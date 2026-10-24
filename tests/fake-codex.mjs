// Deterministic protocol fixture for reconnect, approvals, cancellation and history tests.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const file = process.env.FAKE_STATE_FILE;
let threads = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const approvals = new Map();
let requestId = 900;
const timers = new Map();
const emit = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\n');
const save = () => {
  if (file) fs.writeFileSync(file, JSON.stringify(threads));
};
function item(t, turn, i) {
  turn.items.push(i);
  emit('item/started', { threadId: t.id, turnId: turn.id, item: i });
  emit('item/completed', { threadId: t.id, turnId: turn.id, item: i });
  save();
}
function finish(t, turn, text) {
  item(t, turn, { id: crypto.randomUUID(), type: 'agentMessage', text });
  turn.status = 'completed';
  t.status = { type: 'idle' };
  emit('turn/completed', { threadId: t.id, turn });
  save();
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const p = m.params || {};
  const answer = (r) => process.stdout.write(JSON.stringify({ id: m.id, result: r }) + '\n');
  if (!m.method) {
    const a = approvals.get(m.id);
    if (a) {
      approvals.delete(m.id);
      emit('serverRequest/resolved', { requestId: m.id, threadId: a.t.id });
      finish(
        a.t,
        a.turn,
        m.result?.decision === 'accept' ? '已批准，实验完成：42。' : '已拒绝，本次未执行。',
      );
    }
    return;
  }
  switch (m.method) {
    case 'initialize':
      answer({ userAgent: 'fixture' });
      break;
    case 'initialized':
      break;
    case 'thread/start': {
      const t = {
        id: crypto.randomUUID(),
        cwd: p.cwd,
        turns: [],
        preview: '',
        model: p.model || 'fixture-model',
        reasoningEffort: p.config?.model_reasoning_effort || 'medium',
        status: { type: 'idle' },
      };
      threads[t.id] = t;
      save();
      answer({ thread: t });
      break;
    }
    case 'thread/list':
      answer({
        data: Object.values(threads)
          .filter((t) => !p.cwd || t.cwd === p.cwd)
          .reverse(),
        nextCursor: null,
      });
      break;
    case 'model/list':
      answer({
        data: [
          {
            id: 'fixture-model',
            model: 'fixture-model',
            displayName: 'Fixture model',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
          },
          {
            id: 'fixture-fast',
            model: 'fixture-fast',
            displayName: 'Fixture fast',
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
          },
        ],
        nextCursor: null,
      });
      break;
    case 'thread/read':
    case 'thread/resume':
      answer({ thread: threads[p.threadId] });
      break;
    case 'turn/start': {
      const t = threads[p.threadId];
      if (p.model) t.model = p.model;
      if (p.effort) t.reasoningEffort = p.effort;
      t.status = { type: 'active' };
      const turn = { id: crypto.randomUUID(), status: 'inProgress', items: [] };
      t.turns.push(turn);
      const text = p.input[0].text;
      t.preview ||= text;
      answer({ turn });
      emit('turn/started', { threadId: t.id, turn });
      item(t, turn, { id: crypto.randomUUID(), type: 'userMessage', content: p.input });
      if (text.includes('审批')) {
        const id = ++requestId;
        approvals.set(id, { t, turn });
        process.stdout.write(
          JSON.stringify({
            id,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: t.id,
              turnId: turn.id,
              command: 'python experiment.py',
              reason: '测试操作审批',
              availableDecisions: ['accept', 'decline'],
            },
          }) + '\n',
        );
      } else if (text.includes('长会话')) {
        for (let i = 0; i < 40; i++) {
          item(t, turn, {
            id: crypto.randomUUID(),
            type: 'agentMessage',
            text: `历史消息 ${i + 1}\n\n这是用于滚动测试的较长会话内容。`,
          });
        }
        finish(t, turn, '## 长会话测试完成\n\n可以使用快速跳转按钮。');
      } else if (text.includes('等待')) {
        timers.set(
          turn.id,
          setTimeout(() => finish(t, turn, '等待结束'), 60000),
        );
      } else {
        const id = crypto.randomUUID();
        item(t, turn, { id, type: 'agentMessage', text: '正在计算…' });
        timers.set(
          turn.id,
          setTimeout(() => {
            item(t, turn, {
              id: crypto.randomUUID(),
              type: 'commandExecution',
              command: 'python experiment.py',
              aggregatedOutput: '42\n',
              exitCode: 0,
              status: 'completed',
            });
            finish(t, turn, '## 实验结果\n\n答案是 **42**。\n\n```python\nprint(6 * 7)\n```');
          }, 2500),
        );
      }
      save();
      break;
    }
    case 'turn/interrupt': {
      const t = threads[p.threadId],
        turn = t.turns.find((v) => v.id === p.turnId);
      clearTimeout(timers.get(turn.id));
      turn.status = 'interrupted';
      t.status = { type: 'idle' };
      for (const [id, a] of approvals) if (a.turn.id === turn.id) approvals.delete(id);
      answer({});
      emit('turn/completed', { threadId: t.id, turn });
      save();
      break;
    }
    default:
      answer({});
  }
});
