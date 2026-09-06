方案 C · 菜单入口（小白推荐）
============================================================

上级说明：../README.txt
共用配置：../mobile.conf

文件：
  build.ps1     ← 一个脚本弹出菜单


用法
  powershell -ExecutionPolicy Bypass -File scripts\mobile\C\build.ps1

菜单：
  1 登录 Expo/EAS（每台电脑首次）
  2 打内测 APK（preview）
  3 打正式 APK（production）
  4 打上架 AAB（store，仅 Google Play）
  5 导出 Web H5
  6 热更新正式包（channel=production，只改 JS）
  7 热更新内测包（channel=preview，只改 JS）
  0 退出


建议流程
  第一次：选 1 登录 → 再选 3 打正式 APK → 按终端链接下载安装
  只改 JS/界面：选 6（正式）或 7（内测），不用重装 APK
  改原生库/权限/SDK：必须再选 2 或 3 打新 APK

说明：
  - 与方案 B 功能相同，只是交互改成菜单
  - 底层共用 ../common.ps1、../mobile.conf
  - 仍不需要 Android Studio
