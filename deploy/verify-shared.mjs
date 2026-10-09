// The daemon control socket uses WebSocket over UDS, NOT newline-delimited JSON.
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const socketPath =
  process.env.CODEX_SOCKET ||
  path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'app-server-control',
    'app-server-control.sock',
  );
const ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 10000 });
let seq = 0;
const pending = new Map();
function fail(error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}
ws.on('error', fail);
ws.on('close', () => fail(new Error('共享后台连接关闭')));
ws.on('message', (raw) => {
  let m;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.timer);
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`共享后台响应超时：${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  console.log('控制 socket WebSocket 握手成功');
  await call('initialize', {
    clientInfo: { name: 'codex_mobile_migration', version: '0.2.1' },
    capabilities: { experimentalApi: false },
  });
  ws.send(JSON.stringify({ method: 'initialized' }));
  console.log('Codex initialize 成功');
  const dir = process.argv[2];
  const entries =
    dir && fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((n) => fs.existsSync(path.join(dir, n, 'manifest.json')))
          .sort()
      : [];
  const ids = new Set();
  for (const name of entries) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json')));
    for (const x of m.copied || []) ids.add(x.id);
    for (const id of m.skipped || []) ids.add(id);
  }
  for (const id of ids) {
    console.log(`验证会话 ${id}`);
    await call('thread/read', { threadId: id, includeTurns: true });
    await call('thread/resume', { threadId: id });
    await call('thread/unsubscribe', { threadId: id });
  }
  console.log(`共享后台可连接；${ids.size} 个已迁移会话可读取并 resume。`);
} catch (e) {
  console.error(`验证失败：${e.message}`);
  process.exitCode = 1;
} finally {
  ws.terminate();
  for (const p of pending.values()) clearTimeout(p.timer);
}
