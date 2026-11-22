# =============================================================================
# 用户自己打 APK（本机已有仓库）。缺任意一个必填参数就报错退出，不开始打包。
#
# 必填：-ApiBase -AppName -PackageName
# 可选：-Icon（不填、"" 或只有空格时用仓库默认图标）
#       -ExpoToken（不填则检查本机登录；未登录会打开浏览器，成功后记住）
#       -sw（退出当前账号，清空旧 projectId，再登录新账号）
#       -Profile production|preview|store（默认 production）
#
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 `
#     -ApiBase http://服务器IP/api `
#     -AppName "我的应用" `
#     -PackageName com.example.app `
#     -Icon D:\logo.png `
#     -ExpoToken "expo access token"
#
# 换账号（仍要带上面的必填参数；浏览器里登录新账号）：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -sw `
#     -ApiBase http://服务器IP/api -AppName "我的应用" -PackageName com.example.app
# =============================================================================

param(
  [ValidateSet("build", "update", "web", "login")]
  [string]$Action = "build",

  [ValidateSet("production", "preview", "store")]
  [string]$Profile = "production",

  [string]$ApiBase = "",
  [string]$WebApiBase = "",
  [string]$AppName = "",
  [string]$PackageName = "",
  [string]$Icon = "",
  [string]$ExpoToken = "",
  [string]$Message = "",

  [switch]$sw,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$global:MobileYes = $true
if ($Yes) { $global:MobileYes = $true }

function Show-SelfBuildUsage {
  Write-Host "示例（图标可不填，用默认）：" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 ``"
  Write-Host "    -ApiBase http://服务器IP/api ``"
  Write-Host "    -AppName `"我的应用`" ``"
  Write-Host "    -PackageName com.example.app ``"
  Write-Host "    -Icon D:\logo.png ``"
  Write-Host "    -ExpoToken `"在 expo.dev 创建的 Access Token`""
  Write-Host "换账号时在命令最前面加 -sw，浏览器里登录新账号。"
}

function Test-SelfBuildParams {
  $missing = @()
  if (-not $ApiBase -or -not $ApiBase.Trim()) { $missing += "-ApiBase      接口地址，例 http://服务器IP/api" }
  if (-not $AppName -or -not $AppName.Trim()) { $missing += "-AppName      应用名（桌面显示）" }
  if (-not $PackageName -or -not $PackageName.Trim()) { $missing += "-PackageName  安卓包名，例 com.example.app" }
  if ($missing.Count -gt 0) {
    Write-Host "用户自己打包缺少参数，已停止：" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  $m" -ForegroundColor Red }
    Write-Host ""
    Show-SelfBuildUsage
    exit 1
  }

  $pkg = $PackageName.Trim()
  if ($pkg -notmatch '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$') {
    Write-Host "包名格式不对: $pkg" -ForegroundColor Red
    Write-Host "须类似 com.example.app（至少两段，字母开头）" -ForegroundColor Red
    exit 1
  }
  $iconPath = ""
  if ($Icon) { $iconPath = $Icon.Trim().Trim('"') }
  if ($iconPath) {
    if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
      Write-Host "找不到图标文件: $iconPath" -ForegroundColor Red
      exit 1
    }
    if ([IO.Path]::GetExtension($iconPath) -notmatch '^\.png$') {
      Write-Host "图标必须是 .png: $iconPath" -ForegroundColor Red
      exit 1
    }
  }
}

