install-env/ · 【公共】服务器先装环境（一眼：装环境）
============================================================

本目录独立于「纯 Linux 编译」和「Windows 发版」。
只要这台 Linux 要跑 users-manager，就必须先来这里。

文件：
  floworder.conf   ← 只改这个（APP_ROOT / 端口 / 库 / Git 地址）
  install.sh       ← ① 装 Node、用户、MariaDB、防火墙（可以还没有代码）
  configure.sh     ← ③ 有代码或 dist 后：写完整 .env（无 example 也内嵌同键模板）、systemd
  apply-dist.sh    ← Windows 产物上传后：npm ci + prisma + 重启（读同级 floworder.conf）
  README.txt       ← 本说明

总览（含 L/W 完整顺序）：../README.txt


--------------------------------------------------------------------------------
执行前要配置什么
--------------------------------------------------------------------------------

  编辑 floworder.conf（至少）：
    APP_ROOT     代码目录
    PORT         对外端口
    DB_PASS      库密码（生产改掉）
    MYSQL_* / DB_*   本机建库；MYSQL_ROOT_PASSWORD 可留空（install 自动生成写回）
                     外部库则 MYSQL_AUTO=false

  纯 Linux 若用脚本拉代码，还要：
    GIT_REPO_URL / GIT_BRANCH
    （在 ../deploy/ops/pull.sh 使用）


--------------------------------------------------------------------------------
谁必须跑 install / configure？
--------------------------------------------------------------------------------

  · 纯 Linux 发版 → 要
  · Windows 编好再上传 → 也要


--------------------------------------------------------------------------------
脚本执行顺序（公共段）
--------------------------------------------------------------------------------

  1. 改 floworder.conf
  2. sudo bash scripts/install-env/install.sh
  3. 代码进 APP_ROOT
       纯 Linux：sudo bash scripts/deploy/ops/pull.sh
       Windows：上传/同步到 APP_ROOT
  4. sudo bash scripts/install-env/configure.sh
  5. 分叉：
       纯 Linux → ../deploy/run/build.sh → start.sh
                  （build 末尾 db push 后自动 node prisma/seed.js）
       Windows  → 本机 ../deploy-windows/build.ps1 → 本目录 apply-dist.sh
                  （apply-dist 末尾同样自动 seed）


别搞混：
  install.sh    = 只装系统环境
  pull.sh       = 只拉代码（在 deploy/ops，不在本目录）
  configure.sh  = 有代码后写配置；不编译、不 start
                  服务器写 apps/api/.env（兼容旧 .env.production 自动迁移）
                  本地开发请用 apps/api/.env.dev，发布包不要带本机密文
