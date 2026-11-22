#!/usr/bin/env bash
# ============================================================
#  GOST 安装脚本（CentOS 9 / RHEL 9）
#  一键（账号密码写在命令里，端口可省略，默认 1080）：
#    curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/gost/install-gost-centos9.sh \
#      | sudo bash -s -- --user='你的账号' --pass='你的密码'
#  本机已有同目录 gost.conf 时，仍可：sudo bash install-gost-centos9.sh
#  命令行参数会覆盖 gost.conf。
# ============================================================

set -euo pipefail

GOST_USER_CLI=""
GOST_PASS_CLI=""
GOST_PORT_CLI=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user=*) GOST_USER_CLI="${1#*=}" ;;
    --pass=*) GOST_PASS_CLI="${1#*=}" ;;
    --port=*) GOST_PORT_CLI="${1#*=}" ;;
    --user) shift; GOST_USER_CLI="${1:-}" ;;
    --pass) shift; GOST_PASS_CLI="${1:-}" ;;
    --port) shift; GOST_PORT_CLI="${1:-}" ;;
    -h|--help)
      echo "用法: curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/gost/install-gost-centos9.sh | sudo bash -s -- --user='你的账号' --pass='你的密码' [--port=1080]"
      exit 0
      ;;
    *)
      echo "未知参数: $1（需要 --user / --pass，端口可选 --port）" >&2
      exit 1
      ;;
  esac
  shift
done

CONF_FILE=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${SCRIPT_DIR}/gost.conf" ]]; then
    CONF_FILE="${SCRIPT_DIR}/gost.conf"
  fi
fi

if [[ -n "${CONF_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${CONF_FILE}"
fi

if [[ -n "${GOST_USER_CLI}" ]]; then GOST_USER="${GOST_USER_CLI}"; fi
if [[ -n "${GOST_PASS_CLI}" ]]; then GOST_PASS="${GOST_PASS_CLI}"; fi
if [[ -n "${GOST_PORT_CLI}" ]]; then GOST_PORT="${GOST_PORT_CLI}"; fi

GOST_VERSION="${GOST_VERSION:-3.0.0-rc10}"
GOST_LISTEN="${GOST_LISTEN:-0.0.0.0}"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/gost"
SERVICE_NAME="gost"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：curl ... | sudo bash -s -- --user='你的账号' --pass='你的密码'" >&2
  exit 1
fi

GOST_USER="${GOST_USER:-}"
GOST_PASS="${GOST_PASS:-}"
GOST_PORT="${GOST_PORT:-}"

if [[ -z "${CONF_FILE}" ]]; then
  if [[ -z "${GOST_USER}" || -z "${GOST_PASS}" ]]; then
    echo "一键安装必须带 --user 与 --pass。" >&2
    echo "示例: curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/gost/install-gost-centos9.sh | sudo bash -s -- --user='你的账号' --pass='你的密码'" >&2
    exit 1
  fi
  GOST_PORT="${GOST_PORT:-1080}"
fi

if [[ -z "${GOST_PORT}" ]]; then
  echo "请在命令里加 --port，或在 gost.conf 中填写 GOST_PORT" >&2
  exit 1
fi

if [[ -n "${GOST_USER}" && -z "${GOST_PASS}" ]] || [[ -z "${GOST_USER}" && -n "${GOST_PASS}" ]]; then
  echo "账号和密码必须同时填写，或同时留空（无鉴权）" >&2
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

if [[ -n "${CONF_FILE}" ]]; then
  echo "==> 读取配置 ${CONF_FILE}"
else
  echo "==> 使用命令行账号密码"
fi
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