function Set-MobileBrand {
  param(
    [string]$MobilePath,
    [string]$Name,
    [string]$Package,
    [string]$IconPath
  )
  $appJson = Join-Path $MobilePath "app.json"
  $example = Join-Path $MobilePath "app.json.example"
  if (-not (Test-Path -LiteralPath $appJson)) {
    if (-not (Test-Path -LiteralPath $example)) { Write-Error "找不到 app.json / app.json.example" }
    Copy-Item -LiteralPath $example -Destination $appJson
  }
  $json = Get-Content -LiteralPath $appJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $json.expo.name = $Name
  $json.expo.android.label = $Name
  $json.expo.android.package = $Package
  $slug = ($Package.Split('.')[-1]).ToLower()
  if (-not $slug) { $slug = "app" }
  $json.expo.slug = $slug
  if ($IconPath) {
    $assets = Join-Path $MobilePath "assets"
    if (-not (Test-Path -LiteralPath $assets)) { New-Item -ItemType Directory -Path $assets | Out-Null }
    foreach ($file in @(
        "icon.png",
        "android-icon-foreground.png",
        "android-icon-background.png",
        "android-icon-monochrome.png"
      )) {
      Copy-Item -LiteralPath $IconPath -Destination (Join-Path $assets $file) -Force
    }
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($appJson, ($json | ConvertTo-Json -Depth 30), $utf8)
  Write-Host "==> 已写入应用名/包名"
  Write-Host "    name=$Name"
  Write-Host "    package=$Package"
  if ($IconPath) {
    Write-Host "    icon -> apps\mobile\assets\icon.png 等"
  } else {
    Write-Host "    icon 未传，使用仓库默认图标"
  }
}

function Invoke-EasDirect {
  param([Parameter(Mandatory = $true)][string[]]$CliArgs, [switch]$AllowPrompt)
  $reg = "https://registry.npmjs.org"
  $prevCi = $env:CI
  if ($AllowPrompt) { Remove-Item Env:CI -ErrorAction SilentlyContinue }
  else { $env:CI = "1" }
  $global:LASTEXITCODE = 0
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & npx --yes --registry $reg eas-cli@latest @CliArgs
  } finally {
    $ErrorActionPreference = $old
    if ($null -eq $prevCi) { Remove-Item Env:CI -ErrorAction SilentlyContinue }
    else { $env:CI = $prevCi }
  }
}

function Get-EasWhoAmI {
  $reg = "https://registry.npmjs.org"
  $prevCi = $env:CI
  $env:CI = "1"
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $text = (& npx --yes --registry $reg eas-cli@latest whoami 2>&1 | Out-String)
    return @{ Code = $LASTEXITCODE; Text = $text.Trim() }
  } finally {
    $ErrorActionPreference = $old
    if ($null -eq $prevCi) { Remove-Item Env:CI -ErrorAction SilentlyContinue }
    else { $env:CI = $prevCi }
  }
}

function Save-ExpoTokenFile {
  param([string]$Token)
  $path = Join-Path $script:MobileRoot ".expo-token"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($path, $Token.Trim(), $utf8)
  Write-Host "==> 已保存 Expo Token 到 scripts\mobile\.expo-token（不进 Git，下次不用再填）"
}

function Read-ExpoTokenFile {
  $path = Join-Path $script:MobileRoot ".expo-token"
  if (-not (Test-Path -LiteralPath $path)) { return "" }
  return ([IO.File]::ReadAllText($path)).Trim()
}

function Reset-ExpoAccount {
  param([string]$MobilePath)
  Write-Host "==> 换 Expo 账号：清掉本机旧登录和旧项目"
  $tokenPath = Join-Path $script:MobileRoot ".expo-token"
  if (Test-Path -LiteralPath $tokenPath) { Remove-Item -LiteralPath $tokenPath -Force }
  $localPath = Join-Path $script:MobileRoot "eas.local.json"
  if (Test-Path -LiteralPath $localPath) { Remove-Item -LiteralPath $localPath -Force }
  Remove-Item Env:EXPO_TOKEN -ErrorAction SilentlyContinue

  Ensure-NodeEnv
  Push-Location $MobilePath
  try {
    Invoke-EasDirect -CliArgs @("logout")
  } finally {
    Pop-Location
  }

  $appJson = Join-Path $MobilePath "app.json"
  if (Test-Path -LiteralPath $appJson) {
    $json = Get-Content -LiteralPath $appJson -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($json.expo.PSObject.Properties["owner"]) {
      $json.expo.PSObject.Properties.Remove("owner")
    }
    if ($json.expo.extra -and $json.expo.extra.eas -and $json.expo.extra.eas.PSObject.Properties["projectId"]) {
      $json.expo.extra.eas.PSObject.Properties.Remove("projectId")
    }
    if ($json.expo.updates -and $json.expo.updates.PSObject.Properties["url"]) {
      $json.expo.updates.PSObject.Properties.Remove("url")
    }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($appJson, ($json | ConvertTo-Json -Depth 30), $utf8)
  }
  Write-Host "==> 已退出旧账号，并清空 owner / projectId"
}

