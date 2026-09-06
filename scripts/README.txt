================================================================================
FlowOrder / users-manager 运维脚本总说明
================================================================================

本机 Windows 编译，再把产物上传到 Linux 服务器。

目录分工（名字一眼秒懂）：

  scripts/install-env/      → 服务器先装环境，再 apply-dist
  scripts/deploy/           → Linux 上日常启停（start / restart / stop）
  scripts/deploy-windows/   → Windows：本机编译
  scripts/mobile/           → App（Expo）打包
  scripts/gost/             → GOST 代理
  scripts/dev/              → 本机 Windows 开发环境（Node / env / 建库）

配置文件（脚本执行前先改）：
  服务器：install-env/floworder.conf
  本地开发 API：apps/api/.env.dev（Nest 非 production 读取；从 .env.example 复制）
  服务器 API：apps/api/.env（configure 生成/改写；发布包勿带本机密文）
  Windows 本机：deploy-windows/build.conf
  App：mobile/mobile.conf
  本机开发：dev/dev.conf


--------------------------------------------------------------------------------
执行前必改配置
--------------------------------------------------------------------------------

  编辑：scripts/install-env/floworder.conf

  至少确认：
    APP_ROOT      代码最终目录（上传必须进这里）
    PORT          对外端口（常用 80）
    DB_PASS       数据库密码（生产务必改）
    MYSQL_*       本机建库相关；外部库则 MYSQL_AUTO=false 并稍后在 .env 写 DATABASE_URL

  本机 Windows 再改：deploy-windows/build.conf
    SOURCE_ROOT（本机源码）、RELEASE_DIR（上传包，默认 dist-release）、NODE_HOME


--------------------------------------------------------------------------------
完整顺序
--------------------------------------------------------------------------------

  —— 服务器（首次）——
  1) 改 install-env/floworder.conf
  2) sudo bash scripts/install-env/install.sh
  3) 把代码放到服务器 APP_ROOT（上传整仓或至少后续 configure 所需文件）
  4) sudo bash scripts/install-env/configure.sh
     改 apps/api/.env 生产密钥
     （HD_MNEMONIC 由 configure 首次自动生成并保留，勿改、勿用本机 .env.dev 覆盖）
     管理员账号：configure 只写入 ADMIN_*；首次 apply-dist 会自动 seed 进库

  —— 本机 Windows（每次发版）——
  5) 改 deploy-windows/build.conf（如需要）
  6) powershell -ExecutionPolicy Bypass -File scripts\deploy-windows\build.ps1
     → 生成 dist-release\（与服务器 APP_ROOT 同结构）

  —— 再回服务器 ——
  7) 将 dist-release\ 内容覆盖到 APP_ROOT（勿传 node_modules）
  8) sudo bash scripts/install-env/apply-dist.sh

  细节：scripts/deploy-windows/README.txt


--------------------------------------------------------------------------------
日常运维速查
--------------------------------------------------------------------------------

  场景                              执行
  --------------------------------  ------------------------------------------
  装服务器环境                       sudo bash scripts/install-env/install.sh
  写业务配置                         sudo bash scripts/install-env/configure.sh
  Windows 本机编译                   scripts\deploy-windows\build.ps1
  Windows 产物上线                   sudo bash scripts/install-env/apply-dist.sh
  Linux 启停                         scripts/deploy/run/start|restart|stop.sh


--------------------------------------------------------------------------------
别搞混
--------------------------------------------------------------------------------

  install.sh     只装环境，不要代码也可以
  configure.sh   有代码后写 .env + systemd
  build.ps1      本机编译，生成 dist-release\
  apply-dist.sh  产物在 Linux 上装依赖并重启（与 install 同目录，读同级 floworder.conf）
  start/restart/stop.sh  Linux 上日常启停
================================================================================
