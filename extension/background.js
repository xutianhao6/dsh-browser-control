/**
 * DSH Browser Control — MV3 service worker.
 *
 * Maintains one outbound WebSocket to the local bridge (bridge/server.mjs),
 * receives JSON commands, executes them through chrome.tabs and the Chrome
 * DevTools Protocol (chrome.debugger), and replies with JSON results.
 *
 * Wire protocol (text frames, one JSON object each):
 *   ext -> bridge: {type:'hello', client, version, browser}
 *                  {type:'pong', t}                     (reply to {type:'ping'})
 *                  {type:'result', id, ok, result|error}
 *   bridge -> ext: {type:'ping', t}
 *                  {type:'command', id, command, params}
 */
'use strict';

const EXT_VERSION = chrome.runtime.getManifest().version;
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_PORT = 9777;
const DEFAULT_TOKEN = 'dsh-local';

/** Stored config shape (version 2): {port, token, autoConnect}. */
const DEFAULT_CONFIG = Object.freeze({
	port: DEFAULT_PORT,
	token: DEFAULT_TOKEN,
	autoConnect: true,
});

let cfg = { ...DEFAULT_CONFIG };
let ws = null;
let wsState = 'idle'; // idle | connecting | open
let backoffAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let helloInfo = null;
let lastError = null;
/** True after the user clicks 断开连接 in the popup; blocks auto-reconnect
 *  until they click 立即连接 again. Reset on browser restart. */
let manualDisconnect = false;

/** Tab ids we hold a persistent debugger attachment on. Detach only on
 *  explicit disconnect, tab close, or DevTools stealing the tab. */
const attachedTabs = new Set();

/** Per-tab ring buffer of CDP `Runtime.consoleAPICalled` entries since attach.
 *  Map<tabId, Array<entry>>. Entries are capped at 500 per tab; older entries
 *  shift off. A new attach bumps the tab's generation so stale entries queued
 *  before re-attach are not surfaced as if they were current. */
const consoleLog = new Map();
/** Bumped on every re-attach so entries recorded against an old generation are
 *  dropped. Map<tabId, number>. */
const tabBufferGenerations = new Map();
/** Per-tab in-flight network entries keyed by `Network.requestId`; merged
 *  across `requestWillBeSent` / `responseReceived` / `loadingFinished` /
 *  `loadingFailed` (plus the `*ExtraInfo` events, which is where the real
 *  `Cookie` / `Set-Cookie` / `Authorization` headers live).
 *  Map<tabId, Map<requestId, entry>>. */
const networkLog = new Map();
/** Per-tab response bodies fetched through `Network.getResponseBody`, keyed by
 *  requestId. Chrome keeps a body available only until the renderer evicts it,
 *  so entries carry either the bytes or the reason they are gone.
 *  Map<tabId, Map<requestId, {body, base64Encoded, bytes, truncated, error}>>. */
const bodyCache = new Map();
/** Per-tab `Debugger` domain state (enabled, paused, call frames, hits).
 *  Map<tabId, object>. */
const debuggerState = new Map();
/** Per-tab `Debugger.scriptParsed` registry — every script the tab ever parsed,
 *  including inline/eval/webpack chunks that never appear as a DOM `<script src>`.
 *  Map<tabId, Map<scriptId, entry>>. */
const scriptRegistry = new Map();
/** Per-tab ring of past `Debugger.paused` events (last 20) so a pause that was
 *  already resumed stays auditable. Map<tabId, Array<entry>>. */
const pauseLog = new Map();
/** Per-tab WebSocket sockets + captured frames. Map<tabId, {sockets, frames}>. */
const wsLog = new Map();
/** Per-tab `Fetch` interception state: enabled flag, patterns, paused requests
 *  and the pause log the model reads. Map<tabId, {enabled, patterns, stage,
 *  paused, log}>. */
const fetchState = new Map();
/** Per-tab targets discovered through `Target.attachedToTarget` /
 *  `Target.targetCreated` events (workers, OOPIFs). `chrome.debugger.getTargets()`
 *  does not enumerate a page's dedicated workers, so auto-attach is the only way
 *  to learn their ids and drive them with `cdp {targetId}`.
 *  Map<tabId, Map<targetId, entry>>. */
const targetRegistry = new Map();
/** Scripts registered per tab are capped so a long-lived page cannot grow the
 *  registry without bound. */
const SCRIPT_REGISTRY_MAX = 5_000;
/** WebSocket frames kept per tab (ring). */
const WS_FRAME_MAX = 2_000;
/** Intercepted-request log kept per tab (ring). */
const FETCH_LOG_MAX = 500;
/** Bodies larger than this are reported as metadata only, not transferred. */
const BODY_MAX_BYTES = 8 * 1024 * 1024;
/** Auto-capture ceiling for a single response body (small ones are cheap). */
const BODY_AUTO_MAX_BYTES = 1 * 1024 * 1024;
/**
 * Response-body auto-capture policy:
 *   'off' — never fetch bodies in the background (on-demand only)
 *   'xhr' — auto-capture XHR/Fetch responses (default: the API traffic)
 *   'all' — every document/script/font/… response too
 * Set with the `bodies.policy` command. Background capture is best-effort:
 * `Network.getResponseBody` fails once the renderer drops the body.
 */
let bodyAutoCapture = 'xhr';
/** Set by `bodies.policy` to also keep request post bodies beyond the 64KB
 *  inline cap (fetched on demand through `Network.getRequestPostData`). */
const bodiesAutoPolicyValues = new Set(['off', 'xhr', 'all']);

/**
 * Native dialog (alert/confirm/prompt) auto-answer policy. 'accept' answers
 * every dialog as OK (prompt uses defaultText), 'dismiss' cancels, 'manual'
 * leaves dialogs open. A command can pass params.dialogPolicy to override for
 * that call's duration; the default is accept so automation never deadlocks.
 */
let dialogPolicy = 'accept';
/** Dialogs answered since attach, surfaced in results for verification. */
const dialogLog = [];

/* ------------------------------------------------------------------ config */

async function loadConfig() {
	const stored = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
	// v1→v2 migration: convert old serverUrl to port.
	if (stored.serverUrl && stored.port === undefined) {
		try {
			stored.port = new URL(stored.serverUrl).port ? Number(new URL(stored.serverUrl).port) : DEFAULT_PORT;
		} catch { stored.port = DEFAULT_PORT; }
		delete stored.serverUrl;
	}
	cfg = { ...DEFAULT_CONFIG, ...stored };
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	for (const [key, change] of Object.entries(changes)) {
		if (key in DEFAULT_CONFIG) cfg[key] = change.newValue;
	}
});

/* ------------------------------------------------------------ ws lifecycle */

function setBadge(text, color) {
	try {
		chrome.action.setBadgeBackgroundColor({ color });
		chrome.action.setBadgeText({ text });
	} catch (err) {
		console.warn('[dsh-bridge] badge unavailable:', err.message);
	}
}

function setState(state) {
	wsState = state;
	if (state === 'open') setBadge('ON', '#16a34a');
	else if (state === 'connecting') setBadge('…', '#d97706');
	else setBadge('OFF', '#6b7280');
}

function send(obj) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return false;
	ws.send(JSON.stringify(obj));
	return true;
}

function scheduleReconnect() {
	if (manualDisconnect || !cfg.autoConnect) return;
	const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** backoffAttempt);
	backoffAttempt += 1;
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, delay);
}

function connect() {
	if (wsState === 'open' || wsState === 'connecting') return;
	clearTimeout(reconnectTimer);
	if (manualDisconnect || !cfg.autoConnect) return;

	let url;
	try {
		url = new URL(`ws://127.0.0.1:${cfg.port}/ws`);
	} catch (err) {
		lastError = `端口无法解析: ${err.message}`;
		setState('idle');
		return;
	}
	url.searchParams.set('token', cfg.token);

	setState('connecting');
	let sock;
	try {
		sock = new WebSocket(url.toString());
	} catch (err) {
		lastError = err.message;
		setState('idle');
		scheduleReconnect();
		return;
	}
	ws = sock;

	sock.onopen = () => {
		if (sock !== ws) return;
		backoffAttempt = 0;
		lastError = null;
		setState('open');
		startHeartbeat();
		sendHello();
	};
	sock.onmessage = (ev) => {
		if (sock !== ws || typeof ev.data !== 'string') return;
		let msg;
		try { msg = JSON.parse(ev.data); } catch { return; }
		handleBridgeMessage(msg);
	};
	sock.onclose = () => {
		if (sock !== ws) return;
		stopHeartbeat();
		ws = null;
		setState('idle');
		scheduleReconnect();
	};
	sock.onerror = () => { /* onclose always follows */ };
}

function disconnectNow() {
	clearTimeout(reconnectTimer);
	stopHeartbeat();
	if (ws) {
		const sock = ws;
		ws = null;
		sock.onclose = null;
		try { sock.close(); } catch { /* ignore */ }
	}
	detachAll();
	setState('idle');
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), HEARTBEAT_MS);
}

function stopHeartbeat() {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function sendHello() {
	const ua = navigator.userAgent;
	const name = /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : 'chromium';
	const versionMatch = ua.match(/(?:Edg|Chrome)\/([\d.]+)/);
	helloInfo = { name, version: versionMatch ? versionMatch[1] : 'unknown', ua };
	send({ type: 'hello', client: 'dsh-browser-extension', version: EXT_VERSION, browser: helloInfo });
}

/* Alarm keeps the SW alive for reconnect even without user events. */
try { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); }
catch { chrome.alarms.create('keepalive', { periodInMinutes: 1 }); }
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== 'keepalive') return;
	if (wsState === 'idle') connect();
	else send({ type: 'ping', t: Date.now() });
});

/* ------------------------------------------------------------- dispatching */

function handleBridgeMessage(msg) {
	if (msg.type === 'ping') { send({ type: 'pong', t: msg.t }); return; }
	if (msg.type === 'command' && typeof msg.id === 'string') {
		runCommand(msg.command, msg.params ?? {})
			.then((result) => send({ type: 'result', id: msg.id, ok: true, result }))
			.catch((err) => send({ type: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) }));
	}
}

async function runCommand(command, params) {
	const handler = COMMANDS[command];
	if (!handler) throw new Error(`unknown command: ${command}`);
	return handler(params);
}

/* ------------------------------------------------------------ tab helpers */

async function resolveTab(tabId) {
	if (tabId !== undefined && tabId !== null) {
		const tab = await chrome.tabs.get(tabId);
		return tab;
	}
	const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (focused) return focused;
	const all = await chrome.tabs.query({});
	if (all.length > 0) return all[0];
	throw new Error('no tab available');
}

function waitTabComplete(tabId, timeoutMs) {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); };
		const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
		chrome.tabs.onUpdated.addListener(listener);
		chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(); }).catch(finish);
		setTimeout(finish, timeoutMs);
	});
}

/** Bring the tab and its window forward so real input can land, WITHOUT
 *  touching window geometry: `focused` only raises the window; tab activation
 *  never moves or resizes anything. The user's window size/position/state
 *  (maximized included) is never modified. A minimized window keeps its 0x0
 *  viewport where real input cannot land — report that instead of
 *  force-restoring it (state:'normal' would also un-maximize the window). */
async function activateTabWindow(tabId) {
	let win;
	try {
		const tab = await chrome.tabs.get(tabId);
		win = await chrome.windows.get(tab.windowId);
	} catch {
		return; // tab or window is closing; the command reports it downstream
	}
	if (win.state === 'minimized') {
		const err = new Error('browser window is minimized — real keyboard/mouse input cannot reach a 0x0 viewport; restore the window manually (automation never changes window size or position)');
		err.code = 'window_minimized';
		throw err;
	}
	try {
		await chrome.windows.update(win.id, { focused: true });
		await chrome.tabs.update(tabId, { active: true });
	} catch { /* tab may be closing; input will fail downstream anyway */ }
}

/* ---------------------------------------------------------- debugger (CDP) — persistent attachment */

/**
 * Ensure a persistent debugger attachment on `tabId`. Attaches once on first
 * CDP call and holds the attachment until explicit detach or tab close.
 * The Chrome "is being controlled" banner stays visible until detach.
 */
async function ensureAttached(tabId) {
	if (attachedTabs.has(tabId)) return;
	await new Promise((resolve, reject) => {
		chrome.debugger.attach({ tabId }, '1.3', () => {
			const err = chrome.runtime.lastError;
			if (!err) { attachedTabs.add(tabId); resolve(); return; }
			if (/already attached/i.test(err.message)) {
				attachedTabs.add(tabId);
				resolve();
				return;
			}
			reject(new Error(`debugger attach failed: ${err.message} (DevTools 打开着这个页面? 先关掉)`));
		});
	});
	// Enable the domains whose events we consume (dialogs, navigation results,
	// console + network capture for the browser_console_log / browser_network_log tools).
	await dbgSend(tabId, 'Page.enable').catch(() => {});
	await dbgSend(tabId, 'Runtime.enable').catch(() => {});
	await dbgSend(tabId, 'Network.enable').catch(() => {});
	// Bump the per-attached-tab generation so in-flight network entries queued
	// against an old attachment are not surfaced as if they were current.
	tabBufferGenerations.set(tabId, (tabBufferGenerations.get(tabId) ?? 0) + 1);
}

/* Native dialog auto-answer: fires whenever the page opens alert/confirm/
 * prompt/beforeunload while a debugger is attached. Without an answer the
 * page's main thread stays blocked forever. */
