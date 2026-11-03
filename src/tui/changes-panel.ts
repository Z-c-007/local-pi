import { renderDiff } from '@earendil-works/pi-coding-agent';
import { matchesKey, sliceByColumn, stripTerminalSequences, Text, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { snapshotExcludes, type FileChange, type FileChangeReport } from '../agent/file-changes.ts';
import type { PiUi } from './pi-ui.ts';
import { panelFrame } from './panel-frame.ts';

export const displayPath = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
const clean = (text: string) => displayPath(text).replace(/[\r\n\t]+/g, ' ');
const kinds = { added: '新增', modified: '修改', deleted: '删除', unavailable: '未知' };
type View = 'changes' | 'issues' | 'scope';
interface Hit { x: number; y: number; width: number; action: number }

/** Only certain blockers are disabled here. Live restore preflight remains authoritative. */
function blocked(report: FileChangeReport | undefined, candidates: FileChange[], direction: 'undo' | 'redo'): string | undefined {
  if (!report) return '没有本轮快照';
  if (report.status === 'running' || !report.before || !report.after || report.issues.length) return '快照未完成或记录不完整，仅可查看';
  if (!candidates.length) return direction === 'undo' ? '没有可撤销的文件' : '没有可重做的文件';
  if (candidates.some((file) => file.restoreBlocked)) return candidates.find((file) => file.restoreBlocked)!.restoreBlocked;
  if (candidates.some((file) => file.attribution !== 'tool' || !Number.isSafeInteger(file.revision))) return '修改归属未核验／旧记录，仅可查看';
  if (candidates.some((file) => file.kind === 'unavailable' || [file.before, file.after].some((state) => state && (!state.hash || !state.stamp || state.links !== 1 || state.issue)))) return '文件快照不适合自动恢复';
  return undefined;
}

/** Saved diffs and snapshot problems have distinct views; mutations always go through preview. */
export function changesPanel(reports: FileChangeReport[], height: () => number, changed: () => void, close: () => void, initialId?: string,
  requestRestore?: (reportId: string, direction: 'undo' | 'redo', path?: string) => void, getTheme?: PiUi['getTheme']): Component {
  let task = initialId ? Math.max(0, reports.findIndex((report) => report.id === initialId)) : reports.length - 1;
  let selected = 0; let listTop = 0; let view: View = 'changes'; let previousView: View = 'changes';
  const offsets: Record<View, number> = { changes: 0, issues: 0, scope: 0 };
  let listY = 0; let listRows = 0; let listWidth = 0; let diffRows = 1; let diffCount = 0;
  let actionHits: Hit[] = []; let tabHits: Hit[] = []; let feedback = '';
  let cacheKey = ''; let cacheLines: string[] = []; let cacheTheme: unknown;
  const issuesFor = (report: FileChangeReport) => [...report.issues, ...(report.observationIssues ?? [])];
  const files = () => reports[task]?.changes.filter((file) => file.kind !== 'unavailable') ?? [];
  const reset = () => { selected = 0; listTop = 0; view = previousView = 'changes'; offsets.changes = offsets.issues = offsets.scope = 0; feedback = ''; };
  const switchTask = (delta: number) => { task = Math.max(0, Math.min(reports.length - 1, task + delta)); reset(); };
  const selectFile = (index: number) => { selected = Math.max(0, Math.min(files().length - 1, index)); offsets.changes = 0; feedback = ''; };
  const switchView = (next: View) => { if (view !== 'scope') previousView = view; view = next; feedback = ''; };
  const reason = (index: number) => {
    if (view !== 'changes') return '请切回变更页选择文件';
    const direction = index < 2 ? 'undo' : 'redo'; const undone = direction === 'redo';
    const candidates = (index % 2 === 0 ? files().slice(selected, selected + 1) : reports[task]?.changes ?? []).filter((file) => (file.restoreState === 'undone') === undone);
    return blocked(reports[task], candidates, direction);
  };
  const restore = (index: number) => {
    if (!requestRestore) return;
    const why = reason(index); if (why) { feedback = why; changed(); return; }
    const report = reports[task]!;
    requestRestore(report.id, index < 2 ? 'undo' : 'redo', index % 2 === 0 ? files()[selected]?.path : undefined);
  };
  const linesFor = (width: number): string[] => {
    const report = reports[task]; const file = files()[selected]; const theme = getTheme?.();
    const key = `${task}:${view}:${selected}:${width}`;
    if (key === cacheKey && theme === cacheTheme) return cacheLines;
    cacheKey = key; cacheTheme = theme;
    let text: string;
    if (!report) text = '本会话还没有本轮文件快照。旧历史不能补造修改前的状态。\n执行模式任务或 !命令结束后会显示记录。';
    else if (view === 'scope') text = `项目：${clean(report.cwd)}\n任务：${clean(report.title)}\n${file ? `所选文件：${clean(file.path)}\n` : ''}${report.operationBased && (report.source === 'task' || report.changes.some((item) => item.attribution === 'tool')) ? '变更页来自本会话的逐次工具记录，包含完整核验的脚本变更。其他会话、外部修改和无法核验的变化保留为未归属观察。' : '只观察本轮起止之间的变化；期间外部编辑也可能包含。'}\n排除 ${snapshotExcludes.join('/')}、配置目录；不跟随链接。\n单文件 2 MiB、总大小 64 MiB、10000 条目。\n不记录数据库、远程操作或进程状态。\n自动恢复需完整快照和已核验的工具修改，确认前仍会检查当前版本。`;
    else if (view === 'issues') {
      const unknown = report.changes.filter((item) => item.kind === 'unavailable');
      const issues = issuesFor(report);
      text = `读取／范围问题：${issues.length} 项；无法判定文件：${unknown.length} 个。\n这些记录不等于已确认的文件修改。\n\n${issues.length ? issues.map((issue, i) => `${i + 1}. ${clean(issue)}`).join('\n') : '没有额外读取问题。'}${unknown.length ? `\n\n无法判定的文件：\n${unknown.map((item) => `${clean(item.path)}：${clean(item.note ?? '前后快照不完整')}`).join('\n')}` : ''}${report.observedChanges?.length ? `\n\n未归属观察（其他会话／脚本／外部编辑，仅供查看）：\n${report.observedChanges.map((item) => `${clean(item.path)} · ${kinds[item.kind]}\n${item.diff ? renderDiff(item.diff.split('\n').map(displayPath).join('\n')) : clean(item.note ?? '没有文本差异')}`).join('\n\n')}` : ''}`;
    } else if (!file) text = issuesFor(report).length || report.observedChanges?.length || report.changes.some((item) => item.kind === 'unavailable')
      ? '没有已确认的变更。\n快照不完整，不能据此判断文件未变化。\n按 2 查看快照问题，按 i 查看记录范围。'
      : '限定快照范围内未检测到文件变化。';
    else if (file.diff) {
      cacheLines = new Text(renderDiff(file.diff.split('\n').map(displayPath).join('\n')), 0, 0).render(width); return cacheLines;
    } else text = file.note ?? '无文本差异';
    cacheLines = new Text(text, 0, 0).render(width); return cacheLines;
  };
  return {
    render(width) {
      actionHits = []; tabHits = []; listRows = 0;
      const limit = Math.max(1, Math.floor(height())); const report = reports[task];
      if (width < 6 || limit < 4) return [truncateToWidth('本轮文件变更 · Esc 返回', Math.max(0, width), '')];
      const frame = panelFrame(width, getTheme); const inner = frame.inner; const confirmed = files();
      selected = Math.max(0, Math.min(confirmed.length - 1, selected)); const file = confirmed[selected];
      const unknown = report?.changes.filter((item) => item.kind === 'unavailable').length ?? 0;
      const problems = report ? issuesFor(report).length + (report.observedChanges?.length ?? 0) : 0;
      const states = { completed: '已完成', failed: '失败', aborted: '已停止', running: '未记录结束／未知' };
      const headers: string[] = [];
      if (report && limit >= 16) headers.push(frame.muted(`任务：${clean(report.title)}`));
      if (report && limit >= 8) {
        const summary = `已确认 ${confirmed.length} 个变更 · +${confirmed.reduce((n, item) => n + (item.added ?? 0), 0)} -${confirmed.reduce((n, item) => n + (item.removed ?? 0), 0)} · 快照问题 ${problems} 项${unknown ? ` · 无法判定 ${unknown} 个文件` : ''}`;
        headers.push(problems || unknown || report.status === 'running' ? frame.warning(summary) : summary);
      }
      const tabs = [`[1 变更 ${confirmed.length}]`, `[2 快照问题 ${problems}项]`, '[i 范围]'];
      const tabRow = report && limit >= 10 ? headers.length + 1 : -1;
      if (tabRow >= 0) headers.push(tabs.map((tab, i) => (['changes', 'issues', 'scope'][i] === view ? frame.accent(tab) : frame.muted(tab))).join(' '));
      const reasonRows = requestRestore && report && limit >= 14 ? 1 : 0;
      const footerDivider = limit >= 6 ? 1 : 0;
      const fixed = 2 + headers.length + (headers.length ? 1 : 0) + reasonRows + footerDivider + 1;
      const actionBudget = limit - fixed - (limit >= 12 ? 3 : 1);
      const pack = (labels: string[]) => {
        const rows: Array<Array<{ label: string; index: number; x: number }>> = []; let used = 0;
        labels.forEach((label, index) => {
          if (!rows.length || used + 1 + visibleWidth(label) > inner) { rows.push([]); used = 0; }
          const x = used ? used + 1 : 0; rows.at(-1)!.push({ label, index, x }); used = x + visibleWidth(label);
        }); return rows;
      };
      let actionRows: ReturnType<typeof pack> = [];
      if (requestRestore && report && inner >= 15 && actionBudget > 0) {
        for (const labels of [['[u 撤销此文件]', '[a 撤销本轮]', '[r 重做此文件]', '[R 重做本轮]'], ['[u 撤销]', '[a 本轮]', '[r 重做]', '[R 本轮]'], ['[u]', '[a]', '[r]', '[R]']]) {
          const packed = pack(labels); if (packed.length <= actionBudget) { actionRows = packed; break; }
        }
      }
      const bodyHeight = Math.max(1, limit - fixed - actionRows.length);
      const output = [frame.top(report ? `本轮文件变更 · ${task + 1}/${reports.length} · ${states[report.status]}` : '本轮文件变更 · 暂无记录')];
      output.push(...headers.map(frame.row)); if (headers.length) output.push(frame.divider());
      if (tabRow >= 0) {
        let x = 2; tabs.forEach((tab, action) => { tabHits.push({ x, y: tabRow, width: Math.min(visibleWidth(tab), Math.max(0, width - 2 - x)), action }); x += visibleWidth(tab) + 1; });
      }
      const wide = view === 'changes' && width >= 84;
      const split = wide ? Math.min(42, Math.max(24, Math.floor(inner * 0.34))) : 0;
      listWidth = wide ? split : inner;
      const stacked = !wide && view === 'changes' && confirmed.length && bodyHeight >= 8 ? Math.min(3, confirmed.length) : 0;
      const detailWidth = wide ? inner - split - 3 : inner;
      const detailHeight = bodyHeight - (stacked ? stacked + 2 : 0);
      const detailHeader: string[] = [];
      if (view === 'changes' && file) {
        const path = new Text(`${!wide && !stacked ? `${selected + 1}/${confirmed.length} · ` : ''}${clean(file.path)}`, 0, 0).render(detailWidth);
        const maxPathRows = detailHeight >= 6 ? 2 : 1;
        detailHeader.push(...path.slice(0, maxPathRows));
        if (path.length > maxPathRows) detailHeader[detailHeader.length - 1] = truncateToWidth(detailHeader.at(-1)!, Math.max(0, detailWidth - 1), '') + '…';
        if (detailHeight >= 4) detailHeader.push(frame.muted(file.restoreState === 'undone' ? '已撤销 · 可预览重做' : file.attribution === 'tool' ? '已核验工具修改 · 恢复前仍会检查冲突' : '归属未核验／旧记录 · 仅查看'));
      }
      diffRows = Math.max(0, detailHeight - detailHeader.length);
      const body = linesFor(detailWidth); diffCount = body.length;
      offsets[view] = Math.max(0, Math.min(offsets[view], Math.max(0, diffCount - Math.max(1, diffRows))));
      const detail = [...detailHeader, ...body.slice(offsets[view], offsets[view] + diffRows)];
      while (detail.length < detailHeight) detail.push('');
      listRows = view === 'changes' ? wide ? Math.max(0, bodyHeight - 1) : stacked : 0;
      if (selected < listTop) listTop = selected;
      if (selected >= listTop + listRows) listTop = Math.max(0, selected - listRows + 1);
      const list = confirmed.slice(listTop, listTop + listRows).map((item, i) => {
        const prefix = `${listTop + i === selected ? '▶' : ' '} ${kinds[item.kind]} `;
        const suffix = `${item.added !== undefined ? ` +${item.added} -${item.removed ?? 0}` : ''}${item.restoreState === 'undone' ? ' [已撤销]' : ''}`;
        const budget = Math.max(1, listWidth - visibleWidth(prefix + suffix)); const path = clean(item.path);
        const tail = path.split(/[\\/]/).at(-1)!;
        const shortened = visibleWidth(path) <= budget ? path : budget > 2 && visibleWidth(tail) + 2 <= budget ? `…/${tail}`
          : `…${sliceByColumn(tail, Math.max(0, visibleWidth(tail) - budget + 1), Math.max(0, budget - 1), true)}`;
        const line = prefix + shortened + suffix;
        return listTop + i === selected ? frame.selected(line, listWidth) : truncateToWidth(line, listWidth, '…', true);
      });
      listY = output.length + 1;
      if (wide) {
        for (let row = 0; row < bodyHeight; row++) {
          const left = row === 0 ? frame.muted(`文件 ${confirmed.length ? selected + 1 : 0}/${confirmed.length}`) : list[row - 1] ?? (!confirmed.length && row === 1 ? '暂无已确认变更' : '');
          output.push(frame.row(`${truncateToWidth(left, split, '…', true)} ${frame.border('│')} ${detail[row] ?? ''}`));
        }
      } else {
        if (stacked) output.push(frame.row(frame.muted(`文件 ${selected + 1}/${confirmed.length}`)), ...list.map(frame.row), frame.row(frame.border('─'.repeat(inner))));
        output.push(...detail.map(frame.row));
      }
      if (footerDivider) output.push(frame.divider());
      for (const row of actionRows) {
        const text = row.map((button) => {
          actionHits.push({ x: button.x + 2, y: output.length, width: visibleWidth(button.label), action: button.index });
          return reason(button.index) ? frame.muted(button.label) : frame.accent(button.label);
        }).join(' '); output.push(frame.row(text));
      }
      if (reasonRows) {
        const undo = reason(file?.restoreState === 'undone' ? 2 : 0);
        output.push(frame.row(frame.muted(feedback || undo || `操作先预览确认 · 差异 ${diffRows ? offsets[view] + 1 : 0}/${diffCount} 行`)));
      }
      output.push(frame.row(frame.muted('Esc 返回 · Tab 切页 · ↑↓ 文件 · PgUp/PgDn 滚动 · [ ] 轮次 · i 范围')), frame.bottom());
      return output;
    },
    invalidate() { cacheKey = ''; },
    handleInput(data) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { close(); return; }
      const action = ['u', 'a', 'r', 'R'].indexOf(data); if (action >= 0) { restore(action); return; }
      if (data === '1') switchView('changes');
      if (data === '2') switchView('issues');
      if (matchesKey(data, 'tab')) switchView(view === 'changes' ? 'issues' : 'changes');
      if (data === 'i') switchView(view === 'scope' ? previousView : 'scope');
      if (data === '[') switchTask(-1);
      if (data === ']') switchTask(1);
      if (matchesKey(data, 'up')) { if (view === 'changes') selectFile(selected - 1); else offsets[view]--; }
      if (matchesKey(data, 'down')) { if (view === 'changes') selectFile(selected + 1); else offsets[view]++; }
      if (matchesKey(data, 'pageUp')) offsets[view] -= Math.max(1, diffRows);
      if (matchesKey(data, 'pageDown')) offsets[view] += Math.max(1, diffRows);
      if (matchesKey(data, 'left')) offsets[view]--;
      if (matchesKey(data, 'right')) offsets[view]++;
      if (matchesKey(data, 'home')) offsets[view] = 0;
      if (matchesKey(data, 'end')) offsets[view] = Math.max(0, diffCount - Math.max(1, diffRows));
      changed();
    },
    handleMouse(event) {
      if (event.type === 'click' && event.button === 'left') {
        const action = actionHits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width);
        if (action) { restore(action.action); return { handled: true }; }
        const tab = tabHits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width);
        if (tab) { switchView((['changes', 'issues', 'scope'] as const)[tab.action]!); changed(); return { handled: true }; }
        if (listRows && event.y >= listY && event.y < listY + listRows && event.x >= 2 && event.x < listWidth + 2) {
          selectFile(listTop + event.y - listY); changed(); return { handled: true };
        }
      }
      if (event.type === 'wheel') {
        if (listRows && event.y >= listY && event.y < listY + listRows && event.x >= 2 && event.x < listWidth + 2) selectFile(selected + (event.wheelDelta ?? 0));
        else offsets[view] += event.wheelDelta ?? 0;
        changed(); return { handled: true };
      }
      return { handled: true };
    },
  };
}
