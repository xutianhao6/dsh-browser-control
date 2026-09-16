#!/usr/bin/env node
/**
 * 把「可见光标 + 点击命中判定」注入浏览器标签页。
 *
 * 为什么要有这个脚本：browser_click 走 CDP Input.dispatchMouseEvent，不移动系统指针，
 * 用户看不到鼠标、也看不到一次点击有没有生效；而把 scripts/cursor-overlay.js 的源码
 * 交给 Agent 每次粘贴进 browser_evaluate，要烧掉上万 token。这里让**脚本自己从磁盘读源码**，
 * 经桥的 HTTP 面（POST /api/command）下发，Agent 只要跑一条命令：
 *
 *   node scripts/enable-cursor.mjs
 *
 * 注入分两步，缺一不可：
 *   1. Page.addScriptToEvaluateOnNewDocument —— 注册到本标签页，之后该标签页打开的
 *      每个新页面都自动带上（DevTools 注入不受页面 CSP 限制）；
 *   2. Runtime.evaluate 直接把源码跑一遍 —— 当前这个文档立刻生效，不用刷新。
 *
 * 用法：
 *   node scripts/enable-cursor.mjs                # 注入到当前活动标签页
 *   node scripts/enable-cursor.mjs --all          # 注入到所有可注入的标签页
 *   node scripts/enable-cursor.mjs --tab 12345    # 指定标签页 id
 *   node scripts/enable-cursor.mjs --check        # 只看状态，不改动
 *   node scripts/enable-cursor.mjs --off          # 卸掉（移除注入节点 + 取消注册）
 *   node scripts/enable-cursor.mjs --port 9777 --token dsh-local
 *
 * 退出码：0 = 成功；1 = 失败（桥连不上 / 没有可注入的标签页 / 注入后校验不通过）。
 *
 * 实现备注：这里用 node:http + agent:false 而不是 fetch —— Node 在 Windows 上于
 * undici 的 keep-alive 连接尚未收干净时 process.exit() 会触发 libuv 断言崩溃
 * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。所以既不 import fetch，
 * 也不调 process.exit()，只设 process.exitCode 让事件循环自然退干净。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(HERE, 'cursor-overlay.js');
const REGISTRY = path.join(os.tmpdir(), 'dsh-cursor-registry.json');

function parseArgs(argv) {
  const o = { port: 9777, token: 'dsh-local', all: false, off: false, check: false, tab: null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--off') o.off = true;
    else if (a === '--check') o.check = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--token') o.token = String(argv[++i] ?? '');
    else if (a === '--tab') o.tab = Number(argv[++i]);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));

const base = () => `http://127.0.0.1:${args.port}`;
const say = (...a) => { if (!args.quiet) console.log(...a); };

function bridge(command, params = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ command, params });
    const req = http.request({
      host: '127.0.0.1',
      port: args.port,
      path: '/api/command',
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-DSH-Token': args.token,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* 非 JSON */ }
        if (res.statusCode !== 200) {
          const hint = res.statusCode === 401 ? '（token 不对：传 --token，或看 profile 补丁里的 token）' : '';
          return reject(new Error(`HTTP ${res.statusCode} ${hint} ${body.slice(0, 200)}`.trim()));
        }
        if (json && json.ok === false) return reject(new Error(json.error || '桥返回 ok:false'));
        resolve(json ? json.result : null);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`桥 ${timeoutMs}ms 内没响应`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const readRegistry = () => { try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return {}; } };
const writeRegistry = (r) => { try { fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2)); } catch { /* 尽力而为 */ } };

function isInjectable(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
  } catch { return false; }
}

const shortUrl = (url, n = 72) => (url.length > n ? url.slice(0, n - 1) + '…' : url);

// 「卸掉」的页面侧清理：移除所有 __dsh_* 节点并撤掉全局对象
const CLEANUP_EXPR = `(() => {
  const nodes = document.querySelectorAll('[id^="__dsh_"]');
  const n = nodes.length;
  nodes.forEach((el) => el.remove());
  delete window.__dshCursor;
  return n;
})()`;

