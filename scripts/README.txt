================================================================================
FlowOrder / users-manager 运维脚本总说明
================================================================================

目录分工（名字一眼秒懂）：

  scripts/install-env/      → 【公共】先装服务器环境（纯 Linux / Windows 发版都要）
  scripts/deploy/           → 纯 Linux：拉代码 / 编译 / 启停 / 日常 publish
  scripts/deploy-windows/   → Windows：本机编译 + Linux 上 apply-dist
  scripts/mobile/           → App（Expo）打包
  scripts/gost/             → GOST 代理

配置文件（脚本执行前先改）：
  服务器公共：install-env/floworder.conf
  本地开发 API：apps/api/.env.dev（Nest 非 production 读取；从 .env.example 复制）
  服务器 API：apps/api/.env（configure 生成/改写；发布包勿带本机密文）
  Windows 本机：deploy-windows/build.conf
  App：mobile/mobile.conf


--------------------------------------------------------------------------------
〇、执行前必改配置（公共）
--------------------------------------------------------------------------------

  编辑：scripts/install-env/floworder.conf

  至少确认：
    APP_ROOT      代码最终目录（clone/上传都必须进这里）
    PORT          对外端口（常用 80）
    DB_PASS       数据库密码（生产务必改）
    MYSQL_*       本机建库相关；外部库则 MYSQL_AUTO=false 并稍后在 .env 写 DATABASE_URL

  纯 Linux 首次用脚本拉代码时还要填：
    GIT_REPO_URL  仓库地址（https 或 git@）
    GIT_BRANCH    分支（默认 main）


--------------------------------------------------------------------------------
一、公共前置（路径 L / W 都要）—— install-env/
--------------------------------------------------------------------------------

  1. 改好 floworder.conf（见上）
  2. sudo bash scripts/install-env/install.sh
  3. 代码进入 APP_ROOT
       · 纯 Linux：sudo bash scripts/deploy/ops/pull.sh
       · Windows：把发布内容同步/上传到 APP_ROOT
  4. sudo bash scripts/install-env/configure.sh
     然后改 APP_ROOT/apps/api/.env 里 JWT_SECRET / ENC_KEY / ADMIN 等
     （HD_MNEMONIC 由 configure 首次自动生成并保留，勿改、勿用本机 .env.dev 覆盖）
     管理员账号：configure 只写入 ADMIN_*；首次 build/apply-dist 会自动 seed 进库


--------------------------------------------------------------------------------
二、路径 L · 纯 Linux（完整顺序）
--------------------------------------------------------------------------------

  【执行前配置】install-env/floworder.conf
    APP_ROOT、DB_*、GIT_REPO_URL、GIT_BRANCH

  【顺序】
    1) sudo bash scripts/install-env/install.sh
    2) sudo bash scripts/deploy/ops/pull.sh          ← 拉/克隆代码
    3) sudo bash scripts/install-env/configure.sh
       改 apps/api/.env 生产密钥
    4) sudo bash scripts/deploy/run/build.sh
    5) sudo bash scripts/deploy/run/start.sh

  【日常更新】
    sudo bash scripts/deploy/ops/pull.sh             ← 只更新代码
    sudo bash scripts/deploy/run/build.sh
    sudo bash scripts/deploy/run/restart.sh
    或一键：sudo bash scripts/deploy/ops/publish.sh
      （publish 是否自动 pull 看 conf 的 GIT_PULL）

  细节：scripts/deploy/README.txt


--------------------------------------------------------------------------------
三、路径 W · Windows 编译再上 Linux（完整顺序）
--------------------------------------------------------------------------------

  【服务器执行前配置】install-env/floworder.conf
    APP_ROOT、DB_*、PORT（一般不用 GIT_REPO_URL）

  【本机执行前配置】deploy-windows/build.conf
    SOURCE_ROOT（本机源码）、RELEASE_DIR（上传包，默认 dist-release）、NODE_HOME

  【顺序】
    —— 服务器（首次）——
    1) 改 install-env/floworder.conf
    2) sudo bash scripts/install-env/install.sh
    3) 把代码放到服务器 APP_ROOT（上传整仓或至少后续 configure 所需文件）
    4) sudo bash scripts/install-env/configure.sh
       改 apps/api/.env 生产密钥（HD_MNEMONIC 已由 configure 生成则勿改）

    —— 本机 Windows ——
    5) 改 deploy-windows/build.conf（如需要）
    6) powershell -ExecutionPolicy Bypass -File scripts\deploy-windows\build.ps1
       → 生成 dist-release\（与服务器 APP_ROOT 同结构）

    —— 再回服务器 ——
    7) 将 dist-release\ 内容覆盖到 APP_ROOT（勿传 node_modules）
    8) sudo bash scripts/install-env/apply-dist.sh

  细节：scripts/deploy-windows/README.txt


--------------------------------------------------------------------------------
四、日常运维速查
--------------------------------------------------------------------------------

  场景                              执行
  --------------------------------  ------------------------------------------
  装服务器环境                       sudo bash scripts/install-env/install.sh
  纯 Linux 拉代码                    sudo bash scripts/deploy/ops/pull.sh
  写业务配置                         sudo bash scripts/install-env/configure.sh
  Linux 只编译                       sudo bash scripts/deploy/run/build.sh
  Linux 一键发版                     sudo bash scripts/deploy/ops/publish.sh
  启停                               scripts/deploy/run/start|restart|stop.sh
  Windows 本机编译                   scripts\deploy-windows\build.ps1
  Windows 产物上线                   sudo bash scripts/install-env/apply-dist.sh
  Windows 远程重启/停止              scripts\deploy-windows\restart.ps1 / stop.ps1


--------------------------------------------------------------------------------
五、别搞混
--------------------------------------------------------------------------------

  install.sh     只装环境，不要代码也可以
  pull.sh        只拉/克隆代码到 APP_ROOT（纯 Linux）
  configure.sh   有代码后写 .env + systemd（L/W 都要）
  build.sh       只编译
  publish.sh     日常一键（可选 pull + build + restart），不是首次第一步
  apply-dist.sh  Windows 产物在 Linux 上装依赖并重启（与 install 同目录，读同级 floworder.conf）
================================================================================
