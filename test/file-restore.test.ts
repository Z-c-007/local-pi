import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { SessionPool, type SessionSlot } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { FileRestore } from '../src/agent/file-restore.ts';
import { WorkspaceCoordinator } from '../src/agent/workspace-coordinator.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { changesPanel } from '../src/tui/changes-panel.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

const answer = (content: any[] = [{ type: 'text', text: 'done' }], stopReason = 'stop'): any => ({ role: 'assistant', content,
  api: 'openai-completions', provider: 'restore-fixture', model: 'fixture', stopReason, timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-restore-')); const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir); writeFileSync(join(cwd, 'dirty.txt'), 'USER_DIRTY\r\nold\r\n');
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  models.registerProvider('restore-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'restore-fixture/fixture']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }) }), join(root, 'sessions'));
  const a = await pool.open(); await pool.submit(a.id, '/execute');
  return { root, cwd, agentDir, pool, a };
}
async function tools(pool: SessionPool, slot: SessionSlot, calls: Array<{ name: string; arguments: any }>, title = 'Modify fixture') {
  let round = 0;
  slot.runtime.session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const call = calls[round++];
    const message = call ? answer([{ type: 'toolCall', id: `tool-${round}`, ...call }], 'toolUse') : answer();
    queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message })); return stream;
  };
  await pool.submit(slot.id, title);
  assert.equal(slot.error, undefined);
  return slot.fileChanges.at(-1)!;
}
const edit = (path = 'dirty.txt', oldText = 'old', newText = 'new') => ({ name: 'edit', arguments: { path, edits: [{ oldText, newText }] } });
const write = (path: string, content: string) => ({ name: 'write', arguments: { path, content } });

test('real SDK edits undo per file/whole task, preserve dirty CRLF and other chats; redo persists across reopen', async () => {
  const { pool, a, cwd } = await fixture();
  try {
    const report = await tools(pool, a, [edit(), write('new.txt', 'new file')]);
    assert.ok(report.changes.every((file) => file.attribution === 'tool'), JSON.stringify(report.changes));
    const b = await pool.open(); b.compactionQueue.push({ text: 'UNSENT', mode: 'followUp' });
    const beforeB = JSON.stringify(b.runtime.session.sessionManager.getBranch()); const queueB = JSON.stringify(b.compactionQueue);
    const single = await pool.restorePlan(a.id, report.id, 'undo', 'new.txt'); assert.deepEqual(single.conflicts, []);
    await pool.applyRestore(a.id, single); assert.equal(existsSync(join(cwd, 'new.txt')), false);
    assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nnew\r\n');
    const whole = await pool.restorePlan(a.id, report.id, 'undo'); assert.equal(whole.files.length, 1);
    await pool.applyRestore(a.id, whole); assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nold\r\n');
    assert.equal(JSON.stringify(b.runtime.session.sessionManager.getBranch()), beforeB); assert.equal(JSON.stringify(b.compactionQueue), queueB);
    assert.ok(b.workspaceChanged); assert.ok(a.runtime.session.messages.some((message: any) => message.customType === 'local-pi-file-restore'));
    const id = a.id; await pool.close(id); const reopened = await pool.openSession(id, cwd);
    assert.equal(reopened.fileChanges[0]?.changes.filter((file) => file.restoreState === 'undone').length, 2);
    const redo = await pool.restorePlan(id, report.id, 'redo'); assert.deepEqual(redo.conflicts, []);
    await pool.applyRestore(id, redo); assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'new file');
    assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nnew\r\n');
    await assert.rejects(pool.applyRestore(b.id, redo), /其他会话/);
    await assert.rejects(pool.restorePlan(b.id, report.id, 'undo'), /不属于/);
    const journals = await pool.restore.journals(); assert.equal(journals.length, 3); assert.ok(journals.every((journal) => journal.phase === 'completed'));
    assert.deepEqual(await pool.coordinator.pendingFor(cwd), []);
  } finally { await pool.dispose(); }
});

