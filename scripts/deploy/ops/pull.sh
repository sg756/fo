#!/usr/bin/env bash
# ============================================================
#  ops · 纯 Linux：拉取/首次克隆代码到 APP_ROOT
#  前置：已执行 install-env/install.sh（有 RUN_USER、APP_ROOT 目录）
#  配置：install-env/floworder.conf 里 APP_ROOT、GIT_REPO_URL、GIT_BRANCH
#  sudo bash scripts/deploy/ops/pull.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPTS_ROOT="$(cd "${DEPLOY_ROOT}/.." && pwd)"
CONF_FILE="${SCRIPTS_ROOT}/install-env/floworder.conf"
INSTALL_ENV="${SCRIPTS_ROOT}/install-env"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash $0" >&2
  exit 1
fi
if [[ ! -f "${CONF_FILE}" ]]; then
  echo "找不到配置文件: ${CONF_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

APP_ROOT="${APP_ROOT:-/opt/users-manager}"
RUN_USER="${RUN_USER:-users-manager}"
GIT_REPO_URL="${GIT_REPO_URL:-}"
GIT_BRANCH="${GIT_BRANCH:-main}"

if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "运行用户不存在: ${RUN_USER}。请先 ${INSTALL_ENV}/install.sh" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "==> 安装 git"
  dnf -y install git
fi

mkdir -p "${APP_ROOT}"
chown "${RUN_USER}:${RUN_USER}" "${APP_ROOT}"

# 已有完整仓库 → pull
if [[ -d "${APP_ROOT}/.git" ]]; then
  echo "==> 已有 .git，在 ${APP_ROOT} 执行 git pull --ff-only"
  cd "${APP_ROOT}"
  if [[ -n "${GIT_BRANCH}" ]]; then
    sudo -u "${RUN_USER}" git fetch --all --prune || true
    sudo -u "${RUN_USER}" git checkout "${GIT_BRANCH}" || true
  fi
  sudo -u "${RUN_USER}" git pull --ff-only
  echo
  echo "【ops/pull】代码已更新。"
  echo "  首次后续：sudo bash ${INSTALL_ENV}/configure.sh"
  echo "  已配置过：sudo bash ${DEPLOY_ROOT}/run/build.sh  或  ops/publish.sh"
  exit 0
fi

# 目录非空但无 .git → 拒绝覆盖
if [[ -n "$(ls -A "${APP_ROOT}" 2>/dev/null || true)" ]]; then
  echo "APP_ROOT 非空且没有 .git: ${APP_ROOT}" >&2
  echo "请清空该目录，或改 floworder.conf 的 APP_ROOT，或手工整理后再跑。" >&2
  exit 1
fi

# 首次 clone
if [[ -z "${GIT_REPO_URL}" ]]; then
  echo "首次克隆需要在 floworder.conf 填写 GIT_REPO_URL（仓库地址）。" >&2
  echo "例如：GIT_REPO_URL=https://github.com/你的账号/FlowOrder.git" >&2
  exit 1
fi

echo "==> 首次克隆到 ${APP_ROOT}"
echo "    URL=${GIT_REPO_URL}  BRANCH=${GIT_BRANCH}"
# clone 到临时再移入，避免 APP_ROOT 已存在导致 clone 建子目录
TMP_CLONE="$(mktemp -d /tmp/users-manager-clone.XXXXXX)"
trap 'rm -rf "${TMP_CLONE}"' EXIT
sudo -u "${RUN_USER}" git clone --branch "${GIT_BRANCH}" --single-branch "${GIT_REPO_URL}" "${TMP_CLONE}/repo"
# 移入 APP_ROOT（含隐藏文件）
shopt -s dotglob
mv "${TMP_CLONE}/repo"/* "${APP_ROOT}/"
shopt -u dotglob
chown -R "${RUN_USER}:${RUN_USER}" "${APP_ROOT}"

if [[ ! -d "${APP_ROOT}/apps/api" ]]; then
  echo "克隆完成但缺少 apps/api，请检查仓库地址是否正确。" >&2
  exit 1
fi

echo
echo "【ops/pull】首次克隆完成。"
echo "下一步：sudo bash ${INSTALL_ENV}/configure.sh"
