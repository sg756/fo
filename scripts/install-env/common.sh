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

# 发布根：脚本在仓库 scripts/install-env 下且已有产物时，优先用上两级。
# 空机 curl 一键（脚本在 /tmp）时，仍用 conf 的 APP_ROOT。
resolve_app_root() {
  local conf_root=${1:-}
  local script_root
  script_root="$(cd "$(pwd)/../.." && pwd)"
  if [[ -f "${script_root}/apps/api/dist/main.js" \
    && -f "${script_root}/apps/admin/dist/index.html" ]]; then
    if [[ -n "${conf_root}" && "${conf_root}" != "${script_root}" ]]; then
      echo "==> APP_ROOT=${script_root}（按脚本位置；conf 里是 ${conf_root}）" >&2
    fi
    echo "${script_root}"
    return 0
  fi
  if [[ -n "${conf_root}" \
    && -f "${conf_root}/apps/api/dist/main.js" \
    && -f "${conf_root}/apps/admin/dist/index.html" ]]; then
    echo "${conf_root}"
    return 0
  fi
  echo "${conf_root}"
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

fo_dist_ok() {
  local root=$1
  [[ -f "${root}/apps/api/dist/main.js" \
    && -f "${root}/apps/admin/dist/index.html" \
    && -f "${root}/apps/api/package.json" \
    && -f "${root}/apps/api/prisma/schema.prisma" ]]
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
    echo "覆盖后 ${dest} 仍不完整" >&2
    return 1
  fi
  echo "==> 发布包已放到 ${dest}"
}
