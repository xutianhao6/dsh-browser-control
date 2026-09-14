#!/usr/bin/env node
/**
 * DSH Browser Control —— 接口分析 / JS 逆向能力验收
 *
 * 对着**运行中的桥**（默认 127.0.0.1:9777）与**构建产物**（lib/types/reverse.js）
 * 逐项验证 v1.0.9 的 10 个逆向工具，并用 dsh-tools 自己的校验器同时校验每次调用的
 * 「入参 schema」与「返回值 schema」——v1.0.8 的 browser_network_log 就是栽在返回值
 * schema 上（整个工具不可用），所以这项校验必须常驻。
 *
 * 它自带一个本地夹具服务器（页面 / JSON 接口 / 401 认证挑战 / 带 sourcemap 的 JS），
 * 不依赖任何外网站点，因此离线也能跑、结果稳定。
 *
 * 前置条件：
 *   1. 已构建：npm run build（脚本加载的是 lib/，不是 src/）
 *   2. 桥在监听且扩展已连接（先跑 scripts/verify-install.ps1 最省事）
 *
 * 用法：
 *   node scripts/verify-reverse.mjs
 *   node scripts/verify-reverse.mjs --port 9777 --token dsh-local
 *   node scripts/verify-reverse.mjs --keep      # 保留落盘产物供人工检查
 *
 * 退出码 0 = 全绿；1 = 有失败项；2 = 前置条件不满足（桥连不上等）。
 */
import http from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateJsonSchemaValue, assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(argOf('port', '9777'))
const TOKEN = argOf('token', 'dsh-local')
const KEEP = argv.includes('--keep')
const BRIDGE = `http://127.0.0.1:${PORT}`

/* ------------------------------------------------------- fixture server */

const APP_JS = [
	'window.__dshSign = function (a, b) { return a * 3 + b; };',
	'window.__dshReady = true;',
	'//# sourceMappingURL=app.js.map',
	'',
].join('\n')

const APP_MAP = JSON.stringify({
	version: 3,
	file: 'app.js',
	sources: ['webpack:///src/sign.js', 'webpack:///src/util.js'],
	sourcesContent: [
		'export function sign(a, b) {\n  return a * 3 + b\n}\n',
		'export const VERSION = "1.0.9"\n',
	],
	names: ['sign', 'a', 'b'],
	mappings: 'AAAA',
})

const PAGE = [
	'<!doctype html><html><head><meta charset="utf-8"><title>DSH reverse fixture</title></head>',
	'<body><h1 id="title">fixture</h1>',
	'<script src="/app.js"></script>',
	'</body></html>',
].join('\n')

const WORKER_JS = [
	'self.sign = function (x) { return "sig-" + x * 7; };',
	'self.onmessage = function (e) { self.postMessage(self.sign(e.data)); };',
	'',
].join('\n')

function startFixture() {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const send = (status, type, body, extraHeaders = {}) => {
			res.writeHead(status, { 'Content-Type': type, ...extraHeaders })
			res.end(body)
		}
		if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE)
		if (url.pathname === '/app.js') return send(200, 'application/javascript; charset=utf-8', APP_JS)
		if (url.pathname === '/app.js.map') return send(200, 'application/json; charset=utf-8', APP_MAP)
		if (url.pathname === '/worker.js') return send(200, 'application/javascript; charset=utf-8', WORKER_JS)
		if (url.pathname === '/api/echo') {
			const chunks = []
			req.on('data', (c) => chunks.push(c))
			req.on('end', () => send(200, 'application/json; charset=utf-8', JSON.stringify({
				method: req.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				headers: { 'x-fixture': req.headers['x-fixture'] ?? null, host: req.headers.host ?? null },
				body: Buffer.concat(chunks).toString('utf8'),
			})))
			return
		}
		if (url.pathname === '/api/auth') {
			if (!req.headers.authorization) {
				return send(401, 'application/json; charset=utf-8', JSON.stringify({ error: 'auth required' }), {
					'WWW-Authenticate': 'Basic realm="dsh-fixture"',
				})
			}
			return send(200, 'application/json; charset=utf-8', JSON.stringify({ authorized: true, header: req.headers.authorization }))
		}
		return send(404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found', path: url.pathname }))
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
	})
}

/* ---------------------------------------------------------------- bridge */

