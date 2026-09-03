方案 B · 分步脚本（适合按步骤操作）
============================================================

上级说明：../README.txt
共用配置：../mobile.conf

文件：
  login.ps1           ← 每台电脑首次：登录 Expo/EAS
  build-android.ps1   ← 每次发版：云构建 Android（默认 APK）
  update.ps1          ← 只改 JS：发热更新（默认正式 channel=production）
  export-web.ps1      ← 可选：导出 H5


执行顺序（小白按这个来）
  1. 编辑 ../mobile.conf（一般只改 EAS_PROFILE / NODE_HOME）
  2. 首次登录：
       powershell -ExecutionPolicy Bypass -File scripts\mobile\B\login.ps1
  3. 打内测 APK：
       powershell -ExecutionPolicy Bypass -File scripts\mobile\B\build-android.ps1
  4. 终端会出现 Expo 构建页链接，打开后下载 APK 安装到手机

正式 APK：
  powershell -ExecutionPolicy Bypass -File scripts\mobile\B\build-android.ps1 -Profile production

上架 AAB（Google Play，profile=store）：
  powershell -ExecutionPolicy Bypass -File scripts\mobile\B\build-android.ps1 -Profile store

热更新（已装带 expo-updates 的 APK 才会收到；不重新打包装机）：
  正式：
    powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1
  内测：
    powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1 -Channel preview
  带说明：
    powershell -ExecutionPolicy Bypass -File scripts\mobile\B\update.ps1 -Message "修复持仓列表"

说明：
  - 不需要安装 Android Studio
  - 需要能上网；需要 Expo 账号且对项目有权限（见 apps/mobile/app.json）
  - 若更想「一个菜单选」→ 用方案 C：../C/build.ps1
