import { EventEmitter } from 'node:events';
import { Codex } from './codex.js';
import { Projects } from './paths.js';
import type { ThreadState, Item, Approval } from '../shared/types.js';
const LIMIT = 160_000;
function clip(s: string) {
  return s.length > LIMIT ? '[较早内容已截断]\n' + s.slice(-LIMIT) : s;
}
export class Sessions extends EventEmitter {
  states = new Map<string, ThreadState>();
  private revisions = new Map<string, number>();
  private locks = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    public codex: Codex,
    public projects: Projects,
  ) {
    super();
    codex.on('ready', () => {
      this.states.clear();
      this.revisions.clear();
    });
    codex.on('notification', (m) => this.event(m));
    codex.on('request', (m) => this.request(m));
    codex.on('unavailable', (message) => {
      for (const s of this.states.values()) {
        s.activeTurnId = null;
        s.status = 'failed';
        s.error = message;
        s.approvals = [];
        this.changed(s.id);
      }
      this.emit('unavailable', message);
    });
  }
  private changed(id: string) {
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const s = this.states.get(id);
        if (s) this.emit('state', s);
      }, 40),
    );
  }
  private hydrate(t: any, config: any = {}): ThreadState {
    const turns = t.turns || [];
    const active = turns.findLast((v: any) => v.status === 'inProgress');
    const s: ThreadState = {
      id: t.id,
      cwd: t.cwd,
      title: t.name || t.preview || '新会话',
      model: config.model ?? t.model,
      effort: config.reasoningEffort ?? t.reasoningEffort,
      items: turns.flatMap((v: any) => v.items || []),
      activeTurnId: active?.id || null,
      status:
        active || t.status?.type === 'active'
          ? 'running'
          : t.status?.type === 'systemError'
            ? 'failed'
            : 'idle',
      approvals: this.states.get(t.id)?.approvals || [],
    };
    this.states.set(s.id, s);
    return s;
  }
  async list(cwd: string, cursor?: string) {
    cwd = await this.projects.resolve(cwd);
    const r = await this.codex.call('thread/list', {
      cwd,
      limit: 50,
      cursor,
      sourceKinds: ['appServer', 'cli', 'vscode', 'exec'],
      sortKey: 'updated_at',
    });
    const data = [];
    for (const t of r.data) {
      try {
        if ((await this.projects.resolve(t.cwd)) !== cwd) continue;
        data.push({
          id: t.id,
          cwd: t.cwd,
          title: t.name || t.preview || '新会话',
          updatedAt: t.updatedAt,
          status: t.status?.type,
        });
      } catch {}
    }
    for (const s of this.states.values())
      if (s.cwd === cwd && !data.some((t) => t.id === s.id) && !cursor)
        data.unshift({
          id: s.id,
          cwd: s.cwd,
          title: s.title,
          updatedAt: Date.now() / 1000,
          status: s.status,
        });
    return { data, nextCursor: r.nextCursor };
  }
  async listModels() {
    const data = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const r = await this.codex.call('model/list', { limit: 100, includeHidden: false, cursor });
      if (Array.isArray(r.data)) data.push(...r.data);
      cursor = r.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error('模型列表分页异常，请重新连接');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { data, nextCursor: null };
  }
  private async parameters(model?: string, effort?: string, previous?: ThreadState) {
    const effective = model || previous?.model;
    if (!effective) {
      if (effort) throw new Error('请先选择模型，再选择推理强度');
      return {};
    }
    if (!effort && effective === previous?.model) return model ? { model } : {};
    const { data } = await this.listModels();
    const entry = data.find((m) => (m.model || m.id) === effective);
    if (effort && !entry?.supportedReasoningEfforts?.some((v: any) => v.reasoningEffort === effort))
      throw new Error('所选模型不支持该推理强度，请重新选择');
    return { model: effective, effort: effort || entry?.defaultReasoningEffort };
  }
  async create(cwd: string, model?: string, effort?: string) {
    cwd = await this.projects.resolve(cwd);
    const choice = await this.parameters(model, effort);
    const r = await this.codex.call('thread/start', {
      cwd,
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.effort ? { config: { model_reasoning_effort: choice.effort } } : {}),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      ephemeral: false,
    });
    return this.hydrate(r.thread, r);
  }
  async open(id: string) {
    const revision = this.revisions.get(id) || 0;
    let r;
    try { r = await this.codex.call('thread/read', { threadId: id, includeTurns: true }); }
    catch (e) {
      const cached = this.states.get(id);
      if (cached && !cached.items.length && /no rollout found|rollout .* is empty/.test((e as Error).message)) return cached;
      throw e;
    }
    await this.projects.resolve(r.thread.cwd);
    if (!this.states.has(id)) {
      // Resume without overriding the desktop's permissions, model or effort.
      const resumed = await this.codex.call('thread/resume', { threadId: id });
      if ((this.revisions.get(id) || 0) !== revision && this.states.has(id)) return this.get(id);
      return this.hydrate(resumed.thread, resumed);
    }
    if ((this.revisions.get(id) || 0) !== revision) return this.get(id);
    return this.hydrate(r.thread);
  }
  running() {
    return [...this.states.values()]
      .filter((s) => s.activeTurnId || s.status === 'running' || s.status === 'starting')
      .map((s) => ({ id: s.id, cwd: s.cwd, title: s.title, status: s.status }));
  }
  private get(id: string) {
    const s = this.states.get(id);
    if (!s) throw new Error('请先打开会话');
    return s;
  }
  async send(id: string, text: string, model?: string, effort?: string) {
    const s = this.get(id);
    if (s.activeTurnId || s.status === 'running' || this.locks.has(id))
      throw new Error('Codex 正在执行，请等待完成或先停止');
    this.locks.add(id);
    s.error = undefined;
    s.status = 'starting';
    this.changed(id);
    try {
      const choice = await this.parameters(model, effort, s);
      // Check server state too: a desktop client may have started a turn.
      let current;
      try { current = await this.codex.call('thread/read', { threadId: id, includeTurns: false }); }
      catch (e) {
        if (s.items.length || !/no rollout found|rollout .* is empty/.test((e as Error).message)) throw e;
        current = {}; // Codex persists a new empty thread only when its first turn starts.
      }
      if (current.thread?.status?.type === 'active')
        throw new Error('电脑端正在执行该会话，请等待完成或先停止');
      const r = await this.codex.call('turn/start', {
        threadId: id,
        input: [{ type: 'text', text }],
        ...choice,
      });
      if (choice.model) s.model = choice.model;
      if (choice.effort) s.effort = choice.effort;
      // A very short turn may already have completed before the RPC response.
      if (s.status === 'starting') {
        s.activeTurnId = r.turn.id;
        s.status = 'running';
      }
      if (s.title === '新会话') s.title = text.slice(0, 60);
      this.changed(id);
      return { turnId: r.turn.id };
    } catch (e) {
      if (s.status === 'starting') s.status = 'idle';
      this.changed(id);
      throw e;
    } finally {
      this.locks.delete(id);
    }
  }
  async stop(id: string) {
    const s = this.get(id);
    if (s.activeTurnId)
      await this.codex.call('turn/interrupt', { threadId: id, turnId: s.activeTurnId });
    return {};
  }
  respond(id: string, requestId: string | number, answer: any) {
    const s = this.get(id);
    const a = s.approvals.find((v) => v.id === requestId);
    if (!a) throw new Error('该请求已处理或已过期');
    let result: any;
    if (a.method === 'item/tool/requestUserInput') {
      const questions = a.params.questions || [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of questions) {
        const value = answer.answers?.[q.id];
        if (typeof value !== 'string' || !value.trim() || value.length > 10000)
          throw new Error('请回答每个问题');
        answers[q.id] = { answers: [value] };
      }
      result = { answers };
    } else if (a.method === 'item/permissions/requestApproval') {
      result = {
        permissions: answer.decision === 'accept' ? a.params.permissions : {},
        scope: 'turn',
      };
    } else {
      if (!['accept', 'decline'].includes(answer.decision)) throw new Error('无效的批准选项');
      const available = a.params.availableDecisions;
      const decision =
        answer.decision === 'decline' &&
        Array.isArray(available) &&
        !available.includes('decline') &&
        available.includes('cancel')
          ? 'cancel'
          : answer.decision;
      if (Array.isArray(available) && !available.includes(decision))
        throw new Error('此请求不支持该操作');
      result = { decision };
    }
    this.codex.answer(a.id, result);
    s.approvals = s.approvals.filter((v) => v.id !== a.id);
    this.changed(id);
    return {};
  }
  private request(m: any) {
    const s = this.states.get(m.params?.threadId);
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'item/permissions/requestApproval',
    ];
    if (!s || !supported.includes(m.method)) {
      this.codex.reject(m.id);
      if (s) {
        s.error = `客户端暂不支持交互：${m.method}`;
        this.changed(s.id);
      }
      return;
    }
    s.approvals.push(m as Approval);
    this.changed(s.id);
  }
  private event(m: any) {
    const p = m.params || {};
    if (m.method === 'serverRequest/resolved') {
      for (const s of this.states.values()) {
        s.approvals = s.approvals.filter((a) => a.id !== p.requestId);
        this.changed(s.id);
      }
      return;
    }
    if (
      ['thread/started', 'thread/name/updated', 'turn/started', 'turn/completed'].includes(m.method)
    )
      this.emit('historyChanged');
    const s = this.states.get(p.threadId);
    if (!s) return;
    switch (m.method) {
      case 'thread/status/changed':
        if (p.status?.type === 'active') s.status = 'running';
        else if (p.status?.type === 'idle') {
          s.status = 'idle';
          s.activeTurnId = null;
        }
        break;
      case 'thread/name/updated':
        s.title = p.threadName || p.name || s.title;
        break;
      case 'turn/started':
        s.activeTurnId = p.turn.id;
        s.status = 'running';
        s.error = undefined;
        break;
      case 'turn/completed':
        s.activeTurnId = null;
        s.status =
          p.turn.status === 'failed'
            ? 'failed'
            : p.turn.status === 'interrupted'
              ? 'interrupted'
              : 'idle';
        s.error = p.turn.error?.message;
        s.approvals = [];
        break;
      case 'item/started':
      case 'item/completed':
        this.upsert(s, p.item);
        break;
      case 'item/agentMessage/delta':
        this.delta(s, p.itemId, 'text', p.delta, 'agentMessage');
        break;
      case 'item/commandExecution/outputDelta':
        this.delta(s, p.itemId, 'aggregatedOutput', p.delta, 'commandExecution');
        break;
      case 'turn/diff/updated':
        this.upsert(s, { id: `diff-${p.turnId}`, type: 'diff', text: clip(p.diff || '') });
        break;
      case 'turn/plan/updated':
        this.upsert(s, {
          id: `plan-${p.turnId}`,
          type: 'plan',
          text: (p.plan || [])
            .map((v: any) => `${v.status === 'completed' ? '✓' : '○'} ${v.step}`)
            .join('\n'),
        });
        break;
      case 'error':
        s.error = p.error?.message || 'Codex 执行出错';
        break;
      default:
        return;
    }
    this.changed(s.id);
  }
  private upsert(s: ThreadState, item: Item) {
    if (!item?.id) return;
    if (typeof item.aggregatedOutput === 'string')
      item = { ...item, aggregatedOutput: clip(item.aggregatedOutput) };
    const i = s.items.findIndex((v) => v.id === item.id);
    if (i < 0) s.items.push(item);
    else s.items[i] = { ...s.items[i], ...item };
  }
  private delta(
    s: ThreadState,
    id: string,
    key: 'text' | 'aggregatedOutput',
    delta: string,
    type: string,
  ) {
    const i = s.items.find((v) => v.id === id);
    if (i) i[key] = clip((i[key] || '') + delta);
    else s.items.push({ id, type, [key]: delta });
  }
}
