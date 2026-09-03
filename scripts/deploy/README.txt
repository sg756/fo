deploy/ · 纯 Linux 编译与运维（不含「装环境」）
============================================================

装环境不在本目录！先看：
  ../install-env/     ← 【公共】L / W 都要先装环境
  ../README.txt       ← 总说明（含完整顺序与执行前配置）

本目录：
  run/     编译 build / 启停 start|restart|stop
  ops/     pull.sh（拉代码） / publish.sh（日常一键发版）

配置文件：../install-env/floworder.conf


--------------------------------------------------------------------------------
执行前要配置什么
--------------------------------------------------------------------------------

  编辑 ../install-env/floworder.conf：
    APP_ROOT       代码目录（必填）
    DB_PASS 等     库账号（必填，生产改强密码）
    GIT_REPO_URL   首次用 ops/pull.sh 克隆时必填
    GIT_BRANCH     分支，默认 main
    GIT_PULL       仅影响 publish.sh 是否自动 pull


--------------------------------------------------------------------------------
纯 Linux 脚本执行顺序（首次）
--------------------------------------------------------------------------------

  1. 改好 floworder.conf（含 GIT_REPO_URL）
  2. sudo bash scripts/install-env/install.sh
  3. sudo bash scripts/deploy/ops/pull.sh          ← 拉/克隆代码
  4. sudo bash scripts/install-env/configure.sh
     改 APP_ROOT/apps/api/.env 密钥（JWT / ENC_KEY 等；HD_MNEMONIC 首次自动生成后勿改）
  5. sudo bash scripts/deploy/run/build.sh
  6. sudo bash scripts/deploy/run/start.sh


--------------------------------------------------------------------------------
日常（已上线）
--------------------------------------------------------------------------------

  只更新代码：
    sudo bash scripts/deploy/ops/pull.sh
    sudo bash scripts/deploy/run/build.sh
    sudo bash scripts/deploy/run/restart.sh

  一键：
    sudo bash scripts/deploy/ops/publish.sh
    （是否自动 pull 看 conf 的 GIT_PULL；也可先手动 pull.sh）


Windows 发版 → ../deploy-windows/（服务器仍须先跑 install-env；不用本目录 pull.sh）
