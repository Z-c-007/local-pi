import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { parseOptions } from '../src/cli.ts';
import { codingTools, createRuntime, sessionDirectory } from '../src/agent/runtime.ts';
import { readTools, restoreMode } from '../src/agent/mode.ts';

// Child project tests must start their own runner, rather than inherit this runner's IPC context.
delete process.env.NODE_TEST_CONTEXT;

test('CLI rejects ambiguous sessions and invalid workspaces', () => {
  assert.throws(() => parseOptions(['--continue', '--session', 'example.jsonl']), /只能选一个/);
  assert.throws(() => parseOptions(['--cwd', join(tmpdir(), 'local-pi-does-not-exist-5341')]), /工作目录/);
  assert.throws(() => parseOptions(['--model', 'missing-provider']), /provider\/model-id/);
  assert.throws(() => parseOptions(['--print', ' ']), /非空/);
});

test('SDK coding loop, mode restrictions, busy switching, and session restoration', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-integration-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(cwd, 'sum.js'), 'export function sum(a, b) { return a - b; }\n');
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'sum.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.js';
test('adds numbers', () => assert.equal(sum(2, 3), 5));
`);
  assert.throws(() => execFileSync(process.execPath, ['--test'], { cwd, stdio: 'pipe' }));

  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> }> = [];
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const actions: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: 'read', arguments: { path: 'sum.js' } },
    { name: 'edit', arguments: { path: 'sum.js', edits: [{ oldText: 'return a - b;', newText: 'return a + b;' }] } },
    { name: shell, arguments: { command: 'node --test', timeout: 20 } },
  ];
  let holdResponse: Promise<void> | undefined;
  let onRequest: (() => void) | undefined;
  let discussing = true;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    onRequest?.();
    await holdResponse;
    const action = discussing ? undefined : actions.shift();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `completion-${requests.length}`, object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: 'assistant' });
    if (action) {
      send({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function',
        function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] });
      send({}, 'tool_calls');
    } else {
      send({ content: discussing
        ? '方案是把 a - b 改为 a + b。当前会话处于讨论模式，我不能写文件，请先输入 /execute。'
        : '已修复加法错误，测试通过。' });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'model-cache.json'), refreshOnCreate: false,
  });
  modelRuntime.registerProvider('local-fixture', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-test-only', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Local fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1024 }],
  });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'local-fixture/fixture']);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, packages: [] });
  const sessionsRoot = join(root, 'sessions');
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime(options, { modelRuntime, settingsManager, sessionsRoot });
    await runtime.session.bindExtensions({});
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...readTools].sort());
    await runtime.session.prompt('先讨论如何修复 sum，不要修改。');
    assert.equal(requests.length, 1);
    assert.match(readFileSync(join(cwd, 'sum.js'), 'utf8'), /return a - b/);
    const conversation = () => runtime!.session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const initialMessages = [...conversation()];
    await runtime.session.prompt('/execute');
    assert.equal(requests.length, 1, 'switching must not call the model');
    assert.deepEqual(conversation(), initialMessages, 'switching preserves the conversation');
    assert.ok(runtime.session.messages.some((m) => m.role === 'custom' && m.customType === 'local-pi-mode-change'));
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...codingTools].sort());
    const tools: string[] = [];
    const failures: string[] = [];
    let text = '';
    runtime.session.subscribe((event) => {
      if (event.type === 'tool_execution_start') tools.push(event.toolName);
      if (event.type === 'tool_execution_end' && event.isError) failures.push(event.toolName);
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') text += event.assistantMessageEvent.delta;
    });
    discussing = false;
    await runtime.session.prompt('开始改');
    const last = runtime.session.messages.findLast((message) => message.role === 'assistant');
    assert.notEqual(last?.role === 'assistant' ? last.stopReason : undefined, 'error', JSON.stringify(last));
    assert.deepEqual(failures, []);
    assert.deepEqual(tools, ['read', 'edit', shell]);
    assert.match(text, /已修复/);
    assert.match(readFileSync(join(cwd, 'sum.js'), 'utf8'), /return a \+ b/);
    execFileSync(process.execPath, ['--test'], { cwd, stdio: 'pipe' });
    assert.equal(requests.length, 5);
    assert.equal(requests[4]!.messages.filter((m) => m.role === 'tool').length, 3);
    const executionMessages = requests[1]!.messages;
    const taskIndex = executionMessages.findLastIndex((m) => JSON.stringify(m.content) === JSON.stringify([{ type: 'text', text: '开始改' }]));
    const stateIndex = executionMessages.findLastIndex((m) => m.role === 'user'
      && JSON.stringify(m.content).includes('[Local Pi 当前模式] mode=execute'));
    assert.ok(taskIndex >= 0 && stateIndex > taskIndex,
      'the model must receive current execution state after the new task and old refusal');
    assert.deepEqual(requests[1]!.tools.map((tool) => tool.function.name).sort(), [...codingTools].sort());
    assert.ok(runtime.session.sessionManager.getBranch().some((entry) => entry.type === 'message'
      && entry.message.role === 'system' && JSON.stringify(entry.message).includes('local_pi_mode')),
      'the mode instruction must also be persisted through Pi structured system sections');
    const saved = runtime.session.sessionFile;
    assert.ok(saved);
    assert.match(readFileSync(saved, 'utf8'), /开始改/);
    await runtime.dispose();

    runtime = await createRuntime({ ...options, continue: true }, { modelRuntime, settingsManager, sessionsRoot });
    assert.equal(runtime.session.sessionFile, saved);
    assert.match(runtime.session.getLastAssistantText() ?? '', /已修复/);
    await runtime.session.bindExtensions({});
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...codingTools].sort());
    const beforeDiscuss = [...conversation()];
    await runtime.session.prompt('/discuss');
    assert.deepEqual(conversation(), beforeDiscuss);
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...readTools].sort());
    assert.equal(requests.length, 5);
    await runtime.dispose();

    runtime = await createRuntime({ ...options, continue: true }, { modelRuntime, settingsManager, sessionsRoot });
    await runtime.session.bindExtensions({});
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...readTools].sort());
    actions.push({ name: 'write', arguments: { path: 'should-not-exist.txt', content: 'blocked' } });
    await runtime.session.prompt('分析即可，不修改。');
    assert.equal(existsSync(join(cwd, 'should-not-exist.txt')), false, 'even an unsolicited write call must not modify files');
    assert.deepEqual(requests[5]!.tools.map((tool) => tool.function.name).sort(), [...readTools].sort());
    const restoredRequest = JSON.stringify(requests[5]!.messages);
    assert.ok(restoredRequest.lastIndexOf('[Local Pi 当前模式] mode=discuss') > restoredRequest.lastIndexOf('分析即可，不修改。'));

    let release!: () => void;
    holdResponse = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { onRequest = resolve; });
    const running = runtime.session.prompt('继续分析。');
    await started;
    try {
      await runtime.session.prompt('/execute');
      assert.equal(restoreMode(runtime.session.sessionManager.getBranch()), 'discuss');
      assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...readTools].sort());
    } finally {
      holdResponse = undefined;
      onRequest = undefined;
      release();
      await running;
    }
    await runtime.newSession();
    assert.equal(runtime.cwd, options.cwd);
    assert.equal(runtime.session.messages.length, 0);
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...readTools].sort());

    await assert.rejects(createRuntime({ ...options, cwd: root, session: saved }, { modelRuntime, settingsManager, sessionsRoot }), /会话所属项目/);
    assert.notEqual(sessionDirectory(cwd), sessionDirectory(root));
  } finally {
    await runtime?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
