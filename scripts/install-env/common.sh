#!/usr/bin/env bash
# 公共函数。由 bootstrap / fetch-dist / remote-bootstrap source，不要单独执行。

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "请用 root 执行：sudo bash $0" >&2
    exit 1
  fi
}

# 去掉 Windows 回车再 source，避免 APP_ROOT 等带 \r
source_conf() {
  local f="${1:-./floworder.conf}"
  if [[ ! -f "$f" ]]; then
    echo "找不到配置文件: $f" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source /dev/stdin <<< "$(tr -d '\r' < "$f")"
}

# 一键安装参数：--db-user= --db-pass= 必填；--db-name= 可选；--app-root= 可选（一般不用，解压后自动扫描）
# 也可用环境变量 DB_USER / DB_PASS / DB_NAME / APP_ROOT
parse_bootstrap_args() {
  FO_DB_USER="${DB_USER:-}"
  FO_DB_PASS="${DB_PASS:-}"
  FO_DB_NAME="${DB_NAME:-}"
  FO_APP_ROOT="${FO_APP_ROOT:-${APP_ROOT:-}}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --db-user=*) FO_DB_USER="${1#*=}" ;;
      --db-pass=*) FO_DB_PASS="${1#*=}" ;;
      --db-name=*) FO_DB_NAME="${1#*=}" ;;
      --app-root=*) FO_APP_ROOT="${1#*=}" ;;
      --db-user) shift; FO_DB_USER="${1:-}" ;;
      --db-pass) shift; FO_DB_PASS="${1:-}" ;;
      --db-name) shift; FO_DB_NAME="${1:-}" ;;
      --app-root) shift; FO_APP_ROOT="${1:-}" ;;
      -h|--help)
        echo "用法: ... | sudo bash -s -- --db-user=账号 --db-pass=密码 [--db-name=库名]"
        echo "  库名默认 users_manager。APP_ROOT 解压后自动扫描填写，一般不用传。"
        exit 0
        ;;
      *)
        echo "未知参数: $1" >&2
        echo "需要: --db-user=... --db-pass=... [--db-name=users_manager]" >&2
        exit 1
        ;;
    esac
    shift
  done
  FO_DB_NAME="${FO_DB_NAME:-users_manager}"
}

require_db_creds() {
  if [[ -z "${FO_DB_USER:-}" || -z "${FO_DB_PASS:-}" ]]; then
    echo "一键安装必须指定数据库账号和密码。" >&2
    echo "示例:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/sg756/fo/main/scripts/install-env/remote-bootstrap.sh | sudo bash -s -- --db-user=users_flow --db-pass='你的密码'" >&2
    echo "  可选 --db-name=users_manager（默认就是这个库名）" >&2
    exit 1
  fi
  if [[ "${FO_DB_PASS}" == "ChangeMe_DbPass_2026" ]]; then
    echo "请不要使用模板占位密码 ChangeMe_DbPass_2026，请换成你自己的 DB 密码。" >&2
    exit 1
  fi
}

# 把账号/密码/库名写回 floworder.conf（供 install/configure 读取）
write_db_creds_conf() {
  local file=${1:-./floworder.conf}
  local tmp
  tmp="$(mktemp)"
  awk -v u="${FO_DB_USER}" -v p="${FO_DB_PASS}" -v n="${FO_DB_NAME}" '
    BEGIN { fu=0; fp=0; fn=0 }
    /^DB_USER=/ { print "DB_USER=" u; fu=1; next }
    /^DB_PASS=/ { print "DB_PASS=" p; fp=1; next }
    /^DB_NAME=/ { print "DB_NAME=" n; fn=1; next }
    { print }
    END {
      if (!fu) print "DB_USER=" u
      if (!fp) print "DB_PASS=" p
      if (!fn) print "DB_NAME=" n
    }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  DB_USER="${FO_DB_USER}"
  DB_PASS="${FO_DB_PASS}"
  DB_NAME="${FO_DB_NAME}"
  export DB_USER DB_PASS DB_NAME
}

fo_dist_ok() {
  local root=$1
  [[ -n "$root" \
    && -f "${root}/apps/api/dist/main.js" \
    && -f "${root}/apps/admin/dist/index.html" \
    && -f "${root}/apps/api/package.json" \
    && -f "${root}/apps/api/prisma/schema.prisma" ]]
}

