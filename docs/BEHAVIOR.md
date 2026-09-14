# 行为契约（Behavior Contract）

Agent 和上层脚本可以依赖的确定性语义。违反这些契约视为 bug。

## 窗口几何不可侵犯

- 自动化**绝不**修改窗口尺寸、位置或状态（最大化/还原/最小化一律不动）。真实输入所需的窗口聚焦（`focused: true`）与标签页激活不改变任何几何属性。
- 浏览器窗口处于**最小化**状态时，视口为 0×0，真实键鼠事件无法送达。此时 `type` 模式 / `press` / `click` 返回结构化错误 `window_minimized`，提示用户手动还原窗口——绝不自动还原（自动还原会把最大化窗口压成小窗）。
- `fill` 模式、`eval`、`content`、`wait` 不需要窗口前台，最小化下照常工作。

## 自动等待

- `browser_navigate` / `tabs.open` 等待 `document.readyState === 'complete'`（上限 15s，`timeoutMs` 可调）后才返回。
- **不保证** SPA 路由或懒渲染内容就绪——导航返回后再用 `browser_wait` 显式等目标元素。

## 原生弹窗（alert / confirm / prompt）

- v1.0.2+ 默认策略 `accept`：弹窗打开即自动按 OK，prompt 以 `defaultPrompt` 作为输入。
- 每次点击/输入结果带 `dialogsAnswered`（近 5 秒内该标签页被应答的弹窗数），可据此断言弹窗出现过。
- 全局策略可通过 `dialog` 命令改为 `dismiss` 或 `manual`；`manual` 下弹窗会阻塞页面线程直到工具超时。
- 近 10 条弹窗记录（类型、文本、应答方式）通过 `dialog {action:'get'}` 读取。

## 输入模式

- `browser_type` 默认 `fill`：直接设值 + input/change 事件。快，但绕过按键级逻辑。
- `mode: "type"`：逐字符真实键盘事件（keyDown→char→keyUp）。用于 React 受控组件、带联想状态的搜索框、反爬表单。速度约每字符一次 CDP 往返，长文本慎用。
- 合成赋值对百度/B站搜索框无效是已知案例（DOM 值正确但组件状态未同步）——这类站点用 `type` 模式。

## evaluate

- 返回值经 CDP `returnByValue` 序列化；不可序列化对象（DOM 节点、函数、代理）返回 `[type: not serializable — …]` 占位串而非空 `{}`。
- 页面在 Promise 挂起期间跳转 → 结构化错误 `context_destroyed: page navigated while evaluate was pending`，不会耗尽整个超时预算。
- `frameSelector` 参数支持同源 iframe（contentDocument 穿透）；跨源帧明确报错，不做静默降级。

## 截图与坐标

- 视口截图坐标为 CSS 像素；元素截图用 CDP `clip`，DPR 由 Chrome 内部处理，无需外部换算。
- 点击结果包含实际命中点 `clicked.x/y` 与 `hitVerified`（命中元素是否等于目标元素）。`hitVerified: false` 时附 `hitInstead` 字段指明实际命中的元素——典型场景是 sticky 头部/广告遮挡。

## 超时

- 所有涉及页面交互的命令接受 `timeoutMs`（毫秒）：navigate/tabs.open 默认 15000，wait 默认 15000 上限 120000，evaluate 默认 60000（桥接层上限 300000）。

## 后台标签页节流

Chrome 对非前台标签页的 `setTimeout` 强制钳制到 ≥1s。长任务注入在后台标签会显著变慢甚至超时——需要精确计时的注入先 `browser_tabs activate` 切到前台。

## 死站点检测

导航落到 `chrome-error://` 时，`browser_navigate` 结果携带 `siteUnreachable: {reason}`（dns/unreachable），且 `url` 回报为请求的目标 URL 而非内部协议地址。

## 逆向能力的行为契约（v1.0.9）

接口分析 / JS 逆向这套工具（`cdp` / `cookies.*` / `bodies.policy` / `targets.*` / `network.body|har|replay` / `ws.log` / `scripts.*` / `debugger.*` / `fetch.*` / `hook.*`）的确定语义：

