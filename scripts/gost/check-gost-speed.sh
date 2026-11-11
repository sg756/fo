#!/usr/bin/env bash
# ============================================================
#  在 Linux 上查内存、CPU，以及访问币安的延迟和网速。
#  开始时选择：1 经本机 gost 代理，2 不走代理直连。
#  走代理时，账号、密码、端口从同目录 gost.conf 读取，不要写进命令行。
#
#  用法：
#    bash check-gost-speed.sh              交互选择 1 或 2
#    bash check-gost-speed.sh 1            经代理（可选第二参数为代理地址）
#    bash check-gost-speed.sh 1 127.0.0.1
#    bash check-gost-speed.sh 2            直连币安
#    bash check-gost-speed.sh 127.0.0.1    旧用法，等同于经代理
#
#  可选环境变量：
#    CHECK_N=8    延迟采样次数，默认 8
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/gost.conf"
MODE=""
HOST="127.0.0.1"
if [[ "${1:-}" == "1" || "${1:-}" == "2" ]]; then
  MODE="$1"
  HOST="${2:-127.0.0.1}"
elif [[ -n "${1:-}" ]]; then
  MODE="1"
  HOST="$1"
elif [[ -t 0 ]]; then
  echo "选择测试方式："
  echo "  1  通过代理"
  echo "  2  不走代理，直连币安"
  read -r -p "请输入 1 或 2: " MODE
else
  MODE="1"
fi
if [[ "${MODE}" != "1" && "${MODE}" != "2" ]]; then
  echo "只能选 1（通过代理）或 2（不走代理）" >&2
  exit 1
fi
N="${CHECK_N:-8}"
PING_URLS=(
  "https://fapi.binance.com/fapi/v1/ping"
  "https://api.binance.com/api/v3/ping"
)
# 约几百 KB，用来估算经代理的下载速度，不拉大文件
SPEED_URL="https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000"

if ! [[ "${N}" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHECK_N 必须是正整数" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "服务器上没有 curl" >&2
  exit 1
fi

GOST_PORT=""
CURL_NET=(--noproxy '*')
VIA_LABEL="直连"
if [[ "${MODE}" == "1" ]]; then
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
  PROXY="http://${HOST}:${GOST_PORT}"
  CURL_AUTH=()
  if [[ -n "${GOST_USER}" || -n "${GOST_PASS}" ]]; then
    if [[ -z "${GOST_USER}" || -z "${GOST_PASS}" ]]; then
      echo "gost.conf 里账号和密码必须同时填写，或同时留空" >&2
      exit 1
    fi
    CURL_AUTH=(--proxy-user "${GOST_USER}:${GOST_PASS}")
  fi
  CURL_NET=(--proxy "${PROXY}" "${CURL_AUTH[@]}")
  VIA_LABEL="经代理 ${PROXY}"
fi

echo "本次：${VIA_LABEL}"

section() {
  echo
  echo "==> $*"
}

kb_to_mib() {
  awk -v k="$1" 'BEGIN { printf "%.1f", k / 1024 }'
}

section "本机内存"
if [[ -r /proc/meminfo ]]; then
  mem_total="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  mem_avail="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
  echo "总内存 $(kb_to_mib "${mem_total}") MiB    可用 $(kb_to_mib "${mem_avail}") MiB"
  if [[ "${mem_total}" -gt 0 ]]; then
    used_pct="$(awk -v t="${mem_total}" -v a="${mem_avail}" 'BEGIN { printf "%d", (t - a) * 100 / t }')"
    echo "已用约 ${used_pct}%"
    if [[ "${used_pct}" -ge 90 ]]; then
      echo "内存已用超过 90%，gost 可能被挤慢，偶发下单超时要先看这个"
    fi
  fi
else
  free -m || true
fi

section "本机 CPU"
if [[ -r /proc/cpuinfo ]]; then
  cpu_cores="$(grep -c '^processor' /proc/cpuinfo)"
  cpu_model="$(awk -F: '/^model name/ { gsub(/^[[:space:]]+/, "", $2); print $2; exit }' /proc/cpuinfo)"
  echo "总核数 ${cpu_cores}"
  if [[ -n "${cpu_model}" ]]; then
    echo "型号 ${cpu_model}"
  fi
elif command -v nproc >/dev/null 2>&1; then
  echo "总核数 $(nproc)"
fi

pid=""
if command -v systemctl >/dev/null 2>&1; then
  pid="$(systemctl show -p MainPID --value gost 2>/dev/null || true)"
fi
if [[ -z "${pid}" || "${pid}" == "0" ]]; then
  pid="$(pgrep -n -x gost || true)"
fi

read_cpu_jiffies() {
  awk '/^cpu / { print ($2+$3+$4+$5+$6+$7+$8+$9), ($5+$6) }' /proc/stat
}
read_proc_jiffies() {
  awk '{
    i = index($0, ")")
    rest = substr($0, i + 2)
    split(rest, f, " ")
    print f[12] + f[13]
  }' "/proc/${1}/stat"
}

if [[ -r /proc/stat ]]; then
  read -r cpu_total1 cpu_idle1 < <(read_cpu_jiffies)
  proc_jiff1=""
  if [[ -n "${pid}" && -r "/proc/${pid}/stat" ]]; then
    proc_jiff1="$(read_proc_jiffies "${pid}")"
  fi
  sleep 1
  read -r cpu_total2 cpu_idle2 < <(read_cpu_jiffies)
  cpu_delta=$((cpu_total2 - cpu_total1))
  idle_delta=$((cpu_idle2 - cpu_idle1))
  if [[ "${cpu_delta}" -gt 0 ]]; then
    cpu_used="$(awk -v d="${cpu_delta}" -v i="${idle_delta}" 'BEGIN { printf "%d", (d - i) * 100 / d }')"
    echo "整体占用约 ${cpu_used}%（采样 1 秒）"
    if [[ "${cpu_used}" -ge 90 ]]; then
      echo "CPU 已用超过 90%，偶发下单超时要先看这个"
    fi
  fi
  if [[ -n "${proc_jiff1}" && -r "/proc/${pid}/stat" ]]; then
    proc_jiff2="$(read_proc_jiffies "${pid}")"
    clk="$(getconf CLK_TCK 2>/dev/null || echo 100)"
    awk -v d="$((proc_jiff2 - proc_jiff1))" -v hz="${clk}" \
      'BEGIN { printf "gost 占用约 %.1f%%（相对单核，采样 1 秒）\n", d / hz * 100 }'
  fi
fi

if [[ -r /proc/loadavg ]]; then
  echo "负载 $(cut -d' ' -f1-3 /proc/loadavg)"
fi

if [[ "${MODE}" == "1" ]]; then
section "gost 进程"
if command -v systemctl >/dev/null 2>&1; then
  systemctl show gost -p ActiveState -p SubState -p NRestarts -p MemoryCurrent --no-pager 2>/dev/null || true
fi
if [[ -n "${pid}" && -r "/proc/${pid}/status" ]]; then
  rss="$(awk '/^VmRSS:/ { print $2 }' "/proc/${pid}/status")"
  peak="$(awk '/^VmPeak:/ { print $2 }' "/proc/${pid}/status")"
  threads="$(awk '/^Threads:/ { print $2 }' "/proc/${pid}/status")"
  echo "PID ${pid}    常驻 $(kb_to_mib "${rss}") MiB    虚拟峰值 $(kb_to_mib "${peak}") MiB    线程 ${threads}"
else
  echo "没有找到 gost 进程"
fi

if command -v ss >/dev/null 2>&1; then
  listen="$(ss -lnt | grep -c ":${GOST_PORT} " || true)"
  established="$(ss -Htn state established "sport = :${GOST_PORT}" 2>/dev/null | wc -l | tr -d ' ')"
  echo "监听 ${GOST_PORT}: ${listen}    已建立连接 ${established}"
  if [[ "${listen}" -eq 0 ]]; then
    echo "本机没有进程监听 ${GOST_PORT}，代理起不来时下单会失败" >&2
    exit 1
  fi
fi
fi

probe() {
  local url="$1"
  local out rc code sec
  set +e
  out="$(curl -sS -o /dev/null "${CURL_NET[@]}" \
    --connect-timeout 5 --max-time 15 \
    -w "%{http_code} %{time_connect} %{time_starttransfer} %{time_total}" \
    "${url}" 2>/dev/null)"
  rc=$?
  set -e
  if [[ "${rc}" -ne 0 ]]; then
    echo "FAIL rc=${rc}"
    return
  fi
  code="${out%% *}"
  # shellcheck disable=SC2086
  set -- ${out}
  code="$1"
  if [[ "${code}" != "200" ]]; then
    echo "FAIL http=${code}"
    return
  fi
  awk -v c="$2" -v s="$3" -v t="$4" 'BEGIN {
    printf "OK 连接 %d ms  首字节 %d ms  总耗时 %d ms\n", c * 1000, s * 1000, t * 1000
  }'
}

