import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { createRuntime } from '../src/agent/runtime.ts';
import { SessionPool } from '../src/agent/session-pool.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { installThinkingKeybindings } from '../src/tui/keybindings.ts';
import type { ClipboardReader } from '../src/tui/clipboard.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

// A valid small RGBA PNG, including CRCs, for the SDK's real image transcoder.
function pngChunk(type: string, bytes: Buffer) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
  return Buffer.concat([size, data, crc]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
  return { promise, release };
}

test('native paste shortcut preserves drafts and the SDK reads the pasted screenshot for the model', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-clipboard-'));
  const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir);
  let files: string[] | null = null;
  let image = true; let text: string | null = null; let failure = false;
  let imageGate: ReturnType<typeof gate> | undefined;
  const gates: Array<ReturnType<typeof gate>> = [];
  let imageReads = 0;
  const clipboard: ClipboardReader = {
    async readClipboardFilePaths() { if (failure) throw new Error('Fixture clipboard denied'); return files; },
    async readClipboardImage() { imageReads++; await imageGate?.promise; return image ? { bytes: png, mimeType: 'image/png' } : null; },
    async readClipboardText() { return text; },
    extensionForImageMimeType: (type) => type === 'image/png' ? 'png' : null,
  };
  const requests: any[] = [];
  let screenshot = '';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model: 'vision', created: 1,
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`);
    if (requests.length === 1) {
      send({ tool_calls: [{ index: 0, id: 'read-image', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: screenshot }) } }] });
      send({}, 'tool_calls');
    } else { send({ content: 'The screenshot was received.' }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('clipboard-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture',
    models: [{ id: 'vision', name: 'Vision fixture', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const pool = new SessionPool(parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'clipboard-fixture/vision']),
    (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false } }) }), join(root, 'sessions'));
  const terminal = new MemoryTerminal(); const ui = new MultiSessionTui(pool, terminal, clipboard);
  const running = ui.run();
  const key = process.platform === 'win32' || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP ? '\x1bv' : '\x16';
  const paste = () => terminal.input?.(key);
  try {
    await until(() => !!terminal.input && pool.slots.size === 1);
    const a = pool.active; const aUi = a.runtime.session.extensionRunner!.createContext().ui;
    assert.ok(getKeybindings().matches(key, 'app.clipboard.pasteImage'));
    paste();
    await until(() => aUi.getEditorText().includes('pi-clipboard-'));
    screenshot = aUi.getEditorText();
    assert.deepEqual(readFileSync(screenshot), png);
    assert.equal(requests.length, 0, 'pasting alone must not send a model request');
    terminal.type('\r');
    await until(() => requests.length === 2 && !a.task);
    assert.ok(JSON.stringify(requests[1].messages).includes('data:image/'), JSON.stringify({
      tools: a.runtime.session.messages.filter((message) => message.role === 'toolResult'),
    }).slice(0, 1000));
    assert.ok(a.runtime.session.messages.some((message) => message.role === 'toolResult' && !message.isError
      && message.content.some((part) => part.type === 'image')));

    aUi.setEditorText(''); files = ['D:\\folder with spaces\\a.png'];
    const beforeFiles = imageReads; paste();
    await until(() => aUi.getEditorText().includes('folder with spaces'));
    assert.equal(imageReads, beforeFiles, 'copied files take priority');
    aUi.setEditorText(''); files = null; image = false; text = '中文文字\n第二行'; paste();
    await until(() => aUi.getEditorText() === text);
    aUi.setEditorText(''); text = null; paste();
    await until(() => a.notices.some((notice) => notice.includes('剪贴板没有')));
    failure = true; paste();
    await until(() => a.notices.some((notice) => notice.includes('Fixture clipboard denied')));
    failure = false;
    files = ['bad\npath']; paste();
    await until(() => a.notices.some((notice) => notice.includes('控制字符')));
    assert.equal(aUi.getEditorText(), ''); files = null; image = true;

    imageGate = gate(); gates.push(imageGate);
    const beforeSwitch = imageReads; paste();
    await until(() => imageReads > beforeSwitch);
    const b = await pool.open(); const bUi = b.runtime.session.extensionRunner!.createContext().ui;
    bUi.setEditorText('B draft'); imageGate.release();
    await until(() => aUi.getEditorText().includes('pi-clipboard-'));
    assert.equal(bUi.getEditorText(), 'B draft', 'async paste must stay with A');
    pool.activate(a.id); aUi.setEditorText('');
    imageGate = gate(); gates.push(imageGate);
    const beforeClear = imageReads; paste(); await until(() => imageReads > beforeClear);
    terminal.type('\x03'); imageGate.release();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(aUi.getEditorText(), '', 'clearing cancels a pending paste');
    imageGate = gate(); gates.push(imageGate);
    const beforeSubmit = imageReads; paste(); await until(() => imageReads > beforeSubmit);
    terminal.type('/project\r'); imageGate.release();
    await new Promise<void>((done) => setImmediate(done));
    await until(() => a.notices.some((notice) => notice.includes('项目：')));
    assert.equal(aUi.getEditorText(), '', 'submitting cancels a pending paste');
    imageGate = gate(); gates.push(imageGate);
    const beforeClose = imageReads; paste(); await until(() => imageReads > beforeClose);
    await pool.close(a.id); imageGate.release();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(bUi.getEditorText(), 'B draft');
    assert.equal(requests.length, 2);
  } finally {
    for (const item of gates) item.release();
    if (terminal.input) process.emit('SIGTERM');
    await running; await pool.dispose();
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  }
});

test('clipboard shortcut honors the existing native keybindings configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-pi-paste-key-'));
  writeFileSync(join(dir, 'keybindings.json'), JSON.stringify({ 'app.clipboard.pasteImage': 'alt+i' }));
  const restore = installThinkingKeybindings(dir);
  try {
    assert.equal(getKeybindings().matches('\x1bi', 'app.clipboard.pasteImage'), true);
    assert.equal(getKeybindings().matches('\x1bv', 'app.clipboard.pasteImage'), false);
  } finally { restore(); }
});
