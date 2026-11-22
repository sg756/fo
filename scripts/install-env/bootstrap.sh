#!/usr/bin/env bash
# ============================================================
#  一键：装环境 → 拉 GitHub dist-release.zip → 扫描 APP_ROOT → configure → apply-dist
#  必须带数据库账号/密码；APP_ROOT 解压后自动扫描填写：
#    sudo bash scripts/install-env/bootstrap.sh --db-user=users_flow --db-pass='你的密码'
# ============================================================
[ "${FLOWORDER_UNIX:-0}" = 1 ] || { _d="$(cd "$(dirname "$0")" && pwd)"; for _f in "$_d"/*.sh "$_d"/*.conf; do [ -f "$_f" ] && sed -i 's/\r$//' "$_f" 2>/dev/null || true; done; exec env FLOWORDER_UNIX=1 bash "$0" "$@"; } #

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./common.sh

require_root
parse_bootstrap_args "$@"
require_db_creds
source_conf
write_db_creds_conf ./floworder.conf

# 解压前：已有包则扫到源码根；空机用默认 /opt/dist-release
STAGE_ROOT="$(resolve_app_root "${APP_ROOT:-}")"
STAGE_ROOT="${STAGE_ROOT:-$(default_install_root)}"
APP_ROOT="${STAGE_ROOT}"
export APP_ROOT
SCRIPT_DIR="$(pwd)"
sync_app_root_conf "${APP_ROOT}"

echo "==> 【bootstrap】下载/覆盖目标 STAGE=${STAGE_ROOT}（完成后会扫描真实 APP_ROOT）"
echo "==> 数据库 DB_NAME=${DB_NAME} DB_USER=${DB_USER}"
echo "==> 1/3 安装服务器环境（Node、运行用户、MariaDB、防火墙）"
bash "${SCRIPT_DIR}/install.sh"

echo
echo "==> 2/3 从 GitHub 拉取 dist-release.zip（保留 .env / logs / backup）"
source_conf
write_db_creds_conf ./floworder.conf
# install 可能改写了 conf；保持 STAGE
sync_app_root_conf "${STAGE_ROOT}"
fetch_github_dist "${STAGE_ROOT}"
APP_ROOT="$(finalize_app_root_after_extract "${STAGE_ROOT}")"
export APP_ROOT

# 同步脚本；conf 以当前（含 DB + 扫描到的 APP_ROOT）为准
mkdir -p "${APP_ROOT}/scripts/install-env"
write_db_creds_conf ./floworder.conf
sync_app_root_conf "${APP_ROOT}"
cp -a "${SCRIPT_DIR}/floworder.conf" "${APP_ROOT}/scripts/install-env/floworder.conf"
for f in common.sh install.sh configure.sh apply-dist.sh bootstrap.sh fetch-dist.sh export-db.sh remote-bootstrap.sh; do
  if [[ -f "${SCRIPT_DIR}/${f}" ]]; then
    cp -a "${SCRIPT_DIR}/${f}" "${APP_ROOT}/scripts/install-env/${f}"
    sed -i 's/\r$//' "${APP_ROOT}/scripts/install-env/${f}" 2>/dev/null || true
    chmod +x "${APP_ROOT}/scripts/install-env/${f}" 2>/dev/null || true
  fi
done
sync_app_root_conf "${APP_ROOT}"

echo
if [[ ! -f "${APP_ROOT}/apps/api/.env" ]]; then
  echo "==> 3/3 写 .env + systemd（首次）APP_ROOT=${APP_ROOT}"
  bash "${SCRIPT_DIR}/configure.sh"
else
  echo "==> 3/3 已有 apps/api/.env，跳过 configure（密钥保留）APP_ROOT=${APP_ROOT}"
fi

echo
echo "==> 应用发布包：npm + prisma + 重启"
bash "${SCRIPT_DIR}/apply-dist.sh"

echo
echo "【bootstrap】完成。"
echo "  APP_ROOT: ${APP_ROOT}"
echo "  管理端: http://服务器IP:${PORT:-80}/"
echo "  API:    http://服务器IP:${PORT:-80}/api"
echo "  业务库: ${DB_NAME} / ${DB_USER}"
echo "  管理员账号见 apps/api/.env 的 ADMIN_EMAIL / ADMIN_PASSWORD（seed 首次写入）。"
