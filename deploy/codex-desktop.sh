#!/usr/bin/env bash
# Optional diagnostic helper. Normal codex / codex resume already uses the shared daemon.
# Run from your project directory; pass resume THREAD_ID to explicitly attach.
set -euo pipefail
codex app-server daemon start
exec codex --remote unix:// "$@"
