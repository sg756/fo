App（Expo）打包脚本总说明
============================================================

本目录专门放 mobile 打包，与 deploy / deploy-windows 分开。

方式：Expo EAS 云构建
  - 本机不需要 Android Studio / SDK
  - 需要：能跑 Node（可自动下便携版）+ Expo 账号登录 + 能上网

目录：
  mobile.conf     ← B/C 共用配置（只改这个）
  common.ps1      ← 公共逻辑（勿直接跑）
  B/              ← 方案 B：分步脚本（login / build-android / update / export-web）
  C/              ← 方案 C：一个菜单入口（小白推荐）
  README.txt      ← 本说明


选哪个？
  给不熟命令的人 → 方案 C
       powershell -ExecutionPolicy Bypass -File scripts\mobile\C\build.ps1
       （脚本为 UTF-8 BOM，避免中文乱码解析失败）
  喜欢分步、可写进文档清单 → 方案 B
       先 B\login.ps1 ，再 B\build-android.ps1
       只改 JS 发热更新：B\update.ps1

两套功能等价，共用 mobile.conf。


首次注意
  1. apps/mobile 已配置 EAS（app.json 里 owner / projectId，eas.json 有 profile）
  2. 有 Expo 账号且对该项目有权限
  3. 先登录，再构建
  4. 构建完成后在 Expo 网页下载 APK/AAB


配置项说明
  见 mobile.conf 内每个字段上方注释。
  默认 EAS_PROFILE=production → 正式 APK。
  服务器地址：API_BASE（App）、WEB_API_BASE（H5，可空）。
  打包前脚本会写入 apps/mobile/src/api/api.endpoint.ts。
  产物：preview/production = APK；store = 上架 AAB（Google Play）。


热更新（EAS Update）
  已接 expo-updates。正式/内测 APK 打开时会拉 JS 更新。
  方案 C：菜单选 6（正式）或 7（内测）。
  方案 B：
    powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1
    powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1 -Channel preview
    powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1 -Message "修复持仓列表"
  脚本会先按 mobile.conf 写入 API_BASE，再 eas update。
  改原生库/权限/SDK：必须重新打 APK，不要走热更新。
  旧手机包没有更新模块，需先装带 expo-updates 的那一版 APK。
  免费额度见 expo.dev/pricing（约 1000 MAU/月，超出需付费或等下月重置）。


与后台发布无关
  管理端/API 发布仍用 scripts/deploy 或 deploy-windows。
  App 包是独立产物，不会自动部署到服务器。
