# =============================================================================
# FlowOrder App 一键打包（Windows · EAS 云构建）
#
# 正式 APK：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -ApiBase http://服务器IP/api
#
# 内测 APK：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Profile preview -ApiBase http://服务器IP/api
#
# 上架 AAB：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Profile store -ApiBase http://服务器IP/api
#
# 热更新（只改 JS）：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Action update -ApiBase http://服务器IP/api
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Action update -Profile preview -ApiBase http://.../api -Message "修复说明"
#
# 导出 H5：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Action web -ApiBase http://服务器IP/api
#
# 首次登录 Expo（每台电脑一次）：
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Action login
#
# 说明：本机无需 Android SDK；需已登录 Expo，且 apps/mobile 已 eas init。
# =============================================================================

param(
  [ValidateSet("build", "update", "web", "login")]
  [string]$Action = "build",

  [ValidateSet("production", "preview", "store")]
  [string]$Profile = "production",

  [string]$ApiBase = "",
  [string]$WebApiBase = "",
  [string]$Message = "",

  [switch]$Yes
)

$ErrorActionPreference = "Stop"
# 一键默认少提问、EAS 非交互
$global:MobileYes = $true
if ($Yes) { $global:MobileYes = $true }

$MobileRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $MobileRoot "common.ps1")
$script:SkipConfirm = $true
$script:EasNonInteractive = $true

Write-Host ""
Write-Host "========================================"
Write-Host " FlowOrder App 一键打包"
Write-Host " Action=$Action  Profile=$Profile"
Write-Host "========================================"

if ($Action -eq "login") {
  Invoke-EasLogin
  exit 0
}

if ($ApiBase -and $ApiBase.Trim().Length -gt 0) {
  $apiNorm = Normalize-ApiBase -Raw $ApiBase
  Set-MobileConfValue -Key "API_BASE" -Value $apiNorm
  Write-Host "==> 已写入 mobile.conf API_BASE=$apiNorm"
} elseif (-not $script:MobileConf["API_BASE"]) {
  Write-Host "缺少 API 地址。请传 -ApiBase，例如：" -ForegroundColor Red
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -ApiBase http://服务器IP/api"
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
    Write-Host "==> 一键打 Android 包 profile=$Profile"
    Invoke-EasAndroidBuild -Profile $Profile
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
