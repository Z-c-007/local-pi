import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime, sessionDirectory } from '../src/agent/runtime.ts';
import { modeEntryType, restoreMode } from '../src/agent/mode.ts';
import { parseOptions } from '../src/cli.ts';

test('only submitted conversations persist; legacy histories and missing-file checks survive restart', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-catalog-'));
  const cwd = join(root, 'project');
  const other = join(root, 'other');
  const agentDir = join(root, 'agent');
  const sessionsRoot = join(root, 'sessions');
  for (const directory of [cwd, other, agentDir]) mkdirSync(directory);
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  const factory = async (opts: typeof options, overrides: Parameters<typeof createRuntime>[1]) => {
    const runtime = await createRuntime(opts, {
      ...overrides, modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [] }),
    });
    // Exercise deterministic preflight failure, independent of host credentials/catalogs.
    runtime.session.agent.state.model = undefined;
    return runtime;
  };
  let pool = new SessionPool(options, factory, sessionsRoot);
  try {
    // Pre-existing SDK JSONL with several turns and no Local Pi index.
    const legacy = SessionManager.create(cwd, sessionDirectory(cwd, sessionsRoot));
    for (const text of ['first task', 'second question', 'third question']) {
      legacy.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    }
    legacy.appendSessionInfo('原有会话');
    legacy.appendCustomEntry(modeEntryType, { mode: 'execute' });
    const external = SessionManager.create(other, sessionDirectory(other, sessionsRoot));
    external.appendMessage({ role: 'user', content: 'other project', timestamp: Date.now() });

    const a = await pool.open();
    await pool.submit(a.id, '/execute');
    a.runtime.session.setSessionName('尚未发送任务的 A');
    pool.save(a);
    const b = await pool.open();
    assert.equal(existsSync(join(sessionDirectory(cwd, sessionsRoot), 'metadata', `${a.id}.json`)), false, 'settings and naming never write a blank index');
    assert.equal(existsSync(join(sessionDirectory(cwd, sessionsRoot), 'metadata', `${b.id}.json`)), false, 'opening a page never writes a blank index');
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.runtime, b.runtime);
    assert.equal(existsSync(a.runtime.session.sessionFile!), false, 'SDK still owns its empty-transcript policy');
    const rows = await pool.listSessions();
    assert.equal(rows.length, 1, 'only the real legacy conversation belongs in history');
    assert.equal(rows.filter((row) => row.id === legacy.getSessionId()).length, 1);
    assert.equal(rows.some((row) => row.id === external.getSessionId()), false);
    assert.equal(await pool.openSession(a.id), a, 'switching to an open agent reuses its runtime');

    const liveOther = await pool.open({ ...options, cwd: other });
    assert.equal((await pool.listSessions(cwd)).some((row) => row.id === liveOther.id), false);
    await pool.submit(liveOther.id, 'A submitted question, even without a configured model.');
    assert.ok((await pool.listSessions(cwd)).some((row) => row.id === liveOther.id));
    await pool.close(liveOther.id);
    assert.equal((await pool.listSessions(cwd)).some((row) => row.id === liveOther.id), false);
    await pool.dispose();

    // Older versions persisted blank indexes. Hide these without deleting them.
    const oldIndex = join(sessionDirectory(cwd, sessionsRoot), 'metadata', `${a.id}.json`);
    mkdirSync(join(sessionDirectory(cwd, sessionsRoot), 'metadata'), { recursive: true });
    writeFileSync(oldIndex, JSON.stringify(a.saved));
    const originalIndex = readFileSync(oldIndex, 'utf8');

    pool = new SessionPool(options, factory, sessionsRoot);
    assert.equal((await pool.catalog.list(cwd)).length, 1);
    await assert.rejects(pool.openSession(a.id, cwd), /不存在/);
    await assert.rejects(pool.openSession(b.id, cwd), /不存在/);
    const continuedLegacy = await pool.open({ ...options, continue: true });
    assert.equal(continuedLegacy.id, legacy.getSessionId(), '--continue ignores older blank metadata');
    assert.equal(readFileSync(oldIndex, 'utf8'), originalIndex, 'hidden legacy indexes are preserved');
    const restoredLegacy = await pool.openSession(legacy.getSessionId(), cwd);
    assert.equal(restoredLegacy.runtime.session.messages.filter((message) => message.role === 'user').length, 3);
    assert.equal(restoredLegacy.saved.title, 'first task');
    assert.equal(restoredLegacy.saved.name, '原有会话');
    assert.equal(restoreMode(restoredLegacy.runtime.session.sessionManager.getBranch()), 'execute');
    await pool.close(restoredLegacy.id);
    // A missing transcript must not silently turn into an empty replacement.
    unlinkSync(legacy.getSessionFile()!);
    await assert.rejects(pool.openSession(legacy.getSessionId(), cwd), /记录文件已不存在/);
    const failed = await pool.open();
    await pool.submit(failed.id, 'Keep this first question when model preflight fails.');
    assert.equal(failed.saved.hasConversation, true);
    assert.equal(failed.state, 'error');
    await pool.dispose();

    pool = new SessionPool(options, factory, sessionsRoot);
    const continued = await pool.open({ ...options, continue: true });
    assert.equal(continued.id, failed.id, 'a submitted failed question is a real conversation');
    assert.equal(continued.runtime.session.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(continued.runtime.session.messages.some((message) => message.role === 'assistant'), false);
    const emptyProject = join(root, 'empty-project'); mkdirSync(emptyProject);
    const assistantOnly = SessionManager.create(emptyProject, sessionDirectory(emptyProject, sessionsRoot));
    assistantOnly.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'An old assistant-only record.' }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const blankContinue = await pool.open({ ...options, cwd: emptyProject, continue: true });
    assert.notEqual(blankContinue.id, assistantOnly.getSessionId(), 'no-history continue must not fall back to an assistant-only SDK file');
    assert.equal(blankContinue.saved.hasConversation, false);
    assert.equal((await pool.catalog.list(emptyProject)).length, 0);
    await pool.close(blankContinue.id);
    assert.equal(existsSync(assistantOnly.getSessionFile()!), true, 'old hidden transcripts are not deleted');
  } finally {
    await pool.dispose();
  }
});
