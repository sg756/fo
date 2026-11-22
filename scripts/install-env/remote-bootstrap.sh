#!/usr/bin/env bash
# ============================================================
#  空 Linux 一键：拉安装脚本 + 拉 dist-release.zip + 装环境 + 启动
#  必须带数据库账号/密码（库名可选，默认 users_manager）：
#    curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh \
#      | sudo bash -s -- --db-user=users_flow --db-pass='你的密码'
#    curl ... | sudo bash -s -- --db-user=users_flow --db-pass='你的密码' --db-name=users_manager
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-user=*) FO_DB_USER="${1#*=}" ;;
    --db-pass=*) FO_DB_PASS="${1#*=}" ;;
    --db-name=*) FO_DB_NAME="${1#*=}" ;;
    --db-user) shift; FO_DB_USER="${1:-}" ;;
    --db-pass) shift; FO_DB_PASS="${1:-}" ;;
    --db-name) shift; FO_DB_NAME="${1:-}" ;;
    -h|--help)
      echo "用法: curl ... | sudo bash -s -- --db-user=账号 --db-pass=密码 [--db-name=库名]"
      exit 0
      ;;
    *)
      echo "未知参数: $1（需要 --db-user / --db-pass）" >&2
      exit 1
      ;;
  esac
  shift
done
FO_DB_NAME="${FO_DB_NAME:-users_manager}"
if [[ -z "${FO_DB_USER}" || -z "${FO_DB_PASS}" ]]; then
  echo "一键安装必须指定 --db-user 与 --db-pass。" >&2
  echo "示例: curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash -s -- --db-user=users_flow --db-pass='你的密码'" >&2
  exit 1
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
exec env FLOWORDER_UNIX=1 \
  GITHUB_REPO="${REPO}" \
  GITHUB_RELEASE_TAG="${GITHUB_RELEASE_TAG:-dist}" \
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
  DB_USER="${FO_DB_USER}" \
  DB_PASS="${FO_DB_PASS}" \
  DB_NAME="${FO_DB_NAME}" \
  bash "${WORKDIR}/bootstrap.sh" \
  --db-user="${FO_DB_USER}" \
  --db-pass="${FO_DB_PASS}" \
  --db-name="${FO_DB_NAME}"
