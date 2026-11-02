import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { SessionPool, type SessionSlot } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { WorkspaceCoordinator } from '../src/agent/workspace-coordinator.ts';
import { OperationStore } from '../src/agent/operation-store.ts';
import { WorkspaceOperations } from '../src/agent/workspace-operations.ts';
import { parseOptions } from '../src/cli.ts';
import { until } from './helpers/terminal.ts';

const answer = (call?: { name: string; arguments: unknown }, id = 'call'): any => ({ role: 'assistant',
  content: call ? [{ type: 'toolCall', id, ...call }] : [{ type: 'text', text: 'done' }],
  api: 'openai-completions', provider: 'concurrency-fixture', model: 'fixture', stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const write = (path: string, content: string) => ({ name: 'write', arguments: { path, content } });
const read = (path: string) => ({ name: 'read', arguments: { path } });
const edit = (path: string, oldText: string, newText: string) => ({ name: 'edit', arguments: { path, edits: [{ oldText, newText }] } });
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }
function script(slot: SessionSlot, calls: Array<ReturnType<typeof write> | ReturnType<typeof read> | ReturnType<typeof edit> | { name: string; arguments: unknown }>, hold?: { round: number; gate: ReturnType<typeof gate>; arrived: () => void }) {
  let round = 0;
  slot.runtime.session.agent.streamFunction = (_m, _c, options) => {
    const stream = createAssistantMessageEventStream(); const current = round++;
    const send = () => {
      const message = answer(calls[current], `call-${current}`);
      stream.push({ type: 'done', reason: message.stopReason, message });
    };
    if (current === hold?.round) {
      hold.arrived();
      options?.signal?.addEventListener('abort', () => hold.gate.release(), { once: true });
      void hold.gate.promise.then(send);
    } else queueMicrotask(send);
    return stream;
  };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-concurrent-')); const cwd = join(root, 'project'); const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir);
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  models.registerProvider('concurrency-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture',
    models: [{ id: 'fixture', name: 'fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'concurrency-fixture/fixture']);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }) }), join(root, 'sessions'));
  const a = await pool.open(); const b = await pool.open(); await pool.submit(a.id, '/execute'); await pool.submit(b.id, '/execute');
  return { pool, a, b, cwd, root };
}

test('same-directory agents overlap; operation-owned diffs and revisions preserve other chat undo, even when A finishes last', { timeout: 20000 }, async () => {
  const { pool, a, b, cwd } = await fixture(); const hold = gate(); let arrived = false;
  writeFileSync(join(cwd, 'huge.pdf'), Buffer.alloc(2 * 1024 * 1024 + 1));
  try {
    script(a, [write('a.txt', 'A')], { round: 1, gate: hold, arrived: () => { arrived = true; } });
    const taskA = pool.submit(a.id, 'A own change'); await until(() => arrived);
    script(b, [write('b.txt', 'B')]); await pool.submit(b.id, 'B own change');
    assert.ok(a.task, 'B must complete while A is still running'); assert.equal(a.state, 'running');
    hold.release(); await taskA;
    const reportA = a.fileChanges.at(-1)!; const reportB = b.fileChanges.at(-1)!;
    assert.deepEqual(reportA.changes.map((c) => c.path), ['a.txt']); assert.deepEqual(reportB.changes.map((c) => c.path), ['b.txt']);
    assert.ok(reportA.observedChanges?.some((c) => c.path === 'b.txt'));
    assert.deepEqual(reportA.issues, []); assert.ok(reportA.observationIssues?.some((issue) => issue.includes('2 MiB')));
    assert.ok(reportA.changes[0]!.revision! < reportB.changes[0]!.revision!, 'finish order must not overwrite operation order');
    await pool.applyRestore(a.id, await pool.restorePlan(a.id, reportA.id, 'undo'));
    assert.equal(readFileSync(join(cwd, 'b.txt'), 'utf8'), 'B'); assert.equal(existsSync(join(cwd, 'a.txt')), false);
    assert.deepEqual((await pool.restorePlan(b.id, reportB.id, 'undo')).conflicts, []);
    await pool.applyRestore(b.id, await pool.restorePlan(b.id, reportB.id, 'undo'));
    const operations = pool.operations.list().filter((op) => op.kind === 'file');
    assert.equal(operations.length, 2); assert.ok(operations.every((op) => op.status === 'completed' && op.reportId && op.revision));
    assert.ok(existsSync(join(pool.operations.root, 'operations.sqlite')));
  } finally { hold.release(); await pool.dispose(); }
});

test('stale same-file overwrite is rejected; reread permits a fresh edit, and undo A keeps B bytes', { timeout: 20000 }, async () => {
  const { pool, a, b, cwd } = await fixture(); writeFileSync(join(cwd, 'shared.txt'), 'BASE'); const hold = gate(); let arrived = false;
  try {
    script(a, [read('shared.txt'), write('shared.txt', 'STALE_A'), read('shared.txt'), edit('shared.txt', 'B', 'B\nA')],
      { round: 1, gate: hold, arrived: () => { arrived = true; } });
    const taskA = pool.submit(a.id, 'Read then update'); await until(() => arrived);
    script(b, [edit('shared.txt', 'BASE', 'B')]); await pool.submit(b.id, 'B first update');
    assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'B'); hold.release(); await taskA;
    assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'B\nA');
    assert.ok(a.runtime.session.messages.some((message) => message.role === 'toolResult' && JSON.stringify(message.content).includes('版本已过期')));
    assert.equal(pool.operations.list().filter((op) => op.tool === 'write').at(-1)?.status, 'failed');
    const reportA = a.fileChanges.at(-1)!; const reportB = b.fileChanges.at(-1)!;
    assert.ok(reportA.changes.every((change) => change.attribution === 'tool'));
    assert.ok((await pool.restorePlan(b.id, reportB.id, 'undo')).conflicts.length, 'B cannot remove newer A edits');
    await pool.applyRestore(a.id, await pool.restorePlan(a.id, reportA.id, 'undo'));
    assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'B');
    // Reopen must retain the old read/write version receipt, not trust stale history.
    const id = b.id; await pool.close(id); const reopened = await pool.openSession(id, cwd);
    script(reopened, [write('shared.txt', 'STALE_AFTER_REOPEN')]); await pool.submit(id, 'Old context');
    assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'B');
    assert.ok(reopened.runtime.session.messages.some((message) => message.role === 'toolResult' && JSON.stringify(message.content).includes('版本已过期')));
  } finally { hold.release(); await pool.dispose(); }
});

