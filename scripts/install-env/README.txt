install-env/ · 服务器先装环境（一眼：装环境）
============================================================

Linux 服务器要跑 users-manager，就必须先来这里。
编译在 Windows 本机（../deploy-windows/），本目录负责装环境、写配置、应用产物。

文件：
  floworder.conf   ← 只改这个（APP_ROOT / 端口 / 库）
  install.sh       ← ① 装 Node、用户、MariaDB、防火墙（可以还没有代码）
  configure.sh     ← ③ 有代码或 dist 后：写完整 .env（无 example 也内嵌同键模板）、systemd
  apply-dist.sh    ← Windows 产物上传后：npm ci + prisma + 重启（读同级 floworder.conf）
  README.txt       ← 本说明

总览：../README.txt


--------------------------------------------------------------------------------
执行前要配置什么
--------------------------------------------------------------------------------

  编辑 floworder.conf（至少）：
    APP_ROOT     代码目录
    PORT         对外端口
    DB_PASS      库密码（生产改掉）
    MYSQL_* / DB_*   本机建库；MYSQL_ROOT_PASSWORD 可留空（install 自动生成写回）
                     外部库则 MYSQL_AUTO=false


--------------------------------------------------------------------------------
脚本执行顺序
--------------------------------------------------------------------------------

  1. 改 floworder.conf
  2. sudo bash scripts/install-env/install.sh
  3. 把代码上传/同步到 APP_ROOT
  4. sudo bash scripts/install-env/configure.sh
  5. 本机 ../deploy-windows/build.ps1 → 本目录 apply-dist.sh
     （apply-dist 末尾自动 seed）
  日常启停：../deploy/run/start.sh | restart.sh | stop.sh


别搞混：
  install.sh    = 只装系统环境
  configure.sh  = 有代码后写配置；不编译、不 start
                  服务器写 apps/api/.env（兼容旧 .env.production 自动迁移）
                  本地开发请用 apps/api/.env.dev，发布包不要带本机密文
  apply-dist.sh = 应用本机编好的 dist，装依赖并重启
