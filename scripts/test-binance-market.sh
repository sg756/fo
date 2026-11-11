#!/bin/bash
# 在 API 服务器上测币安公开行情。不需要 API Key，也不看 IP 白名单。
# 用法：bash test-binance-market.sh
set -u
BASE="${MARKET_SOURCE_URL:-https://api.binance.com}"
BASE="${BASE%/}"

probe() {
  local name="$1"
  local url="$2"
  local body
  body="$(mktemp)"
  echo
  echo "===== ${name} ====="
  echo "URL ${url}"
  curl -sS --connect-timeout 8 -m 20 -o "$body" -w "http=%{http_code} time=%{time_total}s size=%{size_download} exit=%{exitcode}\n" "$url"
  local code=$?
  echo "curl_exit=${code}"
  if [ -s "$body" ]; then
    echo "body:"
    head -c 500 "$body"
    echo
  fi
  rm -f "$body"
  return 0
}

echo "MARKET_SOURCE_URL=${BASE}"
echo
echo "===== DNS ====="
getent hosts api.binance.com || echo "DNS 失败"

probe "单币24小时(含涨跌)" "${BASE}/api/v3/ticker/24hr?symbol=BTCUSDT"
probe "单币最新价(无涨跌)" "${BASE}/api/v3/ticker/price?symbol=BTCUSDT"
probe "全市场24小时(现在代码用的这个)" "${BASE}/api/v3/ticker/24hr"