# 在 start 下扫描到「解压后的发布根」（含 apps/api/dist/main.js）
find_fo_app_root() {
  local start=$1
  local maxdepth=${2:-5}
  [[ -n "$start" && -d "$start" ]] || return 1
  if fo_dist_ok "$start"; then
    echo "$start"
    return 0
  fi
  local hit root
  hit="$(find "$start" -maxdepth "$maxdepth" -type f -path '*/apps/api/dist/main.js' 2>/dev/null | head -n 1 || true)"
  [[ -n "$hit" ]] || return 1
  root="$(cd "$(dirname "$hit")/../../.." && pwd)"
  if fo_dist_ok "$root"; then
    echo "$root"
    return 0
  fi
  return 1
}

# 空机默认落点；已有解压包则扫描定位，并写回 conf
default_install_root() {
  echo "/opt/dist-release"
}

# 决定安装/覆盖目标目录（解压前）：显式 --app-root > 已扫描到的源码根 > conf > 默认
resolve_app_root() {
  local conf_root=${1:-}
  local found=""
  if [[ -n "${FO_APP_ROOT:-}" ]]; then
    echo "${FO_APP_ROOT}"
    return 0
  fi
  local script_root
  script_root="$(cd "$(pwd)/../.." 2>/dev/null && pwd || true)"
  if found="$(find_fo_app_root "${script_root}" 2)"; then
    echo "$found"
    return 0
  fi
  if [[ -n "$conf_root" ]] && found="$(find_fo_app_root "$conf_root" 3)"; then
    echo "$found"
    return 0
  fi
  local c
  for c in /opt/dist-release /opt/FlowOrder /opt/users-manager /opt/fo; do
    if found="$(find_fo_app_root "$c" 3)"; then
      echo "$found"
      return 0
    fi
  done
  if found="$(find_fo_app_root /opt 5)"; then
    echo "==> 在 /opt 扫描到已有发布包: ${found}" >&2
    echo "$found"
    return 0
  fi
  # 空机：还没有解压产物，用 conf 或默认目录作为下载目标
  if [[ -n "$conf_root" ]]; then
    echo "$conf_root"
    return 0
  fi
  default_install_root
}

# 解压/覆盖完成后：扫描真实源码根并写回 APP_ROOT
finalize_app_root_after_extract() {
  local stage=$1
  local found
  if ! found="$(find_fo_app_root "$stage" 5)"; then
    echo "解压后未找到完整发布根（需要 apps/api/dist/main.js 等）: ${stage}" >&2
    return 1
  fi
  if [[ "$found" != "$stage" ]]; then
    echo "==> 解压目录有嵌套，APP_ROOT 自动定为: ${found}（扫描自 ${stage}）" >&2
  else
    echo "==> APP_ROOT 已自动填写: ${found}" >&2
  fi
  APP_ROOT="$found"
  export APP_ROOT
  sync_app_root_conf "$APP_ROOT"
  echo "$APP_ROOT"
}

# 把实际安装目录写回服务器上的 floworder.conf（不改 GitHub 仓库模板语义）。
sync_app_root_conf() {
  local root=$1
  local f
  [[ -n "$root" ]] || return 0
  for f in "./floworder.conf" "${root}/scripts/install-env/floworder.conf"; do
    [[ -f "$f" ]] || continue
    if grep -q '^APP_ROOT=' "$f"; then
      sed -i "s|^APP_ROOT=.*|APP_ROOT=${root}|" "$f"
    else
      printf '\nAPP_ROOT=%s\n' "$root" >> "$f"
    fi
  done
  APP_ROOT="$root"
  export APP_ROOT
}

github_release_zip_url() {
  local repo=${1:-${GITHUB_REPO:-sg756/fo}}
  local tag=${2:-${GITHUB_RELEASE_TAG:-dist}}
  echo "https://github.com/${repo}/releases/download/${tag}/dist-release.zip"
}

github_latest_zip_url() {
  local repo=${1:-${GITHUB_REPO:-sg756/fo}}
  echo "https://github.com/${repo}/releases/latest/download/dist-release.zip"
}

curl_github() {
  local url=$1
  local out=$2
  local args=(-fsSL --retry 3 --retry-delay 2 -o "$out")
  if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
    args+=(-H "Authorization: Bearer ${GH_TOKEN:-${GITHUB_TOKEN}}")
  fi
  curl "${args[@]}" "$url"
}

