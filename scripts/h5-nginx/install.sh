#!/usr/bin/env bash
# 在 H5 小机上安装 nginx，托管静态页，并把 /api 反代到业务 API 机。
#   sudo bash scripts/h5-nginx/install.sh
# 只读同目录 h5-nginx.conf。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/h5-nginx.conf"

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

LISTEN_PORT="${LISTEN_PORT:-80}"
WEB_ROOT="${WEB_ROOT:-/var/www/floworder-h5}"
SITE_NAME="${SITE_NAME:-floworder-h5}"
API_HOST="${API_HOST:-}"
API_PORT="${API_PORT:-80}"
SERVER_NAME="${SERVER_NAME:-_}"
CLIENT_MAX_BODY_M="${CLIENT_MAX_BODY_M:-20}"
PROXY_CONNECT_TIMEOUT="${PROXY_CONNECT_TIMEOUT:-5}"
PROXY_SEND_TIMEOUT="${PROXY_SEND_TIMEOUT:-60}"
PROXY_READ_TIMEOUT="${PROXY_READ_TIMEOUT:-60}"
KEEPALIVE_UPSTREAM="${KEEPALIVE_UPSTREAM:-32}"
ACCESS_LOG="${ACCESS_LOG:-on}"
[[ -z "${SERVER_NAME}" ]] && SERVER_NAME="_"

if [[ -z "${API_HOST}" ]]; then
  echo "h5-nginx.conf 里 API_HOST 不能为空" >&2
  exit 1
fi
for n in LISTEN_PORT API_PORT CLIENT_MAX_BODY_M PROXY_CONNECT_TIMEOUT PROXY_SEND_TIMEOUT PROXY_READ_TIMEOUT KEEPALIVE_UPSTREAM; do
  v="${!n}"
  if ! [[ "${v}" =~ ^[0-9]+$ ]]; then
    echo "${n} 必须是数字，当前=${v}" >&2
    exit 1
  fi
done

install_nginx() {
  if command -v nginx >/dev/null 2>&1; then
    echo "==> 已安装 nginx: $(nginx -v 2>&1)"
    return 0
  fi
  echo "==> 安装 nginx"
  if command -v dnf >/dev/null 2>&1; then
    dnf -y install nginx
  elif command -v yum >/dev/null 2>&1; then
    yum -y install nginx
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
  else
    echo "未识别的包管理器，请先手动安装 nginx" >&2
    exit 1
  fi
  if ! command -v nginx >/dev/null 2>&1; then
    echo "nginx 安装失败" >&2
    exit 1
  fi
}

