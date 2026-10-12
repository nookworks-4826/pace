#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The environment must provide Node 24, matching the project's existing CI.
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("Configure Node.js 24 before running setup."); process.exit(1); }'
npm ci
npx --no-install playwright install --with-deps chromium
node scripts/prepare-ocr.mjs
printf '%s\n' 'Dependencies, Chromium and local OCR assets are ready.'
