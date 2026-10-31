import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Editor, ScrollView, TuiAltScreen, VStack, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { SessionPool } from '../src/agent/session-pool.ts';
import { createRuntime, sessionDirectory } from '../src/agent/runtime.ts';
import { parseOptions } from '../src/cli.ts';
import { Transcript } from '../src/tui/transcript.ts';
import { MemoryTerminal, until } from './helpers/terminal.ts';

type Message = Parameters<SessionManager['appendMessage']>[0];
type Assistant = Extract<Message, { role: 'assistant' }>;
const assistant = (content: Assistant['content'], timestamp: number): Assistant => ({
  role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp,
});

test('SDK message cards align, disclose reasoning and full tool output, and survive streaming and resize', async () => {
  initTheme(undefined, false);
  const root = mkdtempSync(join(tmpdir(), 'local-pi-transcript-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionsRoot = join(root, 'sessions');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const seed = SessionManager.create(cwd, sessionDirectory(cwd, sessionsRoot));
  seed.appendMessage({ role: 'user', content: 'USER_你好，请看中文换行和组合字符 é 👩‍💻。\n\n```ts\nconst 中文变量 = "很长的中文代码用来验证窄窗口换行";\n```', timestamp: 1 });
  const reply = assistant([{ type: 'thinking', thinking: 'THINKING_SECRET 分析依赖和修改范围。' },
    { type: 'text', text: 'ANSWER_先阅读文件，然后给出修改建议。\n\n```ts\nconst result = 123;\n```' }], 2);
  seed.appendMessage(reply);
  seed.appendMessage(assistant([{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/中文文件.ts' } }], 3));
  seed.appendMessage({ role: 'toolResult', toolCallId: 'read-1', toolName: 'read',
    content: [{ type: 'text', text: `${'完整输出内容\n'.repeat(400)}TOOL_TAIL_AFTER_1800` }],
    isError: false, timestamp: 4 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'cache.json'), refreshOnCreate: false });
  const options = parseOptions(['--cwd', cwd, '--agent-dir', agentDir, '--session', seed.getSessionFile()!]);
  const pool = new SessionPool(options, (opts, overrides) => createRuntime(opts, {
    ...overrides, modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [] }),
  }), sessionsRoot);
  let interactions = 0;
  const tui = { requestRender() {} } as TUI;
  try {
    const slot = await pool.open(options);
    const transcript = new Transcript(slot, tui, () => { interactions++; });
    const render = (width = 100) => transcript.render(width).map(stripTerminalSequences);
    const plain = () => render().join('\n');
    const clickLine = (needle: string) => {
      const lines = render();
      const y = lines.findIndex((line) => line.includes(needle));
      assert.ok(y >= 0, `missing clickable line ${needle}`);
      const result = transcript.handleMouse({ type: 'click', button: 'left', x: 2, y, screenX: 2, screenY: y,
        width: 100, height: lines.length, shift: false, alt: false, ctrl: false });
      assert.ok(result?.handled, `click did not reach ${needle}`);
    };

    for (const width of [24, 40, 80, 120]) {
      for (const line of render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    }
    const initial = render();
    const user = initial.find((line) => line.includes('USER_你好'))!;
    const answer = initial.find((line) => line.includes('ANSWER_'))!;
    assert.ok(user.search(/\S/) > 20, 'user bubble belongs on the right');
    assert.ok(answer.search(/\S/) <= 2, 'assistant body belongs on the left');
    assert.ok(initial.join('\n').includes('思考过程'));
    assert.ok(!initial.join('\n').includes('THINKING_SECRET'));
    assert.ok(!initial.join('\n').includes('TOOL_TAIL_AFTER_1800'));
    assert.equal(initial.filter((line) => line.includes('read · 完成')).length, 1, 'call and result share one card');

    clickLine('思考过程');
    assert.ok(plain().includes('THINKING_SECRET'));
    slot.streaming = { ...reply, content: [{ type: 'thinking', thinking: 'THINKING_SECRET 新的流式思考。' },
      { type: 'text', text: 'ANSWER_流式回答。' }] };
    pool.changed(slot);
    assert.ok(plain().includes('新的流式思考'), 'streaming must preserve the clicked expansion');
    assert.equal(render().filter((line) => line.includes('ANSWER_')).length, 1, 'streaming must not duplicate a message already in state');
    slot.streaming = undefined;
    pool.changed(slot);
    clickLine('THINKING_SECRET');
    assert.ok(!plain().includes('THINKING_SECRET'));

    transcript.setThinking('hidden');
    assert.ok(!plain().includes('思考过程'));
    assert.ok(!plain().includes('THINKING_SECRET'));
    assert.ok(plain().includes('ANSWER_'));
    transcript.setThinking('expanded');
    assert.ok(plain().includes('THINKING_SECRET'));
    assert.ok(JSON.stringify(slot.runtime.session.messages).includes('THINKING_SECRET'), 'display controls must never edit model context');

    clickLine('read · 完成');
    assert.ok(plain().includes('TOOL_TAIL_AFTER_1800'), 'expansion must retain all recorded tool text');
    pool.changed(slot);
    assert.ok(plain().includes('TOOL_TAIL_AFTER_1800'), 'unrelated status updates must not reset disclosure');
    for (const width of [24, 60, 120]) {
      for (const line of render(width)) assert.ok(visibleWidth(line) <= width, `expanded overflow at ${width}: ${line}`);
    }
    clickLine('read · 完成');
    assert.ok(!plain().includes('TOOL_TAIL_AFTER_1800'));
    transcript.setToolsExpanded(true);
    assert.ok(plain().includes('TOOL_TAIL_AFTER_1800'));
    transcript.setToolsExpanded(false);
    assert.ok(!plain().includes('TOOL_TAIL_AFTER_1800'));

    const b = await pool.open({ ...options, continue: false, session: undefined });
    const otherTranscript = new Transcript(b, tui, () => {});
    assert.equal(otherTranscript.thinking, 'collapsed');
    assert.equal(otherTranscript.toolsExpanded, false);
    pool.activate(slot.id);
    assert.equal(transcript.thinking, 'expanded');
    assert.ok(interactions >= 7);

    // Exercise the actual fullscreen mouse router, viewport, resize and input focus.
    const terminal = new MemoryTerminal();
    const fullscreen = new TuiAltScreen(terminal, true, undefined, { scrollToEndIndicator: () => '↓ 回到最新输出' });
    const document = new Transcript(slot, fullscreen, () => {
      scroll.scrollTo(scroll.scrollTop, { disableFollow: true });
      fullscreen.requestRender();
    });
    const scroll = new ScrollView(document, { follow: 'end', primary: true });
    const editor = new Editor(fullscreen, { borderColor: (text) => text, selectList: {
      selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text,
      scrollInfo: (text) => text, noMatch: (text) => text,
    } });
    fullscreen.setLayoutRoot(new VStack([{ component: scroll, grow: 1, minSize: 1 }, { component: editor, shrink: 0, maxSize: 5 }]));
    fullscreen.setFocus(editor);
    const frame = () => fullscreen.getScreenLines().map(stripTerminalSequences);
    fullscreen.start();
    try {
      await until(() => frame().some((line) => line.includes('思考过程')), 'collapsed thinking in fullscreen');
      terminal.click(2, frame().findIndex((line) => line.includes('思考过程')));
      await until(() => frame().some((line) => line.includes('THINKING_SECRET')), 'fullscreen mouse expansion');
      terminal.type('保留草稿');
      assert.equal(editor.getText(), '保留草稿', 'clicking a disclosure must not take editor focus');
      terminal.click(2, frame().findIndex((line) => line.includes('read · 完成')));
      await until(() => frame().some((line) => line.includes('▼ read')), 'expanded tool stays in view');
      assert.equal(scroll.isFollowingEnd, false, 'opening a tool must not jump to the tail');
      await until(() => frame().some((line) => line.includes('回到最新输出')), 'return-to-output control');
      const indicatorY = frame().findIndex((line) => line.includes('回到最新输出'));
      const indicatorLine = frame()[indicatorY]!;
      terminal.click(visibleWidth(indicatorLine.slice(0, indicatorLine.indexOf('↓'))) + 2, indicatorY);
      await until(() => frame().some((line) => line.includes('TOOL_TAIL_AFTER_1800')), 'full output tail in viewport');
      assert.equal(scroll.isFollowingEnd, true);
      terminal.resize(42);
      await until(() => fullscreen.getScreenLines().every((line) => visibleWidth(line) <= 42), 'narrow fullscreen resize');
      assert.equal(editor.getText(), '保留草稿');
    } finally { fullscreen.stop(); }
  } finally { await pool.dispose(); }
});
