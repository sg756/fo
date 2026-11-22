#!/usr/bin/env bash
# ============================================================
#  空 Linux 一键：拉安装脚本 + 拉 dist-release.zip + 装环境 + 启动
#  空机器上执行（不要先上传代码）：
#    curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash
#  私有仓：
#    curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#      https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash
# ============================================================
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：curl ... | sudo bash" >&2
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

echo "==> 执行 bootstrap（装环境、拉发布包、写配置、启动）"
exec env FLOWORDER_UNIX=1 \
  GITHUB_REPO="${REPO}" \
  GITHUB_RELEASE_TAG="${GITHUB_RELEASE_TAG:-dist}" \
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
  bash "${WORKDIR}/bootstrap.sh"
