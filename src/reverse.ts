/**
 * Interface-analysis and JS-reverse-engineering tools.
 *
 * These are the model-facing `browser_*` tools beyond plain automation: raw CDP
 * passthrough, cookie access (HttpOnly included), response bodies, HAR export,
 * WebSocket frames, script inventory + source extraction, sourcemap recovery,
 * breakpoints/hooking, request rewriting and replay, and a page-level
 * fetch/XHR recorder.
 *
 * Every tool here is a thin adapter over one extension command; the only logic
 * that lives on this side is (a) writing artifacts to disk, because the MV3
 * service worker cannot, and (b) assembling multi-command workflows such as
 * "dump every script" or "resolve this sourcemap", which would otherwise cost
 * the model dozens of round trips.
 * @module @caob23/dsh-browser-control/reverse
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** The slice of the bridge controller these tools need. */
export interface ReverseToolHost {
	/** Resolved artifact directory; `undefined` until settings arrived. */
	readonly shotsDir: string | undefined
	/** Run one extension command over the live link. */
	execute(command: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

/** Response of `<command>` payloads that carry a JSON string back to the model. */
interface JsonEnvelope {
	tabId?: number
	[key: string]: unknown
}

/** Cap for a single artifact written by the script/sourcemap dumpers. */
const SCRIPT_DUMP_MAX_BYTES = 24 * 1024 * 1024

/**
 * Model-facing text for a reverse-engineering tool result.
 *
 * `render` is the only channel the model receives — the canonical value is
 * schema-validated but never delivered on its own — so a summary-only render
 * would hide exactly the data these tools exist to return (request rows,
 * response bodies, script sources, call frames). Renders carry the payload
 * here, capped so a single call cannot swallow the context.
 * @param value - the tool's canonical value.
 * @param maxChars - character budget for the rendered text.
 * @returns one text content block.
 */
function renderPayload(value: unknown, maxChars: number): Array<{ type: 'text'; text: string }> {
	const record = (value ?? {}) as Record<string, unknown>
	const scalars = ['tabId', 'action', 'count', 'entries', 'bytes', 'file', 'error', 'unavailable', 'ok', 'autoAttach', 'policy']
		.filter(key => record[key] !== undefined)
		.map(key => `${key}=${String(record[key])}`)
		.join(' ')
	const inner = typeof record.json === 'string' ? record.json
		: typeof record.js === 'string' ? record.js
			: typeof record.body === 'string' ? record.body
				: typeof record.index === 'string' ? record.index
					: typeof record.source === 'string' ? record.source
						: JSON.stringify(value, null, 1) ?? String(value)
	const text = scalars.length === 0 ? inner : `${scalars}\n${inner}`
	if (text.length <= maxChars) return [{ type: 'text', text }]
	return [{ type: 'text', text: `${text.slice(0, maxChars)}\n…(truncated — ${text.length - maxChars} more chars)` }]
}

/** Timestamp fragment shared by every artifact name. */
function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Resolve (and create) a subdirectory of the shots directory. */
async function artifactDir(host: ReverseToolHost, subdir: string): Promise<string> {
	const dir = host.shotsDir
	if (dir === undefined) throw new Error('browser-bridge is not configured yet')
	const target = path.join(dir, subdir)
	await mkdir(target, { recursive: true })
	return target
}

/** Write one artifact and return its absolute path + byte size. */
async function writeArtifact(dir: string, name: string, data: string): Promise<{ file: string; bytes: number }> {
	const file = path.join(dir, name)
	await writeFile(file, data, 'utf8')
	return { file, bytes: Buffer.byteLength(data, 'utf8') }
}

/** Filesystem-safe tail of a URL, used to name dumped scripts. */
function safeName(input: string, fallback: string): string {
	const withoutQuery = input.split(/[?#]/)[0] ?? ''
	const tail = withoutQuery.split('/').filter(part => part.length > 0).pop() ?? ''
	const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
	return cleaned.length > 0 ? cleaned : fallback
}

/** Name a dumped script without doubling an extension it already carries. */
function scriptFileName(prefix: string, source: string, scriptId: string): string {
	const name = safeName(source, scriptId)
	return /\.(m?js|cjs|jsx|ts|tsx)$/i.test(name) ? `${prefix}-${name}` : `${prefix}-${name}.js`
}

/**
 * Map a sourcemap `sources[]` entry onto a relative path inside the dump
 * directory. `..` segments are dropped rather than resolved, so a hostile map
 * cannot write outside the artifact tree.
 */
function sourceRelPath(source: string, sourceRoot?: string): string {
	let value = source
	if (typeof sourceRoot === 'string' && sourceRoot.length > 0) {
		try { value = new URL(source, sourceRoot).toString() } catch { value = source }
	}
	value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
	const parts = value
		.split('/')
		.filter(part => part.length > 0 && part !== '.' && part !== '..')
		.map(part => part.replace(/[^A-Za-z0-9._@$()[\]{}-]+/g, '_').slice(0, 100))
	if (parts.length === 0) return 'root.js'
	return path.join(...parts)
}

/** Decode a `data:` sourcemap URL into its JSON text. */
function decodeDataUrl(url: string): string | null {
	const comma = url.indexOf(',')
	if (comma < 0) return null
	const meta = url.slice(0, comma)
	const payload = url.slice(comma + 1)
	if (/;base64/i.test(meta)) return Buffer.from(payload, 'base64').toString('utf8')
	try { return decodeURIComponent(payload) } catch { return payload }
}

/** The subset of a sourcemap document this module consumes. */
interface SourceMapDocument {
	version?: number
	file?: string
	sourceRoot?: string
	sources?: string[]
	sourcesContent?: (string | null)[]
	names?: string[]
	mappings?: string
}

/** Register every reverse-engineering tool. */
export function registerReverseTools(ctx: Context, host: ReverseToolHost): void {
	const run = async (command: string, params: Record<string, unknown>, signal: AbortSignal): Promise<JsonEnvelope> =>
		await host.execute(command, params, signal) as JsonEnvelope

	const json = (value: unknown): string => {
		try { return JSON.stringify(value, null, 1) ?? String(value) } catch { return String(value) }
	}

	/* ------------------------------------------------------------ raw CDP */

	ctx.tools.register(defineTool({
		name: 'browser_cdp',
		description: 'Send a raw Chrome DevTools Protocol command to a tab (or to a non-tab target such as a worker). This is the escape hatch for everything the other tools do not wrap: Network.*, Storage.*, DOM.*, Emulation.*, Runtime.*, Debugger.*, Page.*. Example: method "Network.getAllCookies". Two domains are blocked for extension debugger clients and answer -32601 "wasn\'t found": the browser-level `Browser.*` domain, and `Target.*`. Use browser_targets to discover a targetId (that API is not blocked), then pass it here to drive a worker directly.',
		parameters: {
			method: { type: 'string', required: true, description: 'CDP method name, e.g. "Network.getAllCookies", "Storage.getCookies", "Runtime.evaluate".' },
			params: { type: 'json', description: 'CDP parameters object (method-specific). Omit when the method takes none.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			targetId: { type: 'string', description: 'Non-tab CDP target id (worker / OOPIF / service worker) from Target.getTargets.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number' },
					targetId: { type: 'string' },
					method: { type: 'string', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: args => ({ card: 'generic', title: `CDP ${args.method}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { method: args.method }
			if (args.params !== undefined) params.params = args.params
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (typeof args.targetId === 'string') params.targetId = args.targetId
			const raw = await run('cdp', params, exec.signal)
			return {
				...(raw.tabId === undefined ? {} : { tabId: raw.tabId }),
				...(typeof raw.targetId === 'string' ? { targetId: raw.targetId } : {}),
				method: args.method,
				json: json(raw.result),
			}
		},
	}))

	/* ------------------------------------------------------------- cookies */

	ctx.tools.register(defineTool({
		name: 'browser_cookies',
		description: 'Read, set, delete or clear cookies through CDP — HttpOnly cookies included, which page JavaScript can never see. "get" with a url returns exactly the cookies that url would send; without one it returns the whole profile jar.',
		parameters: {
			action: { type: 'string', required: true, enum: ['get', 'set', 'delete', 'clear'], description: 'get = read, set = write, delete = remove one, clear = wipe the jar.' },
			url: { type: 'string', description: 'Request URL: scopes "get" to that URL and anchors "set"/"delete".' },
			domain: { type: 'string', description: 'Cookie domain for set/delete; on "get" it is a case-insensitive substring filter.' },
			name: { type: 'string', description: 'Cookie name (regex filter on get, exact name on set/delete).' },
			value: { type: 'string', description: 'Cookie value for action "set".' },
			path: { type: 'string', description: 'Cookie path; defaults to / with a domain.' },
			secure: { type: 'boolean', description: 'Set the Secure attribute.' },
			httpOnly: { type: 'boolean', description: 'Set the HttpOnly attribute.' },
			sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'], description: 'SameSite attribute.' },
			expires: { type: 'number', description: 'Expiry as a Unix timestamp in seconds.' },
			includeHttpOnly: { type: 'boolean', description: 'get: include HttpOnly cookies (default true).' },
			values: { type: 'boolean', description: 'get: include cookie values (default true; false returns only names + lengths).' },
			limit: { type: 'number', description: 'get: maximum rows (default 1000).' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					action: { type: 'string', required: true },
					ok: { type: 'boolean', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: args => ({ card: 'generic', title: `Cookies ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			for (const key of ['url', 'domain', 'name', 'value', 'path', 'sameSite'] as const) {
				if (typeof args[key] === 'string' && args[key]!.length > 0) params[key] = args[key]
			}
			for (const key of ['secure', 'httpOnly', 'includeHttpOnly', 'values'] as const) {
				if (typeof args[key] === 'boolean') params[key] = args[key]
			}
			for (const key of ['expires', 'limit', 'tabId'] as const) {
				if (typeof args[key] === 'number') params[key] = args[key]
			}
			const map: Record<string, string> = { get: 'cookies.get', set: 'cookies.set', delete: 'cookies.delete', clear: 'cookies.clear' }
			const command = map[args.action]
			if (command === undefined) throw new Error(`unknown action: ${args.action}`)
			const raw = await run(command, params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), action: args.action, ok: true, json: json(raw) }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_body_policy',
		description: 'Read or set the background response-body capture policy. `off` captures nothing, `xhr` (default) captures XHR/Fetch responses as they finish, `all` also captures documents/scripts/images. Captured bodies are what browser_network_body and browser_network_log(includeBodies) can hand back later — the renderer drops a body shortly after the request, so this is the only way to keep it without asking in time.',
		parameters: {
			policy: { type: 'string', enum: ['off', 'xhr', 'all'], description: 'Set the policy; omit to just read the current one.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 1_000),
		},
		presentCall: args => ({ card: 'generic', title: args.policy ? `Body capture → ${args.policy}` : 'Read body capture policy', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (typeof args.policy === 'string') params.policy = args.policy
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await run('bodies.policy', params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), json: json(raw) }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_targets',
		description: 'List every debuggable target Chrome exposes (pages, extension workers, other top-level targets). A page\'s dedicated Web Workers are NOT in that list — pass `autoAttach: true` first and Chrome will then report each worker with `source: "Target auto-attach"`; take its targetId to browser_cdp to evaluate inside the worker, enable its Debugger domain, or hot-patch its code. That is how you reach the signing logic sites hide in workers.',
		parameters: {
			autoAttach: { type: 'boolean', description: 'true = turn Target auto-attach on for this tab and list what appears; false = turn it off.' },
			type: { type: 'string', description: 'Filter by target type, e.g. "page", "worker", "shared_worker", "service_worker", "iframe", "other".' },
			tabId: { type: 'number', description: 'Only targets of this tab (workers carry a tabId only once auto-attach reported them).' },
			waitForDebuggerOnStart: { type: 'boolean', description: 'autoAttach: also pause new workers before their first line (default false).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					count: { type: 'number', required: true },
					autoAttach: { type: 'boolean' },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: args => ({ card: 'generic', title: args.autoAttach === undefined ? 'List debug targets' : `Targets autoAttach=${args.autoAttach}`, kind: 'other' as const }),
		async execute(args, exec) {
			let autoAttach: boolean | undefined
			if (typeof args.autoAttach === 'boolean') {
				const params: Record<string, unknown> = { enable: args.autoAttach }
				if (args.tabId !== undefined) params.tabId = args.tabId
				if (args.waitForDebuggerOnStart === true) params.waitForDebuggerOnStart = true
				await run('targets.autoattach', params, exec.signal)
				autoAttach = args.autoAttach
			}
			const listParams: Record<string, unknown> = {}
			if (typeof args.type === 'string') listParams.type = args.type
			if (args.tabId !== undefined) listParams.tabId = args.tabId
			const raw = await run('targets.list', listParams, exec.signal)
			return {
				tabId: Number(args.tabId ?? 0),
				count: Number(raw.count ?? 0),
				...(autoAttach === undefined ? {} : { autoAttach }),
				json: json(raw),
			}
		},
	}))

	/* ------------------------------------------------- network bodies + HAR */

	ctx.tools.register(defineTool({
		name: 'browser_network_body',
		description: 'Fetch one captured response body (or a request\'s post body) by requestId. Response bodies are only available while the renderer still holds them — grab them right after the request, or use browser_body_policy to capture them in the background.',
		parameters: {
			requestId: { type: 'string', required: true, description: 'CDP requestId from browser_network_log.' },
			kind: { type: 'string', enum: ['response', 'request'], description: 'response (default) or request post body.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					requestId: { type: 'string', required: true },
					kind: { type: 'string', required: true },
					bytes: { type: 'number', required: true },
					base64Encoded: { type: 'boolean' },
					unavailable: { type: 'boolean' },
					error: { type: 'string' },
					body: { type: 'string' },
				},
			},
			render: (_args, value) => renderPayload(value, 8_000),
		},
		presentCall: () => ({ card: 'generic', title: 'Read network body', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { requestId: args.requestId }
			if (args.kind !== undefined) params.kind = args.kind
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await run('network.body', params, exec.signal) as JsonEnvelope & {
				body?: string; postData?: string; bytes?: number; base64Encoded?: boolean; unavailable?: boolean; error?: string
			}
			const text = raw.kind === 'request' ? raw.postData : raw.body
			return {
				tabId: Number(raw.tabId ?? 0),
				requestId: args.requestId,
				kind: String(raw.kind ?? 'response'),
				bytes: Number(raw.bytes ?? (typeof text === 'string' ? text.length : 0)),
				...(raw.base64Encoded === undefined ? {} : { base64Encoded: raw.base64Encoded }),
				...(raw.unavailable === true ? { unavailable: true } : {}),
				...(typeof raw.error === 'string' ? { error: raw.error } : {}),
				...(typeof text === 'string' ? { body: text } : {}),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_network_har',
		description: 'Export the captured traffic of a tab as a HAR 1.2 file (headers, cookies, post bodies, response bodies when still available) and return the file path plus a request index. Opens in Chrome DevTools, Charles, Fiddler or any HAR viewer.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			includeStatic: { type: 'boolean', description: 'Include images/fonts/CSS/scripts (default false).' },
			includeBodies: { type: 'boolean', description: 'Embed response bodies (default true).' },
			save: { type: 'boolean', description: 'Write the .har file to disk (default true).' },
			path: { type: 'string', description: 'Explicit .har path; defaults to <shotsDir>/har/.' },
			clear: { type: 'boolean', description: 'Clear the tab buffer after exporting.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					entries: { type: 'number', required: true },
					file: { type: 'string' },
					bytes: { type: 'number' },
					index: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 8_000),
		},
		presentCall: () => ({ card: 'generic', title: 'Export HAR', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.includeStatic === true) params.includeStatic = true
			if (args.includeBodies === false) params.includeBodies = false
			if (args.clear === true) params.clear = true
			const raw = await run('network.har', params, exec.signal) as JsonEnvelope & {
				har?: unknown; count?: number; url?: string
			}
			const text = JSON.stringify(raw.har ?? {}, null, 1)
			let file: string | undefined
			let bytes: number | undefined
			if (args.save !== false) {
				const dir = typeof args.path === 'string' && args.path.length > 0
					? path.dirname(path.resolve(args.path))
					: await artifactDir(host, 'har')
				await mkdir(dir, { recursive: true })
				const name = typeof args.path === 'string' && args.path.length > 0
					? path.basename(args.path)
					: `${stamp()}-tab${raw.tabId ?? 0}.har`
				const written = await writeArtifact(dir, name, text)
				file = written.file
				bytes = written.bytes
			}
			const entries = (raw.har as { log?: { entries?: Array<{ request?: { method?: string; url?: string }; response?: { status?: number } }> } } | undefined)?.log?.entries ?? []
			const index = entries.slice(0, 200).map((entry) => {
				const method = entry.request?.method ?? '?'
				const url = entry.request?.url ?? ''
				const status = entry.response?.status ?? 0
				return `${method} ${status} ${url.length > 160 ? url.slice(0, 160) + '…' : url}`
			}).join('\n')
			return {
				tabId: Number(raw.tabId ?? 0),
				entries: entries.length,
				...(file === undefined ? {} : { file }),
				...(bytes === undefined ? {} : { bytes }),
				index,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_network_replay',
		description: 'Re-issue a captured request from inside the page, with the page\'s cookies and origin, optionally overriding url/method/headers/body. Use it to probe how an API reacts to edited parameters or to confirm a signature.',
		parameters: {
			requestId: { type: 'string', description: 'Request to replay (from browser_network_log); its url/method/headers/body are reused when not overridden.' },
			url: { type: 'string', description: 'Override the target URL.' },
			method: { type: 'string', description: 'Override the HTTP method.' },
			headers: { type: 'json', description: 'Extra or replacement headers, merged over the captured ones.' },
			body: { type: 'string', description: 'Override the request body.' },
			tabId: { type: 'number', description: 'Tab whose page context performs the replay; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					ok: { type: 'boolean', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: () => ({ card: 'generic', title: 'Replay request', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (typeof args.requestId === 'string') params.requestId = args.requestId
			if (typeof args.url === 'string') params.url = args.url
			if (typeof args.method === 'string') params.method = args.method
			if (args.headers !== undefined) params.headers = args.headers
			if (typeof args.body === 'string') params.body = args.body
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await run('network.replay', params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), ok: raw.ok === true, json: json(raw) }
		},
	}))

	/* ---------------------------------------------------------- websockets */

	ctx.tools.register(defineTool({
		name: 'browser_websocket_log',
		description: 'Read captured WebSocket traffic for a tab: handshake request/response headers, per-socket frame counts, and the frames themselves (direction, opcode, payload).',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			urlPattern: { type: 'string', description: 'Regex filter on the socket URL (case-insensitive).' },
			payloadPattern: { type: 'string', description: 'Regex filter on frame payloads.' },
			direction: { type: 'string', enum: ['sent', 'received'], description: 'Only frames in this direction.' },
			limit: { type: 'number', description: 'Maximum frames returned, newest last (default 200).' },
			clear: { type: 'boolean', description: 'Clear captured frames after reading.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: () => ({ card: 'generic', title: 'Read WebSocket log', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			for (const key of ['urlPattern', 'payloadPattern', 'direction'] as const) {
				if (typeof args[key] === 'string' && args[key]!.length > 0) params[key] = args[key]
			}
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.clear === true) params.clear = true
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await run('ws.log', params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), json: json(raw) }
		},
	}))

	/* ------------------------------------------- scripts, sources, sourcemaps */

	const mapScriptRef = (args: { scriptId?: string; url?: string; urlPattern?: string; index?: number }): Record<string, unknown> => {
		const params: Record<string, unknown> = {}
		if (typeof args.scriptId === 'string') params.scriptId = args.scriptId
		if (typeof args.url === 'string') params.url = args.url
		if (typeof args.urlPattern === 'string') params.urlPattern = args.urlPattern
		if (typeof args.index === 'number') params.index = args.index
		return params
	}

	ctx.tools.register(defineTool({
		name: 'browser_scripts',
		description: 'Work with the JavaScript a tab has parsed. Actions: "list" every script (inline, eval, webpack chunks included — far more than <script src> shows), "source" one script\'s full text, "dump" all matching scripts to files under the shots directory, "sourcemap" resolve a script\'s .map and write the original sources tree back out.',
		parameters: {
			action: { type: 'string', required: true, enum: ['list', 'source', 'dump', 'sourcemap'], description: 'What to do.' },
			scriptId: { type: 'string', description: 'CDP scriptId (exact target).' },
			url: { type: 'string', description: 'Exact script URL.' },
			urlPattern: { type: 'string', description: 'Regex over script URLs.' },
			index: { type: 'number', description: 'Pick the Nth match of urlPattern (0-based).' },
			limit: { type: 'number', description: 'list: max rows (default 200). dump: max scripts to fetch (default 200).' },
			minLength: { type: 'number', description: 'list/dump: skip scripts shorter than this.' },
			withSourceMap: { type: 'boolean', description: 'list: only scripts that declare a sourceMappingURL.' },
			inlineOnly: { type: 'boolean', description: 'list: only inline/webpack scripts without a URL.' },
			maxBytes: { type: 'number', description: 'source: truncate above this size (default 16 MiB).' },
			save: { type: 'boolean', description: 'source: also write the file to disk.' },
			dir: { type: 'string', description: 'dump/sourcemap: explicit output directory.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					action: { type: 'string', required: true },
					js: { type: 'string', required: true },
					files: { type: 'string' },
					count: { type: 'number' },
				},
			},
			render: (_args, value) => renderPayload(value, 12_000),
		},
		presentCall: args => ({ card: 'generic', title: `Scripts ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			if (args.action === 'list') {
				const params: Record<string, unknown> = {}
				if (typeof args.urlPattern === 'string') params.urlPattern = args.urlPattern
				if (typeof args.limit === 'number') params.limit = args.limit
				if (typeof args.minLength === 'number') params.minLength = args.minLength
				if (args.withSourceMap === true) params.withSourceMap = true
				if (args.inlineOnly === true) params.inlineOnly = true
				if (args.tabId !== undefined) params.tabId = args.tabId
				const raw = await run('scripts.list', params, exec.signal)
				return { tabId: Number(raw.tabId ?? 0), action: 'list', count: Number(raw.count ?? 0), js: json(raw) }
			}

			if (args.action === 'source') {
				const params = mapScriptRef(args)
				if (typeof args.maxBytes === 'number') params.maxBytes = args.maxBytes
				if (args.tabId !== undefined) params.tabId = args.tabId
				const raw = await run('scripts.source', params, exec.signal) as JsonEnvelope & { source?: string; url?: string; bytes?: number }
				if (typeof raw.source === 'string' && args.save === true) {
					const dir = typeof args.dir === 'string' && args.dir.length > 0 ? path.resolve(args.dir) : await artifactDir(host, 'scripts')
					await mkdir(dir, { recursive: true })
					const name = scriptFileName(stamp(), String(raw.url ?? raw.scriptId ?? 'script'), String(raw.scriptId ?? 'script'))
					const written = await writeArtifact(dir, name, raw.source)
					return { tabId: Number(raw.tabId ?? 0), action: 'source', js: json(raw), files: written.file }
				}
				return { tabId: Number(raw.tabId ?? 0), action: 'source', js: json(raw) }
			}

			if (args.action === 'dump') {
				const listParams: Record<string, unknown> = { limit: typeof args.limit === 'number' ? args.limit : 200 }
				if (typeof args.urlPattern === 'string') listParams.urlPattern = args.urlPattern
				if (typeof args.minLength === 'number') listParams.minLength = args.minLength
				if (args.tabId !== undefined) listParams.tabId = args.tabId
				const listed = await run('scripts.list', listParams, exec.signal) as JsonEnvelope & {
					scripts?: Array<{ scriptId: string; url: string; length?: number; sourceMapURL?: string }>
				}
				const scripts = listed.scripts ?? []
				const tabId = Number(listed.tabId ?? 0)
				const dir = typeof args.dir === 'string' && args.dir.length > 0
					? path.resolve(args.dir)
					: await artifactDir(host, path.join('scripts', `${stamp()}-tab${tabId}`))
				await mkdir(dir, { recursive: true })
				const manifest: Array<Record<string, unknown>> = []
				let failures = 0
				for (let i = 0; i < scripts.length; i += 1) {
					const script = scripts[i]!
					try {
						const source = await run('scripts.source', { scriptId: script.scriptId }, exec.signal) as { source?: string; bytes?: number; truncated?: boolean }
						if (typeof source.source !== 'string') { failures += 1; continue }
						const name = `${String(i).padStart(4, '0')}-${scriptFileName('', script.url || script.scriptId, script.scriptId).replace(/^-/, '')}`
						const written = await writeArtifact(dir, name, source.source.slice(0, SCRIPT_DUMP_MAX_BYTES))
						manifest.push({ scriptId: script.scriptId, url: script.url, bytes: source.bytes ?? source.source.length, truncated: source.truncated === true, file: written.file })
					} catch (error) {
						failures += 1
						manifest.push({ scriptId: script.scriptId, url: script.url, error: error instanceof Error ? error.message : String(error) })
					}
				}
				const manifestFile = await writeArtifact(dir, 'manifest.json', JSON.stringify({ tabId, dumpedAt: new Date().toISOString(), count: manifest.length, failures, scripts: manifest }, null, 1))
				return {
					tabId,
					action: 'dump',
					count: manifest.length,
					files: manifestFile.file,
					js: JSON.stringify({ dir, count: manifest.length, failures, manifest: manifestFile.file }, null, 1),
				}
			}

			if (args.action === 'sourcemap') {
				const params = mapScriptRef(args)
				if (args.tabId !== undefined) params.tabId = args.tabId
				const script = await run('scripts.source', { ...params, maxBytes: 1 }, exec.signal) as JsonEnvelope & {
					url?: string; scriptId?: string; sourceMapURL?: string; ambiguous?: boolean; matches?: unknown
				}
				if (script.ambiguous === true) return { tabId: Number(script.tabId ?? 0), action: 'sourcemap', js: json({ ambiguous: true, matches: script.matches }) }
				const scriptUrl = String(script.url ?? '')
				const declared = String(script.sourceMapURL ?? '')
				if (declared.length === 0) {
					return { tabId: Number(script.tabId ?? 0), action: 'sourcemap', js: json({ error: 'this script declares no sourceMappingURL', scriptId: script.scriptId, url: scriptUrl }) }
				}
				let mapUrl = declared
				if (!declared.startsWith('data:')) {
					try { mapUrl = new URL(declared, scriptUrl || undefined).toString() } catch { mapUrl = declared }
				}
				let mapText: string | null = mapUrl.startsWith('data:') ? decodeDataUrl(mapUrl) : null
				let via = mapText === null ? '' : 'data-url'
				if (mapText === null) {
					try {
						const response = await fetch(mapUrl)
						if (response.ok) { mapText = await response.text(); via = 'node-fetch' }
					} catch { /* cross-origin or offline — fall through to the page */ }
				}
				if (mapText === null) {
					// The page can fetch its own origin even when this process cannot.
					const expression = `(async () => { try { const r = await fetch(${JSON.stringify(mapUrl)}, { credentials: 'include' }); return JSON.stringify({ ok: r.ok, status: r.status, text: await r.text() }); } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); } })()`
					const evaluated = await run('eval', { expression, ...(args.tabId === undefined ? {} : { tabId: args.tabId }) }, exec.signal) as { value?: string }
					try {
						const parsed = JSON.parse(String(evaluated.value)) as { ok?: boolean; text?: string; error?: string }
						if (parsed.ok === true && typeof parsed.text === 'string') { mapText = parsed.text; via = 'page-fetch' }
					} catch { /* keep the null and report below */ }
				}
				if (mapText === null) {
					return { tabId: Number(script.tabId ?? 0), action: 'sourcemap', js: json({ error: 'sourcemap could not be fetched', mapUrl, scriptUrl }) }
				}
				let document: SourceMapDocument
				try { document = JSON.parse(mapText) as SourceMapDocument } catch (error) {
					return { tabId: Number(script.tabId ?? 0), action: 'sourcemap', js: json({ error: `sourcemap is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, mapUrl }) }
				}
				const sources = document.sources ?? []
				const contents = document.sourcesContent ?? []
				const base = typeof args.dir === 'string' && args.dir.length > 0
					? path.resolve(args.dir)
					: await artifactDir(host, path.join('sourcemaps', `${stamp()}-${safeName(scriptUrl || script.scriptId || 'script', 'bundle')}`))
				await mkdir(base, { recursive: true })
				const written: Array<{ source: string; file?: string; bytes?: number; missing?: boolean }> = []
				for (let i = 0; i < sources.length; i += 1) {
					const relative = sourceRelPath(String(sources[i]), document.sourceRoot)
					const content = contents[i]
					if (typeof content !== 'string') {
						written.push({ source: String(sources[i]), missing: true })
						continue
					}
					const target = path.join(base, relative)
					await mkdir(path.dirname(target), { recursive: true })
					await writeFile(target, content, 'utf8')
					written.push({ source: String(sources[i]), file: target, bytes: Buffer.byteLength(content, 'utf8') })
				}
				await writeArtifact(base, '_sourcemap.json', mapText)
				const withContent = written.filter(entry => entry.missing !== true).length
				return {
					tabId: Number(script.tabId ?? 0),
					action: 'sourcemap',
					count: withContent,
					files: base,
					js: json({
						scriptUrl, mapUrl, via,
						sources: sources.length,
						restored: withContent,
						withoutContent: sources.length - withContent,
						dir: base,
						names: (document.names ?? []).length,
						files: written.slice(0, 500),
					}),
				}
			}

			throw new Error(`unknown action: ${String(args.action)}`)
		},
	}))

	/* ------------------------------------------------------------- debugger */

	ctx.tools.register(defineTool({
		name: 'browser_debugger',
		description: 'Debugger control for reverse engineering. "enable" turns the Debugger domain on (required before scripts/breakpoints). "break" sets a line breakpoint by url/urlRegex; "hook" breaks on every call of a function you name by expression — the fastest way to capture a signature function\'s real arguments; "state" shows the paused call frames; "eval" evaluates an expression inside a paused frame; "step"/"resume" move execution; "unbreak" removes breakpoints.',
		parameters: {
			action: { type: 'string', required: true, enum: ['enable', 'break', 'unbreak', 'hook', 'pause', 'resume', 'step', 'state', 'eval', 'exceptions'], description: 'Operation to perform.' },
			url: { type: 'string', description: 'break: exact script URL.' },
			urlRegex: { type: 'string', description: 'break: regex over script URLs.' },
			lineNumber: { type: 'number', description: 'break: 0-based line number.' },
			columnNumber: { type: 'number', description: 'break: 0-based column number.' },
			condition: { type: 'string', description: 'break/hook: only pause when this expression is truthy in the frame.' },
			scriptId: { type: 'string', description: 'break: target a script id instead of a url.' },
			breakpointId: { type: 'string', description: 'unbreak: the id to remove.' },
			all: { type: 'boolean', description: 'unbreak: remove every breakpoint of this tab.' },
			expression: { type: 'string', description: 'hook: expression yielding the function to watch (e.g. "window.sign" or "JSON.parse"); eval: the expression to evaluate in the paused frame.' },
			callFrameId: { type: 'string', description: 'eval: frame id from "state".' },
			step: { type: 'string', enum: ['over', 'into', 'out'], description: 'step: direction (default over).' },
			state: { type: 'string', enum: ['none', 'uncaught', 'all'], description: 'exceptions: pause-on-exception policy.' },
			full: { type: 'boolean', description: 'state/pause/step: include the full frame objects with scope chains.' },
			timeoutMs: { type: 'number', description: 'pause/step: how long to wait for the next pause.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					action: { type: 'string', required: true },
					js: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: args => ({ card: 'generic', title: `Debugger ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			for (const key of ['url', 'urlRegex', 'condition', 'scriptId', 'breakpointId', 'expression', 'callFrameId', 'state'] as const) {
				if (typeof args[key] === 'string' && args[key]!.length > 0) params[key] = args[key]
			}
			for (const key of ['lineNumber', 'columnNumber', 'timeoutMs', 'tabId'] as const) {
				if (typeof args[key] === 'number') params[key] = args[key]
			}
			if (args.all === true) params.all = true
			if (args.full === true) params.full = true
			const map: Record<string, string> = {
				enable: 'debugger.enable', break: 'debugger.break', unbreak: 'debugger.unbreak',
				hook: 'debugger.hook', pause: 'debugger.pause', resume: 'debugger.resume',
				state: 'debugger.state', eval: 'debugger.eval', exceptions: 'debugger.exceptions',
			}
			const command = args.action === 'step' ? 'debugger.step' : map[args.action]
			if (command === undefined) throw new Error(`unknown action: ${String(args.action)}`)
			if (args.action === 'step') params.action = typeof args.step === 'string' ? args.step : 'over'
			const raw = await run(command, params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), action: String(args.action), js: json(raw) }
		},
	}))

	/* ------------------------------------------------------ fetch rewriting */

	ctx.tools.register(defineTool({
		name: 'browser_intercept',
		description: 'Intercept live traffic through the Fetch domain to read or rewrite it. "enable" parks matching requests (hold=true) or just records them (hold=false); "list" shows what is parked with its headers and post body; "continue" forwards (optionally with a new url/method/headers/body), "fulfill" answers with a body you supply, "fail" kills it, "body" reads a parked response body, "auth" answers an HTTP auth challenge. Always "disable" when done — parked requests hang the page.',
		parameters: {
			action: { type: 'string', required: true, enum: ['enable', 'disable', 'list', 'continue', 'fulfill', 'fail', 'body', 'auth'], description: 'Operation to perform.' },
			urlPattern: { type: 'string', description: 'enable: glob-ish url pattern (default "*"); list: regex filter.' },
			patterns: { type: 'json', description: 'enable: full CDP pattern array, e.g. [{"urlPattern":"*/api/*","requestStage":"Request"}].' },
			stage: { type: 'string', enum: ['request', 'response'], description: 'enable: which stage to intercept (default request). Use response to edit the reply.' },
			hold: { type: 'boolean', description: 'enable: true (default) parks requests for you to decide; false records and continues them.' },
			handleAuthRequests: { type: 'boolean', description: 'enable: also intercept HTTP auth challenges.' },
			requestId: { type: 'string', description: 'Target parked request (from "list").' },
			url: { type: 'string', description: 'continue: rewrite the URL.' },
			method: { type: 'string', description: 'continue: rewrite the method.' },
			headers: { type: 'json', description: 'continue/fulfill: header object to merge/apply.' },
			postData: { type: 'string', description: 'continue: replacement request body.' },
			interceptResponse: { type: 'boolean', description: 'continue: also intercept the response stage after continuing.' },
			responseCode: { type: 'number', description: 'fulfill: status code (default 200).' },
			responsePhrase: { type: 'string', description: 'fulfill: status text.' },
			responseHeaders: { type: 'json', description: 'fulfill: response headers object.' },
			body: { type: 'string', description: 'fulfill: response body text (JSON string or plain text).' },
			bodyBase64: { type: 'string', description: 'fulfill: response body already base64-encoded.' },
			errorReason: { type: 'string', description: 'fail: CDP error reason such as Failed, Aborted, AccessDenied.' },
			response: { type: 'string', enum: ['Default', 'CancelAuth', 'ProvideCredentials'], description: 'auth: how to answer the challenge.' },
			username: { type: 'string', description: 'auth: username with ProvideCredentials.' },
			password: { type: 'string', description: 'auth: password with ProvideCredentials.' },
			parked: { type: 'boolean', description: 'list: only the currently parked requests.' },
			limit: { type: 'number', description: 'list: maximum rows (default 50).' },
			clear: { type: 'boolean', description: 'list: clear the log after reading.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					action: { type: 'string', required: true },
					js: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 6_000),
		},
		presentCall: args => ({ card: 'generic', title: `Intercept ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			for (const key of ['urlPattern', 'stage', 'requestId', 'url', 'method', 'postData', 'responsePhrase', 'errorReason', 'response', 'username', 'password'] as const) {
				if (typeof args[key] === 'string' && args[key]!.length > 0) params[key] = args[key]
			}
			for (const key of ['limit', 'responseCode', 'tabId'] as const) {
				if (typeof args[key] === 'number') params[key] = args[key]
			}
			for (const key of ['hold', 'handleAuthRequests', 'interceptResponse', 'parked', 'clear'] as const) {
				if (typeof args[key] === 'boolean') params[key] = args[key]
			}
			for (const key of ['patterns', 'headers', 'responseHeaders'] as const) {
				if (args[key] !== undefined) params[key] = args[key]
			}
			if (typeof args.body === 'string') params.body = args.body
			if (typeof args.bodyBase64 === 'string') params.bodyBase64 = args.bodyBase64
			const raw = await run(`fetch.${args.action}`, params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), action: String(args.action), js: json(raw) }
		},
	}))

	/* --------------------------------------------------- page-level recorder */

	ctx.tools.register(defineTool({
		name: 'browser_hook',
		description: 'Inject and read a page-level fetch/XHR recorder. Unlike CDP capture this sees what the site\'s own JavaScript passed in — headers, bodies, response text — which is what you need when the payload is built in JS before it hits the wire. "install" (optionally persistent across navigations), "log" to read the records, "restore" to remove it.',
		parameters: {
			action: { type: 'string', required: true, enum: ['install', 'log', 'restore'], description: 'Operation to perform.' },
			persist: { type: 'boolean', description: 'install: also inject into every future document (default true).' },
			urlPattern: { type: 'string', description: 'log: regex filter over recorded URLs.' },
			kind: { type: 'string', enum: ['fetch', 'xhr'], description: 'log: only this transport.' },
			limit: { type: 'number', description: 'log: maximum records, newest last (default 100).' },
			clear: { type: 'boolean', description: 'log: clear the page-side buffer after reading.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					action: { type: 'string', required: true },
					js: { type: 'string', required: true },
				},
			},
			render: (_args, value) => renderPayload(value, 8_000),
		},
		presentCall: args => ({ card: 'generic', title: `Page hook ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (typeof args.urlPattern === 'string') params.urlPattern = args.urlPattern
			if (typeof args.kind === 'string') params.kind = args.kind
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.persist === false) params.persist = false
			if (args.clear === true) params.clear = true
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await run(`hook.${args.action}`, params, exec.signal)
			return { tabId: Number(raw.tabId ?? 0), action: String(args.action), js: json(raw) }
		},
	}))
}
