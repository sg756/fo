#!/usr/bin/env bash
# ============================================================
#  run · 启动服务
#  sudo bash scripts/deploy/run/start.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPTS_ROOT="$(cd "${DEPLOY_ROOT}/.." && pwd)"
CONF_FILE="${SCRIPTS_ROOT}/install-env/floworder.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash $0" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

PORT="${PORT:-80}"
SERVICE_NAME="${SERVICE_NAME:-users-manager}"
API_DIR="${APP_ROOT:-/opt/users-manager}/apps/api"

if [[ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  echo "未找到 ${SERVICE_NAME}.service。请先 scripts/install-env/configure.sh" >&2
  exit 1
fi
if [[ ! -f "${API_DIR}/dist/main.js" ]]; then
  echo "未找到 ${API_DIR}/dist/main.js。请先 run/build.sh 或 ops/publish.sh" >&2
  exit 1
fi

echo "==> 启动 ${SERVICE_NAME}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
systemctl start "${SERVICE_NAME}.service"
sleep 1
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo
echo "已启动。"
echo "  管理端: http://服务器IP:${PORT}/"
echo "  API:    http://服务器IP:${PORT}/api"
echo "  日志:   tail -f ${LOG_DIR:-${APP_ROOT:-/opt/users-manager}/logs}/api-$(date +%Y-%m-%d).log"
