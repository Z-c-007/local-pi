import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ModelRuntime, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { ProjectMemory, type MemoryBackendFactory, type MemoryRecord } from '../src/agent/memory.ts';
import { AutomaticMemory, type MemorySnapshot } from '../src/agent/automatic-memory.ts';
import { validateMemoryPlan, type MemoryExtractor } from '../src/agent/memory-extractor.ts';
import { MemoryQueue } from '../src/agent/memory-queue.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { until } from './helpers/terminal.ts';

function fixture(automatic: Record<string, unknown> = { turnThreshold: 2 }) {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-auto-memory-')); const agent = join(root, 'agent');
  const a = join(root, 'a'); const b = join(root, 'b');
  for (const dir of [agent, a, b]) { mkdirSync(dir); if (dir !== agent) mkdirSync(join(dir, '.git')); }
  const configure = (baseURL = 'http://127.0.0.1:1/v1') => writeFileSync(join(agent, 'local-pi-memory.json'), JSON.stringify({
    enabled: true, embedding: { baseURL, model: 'fixture', apiKeyEnv: 'LOCAL_PI_AUTOMATIC_TEST_KEY', dimension: 3 }, automatic,
  }));
  configure(); const stores = new Map<string, Map<string, MemoryRecord>>(); let serial = 0; let failAfterWrite = false;
  const factory: MemoryBackendFactory = async (directory) => {
    const data = stores.get(directory) ?? new Map(); stores.set(directory, data);
    return {
      async add(messages, options) { const id = `fact-${++serial}`;
        data.set(id, { id, memory: messages[0]!.content, metadata: options.metadata as Record<string, unknown> });
        if (failAfterWrite) { failAfterWrite = false; throw new Error('simulated crash after vector commit'); }
      },
      async getAll(options) { return { results: [...data.values()].filter((record) => Object.entries(options.filters as Record<string, unknown>)
        .every(([key, value]) => key === 'user_id' || record.metadata?.[key] === value)) }; },
      async search() { return { results: [...data.values()].slice(0, 3) }; },
      async get(id) { return data.get(id) ?? null; },
      async delete(id) { data.delete(id); },
      async update(id, options) { data.set(id, { id, memory: options.text, metadata: options.metadata }); },
    };
  };
  return { root, agent, a, b, factory, configure, failWrite: () => { failAfterWrite = true; } };
}

function entries(turns: number): SessionEntry[] {
  return Array.from({ length: turns }, (_, i) => [
    { type: 'message', id: `u-${i}`, timestamp: new Date(i * 2 + 1).toISOString(), message: { role: 'user', timestamp: i * 2 + 1, content: `这个项目需要保留旧接口 ${i}。` } },
    { type: 'message', id: `a-${i}`, timestamp: new Date(i * 2 + 2).toISOString(), message: { role: 'assistant', timestamp: i * 2 + 2, stopReason: 'stop', content: [{ type: 'text', text: '已了解。' }] } },
  ]).flat() as SessionEntry[];
}
const snapshot = (turns: number, session = 'source'): MemorySnapshot => ({ session, model: 'fixture/model', entries: entries(turns) });
const extractor: MemoryExtractor = async (input) => {
  const source = input.batch.sources.find((item) => item.role === 'user')!;
  return validateMemoryPlan(JSON.stringify({ actions: [{ kind: 'add', scope: 'project', text: '项目保留旧接口。', evidence: [{ id: source.id, quote: source.text }] }] }), input);
};

test('automatic extraction batches per-session new turns and never becomes a coding turn', async () => {
  const f = fixture(); const memory = new ProjectMemory(f.agent, f.a, f.factory); let calls = 0; let now = 1;
  const auto = new AutomaticMemory(memory, { timers: false, now: () => now, extractor: async (...args) => { calls++; return extractor(...args); } });
  await auto.capture(snapshot(0), 'start'); await auto.capture(snapshot(1)); await auto.tick(); await auto.idle();
  assert.equal(calls, 0);
  now++; await auto.capture(snapshot(2)); await auto.tick(); await auto.idle();
  assert.equal(calls, 1); assert.equal((await memory.list('project')).length, 1);
  assert.equal((await memory.list('global')).length, 0);
  await auto.tick(); await auto.idle(); assert.equal(calls, 1, 'no new data, no request');
  await auto.stop(snapshot(2)); await memory.dispose();
});

