# 更新日志

## v1.0.9 (2026-09-14)

面向**接口分析 / JS 逆向**的完整能力集：抓包 → 看真实请求头 → 取响应体 / 导 HAR → 定位脚本 → 还原 sourcemap → 函数级 hook 抓入参 → 改包重放 / 伪造响应。全部复用扩展已有的 CDP 附着，不引入代理、证书或新的运行依赖。

- 新增：**原始 CDP 透传 `browser_cdp`** —— `method` + `params`，可带 `tabId`；或用 `targetId` 打到 worker / OOPIF / service worker 等非标签页目标（扩展会先 attach 到那个 target）。Network / Storage / Debugger / Fetch / Emulation / Runtime / Page 各域一次全开，封装工具没覆盖到的都能用它兜底（例：`Network.getAllCookies`、`Network.getRequestPostData`）。
- 新增：**响应体捕获策略 `browser_body_policy`** —— 读/写后台响应体捕获策略 `off` | `xhr`（默认）| `all`，不带 `policy` 即只读。它补上的是一个死路：此前**没有任何工具能改这个策略**，`browser_network_body` 的描述还写着「用 `browser_cdp` 的 `bodies.policy`」——`bodies.policy` 是扩展命令、不是 CDP 方法，照那样调用只会拿到 `-32601 'bodies.policy' wasn't found`。现在该描述指向 `browser_body_policy`，策略也不再只能靠手改扩展代码。
- 新增：**可调试目标 `browser_targets`** —— 列出 Chrome 暴露的全部可调试 target（页面 / 扩展 worker / 其它顶级 target），可按 `type`（`page` / `worker` / `shared_worker` / `service_worker` / `iframe` / `other`）与 `tabId` 过滤；`autoAttach: true|false` 为该标签页开/关 Target auto-attach（可配 `waitForDebuggerOnStart`，让新 worker 在第一行前就停下）。拿到 `targetId` 后交给 `browser_cdp {targetId}`，就能在 worker 里求值、开它的 Debugger 域、甚至热改它的代码。
  - 扩展命令：`targets.list`（`chrome.debugger.getTargets()` 的结果，与 `Target.attachedToTarget` / `targetCreated` / `targetInfoChanged` 事件登记过的 target 合并，后者带 `source: 'Target auto-attach'` 与 `sessionId`）、`targets.autoattach`（`Target.setAutoAttach {autoAttach, waitForDebuggerOnStart, flatten: true}`）。
  - **Chrome 实测限制**：`chrome.debugger` 客户端**不允许浏览器级 `Browser.*` 域**（`Browser.getVersion` → `-32601 … wasn't found`），**也不允许 `Target.getTargets`**（→ `-32000 Not allowed`）；但 **`Target.setAutoAttach` 是允许的**。另外**页面的专用 Worker 完全不出现在 `chrome.debugger.getTargets()` 里**（不带 URL 的、blob worker 都一样），必须先 auto-attach，Chrome 才会以 `Target.attachedToTarget` 把它报出来。
  - 实测：对本地夹具页开 auto-attach 后创建 `/worker.js`（内部 `self.sign = x => 'sig-' + x * 7`）→ `browser_targets {tabId, autoAttach:true}` 列出 `worker http://127.0.0.1:<port>/worker.js`（`source: Target auto-attach`、`attached: true`、带 `sessionId`）→ `browser_cdp {targetId, method:'Runtime.evaluate', params:{expression:'typeof self.sign + "|" + self.sign(6)', returnByValue:true}}` 得到 `"function|sig-42"`；同一个 `targetId` 上 `Debugger.enable` 成功（拿到 `debuggerId`）；把 worker 的 `onmessage` 换成 `postMessage("hooked:" + self.sign(e.data))` 后，页面收到的回包从 `sig-42` 变成 `hooked:sig-35`。
