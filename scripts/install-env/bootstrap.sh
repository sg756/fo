#!/usr/bin/env bash
# ============================================================
#  一键：装环境 → 拉 GitHub dist-release.zip → configure（无 .env）→ apply-dist
#    sudo bash scripts/install-env/bootstrap.sh
#  空机器：
#    curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash
# ============================================================
[ "${FLOWORDER_UNIX:-0}" = 1 ] || { _d="$(cd "$(dirname "$0")" && pwd)"; for _f in "$_d"/*.sh "$_d"/*.conf; do [ -f "$_f" ] && sed -i 's/\r$//' "$_f" 2>/dev/null || true; done; exec env FLOWORDER_UNIX=1 bash "$0" "$@"; } #

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./common.sh

require_root
source_conf

APP_ROOT="$(resolve_app_root "${APP_ROOT:-/opt/dist-release}")"
APP_ROOT="${APP_ROOT:-/opt/dist-release}"
SCRIPT_DIR="$(pwd)"
sync_app_root_conf "${APP_ROOT}"

echo "==> 【bootstrap】发布目录 APP_ROOT=${APP_ROOT}"
echo "==> 1/3 安装服务器环境（Node、运行用户、MariaDB、防火墙）"
bash "${SCRIPT_DIR}/install.sh"

echo
echo "==> 2/3 从 GitHub 拉取 dist-release.zip（保留 .env / logs / backup）"
# install 可能改写了同目录 floworder.conf（DB 密码），拉包前再读一次
source_conf
APP_ROOT="$(resolve_app_root "${APP_ROOT:-/opt/dist-release}")"
APP_ROOT="${APP_ROOT:-/opt/dist-release}"
fetch_github_dist "${APP_ROOT}"
sync_app_root_conf "${APP_ROOT}"

# 把当前安装脚本同步进 APP_ROOT；conf 以 SCRIPT_DIR 为准（install 可能已写回 DB 密码）
mkdir -p "${APP_ROOT}/scripts/install-env"
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
  echo "==> 3/3 写 .env + systemd（首次）"
  # configure / apply 读「脚本同目录」conf；若在 /tmp 跑，用当前 SCRIPT_DIR
  bash "${SCRIPT_DIR}/configure.sh"
else
  echo "==> 3/3 已有 apps/api/.env，跳过 configure（密钥保留）"
fi

echo
echo "==> 应用发布包：npm + prisma + 重启"
bash "${SCRIPT_DIR}/apply-dist.sh"

echo
echo "【bootstrap】完成。"
echo "  管理端: http://服务器IP:${PORT:-80}/"
echo "  API:    http://服务器IP:${PORT:-80}/api"
echo "  管理员账号见 apps/api/.env 的 ADMIN_EMAIL / ADMIN_PASSWORD（seed 首次写入）。"