test('external edits, stale previews, same-byte later tools and corrupt/old snapshots refuse restoration without touching files', async () => {
  const { pool, a, cwd } = await fixture();
  try {
    const report = await tools(pool, a, [edit(), write('new.txt', 'new file')]);
    const plan = await pool.restorePlan(a.id, report.id, 'undo'); assert.deepEqual(plan.conflicts, []);
    writeFileSync(join(cwd, 'dirty.txt'), 'USER_NOW');
    await assert.rejects(pool.applyRestore(a.id, plan), /冲突/);
    assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'new file'); assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_NOW');
    const b = await pool.open(); await pool.submit(b.id, '/execute');
    await tools(pool, b, [write('new.txt', 'new file')]); // Net bytes unchanged, still a newer operation.
    const conflict = await pool.restorePlan(a.id, report.id, 'undo', 'new.txt'); assert.match(conflict.conflicts.join(), /本轮之后/);
    await assert.rejects(pool.applyRestore(a.id, conflict), /冲突/);
    const fresh = await tools(pool, a, [write('safe.txt', 'SAFE')]);
    const recordPath = join(pool.fileChanges.root, fresh.id, 'record.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    delete record.changes[0].attribution; writeFileSync(recordPath, JSON.stringify(record));
    assert.match((await pool.restorePlan(a.id, fresh.id, 'undo')).conflicts.join(), /旧快照/);
    record.changes[0].attribution = 'tool'; writeFileSync(recordPath, JSON.stringify(record));
    writeFileSync(join(pool.fileChanges.root, fresh.id, 'blobs', fresh.changes[0]!.after!.hash!), 'CORRUPTED');
    assert.match((await pool.restorePlan(a.id, fresh.id, 'undo')).conflicts.join(), /校验/);
    assert.equal(readFileSync(join(cwd, 'safe.txt'), 'utf8'), 'SAFE');
  } finally { await pool.dispose(); }
});

test('other-file tasks remain independent; active overlapping read/write tasks block restore and are never aborted', async () => {
  const { pool, a, cwd, root } = await fixture();
  try {
    const report = await tools(pool, a, [edit()]); const b = await pool.open();
    await pool.submit(b.id, '/execute'); await tools(pool, b, [write('other.txt', 'B_OWN')]);
    assert.deepEqual((await pool.restorePlan(a.id, report.id, 'undo')).conflicts, []);
    await pool.submit(b.id, '/discuss'); let pending = false; let release!: () => void; let aborted = false;
    b.runtime.session.agent.streamFunction = (_m, _c, opts) => {
      const stream = createAssistantMessageEventStream(); pending = true;
      release = () => stream.push({ type: 'done', reason: 'stop', message: answer() });
      opts?.signal?.addEventListener('abort', () => { aborted = true; release(); }); return stream;
    };
    const task = pool.submit(b.id, 'Continue B'); await until(() => pending);
    await assert.rejects(pool.restorePlan(a.id, report.id, 'undo'), /正在运行/); assert.equal(aborted, false);
    release(); await task;
    await pool.applyRestore(a.id, await pool.restorePlan(a.id, report.id, 'undo'));
    assert.equal(readFileSync(join(cwd, 'other.txt'), 'utf8'), 'B_OWN');
    const coordinator2 = new WorkspaceCoordinator(join(root, 'sessions')); const child = join(cwd, 'child'); mkdirSync(child);
    const lease = await coordinator2.acquire(child, 'read', 'separate-process');
    try { await assert.rejects(pool.restorePlan(a.id, report.id, 'redo'), /相关目录/); }
    finally { await coordinator2.release(lease); }
    const restoreLease = await coordinator2.acquire(cwd, 'restore', 'separate-process');
    try {
      await assert.rejects(pool.coordinator.acquire(child, 'write', a.id), /文件恢复/);
      await assert.rejects(pool.coordinator.acquire(cwd, 'read', b.id), /文件恢复/);
    } finally { await coordinator2.release(restoreLease); }
  } finally { await pool.dispose(); }
});