- 新增：**Cookie `browser_cookies`** —— `action: get | set | delete | clear`，分别走 `Network.getCookies` / `getAllCookies` / `setCookie` / `deleteCookies` / `clearBrowserCookies`。**包含 HttpOnly**（页面 JS 永远看不到的那些）。`get` 带 `url` 时返回的就是该 URL 实际会发出去的那一组 cookie，不带则是整个 profile 的 jar；`name`（get 按正则过滤）/ `domain` / `includeHttpOnly` / `values:false`（只回名字与长度，不回值）/ `limit` 可收窄输出。`set` / `delete` 需要 `url` 或 `domain` 才能定位 jar。
- 新增：**响应体与 HAR**
  - `browser_network_body` —— 按 `requestId` 取单条响应体；`kind:'request'` 取 POST 请求体。
  - `browser_network_har` —— 整段会话导成 **HAR 1.2**（`Cookie` / `Set-Cookie` 已解析进 `request.cookies` / `response.cookies`，含 queryString、postData、可用时的响应体），默认落盘 `<shotsDir>/har/`，同时回一份 `method status url` 请求索引。每条 entry 末尾带 **`_requestId`**（`_` 前缀是 HAR 自定义字段的惯例），把它回灌 `browser_network_body` / `browser_network_replay` 就能取到同一个请求的响应体或重放它。
  - `browser_network_replay` —— **在页面上下文里**重放抓到的请求（`credentials: 'include'`），可改 `url` / `method` / `headers` / `body`；HTTP/2 伪头与浏览器自有头（`content-length`、`host`、`cookie`、`origin` …）会自动剔除，避免重放直接死在 `Invalid name`。
- 新增：**WebSocket `browser_websocket_log`** —— 握手请求/响应头、每个 socket 的收发帧数、帧本身（`dir` / `opcode` / `payload`）；可按 `urlPattern` / `payloadPattern` / `direction` 过滤，`clear` 清帧。
- 新增：**脚本与源码 `browser_scripts`**
  - `list` —— Debugger 域注册的全部脚本（内联、eval、webpack chunk 都在，比 `<script src>` 多得多），`urlPattern` / `minLength` / `withSourceMap` / `inlineOnly` 可过滤；
  - `source` —— 单个脚本全文（`scriptId` / 精确 `url` / `urlPattern`+`index` 三种定位，多个匹配时明确报 ambiguous），`maxBytes` 默认 16 MiB，`save` 落盘；
  - `dump` —— 批量把匹配脚本写进 `<shotsDir>/scripts/<时间戳>-tabN/`，并生成 `manifest.json`（scriptId / url / bytes / truncated / file），失败项也记进 manifest；
  - `sourcemap` —— 取脚本声明的 `.map`（先试 `data:` URL，再进程内 fetch，最后回到页面自己 `fetch`），把 `sourcesContent` 还原成**原始源码树**写到 `<shotsDir>/sourcemaps/`，并留一份 `_sourcemap.json`；缺 `sourcesContent` 的只是记 `missing`，不伪造内容。
