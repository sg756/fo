# 方案 B：EAS 云构建 Android（默认 mobile.conf 的 EAS_PROFILE）
# powershell -ExecutionPolicy Bypass -File scripts\mobile\B\build-android.ps1
# 正式 APK：...\build-android.ps1 -Profile production
# 上架 AAB：...\build-android.ps1 -Profile store

param(
  [string]$Profile = "",
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$global:MobileYes = [bool]$Yes
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$MobileRoot = (Resolve-Path (Join-Path $Here "..")).Path
. (Join-Path $MobileRoot "common.ps1")

if (-not $Profile) { $Profile = $script:EasProfile }

Write-Host "==> 方案 B · Android 云构建 profile=$Profile"
Write-Host "    配置: $ConfFile"
if (-not $script:SkipConfirm) {
  $ok = Read-Host "确认开始云构建? [Y/n]"
  if ($ok -match '^[Nn]') { Write-Error "已取消" }
}
Invoke-EasAndroidBuild -Profile $Profile
