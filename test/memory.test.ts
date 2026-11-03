import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectMemory, memoryContext, type MemoryBackend, type MemoryBackendFactory, type MemoryRecord } from '../src/agent/memory.ts';
import { createMemoryExtension } from '../src/extensions/memory.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { loadPiUi } from '../src/tui/pi-ui.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-memory-'));
  const agent = join(root, 'agent'); const a = join(root, 'a'); const b = join(root, 'b');
  for (const dir of [agent, a, b]) mkdirSync(dir);
  mkdirSync(join(a, '.git')); mkdirSync(join(a, 'src')); mkdirSync(join(b, '.git'));
  const configure = (baseURL = 'http://127.0.0.1:1/v1') => writeFileSync(join(agent, 'local-pi-memory.json'), JSON.stringify({
    enabled: true, embedding: { baseURL, model: 'fixture', apiKeyEnv: 'LOCAL_PI_MEMORY_TEST_KEY', dimension: 3 },
  }));
  return { root, agent, a, b, configure };
}

function fake() {
  const stores = new Map<string, Map<string, MemoryRecord>>(); let serial = 0;
  const factory: MemoryBackendFactory = async (directory) => {
    const data = stores.get(directory) ?? new Map<string, MemoryRecord>(); stores.set(directory, data);
    return {
      async add(messages, options) {
        assert.equal(options.infer, false);
        const id = `memory-${++serial}`;
        data.set(id, { id, memory: messages[0]!.content, metadata: options.metadata as Record<string, unknown> });
      },
      async search(_query, options) { assert.deepEqual(options.filters, { user_id: 'local-pi' }); return { results: [...data.values()].slice(0, 3) }; },
      async getAll(options) { const filters = options.filters as Record<string, unknown>;
        return { results: [...data.values()].filter((item) => Object.entries(filters).every(([key, value]) => key === 'user_id' || item.metadata?.[key] === value)) }; },
      async get(id) { return data.get(id) ?? null; },
      async delete(id) { data.delete(id); },
      async update(id, options) { const current = data.get(id)!; data.set(id, { ...current, memory: options.text, metadata: options.metadata }); },
    } satisfies MemoryBackend;
  };
  return { factory, stores };
}

test('unconfigured memory does not initialize SDK, create storage, or change coding tools', async () => {
  const f = fixture(); let calls = 0;
  const memory = new ProjectMemory(f.agent, f.a, async () => { calls++; throw new Error(); });
  assert.equal(await memory.recall('hello'), ''); assert.equal(calls, 0); assert.equal(existsSync(memory.root), false);
  const runtime = await createRuntime(parseOptions(['--cwd', f.a, '--agent-dir', f.agent, '--doctor']));
  try {
    assert.ok(runtime.session.extensionRunner?.getCommand('memory'));
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']);
    await runtime.session.prompt('/execute');
    assert.ok(runtime.session.getActiveToolNames().includes('write'));
  } finally { await runtime.dispose(); }
});

test('project memory is shared across sessions/subdirectories, isolated from other projects, and global is shared', async () => {
  const f = fixture(); f.configure(); const backend = fake();
  const a1 = new ProjectMemory(f.agent, f.a, backend.factory);
  const a2 = new ProjectMemory(f.agent, join(f.a, 'src'), backend.factory);
  const b = new ProjectMemory(f.agent, f.b, backend.factory);
  assert.equal(a1.projectKey, a2.projectKey);
  await Promise.all([a1.add('project', '旧接口仍在使用', 'session-a'), a2.add('project', '使用 npm', 'session-b')]);
  await a1.add('global', '中文说明', 'session-a');
  assert.equal((await a2.list('project')).length, 2);
  assert.equal((await b.list('project')).length, 0);
  assert.equal((await b.list('global')).length, 1);
  const content = await b.recall('接口');
  assert.match(content, /中文说明/); assert.doesNotMatch(content, /旧接口/);
  const id = (await a1.list('project'))[0]!.id;
  await assert.rejects(b.remove('project', id), /找不到/);
  await a2.remove('project', id);
  assert.equal((await a1.list('project')).length, 1);
});

test('embedding changes are rejected rather than mixing incompatible vector spaces', async () => {
  const f = fixture(); f.configure(); const backend = fake();
  const memory = new ProjectMemory(f.agent, f.a, backend.factory);
  await memory.add('project', 'fact', 'origin');
  f.configure('http://127.0.0.1:2/v1');
  await assert.rejects(memory.list('project'), /配置已改变/);
});

