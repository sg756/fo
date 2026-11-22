#!/usr/bin/env bash
# 导出 H5 到 apps/mobile/dist。页面挂在 /h5/，接口走同机 /api。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="${ROOT}/apps/mobile"
cd "${MOBILE}"

if [[ ! -f app.json ]]; then
  cp app.json.example app.json
fi

node <<'EOF'
const fs = require('fs');
const p = 'app.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.expo.experiments = j.expo.experiments || {};
j.expo.experiments.baseUrl = '/h5';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
EOF

cat > src/api/api.endpoint.ts <<'EOF'
/**
 * 发布包里的 H5 与后台同一台机器，接口用当前网站的 /api。
 */
export const PACKAGED_API_BASE = '/api';
export const PACKAGED_WEB_API_BASE = '/api';
EOF

npm ci
npx expo export --platform web --output-dir dist
test -f dist/index.html
echo "H5 已导出: ${MOBILE}/dist"
