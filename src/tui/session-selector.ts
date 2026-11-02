import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { SelectList, Text, truncateToWidth, type Component, type SelectItem, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { SessionListEntry } from '../agent/session-pool.ts';
import type { PiUi } from './pi-ui.ts';
import { displayPath } from './changes-panel.ts';
import { panelFrame } from './panel-frame.ts';

interface SessionRow { entry: SessionListEntry; prefix: string }
const states = { idle: '空闲', running: '运行中', waiting: '等待处理', error: '失败' };
const clean = (value: string) => displayPath(value).replace(/[\r\n\t]+/g, ' ');
const title = (entry: SessionListEntry) => clean(entry.hasConversation ? entry.name || entry.title || '会话' : `临时草稿 · ${entry.name || '未发送'}`);

/** Group by persisted fork identity, regardless of identical titles or update order. */
export function sessionTree(entries: SessionListEntry[]): SessionRow[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string, SessionListEntry[]>();
  const roots: SessionListEntry[] = [];
  const newest = new Map(entries.map((entry) => [entry.id, entry.modified]));
  const compare = (a: SessionListEntry, b: SessionListEntry) => (newest.get(b.id)! - newest.get(a.id)!) || a.id.localeCompare(b.id);
  for (const entry of byId.values()) {
    const parent = entry.fork?.sourceSessionId;
    if (parent && parent !== entry.id && byId.has(parent)) {
      const siblings = children.get(parent) ?? []; siblings.push(entry); children.set(parent, siblings);
    } else roots.push(entry);
    // Recent activity brings the family forward without moving a child above its parent.
    const seen = new Set([entry.id]); let ancestor = parent;
    while (ancestor && !seen.has(ancestor) && byId.has(ancestor)) {
      seen.add(ancestor); newest.set(ancestor, Math.max(newest.get(ancestor)!, entry.modified));
      ancestor = byId.get(ancestor)!.fork?.sourceSessionId;
    }
  }
  roots.sort(compare); for (const siblings of children.values()) siblings.sort(compare);
  const result: SessionRow[] = []; const visited = new Set<string>();
  const walk = (root: SessionListEntry) => {
    const stack = [{ entry: root, ancestors: [] as boolean[], branch: '' }];
    while (stack.length) {
      const { entry, ancestors, branch } = stack.pop()!; if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      const prefix = (ancestors.length > 4 ? '… ' : '') + ancestors.slice(-4).map((more) => more ? '│  ' : '   ').join('') + branch;
      result.push({ entry, prefix });
      const nested = children.get(entry.id) ?? [];
      for (let i = nested.length - 1; i >= 0; i--) stack.push({ entry: nested[i]!,
        ancestors: branch ? [...ancestors, branch === '├─ '] : [], branch: i === nested.length - 1 ? '└─ ' : '├─ ' });
    }
  };
  for (const root of roots) walk(root);
  // Missing parents and malformed legacy cycles never hide a selectable conversation.
  for (const entry of [...byId.values()].sort(compare)) if (!visited.has(entry.id)) walk(entry);
  return result;
}

/** Native selection/navigation, with a bounded framed view and fork-family layout. */
export function sessionSelector(entries: SessionListEntry[], cwd: string, currentId: string,
  height: () => number, getTheme: PiUi['getTheme'], changed: () => void,
  select: (id: string) => void, cancel: () => void): Component {
  const rows = sessionTree(entries);
  let list: SelectList | undefined; let capacity = 0; let itemSignature = ''; let listWidth = 1; let listTop = 0; let listHeight = 0;
  let selectedId = rows.some((row) => row.entry.id === currentId) ? currentId : rows[0]?.entry.id;
  const badges = (entry: SessionListEntry) => [entry.id === currentId ? '[当前]' : '',
    `[${entry.live?.waitingOperations?.size ? '排队中' : entry.live ? states[entry.live.state] : '历史'}]`, entry.live?.unread ? '[未读]' : '', entry.fork ? '[分叉]' : ''].filter(Boolean).join(' ');
  const makeItems = (): SelectItem[] => rows.map(({ entry, prefix }) => ({ value: entry.id,
    // Put identity/status first so narrow terminals retain the distinction too.
    label: `${prefix}${entry.live && entry.hasConversation ? `${entry.live.number} ` : ''}${entry.id === currentId ? '[当前] ' : ''}${title(entry)}`,
    description: badges(entry).replace('[当前]', '').trim(),
  }));
  const ensureList = (maxVisible: number) => {
    const items = makeItems(); const signature = JSON.stringify(items);
    if (list && maxVisible === capacity && signature === itemSignature) return;
    capacity = maxVisible; itemSignature = signature;
    list = new SelectList(items, capacity, { ...getSelectListTheme(),
      selectedText: (line) => getTheme().style(truncateToWidth(line.replace(/^→ /, '▶ '), listWidth, '', true), { fg: 'accent', bg: 'selectedBg', bold: true }),
    }, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 60 });
    list.setSelectedIndex(Math.max(0, rows.findIndex((row) => row.entry.id === selectedId)));
    list.onSelectionChange = (item) => { selectedId = item.value; changed(); };
    list.onSelect = (item) => select(item.value); list.onCancel = cancel;
  };
  return {
    render(width) {
      const theme = getTheme(); const limit = Math.max(1, Math.floor(height()));
      const selected = rows.find((row) => row.entry.id === selectedId)?.entry;
      if (width < 6 || limit < 4) { ensureList(1); listHeight = 0; return [truncateToWidth('会话列表 · Esc 取消', Math.max(0, width), '')]; }
      const inner = width - 4; listWidth = inner;
      const details: string[] = [];
      if (selected && limit >= 16) {
        const full = new Text(`所选：${title(selected)}`, 0, 0).render(inner);
        details.push(...full.slice(0, 2));
        if (full.length > 2) details[details.length - 1] = truncateToWidth(details.at(-1)!, Math.max(0, inner - 1), '') + '…';
        details.push(`${badges(selected)} · ${new Date(selected.modified).toLocaleString('zh-CN', { hour12: false })}`,
          selected.fork ? `分叉自 ${clean(selected.fork.sourceSessionId)}${entries.some((entry) => entry.id === selected.fork!.sourceSessionId) ? '' : '（来源未列出）'}` : '来源：独立会话',
          `ID：${clean(selected.id)}`);
        if (selected.cwd !== cwd) details.push(`目录：${clean(selected.cwd)}`);
        const waiting = selected.live?.waitingOperations?.values().next().value;
        if (waiting) details.push(clean(waiting));
      } else if (selected && limit >= 10) details.push(`所选：${badges(selected)} · ${clean(selected.id.slice(0, 8))}`);
      const header = limit >= 8 ? [`项目：${clean(cwd)} · 共 ${rows.length} 个会话`] : [];
      // Reserve borders, separators, detail lines and native scroll information before rendering the list.
      const fixed = 2 + header.length + (header.length ? 1 : 0) + (details.length ? details.length + 1 : 0) + 1;
      const available = Math.max(1, limit - fixed);
      const max = Math.max(1, Math.min(12, rows.length || 1, available - (rows.length > Math.min(12, available) ? 1 : 0)));
      ensureList(max);
      const listLines = list!.render(inner).slice(0, available); listHeight = listLines.length;
      const frame = panelFrame(width, getTheme); const content = frame.row;
      const output = [frame.top('会话列表 · 当前项目历史和已打开会话')];
      for (const line of header) output.push(content(theme.fg('muted', line)));
      if (header.length) output.push(frame.divider());
      listTop = output.length;
      output.push(...listLines.map(content));
      if (details.length) { output.push(frame.divider()); output.push(...details.map(content)); }
      const index = Math.max(0, rows.findIndex((row) => row.entry.id === selectedId)) + 1;
      output.push(content(theme.fg('muted', `↑↓ 选择 · Enter 切换 · Esc 取消 · ${index}/${rows.length} · 切换不会停止后台任务`)), frame.bottom());
      return output;
    },
    invalidate() { list?.invalidate(); },
    handleInput(data) { list?.handleInput(data); },
    handleMouse(event: TuiMouseEvent) {
      if (!list || event.x < 2 || event.x >= event.width - 2 || event.y < listTop || event.y >= listTop + listHeight) return { handled: true };
      return list.handleMouse({ ...event, x: event.x - 2, y: event.y - listTop, width: listWidth, height: listHeight });
    },
  };
}