function Ensure-EasProject {
  param([string]$MobilePath)
  $appJsonPath = Join-Path $MobilePath "app.json"
  $cfg = Get-Content -LiteralPath $appJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $projectId = ""
  if ($cfg.expo.extra -and $cfg.expo.extra.eas) {
    $projectId = [string]$cfg.expo.extra.eas.projectId
  }
  if (-not $projectId) {
    Write-Host "==> app.json 还没有 projectId，正在创建并写入 owner / projectId"
    Push-Location $MobilePath
    try {
      Invoke-EasDirect -CliArgs @("init", "--non-interactive", "--force")
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      Pop-Location
    }
    $cfg = Get-Content -LiteralPath $appJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $projectId = [string]$cfg.expo.extra.eas.projectId
  }
  if ($projectId -and $cfg.expo.updates) {
    $expect = "https://u.expo.dev/$projectId"
    $url = [string]$cfg.expo.updates.url
    if ($url -ne $expect) {
      $cfg.expo.updates | Add-Member -NotePropertyName url -NotePropertyValue $expect -Force
      $utf8 = New-Object System.Text.UTF8Encoding $false
      [IO.File]::WriteAllText($appJsonPath, ($cfg | ConvertTo-Json -Depth 30), $utf8)
      Write-Host "==> 已写入 updates.url"
    }
  }
}

function Ensure-ExpoLogin {
  param([string]$MobilePath)
  $token = ""
  if ($ExpoToken -and $ExpoToken.Trim()) { $token = $ExpoToken.Trim() }
  if (-not $token) { $token = Read-ExpoTokenFile }
  if ($token) {
    $env:EXPO_TOKEN = $token
    if ($ExpoToken -and $ExpoToken.Trim()) { Save-ExpoTokenFile -Token $token }
    else { Write-Host "==> 使用本机已保存的 Expo Token" }
  } else {
    Remove-Item Env:EXPO_TOKEN -ErrorAction SilentlyContinue
  }

  Ensure-NodeEnv
  Push-Location $MobilePath
  try {
    $who = Get-EasWhoAmI
    $loggedIn = ($who.Code -eq 0 -and $who.Text -and $who.Text -notmatch 'Not logged in|未登录')
    if (-not $loggedIn) {
      Write-Host "==> 尚未登录 Expo。接下来会打开浏览器，请用你的账号登录。"
      Remove-Item Env:EXPO_TOKEN -ErrorAction SilentlyContinue
      Invoke-EasDirect -AllowPrompt -CliArgs @("login")
      if ($LASTEXITCODE -ne 0) {
        Write-Host "Expo 登录失败，已停止。" -ForegroundColor Red
        exit $LASTEXITCODE
      }
      $who = Get-EasWhoAmI
      $loggedIn = ($who.Code -eq 0 -and $who.Text -and $who.Text -notmatch 'Not logged in|未登录')
      if (-not $loggedIn) {
        Write-Host "登录后仍无法确认账号，已停止。" -ForegroundColor Red
        Write-Host $who.Text
        exit 1
      }
      Write-Host "==> 登录成功。登录态已保存在本机 Expo 目录，下次不用再登。"
    }
    $account = ($who.Text -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch 'npm |npx |eas-cli' } | Select-Object -Last 1).Trim()
    Write-Host "==> 当前 Expo 账号: $account"
    return $account
  } finally {
    Pop-Location
  }
}

