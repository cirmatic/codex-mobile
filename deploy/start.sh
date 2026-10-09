#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_dir"
bash deploy/ensure-daemon.sh
exec node --env-file-if-exists=.runtime/service.env dist/server/index.js