section "${VIA_LABEL} 访问币安（延迟，各 ${N} 次）"
for url in "${PING_URLS[@]}"; do
  echo "-- ${url}"
  ok=0
  fail=0
  times_file="$(mktemp)"
  for ((i = 1; i <= N; i++)); do
    set +e
    out="$(curl -sS -o /dev/null "${CURL_NET[@]}" \
      --connect-timeout 5 --max-time 15 \
      -w "%{http_code} %{time_total}" "${url}" 2>/dev/null)"
    rc=$?
    set -e
    code="${out%% *}"
    sec="${out#* }"
    if [[ "${rc}" -eq 0 && "${code}" == "200" ]]; then
      ok=$((ok + 1))
      awk -v t="${sec}" 'BEGIN { printf "%d\n", t * 1000 }' >> "${times_file}"
    else
      fail=$((fail + 1))
    fi
  done
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
    if [[ "${max}" -ge 3000 || "${fail}" -gt 0 ]]; then
      echo "有超时或超过 3 秒的请求，和偶发下单失败相符"
    fi
  fi
  rm -f "${times_file}"
done

section "${VIA_LABEL} 下载速度（1 次）"
set +e
speed_out="$(curl -sS -o /dev/null "${CURL_NET[@]}" \
  --connect-timeout 5 --max-time 30 \
  -w "%{http_code} %{size_download} %{speed_download} %{time_total}" \
  "${SPEED_URL}" 2>/dev/null)"
speed_rc=$?
set -e
if [[ "${speed_rc}" -ne 0 ]]; then
  echo "下载失败 rc=${speed_rc}  ${SPEED_URL}"
else
  # shellcheck disable=SC2086
  set -- ${speed_out}
  if [[ "$1" != "200" ]]; then
    echo "下载失败 HTTP $1"
  else
    awk -v bytes="$2" -v bps="$3" -v sec="$4" 'BEGIN {
      printf "大小 %.1f KiB    速度 %.1f KiB/s    耗时 %.2f s\n", bytes / 1024, bps / 1024, sec
    }'
  fi
fi

echo
if [[ "${MODE}" == "1" ]]; then
  echo "延迟看下单会不会偶发超时；速度低或内存已用超过 90% 时，优先查这台代理机。"
else
  echo "这是本机直连币安，不经过 gost。延迟看下单会不会偶发超时；速度低或内存已用超过 90% 时，先看这台机器本身。"
fi
