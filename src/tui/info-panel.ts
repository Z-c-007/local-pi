import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';

/** Read-only, scrollable host page. Never enters the model's message history. */
export function infoPanel(content: () => string, height: () => number, changed: () => void, close: () => void): Component {
  let offset = 0; let count = 0; let previous = ''; let body = new Markdown('', 1, 0, getMarkdownTheme());
  return {
    render(width) {
      const text = content();
      if (text !== previous) { previous = text; body = new Markdown(text, 1, 0, getMarkdownTheme()); }
      const lines = body.render(width); count = lines.length;
      const rows = Math.max(1, height() - 2);
      offset = Math.min(offset, Math.max(0, count - rows));
      return [...lines.slice(offset, offset + rows), '', truncateToWidth(' ↑↓ / PgUp PgDn 滚动 · Esc 关闭', width, '')];
    },
    invalidate() { body.invalidate(); },
    handleInput(data) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { close(); return; }
      const step = Math.max(1, height() - 3);
      if (matchesKey(data, 'up')) offset = Math.max(0, offset - 1);
      if (matchesKey(data, 'down')) offset++;
      if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - step);
      if (matchesKey(data, 'pageDown')) offset += step;
      if (matchesKey(data, 'home')) offset = 0;
      if (matchesKey(data, 'end')) offset = count;
      changed();
    },
  };
}
