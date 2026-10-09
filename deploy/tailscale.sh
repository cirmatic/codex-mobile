#!/usr/bin/env bash
set -euo pipefail
# Install Tailscale and sign in first, on Ubuntu and Android.
command -v tailscale >/dev/null || { echo '请先安装 Tailscale 并执行 tailscale up 登录。'; exit 1; }
tailscale serve --bg "${1:-3030}"
tailscale serve status
