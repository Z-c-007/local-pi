import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { FileChange, FileChangeReport } from '../src/agent/file-changes.ts';
import { changesPanel } from '../src/tui/changes-panel.ts';
import { fileOperationPanel } from '../src/tui/file-operation-panel.ts';
import { loadPiUi } from '../src/tui/pi-ui.ts';

const state = { hash: 'a'.repeat(64), size: 4, mode: 0o100644, stamp: 'fixture', links: 1 };
const file = (path: string): FileChange => ({ path, kind: 'modified', attribution: 'tool', revision: 1,
  before: state, after: { ...state, hash: 'b'.repeat(64) }, added: 1, removed: 1,
  diff: '-1 OLD_LINE\n' + Array.from({ length: 100 }, (_, i) => `+${i + 1} NEW_LINE_${i + 1}`).join('\n') });
const report = (changes: FileChange[], issues: string[] = []): FileChangeReport => ({ version: 1, id: 'fixture', sessionId: 'source',
  cwd: 'D:/project/workspace', title: '确认后修改页面布局', status: 'completed', source: 'task', startedAt: 1,
  before: { files: {}, skipped: [], issues: [] }, after: { files: {}, skipped: [], issues: [] }, changes, issues });
const plain = (panel: Component, width = 110) => panel.render(width).map(stripTerminalSequences);
const mouse = (x: number, y: number, width = 110, height = 26): TuiMouseEvent => ({ type: 'click', button: 'left', x, y,
  screenX: x, screenY: y, width, height, ctrl: false, alt: false, shift: false });

test('changes frame separates incomplete snapshots, keeps all problems accessible and disables unavailable restores', async () => {
  initTheme('dark', false); const ui = await loadPiUi(); let called = false;
  const problems = Array.from({ length: 3888 }, (_, i) => `PROBLEM_${i + 1}：超过 2 MiB`);
  const unknown: FileChange[] = Array.from({ length: 40 }, (_, i) => ({ path: `UNKNOWN_FILE_${i + 1}`, kind: 'unavailable', note: '前后快照不完整' }));
  const data = report(unknown, problems); const original = JSON.stringify(data);
  const panel = changesPanel([data], () => 26, () => {}, () => {}, data.id, () => { called = true; }, () => ui.getTheme());
  let lines = plain(panel);
  assert.ok(lines[0]?.startsWith('╭')); assert.ok(lines.at(-1)?.endsWith('╯'));
  assert.ok(lines.some((line) => line.includes('已确认 0 个变更')));
  assert.ok(lines.some((line) => line.includes('快照问题 3888 项')));
  assert.ok(lines.some((line) => line.includes('不能据此判断文件未变化')));
  assert.ok(!lines.some((line) => line.includes('UNKNOWN_FILE_')));
  for (const key of ['u', 'a', 'r', 'R']) panel.handleInput?.(key);
  const buttonY = lines.findIndex((line) => line.includes('[u 撤销此文件]'));
  panel.handleMouse?.(mouse(3, buttonY)); assert.equal(called, false);
  panel.handleInput?.('2'); lines = plain(panel);
  assert.ok(lines.some((line) => line.includes('PROBLEM_1')));
  panel.handleInput?.('\x1b[F'); lines = plain(panel);
  assert.ok(lines.some((line) => line.includes('UNKNOWN_FILE_40')), 'last problem remains reachable');
  panel.handleInput?.('i'); lines = plain(panel);
  assert.ok(lines.some((line) => line.includes('workspace')));
  panel.handleInput?.('i'); panel.handleInput?.('1');
  assert.ok(plain(panel).some((line) => line.includes('没有已确认的变更')));
  assert.equal(JSON.stringify(data), original); assert.equal(called, false);
});