chrome.debugger.onEvent.addListener((source, method, params) => {
	const tabId = source?.tabId;
	if (tabId === undefined) return;
	if (method === 'Page.javascriptDialogOpening') {
		const entry = {
			tabId, type: params.type, message: params.message,
			defaultPrompt: params.defaultPrompt, answeredAs: dialogPolicy, t: Date.now(),
		};
		dialogLog.push(entry);
		if (dialogLog.length > 50) dialogLog.shift();
		if (dialogPolicy === 'manual') return;
		chrome.debugger.sendCommand(
			{ tabId },
			'Page.handleJavaScriptDialog',
			{ accept: dialogPolicy === 'accept', promptText: params.defaultPrompt },
			() => void chrome.runtime.lastError,
		);
		return;
	}
	if (method === 'Runtime.consoleAPICalled') {
		// Skip the noisy "log-type:verbose / "time-start" pseudo entries.
		const level = (params.type || 'log').toLowerCase();
		if (level === 'verbose' || level === 'timeStart' || level === 'timeEnd') return;
		const text = (params.args || []).map(arg => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type || '')).join(' ');
		let location;
		if (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]) {
			const f = params.stackTrace.callFrames[0];
			location = `${f.url || '<inline>'}:${f.lineNumber}`;
		}
		const entry = { tabId, level, text, t: params.timestamp ? Math.round(params.timestamp * 1000) : Date.now() };
		if (location) entry.location = location;
		const buf = consoleLog.get(tabId) || [];
		buf.push(entry);
		if (buf.length > 500) buf.shift();
		consoleLog.set(tabId, buf);
		return;
	}
	if (method === 'Network.requestWillBeSent') {
		// requestId from CDP; one per request. Key under the tab; the body is
		// capped at 64KB to keep the buffer from blowing up on large POSTs.
		const POST_LIMIT = 64 * 1024;
		const post = params.request.postData;
		const entry = {
			tabId,
			requestId: params.requestId,
			method: params.request.method,
			url: params.request.url,
			headers: params.request.headers,
			resourceType: params.type,
			postData: typeof post === 'string' && post.length > POST_LIMIT ? post.slice(0, POST_LIMIT) + '…(truncated)' : post,
			initiator: params.initiator && params.initiator.url,
			wallTime: params.wallTime,
		};
		let tabMap = networkLog.get(tabId);
		if (!tabMap) { tabMap = new Map(); networkLog.set(tabId, tabMap); }
		tabMap.set(params.requestId, entry);
		trimNetworkMap(tabMap);
		return;
	}
	if (method === 'Network.responseReceived') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.status = params.response.status;
		entry.statusText = params.response.statusText;
		entry.mimeType = params.response.mimeType;
		entry.responseHeaders = params.response.headers;
		return;
	}
	if (method === 'Network.loadingFinished') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.encodedDataLength = params.encodedDataLength;
		entry.finished = true;
		// Best-effort background body capture: the renderer drops the body once
		// it is done with it, so this has to happen now if it happens at all.
		if (shouldAutoCaptureBody(entry)) void captureResponseBody(tabId, params.requestId);
		return;
	}
	if (method === 'Network.loadingFailed') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.failed = true;
		entry.errorText = params.errorText;
		entry.canceled = params.canceled;
		return;
	}
	if (method === 'Network.requestWillBeSentExtraInfo') {
		// The headers Chrome actually put on the wire. This is the only place
		// `Cookie` / `Authorization` are visible: the plain
		// `Network.requestWillBeSent` payload deliberately omits them.
		const tabMap = networkLog.get(tabId);
		const entry = tabMap && tabMap.get(params.requestId);
		if (entry) entry.extraRequestHeaders = params.headers;
		return;
	}
	if (method === 'Network.responseReceivedExtraInfo') {
		// Where `Set-Cookie` lives (and the real status code on redirect chains).
		const tabMap = networkLog.get(tabId);
		const entry = tabMap && tabMap.get(params.requestId);
		if (entry) {
			entry.extraResponseHeaders = params.headers;
			if (params.statusCode !== undefined) entry.rawStatusCode = params.statusCode;
		}
		return;
	}
	if (method === 'Network.webSocketCreated') {
		const st = ensureWsState(tabId);
		st.sockets.set(params.requestId, {
			requestId: params.requestId,
			url: params.url,
			initiator: params.initiator && params.initiator.url,
			created: Date.now(),
			framesSent: 0,
			framesReceived: 0,
			closed: false,
		});
		return;
	}
	if (method === 'Network.webSocketWillSendHandshakeRequest') {
		const st = ensureWsState(tabId);
		const sock = st.sockets.get(params.requestId);
		if (sock) sock.requestHeaders = params.request && params.request.headers;
		return;
	}
	if (method === 'Network.webSocketHandshakeResponseReceived') {
		const st = ensureWsState(tabId);
		const sock = st.sockets.get(params.requestId);
		if (sock && params.response) {
			sock.status = params.response.status;
			sock.statusText = params.response.statusText;
			sock.responseHeaders = params.response.headers;
		}
		return;
	}
	if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
		const st = ensureWsState(tabId);
		const dir = method.endsWith('Sent') ? 'sent' : 'received';
		const sock = st.sockets.get(params.requestId);
		if (sock) {
			if (dir === 'sent') sock.framesSent += 1; else sock.framesReceived += 1;
		}
		const p = params.response || {};
		const raw = typeof p.payloadData === 'string' ? p.payloadData : '';
		st.frames.push({
			requestId: params.requestId,
			dir,
			opcode: p.opcode,
			bytes: raw.length,
			payload: raw.length > 200_000 ? raw.slice(0, 200_000) + '…(truncated)' : raw,
			t: Date.now(),
		});
		if (st.frames.length > WS_FRAME_MAX) st.frames.shift();
		return;
	}
	if (method === 'Network.webSocketClosed') {
		const st = ensureWsState(tabId);
		const sock = st.sockets.get(params.requestId);
		if (sock) { sock.closed = true; sock.closedAt = Date.now(); }
		return;
	}
	if (method === 'Network.webSocketFrameError') {
		const st = ensureWsState(tabId);
		const sock = st.sockets.get(params.requestId);
		if (sock) sock.error = params.errorMessage;
		return;
	}
	if (method === 'Debugger.scriptParsed') {
		let reg = scriptRegistry.get(tabId);
		if (!reg) { reg = new Map(); scriptRegistry.set(tabId, reg); }
		reg.set(params.scriptId, {
			scriptId: params.scriptId,
			url: params.url,
			sourceMapURL: params.sourceMapURL || '',
			length: params.length,
			startLine: params.startLine, startColumn: params.startColumn,
			endLine: params.endLine, endColumn: params.endColumn,
			executionContextId: params.executionContextId,
			hash: params.hash,
			isModule: params.isModule,
			hasSourceURL: params.hasSourceURL,
			embedderName: params.embedderName,
			t: Date.now(),
		});
		if (reg.size > SCRIPT_REGISTRY_MAX) reg.delete(reg.keys().next().value);
		return;
	}
	if (method === 'Debugger.paused') {
		const state = ensureDebuggerState(tabId);
		state.paused = true;
		state.reason = params.reason;
		state.hitBreakpoints = params.hitBreakpoints || [];
		state.callFrames = params.callFrames || [];
		state.data = params.data ?? null;
		state.pausedAt = Date.now();
		state.pauseCount = (state.pauseCount || 0) + 1;
		const log = pauseLog.get(tabId) || [];
		log.push({
			t: state.pausedAt,
			reason: params.reason,
			hitBreakpoints: params.hitBreakpoints || [],
			top: summarizeFrame((params.callFrames || [])[0]),
		});
		if (log.length > 20) log.shift();
		pauseLog.set(tabId, log);
		return;
	}
	if (method === 'Debugger.resumed') {
		const state = ensureDebuggerState(tabId);
		state.paused = false;
		state.callFrames = [];
		state.hitBreakpoints = [];
		state.reason = null;
		return;
	}
	if (method === 'Fetch.requestPaused') {
		const st = ensureFetchState(tabId);
		const entry = {
			requestId: params.requestId,
			url: params.request && params.request.url,
			method: params.request && params.request.method,
			headers: params.request && params.request.headers,
			postData: params.request && params.request.postData,
			resourceType: params.resourceType,
			responseStatusCode: params.responseStatusCode,
			responseHeaders: params.responseHeaders,
			responseErrorReason: params.responseErrorReason,
			networkId: params.networkId,
			stage: params.responseStatusCode !== undefined ? 'response' : 'request',
			t: Date.now(),
		};
		st.paused.set(params.requestId, entry);
		st.log.push(entry);
		if (st.log.length > FETCH_LOG_MAX) st.log.shift();
		// Record-only mode (`hold: false`) must forward the request itself —
		// merely recording it would park the page forever, which is exactly what
		// the "safe, just watch" mode promises not to do.
		if (st.hold === false) {
			const responseStage = params.responseStatusCode !== undefined;
			const continueOnce = (cdpMethod) => new Promise((resolve) => {
				chrome.debugger.sendCommand({ tabId }, cdpMethod, { requestId: params.requestId }, () => {
					const failed = Boolean(chrome.runtime.lastError);
					void chrome.runtime.lastError;
					resolve(!failed);
				});
			});
			void (async () => {
				const done = responseStage
					? (await continueOnce('Fetch.continueResponse')) || (await continueOnce('Fetch.continueRequest'))
					: await continueOnce('Fetch.continueRequest');
				if (done) st.paused.delete(params.requestId);
			})();
		}
		return;
	}
	if (method === 'Fetch.authRequired') {
		// Only fires when Fetch was enabled with handleAuthRequests. Recorded,
		// never auto-answered in hold mode: the request stays parked until the
		// caller sends `fetch.auth` (or the interception is disabled). In
		// record-only mode it must be answered, or the page hangs on a prompt
		// nobody is looking at.
		const st = ensureFetchState(tabId);
		st.auth = st.auth || [];
		st.auth.push({ requestId: params.requestId, authChallenge: params.authChallenge, t: Date.now() });
		if (st.auth.length > 50) st.auth.shift();
		if (st.hold === false) {
			chrome.debugger.sendCommand(
				{ tabId },
				'Fetch.continueWithAuth',
				{ requestId: params.requestId, authChallengeResponse: { response: 'Default' } },
				() => void chrome.runtime.lastError,
			);
		}
		return;
	}
	if (method === 'Target.attachedToTarget' || method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
		const info = params.targetInfo || {};
		const targetId = info.targetId || params.targetId;
		if (!targetId) return;
		let reg = targetRegistry.get(tabId);
		if (!reg) { reg = new Map(); targetRegistry.set(tabId, reg); }
		const previous = reg.get(targetId) || {};
		reg.set(targetId, {
			...previous,
			targetId,
			type: info.type || previous.type || 'unknown',
			url: info.url !== undefined ? info.url : previous.url,
			title: info.title !== undefined ? info.title : previous.title,
			attached: info.attached !== undefined ? info.attached : previous.attached,
			sessionId: params.sessionId || previous.sessionId,
			via: method,
			t: Date.now(),
		});
		if (reg.size > 200) reg.delete(reg.keys().next().value);
		return;
	}
	if (method === 'Target.detachedFromTarget') {
		const reg = targetRegistry.get(tabId);
		if (reg && params.targetId) reg.delete(params.targetId);
		return;
	}
});

/* ------------------------------------------- capture-state helpers (Phase 1/2) */

function ensureWsState(tabId) {
	let st = wsLog.get(tabId);
	if (!st) { st = { sockets: new Map(), frames: [] }; wsLog.set(tabId, st); }
	return st;
}

function ensureFetchState(tabId) {
	let st = fetchState.get(tabId);
	if (!st) {
		st = { enabled: false, patterns: null, stage: 'Request', hold: true, paused: new Map(), log: [], auth: [] };
		fetchState.set(tabId, st);
	}
	return st;
}

function ensureDebuggerState(tabId) {
	let st = debuggerState.get(tabId);
	if (!st) {
		st = {
			enabled: false, paused: false, reason: null, hitBreakpoints: [],
			callFrames: [], data: null, pauseCount: 0, breakpoints: new Map(),
		};
		debuggerState.set(tabId, st);
	}
	return st;
}

/** One-line view of a call frame, safe to log without the whole scope chain. */
function summarizeFrame(frame) {
	if (!frame) return null;
	return {
		callFrameId: frame.callFrameId,
		functionName: frame.functionName,
		url: frame.url,
		location: frame.location,
		scopeCount: (frame.scopeChain || []).length,
	};
}

/** `Network.getResponseBody` result shape, normalized and size-capped. */
function normalizeBody(res, requestId) {
	const raw = res && typeof res.body === 'string' ? res.body : '';
	const base64Encoded = Boolean(res && res.base64Encoded);
	const bytes = base64Encoded ? Math.floor(raw.length * 0.75) : raw.length;
	if (bytes > BODY_MAX_BYTES) {
		return { requestId, body: null, base64Encoded, bytes, truncated: true, error: `body exceeds ${BODY_MAX_BYTES} bytes` };
	}
	return { requestId, body: raw, base64Encoded, bytes, truncated: false };
}

/** Fetch one response body and memoize it. Never throws — failures are data. */
async function captureResponseBody(tabId, requestId) {
	const tabMap = bodyCache.get(tabId);
	if (tabMap && tabMap.has(requestId)) return tabMap.get(requestId);
	let out;
	try {
		// withCDP, not dbgSend: an on-demand `network.body` can be the very first
		// CDP call on a tab (background capture only ever runs on an attached
		// tab), and it must attach — and retry once after a dropped attachment —
		// instead of failing with "Debugger is not attached to the tab".
		const res = await withCDP(tabId, (send) => send('Network.getResponseBody', { requestId }));
		out = normalizeBody(res, requestId);
	} catch (err) {
		out = { requestId, body: null, error: String((err && err.message) || err), unavailable: true };
	}
	let map = bodyCache.get(tabId);
	if (!map) { map = new Map(); bodyCache.set(tabId, map); }
	map.set(requestId, out);
	if (map.size > 500) map.delete(map.keys().next().value);
	return out;
}