async function bridge(command, params = {}, timeoutMs = 90_000) {
	const response = await fetch(`${BRIDGE}/api/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-DSH-Token': TOKEN },
		body: JSON.stringify({ command, params, timeoutMs }),
		signal: AbortSignal.timeout(timeoutMs + 5_000),
	})
	const payload = await response.json().catch(() => ({ ok: false, error: `bad JSON (${response.status})` }))
	if (!payload.ok) throw new Error(payload.error ?? `bridge error ${response.status}`)
	return payload.result
}

/* ----------------------------------------------------------------- tools */

const { registerReverseTools } = await import(new URL('../lib/types/reverse.js', import.meta.url))

const tools = new Map()
let shotsDir
const exec = { signal: new AbortController().signal }
const schemaProblems = []
const renderProblems = []
let argChecks = 0
let outChecks = 0
let renderChecks = 0

/**
 * The model only ever receives `output.render` — the canonical value is
 * validated but not delivered. A summary-only render therefore hides exactly
 * the data a tool exists to return, so every call asserts the payload shows up
 * in the rendered text.
 */
function checkRender(name, args, value) {
	const tool = tools.get(name)
	const render = tool?.output?.render
	if (typeof render !== 'function') return
	renderChecks += 1
	const record = (value ?? {})
	const payload = typeof record.json === 'string' ? record.json
		: typeof record.js === 'string' ? record.js
			: typeof record.body === 'string' ? record.body
				: typeof record.index === 'string' ? record.index
					: typeof record.source === 'string' ? record.source
						: null
	// No string payload in the value means there is nothing to hide (e.g. a
	// metadata-only result such as a failed body fetch) — skip the probe.
	if (payload === null) return
	const probe = payload.replace(/\s+/g, ' ').trim().slice(0, 60)
	let text = ''
	try { text = render(args, value).map((block) => block?.text ?? '').join('\n') } catch (error) {
		renderProblems.push(`${name}: render threw ${String(error?.message ?? error)}`)
		return
	}
	if (text.trim().length === 0) { renderProblems.push(`${name}: render produced no text`); return }
	if (probe.length > 10 && !text.replace(/\s+/g, ' ').includes(probe)) {
		renderProblems.push(`${name}: render hides the payload (expected ${JSON.stringify(probe.slice(0, 40))}…, got ${JSON.stringify(text.slice(0, 60))})`)
	}
}

async function call(name, args) {
	const tool = tools.get(name)
	if (tool === undefined) throw new Error(`tool not registered: ${name} (跑过 npm run build 了吗？)`)
	const argViolations = validateJsonSchemaValue(tool.parameters, args)
	argChecks += 1
	if (argViolations.length > 0) schemaProblems.push(`${name} args: ${argViolations.join(' | ')}`)
	const value = await tool.execute(args, exec)
	assertObjectJsonSchema(tool.output.schema)
	const outViolations = validateJsonSchemaValue(tool.output.schema, value)
	outChecks += 1
	if (outViolations.length > 0) schemaProblems.push(`${name} output: ${outViolations.join(' | ')}`)
	checkRender(name, args, value)
	return value
}

/* ------------------------------------------------------------------ main */

const rows = []
let skipped = 0
function check(name, ok, detail) {
	rows.push({ name, ok, detail })
	console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, detail) {
	skipped += 1
	console.log(`  [SKIP] ${name}${detail ? ` — ${detail}` : ''}`)
}
const attempt = async (name, fn) => {
	// Every stage starts from a known-clean tab: a stage that fails midway can
	// leave the page parked at a breakpoint (or a Fetch hold in place), which
	// would otherwise cascade into every later stage with tab_paused / hangs.
	await ensureClean()
	try {
		return await fn()
	} catch (error) {
		check(name, false, String(error?.message ?? error))
		return undefined
	}
}

/** Resume a paused tab and release any Fetch interception. Never throws. */
async function ensureClean() {
	if (tabId === undefined) return
	// A pause can land a few hundred ms after the command that caused it, so
	// retry instead of trusting a single check.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let paused = false
		try {
			const state = await bridge('debugger.state', { tabId }, 15_000)
			paused = state.paused === true
			if (paused) await bridge('debugger.resume', { tabId, force: true }, 15_000)
		} catch { /* debugger not enabled on this tab */ }
		if (!paused) break
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	try {
		await bridge('fetch.disable', { tabId }, 15_000)
	} catch { /* interception was not enabled */ }
}

console.log(`DSH Browser Control 逆向能力验收（桥 ${BRIDGE}，token ${TOKEN === 'dsh-local' ? 'dsh-local' : '(已提供)'}）\n`)

const status = await fetch(`${BRIDGE}/api/status`, { signal: AbortSignal.timeout(5_000) })
	.then((r) => r.json())
	.catch(() => null)
if (status === null) {
	console.error(`桥连不上：${BRIDGE}/api/status —— 先让 dsh 起来并启用「DSH 浏览器控制」`)
	process.exit(2)
}
console.log(`桥：listening=${status.listening} extensionConnected=${status.extensionConnected} 扩展版本=${status.hello?.version ?? '—'}\n`)
if (status.extensionConnected !== true) {
	console.error('扩展没连上 —— 先跑 scripts/start-browser.ps1，或看 scripts/verify-install.ps1 的提示')
	process.exit(2)
}

/* 访问令牌门（v1.0.9 起 /api/command 必须带 token） */
{
	let code = 0
	try {
		await fetch(`${BRIDGE}/api/command`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ command: 'ping', params: {} }),
			signal: AbortSignal.timeout(8_000),
		}).then(async (r) => { code = r.status })
	} catch { code = -1 }
	check('桥的 /api/command 拒绝无 token 调用（401）', code === 401, `实际 ${code}`)
}

/* 夹具 + 工具注册 */
const fixture = await startFixture()
const origin = `http://127.0.0.1:${fixture.port}`
shotsDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-verify-reverse-'))
await mkdir(shotsDir, { recursive: true })
registerReverseTools(
	{ tools: { register: (tool) => tools.set(tool.name, tool) }, systemPrompt: { section() {} } },
	{ shotsDir, execute: (command, params) => bridge(command, params) },
)
console.log(`夹具：${origin}   产物目录：${shotsDir}\n`)
console.log(`已注册工具（${tools.size}）：${[...tools.keys()].join(', ')}\n`)

const tabId = (await bridge('tabs.open', { url: `${origin}/`, active: true })).tabId
await new Promise((resolve) => setTimeout(resolve, 1_200))
console.log(`验收标签页 tabId=${tabId}\n`)

/* 1. 抓包：文档请求必须在缓冲区内（nav/tabs.open 先 attach 再导航） */
await attempt('抓包窗口（tabs.open 先 attach 再导航）', async () => {
	const log = await bridge('network.log', { tabId, urlPattern: `127\\.0\\.0\\.1:${fixture.port}/$`, includeStatic: true })
	const doc = log.requests.find((r) => String(r.url).endsWith('/') && r.resourceType === 'Document')
	check('抓包窗口（tabs.open 先 attach 再导航）', Boolean(doc), `total=${log.total} Document=${doc ? '已捕获' : '缺失'}`)
})

/* 2. 原始 CDP 透传 */
await attempt('browser_cdp', async () => {
	const v = await call('browser_cdp', { method: 'Network.getAllCookies', params: {}, tabId })
	const cookies = JSON.parse(v.json).cookies.length
	check('browser_cdp 透传 Network 域', cookies > 0, `getAllCookies=${cookies} 条`)
	let denied = ''
	try { await call('browser_cdp', { method: 'Browser.getVersion', tabId }) } catch (error) { denied = String(error.message) }
	check('browser_cdp 如实转达 Chrome 对浏览器级域的拒绝', /-32601|wasn't found/.test(denied), denied.slice(0, 80) || '(未被拒绝，异常)')
})

/* 3. Cookie（含 HttpOnly） */
await attempt('browser_cookies', async () => {
	const set = await call('browser_cookies', {
		action: 'set', tabId, url: `${origin}/`, name: 'dsh_probe', value: 'v1', httpOnly: true, sameSite: 'Lax',
	})
	const got = JSON.parse((await call('browser_cookies', { action: 'get', tabId, url: `${origin}/`, name: 'dsh_probe' })).json)
	const pageSees = (await bridge('eval', { tabId, expression: 'document.cookie' })).value
	const del = JSON.parse((await call('browser_cookies', { action: 'delete', tabId, url: `${origin}/`, name: 'dsh_probe' })).json)
	const after = JSON.parse((await call('browser_cookies', { action: 'get', tabId, url: `${origin}/`, name: 'dsh_probe' })).json)
	check('browser_cookies 读写 HttpOnly（页面 JS 看不到）',
		JSON.parse(set.json).success !== false && got.count === 1 && got.httpOnly === 1 && pageSees === '' && after.count === 0,
		`set=${JSON.parse(set.json).success} 读到=${got.count}(httpOnly=${got.httpOnly}) 页面可见="${pageSees}" 删除后=${after.count}`)
})

/* 4. 流量 → HAR / body / replay */
await bridge('eval', {
	tabId,
	expression: `(async () => {
		await (await fetch('/api/echo?tag=get')).text();
		await (await fetch('/api/echo?tag=post', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fixture': 'yes' }, body: JSON.stringify({ probe: 'reverse', n: 7 }) })).text();
		return 'ok';
	})()`,
})
await new Promise((resolve) => setTimeout(resolve, 1_000))

let entryGet
let entryPost
await attempt('browser_network_har', async () => {
	const v = await call('browser_network_har', { tabId, includeStatic: true, includeBodies: true, save: true })
	const har = JSON.parse(await readFile(v.file, 'utf8'))
	const entries = har.log.entries
	entryGet = entries.find((e) => String(e.request.url).includes('tag=get'))
	entryPost = entries.find((e) => String(e.request.url).includes('tag=post'))
	const wireHeader = entryPost?.request.headers.some((h) => h.name.toLowerCase() === 'x-fixture')
	check('browser_network_har（HAR 1.2 + 落盘 + _requestId + 内联响应体）',
		har.log.version === '1.2' && entries.length === v.entries && entries.every((e) => typeof e._requestId === 'string') && Boolean(entryGet?.response.content.text) && wireHeader === true,
		`file=${path.basename(v.file)} ${v.bytes}B entries=${entries.length} 带体=${entries.filter((e) => e.response.content.text).length} 真实请求头=${wireHeader === true}`)
})

await attempt('browser_network_body', async () => {
	const res = await call('browser_network_body', { tabId, requestId: entryGet._requestId })
	const req = await call('browser_network_body', { tabId, requestId: entryPost._requestId, kind: 'request' })
	const missing = await call('browser_network_body', { tabId, requestId: 'not-a-real-id' })
	check('browser_network_body（响应体 / 请求体 / 取不到时如实报错）',
		res.bytes > 0 && req.body === '{"probe":"reverse","n":7}' && missing.unavailable === true && typeof missing.error === 'string',
		`resp=${res.bytes}B req=${req.body} 缺失=${missing.error.slice(0, 48)}`)
})

await attempt('browser_network_replay', async () => {
	const v = await call('browser_network_replay', { tabId, requestId: entryPost._requestId, body: '{"replayed":true}' })
	const p = JSON.parse(v.json)
	// The fixture echoes the body it received, so the replay is proven by what
	// came back — not by the (JSON-escaped) raw text.
	let echoed = null
	try { echoed = JSON.parse(p.body)?.body ?? null } catch { echoed = null }
	check('browser_network_replay（页面上下文重放 + 改包）',
		v.ok === true && p.status === 200 && echoed === '{"replayed":true}',
		`status=${p.status} 服务端收到的 body=${JSON.stringify(echoed)}`)
})

/* 5. 脚本与 sourcemap（夹具自带 .map，离线可验） */
await attempt('browser_scripts', async () => {
	const list = JSON.parse((await call('browser_scripts', { action: 'list', tabId, urlPattern: 'app\\.js', limit: 10 })).js)
	const source = await call('browser_scripts', { action: 'source', tabId, urlPattern: 'app\\.js$', save: true })
	const sourceJson = JSON.parse(source.js)
	const dump = await call('browser_scripts', { action: 'dump', tabId, urlPattern: 'app\\.js', limit: 5 })
	const manifest = JSON.parse(await readFile(dump.files, 'utf8'))
	const smap = await call('browser_scripts', { action: 'sourcemap', tabId, urlPattern: 'app\\.js$', index: 0 })
	const smapJson = JSON.parse(smap.js)
	const tree = await readdir(smap.files, { recursive: true })
	const restored = tree.find((p) => String(p).endsWith('sign.js'))
	const content = restored ? await readFile(path.join(smap.files, restored), 'utf8') : ''
	check('browser_scripts list/source/dump', list.count >= 1 && sourceJson.bytes > 0 && manifest.count >= 1 && !path.basename(source.files).endsWith('.js.js'),
		`matched=${list.count} source=${sourceJson.bytes}B dump=${manifest.count}(失败 ${manifest.failures}) file=${path.basename(source.files)}`)
	check('browser_scripts sourcemap（还原原始源码树）',
		smapJson.restored >= 2 && content.includes('export function sign'),
		`via=${smapJson.via} restored=${smapJson.restored}/${smapJson.sources} 抽查=${restored} ${content.length}B`)
})

/* 6. 调试器：函数 hook 抓真实入参 */
await attempt('browser_debugger', async () => {
	await call('browser_debugger', { action: 'enable', tabId })
	await call('browser_debugger', { action: 'hook', tabId, expression: 'window.__dshSign' })
	await bridge('eval', { tabId, expression: `window.__dshCall = null; setTimeout(function () { window.__dshCall = window.__dshSign(10, 4); }, 200); 'armed'` })
	await new Promise((resolve) => setTimeout(resolve, 1_800))
	const state = JSON.parse((await call('browser_debugger', { action: 'state', tabId })).js)
	const frame = state.callFrames[0]
	if (!frame) {
		check('browser_debugger hook（抓真实入参 + 帧上改参）', false, '没有暂停（断点未命中）')
		return
	}
	const read = JSON.parse((await call('browser_debugger', { action: 'eval', tabId, callFrameId: frame.callFrameId, expression: 'JSON.stringify({ a: a, b: b })' })).js)
	await call('browser_debugger', { action: 'eval', tabId, callFrameId: frame.callFrameId, expression: 'a = 1' })
	await call('browser_debugger', { action: 'resume', tabId })
	await new Promise((resolve) => setTimeout(resolve, 400))
	const value = (await bridge('eval', { tabId, expression: 'window.__dshCall' })).value
	const unbreak = JSON.parse((await call('browser_debugger', { action: 'unbreak', tabId, all: true })).js)
	check('browser_debugger hook（抓真实入参 + 帧上改参）',
		state.paused === true && read.value.includes('"a":10') && value === 7 && unbreak.removed === 1,
		`暂停=${state.paused} 入参=${read.value} 改 a=1 后返回=${value} 断点已清=${unbreak.removed}`)
})

/* 7. 改包：hold → fulfill；认证挑战 → 提供凭据 */
await attempt('browser_intercept', async () => {
	await call('browser_intercept', { action: 'enable', tabId, urlPattern: '*/api/echo*', hold: true })
	await bridge('eval', { tabId, expression: `window.__forge = null; fetch('/api/echo?forged=1').then(r => r.text().then(t => { window.__forge = { status: r.status, text: t }; })).catch(e => { window.__forge = { error: String(e) }; }); 'go'` })
	await new Promise((resolve) => setTimeout(resolve, 1_500))
	const parked = JSON.parse((await call('browser_intercept', { action: 'list', tabId, parked: true })).js)
	await call('browser_intercept', { action: 'fulfill', tabId, requestId: parked.parkedIds[0], responseCode: 503, body: '{"forged":true}' })
	await new Promise((resolve) => setTimeout(resolve, 1_000))
	const seen = JSON.parse((await bridge('eval', { tabId, expression: 'JSON.stringify(window.__forge)' })).value)
	await call('browser_intercept', { action: 'disable', tabId })
	check('browser_intercept（hold → fulfill 伪造响应）', parked.parked === 1 && seen.status === 503 && seen.text === '{"forged":true}',
		`parked=${parked.parked} 页面收到=${JSON.stringify(seen)}`)
})

await attempt('browser_intercept auth', async () => {
	// 真实工作流：hold 住 → 放行 → 401 触发认证挑战 → 提供凭据 → 放行带凭据的重试。
	// 单靠 fetch() 不会触发挑战（401 只是普通响应），必须走顶层导航。
	try {
		await call('browser_intercept', { action: 'enable', tabId, urlPattern: '*/api/auth*', hold: true, handleAuthRequests: true })
		await bridge('eval', { tabId, expression: `location.href = '/api/auth?t=' + Date.now(); 'navigating'` }).catch(() => {})
		let answered = null
		let sawChallenge = false
		for (let i = 0; i < 12; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 400))
			const listed = JSON.parse((await call('browser_intercept', { action: 'list', tabId })).js)
			const challenge = (listed.pendingAuth ?? [])[0]
			if (challenge !== undefined) {
				sawChallenge = true
				answered = JSON.parse((await call('browser_intercept', {
					action: 'auth', tabId, requestId: challenge.requestId, response: 'ProvideCredentials', username: 'dsh', password: 'secret',
				})).js)
				continue
			}
			const parkedId = (listed.parkedIds ?? [])[0]
			if (parkedId !== undefined) await call('browser_intercept', { action: 'continue', tabId, requestId: parkedId })
		}
		const landed = (await bridge('eval', { tabId, expression: 'location.href + "|" + (document.body ? document.body.innerText.slice(0, 80) : "")' }).catch(() => ({ value: '' }))).value
		if (!sawChallenge) {
			skip('browser_intercept auth（未观察到认证挑战）', `页面=${String(landed).slice(0, 60)}`)
			return
		}
		check('browser_intercept auth（拦截 → 放行 → 应答 Basic 挑战 → 放行重试）',
			answered?.answered === 'ProvideCredentials' && String(landed).includes('authorized'),
			`answered=${answered?.answered} 页面=${String(landed).slice(0, 60)}`)
	} finally {
		await call('browser_intercept', { action: 'disable', tabId }).catch(() => {})
		await bridge('nav', { tabId, url: `${origin}/`, wait: true }).catch(() => {})
		await new Promise((resolve) => setTimeout(resolve, 400))
	}
})

/* 7b. 只观察模式（hold:false）必须自己放行，否则页面会被挂死 */
await attempt('browser_intercept record-only', async () => {
	await call('browser_intercept', { action: 'enable', tabId, urlPattern: '*/api/echo*watch=1*', hold: false })
	const seen = await bridge('eval', {
		tabId,
		expression: `(async () => { try { const r = await fetch('/api/echo?watch=1', { method: 'POST', body: '{"watch":true}' }); const t = await r.text(); return JSON.stringify({ status: r.status, echoed: JSON.parse(t).body }); } catch (e) { return JSON.stringify({ error: String(e) }); } })()`,
		timeoutMs: 15_000,
	}).catch((error) => ({ value: JSON.stringify({ error: String(error.message) }) }))
	const listed = JSON.parse((await call('browser_intercept', { action: 'list', tabId, urlPattern: 'watch=1' })).js)
	await call('browser_intercept', { action: 'disable', tabId })
	const result = JSON.parse(String(seen.value))
	check('browser_intercept hold:false（只记录并自动放行，不挂页面）',
		result.status === 200 && result.echoed === '{"watch":true}' && listed.count >= 1 && listed.parked === 0,
		`页面=${JSON.stringify(result)} 记录到=${listed.count} 仍挂起=${listed.parked}`)
})

/* 8. 页面级记录器 */
await attempt('browser_hook', async () => {
	const install = JSON.parse((await call('browser_hook', { action: 'install', tabId, persist: false })).js)
	await bridge('eval', {
		tabId,
		expression: `fetch('/api/echo?hooked=1', { method: 'POST', headers: { 'X-Fixture': 'hooked' }, body: JSON.stringify({ from: 'page' }) }).then(r => r.text())`,
	})
	await new Promise((resolve) => setTimeout(resolve, 1_000))
	const log = JSON.parse((await call('browser_hook', { action: 'log', tabId, urlPattern: 'hooked=1', limit: 5 })).js)
	const record = log.records[0]
	const restore = JSON.parse((await call('browser_hook', { action: 'restore', tabId })).js)
	check('browser_hook（记录页面自己构造的请求 → 还原）',
		install.status === 'installed' && record?.method === 'POST' && String(record.headers).includes('hooked') && String(record.body).includes('from') && restore.status === 'restored',
		`records=${log.count} method=${record?.method} headers=${record?.headers} body=${record?.body}`)
})

/* 9. WebSocket（夹具不含 WS 服务，用公共 echo；不可达则跳过） */
await attempt('browser_websocket_log', async () => {
	const opened = await bridge('eval', {
		tabId,
		expression: `(async () => { try { const ws = new WebSocket('wss://ws.postman-echo.com/raw'); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('error')); setTimeout(() => rej(new Error('timeout')), 8000); }); ws.send(JSON.stringify({ verify: 'reverse' })); await new Promise(r => setTimeout(r, 1200)); ws.close(); return 'ok'; } catch (e) { return 'unreachable: ' + String(e); } })()`,
		timeoutMs: 30_000,
	})
	if (String(opened.value).startsWith('unreachable')) {
		skip('browser_websocket_log（公共 echo 不可达）', String(opened.value).slice(0, 80))
		return
	}
	await new Promise((resolve) => setTimeout(resolve, 600))
	const payload = await call('browser_websocket_log', { tabId, limit: 5 })
	if (typeof payload?.json !== 'string') {
		check('browser_websocket_log（握手 + 帧）', false, `工具返回形状异常：${JSON.stringify(payload).slice(0, 160)}`)
		return
	}
	const parsed = JSON.parse(payload.json)
	const sock = parsed.sockets.find((s) => String(s.url).includes('postman-echo'))
	check('browser_websocket_log（握手 + 帧）', Boolean(sock) && parsed.frames.length >= 2,
		`sockets=${parsed.sockets.length} frames=${parsed.frames.length} status=${sock?.status} 方向=${parsed.frames.map((f) => f.dir).join('/')}`)
})

/* 10. 暂停防护 */
await attempt('tab_paused 防护', async () => {
	await bridge('eval', { tabId, expression: `window.__spin = 0; window.__timer = setInterval(function () { window.__spin += 1; }, 20); 'busy'` })
	await bridge('debugger.pause', { tabId, timeoutMs: 6_000 })
	let blocked = ''
	try { await bridge('eval', { tabId, expression: '1+1' }, 10_000) } catch (error) { blocked = String(error.message) }
	const shot = await bridge('screenshot', { tabId, format: 'png' })
	await bridge('debugger.resume', { tabId })
	await bridge('eval', { tabId, expression: 'clearInterval(window.__timer); 1' })
	check('暂停时 JS 类命令被拒、截图仍可用、resume 后恢复',
		/paused at a breakpoint/.test(blocked) && String(shot.base64).length > 100,
		`eval=${blocked.slice(0, 60)}… screenshot=${String(shot.base64).length} 字符`)
})

/* 12. 深层路径：行断点 / step / 异常自恢复 / worker / 捕获策略 / HAR clear */
await attempt('browser_debugger 行断点（urlRegex + 条件）', async () => {
	await call('browser_debugger', { action: 'enable', tabId })
	const bp = JSON.parse((await call('browser_debugger', {
		action: 'break', tabId, urlRegex: 'app\\.js', lineNumber: 0, condition: 'typeof window !== "undefined"',
	})).js)
	// 重新注入一份 app.js（带 cache-busting query）才会再次执行到那一行
	const injected = await bridge('eval', {
		tabId,
		expression: `(async () => { await new Promise((res) => { const s = document.createElement('script'); s.src = '/app.js?bp=' + Date.now(); s.onload = res; s.onerror = res; document.head.appendChild(s); }); return 'injected'; })()`,
		timeoutMs: 8_000,
	}).catch((error) => ({ value: `eval-failed-fast: ${String(error.message).slice(0, 60)}` }))
	await new Promise((resolve) => setTimeout(resolve, 800))
	const state = JSON.parse((await call('browser_debugger', { action: 'state', tabId })).js)
	const hit = state.paused === true && (state.hitBreakpoints ?? []).length > 0
	await call('browser_debugger', { action: 'unbreak', tabId, all: true })
	await ensureClean()
	check('browser_debugger 行断点（urlRegex + 条件命中）', hit,
		`解析到=${bp.resolvedNow ?? (bp.locations ?? []).length} 暂停=${state.paused} 命中=${(state.hitBreakpoints ?? []).join(',')} 触发它的 eval=${String(injected.value).slice(0, 40)}`)
})

await attempt('browser_debugger step / 异常自恢复', async () => {
	await bridge('eval', { tabId, expression: `window.__spin2 = 0; window.__tmr2 = setInterval(function () { window.__spin2 += 1; }, 20); 'busy'` })
	const paused = JSON.parse((await call('browser_debugger', { action: 'pause', tabId, timeoutMs: 6_000 })).js)
	const over = JSON.parse((await call('browser_debugger', { action: 'step', tabId, step: 'over', timeoutMs: 6_000 })).js)
	const into = JSON.parse((await call('browser_debugger', { action: 'step', tabId, step: 'into', timeoutMs: 6_000 })).js)
	const out = JSON.parse((await call('browser_debugger', { action: 'step', tabId, step: 'out', timeoutMs: 6_000 })).js)
	await ensureClean()
	await ensureClean()
	await bridge('eval', { tabId, expression: 'clearInterval(window.__tmr2); 1' }).catch(() => ({}))
	check('browser_debugger step over/into/out', paused.paused === true && over.paused === true && into.paused === true && (out.paused === true || typeof out.note === 'string'),
		`pause=${paused.pauseCount} over=${over.pauseCount} into=${into.pauseCount} out=${out.paused === true ? out.pauseCount : `(已跑出：${String(out.note).slice(0, 40)})`}`)

	await call('browser_debugger', { action: 'exceptions', tabId, state: 'all' })
	await ensureClean()
	await bridge('eval', { tabId, expression: `setTimeout(function () { try { null.x; } catch (e) { window.__caught = String(e); } }, 150); 'armed'` }).catch(() => {})
	let sawPause = false
	for (let i = 0; i < 12 && !sawPause; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 400))
		sawPause = JSON.parse((await call('browser_debugger', { action: 'state', tabId })).js).paused === true
	}
	const cleared = JSON.parse((await call('browser_debugger', { action: 'exceptions', tabId, state: 'none' })).js)
	const after = JSON.parse((await call('browser_debugger', { action: 'state', tabId })).js)
	check('browser_debugger 异常断点 + 关策略自动恢复', sawPause && cleared.resumed === true && after.paused === false,
		`暂停=${sawPause} resumed=${cleared.resumed} 之后 paused=${after.paused}`)
})

