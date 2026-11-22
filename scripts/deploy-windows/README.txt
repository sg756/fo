Windows 构建与发布流程
============================================================

本目录 = Windows 本机编译（build.ps1）。
Linux 上应用产物 = ../install-env/apply-dist.sh（与 install / floworder.conf 同目录）。


--------------------------------------------------------------------------------
执行前要配置什么
--------------------------------------------------------------------------------

  【服务器】编辑 ../install-env/floworder.conf
    APP_ROOT、PORT、DB_PASS 等

  【本机 Windows】没有 build.conf 时从 build.conf.example 复制（脚本会自动复制；build.conf 不进 Git）
    SOURCE_ROOT  本机源码根（编译输入；空=仓库根）
    RELEASE_DIR  上传包输出（编译输出；空=SOURCE_ROOT\dist-release）
    NODE_HOME    便携 Node 目录
    SKIP_CONFIRM / PRISMA_MODE 等（见文件内注释）


--------------------------------------------------------------------------------
脚本执行顺序（完整）
--------------------------------------------------------------------------------

  —— 服务器首次 ——
  1. 改 install-env/floworder.conf
  2. sudo bash scripts/install-env/install.sh
  3. 把代码放到服务器 APP_ROOT（上传整仓，或保证 configure 能找到 apps/api）
  4. sudo bash scripts/install-env/configure.sh
     改 apps/api/.env 生产密钥

  —— 本机每次发版 ——
  5. （可选）改 build.conf
  6. powershell -ExecutionPolicy Bypass -File scripts\deploy-windows\build.ps1
     编完后会生成：
       dist-release\apps\admin\dist\
       dist-release\apps\api\dist\ …
       dist-release\scripts\install-env\
       仓库根 dist-release.zip（上传到 GitHub Release tag=dist，资产名必须一致）

  —— 再回服务器 ——
  推荐：sudo bash scripts/install-env/fetch-dist.sh（从 Release 拉 zip）
  或把 dist-release\ 内容覆盖到 APP_ROOT 后再：
     sudo bash scripts/install-env/apply-dist.sh
  空机器首次也可：
     curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash


目录文件：
  build.conf / build.ps1 / README.txt
  （apply-dist 在 ../install-env/）

  直接在 Linux 上启停：
    sudo bash scripts/deploy/run/start.sh
    sudo bash scripts/deploy/run/restart.sh
    sudo bash scripts/deploy/run/stop.sh
