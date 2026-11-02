import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { FileChanges, changeSummary, within } from '../src/agent/file-changes.ts';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { Transcript } from '../src/tui/transcript.ts';
import { changesPanel } from '../src/tui/changes-panel.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

const answer = (text: string, extra: Record<string, unknown> = {}): any => ({ role: 'assistant', content: [{ type: 'text', text }],
  api: 'openai-completions', provider: 'changes-fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });

test('byte snapshots work without Git: dirty baseline, additions, deletions, binary/large limits and readonly diff browser', async () => {
  initTheme(undefined, false);
  const root = mkdtempSync(join(tmpdir(), 'local-pi-snapshot-')); const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(join(cwd, '.svn')); mkdirSync(join(cwd, 'node_modules'));
  writeFileSync(join(cwd, '.svn', 'private'), 'SVN_METADATA'); writeFileSync(join(cwd, 'node_modules', 'ignored'), 'DEPENDENCY');
  writeFileSync(join(cwd, 'dirty.txt'), 'USER_DIRTY\nold\n'); writeFileSync(join(cwd, 'deleted.txt'), 'KEEP_BEFORE_DELETE');
  writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2])); writeFileSync(join(cwd, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'not-captured'), 'OUTSIDE');
  try { symlinkSync(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* Windows can deny symlink creation. */ }
  const manager = SessionManager.create(cwd, join(root, 'sessions')); manager.appendMessage({ role: 'user', content: 'QUESTION', timestamp: 1 }); manager.appendMessage(answer('ANSWER'));
  const session: any = { sessionId: manager.getSessionId(), sessionManager: manager, get messages() { return manager.buildSessionContext().messages; } };
  const store = new FileChanges(join(cwd, 'archive')); const capture = await store.begin(session, agentDir, 'Modify fixture', 'task');
  assert.ok(!capture.before.files['.svn/private']); assert.ok(!capture.before.files['node_modules/ignored']);
  assert.ok(!capture.before.files['linked/not-captured']);
  writeFileSync(join(cwd, 'dirty.txt'), 'USER_DIRTY\nnew\n'); writeFileSync(join(cwd, 'added.txt'), 'new file\n'); unlinkSync(join(cwd, 'deleted.txt'));
  writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 4, 2]));
  const report = await store.finish(capture, session, agentDir, 'failed');
  const changed = new Map(report.changes.map((file) => [file.path, file]));
  assert.equal(changed.get('added.txt')?.kind, 'added'); assert.equal(changed.get('deleted.txt')?.kind, 'deleted');
  const dirty = changed.get('dirty.txt')!; assert.equal(dirty.kind, 'modified'); assert.equal(dirty.added, 1); assert.equal(dirty.removed, 1);
  assert.ok(dirty.diff?.includes('USER_DIRTY')); assert.ok(dirty.diff?.includes('old') && dirty.diff.includes('new'));
  assert.equal(readFileSync(join(capture.directory, 'blobs', dirty.before!.hash!), 'utf8'), 'USER_DIRTY\nold\n');
  assert.match(changed.get('binary.bin')!.note!, /二进制/); assert.equal(changed.get('large.txt')?.kind, 'unavailable');
  assert.ok(report.issues.some((issue) => issue.includes('2 MiB'))); assert.equal(report.status, 'failed');
  assert.equal(new FileChanges(join(cwd, 'archive')).read(session)[0]?.id, report.id);
  assert.ok(within(cwd, join(cwd, 'x'))); assert.equal(within(cwd, outside), false);
  const original = readFileSync(join(cwd, 'dirty.txt')); let closed = false;
  const panel = changesPanel([report], () => 24, () => {}, () => { closed = true; });
  for (const width of [24, 40, 100]) {
    const lines = panel.render(width); assert.ok(lines.length <= 24);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  panel.handleInput?.('i'); assert.match(panel.render(100).map(stripTerminalSequences).join('\n'), /快照|2 MiB|workspace/);
  panel.handleInput?.('\x1b'); assert.equal(closed, true); assert.deepEqual(readFileSync(join(cwd, 'dirty.txt')), original);
  assert.match(changeSummary(report), /记录不完整/);
  const second = await store.begin(session, agentDir, 'crashed run', 'task');
  assert.equal(store.read(session).at(-1)?.status, 'running');
  unlinkSync(join(second.directory, 'record.json')); assert.match(store.read(session).at(-1)!.issues.join(''), /缺失或损坏/);
});