await attempt('worker 目标（auto-attach → 直接驱动）', async () => {
	const before = JSON.parse((await call('browser_targets', { tabId })).json)
	const attached = JSON.parse((await call('browser_targets', { tabId, autoAttach: true })).json)
	await bridge('eval', {
		tabId,
		expression: `window.__workerReply = null; window.__w = new Worker('/worker.js'); window.__w.onmessage = function (e) { window.__workerReply = e.data; }; window.__w.postMessage(6); 'created'`,
	})
	await new Promise((resolve) => setTimeout(resolve, 1_500))
	const listed = JSON.parse((await call('browser_targets', { tabId })).json)
	const worker = listed.targets.find((t) => String(t.url).includes('/worker.js'))
	const pageReply = (await bridge('eval', { tabId, expression: 'window.__workerReply' })).value
	if (!worker) {
		check('worker 目标（auto-attach → 直接驱动）', false, `auto-attach 后仍未发现 worker；targets=${listed.targets.map((t) => t.type).join(',')}（autoAttach=${JSON.stringify(attached).slice(0, 80)}）`)
		return
	}
	const inWorker = await call('browser_cdp', {
		targetId: worker.targetId,
		method: 'Runtime.evaluate',
		params: { expression: 'typeof self.sign + "|" + self.sign(6)', returnByValue: true },
	})
	const workerValue = JSON.parse(inWorker.json).result.value
	await call('browser_cdp', {
		targetId: worker.targetId,
		method: 'Runtime.evaluate',
		params: { expression: 'self.onmessage = function (e) { self.postMessage("hooked:" + self.sign(e.data)); }; "patched"', returnByValue: true },
	})
	await bridge('eval', { tabId, expression: 'window.__w.postMessage(5)' })
	await new Promise((resolve) => setTimeout(resolve, 600))
	const patched = (await bridge('eval', { tabId, expression: 'window.__workerReply' })).value
	await call('browser_targets', { tabId, autoAttach: false }).catch(() => {})
	check('worker 目标（auto-attach → 直接驱动 → 热改 worker 逻辑）',
		workerValue === 'function|sig-42' && pageReply === 'sig-42' && patched === 'hooked:sig-35',
		`autoAttach 前=${before.count} 后=${listed.count}(${worker.source}) worker 内求值=${workerValue} 热改后回包=${patched}`)
})

