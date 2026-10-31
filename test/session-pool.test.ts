import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { readTools } from '../src/agent/mode.ts';

delete process.env.NODE_TEST_CONTEXT;

test('switching keeps A shell running while B completes; abort, modes and output stay session-local', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-pool-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(cwd, 'info.txt'), 'B-only content');
  writeFileSync(join(cwd, 'worker.cjs'), `const fs = require('node:fs');
const id = process.argv[2];
const timer = setInterval(() => {
  if (fs.existsSync('release-' + id)) {
    fs.writeFileSync(id + '.done', id);
    clearInterval(timer);
  }
}, 25);
setTimeout(() => process.exit(2), 20000).unref();
`);
  const calls = new Map<string, number>();
  const payloads: Array<{ task: string; body: unknown }> = [];
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const server = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    const task = ['task-A', 'task-B', 'task-D'].find((id) => JSON.stringify(body.messages).includes(id)) ?? 'other';
    payloads.push({ task, body });
    const count = calls.get(task) ?? 0;
    calls.set(task, count + 1);
    const action = count === 0 ? task === 'task-A' || task === 'task-D'
      ? { name: shell, arguments: { command: `node worker.cjs ${task.slice(-1)}`, timeout: 25 } }
      : { name: 'read', arguments: { path: 'info.txt' } } : undefined;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `${task}-${count}`, object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: 'assistant' });
    if (action) {
      send({ tool_calls: [{ index: 0, id: `${task}-${count}`, type: 'function', function: {
        name: action.name, arguments: JSON.stringify(action.arguments),
      } }] });
      send({}, 'tool_calls');
    } else { send({ content: `${task} finished` }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('local-pool', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'local-pool/fixture']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, {
    ...overrides, modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false } }),
  }), join(root, 'sessions'));
  const waitForTool = (id: string) => new Promise<void>((resolveWait) => {
    const onChange = () => {
      if (pool.slots.get(id)?.runningTools.has(shell)) { pool.off('change', onChange); resolveWait(); }
    };
    pool.on('change', onChange);
    onChange();
  });
  try {
    const a = await pool.open(options);
    await pool.submit(a.id, '/execute');
    const aTask = pool.submit(a.id, 'task-A');
    await waitForTool(a.id);
    assert.equal(a.state, 'running');

    const b = await pool.open();
    assert.equal(pool.activeId, b.id);
    assert.equal(a.state, 'running');
    assert.deepEqual(b.runtime.session.getActiveToolNames().sort(), [...readTools].sort());
    await pool.submit(b.id, 'task-B');
    assert.match(b.runtime.session.getLastAssistantText() ?? '', /task-B finished/);
    assert.equal(a.state, 'running');
    assert.equal(existsSync(join(cwd, 'A.done')), false);
    assert.ok(!JSON.stringify(b.runtime.session.messages).includes('task-A'));
    const sessions = await pool.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((entry) => entry.id === a.id)?.live?.state, 'running');
    assert.equal(sessions.find((entry) => entry.id === b.id)?.title, 'task-B');
    assert.equal(await pool.openSession(a.id), a, 'the list must reuse a running agent');
    assert.equal(a.state, 'running');
    assert.equal(await pool.openSession(b.id), b);
    assert.equal(pool.slots.size, 2);
    await assert.rejects(pool.close(a.id), /运行/);

    await pool.submit(b.id, '/execute');
    await assert.rejects(pool.submit(b.id, 'conflicting write'), /正在此目录执行/);
    await pool.submit(b.id, '/discuss');
    assert.ok(a.runtime.session.getActiveToolNames().includes(shell));

    // Stop D in another workspace; A must remain alive.
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'worker.cjs'), readFileSync(join(cwd, 'worker.cjs')));
    const d = await pool.open({ ...options, cwd: other, continue: false, session: undefined });
    await pool.submit(d.id, '/execute');
    const dTask = pool.submit(d.id, 'task-D');
    await waitForTool(d.id);
    await pool.abort(d.id);
    await dTask;
    assert.equal(existsSync(join(other, 'D.done')), false);
    assert.equal(a.state, 'running');

    pool.activate(b.id);
    writeFileSync(join(cwd, 'release-A'), 'go');
    await aTask;
    assert.equal(readFileSync(join(cwd, 'A.done'), 'utf8'), 'A');
    assert.match(a.runtime.session.getLastAssistantText() ?? '', /task-A finished/);
    assert.equal(a.unread, true);
    assert.ok(!JSON.stringify(a.runtime.session.messages).includes('task-B'));
    assert.equal(pool.activeId, b.id);
    pool.activate(a.id);
    assert.equal(a.unread, false);
    const saved = a.runtime.session.sessionFile!;
    const count = pool.slots.size;
    const reopened = await pool.open({ ...options, session: saved, continue: false });
    assert.equal(reopened, a);
    assert.equal(pool.slots.size, count);
    assert.ok(payloads.some((entry) => entry.task === 'task-B'));
  } finally {
    await pool.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
