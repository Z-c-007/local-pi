import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MemoryQueue, memorySources, redactMemoryText, type MemorySource, type MemoryPolicy } from '../src/agent/memory-queue.ts';
import { validateMemoryPlan, type ExtractionInput } from '../src/agent/memory-extractor.ts';

const policy: MemoryPolicy = { enabled: true, turns: 20, tokens: 8000, idleMs: 600_000 };
const sources = (count: number, prefix = 'a'): MemorySource[] => Array.from({ length: count }, (_, i) => [
  { id: `${prefix}-u${i}`, role: 'user' as const, text: `用户偏好 ${prefix}-${i}`, time: i + 1 },
  { id: `${prefix}-a${i}`, role: 'assistant' as const, text: '已了解。', time: i + 1 },
]).flat();
const queue = () => new MemoryQueue(mkdtempSync(join(tmpdir(), 'local-pi-memory-queue-')));

test('counts new user turns per session, never aggregates unrelated sessions to reach twenty', () => {
  const q = queue(); q.observe('p', 'a', [], 'test/model', 0); q.observe('p', 'b', [], 'test/model', 0);
  q.observe('p', 'a', sources(10), 'test/model', 1); q.observe('p', 'b', sources(10, 'b'), 'test/model', 1);
  assert.equal(q.seal('p', policy, 2), 0);
  q.observe('p', 'a', sources(20), 'test/model', 3);
  assert.equal(q.seal('p', policy, 4), 1);
  const batch = q.claim('p', 4)!; assert.equal(batch.session, 'a');
  assert.equal(batch.sources.filter((source) => source.role === 'user').length, 20);
  assert.ok(batch.sources.every((source) => !source.id.startsWith('b')));
  q.finish(batch, 'done'); assert.equal(q.seal('p', policy, 5), 0);
  assert.equal(q.status('p').pendingTurns, 10);
  const db = new DatabaseSync(q.path);
  assert.equal((db.prepare("SELECT count(*) n FROM sources WHERE project='p' AND session='a' AND data!=''").get() as { n: number }).n, 4);
  assert.equal((db.prepare('SELECT payload FROM jobs WHERE id=?').get(batch.id) as { payload: string }).payload, '[]'); db.close();
});

test('idle/token boundaries, active-task guards, and closing one session do not flush another', () => {
  const q = queue(); q.observe('p', 'a', [], 'test/model', 0); q.observe('p', 'b', [], 'test/model', 0);
  q.observe('p', 'a', sources(1), 'test/model', 100); q.observe('p', 'b', sources(1, 'b'), 'test/model', 100);
  assert.equal(q.seal('p', policy, 599_999), 0);
  q.touch('p', 'a', 100, true);
  assert.equal(q.seal('p', policy, 600_100), 1, 'only idle B is sealed');
  assert.equal(q.claim('p', 600_100)!.session, 'b');
  assert.equal(q.seal('p', policy, 600_100, 'a'), 1, 'explicit close persists A without waiting for idle');
  const q2 = queue(); q2.observe('p', 's', [], 'test/model', 0);
  q2.observe('p', 's', [{ id: 'long', role: 'user', text: '测试'.repeat(100), time: 1 }], 'test/model', 1);
  assert.equal(q2.seal('p', { ...policy, tokens: 128 }, 2), 1);
});

test('first activation skips historical entries; fork clones do not double-capture shared entries', () => {
  const q = queue(); const old = sources(2, 'old');
  q.observe('p', 'a', old, 'test/model', 0);
  assert.equal(q.status('p').pendingTurns, 0);
  const fresh = sources(2, 'fresh');
  // Child baseline observes a parent's uncollected entries without consuming them globally.
  q.observe('p', 'child', [...old, ...fresh], 'test/model', 1);
  q.observe('p', 'a', [...old, ...fresh], 'test/model', 1);
  q.observe('p', 'child', [...old, ...fresh, ...sources(1, 'child')], 'test/model', 2);
  assert.equal(q.status('p').pendingTurns, 3);
  q.observe('p', 'a', [...old, ...fresh], 'test/model', 3);
  assert.equal(q.status('p').pendingTurns, 3);
});

