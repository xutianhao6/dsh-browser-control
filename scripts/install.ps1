<#
  DSH Browser Control —— 一键安装器（幂等，可重复运行）

  做四件事：
    1. 把本仓库的插件包装进 dsh 的 web profile（node_modules + profile package.json）
    2. 在 profile 的用户层补丁里写 browser-bridge 配置（含 launch 专属浏览器环境）
       —— 该文件是 patchReload: live，改完不用重启 dsh
    3. 生成「浏览器操作」Agent preset（复制 dsh 随附的 standard 组装 + 换成浏览器人设）
    4. 启动专属浏览器并打开 chrome://extensions，打印需要用户手动做的部署步骤

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ProfileDir D:\dsh-browser-profile
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipPreset -SkipLaunch
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -UseCli     # 改用 dsh plugin add 安装

  装完请让用户完成部署（开发者模式 + 加载已解压的扩展程序），再跑 verify-install.ps1。
#>
[CmdletBinding()]
param(
  [string]$RepoDir,
  [string]$DshHome,
  [string]$ProfileName = 'web',
  [string]$ProfileDir,
  [string]$ChromePath,
  [string]$ExtensionDir,
  [int]$Port = 9777,
  [string]$Token = 'dsh-local',
  [string[]]$LaunchUrls = @(),
  [switch]$SkipPreset,
  [switch]$SkipLaunch,
  [switch]$UseCli,
  [switch]$SessionLoad
)

$ErrorActionPreference = 'Stop'

# ───────────────────────────────────────────────────────────── 小工具

