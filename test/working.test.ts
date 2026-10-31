import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getSelectListTheme, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { SessionPool, type SessionSlot } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { SessionEditor, SessionWorking } from '../src/tui/working.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
  return { promise, release };
}

test('native Working border covers initial wait, switching, retries, compaction, waiting UI and cancellation', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-working-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const plans: Array<{ status?: number; gate?: ReturnType<typeof gate> }> = [];
  const releases: Array<ReturnType<typeof gate>> = [];
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the local fixture request. */ }
    requests++;
    const plan = plans.shift() ?? {};
    await plan.gate?.promise;
    if (res.destroyed) return;
    if (plan.status) {
      res.writeHead(plan.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: plan.status === 503 ? 'Server overloaded, please try again' : 'Invalid fixture request' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: 'assistant' });
    send({ content: 'Fixture completed. This is a sufficient summary of the conversation and its current task.' });
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('working-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'working-fixture/fixture']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, {
    ...overrides, modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [],
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 400 }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } }),
  }), join(root, 'sessions'));
  const terminal = new MemoryTerminal();
  const ui = new MultiSessionTui(pool, terminal);
  const views = new Map<string, { editor: SessionEditor; working: SessionWorking }>();
  const stub = { requestRender() {}, terminal: new MemoryTerminal() } as TUI;
  // Observe the same public SDK editor/controller that the full TUI mounts.
  const update = () => {
    for (const slot of pool.slots.values()) {
      let view = views.get(slot.id);
      if (!view) {
        const editor = new SessionEditor(stub, { borderColor: (text) => text, selectList: getSelectListTheme() });
        view = { editor, working: new SessionWorking(editor, stub) };
        views.set(slot.id, view);
      }
      view.working.update(slot, slot.id === pool.activeId);
    }
  };
  pool.on('change', update);
  pool.on('active', update);
  const border = (slot: SessionSlot) => stripTerminalSequences(views.get(slot.id)!.editor.render(100)[0]!);
  const running = ui.run();
  try {
    await until(() => !!terminal.input && pool.slots.size === 1);
    const a = pool.active;
    const slow = gate(); releases.push(slow); plans.push({ gate: slow });
    const taskA = pool.submit(a.id, 'Read the project and discuss the implementation plan without editing files.');
    await until(() => requests === 1 && border(a).includes('Working'), 'Working before the first response byte');
    await until(() => terminal.output.includes('Working'), 'Working in the actual multi-session TUI');
    const firstFrame = border(a);
    await until(() => border(a) !== firstFrame, 'animated spinner while waiting');
    assert.equal(a.runtime.session.messages.some((message) => message.role === 'assistant'), false);
    assert.ok(border(a).startsWith('── '), 'Working belongs in the input border');

    const b = await pool.open();
    assert.ok(!border(a).includes('Working'), 'inactive view pauses its spinner');
    assert.ok(!border(b).includes('Working'), 'idle B must not display A\'s status');
    assert.equal(a.state, 'running');
    assert.ok(a.task, 'switching must not abort A');
    pool.activate(a.id);
    assert.ok(border(a).includes('Working'));

    const extUi = a.runtime.session.extensionRunner!.createContext().ui;
    extUi.setWorkingMessage('Inspecting project');
    await until(() => terminal.output.includes('Inspecting project'), 'extension working message');
    extUi.setWorkingMessage();
    extUi.setWorkingVisible(false);
    extUi.setWorkingVisible(true);
    extUi.setWorkingIndicator({ frames: ['●'] });
    await until(() => stripTerminalSequences(terminal.output).includes('● Working'), 'extension custom spinner');
    extUi.setWorkingIndicator();

    const view = views.get(a.id)!;
    view.working.setVisible(false); update();
    assert.ok(!border(a).includes('Working'));
    view.working.setVisible(true); update();
    view.working.setIndicator({ frames: [] }); update();
    assert.ok(!border(a).includes('Working'));
    view.working.setIndicator(); update();
    for (const width of [12, 24, 42, 100]) {
      for (const line of view.editor.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    const confirm = extUi.confirm('Confirm task', 'Proceed?');
    await until(() => border(a).includes('Waiting for input'));
    terminal.type('2\r');
    assert.equal(await confirm, false);
    await until(() => border(a).includes('Working'));
    slow.release(); await taskA;
    assert.equal(a.activity, undefined);
    assert.ok(!border(a).includes('Working'), 'completion clears the border');

    // A real manual SDK compaction must use the same border and clear on completion.
    const compactGate = gate(); releases.push(compactGate); plans.push({ gate: compactGate });
    const compacting = a.runtime.session.compact();
    await until(() => border(a).includes('Compacting context'), 'compaction indicator');
    compactGate.release(); await compacting;
    assert.ok(!border(a).includes('Compacting'));

    pool.activate(b.id);
    const retryGate = gate(); releases.push(retryGate);
    plans.push({ status: 503 }, { gate: retryGate });
    let sawRetry = false;
    const observeRetry = () => { if (border(b).includes('Retrying')) sawRetry = true; };
    pool.on('change', observeRetry);
    const retryTask = pool.submit(b.id, 'Discuss the retry fixture.');
    await until(() => sawRetry, 'SDK retry indicator');
    assert.ok(b.task, 'a failed intermediate response must not mark the task finished');
    retryGate.release(); await retryTask;
    pool.off('change', observeRetry);
    assert.equal(b.state, 'idle', 'successful retry must clear the intermediate error');
    assert.ok(!border(b).includes('Working'));

    const failed = await pool.open();
    plans.push({ status: 400 });
    await pool.submit(failed.id, 'Discuss the failure fixture.');
    assert.equal(failed.state, 'error');
    assert.ok(!border(failed).includes('Working'));

    const cancel = await pool.open();
    const cancelGate = gate(); releases.push(cancelGate); plans.push({ gate: cancelGate });
    const cancelTask = pool.submit(cancel.id, 'Discuss the cancellation fixture.');
    await until(() => border(cancel).includes('Working'));
    await pool.abort(cancel.id); await cancelTask;
    assert.ok((await pool.catalog.list(cwd)).some((entry) => entry.id === cancel.id), 'cancelling the first submitted task keeps its history');
    assert.ok(!border(cancel).includes('Working'), 'cancellation clears the indicator and timer');
    cancelGate.release();
    terminal.type('/quit\r');
    await running;
  } finally {
    pool.off('change', update);
    pool.off('active', update);
    for (const release of releases) release.release();
    for (const view of views.values()) view.working.dispose();
    if (terminal.input) { process.emit('SIGTERM'); await running; }
    await pool.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
