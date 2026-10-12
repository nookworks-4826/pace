#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm test -- --maxWorkers=2
npm run build
npm run privacy:audit
npm run test:experience
