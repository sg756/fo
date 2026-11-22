install-env/ · 服务器装环境 + GitHub 一键安装
============================================================

Linux 服务器要跑 FlowOrder（users-manager），就从这里开始。
编译在 Windows 本机（../deploy-windows/）或 GitHub Actions；本目录负责装环境、拉包、写配置、应用产物。

CentOS 9 一键安装 / 更新（业务库账号、业务库密码、MariaDB root 密码都要在命令里填；库名可选，默认 users_manager）：
  curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh \
    | sudo bash -s -- --db-user=users_flow --db-pass='你的密码' --mysql-root-pass='你的root密码'
  也可加 --db-name=users_manager。私有仓先 export GH_TOKEN=你的PAT
装完打开 http://服务器IP/ （PORT 默认 80），H5 为 http://服务器IP/h5/ 。
管理员账号：首次 seed 写入 .env 的 ADMIN_EMAIL / ADMIN_PASSWORD（模板默认 admin / 1234567）。
再跑同一条命令即更新程序。覆盖发布包，保留 apps/api/.env 里的私钥、助记词、JWT、ENC_KEY、管理员密码，以及 logs/、backup/。

私有仓库先：
  export GH_TOKEN=你的GitHub_PAT
  再执行上面的 curl | sudo bash


文件：
  floworder.conf       ← 只改这个（APP_ROOT / 端口 / 库 / GITHUB_*）
  remote-bootstrap.sh  ← 空机器 curl | sudo bash 一键
  bootstrap.sh         ← 首次一键：install + 拉 GitHub zip + configure + apply-dist
  fetch-dist.sh        ← 从 GitHub Release 覆盖 zip 并重启
  install.sh           ← 只装 Node、用户、MariaDB、防火墙
  configure.sh         ← 写 .env + systemd
  apply-dist.sh        ← npm ci + prisma + 重启
  export-db.sh         ← 备份业务库
  common.sh            ← 内部公用，不要单独跑
  README.txt           ← 本说明

必须用：
  sudo bash scripts/install-env/bootstrap.sh
不要用 ./bootstrap.sh（从 Windows 上传时 shebang 可能带回车）。


--------------------------------------------------------------------------------
执行前要配置什么
--------------------------------------------------------------------------------

  编辑 floworder.conf（至少）：
    APP_ROOT     一键解压后自动扫描；空机默认先下到 /opt/dist-release
    PORT         对外端口
    DB_USER/DB_PASS           一键安装必须用 --db-user / --db-pass 传入
    MYSQL_ROOT_PASSWORD   一键安装必须用 --mysql-root-pass 传入，脚本不自动生成
    DB_NAME               默认 users_manager
    GITHUB_REPO / GITHUB_RELEASE_TAG  默认 sg756/fo + dist


--------------------------------------------------------------------------------
脚本执行顺序
--------------------------------------------------------------------------------

  空 Linux 一条命令（推荐）：
    curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash -s -- --db-user=users_flow --db-pass='你的密码' --mysql-root-pass='你的root密码'
    会自动：下载脚本 → 装 Node/MariaDB → 拉 GitHub dist-release.zip → configure → npm/prisma → 启动

  已有脚本目录时：
    1. 改 floworder.conf
    2. sudo bash scripts/install-env/bootstrap.sh

  以后发版（只更新程序）：
    sudo bash scripts/install-env/fetch-dist.sh
    或本机 build.ps1 覆盖 APP_ROOT 后再 apply-dist.sh

  日常启停：../deploy/run/start.sh | restart.sh | stop.sh


--------------------------------------------------------------------------------
本机打 zip / 挂 Release
--------------------------------------------------------------------------------

  Windows：scripts\deploy-windows\build.ps1
    → 生成 dist-release\ 与仓库根 dist-release.zip

  把 dist-release.zip 上传到 GitHub Release：
    tag = dist
    资产名必须为 dist-release.zip

  推 main 时 .github/workflows/release-dist.yml 也会自动编包并覆盖 tag=dist。


--------------------------------------------------------------------------------
备份业务库
--------------------------------------------------------------------------------

  cd ${APP_ROOT}
  sudo bash scripts/install-env/export-db.sh


别搞混：
  remote-bootstrap.sh = 空机 curl 一键
  bootstrap.sh        = 首次一键（install + 拉包 + configure + apply）
  fetch-dist.sh       = 拉最新 zip 并重启
  install.sh          = 只装系统环境
  configure.sh        = 写 .env / systemd
  apply-dist.sh       = 应用产物并重启