test('durable claims recover dead owners, reject stale completion, and retry with stable batches', () => {
  const q = queue(); q.observe('p', 'a', [], 'test/model', 0); q.observe('p', 'a', sources(1), 'test/model', 1);
  q.seal('p', policy, 2, 'a'); const first = q.claim('p', 2)!;
  q.plan(first, '[]'); assert.equal(q.claim('p', 3), undefined, 'live worker retains its lease');
  const db = new DatabaseSync(q.path); db.prepare('UPDATE jobs SET pid=? WHERE id=?').run(2147483647, first.id); db.close();
  const reopened = new MemoryQueue(join(q.path, '..')); const second = reopened.claim('p', 4)!;
  assert.equal(first.id, second.id); assert.equal(second.plan, '[]');
  assert.throws(() => q.finish(first, 'stale'), /所有权/);
  reopened.fail(second, 4); assert.equal(reopened.claim('p', 5), undefined);
  reopened.observe('p', 'a', [...sources(1), ...sources(1, 'later')], 'test/model', 6);
  reopened.seal('p', policy, 6, 'a');
  assert.equal(reopened.claim('p', 7), undefined, 'a later job cannot overtake an older batch in retry backoff');
  reopened.retry('p'); const third = reopened.claim('p', 5)!;
  assert.equal(third.id, first.id); assert.equal(third.plan, undefined);
  reopened.finish(third, 'zero facts'); assert.equal(q.status('p').pendingTurns, 1);
  reopened.finish(reopened.claim('p', 8)!, 'later done'); assert.equal(q.status('p').pendingTurns, 0);
});

test('pause excludes disabled-period messages without discarding previously pending batches', () => {
  const q = queue(); q.observe('p', 's', [], 'test/model', 0); q.observe('p', 's', sources(1), 'test/model', 1);
  q.pause('p', true); q.observe('p', 's', [...sources(1), ...sources(1, 'off')], 'test/model', 2);
  assert.equal(q.seal('p', policy, 900_000, 's'), 0);
  q.pause('p', false); q.observe('p', 's', [...sources(1), ...sources(1, 'off'), ...sources(1, 'on')], 'test/model', 3);
  assert.equal(q.status('p').pendingTurns, 2);
});

test('capture excludes thinking, images, code blocks and failures; only bounded verified commands are retained', () => {
  const raw: any[] = [
    { id: '1', type: 'message', timestamp: '2026-11-03T00:00:00Z', message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: '所有项目都用中文说明。\n```ts\nprivate file\n```\napi_key=sk-abcdef012345678901' }, { type: 'image', data: 'secretimage' }] } },
    { id: '2', type: 'message', message: { role: 'assistant', timestamp: 2, stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'toolCall', id: 'tool1', arguments: { command: 'npm test' } }] } },
    { id: '3', type: 'message', message: { role: 'toolResult', timestamp: 3, toolCallId: 'tool1', isError: false, details: { exitCode: 0 }, content: [{ type: 'text', text: 'FULL FILE OUTPUT' }] } },
    { id: '4', type: 'message', message: { role: 'assistant', timestamp: 4, stopReason: 'error', content: [{ type: 'text', text: 'failed incomplete answer' }] } },
  ];
  const result = memorySources(raw); const serialized = JSON.stringify(result);
  assert.equal(result.filter((source) => source.role === 'user').length, 1);
  assert.ok(result.some((source) => source.role === 'verification'));
  for (const secret of ['private thought', 'private file', 'secretimage', 'FULL FILE OUTPUT', 'failed incomplete', 'sk-abcdef']) assert.ok(!serialized.includes(secret));
  assert.match(redactMemoryText('Authorization: Bearer abcdef0123456789'), /凭证已省略/);
});

test('extraction validates evidence, enforces global scope, constrains correction targets and accepts empty results', () => {
  const source: MemorySource = { id: 'user', role: 'user', text: '这个项目默认 npm。所有项目都用中文说明。忘记旧的记忆。', time: 1 };
  const input: ExtractionInput = { batch: { id: 'batch', project: 'p', session: 's', model: 'p/m', sources: [source], context: [], created: 1, attempts: 1 },
    existing: [{ id: 'old', scope: 'project', memory: '旧事实' }] };
  const plan = (action: any) => JSON.stringify({ actions: [action] });
  const action = { kind: 'add', scope: 'global', text: '默认 npm', evidence: [{ id: 'user', quote: '这个项目默认 npm' }] };
  assert.equal(validateMemoryPlan(plan(action), input)[0]!.scope, 'project');
  assert.equal(validateMemoryPlan(plan({ ...action, text: '中文说明', evidence: [{ id: 'user', quote: '所有项目都用中文说明' }] }), input)[0]!.scope, 'global');
  assert.throws(() => validateMemoryPlan(plan({ ...action, evidence: [{ id: 'user', quote: '不存在的原话' }] }), input), /证据/);
  assert.throws(() => validateMemoryPlan(plan({ ...action, kind: 'replace', scope: 'project', targetId: 'other-project' }), input), /范围/);
  assert.throws(() => validateMemoryPlan(plan({ ...action, kind: 'forget', scope: 'project', targetId: 'old' }), input), /明确要求/);
  const replacement = validateMemoryPlan(plan({ ...action, kind: 'replace', scope: 'project', targetId: 'old' }), input)[0]!;
  assert.equal(replacement.expectedText, '旧事实');
  assert.deepEqual(validateMemoryPlan('{"actions":[]}', input), []);
});
