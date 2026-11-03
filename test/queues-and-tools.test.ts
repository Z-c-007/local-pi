import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { MemoryTerminal, settle, until } from './helpers/terminal.ts';

function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }
const textOf = (message: any) => typeof message.content === 'string' ? message.content
  : message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') ?? '';

test('SDK queues, compaction, copy and external draft editing stay session-local', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-queues-')); const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir); writeFileSync(join(cwd, 'fixture.txt'), 'A local fixture.');
  writeFileSync(join(agentDir, 'keybindings.json'), JSON.stringify({ 'app.message.followUp': 'alt+f', 'app.message.dequeue': 'alt+u',
    'app.message.copy': 'alt+c', 'app.editor.external': 'alt+e' }));
  const first = gate(); const editing = gate(); const gates = [first, editing];
  let compactHold: ReturnType<typeof gate> | undefined; let failNext = false;
  const requests: any[] = []; let initialSeen = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const latest = textOf(request.messages.findLast((message: any) => message.role === 'user'
      && /A_INITIAL|STEER_NEXT|FOLLOW_LATER|B_ONLY|AFTER_COMPACT/.test(textOf(message)))
      ?? request.messages.findLast((message: any) => message.role === 'user'));
    const tool = request.messages.some((message: any) => message.role === 'user' && textOf(message).includes('A_INITIAL')) && !initialSeen;
    if (tool) { initialSeen = true; await first.promise; }
    const hold = compactHold; compactHold = undefined; await hold?.promise;
    if (res.destroyed) return;
    if (failNext) { failNext = false; res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Fixture compact failed"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
      created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (tool) {
      send({ tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] }); send({}, 'tool_calls');
    } else { send({ content: `Fixture result: ${latest.slice(0, 40)}. This is a complete summary of the current task, files and pending work.` }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('queue-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'queue-fixture/fixture']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime,
    settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } }),
  }), join(root, 'sessions'));
  let copied = ''; let copyFails = false; let editorCalled = false; let editorFails = false;
  const terminal = new MemoryTerminal();
  const ui = new MultiSessionTui(pool, terminal, undefined, {
    copyToClipboard: async (text) => { if (copyFails) throw new Error('Fixture clipboard denied'); copied = text; },
    editInExternalEditor: async ({ content, command }) => {
      editorCalled = true; assert.ok(command); assert.equal(terminal.input, undefined, 'external editor owns terminal input');
      await editing.promise; return editorFails ? { status: 'failed' } : { status: 'complete', content: `Edited: ${content}` };
    },
  });
  const running = ui.run(); const key = (data: string) => terminal.input?.(data);
  try {
    await until(() => !!terminal.input && pool.slots.size === 1);
    const a = pool.active; const aUi = a.runtime.session.extensionRunner!.createContext().ui;
    const taskA = pool.submit(a.id, 'A_INITIAL'); await until(() => requests.length === 1);
    terminal.type('REMOVE_STEER\r'); await until(() => a.runtime.session.getSteeringMessages().length === 1);
    terminal.type('REMOVE_FOLLOW'); key('\x1bf'); await until(() => a.runtime.session.getFollowUpMessages().length === 1);
    key('\x1bu');
    assert.equal(a.runtime.session.pendingMessageCount, 0);
    assert.ok(aUi.getEditorText().includes('REMOVE_STEER') && aUi.getEditorText().includes('REMOVE_FOLLOW'));
    aUi.setEditorText('STEER_NEXT'); terminal.type('\r'); await until(() => a.runtime.session.getSteeringMessages().includes('STEER_NEXT'));
    aUi.setEditorText('FOLLOW_LATER'); key('\x1bf'); await until(() => a.runtime.session.getFollowUpMessages().includes('FOLLOW_LATER'));
    await until(() => stripTerminalSequences(terminal.output).includes('待发送 2 条'));
    terminal.type('/compact\r'); await until(() => a.notices.some((notice) => notice.includes('不会自动中断')));
    assert.ok(a.task);
    const b = await pool.open(); const bUi = b.runtime.session.extensionRunner!.createContext().ui;
    await pool.submit(b.id, 'B_ONLY'); terminal.type('/copy\r');
    await until(() => copied.includes('B_ONLY')); assert.ok(a.task);
    const bAnswer = copied; copied = ''; key('\x1bc'); await until(() => copied === bAnswer);
    copyFails = true; key('\x1bc'); await until(() => b.notices.some((notice) => notice.includes('Fixture clipboard denied'))); copyFails = false;
    pool.activate(a.id); aUi.setEditorText('External draft'); key('\x1be');
    await until(() => editorCalled && !terminal.input);
    const outputDuringEdit = terminal.output.length;
    first.release(); await taskA;
    assert.equal(a.runtime.session.pendingMessageCount, 0);
    assert.equal(terminal.output.length, outputDuringEdit, 'background model events cannot paint over the external editor');
    const steeringRequest = requests.findIndex((request) => request.messages.some((message: any) => message.role === 'user' && textOf(message) === 'STEER_NEXT'));
    const followRequest = requests.findIndex((request) => request.messages.some((message: any) => message.role === 'user' && textOf(message) === 'FOLLOW_LATER'));
    assert.ok(steeringRequest > 0 && followRequest > steeringRequest);
    assert.ok(!requests.some((request) => JSON.stringify(request.messages).includes('REMOVE_STEER')));
    pool.activate(b.id); bUi.setEditorText('B untouched'); editing.release();
    await until(() => !!terminal.input && aUi.getEditorText() === 'Edited: External draft');
    assert.equal(bUi.getEditorText(), 'B untouched');
    editorFails = true; key('\x1be'); await until(() => b.notices.some((notice) => notice.includes('原草稿已保留')));
    assert.equal(bUi.getEditorText(), 'B untouched');

    pool.activate(a.id); aUi.setEditorText(''); const compact = gate(); gates.push(compact); compactHold = compact;
    const beforeCompact = requests.length; terminal.type('/compact Preserve queued tasks\r');
    await until(() => requests.length > beforeCompact && a.runtime.session.isCompacting);
    terminal.type('AFTER_COMPACT\r'); await until(() => a.compactionQueue.length === 1);
    pool.activate(b.id); assert.ok(a.task); compact.release();
    await until(() => !a.task && a.compactionQueue.length === 0);
    assert.ok(a.runtime.session.sessionManager.getBranch().some((entry) => entry.type === 'compaction'));
    assert.ok(a.runtime.session.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('AFTER_COMPACT')));
    assert.equal(bUi.getEditorText(), 'B untouched');

    pool.activate(b.id); bUi.setEditorText(''); const cancelled = gate(); gates.push(cancelled); compactHold = cancelled;
    const beforeStop = requests.length; terminal.type('/compact\r');
    await until(() => requests.length > beforeStop && b.runtime.session.isCompacting);
    terminal.type('DO_NOT_SEND\r'); await until(() => b.compactionQueue.length === 1);
    terminal.type('/stop\r'); await until(() => !b.task); cancelled.release();
    assert.equal(bUi.getEditorText(), 'DO_NOT_SEND'); assert.equal(b.compactionQueue.length, 0);
    assert.ok(!requests.some((request) => JSON.stringify(request.messages).includes('DO_NOT_SEND')));
    bUi.setEditorText(''); failNext = true;
    terminal.type('/compact\r'); await until(() => !b.task && b.notices.some((notice) => notice.includes('压缩失败')));
    assert.equal(b.state, 'error');
    assert.equal(a.state, 'idle');
  } finally {
    for (const item of gates) item.release();
    process.emit('SIGTERM');
    await settle(running, 'queues TUI shutdown');
    await settle(pool.dispose(), 'queues pool dispose');
    server.closeAllConnections();
    await settle(new Promise<void>((done) => server.close(() => done())), 'queues fixture server');
  }
});
