#!/usr/bin/env bash
# ============================================================
#  Windows 发布链路 · 在 Linux 服务器上执行（不要在 Windows 上跑）
#  作用：应用本机 build.ps1 编好的 dist → npm ci + prisma + 重启
#  前置：同目录 install.sh + configure.sh
#  配置：同目录 floworder.conf（与 install 一样，不往上找）
#  sudo bash scripts/install-env/apply-dist.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/floworder.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 在 Linux 上执行：sudo bash $0" >&2
  exit 1
fi

if [[ ! -f "${CONF_FILE}" ]]; then
  echo "找不到配置: ${CONF_FILE}" >&2
  echo "请把 floworder.conf 与本脚本放在同一目录（与 install.sh 相同）。" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

APP_ROOT="${APP_ROOT:-/opt/users-manager}"
RUN_USER="${RUN_USER:-users-manager}"
SERVICE_NAME="${SERVICE_NAME:-users-manager}"
PORT="${PORT:-80}"
PRISMA_MODE="${PRISMA_MODE:-push}"

ADMIN_DIR="${APP_ROOT}/apps/admin"
API_DIR="${APP_ROOT}/apps/api"

if [[ ! -f "${ADMIN_DIR}/dist/index.html" ]]; then
  echo "缺少 ${ADMIN_DIR}/dist/index.html。请先本机 build.ps1 并上传到 APP_ROOT" >&2
  exit 1
fi
if [[ ! -f "${API_DIR}/dist/main.js" ]]; then
  echo "缺少 ${API_DIR}/dist/main.js。请先本机 build.ps1 并上传到 APP_ROOT" >&2
  exit 1
fi
if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "运行用户不存在: ${RUN_USER}。请先执行 ${SCRIPT_DIR}/install.sh" >&2
  exit 1