/** Whether the loadingFinished hook should grab this body unprompted. */
function shouldAutoCaptureBody(entry) {
	if (bodyAutoCapture === 'off') return false;
	if (entry.failed) return false;
	if (bodyAutoCapture === 'xhr') {
		const type = entry.resourceType;
		if (type !== 'XHR' && type !== 'Fetch') return false;
	}
	if (entry.encodedDataLength !== undefined && entry.encodedDataLength > BODY_AUTO_MAX_BYTES) return false;
	return true;
}

/**
 * Refuse to run DOM/JS work on a tab that is parked at a debugger breakpoint:
 * `Runtime.evaluate` against a paused renderer never returns, so the caller
 * would ride the whole command timeout instead of learning why.
 */
function assertNotPaused(tabId) {
	const st = debuggerState.get(tabId);
	if (!st || !st.paused) return;
	const top = summarizeFrame((st.callFrames || [])[0]);
	const where = top && top.url ? `${top.url}:${(top.location || {}).lineNumber}` : 'unknown location';
	const err = new Error(`tab ${tabId} is paused at a breakpoint (${st.reason || 'other'}) at ${where} — resume it first (debugger.resume) or the page's JS cannot run`);
	err.code = 'tab_paused';
	throw err;
}

/** Cap a per-tab request map at 500 entries (LRU-by-insertion-order). */
function trimNetworkMap(tabMap) {
	if (tabMap.size <= 500) return;
	const overflow = tabMap.size - 500;
	const keys = tabMap.keys();
	for (let i = 0; i < overflow; i++) tabMap.delete(keys.next().value);
}

function detachTab(tabId) {
	attachedTabs.delete(tabId);
	consoleLog.delete(tabId);
	networkLog.delete(tabId);
	bodyCache.delete(tabId);
	wsLog.delete(tabId);
	scriptRegistry.delete(tabId);
	debuggerState.delete(tabId);
	pauseLog.delete(tabId);
	fetchState.delete(tabId);
	tabBufferGenerations.delete(tabId);
	chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

function detachAll() {
	for (const tabId of [...attachedTabs]) detachTab(tabId);
}

/* Clean up when a tab is closed (detaches automatically, but remove from set). */
chrome.tabs.onRemoved.addListener((tabId) => {
	if (attachedTabs.has(tabId)) attachedTabs.delete(tabId);
	consoleLog.delete(tabId);
	networkLog.delete(tabId);
	bodyCache.delete(tabId);
	wsLog.delete(tabId);
	scriptRegistry.delete(tabId);
	debuggerState.delete(tabId);
	pauseLog.delete(tabId);
	fetchState.delete(tabId);
	tabBufferGenerations.delete(tabId);
});

/* Clean up when DevTools steals a tab (detach event fires). */
chrome.debugger.onDetach.addListener((source, reason) => {
	// Any detach — DevTools opening on the tab, another debugger client taking
	// it, a crashed target — must drop the tab from `attachedTabs`. Keeping the
	// stale entry made every later call on that tab fail with
	// "Debugger is not attached to the tab with id: N" until the tab closed.
	const tabId = source?.tabId;
	if (tabId !== undefined) attachedTabs.delete(tabId);
	if (reason === 'target_closed' || reason === 'canceled_by_user') {
		// Buffers are dropped by chrome.tabs.onRemoved for closed tabs.
	}
});

function dbgSend(tabId, method, params) {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (res) => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(`${method} failed: ${err.message}`));
			else resolve(res);
		});
	});
}

/** Persistent CDP: attaches (if not already) and holds. */
async function withCDP(tabId, fn) {
	await ensureAttached(tabId);
	try {
		return await fn((method, params) => dbgSend(tabId, method, params));
	} catch (error) {
		// Chrome can drop an attachment without our bookkeeping noticing (service
		// worker recycled, DevTools opened on the tab, another extension or a
		// crash taking the target). Re-attach once and retry instead of failing
		// the call with a stale "Debugger is not attached" error.
		if (!/not attached to the tab/i.test(String((error && error.message) || error))) throw error;
		attachedTabs.delete(tabId);
		await ensureAttached(tabId);
		return fn((method, params) => dbgSend(tabId, method, params));
	}
}

/* ------------------------------------------------------- command handlers */

async function cmdPing() {
	return { pong: true, t: Date.now(), version: EXT_VERSION };
}

/**
 * Return the recorded `Runtime.consoleAPICalled` entries for a tab. Filters
 * apply client-side so the model only sees the rows it asked for. `clear`
 * empties the buffer on the same call so the next call starts fresh; useful
 * for "give me the warnings that appeared after I clicked submit" without
 * earlier noise. `limit` defaults to 100, capped at 500.
 */
async function cmdConsoleLog(params) {
	const tab = await resolveTab(params.tabId);
	const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
	const levels = Array.isArray(params.levels) && params.levels.length > 0
		? new Set(params.levels.map((l) => String(l).toLowerCase()))
		: null;
	const pattern = typeof params.pattern === 'string' && params.pattern.length > 0
		? new RegExp(params.pattern, 'i')
		: null;
	const buf = consoleLog.get(tab.id) || [];
	const filtered = buf.filter((e) => {
		if (levels && !levels.has(e.level)) return false;
		if (pattern && !pattern.test(e.text || '')) return false;
		return true;
	});
	const tail = filtered.slice(-limit);
	if (params.clear === true) consoleLog.set(tab.id, []);
	return { tabId: tab.id, count: tail.length, total: filtered.length, entries: tail };
}

/**
 * Return merged request/response entries captured by `Network.*` events.
 * `includeStatic: true` surfaces images / fonts / stylesheets / scripts that
 * are filtered by default (they dominate the buffer in a typical page load).
 * `methodPattern` / `urlPattern` / `status` filter client-side.
 */
async function cmdNetworkLog(params) {
	const tab = await resolveTab(params.tabId);
	const tabMap = networkLog.get(tab.id);
	const all = tabMap ? [...tabMap.values()] : [];
	const includeStatic = params.includeStatic === true;
	const methodPattern = typeof params.methodPattern === 'string' && params.methodPattern.length > 0
		? new RegExp(params.methodPattern, 'i')
		: null;
	const urlPattern = typeof params.urlPattern === 'string' && params.urlPattern.length > 0
		? new RegExp(params.urlPattern, 'i')
		: null;
	const statusFilter = typeof params.status === 'string' && params.status.length > 0 ? params.status : null;
	const staticTypes = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Favicon', 'Manifest']);
	const filtered = all.filter((e) => {
		if (!includeStatic && staticTypes.has(e.resourceType)) return false;
		if (methodPattern && !methodPattern.test(e.method || '')) return false;
		if (urlPattern && !urlPattern.test(e.url || '')) return false;
		if (statusFilter) {
			if (e.failed) {
				if (!/^f/i.test(statusFilter)) return false;
			} else if (e.status === undefined) {
				if (!/^p/i.test(statusFilter)) return false; // pending
			} else if (statusFilter === '2xx' && (e.status < 200 || e.status >= 300)) return false;
			else if (statusFilter === '3xx' && (e.status < 300 || e.status >= 400)) return false;
			else if (statusFilter === '4xx' && (e.status < 400 || e.status >= 500)) return false;
			else if (statusFilter === '5xx' && (e.status < 500 || e.status >= 600)) return false;
		}
		return true;
	});
	filtered.sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0));
	const limit = Math.min(1000, Math.max(1, Number(params.limit) || 200));
	const cache = bodyCache.get(tab.id);
	const out = filtered.slice(-limit).map((e) => {
		const { tabId: _t, ...rest } = e;
		// `requestId` stays in the row: it is the handle every follow-up needs
		// (network.body, network.replay, per-request correlation). `bodyCached`
		// tells the caller a body is already available without a second round trip.
		return { ...rest, bodyCached: cache ? cache.has(e.requestId) : false };
	});
	if (params.clear === true) networkLog.set(tab.id, new Map());
	return { tabId: tab.id, count: out.length, total: filtered.length, requests: out };
}

async function cmdNetworkClear(params) {
	const tab = await resolveTab(params.tabId);
	networkLog.set(tab.id, new Map());
	return { tabId: tab.id, cleared: true };
}

/**
 * `Page.printToPDF` returns base64-encoded PDF. The extension's MV3 SW cannot
 * write to absolute paths on the host; the bridge decodes the base64 to a
 * `path` the caller supplies (or to `<shotsDir>/<tabId>-<t>.pdf` when no path
 * is given). The result echoes the saved path + size so callers can hand it
 * off to a reader tool.
 */
async function cmdPdf(params) {
	const tab = await resolveTab(params.tabId);
	return withCDP(tab.id, async (send) => {
		const cdpParams = {
			printBackground: params.printBackground !== false,
			landscape: params.landscape === true,
			...(typeof params.paperWidth === 'number' ? { paperWidth: params.paperWidth } : {}),
			...(typeof params.paperHeight === 'number' ? { paperHeight: params.paperHeight } : {}),
			...(typeof params.scale === 'number' ? { scale: params.scale } : {}),
			...(params.pageRanges ? { pageRanges: String(params.pageRanges) } : {}),
		};
		const res = await send('Page.printToPDF', cdpParams);
		if (!res || !res.data) throw new Error('Page.printToPDF returned no data');
		return { tabId: tab.id, base64: res.data };
	});
}

/**
 * Apply `Emulation.setDeviceMetricsOverride` + `setUserAgentOverride` +
 * `setTouchEmulationEnabled` to switch how the page renders. Presets cover
 * the common shapes (desktop / iphone / ipad / pixel); a custom object
 * overrides any field. Restoring back to desktop is `device:"reset"` so
 * the agent can clean up after itself.
 */
async function cmdEmulate(params) {
	const tab = await resolveTab(params.tabId);
	const preset = params.device && params.device !== 'reset' ? PRESETS[String(params.device).toLowerCase()] : null;
	if (params.device && params.device !== 'reset' && !preset && typeof params.device === 'string') {
		throw new Error(`unknown device preset "${params.device}". Use one of: ${Object.keys(PRESETS).join(', ')}, reset, or pass width/height fields directly.`);
	}
	const width = Number(params.width ?? (preset && preset.width) ?? 0);
	const height = Number(params.height ?? (preset && preset.height) ?? 0);
	const deviceScaleFactor = Number(params.deviceScaleFactor ?? (preset && preset.deviceScaleFactor) ?? 1);
	const isMobile = params.isMobile ?? (preset && preset.isMobile) ?? false;
	const hasTouch = params.hasTouch ?? (preset && preset.hasTouch) ?? false;
	const userAgent = params.userAgent || (preset && preset.userAgent) || undefined;
	return withCDP(tab.id, async (send) => {
		if (params.device === 'reset') {
			await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
			await send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
			await send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
			return { tabId: tab.id, reset: true };
		}
		if (width > 0 && height > 0) {
			await send('Emulation.setDeviceMetricsOverride', {
				width, height, deviceScaleFactor, mobile: isMobile,
			}).catch((e) => { throw new Error(`setDeviceMetricsOverride failed: ${e.message}`); });
		}
		if (userAgent) {
			await send('Emulation.setUserAgentOverride', { userAgent }).catch(() => {});
		}
		await send('Emulation.setTouchEmulationEnabled', { enabled: hasTouch }).catch(() => {});
		return {
			tabId: tab.id,
			width, height, deviceScaleFactor, isMobile, hasTouch,
			userAgent: userAgent || null,
		};
	});
}

const PRESETS = {
	desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: '' },
	'mobile-iphone-13': { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
	'mobile-pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
	'tablet-ipad': { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
};

async function cmdBrowserInfo() {
	return { client: 'dsh-browser-extension', version: EXT_VERSION, browser: helloInfo };
}

async function cmdTabsList() {
	const tabs = await chrome.tabs.query({});
	// Compact shape (id/url/active/title only): the bridge serializes this
	// straight into a tool result and wide shapes were truncating mid-JSON.
	return {
		count: tabs.length,
		activeTabId: tabs.find((t) => t.active)?.id,
		tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
	};
}

async function cmdTabsOpen(params) {
	if (!params.url) throw new Error('params.url is required');
	const active = params.active !== undefined ? Boolean(params.active) : true;
	// Open on about:blank, attach, *then* navigate. Creating the tab straight at
	// the target URL would put the document request (and everything racing it)
	// outside the capture window, because Network.* events only flow while a
	// debugger is attached. A failed attach (DevTools holding the tab) must not
	// block the navigation.
	const created = await chrome.tabs.create({ url: 'about:blank', active });
	await ensureAttached(created.id).catch(() => {});
	await chrome.tabs.update(created.id, { url: params.url }).catch(() => {});
	if (params.wait !== false) await waitTabComplete(created.id, Number(params.timeoutMs) || 15_000);
	const fresh = await chrome.tabs.get(created.id).catch(() => null);
	return { tabId: created.id, url: fresh?.url, title: fresh?.title };
}

async function cmdTabsClose(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	await chrome.tabs.remove(Number(params.tabId));
	return { closed: Number(params.tabId) };
}

async function cmdTabsActivate(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	await chrome.tabs.update(Number(params.tabId), { active: true });
	return { activated: Number(params.tabId) };
}

async function cmdNav(params) {
	if (!params.url) throw new Error('params.url is required');
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	// Attach before navigating so the whole load — the document request
	// included — lands in the network buffer. Network.* events only flow while
	// a debugger is attached, so attaching afterwards would silently miss it.
	// A failed attach (DevTools holding the tab, or a chrome:// target) must
	// not block the navigation itself.
	await ensureAttached(tab.id).catch(() => {});
	await chrome.tabs.update(tab.id, { url: params.url });
	if (params.wait !== false) await waitTabComplete(tab.id, Number(params.timeoutMs) || 15_000);
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally.
	let landedUrl = '';
	try {
		landedUrl = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'location.href', awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? '')));
	} catch { /* no debugger possible (e.g. chrome:// pages) — fall through */ }
	let siteUnreachable;
	if (/^chrome-error:/.test(landedUrl)) {
		let errText = '';
		try {
			errText = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
				expression: 'document.body ? document.body.innerText.slice(0, 4000) : ""',
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).then((r) => String(r.result?.value ?? '')));
		} catch { /* classification falls back below */ }
		// Error-page copy is localized (zh-CN shows 无法找到 … 的 DNS 地址,
		// en-US shows ERR_NAME_NOT_RESOLVED); match either plus any bare DNS
		// mention such as DNS_PROBE_STARTED.
		const dns = /ERR_NAME_NOT_RESOLVED|ERR_DNS_TIMED_OUT|\bDNS\b|无法找到.{0,40}(DNS|服务器)/i.test(errText)
			|| /ERR_NAME_NOT_RESOLVED|dns/i.test(fresh?.title ?? '');
		siteUnreachable = { reason: dns ? 'dns' : 'unreachable' };
	}
	return {
		tabId: tab.id,
		url: siteUnreachable ? params.url : (fresh?.url ?? params.url),
		title: siteUnreachable ? undefined : fresh?.title,
		...(siteUnreachable ? { siteUnreachable } : {}),
	};
}

