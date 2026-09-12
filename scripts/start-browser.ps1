<#
  DSH Browser Control —— 启动「专属浏览器环境」

  专属环境是一个独立的 Chrome user-data-dir（默认 %LOCALAPPDATA%\dsh-browser-profile），
  里面只装 DSH Browser Control 扩展。Chrome 同一个标签页只允许一个 debugger 客户端，
  所以把 dsh 的调试器隔离在一个干净 profile 里，它就不会和日常 Chrome 里的
  Claude / ChatGPT / 录屏类扩展互相抢。

  用法：
    .\start-browser.ps1                          # 用默认 profile 打开
    .\start-browser.ps1 -Urls https://example.com
    .\start-browser.ps1 -OpenExtensionsPage      # 顺便打开 chrome://extensions（部署用）

  已在运行就只提示、不重复开（Chrome 对同一 user-data-dir 是单例的）。
#>
[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$ChromePath,
  [string[]]$Urls = @(),
  [switch]$OpenExtensionsPage
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileDir) {
  $ProfileDir = if ($env:DSH_BROWSER_PROFILE) { $env:DSH_BROWSER_PROFILE } else { Join-Path $env:LOCALAPPDATA 'dsh-browser-profile' }
}

function Find-Chrome([string]$Explicit) {
  if ($Explicit -and (Test-Path $Explicit)) { return $Explicit }
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  throw "找不到 Chrome —— 用 -ChromePath 指定 chrome.exe 的路径。"
}

$running = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" -and $_.CommandLine -notlike '*--type=*' }
if ($running) {
  Write-Host "[OK] 专属浏览器已在运行 (PID $($running.ProcessId -join ','))" -ForegroundColor Green
  Write-Host "     profile: $ProfileDir"
  exit 0
}

$chrome = Find-Chrome $ChromePath
if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null }

$targets = @()
if ($OpenExtensionsPage) { $targets += 'chrome://extensions' }
$targets += $Urls

Start-Process -FilePath $chrome -ArgumentList (@(
  "--user-data-dir=$ProfileDir",
  '--no-first-run',
  '--no-default-browser-check'
) + $targets)

Write-Host "[OK] 已启动专属浏览器" -ForegroundColor Green
Write-Host "     chrome : $chrome"
Write-Host "     profile: $ProfileDir"
