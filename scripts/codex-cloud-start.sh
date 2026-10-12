#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npm run dev -- --port "${PORT:-5173}" --strictPort
