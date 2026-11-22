#!/usr/bin/env bash
# ============================================================
#  空 Linux 一键：拉安装脚本 + 拉 dist-release.zip + 装环境 + 启动
#  必须带数据库账号/密码（库名可选，默认 users_manager）：
#    curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh \
#      | sudo bash -s -- --db-user=users_flow --db-pass='你的密码' --mysql-root-pass='你的root密码'
#    再跑同一条即更新程序，不改 .env 里的私钥、助记词、JWT、管理员密码。
#  私有仓加：-H "Authorization: Bearer $GH_TOKEN"
# ============================================================
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：curl ... | sudo bash -s -- --db-user=... --db-pass=..." >&2
  exit 1
fi

# 先解析参数（未传则立刻报错，避免白下脚本）
# shellcheck disable=SC1091
# common 尚未下载：这里先做最小校验
FO_DB_USER="${DB_USER:-}"
FO_DB_PASS="${DB_PASS:-}"
FO_DB_NAME="${DB_NAME:-}"
FO_MYSQL_ROOT_PASS="${MYSQL_ROOT_PASSWORD:-}"
FO_APP_ROOT="${FO_APP_ROOT:-${APP_ROOT:-}}"
FO_GH_TOKEN="${FO_GH_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-user=*) FO_DB_USER="${1#*=}" ;;
    --db-pass=*) FO_DB_PASS="${1#*=}" ;;
    --db-name=*) FO_DB_NAME="${1#*=}" ;;
    --mysql-root-pass=*) FO_MYSQL_ROOT_PASS="${1#*=}" ;;
    --app-root=*) FO_APP_ROOT="${1#*=}" ;;
    --gh-token=*) FO_GH_TOKEN="${1#*=}" ;;
    --db-user) shift; FO_DB_USER="${1:-}" ;;
    --db-pass) shift; FO_DB_PASS="${1:-}" ;;
    --db-name) shift; FO_DB_NAME="${1:-}" ;;
    --mysql-root-pass) shift; FO_MYSQL_ROOT_PASS="${1:-}" ;;
    --app-root) shift; FO_APP_ROOT="${1:-}" ;;
    --gh-token) shift; FO_GH_TOKEN="${1:-}" ;;
    -h|--help)
      echo "用法: curl ... | sudo bash -s -- --db-user=账号 --db-pass=密码 --mysql-root-pass=root密码 [--db-name=库名]"
      echo "  APP_ROOT 解压后自动扫描。root 密码必须自己填。再跑同一条即更新，不改私钥。"
      exit 0
      ;;
    *)
      echo "未知参数: $1（需要 --db-user / --db-pass / --mysql-root-pass）" >&2
      exit 1
      ;;
  esac
  shift
done
FO_DB_NAME="${FO_DB_NAME:-users_manager}"
missing=()
[[ -z "${FO_DB_USER}" ]] && missing+=("--db-user")
[[ -z "${FO_DB_PASS}" ]] && missing+=("--db-pass")
[[ -z "${FO_MYSQL_ROOT_PASS}" ]] && missing+=("--mysql-root-pass")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "一键安装缺少: ${missing[*]}" >&2
  echo "示例: curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash -s -- --db-user=users_flow --db-pass='你的密码' --mysql-root-pass='你的root密码'" >&2
  exit 1
fi
if [[ -n "${FO_GH_TOKEN}" ]]; then
  export GH_TOKEN="${FO_GH_TOKEN}"
  export GITHUB_TOKEN="${FO_GH_TOKEN}"
fi

REPO="${GITHUB_REPO:-sg756/fo}"
BRANCH="${GITHUB_BRANCH:-main}"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/install-env"
WORKDIR="$(mktemp -d /tmp/fo-boot-XXXX)"

echo "==> 下载安装脚本 ${REPO}@${BRANCH} → ${WORKDIR}"
if ! command -v curl >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf -y install curl ca-certificates
  else
    echo "需要 curl" >&2
    exit 1
  fi
fi

curl_raw() {
  local url=$1
  local out=$2
  local args=(-fsSL --retry 3 -o "$out")
  if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
    args+=(-H "Authorization: Bearer ${GH_TOKEN:-${GITHUB_TOKEN}}")
  fi
  curl "${args[@]}" "$url"
}

files=(
  common.sh
  floworder.conf
  install.sh
  configure.sh
  apply-dist.sh
  bootstrap.sh
  fetch-dist.sh
  export-db.sh
)
for f in "${files[@]}"; do
  curl_raw "${BASE}/${f}" "${WORKDIR}/${f}"
  sed -i 's/\r$//' "${WORKDIR}/${f}" 2>/dev/null || true
  chmod +x "${WORKDIR}/${f}" 2>/dev/null || true
done

echo "==> 执行 bootstrap（装环境、拉发布包、启动）DB_USER=${FO_DB_USER} DB_NAME=${FO_DB_NAME}"
BOOT_ARGS=(
  --db-user="${FO_DB_USER}"
  --db-pass="${FO_DB_PASS}"
  --db-name="${FO_DB_NAME}"
  --mysql-root-pass="${FO_MYSQL_ROOT_PASS}"
)
if [[ -n "${FO_APP_ROOT}" ]]; then
  BOOT_ARGS+=(--app-root="${FO_APP_ROOT}")
fi
if [[ -n "${FO_GH_TOKEN}" ]]; then
  BOOT_ARGS+=(--gh-token="${FO_GH_TOKEN}")
fi
exec env FLOWORDER_UNIX=1 \
  GITHUB_REPO="${REPO}" \
  GITHUB_RELEASE_TAG="${GITHUB_RELEASE_TAG:-dist}" \
  GH_TOKEN="${FO_GH_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}" \
  DB_USER="${FO_DB_USER}" \
  DB_PASS="${FO_DB_PASS}" \
  DB_NAME="${FO_DB_NAME}" \
  MYSQL_ROOT_PASSWORD="${FO_MYSQL_ROOT_PASS}" \
  FO_DB_USER="${FO_DB_USER}" \
  FO_DB_PASS="${FO_DB_PASS}" \
  FO_DB_NAME="${FO_DB_NAME}" \
  FO_MYSQL_ROOT_PASS="${FO_MYSQL_ROOT_PASS}" \
  FO_APP_ROOT="${FO_APP_ROOT}" \
  bash "${WORKDIR}/bootstrap.sh" "${BOOT_ARGS[@]}"
