import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getKeybindings, stripTerminalSequences } from '@earendil-works/pi-tui';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

async function setup(bindings?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-thinking-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  if (bindings) writeFileSync(join(agentDir, 'keybindings.json'), JSON.stringify(bindings));
  const requests: Array<{ reasoning_effort?: string }> = [];
  let nextHold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const hold = nextHold;
    nextHold = undefined;
    await hold;
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'reasoner',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: 'assistant' }); send({ content: 'Fixture completed.' }); send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  const common = { name: 'fixture', input: ['text'] as ['text'], contextWindow: 32000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  modelRuntime.registerProvider('thinking-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: 'openai-completions', apiKey: 'local-test', models: [
      { ...common, id: 'reasoner', reasoning: true,
        thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
      { ...common, id: 'plain', reasoning: false },
    ] });
  const settingsManager = SettingsManager.inMemory({ packages: [], defaultThinkingLevel: 'medium', retry: { enabled: false } });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'thinking-fixture/reasoner']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, {
    ...overrides, modelRuntime, settingsManager,
  }), join(root, 'sessions'));
  const terminal = new MemoryTerminal();
  const previousKeys = getKeybindings();
  const ui = new MultiSessionTui(pool, terminal);
  const running = ui.run();
  await until(() => !!terminal.input && pool.slots.size === 1);
  const menu = async () => {
    // Let the preceding overlay removal paint before asserting the next frame;
    // the TUI otherwise coalesces identical frames and writes only differences.
    await new Promise((resolveRender) => setTimeout(resolveRender, 40));
    const offset = terminal.output.length;
    terminal.type('/thinking\r');
    await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('Thinking Level'), 'official thinking selector');
  };
  return {
    pool, terminal, settingsManager, requests, menu, cwd,
    holdNext() { nextHold = new Promise<void>((resolveHold) => { release = resolveHold; }); return () => release?.(); },
    async finish() {
      release?.();
      if (terminal.input) process.emit('SIGTERM');
      await running;
      await pool.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      assert.equal(getKeybindings(), previousKeys, 'leaving the TUI restores its previous key registry');
    },
  };
}

test('native thinking selector, Shift+Tab, persistence and active SDK requests remain independent', { timeout: 30_000 }, async () => {
  const fixture = await setup();
  const { pool, terminal, settingsManager, requests, menu } = fixture;
  try {
    const a = pool.active;
    assert.deepEqual(a.runtime.session.getAvailableThinkingLevels(), ['off', 'low', 'medium', 'high']);
    assert.equal(a.runtime.session.thinkingLevel, 'medium');
    terminal.type('保留草稿');
    terminal.input?.('\x1b[Z'); // Shift+Tab, handled by the native CustomEditor action.
    await until(() => a.runtime.session.thinkingLevel === 'high');
    assert.equal(a.runtime.session.extensionRunner!.createContext().ui.getEditorText(), '保留草稿');
    terminal.type('\x03');
    terminal.type('/thinking low\r');
    await until(() => a.runtime.session.thinkingLevel === 'low');
    assert.equal(settingsManager.getDefaultThinkingLevel(), 'medium', 'normal selection must not change defaults');
    await menu();
    terminal.type('high\r');
    await until(() => a.runtime.session.thinkingLevel === 'high');
    assert.equal(requests.length, 0, 'opening a selector and changing levels must not call the model');
    terminal.type('/thinking-display hide\r');
    await until(() => a.notices.some((notice) => notice.includes('思考显示：隐藏')));
    assert.equal(a.runtime.session.thinkingLevel, 'high');
    terminal.type('\x14'); // Ctrl+T affects display only.
    await until(() => terminal.output.includes('思考内容:展开'));
    assert.equal(a.runtime.session.thinkingLevel, 'high');
    terminal.type('/thinking hide\r');
    await until(() => a.notices.some((notice) => notice.includes('当前模型支持的推理等级')));
    assert.equal(a.runtime.session.thinkingLevel, 'high');

    const release = fixture.holdNext();
    const task = pool.submit(a.id, 'Discuss the project without editing it.');
    await until(() => requests.length === 1);
    assert.equal(requests[0]!.reasoning_effort, 'high');
    terminal.type('/thinking low\r');
    await until(() => a.runtime.session.thinkingLevel === 'low');
    assert.ok(a.task, 'changing effort must not abort the running request');
    assert.equal(requests.length, 1, 'changing effort must not restart the request');
    release(); await task;
    await pool.submit(a.id, 'Continue discussing.');
    assert.equal(requests[1]!.reasoning_effort, 'low', 'the next request uses the selected SDK level');
    await until(() => terminal.output.includes('推理等级:low'));

    const b = await pool.open();
    assert.equal(b.runtime.session.thinkingLevel, 'medium');
    await menu();
    terminal.type('low'); terminal.type('\x13'); // Native Ctrl+S explicitly saves the default.
    await until(() => settingsManager.getDefaultThinkingLevel() === 'low');
    assert.ok(b.notices.some((notice) => notice.includes('已保存为默认')));
    terminal.type('/thinking high\r');
    await until(() => b.runtime.session.thinkingLevel === 'high');
    assert.equal(a.runtime.session.thinkingLevel, 'low', 'live sessions retain independent effort levels');
    await pool.close(b.id);
    await assert.rejects(pool.openSession(b.id, fixture.cwd), /不存在/, 'an unsubmitted session must not become history');
    await pool.close(a.id);
    const restoredA = await pool.openSession(a.id, fixture.cwd);
    assert.equal(restoredA.runtime.session.thinkingLevel, 'low', 'SDK transcript restoration retains its level');
    const c = await pool.open();
    assert.equal(c.runtime.session.thinkingLevel, 'low', 'new sessions use the explicitly saved default');

    terminal.type('/model thinking-fixture/plain\r');
    await until(() => c.runtime.session.model?.id === 'plain');
    assert.deepEqual(c.runtime.session.getAvailableThinkingLevels(), ['off']);
    terminal.input?.('\x1b[Z');
    await until(() => c.notices.some((notice) => notice.includes('不支持切换推理等级')));
    await menu();
    terminal.type('\x1b');
    assert.equal(c.runtime.session.thinkingLevel, 'off');
    terminal.type('/thinking high\r');
    await until(() => c.notices.some((notice) => notice.includes('推理等级：off。')));
    assert.equal(requests.length, 2);
  } finally { await fixture.finish(); }
});

test('native thinking actions honor configured keys and selecting or cancelling preserves the default', { timeout: 20_000 }, async () => {
  const fixture = await setup({ 'app.thinking.cycle': 'alt+y', 'app.thinking.save': 'alt+s' });
  const { pool, terminal, menu, settingsManager, requests } = fixture;
  try {
    const slot = pool.active;
    terminal.input?.('\x1by');
    await until(() => slot.runtime.session.thinkingLevel === 'high');
    await menu();
    terminal.type('low'); terminal.type('\x1b'); // Cancel the official picker.
    assert.equal(slot.runtime.session.thinkingLevel, 'high');
    assert.equal(settingsManager.getDefaultThinkingLevel(), 'medium');
    await menu();
    terminal.type('low'); terminal.input?.('\x1bs');
    await until(() => settingsManager.getDefaultThinkingLevel() === 'low');
    assert.equal(slot.runtime.session.thinkingLevel, 'low');
    assert.equal(requests.length, 0);
  } finally { await fixture.finish(); }
});
