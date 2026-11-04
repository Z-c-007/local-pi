import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ollamaEmbedder } from '../src/agent/ollama-embedding.ts';
import { ProjectMemory, type MemoryConfig } from '../src/agent/memory.ts';

test('Ollama queues across clients/processes, adapts only searches, validates vectors and releases timed-out leases', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-ollama-'));
  const requests: any[] = []; let active = 0; let peak = 0; let dimension = 3;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body); assert.equal(req.url, '/api/embed');
    active++; peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, body.input.includes('slow') ? 300 : 25));
    active--;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0].slice(0, dimension)) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'qwen3-embedding:0.6b', dimension: 3 };
  try {
    const a = ollamaEmbedder(config, root); const b = ollamaEmbedder(config, root);
    await Promise.all([a.embed('preference', 'search'), b.embed('fact', 'add'), a.embed('replacement', 'update')]);
    // Concurrent callers may reach the filesystem queue in either order.
    assert.ok(requests.some((request) => /^Instruct: .*\nQuery:preference$/.test(request.input[0])));
    assert.ok(requests.some((request) => request.input[0] === 'fact'));
    assert.ok(requests.some((request) => request.input[0] === 'replacement'));
    assert.equal(requests[0].truncate, false); assert.equal(requests[0].options.num_thread, 4);
    const source = new URL('../src/agent/ollama-embedding.ts', import.meta.url).href;
    const child = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { ollamaEmbedder } from ${JSON.stringify(source)}; await ollamaEmbedder(${JSON.stringify(config)}, ${JSON.stringify(root)}).embed('child', 'search');`],
    { timeout: 10_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    await Promise.all([child(), child()]); assert.equal(peak, 1);
    dimension = 1; await assert.rejects(a.embed('invalid'), /维数/); dimension = 3;
    await assert.rejects(ollamaEmbedder({ ...config, timeoutMs: 100 }, root).embed('slow'));
    await new Promise((done) => setTimeout(done, 350));
    assert.deepEqual(await b.embed('recovered'), [1, 0, 0]);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

test('real Ollama + Mem0: persistent scoped memory, fresh sessions, concurrent writes, edits and deletion',
  { skip: !process.env.LOCAL_PI_TEST_OLLAMA, timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'local-pi-live-ollama-'));
    const agent = join(root, 'agent'); const a = join(root, 'a'); const b = join(root, 'b');
    for (const dir of [agent, a, b]) mkdirSync(dir);
    const config: MemoryConfig = { enabled: true, embedding: { provider: 'ollama', baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-embedding:0.6b', apiKeyEnv: 'LOCAL_PI_UNUSED_TEST_KEY', dimension: 1024, timeoutMs: 60_000 }, automatic: { enabled: false } };
    writeFileSync(join(agent, 'local-pi-memory.json'), JSON.stringify(config));
    const first = new ProjectMemory(agent, a); const other = new ProjectMemory(agent, b);
    let reopened: ProjectMemory | undefined;
    try {
      await Promise.all([first.add('project', '本项目统一使用 npm 安装依赖和运行脚本。', 'a'),
        other.add('project', '另一个项目使用 pnpm 管理依赖。', 'b')]);
      await first.add('global', '用户希望最终说明使用中文。', 'a');
      await first.dispose(); reopened = new ProjectMemory(agent, a);
      const records = await reopened.search('project', '这个项目应该用什么工具安装依赖？');
      assert.ok(records.some((record) => record.memory.includes('npm')));
      assert.ok(!(await other.list('project')).some((record) => record.memory.includes('统一使用 npm')));
      assert.ok((await other.search('global', '回复语言有什么偏好？')).some((record) => record.memory.includes('中文')));
      const record = records.find((item) => item.memory.includes('npm'))!;
      writeFileSync(reopened.markdownPath('project'), readFileSync(reopened.markdownPath('project'), 'utf8')
        .replace(record.memory, '本项目现在使用 yarn 管理依赖。'));
      assert.ok((await reopened.search('project', '现在用哪个包管理器？')).some((item) => item.memory.includes('yarn')));
      await reopened.reindex('project');
      await reopened.edit('project', record.id, '本项目使用 npm，要求兼容旧接口。', 'a', '本项目现在使用 yarn 管理依赖。');
      assert.match((await reopened.get('project', record.id))!.memory, /兼容旧接口/);
      await reopened.remove('project', record.id);
      assert.equal((await reopened.list('project')).length, 0);
    } finally { await first.dispose(); await reopened?.dispose(); await other.dispose(); }
  });
