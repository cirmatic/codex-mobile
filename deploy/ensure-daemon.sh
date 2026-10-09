#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_dir"
node --env-file-if-exists=.runtime/service.env --input-type=module <<'JS'
import {spawnSync} from 'node:child_process';
if(process.env.CODEX_CONNECTION!=='standalone' && !process.env.CODEX_ARGS_JSON && !process.env.CODEX_REMOTE_URL){
 const result=spawnSync(process.env.CODEX_BIN||'codex',['app-server','daemon','start'],{stdio:'inherit',env:process.env});
 if(result.error)console.error(result.error.message);process.exit(result.status??1);
}
JS
