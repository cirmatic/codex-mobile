import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { z } from 'zod';
import { Projects } from './paths.js';
import { createDownloadPolicy, FileAccessError, FileBrowser } from './files.js';
import { Codex } from './codex.js';
import { Sessions } from './sessions.js';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes('/dist/') ? '../..' : '..',
);
const runtime = path.resolve(process.env.RUNTIME_DIR || path.join(root, '.runtime'));
await mkdir(runtime, { recursive: true, mode: 0o700 });
const tokenFile = path.join(runtime, 'access-token');
let token: string;
try {
  token = (await readFile(tokenFile, 'utf8')).trim();
} catch {
  token = randomBytes(24).toString('base64url');
  await writeFile(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
}
await chmod(tokenFile, 0o600);
const projects = new Projects(
  (process.env.PROJECT_ROOTS || path.join(os.homedir(), 'ideas'))
    .split(path.delimiter)
    .map((s) => path.resolve(s)),
);
await projects.init();
const files = new FileBrowser(
  projects,
  createDownloadPolicy(
    os.homedir(),
    (process.env.FILE_DOWNLOAD_DENY_PATHS || '').split(path.delimiter).filter(Boolean),
  ),
);
const codex = new Codex();
const sessions = new Sessions(codex, projects);
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});
app.use(express.json({ limit: '128kb' }));
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sign(value: string) {
  return createHmac('sha256', token).update(value).digest('base64url');
}
function authorized(req: any) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)cm_session=([^;]+)/);
  if (!match) return false;
  const [expires, sig] = match[1].split('.');
  return Number(expires) > Date.now() && !!sig && equal(sign(expires), sig);
}
function validOrigin(req: any) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (process.env.PUBLIC_ORIGIN) return origin === process.env.PUBLIC_ORIGIN;
  try {
    const u = new URL(origin);
    return ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host;
  } catch {
    return false;
  }
}
const attempts = new Map<string, { count: number; until: number }>();
app.get('/api/health', (_req, res) => res.json({ ok: true, codexReady: codex.ready }));
app.get('/api/session', (req, res) => res.json({ authenticated: authorized(req) }));
app.post('/api/login', (req, res) => {
  if (!validOrigin(req)) {
    res.status(403).json({ error: '来源不匹配' });
    return;
  }
  const ip = req.socket.remoteAddress || '';
  let entry = attempts.get(ip);
  if (!entry || entry.until < Date.now()) {
    entry = { count: 0, until: Date.now() + 60000 };
    attempts.set(ip, entry);
  }
  if (++entry.count > 20) {
    res.status(429).json({ error: '尝试过多，请一分钟后重试' });
    return;
  }
  if (typeof req.body?.token !== 'string' || !equal(req.body.token.trim(), token)) {
    res.status(401).json({ error: '连接密钥不正确' });
    return;
  }
  attempts.delete(ip);
  const expires = String(Date.now() + 30 * 86400000);
  const secure = req.headers.origin?.startsWith('https://') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `cm_session=${expires}.${sign(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
  );
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  if (!validOrigin(req)) {
    res.sendStatus(403);
    return;
  }
  res.setHeader('Set-Cookie', 'cm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) {
    res.status(401).json({ error: '请先连接电脑' });
    return;
  }
  next();
});
app.get('/api/config', (_req, res) => res.json({ roots: projects.roots, codexReady: codex.ready }));
app.get('/api/directories', async (req, res) => {
  try {
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';
    res.json(
      await projects.list(
        typeof req.query.path === 'string' ? req.query.path : undefined,
        showHidden,
      ),
    );
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.post('/api/directories', async (req, res) => {
  if (!validOrigin(req)) {
    res.sendStatus(403);
    return;
  }
  try {
    const p = z.object({ parent: z.string(), name: z.string() }).parse(req.body);
    res.json({ path: await projects.create(p.parent, p.name) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
function fileError(res: express.Response, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  const status =
    error instanceof FileAccessError
      ? error.status
      : code === 'ENOENT'
        ? 404
        : code === 'EACCES'
          ? 403
          : 400;
  res.status(status).json({
    error:
      error instanceof FileAccessError
        ? error.message
        : status === 404
          ? '文件不存在'
          : status === 403
            ? '无法访问此文件'
            : '文件请求无效',
  });
}
app.get('/api/files', async (req, res) => {
  try {
    if (typeof req.query.workspace !== 'string') throw new FileAccessError('请选择工作区');
    const relative = typeof req.query.path === 'string' ? req.query.path : '';
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    res.json(await files.list(req.query.workspace, relative, cursor));
  } catch (error) {
    fileError(res, error);
  }
});
app.get('/api/files/download', async (req, res) => {
  try {
    if (typeof req.query.workspace !== 'string' || typeof req.query.path !== 'string') {
      throw new FileAccessError('请选择文件');
    }
    const file = await files.download(req.query.workspace, req.query.path);
    res.download(file.path, file.name, (error) => {
      if (error && !res.headersSent) fileError(res, error);
      else if (error) res.destroy(error);
    });
  } catch (error) {
    fileError(res, error);
  }
});
app.use(
  express.static(path.join(root, 'dist/public'), {
    index: 'index.html',
    setHeaders(res, file) {
      if (file.endsWith('.html') || file.endsWith('sw.js'))
        res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(400).json({ error: err.type === 'entity.too.large' ? '消息过大' : '请求无效' }),
);
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !authorized(req) || !validOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
const clients = new Map<WebSocket, { threadId?: string; alive: boolean }>();
function send(ws: WebSocket, m: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      ws.close(1013, '请重新连接');
      return;
    }
    ws.send(JSON.stringify(m));
  }
}
codex.on('ready', () => {
  for (const ws of clients.keys()) send(ws, { event: 'ready', data: { codexReady: true } });
});
sessions.on('historyChanged', () => {
  for (const ws of clients.keys()) send(ws, { event: 'historyChanged' });
});
sessions.on('state', (s) => {
  for (const [ws, c] of clients) {
    if (c.threadId === s.id) send(ws, { event: 'state', data: s });
    send(ws, { event: 'running', data: sessions.running() });
  }
});
sessions.on('unavailable', (message) => {
  for (const ws of clients.keys()) send(ws, { event: 'unavailable', data: message });
});
const paramsSchema = z.object({
  id: z.string().max(100),
  action: z.enum([
    'list',
    'models',
    'running',
    'workspace',
    'create',
    'open',
    'send',
    'stop',
    'respond',
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
});
wss.on('connection', (ws) => {
  const c: { threadId?: string; alive: boolean } = { alive: true };
  clients.set(ws, c);
  send(ws, { event: 'ready', data: { codexReady: codex.ready } });
  ws.on('pong', () => (c.alive = true));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => {});
  ws.on('message', async (raw) => {
    let id: string | undefined;
    try {
      const m = paramsSchema.parse(JSON.parse(raw.toString()));
      id = m.id;
      const p = m.params;
      let result: any;
      if (!codex.ready) throw new Error('Codex 尚未就绪，请检查服务状态');
      const threadId = () => z.string().min(1).parse(p.threadId);
      switch (m.action) {
        case 'list':
          result = await sessions.list(
            z.string().parse(p.cwd),
            z.string().optional().parse(p.cursor),
          );
          break;
        case 'workspace':
          result = { cwd: await projects.resolve(z.string().parse(p.cwd)) };
          c.threadId = undefined;
          break;
        case 'running':
          result = sessions.running();
          break;
        case 'models':
          result = await sessions.listModels();
          break;
        case 'create':
          result = await sessions.create(
            z.string().parse(p.cwd),
            z.string().max(200).optional().parse(p.model),
            z.string().max(30).optional().parse(p.effort),
          );
          c.threadId = result.id;
          break;
        case 'open':
          result = await sessions.open(threadId());
          c.threadId = result.id;
          break;
        case 'send': {
          const tid = threadId();
          if (c.threadId !== tid) throw new Error('请先打开此会话');
          result = await sessions.send(
            tid,
            z.string().trim().min(1).max(50000).parse(p.text),
            z.string().max(200).optional().parse(p.model),
            z.string().max(30).optional().parse(p.effort),
          );
          break;
        }
        case 'stop':
          if (c.threadId !== threadId()) throw new Error('请先打开此会话');
          result = await sessions.stop(threadId());
          break;
        case 'respond':
          if (c.threadId !== threadId()) throw new Error('请先打开此会话');
          result = sessions.respond(
            threadId(),
            z.union([z.string(), z.number()]).parse(p.requestId),
            p.answer,
          );
          break;
      }
      send(ws, { id, result });
    } catch (e) {
      send(ws, { id, error: (e as Error).message });
    }
  });
});
const heartbeat = setInterval(() => {
  for (const [ws, c] of clients) {
    if (!c.alive) {
      ws.terminate();
      continue;
    }
    c.alive = false;
    ws.ping();
  }
}, 25000);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
server.on('error', (e) => {
  console.error('服务监听失败：', (e as Error).message);
  codex.close();
  process.exit(1);
});
server.listen(port, host, () =>
  console.log(`Codex Mobile: http://${host}:${port}\n连接密钥文件: ${tokenFile}`),
);
try {
  await codex.start();
  console.log('Codex app-server ready');
} catch (e) {
  console.error('Codex startup failed:', (e as Error).message);
}
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  for (const ws of clients.keys()) ws.close(1001);
  codex.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