- **模型只看到 `render` 文本**：DSH 的工具结果只把 `output.render` 生成的文本交给模型，规范值仅用于 schema 校验、不单独投递。所以每个数据类工具的 render 都必须携带载荷（页面正文 / 元素 ref / 请求行 / 脚本源码 / 调用帧 / 响应体），超长时给出明确的截断提示；`scripts/verify-reverse.mjs` 每次工具调用都会断言这一点。改工具时**只改 render 文案而丢掉载荷**＝该工具对模型失效。

- **响应体是「有就拿、没有就说没有」**。`network.body` 只在渲染进程还持有该响应体时取得到；取不到时返回 `unavailable: true` **加** `error`（`Network.getResponseBody` 的原话，如没有该资源标识），**绝不返回空串冒充内容**。单条超过 8 MiB 返回 `truncated: true` + `error`（`browser_network_body` 上表现为 `error` 字段），也不回半截。想要稳定拿到 body，就让 `bodies.policy` 在请求结束时先缓存。
- **`bodies.policy` 默认 `xhr`**：`off` 不自动缓存，`xhr` 只缓存 `resourceType` 为 `XHR` / `Fetch` 的响应，`all` 连文档 / 脚本 / 图片一起缓存。自动缓存发生在 `loadingFinished`（渲染进程一放手就没了，只能那时抓），按 `encodedDataLength` 判断，**单条超过 1MB 直接跳过**。`network.log` 的 `includeBodies`（默认 20 条、上限 100）读的是同一份缓存。
- **网络日志的行结构是稳定的**：每条带 `requestId`（`network.body` / `network.replay` 的句柄）、`bodyCached`（响应体是否已缓存），以及 `*ExtraInfo` 事件到达后的 `extraRequestHeaders` / `extraResponseHeaders`（真实的 `Cookie` / `Authorization` / `Set-Cookie`）。`requestWillBeSent` 自己的 `headers` 里没有 Cookie，这是 Chrome 的行为，不是抓漏了。HAR 的每条 entry 也带 **`_requestId`**（`_` 前缀是 HAR 自定义字段惯例），把它回灌 `network.body` / `network.replay` 就能取到同一请求；`bodyCached` 只有 `network.log` 的行有。
- **标签页暂停时，DOM/JS 命令拒绝执行**：`eval` / `content` / `find` / `click` / `input` / `press` / `scroll` / `snapshot` / `wait` / `nav` / `hook.install` / `hook.log` / `hook.restore`（即 `browser_evaluate` / `browser_read` / `browser_click` / `browser_type` / `browser_press` / `browser_scroll` / `browser_snapshot` / `browser_navigate` / `browser_hook` 以及 `network.replay`）一律**立即失败**，扩展侧错误码 `tab_paused`，报文是固定措辞的说明（`tab N is paused at a breakpoint (…) at <url>:<line> — resume it first (debugger.resume) …`）。意图是不让 `Runtime.evaluate` 打在一个暂停的渲染进程上把整个命令超时耗满。`debugger.*`、`screenshot`、`network.log`、`console.log` 照常可用；恢复用 `debugger` 的 `resume`。
- **`Fetch.enable` 处于 hold（默认）时，匹配的请求真的会停住**，直到 `fetch.continue` / `fetch.fulfill` / `fetch.fail` 送达，或 `fetch.disable` 一次性放行（返回释放条数）。页面在等待期间看起来是卡死的。对不在挂起表里的 `requestId`，`continue` / `fulfill` / `fail` 直接报错，不会静默放行。**`hold: false` 是只观察模式**：匹配的请求会被记录后立刻放行（响应阶段同样自动放行；认证挑战自动以 `Default` 应答），页面不会因为「只是看看」而卡住。
- **认证挑战是两步**：`Fetch.authRequired` 只在 401 响应回来之后产生，所以 `hold: true` 时要先 `fetch.continue` 放行请求，挑战才会出现，再用 `fetch.auth` 应答；带凭据的重试会再次命中拦截模式，需要再放行一次。`fetch()` 拿到的 401 只是普通响应、不会触发挑战，要观察挑战得走顶层导航。
- **重放发生在页面上下文**：`network.replay` 由页面自己发 `fetch`（`credentials: 'include'`），同源请求的 cookie / Origin / CORS 语义与原始调用**完全一致**；跨源只在站点自身被允许的范围内成功（对方没给 CORS 头就照原样失败）。HTTP/2 伪头与 `content-length` / `host` / `connection` / `cookie` / `origin` / `referer` / `accept-encoding` 会被剔除（除非调用方显式覆盖），避免重放死在 `Invalid name`。响应体超过 512 KB 只回截断预览。
- **落盘产物统一在 shotsDir 下**：`har/`（HAR 1.2）、`scripts/`（脚本 dump + `manifest.json`）、`sourcemaps/`（还原出的源码树 + `_sourcemap.json`），单个脚本落盘上限 24 MiB。`browser_cleanup` 会一并清掉：shotsDir 顶层的文件（截图、PDF）、这三棵产物树（整棵递归删）、`__` 前缀的临时文件；**其它顶层子目录不动**。它只接受纯目录名，含 `/`、`\`、`.`、`..` 的目标一律跳过，返回值里用 `subdirsRemoved` 报告实际删掉了几棵树。
- **`sourcemap` 不伪造源码**：只有 `.map` 里真的带 `sourcesContent` 的条目才会写出文件，其余记 `missing`；`.map` 本身取不到时返回 `error`（附 `mapUrl`），不会写出空文件冒充还原结果。
- **抓包窗口从 attach 那一刻开始**：`Network.*` 事件只在扩展持有该标签页的调试器附着时才产生，附着之前发生的请求不在缓冲区里。`nav` 与 `tabs.open` 因此**先挂调试器再导航**（`tabs.open` 先开 `about:blank`、attach、再跳到目标 URL），整段加载连同文档请求都会被捕获。用户手动打开的标签页只能从扩展第一次附着（通常是 `eval` / `content` / `scripts.*` 等任意 CDP 命令）之后开始记；要完整抓一次加载，用 `browser_navigate`。
- **按需取体自带自愈**：`network.body` 可能是一个标签页上的第一条 CDP 调用，它会自己完成附着（失败还会重挂一次重试），不会出现 `Debugger is not attached`；真正的错误（例如 requestId 不存在）如实返回 Chrome 原文 `No resource with given identifier found`，并附 `unavailable: true`。
- **`cdp` 的域边界**：`chrome.debugger` 客户端拿不到浏览器级域 —— `Browser.*`（如 `Browser.getVersion`）返回 `-32601 ... wasn't found`，`Target.getTargets` 返回 `-32000 Not allowed`，这是 Chrome 的限制、不是封装缺失。`Network.*` / `Storage.*` / `DOM.*` / `Runtime.*` / `Debugger.*` / `Fetch.*` / `Emulation.*` 以及 `Target.setAutoAttach` 均可用（实测 `Target.setAutoAttach` 允许，返回成功）。
- **发现 target 只能靠 `targets.list` + auto-attach**：**页面的专用 Worker（含 blob worker）完全不出现在 `chrome.debugger.getTargets()` 里**，`targets.list` 的静态部分也列不到它 —— 必须先 `targets.autoattach`（即 `browser_targets {autoAttach: true}`，底层 `Target.setAutoAttach {autoAttach, waitForDebuggerOnStart, flatten: true}`），Chrome 才会以 `Target.attachedToTarget` 把它报出来，此时它带 `source: 'Target auto-attach'`、`attached: true` 与 `sessionId`；静态列表里的行 `source` 是 `chrome.debugger.getTargets`。`autoAttach:false` 会关掉并把该标签页已登记的 target 清空。拿到 `targetId` 后交给 `cdp {targetId}` 就能在该 target 上 `Runtime.evaluate` / `Debugger.enable` / 热改代码；`targets.list` 的 `tabId`/`type` 过滤对 auto-attach 报出来的 target 也生效。