test('file selection, sticky diff header, compact action targets and bounded layouts survive resizing and themes', async () => {
  initTheme('dark', false); const ui = await loadPiUi(); let height = 26; let action = ''; let closed = false;
  const data = report([{ path: 'UNKNOWN_FIRST', kind: 'unavailable' }, file('src/first.ts'), file('src/second.ts')]);
  const panel = changesPanel([data], () => height, () => {}, () => { closed = true; }, data.id,
    (_id, direction, path) => { action = `${direction}:${path}`; }, () => ui.getTheme());
  let lines = plain(panel); const originalHeader = lines[0];
  const selectedRow = panel.render(110).find((line) => stripTerminalSequences(line).includes('▶'))!;
  assert.ok(selectedRow.includes(ui.getTheme().getBgAnsi('selectedBg')));
  panel.handleInput?.('\x1b[6~'); lines = plain(panel);
  assert.equal(lines[0], originalHeader); assert.ok(lines.some((line) => line.includes('src/first.ts')));
  assert.ok(!lines.some((line) => line.includes('NEW_LINE_1 ')), 'diff scrolls independently of header');
  const secondY = lines.findIndex((line) => line.includes('修改 src/second.ts'));
  panel.handleMouse?.(mouse(5, secondY)); lines = plain(panel);
  const actionRow = lines.findIndex((line) => line.includes('[u 撤销此文件]'));
  panel.handleMouse?.(mouse(3, actionRow)); assert.equal(action, 'undo:src/second.ts');
  action = ''; panel.handleInput?.('a'); assert.equal(action, '', 'unknown files also block whole-task restore');
  for (const scheme of ['dark', 'light']) {
    initTheme(scheme, false);
    for (height of [4, 6, 8, 10, 14, 16, 24, 35]) for (const width of [6, 16, 24, 40, 83, 84, 110]) {
      const rendered = panel.render(width);
      assert.ok(rendered.length <= height, `${scheme} ${width}x${height}: ${rendered.length}`);
      assert.ok(rendered.every((line) => visibleWidth(line) === width), `${scheme} ${width}x${height}`);
      assert.ok(stripTerminalSequences(rendered.at(-1)!).endsWith('╯'));
    }
  }
  height = 26; plain(panel); panel.handleInput?.('u'); assert.equal(action, 'undo:src/second.ts');
  data.changes[2]!.restoreState = 'undone'; panel.handleInput?.('r'); assert.equal(action, 'redo:src/second.ts');
  action = ''; plain(panel); panel.handleMouse?.(mouse(109, 25)); assert.equal(action, '', 'border clicks never request restore');
  panel.handleInput?.('\x1b'); assert.equal(closed, true);
});

test('restore preview preserves scrollable content and only its explicit enabled confirmation applies files', async () => {
  initTheme('dark', false); const ui = await loadPiUi(); let height = 20; let applied = 0; let cancelled = 0;
  const content = '# 撤销预览\n\n' + Array.from({ length: 100 }, (_, i) => `- src/FILE_${i + 1}.ts`).join('\n');
  const panel = fileOperationPanel(content, true, () => height, () => ui.getTheme(), () => {}, () => { applied++; }, () => { cancelled++; });
  let lines = plain(panel); const first = lines[0];
  const y = lines.findIndex((line) => line.includes('[Enter 确认执行]'));
  panel.handleMouse?.(mouse(109, y)); panel.handleMouse?.(mouse(3, y + 1)); panel.handleMouse?.(mouse(3, 19));
  assert.equal(applied, 0, 'footer whitespace and border are not a confirmation button');
  const cancelX = visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf('[Esc 取消]')));
  panel.handleMouse?.(mouse(cancelX + 1, y)); assert.equal(cancelled, 1);
  panel.handleInput?.('\x1b[F'); lines = plain(panel); assert.equal(lines[0], first); assert.ok(lines.some((line) => line.includes('FILE_100')));
  panel.handleMouse?.(mouse(3, y)); assert.equal(applied, 1);
  for (height of [4, 6, 8, 20]) for (const width of [6, 24, 40, 110]) {
    const rendered = panel.render(width); assert.ok(rendered.length <= height);
    assert.ok(rendered.every((line) => visibleWidth(line) === width));
  }
  panel.render(4); panel.handleInput?.('\r'); assert.equal(applied, 1, 'no confirmation when button cannot be displayed');
  const denied = fileOperationPanel('# 撤销预览\n\n当前文件有后续修改', false, () => 20, () => ui.getTheme(), () => {}, () => { applied++; }, () => {});
  const disabled = plain(denied); assert.ok(disabled.some((line) => line.includes('存在冲突')));
  denied.handleInput?.('\r'); denied.handleMouse?.(mouse(3, disabled.length - 3)); assert.equal(applied, 1);
});

test('operation-owned files can be restored despite unrelated observation limits; observed diffs remain view-only', async () => {
  initTheme('dark', false); const ui = await loadPiUi(); let called = false;
  const data = report([file('own.ts')]); data.operationBased = true;
  data.observationIssues = ['external.pdf: 文件超过 2 MiB'];
  data.observedChanges = [{ ...file('foreign.ts'), attribution: 'ambiguous', diff: '-1 FOREIGN_BEFORE\n+1 FOREIGN_AFTER' }];
  const panel = changesPanel([data], () => 30, () => {}, () => {}, data.id, () => { called = true; }, () => ui.getTheme());
  const main = plain(panel).join('\n'); assert.match(main, /own.ts/); assert.doesNotMatch(main, /foreign.ts/);
  panel.handleInput?.('u'); assert.equal(called, true); called = false;
  panel.handleInput?.('2'); const observed = plain(panel).join('\n');
  assert.match(observed, /未归属观察/); assert.match(observed, /foreign.ts/); assert.match(observed, /FOREIGN_AFTER/);
  panel.handleInput?.('u'); panel.handleInput?.('a'); assert.equal(called, false, 'observations never trigger undo');
});
