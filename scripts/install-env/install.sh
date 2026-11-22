#!/usr/bin/env bash
# ============================================================
#  只装 Linux 服务器环境（Windows 发版要先跑）
#  不依赖业务代码；不写 .env / systemd
#  sudo bash scripts/install-env/install.sh
# ============================================================

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

# 去 Windows 回车后再 source；命令行/环境里的 DB_* 优先于 conf 占位
# shellcheck disable=SC1090
source /dev/stdin <<< "$(tr -d '\r' < "${CONF_FILE}")"

APP_ROOT="${APP_ROOT:-/opt/dist-release}"
PORT="${PORT:-80}"
RUN_USER="${RUN_USER:-users-manager}"
MYSQL_AUTO="${MYSQL_AUTO:-true}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-users_manager}"
DB_USER="${DB_USER:-users_flow}"
DB_PASS="${DB_PASS:-ChangeMe_DbPass_2026}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
# 一键传入的库账号覆盖 conf（bootstrap 已写回 conf，这里再兜底）
[[ -n "${FO_DB_USER:-}" ]] && DB_USER="${FO_DB_USER}"
[[ -n "${FO_DB_PASS:-}" ]] && DB_PASS="${FO_DB_PASS}"
[[ -n "${FO_DB_NAME:-}" ]] && DB_NAME="${FO_DB_NAME}"
[[ -n "${FO_MYSQL_ROOT_PASS:-}" ]] && MYSQL_ROOT_PASSWORD="${FO_MYSQL_ROOT_PASS}"