write_site() {
  mkdir -p "${WEB_ROOT}"
  chmod 755 "${WEB_ROOT}"
  mkdir -p /etc/nginx/conf.d /var/log/nginx

  local use_sites=0
  local conf_path=""
  if [[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]]; then
    use_sites=1
    conf_path="/etc/nginx/sites-available/${SITE_NAME}.conf"
  else
    conf_path="/etc/nginx/conf.d/${SITE_NAME}.conf"
  fi

  if [[ "${use_sites}" -eq 1 ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
  if [[ -f /etc/nginx/conf.d/default.conf ]]; then
    mv -f /etc/nginx/conf.d/default.conf "/etc/nginx/conf.d/default.conf.bak.$(date +%Y%m%d%H%M%S)" || true
  fi

  local access_line="access_log /var/log/nginx/${SITE_NAME}.access.log main_fo;"
  if [[ "${ACCESS_LOG}" == "off" || "${ACCESS_LOG}" == "0" || "${ACCESS_LOG}" == "false" ]]; then
    access_line="access_log off;"
  fi

  # http{} 内公共项（RHEL/Debian 的 conf.d 都在 http 里 include）
  local http_path="/etc/nginx/conf.d/00-${SITE_NAME}-http.conf"
  echo "==> 写入 ${http_path}"
  cat > "${http_path}" <<EOF
# 由 scripts/h5-nginx/install.sh 生成（http 上下文）
# 改 h5-nginx.conf 后重新执行 install.sh

upstream ${SITE_NAME}_api {
    server ${API_HOST}:${API_PORT};
    keepalive ${KEEPALIVE_UPSTREAM};
}

log_format main_fo '\$remote_addr - \$remote_user [\$time_local] '
                   '"\$request" \$status \$body_bytes_sent '
                   '"\$http_referer" "\$http_user_agent" '
                   'rt=\$request_time uct="\$upstream_connect_time" '
                   'uht="\$upstream_header_time" urt="\$upstream_response_time"';

# 文件句柄缓存，减轻小机磁盘压力
open_file_cache max=2000 inactive=30s;
open_file_cache_valid 60s;
open_file_cache_min_uses 2;
open_file_cache_errors on;

# 全局 gzip（站点内再开一层也无妨）
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_min_length 1024;
gzip_comp_level 5;
gzip_types
    text/plain
    text/css
    text/xml
    application/json
    application/javascript
    application/x-javascript
    application/xml
    application/xml+rss
    application/vnd.ms-fontobject
    application/wasm
    font/ttf
    font/otf
    image/svg+xml;
EOF

  echo "==> 写入 ${conf_path}"
  cat > "${conf_path}" <<EOF
# 由 scripts/h5-nginx/install.sh 生成（server）
# 改 h5-nginx.conf 后重新执行 install.sh

server {
    listen ${LISTEN_PORT} default_server;
    listen [::]:${LISTEN_PORT} default_server;
    server_name ${SERVER_NAME};

    root ${WEB_ROOT};
    index index.html;
    charset utf-8;
    server_tokens off;

    client_max_body_size ${CLIENT_MAX_BODY_M}m;
    client_body_timeout 30s;
    client_header_timeout 15s;
    send_timeout 60s;
    keepalive_timeout 65s;
    keepalive_requests 1000;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;

    ${access_line}
    error_log /var/log/nginx/${SITE_NAME}.error.log warn;

    # 基础安全头（H5 SPA，不做过严 CSP，以免 Expo 资源被挡）
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-XSS-Protection "1; mode=block" always;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_types text/plain text/css application/javascript application/json application/xml image/svg+xml;

    # ---- API 反代（内网业务机）----
    location /api/ {
        proxy_pass http://${SITE_NAME}_api/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header Connection "";
        proxy_redirect off;

        proxy_connect_timeout ${PROXY_CONNECT_TIMEOUT}s;
        proxy_send_timeout ${PROXY_SEND_TIMEOUT}s;
        proxy_read_timeout ${PROXY_READ_TIMEOUT}s;

        proxy_buffering on;
        proxy_buffer_size 16k;
        proxy_buffers 8 16k;
        proxy_busy_buffers_size 32k;
        proxy_temp_file_write_size 32k;

        # API 不长时间缓存
        add_header Cache-Control "no-store" always;
    }

    location = /api {
        return 301 /api/;
    }

    # 健康检查（不打业务机）
    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 'ok';
    }

    # Expo 带 hash 的静态资源：长缓存
    location ^~ /_expo/static/ {
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files \$uri =404;
    }

    # 其它静态后缀
    location ~* \\.(?:js|css|mjs|map|png|jpe?g|gif|ico|svg|webp|woff2?|ttf|otf|eot|wasm)$ {
        access_log off;
        expires 7d;
        add_header Cache-Control "public" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files \$uri =404;
    }

    # 禁止隐藏文件
    location ~ /\\. {
        deny all;
        access_log off;
        log_not_found off;
    }

    # H5 SPA：其余回 index.html
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

  if [[ "${use_sites}" -eq 1 ]]; then
    ln -sfn "${conf_path}" "/etc/nginx/sites-enabled/${SITE_NAME}.conf"
  fi
}

open_firewall() {
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    echo "==> firewalld 放行 ${LISTEN_PORT}/tcp"
    firewall-cmd --permanent --add-port="${LISTEN_PORT}/tcp" >/dev/null || true
    firewall-cmd --reload >/dev/null || true
  fi
}

install_nginx
write_site
open_firewall

echo "==> nginx -t"
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

if [[ ! -f "${WEB_ROOT}/index.html" ]]; then
  cat > "${WEB_ROOT}/index.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><title>FlowOrder H5</title></head>
<body style="font-family:sans-serif;padding:2rem">
<h1>H5 目录已就绪</h1>
<p>请把 <code>apps/mobile/dist</code> 里的文件覆盖到 <code>${WEB_ROOT}</code>。</p>
</body></html>
EOF
fi

# 本机一个非回环地址，方便打印 WEB_API 示例（取不到就写占位）
PUBLIC_HINT="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "${PUBLIC_HINT}" ]] && PUBLIC_HINT="<H5公网IP>"

echo
echo "==> nginx 已安装并启动（本脚本已执行完，无需再跑一遍）"
echo "  WEB_ROOT（H5 静态目录）: ${WEB_ROOT}"
echo "  WEB_API_BASE（导出 H5 用）: http://${PUBLIC_HINT}:${LISTEN_PORT}/api"
echo "    （若 LISTEN_PORT=80，也可写成 http://${PUBLIC_HINT}/api）"
echo "  反代上游 API:             http://${API_HOST}:${API_PORT}/api/"
echo "  本机网页:                 http://${PUBLIC_HINT}:${LISTEN_PORT}/"
echo "  健康检查:                 curl -sS http://127.0.0.1:${LISTEN_PORT}/healthz"
echo "  日志:                     /var/log/nginx/${SITE_NAME}.access.log"
echo "                            /var/log/nginx/${SITE_NAME}.error.log"
echo
echo "  测内网到业务机（在本 H5 机执行）："
echo "    curl -sS -o /dev/null -w '%{http_code} time=%{time_total}\\n' http://${API_HOST}:${API_PORT}/api/"
echo "    curl -sS -I http://${API_HOST}:${API_PORT}/api/ | head -n 5"
echo
echo "  静态文件：把 apps/mobile/dist/ 内容覆盖到 ${WEB_ROOT}/（已传过且未改包可忽略）"
echo "  改 h5-nginx.conf 后：再执行一次本脚本即可覆盖配置"