await attempt('browser_body_policy', async () => {
	const before = JSON.parse((await call('browser_body_policy', { tabId })).json)
	const set = JSON.parse((await call('browser_body_policy', { policy: 'off', tabId })).json)
	const read = JSON.parse((await call('browser_body_policy', { tabId })).json)
	await call('browser_body_policy', { policy: 'xhr', tabId })
	check('browser_body_policy 读/写捕获策略', before.policy === 'xhr' && set.policy === 'off' && read.policy === 'off',
		`${before.policy} → ${set.policy} → 已恢复 xhr`)
})

await attempt('browser_intercept 响应阶段 fail / body', async () => {
	await call('browser_intercept', { action: 'enable', tabId, urlPattern: '*/api/echo*stage=2*', stage: 'response', hold: true })
	await bridge('eval', {
		tabId,
		expression: `window.__stage2 = null; fetch('/api/echo?stage=2').then(r => r.text().then(t => { window.__stage2 = { status: r.status, len: t.length }; })).catch(e => { window.__stage2 = { error: String(e) }; }); 'go'`,
	})
	await new Promise((resolve) => setTimeout(resolve, 1_500))
	const parked = JSON.parse((await call('browser_intercept', { action: 'list', tabId, parked: true })).js)
	const body = JSON.parse((await call('browser_intercept', { action: 'body', tabId, requestId: parked.parkedIds[0] })).js)
	await call('browser_intercept', { action: 'fail', tabId, requestId: parked.parkedIds[0], errorReason: 'Aborted' })
	await new Promise((resolve) => setTimeout(resolve, 1_000))
	const seen = JSON.parse((await bridge('eval', { tabId, expression: 'JSON.stringify(window.__stage2)' })).value)
	await call('browser_intercept', { action: 'disable', tabId })
	check('browser_intercept 响应阶段（读原文 → fail 中断）',
		parked.parked === 1 && body.bytes > 0 && typeof seen.error === 'string',
		`parked=${parked.parked} body=${body.bytes}B 页面=${JSON.stringify(seen)}`)
})