async function main() {
  const source = fs.readFileSync(OVERLAY, 'utf8');
  const sizeKb = (Buffer.byteLength(source, 'utf8') / 1024).toFixed(1);

  let tabs, activeTabId;
  try {
    const r = await bridge('tabs.list', {});
    tabs = (r.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
    activeTabId = r.activeTabId;
  } catch (e) {
    console.error(`✖ 连不上桥 ${base()} —— ${e.message}`);
    console.error('  dsh 没在运行？或插件没启用？浏览器没起来就跑：');
    console.error(`  powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(HERE, 'start-browser.ps1')}"`);
    console.error(`  状态页：${base()}/api/status（看 extensionConnected）`);
    process.exitCode = 1;
    return;
  }

  let targets;
  if (args.tab !== null) targets = tabs.filter((t) => t.id === args.tab);
  else if (args.all) targets = tabs;
  else targets = tabs.filter((t) => t.id === activeTabId);

  if (!targets.length) {
    console.error(args.tab !== null ? `✖ 没有 id=${args.tab} 的标签页` : '✖ 没找到活动标签页');
    console.error(`  当前 ${tabs.length} 个标签页：` + tabs.map((t) => `${t.id}=${shortUrl(t.url, 40)}`).join('  '));
    process.exitCode = 1;
    return;
  }

  const injectable = targets.filter((t) => isInjectable(t.url));
  const registry = readRegistry();
  let failures = 0;

  if (args.check) {
    say(`光标图层状态（桥 ${base()}）`);
    for (const t of targets) {
      if (!isInjectable(t.url)) { say(`  · ${t.id}  ${shortUrl(t.url)}  —— 跳过（chrome:// 等内部页面挂不上调试器）`); continue; }
      let state;
      try {
        const v = await bridge('eval', { expression: 'typeof window.__dshCursor', tabId: t.id }, 15000);
        state = v.value === 'object' ? '已注入' : '未注入';
      } catch (e) { state = `读不到（${e.message.split('\n')[0]}）`; }
      say(`  · ${t.id}  ${shortUrl(t.url)}  —— ${state}${registry[t.id] ? '（已注册，导航后自动带上）' : ''}`);
    }
    return;
  }

  for (const t of targets.filter((x) => !isInjectable(x.url))) {
    say(`  – 跳过 ${t.id}  ${shortUrl(t.url)}（chrome:// 等内部页面挂不上调试器，先 browser_navigate 到 http(s) 页面）`);
  }

  if (!injectable.length) {
    console.error('✖ 没有可注入的标签页（需要 http(s) / file:// 页面）');
    process.exitCode = 1;
    return;
  }

  for (const t of injectable) {
    const label = `${t.id}  ${shortUrl(t.url)}`;
    try {
      if (args.off) {
        const id = registry[t.id];
        if (id) {
          try {
            await bridge('cdp', { method: 'Page.removeScriptToEvaluateOnNewDocument', params: { identifier: id }, tabId: t.id }, 15000);
          } catch { /* 调试器可能重挂过，identifier 失效；不影响当前文档的清理 */ }
          delete registry[t.id];
          writeRegistry(registry);
        }
        const r = await bridge('eval', { expression: CLEANUP_EXPR, tabId: t.id }, 20000);
        say(`  ✔ 已卸掉 ${label}（移除 ${r.value} 个节点${id ? '，并取消注册' : '；无注册记录，后续导航可能仍带着，关掉该标签页即彻底清除'}）`);
        continue;
      }

      // 1) 注册到本标签页：之后新打开的页面自动带上
      //    桥的 cdp 命令返回 { tabId, method, result }，标识符在 result.identifier 里
      //    （扩展源码：extension/background.js 的 cmdCdp → return { tabId, method, result }）
      if (registry[t.id]) {
        // 先撤掉上一次的注册，避免反复注入在同一标签页堆叠多份
        try {
          await bridge('cdp', { method: 'Page.removeScriptToEvaluateOnNewDocument', params: { identifier: registry[t.id] }, tabId: t.id }, 15000);
        } catch { /* 调试器可能重挂过，identifier 失效——重新注册即可 */ }
        delete registry[t.id];
        writeRegistry(registry);
      }
      const reg = await bridge('cdp', { method: 'Page.addScriptToEvaluateOnNewDocument', params: { source }, tabId: t.id }, 30000);
      const identifier = reg && reg.result && reg.result.identifier;
      if (identifier) {
        registry[t.id] = identifier;
        writeRegistry(registry);
      }

      // 2) 当前文档立刻生效
      await bridge('eval', { expression: source, tabId: t.id }, 30000);
      const check = await bridge('eval', {
        expression: 'typeof window.__dshCursor === "object" && typeof window.__dshCursor.clickTo === "function" ? "ready" : "missing"',
        tabId: t.id,
      }, 15000);

      if (check.value === 'ready') {
        say(`  ✔ ${label}`);
        say('      当前文档已生效；本标签页后续导航也自动带上');
      } else {
        failures++;
        say(`  ✖ ${label} —— 注入后校验失败（window.__dshCursor 不存在）`);
      }
    } catch (e) {
      failures++;
      say(`  ✖ ${label} —— ${e.message.split('\n')[0]}`);
    }
  }

  if (!args.off) {
    say('');
    say(`可见光标 + 命中判定就绪（图层源码 ${sizeKb}KB 由本脚本从磁盘读取，不占用 Agent 上下文）`);
    say('用法：await __dshCursor.clickTo("<选择器>")  →  browser_click  →  自动判定');
    say('      绿「命中」= 这次点击真的生效；红「被遮挡 / 被拦截 / 事件未到达」= 没生效，');
    say('      红虚线框会圈出真正吃掉点击的元素（先处理它再重试，不要盲目重复点击）。');
  }

  process.exitCode = failures ? 1 : 0;
}

// 入口放在最后：main() 会用到上面那些 const（base/say/bridge…），提前调用会撞 TDZ
if (args.help) {
  console.log(String(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')).split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exitCode = 0;
} else {
  main().catch((e) => { console.error(`✖ ${e.stack || e.message}`); process.exitCode = 1; });
}