test('same-file queue waits with owner, other files progress, and cancelling A preserves B wait and SDK native renderer', { timeout: 20000 }, async () => {
  const { pool, a, b, cwd } = await fixture(); let lease: string | undefined;
  try {
    lease = await pool.coordinator.wait(cwd, 'write', 'external-holder', { path: join(cwd, 'shared.txt') });
    script(a, [write('shared.txt', 'A')]); script(b, [write('shared.txt', 'B')]);
    const taskA = pool.submit(a.id, 'A waiting'); const taskB = pool.submit(b.id, 'B waiting');
    await until(() => !!a.waitingOperations?.size && !!b.waitingOperations?.size);
    assert.match([...a.waitingOperations!.values()].join(), /external.*shared.txt/);
    const c = await pool.open(); await pool.submit(c.id, '/execute'); script(c, [write('other.txt', '')]); await pool.submit(c.id, 'Independent file');
    assert.equal(readFileSync(join(cwd, 'other.txt'), 'utf8'), ''); assert.ok(a.task && b.task);
    await pool.abort(a.id); await taskA; assert.ok(b.task && b.waitingOperations?.size); assert.equal(existsSync(join(cwd, 'shared.txt')), false);
    await pool.coordinator.release(lease); lease = undefined; await taskB;
    assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'B'); assert.equal(a.waitingOperations?.size, 0);
    assert.ok(b.runtime.session.getToolDefinition('write')?.renderResult, 'native rendering must be retained');
    assert.ok(b.runtime.session.getToolDefinition('edit')?.prepareArguments, 'native compatibility shim must be retained');
  } finally { if (lease) await pool.coordinator.release(lease); await pool.dispose(); }
});

test('codemode nested native writes share workspace lease without deadlock and retain individual ownership', { timeout: 20000 }, async () => {
  const { pool, a, cwd } = await fixture();
  try {
    // Native MCP normally activates this; explicitly select the registered native tool for this fixture.
    a.runtime.session.setActiveToolsByName([...a.runtime.session.getActiveToolNames(), 'codemode']);
    script(a, [{ name: 'codemode', arguments: { code: 'text(await tools.write({path:"nested.txt",content:"NESTED"})); text(await tools.read({path:"nested.txt"})); await Promise.all([tools.write({path:"same.txt",content:"ONE"}),tools.write({path:"same.txt",content:"TWO"}),tools.write({path:"other.txt",content:"OTHER"})]);' } }]);
    await pool.submit(a.id, 'Nested write');
    assert.equal(readFileSync(join(cwd, 'nested.txt'), 'utf8'), 'NESTED');
    assert.ok(a.fileChanges.at(-1)?.changes.some((change) => change.path === 'nested.txt' && change.attribution === 'tool'));
    assert.ok(a.fileChanges.at(-1)?.changes.every((change) => change.attribution === 'tool'));
    const same = pool.operations.list().filter((op) => op.path?.endsWith('same.txt'));
    assert.equal(same.length, 2); assert.ok(same.every((op) => op.status === 'completed'));
    assert.equal(same[0]!.after?.hash, same[1]!.before?.hash, 'parallel calls must form one serialized mutation chain');
    assert.equal(createHash('sha256').update(readFileSync(join(cwd, 'same.txt'))).digest('hex'), same[1]!.after?.hash);
    assert.equal(readFileSync(join(cwd, 'other.txt'), 'utf8'), 'OTHER');
    assert.ok(pool.operations.list().some((op) => op.tool === 'codemode' && op.status === 'completed'));
    assert.deepEqual(await pool.coordinator.pendingFor(cwd), []);
  } finally { await pool.dispose(); }
});

