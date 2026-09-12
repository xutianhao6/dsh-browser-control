<#
  DSH Browser Control —— 让 Chrome 重新读取扩展文件（改过 extension/ 之后跑一次）

  为什么需要它：改完 background.js / manifest.json 后，**光重启浏览器不够**。
  Chrome 把扩展 Service Worker 的脚本缓存在 <profile>\Default\Service Worker\，
  缓存没失效前它会一直喂旧脚本 —— 表现就是「磁盘上代码明明改了、行为还是旧的」，
  非常容易误判成改错了地方。

  它做的事：关掉专属浏览器 → 删除该 profile 的 Service Worker 缓存 → 结束。
  之后正常启动即可（start-browser.ps1，或直接调一个 browser_* 工具让插件自动拉起）。

  等价的手工做法：在扩展页点该扩展卡片上的「刷新」。

  普通用户用不到它；只有改扩展代码、或升级扩展版本后行为对不上时才需要。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\reload-extension.ps1
#>
[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$ExtensionDir
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileDir) {
  $ProfileDir = if ($env:DSH_BROWSER_PROFILE) { $env:DSH_BROWSER_PROFILE } else { Join-Path $env:LOCALAPPDATA 'dsh-browser-profile' }
}
if (-not $ExtensionDir) { $ExtensionDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'extension' }

if (-not (Test-Path $ProfileDir)) { throw "找不到 profile：$ProfileDir（还没装过专属环境？先跑 install.ps1）" }
if (-not (Test-Path $ExtensionDir)) { throw "找不到扩展目录：$ExtensionDir" }

Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" -and $_.CommandLine -notlike '*--type=*' } |
  ForEach-Object { Write-Host "关闭专属实例 PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

$sw = Join-Path $ProfileDir 'Default\Service Worker'
if (Test-Path $sw) {
  Remove-Item $sw -Recurse -Force
  Write-Host "[OK] 已清除 Service Worker 缓存：$sw" -ForegroundColor Green
} else {
  Write-Host "没有 Service Worker 缓存目录，无需清理" -ForegroundColor DarkGray
}

Write-Host "完成。接下来启动专属浏览器（scripts\start-browser.ps1，或直接调任意 browser_* 工具让插件自动拉起）。" -ForegroundColor Green