test('enabling configuration mid-session retains the first new question without importing disabled history', async () => {
  const f = fixture({ turnThreshold: 1 });
  writeFileSync(join(f.agent, 'local-pi-memory.json'), '{"enabled":false}');
  const memory = new ProjectMemory(f.agent, f.a, f.factory); let captured: string[] = [];
  const auto = new AutomaticMemory(memory, { timers: false, extractor: async (input) => { captured = input.batch.sources.map((item) => item.id); return []; } });
  await auto.capture(snapshot(1), 'start'); f.configure();
  await auto.capture(snapshot(2), 'busy'); await auto.capture(snapshot(2), 'settled');
  await auto.tick(); await auto.idle();
  assert.equal(captured.length, 2, 'only the new user question and answer enter extraction');
  await auto.stop(); await memory.dispose();
});

test('idle flush handles short sessions; pause excludes new content while preserving existing pending work', async () => {
  const f = fixture({ turnThreshold: 20 }); const memory = new ProjectMemory(f.agent, f.a, f.factory); let now = 0; let calls = 0;
  const auto = new AutomaticMemory(memory, { timers: false, now: () => now, extractor: async (...args) => { calls++; return extractor(...args); } });
  await auto.capture(snapshot(0), 'start'); now = 1; await auto.capture(snapshot(1));
  now = 600_000; await auto.tick(); await auto.idle(); assert.equal(calls, 0);
  now = 600_001; await auto.tick(); await auto.idle(); assert.equal(calls, 1);
  await auto.enabled(false, snapshot(1)); await auto.capture(snapshot(2));
  await auto.enabled(true, snapshot(2)); await auto.tick(true); await auto.idle();
  assert.equal(calls, 1, 'disabled-period turn was not backfilled');
  await auto.stop(); await memory.dispose();
});

test('closing queues without model calls; a different project startup recovers into the original project', async () => {
  const f = fixture({ turnThreshold: 20 }); const a = new ProjectMemory(f.agent, f.a, f.factory); let calls = 0;
  const first = new AutomaticMemory(a, { timers: false, extractor: async (...args) => { calls++; return extractor(...args); } });
  await first.capture(snapshot(0, 'A'), 'start'); await first.capture(snapshot(1, 'A'));
  await first.stop(snapshot(1, 'A')); assert.equal(calls, 0); await a.dispose();
  const b = new ProjectMemory(f.agent, f.b, f.factory);
  const next = new AutomaticMemory(b, { timers: false, extractor: async (...args) => { calls++; assert.equal(args[0].batch.session, 'A'); return extractor(...args); } });
  await next.capture(snapshot(0, 'B'), 'start'); await next.tick(); await next.idle();
  assert.equal(calls, 1); assert.equal((await b.list('project')).length, 0);
  const reopened = new ProjectMemory(f.agent, f.a, f.factory); assert.equal((await reopened.list('project')).length, 1);
  await reopened.dispose(); await next.stop(); await b.dispose();
});

test('failure retries retain the same batch, use backoff, cap automatic attempts and expose sanitized status', async () => {
  const f = fixture({ turnThreshold: 1 }); const memory = new ProjectMemory(f.agent, f.a, f.factory); let now = 0; let calls = 0;
  const auto = new AutomaticMemory(memory, { timers: false, now: () => now, extractor: async () => {
    calls++; if (calls <= 3) throw new Error('Bearer SECRET'); return [];
  } });
  await auto.capture(snapshot(0), 'start'); await auto.capture(snapshot(1)); await auto.tick(); await auto.idle();
  await auto.tick(); await auto.idle(); assert.equal(calls, 1);
  now = 30_001; await auto.tick(); await auto.idle(); assert.equal(calls, 2);
  now = 90_002; await auto.tick(); await auto.idle(); assert.equal(calls, 3);
  assert.ok((await auto.status()).includes('failed')); assert.ok(!(await auto.status()).includes('SECRET'));
  now = 999_999; await auto.tick(); await auto.idle(); assert.equal(calls, 3);
  await auto.retry(); await auto.idle(); assert.equal(calls, 4);
  assert.ok((await auto.status()).includes('没有需要长期保存的信息'));
  await auto.stop(); await memory.dispose();
});

test('stop aborts extraction without waiting for its result, late output cannot mutate memory', async () => {
  const f = fixture({ turnThreshold: 1 }); const memory = new ProjectMemory(f.agent, f.a, f.factory);
  let release!: () => void; let entered = false;
  const held = new Promise<void>((done) => { release = done; });
  const auto = new AutomaticMemory(memory, { timers: false, extractor: async (...args) => { entered = true; await held; return extractor(...args); } });
  await auto.capture(snapshot(0), 'start'); await auto.capture(snapshot(1)); await auto.tick();
  await until(() => entered);
  await auto.stop(snapshot(1)); await auto.idle(); release();
  await new Promise((done) => setTimeout(done, 50));
  assert.equal((await memory.list('project')).length, 0);
  assert.equal(auto.queue.status(memory.projectKey).recent[0]?.state, 'pending');
  await memory.dispose();
});

