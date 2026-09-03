#!/usr/bin/env bash
# ============================================================
#  【公共】只装 Linux 服务器环境（纯 Linux / Windows 发版都要先跑）
#  不依赖业务代码；不写 .env / systemd
#  sudo bash scripts/install-env/install.sh
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
RUN_USER="${RUN_USER:-users-manager}"
MYSQL_AUTO="${MYSQL_AUTO:-true}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-users_manager}"
DB_USER="${DB_USER:-users_manager}"
DB_PASS="${DB_PASS:-ChangeMe_DbPass_2026}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"

# 优先：已配置密码的 TCP；否则：本机 socket（系统 root 常见免密）
mysql_root() {
  if [[ -n "${MYSQL_ROOT_PASSWORD}" ]] \
    && mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" --protocol=TCP -h127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
    mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" --protocol=TCP -h127.0.0.1 "$@"
    return
  fi
  mysql -uroot "$@"
}

mysql_socket() {
  mysql -uroot "$@"
}

gen_db_password() {
  tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24
}

# 写回 floworder.conf（值用单引号，密码仅字母数字故安全）
save_mysql_root_password_to_conf() {
  local pass=$1
  local tmp
  tmp="$(mktemp)"
  if grep -qE '^MYSQL_ROOT_PASSWORD=' "${CONF_FILE}"; then
    awk -v p="${pass}" '
      BEGIN { done=0 }
      /^MYSQL_ROOT_PASSWORD=/ && !done {
        printf "MYSQL_ROOT_PASSWORD='\''%s'\''\n", p
        done=1
        next
      }
      { print }
    ' "${CONF_FILE}" > "${tmp}"
    mv "${tmp}" "${CONF_FILE}"
  else
    printf '\nMYSQL_ROOT_PASSWORD='\''%s'\''\n' "${pass}" >> "${CONF_FILE}"
    rm -f "${tmp}"
  fi
  chmod 600 "${CONF_FILE}" || true
}