test('partial multi-file failure keeps durable backups, blocks tasks and recovers only its owning chat', async () => {
  const { pool, a, cwd } = await fixture();
  try {
    const report = await tools(pool, a, [edit(), write('new.txt', 'new file')]); const plan = await pool.restorePlan(a.id, report.id, 'undo');
    const failing = new FileRestore(pool.fileChanges, pool.coordinator, async (stage) => { if (stage === 'after') throw new Error('SIMULATED_DISK_FAILURE'); });
    await assert.rejects(failing.apply(a.runtime.session, plan), /recovery/);
    const [journal] = await failing.journals(); assert.equal(journal?.phase, 'needs_recovery');
    assert.ok(existsSync(join(failing.root, journal!.id, 'backups', '0.bin')));
    assert.equal((await pool.coordinator.pendingFor(cwd)).length, 1);
    await assert.rejects(pool.coordinator.acquire(cwd, 'write', a.id), /未完成/);
    const b = await pool.open(); await assert.rejects(pool.recoverRestore(b.id, journal!.id), /不属于/);
    await pool.recoverRestore(a.id, journal!.id);
    assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nnew\r\n');
    assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'new file');
    assert.deepEqual(await pool.coordinator.pendingFor(cwd), []);
    const retry = await pool.restorePlan(a.id, report.id, 'undo'); assert.deepEqual(retry.conflicts, []);
    await pool.applyRestore(a.id, retry);
  } finally { await pool.dispose(); }
});

