#!/usr/bin/env bash
# ============================================================
#  【公共】代码就位后写业务配置（.env + systemd + 开机自启）
#  本地开发：apps/api/.env.dev ；服务器：apps/api/.env（本脚本生成/改写）
#  前置：install.sh 已完成；APP_ROOT 下已有仓库（apps/api）
#  sudo bash scripts/install-env/configure.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/floworder.conf"
SCRIPTS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
PORT="${PORT:-80}"
SERVICE_NAME="${SERVICE_NAME:-users-manager}"
RUN_USER="${RUN_USER:-users-manager}"
LOG_DIR="${LOG_DIR:-${APP_ROOT}/logs}"
MYSQL_AUTO="${MYSQL_AUTO:-true}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-users_manager}"
DB_USER="${DB_USER:-users_manager}"
DB_PASS="${DB_PASS:-ChangeMe_DbPass_2026}"

API_DIR="${APP_ROOT}/apps/api"
# 服务器唯一业务 env（Nest 生产 + Prisma CLI 都读这个）
ENV_FILE="${API_DIR}/.env"
# 按天一个文件：api-YYYY-MM-DD.log（由 api-run.sh 按行写入，跨零点自动切文件）
LOG_TODAY="${LOG_DIR}/api-$(date +%Y-%m-%d).log"
API_RUN="${APP_ROOT}/bin/api-run.sh"
LEGACY_PROD="${API_DIR}/.env.production"

