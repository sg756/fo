#!/usr/bin/env bash
# ============================================================
#  GOST 稳定性抽查（在装了 gost 的服务器上执行）
#  同目录要有 gost.conf（账号/密码/端口从这里读，不要写进命令行）
#
#  用法：
#    bash check-gost-stability.sh
#    bash check-gost-stability.sh 127.0.0.1
#
#  可选环境变量：
#    CHECK_N=60            采样次数，默认 60
#    CHECK_INTERVAL=2      每次间隔秒数，默认 2
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/gost.conf"
HOST="${1:-127.0.0.1}"
N="${CHECK_N:-60}"
INTERVAL="${CHECK_INTERVAL:-2}"
PING_URL="https://api.binance.com/api/v3/ping"
IP_URL="https://api.ipify.org"

if [[ ! -f "${CONF_FILE}" ]]; then
  echo "找不到配置文件: ${CONF_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${CONF_FILE}"

GOST_PORT="${GOST_PORT:-}"
GOST_USER="${GOST_USER:-}"
GOST_PASS="${GOST_PASS:-}"

if [[ -z "${GOST_PORT}" ]]; then
  echo "请在 gost.conf 中填写 GOST_PORT" >&2
  exit 1
fi

if ! [[ "${N}" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHECK_N 必须是正整数" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "服务器上没有 curl" >&2
  exit 1
fi

PROXY="http://${HOST}:${GOST_PORT}"
CURL_AUTH=()
if [[ -n "${GOST_USER}" || -n "${GOST_PASS}" ]]; then
  if [[ -z "${GOST_USER}" || -z "${GOST_PASS}" ]]; then
    echo "gost.conf 里账号和密码必须同时填写，或同时留空" >&2
    exit 1
  fi
  CURL_AUTH=(--proxy-user "${GOST_USER}:${GOST_PASS}")
fi

echo "==> 代理 ${HOST}:${GOST_PORT}  采样 ${N} 次  间隔 ${INTERVAL}s"

if command -v systemctl >/dev/null 2>&1; then
  systemctl show gost -p ActiveState -p SubState -p NRestarts --no-pager 2>/dev/null || true
fi

if command -v ss >/dev/null 2>&1; then
  if ! ss -lnt | grep -q ":${GOST_PORT} "; then
    echo "本机没有进程监听 ${GOST_PORT}，先确认 gost 已启动" >&2
    exit 1
  fi
fi

fetch_ip() {
  curl -sS --proxy "${PROXY}" "${CURL_AUTH[@]}" \
    --connect-timeout 5 --max-time 15 "${IP_URL}" 2>/dev/null || true
}

ip_begin="$(fetch_ip)"
if [[ -z "${ip_begin}" ]]; then
  echo "出口 IP 获取失败（代理连不上，或出网失败）"
else
  echo "出口 IP: ${ip_begin}"
fi

times_file="$(mktemp)"
trap 'rm -f "${times_file}"' EXIT

ok=0
fail=0

for ((i = 1; i <= N; i++)); do
  set +e
  out="$(curl -sS -o /dev/null --proxy "${PROXY}" "${CURL_AUTH[@]}" \
    --connect-timeout 5 --max-time 15 \
    -w "%{http_code} %{time_total}" "${PING_URL}" 2>/dev/null)"
  rc=$?
  set -e

  code="${out%% *}"
  sec="${out#* }"
  if [[ "${rc}" -eq 0 && "${code}" == "200" ]]; then
    ok=$((ok + 1))
    ms="$(awk -v t="${sec}" 'BEGIN { printf "%d", t * 1000 }')"
    printf "%s\n" "${ms}" >> "${times_file}"
    printf "%3d OK %4d ms\n" "${i}" "${ms}"
  else
    fail=$((fail + 1))
    printf "%3d FAIL rc=%s out=%s\n" "${i}" "${rc}" "${out:-timeout}"
  fi

  if [[ "${i}" -lt "${N}" ]]; then
    sleep "${INTERVAL}"
  fi
done

ip_end="$(fetch_ip)"

echo "==> 结果"
echo "成功 ${ok}/$((ok + fail))  失败 ${fail}"

if [[ -s "${times_file}" ]]; then
  mapfile -t sorted < <(sort -n "${times_file}")
  count="${#sorted[@]}"
  min="${sorted[0]}"
  max="${sorted[$((count - 1))]}"
  median="${sorted[$(((count - 1) / 2))]}"
  sum="$(awk '{ s += $1 } END { printf "%d", s }' "${times_file}")"
  avg=$((sum / count))
  echo "最小 ${min} ms  中位 ${median} ms  平均 ${avg} ms  最大 ${max} ms"
fi

echo "出口 IP 开始: ${ip_begin:-失败}"
echo "出口 IP 结束: ${ip_end:-失败}"
if [[ -n "${ip_begin}" && -n "${ip_end}" && "${ip_begin}" != "${ip_end}" ]]; then
  echo "出口 IP 发生了变化"
fi
