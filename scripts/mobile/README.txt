App（Expo）打包脚本总说明
============================================================

本目录专门放 mobile 打包，与 deploy-windows 分开。

方式：Expo EAS 云构建
  - 本机不需要 Android Studio / SDK
  - 需要：能跑 Node（可自动下便携版）+ Expo 账号登录 + 能上网

目录：
  mobile.conf.example ← 模板（进 Git）
  mobile.conf         ← 本机复制后改（不进 Git；没有时脚本会自动复制）
  common.ps1      ← 公共逻辑（勿直接跑）
  B/              ← 方案 B：分步脚本（login / build-android / update / export-web）
  C/              ← 方案 C：一个菜单入口（小白推荐）
  README.txt      ← 本说明


选哪个？
  用户什么都没装 → remote-one-click.ps1（一条命令下载源码、装 Node、云端打包）
       powershell -NoProfile -ExecutionPolicy Bypass -Command '& { $d = Join-Path $env:TEMP ''fo-app.ps1''; irm ''https://raw.githubusercontent.com/sg756/fo/main/scripts/mobile/remote-one-click.ps1'' -OutFile $d; & $d -ApiBase ''http://服务器IP/api'' -AppName ''你的应用名'' -PackageName ''com.example.app'' }'
       私有仓加 -GhToken '你的PAT'
  本机已有仓库 → one-click.ps1
       必填缺一即报错退出：-ApiBase -AppName -PackageName
       -Icon 可不填、"" 或空格，此时用仓库默认图标
       -ExpoToken 可不填：未登录会打开浏览器，成功后登录态和 projectId 记在本机
       换账号加 -sw：退出旧账号、清空旧 projectId，再登录新账号并继续打包
         powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 `
           -ApiBase http://服务器IP/api -AppName "你的应用名" -PackageName com.example.app `
           -ExpoToken "你的ExpoToken"
         powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -sw `
           -ApiBase http://服务器IP/api -AppName "你的应用名" -PackageName com.example.app
       内测加 -Profile preview；上架加 -Profile store
       热更新仍只需 -ApiBase：
         powershell -ExecutionPolicy Bypass -File scripts\mobile\one-click.ps1 -Action update -ApiBase http://服务器IP/api
  给不熟命令的人 → 方案 C 菜单
       powershell -ExecutionPolicy Bypass -File scripts\mobile\C\build.ps1
  喜欢分步 → 方案 B
       先 B\login.ps1 ，再 B\build-android.ps1
       热更新：B\update.ps1

共用 mobile.conf。一键脚本会把 -ApiBase 写进 conf 并默认非交互。


首次注意
  1. 复制 apps/mobile/app.json.example → app.json，再 eas-cli init（会写入 owner / projectId）
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
  管理端/API 发布用 scripts/deploy-windows；Linux 启停用 scripts/deploy/run。
  App 包是独立产物，不会自动部署到服务器。
