# 方案 B：导出 Web H5（可选，给 iOS 浏览器用）
# powershell -ExecutionPolicy Bypass -File scripts\mobile\B\export-web.ps1

param([switch]$Yes)

$ErrorActionPreference = "Stop"
$global:MobileYes = [bool]$Yes
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$MobileRoot = (Resolve-Path (Join-Path $Here "..")).Path
. (Join-Path $MobileRoot "common.ps1")

Write-Host "==> 方案 B · 导出 Web"
Invoke-ExpoWebExport
