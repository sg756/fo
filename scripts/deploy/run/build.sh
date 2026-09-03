#!/usr/bin/env bash
# ============================================================
#  run · 仅构建（不拉代码、不启停）
#  sudo bash scripts/deploy/run/build.sh
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

APP_ROOT="${APP_ROOT:-/opt/users-manager}"
RUN_USER="${RUN_USER:-users-manager}"
PRISMA_MODE="${PRISMA_MODE:-push}"

ADMIN_DIR="${APP_ROOT}/apps/admin"
API_DIR="${APP_ROOT}/apps/api"

if [[ ! -d "${ADMIN_DIR}" || ! -d "${API_DIR}" ]]; then
  echo "目录不完整，需要 ${ADMIN_DIR} 与 ${API_DIR}" >&2
  exit 1
fi
if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "运行用户不存在: ${RUN_USER}。请先 scripts/install-env/install.sh" >&2
  exit 1
fi
if [[ ! -f "${API_DIR}/.env" ]]; then
  echo "缺少 ${API_DIR}/.env。请先 scripts/install-env/configure.sh" >&2
  exit 1
fi

echo "==> 构建管理端 admin"
cd "${ADMIN_DIR}"
sudo -u "${RUN_USER}" npm ci
sudo -u "${RUN_USER}" npm run build
if [[ ! -f "${ADMIN_DIR}/dist/index.html" ]]; then
  echo "admin 构建失败：找不到 dist/index.html" >&2
  exit 1
fi

echo "==> 构建 API"
cd "${API_DIR}"
sudo -u "${RUN_USER}" npm ci
sudo -u "${RUN_USER}" npx prisma generate
sudo -u "${RUN_USER}" npm run build
if [[ ! -f "${API_DIR}/dist/main.js" ]]; then
  echo "api 构建失败：找不到 dist/main.js" >&2
  exit 1
fi

echo "==> 数据库同步 (PRISMA_MODE=${PRISMA_MODE})"
case "${PRISMA_MODE}" in
  deploy) sudo -u "${RUN_USER}" npx prisma migrate deploy ;;
  push)   sudo -u "${RUN_USER}" npx prisma db push ;;
  skip|none) echo "    跳过 Prisma" ;;
  *) echo "未知 PRISMA_MODE=${PRISMA_MODE}" >&2; exit 1 ;;
esac

if [[ "${PRISMA_MODE}" != "skip" && "${PRISMA_MODE}" != "none" ]]; then
  if [[ -f "${API_DIR}/prisma/seed.js" ]]; then
    echo "==> 数据库种子 (prisma/seed.js，幂等)"
    sudo -u "${RUN_USER}" bash -c "cd '${API_DIR}' && node prisma/seed.js"
  else
    echo "警告: 缺少 ${API_DIR}/prisma/seed.js，跳过 seed（管理端可能无默认管理员）" >&2
  fi
fi

chown -R "${RUN_USER}:${RUN_USER}" "${APP_ROOT}"

echo
echo "【run/build】构建完成。"
echo "  启动: sudo bash ${SCRIPT_DIR}/start.sh"
