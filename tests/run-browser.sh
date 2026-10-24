#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
fixture_root=$(mktemp -d "$PWD/artifacts/browser-projects.XXXXXX")
mkdir -p "$fixture_root/.fixture-hidden"
printf 'blocked\n' > "$fixture_root/private-note.txt"
PORT=3031 RUNTIME_DIR=.runtime/fixture PROJECT_ROOTS="$fixture_root" FILE_DOWNLOAD_DENY_PATHS="$fixture_root/private-note.txt" CODEX_BIN=node CODEX_ARGS_JSON='["tests/fake-codex.mjs"]' FAKE_STATE_FILE=.runtime/fixture/history.json node dist/server/index.js &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; rm -rf "$fixture_root"' EXIT
for i in {1..50}; do
  if curl --silent --fail http://127.0.0.1:3031/api/health >/dev/null; then break; fi
  sleep 0.2
done
TEST_PROJECT_ROOT="$fixture_root" "${PYTHON:-python3}" tests/browser-fixture.py