- 新增：**调试器 `browser_debugger`** —— `enable`（打开 Debugger 域并回放已加载脚本的 scriptParsed）/ `break`（按 `url` 或 `urlRegex` + `lineNumber`，可带 `condition`，也可用 `scriptId` + 行号）/ `unbreak`（单个 `breakpointId` 或 `all:true`）/ `hook`（`expression` 求值出函数对象，用 `Debugger.setBreakpointOnFunctionCall` 在它**每次被调用**时断下——不用在压缩产物里找行号就能抓到签名函数的真实入参）/ `pause` / `resume` / `step`（`over` | `into` | `out`）/ `state`（调用帧、断点表、暂停历史，`full` 带完整作用域链）/ `eval`（在暂停帧上求值，可改参数）/ `exceptions`（`none` | `uncaught` | `all`）。
- 新增：**请求改写 `browser_intercept`** —— Fetch 域：`enable`（`patterns` 数组或 `urlPattern` + `stage: request|response`；`hold` 默认 true 挂住请求等决定，false 只记录并放行；`handleAuthRequests` 连认证挑战一起拦）/ `disable`（放行全部并报告释放条数）/ `list`（已挂住的请求、请求头、post body、待应答的 auth 挑战；`parked` 只看挂住的）/ `continue`（可改 `url` / `method` / `headers` / `postData`，`interceptResponse` 继续拦响应阶段）/ `fulfill`（`responseCode` / `responsePhrase` / `responseHeaders` / `body` 或 `bodyBase64` 伪造响应，自动补 `Content-Type` 与 `Content-Length`）/ `fail`（`errorReason` 如 `Aborted`）/ `body`（读挂住响应的 body）/ `auth`（`Default` | `CancelAuth` | `ProvideCredentials`）。
- 新增：**页面级记录器 `browser_hook`** —— 注入 fetch/XHR 记录器，看到的是**站点自己的 JS 传进去的** headers / body / 响应文本（报文还没落到线上之前的那一层）：`install`（`persist` 默认 true，用 `Page.addScriptToEvaluateOnNewDocument` 跨导航常驻）/ `log`（`urlPattern` / `kind: fetch|xhr` / `limit` / `clear`）/ `restore`（还原原始 fetch/XHR 并撤掉常驻脚本）。
- 新增：网络捕获订阅 **`Network.requestWillBeSentExtraInfo` / `responseReceivedExtraInfo`** —— 真实的 `Cookie` / `Authorization` / `Set-Cookie` 头第一次可见（`requestWillBeSent` 里 Chrome 故意不带这些），HAR 的 cookie 解析与 `browser_network_replay` 的请求头重建都以它为准，条目上记为 `extraRequestHeaders` / `extraResponseHeaders`。
- 变更：`network.log` 的行保留 `requestId`（后续 `network.body` / `network.replay` 的句柄）并新增 `bodyCached`（该响应体是否已缓存，省一次往返）；HAR 的每条 entry 也带 `_requestId`，与这些行一一对应（`bodyCached` 只有 `network.log` 的行有，HAR 不重复带）。新增 **`bodies.policy`** 命令与读写它的 **`browser_body_policy`** 工具（`off` | `xhr` | `all`，默认 `xhr`）在 `loadingFinished` 时就缓存 XHR/Fetch 的响应体（按 `encodedDataLength` 判断，单条 ≤ 1MB，超限跳过）；`browser_network_log` 新增 `includeBodies` / `bodyLimit`（默认 20 条、上限 100），一次把还能取到的响应体带回来。
- 变更：**`browser_cleanup` 现在连逆向产物树一起清**。`cleanupArtifacts()` 新增 `artifactSubdirs` 选项，插件侧传 `['har', 'scripts', 'sourcemaps']`，把这三个子目录整棵递归删除；只接受纯目录名（含 `/`、`\`、`.`、`..` 的一律跳过），其它未知子目录不动。返回值新增 `subdirsRemoved`，`browser_cleanup` 的输出 schema 同步要求该字段，render 文案变为 `Cleaned N screenshot(s), M artifact tree(s) and K scratch file(s)`。
- 修复：`browser_network_log` 的输出 schema 之前把 `requests` 的 items 声明成 `additionalProperties: false, properties: {}`，于是**只要该标签页有一条请求**就报 `"value.requests[0].method" is not a declared property` —— 整个工具从 v1.0.8 起等于不可用。现在正常返回。
- 修复：**导航会漏掉文档请求**。`Network.*` 事件只在扩展持有调试器附着时产生，而 `nav` / `tabs.open` 之前都不先附着 —— 新标签页在 attach 之前发出的请求根本没进缓冲区，「打开目标页 → 看抓包」这条最常用路径会缺掉第一条。现在 `nav` 先 attach 再跳转，`tabs.open` 先开 `about:blank`、attach、再跳到目标 URL（attach 失败不影响导航）。顺带给 `network.body` 加了同样的自愈：它可能是一个标签页上的第一条 CDP 调用，现在会自己附着并在掉线时重挂一次，不再报 `Debugger is not attached`。
- 修复：`fetch.fulfill` 的 `Content-Length` 之前按 JS 字符数计算，含中文等多字节字符时会算小；现在按 UTF-8 字节（base64 body 按其解码后长度）计算，实测中文 JSON 报 `bodyBytes=28` 且页面收到的正文逐字节一致。
- 修复：**Fetch 的「只观察」模式（`hold: false`）从来没有放行过请求** —— 匹配的请求会被一直挂着，页面表现为卡死，与 `enable` 返回文案承诺的「只记录并放行」正好相反。现在在 `requestPaused` 的请求/响应两个阶段自动 `continue`（响应阶段优先 `continueResponse`，失败回落 `continueRequest`），认证挑战也自动以 `Default` 应答，不会把页面晾在弹窗上。验收脚本里加了这条回归项。
- 修复：`hook.install` / `hook.log` / `hook.restore` 会在页面里 eval，遇到暂停中的标签页会骑满整个命令超时；现在与 `eval` / `click` 等一样先被 `tab_paused` 结构化拒绝。
- 新增：`scripts/verify-reverse.mjs` —— 逆向能力验收脚本。自带本地夹具（页面 / JSON 接口 / 401 Basic 挑战 / 带 sourcemap 的 JS），**离线可跑**；它加载构建产物、对 10 个工具发真实调用，并用 dsh-tools 的校验器同时校验每次调用的入参与返回值 schema。用法：`node scripts/verify-reverse.mjs`（`--keep` 保留落盘产物）。
- 修复：**工具返回的数据根本到不了模型**。DSH 的工具结果**只把 `output.render` 生成的文本交给模型**（规范值只做 schema 校验，不投递），而这个插件的 render 从 v1.0.7 起一律只写摘要：`browser_read` 只回「547 chars」、`browser_snapshot` 只回元素个数却从不给 ref、`browser_network_log` 只回条数不给请求行、`browser_evaluate` 只给 300 字符……也就是说这些数据类工具在模型侧一直是「有数据但看不见」，`browser_read` 里那个 120,000 字符的正文上限从来没被用上。现在所有数据类工具（含新增的 12 个逆向工具）都在 render 里携带载荷并给出明确截断提示，`scripts/verify-reverse.mjs` 每次调用都会断言「render 里能看到载荷」，把这类回归钉死。
- 安全：桥的 HTTP 面 **`/api/command` 与 `/api/cleanup` 现在必须带 token**（`X-DSH-Token` 头或 `?token=`），并且**带浏览器 `Origin` 的请求只接受 `chrome-extension://` 来源**。以前本机任何进程、任何网页都能 POST 到 `127.0.0.1:<port>` 驱动你登录着的浏览器（本机 CSRF）。命令行调用方（curl / PowerShell / node fetch）不发 `Origin`，天然通过第二道闸。`scripts/verify-install.ps1` 的下发方式同步改成带 header，并新增一项「不带 token 应被拒」的验收。
- 版本：`extension/manifest.json` 与 `package.json` 均为 **1.0.9**。
- 文档：README / README.en 新增「接口分析 / JS 逆向」一节（工具表 + 典型工作流），`docs/BEHAVIOR.md` 新增「逆向能力的行为契约」，`llms.txt` 补齐工具清单。

