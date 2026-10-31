import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const forkEntryType = 'local-pi-fork';
export interface ForkOrigin {
  sourceSessionId: string;
  sourceSessionFile: string;
  entryId: string;
  position: 'at';
}
export interface ForkPoint { entryId: string; role: 'user' | 'assistant'; text: string }

/** Only offer complete message boundaries, never half a tool call/result group. */
export function forkPoints(branch: readonly SessionEntry[]): ForkPoint[] {
  const pending = new Set<string>();
  const points: ForkPoint[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') pending.add(part.id);
    } else if (message.role === 'toolResult') pending.delete(message.toolCallId);
    if (pending.size || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.role === 'assistant' && message.stopReason !== 'stop') continue;
    const text = typeof message.content === 'string' ? message.content : message.content
      .filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    points.push({ entryId: entry.id, role: message.role, text: text.trim() || '（图片或无文本消息）' });
  }
  return points;
}

export function forkOrigin(branch: readonly SessionEntry[]): ForkOrigin | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== 'custom' || entry.customType !== forkEntryType) continue;
    const data = entry.data as ForkOrigin | undefined;
    if (data && typeof data.sourceSessionId === 'string' && typeof data.sourceSessionFile === 'string'
      && typeof data.entryId === 'string' && data.position === 'at') return data;
  }
  return undefined;
}