await attempt('cookies domain 形式 + HAR clear', async () => {
	const set = JSON.parse((await call('browser_cookies', {
		action: 'set', tabId, domain: '127.0.0.1', path: '/', name: 'dsh_domain', value: 'v2', httpOnly: true,
	})).json)
	const got = JSON.parse((await call('browser_cookies', { action: 'get', tabId, url: `${origin}/`, name: 'dsh_domain' })).json)
	const del = JSON.parse((await call('browser_cookies', { action: 'delete', tabId, domain: '127.0.0.1', path: '/', name: 'dsh_domain' })).json)
	const har = await call('browser_network_har', { tabId, includeStatic: true, includeBodies: false, clear: true, save: false })
	const after = await bridge('network.log', { tabId, includeStatic: true })
	check('browser_cookies domain 形式 + browser_network_har clear',
		set.success !== false && got.count === 1 && del.deleted === true && har.entries > 0 && after.total === 0,
		`set=${set.success} 命中=${got.count} 删除=${del.deleted} HAR=${har.entries} 行 clear 后缓冲=${after.total}`)
})

/* 13. 产物落盘与清理 */
await attempt('产物落盘 + cleanup', async () => {
	const tree = await readdir(shotsDir, { recursive: true })
	const tops = (await readdir(shotsDir)).sort()
	const hasTrees = tops.includes('har') && tops.includes('scripts') && tops.includes('sourcemaps')
	// 直接验 cleanupArtifacts 的实现（工具层 browser_cleanup 由插件装配，这里验同一函数）
	const { cleanupArtifacts } = await import(new URL('../lib/types/server.js', import.meta.url))
	const result = await cleanupArtifacts({ shotsDir, artifactSubdirs: ['har', 'scripts', 'sourcemaps'] })
	const after = await readdir(shotsDir)
	check('产物落盘到 shotsDir 的 har/scripts/sourcemaps 且可被 cleanup 清理',
		hasTrees && result.subdirsRemoved.length === 3 && after.length === 0,
		`落盘 ${tree.length} 项 → 三棵树目录=${tops.join(',')} cleanup 删除=[${result.subdirsRemoved.join(',')}] 剩余=${after.length}`)
})

