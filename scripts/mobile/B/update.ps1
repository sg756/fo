# 方案 B：发布 JS 热更新（已装带 expo-updates 的 APK 才会收到）
# 正式：powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1
# 内测：...\update.ps1 -Channel preview
# 说明：...\update.ps1 -Message "修复持仓列表"

param(
  [ValidateSet("production", "preview")]
  [string]$Channel = "production",
  [string]$Message = "",
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$global:MobileYes = [bool]$Yes
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$MobileRoot = (Resolve-Path (Join-Path $Here "..")).Path
. (Join-Path $MobileRoot "common.ps1")

Write-Host "==> 方案 B · 热更新 channel=$Channel"
Write-Host "    配置: $ConfFile"
if (-not $script:SkipConfirm) {
  $ok = Read-Host "确认推送 JS 热更新到 $Channel? [Y/n]"
  if ($ok -match '^[Nn]') { Write-Error "已取消" }
}
Invoke-EasUpdate -Channel $Channel -Message $Message
