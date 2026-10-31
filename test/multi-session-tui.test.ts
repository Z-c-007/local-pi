import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { restoreMode } from '../src/agent/mode.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

test('official TUI components switch sessions, retain drafts, and route background dialogs', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-ui-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  const pool = new SessionPool(parseOptions(['--cwd', cwd, '--agent-dir', agentDir]), (options, overrides) => createRuntime(options, {
    ...overrides, modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [] }),
  }), join(root, 'sessions'));
  const terminal = new MemoryTerminal();
  const ui = new MultiSessionTui(pool, terminal);
  const running = ui.run();
  try {
    await until(() => !!terminal.input && pool.slots.size === 1);
    const a = pool.active;
    terminal.type('/execute\r');
    await until(() => restoreMode(a.runtime.session.sessionManager.getBranch()) === 'execute');
    terminal.type('\x14'); // Ctrl+T: collapsed -> expanded, local to A.
    await until(() => terminal.output.includes('思考内容:展开'));
    terminal.type('/project'); // Leave an unsubmitted draft in A.
    terminal.type('\x0e'); // Ctrl+N.
    await until(() => pool.slots.size === 2 && pool.activeId !== a.id);
    const b = pool.active;
    terminal.type('/thinking-display hide\r');
    await until(() => b.notices.some((notice) => notice.includes('思考显示：隐藏')));
    terminal.type('\x0f'); // Ctrl+O toggles tools without submitting a task.
    terminal.type('/tools collapse\r');
    await until(() => b.notices.some((notice) => notice.includes('工具结果：折叠')));
    terminal.type('/name B\r');
    await until(() => b.runtime.session.sessionManager.getSessionName() === 'B');
    terminal.type('\x10'); // Ctrl+P; most recently named B is first, A is second.
    await until(() => terminal.output.includes('会话列表 · 当前项目历史'));
    terminal.input?.('\x1b[B');
    terminal.type('\r');
    await until(() => pool.activeId === a.id);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    terminal.type('\r'); // Submit A's restored /project draft.
    await until(() => a.notices.some((notice) => notice.includes('模式：执行')));
    const outputBeforeModeCheck = terminal.output.length;
    terminal.type('/thinking-display\r'); // A was expanded, so its next display state is hidden.
    await until(() => a.notices.some((notice) => notice.includes('思考显示：隐藏')));
    terminal.type('/thinking-display\r'); // hidden -> collapsed
    await until(() => terminal.output.slice(outputBeforeModeCheck).includes('思考内容:折叠'));
    assert.equal(b.notices.some((notice) => notice.includes('模式：执行')), false);
    assert.equal(restoreMode(b.runtime.session.sessionManager.getBranch()), 'discuss');

    const aDialog = a.runtime.session.extensionRunner!.createContext().ui.confirm('A-confirm', 'A question');
    await until(() => a.state === 'waiting');
    pool.activate(b.id);
    const bDialog = b.runtime.session.extensionRunner!.createContext().ui.confirm('B-confirm', 'B question');
    await until(() => b.state === 'waiting');
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    terminal.type('1\r');
    assert.equal(await bDialog, true);
    assert.equal(a.state, 'waiting', 'answering B must not resolve A');
    pool.activate(a.id);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    terminal.type('2\r');
    assert.equal(await aDialog, false);
    terminal.type(`/close ${b.number}\r`);
    await until(() => pool.slots.size === 1);
    terminal.type('/resume\r');
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    assert.equal((await pool.listSessions()).length, 0, 'configuration commands and naming do not create a conversation');
    terminal.type('/new\r');
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    assert.equal(pool.activeId, a.id, 'new reuses the current empty page');
    assert.equal(pool.slots.size, 1);
    a.runtime.session.extensionRunner!.createContext().ui.setEditorText('UNSENT_DRAFT');
    terminal.type('\x0e\x0e\x0e'); // Rapid new requests must share one pending blank page.
    await until(() => pool.slots.size === 2);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    assert.equal(pool.slots.size, 2);
    const fresh = pool.active;
    const draftMenuOffset = terminal.output.length;
    terminal.type('/sessions\r');
    await until(() => terminal.output.slice(draftMenuOffset).includes('临时草稿'));
    terminal.type('\r');
    await until(() => pool.activeId === a.id);
    assert.equal(a.runtime.session.extensionRunner!.createContext().ui.getEditorText(), 'UNSENT_DRAFT');
    assert.equal((await pool.catalog.list(a.runtime.cwd)).length, 0);
    a.runtime.session.extensionRunner!.createContext().ui.setEditorText('');
    assert.ok(pool.slots.has(fresh.id));
    terminal.type('/quit\r');
    await running;
    assert.equal(pool.slots.size, 0);
  } finally {
    await pool.dispose();
    terminal.type('/quit\r');
  }
});
