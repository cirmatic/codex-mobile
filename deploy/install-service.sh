#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(command -v node)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$config_dir"
cat > "$config_dir/codex-mobile.service" <<UNIT
[Unit]
Description=Codex Mobile bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=$app_dir/deploy/ensure-daemon.sh
WorkingDirectory=$app_dir
ExecStart=$node_bin --env-file-if-exists=.runtime/service.env $app_dir/dist/server/index.js
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=10
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now codex-mobile.service
systemctl --user --no-pager status codex-mobile.service