/* 14. 老工具的 render 也必须携带载荷（模型只看得到 render） */
await attempt('工具 render 携带载荷（含老工具）', async () => {
	const { apply } = await import(new URL('../lib/index.js', import.meta.url))
	const legacy = new Map()
	const stubCtx = {
		tools: { register: (tool) => legacy.set(tool.name, tool) },
		systemPrompt: { section: () => {} },
		logger: { info: () => {} },
		inject: () => {},
		effect: () => {},
		fiber: { state: 0 },
	}
	await import(new URL('../lib/invariant.js', import.meta.url)).catch(() => {})
	// enabled:false 让 assemble 只注册工具、不起桥（也不会去抢 9777 端口）
	apply(stubCtx, { enabled: false, port: 1, token: 'x', shotsDir: shotsDir, launch: { enabled: false } })
	const samples = [
		['browser_read', { tabId: 1, mode: 'text', title: 'T', url: 'https://x/', content: 'PAYLOAD-MARKER-READ', truncated: false }, 'PAYLOAD-MARKER-READ'],
		['browser_snapshot', { tabId: 1, title: 'T', url: 'https://x/', items: [{ ref: 'PAYLOAD-MARKER-REF', tag: 'a' }] }, 'PAYLOAD-MARKER-REF'],
		['browser_console_log', { tabId: 1, count: 1, total: 1, entries: [{ level: 'log', text: 'PAYLOAD-MARKER-CONSOLE' }] }, 'PAYLOAD-MARKER-CONSOLE'],
		['browser_network_log', { tabId: 1, count: 1, total: 1, requests: [{ requestId: 'r1', method: 'GET', url: 'https://x/PAYLOAD-MARKER-NET', status: 200 }] }, 'PAYLOAD-MARKER-NET'],
		['browser_tabs', { count: 1, activeTabId: 1, tabs: [{ id: 1, url: 'https://x/PAYLOAD-MARKER-TABS', title: 't' }] }, 'PAYLOAD-MARKER-TABS'],
		['browser_evaluate', { tabId: 1, json: 'PAYLOAD-MARKER-EVAL' }, 'PAYLOAD-MARKER-EVAL'],
	]
	const hidden = []
	let checked = 0
	for (const [name, value, marker] of samples) {
		const tool = legacy.get(name)
		if (tool === undefined) { hidden.push(`${name}: 未注册`); continue }
		checked += 1
		const text = tool.output.render({}, value).map((block) => block?.text ?? '').join('\n')
		if (!text.includes(marker)) hidden.push(`${name}: render 里没有载荷（得到 ${JSON.stringify(text.slice(0, 40))}）`)
	}
	check('工具 render 携带载荷（含老工具 read/snapshot/console/network/tabs/evaluate）',
		hidden.length === 0 && checked === samples.length,
		hidden.length === 0 ? `抽查 ${checked} 个老工具的 render，载荷均在` : hidden.join('; '))
})

/* ---------------------------------------------------------------- report */

await ensureClean()
console.log(`\n=== 汇总 === 通过=${rows.filter((r) => r.ok).length} 失败=${rows.filter((r) => !r.ok).length} 跳过=${skipped}`)
console.log(`schema 校验：入参 ${argChecks} 次 / 返回值 ${outChecks} 次，违规 ${schemaProblems.length} 条`)
console.log(`render 载荷校验：${renderChecks} 次工具调用 + 老工具抽查，隐藏载荷 ${renderProblems.length} 处`)
for (const problem of schemaProblems) console.log(`SCHEMA VIOLATION: ${problem}`)
for (const problem of renderProblems) console.log(`RENDER HIDES PAYLOAD: ${problem}`)
for (const row of rows) if (!row.ok) console.log(`FAILED: ${row.name} — ${row.detail}`)

await bridge('tabs.close', { tabId }).catch(() => {})
fixture.server.close()
if (KEEP) console.log(`\n产物保留在：${shotsDir}`)
else await rm(shotsDir, { recursive: true, force: true }).catch(() => {})

const failed = rows.filter((r) => !r.ok).length
process.exit(failed === 0 && schemaProblems.length === 0 && renderProblems.length === 0 ? 0 : 1)
