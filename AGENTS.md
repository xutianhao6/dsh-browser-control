# 给 AI Agent 的安装 runbook

如果你的用户把本仓库交给你并说「帮我装好」，照这个文件做。**全程只需要用户手动操作一次**（三下点击），其余都能脚本化。

## 0. 前置检查

| 项 | 要求 |
|---|---|
| 平台 | Windows（脚本是 PowerShell） |
| dsh | 已安装，且 `%DSH_HOME%`（默认 `~/.dsh`）下已有 `profiles/web` |
| 浏览器 | Chrome 116+ |
| Node / pnpm | **不需要**（`lib/` 构建产物随仓库提交） |

`profiles/web` 不存在时，先让 dsh 生成它（跑一次 `dsh --profile web`，或 `dsh plugin --profile web add <包>`）。

## 1. 装（一条命令）

```powershell
powershell -ExecutionPolicy Bypass -File <仓库目录>\scripts\install.ps1
```

它做四件事（幂等，可重复跑）：

1. 把插件包装进 `~/.dsh/profiles/web`（`node_modules` + profile 的 `package.json`）；
2. 在 profile 的用户层补丁 `~/.dsh/profiles/web/cordis.patch.yml` 里写 `browser-bridge` 配置（含 `launch` 专属浏览器环境）。该层是 `patchReload: live`，**改完不用重启 dsh**；
3. 生成「浏览器操作」Agent preset 到 `~/.dsh/.agent-presets/browser/`（复制 dsh 随附的 `standard` 组装 + 换成浏览器人设）；
4. 启动专属浏览器并打开 `chrome://extensions`。

常用参数：`-ProfileDir`（专属 profile 路径）、`-LaunchUrls`（拉起时打开的页面）、`-SkipPreset`、`-SkipLaunch`、`-UseCli`（改用 `dsh plugin add`）、`-SessionLoad`（跳过手动部署，用 CDP 会话级装载）。

## 2. 把这段原样发给用户（唯一的手动步骤）

> 还差一步，需要你在刚弹出的那个 Chrome 窗口里手动做一次（只需一次）：
>
> 1. 地址栏输入 `chrome://extensions`
> 2. 打开右上角的「开发者模式」
> 3. 点「加载已解压的扩展程序」，选择：`<扩展目录的绝对路径>`
> 4. 确认卡片上的开关是打开的（工具栏会出现鲸鱼图标）
>
> 做完回我一句，我来验证。

要解释原因就说：Chrome 137+ 移除了命令行加载扩展的开关，而 CDP 装载是会话级的（关掉浏览器就没了）；只有在开发者模式下从扩展页加载，扩展才会持久留在那个 profile 里。

## 3. 自检

用户回复后跑：

```powershell
powershell -ExecutionPolicy Bypass -File <仓库目录>\scripts\verify-install.ps1
```

它会通过桥的 HTTP 面下发真实命令，逐项验收：桥在监听 → 扩展已连接 → **扩展版本 = 仓库版本** → `ping` → `tabs.list` → 打开验收标签页（`chrome://` 页面挂不上调试器）→ `eval` 里 `await` 400ms（旧版有 100ms 隐形超时，这一项会挂）→ `content` 读当前页 → 接口分析 / JS 逆向能力（`cdp` / `cookies.get` / `network.log` / `network.har` / `ws.log` / `scripts.list` / `debugger.state` / `fetch.list` / `hook.log`，以及「不带 token 应被拒」）→ 「浏览器操作」模式存在 → `launch` 配置就位。全绿退出码 0。

> 「不带 token 应被拒」失败 = 运行中的 dsh 还加载着旧版插件代码（桥的 token 门是 v1.0.9 新增的）。**重启一次 DSH Desktop** 即可；这一项故意做成失败而不是跳过，就是这个用途。

### 3b. 逆向能力的深度验收（可选但推荐）

```powershell
node <仓库目录>\scripts\verify-reverse.mjs
```

它自带本地夹具服务器（页面 / JSON 接口 / 401 Basic 挑战 / 带 sourcemap 的 JS），**离线可跑**，不需要外网站点。它加载构建产物、对 10 个逆向工具发真实调用，并用 dsh-tools 的校验器同时校验每次调用的入参 schema 与返回值 schema。前置：跑过 `npm run build`、桥在监听、扩展已连接。加 `--keep` 可保留落盘产物（HAR / 脚本 / sourcemap 树）人工检查。