function Step([string]$text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok([string]$text)   { Write-Host "    [OK] $text" -ForegroundColor Green }
function Info([string]$text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn([string]$text) { Write-Host "    [!] $text" -ForegroundColor Yellow }

function Find-Chrome([string]$Explicit) {
  if ($Explicit -and (Test-Path $Explicit)) { return $Explicit }
  foreach ($c in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Write-Text([string]$path, [string]$text) {
  $dir = Split-Path $path -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  # 不带 BOM 的 UTF-8：YAML/JSON 都吃得下，但 BOM 会让某些解析器别扭
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# ───────────────────────────────────────────────────────────── 定位路径

if (-not $RepoDir) { $RepoDir = Split-Path $PSScriptRoot -Parent }
if (-not (Test-Path (Join-Path $RepoDir 'package.json'))) { throw "RepoDir 不像本仓库：$RepoDir" }
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
if (-not $ExtensionDir) { $ExtensionDir = Join-Path $RepoDir 'extension' }
if (-not (Test-Path $ExtensionDir)) { throw "找不到扩展目录：$ExtensionDir" }

$profilePath = Join-Path $DshHome "profiles\$ProfileName"
if (-not (Test-Path $profilePath)) {
  throw @"
找不到 dsh 的 profile 目录：$profilePath
请先让 dsh 生成它（例如跑一次 `dsh --profile $ProfileName` 或 `dsh plugin --profile $ProfileName add <包>`），再运行本脚本。
"@
}

if (-not $ProfileDir) {
  # 优先沿用已配置的 profileDir（补丁层或 settings.yaml），避免在另一处又建一个环境
  $existing = $null
  $patchAt = Join-Path $profilePath 'cordis.patch.yml'
  if (Test-Path $patchAt) {
    $m = [regex]::Match((Get-Content $patchAt -Raw), "profileDir:\s*'([^']+)'")
    if ($m.Success) { $existing = $m.Groups[1].Value }
  }
  if (-not $existing) {
    $settingsAt = Join-Path $DshHome 'settings.yaml'
    if (Test-Path $settingsAt) {
      $m = [regex]::Match((Get-Content $settingsAt -Raw), "(?m)^\s*profileDir:\s*'([^']+)'")
      if ($m.Success) { $existing = $m.Groups[1].Value }
    }
  }
  if ($existing) { $ProfileDir = $existing }
  elseif ($env:DSH_BROWSER_PROFILE) { $ProfileDir = $env:DSH_BROWSER_PROFILE }
  else { $ProfileDir = Join-Path $env:LOCALAPPDATA 'dsh-browser-profile' }
}
$chrome = Find-Chrome $ChromePath

$repoPkg = Get-Content (Join-Path $RepoDir 'package.json') -Raw | ConvertFrom-Json
Write-Host "DSH Browser Control v$($repoPkg.version) 安装器" -ForegroundColor White
Info "仓库     : $RepoDir"
Info "DSH home : $DshHome"
Info "profile  : $profilePath"
Info "专属环境 : $ProfileDir"
Info "扩展目录 : $ExtensionDir"
if ($chrome) { Info "Chrome   : $chrome" } else { Warn "没找到 Chrome —— 拉起前需要用 -ChromePath 指定" }

# ───────────────────────────────────────────────── 1. 装插件包进 profile

Step "1/4 把插件装进 profile"
$pkgTarget = Join-Path $profilePath "node_modules\@caob23\dsh-browser-control"

if ($UseCli) {
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if (-not $dsh) { throw "-UseCli 需要 dsh 在 PATH 上" }
  Info "dsh plugin --profile $ProfileName add `"file:$RepoDir`""
  & $dsh.Source plugin --profile $ProfileName add "file:$RepoDir"
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）" }
  Ok "通过 dsh plugin 安装完成"
} else {
  New-Item -ItemType Directory -Force -Path $pkgTarget | Out-Null
  foreach ($item in @('lib', 'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'llms.txt', 'LICENSE')) {
    $src = Join-Path $RepoDir $item
    if (-not (Test-Path $src)) { continue }
    if ((Get-Item $src).PSIsContainer) { Copy-Item $src $pkgTarget -Recurse -Force }
    else { Copy-Item $src $pkgTarget -Force }
  }
  Ok "已复制到 $pkgTarget"
}

# profile 的 package.json：登记依赖 + bundle
$profilePkgPath = Join-Path $profilePath 'package.json'
$profilePkg = Get-Content $profilePkgPath -Raw | ConvertFrom-Json
$changed = $false
if (-not $profilePkg.dependencies) { $profilePkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force; $changed = $true }
if (-not $profilePkg.dependencies.PSObject.Properties['@caob23/dsh-browser-control']) {
  $profilePkg.dependencies | Add-Member -NotePropertyName '@caob23/dsh-browser-control' -NotePropertyValue "^$($repoPkg.version)" -Force
  $changed = $true
}
if (-not $profilePkg.dsh) { $profilePkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force; $changed = $true }
if (-not $profilePkg.dsh.profile) { $profilePkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force; $changed = $true }
$bundles = @($profilePkg.dsh.profile.bundles)
if ($bundles -notcontains '@caob23/dsh-browser-control') {
  $bundles += '@caob23/dsh-browser-control'
  $profilePkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  $changed = $true
}
if ($changed) {
  Write-Text $profilePkgPath ($profilePkg | ConvertTo-Json -Depth 10)
  Ok "已更新 profile/package.json（dependencies + dsh.profile.bundles）"
} else {
  Ok "profile/package.json 已登记，无需改动"
}

# ───────────────────────────────────────── 2. 写 launch 配置到补丁层

Step "2/4 写 browser-bridge 配置（用户层补丁，免重启生效）"
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$markerStart = '# >>> dsh-browser-control (managed by scripts/install.ps1) >>>'
$markerEnd = '# <<< dsh-browser-control (managed) <<<'

$urlLines = ''
foreach ($u in $LaunchUrls) { $urlLines += "`n            - '$u'" }
if (-not $urlLines) { $urlLines = ' []' }

$block = @"
$markerStart
- merge:
    - id: browser-bridge
      config:
        enabled: true
        port: $Port
        token: $Token
        launch:
          enabled: true
          chromePath: '$chrome'
          profileDir: '$ProfileDir'
          urls:$urlLines
          waitMs: 25000
$markerEnd
"@

$existing = if (Test-Path $patchPath) { Get-Content $patchPath -Raw } else { '' }
# 先移除本脚本上次写的块，保证反复运行不叠加
$body = [regex]::Replace($existing, "(?ms)^# >>> dsh-browser-control \(managed.*?^# <<< dsh-browser-control \(managed\) <<<\r?\n?", '')
# 空数组 `[]` 与被管理的列表冲突，去掉它
$body = ($body -split "`r?`n" | Where-Object { $_.Trim() -ne '[]' }) -join "`n"
if ($body.Trim().Length -gt 0 -and -not $body.EndsWith("`n")) { $body += "`n" }
$newPatch = ($body.TrimEnd() + "`n`n" + $block).TrimStart("`n")
Write-Text $patchPath $newPatch
Ok "写入 $patchPath"
Info "该层是 patchReload: live —— dsh 会热重组，不需要重启"

# ───────────────────────────────────────────── 3. 生成浏览器操作 preset

Step "3/4 生成「浏览器操作」模式（Agent preset）"
if ($SkipPreset) {
  Info "已按 -SkipPreset 跳过"
} else {
  $presetDir = Join-Path $DshHome '.agent-presets\browser'
  $shipped = $null
  $globs = @(
    (Join-Path $profilePath 'node_modules\@deepseek-ai\dsh-agent-presets\presets\standard\agent.cordis.yml'),
    (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx\*\node_modules\@deepseek-ai\dsh-agent-presets\presets\standard\agent.cordis.yml'),
    (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh-agent-presets\presets\standard\agent.cordis.yml')
  )
  foreach ($g in $globs) {
    $hit = Get-ChildItem $g -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $shipped = $hit.FullName; break }
  }

  if (-not $shipped) {
    Warn "找不到 dsh 随附的 standard preset 组装 —— 跳过模式生成"
    Info "手动做法见 README「浏览器操作模式」一节"
  } else {
    New-Item -ItemType Directory -Force -Path $presetDir | Out-Null
    Copy-Item $shipped (Join-Path $presetDir 'agent.cordis.yml') -Force
    Copy-Item (Join-Path $PSScriptRoot 'assets\preset.yml') (Join-Path $presetDir 'preset.yml') -Force

    # 资产文件开头的说明性注释是给人看的，不要拼进组装
    $personaLines = @(Get-Content (Join-Path $PSScriptRoot 'assets\persona.yml'))
    $start = 0
    while ($start -lt $personaLines.Count -and ($personaLines[$start].Trim() -eq '' -or $personaLines[$start].TrimStart().StartsWith('#'))) { $start++ }
    $persona = ($personaLines[$start..($personaLines.Count - 1)] -join "`n").TrimEnd()
    $composition = Get-Content (Join-Path $presetDir 'agent.cordis.yml') -Raw
    $pattern = '(?ms)^- id: persona\r?\n.*?(?=^- id: )'
    if ([regex]::IsMatch($composition, $pattern)) {
      $composition = [regex]::Replace($composition, $pattern, ($persona + "`n`n"), 1)
      Write-Text (Join-Path $presetDir 'agent.cordis.yml') $composition
      Ok "已生成 $presetDir（standard 组装 + 浏览器人设）"
    } else {
      Warn "复制来的组装里找不到 persona 段落，模式已生成但用的是原人设"
    }
  }
}

# ───────────────────────────────────────────────── 4. 启动专属浏览器

Step "4/4 启动专属浏览器"
if ($SkipLaunch) {
  Info "已按 -SkipLaunch 跳过"
} else {
  if ($SessionLoad) {
    Info "会话级装载模式：用 CDP 把扩展临时装进去（关掉浏览器就没了）"
    & (Join-Path $PSScriptRoot 'bootstrap-extension.ps1') -ProfileDir $ProfileDir -ExtensionDir $ExtensionDir -ChromePath $chrome
  } else {
    & (Join-Path $PSScriptRoot 'start-browser.ps1') -ProfileDir $ProfileDir -ChromePath $chrome -OpenExtensionsPage
  }
}

# ─────────────────────────────────────────────────────────── 收尾说明

$verify = "powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'verify-install.ps1')`""

Write-Host ""
Write-Host "================================================================" -ForegroundColor White
if ($SessionLoad) {
  Write-Host " 安装完成（会话级装载）。跑下面这条做自检：" -ForegroundColor Green
} else {
  Write-Host " 安装完成。还差用户手动做一次部署：" -ForegroundColor Green
  Write-Host ""
  Write-Host "   1) 在刚打开的 Chrome 窗口里进入 chrome://extensions" -ForegroundColor White
  Write-Host "   2) 打开右上角的「开发者模式」" -ForegroundColor White
  Write-Host "   3) 点「加载已解压的扩展程序」，选择：" -ForegroundColor White
  Write-Host "      $ExtensionDir" -ForegroundColor Yellow
  Write-Host "   4) 确认卡片上的开关是打开的（工具栏会出现鲸鱼图标）" -ForegroundColor White
  Write-Host ""
  Write-Host "   （Chrome 只在开发者模式开启时持久化未打包扩展；这一步只需做一次）" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host " 自检：$verify" -ForegroundColor White
Write-Host "================================================================" -ForegroundColor White
