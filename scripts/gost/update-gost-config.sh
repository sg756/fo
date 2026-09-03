#!/usr/bin/env bash
# ============================================================
#  GOST 维护脚本：按 gost.conf 更新配置并重启
#  1) 编辑同目录 gost.conf（端口必填；账号/密码可留空=无鉴权）
#  2) sudo bash update-gost-config.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/gost.conf"

if [[ ! -f "${CONF_FILE}" ]]; then
  echo "找不到配置文件: ${CONF_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

CONFIG_DIR="/etc/gost"
CONFIG_FILE="${CONFIG_DIR}/gost.yaml"
SERVICE_NAME="gost"
GOST_LISTEN="${GOST_LISTEN:-0.0.0.0}"
GOST_USER="${GOST_USER:-}"
GOST_PASS="${GOST_PASS:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash $0" >&2
  exit 1
fi

if [[ -z "${GOST_PORT:-}" ]]; then
  echo "请在 gost.conf 中填写 GOST_PORT" >&2
  exit 1
fi

# 账号/密码：都空=无鉴权；只填一项不允许
if [[ -n "${GOST_USER}" && -z "${GOST_PASS}" ]] || [[ -z "${GOST_USER}" && -n "${GOST_PASS}" ]]; then
  echo "GOST_USER / GOST_PASS 需同时填写，或同时留空（无鉴权）" >&2
  exit 1
fi

if ! command -v gost >/dev/null 2>&1 && [[ ! -x /usr/local/bin/gost ]]; then
  echo "未检测到 gost，请先运行 install-gost-centos9.sh 安装" >&2
  exit 1
fi

if ! systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  echo "未找到 ${SERVICE_NAME}.service，请先运行安装脚本" >&2
  exit 1
fi

yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

mkdir -p "${CONFIG_DIR}"
if [[ -n "${GOST_USER}" && -n "${GOST_PASS}" ]]; then
  USER_ESC="$(yaml_escape "${GOST_USER}")"
  PASS_ESC="$(yaml_escape "${GOST_PASS}")"
  AUTH_MODE="有鉴权"
  cat > "${CONFIG_FILE}" <<EOF
services:
  - name: http
    addr: "${GOST_LISTEN}:${GOST_PORT}"
    handler:
      type: http
      auth:
        username: "${USER_ESC}"
        password: "${PASS_ESC}"
    listener:
      type: tcp
EOF
  CURL_PROXY="http://${GOST_USER}:${GOST_PASS}@127.0.0.1:${GOST_PORT}"
else
  AUTH_MODE="无鉴权"
  cat > "${CONFIG_FILE}" <<EOF
services:
  - name: http
    addr: "${GOST_LISTEN}:${GOST_PORT}"
    handler:
      type: http
    listener:
      type: tcp
EOF
  CURL_PROXY="http://127.0.0.1:${GOST_PORT}"
fi
chmod 600 "${CONFIG_FILE}"

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${GOST_PORT}/tcp" >/dev/null || true
  firewall-cmd --reload >/dev/null || true
fi

systemctl restart "${SERVICE_NAME}"
sleep 1
systemctl --no-pager --full status "${SERVICE_NAME}" || true

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"

echo
echo "======== 配置已更新并重启 ========"
echo "鉴权: ${AUTH_MODE}"
if [[ "${AUTH_MODE}" == "有鉴权" ]]; then
  echo "账号: ${GOST_USER}"
  echo "密码: ${GOST_PASS}"
fi
echo "端口: ${GOST_PORT}"
echo "来源: ${CONF_FILE}"
echo "生效: ${CONFIG_FILE}"
echo
echo "自测:"
echo "  curl -x ${CURL_PROXY} https://api.ipify.org"
if [[ -n "${LAN_IP}" ]]; then
  echo
  echo "中间件 proxyIP（局域网）: ${LAN_IP}:${GOST_PORT}"
fi
echo "================================="