fi
if [[ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  echo "未找到 ${SERVICE_NAME}.service。请先执行 ${SCRIPT_DIR}/configure.sh" >&2
  exit 1
fi

echo "==> 应用目录: ${APP_ROOT}"
echo "==> 配置来自: ${CONF_FILE}"

if [[ ! -f "${API_DIR}/package.json" ]]; then
  echo "缺少 ${API_DIR}/package.json。请把 dist-release 内的 apps/api/package.json 一并上传" >&2
  exit 1
fi

# ---------- 权限：APP_ROOT 不能放在 /root 下（/root 默认 700，业务用户进不去）----------
# 日志里 EACCES open package-lock / .npmrc，最终被 npm 误报成「没有 lock」
RUN_AS_ROOT_NPM=0
if ! sudo -u "${RUN_USER}" test -x "${APP_ROOT}" 2>/dev/null \
  || ! sudo -u "${RUN_USER}" test -r "${API_DIR}/package.json" 2>/dev/null; then
  echo "==> 权限问题：用户 ${RUN_USER} 无法访问 ${APP_ROOT}" >&2
  echo "    典型原因：APP_ROOT 在 /root 下，而 /root 目录权限是 700（仅 root 可进）。" >&2
  echo "    npm 读不到 package-lock.json 时会误报「没有 lock」。" >&2
  echo "    建议：把 APP_ROOT 改到 /opt/users-manager 等目录，而不是 /root/..." >&2
  if [[ "${APP_ROOT}" == /root/* || "${APP_ROOT}" == /root ]]; then
    echo "    本次临时用 root 执行 npm，装完再 chown 给 ${RUN_USER}（权宜之计）。" >&2
    RUN_AS_ROOT_NPM=1
  else
    echo "    请先修复目录权限（chmod/chown 整条路径），再重试。" >&2
    exit 1
  fi
fi

echo "==> 安装 API 生产依赖（Linux 原生引擎，勿沿用 Windows 的 node_modules）"
chown -R "${RUN_USER}:${RUN_USER}" "${API_DIR}" || true
NPM_CACHE="/var/tmp/${RUN_USER}-npm-cache"
mkdir -p "${NPM_CACHE}"
chown -R "${RUN_USER}:${RUN_USER}" "${NPM_CACHE}"

LOCK="${API_DIR}/package-lock.json"
echo "    检查 lock："
ls -la "${API_DIR}/package.json" "${LOCK}" 2>&1 || true
if [[ -e "${LOCK}" ]]; then
  echo "    lock 大小: $(wc -c < "${LOCK}" | tr -d ' ') 字节"
fi

lock_ok=0
if [[ -s "${LOCK}" ]] && grep -q '"lockfileVersion"' "${LOCK}"; then
  lock_ok=1
fi

rm -rf "${API_DIR}/node_modules"

run_npm() {
  if [[ "${RUN_AS_ROOT_NPM}" -eq 1 ]]; then
    npm "$@" --prefix "${API_DIR}" --cache "${NPM_CACHE}"
  else
    sudo -u "${RUN_USER}" env HOME="${NPM_CACHE}" \
      npm "$@" --prefix "${API_DIR}" --cache "${NPM_CACHE}"
  fi
}

if [[ "${lock_ok}" -eq 1 ]]; then
  echo "    使用 npm ci"
  if ! run_npm ci; then
    echo "    npm ci 失败，回退 npm install --omit=dev" >&2
    run_npm install --omit=dev
  fi
else
  echo "    package-lock.json 无效（缺失/空/无 lockfileVersion）→ npm install --omit=dev" >&2
  run_npm install --omit=dev
fi

if [[ ! -f "${API_DIR}/prisma/schema.prisma" ]]; then
  echo "缺少 ${API_DIR}/prisma/schema.prisma。" >&2
  echo "请确认 Windows 发布包已上传 apps/api/prisma/（含 schema.prisma、seed.js）。" >&2
  exit 1
fi

echo "==> prisma generate"
if [[ "${RUN_AS_ROOT_NPM}" -eq 1 ]]; then
  (cd "${API_DIR}" && npx prisma generate)
else
  sudo -u "${RUN_USER}" env HOME="${NPM_CACHE}" bash -c "cd '${API_DIR}' && npx prisma generate"
fi

if [[ -d "${ADMIN_DIR}/node_modules" ]]; then
  echo "==> 清理 admin/node_modules（静态托管不需要）"
  rm -rf "${ADMIN_DIR}/node_modules"
fi

echo "==> 数据库同步 (PRISMA_MODE=${PRISMA_MODE})"
case "${PRISMA_MODE}" in
  deploy)
    if [[ "${RUN_AS_ROOT_NPM}" -eq 1 ]]; then
      (cd "${API_DIR}" && npx prisma migrate deploy)
    else
      sudo -u "${RUN_USER}" env HOME="${NPM_CACHE}" bash -c "cd '${API_DIR}' && npx prisma migrate deploy"
    fi
    ;;
  push)
    echo "==> 修复 users.user_no（回填空值 + AUTO_INCREMENT）"
    if [[ "${RUN_AS_ROOT_NPM}" -eq 1 ]]; then
      (cd "${API_DIR}" && node scripts/fix-user-no.js)
      (cd "${API_DIR}" && npx prisma db push)
    else
      sudo -u "${RUN_USER}" env HOME="${NPM_CACHE}" bash -c "cd '${API_DIR}' && node scripts/fix-user-no.js"
      sudo -u "${RUN_USER}" env HOME="${NPM_CACHE}" bash -c "cd '${API_DIR}' && npx prisma db push"
    fi
    ;;
  skip|none) echo "    跳过 Prisma" ;;
  *) echo "未知 PRISMA_MODE=${PRISMA_MODE}（deploy|push|skip）" >&2; exit 1 ;;
esac

if [[ "${PRISMA_MODE}" != "skip" && "${PRISMA_MODE}" != "none" ]]; then
  if [[ -f "${API_DIR}/prisma/seed.js" ]]; then
    echo "==> 数据库种子 (prisma/seed.js，幂等)"
    if [[ "${RUN_AS_ROOT_NPM}" -eq 1 ]]; then
      (cd "${API_DIR}" && node prisma/seed.js)
    else
      sudo -u "${RUN_USER}" env HOME="${NPM_CACHE}" bash -c "cd '${API_DIR}' && node prisma/seed.js"
    fi
  else
    echo "警告: 缺少 ${API_DIR}/prisma/seed.js，跳过 seed（管理端可能无默认管理员）" >&2
  fi
fi

chown -R "${RUN_USER}:${RUN_USER}" "${APP_ROOT}" || true

echo "==> 重启 ${SERVICE_NAME}"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}.service"
sleep 1
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo
echo "Windows 产物已应用到 Linux 并重启。"
if [[ "${RUN_AS_ROOT_NPM}" -eq 1 ]]; then
  echo "  警告: APP_ROOT 仍在 /root 下。请尽快改到 /opt/users-manager 一类目录，否则服务用户可能无法读文件。"
fi
echo "  管理端: http://服务器IP:${PORT}/"
echo "  API:    http://服务器IP:${PORT}/api"
echo "  日志:   tail -f ${LOG_DIR:-${APP_ROOT:-/opt/users-manager}/logs}/api-$(date +%Y-%m-%d).log"