# 确保 MariaDB root 有密码：空则生成；经 socket 写入库并写回 conf
ensure_mysql_root_password() {
  local sql_esc
  local via_socket=0

  if mysql_socket -e "SELECT 1" >/dev/null 2>&1; then
    via_socket=1
  fi

  if [[ "${via_socket}" -eq 0 ]]; then
    if [[ -n "${MYSQL_ROOT_PASSWORD}" ]] \
      && mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" --protocol=TCP -h127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
      echo "    MariaDB root 已可用（密码登录），保留现有 MYSQL_ROOT_PASSWORD"
      return 0
    fi
    echo "无法连接 MariaDB root（socket 与密码均失败）" >&2
    exit 1
  fi

  if [[ -z "${MYSQL_ROOT_PASSWORD}" ]]; then
    MYSQL_ROOT_PASSWORD="$(gen_db_password)"
    echo "    已自动生成 MariaDB root 密码并写入 ${CONF_FILE}"
  else
    echo "    通过 socket 将 conf 中的 MYSQL_ROOT_PASSWORD 应用到 MariaDB root"
  fi

  sql_esc=${MYSQL_ROOT_PASSWORD//\'/\'\'}
  mysql_socket <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '${sql_esc}';
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${sql_esc}';
ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '${sql_esc}';
FLUSH PRIVILEGES;
SQL

  save_mysql_root_password_to_conf "${MYSQL_ROOT_PASSWORD}"

  if ! mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" --protocol=TCP -h127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
    echo "已写 root 密码，但 TCP 校验失败。请检查 MariaDB 认证插件。" >&2
    exit 1
  fi
  echo "    MariaDB root 密码已就绪（可用 TCP + MYSQL_ROOT_PASSWORD）"
}

setup_mysql() {
  echo "==> 本机数据库（MariaDB/MySQL）— 建库建用户；root 密码由脚本保证"
  if ! rpm -q mariadb-server >/dev/null 2>&1 && ! rpm -q mysql-server >/dev/null 2>&1; then
    echo "    安装 mariadb-server"
    dnf -y install mariadb-server mariadb
  fi
  if ! command -v mysql >/dev/null 2>&1; then
    dnf -y install mariadb || dnf -y install mysql
  fi

  local unit=""
  if systemctl cat mariadb.service >/dev/null 2>&1; then
    unit=mariadb
  elif systemctl cat mysqld.service >/dev/null 2>&1; then
    unit=mysqld
  else
    echo "未找到 mariadb/mysqld 服务单元" >&2
    exit 1
  fi

  systemctl enable --now "${unit}"

  # 启动等待：先试 socket，再试 conf 密码（避免「conf 填了错密码却挡住 socket」）
  local ok=0
  for _ in $(seq 1 30); do
    if mysql_socket -e "SELECT 1" >/dev/null 2>&1; then
      ok=1
      break
    fi
    if [[ -n "${MYSQL_ROOT_PASSWORD}" ]] \
      && mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" --protocol=TCP -h127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ "${ok}" -ne 1 ]]; then
    echo "无法连接本机 MariaDB/MySQL（socket 与 MYSQL_ROOT_PASSWORD 均失败）" >&2
    exit 1
  fi

  ensure_mysql_root_password

  echo "    建库 ${DB_NAME} / 用户 ${DB_USER}"
  local sql_pass=${DB_PASS//\'/\'\'}
  mysql_root <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${sql_pass}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${sql_pass}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${sql_pass}';
ALTER USER '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${sql_pass}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
  echo "    数据库已就绪（DATABASE_URL 将在 configure.sh 写入 .env）"
}

echo "==> 【install-env】装服务器环境（CentOS 9 / RHEL 9）"
echo "==> APP_ROOT=${APP_ROOT}（仅创建目录，不要求已有代码）"
mkdir -p "${APP_ROOT}"

echo "==> 安装 Node.js 20（NodeSource）"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]]; then
  dnf -y module reset nodejs >/dev/null 2>&1 || true
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf -y install nodejs
fi
echo "    node=$(node -v) npm=$(npm -v)"

if [[ "${MYSQL_AUTO}" == "true" || "${MYSQL_AUTO}" == "1" ]]; then
  setup_mysql
else
  echo "==> MYSQL_AUTO=false，跳过本机建库"
fi

echo "==> 创建运行用户 ${RUN_USER}"
if ! id "${RUN_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_ROOT}" --shell /sbin/nologin "${RUN_USER}"
fi
chown -R "${RUN_USER}:${RUN_USER}" "${APP_ROOT}"

if systemctl is-active --quiet firewalld 2>/dev/null; then
  echo "==> firewalld 放行 ${PORT}/tcp"
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null || true
  firewall-cmd --reload >/dev/null || true
else
  echo "==> 未检测到 firewalld，请自行放行 ${PORT}（含云安全组）"
fi

echo
echo "【install-env/install】环境安装完成（尚未写 .env / systemd）。"
if [[ -n "${MYSQL_ROOT_PASSWORD:-}" ]]; then
  echo "  MariaDB root 密码已写入: ${CONF_FILE} （键 MYSQL_ROOT_PASSWORD，请保管）"
fi
echo "下一步（L / W 相同）："
echo "  1) 代码进 ${APP_ROOT}"
echo "       纯 Linux：sudo bash ${SCRIPTS_ROOT}/deploy/ops/pull.sh"
echo "       Windows：上传/同步到该目录"
echo "  2) sudo bash ${SCRIPT_DIR}/configure.sh"
echo "然后分叉："
echo "  · 纯 Linux → ${SCRIPTS_ROOT}/deploy/run/build.sh → start.sh"
echo "  · Windows  → 本机 deploy-windows/build.ps1 → ${SCRIPT_DIR}/apply-dist.sh"
