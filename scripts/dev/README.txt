本机 Windows 开发环境
============================================================

不装 MySQL 软件。Linux 生产请用 ../install-env/ ，不要跑这里。

文件：
  dev.conf           ← 可选：APP_ROOT / NODE_HOME
  install-dev.ps1    ← ① Node 20 + npm 依赖 + 复制 .env.dev / .env
  setup-dev-db.ps1   ← ② 检测 MySQL、按 .env 建库用户、prisma + seed
  README.txt         ← 本说明


顺序
  1. 本机先装好 MySQL 或 MariaDB，并启动服务
  2. powershell -ExecutionPolicy Bypass -File scripts\dev\install-dev.ps1
     没有 .env.dev / .env 时从 apps\api\.env.example 复制（已有不覆盖）
  3. 改 apps\api\.env.dev 和 .env 的 DATABASE_URL（两份保持一样）
  4. powershell -ExecutionPolicy Bypass -File scripts\dev\setup-dev-db.ps1
       · 没有 MySQL → 提示去装，不自动装
       · .env 用户能连 → 直接 prisma / seed
       · 用户还不存在 → 询问后用 root 按 .env 建库建用户
  5. 启动：
       cd apps\api    ; npm run start:dev
       cd apps\admin  ; npm run dev


说明
  Nest 开发读 .env.dev ；Prisma / seed 读 .env 。
  这两份不要提交、不要拿去盖生产服务器。
