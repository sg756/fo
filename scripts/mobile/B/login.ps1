# 方案 B：仅登录 Expo / EAS（每台电脑首次）
# powershell -ExecutionPolicy Bypass -File scripts\mobile\B\login.ps1

param([switch]$Yes)

$ErrorActionPreference = "Stop"
$global:MobileYes = [bool]$Yes
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$MobileRoot = (Resolve-Path (Join-Path $Here "..")).Path
. (Join-Path $MobileRoot "common.ps1")

Write-Host "==> 方案 B 登录 (配置: $ConfFile)"
Invoke-EasLogin
