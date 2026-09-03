ops/ · 纯 Linux 拉代码 + 日常发版
============================================================

配置：../../install-env/floworder.conf
装环境：先 ../../install-env/install.sh


文件：
  pull.sh      ← 拉代码 / 首次按 GIT_REPO_URL 克隆到 APP_ROOT
  publish.sh   ← 日常一键：可选 pull → build → restart（不是首次第一步）


--------------------------------------------------------------------------------
执行前配置（pull.sh）
--------------------------------------------------------------------------------

  在 floworder.conf：
    APP_ROOT        目标目录
    GIT_REPO_URL    首次克隆必填（已有 .git 后只需 pull，可不改）
    GIT_BRANCH      默认 main
    RUN_USER        须已由 install.sh 创建


--------------------------------------------------------------------------------
pull.sh 行为
--------------------------------------------------------------------------------

  · APP_ROOT 已有 .git  → git pull --ff-only
  · APP_ROOT 为空        → git clone GIT_REPO_URL（需已配置）
  · APP_ROOT 非空无 .git → 报错，避免覆盖


命令：
  sudo bash scripts/deploy/ops/pull.sh

首次拉完后：
  sudo bash scripts/install-env/configure.sh


--------------------------------------------------------------------------------
publish.sh
--------------------------------------------------------------------------------

  前置：已 configure，APP_ROOT 已有完整仓库
  GIT_PULL=true 时会自动 pull；false 时请先跑 pull.sh

  sudo bash scripts/deploy/ops/publish.sh
