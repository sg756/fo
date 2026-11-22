#!/usr/bin/env bash
# 把已编好的 dist-release/ 打成 dist-release.zip（供 GitHub Release / 一键安装）
# 前置：先跑 Windows build.ps1，或 CI 里编好 apps/*/dist 并组装到 dist-release/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/dist-release"
ZIP="${ROOT}/dist-release.zip"

if [[ ! -f "${OUT}/apps/api/dist/main.js" ]]; then
  echo "缺少 ${OUT}/apps/api/dist/main.js，请先编译并组装 dist-release/" >&2
  exit 1
fi
if [[ ! -f "${OUT}/apps/admin/dist/index.html" ]]; then
  echo "缺少 ${OUT}/apps/admin/dist/index.html" >&2
  exit 1
fi

# 确保安装脚本进包（一键更新后机器上仍有 bootstrap/fetch）
mkdir -p "${OUT}/scripts/install-env"
cp -a "${ROOT}/scripts/install-env/." "${OUT}/scripts/install-env/"
# 包内 conf 用仓库模板；服务器本地 conf 由 fetch 保留逻辑跳过覆盖

rm -f "$ZIP"
(
  cd "$OUT"
  zip -r "$ZIP" .
)

echo "已生成 ${ZIP}"
