import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime, sessionDirectory } from '../src/agent/runtime.ts';
import { modeEntryType, restoreMode } from '../src/agent/mode.ts';
import { readTaskReports, taskMetricsType } from '../src/agent/task-metrics.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

type Message = Parameters<SessionManager['appendMessage']>[0];
const assistant = (text: string): Extract<Message, { role: 'assistant' }> => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'fork-fixture', model: 'second',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: Date.now(),
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-fork-'));
  const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent'); const sessionsRoot = join(root, 'sessions');
  mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(join(agentDir, 'extensions'));
  // Observe the real SDK lifecycle, including a cancellable before-fork hook.
  writeFileSync(join(agentDir, 'extensions', 'fork-observer.ts'), `import { existsSync } from 'node:fs';
export default (pi) => {
  pi.on('session_before_fork', () => existsSync(${JSON.stringify(join(root, 'cancel'))}) ? { cancel: true } : undefined);
  pi.on('session_start', (event) => { if (event.reason === 'fork') pi.appendEntry('test-fork-start', { reason: event.reason }); });
};`);
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  models.registerProvider('fork-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test',
    models: ['first', 'second'].map((id) => ({ id, name: id, reasoning: true, input: ['text'],
      contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
  const seed = SessionManager.create(cwd, sessionDirectory(cwd, sessionsRoot));
  seed.appendModelChange('fork-fixture', 'second'); seed.appendThinkingLevelChange('high');
  seed.appendCustomEntry(modeEntryType, { mode: 'execute' });
  seed.appendMessage({ role: 'user', content: 'FIRST_QUESTION', timestamp: 1 });
  const first = seed.appendMessage(assistant('FIRST_ANSWER'));
  seed.appendCustomEntry(taskMetricsType, { version: 1, id: 'old-report', startedAt: 1, status: 'running' });
  seed.appendMessage({ role: 'user', content: 'SECOND_QUESTION', timestamp: 2 });
  const tool = seed.appendMessage({ ...assistant(''), stopReason: 'toolUse', content: [
    { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'file.txt' } },
    { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'file.txt' } },
  ] });
  seed.appendMessage({ role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'one' }], isError: false, timestamp: 3 });
  const half = seed.appendMessage({ role: 'user', content: 'UNSAFE_BOUNDARY', timestamp: 4 });
  seed.appendMessage({ role: 'toolResult', toolCallId: 'tool-2', toolName: 'read', content: [{ type: 'text', text: 'two' }], isError: false, timestamp: 5 });
  const last = seed.appendMessage(assistant('LAST_ANSWER'));
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'fork-fixture/first', '--session', seed.getSessionFile()!]);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, {
    ...overrides, modelRuntime: models, settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false } }),
  }), sessionsRoot);
  return { root, pool, options, seed, first, last, tool, half, cwd };
}