test('real SDK writes, failed/stopped tasks, shell edits, restored history and visual cards stay session-local', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-changes-integration-')); const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir); writeFileSync(join(cwd, 'dirty.txt'), 'USER_DIRTY\n');
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  models.registerProvider('changes-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'changes-fixture/fixture']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }) }), join(root, 'sessions'));
  const terminal = new MemoryTerminal(); const ui = new MultiSessionTui(pool, terminal); const running = ui.run();
  try {
    await until(() => !!terminal.input); const a = pool.active; await pool.submit(a.id, '/execute');
    let rounds = 0; let release!: () => void; let hold = false; let pending = false;
    a.runtime.session.agent.streamFunction = (_m, context, opts) => {
      const stream = createAssistantMessageEventStream();
      if (hold) {
        pending = true; release = () => stream.push({ type: 'done', reason: 'aborted', message: answer('', { stopReason: 'aborted' }) });
        opts?.signal?.addEventListener('abort', release, { once: true }); return stream;
      }
      const message = rounds++ === 0 ? answer('', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'real-write', name: 'write', arguments: { path: 'dirty.txt', content: 'USER_DIRTY\nAGENT_EDIT\n' } }] })
        : answer('', { stopReason: 'error', errorMessage: 'fixture failed after write' });
      assert.ok(!JSON.stringify(context.messages).includes('local-pi-file-changes'), 'host snapshots never enter model context');
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message })); return stream;
    };
    await pool.submit(a.id, 'Modify then fail'); assert.equal(a.fileChanges.length, 1);
    const first = a.fileChanges[0]!; assert.equal(first.status, 'failed'); assert.equal(first.changes[0]?.path, 'dirty.txt');
    const modelMessages = JSON.stringify(a.runtime.session.messages);
    const b = await pool.open(); assert.equal(b.fileChanges.length, 0);
    pool.activate(a.id); const offset = terminal.output.length; terminal.type('/changes\r');
    await until(() => stripTerminalSequences(terminal.output.slice(offset)).includes('本轮文件变更'));
    terminal.input?.('\x1b'); assert.equal(JSON.stringify(a.runtime.session.messages), modelMessages);
    let viewed = ''; const transcript = new Transcript(a, { requestRender() {} } as any, () => {}, (id) => { viewed = id; });
    const lines = transcript.render(100).map(stripTerminalSequences); const y = lines.findIndex((line) => line.includes('[查看变更]'));
    assert.ok(y >= 0); const clicked = transcript.handleMouse({ type: 'click', button: 'left', x: 2, y, screenX: 2, screenY: y, width: 100, height: lines.length, shift: false, alt: false, ctrl: false });
    assert.ok(clicked?.handled); assert.equal(viewed, first.id);
    hold = true; const task = pool.submit(a.id, 'Stop this task'); await until(() => pending);
    writeFileSync(join(cwd, 'stopped.txt'), 'written before stop'); pool.activate(b.id); await pool.abort(a.id); await task;
    assert.equal(a.fileChanges.at(-1)?.status, 'aborted'); assert.ok(a.fileChanges.at(-1)?.observedChanges?.some((c) => c.path === 'stopped.txt'));
    assert.ok(!a.fileChanges.at(-1)?.changes.some((c) => c.path === 'stopped.txt'), 'external edits are observations, never owned changes');
    assert.equal(b.fileChanges.length, 0);
    await pool.executeShell(a.id, process.platform === 'win32' ? "Set-Content -LiteralPath shell.txt -Value 'SHELL_EDIT'" : "printf SHELL_EDIT > shell.txt");
    assert.equal(a.fileChanges.at(-1)?.source, 'shell'); assert.ok(a.fileChanges.at(-1)?.changes.some((c) => c.path === 'shell.txt'));
    const id = a.id; await pool.close(id); const restored = await pool.openSession(id, cwd);
    assert.equal(restored.fileChanges.length, 3); assert.equal(restored.fileChanges[0]?.id, first.id);
    assert.ok(existsSync(join(cwd, 'shell.txt')), 'viewing and restoring chat never undoes files');
  } finally { process.emit('SIGTERM'); await running; await pool.dispose(); }
});