function Save-EasLocalInfo {
  param([string]$MobilePath, [string]$Account)
  $appJson = Join-Path $MobilePath "app.json"
  if (-not (Test-Path -LiteralPath $appJson)) { return }
  $cfg = Get-Content -LiteralPath $appJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $projectId = [string]$cfg.expo.extra.eas.projectId
  $owner = [string]$cfg.expo.owner
  $info = [ordered]@{
    account   = $Account
    owner     = $owner
    projectId = $projectId
    savedAt   = (Get-Date).ToString("s")
  }
  $path = Join-Path $script:MobileRoot "eas.local.json"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($path, ($info | ConvertTo-Json), $utf8)
  Write-Host "==> 已保存项目信息到 scripts\mobile\eas.local.json"
  Write-Host "    account=$Account"
  Write-Host "    owner=$owner"
  Write-Host "    projectId=$projectId"
}

$MobileRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $MobileRoot "common.ps1")
$script:SkipConfirm = $true
$script:EasNonInteractive = $true

Write-Host ""
Write-Host "========================================"
Write-Host " FlowOrder App 用户自己打包"
Write-Host " Action=$Action  Profile=$Profile"
Write-Host "========================================"

if ($Action -eq "login") {
  $paths = Resolve-AppRoot
  if ($sw) { Reset-ExpoAccount -MobilePath $paths.MobilePath }
  $account = Ensure-ExpoLogin -MobilePath $paths.MobilePath
  Ensure-EasProject -MobilePath $paths.MobilePath
  Save-EasLocalInfo -MobilePath $paths.MobilePath -Account $account
  exit 0
}

if ($Action -eq "build") {
  Test-SelfBuildParams
}

if ($ApiBase -and $ApiBase.Trim().Length -gt 0) {
  $apiNorm = Normalize-ApiBase -Raw $ApiBase
  Set-MobileConfValue -Key "API_BASE" -Value $apiNorm
  Write-Host "==> 已写入 mobile.conf API_BASE=$apiNorm"
} elseif (-not $script:MobileConf["API_BASE"]) {
  Write-Host "缺少 -ApiBase" -ForegroundColor Red
  if ($Action -eq "build") { Show-SelfBuildUsage }
  exit 1
}

if ($WebApiBase -and $WebApiBase.Trim().Length -gt 0) {
  $webNorm = Normalize-ApiBase -Raw $WebApiBase
  Set-MobileConfValue -Key "WEB_API_BASE" -Value $webNorm
  Write-Host "==> 已写入 mobile.conf WEB_API_BASE=$webNorm"
}

Set-MobileConfValue -Key "EAS_PROFILE" -Value $Profile
Set-MobileConfValue -Key "EAS_NON_INTERACTIVE" -Value "true"
Set-MobileConfValue -Key "SKIP_CONFIRM" -Value "true"
$script:EasProfile = $Profile

switch ($Action) {
  "build" {
    $paths = Resolve-AppRoot
    $iconArg = ""
    if ($Icon) { $iconArg = $Icon.Trim().Trim('"') }
    if ($sw) { Reset-ExpoAccount -MobilePath $paths.MobilePath }
    $account = Ensure-ExpoLogin -MobilePath $paths.MobilePath
    Set-MobileBrand -MobilePath $paths.MobilePath -Name $AppName.Trim() -Package $PackageName.Trim() -IconPath $iconArg
    Ensure-EasProject -MobilePath $paths.MobilePath
    Save-EasLocalInfo -MobilePath $paths.MobilePath -Account $account
    Write-Host "==> 一键打 Android 包 profile=$Profile"
    Invoke-EasAndroidBuild -Profile $Profile -MobilePath $paths.MobilePath
  }
  "update" {
    $channel = if ($Profile -eq "preview") { "preview" } else { "production" }
    Write-Host "==> 一键热更新 channel=$channel"
    Invoke-EasUpdate -Channel $channel -Message $Message
  }
  "web" {
    Write-Host "==> 一键导出 Web H5"
    Invoke-ExpoWebExport
  }
}

Write-Host ""
Write-Host "一键流程结束。"