## v1.0.8 (2026-09-12)

- 新增：**一键安装 + 安装自检**。
  - `scripts/install.ps1`：幂等完成「把插件装进 profile → 在 profile 用户层补丁写 `browser-bridge` 配置（含 `launch`）→ 生成「浏览器操作」模式 → 启动专属浏览器并打开 `chrome://extensions`」。补丁层是 `patchReload: live`，通常改完不用重启 dsh（实测例外：只改 `launch.*` 时未必重组进插件，见本版末尾两条修正）；也不覆盖用户的 `settings.yaml`。
  - `scripts/verify-install.ps1`：通过桥的 HTTP 面 `POST /api/command` 下发真实命令逐项验收 —— 桥在监听 / 扩展已连接 / 扩展版本 = 仓库版本 / `ping` / `tabs.list` / `eval` 里 `await` 400ms / 读当前页 / 模式与 `launch` 配置就位。
  - `scripts/start-browser.ps1` + `.cmd`：手动启动专属浏览器；`scripts/bootstrap-extension.ps1`：会话级 CDP 兜底装载；`scripts/reload-extension.ps1`：改过扩展代码后清 Service Worker 脚本缓存。
  - [`AGENTS.md`](AGENTS.md)：给 AI Agent 的安装 runbook —— 用户把仓库地址丢给 Agent，Agent 负责安装、把「开发者模式 + 加载已解压」那段发给用户、用户做完后跑自检并用自己的 `browser_*` 工具做一轮真实验证。