test('memory command uses a framed, scrollable native overlay without adding conversation messages', async () => {
  const f = fixture(); const memory = new ProjectMemory(f.agent, f.a, fake().factory);
  const commands = new Map<string, any>();
  createMemoryExtension(memory)({ on() {}, registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
  initTheme('dark', false); const official = await loadPiUi(); let closed = false;
  const ctx = { isIdle: () => true, hasUI: true, ui: {
    notify() { throw new Error('help should open an overlay'); },
    async custom(factory: Function) {
      const panel = factory({ terminal: { rows: 24 }, requestRender() {} }, official.getTheme(), {}, () => { closed = true; });
      for (const width of [100, 45, 15]) {
        const lines = panel.render(width);
        assert.match(stripTerminalSequences(lines[0]), /╭/);
        assert.match(stripTerminalSequences(lines.at(-1)), /╯/);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
      }
      panel.handleInput('\x1b');
    },
  } };
  await commands.get('memory').handler('', ctx);
  assert.ok(closed);
});

test('extension replaces stale recall, does not write automatically, and fails open without leaking provider details', async () => {
  const f = fixture(); f.configure(); const backend = fake();
  const memory = new ProjectMemory(f.agent, f.a, backend.factory);
  await memory.add('project', 'compatibility constraint', 'origin');
  const handlers = new Map<string, Function>(); const commands = new Map<string, any>();
  createMemoryExtension(memory)({ on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
  const notices: string[] = []; const ctx = { isIdle: () => true, hasUI: false,
    ui: { setStatus() {}, notify: (message: string) => notices.push(message) } };
  const event = { messageType: 'user', prompt: 'compatibility', systemPromptOptions: { sections: {} as Record<string, string> } };
  await handlers.get('before_agent_start')!(event, ctx);
  assert.match(event.systemPromptOptions.sections.local_pi_memory!, /compatibility constraint/);
  writeFileSync(memory.configPath, '{"enabled":false}');
  await handlers.get('before_agent_start')!(event, ctx);
  assert.equal(event.systemPromptOptions.sections.local_pi_memory, '');
  assert.equal(memory.lastRecall.length, 0);
  f.configure(); memory.recall = async () => { throw new Error('Bearer SUPERSECRET'); };
  await handlers.get('before_agent_start')!(event, ctx);
  assert.equal(event.systemPromptOptions.sections.local_pi_memory, '');
  assert.ok(notices.some((text) => text.includes('召回失败')));
  assert.ok(!notices.join('').includes('SUPERSECRET'));
  assert.equal((await memory.list('project')).length, 1, 'recall must never extract or save the question');
  await commands.get('memory').handler('delete project unknown', ctx);
  assert.equal((await memory.list('project')).length, 1);
  assert.ok(memoryContext(Array.from({ length: 20 }, (_, i) => ({ id: String(i), memory: '\x1b[31m' + 'a'.repeat(4000), scope: 'project' as const }))).length < 6300);
});

test('real Mem0 3.3.1 persists and deletes SQLite vectors across a fresh instance, with embeddings only', { timeout: 30_000 }, async () => {
  const f = fixture(); const requests: string[] = []; let dimension = 3; let hang = false;
  const server = createServer(async (request, response) => {
    requests.push(request.url!); let body = '';
    for await (const chunk of request) body += chunk;
    if (hang) return;
    const input = JSON.parse(body).input;
    const texts = Array.isArray(input) ? input : [input];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: texts.map((_: unknown, index: number) => ({ embedding: [1, 0, 0].slice(0, dimension), index })), model: 'fixture' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  f.configure(`http://127.0.0.1:${address.port}/v1`);
  process.env.LOCAL_PI_MEMORY_TEST_KEY = 'local-fixture-only';
  try {
    const first = new ProjectMemory(f.agent, f.a);
    await first.add('project', '项目需要兼容旧接口', 'session-1');
    const next = new ProjectMemory(f.agent, join(f.a, 'src'));
    const recalled = await next.search('project', '旧接口');
    assert.equal(recalled.length, 1); assert.equal(recalled[0]!.memory, '项目需要兼容旧接口');
    assert.equal(recalled[0]!.metadata?.sourceSessionId, 'session-1');
    assert.equal((await next.list('project')).length, 1);
    assert.ok(existsSync(join(next.directory('project'), 'vectors.sqlite')));
    const id = recalled[0]!.id;
    await next.remove('project', id);
    assert.equal((await first.search('project', '旧接口')).length, 0);
    assert.ok(requests.length >= 3); assert.ok(requests.every((path) => path === '/v1/embeddings'), JSON.stringify(requests));
    const source = new URL('../src/agent/memory.ts', import.meta.url).href;
    const child = (text: string) => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { ProjectMemory } from ${JSON.stringify(source)}; const m = new ProjectMemory(${JSON.stringify(f.agent)}, ${JSON.stringify(f.a)}); await m.add('project', ${JSON.stringify(text)}, 'child');`],
    { timeout: 15_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    await Promise.all([child('process-one'), child('process-two')]);
    const reopened = new ProjectMemory(f.agent, f.a);
    assert.deepEqual((await reopened.list('project')).map((item) => item.memory).sort(), ['process-one', 'process-two']);
    const editable = (await reopened.list('project')).find((item) => item.memory === 'process-one')!;
    await reopened.edit('project', editable.id, 'process-one-updated', 'human', editable.memory);
    assert.equal((await first.get('project', editable.id))?.memory, 'process-one-updated');
    dimension = 1;
    await assert.rejects(reopened.add('project', 'bad-dimension', 'invalid'), /维数/);
    assert.equal((await reopened.list('project')).length, 2);
    dimension = 3; hang = true;
    const started = Date.now();
    await assert.rejects(reopened.search('project', 'timeout'));
    assert.ok(Date.now() - started < 6500, 'embedding request must time out without SDK retries');
    assert.equal((await reopened.list('project')).length, 2, 'timed-out searches release their coordination lease');
    await Promise.all([first.dispose(), next.dispose(), reopened.dispose()]);
    await assert.rejects(reopened.list('project'), /已关闭/);
  } finally { delete process.env.LOCAL_PI_MEMORY_TEST_KEY; server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});
