import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { getKeybindings, stripTerminalSequences, Text } from '@earendil-works/pi-tui';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime, sessionDirectory } from '../src/agent/runtime.ts';
import { restoreMode } from '../src/agent/mode.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

function answer(text: string, extra: Record<string, unknown> = {}): any {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'native-fixture', model: 'fixture',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(), ...extra };
}

async function setup(mcp = false) {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-native-actions-'));
  const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent'); const sessionsRoot = join(root, 'sessions');
  mkdirSync(cwd); mkdirSync(agentDir);
  if (mcp) {
    const server = join(root, 'mcp-fixture.cjs');
    writeFileSync(server, `const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line); if(req.id===undefined)return;
 let result={};
 if(req.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'local-fixture',version:'1'}};
 if(req.method==='tools/list') result={tools:[{name:'echo_fixture',description:'Echo a fixture string',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]};
 if(req.method==='tools/call'){appendFileSync(${JSON.stringify(join(root, 'calls.txt'))},req.params.arguments.value+'\\n');result={content:[{type:'text',text:'MCP_OK_'+req.params.arguments.value}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});`);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server], exposure: 'direct' } } }));
  }
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  models.registerProvider('native-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const seed = SessionManager.create(cwd, sessionDirectory(cwd, sessionsRoot));
  seed.appendMessage({ role: 'user', content: 'FIRST_QUESTION', timestamp: 1 }); const first = seed.appendMessage(answer('FIRST_ANSWER'));
  seed.appendMessage({ role: 'user', content: 'SECOND_QUESTION', timestamp: 2 }); const last = seed.appendMessage(answer('SECOND_ANSWER'));
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'native-fixture/fixture', '--session', seed.getSessionFile()!]);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false }, branchSummary: { skipPrompt: true } }),
  }), sessionsRoot);
  const terminal = new MemoryTerminal(); const ui = new MultiSessionTui(pool, terminal); const running = ui.run();
  await until(() => !!terminal.input && pool.slots.size === 1);
  return { root, cwd, agentDir, pool, terminal, running, first, last, a: pool.active };
}

test('native tree, HTML/JSONL export and reload preserve branches, drafts and a background run', { timeout: 30000 }, async () => {
  const f = await setup(); const { pool, terminal, a } = f;
  let release!: () => void; let task: Promise<void> | undefined; let aborted = false;
  const gate = new Promise<void>((done) => { release = done; });
  try {
    const b = await pool.open(); let requested = false;
    b.runtime.session.agent.streamFunction = (_m, _c, options) => {
      requested = true; options?.signal?.addEventListener('abort', () => { aborted = true; });
      const stream = createAssistantMessageEventStream();
      void gate.then(() => stream.push({ type: 'done', reason: 'stop', message: answer('BACKGROUND_DONE') })); return stream;
    };
    task = pool.submit(b.id, 'KEEP_RUNNING'); await until(() => requested); pool.activate(a.id);
    terminal.type('/export "saved branch.jsonl"\r'); const exported = join(f.cwd, 'saved branch.jsonl');
    await until(() => existsSync(exported)); const copy = SessionManager.open(exported);
    assert.ok(JSON.stringify(copy.buildSessionContext().messages).includes('SECOND_QUESTION'));
    terminal.type('/export "saved chat.html"\r'); const html = join(f.cwd, 'saved chat.html');
    await until(() => a.notices.some((n) => n.includes('saved chat.html')));
    const encoded = readFileSync(html, 'utf8').match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
    assert.ok(encoded, 'native HTML export embeds its session data');
    assert.ok(Buffer.from(encoded[1]!, 'base64').toString('utf8').includes('FIRST_QUESTION'));
    const originalExport = readFileSync(exported, 'utf8'); terminal.type('/export "saved branch.jsonl"\r');
    await until(() => a.notices.some((n) => n.includes('目标已存在'))); assert.equal(readFileSync(exported, 'utf8'), originalExport);
    const before = a.runtime.session.sessionManager.getLeafId(); const view = a.runtime.session.extensionRunner.createContext().ui;
    terminal.type('/tree\r'); await until(() => terminal.output.includes('只切换对话分支')); terminal.input?.('\x1b');
    assert.equal(a.runtime.session.sessionManager.getLeafId(), before);
    terminal.type('/tree\r'); await new Promise((r) => setTimeout(r, 40)); terminal.type('FIRST_ANSWER'); terminal.type('\r');
    await until(() => a.notices.some((n) => n.includes('已切换对话分支')));
    assert.equal(a.runtime.session.sessionManager.getLeafId(), f.first);
    assert.ok(!JSON.stringify(a.runtime.session.messages).includes('SECOND_QUESTION'));
    assert.ok(a.runtime.session.sessionManager.getEntries().some((e) => e.id === f.last), 'old branches are retained');
    await pool.navigateTree(a.id, f.last); assert.ok(JSON.stringify(a.runtime.session.messages).includes('SECOND_QUESTION'));
    mkdirSync(join(f.agentDir, 'prompts')); writeFileSync(join(f.agentDir, 'prompts', 'reload-fixture.md'), '---\ndescription: loaded after reload\n---\nRELOADED_PROMPT');
    writeFileSync(join(f.agentDir, 'keybindings.json'), JSON.stringify({ 'app.thinking.cycle': 'alt+y' }));
    terminal.type('/reload\r'); await until(() => a.notices.some((n) => n.includes('已重载当前会话')));
    assert.ok(a.runtime.session.promptTemplates.some((p) => p.name === 'reload-fixture'));
    assert.deepEqual(getKeybindings().getKeys('app.thinking.cycle'), ['alt+y']);
    view.setEditorText('UNSENT_RELOAD_DRAFT'); await pool.reload(a.id); assert.equal(view.getEditorText(), 'UNSENT_RELOAD_DRAFT');
    assert.ok(b.task); assert.equal(aborted, false);
    await assert.rejects(pool.reload(b.id), /不会自动中断/); await assert.rejects(pool.navigateTree(b.id, f.first), /不会自动中断/);
    release(); await task; assert.equal(b.runtime.session.getLastAssistantText(), 'BACKGROUND_DONE');
  } finally { release(); await task; process.emit('SIGTERM'); await f.running; await pool.dispose(); }
});