async function cmdEval(params) {
	if (typeof params.expression !== 'string' || params.expression.length === 0) {
		throw new Error('params.expression is required');
	}
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	// Frame targeting: params.frameSelector (CSS selector of an <iframe>) runs
	// the expression inside that frame via contentDocument (same-origin).
	// Cross-origin frames need a separate debugger target — reported clearly.
	let expression = params.expression;
	if (Array.isArray(params.argNames) && Array.isArray(params.args)
		&& params.argNames.length === params.args.length && params.argNames.length > 0) {
		const argValues = params.args.map((a) => JSON.stringify(a)).join(', ');
		expression = `((${params.argNames.join(', ')}) => { ${params.expression} })(${argValues})`;
	}
	if (params.frameSelector) {
		const inner = expression.startsWith('(') ? expression : `(() => { ${expression} })()`;
		// Rebind document/window to the frame by passing them as parameters of
		// the wrapping arrow — parameter shadowing, no TDZ hazard. A `const
		// document = doc` declaration in the same scope would throw
		// "Cannot access 'document' before initialization" at the host lookup
		// above it.
		expression = `(() => {
			const host = document.querySelector(${JSON.stringify(String(params.frameSelector))});
			if (!host || !(host instanceof HTMLIFrameElement)) throw new Error('iframe not found: ${String(params.frameSelector).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');
			if (!host.contentDocument) throw new Error('cross-origin iframe: same-origin only supported, use a frame-specific tool');
			const doc = host.contentDocument, win = host.contentWindow;
			return ((document, window) => ${inner})(doc, win);
		})()`;
	}
	// params.timeoutMs races the evaluation: a hung awaitPromise (looping
	// promise, blocked page) must fail at the caller's budget instead of
	// riding the bridge-wide 60s default. An omitted budget means "no race" —
	// the old `Math.max(100, Number(x) || 0)` collapsed that case to 100 ms, so
	// every evaluate slower than a tenth of a second died with
	// "eval timeout after 100ms" (fetches, multi-step page reads, awaits).
	const requestedTimeout = Number(params.timeoutMs);
	const evalTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
		? Math.min(120_000, Math.max(100, requestedTimeout))
		: null;
	const raceTimeout = (ms) => new Promise((_, reject) => setTimeout(() => {
		const err = new Error(`eval timeout after ${ms}ms`);
		err.code = 'eval_timeout';
		reject(err);
	}, ms));
	const evaluate = withCDP(tab.id, async (send) => {
		// Evaluate WITHOUT returnByValue first: the RemoteObject's type/subtype
		// metadata tells us honestly what came back. Newer Chrome serializes
		// un-serializable objects to `{}` under returnByValue:true, which would
		// masquerade as a legitimate empty object.
		return send('Runtime.evaluate', {
			expression,
			awaitPromise: params.awaitPromise !== false,
			returnByValue: false,
			userGesture: true,
		}).then(async (res) => {
			if (res.exceptionDetails) {
				const d = res.exceptionDetails;
				const desc = String(d.exception?.description ?? d.text);
				if (CONTEXT_DESTROYED_RE.test(desc)) {
					const err = new Error('context_destroyed: page navigated while evaluate was pending');
					err.code = 'context_destroyed';
					throw err;
				}
				throw new Error(`page exception: ${desc}`);
			}
			const ro = res.result;
			// Primitives carry their value inline; nothing more to transfer.
			const isPrimitiveLike = ro.type === 'number' || ro.type === 'string' || ro.type === 'boolean'
				|| ro.type === 'bigint' || ro.type === 'undefined' || ro.subtype === 'null';
			if (isPrimitiveLike || !ro.objectId) return ro;
			// Objects known un-serializable by value get an honest report instead
			// of a silent {} (DOM nodes, functions, proxies, symbols, Map/Set…).
			const NOT_BY_VALUE = new Set(['node', 'function', 'proxy', 'symbol', 'map', 'set',
				'weakmap', 'weakset', 'iterator', 'generator']);
			if (NOT_BY_VALUE.has(ro.subtype ?? '') || ro.type === 'function' || ro.type === 'symbol') return ro;
			// Transfer by value without re-executing the expression:
			// callFunctionOn(identity) on the existing objectId.
			const ser = await send('Runtime.callFunctionOn', {
				objectId: ro.objectId,
				functionDeclaration: 'function () { return this; }',
				returnByValue: true,
			});
			if (ser.exceptionDetails) return ro;
			return { ...ro, value: ser.result.value };
		}).catch((err) => {
			// Protocol-level variant: Chrome rejects the whole sendCommand with
			// -32000 "Inspected target navigated or closed" when the target dies
			// mid-call; surface it under the same structural code.
			if (err instanceof Error && CONTEXT_DESTROYED_RE.test(err.message)) {
				const wrapped = new Error('context_destroyed: page navigated while evaluate was pending');
				wrapped.code = 'context_destroyed';
				throw wrapped;
			}
			throw err;
		});
	});
	// An eval that trips a breakpoint parks the renderer, so `Runtime.evaluate`
	// cannot finish until someone resumes: without this watcher the caller just
	// rides the whole command timeout with no idea why.
	let pauseWatcher = null;
	const pauseRace = new Promise((_, reject) => {
		pauseWatcher = setInterval(() => {
			const st = debuggerState.get(tab.id);
			if (!st || !st.paused) return;
			clearInterval(pauseWatcher);
			pauseWatcher = null;
			const top = summarizeFrame((st.callFrames || [])[0]);
			const where = top && top.url ? `${top.url}:${(top.location || {}).lineNumber}` : 'an unknown location';
			const err = new Error(`eval paused at a breakpoint (${st.reason || 'other'}) at ${where} — the renderer is frozen until debugger.resume; inspect the frames with debugger.state / debugger.eval first`);
			err.code = 'tab_paused';
			reject(err);
		}, 100);
	});
	const clearWatcher = () => { if (pauseWatcher !== null) { clearInterval(pauseWatcher); pauseWatcher = null; } };
	const value = await Promise.race([
		evaluate.then((result) => { clearWatcher(); return result; }, (error) => { clearWatcher(); throw error; }),
		pauseRace,
		...(evalTimeoutMs ? [raceTimeout(evalTimeoutMs)] : []),
	]).finally(clearWatcher);
	// Serialize what we honestly got. `value` here is a RemoteObject; a
	// missing `.value` on a non-primitive means transfer was impossible.
	let out;
	if (value.value !== undefined) {
		out = value.value;
	} else if (value.type === 'undefined') {
		out = null;
	} else if (value.subtype === 'node') {
		out = `[dom:${value.className ?? 'Node'} — wrap in JSON.stringify() or read specific properties]`;
	} else {
		out = `[${value.type}${value.subtype ? `:${value.subtype}` : ''}: not serializable — wrap the expression in JSON.stringify()]`;
	}
	return { tabId: tab.id, value: out, valueType: value.type };
}

async function cmdContent(params) {
	const mode = params.mode === 'html' ? 'html' : 'text';
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const inner = mode === 'html'
		? 'document.documentElement.outerHTML'
		: '(document.body && (document.body.innerText || document.body.textContent)) || ""';
	const payload = await withCDP(tab.id, (send) =>
		send('Runtime.evaluate', {
			expression: `JSON.stringify({title: document.title, url: location.href, readyState: document.readyState, content: ${inner}})`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(`page exception: ${res.exceptionDetails.text}`);
			return JSON.parse(res.result.value);
		}));
	return { tabId: tab.id, mode, ...payload };
}

async function cmdFind(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const payload = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const els = [...document.querySelectorAll(${JSON.stringify(String(params.selector))})];
			return JSON.stringify({
				count: els.length,
				items: els.slice(0, ${limit}).map((el) => {
					const r = el.getBoundingClientRect();
					return {
						tag: el.tagName.toLowerCase(), id: el.id || undefined,
						class: String(el.className || '').slice(0, 120) || undefined,
						text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160) || undefined,
						href: el instanceof Element && el.hasAttribute('href') ? el.getAttribute('href') : undefined,
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					};
				}),
			});
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => JSON.parse(res.result.value)));
	return { tabId: tab.id, selector: params.selector, ...payload };
}

async function cmdClick(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	// Mouse events land on whatever is under the viewport coordinates of the
	// focused tab; ensure our tab is frontmost so coordinates are meaningful.
	await activateTabWindow(tab.id);
	return withCDP(tab.id, async (send) => {
		const hit = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				// elementFromPoint at the intended hit point catches overlays
				// (sticky headers, ads) that would swallow the click.
				const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
				const topEl = document.elementFromPoint(x, y);
				const isTop = topEl === el || el.contains(topEl);
				return { x, y, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 120),
					hitTag: topEl ? topEl.tagName.toLowerCase() : null, isTop };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		if (!hit) throw new Error(`element not found: ${params.selector}`);
		const clickCount = params.doubleClick ? 2 : 1;
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount });
		return {
			tabId: tab.id,
			clicked: { x: hit.x, y: hit.y, tag: hit.tag, text: hit.text },
			hitVerified: hit.isTop,
			...(hit.isTop ? {} : { hitInstead: hit.hitTag }),
			dialogsAnswered: dialogLog.filter((d) => d.tabId === tab.id && Date.now() - d.t < 5000).length,
		};
	});
}

async function cmdInput(params) {
	if (!params.selector) throw new Error('params.selector is required');
	if (params.value === undefined) throw new Error('params.value is required');
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	// 'type' mode drives the real keyboard pipeline (Input.insertText per
	// keystroke) so stateful components (React-controlled, search bars with
	// internal suggestion state) observe every character. 'fill' (default)
	// sets the value directly — fast, but bypasses component keystroke logic.
	const mode = params.mode === 'type' ? 'type' : 'fill';
	// Real key events require the tab to have OS-level focus; activate first.
	if (mode === 'type') await activateTabWindow(tab.id);

	// Locate + focus + clear in one evaluate, shared by both modes.
	const located = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const el = document.querySelector(${JSON.stringify(String(params.selector))});
			if (!el) return null;
			el.scrollIntoView({ block: 'center', inline: 'center' });
			el.focus();
			let tag = el.tagName.toLowerCase();
			let cleared = '';
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
				el.dispatchEvent(new Event('input', { bubbles: true }));
				tag = tag + '[' + (el.getAttribute('type') || 'text') + ']';
				cleared = '';
			} else if (el.isContentEditable) {
				el.textContent = '';
				el.dispatchEvent(new InputEvent('input', { bubbles: true }));
			} else if (el instanceof HTMLSelectElement) {
				tag = 'select';
			}
			return { tag };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return res.result.value;
	}));
	if (!located) throw new Error(`element not found: ${params.selector}`);

	if (mode === 'fill') {
		const result = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				const value = ${JSON.stringify(String(params.value))};
				if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else if (el.isContentEditable) {
					el.textContent = value;
					el.dispatchEvent(new InputEvent('input', { bubbles: true }));
				} else if (el instanceof HTMLSelectElement) {
					el.value = value;
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else {
					el.textContent = value;
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		}));
		return { tabId: tab.id, mode, filled: result };
	}

	// 'type' mode: per-character real key events. dispatchKeyEvent with the
	// text field performs a full keyDown→char→keyUp; insertText would skip
	// per-key keydown handlers, so we use rawKeyDown+char for letters and
	// dispatchKeyEvent(text=…) for everything else.
	const text = String(params.value);
	return withCDP(tab.id, async (send) => {
		for (const ch of text) {
			if (ch === '\n') {
				await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter', text: '\r' });
				await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter' });
				continue;
			}
			// Non-ASCII (CJK, emoji) cannot travel through keyEvent text — the
			// protocol mangles them to '?'. Route them through insertText which
			// performs a real composition-style insertion; ASCII keeps full
			// keyDown/char/keyUp so per-key handlers still fire.
			if (ch.charCodeAt(0) > 127 || ch.codePointAt(0) > 0xFFFF) {
				await send('Input.insertText', { text: ch });
				continue;
			}
			await send('Input.dispatchKeyEvent', {
				type: 'keyDown', key: ch, text: ch, unmodifiedText: ch,
				windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
			});
			// NOTE: no separate 'char' event — Chrome inserts the character from
			// keyDown's text field; an explicit char event duplicates the input.
			await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
		}
		// Read back what actually landed in the element.
		const readBack = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => res.result.value);
		return { tabId: tab.id, mode, filled: readBack };
	});
}

const KEY_CODES = {
	Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
	Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'],
	ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
	ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
	Home: [36, 'Home'], End: [35, 'End'],
	PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, shift: 8 };

