#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_dir"
systemctl --user show-environment >/dev/null
service_file="$app_dir/.runtime/service.env"
backup_file="$app_dir/.runtime/service.env.before-shared"
if [ ! -f "$backup_file" ]; then cp -- "$service_file" "$backup_file"; chmod 600 "$backup_file"; fi
node --check deploy/verify-shared.mjs
npm run build
systemctl --user stop codex-mobile.service
if curl --silent --max-time 2 --fail http://127.0.0.1:3050/api/health >/dev/null; then
  echo '3050 仍有手动启动的实例，请先在其终端 Ctrl+C 或对准确 PID 发送 SIGTERM，再执行本脚本。'
  exit 1
fi
python3 deploy/migrate-sessions.py --source "$app_dir/.runtime/app-home" --target "$HOME/.codex" --backups "$app_dir/.runtime/migration-backups"
codex app-server daemon start
CODEX_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock" node deploy/verify-shared.mjs "$app_dir/.runtime/migration-backups"
python3 - <<'PY'
from pathlib import Path
p=Path('.runtime/service.env')
lines=[l for l in p.read_text().splitlines() if not l.startswith(('CODEX_MOBILE_HOME=','CODEX_CONNECTION=','CODEX_ARGS_JSON=','CODEX_REMOTE_URL=','CODEX_SOCKET='))]
p.write_text('\n'.join(lines+['CODEX_CONNECTION=shared'])+'\n');p.chmod(0o600)
PY
bash deploy/install-service.sh
echo '已切换到共享 daemon。请刷新手机网页。配置备份：.runtime/service.env.before-shared'
