import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { SessionListEntry } from '../src/agent/session-pool.ts';
import { loadPiUi } from '../src/tui/pi-ui.ts';
import { sessionSelector, sessionTree } from '../src/tui/session-selector.ts';

const entry = (id: string, title: string, modified: number, parent?: string): SessionListEntry => ({ version: 1, id,
  cwd: 'D:/project', title, modified, created: 1, hasConversation: true, mode: 'discuss',
  fork: parent ? { sourceSessionId: parent, sourceSessionFile: `${parent}.jsonl`, entryId: 'point', position: 'at' } : undefined,
});

test('framed session picker keeps fork families, selection identity and mouse targets through scrolling, resize and theme changes', async () => {
  initTheme('dark', false); const ui = await loadPiUi();
  const entries = [entry('grand', '分支一的分支', 60, 'child'), entry('child2', '另一个分支', 50, 'parent'),
    entry('other', '独立会话', 20), entry('parent', '父会话', 1), entry('child', '分支一', 30, 'parent'),
    entry('orphan', '来源未列出的分支', 5, 'missing')];
  const before = JSON.stringify(entries);
  const tree = sessionTree(entries);
  assert.deepEqual(tree.map((row) => row.entry.id), ['parent', 'child', 'grand', 'child2', 'other', 'orphan']);
  assert.equal(tree[1]?.prefix, '├─ '); assert.equal(tree[2]?.prefix, '│  └─ '); assert.equal(tree[3]?.prefix, '└─ ');
  let height = 26; let chosen = ''; let cancelled = false;
  const panel = sessionSelector(entries, 'D:/project', 'grand', () => height, () => ui.getTheme(), () => {},
    (id) => { chosen = id; }, () => { cancelled = true; });
  const lines = panel.render(100); const plain = lines.map(stripTerminalSequences);
  assert.ok(plain[0]?.startsWith('╭')); assert.ok(plain.at(-1)?.endsWith('╯'));
  assert.ok(plain.some((line) => line.includes('├─ 分支一')));
  assert.ok(plain.some((line) => line.includes('│  └─ [当前] 分支一的分支')));
  assert.ok(plain.some((line) => line.includes('分叉自 child')));
  assert.ok(lines.find((line) => stripTerminalSequences(line).includes('▶'))?.includes(ui.getTheme().getBgAnsi('selectedBg')));
  for (const scheme of ['dark', 'light']) {
    initTheme(scheme, false);
    for (height of [4, 7, 10, 16, 26]) for (const width of [6, 24, 44, 100]) {
      const fitted = panel.render(width);
      assert.ok(fitted.length <= height, `${scheme}, ${width}x${height}: ${fitted.length}`);
      assert.ok(fitted.every((line) => visibleWidth(line) === width), `${scheme}, ${width}x${height}`);
      assert.ok(stripTerminalSequences(fitted.at(-1)!).startsWith('╰'));
    }
  }
  height = 26; panel.render(100); panel.handleInput?.('\r'); assert.equal(chosen, 'grand'); chosen = '';
  panel.handleInput?.('\x1b[A'); panel.render(100);
  panel.handleInput?.('\r'); assert.equal(chosen, 'child'); chosen = '';
  const refreshed = panel.render(100).map(stripTerminalSequences);
  assert.ok(refreshed.some((line) => line.includes('分叉自 parent')));
  assert.ok(refreshed.some((line) => line.includes('[当前] 分支一的分支')), 'current chat badge stays separate from keyboard selection');
  const rootY = refreshed.findIndex((line) => line.includes('父会话'));
  const mouse: TuiMouseEvent = { type: 'press', button: 'left', x: 4, y: rootY, screenX: 4, screenY: rootY,
    width: 100, height: refreshed.length, ctrl: false, alt: false, shift: false };
  assert.ok(panel.handleMouse?.(mouse)?.handled); panel.render(100);
  panel.handleMouse?.({ ...mouse, type: 'click' }); assert.equal(chosen, 'parent');
  panel.handleInput?.('\x1b'); assert.equal(cancelled, true); assert.equal(JSON.stringify(entries), before);
  const cycle = sessionTree([entry('a', 'A', 1, 'b'), entry('b', 'B', 2, 'a'), entry('self', 'Self', 3, 'self')]);
  assert.deepEqual(new Set(cycle.map((row) => row.entry.id)), new Set(['a', 'b', 'self']));
  const crowded = Array.from({ length: 30 }, (_, index) => entry(`id-${index}`, `同名会话 ${index}`, index, index ? 'id-0' : undefined));
  const scroll = sessionSelector(crowded, 'D:/project', 'id-20', () => 16, () => ui.getTheme(), () => {}, (id) => { chosen = id; }, () => {});
  const scrolled = scroll.render(60).map(stripTerminalSequences); assert.ok(scrolled.some((line) => line.includes('[当前]')));
  scroll.handleInput?.('\x1b[B'); scroll.render(60); scroll.handleInput?.('\r'); assert.equal(chosen, 'id-19');
});