async function cmdPress(params) {
	const key = String(params.key ?? '');
	if (key.length === 0) throw new Error('params.key is required');
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	// Key events need OS focus; a background tab swallows them silently.
	await activateTabWindow(tab.id);
	let keyCode, code;
	if (KEY_CODES[key]) { [keyCode, code] = KEY_CODES[key]; }
	else if (key.length === 1) {
		keyCode = key.toUpperCase().charCodeAt(0);
		if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
		else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
	}
	const text = params.text !== undefined
		? String(params.text)
		: key === 'Enter' ? '\r' // '\r' makes keyDown perform implicit form submission
		: key.length === 1 && !(params.modifiers ?? []).some((m) => m in MODIFIER_BITS && m !== 'shift') ? key : undefined;
	let modifiers = 0;
	for (const m of params.modifiers ?? []) modifiers |= MODIFIER_BITS[String(m).toLowerCase()] ?? 0;
	return withCDP(tab.id, async (send) => {
		await send('Input.dispatchKeyEvent', {
			type: 'keyDown', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, text, unmodifiedText: text, modifiers,
		});
		if (text) {
			await send('Input.dispatchKeyEvent', { type: 'char', key, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, modifiers });
		}
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, modifiers });
		return { tabId: tab.id, key };
	});
}

async function cmdScreenshot(params) {
	const tab = await resolveTab(params.tabId);
	const format = params.format === 'jpeg' ? 'jpeg' : 'png';
	const res = await withCDP(tab.id, async (send) => {
		// Element capture: resolve the selector to a CSS-pixel rect, then pass
		// it as clip. Page.captureScreenshot's clip is in CSS pixels and it
		// handles DPR internally (unlike raw base64 math).
		if (params.selector) {
			const rect = await send('Runtime.evaluate', {
				expression: `(() => {
					const el = document.querySelector(${JSON.stringify(String(params.selector))});
					if (!el) return null;
					el.scrollIntoView({ block: 'center', inline: 'center' });
					const r = el.getBoundingClientRect();
					return { x: r.left, y: r.top, width: r.width, height: r.height };
				})()`,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).then((r) => {
				if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
				return r.result.value;
			});
			if (!rect) throw new Error(`element not found: ${params.selector}`);
			return send('Page.captureScreenshot', {
				format,
				quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
				clip: { ...rect, scale: 1 },
			}).then((shot) => ({ shot, elementRect: rect }));
		}
		const shot = await send('Page.captureScreenshot', {
			format,
			quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
			captureBeyondViewport: Boolean(params.fullPage),
		});
		return { shot };
	});
	return {
		tabId: tab.id,
		format,
		base64: res.shot.data,
		tabTitle: tab.title,
		tabUrl: tab.url,
		...(res.elementRect ? {
			elementRect: {
				x: Math.round(res.elementRect.x), y: Math.round(res.elementRect.y),
				w: Math.round(res.elementRect.width), h: Math.round(res.elementRect.height),
			},
		} : {}),
	};
}

async function cmdScroll(params) {
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const dx = Number.isFinite(Number(params.x)) ? Number(params.x) : 0;
	const dy = Number.isFinite(Number(params.y)) ? Number(params.y) : 0;
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			window.scrollBy({ left: ${JSON.stringify(dx)}, top: ${JSON.stringify(dy)}, behavior: 'instant' });
			return { tabId: ${tab.id}, scrollX: window.scrollX, scrollY: window.scrollY,
				pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => res.result.value));
}

/** All CDP message variants that mean "the page went away mid-evaluation". */
const CONTEXT_DESTROYED_RE = /Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed/i;

const SNAPSHOT_SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], '
	+ '[role="tab"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]';