# 从 GitHub Release 把 dist-release.zip 覆盖到 dest
# 保留：apps/api/.env、logs/、backup/、已有 floworder.conf
fetch_github_dist() {
  local dest=$1
  local repo=${GITHUB_REPO:-sg756/fo}
  local tag=${GITHUB_RELEASE_TAG:-dist}
  local tmp zip unpack
  if ! command -v unzip >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
      dnf -y install unzip >/dev/null
    else
      echo "需要 unzip。请先安装 unzip。" >&2
      return 1
    fi
  fi
  mkdir -p "$dest"
  tmp="$(mktemp -d /tmp/fo-dist-XXXX)"
  zip="${tmp}/dist-release.zip"
  unpack="${tmp}/unpack"
  mkdir -p "$unpack"
  echo "==> 从 GitHub 拉取发布包 ${repo} tag=${tag}"
  if ! curl_github "$(github_release_zip_url "$repo" "$tag")" "$zip"; then
    echo "    tag=${tag} 没有包，改试 latest"
    if ! curl_github "$(github_latest_zip_url "$repo")" "$zip"; then
      echo "无法下载 dist-release.zip。请确认仓库 ${repo} 已有 GitHub Release（资产名 dist-release.zip）。" >&2
      echo "私有仓请先：export GH_TOKEN=你的token" >&2
      rm -rf "$tmp"
      return 1
    fi
  fi
  unzip -qo "$zip" -d "$unpack"
  local src="$unpack"
  if ! fo_dist_ok "$unpack"; then
    local inner
    inner="$(find "$unpack" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [[ -n "$inner" ]] && fo_dist_ok "$inner"; then
      src="$inner"
    fi
  fi
  if ! fo_dist_ok "$src"; then
    echo "发布包不完整：需要 apps/api/dist/main.js、apps/admin/dist/index.html、prisma/" >&2
    rm -rf "$tmp"
    return 1
  fi

  echo "==> 覆盖到 ${dest}（保留 .env / logs / backup / floworder.conf）"
  local keep_conf=0
  local keep_env=0
  if [[ -f "${dest}/scripts/install-env/floworder.conf" ]]; then
    keep_conf=1
    cp -a "${dest}/scripts/install-env/floworder.conf" "${tmp}/floworder.conf.keep"
  fi
  if [[ -f "${dest}/apps/api/.env" ]]; then
    keep_env=1
    mkdir -p "${tmp}/keep"
    cp -a "${dest}/apps/api/.env" "${tmp}/keep/.env"
  fi

  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude logs --exclude backup --exclude node_modules \
      --exclude apps/api/.env \
      --exclude apps/api/node_modules \
      --exclude apps/admin/node_modules \
      --exclude scripts/install-env/floworder.conf \
      "${src}/" "${dest}/"
  else
    (
      cd "$src"
      tar --exclude=logs --exclude=backup --exclude=node_modules \
        --exclude=apps/api/.env \
        --exclude=apps/api/node_modules \
        --exclude=apps/admin/node_modules \
        --exclude=scripts/install-env/floworder.conf -cf - .
    ) | tar -C "$dest" -xf -
  fi

  mkdir -p "${dest}/scripts/install-env" "${dest}/apps/api" "${dest}/logs" "${dest}/backup"
  if [[ "${keep_conf}" -eq 1 ]]; then
    cp -a "${tmp}/floworder.conf.keep" "${dest}/scripts/install-env/floworder.conf"
  elif [[ -f "${src}/scripts/install-env/floworder.conf" && ! -f "${dest}/scripts/install-env/floworder.conf" ]]; then
    cp -a "${src}/scripts/install-env/floworder.conf" "${dest}/scripts/install-env/floworder.conf"
  fi
  if [[ "${keep_env}" -eq 1 ]]; then
    cp -a "${tmp}/keep/.env" "${dest}/apps/api/.env"
  fi

  rm -rf "$tmp"
  if ! fo_dist_ok "$dest"; then
    # 允许 zip 多裹一层目录：扫描后再由调用方 finalize APP_ROOT
    if ! find_fo_app_root "$dest" 5 >/dev/null; then
      echo "覆盖后 ${dest} 仍不完整" >&2
      return 1
    fi
  fi
  echo "==> 发布包已放到 ${dest}"
}
