import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/agent/operation-store.ts';
import { takeOperationSnapshot, snapshotState, snapshotChanges } from '../src/agent/operation-snapshot.ts';
import { sameState } from '../src/agent/file-state.ts';
import { WorkspaceCoordinator } from '../src/agent/workspace-coordinator.ts';
import { WorkspaceOperations } from '../src/agent/workspace-operations.ts';

test('focused snapshots cover script output in a bounded large tree; an unscanned file is never mistaken for an addition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-focused-')); const cwd = join(root, 'workspace'); const focus = join(cwd, 'slow_notes');
  mkdirSync(focus, { recursive: true }); mkdirSync(join(cwd, 'BackEnd'));
  for (let index = 0; index < 30; index++) writeFileSync(join(cwd, 'BackEnd', `file-${index}.txt`), 'BACKEND');
  const script = join(focus, 'script.cjs'); writeFileSync(script, 'SCRIPT'); writeFileSync(join(cwd, 'huge.pdf'), Buffer.alloc(2048));
  const store = new OperationStore(join(root, 'history'));
  const options = { tracked: [script, ...Array.from({ length: 30 }, (_, index) => join(cwd, 'BackEnd', `file-${index}.txt`))], priority: [script], focus: [focus], limits: { files: 8, bytes: 512, fileBytes: 1024 } };
  try {
    const before = await takeOperationSnapshot(cwd, store, options);
    assert.ok(Object.keys(before.files).length <= 8, 'the tracked-file registry cannot bypass snapshot limits');
    assert.equal(snapshotState(before, join(focus, 'notes.txt')).known, true); assert.equal(snapshotState(before, join(focus, 'notes.txt')).state, undefined);
    assert.equal(snapshotState(before, join(cwd, 'BackEnd/file-29.txt')).known, false);
    writeFileSync(join(focus, 'notes.txt'), 'NOTES'); writeFileSync(join(cwd, 'BackEnd/file-29.txt'), 'LATER');
    const after = await takeOperationSnapshot(cwd, store, { ...options, baseline: before });
    assert.deepEqual(snapshotChanges(before, after).map((change) => change.path), [join(focus, 'notes.txt')]);
    assert.ok(sameState(snapshotState(before, script).state, snapshotState(after, script).state));
    const hash = await store.archiveSnapshot(before); assert.deepEqual(await store.loadSnapshot(hash), JSON.parse(JSON.stringify(before)));
  } finally { store.close(); }
});

test('failure to finalize a completed script keeps its before/after backups and enters recovery instead of leaving a live prepared operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-footprint-failure-')); const cwd = join(root, 'workspace'); mkdirSync(cwd);
  writeFileSync(join(cwd, 'file.txt'), 'BEFORE');
  const store = new OperationStore(join(root, 'history')); const coordinator = new WorkspaceCoordinator(join(root, 'history'));
  const host = new WorkspaceOperations(store, coordinator); const record = coordinator.record.bind(coordinator);
  coordinator.record = async (...args: Parameters<WorkspaceCoordinator['record']>) => {
    if (args[2].startsWith('finished potential')) throw new Error('SIMULATED_EVENT_DISK_FAILURE');
    return record(...args);
  };
  try {
    await assert.rejects(host.run({ cwd, sessionId: 'test', toolName: 'opaque', toolCallId: 'failure', input: {}, onWait() {} }, async () => {
      writeFileSync(join(cwd, 'file.txt'), 'AFTER');
    }), /recovery/);
    const operation = store.list().at(-1)!; assert.equal(operation.status, 'uncertain');
    assert.ok(operation.footprint?.before && operation.footprint.after);
    assert.ok((await coordinator.pendingFor(cwd)).some((entry) => entry.id === operation.id));
    const before = await store.loadSnapshot(operation.footprint!.before!); const after = await store.loadSnapshot(operation.footprint!.after!);
    assert.notEqual(snapshotState(before, join(cwd, 'file.txt')).state?.hash, snapshotState(after, join(cwd, 'file.txt')).state?.hash);
    await store.acknowledge(operation.id, cwd, coordinator); assert.deepEqual(await coordinator.pendingFor(cwd), []);
  } finally { store.close(); }
});
