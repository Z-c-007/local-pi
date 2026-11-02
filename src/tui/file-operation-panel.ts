import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import type { PiUi } from './pi-ui.ts';
import { panelFrame } from './panel-frame.ts';

/** Bounded preview with fixed footer. Only the explicit confirmation button can apply files. */
export function fileOperationPanel(content: string, enabled: boolean, height: () => number, getTheme: PiUi['getTheme'],
  changed: () => void, confirm: () => void, cancel: () => void): Component {
  const heading = content.match(/^# ([^\n]+)\n/);
  const title = heading?.[1] ?? '文件恢复预览';
  const markdown = new Markdown(heading ? content.slice(heading[0].length).trimStart() : content, 0, 0, getMarkdownTheme());
  let offset = 0; let rows = 1; let count = 0;
  let buttonRow = -1; let confirmWidth = 0; let cancelX = -1; let cancelWidth = 0;
  return {
    render(width) {
      const limit = Math.max(1, Math.floor(height())); buttonRow = -1; confirmWidth = cancelWidth = 0; cancelX = -1;
      if (width < 6 || limit < 4) return [truncateToWidth(`${title} · Esc 取消`, Math.max(0, width), '')];
      const frame = panelFrame(width, getTheme);
      const showHelp = limit >= 8; const showDivider = limit >= 6;
      rows = Math.max(1, limit - 2 - 1 - Number(showHelp) - Number(showDivider));
      const body = markdown.render(frame.inner); count = body.length;
      offset = Math.max(0, Math.min(offset, Math.max(0, count - rows)));
      const output = [frame.top(title), ...body.slice(offset, offset + rows).map(frame.row)];
      while (output.length < rows + 1) output.push(frame.row(''));
      if (showDivider) output.push(frame.divider());
      buttonRow = output.length;
      const confirmLabel = '[Enter 确认执行]'; const cancelLabel = '[Esc 取消]';
      confirmWidth = enabled && frame.inner >= visibleWidth(confirmLabel) ? visibleWidth(confirmLabel) : 0;
      cancelX = confirmWidth && frame.inner >= confirmWidth + 2 + visibleWidth(cancelLabel) ? 2 + confirmWidth + 2 : !enabled ? 2 : -1;
      cancelWidth = cancelX >= 0 ? Math.min(visibleWidth(cancelLabel), Math.max(0, width - 2 - cancelX)) : 0;
      output.push(frame.row(enabled
        ? `${frame.accent(confirmLabel)}${cancelX >= 0 ? `  ${cancelLabel}` : ''}`
        : `${frame.muted(cancelLabel)} · 存在冲突，未修改文件`));
      if (showHelp) output.push(frame.row(frame.muted(`Esc 取消 · ↑↓ / PgUp PgDn 滚动 · ${Math.min(offset + 1, count)}/${count} 行`)));
      output.push(frame.bottom()); return output;
    },
    invalidate() { markdown.invalidate(); },
    handleInput(data) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { cancel(); return; }
      if (matchesKey(data, 'enter')) { if (enabled && confirmWidth) confirm(); return; }
      if (matchesKey(data, 'up')) offset--;
      if (matchesKey(data, 'down')) offset++;
      if (matchesKey(data, 'pageUp')) offset -= rows;
      if (matchesKey(data, 'pageDown')) offset += rows;
      if (matchesKey(data, 'home')) offset = 0;
      if (matchesKey(data, 'end')) offset = Math.max(0, count - rows);
      changed();
    },
    handleMouse(event) {
      if (event.type === 'wheel') { offset += event.wheelDelta ?? 0; changed(); return { handled: true }; }
      if (event.type === 'click' && event.button === 'left' && event.y === buttonRow) {
        if (enabled && confirmWidth && event.x >= 2 && event.x < 2 + confirmWidth) confirm();
        else if (cancelWidth && event.x >= cancelX && event.x < cancelX + cancelWidth) cancel();
      }
      return { handled: true };
    },
  };
}
