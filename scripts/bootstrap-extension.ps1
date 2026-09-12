<#
  DSH Browser Control —— 会话级兜底装载（用 CDP 把未打包扩展临时装进专属 profile）

  Chrome 137+ 移除了 --load-extension（152 上连
  --disable-features=DisableLoadExtensionCommandLineSwitch 也无效），
  可脚本化的替代是 CDP 的 Extensions.loadUnpacked。

  ⚠️ 它是**会话级**的：这样装进去的扩展在关掉该 Chrome 后就会从 profile 里消失。
     持久做法是在那个窗口里手动做一次（开发者模式 + 加载已解压的扩展程序）。
     本脚本用于「profile 里没有扩展、我又想马上用」的救急场景。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap-extension.ps1
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap-extension.ps1 -ProfileDir D:\dsh-browser-profile
#>
[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$ExtensionDir,
  [string]$ChromePath,
  [int]$DebugPort = 9333
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileDir) {
  $ProfileDir = if ($env:DSH_BROWSER_PROFILE) { $env:DSH_BROWSER_PROFILE } else { Join-Path $env:LOCALAPPDATA 'dsh-browser-profile' }
}
if (-not $ExtensionDir) { $ExtensionDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'extension' }
if (-not (Test-Path $ExtensionDir)) { throw "找不到扩展目录：$ExtensionDir" }

if (-not $ChromePath) {
  foreach ($c in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )) { if ($c -and (Test-Path $c)) { $ChromePath = $c; break } }
}
if (-not $ChromePath) { throw "找不到 Chrome —— 用 -ChromePath 指定" }

if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null }

Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" -and $_.CommandLine -notlike '*--type=*' } |
  ForEach-Object { Write-Host "关闭已有实例 PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force; Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 2

Start-Process -FilePath $ChromePath -ArgumentList @(
  "--user-data-dir=$ProfileDir",
  '--no-first-run',
  '--no-default-browser-check',
  "--remote-debugging-port=$DebugPort",
  '--enable-unsafe-extension-debugging',
  'chrome://extensions'
) | Out-Null

$ws = $null
for ($i = 0; $i -lt 30 -and -not $ws; $i++) {
  Start-Sleep -Milliseconds 700
  try { $ws = (Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 3).webSocketDebuggerUrl } catch { }
}
if (-not $ws) { throw "调试端口 $DebugPort 没起来，无法装入扩展" }

$client = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$client.ConnectAsync([Uri]$ws, $ct).Wait()

$payload = @{ id = 1; method = 'Extensions.loadUnpacked'; params = @{ path = $ExtensionDir } } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$client.SendAsync((New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)),
                  [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()

$buf = New-Object byte[] 65536
$recv = $client.ReceiveAsync((New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buf)), $ct).Result
$reply = [System.Text.Encoding]::UTF8.GetString($buf, 0, $recv.Count)
$client.Dispose()

$parsed = $reply | ConvertFrom-Json
if ($parsed.error) { throw "装入失败：$($parsed.error.message)" }
Write-Host "[OK] 扩展已装入，ID = $($parsed.result.id)" -ForegroundColor Green

Write-Host ""
Write-Host "[注意] 这样装入的扩展是【会话级】的：关掉这个 Chrome 后它就没了。" -ForegroundColor Yellow
Write-Host "       要永久留住它，在专属窗口里手动做一次（只需一次）：" -ForegroundColor Yellow
Write-Host "         chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → $ExtensionDir" -ForegroundColor Yellow
Write-Host "       本次实例保持运行（调试端口 $DebugPort，仅监听回环）。" -ForegroundColor Green
