import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { markdownBackend } from '../src/agent/markdown-memory.ts';
import { ProjectMemory, type MemoryBackend, type MemoryRecord } from '../src/agent/memory.ts';

function fixture(count = 0) {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-md-'));
  const rows = new Map<string, MemoryRecord>(); let serial = 0; let searches = 0;
  for (let i = 0; i < count; i++) rows.set(`legacy-${i}`, { id: `legacy-${i}`, memory: `旧记忆 ${i}`, metadata: { sourceSessionId: 'original' } });
  let beforeWrite: (() => void | Promise<void>) | undefined;
  const index: MemoryBackend = {
    async getAll() { return { results: [...rows.values()] }; },
    async get(id) { return rows.get(id) ?? null; },
    async add(messages, options) { await beforeWrite?.(); const id = `index-${serial++}`;
      rows.set(id, { id, memory: messages[0]!.content, metadata: options.metadata as Record<string, unknown> }); },
    async update(id, options) { await beforeWrite?.(); rows.set(id, { id, memory: options.text, metadata: options.metadata }); },
    async delete(id) { rows.delete(id); },
    async search() { searches++; return { results: [...rows.values()] }; },
  };
  return { root, rows, index, path: join(root, 'MEMORY.md'), searches: () => searches, beforeWrite: (fn?: () => void | Promise<void>) => { beforeWrite = fn; } };
}

test('legacy migration preserves over 100 entries, stable IDs and provenance; MD edits and index rebuild converge', async () => {
  const f = fixture(130); let store = await markdownBackend(f.root, f.index);
  assert.equal((await store.getAll({})).results.length, 130);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'legacy-before-markdown.json'), 'utf8')).length, 130);
  assert.match(readFileSync(f.path, 'utf8'), /旧记忆 129/);
  writeFileSync(f.path, readFileSync(f.path, 'utf8').replace('旧记忆 129', '手动修改为使用 npm').replace(/\n/g, '\r\n'));
  store = await markdownBackend(f.root, f.index);
  assert.equal((await store.get('legacy-129'))!.metadata!.source, 'markdown-edit');
  const result = await store.search('npm', {});
  assert.ok(result.results.some((record) => record.id === 'legacy-129' && record.memory.includes('npm')));
  const source = readFileSync(f.path, 'utf8');
  await store.reindex!(); assert.equal(readFileSync(f.path, 'utf8'), source);
  assert.equal((await store.getAll({})).results.length, 130);
  assert.ok(f.rows.size === 130);
});

test('deleting or emptying MD never resurrects database facts; plain Markdown can be written by hand', async () => {
  const f = fixture(2); await markdownBackend(f.root, f.index); unlinkSync(f.path);
  let store = await markdownBackend(f.root, f.index);
  assert.equal((await store.getAll({})).results.length, 0);
  assert.equal((await store.search('旧记忆', {})).results.length, 0); assert.equal(f.rows.size, 0);
  writeFileSync(f.path, '所有项目使用中文说明。\n\n当前项目使用 npm。\n');
  store = await markdownBackend(f.root, f.index);
  assert.equal((await store.getAll({})).results.length, 2);
  assert.equal((await store.search('npm', {})).results.length, 2);
  writeFileSync(f.path, ''); store = await markdownBackend(f.root, f.index);
  assert.equal((await store.search('npm', {})).results.length, 0);
});

test('a hand edit during an embedding write is preserved, and the uncommitted index row is repaired next lookup', async () => {
  const f = fixture(1); const store = await markdownBackend(f.root, f.index);
  const edited = readFileSync(f.path, 'utf8').replace('旧记忆 0', '用户正在手动编辑');
  f.beforeWrite(() => { writeFileSync(f.path, edited); });
  await assert.rejects(store.add([{ role: 'user', content: '后台新记忆' }], { infer: false, metadata: {} }), /已被手动/);
  assert.equal(readFileSync(f.path, 'utf8'), edited);
  f.beforeWrite(); const reopened = await markdownBackend(f.root, f.index);
  assert.deepEqual((await reopened.search('手动', {})).results.map((record) => record.memory), ['用户正在手动编辑']);
  assert.equal(f.rows.size, 1);
});

test('unmigrated writes from an old process are retained and block index cleanup', async () => {
  const f = fixture(1); const store = await markdownBackend(f.root, f.index);
  f.rows.set('old-process-new-fact', { id: 'old-process-new-fact', memory: '旧版本刚写入的内容', metadata: {} });
  await assert.rejects(store.search('内容', {}), /旧版本进程/);
  assert.ok(f.rows.has('old-process-new-fact'));
});

test('invalid markers, duplicate IDs, invalid UTF8 and hard links fail without rewriting user files', async () => {
  const f = fixture(1); await markdownBackend(f.root, f.index);
  const valid = readFileSync(f.path, 'utf8');
  for (const invalid of [valid + valid.slice(valid.indexOf('<!-- local-pi-entry')), valid.replace('"id":', 'BROKEN:'), Buffer.from([0xff, 0xfe])]) {
    writeFileSync(f.path, invalid);
    const before = readFileSync(f.path); await assert.rejects(markdownBackend(f.root, f.index));
    assert.deepEqual(readFileSync(f.path), before);
  }
  writeFileSync(f.path, valid); linkSync(f.path, join(f.root, 'alias.md'));
  await assert.rejects(markdownBackend(f.root, f.index), /独立普通文件/);
});

test('short memory is loaded in full without vector lookup; hand deletion prevents automatic resurrection across sessions', async () => {
  const f = fixture(); const agent = join(f.root, 'agent'); const project = join(f.root, 'project');
  mkdirSync(agent); mkdirSync(project);
  writeFileSync(join(agent, 'local-pi-memory.json'), JSON.stringify({ enabled: true,
    embedding: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'TEST_UNUSED', dimension: 3 } }));
  const memory = new ProjectMemory(agent, project, async () => f.index);
  // Separate stores are required for the two scopes, just as real SQLite stores are separate.
  const empty = fixture();
  const next = new ProjectMemory(agent, project, async (directory) => directory.endsWith('global') ? empty.index : f.index);
  try {
    await memory.add('project', '项目使用 npm。' + '这是需要完整保留的细节。'.repeat(100), 'a');
    const recalled = await next.recall('包管理器');
    assert.match(recalled, /这是需要完整保留的细节。/); assert.ok(recalled.length > 800); assert.equal(f.searches(), 0);
    writeFileSync(memory.markdownPath('project'), '');
    await next.apply({ kind: 'add', scope: 'project', text: '项目使用 npm。' + '这是需要完整保留的细节。'.repeat(100) }, 'old-batch', 'a', true);
    assert.equal((await next.list('project')).length, 0);
    assert.equal(readFileSync(memory.markdownPath('project'), 'utf8'), '');
  } finally { await memory.dispose(); await next.dispose(); }
});
