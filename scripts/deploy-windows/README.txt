Windows 构建与发布流程
============================================================

本目录 = Windows 本机编译（build.ps1）。
Linux 上应用产物 = ../install-env/apply-dist.sh（与 install / floworder.conf 同目录）。


--------------------------------------------------------------------------------
执行前要配置什么
--------------------------------------------------------------------------------

  【服务器】编辑 ../install-env/floworder.conf
    APP_ROOT、PORT、DB_PASS 等

  【本机 Windows】编辑 build.conf
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
     编完后会生成发布包（默认仓库根下 dist-release\），结构与 Linux APP_ROOT 一致：
       dist-release\apps\admin\dist\
       dist-release\apps\api\dist\
       dist-release\apps\api\package.json
       dist-release\apps\api\package-lock.json
       dist-release\apps\api\prisma\

  —— 再回服务器 ——
  7. 把 dist-release\ 里的内容覆盖到服务器 APP_ROOT（不要传 node_modules）
     例：rsync / scp / 面板上传，使服务器出现：
       APP_ROOT/apps/admin/dist/...
       APP_ROOT/apps/api/dist/...
       APP_ROOT/apps/api/package.json 等
     无需改名。
  8. sudo bash scripts/install-env/apply-dist.sh
     （与 install.sh、floworder.conf 同一目录，只读同级 conf）


目录文件：
  build.conf / build.ps1 / README.txt
  （apply-dist 在 ../install-env/）

  直接在 Linux 上启停：
    sudo bash scripts/deploy/run/start.sh
    sudo bash scripts/deploy/run/restart.sh
    sudo bash scripts/deploy/run/stop.sh
