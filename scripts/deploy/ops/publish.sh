#!/usr/bin/env bash
# ============================================================
#  ops · 日常一键发版（例外入口，非首次装机）
#  拉代码 → 构建 → 重启
#  前置：install-env 已完成 + APP_ROOT 已有仓库
#  sudo bash scripts/deploy/ops/publish.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPTS_ROOT="$(cd "${DEPLOY_ROOT}/.." && pwd)"
CONF_FILE="${SCRIPTS_ROOT}/install-env/floworder.conf"
RUN_DIR="${DEPLOY_ROOT}/run"
INSTALL_ENV="${SCRIPTS_ROOT}/install-env"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash $0" >&2
  exit 1
fi
if [[ ! -f "${CONF_FILE}" ]]; then
  echo "找不到配置文件: ${CONF_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

APP_ROOT="${APP_ROOT:-/opt/users-manager}"
PORT="${PORT:-80}"
SERVICE_NAME="${SERVICE_NAME:-users-manager}"
RUN_USER="${RUN_USER:-users-manager}"
GIT_PULL="${GIT_PULL:-true}"

ADMIN_DIR="${APP_ROOT}/apps/admin"
API_DIR="${APP_ROOT}/apps/api"
ENV_FILE="${API_DIR}/.env"

if [[ ! -d "${ADMIN_DIR}" || ! -d "${API_DIR}" ]]; then
  echo "APP_ROOT 下没有完整仓库: ${APP_ROOT}" >&2
  echo "请先 git clone/上传代码，再跑本脚本。" >&2
  exit 1
fi
if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "运行用户不存在。请先 ${INSTALL_ENV}/install.sh" >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]] || [[ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  echo "尚未完成业务配置（缺 .env 或 systemd）。" >&2
  echo "请先：sudo bash ${INSTALL_ENV}/configure.sh" >&2
  exit 1
fi

echo "==> 【ops/publish】发布目录: ${APP_ROOT}"
cd "${APP_ROOT}"

if [[ "${GIT_PULL}" == "true" || "${GIT_PULL}" == "1" ]]; then
  if [[ -d .git ]]; then
    echo "==> git pull"
    sudo -u "${RUN_USER}" git pull --ff-only
  else
    echo "==> 无 .git，跳过 git pull"
  fi
else
  echo "==> GIT_PULL=false，跳过 git pull"
fi

echo "==> 调用 run/build.sh"
bash "${RUN_DIR}/build.sh"

echo "==> 调用 run/restart.sh"
bash "${RUN_DIR}/restart.sh"

echo
echo "【ops/publish】发布完成。"
echo "  管理端: http://服务器IP:${PORT}/"
echo "  API:    http://服务器IP:${PORT}/api"
echo "  日志:   tail -f ${LOG_DIR:-${APP_ROOT:-/opt/users-manager}/logs}/api-$(date +%Y-%m-%d).log"
