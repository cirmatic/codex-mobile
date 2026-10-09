import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ThreadState, ThreadSummary, Item, Approval, ModelOption } from '../../shared/types';
import './style.css';
const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};
const saveLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
async function api(url: string, body?: unknown) {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '连接失败');
  return data;
}
function Mark({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        img: ({ alt }) => <span>[图片：{alt || '暂不预览'}]</span>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
function Message({ item }: { item: Item }) {
  if (item.type === 'userMessage')
    return (
      <article className="message user">
        <div className="byline">你</div>
        <div className="bubble">{item.content?.map((x) => x.text || '').join('\n')}</div>
      </article>
    );
  if (item.type === 'agentMessage')
    return (
      <article className="message assistant">
        <div className="byline">
          <span className="mini-brand">⌘</span> CODEX
        </div>
        <div className="markdown">
          <Mark text={item.text || ''} />
        </div>
      </article>
    );
  if (item.type === 'commandExecution')
    return (
      <details className="tool">
        <summary>
          <span className={item.status === 'inProgress' ? 'spinner' : 'tool-check'}>
            {item.status === 'inProgress' ? '' : item.exitCode && item.exitCode !== 0 ? '!' : '✓'}
          </span>
          <span className="tool-label">{item.command || '执行命令'}</span>
          <span>
            {item.status === 'inProgress'
              ? '运行中'
              : item.exitCode != null
                ? `退出 ${item.exitCode}`
                : '命令'}
          </span>
        </summary>
        <pre>{item.aggregatedOutput || '暂无输出'}</pre>
      </details>
    );
  if (item.type === 'fileChange')
    return (
      <details className="tool">
        <summary>
          <span className="tool-check">↗</span>
          <span className="tool-label">修改了 {item.changes?.length || 0} 个文件</span>
          <span>查看差异</span>
        </summary>
        {item.changes?.map((c, i) => (
          <div key={i}>
            <h4>{c.path}</h4>
            <pre>{c.diff}</pre>
          </div>
        ))}
      </details>
    );
  if (item.type === 'diff')
    return (
      <details className="tool">
        <summary>本轮代码差异</summary>
        <pre>{item.text}</pre>
      </details>
    );
  if (item.type === 'plan')
    return (
      <div className="plan">
        <span>执行计划</span>
        <pre>{item.text}</pre>
      </div>
    );
  if (item.type === 'reasoning') return null;
  return (
    <details className="tool">
      <summary>
        {(
          { webSearch: '网页检索', mcpToolCall: '调用工具', imageView: '查看图片' } as Record<
            string,
            string
          >
        )[item.type] || '工具操作'}
      </summary>
      <pre>{JSON.stringify(item, null, 2)}</pre>
    </details>
  );
}
function ApprovalCard({
  approval,
  respond,
}: {
  approval: Approval;
  respond: (answer: unknown) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(answer: unknown) {
    setBusy(true);
    setError('');
    try {
      await respond(answer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const p = approval.params;
  return (
    <section className="approval">
      <div className="eyebrow">需要你的决定</div>
      {approval.method === 'item/tool/requestUserInput' ? (
        <>
          {(p.questions || []).map((q: any) => (
            <label key={q.id}>
              {q.question}
              {q.options?.length > 0 && (
                <div className="choices">
                  {q.options.map((o: any) => (
                    <button
                      key={o.label}
                      onClick={() => setAnswers({ ...answers, [q.id]: o.label })}
                      className={answers[q.id] === o.label ? 'selected' : ''}
                      title={o.description}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              <input
                aria-label={q.question}
                value={answers[q.id] || ''}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                placeholder="输入回答"
              />
            </label>
          ))}
          <button className="primary" disabled={busy} onClick={() => submit({ answers })}>
            提交回答
          </button>
        </>
      ) : (
        <>
          <h3>
            {approval.method.includes('fileChange')
              ? '允许修改文件？'
              : approval.method.includes('permissions')
                ? '允许本轮请求的权限？'
                : '允许执行此操作？'}
          </h3>
          <p>{p.reason}</p>
          {p.command && <pre>{p.command}</pre>}
          {p.cwd && <small>{p.cwd}</small>}
          {p.permissions && <pre>{JSON.stringify(p.permissions, null, 2)}</pre>}
          {p.networkApprovalContext && (
            <pre>{JSON.stringify(p.networkApprovalContext, null, 2)}</pre>
          )}
          <div className="actions">
            <button disabled={busy} onClick={() => submit({ decision: 'decline' })}>
              拒绝
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => submit({ decision: 'accept' })}
            >
              允许这次
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [connection, setConnection] = useState('连接中');
  const [ready, setReady] = useState(false);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [workspace, setWorkspace] = useState(() => readLocal('cm-workspace'));
  const workspaceRef = useRef(readLocal('cm-workspace'));
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
    try {
      return JSON.parse(readLocal('cm-workspaces') || '[]');
    } catch {
      return [];
    }
  });
  const [runningThreads, setRunningThreads] = useState<ThreadSummary[]>([]);
  const [selectedEffort, setSelectedEffort] = useState('');
  const preferenceDirty = useRef(false);
  const listRequest = useRef(0);
  const navigation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [dirs, setDirs] = useState<any>({ entries: [] });
  const [name, setName] = useState('');
  const [install, setInstall] = useState<any>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [showHidden, setShowHidden] = useState(() => readLocal('cm-show-hidden') === 'true');
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(
    new Map<
      string,
      {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const active = useRef('');
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const choosing = useRef(false);
  function rpc(action: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('连接已断开，消息尚未发送'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.current.delete(id);
        reject(new Error('响应超时，请同步会话后确认是否已发送'));
      }, 65000);
      pending.current.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, action, params }));
    });
  }
  async function refresh(more = false) {
    const cwd = workspaceRef.current;
    if (!cwd) {
      setThreads([]);
      setCursor(null);
      return;
    }
    const request = ++listRequest.current;
    const r = await rpc('list', { cwd, ...(more ? { cursor } : {}) });
    if (request !== listRequest.current || cwd !== workspaceRef.current) return;
    setThreads((old) =>
      more
        ? [...old, ...r.data.filter((v: ThreadSummary) => !old.some((x) => x.id === v.id))]
        : r.data,
    );
    setCursor(r.nextCursor);
  }
  async function refreshModels() {
    const r = await rpc('models');
    setModels((r.data || []).filter((m: ModelOption) => !m.hidden));
  }
  function sync(s: ThreadState) {
    setThread(s);
    if (!preferenceDirty.current) {
      setSelectedModel(s.model || '');
      setSelectedEffort(s.effort || '');
    }
  }
  function select(s: ThreadState) {
    active.current = s.id;
    saveLocal('cm-thread', s.id);
    saveLocal('cm-thread:' + s.cwd, s.id);
    preferenceDirty.current = false;
    sync(s);
    stick.current = true;
  }
  async function open(id: string) {
    const generation = ++navigation.current;
    choosing.current = true;
    try {
      const s = await rpc('open', { threadId: id });
      if (generation !== navigation.current) return;
      if (s.cwd !== workspaceRef.current) throw new Error('会话不属于当前工作区，请先切换工作区');
      select(s);
      setSidebar(false);
      setError('');
    } catch (e) {
      if (generation === navigation.current) setError((e as Error).message);
    } finally {
      if (generation === navigation.current) choosing.current = false;
    }
  }
  async function chooseWorkspace(path: string) {
    if (busy) return;
    const generation = ++navigation.current;
    choosing.current = true;
    try {
      const { cwd } = await rpc('workspace', { cwd: path });
      if (generation !== navigation.current) return;
      workspaceRef.current = cwd;
      setWorkspace(cwd);
      saveLocal('cm-workspace', cwd);
      active.current = '';
      setThread(null);
      setThreads([]);
      setCursor(null);
      preferenceDirty.current = false;
      setSelectedModel('');
      setSelectedEffort('');
      setDraft(readLocal('cm-draft:' + cwd));
      setRecentWorkspaces((old) => {
        const next = [cwd, ...old.filter((x) => x !== cwd)].slice(0, 8);
        saveLocal('cm-workspaces', JSON.stringify(next));
        return next;
      });
      setPicker(false);
      setSidebar(false);
      setError('');
      await refresh();
      const last = readLocal('cm-thread:' + cwd);
      if (last && generation === navigation.current) await open(last);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      choosing.current = false;
    }
  }
  function updateDraft(value: string) {
    setDraft(value);
    if (workspaceRef.current) saveLocal('cm-draft:' + workspaceRef.current, value);
  }
  useEffect(() => {
    api('/api/session')
      .then((r) => setAuthed(r.authenticated))
      .catch(() => setAuthed(false));
    const listener = (e: Event) => {
      e.preventDefault();
      setInstall(e);
    };
    window.addEventListener('beforeinstallprompt', listener);
    return () => window.removeEventListener('beforeinstallprompt', listener);
  }, []);
  useEffect(() => {
    if (!authed) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let failures = 0;
    const connect = () => {
      setConnection('连接中');
      setReady(false);
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      );
      socket.current = ws;
      ws.onopen = () => {
        failures = 0;
        setConnection('已连接');
      };
      ws.onmessage = async (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = pending.current.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            pending.current.delete(m.id);
            m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
          }
          return;
        }
        if (m.event === 'ready') {
          setReady(m.data.codexReady);
          if (m.data.codexReady) {
            // Catalog failures must not prevent opening the last conversation.
            void refreshModels().catch((e) => setError(`模型列表加载失败：${e.message}`));
            try {
              await refresh();
              if (workspaceRef.current) await chooseWorkspace(workspaceRef.current);
              setRunningThreads(await rpc('running'));
            } catch (e) {
              setError((e as Error).message);
            }
          }
        }
        if (m.event === 'state' && m.data.id === active.current && !choosing.current) sync(m.data);
        if (m.event === 'running') setRunningThreads(m.data);
        if (m.event === 'historyChanged') void refresh().catch(() => {});
        if (m.event === 'unavailable') {
          setReady(false);
          setError(m.data);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setConnection('已断开 · 自动重连');
        setReady(false);
        for (const p of pending.current.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('连接断开；请重连后确认执行状态，消息不会自动重复发送'));
        }
        pending.current.clear();
        retry = setTimeout(connect, Math.min(1000 * 2 ** failures++, 10000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const wake = () => {
      if (socket.current?.readyState === WebSocket.OPEN) {
        void refresh().catch(() => {});
        const id = active.current;
        if (id && !choosing.current)
          void rpc('open', { threadId: id })
            .then((s) => {
              if (active.current === id && s.cwd === workspaceRef.current) sync(s);
            })
            .catch((e) => setError(e.message));
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') wake();
    }, 10000);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', visible);
    return () => {
      closed = true;
      clearInterval(poll);
      clearTimeout(retry);
      socket.current?.close();
      for (const p of pending.current.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('连接已关闭'));
      }
      pending.current.clear();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [authed]);
  useEffect(() => {
    if (stick.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
  }, [thread]);
  async function browse(path?: string, includeHidden = showHidden) {
    try {
      const query = new URLSearchParams();
      if (path) query.set('path', path);
      if (includeHidden) query.set('showHidden', '1');
      setDirs(await api('/api/directories' + (query.toString() ? '?' + query.toString() : '')));
      setPicker(true);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function create(cwd: string) {
    if (busy) return;
    setBusy(true);
    choosing.current = true;
    try {
      select(
        await rpc('create', {
          cwd,
          model: selectedModel || undefined,
          effort: selectedEffort || undefined,
        }),
      );
      setPicker(false);
      setSidebar(false);
      await refresh();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      choosing.current = false;
    }
  }
  async function send() {
    if (!draft.trim() || !thread || busy) return;
    setBusy(true);
    setError('');
    try {
      await rpc('send', {
        threadId: thread.id,
        text: draft,
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      });
      preferenceDirty.current = false;
      sync(await rpc('open', { threadId: thread.id }));
      updateDraft('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const running =
    !!thread?.activeTurnId || thread?.status === 'starting' || thread?.status === 'running';
  const effectiveModel = selectedModel || thread?.model || '';
  const modelEntry = models.find((m) => (m.model || m.id) === effectiveModel);
  const efforts = modelEntry?.supportedReasoningEfforts || [];
  function changeModel(value: string) {
    preferenceDirty.current = true;
    setSelectedModel(value);
    const entry = models.find((m) => (m.model || m.id) === (value || thread?.model));
    setSelectedEffort((previous) =>
      entry?.supportedReasoningEfforts?.some((v) => v.reasoningEffort === previous)
        ? previous
        : entry?.defaultReasoningEffort || '',
    );
  }
  if (authed === null) return <div className="loading">正在连接你的电脑…</div>;
  if (!authed)
    return (
      <main className="login">
        <div className="brand-icon">⌘</div>
        <div className="eyebrow">你的移动研究空间</div>
        <h1>
          把灵感，
          <br />
          交给电脑继续。
        </h1>
        <p>连接 Ubuntu 上的 Codex，随时开始一个小实验。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/api/login', { token });
              setToken('');
              setError('');
              setAuthed(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="token">电脑连接密钥</label>
          <input
            id="token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="粘贴电脑上的连接密钥"
            required
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            连接电脑 <span>↗</span>
          </button>
        </form>
        <small>首次连接需要密钥，后续会记住这台设备。</small>
      </main>
    );
  return (
    <div className="app">
      {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
      <aside className={sidebar ? 'sidebar visible' : 'sidebar'}>
        <div className="brand">
          <span className="brand-icon">⌘</span>
          <div>
            Codex Mobile<small>随手实验</small>
          </div>
          <button
            className="mobile-only icon-button"
            aria-label="关闭会话列表"
            onClick={() => setSidebar(false)}
          >
            ×
          </button>
        </div>
        <button
          className="workspace-button"
          aria-label="切换工作区"
          disabled={!ready || busy}
          onClick={() => browse()}
        >
          <small>当前工作区</small>
          <span>{workspace || '选择工作区'} ▾</span>
        </button>
        <button
          className="new-chat"
          disabled={!ready || !workspace || busy}
          onClick={() => create(workspace)}
        >
          ＋ 新建会话 <span>↗</span>
        </button>
        <div className="section-label">
          当前工作区的会话{' '}
          <button
            aria-label="刷新会话"
            disabled={!ready}
            onClick={() => refresh().catch((e) => setError(e.message))}
          >
            ↻
          </button>
        </div>
        <nav>
          {threads.map((t) => (
            <button
              className={'thread-link ' + (thread?.id === t.id ? 'active' : '')}
              key={t.id}
              onClick={() => open(t.id)}
            >
              <span>{t.title}</span>
              <small>
                {['active', 'running', 'starting'].includes(t.status || '')
                  ? '运行中'
                  : t.cwd.split('/').at(-1)}
              </small>
            </button>
          ))}
          {!threads.length && (
            <p className="muted">{workspace ? '此工作区还没有会话。' : '先选择工作区。'}</p>
          )}
          {cursor && (
            <button onClick={() => refresh(true).catch((e) => setError(e.message))}>
              加载更多
            </button>
          )}
        </nav>
        {runningThreads.filter((t) => t.cwd !== workspace).length > 0 && (
          <section className="other-running">
            <small>其他工作区正在运行</small>
            {runningThreads
              .filter((t) => t.cwd !== workspace)
              .map((t) => (
                <button key={t.id} onClick={() => chooseWorkspace(t.cwd)}>
                  {t.title}
                  <small>{t.cwd}</small>
                </button>
              ))}
          </section>
        )}
        <footer>
          {install && (
            <button
              onClick={() => {
                install.prompt();
                setInstall(null);
              }}
            >
              添加到手机桌面 ↗
            </button>
          )}
          <div>
            <span className={'dot ' + (ready ? 'online' : '')} />
            {connection}
          </div>
          <button
            onClick={async () => {
              await api('/api/logout', {});
              setAuthed(false);
            }}
          >
            断开此设备
          </button>
        </footer>
      </aside>
      <main className="main">
        <header>
          <button
            className="mobile-only icon-button"
            aria-label="打开会话列表"
            onClick={() => setSidebar(true)}
          >
            ☰
          </button>
          <div className="header-title">
            <strong>{thread?.title || '新的想法，从这里开始'}</strong>
            <button
              className="cwd"
              title={workspace}
              onClick={() => browse()}
              disabled={!ready || busy}
            >
              ⌑ {workspace || '选择工作区'} <span>⌄</span>
            </button>
          </div>
          <span className={'connection ' + (ready ? 'connected' : '')}>
            <span className={'dot ' + (ready ? 'online' : '')} />
            {ready ? '电脑在线' : '连接中'}
          </span>
        </header>
        {error && (
          <div className="error banner" role="alert">
            {error}
            <button aria-label="关闭错误提示" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        <div
          className="conversation"
          ref={scroll}
          onScroll={() => {
            const e = scroll.current;
            stick.current = !!e && e.scrollHeight - e.scrollTop - e.clientHeight < 100;
          }}
        >
          <div className="conversation-inner">
            {!thread?.items.length ? (
              <section className="welcome">
                <div className="welcome-symbol">✳</div>
                <div className="eyebrow">灵感不必等到回到电脑前</div>
                <h1>现在，你想探索什么？</h1>
                <p>
                  说出你的想法，让 Codex 在电脑上
                  <br className="desktop-only" />
                  调研、写代码，然后把结果带回来。
                </p>
                {!thread ? (
                  <button
                    className="primary"
                    disabled={!ready}
                    onClick={() => (workspace ? create(workspace) : browse())}
                  >
                    {workspace ? '在此工作区新建会话' : '选择工作区'} <span>↗</span>
                  </button>
                ) : (
                  <div className="suggestions">
                    {[
                      '先看看这个项目，告诉我可以做什么。',
                      '帮我设计一个最小实验，先给出方案。',
                    ].map((x) => (
                      <button
                        key={x}
                        onClick={() => {
                          updateDraft(x);
                        }}
                      >
                        {x}
                        <span>↗</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="welcome-note">
                  <span className="dot online" /> 代码和实验留在你的电脑上
                </div>
              </section>
            ) : (
              thread.items.map((i) => <Message key={i.id} item={i} />)
            )}
            {thread?.approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                respond={(answer) =>
                  rpc('respond', { threadId: thread.id, requestId: a.id, answer })
                }
              />
            ))}
            {thread?.error && (
              <div role="alert" className="error">
                {thread.error}
              </div>
            )}
            {running && (
              <div className="working">
                <span className="spinner" />
                {thread?.approvals.length ? '等待你的回复' : 'Codex 正在电脑上工作…'}
              </div>
            )}
            {thread?.status === 'interrupted' && (
              <div className="muted">本轮已停止，可以继续发送消息。</div>
            )}
          </div>
        </div>
        <div className="composer-area">
          <div className="composer">
            <textarea
              aria-label="消息"
              placeholder={thread ? '描述你的想法，或继续追问…' : '先选择一个项目目录…'}
              value={draft}
              disabled={!thread}
              onChange={(e) => {
                updateDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-bottom">
              <label className="model-picker">
                <span className="sr-only">选择模型</span>
                <select
                  aria-label="选择模型"
                  title="选择后从下一条消息开始使用，当前会话历史保留"
                  value={selectedModel}
                  disabled={!ready || !models.length || running || busy}
                  onChange={(e) => changeModel(e.target.value)}
                >
                  <option value="">
                    {thread ? '沿用当前会话模型' : '使用电脑上的 Codex 配置'}
                  </option>
                  {selectedModel && !models.some((m) => (m.model || m.id) === selectedModel) && (
                    <option value={selectedModel}>{selectedModel}（当前模型）</option>
                  )}
                  {models.map((m) => (
                    <option key={m.model || m.id} value={m.model || m.id}>
                      {m.displayName || m.model || m.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="effort-picker">
                <span className="sr-only">推理强度</span>
                <select
                  aria-label="推理强度"
                  value={selectedEffort}
                  disabled={!ready || !efforts.length || running || busy}
                  onChange={(e) => {
                    preferenceDirty.current = true;
                    setSelectedEffort(e.target.value);
                  }}
                >
                  <option value="">{efforts.length ? '默认强度' : '选择模型后设置强度'}</option>
                  {selectedEffort && !efforts.some((v) => v.reasoningEffort === selectedEffort) && (
                    <option value={selectedEffort}>{selectedEffort}（当前）</option>
                  )}
                  {efforts.map((v) => (
                    <option key={v.reasoningEffort} value={v.reasoningEffort} title={v.description}>
                      {v.reasoningEffort}
                    </option>
                  ))}
                </select>
              </label>
              {running ? (
                <button
                  className="stop"
                  disabled={!ready}
                  onClick={() =>
                    rpc('stop', { threadId: thread!.id }).catch((e) => setError(e.message))
                  }
                >
                  ■ 停止
                </button>
              ) : (
                <button
                  className="send"
                  aria-label="发送消息"
                  disabled={!ready || !thread || !draft.trim() || busy}
                  onClick={send}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
          {thread &&
            ((selectedModel && selectedModel !== thread.model) ||
              (selectedEffort && selectedEffort !== thread.effort)) && (
              <div className="composer-note" role="status">
                下一条消息将使用 {selectedModel || thread.model} · {selectedEffort || '默认强度'}
              </div>
            )}
          <div className="composer-note">
            {connection === '已连接'
              ? '手机离开页面后，电脑会继续执行。'
              : '连接中断时，输入会留在此设备，消息不会自动发送。'}
          </div>
        </div>
      </main>
      {picker && (
        <div className="modal-backdrop">
          <section
            className="directory-modal"
            role="dialog"
            aria-modal="true"
            aria-label="选择项目目录"
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">电脑上的工作空间</div>
                <h2>选择项目目录</h2>
              </div>
              <button
                aria-label="关闭目录选择"
                className="icon-button"
                onClick={() => setPicker(false)}
              >
                ×
              </button>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <label className="hidden-toggle">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => {
                  const value = e.target.checked;
                  setShowHidden(value);
                  saveLocal('cm-show-hidden', String(value));
                  browse(dirs.path || undefined, value);
                }}
              />
              显示隐藏目录（以 . 开头）
            </label>
            {!dirs.path && recentWorkspaces.length > 0 && (
              <div className="recent-workspaces">
                <small>最近工作区</small>
                {recentWorkspaces.map((w) => (
                  <button key={w} onClick={() => browse(w)}>
                    {w}
                  </button>
                ))}
              </div>
            )}
            <p className="directory-path">{dirs.path || '允许访问的根目录'}</p>
            {dirs.path && (
              <button className="back" onClick={() => browse(dirs.parent || undefined)}>
                ← 上一级
              </button>
            )}
            <div className="directory-list">
              {dirs.entries.map((d: any) => (
                <button key={d.path} onClick={() => browse(d.path)}>
                  <span>▱ {d.name}</span>
                  <span>›</span>
                </button>
              ))}
              {!dirs.entries.length && (
                <p className="muted">这里还没有子目录，可以直接使用或新建。</p>
              )}
            </div>
            {dirs.path && (
              <>
                <form
                  className="create-directory"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                      const r = await api('/api/directories', { parent: dirs.path, name });
                      setName('');
                      await browse(r.path);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <input
                    aria-label="新目录名称"
                    placeholder="新想法的目录名"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <button disabled={!name.trim() || busy}>新建目录</button>
                </form>
                <button
                  className="primary use-directory"
                  disabled={busy}
                  onClick={() => chooseWorkspace(dirs.path)}
                >
                  使用此工作区 ↗
                </button>
              </>
            )}
            <small>选择工作区后显示该目录的历史会话；其他目录的任务继续运行。</small>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator && import.meta.env.PROD)
  navigator.serviceWorker.register('/sw.js').catch(() => {});