urlencode() {
  local s=$1
  s=${s//'%'/'%25'}
  s=${s//' '/'%20'}
  s=${s//'!'/'%21'}
  s=${s//'#'/'%23'}
  s=${s//'$'/'%24'}
  s=${s//'&'/'%26'}
  s=${s//\'/'%27'}
  s=${s//'('/'%28'}
  s=${s//')'/'%29'}
  s=${s//'+'/'%2B'}
  s=${s//','/'%2C'}
  s=${s//'/'/'%2F'}
  s=${s//':'/'%3A'}
  s=${s//';'/'%3B'}
  s=${s//'='/'%3D'}
  s=${s//'?'/'%3F'}
  s=${s//'@'/'%40'}
  s=${s//'['/'%5B'}
  s=${s//']'/'%5D'}
  printf '%s' "$s"
}

set_env_kv() {
  local key=$1
  local val=$2
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    awk -v k="${key}" -v v="${val}" '
      BEGIN { done=0 }
      $0 ~ ("^" k "=") && !done { print k "=" v; done=1; next }
      { print }
    ' "${ENV_FILE}" > "${tmp}"
    mv "${tmp}" "${ENV_FILE}"
  else
    printf '\n%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
    rm -f "${tmp}"
  fi
}

# 与 apps/api/.env.example 同键的完整模板（无 example 文件时用；值由后续步骤改成生产）
write_full_env_template() {
  cat > "${ENV_FILE}" <<'EOF'
# ===== 数据库 =====
# 由 configure.sh 根据 floworder.conf 写入 DATABASE_URL
DATABASE_URL="mysql://users_manager:ChangeMe_DbPass_2026@127.0.0.1:3306/users_manager"

# ===== 服务 =====
PORT=80
NODE_ENV=production
# ADMIN_DIST=

# ===== JWT =====
JWT_SECRET="change-me-to-a-long-random-string"
JWT_EXPIRES_IN="7d"

# ===== 敏感字段加密 AES-256-GCM, 32字节hex(64位) =====
ENC_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# ===== 下单中间件 =====
TRADE_MIDDLEWARE_BASE="http://127.0.0.1:1820"
SYMBOL_CACHE_REFRESH_MS=1800000
TRADE_SERVICE_KEY=""
TRADE_LANGUAGE="zh-Hans"
TRADE_VERSION_CODE="20260012"
TRADE_CLIENT_TYPE="win"
TRADE_REQUIRE_PROXY=false
TRADE_REQUEST_TIMEOUT_MS=15000

# ===== 跟单 Worker =====
FOLLOWER_ENABLED=true
FOLLOWER_POLL_MS=500
FOLLOWER_MAX_SIGNALS=20
SIGNAL_TIMEOUT_MS=60000
SIGNAL_TIMEOUT_SECONDS=60
ORDER_EXPIRE_SECONDS=60
ORDER_WATCH_MS=8000
ORDER_EXPIRE_CHECK_MS=8000
POSITION_RECONCILE_MS=60000

# ===== 行情 =====
MARKET_ENABLED=true
MARKET_POLL_MS=90000
MARKET_BAN_BACKOFF_MIN_MS=5000
MARKET_BAN_BACKOFF_MAX_MS=1800000
MARKET_SOURCE_URL=https://api.binance.com
MARKET_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT

# ===== 提现热钱包 / 归集 =====
# WITHDRAW_HOT_PRIVATE_KEY=
COLLECTION_ENABLED=false

# ===== 充值 HD 钱包（configure 首次自动生成） =====
HD_MNEMONIC="word1 word2 ... word12"

# ===== 链上充值监听 =====
DEPOSIT_SCAN_ENABLED=true
DEPOSIT_SCAN_MS=90000
DEPOSIT_BAN_BACKOFF_MAX_MS=1800000
DEPOSIT_PRIMARY_CHAIN=ARB
DEPOSIT_ENABLED_CHAINS=ARB
DEPOSIT_MIN_AMOUNT=10
# CHAIN_ARB_RPC=https://arb1.arbitrum.io/rpc
# CHAIN_BASE_RPC=https://mainnet.base.org
# CHAIN_ETH_RPC=https://ethereum.publicnode.com

# ===== 初始平台管理员 (seed) =====
ADMIN_EMAIL="admin@floworder.local"
ADMIN_PASSWORD="admin123456"
EOF
}

# 占位 JWT / ENC_KEY 则生成一次（已有非占位值不覆盖）
ensure_jwt_and_enc_key() {
  local jwt enc
  jwt="$(get_env_val JWT_SECRET)"
  if [[ -z "${jwt}" || "${jwt}" == "change-me-to-a-long-random-string" || "${jwt}" == *"dev-secret"* ]]; then
    jwt="$(openssl rand -hex 32)"
    set_env_kv "JWT_SECRET" "\"${jwt}\""
    echo "==> 已生成 JWT_SECRET"
  else
    echo "==> JWT_SECRET 已存在，保留"
  fi

  enc="$(get_env_val ENC_KEY)"
  if [[ -z "${enc}" || "${enc}" == "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ]]; then
    enc="$(openssl rand -hex 32)"
    set_env_kv "ENC_KEY" "\"${enc}\""
    echo "==> 已生成 ENC_KEY"
  else
    echo "==> ENC_KEY 已存在，保留"
  fi
}

# 读 .env 中某 key 的值（去掉首尾引号）
get_env_val() {
  local key=$1
  local line raw
  line="$(grep -E "^${key}=" "${ENV_FILE}" | head -n1 || true)"
  [[ -z "${line}" ]] && { printf ''; return; }
  raw="${line#*=}"
  raw="${raw%$'\r'}"
  if [[ "${raw}" == \"*\" ]]; then
    raw="${raw#\"}"
    raw="${raw%\"}"
  elif [[ "${raw}" == \'*\' ]]; then
    raw="${raw#\'}"
    raw="${raw%\'}"
  fi
  printf '%s' "${raw}"
}

# 空 / 占位 / 已知开发样例 → 需要生成；已有真实助记词 → 永不覆盖
hd_mnemonic_needs_generate() {
  local m=$1
  local n
  m="$(echo "${m}" | xargs)"
  [[ -z "${m}" ]] && return 0
  # .env.example 占位
  if [[ "${m}" == *"word1"* ]] || [[ "${m}" == *"..."* ]]; then
    return 0
  fi
  # 仓库里曾用过的开发样例（勿用于生产）
  if [[ "${m}" == "kitchen asset armor beauty lens fluid mass tired say food expect flip" ]]; then
    return 0
  fi
  # 粗检：至少 12 个词
  n="$(echo "${m}" | wc -w)"
  if [[ "${n}" -lt 12 ]]; then
    return 0
  fi
  return 1
}

ensure_hd_mnemonic() {
  local current phrase tmpdir
  current="$(get_env_val HD_MNEMONIC)"
  if ! hd_mnemonic_needs_generate "${current}"; then
    echo "==> HD_MNEMONIC 已存在，保留（此后勿改；已发过充值地址更不能换）"
    return 0
  fi

  echo "==> 首次生成生产 HD_MNEMONIC（写入 .env，请立即离线备份）"
  # 不要在 APP_ROOT/apps/api 下跑：此处常只有 dist、无 node_modules，npx 会解析失败
  tmpdir="$(mktemp -d)"
  phrase="$(
    cd "${tmpdir}"
    npm init -y >/dev/null 2>&1
    npm install --silent --no-audit --no-fund ethers@6 >/dev/null 2>&1
    node -e "const {Wallet}=require('ethers'); process.stdout.write(Wallet.createRandom().mnemonic.phrase)"
  )" || true
  rm -rf "${tmpdir}"
  phrase="$(echo "${phrase}" | tr -d '\r' | xargs)"
  if [[ -z "${phrase}" ]] || [[ "$(echo "${phrase}" | wc -w)" -lt 12 ]]; then
    echo "生成 HD_MNEMONIC 失败（临时目录 npm install ethers 未成功，请检查网络）" >&2
    exit 1
  fi
  # 带引号，词间空格安全
  set_env_kv "HD_MNEMONIC" "\"${phrase}\""
  echo "==> 已写入 HD_MNEMONIC（12 词）。请立即离线备份："
  echo "    grep '^HD_MNEMONIC=' ${ENV_FILE}"
  echo "    本脚本以后再跑也不会覆盖已有助记词。"
}

# 准备服务器 .env：兼容旧 .env.production / 符号链接；不覆盖已有真实 .env
prepare_env_file() {
  if [[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]]; then
    echo "==> 已存在 ${ENV_FILE}，保留并更新 PORT / DATABASE_URL 等"
    return 0
  fi

  # 旧方案：.env → .env.production 符号链接 → 物化为普通 .env
  if [[ -L "${ENV_FILE}" ]]; then
    echo "==> 将符号链接 ${ENV_FILE} 物化为普通 .env"
    local tmp
    tmp="$(mktemp)"
    cp -L "${ENV_FILE}" "${tmp}"
    rm -f "${ENV_FILE}"
    mv "${tmp}" "${ENV_FILE}"
    if [[ -f "${LEGACY_PROD}" ]]; then
      echo "==> 已弃用 ${LEGACY_PROD}（可手动删除；以后以 .env 为准）"
    fi
    return 0
  fi

  if [[ -f "${LEGACY_PROD}" ]]; then
    echo "==> 将已有 .env.production 迁移为 .env"
    mv "${LEGACY_PROD}" "${ENV_FILE}"
  elif [[ -f "${API_DIR}/.env.example" ]]; then
    echo "==> 从 .env.example 复制 ${ENV_FILE}"
    cp "${API_DIR}/.env.example" "${ENV_FILE}"
  else
    echo "==> 无 .env.example，写入与 example 同键的完整 .env 模板"
    write_full_env_template
  fi
}

if [[ ! -d "${API_DIR}" ]]; then
  echo "==> 创建 ${API_DIR}（可仅有 dist 上传包；.env 由本脚本生成）"
  mkdir -p "${API_DIR}"
fi
if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "运行用户不存在: ${RUN_USER}。请先执行 install-env/install.sh" >&2
  exit 1
fi

prepare_env_file

# 生产文件里标成 production（便于辨认；进程仍以 systemd 的 NODE_ENV 为准）
set_env_kv "NODE_ENV" "production"

if [[ "${MYSQL_AUTO}" == "true" || "${MYSQL_AUTO}" == "1" ]]; then
  enc_user="$(urlencode "${DB_USER}")"
  enc_pass="$(urlencode "${DB_PASS}")"
  db_url="\"mysql://${enc_user}:${enc_pass}@${DB_HOST}:${DB_PORT}/${DB_NAME}\""
  set_env_kv "DATABASE_URL" "${db_url}"
  echo "==> 已写入 DATABASE_URL（来自 floworder.conf 的 DB_*）"
else
  echo "==> MYSQL_AUTO=false，请确认 ${ENV_FILE} 中 DATABASE_URL 正确"
fi

set_env_kv "PORT" "${PORT}"
echo "==> 已将 PORT=${PORT} 写入 .env"

NODE_BIN="$(command -v node)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "未找到 node。请先执行 install-env/install.sh" >&2
  exit 1
fi

ensure_jwt_and_enc_key
# 首次配置生成生产助记词；已有真实值则永不覆盖
ensure_hd_mnemonic

echo "==> 日志目录: ${LOG_DIR}（按天 api-YYYY-MM-DD.log）"
mkdir -p "${LOG_DIR}" "${APP_ROOT}/bin"
touch "${LOG_TODAY}"
chown -R "${RUN_USER}:${RUN_USER}" "${LOG_DIR}"
chmod 755 "${LOG_DIR}"
chmod 644 "${LOG_TODAY}"

# 启动包装：stdout/stderr 按行写入当天文件，零点后自动落到新日期文件
cat > "${API_RUN}" <<RUN
#!/usr/bin/env bash
set -euo pipefail
API_DIR='${API_DIR}'
LOG_DIR='${LOG_DIR}'
NODE_BIN='${NODE_BIN}'
cd "\${API_DIR}"
mkdir -p "\${LOG_DIR}"
run_node() {
  if command -v stdbuf >/dev/null 2>&1; then
    stdbuf -oL -eL "\${NODE_BIN}" dist/main.js
  else
    "\${NODE_BIN}" dist/main.js
  fi
}
set -o pipefail
run_node 2>&1 | while IFS= read -r line || [[ -n "\${line}" ]]; do
  printf '%s\\n' "\${line}" >> "\${LOG_DIR}/api-\$(date +%Y-%m-%d).log"
done
exit "\${PIPESTATUS[0]}"
RUN
chmod 755 "${API_RUN}"
chown "${RUN_USER}:${RUN_USER}" "${API_RUN}"
echo "==> 已写入启动包装: ${API_RUN}"

# 保留 14 天：按文件名日期清理
CLEAN_CRON="/etc/cron.daily/${SERVICE_NAME}-logs"
cat > "${CLEAN_CRON}" <<CLEAN
#!/bin/sh
find '${LOG_DIR}' -maxdepth 1 -type f -name 'api-????-??-??.log' -mtime +14 -delete 2>/dev/null || true
find '${LOG_DIR}' -maxdepth 1 -type f -name 'api-????-??-??.log.gz' -mtime +14 -delete 2>/dev/null || true
CLEAN
chmod 755 "${CLEAN_CRON}"
echo "==> 已写入日志清理: ${CLEAN_CRON}（保留 14 天）"

# 去掉旧版单文件 api.log 的 logrotate（若曾写入则删除）
if [[ -f "/etc/logrotate.d/${SERVICE_NAME}" ]]; then
  rm -f "/etc/logrotate.d/${SERVICE_NAME}"
  echo "==> 已移除旧 logrotate: /etc/logrotate.d/${SERVICE_NAME}"
fi

echo "==> 写入 systemd: ${SERVICE_NAME}.service（NODE_ENV=production，读 .env；按天日志）"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=users-manager API + Admin (port ${PORT}, no nginx)
After=network.target mysqld.service mariadb.service
Wants=network.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${API_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=${API_RUN}
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
LimitNOFILE=65535
# 日志由 api-run.sh 写入 ${LOG_DIR}/api-YYYY-MM-DD.log
StandardOutput=null
StandardError=null
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

chown -R "${RUN_USER}:${RUN_USER}" "${APP_ROOT}"

echo
echo "【install-env/configure】配置完成。"
echo "  生产环境文件: ${ENV_FILE}"
echo "  日志目录: ${LOG_DIR}（当天: ${LOG_TODAY}）"
echo "  已自动处理（占位则生成，已有则保留）：JWT_SECRET / ENC_KEY / HD_MNEMONIC"
echo "  请核对并修改：ADMIN_EMAIL / ADMIN_PASSWORD（及 TRADE_* 等业务项）"
echo "  首次 build.sh / apply-dist 会自动跑 prisma/seed.js（按上述账号建管理员；已存在则不改密码）"
echo "  HD_MNEMONIC 勿再改；请离线备份。"
echo "下一步："
echo "  · 纯 Linux → sudo bash ${SCRIPTS_ROOT}/deploy/run/build.sh && start.sh"
echo "  · Windows  → 上传 dist 后 sudo bash ${SCRIPT_DIR}/apply-dist.sh"
echo "  · 看当天日志 → tail -f ${LOG_TODAY}"
echo "  · 列历史     → ls -lh ${LOG_DIR}/api-*.log"
