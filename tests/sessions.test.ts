import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Sessions } from '../server/sessions.js';
class Fake extends EventEmitter {
  calls: any[] = [];
  answers: any[] = [];
  snapshot: any = { id: 't', cwd: '/project', turns: [], status: { type: 'idle' } };
  async call(method: string, p: any): Promise<any> {
    this.calls.push([method, p]);
    if (method === 'thread/start') {
      this.snapshot = {
        ...this.snapshot,
        cwd: p.cwd,
        model: p.model,
        reasoningEffort: p.config?.model_reasoning_effort,
      };
      return { thread: this.snapshot };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: this.snapshot };
    if (method === 'turn/start') return { turn: { id: 'turn' } };
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'fixture-model',
            displayName: 'Fixture model',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'high' },
              { reasoningEffort: 'medium' },
            ],
          },
        ],
      };
    return {};
  }
  answer(id: any, result: any) {
    this.answers.push({ id, result });
  }
  reject() {}
}
function setup() {
  const codex = new Fake();
  const projects = { resolve: async (p: string) => p };
  return { codex, s: new Sessions(codex as any, projects as any) };
}
test('disconnected clients retain streamed output, pending approvals, and completed state', async () => {
  const { codex, s } = setup();
  await s.create('/project');
  await s.send('t', 'hello');
  codex.emit('notification', {
    method: 'item/started',
    params: { threadId: 't', item: { id: 'a', type: 'agentMessage', text: '' } },
  });
  codex.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 't', itemId: 'a', delta: 'result' },
  });
  codex.emit('request', {
    id: 88,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't', command: 'python train.py' },
  });
  codex.snapshot = {
    ...codex.snapshot,
    turns: [
      {
        id: 'turn',
        status: 'inProgress',
        items: [{ id: 'a', type: 'agentMessage', text: 'result' }],
      },
    ],
  };
  const restored = await s.open('t');
  assert.equal(restored.items[0].text, 'result');
  assert.equal(restored.approvals.length, 1);
  assert.equal(restored.activeTurnId, 'turn');
  s.respond('t', 88, { decision: 'decline' });
  assert.deepEqual(codex.answers, [{ id: 88, result: { decision: 'decline' } }]);
  assert.throws(() => s.respond('t', 88, { decision: 'accept' }));
  codex.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't', turn: { id: 'turn', status: 'completed' } },
  });
  assert.equal(restored.activeTurnId, null);
  assert.equal(restored.status, 'idle');
});
test('concurrent sends cannot start duplicate turns, interrupt targets active turn', async () => {
  const { codex, s } = setup();
  await s.create('/project');
  await s.send('t', 'one');
  await assert.rejects(s.send('t', 'two'));
  await s.stop('t');
  assert.deepEqual(codex.calls.at(-1), ['turn/interrupt', { threadId: 't', turnId: 'turn' }]);
});
test('structured question answers and process exit are handled', async () => {
  const { codex, s } = setup();
  await s.create('/project');
  codex.emit('request', {
    id: 'q',
    method: 'item/tool/requestUserInput',
    params: { threadId: 't', questions: [{ id: 'choice', question: 'which?' }] },
  });
  assert.throws(() => s.respond('t', 'q', { answers: {} }));
  s.respond('t', 'q', { answers: { choice: 'small' } });
  assert.deepEqual(codex.answers[0].result, { answers: { choice: { answers: ['small'] } } });
  codex.emit('unavailable', 'process exited');
  assert.equal(s.states.get('t')?.status, 'failed');
  assert.equal(s.states.get('t')?.error, 'process exited');
});

test('reject maps to cancel when the server offers only cancel', async () => {
  const { codex, s } = setup();
  await s.create('/project');
  codex.emit('request', {
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't', availableDecisions: ['accept', 'cancel'] },
  });
  s.respond('t', 7, { decision: 'decline' });
  assert.deepEqual(codex.answers[0].result, { decision: 'cancel' });
});

test('effort validation, per-turn parameters and desktop refresh', async () => {
  const { codex, s } = setup();
  await s.create('/project', 'fixture-model', 'high');
  assert.equal(
    codex.calls.find((c) => c[0] === 'thread/start')[1].config.model_reasoning_effort,
    'high',
  );
  await assert.rejects(s.send('t', 'bad', 'fixture-model', 'ultra'), /不支持/);
  await s.send('t', 'good', 'fixture-model', 'low');
  assert.equal(codex.calls.filter((c) => c[0] === 'turn/start').at(-1)[1].effort, 'low');
  codex.snapshot = {
    ...codex.snapshot,
    model: 'desktop-model',
    reasoningEffort: 'high',
    turns: [],
  };
  const restored = await s.open('t');
  assert.equal(restored.model, 'desktop-model');
  assert.equal(restored.effort, 'high');
});
test('workspace filter excludes cached threads and desktop active turn is protected', async () => {
  const { codex, s } = setup();
  await s.create('/project');
  const orig = codex.call.bind(codex);
  codex.call = async (method, p) =>
    method === 'thread/list'
      ? { data: [{ id: 'other', cwd: '/other', status: { type: 'idle' } }] }
      : orig(method, p);
  assert.equal((await s.list('/other')).data.length, 1);
  assert.equal((await s.list('/other')).data[0].id, 'other');
  codex.snapshot.status = { type: 'active' };
  await assert.rejects(s.send('t', 'hello'), /电脑端/);
  assert.equal(codex.calls.filter((c) => c[0] === 'turn/start').length, 0);
});
test('desktop resolves approval on other device without duplicate execution', async () => {
  const { codex, s } = setup();
  await s.create('/project');
  codex.emit('request', {
    id: 22,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't' },
  });
  codex.emit('notification', {
    method: 'serverRequest/resolved',
    params: { requestId: 22, threadId: 't' },
  });
  assert.throws(() => s.respond('t', 22, { decision: 'accept' }), /过期/);
  assert.equal(codex.answers.length, 0);
});