test('mutations recover partial vector commits, deduplicate, protect deletions and reject stale replacements', async () => {
  const f = fixture(); const memory = new ProjectMemory(f.agent, f.a, f.factory);
  const change = { kind: 'add' as const, scope: 'project' as const, text: '保留旧接口' };
  f.failWrite(); await assert.rejects(memory.apply(change, 'operation-1', 'source', true));
  await memory.apply(change, 'operation-1', 'source', true); assert.equal((await memory.list('project')).length, 1);
  await memory.apply(change, 'operation-2', 'source', true); assert.equal((await memory.list('project')).length, 1);
  const old = (await memory.list('project'))[0]!;
  await memory.edit('project', old.id, '已迁移到新接口', 'human', old.memory);
  await assert.rejects(memory.apply({ kind: 'replace', scope: 'project', targetId: old.id, text: '过时结论', expectedText: old.memory }, 'stale', 'source', true), /已被其他操作修改/);
  await memory.apply(change, 'old-fact', 'source', true); assert.equal((await memory.list('project')).length, 1, 'replaced old facts stay tombstoned');
  await memory.remove('project', old.id);
  await memory.apply({ kind: 'add', scope: 'project', text: '已迁移到新接口' }, 'deleted-replay', 'source', true);
  assert.equal((await memory.list('project')).length, 0);
  await memory.dispose();
});

test('real Pi registry reuses configured auth for background extraction and real Mem0 shares global facts across sessions', { timeout: 30_000 }, async () => {
  const f = fixture({ turnThreshold: 1 }); let coding = 0; let extraction = 0; let seenAuthorization = '';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const payload = JSON.parse(body);
    if (request.url === '/v1/embeddings') {
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: input.map((_: unknown, index: number) => ({ index, embedding: [1, 0, 0] })) })); return;
    }
    const serialized = JSON.stringify(payload.messages);
    let content = '已了解。';
    if (serialized.includes('后台长期记忆整理器')) {
      extraction++; seenAuthorization = request.headers.authorization ?? '';
      const message = payload.messages.find((item: any) => item.role === 'user');
      const text = typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text ?? '').join('');
      const data = JSON.parse(text); const source = data.newSources.find((item: any) => item.role === 'user');
      content = JSON.stringify({ actions: [{ kind: 'add', scope: 'global', text: '所有项目使用中文说明。', evidence: [{ id: source.id, quote: source.text }] }] });
    } else coding++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test', created: 1,
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  f.configure(`http://127.0.0.1:${address.port}/v1`); process.env.LOCAL_PI_AUTOMATIC_TEST_KEY = 'local-embedding-fixture';
  const models = await ModelRuntime.create({ authPath: join(f.agent, 'auth.json'), modelsPath: null, modelsStorePath: join(f.agent, 'models-cache.json'), refreshOnCreate: false });
  models.registerProvider('memory-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'subscription-fixture',
    models: [{ id: 'test', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const runtime = await createRuntime(parseOptions(['--cwd', f.a, '--agent-dir', f.agent, '--model', 'memory-fixture/test', '--doctor']), { modelRuntime: models });
  const memory = new ProjectMemory(f.agent, f.a); const q = new MemoryQueue(memory.root);
  try {
    await runtime.session.bindExtensions({});
    await runtime.session.prompt('所有项目都使用中文说明。');
    await until(() => q.status(memory.projectKey).recent.some((item) => item.state === 'done'), 'background memory extraction');
    assert.equal(coding, 1); assert.equal(extraction, 1); assert.equal(seenAuthorization, 'Bearer subscription-fixture');
    assert.equal((await memory.list('global')).length, 1);
    assert.equal(runtime.session.messages.filter((message) => message.role === 'user').length, 1, 'background extraction must not add a coding conversation turn');
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']);
    await runtime.session.reload();
    await runtime.session.prompt('/memory add project 重载后仍能保存。');
    assert.equal((await memory.list('project')).length, 1, 'reload creates a fresh memory instance rather than reusing a disposed one');
    assert.equal(coding, 1); assert.equal(extraction, 1);
    const other = new ProjectMemory(f.agent, f.b);
    assert.match(await other.recall('说明'), /所有项目使用中文说明/);
    assert.equal((await other.list('project')).length, 0); await other.dispose();
  } finally {
    await runtime.dispose(); await memory.dispose(); delete process.env.LOCAL_PI_AUTOMATIC_TEST_KEY;
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  }
});
