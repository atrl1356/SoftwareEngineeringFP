#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/openspec-env.sh
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<20)) { console.error("需要 Node.js >=22.20.0"); process.exit(1); }'
if [[ ! -x /workspace/.tools/bin/openspec ]] || [[ "$(/workspace/.tools/bin/openspec --version)" != "2.1.0" ]]; then
  npm --cache /workspace/.cache/npm install --global --prefix /workspace/.tools @fission-ai/openspec@2.1.0
fi
# 官方 profile 設定位於 XDG_CONFIG_HOME；只更新本專案需要的欄位。
openspec config set profile custom
openspec config set workflows '["propose","explore","apply","update","sync","archive","bulk-archive","verify"]'
# 更新前先檢視差異；不自動重寫可能已自訂的 Skills。
openspec --version
openspec update --dry-run
openspec list --json