test('nested file leases bypass an outsider waiting on their parent; sibling same-file calls still serialize', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-lock-tree-')); const coordinator = new WorkspaceCoordinator(root);
  const parent = await coordinator.wait(root, 'write', 'parent'); const controller = new AbortController();
  let outsiderWaiting = false; let outsider: string | undefined; let first: string | undefined; let second: string | undefined;
  const outside = coordinator.wait(root, 'write', 'outsider', { signal: controller.signal, onWait: () => { outsiderWaiting = true; } }).then((id) => { outsider = id; });
  try {
    await until(() => outsiderWaiting);
    first = await coordinator.wait(root, 'write', 'parent', { path: join(root, 'file'), inherited: [parent] });
    let siblingWaiting = false;
    const sibling = coordinator.wait(root, 'write', 'parent', { path: join(root, 'file'), inherited: [parent], onWait: () => { siblingWaiting = true; } });
    await until(() => siblingWaiting); assert.equal(outsider, undefined);
    const different = await coordinator.wait(root, 'write', 'parent', { path: join(root, 'different'), inherited: [parent] }); await coordinator.release(different);
    await coordinator.release(first); first = undefined; second = await sibling;
    await coordinator.release(second); second = undefined; await coordinator.release(parent); await outside;
    assert.ok(outsider); await coordinator.release(outsider); outsider = undefined;
  } finally {
    controller.abort(); await outside.catch(() => {});
    for (const id of [first, second, outsider, parent]) if (id) await coordinator.release(id);
  }
});

test('native path spelling, new directories and larger writes retain tool behavior; shell completion requires fresh versions', { timeout: 20000 }, async () => {
  const { pool, a, cwd } = await fixture(); writeFileSync(join(cwd, 'MixedCase.TXT'), 'OLD');
  try {
    script(a, [edit('@MixedCase.TXT', 'OLD', 'NEW'), write('NewFolder/NewFile.TXT', 'NEW'), write('large.txt', 'X'.repeat(2 * 1024 * 1024 + 1))]);
    await pool.submit(a.id, 'Native paths and limits');
    assert.equal(readFileSync(join(cwd, 'MixedCase.TXT'), 'utf8'), 'NEW'); assert.equal(readFileSync(join(cwd, 'NewFolder/NewFile.TXT'), 'utf8'), 'NEW');
    assert.equal(readFileSync(join(cwd, 'large.txt')).length, 2 * 1024 * 1024 + 1);
    assert.ok(a.fileChanges.at(-1)?.changes.some((change) => change.path === 'MixedCase.TXT'));
    assert.ok(a.fileChanges.at(-1)?.changes.some((change) => change.path === 'NewFolder/NewFile.TXT'));
    assert.ok(a.fileChanges.at(-1)?.changes.find((change) => change.path === 'large.txt')?.note?.includes('2 MiB'));
    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    script(a, [read('MixedCase.TXT'), { name: shell, arguments: { command: 'echo DONE' } }, write('MixedCase.TXT', 'STALE'),
      write('brand-new.txt', 'ALLOWED'), read('MixedCase.TXT'), edit('MixedCase.TXT', 'NEW', 'FRESH')]);
    await pool.submit(a.id, 'Shell invalidation');
    assert.equal(readFileSync(join(cwd, 'MixedCase.TXT'), 'utf8'), 'FRESH'); assert.equal(readFileSync(join(cwd, 'brand-new.txt'), 'utf8'), 'ALLOWED');
    assert.ok(a.runtime.session.messages.some((message) => message.role === 'toolResult' && JSON.stringify(message.content).includes('版本已过期')));
    assert.deepEqual(await pool.coordinator.pendingFor(cwd), []);
  } finally { await pool.dispose(); }
});