# 探测用：强制 </dev/null，避免偶发从 stdin 读 SQL
mysql_ping_socket() {
  mysql --protocol=socket -uroot -e "SELECT 1" </dev/null >/dev/null 2>&1 && return 0
  local sock
  for sock in /var/lib/mysql/mysql.sock /run/mysqld/mysqld.sock /var/run/mysqld/mysqld.sock /tmp/mysql.sock; do
    if [[ -S "${sock}" ]] && mysql --socket="${sock}" -uroot -e "SELECT 1" </dev/null >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# 命令里的 root 密码登不上时，改成用户这次填写的密码。不删库，不改 .env。
reset_mysql_root_password() {
  local unit=$1
  local sql_esc sock pid i
  sql_esc=${MYSQL_ROOT_PASSWORD//\'/\'\'}
  sock="/tmp/mysql-reset.sock"
  echo "==> 命令中的 MariaDB root 密码目前登不上，将改成你这次填写的密码（不删库，不改 .env 私钥）"
  systemctl stop "${unit}" || true
  rm -f "${sock}"
  mysqld --user=mysql --datadir=/var/lib/mysql --skip-grant-tables --skip-networking --socket="${sock}" >/tmp/mysql-reset.log 2>&1 &
  pid=$!
  for i in $(seq 1 40); do
    if mysql --socket="${sock}" -uroot -e "SELECT 1" </dev/null >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! mysql --socket="${sock}" -uroot -e "SELECT 1" </dev/null >/dev/null 2>&1; then
    echo "重置 MariaDB 时临时实例没有起来，日志: /tmp/mysql-reset.log" >&2
    kill "${pid}" >/dev/null 2>&1 || true
    systemctl start "${unit}" || true
    exit 1
  fi
  mysql --socket="${sock}" -uroot <<SQL
FLUSH PRIVILEGES;
ALTER USER 'root'@'localhost' IDENTIFIED BY '${sql_esc}';
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${sql_esc}';
ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '${sql_esc}';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
  mysqladmin --socket="${sock}" -uroot shutdown >/dev/null 2>&1 || kill "${pid}" >/dev/null 2>&1 || true
  wait "${pid}" >/dev/null 2>&1 || true
  rm -f "${sock}"
  systemctl start "${unit}"
  save_mysql_root_password_to_conf "${MYSQL_ROOT_PASSWORD}"
  echo "    MariaDB root 已改为命令中的密码，并写入 ${CONF_FILE}"
}

mysql_ping_tcp() {
  local pass=$1
  mysql -uroot -p"${pass}" --protocol=TCP -h127.0.0.1 -e "SELECT 1" </dev/null >/dev/null 2>&1
}

# 执行 SQL：不要在函数里重定向 stdin，否则 <<SQL heredoc 会被吃掉（曾导致 ALTER 没执行）
mysql_root() {
  if [[ -n "${MYSQL_ROOT_PASSWORD}" ]] && mysql_ping_tcp "${MYSQL_ROOT_PASSWORD}"; then
    mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" --protocol=TCP -h127.0.0.1 "$@"
    return
  fi
  mysql -uroot "$@"
}

mysql_socket() {
  mysql -uroot "$@"
}

# 写回 floworder.conf。%q 保证密码里的特殊字符可以被 source。
save_mysql_root_password_to_conf() {
  local pass=$1
  local tmp
  tmp="$(mktemp)"
  grep -vE '^MYSQL_ROOT_PASSWORD=' "${CONF_FILE}" > "${tmp}" || true
  printf 'MYSQL_ROOT_PASSWORD=%q\n' "${pass}" >> "${tmp}"
  mv "${tmp}" "${CONF_FILE}"
  chmod 600 "${CONF_FILE}" || true
}

# 使用命令里的 root 密码：已经一致则不改；仅 socket 免密时写入该密码
ensure_mysql_root_password() {
  local sql_esc

  if [[ -z "${MYSQL_ROOT_PASSWORD}" ]]; then
    echo "必须在命令中指定 --mysql-root-pass。脚本不会自动生成 MariaDB root 密码。" >&2
    exit 1
  fi

  if mysql_ping_tcp "${MYSQL_ROOT_PASSWORD}"; then
    echo "    MariaDB root 与命令中的密码一致，不修改"
    save_mysql_root_password_to_conf "${MYSQL_ROOT_PASSWORD}"
    return 0
  fi

  if ! mysql_ping_socket; then
    echo "无法连接 MariaDB root（socket 与命令中的密码均失败）" >&2
    exit 1
  fi

  echo "    首次把命令中的 MariaDB root 密码写入数据库"
  sql_esc=${MYSQL_ROOT_PASSWORD//\'/\'\'}
  mysql_socket <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '${sql_esc}';
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${sql_esc}';
ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '${sql_esc}';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

  save_mysql_root_password_to_conf "${MYSQL_ROOT_PASSWORD}"

  # 等认证生效再测 TCP；失败不阻断（业务库走业务账号，后续仍可用 socket 建库）
  local tcp_ok=0
  local i
  for i in 1 2 3 4 5; do
    if mysql_ping_tcp "${MYSQL_ROOT_PASSWORD}"; then
      tcp_ok=1
      break
    fi
    sleep 1
  done
  if [[ "${tcp_ok}" -eq 1 ]]; then
    echo "    MariaDB root 密码已就绪（TCP + socket 可用）"
  else
    echo "    警告: root 的 TCP(127.0.0.1) 校验未通过，将继续用 socket 建业务库（一般可忽略）" >&2
  fi
}

setup_mysql() {
  echo "==> 本机数据库（MariaDB/MySQL）— 建库建用户；root 密码用命令中的 --mysql-root-pass"
  if [[ -z "${MYSQL_ROOT_PASSWORD}" ]]; then
    echo "必须在命令中指定 --mysql-root-pass。脚本不会自动生成 MariaDB root 密码。" >&2
    exit 1
  fi
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

  # 启动等待：命令中的 root 密码，或全新安装时的 socket 免密
  local ok=0
  for _ in $(seq 1 30); do
    if mysql_ping_socket; then
      ok=1
      break
    fi
    if [[ -n "${MYSQL_ROOT_PASSWORD}" ]] && mysql_ping_tcp "${MYSQL_ROOT_PASSWORD}"; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ "${ok}" -ne 1 ]]; then
    reset_mysql_root_password "${unit}"
    ok=0
    for _ in $(seq 1 30); do
      if mysql_ping_socket || mysql_ping_tcp "${MYSQL_ROOT_PASSWORD}"; then
        ok=1
        break
      fi
      sleep 1
    done
  fi
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
if ! command -v dnf >/dev/null 2>&1; then
  echo "未找到 dnf。一键安装面向 CentOS 9 / RHEL 9。" >&2
  exit 1
fi

echo "==> 检测并安装基础工具（curl / unzip / find / tar 等）"
dnf -y install curl ca-certificates unzip findutils tar gzip which shadow-utils procps-ng >/dev/null

echo "==> APP_ROOT=${APP_ROOT}（仅创建目录，不要求已有代码）"
mkdir -p "${APP_ROOT}"

echo "==> 安装 Node.js 20"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]]; then
  if curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - \
    && dnf -y install nodejs; then
    echo "    已用 NodeSource 安装"
  else
    echo "    NodeSource 失败，改试 dnf module nodejs:20"
    dnf -y module reset nodejs >/dev/null 2>&1 || true
    dnf -y module enable nodejs:20 >/dev/null 2>&1 || true
    dnf -y install nodejs
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 安装失败" >&2
  exit 1
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
echo "下一步："
echo "  1) 把代码上传/同步到 ${APP_ROOT}"
echo "  2) sudo bash ${SCRIPT_DIR}/configure.sh"
echo "  3) 本机 deploy-windows/build.ps1 → ${SCRIPT_DIR}/apply-dist.sh"