test('recovery refuses a post-failure external edit; links stay protected while recorded shell changes can undo', async () => {
  const { pool, a, cwd } = await fixture();
  try {
    const report = await tools(pool, a, [edit(), write('new.txt', 'new file')]);
    const failing = new FileRestore(pool.fileChanges, pool.coordinator, async (stage) => { if (stage === 'after') throw new Error('INTERRUPT'); });
    await assert.rejects(failing.apply(a.runtime.session, await pool.restorePlan(a.id, report.id, 'undo')), /recovery/);
    const [journal] = await failing.journals(); writeFileSync(join(cwd, 'dirty.txt'), 'EXTERNAL_AFTER_FAILURE');
    await assert.rejects(pool.recoverRestore(a.id, journal!.id), /外部修改/);
    assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'EXTERNAL_AFTER_FAILURE');
    assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'new file');
    assert.equal((await pool.coordinator.pendingFor(cwd)).length, 1);
  } finally { await pool.dispose(); }
  const f = await fixture();
  try {
    const report = await tools(f.pool, f.a, [edit()]); linkSync(join(f.cwd, 'dirty.txt'), join(f.cwd, 'hard-link.txt'));
    assert.match((await f.pool.restorePlan(f.a.id, report.id, 'undo')).conflicts.join(), /链接数/);
    const shell = process.platform === 'win32' ? "Set-Content -LiteralPath shell.txt -Value 'SHELL'" : 'printf SHELL > shell.txt';
    await f.pool.executeShell(f.a.id, shell);
    const plan = await f.pool.restorePlan(f.a.id, f.a.fileChanges.at(-1)!.id, 'undo'); assert.deepEqual(plan.conflicts, []);
    await f.pool.applyRestore(f.a.id, plan); assert.equal(existsSync(join(f.cwd, 'shell.txt')), false);
    assert.equal(readFileSync(join(f.cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nnew\r\n');
  } finally { await f.pool.dispose(); }
});

test('TUI previews cancel without writes; panel actions and confirmed undo/redo preserve SDK history', async () => {
  const { pool, a, cwd } = await fixture(); const terminal = new MemoryTerminal(); const ui = new MultiSessionTui(pool, terminal); const running = ui.run();
  try {
    await until(() => !!terminal.input);
    const b = pool.active; const bUi = b.runtime.session.extensionRunner!.createContext().ui; bUi.setEditorText('B_UNSENT_DRAFT');
    pool.activate(a.id); const report = await tools(pool, a, [edit()]);
    await pool.coordinator.record(cwd, a.id, 'potential side effects: powershell');
    await pool.coordinator.record(cwd, a.id, 'finished potential side effects: powershell');
    const messages = JSON.stringify(a.runtime.session.messages); let offset = terminal.output.length; terminal.type('/undo\r');
    await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('撤销预览'));
    assert.match(stripTerminalSequences(terminal.output.slice(offset)), /历史记录需要人工复核/);
    terminal.input?.('\x1b'); await new Promise((done) => setTimeout(done, 60));
    assert.equal(JSON.stringify(a.runtime.session.messages), messages); assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nnew\r\n');
    offset = terminal.output.length; terminal.type('/changes\r'); await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('撤销此文件'));
    offset = terminal.output.length; terminal.input?.('a'); await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('撤销预览'));
    terminal.input?.('\r'); await until(() => a.fileChanges[0]?.changes[0]?.restoreState === 'undone');
    assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nold\r\n');
    await until(() => !a.task); offset = terminal.output.length; terminal.type('/redo\r');
    await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('重做预览')); terminal.input?.('\r');
    await until(() => a.fileChanges[0]?.changes[0]?.restoreState !== 'undone' && !a.task, 'redo completion').catch((error) => {
      throw new Error(`${String(error)}; state=${a.state}; task=${!!a.task}; notices=${JSON.stringify(a.notices)}; file=${readFileSync(join(cwd, 'dirty.txt'), 'utf8')}`);
    });
    assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'USER_DIRTY\r\nnew\r\n');
    pool.activate(b.id); assert.equal(bUi.getEditorText(), 'B_UNSENT_DRAFT'); pool.activate(a.id);
    initTheme(undefined, false); let action = '';
    const panel = changesPanel([report], () => 24, () => {}, () => {}, report.id, (id, direction, path) => { action = `${id}:${direction}:${path}`; });
    for (const width of [24, 40, 100]) { const lines = panel.render(width); assert.ok(lines.length <= 24); assert.ok(lines.every((line) => visibleWidth(line) <= width)); }
    panel.handleInput?.('u'); assert.equal(action, `${report.id}:undo:dirty.txt`);
  } finally { process.emit('SIGTERM'); await running; await pool.dispose(); }
});

test('independent Node processes share leases; a dead process lease is reclaimed without dropping recovery guards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-coordinator-')); const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const moduleUrl = new URL('../src/agent/workspace-coordinator.ts', import.meta.url).href;
  const code = `import { WorkspaceCoordinator } from ${JSON.stringify(moduleUrl)};
    const coordinator = new WorkspaceCoordinator(process.argv[1]);
    await coordinator.acquire(process.argv[2], 'write', 'CHILD');
    process.stdout.write('LEASE_READY'); process.stdin.resume();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, cwd], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; let errors = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = once(child, 'exit'); const coordinator = new WorkspaceCoordinator(root);
  try {
    await until(() => output.includes('LEASE_READY') || child.exitCode !== null, 'independent process lease'); assert.ok(output.includes('LEASE_READY'), errors);
    await assert.rejects(coordinator.acquire(cwd, 'restore', 'PARENT'), /会话任务/);
    await coordinator.pending('unfinished-fixture', cwd, true);
    child.kill(); await exited;
    await assert.rejects(coordinator.acquire(cwd, 'write', 'PARENT'), /未完成/);
    const recovery = await coordinator.acquire(cwd, 'restore', 'PARENT', 'unfinished-fixture'); await coordinator.release(recovery);
    await coordinator.pending('unfinished-fixture', cwd, false);
    const lease = await coordinator.acquire(cwd, 'write', 'PARENT'); await coordinator.release(lease);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});
