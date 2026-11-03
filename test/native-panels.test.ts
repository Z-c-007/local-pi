import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('native settings/model selectors, real configured hotkeys and read-only session stats', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-panels-'));
  const cwd = join(root, 'project'); const agentDir = join(root, 'agent'); mkdirSync(cwd); mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], theme: 'dark', defaultProvider: 'panel-fixture', defaultModel: 'alpha', retry: { enabled: false } }));
  writeFileSync(join(agentDir, 'keybindings.json'), JSON.stringify({
    'app.model.select': 'alt+l', 'app.models.save': 'alt+s', 'local.session.select': 'alt+j', 'local.session.new': 'alt+n',
  }));
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* local fixture */ }
    requests++; await held;
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'alpha', created: 1,
      choices: [{ index: 0, delta: { content: 'Panel fixture completed.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
    })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('panel-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture',
    models: ['alpha', 'beta'].map((id) => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
  const settings = SettingsManager.create(cwd, agentDir);
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir]);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime, settingsManager: settings }), join(root, 'sessions'));
  const terminal = new MemoryTerminal(); const ui = new MultiSessionTui(pool, terminal); const running = ui.run();
  const plain = () => stripTerminalSequences(terminal.output);
  const close = async () => { terminal.type('\x1b'); await new Promise((done) => setTimeout(done, 50)); };
  const open = async (command: string, marker: string) => {
    await new Promise((done) => setTimeout(done, 50)); const offset = terminal.output.length;
    terminal.type(`${command}\r`);
    await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes(marker), `${command} native panel`);
  };
  try {
    await until(() => !!terminal.input && pool.slots.size === 1);
    const a = pool.active;
    await open('/settings', 'Auto-compact');
    terminal.type('auto-compact\r');
    await until(() => !settings.getCompactionEnabled());
    assert.equal(a.runtime.session.autoCompactionEnabled, false);
    await close(); await settings.flush();
    assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).compaction.enabled, false);
    await open('/settings', 'Auto-compact');
    terminal.type('hide thinking\r');
    await until(() => settings.getGlobalSettings().hideThinkingBlock !== undefined);
    await close();
    await open('/settings', 'Auto-compact');
    terminal.type('steering mode\r');
    await until(() => settings.getSteeringMode() === 'all');
    assert.equal(a.runtime.session.steeringMode, 'all');
    await close();
    assert.equal(requests, 0);

    const offset = terminal.output.length;
    terminal.input?.('\x1bl'); // Configured model selector key, native search UI.
    await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('Only showing models'));
    terminal.type('beta\r');
    await until(() => a.runtime.session.model?.id === 'beta');
    assert.equal(settings.getDefaultModel(), 'alpha', 'Enter changes only this live session');
    await open('/model alpha', 'Model Name:'); // Exact ID without provider opens native search.
    await close();
    assert.equal(a.runtime.session.model?.id, 'beta', 'cancel keeps current model');
    await open('/model', 'Only showing models');
    terminal.type('beta'); terminal.input?.('\x1bs');
    await until(() => settings.getDefaultModel() === 'beta');
    await settings.flush();
    assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultModel, 'beta');

    const beforeInfo = a.runtime.session.sessionManager.getEntryCount();
    await open('/session', '当前会话统计');
    terminal.input?.('\x1b[6~'); // PageDown on the long read-only statistics view.
    await close();
    await open('/hotkeys', '快捷键帮助');
    terminal.input?.('\x1b[F'); // End: context/conflict help is also reachable.
    await until(() => plain().includes('绑定冲突'));
    await close();
    assert.equal(a.runtime.session.sessionManager.getEntryCount(), beforeInfo, 'information pages never enter the model context');
    assert.equal(requests, 0);

    const taskA = pool.submit(a.id, 'Discuss the local fixture.');
    await until(() => requests === 1 && !!a.task);
    await open('/session', '当前会话统计');
    await close();
    terminal.type('/model panel-fixture/alpha\r');
    await until(() => a.notices.some((notice) => notice.includes('先停止此会话')));
    assert.equal(a.runtime.session.model?.id, 'beta');
    terminal.input?.('\x1bn'); // Configured independent-session key.
    await until(() => pool.slots.size === 2 && pool.activeId !== a.id);
    const b = pool.active;
    await open('/settings', 'Auto-compact');
    assert.ok(a.task, 'opening B settings cannot interrupt A');
    await close();
    assert.equal(b.runtime.session.model?.id, 'beta', 'new sessions use saved default model');
    assert.ok(a.task);
    release(); await taskA;
    pool.activate(a.id);
    const beforeStats = a.runtime.session.sessionManager.getEntryCount();
    await open('/session', '当前会话统计');
    terminal.input?.('\x1b[6~');
    await until(() => plain().includes('120'));
    await close();
    assert.equal(a.runtime.session.sessionManager.getEntryCount(), beforeStats);
    assert.equal(a.runtime.session.getSessionStats().tokens.total, 120);
    assert.equal(requests, 1);
  } finally {
    release();
    process.emit('SIGTERM');
    await settle(running, 'native-panels TUI shutdown');
    await settle(pool.dispose(), 'native-panels pool dispose');
    server.closeAllConnections();
    await settle(new Promise<void>((done) => server.close(() => done())), 'native-panels fixture server');
  }
});