test('cross-process queued mutation refuses an interrupted operation; SQLite backup and explicit acknowledgement survive process death', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-crash-')); const cwd = join(root, 'project'); mkdirSync(cwd); writeFileSync(join(cwd, 'shared.txt'), 'BEFORE');
  const coordinator = new WorkspaceCoordinator(root); const store = new OperationStore(root); const host = new WorkspaceOperations(store, coordinator);
  const moduleUrl = (name: string) => new URL(`../src/agent/${name}.ts`, import.meta.url).href;
  const childCode = `
    import {WorkspaceCoordinator} from ${JSON.stringify(moduleUrl('workspace-coordinator'))};
    import {OperationStore} from ${JSON.stringify(moduleUrl('operation-store'))};
    import {fileState} from ${JSON.stringify(moduleUrl('file-state'))};
    import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
    const [root,cwd]=process.argv.slice(1); const coordinator=new WorkspaceCoordinator(root); const store=new OperationStore(root);
    await coordinator.wait(cwd,'write','child-session',{path:join(cwd,'shared.txt')});
    const before=await fileState(cwd,'shared.txt'); await store.backup(before.bytes);
    const operation=store.begin({sessionId:'child-session',toolCallId:'interrupted',tool:'write',cwd,path:join(cwd,'shared.txt'),kind:'file',before:before.state});
    await writeFile(join(cwd,'shared.txt'),'CHILD_WRITE'); process.stdout.write(operation.id+'\\n'); setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, root, cwd], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await until(() => output.includes('\n') || child.exitCode !== null, 'child durable operation'); assert.ok(output.includes('\n'), errors);
    let waiting = false; let executed = false;
    const operation = host.run({ cwd, sessionId: 'parent-session', toolName: 'write', toolCallId: 'queued', input: { path: 'shared.txt', content: 'NEVER' },
      onWait: (owner) => { if (owner) waiting = true; } }, async () => { executed = true; });
    const rejected = assert.rejects(operation, /未确认|recovery/); await until(() => waiting);
    const other = await coordinator.wait(cwd, 'write', 'different-file', { path: join(cwd, 'other.txt') }); await coordinator.release(other);
    const exited = once(child, 'exit'); child.kill(); await exited; await rejected;
    assert.equal(executed, false); assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'CHILD_WRITE');
    const uncertain = store.uncertain(cwd); assert.equal(uncertain.length, 1); const interrupted = uncertain[0]!;
    assert.equal(readFileSync(join(store.root, 'blobs', interrupted.before!.hash!), 'utf8'), 'BEFORE');
    assert.ok((await coordinator.pendingFor(cwd)).some((item) => item.id === interrupted.id));
    await store.acknowledge(interrupted.id, cwd, coordinator);
    assert.deepEqual(await coordinator.pendingFor(cwd), []); assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'CHILD_WRITE');
    assert.equal(store.list().find((op) => op.id === interrupted.id)?.status, 'acknowledged');
    const fresh = await coordinator.wait(cwd, 'write', 'parent-session', { path: join(cwd, 'shared.txt') }); await coordinator.release(fresh);
  } finally { if (child.exitCode === null) child.kill(); store.close(); }
});

test('concurrent identical byte backups publish complete immutable blobs, and corruption fails closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-blob-race-')); const a = new OperationStore(root); const b = new OperationStore(root);
  const bytes = Buffer.alloc(256 * 1024, 'A'); const hash = createHash('sha256').update(bytes).digest('hex');
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).backup(bytes)));
    const blob = join(a.root, 'blobs', hash); assert.deepEqual(readFileSync(blob), bytes); assert.equal(statSync(blob).nlink, 1);
    assert.deepEqual(readdirSync(join(a.root, 'blobs')), [hash]);
    writeFileSync(blob, 'CORRUPT'); await assert.rejects(a.backup(bytes), /校验失败/);
    assert.equal(readFileSync(blob, 'utf8'), 'CORRUPT', 'corruption is not silently replaced');
  } finally { a.close(); b.close(); }
});

test('a process killed while holding the coordination mutex is reclaimed safely by concurrent contenders', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-mutex-crash-'));
  const moduleUrl = new URL('../src/agent/workspace-coordinator.ts', import.meta.url).href;
  const code = `import {WorkspaceCoordinator} from ${JSON.stringify(moduleUrl)};
    const coordinator=new WorkspaceCoordinator(process.argv[1]);
    await coordinator.critical(async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>{setInterval(()=>{},1000)});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await until(() => output.includes('LOCKED') || child.exitCode !== null, 'child mutex'); assert.match(output, /LOCKED/, errors);
    const exited = once(child, 'exit'); child.kill(); await exited;
    const contenders = Array.from({ length: 4 }, () => new WorkspaceCoordinator(root));
    const leases = await Promise.all(contenders.map((coordinator, index) => coordinator.wait(root, 'write', `contender-${index}`, { path: join(root, `file-${index}`) })));
    assert.equal(new Set(leases).size, 4);
    await Promise.all(contenders.map((coordinator, index) => coordinator.release(leases[index]!)));
    assert.equal(existsSync(join(root, 'workspace-coordination', 'mutex')), false);
    assert.ok(existsSync(join(root, 'workspace-coordination', 'mutex-recovery.sqlite')));
  } finally { if (child.exitCode === null) child.kill(); }
});
