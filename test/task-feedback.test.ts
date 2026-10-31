import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime } from '../src/agent/runtime.ts';
import { readTaskReports, formatTaskReport } from '../src/agent/task-metrics.ts';
import { parseOptions } from '../src/cli.ts';
import { MultiSessionTui } from '../src/tui/multi-session.ts';
import { loadPiUi } from '../src/tui/pi-ui.ts';
import { Transcript } from '../src/tui/transcript.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
  return { promise, release };
}

test('native themes/footer, independent persisted task feedback, and unsupported command routing', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-pi-feedback-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(join(agentDir, 'themes'), { recursive: true });
  mkdirSync(join(agentDir, 'skills', 'fixture-skill'), { recursive: true });
  writeFileSync(join(cwd, 'fixture.txt'), 'Fixture file content.');
  writeFileSync(join(agentDir, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: A local test skill.\n---\nDiscuss this fixture skill.');
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const customTheme = JSON.parse(readFileSync(join(dist, 'modes/interactive/theme/dark.json'), 'utf8'));
  customTheme.name = 'fixture-theme';
  writeFileSync(join(agentDir, 'themes', 'fixture-theme.json'), JSON.stringify(customTheme));
  const plans: Array<{ gate?: ReturnType<typeof gate>; tool?: boolean; status?: number; usage?: boolean }> = [];
  const gates: Array<ReturnType<typeof gate>> = [];
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const plan = plans.shift() ?? { usage: true };
    await plan.gate?.promise;
    if (res.destroyed) return;
    if (plan.status) {
      res.writeHead(plan.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: plan.status === 503 ? 'Server overloaded, please try again' : 'Invalid fixture request' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices, ...(usage ? { usage } : {}) })}\n\n`);
    const choice = (delta: unknown, finish_reason: string | null = null) => [{ index: 0, delta, finish_reason }];
    if (plan.tool) {
      send(choice({ tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] }));
      send(choice({}, 'tool_calls'));
    } else {
      send(choice({ reasoning_content: 'Fixture thinking content.', content: 'Fixture reply with **Markdown**.' }));
      send(choice({}, 'stop'));
    }
    if (plan.usage) send([], { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('feedback-fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-test',
    models: [{ id: 'fixture', name: 'fixture', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const settings = SettingsManager.inMemory({ theme: 'dark', defaultThinkingLevel: 'medium', packages: [],
    compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
  const pool = new SessionPool(parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--model', 'feedback-fixture/fixture']),
    (opts, overrides) => createRuntime(opts, { ...overrides, modelRuntime, settingsManager: settings }), join(root, 'sessions'));
  const terminal = new MemoryTerminal();
  const ui = new MultiSessionTui(pool, terminal);
  const running = ui.run();
  try {
    await until(() => !!terminal.input && pool.slots.size === 1);
    const pi = await loadPiUi();
    const a = pool.active;
    const extUi = a.runtime.session.extensionRunner!.createContext().ui;
    await until(() => pi.getTheme().name === 'dark');
    assert.equal(extUi.theme, pi.getTheme(), 'extension theme follows the live official theme');
    const mediumColor = pi.getTheme().getThinkingBorderColor('medium')('─');
    const offset = terminal.output.length;
    terminal.type('/thinking high\r');
    await until(() => a.runtime.session.thinkingLevel === 'high');
    const highColor = pi.getTheme().getThinkingBorderColor('high')('─');
    assert.notEqual(highColor, mediumColor);
    await until(() => terminal.output.slice(offset).includes(highColor.slice(0, highColor.indexOf('─') + 1)), 'native effort color in the real editor');
    terminal.type('/theme fixture-theme\r');
    await until(() => pi.getTheme().name === 'fixture-theme');
    assert.equal(settings.getThemeSetting(), 'fixture-theme');
    assert.equal(extUi.theme, pi.getTheme());
    terminal.type('/theme nonexistent-theme\r');
    await until(() => a.notices.some((notice) => notice.includes('找不到主题')));
    assert.equal(settings.getThemeSetting(), 'fixture-theme');
    terminal.type('/theme\r');
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 60));
    terminal.input?.('\x1b[A'); // Native theme selector previews the preceding built-in theme.
    await until(() => pi.getTheme().name !== 'fixture-theme');
    terminal.type('\x1b');
    await until(() => pi.getTheme().name === 'fixture-theme');
    assert.equal(settings.getThemeSetting(), 'fixture-theme', 'cancelling preview must not save it');
    terminal.type('/theme light/dark\r');
    await until(() => settings.getThemeSetting() === 'light/dark');
    terminal.type('/theme dark\r');
    await until(() => pi.getTheme().name === 'dark');
    for (const command of ['/import', '/share', '/not-a-command']) terminal.type(`${command}\r`);
    await until(() => a.notices.some((notice) => notice.includes('未知命令')));
    assert.equal(requests.length, 0);
    assert.equal(a.runtime.session.messages.filter((message) => message.role === 'user').length, 0);
    terminal.type('/project\r');
    await until(() => a.notices.some((notice) => notice.includes('项目：')));

    const slow = gate(); gates.push(slow);
    plans.push({ gate: slow, tool: true, usage: true });
    const taskA = pool.submit(a.id, 'Read fixture.txt and discuss it.');
    await until(() => requests.length === 1 && !!a.metrics.current);
    const start = a.metrics.current!.id;
    await until(() => /Working · \d+:\d{2}/.test(stripTerminalSequences(terminal.output)), 'elapsed clock in the real editor');
    const b = await pool.open();
    plans.push({ usage: true });
    await pool.submit(b.id, 'Discuss another independent task.');
    const reportB = readTaskReports(b.runtime.session).at(-1)!;
    assert.equal(reportB.tokens?.total, 120);
    assert.equal(reportB.status, 'completed');
    assert.equal(a.metrics.current!.id, start);
    await new Promise((resolveClock) => setTimeout(resolveClock, 1100));
    const beforeSwitch = terminal.output.length;
    pool.activate(a.id);
    await until(() => [...stripTerminalSequences(terminal.output.slice(beforeSwitch)).matchAll(/Working · (\d+):(\d{2})/g)]
      .some((match) => Number(match[1]) * 60 + Number(match[2]) >= 1), 'background clock resumes without resetting');
    plans.push({ usage: true });
    slow.release(); await taskA;
    const reportA = readTaskReports(a.runtime.session).at(-1)!;
    assert.equal(reportA.id, start, 'tool turns must not start a new task timer');
    assert.equal(reportA.status, 'completed');
    assert.ok(reportA.durationMs! >= 1100);
    assert.deepEqual(reportA.tokens, { input: 120, output: 40, cacheRead: 80, cacheWrite: 0, total: 240 });
    assert.equal(a.runtime.session.getSessionStats().tokens.total, 240, 'reasoning tokens must not be counted twice');
    await until(() => stripTerminalSequences(terminal.output).includes('↑120 ↓40 R80'), 'official usage footer');
    await until(() => stripTerminalSequences(terminal.output).includes('本次耗时'), 'persisted task summary');
    assert.ok(!requests.some((request) => JSON.stringify(request.messages).includes('local-pi-task-metrics')));

    const transcript = new Transcript(a, { requestRender() {} } as TUI, () => {});
    const render = () => transcript.render(120).map(stripTerminalSequences);
    let lines = render();
    const thinkingY = lines.findIndex((line) => line.includes('点击展开'));
    assert.ok(thinkingY >= 0);
    transcript.handleMouse({ type: 'click', button: 'left', x: 2, y: thinkingY, screenX: 2, screenY: thinkingY,
      width: 120, height: lines.length, shift: false, alt: false, ctrl: false });
    assert.ok(render().join('\n').includes('Fixture thinking content.'));
    terminal.type('/theme light\r'); await until(() => pi.getTheme().name === 'light');
    transcript.resetTheme();
    assert.ok(render().join('\n').includes('Fixture thinking content.'), 'theme changes preserve per-block disclosure');

    plans.push({ status: 503 }, { usage: true });
    await pool.submit(a.id, 'Discuss the retry case.');
    assert.equal(readTaskReports(a.runtime.session).length, 2, 'automatic retries share one task report');
    assert.equal(readTaskReports(a.runtime.session).at(-1)!.status, 'completed');
    plans.push({ status: 400 });
    await pool.submit(b.id, 'Discuss the failure case.');
    assert.equal(readTaskReports(b.runtime.session).at(-1)!.status, 'failed');
    assert.ok(formatTaskReport(readTaskReports(b.runtime.session).at(-1)!).includes('Token 未知'));
    plans.push({ tool: true, usage: false }, { usage: true });
    await pool.submit(b.id, 'Read fixture.txt again with a response missing usage.');
    const partial = readTaskReports(b.runtime.session).at(-1)!;
    assert.equal(partial.tokens?.total, 120);
    assert.equal(partial.partialUsage, true);
    assert.ok(formatTaskReport(partial).includes('部分响应未返回用量'));
    const stop = gate(); gates.push(stop); plans.push({ gate: stop, usage: true });
    const beforeStop = requests.length;
    const stopping = pool.submit(a.id, 'Discuss cancellation.');
    await until(() => !!a.metrics.current && requests.length > beforeStop);
    await pool.abort(a.id); await stopping; stop.release();
    assert.equal(readTaskReports(a.runtime.session).at(-1)!.status, 'aborted');
    assert.equal(a.metrics.current, undefined);

    pool.activate(b.id);
    const beforeCommands = requests.length;
    terminal.type('/code-review fixture\r'); // SDK prompt templates still reach the agent.
    await until(() => requests.length > beforeCommands && !b.task);
    terminal.type('/skill:fixture-skill\r');
    await until(() => requests.length > beforeCommands + 1 && !b.task);
    assert.ok(requests.at(-1).messages.some((message: { content: unknown }) => JSON.stringify(message.content).includes('Discuss this fixture skill')));
    await pool.close(a.id);
    const restored = await pool.openSession(a.id, cwd);
    assert.deepEqual(readTaskReports(restored.runtime.session), readTaskReports(a.runtime.session));
    assert.ok(new Transcript(restored, { requestRender() {} } as TUI, () => {}).render(120).map(stripTerminalSequences).join('\n').includes('本次耗时'));
  } finally {
    for (const item of gates) item.release();
    if (terminal.input) process.emit('SIGTERM');
    await running;
    await pool.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
