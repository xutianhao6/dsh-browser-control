<#
  DSH Browser Control —— 安装自检

  装完（并且用户做完「开发者模式 + 加载已解压的扩展程序」）之后跑这个脚本。
  它通过桥的 HTTP 面 http://127.0.0.1:<port>/api/command 下发真实命令，逐项验收：

    1. 桥在监听
    2. 扩展已连上，且版本与仓库里的扩展 manifest 一致（证明加载的是这份代码）
    3. ping 往返正常
    4. tabs.list 能拿到标签页
    5. eval 里 await 400ms 能成功 —— 旧代码有 100ms 隐形超时，这一项会挂
    6. content 能读到当前页标题

  全绿则退出码 0；任何一项失败退出码 1，并打印对应修法。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\verify-install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\verify-install.ps1 -Port 9777 -WaitSeconds 40
#>
[CmdletBinding()]
param(
  [int]$Port = 9777,
  [string]$RepoDir,
  [string]$DshHome,
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Continue'
$failed = 0

function Check([string]$name, [scriptblock]$test) {
  try {
    $detail = & $test
    Write-Host "  [PASS] $name" -ForegroundColor Green
    if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
  } catch {
    Write-Host "  [FAIL] $name" -ForegroundColor Red
    Write-Host "         $($_.Exception.Message)" -ForegroundColor Red
    $script:failed++
  }
}

function Info([string]$text) { Write-Host "  $text" -ForegroundColor DarkGray }

if (-not $RepoDir) { $RepoDir = Split-Path $PSScriptRoot -Parent }
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }

$base = "http://127.0.0.1:$Port"
$expectedExtVersion = $null
$manifestPath = Join-Path $RepoDir 'extension\manifest.json'
if (Test-Path $manifestPath) { $expectedExtVersion = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version }

Write-Host "DSH Browser Control 安装自检（端口 $Port）" -ForegroundColor White

function Invoke-Command2([string]$command, $params, [int]$timeoutSec = 60) {
  $body = @{ command = $command; params = $params } | ConvertTo-Json -Compress -Depth 8
  return Invoke-RestMethod -Uri "$base/api/command" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $timeoutSec
}

# ── 1. 等桥起来 ────────────────────────────────────────────────────────────
Write-Host "`n[1] 桥接服务" -ForegroundColor Cyan
$status = $null
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  try { $status = Invoke-RestMethod -Uri "$base/api/status" -TimeoutSec 3; break } catch { Start-Sleep -Milliseconds 500 }
}

Check "桥在监听 $base" {
  if (-not $status) { throw "连不上 —— dsh 没在运行，或插件没启用（设置 → 插件 → DSH 浏览器控制）" }
  "listening=$($status.listening) port=$($status.port)"
}

Check "扩展已连接" {
  if (-not $status) { throw "桥没起来，先解决上一项" }
  if (-not $status.extensionConnected) {
    throw "没有扩展连接。让用户在那个专属 Chrome 窗口里完成部署：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 $RepoDir\extension"
  }
  "client=$($status.hello.client) browser=$($status.hello.browser.name) $($status.hello.browser.version)"
}

Check "扩展版本 = 仓库版本" {
  if (-not $status -or -not $status.extensionConnected) { throw "扩展没连上，跳过" }
  if ($expectedExtVersion -and $status.hello.version -ne $expectedExtVersion) {
    throw "桥上是 v$($status.hello.version)，仓库是 v$expectedExtVersion —— Chrome 在用缓存的旧脚本，跑 scripts/reload-extension.ps1 或在扩展页点一次「刷新」"
  }
  "v$($status.hello.version)"
}

# ── 2. 真实命令往返 ────────────────────────────────────────────────────────
Write-Host "`n[2] 端到端命令" -ForegroundColor Cyan

Check "ping" {
  $r = Invoke-Command2 'ping' @{} 15
  if (-not $r.ok) { throw $r.error }
  "pong t=$($r.result.t)"
}

Check "tabs.list" {
  $r = Invoke-Command2 'tabs.list' @{} 20
  if (-not $r.ok) { throw $r.error }
  $n = @($r.result.tabs).Count
  if ($n -eq 0) { throw "连上了但一个标签页都没有" }
  "$n 个标签页，active=$($r.result.activeTabId)"
}

Check "eval 里 await 400ms（旧版 100ms 超时会挂在这）" {
  $expr = "(async () => { const t = Date.now(); await new Promise(r => setTimeout(r, 400)); return Date.now() - t; })()"
  $r = Invoke-Command2 'eval' @{ expression = $expr } 30
  if (-not $r.ok) { throw $r.error }
  $ms = [int]$r.result.value
  if ($ms -lt 350) { throw "只过了 ${ms}ms，计时器似乎没等满" }
  "slept ${ms}ms"
}

Check "content 读当前页" {
  $r = Invoke-Command2 'content' @{ mode = 'text' } 30
  if (-not $r.ok) { throw $r.error }
  $title = $r.result.title
  $len = "$($r.result.content)".Length
  "$title（$len 字符）url=$($r.result.url)"
}

# ── 3. 安装物检查 ──────────────────────────────────────────────────────────
Write-Host "`n[3] 安装物" -ForegroundColor Cyan

Check "「浏览器操作」模式存在" {
  $dir = Join-Path $DshHome '.agent-presets\browser'
  $p = Join-Path $dir 'agent.cordis.yml'
  if (-not (Test-Path $p)) { throw "缺 $p —— 跑一次 install.ps1（不加 -SkipPreset）" }
  $name = '(无 preset.yml)'
  $meta = Join-Path $dir 'preset.yml'
  if (Test-Path $meta) {
    foreach ($line in Get-Content $meta) { if ($line -match '^name:\s*(.+)$') { $name = $Matches[1].Trim(); break } }
  }
  $rows = @(Get-Content $p | Where-Object { $_ -match '^- id:\s*\S' }).Count
  "显示名：$name，组装行数：$rows"
}

Check "launch 配置已写进 profile 补丁层" {
  $profiles = Get-ChildItem (Join-Path $DshHome 'profiles') -Directory -ErrorAction SilentlyContinue
  $hit = $null
  foreach ($p in $profiles) {
    $f = Join-Path $p.FullName 'cordis.patch.yml'
    if ((Test-Path $f) -and ((Get-Content $f -Raw) -match 'dsh-browser-control')) { $hit = $f; break }
  }
  if (-not $hit) { throw "没找到含 dsh-browser-control 的 profile 补丁层 —— 跑一次 install.ps1" }
  $dir = [regex]::Match((Get-Content $hit -Raw), "profileDir:\s*'([^']+)'").Groups[1].Value
  "profileDir = $dir"
}

Write-Host ""
if ($failed -eq 0) {
  Write-Host "全部通过 ✅ 安装可以用了。" -ForegroundColor Green
  exit 0
}
Write-Host "$failed 项未通过 ❌ 按上面的提示逐条修。" -ForegroundColor Red
exit 1
