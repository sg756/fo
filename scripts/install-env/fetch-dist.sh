#!/usr/bin/env bash
# ============================================================
#  从 GitHub Release 覆盖发布包到 APP_ROOT，扫描真实源码根，然后 apply-dist
#  sudo bash scripts/install-env/fetch-dist.sh
# ============================================================
[ "${FLOWORDER_UNIX:-0}" = 1 ] || { _d="$(cd "$(dirname "$0")" && pwd)"; for _f in "$_d"/*.sh "$_d"/*.conf; do [ -f "$_f" ] && sed -i 's/\r$//' "$_f" 2>/dev/null || true; done; exec env FLOWORDER_UNIX=1 bash "$0" "$@"; } #

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./common.sh

require_root
source_conf

STAGE_ROOT="$(resolve_app_root "${APP_ROOT:-}")"
STAGE_ROOT="${STAGE_ROOT:-$(default_install_root)}"
SCRIPT_DIR="$(pwd)"
sync_app_root_conf "${STAGE_ROOT}"

fetch_github_dist "${STAGE_ROOT}"
APP_ROOT="$(finalize_app_root_after_extract "${STAGE_ROOT}")"
export APP_ROOT
sync_app_root_conf "${APP_ROOT}"

echo
echo "==> 应用发布包并重启 APP_ROOT=${APP_ROOT}"
bash "${SCRIPT_DIR}/apply-dist.sh"