- 新增：`launch` 配置段 —— **专属浏览器环境自动拉起**。`browser_*` 调用发现桥上没有扩展连接时，插件按 `launch.profileDir` 拉起一个独立的 Chrome user-data-dir（`chromePath` 留空则按平台自动探测），并轮询等待扩展握手（`waitMs`，默认 25s）。这样 dsh 的调试器不会再去挤日常 Chrome —— 同一标签页只允许一个 debugger 客户端，Claude / ChatGPT / 录屏类扩展都在抢它，表现就是 `Cannot access a chrome-extension:// URL of different extension` 和随机掉线。
  - 合并并发：多个工具调用只会触发一次拉起；失败后 5s 内不重复 fork，避免每次调用都弹一个 Chrome。
  - `bootstrapScript`：握手超时后运行一次引导脚本（用 CDP `Extensions.loadUnpacked` 把未打包扩展装进该 profile）。Chrome 137+ 已移除 `--load-extension`，这是官方替代路径。
  - 不配 `launch`（或 `enabled: false`）时行为与之前完全一致，不会拉起任何东西。
- 修复（扩展）：`Runtime.evaluate` 的超时默认值。原来没传 `timeoutMs` 时 `Math.max(100, 0)` 会算出 **100ms**，导致任何超过 0.1 秒的求值（fetch、多步读取、await）都报 `eval timeout after 100ms` —— 与注释里写的「不传就走桥接的 60s 默认」不一致。现在不传即不设竞速计时器。
- 修复（扩展）：`chrome.debugger.onDetach` 原来是个空处理器，调试器被 DevTools / 其它扩展抢走或目标崩溃后，`attachedTabs` 仍以为自己挂着，之后该标签页每条命令都报 `Debugger is not attached to the tab with id: N`。现在 detach 即清除记录；`withCDP` 再对这类错误**重挂一次并重试**。
- 修复（`install.ps1`）：**重复运行会在第 1 步中断**（`Copy-Item : The process cannot access the file ...\lib\index.js because it is being used by another process`）。profile 的依赖写成 `link:<repo>` 时，`node_modules\@caob23\dsh-browser-control` 是指向本仓库的 junction，往里复制等于把仓库拷给自己，而 dsh 正加载着 `lib/index.js`。现在检测到 reparse point 且目标就是本仓库就跳过复制并打印原因；真实目录（脚本自己复制出来的）仍照旧刷新，`git pull` 后再跑一次照样生效。顺带把 `$DshHome\profiles\node_modules\...\dsh-agent-presets` 加进 standard 组装的查找路径（Desktop 安装里就在这儿，之前只找 npx 缓存，找不到就会静默跳过模式生成、留下旧人设）。
- 文档：`dsh-config/README.md` 补充 `launch` 段字段说明与专属环境搭建步骤。
- 修复：**「浏览器操作」模式的人设会谎报拉起行为**。`scripts/assets/persona.yml` 里原来无条件写着「工具报没有扩展连接时，插件会自动把它拉起来」，可用 `-DisableLaunch` 装的 profile 写的是 `launch.enabled: false` —— 插件根本不会拉起，模型于是卡在一个不会发生的等待上，最后自己去翻 Electron 的 `app.asar` 找启动方式（真实踩到：约 14 次工具调用里只有 3~4 次是必要的）。现在 `install.ps1` 按 `$DisableLaunch` 生成两种说法（开着时说会自动拉起、并给出「连着两次同一条错就是没生效」的判据；关着时说浏览器没开就跑脚本），两种都带上兜底命令的绝对路径（`{{REPO_DIR}}\scripts\start-browser.ps1`）、桥状态页和「`chrome://` 页面不能挂调试器」。占位符替换漏了会打 `[!]` 警告。
- 文档：**更正「补丁层改完不用重启 dsh」的说法**。实测（2026-09-13）只改 `launch.*` 时，运行中的 dsh 没有把它重组进插件配置：`enabled: false → true` 之后工具调用仍不拉起浏览器，`/api/status` 一直未连接，日志里连「拉起专属浏览器」那行都没有，**重启一次 dsh 即恢复正常**。`install.ps1` 的收尾提示、README / README.en 的「改了 launch 配置没生效？」一节、AGENTS.md 的故障表都按实测改了，并给出唯一判据：`launch.enabled: true` 且未连接时日志必然出现那行，没有就是配置没进到插件里。

