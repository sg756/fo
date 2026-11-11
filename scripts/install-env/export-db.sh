#!/usr/bin/env bash
# 在 Linux 服务器上备份业务库（mysqldump）。
#   sudo bash scripts/install-env/export-db.sh
#   sudo OUT_DIR=/root/db-backup bash scripts/install-env/export-db.sh
#   sudo GZIP=1 bash scripts/install-env/export-db.sh   # 额外打成 .sql.gz
#
# 账号密码只读同目录 floworder.conf 的 DB_*，不写进脚本、不要提交 .sql。
# 默认输出：${APP_ROOT}/backup/${DB_NAME}-时间戳.sql
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/floworder.conf"

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

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-users_manager}"
DB_USER="${DB_USER:-}"
DB_PASS="${DB_PASS:-}"
APP_ROOT="${APP_ROOT:-/opt/dist-release}"

if [[ -z "${DB_USER}" || -z "${DB_PASS}" ]]; then
  echo "floworder.conf 里 DB_USER / DB_PASS 不能为空" >&2
  exit 1
fi
if ! command -v mysqldump >/dev/null 2>&1; then
  echo "未找到 mysqldump，请先安装 mariadb 或 mysql 客户端" >&2
  exit 1
fi

OUT_DIR="${OUT_DIR:-${APP_ROOT}/backup}"
mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="${OUT_DIR}/${DB_NAME}-${STAMP}.sql"

CNF="$(mktemp)"
chmod 600 "${CNF}"
cleanup() { rm -f "${CNF}"; }
trap cleanup EXIT

cat > "${CNF}" <<EOF
[client]
host=${DB_HOST}
port=${DB_PORT}
user=${DB_USER}
password=${DB_PASS}
protocol=TCP
EOF

ARGS=(
  --defaults-extra-file="${CNF}"
  --single-transaction
  --quick
  --routines
  --triggers
  --default-character-set=utf8mb4
  --hex-blob
  --no-tablespaces
)
if mysqldump --help 2>/dev/null | grep -q 'column-statistics'; then
  ARGS+=(--column-statistics=0)
fi
if mysqldump --help 2>/dev/null | grep -q 'set-gtid-purged'; then
  ARGS+=(--set-gtid-purged=OFF)
fi

echo "==> 备份 ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
mysqldump "${ARGS[@]}" "${DB_NAME}" > "${OUT_FILE}"
# 去掉 DEFINER，换机导入时不会因账号不同失败
sed -E -i 's/DEFINER=`[^`]*`@`[^`]*`//g' "${OUT_FILE}"
chmod 600 "${OUT_FILE}"

FINAL="${OUT_FILE}"
if [[ "${GZIP:-0}" == "1" || "${GZIP:-}" == "true" ]]; then
  if ! command -v gzip >/dev/null 2>&1; then
    echo "未找到 gzip，已保留未压缩文件" >&2
  else
    gzip -f "${OUT_FILE}"
    FINAL="${OUT_FILE}.gz"
    chmod 600 "${FINAL}"
  fi
fi

BYTES="$(wc -c < "${FINAL}" | tr -d ' ')"
echo "==> 已写出 ${FINAL} （${BYTES} 字节）"
echo "拷到本机后可导入测试库："
echo "  powershell -ExecutionPolicy Bypass -File scripts\\dev\\import-linux-db.ps1 -Dump <sql路径>"
