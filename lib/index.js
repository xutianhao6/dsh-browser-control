import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
/**
* Incremental frame parser over arbitrary TCP chunks. `drain` parses every
* complete frame currently buffered and keeps the remainder; an oversized or
* unmasked data frame throws, and the caller closes the link.
*/
var FrameReader = class {
	buffer = Buffer.alloc(0);
	/** Append one TCP chunk to the parse buffer. */
	push(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
	}
	/** Parse and consume every complete frame, invoking `onFrame` per frame in order. */
	drain(onFrame) {
		for (;;) {
			const frame = this.readFrame();
			if (!frame) return;
			onFrame(frame);
		}
	}
	readFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const fin = (buf[0] & 128) !== 0;
		const opcode = buf[0] & 15;
		const masked = (buf[1] & 128) !== 0;
		let length = buf[1] & 127;
		let offset = 2;
		if (length === 126) {
			if (buf.length < offset + 2) return null;
			length = buf.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buf.length < offset + 8) return null;
			const extended = buf.readBigUInt64BE(offset);
			offset += 8;
			if (extended > BigInt(67108864)) throw new Error(`websocket frame too large: ${extended} bytes`);
			length = Number(extended);
		}
		let maskKey = null;
		if (masked) {
			if (buf.length < offset + 4) return null;
			maskKey = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + length) return null;
		if (!masked && (opcode === 1 || opcode === 0 || opcode === 2)) throw new Error("websocket client sent an unmasked data frame");
		const payload = Buffer.from(buf.subarray(offset, offset + length));
		if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ maskKey[i & 3];
		this.buffer = buf.subarray(offset + length);
		return {
			fin,
			opcode,
			payload
		};
	}
};
/** Encode one unmasked text frame carrying a UTF-8 JSON message. */
function encodeTextFrame(text) {
	const payload = Buffer.from(text, "utf8");
	if (payload.length < 126) return Buffer.from([
		129,
		payload.length,
		...payload
	]);
	if (payload.length < 65536) {
		const header = Buffer.alloc(4);
		header[0] = 129;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = 129;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}
/** Encode one control frame (opcode 0x8 close, 0x9 ping, 0xA pong); payload stays ≤ 125 bytes. */
function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
	return Buffer.concat([Buffer.from([128 | opcode, payload.length]), payload]);
}
/** Build the close-frame bytes for a status code plus a UTF-8 reason within the 125-byte limit. */
function encodeCloseFrame(code, reason) {
	const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
	const body = Buffer.alloc(2 + reasonBytes.length);
	body.writeUInt16BE(code, 0);
	reasonBytes.copy(body, 2);
	return encodeControlFrame(8, body);
}
//#endregion
//#region lib/types/server.js
/**
* Local WebSocket+HTTP bridge between one browser extension and dsh. The
* extension connects OUT to `ws://127.0.0.1:<port>/ws?token=...`, so no
* native-messaging host or registry setup exists; dsh drives commands through
* {@link BridgeServer.execute} and reads link state through {@link BridgeServer.status}.
* A small HTTP face (`/api/status`, `/api/command`, `/api/cleanup`, `/`) keeps
* the bridge usable from curl while the server runs.
*
* Wire protocol (text frames, one JSON object each):
* - extension → server: `{type:'hello',…}`, `{type:'pong',t}`, `{type:'result',id,ok,result?|error}`
* - server → extension: `{type:'ping',t}`, `{type:'command',id,command,params}`
*
* Command names (sent in `command`) include: `ping`, `browser.info`, `tabs.list/open/close/activate`,
* `nav`, `eval`, `content`, `find`, `click`, `input`, `press`, `scroll`, `snapshot`, `screenshot`,
* `wait`, `dialog`, `console.log`, `network.log`, `network.clear`, `pdf`, `emulate`.
* @module @deepseek-ai/dsh-browser-bridge/server
*/
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
const MAX_COMMAND_TIMEOUT_MS = 3e5;
const MAX_HTTP_BODY_BYTES = 2097152;
/** Agent scratch-file convention: `__name.mjs`-style temp artifacts at the top level only. */
const SCRATCH_FILE_PATTERN = /^__[^/\\]+\.(mjs|cjs|js|png|jpg|jpeg)$/i;
/**
* Clear the screenshots directory and delete agent scratch files. Only the
* top level of each location is touched, except for the named artifact
* subdirectories (HAR exports, script dumps, sourcemap trees), which are
* removed whole — they are generated trees this plugin owns.
* @param options - `shotsDir` is cleared of direct file children; `scratchDir`
*   defaults to the process working directory and loses only scratch-named
*   files; `artifactSubdirs` names subdirectories of `shotsDir` to delete
*   recursively.
* @returns counts and names of what was removed.
*/
async function cleanupArtifacts(options) {
	await mkdir(options.shotsDir, { recursive: true });
	const shotsEntries = await readdir(options.shotsDir, { withFileTypes: true });
	let shotsRemoved = 0;
	for (const entry of shotsEntries) {
		if (!entry.isFile()) continue;
		await rm(path.join(options.shotsDir, entry.name));
		shotsRemoved += 1;
	}
	const subdirsRemoved = [];
	for (const name of options.artifactSubdirs ?? []) {
		if (name.length === 0 || name.includes("/") || name.includes("\\") || name === "." || name === "..") continue;
		const target = path.join(options.shotsDir, name);
		const info = await stat(target).catch(() => null);
		if (info === null || !info.isDirectory()) continue;
		await rm(target, {
			recursive: true,
			force: true
		});
		subdirsRemoved.push(name);
	}
	const scratchDir = options.scratchDir ?? process.cwd();
	const scratchEntries = await readdir(scratchDir, { withFileTypes: true }).catch(() => []);
	const scratchRemoved = [];
	for (const entry of scratchEntries) {
		if (!entry.isFile() || !SCRATCH_FILE_PATTERN.test(entry.name)) continue;
		await rm(path.join(scratchDir, entry.name));
		scratchRemoved.push(entry.name);
	}
	return {
		shotsRemoved,
		scratchRemoved,
		subdirsRemoved
	};
}
/**
* One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
* a fresh listener is built per start so a changed config reuses the class
* without re-allocation concerns. Exactly one extension link is held at a
* time; a newer WebSocket replaces the older one.
*/
var BridgeServer = class {
	options;
	httpServer;
	clientSocket;
	hello;
	connectedAt;
	pending = /* @__PURE__ */ new Map();
	lastError;
	continuationRemainder = "";
	continuationOpen = false;
	constructor(options) {
		this.options = options;
	}
	/** Current link state, also served verbatim as `/api/status`. */
	get status() {
		return {
			listening: this.httpServer !== void 0,
			port: this.httpServer !== void 0 ? this.options.port : void 0,
			extensionConnected: this.clientSocket !== void 0,
			connectedAt: this.connectedAt?.toISOString(),
			hello: this.hello,
			pendingCommands: this.pending.size,
			lastError: this.lastError
		};
	}
	/** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
	async start() {
		if (this.httpServer !== void 0) return;
		const server = http.createServer((req, res) => {
			try {
				this.handleHttp(req, res);
			} catch (error) {
				this.log(`http handler failed: ${errorMessage$1(error)}`);
				res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					ok: false,
					error: "internal error"
				}));
			}
		});
		server.on("upgrade", (req, socket) => {
			try {
				this.handleUpgrade(req, socket);
			} catch (error) {
				this.log(`upgrade failed: ${errorMessage$1(error)}`);
				socket.destroy();
			}
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				this.lastError = errorMessage$1(error);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.options.port, "127.0.0.1");
		});
		this.httpServer = server;
		this.log(`listening on ws://127.0.0.1:${this.options.port}/ws`);
	}
	/** Close the extension link, fail every pending command, and release the port. Idempotent. */
	async stop() {
		const server = this.httpServer;
		if (server === void 0) return;
		this.httpServer = void 0;
		this.closeClientSocket(1001, "server stopping");
		this.failAllPending(/* @__PURE__ */ new Error("browser-bridge stopped"));
		await new Promise((resolve) => {
			server.close(() => resolve());
		});
		this.log("stopped");
	}
	/**
	* Send one command to the connected extension and await its result.
	* Throws while no extension is linked; the rejection message names the fix.
	*/
	async execute(command, params, options = {}) {
		const socket = this.clientSocket;
		if (socket === void 0) throw new Error("no browser extension connected — open the browser that has the DSH Browser Control extension installed");
		const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? 6e4));
		const signal = options.signal;
		if (signal?.aborted) throw new Error(`browser command cancelled before send: ${command}`);
		const id = randomUUID();
		const entry = {
			command,
			resolve: () => {},
			reject: () => {},
			timer: setTimeout(() => {
				if (!this.pending.delete(id)) return;
				entry.reject(/* @__PURE__ */ new Error(`browser command timed out after ${timeoutMs}ms: ${command}`));
			}, timeoutMs)
		};
		const result = new Promise((resolve, reject) => {
			entry.resolve = resolve;
			entry.reject = reject;
		});
		if (signal !== void 0) {
			entry.onAbort = () => {
				if (!this.pending.delete(id)) return;
				entry.reject(/* @__PURE__ */ new Error(`browser command cancelled: ${command}`));
			};
			signal.addEventListener("abort", entry.onAbort, { once: true });
		}
		this.pending.set(id, entry);
		this.log(`-> ${command} (${id})`);
		socket.write(encodeTextFrame(JSON.stringify({
			type: "command",
			id,
			command,
			params
		})));
		try {
			return await result;
		} finally {
			clearTimeout(entry.timer);
			if (entry.onAbort !== void 0 && signal !== void 0) signal.removeEventListener("abort", entry.onAbort);
		}
	}
	/**
	* Delete generated screenshots and agent scratch files via
	* {@link cleanupArtifacts} using this server's configured directories.
	*/
	async cleanup() {
		const result = await cleanupArtifacts({
			shotsDir: this.options.shotsDir,
			...this.options.scratchDir === void 0 ? {} : { scratchDir: this.options.scratchDir }
		});
		this.log(`cleanup: ${result.shotsRemoved} screenshot(s), ${result.scratchRemoved.length} scratch file(s)`);
		return result;
	}
	log(line) {
		this.options.log?.(line);
	}
	handleHttp(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST",
				"Access-Control-Allow-Headers": "Content-Type, X-DSH-Token"
			});
			res.end();
			return;
		}
		if (url.pathname === "/api/status" && req.method === "GET") {
			this.respondJson(res, 200, {
				ok: true,
				...this.status,
				wsUrl: `ws://127.0.0.1:${this.options.port}/ws`,
				shotsDir: path.resolve(this.options.shotsDir)
			});
			return;
		}
		if (url.pathname === "/api/cleanup" && req.method === "POST") {
			if (!this.authorize(req, url)) {
				this.respondJson(res, 401, {
					ok: false,
					error: "unauthorized: send the bridge token in the X-DSH-Token header or ?token="
				});
				return;
			}
			this.cleanup().then((result) => this.respondJson(res, 200, {
				ok: true,
				...result
			}), (error) => this.respondJson(res, 500, {
				ok: false,
				error: errorMessage$1(error)
			}));
			return;
		}
		if (url.pathname === "/api/command" && req.method === "POST") {
			if (!this.authorize(req, url)) {
				this.respondJson(res, 401, {
					ok: false,
					error: "unauthorized: send the bridge token in the X-DSH-Token header or ?token="
				});
				return;
			}
			this.handleCommandRequest(req, res);
			return;
		}
		if (url.pathname === "/" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(statusPageHtml(this.options.port));
			return;
		}
		this.respondJson(res, 404, {
			ok: false,
			error: `no route: ${req.method} ${url.pathname}`
		});
	}
	respondJson(res, statusCode, body) {
		res.writeHead(statusCode, {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*"
		});
		res.end(JSON.stringify(body));
	}
	/**
	* Authorize a state-changing HTTP call.
	*
	* Two independent gates, because the listener is reachable by every local
	* process and by any page a browser happens to have open:
	*  1. the bridge token must match (header `X-DSH-Token` or `?token=`), and
	*  2. a request that carries a browser `Origin` must come from an extension
	*     origin — otherwise a random website could POST to 127.0.0.1:<port> and
	*     drive the user's logged-in browser.
	* Command-line callers (curl, PowerShell, node fetch) send no Origin and pass
	* gate 2 by construction.
	* @param req - incoming request.
	* @param url - parsed request URL, carrying the optional `token` query.
	* @returns whether the request may proceed.
	*/
	authorize(req, url) {
		const origin = req.headers.origin;
		if (typeof origin === "string" && origin.length > 0 && !origin.startsWith("chrome-extension://")) return false;
		const header = req.headers["x-dsh-token"];
		const token = ((Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("token") ?? "").trim();
		return token.length > 0 && token === this.options.token;
	}
	handleCommandRequest(req, res) {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			if (aborted) return;
			size += chunk.length;
			if (size > MAX_HTTP_BODY_BYTES) {
				aborted = true;
				chunks.length = 0;
				this.respondJson(res, 413, {
					ok: false,
					error: "body too large"
				});
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				this.respondJson(res, 400, {
					ok: false,
					error: `invalid JSON body: ${errorMessage$1(error)}`
				});
				return;
			}
			if (typeof parsed.command !== "string" || parsed.command.length === 0) {
				this.respondJson(res, 400, {
					ok: false,
					error: "body must be {\"command\": \"...\", \"params\": {...}}"
				});
				return;
			}
			const timeoutMs = typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : void 0;
			this.execute(parsed.command, parsed.params ?? {}, timeoutMs === void 0 ? {} : { timeoutMs }).then((result) => this.respondJson(res, 200, {
				ok: true,
				result
			}), (error) => {
				const message = errorMessage$1(error);
				const code = message.startsWith("no browser extension") ? 503 : 502;
				this.respondJson(res, code, {
					ok: false,
					error: message
				});
			});
		});
	}
	handleUpgrade(req, socket) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		if ((url.searchParams.get("token") ?? "") !== this.options.token) {
			this.log("websocket rejected: bad token");
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r\n\r
`);
		this.closeClientSocket(1e3, "replaced by a newer connection");
		this.clientSocket = socket;
		this.hello = void 0;
		this.connectedAt = /* @__PURE__ */ new Date();
		this.continuationRemainder = "";
		this.continuationOpen = false;
		this.log(`extension connected from ${socket.remoteAddress}:${socket.remotePort}`);
		const reader = new FrameReader();
		socket.on("data", (chunk) => {
			reader.push(chunk);
			try {
				reader.drain((frame) => this.handleFrame(frame));
			} catch (error) {
				this.log(`protocol error: ${errorMessage$1(error)}`);
				this.lastError = errorMessage$1(error);
				this.closeClientSocket(1002, "protocol error");
			}
		});
		socket.on("error", (error) => {
			this.logVerbose(`socket error: ${errorMessage$1(error)}`);
			this.closeClientSocket(1011, "server error");
		});
		socket.on("close", () => {
			if (this.clientSocket !== socket) return;
			this.closeClientSocket(1e3, "");
		});
	}
	handleFrame(frame) {
		switch (frame.opcode) {
			case 1:
			case 0:
				this.handleText(frame.payload.toString("utf8"), frame.fin, frame.opcode);
				return;
			case 8:
				this.closeClientSocket(1e3, "");
				return;
			case 9:
				this.clientSocket?.write(encodeControlFrame(10, frame.payload));
				return;
			default: return;
		}
	}
	handleText(text, fin, opcode) {
		if (opcode === 0 && !this.continuationOpen) return;
		if (opcode === 1) this.continuationRemainder = "";
		this.continuationOpen = opcode === 0 || !fin;
		this.continuationRemainder += text;
		if (!fin) return;
		const full = this.continuationRemainder;
		this.continuationRemainder = "";
		this.continuationOpen = false;
		let msg;
		try {
			msg = JSON.parse(full);
		} catch {
			this.logVerbose("dropped a non-JSON extension message");
			return;
		}
		if (msg.type === "hello") {
			this.hello = {
				client: typeof msg.client === "string" ? msg.client : "unknown",
				version: typeof msg.version === "string" ? msg.version : "unknown",
				browser: msg.browser ?? {
					name: "unknown",
					version: "unknown",
					ua: ""
				}
			};
			this.log(`hello: client=${this.hello.client} v${this.hello.version} browser=${this.hello.browser.name} ${this.hello.browser.version}`);
			return;
		}
		if (msg.type === "pong") return;
		if (msg.type === "result" && typeof msg.id === "string") {
			const entry = this.pending.get(msg.id);
			if (entry === void 0) {
				this.logVerbose(`result for unknown id ${msg.id}`);
				return;
			}
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.ok === true) entry.resolve(msg.result);
			else entry.reject(new Error(typeof msg.error === "string" && msg.error.length > 0 ? msg.error : "unknown extension error"));
		}
	}
	closeClientSocket(code, reason) {
		const socket = this.clientSocket;
		if (socket === void 0) return;
		this.clientSocket = void 0;
		this.hello = void 0;
		this.connectedAt = void 0;
		this.failAllPending(/* @__PURE__ */ new Error("the browser extension disconnected mid-command"));
		try {
			socket.write(encodeCloseFrame(code, reason));
			socket.end();
			setTimeout(() => socket.destroy(), 500).unref();
		} catch {
			socket.destroy();
		}
		if (reason.length > 0) this.log(`extension disconnected (${reason})`);
	}
	failAllPending(error) {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
	logVerbose(line) {
		this.options.log?.(line);
	}
};
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Minimal self-refreshing status page with the cleanup action. */
function statusPageHtml(port) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Browser Control — 状态</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--dim:#94a3b8;
        --green:#22c55e;--green-bg:rgba(34,197,94,.12);--red:#ef4444;--red-bg:rgba(239,68,68,.10)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);
       color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:440px;width:100%;overflow:hidden}
  .head{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--red)}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .head h1{font-size:15px;font-weight:600}.head small{color:var(--dim);font-size:11px}
  .rows{padding:16px 24px}
  .row{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;
       border-bottom:1px solid var(--border);font-size:13px}
  .row:last-child{border-bottom:none}
  .row .k{color:var(--dim)}.row .v{font-weight:500;text-align:right;max-width:260px;word-break:break-all}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
  .badge.on{background:var(--green-bg);color:var(--green)}.badge.off{background:var(--red-bg);color:var(--red)}
  .actions{padding:8px 24px;display:flex;gap:8px}
  .btn{padding:7px 14px;border:1px solid var(--border);border-radius:9px;background:var(--card);
       color:var(--text);font-size:12px;cursor:pointer}.btn:hover{background:#334155}
  .btn.danger{border-color:var(--red);color:var(--red)}.btn.danger:hover{background:var(--red-bg)}
  .hint{color:var(--dim);font-size:11px;padding:4px 24px 8px}
  .pre{background:var(--bg);border-top:1px solid var(--border);padding:12px 24px}
  .pre code{color:var(--dim);font-size:11px;white-space:pre-wrap;word-break:break-all}
  .foot{text-align:center;padding:12px;font-size:11px;color:var(--dim)}
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div class="dot" id="dot"></div>
    <div><h1>DSH Browser Control</h1><small id="sub">加载中…</small></div>
  </div>
  <div class="rows" id="rows"></div>
  <div class="actions">
    <button class="btn" onclick="refresh()">刷新</button>
    <button class="btn danger" id="cleanup">🧹 清理截图 + 脚本草稿</button>
  </div>
  <div class="hint">清理会删除截图目录下的全部文件，以及工作目录顶层的 __ 开头草稿脚本。</div>
  <div class="pre"><code id="raw"> </code></div>
  <div class="foot">DSH Browser Bridge · 127.0.0.1:${port}</div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    const connected=j.extensionConnected;
    document.getElementById('dot').className='dot'+(connected?' on':'');
    document.getElementById('sub').textContent=connected
      ?(j.hello?j.hello.client+' '+j.hello.browser.name+' '+j.hello.browser.version:'已连接')
      :'等待浏览器扩展连接…';
    const rows=[
      ['监听端口','<span class="badge on">'+j.port+'</span>'],
      ['扩展状态',connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>'],
      ['扩展类型',j.hello?(j.hello.client+' v'+j.hello.version):'—'],
      ['浏览器',j.hello?(j.hello.browser.name+' '+j.hello.browser.version):'—'],
      ['等待命令',String(j.pendingCommands??0)],
      ['连接时间',j.connectedAt?new Date(j.connectedAt).toLocaleString():'—'],
      ['截图目录',j.shotsDir||'—'],
    ];
    document.getElementById('rows').innerHTML=rows.map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>').join('');
    document.getElementById('raw').textContent=JSON.stringify(j,null,2);
  }catch(e){document.getElementById('sub').textContent='连接失败: '+e.message}
}
document.getElementById('cleanup').onclick=async()=>{
  if(!confirm('确认清理截图与临时脚本？'))return;
  const r=await fetch('/api/cleanup',{method:'POST'});const j=await r.json();
  alert(j.ok?('已删除 '+j.shotsRemoved+' 个截图，'+j.scratchRemoved.length+' 个草稿'):('失败：'+j.error));
  refresh();
};
refresh();setInterval(refresh,2000);
<\/script>
</body></html>`;
}
//#endregion
//#region lib/types/launch.js
/**
* Dedicated-browser launcher.
*
* Chrome allows exactly one debugger client per tab, so a profile shared with
* other debugger-hungry extensions (Claude, ChatGPT, screen recorders) makes
* `chrome.debugger.attach` fail intermittently with
* "Cannot access a chrome-extension:// URL of different extension". The fix is
* an isolated user-data-dir that holds only the DSH Browser Control extension;
* this module makes dsh bring that environment up on demand instead of asking
* the user to launch it by hand before every task.
*
* Two deliberate properties:
* - Spawning is idempotent at the OS level: launching Chrome again for an
*   already-running user-data-dir is forwarded to the existing process (a new
*   window/tab at most), never a second browser fighting for the same bridge.
* - `--load-extension` is NOT used: Chrome 137+ removed the switch. The CDP
*   `Extensions.loadUnpacked` path is scriptable but **session-scoped** — the
*   extension is gone from the profile on the next start — so it only serves as
*   `bootstrapScript` rescue. Durable installation means loading the unpacked
*   extension once from `chrome://extensions` with developer mode on, exactly
*   like the daily profile does.
* @module @deepseek-ai/dsh-browser-bridge/launch
*/
/** Per-platform Chrome locations tried when `chromePath` is not configured. */
const CHROME_CANDIDATES = {
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		"%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"
	],
	darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser"
	]
};
/** Poll interval while waiting for the extension to dial in. */
const POLL_INTERVAL_MS = 250;
/** Do not re-spawn within this window: a failed attempt must not fork Chrome per tool call. */
const RESPAWN_COOLDOWN_MS = 5e3;
/** Ceiling for the one-time bootstrap script. */
const BOOTSTRAP_TIMEOUT_MS = 9e4;
/** Expand `%LOCALAPPDATA%`-style prefixes in configured candidate paths. */
function expandEnv(value) {
	return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}
