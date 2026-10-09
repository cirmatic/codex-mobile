#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime/fixture-projects/.fixture-hidden
PORT=3031 RUNTIME_DIR=.runtime/fixture PROJECT_ROOTS="$PWD/.runtime/fixture-projects" CODEX_BIN=node CODEX_ARGS_JSON='["tests/fake-codex.mjs"]' FAKE_STATE_FILE=.runtime/fixture/history.json node dist/server/index.js &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
for i in {1..50}; do
  if curl --silent --fail http://127.0.0.1:3031/api/health >/dev/null; then break; fi
  sleep 0.2
done
python3 tests/browser-fixture.py