失败时按脚本给出的提示处理，常见情况见下表。

## 4. 再用你自己的 browser_* 工具做一轮真实验证

自检脚本只证明「链路通」。真正的验收是**你自己动手**（这几步同时验证工具链）：

1. `browser_tabs` —— 确认能列出专属浏览器的标签页；
2. `browser_navigate` 打开一个页面（例如 `https://example.com`）；
3. `browser_snapshot` 拿到交互元素 ref，`browser_click` 点一下；
4. `browser_evaluate` 跑一个 >100ms 的 `await`（例如 `(async()=>{const t=Date.now();await new Promise(r=>setTimeout(r,400));return Date.now()-t})()`）；
5. `browser_read` 读出正文。

五步都过，就可以告诉用户装好了，并提示他：**新建会话时在模式选择器里选「浏览器操作」**（名单每次读取都重新扫文件系统，刷新 GUI 即可看到；preset 只能在空会话里切换）。

## 5. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `no browser extension connected`，但扩展明明装过 | 这个 profile 是 `-DisableLaunch` 装的（`launch.enabled: false`），或改了 `launch` 没进到运行中的插件里 | **先自己跑** `scripts\start-browser.ps1` 把专属环境拉起来，再复跑原命令；确认补丁层里 `launch.enabled: true`；改了配置仍不自动拉起就**重启一次 dsh**（实测 `patchReload: live` 未必把 `launch.*` 重组进插件） |
| `no browser extension connected` | 用户还没做第 2 步，或扩展被停用 | 让用户按第 2 步操作；确认扩展开关是开的 |
| `Cannot access a chrome-extension:// URL of different extension` | 同一个标签页有别的扩展在抢 `debugger`（Claude / ChatGPT / 录屏类） | 让用户在**日常** Chrome 里停用本扩展，只留专属环境里那一个 |
| `Debugger is not attached to the tab with id: N` | 调试器被抢走后扩展的内存状态过期 | 关掉专属浏览器重开；v1.0.8 起扩展会自愈 |
| 自检里「扩展版本 ≠ 仓库版本」 | Chrome 在用 Service Worker 缓存的旧脚本 | 跑 `scripts\reload-extension.ps1`，或在扩展页点一次「刷新」 |
| 桥连不上（`/api/status` 打不开） | dsh 没在运行，或插件没启用 | 启动 dsh；设置 → 插件 → DSH 浏览器控制 开启 |
| `profiles/web` 不存在 | dsh 还没初始化该 profile | 先跑一次 `dsh --profile web` |

**一条判断规则（省掉一半排查）**：`launch.enabled: true` 且扩展未连接时，任何 `browser_*` 调用**必然**在 dsh 日志里留下

```
[browser-bridge] browser-bridge: 没有扩展连接，拉起专属浏览器 <profileDir>
```

**日志里没有这行，就是配置没进到插件里**（去重启 dsh），不要往「扩展是不是没装」「profile 是不是错了」的方向查。日志：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`。

同理，**别把「浏览器没开」交还给用户**：专属环境是由脚本拉起的（`scripts\start-browser.ps1`，`launch.enabled: true` 时插件自己也会拉），你手上就有这条命令。「浏览器操作」模式的人设里已经写明这一点（含本仓库的绝对路径），照着做即可；只有「扩展没装 / 被停用」才轮到用户去点那三下。

## 6. 不要做

- **不要**用 `--load-extension`（Chrome 137+ 已移除），也不要加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 去救（实测无效）；
- **不要**去改 Chrome 的 `Secure Preferences` 打开开发者模式（带 HMAC 校验，改了会被重置甚至损坏配置）；
- **不要**把 cookie / 登录态从一个 profile 复制到另一个（登录请让用户自己扫码）；
- **不要**整体覆盖用户的 `~/.dsh/settings.yaml`（`install.ps1` 只写 profile 的补丁层，就是这个原因）；
- **不要**在用户没同意的情况下把 `launch.profileDir` 指到一个已有数据的目录（它会被当作 Chrome 用户目录使用）。