## v1.0.7 (2026-09-04)

- 新增：`browser_console_log` — 抓取页面 console.log/info/warn/error/debug；可按 level + regex 过滤，可 `clear:true` 清空。CDP 域 `Runtime.enable` 已在 attach 时常驻，不再 lazy。
- 新增：`browser_network_log` — 抓取 HTTP 请求/响应完整生命周期（`requestWillBeSent` → `responseReceived` → `loadingFinished`/`loadingFailed`）。可按 methodPattern/urlPattern/status 过滤；`includeStatic:true` 包含图片/字体/样式/脚本（默认过滤掉）。`browser_network_clear` 单独清空。
- 新增：`browser_pdf` — 调用 `Page.printToPDF` 导出 PDF 到 `path`（绝对路径）或 shotsDir（默认）。可选 landscape / paperWidth / paperHeight / scale / pageRanges / printBackground。PDF 文字可选中可搜索，比 screenshot 更适合长文 article。
- 新增：`browser_emulate` — 切换视口到 `desktop` / `mobile-iphone-13` / `mobile-pixel-7` / `tablet-ipad` 预设，或自定义 width/height/deviceScaleFactor/isMobile/hasTouch/userAgent。`device:"reset"` 还原。
- 内部：extension/background.js 增强 `chrome.debugger.onEvent` 监听器同时处理 `Page.javascriptDialogOpening` + `Runtime.consoleAPICalled` + 4 个 `Network.*` 事件，按 `tabId` 隔离缓冲；attach 时常驻 `Runtime.enable` + `Network.enable`。
- 资源：每 tab console 缓冲上限 500 条，network 上限 500 条（LRU）；POST body 截断 64KB；请求过滤默认排除 `Image/Font/Stylesheet/Script/Favicon/Manifest`。
- 文档：README 工具清单加入 4 个新工具

## v1.0.6 (2026-09-03)

- 变更：`Config.enabled` schema 默认值从 `false` 改为 `true`，装上即默认启动桥接（issue #1 反馈：之前需要手动在 setting 文件加 `enabled: true` 才能用）
- 安全：`allowEval` 默认仍为 `false`，启用 eval 仍需显式配置
- 配套：CHANGELOG/README 同步更新启用行为说明

## v1.0.5 (2026-09-03)

- 修复：在新版 `@deepseek-ai/dsh-settings`（0.1.2-alpha.* 起）下插件加载失败（issue #1）
  - 原因：旧版源码对 dsh-settings 的 `installSettingsSection` 与 `settingsNamespace` 两个 helper 有静态 import；新版本里这两个 helper 已被改造成 `SettingsProvider.installSection` 方法 + 字符串字面量类型，对应能力保留但 helper 移除 → 旧插件 ESM 解析时找不到 export，整个插件加载 throw
  - 修复：绕开 helper，直接调底层 `sctx.settings.register(ns, schema, { base, validate })` API（该方法在 dsh-settings 所有发布版本上都存在），`BROWSER_BRIDGE_SETTINGS_NAMESPACE` 改为普通字符串字面量
  - 升级：`pnpm update @caob23/dsh-browser-control` 或重装 `@caob23/dsh-browser-control@^1.0.5`

## v1.0.4 (2026-08-23)

- 变更：许可证 MIT → **AGPL-3.0**。个人/学术/非商业免费；企业闭源商用需商业许可（联系：GitHub Issues 或 caob2333@outlook.com）
- 文档：SECURITY.md 允许非可利用问题直接提 Issue（中英双语）
- 文档：dsh-config/README.md 重写为配置项参考（patch 字段、默认值、用户层覆盖示例）
- 清理：移除 tests/、fixtures/ 与未使用的 icon-svg.ts；英文文档归档到 docs/en/
- 安装方式与 v1.0.3 一致：npm / GitHub / 本地 file: 三种来源

## v1.0.3 (2026-08-23)

- 新增：插件按 dsh Profile Bundle 规范打包，一条命令安装
  `dsh plugin --profile web add github:caob23/dsh-browser-control#v1.0.3`
  （npm 发布后也可 `dsh plugin --profile web add @caob23/dsh-browser-control`）
