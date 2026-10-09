import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import path from 'node:path';
import os from 'node:os';
export class Codex extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private socket?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  ready = false;
  async start() {
    const command = process.env.CODEX_BIN || 'codex';
    this.stopped = false;
    const receive = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method) {
        this.emit(msg.id !== undefined ? 'request' : 'notification', msg);
        return;
      }
      const request = this.pending.get(msg.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(msg.id);
      if (msg.error) request.reject(new Error(msg.error.message || 'Codex 请求失败'));
      else request.resolve(msg.result);
    };
    const shared = !process.env.CODEX_ARGS_JSON && process.env.CODEX_CONNECTION !== 'standalone';
    if (process.env.CODEX_REMOTE_URL || shared) {
      let address: string;
      if (process.env.CODEX_REMOTE_URL) {
        const url = new URL(process.env.CODEX_REMOTE_URL);
        if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          throw new Error('CODEX_REMOTE_URL 仅支持本机 ws:// 地址');
        address = url.toString();
      } else {
        const socketPath =
          process.env.CODEX_SOCKET ||
          path.join(
            process.env.CODEX_MOBILE_HOME ||
              process.env.CODEX_HOME ||
              path.join(os.homedir(), '.codex'),
            'app-server-control',
            'app-server-control.sock',
          );
        address = `ws+unix://${socketPath}:/`;
      }
      const socket = new WebSocket(address, { handshakeTimeout: 10000 });
      this.socket = socket;
      socket.on('message', (data) => receive(data.toString()));
      socket.on('close', () => this.failed(new Error('共享 Codex 连接已断开，正在重连')));
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error('Codex 连接超时'));
        }, 10000);
        socket.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } else {
      const args = process.env.CODEX_ARGS_JSON
        ? JSON.parse(process.env.CODEX_ARGS_JSON)
        : ['app-server'];
      this.proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(process.env.CODEX_MOBILE_HOME ? { CODEX_HOME: process.env.CODEX_MOBILE_HOME } : {}),
        },
      });
      this.proc.on('error', (e) => this.failed(e));
      this.proc.on('exit', () =>
        this.failed(
          new Error('共享 Codex 未连接，请在电脑执行 codex app-server daemon start；正在重连'),
        ),
      );
      this.proc.stderr.on('data', () => {});
      this.proc.stdin.on('error', (e) => this.failed(e));
      createInterface({ input: this.proc.stdout }).on('line', receive);
    }
    await this.call('initialize', {
      clientInfo: { name: 'codex_mobile', title: 'Codex Mobile', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.write({ method: 'initialized' });
    this.ready = true;
    this.emit('ready');
  }
  private failed(e: Error) {
    this.ready = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    if (this.stopped) return;
    this.emit('unavailable', e.message);
    if (!this.retry)
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.start().catch((error) => this.failed(error));
      }, 5000);
  }
  private write(message: unknown) {
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex 未连接');
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable)
      throw new Error('Codex 未连接');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 响应超时：${method}。请重新同步状态，勿重复提交。`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  answer(id: string | number, result: unknown) {
    this.write({ id, result });
  }
  reject(id: string | number) {
    this.write({
      id,
      error: { code: -32601, message: 'This client does not support this request' },
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.proc?.kill('SIGTERM'); // Only the proxy client is stopped in shared mode.
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('桥接已关闭'));
    }
    this.pending.clear();
  }
}
