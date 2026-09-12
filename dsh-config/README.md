# dsh 配置参考

安装方式见 [README](../README.md)。本文只说明插件的配置项含义，供需要自定义默认值的用户参考。

## cordis.patch.yml 字段

插件包根目录的 `cordis.patch.yml` 声明默认配置：

```yaml
- insert:
    - id: browser-bridge
      name: '@caob23/dsh-browser-control'
      config:
        enabled: false
        port: 9777
        token: dsh-local
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `id` | `browser-bridge` | 插件实例 ID，勿改 |
| `name` | `@caob23/dsh-browser-control` | npm 包名，即 Loader 的解析目标 |
| `config.enabled` | `false` | 默认关闭，在 dsh 设置 → 插件 → DSH 浏览器控制 手动开启 |
| `config.port` | `9777` | 本地桥接服务端口（127.0.0.1，仅监听回环） |
| `config.token` | `dsh-local` | 扩展与桥接的握手令牌；多用户环境建议改掉 |
| `config.launch` | 见下 | 专属浏览器环境：没连接时自动拉起哪个 profile |

## 专属浏览器环境（`config.launch`）

Chrome **同一个标签页同一时刻只允许一个 debugger 客户端**。日常 profile 里只要还有别的
`debugger` 扩展（Claude / ChatGPT / 录屏类），dsh 的扩展就会被抢，表现为
`Cannot access a chrome-extension:// URL of different extension`、随机掉线、
`Debugger is not attached to the tab with id: N`。给 dsh 一个**独占的 user-data-dir** 是根治办法。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `launch.enabled` | `false` | 关掉时行为与旧版完全一致，不会拉起任何进程 |
| `launch.chromePath` | `''` | Chrome 可执行文件；留空按平台探测常见路径 |
| `launch.profileDir` | `''` | 专属环境的 user-data-dir（`enabled` 为真时必填） |
| `launch.urls` | `[]` | 拉起时打开的页面 |
| `launch.extraArgs` | `[]` | 追加的 Chrome 开关 |
| `launch.waitMs` | `25000` | 每次拉起后等待扩展握手的时长 |
| `launch.bootstrapScript` | `''` | 握手超时后运行一次的引导脚本（装入未打包扩展） |

行为：任一 `browser_*` 工具发现桥上没有扩展连接 → 拉起 `profileDir` → 轮询等握手 →
（超时才）跑一次 `bootstrapScript` → 继续原命令。并发调用合并为一次拉起，失败后 5 秒内不重复 fork。

用户层示例：

```yaml
- merge:
    - id: browser-bridge
      config:
        launch:
          enabled: true
          profileDir: 'D:\dsh-browser-profile'
          chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
          urls: ['https://www.xiaohongshu.com/']
          bootstrapScript: 'C:\Users\me\.dsh\browser-env\bootstrap-extension.ps1'
```

### 首次搭建专属环境

1. **在专属窗口里从 UI 加载扩展（一次性，也是唯一持久的方式）**：
   打开 `chrome://extensions` → 右上角打开**开发者模式** → 「加载已解压的扩展程序」→ 选
   `D:\dsh-browser\extension`。Chrome 只在开发者模式开启时持久化未打包扩展；之后每次启动
   专属 profile 都会自动带上它。
2. **不要指望 `--load-extension`**：Chrome 137+ 已移除该开关（实测 152 上
   `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效）。CDP 的
   `Extensions.loadUnpacked` 是可脚本化的替代，但它装进去的扩展是**会话级**的 ——
   关掉该浏览器后就从 profile 里消失（实测：装完有 `location: 4` 记录，重启后连同扩展一起没了）。
   因此 `launch.bootstrapScript` 只当**救急兜底**用，不能替代第 1 步。
3. 扩展目录是**未打包加载**的：移动 / 改名 / 删除后 Chrome 会静默丢掉它，需要重新加载。
4. 改过 `extension/` 里的文件后，**光重启浏览器不够**：Chrome 会把扩展 Service Worker 的
   脚本缓存留在 `<profile>\Default\Service Worker\ScriptCache`，缓存没失效前一直喂旧脚本，
   表现为「磁盘上代码改了、行为没变」。在扩展页点一次「刷新」，或清掉该缓存目录后冷启
   （本机脚本：`C:\Users\<你>\.dsh\browser-env\reload-dsh-extension.ps1`）。
5. 关掉日常 profile 里的同一个扩展，否则两个实例会轮流抢占桥接连接 —— 桥同一时刻只接受
   一个客户端，表现为 `connectedAt` 反复刷新、状态页时不时显示未连接。

## 覆盖默认值

不想改包内文件的话，在你的 profile 用户层（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`）里写一条补丁覆盖 `browser-bridge` 的 config 即可，例如改端口：

```yaml
- merge:
    - id: browser-bridge
      config:
        port: 8888
```

## 状态页

桥接启动后可访问 `http://127.0.0.1:9777/` 查看连接状态；扩展工具栏图标绿点呼吸 = 已连接。