async function cmdSnapshot(params) {
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const limit = Math.min(200, Math.max(1, Number(params.limit) || 120));
	return withCDP(tab.id, async (send) => {
		await send('Runtime.enable').catch(() => {});
		const payload = await send('Runtime.evaluate', {
			expression: `(() => {
				const ATTR = 'data-dsh-ref';
				document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
				const nodes = [...document.querySelectorAll(${JSON.stringify(SNAPSHOT_SELECTOR)})];
				const items = [];
				let n = 0;
				for (const el of nodes) {
					if (items.length >= ${limit}) break;
					const r = el.getBoundingClientRect();
					if (r.width === 0 && r.height === 0) continue;
					const ref = 'e' + (++n);
					el.setAttribute(ATTR, ref);
					const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
					items.push({
						ref, tag: el.tagName.toLowerCase(),
						type: el.getAttribute('type') || undefined,
						role: el.getAttribute('role') || undefined,
						name: (el.getAttribute('aria-label') || el.getAttribute('placeholder')
							|| (el.textContent || '').trim().replace(/\\s+/g, ' ')).slice(0, 80) || undefined,
						value: isField || el instanceof HTMLSelectElement ? String(el.value ?? '').slice(0, 60) : undefined,
						href: el.hasAttribute('href') ? el.href : undefined,
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					});
				}
				return { tabId: ${tab.id}, title: document.title, url: location.href, total: nodes.length, items };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		payload.limitedTo = limit;
		return payload;
	});
}

/* ================= Phase 1/2: interface analysis + JS reverse engineering ==== */

/**
 * Every debuggable target Chrome knows about: tabs, OOPIFs, dedicated/shared
 * workers, service workers. This is the only way to *discover* a target id —
 * the CDP `Target` domain answers "Not allowed" for chrome.debugger clients —
 * and a target id is what `cdp` needs to drive a worker directly, which is
 * where a lot of real signing logic lives.
 */
async function cmdTargetsList(params) {
	const targets = await chrome.debugger.getTargets();
	const typeFilter = typeof params.type === 'string' && params.type.length > 0 ? params.type : null;
	const tabFilter = params.tabId === undefined ? null : Number(params.tabId);
	const rows = targets
		.filter((t) => (typeFilter === null ? true : t.type === typeFilter))
		.filter((t) => (tabFilter === null ? true : t.tabId === tabFilter))
		.map((t) => ({
			targetId: t.id,
			type: t.type,
			title: t.title,
			url: t.url,
			tabId: t.tabId,
			attached: t.attached,
			source: 'chrome.debugger.getTargets',
		}));
	// Merge in whatever Target auto-attach reported: this is the only place a
	// page's dedicated workers show up at all.
	const seen = new Set(rows.map((r) => r.targetId));
	const scopedTabs = tabFilter === null ? [...targetRegistry.keys()] : [tabFilter];
	for (const tabId of scopedTabs) {
		const reg = targetRegistry.get(tabId);
		if (!reg) continue;
		for (const entry of reg.values()) {
			if (seen.has(entry.targetId)) {
				const existing = rows.find((r) => r.targetId === entry.targetId);
				if (existing) existing.attached = existing.attached || entry.attached === true;
				continue;
			}
			if (typeFilter !== null && entry.type !== typeFilter) continue;
			seen.add(entry.targetId);
			rows.push({
				targetId: entry.targetId,
				type: entry.type,
				title: entry.title,
				url: entry.url,
				tabId,
				attached: entry.attached === true,
				sessionId: entry.sessionId,
				source: 'Target auto-attach',
			});
		}
	}
	return { count: rows.length, targets: rows, autoAttachTabs: [...targetRegistry.keys()] };
}

/**
 * Turn Target auto-attach on/off for a tab. With it on, Chrome reports the
 * page's children (dedicated workers, OOPIFs) as `Target.attachedToTarget`, and
 * their ids become drivable through `cdp {targetId}` — the CDP `Target` domain
 * refuses `getTargets` for extension clients, but accepts `setAutoAttach`.
 */
async function cmdTargetsAutoAttach(params) {
	const tab = await resolveTab(params.tabId);
	const enable = params.enable !== false;
	const wait = params.waitForDebuggerOnStart === true;
	await withCDP(tab.id, (send) => send('Target.setAutoAttach', {
		autoAttach: enable,
		waitForDebuggerOnStart: wait,
		flatten: true,
	}));
	if (!enable) {
		targetRegistry.delete(tab.id);
		return { tabId: tab.id, autoAttach: false, targets: [] };
	}
	// Children already alive are reported as events; give them a moment to land.
	await new Promise((resolve) => setTimeout(resolve, 400));
	const reg = targetRegistry.get(tab.id);
	const targets = reg ? [...reg.values()] : [];
	return { tabId: tab.id, autoAttach: true, count: targets.length, targets };
}

/** Headers arrive as a plain object; HAR wants an array. Later sources win. */
function headersToHar(...sources) {
	const merged = {};
	for (const src of sources) {
		if (!src || typeof src !== 'object') continue;
		for (const [name, value] of Object.entries(src)) {
			if (value === undefined || value === null) continue;
			merged[name] = Array.isArray(value) ? value.join(', ') : String(value);
		}
	}
	return Object.entries(merged).map(([name, value]) => ({ name, value }));
}

function parseCookieHeader(value) {
	if (typeof value !== 'string' || value.length === 0) return [];
	return value.split(';').map((part) => part.trim()).filter(Boolean).map((pair) => {
		const eq = pair.indexOf('=');
		return eq < 0
			? { name: pair, value: '' }
			: { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
	});
}

function parseSetCookie(value) {
	if (typeof value !== 'string' || value.length === 0) return null;
	const parts = value.split(';').map((p) => p.trim());
	const eq = parts[0].indexOf('=');
	const cookie = {
		name: eq < 0 ? parts[0] : parts[0].slice(0, eq).trim(),
		value: eq < 0 ? '' : parts[0].slice(eq + 1).trim(),
	};
	for (const attr of parts.slice(1)) {
		const [rawKey, ...rest] = attr.split('=');
		const key = rawKey.trim().toLowerCase();
		const val = rest.join('=').trim();
		if (key === 'domain') cookie.domain = val;
		else if (key === 'path') cookie.path = val;
		else if (key === 'expires') cookie.expires = val;
		else if (key === 'httponly') cookie.httpOnly = true;
		else if (key === 'secure') cookie.secure = true;
		else if (key === 'samesite') cookie.sameSite = val;
	}
	return cookie;
}

/** One captured network entry → a HAR 1.2 entry. */
function toHarEntry(entry, body) {
	const requestHeaders = headersToHar(entry.headers, entry.extraRequestHeaders);
	const responseHeaders = headersToHar(entry.responseHeaders, entry.extraResponseHeaders);
	const cookieHeader = (requestHeaders.find((h) => h.name.toLowerCase() === 'cookie') || {}).value;
	const setCookies = responseHeaders.filter((h) => h.name.toLowerCase() === 'set-cookie');
	const started = entry.wallTime ? new Date(entry.wallTime * 1000).toISOString() : new Date(entry.t || Date.now()).toISOString();
	let queryString = [];
	try {
		queryString = [...new URL(entry.url).searchParams.entries()].map(([name, value]) => ({ name, value }));
	} catch { /* data:/blob: URLs have no query */ }
	const content = body && body.body !== null && body.body !== undefined
		? {
			size: body.bytes,
			mimeType: entry.mimeType || '',
			text: body.base64Encoded ? undefined : body.body,
			encoding: body.base64Encoded ? 'base64' : undefined,
		}
		: { size: entry.encodedDataLength || 0, mimeType: entry.mimeType || '' };
	if (body && body.error) content._unavailable = body.error;
	return {
		startedDateTime: started,
		time: 0,
		request: {
			method: entry.method || 'GET',
			url: entry.url,
			httpVersion: 'HTTP/1.1',
			cookies: parseCookieHeader(cookieHeader),
			headers: requestHeaders,
			queryString,
			headersSize: -1,
			bodySize: entry.postData ? entry.postData.length : 0,
			...(entry.postData ? { postData: { mimeType: (requestHeaders.find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '', text: entry.postData } } : {}),
		},
		response: {
			status: entry.status || 0,
			statusText: entry.statusText || '',
			httpVersion: 'HTTP/1.1',
			cookies: setCookies.map((h) => parseSetCookie(h.value)).filter(Boolean),
			headers: responseHeaders,
			content,
			redirectURL: (responseHeaders.find((h) => h.name.toLowerCase() === 'location') || {}).value || '',
			headersSize: -1,
			bodySize: entry.encodedDataLength || -1,
		},
		cache: {},
		timings: { send: 0, wait: 0, receive: 0 },
		...(entry.failed ? { _error: entry.errorText || 'failed' } : {}),
		...(entry.extraRequestHeaders ? { _requestHeadersSource: 'extraInfo (wire headers)' } : {}),
		// Custom HAR fields are underscore-prefixed by convention; this one lets a
		// HAR row be fed straight back into network.body / network.replay.
		_requestId: entry.requestId,
		_serverIPAddress: undefined,
	};
}

/** Raw CDP passthrough: every DevTools capability the extension did not wrap. */
async function cmdCdp(params) {
	const method = typeof params.method === 'string' ? params.method.trim() : '';
	if (!method) throw new Error('params.method is required (e.g. "Network.getAllCookies")');
	const targetId = typeof params.targetId === 'string' && params.targetId ? params.targetId : null;
	if (targetId) {
		// Non-tab target (worker / OOPIF / service worker). Attach to the target
		// itself; commands addressed to a target we never attached to fail.
		await new Promise((resolve, reject) => {
			chrome.debugger.attach({ targetId }, '1.3', () => {
				const err = chrome.runtime.lastError;
				if (err && !/already attached/i.test(err.message)) reject(new Error(`debugger attach failed: ${err.message}`));
				else resolve();
			});
		});
		const result = await new Promise((resolve, reject) => {
			chrome.debugger.sendCommand({ targetId }, method, params.params ?? {}, (res) => {
				const err = chrome.runtime.lastError;
				if (err) reject(new Error(`${method} failed: ${err.message}`));
				else resolve(res);
			});
		});
		return { targetId, method, result };
	}
	const tab = await resolveTab(params.tabId);
	const result = await withCDP(tab.id, (send) => send(method, params.params ?? {}));
	return { tabId: tab.id, method, result };
}

/** Read/set the background response-body capture policy. */
async function cmdBodiesPolicy(params) {
	if (params && params.policy !== undefined) {
		const policy = String(params.policy);
		if (!bodiesAutoPolicyValues.has(policy)) throw new Error(`invalid policy: ${policy} (use off|xhr|all)`);
		bodyAutoCapture = policy;
	}
	return { policy: bodyAutoCapture, maxBytes: BODY_MAX_BYTES, autoMaxBytes: BODY_AUTO_MAX_BYTES };
}

/** One response body (or request post body) on demand. */
async function cmdNetworkBody(params) {
	const tab = await resolveTab(params.tabId);
	const requestId = typeof params.requestId === 'string' ? params.requestId : '';
	if (!requestId) throw new Error('params.requestId is required (take it from network.log)');
	if (params.kind === 'request') {
		const res = await withCDP(tab.id, (send) => send('Network.getRequestPostData', { requestId }));
		const postData = (res && res.postData) || '';
		return { tabId: tab.id, requestId, kind: 'request', postData, bytes: postData.length };
	}
	const body = await captureResponseBody(tab.id, requestId);
	return { tabId: tab.id, kind: 'response', ...body };
}

/** Whole captured conversation as a HAR 1.2 document. */
async function cmdNetworkHar(params) {
	const tab = await resolveTab(params.tabId);
	const tabMap = networkLog.get(tab.id);
	const all = tabMap ? [...tabMap.values()] : [];
	const includeStatic = params.includeStatic === true;
	const staticTypes = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Favicon', 'Manifest']);
	const filtered = all
		.filter((e) => includeStatic || !staticTypes.has(e.resourceType))
		.sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0));
	const includeBodies = params.includeBodies !== false;
	const entries = [];
	for (const entry of filtered) {
		let body = null;
		if (includeBodies && !entry.failed) body = await captureResponseBody(tab.id, entry.requestId).catch(() => null);
		entries.push(toHarEntry(entry, body));
	}
	if (params.clear === true) networkLog.set(tab.id, new Map());
	return {
		tabId: tab.id,
		url: (await chrome.tabs.get(tab.id).catch(() => ({}))).url,
		count: entries.length,
		har: {
			log: {
				version: '1.2',
				creator: { name: 'DSH Browser Control', version: EXT_VERSION },
				pages: [],
				entries,
			},
		},
	};
}

/* --------------------------------------------------------------- cookies */

/**
 * Read cookies. With `url` this asks Chrome which cookies that URL would send
 * (the accurate per-request view); otherwise it returns the whole profile jar.
 * HttpOnly cookies are included — that is the point of going through CDP.
 */
async function cmdCookiesGet(params) {
	const tab = await resolveTab(params.tabId);
	const url = typeof params.url === 'string' && params.url ? params.url : null;
	const res = url
		? await withCDP(tab.id, (send) => send('Network.getCookies', { urls: [url] }))
		: await withCDP(tab.id, (send) => send('Network.getAllCookies', {}));
	let cookies = (res && res.cookies) || [];
	const nameFilter = typeof params.name === 'string' && params.name ? new RegExp(params.name) : null;
	const domainFilter = typeof params.domain === 'string' && params.domain ? new RegExp(params.domain, 'i') : null;
	if (nameFilter) cookies = cookies.filter((c) => nameFilter.test(c.name));
	if (domainFilter) cookies = cookies.filter((c) => domainFilter.test(c.domain || ''));
	if (params.includeHttpOnly === false) cookies = cookies.filter((c) => !c.httpOnly);
	if (params.value === false) cookies = cookies.map((c) => ({ ...c, value: undefined, valueLength: (c.value || '').length }));
	const limit = Math.min(5_000, Math.max(1, Number(params.limit) || 1_000));
	return {
		tabId: tab.id,
		source: url ? 'Network.getCookies' : 'Network.getAllCookies',
		scope: url || 'whole profile',
		count: cookies.length,
		httpOnly: cookies.filter((c) => c.httpOnly).length,
		cookies: cookies.slice(0, limit),
	};
}

async function cmdCookiesSet(params) {
	const tab = await resolveTab(params.tabId);
	if (typeof params.name !== 'string' || !params.name) throw new Error('params.name is required');
	if (typeof params.value !== 'string') throw new Error('params.value is required');
	const cdpParams = { name: params.name, value: params.value };
	if (params.url) cdpParams.url = String(params.url);
	else if (params.domain) {
		cdpParams.domain = String(params.domain);
		cdpParams.path = params.path ? String(params.path) : '/';
	} else throw new Error('provide params.url, or params.domain (+ optional path)');
	for (const key of ['path', 'secure', 'httpOnly', 'sameSite', 'expires', 'priority']) {
		if (params[key] !== undefined) cdpParams[key] = params[key];
	}
	const res = await withCDP(tab.id, (send) => send('Network.setCookie', cdpParams));
	return { tabId: tab.id, success: res && res.success !== false, cookie: { ...cdpParams, value: undefined, valueLength: String(params.value).length } };
}

async function cmdCookiesDelete(params) {
	const tab = await resolveTab(params.tabId);
	if (typeof params.name !== 'string' || !params.name) throw new Error('params.name is required');
	const cdpParams = { name: params.name };
	if (params.url) cdpParams.url = String(params.url);
	if (params.domain) cdpParams.domain = String(params.domain);
	if (params.path) cdpParams.path = String(params.path);
	if (!params.url && !params.domain) throw new Error('provide params.url or params.domain so Chrome knows which cookie jar to edit');
	await withCDP(tab.id, (send) => send('Network.deleteCookies', cdpParams));
	return { tabId: tab.id, deleted: true, name: params.name, url: params.url, domain: params.domain, path: params.path };
}

async function cmdCookiesClear(params) {
	const tab = await resolveTab(params.tabId);
	await withCDP(tab.id, (send) => send('Network.clearBrowserCookies', {}));
	return { tabId: tab.id, cleared: true };
}

/* ------------------------------------------------------------ websockets */

async function cmdWsLog(params) {
	const tab = await resolveTab(params.tabId);
	const st = wsLog.get(tab.id) || { sockets: new Map(), frames: [] };
	const limit = Math.min(2_000, Math.max(1, Number(params.limit) || 200));
	const pattern = typeof params.urlPattern === 'string' && params.urlPattern ? new RegExp(params.urlPattern, 'i') : null;
	const sockets = [...st.sockets.values()].filter((s) => !pattern || pattern.test(s.url || ''));
	const ids = new Set(sockets.map((s) => s.requestId));
	let frames = st.frames.filter((f) => ids.has(f.requestId));
	if (params.direction === 'sent' || params.direction === 'received') frames = frames.filter((f) => f.dir === params.direction);
	if (params.payloadPattern) {
		const re = new RegExp(params.payloadPattern, 'i');
		frames = frames.filter((f) => re.test(f.payload || ''));
	}
	const tail = frames.slice(-limit);
	if (params.clear === true) { st.frames = []; wsLog.set(tab.id, st); }
	return { tabId: tab.id, sockets, frameCount: frames.length, frames: tail };
}

/* --------------------------------------------------------- JS: scripts */

/** Turn the Debugger domain on (idempotent) and let scriptParsed land. */
async function ensureDebuggerReady(tabId, waitMs = 250) {
	const st = ensureDebuggerState(tabId);
	if (!st.enabled) {
		await withCDP(tabId, (send) => send('Debugger.enable', {}));
		st.enabled = true;
		await dbgSend(tabId, 'Debugger.setAsyncCallStackDepth', { maxDepth: 32 }).catch(() => {});
		await dbgSend(tabId, 'Runtime.setAsyncCallStackDepth', { maxDepth: 32 }).catch(() => {});
	}
	if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
	return st;
}

async function cmdScriptsList(params) {
	const tab = await resolveTab(params.tabId);
	await ensureDebuggerReady(tab.id);
	const reg = scriptRegistry.get(tab.id);
	let scripts = reg ? [...reg.values()] : [];
	const urlPattern = typeof params.urlPattern === 'string' && params.urlPattern ? new RegExp(params.urlPattern, 'i') : null;
	if (urlPattern) scripts = scripts.filter((s) => urlPattern.test(s.url || ''));
	if (params.withSourceMap === true) scripts = scripts.filter((s) => Boolean(s.sourceMapURL));
	if (params.minLength !== undefined) scripts = scripts.filter((s) => (s.length || 0) >= Number(params.minLength));
	if (params.inlineOnly === true) scripts = scripts.filter((s) => !s.url || s.url.startsWith('webpack://'));
	scripts.sort((a, b) => (b.length || 0) - (a.length || 0));
	const limit = Math.min(2_000, Math.max(1, Number(params.limit) || 200));
	return {
		tabId: tab.id,
		total: (reg ? reg.size : 0),
		count: scripts.length,
		scripts: scripts.slice(0, limit).map((s) => ({
			...s,
			inline: !s.url,
			hasSourceMap: Boolean(s.sourceMapURL),
		})),
	};
}

async function cmdScriptsSource(params) {
	const tab = await resolveTab(params.tabId);
	await ensureDebuggerReady(tab.id);
	const reg = scriptRegistry.get(tab.id);
	if (!reg || reg.size === 0) throw new Error('no scripts registered for this tab yet — call scripts.list first, then reload the page if it is still empty');
	let target = null;
	if (params.scriptId) target = reg.get(String(params.scriptId)) || null;
	if (!target && params.url) target = [...reg.values()].filter((s) => s.url === params.url)[0] || null;
	if (!target && params.urlPattern) {
		const re = new RegExp(String(params.urlPattern), 'i');
		const matches = [...reg.values()].filter((s) => re.test(s.url || ''));
		const index = Math.max(0, Number(params.index) || 0);
		target = matches[index] || null;
		if (matches.length > 1 && params.index === undefined) {
			return {
				tabId: tab.id,
				ambiguous: true,
				matches: matches.slice(0, 25).map((s) => ({ scriptId: s.scriptId, url: s.url, length: s.length })),
				hint: 'several scripts match — pass params.index or params.scriptId',
			};
		}
	}
	if (!target) throw new Error('script not found: pass scriptId, an exact url, or urlPattern (+ index)');
	const res = await withCDP(tab.id, (send) => send('Debugger.getScriptSource', { scriptId: target.scriptId }));
	const source = (res && res.scriptSource) || '';
	const maxBytes = Math.min(64 * 1024 * 1024, Math.max(1_000, Number(params.maxBytes) || 16 * 1024 * 1024));
	const truncated = source.length > maxBytes;
	return {
		tabId: tab.id,
		scriptId: target.scriptId,
		url: target.url,
		sourceMapURL: target.sourceMapURL || '',
		bytes: source.length,
		truncated,
		source: truncated ? source.slice(0, maxBytes) : source,
	};
}

/* --------------------------------------------------- JS: debugger control */

/** Poll until a *new* pause lands (step/pause commands do not pause inline). */
async function waitForPause(tabId, previousCount, timeoutMs) {
	const st = ensureDebuggerState(tabId);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (st.paused && (st.pauseCount || 0) > previousCount) return st;
		if (Date.now() >= deadline) {
			const err = new Error(`no pause within ${timeoutMs}ms (the breakpoint may not have been hit)`);
			err.code = 'pause_timeout';
			throw err;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function debuggerSnapshot(tabId, full) {
	const st = ensureDebuggerState(tabId);
	const frames = st.callFrames || [];
	return {
		tabId,
		enabled: st.enabled,
		paused: st.paused,
		reason: st.reason,
		hitBreakpoints: st.hitBreakpoints || [],
		pauseCount: st.pauseCount || 0,
		breakpoints: [...st.breakpoints.values()],
		pauseHistory: pauseLog.get(tabId) || [],
		callFrames: full
			? frames
			: frames.map((f) => ({
				callFrameId: f.callFrameId,
				functionName: f.functionName,
				url: f.url,
				location: f.location,
				scopes: (f.scopeChain || []).map((s) => s.type),
			})),
	};
}

async function cmdDebuggerEnable(params) {
	const tab = await resolveTab(params.tabId);
	ensureDebuggerState(tab.id).enabled = false; // force a fresh enable so
	// scriptParsed for everything already loaded is replayed to us.
	await ensureDebuggerReady(tab.id);
	const reg = scriptRegistry.get(tab.id);
	return { tabId: tab.id, scripts: reg ? reg.size : 0 };
}

async function cmdDebuggerBreak(params) {
	const tab = await resolveTab(params.tabId);
	const st = await ensureDebuggerReady(tab.id);
	if (params.scriptId) {
		if (params.lineNumber === undefined) throw new Error('params.lineNumber is required with params.scriptId');
		const res = await withCDP(tab.id, (send) => send('Debugger.setBreakpoint', {
			location: {
				scriptId: String(params.scriptId),
				lineNumber: Number(params.lineNumber),
				...(params.columnNumber !== undefined ? { columnNumber: Number(params.columnNumber) } : {}),
			},
			...(params.condition ? { condition: String(params.condition) } : {}),
		}));
		const record = { breakpointId: res.breakpointId, kind: 'location', scriptId: String(params.scriptId), lineNumber: Number(params.lineNumber), condition: params.condition || null, actualLocation: res.actualLocation };
		st.breakpoints.set(res.breakpointId, record);
		return { tabId: tab.id, ...record };
	}
	if (params.lineNumber === undefined) throw new Error('params.lineNumber is required (0-based)');
	if (!params.url && !params.urlRegex) throw new Error('provide params.url (exact) or params.urlRegex');
	const res = await withCDP(tab.id, (send) => send('Debugger.setBreakpointByUrl', {
		lineNumber: Number(params.lineNumber),
		...(params.columnNumber !== undefined ? { columnNumber: Number(params.columnNumber) } : {}),
		...(params.url ? { url: String(params.url) } : { urlRegex: String(params.urlRegex) }),
		...(params.condition ? { condition: String(params.condition) } : {}),
	}));
	const record = {
		breakpointId: res.breakpointId,
		kind: params.url ? 'url' : 'urlRegex',
		url: params.url || null,
		urlRegex: params.urlRegex || null,
		lineNumber: Number(params.lineNumber),
		condition: params.condition || null,
		locations: res.locations,
	};
	st.breakpoints.set(res.breakpointId, record);
	return { tabId: tab.id, ...record, resolvedNow: (res.locations || []).length };
}

async function cmdDebuggerUnbreak(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureDebuggerState(tab.id);
	const breakpointId = typeof params.breakpointId === 'string' ? params.breakpointId : '';
	if (!breakpointId) {
		if (params.all === true) {
			const ids = [...st.breakpoints.keys()];
			for (const id of ids) await dbgSend(tab.id, 'Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
			st.breakpoints.clear();
			return { tabId: tab.id, removed: ids.length, remaining: 0 };
		}
		throw new Error('params.breakpointId is required (or pass all:true)');
	}
	await withCDP(tab.id, (send) => send('Debugger.removeBreakpoint', { breakpointId }));
	st.breakpoints.delete(breakpointId);
	return { tabId: tab.id, removed: 1, remaining: st.breakpoints.size };
}

/**
 * Hook a function by reference: evaluate an expression that yields the current
 * function object, then break whenever it is called. This is the "watch the
 * sign()/encrypt() call with its real arguments" move without hunting for the
 * line number in a minified bundle.
 */
async function cmdDebuggerHook(params) {
	const tab = await resolveTab(params.tabId);
	const st = await ensureDebuggerReady(tab.id);
	const expression = typeof params.expression === 'string' && params.expression ? params.expression : '';
	if (!expression) throw new Error('params.expression is required (must evaluate to a function object, e.g. "window.encrypt" or "JSON.parse")');
	const evaluated = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression, returnByValue: false, awaitPromise: true, userGesture: true,
	}));
	if (evaluated.exceptionDetails) {
		throw new Error(`expression threw: ${evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text}`);
	}
	const objectId = evaluated.result && evaluated.result.objectId;
	if (!objectId) throw new Error(`expression did not yield an object (got ${evaluated.result && evaluated.result.type}) — a function reference is required`);
	const res = await withCDP(tab.id, (send) => send('Debugger.setBreakpointOnFunctionCall', {
		objectId,
		...(params.condition ? { condition: String(params.condition) } : {}),
	}));
	const record = { breakpointId: res.breakpointId, kind: 'functionCall', expression, condition: params.condition || null, description: evaluated.result.description };
	st.breakpoints.set(res.breakpointId, record);
	return { tabId: tab.id, ...record };
}

async function cmdDebuggerPause(params) {
	const tab = await resolveTab(params.tabId);
	const st = await ensureDebuggerReady(tab.id);
	const before = st.pauseCount || 0;
	await withCDP(tab.id, (send) => send('Debugger.pause', {}));
	const timeoutMs = Math.min(30_000, Math.max(500, Number(params.timeoutMs) || 5_000));
	const paused = await waitForPause(tab.id, before, timeoutMs);
	return { tabId: tab.id, ...debuggerSnapshot(tab.id, params.full === true), reason: paused.reason };
}

async function cmdDebuggerResume(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureDebuggerState(tab.id);
	if (!st.paused && params.force !== true) return { tabId: tab.id, resumed: false, note: 'tab was not paused' };
	await withCDP(tab.id, (send) => send('Debugger.resume', { terminateOnResume: false }));
	await new Promise((resolve) => setTimeout(resolve, 100));
	return { tabId: tab.id, resumed: true, paused: ensureDebuggerState(tab.id).paused };
}

async function cmdDebuggerStep(params) {
	const tab = await resolveTab(params.tabId);
	const st = await ensureDebuggerReady(tab.id);
	const action = String(params.action || 'over');
	const method = action === 'into' ? 'Debugger.stepInto' : action === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver';
	const before = st.pauseCount || 0;
	await withCDP(tab.id, (send) => send(method, {}));
	const timeoutMs = Math.min(30_000, Math.max(500, Number(params.timeoutMs) || 5_000));
	try {
		const paused = await waitForPause(tab.id, before, timeoutMs);
		return { tabId: tab.id, stepped: action, ...debuggerSnapshot(tab.id, params.full === true), reason: paused.reason };
	} catch (err) {
		// A step that runs off the end of the program resumes the page instead.
		return { tabId: tab.id, stepped: action, ...debuggerSnapshot(tab.id, params.full === true), note: String(err.message || err) };
	}
}

async function cmdDebuggerState(params) {
	const tab = await resolveTab(params.tabId);
	return { ...debuggerSnapshot(tab.id, params.full === true) };
}

async function cmdDebuggerEval(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureDebuggerState(tab.id);
	if (!st.paused) throw new Error('the tab is not paused — nothing to evaluate on; set a breakpoint and wait for a pause first');
	if (!params.callFrameId) throw new Error('params.callFrameId is required (from debugger.state callFrames)');
	if (typeof params.expression !== 'string' || !params.expression) throw new Error('params.expression is required');
	const res = await withCDP(tab.id, (send) => send('Debugger.evaluateOnCallFrame', {
		callFrameId: String(params.callFrameId),
		expression: String(params.expression),
		returnByValue: params.returnByValue !== false,
		awaitPromise: true,
		userGesture: true,
	}));
	if (res.exceptionDetails) throw new Error(`frame exception: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
	const result = res.result || {};
	return {
		tabId: tab.id,
		type: result.type,
		value: result.value !== undefined ? result.value : (result.description || `[${result.type}: wrap in JSON.stringify()]`),
		objectId: result.objectId,
	};
}

async function cmdDebuggerExceptions(params) {
	const tab = await resolveTab(params.tabId);
	await ensureDebuggerReady(tab.id);
	const state = ['none', 'uncaught', 'all'].includes(String(params.state)) ? String(params.state) : 'none';
	await withCDP(tab.id, (send) => send('Debugger.setPauseOnExceptions', { state }));
	const st = ensureDebuggerState(tab.id);
	// Turning the policy off is the "I am done with exceptions" gesture, so a
	// page left parked by one is released instead of staying frozen until the
	// caller remembers to resume it separately.
	let resumed = false;
	if (state === 'none' && st.paused && st.reason === 'exception') {
		await withCDP(tab.id, (send) => send('Debugger.resume', { terminateOnResume: false })).catch(() => {});
		resumed = true;
	}
	return { tabId: tab.id, pauseOnExceptions: state, resumed };
}

/* --------------------------------------------------- Fetch: intercept/rewrite */

async function cmdFetchEnable(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureFetchState(tab.id);
	const hold = params.hold !== false;
	st.hold = hold;
	const patterns = Array.isArray(params.patterns) && params.patterns.length > 0
		? params.patterns.map((p) => ({
			urlPattern: p.urlPattern ? String(p.urlPattern) : '*',
			...(p.resourceType ? { resourceType: String(p.resourceType) } : {}),
			...(p.requestStage ? { requestStage: String(p.requestStage) } : {}),
		}))
		: [{ urlPattern: String(params.urlPattern || '*'), requestStage: params.stage === 'response' ? 'Response' : 'Request' }];
	st.patterns = patterns;
	st.stage = params.stage === 'response' ? 'Response' : 'Request';
	await withCDP(tab.id, (send) => send('Fetch.enable', {
		patterns,
		handleAuthRequests: params.handleAuthRequests === true,
	}));
	st.enabled = true;
	return {
		tabId: tab.id,
		enabled: true,
		patterns,
		hold,
		note: hold
			? 'matching requests now park until fetch.continue / fetch.fulfill / fetch.fail is sent — the page will look frozen meanwhile'
			: 'matching requests are recorded and continued automatically',
	};
}

async function cmdFetchDisable(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureFetchState(tab.id);
	await withCDP(tab.id, (send) => send('Fetch.disable', {})).catch(() => {});
	st.enabled = false;
	const released = st.paused.size;
	st.paused.clear();
	return { tabId: tab.id, enabled: false, released };
}

async function cmdFetchList(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureFetchState(tab.id);
	const limit = Math.min(FETCH_LOG_MAX, Math.max(1, Number(params.limit) || 50));
	const pattern = typeof params.urlPattern === 'string' && params.urlPattern ? new RegExp(params.urlPattern, 'i') : null;
	const rows = (params.parked === true ? [...st.paused.values()] : st.log).filter((e) => !pattern || pattern.test(e.url || ''));
	const tail = rows.slice(-limit);
	if (params.clear === true) st.log = [];
	return {
		tabId: tab.id,
		enabled: st.enabled,
		hold: st.hold !== false,
		patterns: st.patterns,
		parked: st.paused.size,
		parkedIds: [...st.paused.keys()],
		count: tail.length,
		requests: tail,
		pendingAuth: st.auth || [],
	};
}

function takePaused(tabId, requestId) {
	const st = ensureFetchState(tabId);
	if (!requestId) throw new Error('params.requestId is required (from fetch.list)');
	if (!st.paused.has(requestId)) {
		throw new Error(`request ${requestId} is not parked (fetch.list shows the ids currently held; Fetch.disable releases everything)`);
	}
	return st;
}

async function cmdFetchContinue(params) {
	const tab = await resolveTab(params.tabId);
	const st = takePaused(tab.id, params.requestId);
	const entry = st.paused.get(params.requestId);
	const cdpParams = { requestId: String(params.requestId) };
	if (params.url) cdpParams.url = String(params.url);
	if (params.method) cdpParams.method = String(params.method).toUpperCase();
	if (params.postData !== undefined) cdpParams.postData = params.postData === null ? undefined : String(params.postData);
	if (params.headers) {
		const merged = { ...(entry.headers || {}), ...params.headers };
		cdpParams.headers = Object.entries(merged).map(([name, value]) => ({ name, value: String(value) }));
	}
	if (params.interceptResponse === true) cdpParams.interceptResponse = true;
	const stage = entry.stage === 'response' && params.interceptResponse !== true;
	const method = stage ? 'Fetch.continueResponse' : 'Fetch.continueRequest';
	try {
		await withCDP(tab.id, (send) => send(method, cdpParams));
	} catch (err) {
		if (stage && /wasn't found|not found|Invalid parameters/i.test(String(err.message))) {
			await withCDP(tab.id, (send) => send('Fetch.continueRequest', cdpParams));
		} else throw err;
	}
	st.paused.delete(String(params.requestId));
	return { tabId: tab.id, continued: true, requestId: params.requestId, viaMethod: method, modified: Boolean(params.url || params.method || params.headers || params.postData !== undefined) };
}

async function cmdFetchFulfill(params) {
	const tab = await resolveTab(params.tabId);
	const st = takePaused(tab.id, params.requestId);
	const responseCode = Number(params.responseCode) || 200;
	// Byte length of the body being sent: a base64 payload's decoded length is
	// its binary-string length, while a text payload must be measured in UTF-8
	// code units, never in JS characters.
	let body;
	let bodyBytes = 0;
	if (params.bodyBase64 !== undefined) {
		body = String(params.bodyBase64);
		bodyBytes = atob(body).length;
	} else if (params.body !== undefined) {
		const text = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
		body = base64EncodeUtf8(text);
		bodyBytes = utf8ByteLength(text);
	}
	const cdpParams = { requestId: String(params.requestId), responseCode };
	if (params.responsePhrase) cdpParams.responsePhrase = String(params.responsePhrase);
	const headers = { ...(params.responseHeaders || {}) };
	if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8';
	if (body !== undefined) headers['Content-Length'] = String(bodyBytes);
	if (Object.keys(headers).length > 0) cdpParams.responseHeaders = Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
	if (body !== undefined) cdpParams.body = body;
	await withCDP(tab.id, (send) => send('Fetch.fulfillRequest', cdpParams));
	st.paused.delete(String(params.requestId));
	return { tabId: tab.id, fulfilled: true, requestId: params.requestId, responseCode, bodyBytes };
}

async function cmdFetchFail(params) {
	const tab = await resolveTab(params.tabId);
	const st = takePaused(tab.id, params.requestId);
	const errorReason = String(params.errorReason || 'Failed');
	await withCDP(tab.id, (send) => send('Fetch.failRequest', { requestId: String(params.requestId), errorReason }));
	st.paused.delete(String(params.requestId));
	return { tabId: tab.id, failed: true, requestId: params.requestId, errorReason };
}

async function cmdFetchBody(params) {
	const tab = await resolveTab(params.tabId);
	if (!params.requestId) throw new Error('params.requestId is required');
	const res = await withCDP(tab.id, (send) => send('Fetch.getResponseBody', { requestId: String(params.requestId) }));
	const raw = (res && res.body) || '';
	const base64Encoded = Boolean(res && res.base64Encoded);
	return { tabId: tab.id, requestId: params.requestId, base64Encoded, bytes: base64Encoded ? Math.floor(raw.length * 0.75) : raw.length, body: raw };
}

async function cmdFetchAuth(params) {
	const tab = await resolveTab(params.tabId);
	const st = ensureFetchState(tab.id);
	if (!params.requestId) throw new Error('params.requestId is required (from fetch.list pendingAuth)');
	const response = ['Default', 'CancelAuth', 'ProvideCredentials'].includes(String(params.response)) ? String(params.response) : 'Default';
	const cdpParams = { requestId: String(params.requestId), authChallengeResponse: { response } };
	if (response === 'ProvideCredentials') {
		if (!params.username) throw new Error('params.username is required with ProvideCredentials');
		cdpParams.authChallengeResponse.username = String(params.username);
		cdpParams.authChallengeResponse.password = String(params.password || '');
	}
	await withCDP(tab.id, (send) => send('Fetch.continueWithAuth', cdpParams));
	st.auth = (st.auth || []).filter((a) => a.requestId !== params.requestId);
	return { tabId: tab.id, requestId: params.requestId, answered: response };
}

/* -------------------------------------------------- replay + page-level hooks */

/** UTF-8 safe base64 for CDP bodies (btoa alone chokes on non-Latin1). */
function base64EncodeUtf8(text) {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function utf8ByteLength(text) {
	try { return new TextEncoder().encode(text).length; } catch { return String(text).length; }
}

const REPLAY_MAX_BYTES = 512 * 1024;

/**
 * Re-issue a captured request from inside the page. Running in the page keeps
 * cookies, origin and CORS semantics identical to the original call — a
 * same-origin XHR replays perfectly; a cross-origin one replays only where the
 * site itself was allowed to call it.
 */
async function cmdNetworkReplay(params) {
	const tab = await resolveTab(params.tabId);
	if (!attachedTabs.has(tab.id)) await ensureAttached(tab.id);
	assertNotPaused(tab.id);
	let base = null;
	if (params.requestId) {
		const tabMap = networkLog.get(tab.id);
		base = tabMap && tabMap.get(String(params.requestId));
		if (!base) throw new Error(`unknown requestId ${params.requestId} (the buffer keeps the last 500 requests of this tab)`);
	}
	const url = params.url || (base && base.url);
	if (!url) throw new Error('provide params.url, or a params.requestId still in the buffer');
	const method = String(params.method || (base && base.method) || 'GET').toUpperCase();
	const headers = {
		...(base ? headersToHar(base.headers, base.extraRequestHeaders).reduce((acc, h) => { acc[h.name] = h.value; return acc; }, {}) : {}),
		...(params.headers || {}),
	};
	for (const key of Object.keys(headers)) {
		// HTTP/2 pseudo-headers (`:authority`, `:path`, …) and the hop-by-hop /
		// browser-owned headers cannot be set from `fetch`; keeping them made the
		// replay die with "Invalid name" before it ever left the page.
		if (key.startsWith(':')) { delete headers[key]; continue; }
		if (/^(content-length|host|connection|cookie|origin|referer|accept-encoding)$/i.test(key) && !(params.headers && key in params.headers)) delete headers[key];
	}
	const body = params.body !== undefined ? params.body : (base && base.postData);
	const init = { method, headers, credentials: 'include', redirect: 'follow' };
	if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') init.body = String(body);
	const expression = `(async () => {
		const init = ${JSON.stringify(init)};
		try {
			const res = await fetch(${JSON.stringify(url)}, init);
			const text = await res.text();
			return JSON.stringify({
				ok: true, status: res.status, statusText: res.statusText, finalUrl: res.url,
				headers: [...res.headers.entries()],
				bytes: text.length,
				body: text.length > ${REPLAY_MAX_BYTES} ? text.slice(0, ${REPLAY_MAX_BYTES}) + '…(truncated)' : text,
			});
		} catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
	})()`;
	const res = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression, awaitPromise: true, returnByValue: true, userGesture: true,
	}));
	if (res.exceptionDetails) throw new Error(`replay threw: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
	const parsed = JSON.parse(res.result.value);
	return { tabId: tab.id, replayOf: params.requestId || null, request: { url, method, headerNames: Object.keys(headers), bodyBytes: init.body ? utf8ByteLength(init.body) : 0 }, ...parsed };
}

/** Source injected into the page to record fetch/XHR calls from JS-land. */
const HOOK_SOURCE = `(() => {
	if (window.__DSH_HOOK__ && window.__DSH_HOOK__.version === 1) return 'already';
	const MAX = 1000, MAXBODY = 200000;
	const cut = (v) => {
		if (v === undefined || v === null) return v;
		let s;
		try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
		return typeof s === 'string' && s.length > MAXBODY ? s.slice(0, MAXBODY) + '…(truncated)' : s;
	};
	const store = { version: 1, installedAt: Date.now(), records: [] };
	const push = (r) => { store.records.push(r); if (store.records.length > MAX) store.records.shift(); };
	const origFetch = window.fetch;
	const origOpen = XMLHttpRequest.prototype.open;
	const origSend = XMLHttpRequest.prototype.send;
	const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
	window.fetch = function (input, init) {
		const rec = {
			kind: 'fetch', t: Date.now(),
			url: typeof input === 'string' ? input : (input && input.url) || '',
			method: ((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
			headers: cut((init && init.headers) || (input && input.headers) || null),
			body: cut(init && init.body),
		};
		push(rec);
		const started = Date.now();
		return origFetch.apply(this, arguments).then((res) => {
			rec.status = res.status;
			rec.ms = Date.now() - started;
			try {
				res.clone().text().then((text) => { rec.response = cut(text); }).catch((e) => { rec.responseError = String(e); });
			} catch (e) { rec.responseError = String(e); }
			return res;
		}, (err) => { rec.error = String(err); rec.ms = Date.now() - started; throw err; });
	};
	XMLHttpRequest.prototype.open = function (method, url) {
		this.__dshHook = { kind: 'xhr', t: Date.now(), method: String(method).toUpperCase(), url: String(url), headers: {} };
		return origOpen.apply(this, arguments);
	};
	XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
		if (this.__dshHook) this.__dshHook.headers[name] = value;
		return origSetHeader.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function (body) {
		const rec = this.__dshHook || { kind: 'xhr', t: Date.now(), method: 'GET', url: '', headers: {} };
		rec.body = cut(body);
		const started = Date.now();
		push(rec);
		this.addEventListener('loadend', () => {
			try {
				rec.status = this.status;
				rec.ms = Date.now() - started;
				rec.response = cut(this.responseType === '' || this.responseType === 'text' ? this.responseText : '[' + this.responseType + ' body not captured]');
			} catch (e) { rec.responseError = String(e); }
		});
		return origSend.apply(this, arguments);
	};
	store.originals = { fetch: origFetch, open: origOpen, send: origSend, setRequestHeader: origSetHeader };
	store.restore = function () {
		if (origFetch) window.fetch = origFetch;
		XMLHttpRequest.prototype.open = origOpen;
		XMLHttpRequest.prototype.send = origSend;
		XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
		store.restored = true;
	};
	window.__DSH_HOOK__ = store;
	return 'installed';
})()`;

async function evalJson(tabId, expression) {
	const res = await withCDP(tabId, (send) => send('Runtime.evaluate', {
		expression, awaitPromise: true, returnByValue: true, userGesture: true,
	}));
	if (res.exceptionDetails) throw new Error(`page exception: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
	return res.result.value;
}

async function cmdHookInstall(params) {
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const st = ensureDebuggerState(tab.id);
	const status = await evalJson(tab.id, HOOK_SOURCE);
	let persistId = st.hookScriptId || null;
	if (params.persist !== false) {
		const res = await withCDP(tab.id, (send) => send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE }));
		persistId = res.identifier || null;
		st.hookScriptId = persistId;
	}
	return { tabId: tab.id, status, persistent: params.persist !== false, identifier: persistId };
}

async function cmdHookLog(params) {
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const limit = Math.min(1_000, Math.max(1, Number(params.limit) || 100));
	const raw = await evalJson(tab.id, `(() => {
		const s = window.__DSH_HOOK__;
		if (!s) return JSON.stringify({ installed: false, total: 0, records: [] });
		return JSON.stringify({ installed: true, total: s.records.length, installedAt: s.installedAt, restored: Boolean(s.restored), records: s.records.slice(-${limit}) });
	})()`);
	const parsed = JSON.parse(raw);
	let records = parsed.records || [];
	if (params.urlPattern) {
		const re = new RegExp(String(params.urlPattern), 'i');
		records = records.filter((r) => re.test(r.url || ''));
	}
	if (params.kind) records = records.filter((r) => r.kind === params.kind);
	if (params.clear === true) await evalJson(tab.id, '(() => { if (window.__DSH_HOOK__) window.__DSH_HOOK__.records.length = 0; return true; })()');
	return { tabId: tab.id, ...parsed, count: records.length, records };
}

async function cmdHookRestore(params) {
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const st = ensureDebuggerState(tab.id);
	const out = await evalJson(tab.id, '(() => { const s = window.__DSH_HOOK__; if (!s || !s.restore) return "not-installed"; s.restore(); return "restored"; })()');
	if (st.hookScriptId) {
		await withCDP(tab.id, (send) => send('Page.removeScriptToEvaluateOnNewDocument', { identifier: st.hookScriptId })).catch(() => {});
		st.hookScriptId = null;
	}
	return { tabId: tab.id, status: out, persistent: false };
}

const COMMANDS = {
	ping: cmdPing, 'browser.info': cmdBrowserInfo,
	'tabs.list': cmdTabsList, 'tabs.open': cmdTabsOpen, 'tabs.close': cmdTabsClose, 'tabs.activate': cmdTabsActivate,
	nav: cmdNav, eval: cmdEval, content: cmdContent, find: cmdFind,
	click: cmdClick, input: cmdInput, press: cmdPress, scroll: cmdScroll,
	snapshot: cmdSnapshot, screenshot: cmdScreenshot,
	wait: cmdWait, dialog: cmdDialogPolicy,
	'console.log': cmdConsoleLog, 'network.log': cmdNetworkLog, 'network.clear': cmdNetworkClear,
	pdf: cmdPdf, emulate: cmdEmulate,
	// Interface analysis + JS reverse engineering (v1.0.9).
	cdp: cmdCdp, 'targets.list': cmdTargetsList, 'targets.autoattach': cmdTargetsAutoAttach,
	'bodies.policy': cmdBodiesPolicy, 'network.body': cmdNetworkBody, 'network.har': cmdNetworkHar,
	'network.replay': cmdNetworkReplay,
	'cookies.get': cmdCookiesGet, 'cookies.set': cmdCookiesSet,
	'cookies.delete': cmdCookiesDelete, 'cookies.clear': cmdCookiesClear,
	'ws.log': cmdWsLog,
	'scripts.list': cmdScriptsList, 'scripts.source': cmdScriptsSource,
	'debugger.enable': cmdDebuggerEnable, 'debugger.break': cmdDebuggerBreak,
	'debugger.unbreak': cmdDebuggerUnbreak, 'debugger.hook': cmdDebuggerHook,
	'debugger.pause': cmdDebuggerPause, 'debugger.resume': cmdDebuggerResume,
	'debugger.step': cmdDebuggerStep, 'debugger.state': cmdDebuggerState,
	'debugger.eval': cmdDebuggerEval, 'debugger.exceptions': cmdDebuggerExceptions,
	'fetch.enable': cmdFetchEnable, 'fetch.disable': cmdFetchDisable, 'fetch.list': cmdFetchList,
	'fetch.continue': cmdFetchContinue, 'fetch.fulfill': cmdFetchFulfill, 'fetch.fail': cmdFetchFail,
	'fetch.body': cmdFetchBody, 'fetch.auth': cmdFetchAuth,
	'hook.install': cmdHookInstall, 'hook.log': cmdHookLog, 'hook.restore': cmdHookRestore,
};

/**
 * Explicit wait primitive: poll until a selector appears, page text contains
 * a string, or a predicate function returns truthy. Polls inside the page via
 * requestAnimationFrame-ish loop (50ms interval) — no bridge round-trips.
 */
async function cmdWait(params) {
	const tab = await resolveTab(params.tabId);
	assertNotPaused(tab.id);
	const timeoutMs = Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 15_000));
	let condition;
	if (params.selector) {
		condition = `!!document.querySelector(${JSON.stringify(String(params.selector))})`;
	} else if (typeof params.text === 'string') {
		condition = `(document.body && document.body.innerText.includes(${JSON.stringify(params.text)}))`;
	} else if (typeof params.fn === 'string' && params.fn.length > 0) {
		// Accept both a predicate function ("() => x.ready") and a bare boolean
		// expression ("x.ready === true"): call function values, evaluate
		// everything else as-is.
		condition = `(() => { const f = (${params.fn}); return typeof f === 'function' ? Boolean(f()) : Boolean(f); })()`;
	} else {
		throw new Error('provide one of selector, text, or fn');
	}
	return withCDP(tab.id, async (send) => {
		const started = Date.now();
		for (;;) {
			const res = await send('Runtime.evaluate', {
				expression: condition,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).catch(() => ({ result: { value: false } }));
			if (res.exceptionDetails) throw new Error(`wait condition error: ${res.exceptionDetails.text}`);
			if (res.result.value === true) return { tabId: tab.id, waited: Date.now() - started };
			if (Date.now() - started >= timeoutMs) throw new Error(`wait timeout after ${timeoutMs}ms`);
			await new Promise((r) => setTimeout(r, 50));
		}
	});
}

/**
 * Read or set the native-dialog auto-answer policy. GET: {action:'get'} →
 * {policy, recent}. SET: {action:'set', policy:'accept'|'dismiss'|'manual'}.
 * Recent dialogs (last 50) are returned so callers can verify what happened.
 */
async function cmdDialogPolicy(params) {
	if (params?.policy !== undefined) {
		const p = String(params.policy);
		if (!['accept', 'dismiss', 'manual'].includes(p)) throw new Error(`invalid dialog policy: ${p}`);
		dialogPolicy = p;
	}
	return { policy: dialogPolicy, recent: dialogLog.slice(-10) };
}

/* ------------------------------------------------------------ popup link */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.type === 'bridgeStatus') {
		sendResponse({ state: wsState, cfg, helloInfo, lastError });
		return false;
	}
	if (msg?.type === 'reconnect') {
		manualDisconnect = false;
		backoffAttempt = 0;
		disconnectNow();
		loadConfig().then(() => { connect(); sendResponse({ started: true }); });
		return true;
	}
	if (msg?.type === 'disconnect') {
		manualDisconnect = true;
		disconnectNow();
		sendResponse({ started: true });
		return false;
	}
	return false;
});

/* -------------------------------------------------------------- lifecycle */

async function init() {
	await loadConfig();
	connect();
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