/**
* Resolve the Chrome binary to launch.
* @param explicit - configured `launch.chromePath`; wins when it exists on disk.
* @returns the path to use, or undefined when nothing usable was found.
*/
function detectChromePath(explicit) {
	const configured = expandEnv(explicit.trim());
	if (configured.length > 0) return existsSync(configured) ? configured : void 0;
	for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
		const expanded = expandEnv(candidate);
		if (existsSync(expanded)) return expanded;
	}
}
/**
* Brings the dedicated browser environment up when a `browser_*` call finds the
* bridge without an extension link. Concurrent callers share one attempt, and a
* failed attempt backs off so a misconfigured profile cannot fork Chrome on
* every single tool call.
*/
var BrowserLauncher = class {
	options;
	inFlight;
	lastAttemptAt = 0;
	constructor(options) {
		this.options = options;
	}
	/**
	* Ensure an extension is connected, launching the dedicated environment when
	* configured to. Resolves once an attempt has been made; callers re-check the
	* link themselves. Never throws: a launch failure is logged and the original
	* "no extension connected" error stays the one the model sees.
	*/
	async ensureConnected() {
		const config = this.options.readConfig();
		if (config === void 0 || !config.enabled) return;
		if (this.options.isConnected()) return;
		if (config.profileDir.trim().length === 0) {
			this.options.log("browser-bridge: launch.enabled 为真但没有配 profileDir，跳过自动拉起");
			return;
		}
		if (this.inFlight !== void 0) return this.inFlight;
		if (Date.now() - this.lastAttemptAt < RESPAWN_COOLDOWN_MS) return;
		this.inFlight = this.attempt(config).catch((error) => {
			this.options.log(`browser-bridge: 拉起专属浏览器失败：${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			this.inFlight = void 0;
			this.lastAttemptAt = Date.now();
		});
		return this.inFlight;
	}
	/** One launch attempt: spawn, wait for the handshake, bootstrap once if needed. */
	async attempt(config) {
		const chrome = detectChromePath(config.chromePath);
		if (chrome === void 0) {
			this.options.log("browser-bridge: 找不到 Chrome —— 用 launch.chromePath 指定可执行文件");
			return;
		}
		this.options.log(`browser-bridge: 没有扩展连接，拉起专属浏览器 ${config.profileDir}`);
		this.spawnDetached(chrome, [
			`--user-data-dir=${config.profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			...config.extraArgs,
			...config.urls
		]);
		if (await this.waitForConnection(config.waitMs)) {
			this.options.log("browser-bridge: 专属浏览器已连接");
			return;
		}
		if (config.bootstrapScript.trim().length === 0) {
			this.options.log("browser-bridge: 等待扩展握手超时 —— 该 profile 里可能还没装 DSH Browser Control 扩展");
			return;
		}
		if (!existsSync(config.bootstrapScript)) {
			this.options.log(`browser-bridge: 引导脚本不存在：${config.bootstrapScript}`);
			return;
		}
		this.options.log(`browser-bridge: 握手超时，运行引导脚本 ${config.bootstrapScript}`);
		await this.runBootstrap(config.bootstrapScript, config.profileDir);
		if (await this.waitForConnection(config.waitMs)) {
			this.options.log("browser-bridge: 引导后扩展已连接");
			return;
		}
		this.options.log("browser-bridge: 引导后仍未连接 —— 请检查该 profile 里的扩展是否被停用或路径已失效");
	}
	/** Start a detached GUI process; the bridge talks to it over the extension, not stdio. */
	spawnDetached(command, args) {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore"
		});
		child.on("error", () => {});
		child.unref();
	}
	/** Poll until the bridge reports a link, or the budget runs out. */
	async waitForConnection(budgetMs) {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (this.options.isConnected()) return true;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		return this.options.isConnected();
	}
	/**
	* Run the rescue script that loads the unpacked extension into `profileDir`
	* through CDP. Session-scoped by design (see {@link ResolvedLaunchConfig.bootstrapScript});
	* the script owns the messy part (debug port, loadUnpacked, status output).
	*/
	async runBootstrap(script, profileDir) {
		const args = process.platform === "win32" ? [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			script,
			"-ProfileDir",
			profileDir
		] : [
			script,
			"-ProfileDir",
			profileDir
		];
		const command = process.platform === "win32" ? "powershell.exe" : "bash";
		await new Promise((resolve) => {
			const child = spawn(command, args, { stdio: "ignore" });
			const timer = setTimeout(() => {
				child.kill();
				resolve();
			}, BOOTSTRAP_TIMEOUT_MS);
			child.on("error", () => {
				clearTimeout(timer);
				resolve();
			});
			child.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
};
//#endregion
//#region lib/types/reverse.js
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
/** Cap for a single artifact written by the script/sourcemap dumpers. */
const SCRIPT_DUMP_MAX_BYTES = 25165824;
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
function renderPayload$1(value, maxChars) {
	const record = value ?? {};
	const scalars = [
		"tabId",
		"action",
		"count",
		"entries",
		"bytes",
		"file",
		"error",
		"unavailable",
		"ok",
		"autoAttach",
		"policy"
	].filter((key) => record[key] !== void 0).map((key) => `${key}=${String(record[key])}`).join(" ");
	const inner = typeof record.json === "string" ? record.json : typeof record.js === "string" ? record.js : typeof record.body === "string" ? record.body : typeof record.index === "string" ? record.index : typeof record.source === "string" ? record.source : JSON.stringify(value, null, 1) ?? String(value);
	const text = scalars.length === 0 ? inner : `${scalars}\n${inner}`;
	if (text.length <= maxChars) return [{
		type: "text",
		text
	}];
	return [{
		type: "text",
		text: `${text.slice(0, maxChars)}\n…(truncated — ${text.length - maxChars} more chars)`
	}];
}
/** Timestamp fragment shared by every artifact name. */
function stamp() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
/** Resolve (and create) a subdirectory of the shots directory. */
async function artifactDir(host, subdir) {
	const dir = host.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	const target = path.join(dir, subdir);
	await mkdir(target, { recursive: true });
	return target;
}
/** Write one artifact and return its absolute path + byte size. */
async function writeArtifact(dir, name, data) {
	const file = path.join(dir, name);
	await writeFile(file, data, "utf8");
	return {
		file,
		bytes: Buffer.byteLength(data, "utf8")
	};
}
/** Filesystem-safe tail of a URL, used to name dumped scripts. */
function safeName(input, fallback) {
	const cleaned = ((input.split(/[?#]/)[0] ?? "").split("/").filter((part) => part.length > 0).pop() ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
	return cleaned.length > 0 ? cleaned : fallback;
}
/** Name a dumped script without doubling an extension it already carries. */
function scriptFileName(prefix, source, scriptId) {
	const name = safeName(source, scriptId);
	return /\.(m?js|cjs|jsx|ts|tsx)$/i.test(name) ? `${prefix}-${name}` : `${prefix}-${name}.js`;
}
/**
* Map a sourcemap `sources[]` entry onto a relative path inside the dump
* directory. `..` segments are dropped rather than resolved, so a hostile map
* cannot write outside the artifact tree.
*/
function sourceRelPath(source, sourceRoot) {
	let value = source;
	if (typeof sourceRoot === "string" && sourceRoot.length > 0) try {
		value = new URL(source, sourceRoot).toString();
	} catch {
		value = source;
	}
	value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
	const parts = value.split("/").filter((part) => part.length > 0 && part !== "." && part !== "..").map((part) => part.replace(/[^A-Za-z0-9._@$()[\]{}-]+/g, "_").slice(0, 100));
	if (parts.length === 0) return "root.js";
	return path.join(...parts);
}
/** Decode a `data:` sourcemap URL into its JSON text. */
function decodeDataUrl(url) {
	const comma = url.indexOf(",");
	if (comma < 0) return null;
	const meta = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	if (/;base64/i.test(meta)) return Buffer.from(payload, "base64").toString("utf8");
	try {
		return decodeURIComponent(payload);
	} catch {
		return payload;
	}
}
/** Register every reverse-engineering tool. */
function registerReverseTools(ctx, host) {
	const run = async (command, params, signal) => await host.execute(command, params, signal);
	const json = (value) => {
		try {
			return JSON.stringify(value, null, 1) ?? String(value);
		} catch {
			return String(value);
		}
	};
	ctx.tools.register(defineTool({
		name: "browser_cdp",
		description: "Send a raw Chrome DevTools Protocol command to a tab (or to a non-tab target such as a worker). This is the escape hatch for everything the other tools do not wrap: Network.*, Storage.*, DOM.*, Emulation.*, Runtime.*, Debugger.*, Page.*. Example: method \"Network.getAllCookies\". Two domains are blocked for extension debugger clients and answer -32601 \"wasn't found\": the browser-level `Browser.*` domain, and `Target.*`. Use browser_targets to discover a targetId (that API is not blocked), then pass it here to drive a worker directly.",
		parameters: {
			method: {
				type: "string",
				required: true,
				description: "CDP method name, e.g. \"Network.getAllCookies\", \"Storage.getCookies\", \"Runtime.evaluate\"."
			},
			params: {
				type: "json",
				description: "CDP parameters object (method-specific). Omit when the method takes none."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			targetId: {
				type: "string",
				description: "Non-tab CDP target id (worker / OOPIF / service worker) from Target.getTargets."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: { type: "number" },
					targetId: { type: "string" },
					method: {
						type: "string",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `CDP ${args.method}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { method: args.method };
			if (args.params !== void 0) params.params = args.params;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (typeof args.targetId === "string") params.targetId = args.targetId;
			const raw = await run("cdp", params, exec.signal);
			return {
				...raw.tabId === void 0 ? {} : { tabId: raw.tabId },
				...typeof raw.targetId === "string" ? { targetId: raw.targetId } : {},
				method: args.method,
				json: json(raw.result)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_cookies",
		description: "Read, set, delete or clear cookies through CDP — HttpOnly cookies included, which page JavaScript can never see. \"get\" with a url returns exactly the cookies that url would send; without one it returns the whole profile jar.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"get",
					"set",
					"delete",
					"clear"
				],
				description: "get = read, set = write, delete = remove one, clear = wipe the jar."
			},
			url: {
				type: "string",
				description: "Request URL: scopes \"get\" to that URL and anchors \"set\"/\"delete\"."
			},
			domain: {
				type: "string",
				description: "Cookie domain for set/delete; on \"get\" it is a case-insensitive substring filter."
			},
			name: {
				type: "string",
				description: "Cookie name (regex filter on get, exact name on set/delete)."
			},
			value: {
				type: "string",
				description: "Cookie value for action \"set\"."
			},
			path: {
				type: "string",
				description: "Cookie path; defaults to / with a domain."
			},
			secure: {
				type: "boolean",
				description: "Set the Secure attribute."
			},
			httpOnly: {
				type: "boolean",
				description: "Set the HttpOnly attribute."
			},
			sameSite: {
				type: "string",
				enum: [
					"Strict",
					"Lax",
					"None"
				],
				description: "SameSite attribute."
			},
			expires: {
				type: "number",
				description: "Expiry as a Unix timestamp in seconds."
			},
			includeHttpOnly: {
				type: "boolean",
				description: "get: include HttpOnly cookies (default true)."
			},
			values: {
				type: "boolean",
				description: "get: include cookie values (default true; false returns only names + lengths)."
			},
			limit: {
				type: "number",
				description: "get: maximum rows (default 1000)."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					ok: {
						type: "boolean",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Cookies ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			for (const key of [
				"url",
				"domain",
				"name",
				"value",
				"path",
				"sameSite"
			]) if (typeof args[key] === "string" && args[key].length > 0) params[key] = args[key];
			for (const key of [
				"secure",
				"httpOnly",
				"includeHttpOnly",
				"values"
			]) if (typeof args[key] === "boolean") params[key] = args[key];
			for (const key of [
				"expires",
				"limit",
				"tabId"
			]) if (typeof args[key] === "number") params[key] = args[key];
			const command = {
				get: "cookies.get",
				set: "cookies.set",
				delete: "cookies.delete",
				clear: "cookies.clear"
			}[args.action];
			if (command === void 0) throw new Error(`unknown action: ${args.action}`);
			const raw = await run(command, params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				action: args.action,
				ok: true,
				json: json(raw)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_body_policy",
		description: "Read or set the background response-body capture policy. `off` captures nothing, `xhr` (default) captures XHR/Fetch responses as they finish, `all` also captures documents/scripts/images. Captured bodies are what browser_network_body and browser_network_log(includeBodies) can hand back later — the renderer drops a body shortly after the request, so this is the only way to keep it without asking in time.",
		parameters: {
			policy: {
				type: "string",
				enum: [
					"off",
					"xhr",
					"all"
				],
				description: "Set the policy; omit to just read the current one."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 1e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.policy ? `Body capture → ${args.policy}` : "Read body capture policy",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (typeof args.policy === "string") params.policy = args.policy;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await run("bodies.policy", params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				json: json(raw)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_targets",
		description: "List every debuggable target Chrome exposes (pages, extension workers, other top-level targets). A page's dedicated Web Workers are NOT in that list — pass `autoAttach: true` first and Chrome will then report each worker with `source: \"Target auto-attach\"`; take its targetId to browser_cdp to evaluate inside the worker, enable its Debugger domain, or hot-patch its code. That is how you reach the signing logic sites hide in workers.",
		parameters: {
			autoAttach: {
				type: "boolean",
				description: "true = turn Target auto-attach on for this tab and list what appears; false = turn it off."
			},
			type: {
				type: "string",
				description: "Filter by target type, e.g. \"page\", \"worker\", \"shared_worker\", \"service_worker\", \"iframe\", \"other\"."
			},
			tabId: {
				type: "number",
				description: "Only targets of this tab (workers carry a tabId only once auto-attach reported them)."
			},
			waitForDebuggerOnStart: {
				type: "boolean",
				description: "autoAttach: also pause new workers before their first line (default false)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					autoAttach: { type: "boolean" },
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.autoAttach === void 0 ? "List debug targets" : `Targets autoAttach=${args.autoAttach}`,
			kind: "other"
		}),
		async execute(args, exec) {
			let autoAttach;
			if (typeof args.autoAttach === "boolean") {
				const params = { enable: args.autoAttach };
				if (args.tabId !== void 0) params.tabId = args.tabId;
				if (args.waitForDebuggerOnStart === true) params.waitForDebuggerOnStart = true;
				await run("targets.autoattach", params, exec.signal);
				autoAttach = args.autoAttach;
			}
			const listParams = {};
			if (typeof args.type === "string") listParams.type = args.type;
			if (args.tabId !== void 0) listParams.tabId = args.tabId;
			const raw = await run("targets.list", listParams, exec.signal);
			return {
				tabId: Number(args.tabId ?? 0),
				count: Number(raw.count ?? 0),
				...autoAttach === void 0 ? {} : { autoAttach },
				json: json(raw)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_network_body",
		description: "Fetch one captured response body (or a request's post body) by requestId. Response bodies are only available while the renderer still holds them — grab them right after the request, or use browser_body_policy to capture them in the background.",
		parameters: {
			requestId: {
				type: "string",
				required: true,
				description: "CDP requestId from browser_network_log."
			},
			kind: {
				type: "string",
				enum: ["response", "request"],
				description: "response (default) or request post body."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					requestId: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					base64Encoded: { type: "boolean" },
					unavailable: { type: "boolean" },
					error: { type: "string" },
					body: { type: "string" }
				}
			},
			render: (_args, value) => renderPayload$1(value, 8e3)
		},
		presentCall: () => ({
			card: "generic",
			title: "Read network body",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { requestId: args.requestId };
			if (args.kind !== void 0) params.kind = args.kind;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await run("network.body", params, exec.signal);
			const text = raw.kind === "request" ? raw.postData : raw.body;
			return {
				tabId: Number(raw.tabId ?? 0),
				requestId: args.requestId,
				kind: String(raw.kind ?? "response"),
				bytes: Number(raw.bytes ?? (typeof text === "string" ? text.length : 0)),
				...raw.base64Encoded === void 0 ? {} : { base64Encoded: raw.base64Encoded },
				...raw.unavailable === true ? { unavailable: true } : {},
				...typeof raw.error === "string" ? { error: raw.error } : {},
				...typeof text === "string" ? { body: text } : {}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_network_har",
		description: "Export the captured traffic of a tab as a HAR 1.2 file (headers, cookies, post bodies, response bodies when still available) and return the file path plus a request index. Opens in Chrome DevTools, Charles, Fiddler or any HAR viewer.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			includeStatic: {
				type: "boolean",
				description: "Include images/fonts/CSS/scripts (default false)."
			},
			includeBodies: {
				type: "boolean",
				description: "Embed response bodies (default true)."
			},
			save: {
				type: "boolean",
				description: "Write the .har file to disk (default true)."
			},
			path: {
				type: "string",
				description: "Explicit .har path; defaults to <shotsDir>/har/."
			},
			clear: {
				type: "boolean",
				description: "Clear the tab buffer after exporting."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					entries: {
						type: "number",
						required: true
					},
					file: { type: "string" },
					bytes: { type: "number" },
					index: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 8e3)
		},
		presentCall: () => ({
			card: "generic",
			title: "Export HAR",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.includeStatic === true) params.includeStatic = true;
			if (args.includeBodies === false) params.includeBodies = false;
			if (args.clear === true) params.clear = true;
			const raw = await run("network.har", params, exec.signal);
			const text = JSON.stringify(raw.har ?? {}, null, 1);
			let file;
			let bytes;
			if (args.save !== false) {
				const dir = typeof args.path === "string" && args.path.length > 0 ? path.dirname(path.resolve(args.path)) : await artifactDir(host, "har");
				await mkdir(dir, { recursive: true });
				const written = await writeArtifact(dir, typeof args.path === "string" && args.path.length > 0 ? path.basename(args.path) : `${stamp()}-tab${raw.tabId ?? 0}.har`, text);
				file = written.file;
				bytes = written.bytes;
			}
			const entries = raw.har?.log?.entries ?? [];
			const index = entries.slice(0, 200).map((entry) => {
				const method = entry.request?.method ?? "?";
				const url = entry.request?.url ?? "";
				return `${method} ${entry.response?.status ?? 0} ${url.length > 160 ? url.slice(0, 160) + "…" : url}`;
			}).join("\n");
			return {
				tabId: Number(raw.tabId ?? 0),
				entries: entries.length,
				...file === void 0 ? {} : { file },
				...bytes === void 0 ? {} : { bytes },
				index
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_network_replay",
		description: "Re-issue a captured request from inside the page, with the page's cookies and origin, optionally overriding url/method/headers/body. Use it to probe how an API reacts to edited parameters or to confirm a signature.",
		parameters: {
			requestId: {
				type: "string",
				description: "Request to replay (from browser_network_log); its url/method/headers/body are reused when not overridden."
			},
			url: {
				type: "string",
				description: "Override the target URL."
			},
			method: {
				type: "string",
				description: "Override the HTTP method."
			},
			headers: {
				type: "json",
				description: "Extra or replacement headers, merged over the captured ones."
			},
			body: {
				type: "string",
				description: "Override the request body."
			},
			tabId: {
				type: "number",
				description: "Tab whose page context performs the replay; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					ok: {
						type: "boolean",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: () => ({
			card: "generic",
			title: "Replay request",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (typeof args.requestId === "string") params.requestId = args.requestId;
			if (typeof args.url === "string") params.url = args.url;
			if (typeof args.method === "string") params.method = args.method;
			if (args.headers !== void 0) params.headers = args.headers;
			if (typeof args.body === "string") params.body = args.body;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await run("network.replay", params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				ok: raw.ok === true,
				json: json(raw)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_websocket_log",
		description: "Read captured WebSocket traffic for a tab: handshake request/response headers, per-socket frame counts, and the frames themselves (direction, opcode, payload).",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			urlPattern: {
				type: "string",
				description: "Regex filter on the socket URL (case-insensitive)."
			},
			payloadPattern: {
				type: "string",
				description: "Regex filter on frame payloads."
			},
			direction: {
				type: "string",
				enum: ["sent", "received"],
				description: "Only frames in this direction."
			},
			limit: {
				type: "number",
				description: "Maximum frames returned, newest last (default 200)."
			},
			clear: {
				type: "boolean",
				description: "Clear captured frames after reading."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: () => ({
			card: "generic",
			title: "Read WebSocket log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			for (const key of [
				"urlPattern",
				"payloadPattern",
				"direction"
			]) if (typeof args[key] === "string" && args[key].length > 0) params[key] = args[key];
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await run("ws.log", params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				json: json(raw)
			};
		}
	}));
	const mapScriptRef = (args) => {
		const params = {};
		if (typeof args.scriptId === "string") params.scriptId = args.scriptId;
		if (typeof args.url === "string") params.url = args.url;
		if (typeof args.urlPattern === "string") params.urlPattern = args.urlPattern;
		if (typeof args.index === "number") params.index = args.index;
		return params;
	};
	ctx.tools.register(defineTool({
		name: "browser_scripts",
		description: "Work with the JavaScript a tab has parsed. Actions: \"list\" every script (inline, eval, webpack chunks included — far more than <script src> shows), \"source\" one script's full text, \"dump\" all matching scripts to files under the shots directory, \"sourcemap\" resolve a script's .map and write the original sources tree back out.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list",
					"source",
					"dump",
					"sourcemap"
				],
				description: "What to do."
			},
			scriptId: {
				type: "string",
				description: "CDP scriptId (exact target)."
			},
			url: {
				type: "string",
				description: "Exact script URL."
			},
			urlPattern: {
				type: "string",
				description: "Regex over script URLs."
			},
			index: {
				type: "number",
				description: "Pick the Nth match of urlPattern (0-based)."
			},
			limit: {
				type: "number",
				description: "list: max rows (default 200). dump: max scripts to fetch (default 200)."
			},
			minLength: {
				type: "number",
				description: "list/dump: skip scripts shorter than this."
			},
			withSourceMap: {
				type: "boolean",
				description: "list: only scripts that declare a sourceMappingURL."
			},
			inlineOnly: {
				type: "boolean",
				description: "list: only inline/webpack scripts without a URL."
			},
			maxBytes: {
				type: "number",
				description: "source: truncate above this size (default 16 MiB)."
			},
			save: {
				type: "boolean",
				description: "source: also write the file to disk."
			},
			dir: {
				type: "string",
				description: "dump/sourcemap: explicit output directory."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					js: {
						type: "string",
						required: true
					},
					files: { type: "string" },
					count: { type: "number" }
				}
			},
			render: (_args, value) => renderPayload$1(value, 12e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Scripts ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			if (args.action === "list") {
				const params = {};
				if (typeof args.urlPattern === "string") params.urlPattern = args.urlPattern;
				if (typeof args.limit === "number") params.limit = args.limit;
				if (typeof args.minLength === "number") params.minLength = args.minLength;
				if (args.withSourceMap === true) params.withSourceMap = true;
				if (args.inlineOnly === true) params.inlineOnly = true;
				if (args.tabId !== void 0) params.tabId = args.tabId;
				const raw = await run("scripts.list", params, exec.signal);
				return {
					tabId: Number(raw.tabId ?? 0),
					action: "list",
					count: Number(raw.count ?? 0),
					js: json(raw)
				};
			}
			if (args.action === "source") {
				const params = mapScriptRef(args);
				if (typeof args.maxBytes === "number") params.maxBytes = args.maxBytes;
				if (args.tabId !== void 0) params.tabId = args.tabId;
				const raw = await run("scripts.source", params, exec.signal);
				if (typeof raw.source === "string" && args.save === true) {
					const dir = typeof args.dir === "string" && args.dir.length > 0 ? path.resolve(args.dir) : await artifactDir(host, "scripts");
					await mkdir(dir, { recursive: true });
					const written = await writeArtifact(dir, scriptFileName(stamp(), String(raw.url ?? raw.scriptId ?? "script"), String(raw.scriptId ?? "script")), raw.source);
					return {
						tabId: Number(raw.tabId ?? 0),
						action: "source",
						js: json(raw),
						files: written.file
					};
				}
				return {
					tabId: Number(raw.tabId ?? 0),
					action: "source",
					js: json(raw)
				};
			}
			if (args.action === "dump") {
				const listParams = { limit: typeof args.limit === "number" ? args.limit : 200 };
				if (typeof args.urlPattern === "string") listParams.urlPattern = args.urlPattern;
				if (typeof args.minLength === "number") listParams.minLength = args.minLength;
				if (args.tabId !== void 0) listParams.tabId = args.tabId;
				const listed = await run("scripts.list", listParams, exec.signal);
				const scripts = listed.scripts ?? [];
				const tabId = Number(listed.tabId ?? 0);
				const dir = typeof args.dir === "string" && args.dir.length > 0 ? path.resolve(args.dir) : await artifactDir(host, path.join("scripts", `${stamp()}-tab${tabId}`));
				await mkdir(dir, { recursive: true });
				const manifest = [];
				let failures = 0;
				for (let i = 0; i < scripts.length; i += 1) {
					const script = scripts[i];
					try {
						const source = await run("scripts.source", { scriptId: script.scriptId }, exec.signal);
						if (typeof source.source !== "string") {
							failures += 1;
							continue;
						}
						const written = await writeArtifact(dir, `${String(i).padStart(4, "0")}-${scriptFileName("", script.url || script.scriptId, script.scriptId).replace(/^-/, "")}`, source.source.slice(0, SCRIPT_DUMP_MAX_BYTES));
						manifest.push({
							scriptId: script.scriptId,
							url: script.url,
							bytes: source.bytes ?? source.source.length,
							truncated: source.truncated === true,
							file: written.file
						});
					} catch (error) {
						failures += 1;
						manifest.push({
							scriptId: script.scriptId,
							url: script.url,
							error: error instanceof Error ? error.message : String(error)
						});
					}
				}
				const manifestFile = await writeArtifact(dir, "manifest.json", JSON.stringify({
					tabId,
					dumpedAt: (/* @__PURE__ */ new Date()).toISOString(),
					count: manifest.length,
					failures,
					scripts: manifest
				}, null, 1));
				return {
					tabId,
					action: "dump",
					count: manifest.length,
					files: manifestFile.file,
					js: JSON.stringify({
						dir,
						count: manifest.length,
						failures,
						manifest: manifestFile.file
					}, null, 1)
				};
			}
			if (args.action === "sourcemap") {
				const params = mapScriptRef(args);
				if (args.tabId !== void 0) params.tabId = args.tabId;
				const script = await run("scripts.source", {
					...params,
					maxBytes: 1
				}, exec.signal);
				if (script.ambiguous === true) return {
					tabId: Number(script.tabId ?? 0),
					action: "sourcemap",
					js: json({
						ambiguous: true,
						matches: script.matches
					})
				};
				const scriptUrl = String(script.url ?? "");
				const declared = String(script.sourceMapURL ?? "");
				if (declared.length === 0) return {
					tabId: Number(script.tabId ?? 0),
					action: "sourcemap",
					js: json({
						error: "this script declares no sourceMappingURL",
						scriptId: script.scriptId,
						url: scriptUrl
					})
				};
				let mapUrl = declared;
				if (!declared.startsWith("data:")) try {
					mapUrl = new URL(declared, scriptUrl || void 0).toString();
				} catch {
					mapUrl = declared;
				}
				let mapText = mapUrl.startsWith("data:") ? decodeDataUrl(mapUrl) : null;
				let via = mapText === null ? "" : "data-url";
				if (mapText === null) try {
					const response = await fetch(mapUrl);
					if (response.ok) {
						mapText = await response.text();
						via = "node-fetch";
					}
				} catch {}
				if (mapText === null) {
					const expression = `(async () => { try { const r = await fetch(${JSON.stringify(mapUrl)}, { credentials: 'include' }); return JSON.stringify({ ok: r.ok, status: r.status, text: await r.text() }); } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); } })()`;
					const evaluated = await run("eval", {
						expression,
						...args.tabId === void 0 ? {} : { tabId: args.tabId }
					}, exec.signal);
					try {
						const parsed = JSON.parse(String(evaluated.value));
						if (parsed.ok === true && typeof parsed.text === "string") {
							mapText = parsed.text;
							via = "page-fetch";
						}
					} catch {}
				}
				if (mapText === null) return {
					tabId: Number(script.tabId ?? 0),
					action: "sourcemap",
					js: json({
						error: "sourcemap could not be fetched",
						mapUrl,
						scriptUrl
					})
				};
				let document;
				try {
					document = JSON.parse(mapText);
				} catch (error) {
					return {
						tabId: Number(script.tabId ?? 0),
						action: "sourcemap",
						js: json({
							error: `sourcemap is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
							mapUrl
						})
					};
				}
				const sources = document.sources ?? [];
				const contents = document.sourcesContent ?? [];
				const base = typeof args.dir === "string" && args.dir.length > 0 ? path.resolve(args.dir) : await artifactDir(host, path.join("sourcemaps", `${stamp()}-${safeName(scriptUrl || script.scriptId || "script", "bundle")}`));
				await mkdir(base, { recursive: true });
				const written = [];
				for (let i = 0; i < sources.length; i += 1) {
					const relative = sourceRelPath(String(sources[i]), document.sourceRoot);
					const content = contents[i];
					if (typeof content !== "string") {
						written.push({
							source: String(sources[i]),
							missing: true
						});
						continue;
					}
					const target = path.join(base, relative);
					await mkdir(path.dirname(target), { recursive: true });
					await writeFile(target, content, "utf8");
					written.push({
						source: String(sources[i]),
						file: target,
						bytes: Buffer.byteLength(content, "utf8")
					});
				}
				await writeArtifact(base, "_sourcemap.json", mapText);
				const withContent = written.filter((entry) => entry.missing !== true).length;
				return {
					tabId: Number(script.tabId ?? 0),
					action: "sourcemap",
					count: withContent,
					files: base,
					js: json({
						scriptUrl,
						mapUrl,
						via,
						sources: sources.length,
						restored: withContent,
						withoutContent: sources.length - withContent,
						dir: base,
						names: (document.names ?? []).length,
						files: written.slice(0, 500)
					})
				};
			}
			throw new Error(`unknown action: ${String(args.action)}`);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_debugger",
		description: "Debugger control for reverse engineering. \"enable\" turns the Debugger domain on (required before scripts/breakpoints). \"break\" sets a line breakpoint by url/urlRegex; \"hook\" breaks on every call of a function you name by expression — the fastest way to capture a signature function's real arguments; \"state\" shows the paused call frames; \"eval\" evaluates an expression inside a paused frame; \"step\"/\"resume\" move execution; \"unbreak\" removes breakpoints.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"enable",
					"break",
					"unbreak",
					"hook",
					"pause",
					"resume",
					"step",
					"state",
					"eval",
					"exceptions"
				],
				description: "Operation to perform."
			},
			url: {
				type: "string",
				description: "break: exact script URL."
			},
			urlRegex: {
				type: "string",
				description: "break: regex over script URLs."
			},
			lineNumber: {
				type: "number",
				description: "break: 0-based line number."
			},
			columnNumber: {
				type: "number",
				description: "break: 0-based column number."
			},
			condition: {
				type: "string",
				description: "break/hook: only pause when this expression is truthy in the frame."
			},
			scriptId: {
				type: "string",
				description: "break: target a script id instead of a url."
			},
			breakpointId: {
				type: "string",
				description: "unbreak: the id to remove."
			},
			all: {
				type: "boolean",
				description: "unbreak: remove every breakpoint of this tab."
			},
			expression: {
				type: "string",
				description: "hook: expression yielding the function to watch (e.g. \"window.sign\" or \"JSON.parse\"); eval: the expression to evaluate in the paused frame."
			},
			callFrameId: {
				type: "string",
				description: "eval: frame id from \"state\"."
			},
			step: {
				type: "string",
				enum: [
					"over",
					"into",
					"out"
				],
				description: "step: direction (default over)."
			},
			state: {
				type: "string",
				enum: [
					"none",
					"uncaught",
					"all"
				],
				description: "exceptions: pause-on-exception policy."
			},
			full: {
				type: "boolean",
				description: "state/pause/step: include the full frame objects with scope chains."
			},
			timeoutMs: {
				type: "number",
				description: "pause/step: how long to wait for the next pause."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					js: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Debugger ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			for (const key of [
				"url",
				"urlRegex",
				"condition",
				"scriptId",
				"breakpointId",
				"expression",
				"callFrameId",
				"state"
			]) if (typeof args[key] === "string" && args[key].length > 0) params[key] = args[key];
			for (const key of [
				"lineNumber",
				"columnNumber",
				"timeoutMs",
				"tabId"
			]) if (typeof args[key] === "number") params[key] = args[key];
			if (args.all === true) params.all = true;
			if (args.full === true) params.full = true;
			const command = args.action === "step" ? "debugger.step" : {
				enable: "debugger.enable",
				break: "debugger.break",
				unbreak: "debugger.unbreak",
				hook: "debugger.hook",
				pause: "debugger.pause",
				resume: "debugger.resume",
				state: "debugger.state",
				eval: "debugger.eval",
				exceptions: "debugger.exceptions"
			}[args.action];
			if (command === void 0) throw new Error(`unknown action: ${String(args.action)}`);
			if (args.action === "step") params.action = typeof args.step === "string" ? args.step : "over";
			const raw = await run(command, params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				action: String(args.action),
				js: json(raw)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_intercept",
		description: "Intercept live traffic through the Fetch domain to read or rewrite it. \"enable\" parks matching requests (hold=true) or just records them (hold=false); \"list\" shows what is parked with its headers and post body; \"continue\" forwards (optionally with a new url/method/headers/body), \"fulfill\" answers with a body you supply, \"fail\" kills it, \"body\" reads a parked response body, \"auth\" answers an HTTP auth challenge. Always \"disable\" when done — parked requests hang the page.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"enable",
					"disable",
					"list",
					"continue",
					"fulfill",
					"fail",
					"body",
					"auth"
				],
				description: "Operation to perform."
			},
			urlPattern: {
				type: "string",
				description: "enable: glob-ish url pattern (default \"*\"); list: regex filter."
			},
			patterns: {
				type: "json",
				description: "enable: full CDP pattern array, e.g. [{\"urlPattern\":\"*/api/*\",\"requestStage\":\"Request\"}]."
			},
			stage: {
				type: "string",
				enum: ["request", "response"],
				description: "enable: which stage to intercept (default request). Use response to edit the reply."
			},
			hold: {
				type: "boolean",
				description: "enable: true (default) parks requests for you to decide; false records and continues them."
			},
			handleAuthRequests: {
				type: "boolean",
				description: "enable: also intercept HTTP auth challenges."
			},
			requestId: {
				type: "string",
				description: "Target parked request (from \"list\")."
			},
			url: {
				type: "string",
				description: "continue: rewrite the URL."
			},
			method: {
				type: "string",
				description: "continue: rewrite the method."
			},
			headers: {
				type: "json",
				description: "continue/fulfill: header object to merge/apply."
			},
			postData: {
				type: "string",
				description: "continue: replacement request body."
			},
			interceptResponse: {
				type: "boolean",
				description: "continue: also intercept the response stage after continuing."
			},
			responseCode: {
				type: "number",
				description: "fulfill: status code (default 200)."
			},
			responsePhrase: {
				type: "string",
				description: "fulfill: status text."
			},
			responseHeaders: {
				type: "json",
				description: "fulfill: response headers object."
			},
			body: {
				type: "string",
				description: "fulfill: response body text (JSON string or plain text)."
			},
			bodyBase64: {
				type: "string",
				description: "fulfill: response body already base64-encoded."
			},
			errorReason: {
				type: "string",
				description: "fail: CDP error reason such as Failed, Aborted, AccessDenied."
			},
			response: {
				type: "string",
				enum: [
					"Default",
					"CancelAuth",
					"ProvideCredentials"
				],
				description: "auth: how to answer the challenge."
			},
			username: {
				type: "string",
				description: "auth: username with ProvideCredentials."
			},
			password: {
				type: "string",
				description: "auth: password with ProvideCredentials."
			},
			parked: {
				type: "boolean",
				description: "list: only the currently parked requests."
			},
			limit: {
				type: "number",
				description: "list: maximum rows (default 50)."
			},
			clear: {
				type: "boolean",
				description: "list: clear the log after reading."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					js: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 6e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Intercept ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			for (const key of [
				"urlPattern",
				"stage",
				"requestId",
				"url",
				"method",
				"postData",
				"responsePhrase",
				"errorReason",
				"response",
				"username",
				"password"
			]) if (typeof args[key] === "string" && args[key].length > 0) params[key] = args[key];
			for (const key of [
				"limit",
				"responseCode",
				"tabId"
			]) if (typeof args[key] === "number") params[key] = args[key];
			for (const key of [
				"hold",
				"handleAuthRequests",
				"interceptResponse",
				"parked",
				"clear"
			]) if (typeof args[key] === "boolean") params[key] = args[key];
			for (const key of [
				"patterns",
				"headers",
				"responseHeaders"
			]) if (args[key] !== void 0) params[key] = args[key];
			if (typeof args.body === "string") params.body = args.body;
			if (typeof args.bodyBase64 === "string") params.bodyBase64 = args.bodyBase64;
			const raw = await run(`fetch.${args.action}`, params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				action: String(args.action),
				js: json(raw)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_hook",
		description: "Inject and read a page-level fetch/XHR recorder. Unlike CDP capture this sees what the site's own JavaScript passed in — headers, bodies, response text — which is what you need when the payload is built in JS before it hits the wire. \"install\" (optionally persistent across navigations), \"log\" to read the records, \"restore\" to remove it.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"install",
					"log",
					"restore"
				],
				description: "Operation to perform."
			},
			persist: {
				type: "boolean",
				description: "install: also inject into every future document (default true)."
			},
			urlPattern: {
				type: "string",
				description: "log: regex filter over recorded URLs."
			},
			kind: {
				type: "string",
				enum: ["fetch", "xhr"],
				description: "log: only this transport."
			},
			limit: {
				type: "number",
				description: "log: maximum records, newest last (default 100)."
			},
			clear: {
				type: "boolean",
				description: "log: clear the page-side buffer after reading."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					js: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => renderPayload$1(value, 8e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Page hook ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (typeof args.urlPattern === "string") params.urlPattern = args.urlPattern;
			if (typeof args.kind === "string") params.kind = args.kind;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.persist === false) params.persist = false;
			if (args.clear === true) params.clear = true;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await run(`hook.${args.action}`, params, exec.signal);
			return {
				tabId: Number(raw.tabId ?? 0),
				action: String(args.action),
				js: json(raw)
			};
		}
	}));
}
//#endregion
//#region lib/types/index.js
/**
* Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
* extension connects to, plus the model-facing `browser_*` tools that drive
* it. The Settings-managed `enabled` flag starts and stops the listener live
* through dsh-settings' change hook — no reload needed.
*
* We deliberately bypass the higher-level `installSettingsSection` helper and
* talk to the lower-level `sctx.settings.register` API directly: that API
* predates the helper and is the one stable across every dsh-settings build a
* consumer is realistically pinned to. Importing the helper on a build that
* does not export it crashes the whole plugin at module load.
*
* Tools stay mounted whenever the plugin does; calling one while the bridge
* is disabled or the extension is offline fails with a message naming the
* fix, so the model can tell the user what to do instead of hanging.
* @module @deepseek-ai/dsh-browser-bridge
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "browser-bridge";
/** The tool registry this plugin contributes `browser_*` tools to. */
const inject = ["tools", "systemPrompt"];
/** Settings namespace carrying the bridge switch and endpoint options. */
const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
const Config = z.object({
	enabled: z.boolean().default(true),
	port: z.number().step(1).min(1024).max(65535).default(9777),
	token: z.string().default("dsh-local"),
	shotsDir: z.string().default("dsh-browser-shots"),
	launch: z.object({
		enabled: z.boolean().default(false),
		chromePath: z.string().default(""),
		profileDir: z.string().default(""),
		urls: z.array(z.string()).default([]),
		extraArgs: z.array(z.string()).default([]),
		waitMs: z.number().step(1).min(1e3).max(12e4).default(25e3),
		bootstrapScript: z.string().default("")
	})
});
/**
* Apply `launch` defaults defensively. The nested schema already carries them,
* but resolving here keeps the controller correct on dsh-settings builds that
* hand back a partially populated section, and on `apply()`'s raw config.
* @param config - raw or settings-resolved plugin config.
* @returns the same config with every field materialized.
*/
function resolveConfig(config) {
	const launch = config.launch ?? {};
	return {
		enabled: config.enabled ?? true,
		port: config.port ?? 9777,
		token: config.token ?? "dsh-local",
		shotsDir: config.shotsDir ?? "dsh-browser-shots",
		launch: {
			enabled: launch.enabled ?? false,
			chromePath: launch.chromePath ?? "",
			profileDir: launch.profileDir ?? "",
			urls: [...launch.urls ?? []],
			extraArgs: [...launch.extraArgs ?? []],
			waitMs: launch.waitMs ?? 25e3,
			bootstrapScript: launch.bootstrapScript ?? ""
		}
	};
}
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
const READ_CONTENT_MAX_CHARS = 12e4;
/**
* Owns zero or one live {@link BridgeServer} and restarts it whenever the
* resolved settings change. Reconciles serialize through a promise chain so a
* burst of settings commits cannot interleave stop/start pairs.
*/
var BridgeController = class {
	log;
	server;
	serverKey = "";
	lastError;
	chain = Promise.resolve();
	current;
	/**
	* Brings the dedicated browser environment up when a call finds the bridge
	* without a link. It reads the latest settings on every attempt, so flipping
	* `launch` in dsh settings applies to the next tool call without a restart.
	*/
	launcher;
	constructor(log) {
		this.log = log;
		this.launcher = new BrowserLauncher({
			readConfig: () => this.current?.launch,
			isConnected: () => this.server?.status.extensionConnected ?? false,
			log
		});
	}
	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir() {
		return this.current === void 0 ? void 0 : path.resolve(this.current.shotsDir);
	}
	/**
	* Converge the live server onto `config`. With `throwOnError`, an initial
	* start failure rejects (fail-loud activation); later changes record the
	* failure instead, so a bad port cannot tear down an otherwise running session.
	* @param config - the freshly resolved settings snapshot.
	* @param options - set `throwOnError` only for the activation-time call.
	* @returns a promise settling once the convergence attempt finished.
	*/
	reconcile(config, options = {}) {
		this.current = config;
		const run = this.chain.then(() => this.reconcileNow(config));
		this.chain = run.catch(() => {});
		if (options.throwOnError === true) return run.catch((error) => {
			throw error instanceof Error ? error : new Error(String(error));
		});
		return Promise.resolve();
	}
	async reconcileNow(config) {
		const shotsDir = path.resolve(config.shotsDir);
		const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : "";
		if (key === this.serverKey) return;
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		await previous?.stop();
		if (!config.enabled) {
			this.lastError = void 0;
			return;
		}
		const server = new BridgeServer({
			port: config.port,
			token: config.token,
			shotsDir,
			log: this.log
		});
		try {
			await server.start();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`;
			this.log(this.lastError);
			throw error instanceof Error ? error : new Error(message);
		}
		this.server = server;
		this.serverKey = key;
		this.lastError = void 0;
	}
	/**
	* Run one extension command over the live link.
	* @param command - extension command name (`nav`, `click`, …).
	* @param params - wire params passed through to the extension.
	* @param signal - tool-execution cancellation propagated to the pending command.
	* @returns the extension's result payload verbatim.
	*/
	async execute(command, params, signal) {
		const server = this.server;
		if (server === void 0) throw new Error(this.lastError ?? "浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关");
		if (!server.status.extensionConnected) await this.launcher.ensureConnected();
		return server.execute(command, params, { signal });
	}
	/**
	* Delete generated artifacts using the currently resolved directories;
	* works while the bridge is stopped because it never touches the socket.
	* @returns counts and names of what was removed.
	*/
	async cleanup() {
		const dir = this.shotsDir;
		if (dir === void 0) throw new Error("浏览器控制尚未加载配置，无法确定清理目录");
		return cleanupArtifacts({
			shotsDir: dir,
			artifactSubdirs: [
				"har",
				"scripts",
				"sourcemaps"
			]
		});
	}
	/** Stop the listener; safe to call repeatedly and during teardown. */
	stop() {
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		return previous?.stop() ?? Promise.resolve();
	}
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Cap long page reads and mark the cut, so token cost stays bounded. */
function clampText(value, maxChars) {
	return value.length <= maxChars ? {
		content: value,
		truncated: false
	} : {
		content: value.slice(0, maxChars),
		truncated: true
	};
}
/**
* Model-facing text for a tool result.
*
* The `render` callback is the *only* channel the model receives: the canonical
* value is schema-validated but never delivered on its own. A summary-only
* render therefore hides exactly the data the tool exists to return (page text,
* element refs, request rows, script sources), so every data-bearing tool
* renders its payload here, capped so one call cannot swallow the context.
* @param value - the tool's canonical value.
* @param maxChars - character budget for the rendered text.
* @returns one text content block.
*/
function renderPayload(value, maxChars) {
	if (typeof value === "string") return [{
		type: "text",
		text: value
	}];
	const text = JSON.stringify(value, null, 1) ?? String(value);
	if (text.length <= maxChars) return [{
		type: "text",
		text
	}];
	return [{
		type: "text",
		text: `${text.slice(0, maxChars)}\n…(truncated — ${text.length - maxChars} more chars)`
	}];
}
/**
* Resolve the element target a click/type tool received.
* @param args - validated tool arguments carrying at most one targeting field.
* @returns the CSS selector to send on the wire, refs translated to their attribute form.
*/
function targetSelector(args) {
	const hasSelector = typeof args.selector === "string" && args.selector.length > 0;
	const hasRef = typeof args.ref === "string" && args.ref.length > 0;
	if (hasSelector === hasRef) throw new Error("provide exactly one of selector or ref (ref comes from browser_snapshot)");
	if (hasRef) {
		const ref = args.ref;
		if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`);
		return `[data-dsh-ref="${ref}"]`;
	}
	return args.selector;
}
function requireTabId(args, action) {
	if (typeof args.tabId !== "number") throw new Error(`${action} requires tabId`);
	return args.tabId;
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	await mkdir(dir, { recursive: true });
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	const random = Math.random().toString(36).slice(2, 6);
	const file = path.join(dir, `${stamp}-${random}.${payload.format === "jpeg" ? "jpg" : "png"}`);
	const buffer = Buffer.from(payload.base64, "base64");
	await writeFile(file, buffer);
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl
	};
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
*  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	let file;
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath;
		await mkdir(path.dirname(file), { recursive: true });
	} else {
		await mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const random = Math.random().toString(36).slice(2, 6);
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
		file = path.join(dir, name);
	}
	const buffer = Buffer.from(payload.base64, "base64");
	await writeFile(file, buffer);
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		...payload.tabTitle === void 0 ? {} : { title: payload.tabTitle },
		...payload.tabUrl === void 0 ? {} : { url: payload.tabUrl }
	};
}
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller) {
	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 112,
		text: "The browser_* tools drive the user's real, logged-in browser through the DSH Browser Control extension; they act on the active tab unless a tabId is passed. Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. browser_read extracts page text, browser_screenshot saves a PNG/JPEG and returns its file path (view it with an image tool). Calls fail with actionable copy while the bridge is disabled or no browser is connected. For interface analysis and JS reverse engineering: browser_network_log (+ browser_network_body / browser_network_har / browser_websocket_log) shows traffic with the real wire headers, browser_cookies reads HttpOnly cookies, browser_scripts lists every parsed script and dumps sources or sourcemap-recovered trees, browser_debugger sets breakpoints and hooks functions to capture their arguments, browser_intercept rewrites live requests, browser_hook records what page JS passed to fetch/XHR, and browser_cdp reaches any Chrome DevTools Protocol method the wrappers do not cover."
	});
	ctx.tools.register(defineTool({
		name: "browser_navigate",
		description: "Navigate a browser tab to a URL and wait for the page load to settle.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open in the tab."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					url: { type: "string" },
					title: { type: "string" }
				}
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter((part) => typeof part === "string" && part.length > 0).join(" — ");
				return [{
					type: "text",
					text: `Tab ${value.tabId} now shows ${label.length > 0 ? label : "(untitled)"}`
				}];
			}
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => ({
			card: "generic",
			title: `Open ${args.url}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { url: args.url };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("nav", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_read",
		description: "Read the current page: title, URL, ready state, and body text (or full HTML).",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			mode: {
				type: "string",
				description: "\"text\" (default) for visible text, \"html\" for the whole document."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					mode: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					content: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.title} (${value.url})\n${value.content}${value.truncated ? "\n…(page text truncated)" : ""}`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const mode = args.mode === "html" ? "html" : "text";
			const raw = await controller.execute("content", args.tabId === void 0 ? { mode } : {
				mode,
				tabId: args.tabId
			}, exec.signal);
			const clamped = clampText(raw.content ?? "", READ_CONTENT_MAX_CHARS);
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? "",
				url: raw.url ?? "",
				content: clamped.content,
				truncated: clamped.truncated
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_snapshot",
		description: "Inventory the page's interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			limit: {
				type: "number",
				description: "Max elements returned; defaults to 120, capped at 200."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								ref: {
									type: "string",
									required: true
								},
								tag: {
									type: "string",
									required: true
								},
								name: { type: "string" },
								href: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.items.length} interactive element(s) on ${value.title}\n${renderPayload(value.items, 8e3)[0].text}`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Snapshot browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const limit = Math.min(200, Math.max(1, args.limit ?? 120));
			const raw = await controller.execute("snapshot", args.tabId === void 0 ? { limit } : {
				limit,
				tabId: args.tabId
			}, exec.signal);
			return {
				tabId: raw.tabId,
				title: raw.title ?? "",
				url: raw.url ?? "",
				items: (raw.items ?? []).map((item) => ({
					ref: item.ref,
					tag: item.tag,
					...item.name === void 0 ? {} : { name: item.name },
					...item.href === void 0 ? {} : { href: item.href }
				}))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_click",
		description: "Click a page element with real mouse events; target it by snapshot ref or CSS selector.",
		parameters: {
			ref: {
				type: "string",
				description: "Element ref from browser_snapshot (e.g. \"e3\"); wins over selector."
			},
			selector: {
				type: "string",
				description: "CSS selector; ignored when ref is given."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			doubleClick: {
				type: "boolean",
				description: "Send a double click instead."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => renderPayload(value, 2e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Click ${args.ref ?? args.selector ?? ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { selector: targetSelector(args) };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.doubleClick !== void 0) params.doubleClick = args.doubleClick;
			return await controller.execute("click", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_type",
		description: "Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.",
		parameters: {
			value: {
				type: "string",
				required: true,
				description: "Text to put into the element."
			},
			ref: {
				type: "string",
				description: "Element ref from browser_snapshot; wins over selector."
			},
			selector: {
				type: "string",
				description: "CSS selector; ignored when ref is given."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			submit: {
				type: "boolean",
				description: "Press Enter after filling."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => renderPayload(value, 2e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Type into ${args.ref ?? args.selector ?? "element"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {
				selector: targetSelector(args),
				value: args.value
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const filled = await controller.execute("input", params, exec.signal);
			if (args.submit === true) await controller.execute("press", args.tabId === void 0 ? { key: "Enter" } : {
				key: "Enter",
				tabId: args.tabId
			}, exec.signal);
			return filled;
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_press",
		description: "Send a real keyboard event to the page (Enter, Tab, Escape, arrows, or a single character).",
		parameters: {
			key: {
				type: "string",
				required: true,
				description: "Named key (Enter, Escape, ArrowDown…) or a single character."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => renderPayload(value, 2e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Press ${args.key}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { key: args.key };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("press", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_scroll",
		description: "Scroll the page viewport by a delta and report the resulting position.",
		parameters: {
			x: {
				type: "number",
				description: "Horizontal delta in pixels; defaults to 0."
			},
			y: {
				type: "number",
				description: "Vertical delta in pixels; positive scrolls down."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => renderPayload(value, 2e3)
		},
		presentCall: () => ({
			card: "generic",
			title: "Scroll browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {
				x: args.x ?? 0,
				y: args.y ?? 0
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("scroll", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_tabs",
		description: "List tabs, or open/close/activate one. Actions act on real browser windows.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "One of: list, open, close, activate."
			},
			url: {
				type: "string",
				description: "URL for the open action."
			},
			tabId: {
				type: "number",
				description: "Target tab for close/activate."
			},
			active: {
				type: "boolean",
				description: "Whether a newly opened tab becomes active; defaults to true."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => renderPayload(value, 4e3)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Browser tabs: ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			switch (args.action) {
				case "list": return await controller.execute("tabs.list", {}, exec.signal);
				case "open": {
					if (typeof args.url !== "string" || args.url.length === 0) throw new Error("open requires url");
					const params = { url: args.url };
					if (args.active !== void 0) params.active = args.active;
					return await controller.execute("tabs.open", params, exec.signal);
				}
				case "close": return await controller.execute("tabs.close", { tabId: requireTabId(args, "close") }, exec.signal);
				case "activate": return await controller.execute("tabs.activate", { tabId: requireTabId(args, "activate") }, exec.signal);
				default: throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate)`);
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_evaluate",
		description: "Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression or statement sequence; awaited like a promise body."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.json.slice(0, 6e3)
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Evaluate in page",
			kind: "other"
		}),
		async execute(args, exec) {
			const raw = await controller.execute("eval", args.tabId === void 0 ? { expression: args.expression } : {
				expression: args.expression,
				tabId: args.tabId
			}, exec.signal);
			let json;
			try {
				json = JSON.stringify(raw.value) ?? String(raw.value);
			} catch {
				json = String(raw.value);
			}
			return {
				tabId: raw.tabId,
				json
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_screenshot",
		description: "Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			fullPage: {
				type: "boolean",
				description: "Capture beyond the viewport."
			},
			format: {
				type: "string",
				description: "\"png\" (default) or \"jpeg\"."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					},
					title: { type: "string" },
					url: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Saved ${value.file} (${value.bytes} bytes)`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser screenshot",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { format: args.format === "jpeg" ? "jpeg" : "png" };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.fullPage !== void 0) params.fullPage = args.fullPage;
			return saveScreenshot(controller, await controller.execute("screenshot", params, exec.signal));
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_cleanup",
		description: "Delete generated browser artifacts: screenshots and PDFs in the shots directory, the reverse-engineering trees under it (har/, scripts/, sourcemaps/), and __-prefixed agent scratch files.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					shotsRemoved: {
						type: "number",
						required: true
					},
					scratchRemoved: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					subdirsRemoved: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Cleaned ${value.shotsRemoved} screenshot(s), ${value.subdirsRemoved.length} artifact tree(s) and ${value.scratchRemoved.length} scratch file(s)`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Clean up browser artifacts",
			kind: "other"
		}),
		async execute() {
			const result = await controller.cleanup();
			return {
				shotsRemoved: result.shotsRemoved,
				scratchRemoved: Array.from(result.scratchRemoved),
				subdirsRemoved: Array.from(result.subdirsRemoved)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_console_log",
		description: "Read the captured `console.log/info/warn/error` entries for a tab. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for \"what did the page log after I clicked submit\".",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			levels: {
				type: "array",
				items: { type: "string" },
				description: "Filter to one or more of: log, info, warn, error, debug."
			},
			pattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the formatted text."
			},
			limit: {
				type: "number",
				description: "Maximum entries to return; default 100, capped at 500."
			},
			clear: {
				type: "boolean",
				description: "Empty the buffer after reading."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					total: {
						type: "number",
						required: true
					},
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} console entries\n${renderPayload(value.entries, 6e3)[0].text}`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser console",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (Array.isArray(args.levels)) params.levels = args.levels;
			if (typeof args.pattern === "string") params.pattern = args.pattern;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			return await controller.execute("console.log", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_network_log",
		description: "Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer. `includeBodies:true` also fetches the response bodies that are still available (capped by `bodyLimit`).",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			includeStatic: {
				type: "boolean",
				description: "Include images / fonts / stylesheets / scripts. Default false."
			},
			methodPattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the HTTP method."
			},
			urlPattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the URL."
			},
			status: {
				type: "string",
				description: "One of: 2xx, 3xx, 4xx, 5xx, failed, pending."
			},
			limit: {
				type: "number",
				description: "Maximum entries to return; default 200, capped at 1000."
			},
			clear: {
				type: "boolean",
				description: "Empty the buffer after reading."
			},
			includeBodies: {
				type: "boolean",
				description: "Also fetch response bodies that are still in memory (default false)."
			},
			bodyLimit: {
				type: "number",
				description: "Maximum bodies to fetch when includeBodies is set (default 20, capped at 100)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					total: {
						type: "number",
						required: true
					},
					requests: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true
						}
					},
					bodiesFetched: { type: "number" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} network requests${value.bodiesFetched ? ` (${value.bodiesFetched} bodies)` : ""}\n${renderPayload(value.requests.map((row) => ({
					requestId: row.requestId,
					method: row.method,
					status: typeof row.status === "number" ? row.status : row.failed === true ? "failed" : void 0,
					mimeType: row.mimeType,
					resourceType: row.resourceType,
					url: row.url,
					bodyCached: row.bodyCached,
					bodyError: row.bodyError
				})), 8e3)[0].text}`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser network log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.includeStatic === true) params.includeStatic = true;
			if (typeof args.methodPattern === "string") params.methodPattern = args.methodPattern;
			if (typeof args.urlPattern === "string") params.urlPattern = args.urlPattern;
			if (typeof args.status === "string") params.status = args.status;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			const payload = await controller.execute("network.log", params, exec.signal);
			if (args.includeBodies !== true) return payload;
			const budget = Math.min(100, Math.max(1, args.bodyLimit ?? 20));
			const wanted = payload.requests.filter((entry) => entry.failed !== true && typeof entry.requestId === "string").slice(-budget);
			let bodiesFetched = 0;
			for (const entry of wanted) try {
				const body = await controller.execute("network.body", {
					requestId: entry.requestId,
					...args.tabId === void 0 ? {} : { tabId: args.tabId }
				}, exec.signal);
				if (typeof body.body === "string") {
					entry.body = body.body;
					bodiesFetched += 1;
				} else if (typeof body.error === "string") entry.bodyError = body.error;
				if (typeof body.bytes === "number") entry.bodyBytes = body.bytes;
			} catch (error) {
				entry.bodyError = error instanceof Error ? error.message : String(error);
			}
			return {
				...payload,
				bodiesFetched
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_network_clear",
		description: "Empty the per-tab network capture buffer without returning the rows.",
		parameters: { tabId: {
			type: "number",
			description: "Target tab; defaults to the active tab."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					cleared: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: network log cleared`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Clear browser network log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("network.clear", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_pdf",
		description: "Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			path: {
				type: "string",
				description: "Absolute path. Omit to save under the configured shotsDir with a timestamped name."
			},
			landscape: {
				type: "boolean",
				description: "Use landscape orientation."
			},
			printBackground: {
				type: "boolean",
				description: "Render CSS backgrounds. Default true."
			},
			paperWidth: {
				type: "number",
				description: "Paper width in inches."
			},
			paperHeight: {
				type: "number",
				description: "Paper height in inches."
			},
			scale: {
				type: "number",
				description: "Page scale (0.1–2.0)."
			},
			pageRanges: {
				type: "string",
				description: "Sub-range, e.g. \"1-3\" or \"1,4-6\"."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Save PDF${args.path ? " → " + args.path : ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.landscape === true) params.landscape = true;
			if (args.printBackground === false) params.printBackground = false;
			if (typeof args.paperWidth === "number") params.paperWidth = args.paperWidth;
			if (typeof args.paperHeight === "number") params.paperHeight = args.paperHeight;
			if (typeof args.scale === "number") params.scale = args.scale;
			if (typeof args.pageRanges === "string") params.pageRanges = args.pageRanges;
			return await savePdf(controller, await controller.execute("pdf", params, exec.signal), typeof args.path === "string" ? args.path : void 0);
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_emulate",
		description: "Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:\"reset\"` restores the user's actual viewport. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			device: {
				type: "string",
				description: "Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below."
			},
			width: {
				type: "number",
				description: "Custom viewport width in CSS px."
			},
			height: {
				type: "number",
				description: "Custom viewport height in CSS px."
			},
			deviceScaleFactor: {
				type: "number",
				description: "Custom DPR (1 = standard, 2 = retina, 3 = super-retina)."
			},
			isMobile: {
				type: "boolean",
				description: "Pass as mobile to the page (affects responsive meta)."
			},
			hasTouch: {
				type: "boolean",
				description: "Enable touch event dispatch."
			},
			userAgent: {
				type: "string",
				description: "Custom User-Agent string. Empty string clears."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					reset: { type: "boolean" },
					width: { type: "number" },
					height: { type: "number" },
					deviceScaleFactor: { type: "number" },
					isMobile: { type: "boolean" },
					hasTouch: { type: "boolean" },
					userAgent: { type: "string" }
				}
			},
			render: (_args, value) => {
				if (value.reset) return [{
					type: "text",
					text: `Tab ${value.tabId}: emulation reset to default`
				}];
				return [{
					type: "text",
					text: `Tab ${value.tabId}: ${value.width || "?"}×${value.height || "?"} DPR=${value.deviceScaleFactor ?? "?"} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}`
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Emulate${args.device ? " " + args.device : " device"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (typeof args.device === "string") params.device = args.device;
			if (typeof args.width === "number") params.width = args.width;
			if (typeof args.height === "number") params.height = args.height;
			if (typeof args.deviceScaleFactor === "number") params.deviceScaleFactor = args.deviceScaleFactor;
			if (typeof args.isMobile === "boolean") params.isMobile = args.isMobile;
			if (typeof args.hasTouch === "boolean") params.hasTouch = args.hasTouch;
			if (typeof args.userAgent === "string") params.userAgent = args.userAgent;
			return await controller.execute("emulate", params, exec.signal);
		}
	}));
	registerReverseTools(ctx, controller);
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	if (resolved.enabled && resolved.token.trim().length === 0) throw new Error("browser-bridge: token must be a non-empty string when enabled");
	const controller = new BridgeController((line) => ctx.logger.info(line));
	let current = () => resolved;
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
			base: config,
			validate: (value) => {
				if (value.enabled && (value.token ?? "").trim().length === 0) throw new Error("browser-bridge: token must be a non-empty string when enabled");
			}
		});
		current = () => resolveConfig(scope.get());
		ctx.effect(() => () => {
			if (ctx.fiber.state === 4 || ctx.fiber.state === 5) return;
			current = () => resolved;
			controller.reconcile(current());
		}, "browser-bridge: settings cleanup");
		controller.reconcile(current());
		scope.watch(() => {
			if (ctx.fiber.state === 4 || ctx.fiber.state === 5) return;
			controller.reconcile(current());
		});
	});
	controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
		throw new Error(`browser-bridge: ${errorMessage(error)}`);
	});
	applyBrowserTools(ctx, controller);
	ctx.effect(() => () => {
		controller.stop();
	}, "browser-bridge: server lifecycle");
}
//#endregion
export { BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, apply, inject, name };