test('fork clones a persisted safe branch without replacing its source; metadata and mode survive reopen', { timeout: 20000 }, async () => {
  const f = await setup(); const { pool, first, last, tool, half, seed } = f;
  try {
    const source = await pool.open(f.options); const original = readFileSync(seed.getSessionFile()!, 'utf8');
    const originalManager = source.runtime.session.sessionManager; const originalLeaf = originalManager.getLeafId();
    const points = pool.getForkPoints(source.id);
    assert.ok(points.some((p) => p.entryId === first)); assert.ok(points.some((p) => p.entryId === last));
    assert.ok(!points.some((p) => p.entryId === tool || p.entryId === half));
    await assert.rejects(pool.fork(source.id, half), /完整/);
    assert.equal(pool.slots.size, 1);
    const child = (await pool.fork(source.id, last))!;
    assert.notEqual(child.id, source.id); assert.notEqual(child.runtime, source.runtime);
    assert.equal(pool.slots.get(source.id), source);
    assert.equal(source.runtime.session.sessionManager, originalManager);
    assert.equal(originalManager.getLeafId(), originalLeaf);
    assert.equal(readFileSync(seed.getSessionFile()!, 'utf8'), original);
    assert.equal(restoreMode(child.runtime.session.sessionManager.getBranch()), 'discuss');
    assert.equal(child.runtime.session.model?.id, 'second', 'inherit branch model, not startup CLI override');
    assert.equal(child.runtime.session.thinkingLevel, 'high');
    assert.equal(readTaskReports(child.runtime.session).length, 0, 'inherited running reports are not child tasks');
    assert.equal(readTaskReports(source.runtime.session).length, 1);
    assert.equal(child.runtime.session.sessionManager.getHeader()?.parentSession, seed.getSessionFile());
    assert.ok(child.runtime.session.sessionManager.getBranch().some((e) => e.type === 'custom' && e.customType === 'test-fork-start'));
    assert.equal(child.saved.fork?.entryId, last);
    const early = (await pool.fork(source.id, first))!;
    assert.ok(!JSON.stringify(early.runtime.session.messages).includes('SECOND_QUESTION'));
    const question = points.find((point) => point.role === 'user')!;
    const questionFork = (await pool.fork(source.id, question.entryId))!;
    assert.equal(questionFork.runtime.session.messages.filter((message) => message.role === 'assistant').length, 0);
    assert.equal(questionFork.state, 'idle', 'a user boundary never auto-resends the inherited question');
    await pool.close(questionFork.id);
    assert.equal((await pool.openSession(questionFork.id, f.cwd)).saved.fork?.entryId, question.entryId);
    const childId = child.id; await pool.close(childId);
    const restored = await pool.openSession(childId, f.cwd);
    assert.equal(restored.saved.fork?.sourceSessionId, source.id);
    assert.equal(restored.runtime.session.model?.id, 'second');
    assert.equal(restoreMode(restored.runtime.session.sessionManager.getBranch()), 'discuss');
    assert.ok((await pool.listSessions()).some((row) => row.id === childId && row.fork?.entryId === last));
    writeFileSync(join(f.root, 'cancel'), ''); const size = pool.slots.size;
    assert.equal(await pool.fork(source.id, first), undefined);
    assert.equal(pool.slots.size, size);
  } finally { await pool.dispose(); }
});

test('fork keeps an actual SDK run and its queue alive while the child stays idle', { timeout: 20000 }, async () => {
  const f = await setup(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let task: Promise<void> | undefined; let requests = 0; let aborted = false;
  try {
    const source = await f.pool.open(f.options);
    source.runtime.session.agent.streamFunction = (_model, _context, options) => {
      requests++; options?.signal?.addEventListener('abort', () => { aborted = true; });
      const stream = createAssistantMessageEventStream();
      void gate.then(() => { const message = assistant('RUN_FINISHED'); stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    };
    task = f.pool.submit(source.id, 'RUNNING_TASK');
    await until(() => requests === 1);
    await f.pool.submit(source.id, 'KEEP_QUEUE', 'followUp');
    const child = (await f.pool.fork(source.id, f.last))!;
    assert.equal(aborted, false); assert.equal(source.state, 'running'); assert.equal(child.state, 'idle');
    assert.equal(child.task, undefined); assert.equal(child.metrics.current, undefined);
    assert.deepEqual(child.runtime.session.getFollowUpMessages(), []);
    assert.deepEqual(source.runtime.session.getFollowUpMessages(), ['KEEP_QUEUE']);
    assert.ok(!JSON.stringify(child.runtime.session.messages).includes('RUNNING_TASK'));
    release(); await task;
    assert.match(source.runtime.session.getLastAssistantText()!, /RUN_FINISHED/);
    assert.equal(aborted, false);
  } finally { release(); await task; await f.pool.dispose(); }
});

test('fork menu cancellation preserves source and confirmation opens an independent conversation', { timeout: 20000 }, async () => {
  const f = await setup(); const terminal = new MemoryTerminal(); const ui = new MultiSessionTui(f.pool, terminal);
  const running = ui.run();
  try {
    await until(() => !!terminal.input && f.pool.slots.size === 1); const source = f.pool.active;
    terminal.type('/fork\r'); await until(() => terminal.output.includes('分叉会话'));
    terminal.type('\x1b'); await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.pool.activeId, source.id); assert.equal(f.pool.slots.size, 1);
    terminal.type('/fork\r'); await new Promise((resolve) => setTimeout(resolve, 50)); terminal.type('\r');
    await until(() => f.pool.slots.size === 2);
    assert.notEqual(f.pool.activeId, source.id); assert.equal(f.pool.active.saved.fork?.entryId, f.last);
    assert.equal(f.pool.active.state, 'idle');
    terminal.type('/session\r'); await until(() => terminal.output.includes('分叉来源'));
    terminal.type('\x1b');
  } finally { process.emit('SIGTERM'); await running; await f.pool.dispose(); }
});