test('manual shell streams, uses cwd, cancels independently and distinguishes !! from model context', { timeout: 30000 }, async () => {
  const f = await setup(); const { pool, terminal, a } = f;
  try {
    terminal.type(process.platform === 'win32' ? '!Write-Output SHELL_OK; (Get-Location).Path\r' : '!printf "SHELL_OK\\n"; pwd\r');
    await until(() => a.runtime.session.messages.some((m) => m.role === 'bashExecution' && m.output.includes('SHELL_OK')));
    await until(() => !a.task);
    const first = a.runtime.session.messages.findLast((m) => m.role === 'bashExecution');
    assert.ok(first && first.role === 'bashExecution'); assert.match(first.output.replaceAll('\\', '/'), new RegExp(f.cwd.replaceAll('\\', '/')));
    assert.equal(first.excludeFromContext, false); assert.equal(restoreMode(a.runtime.session.sessionManager.getBranch()), 'discuss');
    terminal.type(process.platform === 'win32' ? '!!Write-Output PRIVATE_OUTPUT\r' : '!!printf PRIVATE_OUTPUT\r');
    await until(() => a.runtime.session.messages.some((m) => m.role === 'bashExecution' && m.excludeFromContext && m.output.includes('PRIVATE_OUTPUT')));
    await until(() => !a.task); let sentContext = '';
    a.runtime.session.agent.streamFunction = (_m, context) => {
      sentContext = JSON.stringify(a.runtime.session.agent.convertToLlm(context.messages));
      const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: answer('SHELL_CONTEXT_CHECKED') })); return stream;
    };
    await pool.submit(a.id, 'Check shell output'); assert.match(sentContext, /SHELL_OK/); assert.doesNotMatch(sentContext, /PRIVATE_OUTPUT/);
    const b = await pool.open(); pool.activate(a.id);
    terminal.type(process.platform === 'win32' ? '!Write-Output SHELL_STARTED; Start-Sleep -Seconds 20\r' : '!echo SHELL_STARTED; sleep 20\r');
    await until(() => !!a.shell?.output.includes('SHELL_STARTED')); pool.activate(b.id); assert.ok(a.task);
    await assert.rejects(pool.executeShell(b.id, 'echo SHOULD_NOT_RUN'), /正在此目录执行/);
    pool.activate(a.id); terminal.input?.('\x1b'); await until(() => !a.task);
    assert.ok(a.runtime.session.messages.some((m) => m.role === 'bashExecution' && m.cancelled));
    assert.equal(b.runtime.session.messages.some((m) => m.role === 'bashExecution'), false);
    await until(() => stripTerminalSequences(terminal.output).includes('SHELL_OK'));
  } finally { process.emit('SIGTERM'); await f.running; await pool.dispose(); }
});

