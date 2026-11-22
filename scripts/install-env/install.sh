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

# 上次安装把 root 密码写在服务器上的 floworder.conf，这次空机脚本不会带着它
load_saved_root_password() {
  local f line val
  for f in \
    "${APP_ROOT}/scripts/install-env/floworder.conf" \
    /opt/dist-release/scripts/install-env/floworder.conf \
    /opt/FlowOrder/scripts/install-env/floworder.conf
  do
    [[ -f "${f}" ]] || continue
    line="$(grep -E '^MYSQL_ROOT_PASSWORD=' "${f}" | tail -n 1 || true)"
    val="${line#MYSQL_ROOT_PASSWORD=}"
    val="${val#\'}"
    val="${val%\'}"
    if [[ -n "${val}" ]]; then
      MYSQL_ROOT_PASSWORD="${val}"
      echo "    使用已保存的 MariaDB root 密码: ${f}"
      return 0
    fi
  done
  return 1
}

# 已装过 MariaDB 且 root 不再免密时，重置密码，不删除已有库
reset_mysql_root_password() {
  local unit=$1
  local pass sql_esc sock pid i
  pass="$(gen_db_password)"
  sql_esc=${pass//\'/\'\'}
  sock="/tmp/mysql-reset.sock"
  echo "==> 无法登录现有 MariaDB，重置 root 密码（保留已有数据库）"
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
  MYSQL_ROOT_PASSWORD="${pass}"
  save_mysql_root_password_to_conf "${MYSQL_ROOT_PASSWORD}"
  echo "    已重置 MariaDB root 密码并写入 ${CONF_FILE}"
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

# 注意：不能用 tr|head（pipefail 下 head 提前关闭管道会使 tr 以 141 失败，脚本会静默退出）
gen_db_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 12
    return 0
  fi
  # 兜底：一次读够字节再过滤，避免 SIGPIPE
  local raw
  raw="$(dd if=/dev/urandom bs=64 count=1 status=none 2>/dev/null | base64 2>/dev/null | tr -d '\n+/=' )"
  printf '%s' "${raw:0:24}"
  echo
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

  if mysql_ping_socket; then
    via_socket=1
  fi

  if [[ "${via_socket}" -eq 0 ]]; then
    if [[ -n "${MYSQL_ROOT_PASSWORD}" ]] && mysql_ping_tcp "${MYSQL_ROOT_PASSWORD}"; then
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

  if [[ -z "${MYSQL_ROOT_PASSWORD}" ]]; then
    load_saved_root_password || true
  fi

  # 启动等待：先试 socket，再试 conf 密码（避免「conf 填了错密码却挡住 socket」）
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