- 变更：npm 包名从 in-tree 的 `@deepseek-ai/dsh-browser-bridge` 改为用户 scope 的 `@caob23/dsh-browser-control`
- 变更：插件源码上移到仓库根，独立于 harness 工作区构建（tsc + tsdown），构建产物 `lib/` 随仓库提交，GitHub 安装零编译
- 旧「复制进 harness 源码树」方式保留在 v1.0.2 tag；迁移时删除旧副本避免 browser-bridge id 重复挂载

## v1.0.2 (2026-08-23)

16 项验收意见修复，另加饱和回归中新发现并修复的 10 个缺陷。

弹窗与交互：

- 新增 `dialog` 命令：全局自动应答策略（accept / dismiss / manual）读取与切换，含最近 50 条弹窗日志
- MV3 service worker 常驻监听 `Page.javascriptDialogOpening`，alert/confirm/prompt/beforeunload 全类型自动应答，prompt 支持自定义应答文本
- 连续链式弹窗（一次点击多个 prompt）逐个依次应答
- 输入新增 `mode:'type'` 真实键盘通道：逐字符 keyDown/keyUp，回车映射 Enter；默认 fill 模式保持直写

键盘与焦点健壮性：

- 键盘/鼠标事件前自动聚焦目标窗口并激活标签页；**绝不修改窗口尺寸、位置或状态**（含最大化状态），最小化窗口返回结构化 `window_minimized` 错误而非擅自还原
- 非 ASCII 字符（中文/emoji）改走 `Input.insertText` 真实插入通道，不再被协议损坏成 `?`
- 移除多余的 char 事件，修复 ASCII 字符被插入两次
- Enter 事件携带 `text:'\r'`，表单隐式提交恢复正常

求值与序列化：

- 页面导航中断求值时返回结构化 `context_destroyed` 错误（覆盖 -32000 "Inspected target navigated or closed" 变体），不再挂满超时
- 序列化重写为两步架构：先取 RemoteObject 元数据分类，再经 `callFunctionOn` 按值转移；DOM 节点、函数、Map/Set 等不可转移值诚实报错，杜绝静默 `{}`（新版 Chrome returnByValue 行为变更）
- `eval` 支持 `timeoutMs` 竞速超时，慢 Promise 不再拖满桥接默认 60s
- `eval` 支持 `frameSelector` 同源 iframe 求值，document/window 经参数影子化重绑定（修复 TDZ 报错）；`argNames`+`args` 参数化注入

导航与等待：

- 死站点导航返回结构化 `siteUnreachable:{reason:dns|unreachable}`，经页面内 location.href 探测 chrome-error 页，中英文错误文案均可分类
- 新增 `wait` 命令：selector / text / fn 三种条件 50ms 轮询等待，fn 同时接受谓词函数与布尔表达式，timeoutMs 上限 120s

工具输出：

- `click` 返回命中校验（hitVerified）、点击坐标、元素信息及连带应答的弹窗数
- `screenshot` 支持 selector 元素裁剪截图并返回 elementRect
- `tabs.list` 精简为紧凑结构（id/url/title/active 等）
- snapshot 增加 total 计数与每项 type/value/rect 字段

## v1.0.1 (2026-08-23)

- 修复：已连接时圆点显示为绿色呼吸动画（此前因 CSS 类名错位误显示红色）
- 新增：弹窗一键「断开连接」；断开后不再自动重连，点「立即连接」恢复
- 文档：新增鲸鱼插画横幅，README / CONTRIBUTING / SECURITY 中英双语（中文默认）
- 文档：版本号和 License 徽章改为动态读取，徽章换成经典塑料风格

## v1.0.0 (2026-08-22)

- 扩展、弹窗、状态页统一鲸鱼图标
- 状态页内嵌 SVG logo
- 持久 debugger 附着（控制期间 Chrome 横幅稳定显示）
- 配置简化为端口模式（替代完整 URL）
- 状态页暗色卡片样式 + 连接信息展示

## v0.2.0 (2026-08-22)

- 持久 debugger 附着
- 桥接端口配置输入
- 状态页美化
- 29/29 单元测试通过

## v0.1.0 (2026-08-22)

- 首个发布版本