test('official MCP manager persists across session switches and real MCP tools obey discussion/execute mode', { timeout: 30000 }, async () => {
  const f = await setup(true); const { pool, terminal, a } = f;
  try {
    await until(() => a.runtime.session.getAllTools().some((t) => t.name.startsWith('mcp__fixture__')));
    const tool = a.runtime.session.getAllTools().find((t) => t.name.startsWith('mcp__fixture__'))!;
    let requestedTools: string[] = []; let calls = 0;
    a.runtime.session.agent.streamFunction = (_m, context) => {
      requestedTools = context.tools?.map((t) => t.name) ?? []; const stream = createAssistantMessageEventStream();
      const message = calls++ === 0 ? answer('', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'mcp-call', name: tool.name, arguments: { value: 'EXECUTE' } }] }) : answer('MCP_FINISHED');
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message })); return stream;
    };
    await pool.submit(a.id, 'Read-only MCP attempt'); assert.ok(!requestedTools.includes(tool.name)); assert.ok(!existsSync(join(f.root, 'calls.txt')));
    await pool.submit(a.id, '/execute'); calls = 0; await pool.submit(a.id, 'Use the fixture MCP tool');
    assert.match(readFileSync(join(f.root, 'calls.txt'), 'utf8'), /EXECUTE/);
    assert.ok(a.runtime.session.messages.some((m) => m.role === 'toolResult' && JSON.stringify(m.content).includes('MCP_OK_EXECUTE')));
    terminal.type('/mcp\r'); await until(() => terminal.output.includes('MCP servers'));
    terminal.type('\r'); await until(() => terminal.output.includes('Reconnect'));
    terminal.input?.('\x0e'); await until(() => pool.slots.size === 2); const b = pool.active;
    assert.notEqual(b.id, a.id); terminal.type('B_DRAFT'); pool.activate(a.id);
    const offset = terminal.output.length; await new Promise((r) => setTimeout(r, 60));
    // The selected server menu survives; returning does not reopen at the root.
    terminal.input?.('\x1b'); await new Promise((r) => setTimeout(r, 40));
    assert.ok(stripTerminalSequences(terminal.output.slice(offset)).includes('MCP servers'));
    terminal.input?.('\x1b'); await new Promise((r) => setTimeout(r, 40)); terminal.type('/project\r');
    await until(() => a.notices.some((n) => n.includes('项目：')));
    pool.activate(b.id); assert.equal(b.runtime.session.extensionRunner.createContext().ui.getEditorText(), 'B_DRAFT');
    assert.ok(!existsSync(join(f.agentDir, 'mcp-auth.json')), 'no OAuth state without a login');
    // The default MCP exposure uses the SDK codemode tool, not only direct tools.
    writeFileSync(join(f.agentDir, 'mcp.json'), readFileSync(join(f.agentDir, 'mcp.json'), 'utf8').replace('"direct"', '"codemode"'));
    await pool.reload(a.id);
    await until(() => a.runtime.session.getAllTools().some((t) => t.name.startsWith('mcp__fixture__')));
    assert.ok(a.runtime.session.getActiveToolNames().includes('codemode'));
    assert.equal(a.runtime.session.getAllTools().find((t) => t.name === tool.name)?.exposure, 'deferred', 'native MCP normalizes codemode to deferred');
    calls = 0;
    a.runtime.session.agent.streamFunction = (_m, _context) => {
      const stream = createAssistantMessageEventStream();
      const message = calls++ === 0 ? answer('', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'code-call', name: 'codemode',
        arguments: { code: `text(await tools.${tool.name}({value:"CODEMODE"}));` } }] }) : answer('CODEMODE_FINISHED');
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message })); return stream;
    };
    await pool.submit(a.id, 'Use default MCP codemode');
    assert.ok(readFileSync(join(f.root, 'calls.txt'), 'utf8').includes('CODEMODE'));
    // An async extension factory finishing after its session closes must dispose its component.
    let finishFactory!: () => void; let disposed = 0;
    const factoryWait = new Promise<void>((done) => { finishFactory = done; });
    const panel = b.runtime.session.extensionRunner.createContext().ui.custom(async () => {
      await factoryWait; return Object.assign(new Text('LATE_EXTENSION_PANEL'), { dispose: () => { disposed++; } });
    });
    await pool.close(b.id); assert.equal(await panel, undefined); finishFactory();
    await until(() => disposed === 1);
  } finally { process.emit('SIGTERM'); await f.running; await pool.dispose(); }
});
