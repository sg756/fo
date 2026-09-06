#!/usr/bin/env bash
# ============================================================
#  GOST 安装脚本（CentOS 9 / RHEL 9）
#  1) 编辑同目录 gost.conf（账号/密码/端口）
#  2) sudo bash install-gost-centos9.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/gost.conf"

if [[ ! -f "${CONF_FILE}" ]]; then
  echo "找不到配置文件: ${CONF_FILE}" >&2
  echo "请先编辑同目录下的 gost.conf" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

GOST_VERSION="${GOST_VERSION:-3.0.0-rc10}"
GOST_LISTEN="${GOST_LISTEN:-0.0.0.0}"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/gost"
SERVICE_NAME="gost"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash $0" >&2
  exit 1
fi

if [[ -z "${GOST_PORT:-}" ]]; then
  echo "请在 gost.conf 中填写 GOST_PORT" >&2
  exit 1
fi

GOST_USER="${GOST_USER:-}"
GOST_PASS="${GOST_PASS:-}"
# 账号/密码：都空=无鉴权；只填一项不允许
if [[ -n "${GOST_USER}" && -z "${GOST_PASS}" ]] || [[ -z "${GOST_USER}" && -n "${GOST_PASS}" ]]; then
  echo "GOST_USER / GOST_PASS 需同时填写，或同时留空（无鉴权）" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOST_ARCH="amd64" ;;
  aarch64|arm64) GOST_ARCH="arm64" ;;
  *)
    echo "不支持的架构: $ARCH" >&2
    exit 1
    ;;
esac

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}
need_cmd curl
need_cmd tar
need_cmd systemctl

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

ASSET="gost_${GOST_VERSION}_linux_${GOST_ARCH}.tar.gz"
URL="https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/${ASSET}"

echo "==> 读取配置 ${CONF_FILE}"
if [[ -n "${GOST_USER}" && -n "${GOST_PASS}" ]]; then
  echo "    鉴权=有 用户=${GOST_USER} 端口=${GOST_PORT}"
else
  echo "    鉴权=无 端口=${GOST_PORT}"
fi
echo "==> 下载 GOST v${GOST_VERSION} (${GOST_ARCH})"
echo "    ${URL}"
if ! curl -fL --retry 3 -o "${TMP_DIR}/${ASSET}" "${URL}"; then
  echo "下载失败，请检查网络或更换 GOST_VERSION" >&2
  exit 1
fi

echo "==> 安装到 ${INSTALL_DIR}/gost"
tar -xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}"
BIN=""
if [[ -x "${TMP_DIR}/gost" ]]; then
  BIN="${TMP_DIR}/gost"
else
  BIN="$(find "${TMP_DIR}" -type f -name gost | head -n 1 || true)"
fi
if [[ -z "${BIN}" || ! -x "${BIN}" ]]; then
  echo "压缩包内未找到 gost 可执行文件" >&2
  exit 1
fi
install -m 755 "${BIN}" "${INSTALL_DIR}/gost"
"${INSTALL_DIR}/gost" -V || true

yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

echo "==> 写入配置 ${CONFIG_DIR}/gost.yaml"
mkdir -p "${CONFIG_DIR}"
if [[ -n "${GOST_USER}" && -n "${GOST_PASS}" ]]; then
  USER_ESC="$(yaml_escape "${GOST_USER}")"
  PASS_ESC="$(yaml_escape "${GOST_PASS}")"
  AUTH_MODE="有鉴权"
  cat > "${CONFIG_DIR}/gost.yaml" <<EOF
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
  cat > "${CONFIG_DIR}/gost.yaml" <<EOF
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
chmod 600 "${CONFIG_DIR}/gost.yaml"

echo "==> 写入 systemd: ${SERVICE_NAME}.service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GOST HTTP Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/gost -C ${CONFIG_DIR}/gost.yaml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
sleep 1
systemctl --no-pager --full status "${SERVICE_NAME}" || true

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  echo "==> firewalld 放行 ${GOST_PORT}/tcp"
  firewall-cmd --permanent --add-port="${GOST_PORT}/tcp" >/dev/null || true
  firewall-cmd --reload >/dev/null || true
else
  echo "==> 未检测到运行中的 firewalld，请自行放行端口 ${GOST_PORT}（含云安全组）"
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
PUB_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

echo
echo "======== 安装完成 ========"
echo "鉴权: ${AUTH_MODE}"
if [[ "${AUTH_MODE}" == "有鉴权" ]]; then
  echo "账号: ${GOST_USER}"
  echo "密码: ${GOST_PASS}"
fi
echo "端口: ${GOST_PORT}"
echo "配置: ${CONFIG_DIR}/gost.yaml"
echo
echo "本机自测:"
echo "  curl -x ${CURL_PROXY} https://api.ipify.org"
echo
if [[ -n "${LAN_IP}" ]]; then
  echo "【给中间件 proxyIP 填局域网】（同内网时用这个）"
  echo "  ${LAN_IP}:${GOST_PORT}"
  echo
fi
if [[ -n "${PUB_IP}" ]]; then
  echo "【给交易所白名单填公网出口】"
  echo "  ${PUB_IP}"
  echo
fi
echo "以后改配置：改 gost.conf → sudo bash update-gost-config.sh"
echo "=========================="
