#!/usr/bin/env bash
# ============================================================
#  run · 停止服务
#  sudo bash scripts/deploy/run/stop.sh
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

SERVICE_NAME="${SERVICE_NAME:-users-manager}"

if [[ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  echo "未找到 ${SERVICE_NAME}.service。请先 scripts/install-env/configure.sh" >&2
  exit 1
fi

echo "==> 停止 ${SERVICE_NAME}"
systemctl stop "${SERVICE_NAME}.service"
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo
echo "已停止。"
echo "  再启动: sudo bash ${SCRIPT_DIR}/start.sh"
