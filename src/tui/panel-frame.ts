import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { PiUi } from './pi-ui.ts';

/** One opaque, padded frame shared by host dialogs. Child ANSI diff colors survive. */
export function panelFrame(width: number, getTheme?: PiUi['getTheme']) {
  const theme = getTheme?.(); const markdown = getMarkdownTheme();
  const inner = Math.max(0, width - 4);
  const border = (text: string) => theme?.fg('borderAccent', text) ?? markdown.quoteBorder(text);
  const fill = (text: string) => theme ? theme.bg('customMessageBg', text
    .replaceAll('\x1b[0m', `\x1b[0m${theme.getBgAnsi('customMessageBg')}`)
    .replaceAll('\x1b[49m', theme.getBgAnsi('customMessageBg'))) : text;
  const edge = (left: string, text: string, right: string) => {
    const fitted = truncateToWidth(text, Math.max(0, width - 2), '');
    return fill(border(left + fitted + '─'.repeat(Math.max(0, width - 2 - visibleWidth(fitted))) + right));
  };
  return {
    inner, border,
    top: (title: string) => edge('╭', ` ${title} `, '╮'),
    divider: () => edge('├', '', '┤'),
    bottom: () => edge('╰', '', '╯'),
    row: (text: string) => fill(`${border('│')} ${truncateToWidth(text, inner, '…', true)} ${border('│')}`),
    muted: (text: string) => theme?.fg('muted', text) ?? markdown.quote(text),
    warning: (text: string) => theme?.fg('warning', text) ?? markdown.heading(text),
    accent: (text: string) => theme?.fg('accent', text) ?? markdown.heading(text),
    selected: (text: string, cells: number) => {
      const fitted = truncateToWidth(text, cells, '…', true);
      return theme?.style(fitted, { fg: 'accent', bg: 'selectedBg', bold: true }) ?? markdown.heading(fitted);
    },
  };
}
