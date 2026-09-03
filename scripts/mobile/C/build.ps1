# 方案 C: 菜单入口 (小白推荐)
# powershell -ExecutionPolicy Bypass -File scripts\mobile\C\build.ps1

param([switch]$Yes)

$ErrorActionPreference = "Stop"
$global:MobileYes = [bool]$Yes
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$MobileRoot = (Resolve-Path (Join-Path $Here "..")).Path
. (Join-Path $MobileRoot "common.ps1")

Write-Host ""
Write-Host "========================================"
Write-Host " FlowOrder App 打包菜单 (方案 C)"
Write-Host " EAS 云构建 · 本机无需 Android SDK"
Write-Host " 配置: $ConfFile"
$__apiShow = if ($script:MobileConf["API_BASE"]) { $script:MobileConf["API_BASE"] } else { "(未配置 API_BASE)" }
Write-Host " API_BASE: $__apiShow"
Write-Host "========================================"
Write-Host ""
Write-Host "  1) 登录 Expo / EAS (每台电脑首次必做)"
Write-Host "  2) 打内测 APK (profile=preview)"
Write-Host "  3) 打正式 APK (profile=production)"
Write-Host "  4) 打上架 AAB (profile=store, 仅 Google Play)"
Write-Host "  5) 导出 Web H5"
Write-Host "  6) 热更新正式包 (channel=production, 只改 JS)"
Write-Host "  7) 热更新内测包 (channel=preview, 只改 JS)"
Write-Host "  0) 退出"
Write-Host ""
Write-Host " 提示: 改服务器地址请编辑 mobile.conf 的 API_BASE, 打包/热更新时自动写入 App"
Write-Host "       热更新不装新 APK; 旧手机包需先装带 expo-updates 的那一版."
Write-Host ""

$choice = Read-Host "请选择"

switch ($choice) {
  "1" {
    Invoke-EasLogin
  }
  "2" {
    Write-Host "将使用 profile=preview (APK)"
    if (-not $script:SkipConfirm) {
      $ok = Read-Host "确认开始? [Y/n]"
      if ($ok -match '^[Nn]') { Write-Error "已取消" }
    }
    Invoke-EasAndroidBuild -Profile "preview"
  }
  "3" {
    Write-Host "将使用 profile=production (正式 APK)"
    if (-not $script:SkipConfirm) {
      $ok = Read-Host "确认打正式 production APK? [Y/n]"
      if ($ok -match '^[Nn]') { Write-Error "已取消" }
    }
    Invoke-EasAndroidBuild -Profile "production"
  }
  "4" {
    Write-Host "将使用 profile=store (上架 AAB, 不能直接装手机)"
    if (-not $script:SkipConfirm) {
      $ok = Read-Host "确认打上架 store AAB? [Y/n]"
      if ($ok -match '^[Nn]') { Write-Error "已取消" }
    }
    Invoke-EasAndroidBuild -Profile "store"
  }
  "5" {
    Invoke-ExpoWebExport
  }
  "6" {
    Write-Host "将推送 JS 热更新到 channel=production (已装正式 APK 的手机)"
    if (-not $script:SkipConfirm) {
      $ok = Read-Host "确认热更新正式包? [Y/n]"
      if ($ok -match '^[Nn]') { Write-Error "已取消" }
    }
    Invoke-EasUpdate -Channel "production"
  }
  "7" {
    Write-Host "将推送 JS 热更新到 channel=preview (已装内测 APK 的手机)"
    if (-not $script:SkipConfirm) {
      $ok = Read-Host "确认热更新内测包? [Y/n]"
      if ($ok -match '^[Nn]') { Write-Error "已取消" }
    }
    Invoke-EasUpdate -Channel "preview"
  }
  "0" {
    Write-Host "已退出"
  }
  default {
    Write-Error "无效选项: $choice"
  }
}
