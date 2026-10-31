import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, BashExecutionComponent, getMarkdownTheme, truncateTail,
  type ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import {
  Container, Markdown, MouseRegion, Spacer, Text, TruncatedText, truncateToWidth, visibleWidth,
  type Component, type TUI, type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import type { SessionSlot, ToolEvent } from '../agent/session-pool.ts';
import { readTaskReports, formatTaskReport } from '../agent/task-metrics.ts';

type Message = SessionSlot['runtime']['session']['messages'][number];
type AssistantMessage = Extract<Message, { role: 'assistant' }>;
type ToolResult = Extract<Message, { role: 'toolResult' }>;
type ToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>;
export type ThinkingDisplay = 'collapsed' | 'expanded' | 'hidden';

export const thinkingLabels: Record<ThinkingDisplay, string> = { collapsed: '折叠', expanded: '展开', hidden: '隐藏' };

function plainContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part.type === 'text' ? part.text : part.type === 'image' ? '[图片]' : '').join('\n');
}

/** Align the bubble, not each text line; Markdown and Chinese still wrap naturally. */
class UserBubble implements Component {
  private readonly content: UserMessageComponent;
  constructor(text: string) {
    this.content = new UserMessageComponent(text);
  }
  invalidate(): void { this.content.invalidate(); }
  setOutputPad(padding: number): void { this.content.setOutputPad(padding); }
  render(width: number): string[] {
    const bubbleWidth = Math.max(1, Math.min(width - 2, width >= 56 ? Math.floor(width * 0.72) : width - 2, 100));
    const indent = ' '.repeat(Math.max(0, width - bubbleWidth - 1));
    if (bubbleWidth < 6) {
      return this.content.render(bubbleWidth).map((line) => `${indent}${truncateToWidth(line, bubbleWidth, '')}`);
    }
    const innerWidth = bubbleWidth - 2;
    const border = getMarkdownTheme().quoteBorder;
    const label = ' 你 ';
    const lines = [border(`╭${label}${'─'.repeat(innerWidth - visibleWidth(label))}╮`)];
    for (const line of this.content.render(innerWidth)) {
      const fitted = truncateToWidth(line, innerWidth, '');
      lines.push(`${border('│')}${fitted}${' '.repeat(Math.max(0, innerWidth - visibleWidth(fitted)))}${border('│')}`);
    }
    lines.push(border(`╰${'─'.repeat(innerWidth)}╯`));
    return [...lines.map((line) => `${indent}${line}`), ''];
  }
}

class AssistantCard extends Container {
  private readonly heading = new Text('', 1, 0);
  private readonly body = new AssistantMessageComponent(undefined, true, getMarkdownTheme(), '▶ 思考过程（点击展开）');
  private message?: AssistantMessage;
  private display: ThinkingDisplay = 'collapsed';
  private wasStreaming = false;
  constructor() {
    super();
    this.heading.setText(getMarkdownTheme().heading('助手'));
    this.addChild(this.heading);
    this.addChild(this.body);
    this.addChild(new Spacer(1));
  }
  override invalidate(): void {
    this.heading.setText(getMarkdownTheme().heading('助手'));
    super.invalidate();
  }
  setOutputPad(padding: number): void { this.body.setOutputPad(padding); }
  update(message: AssistantMessage, streaming: boolean, display: ThinkingDisplay): void {
    const modeChanged = display !== this.display;
    if (modeChanged) this.body.setHideThinkingBlock(display !== 'expanded');
    if (modeChanged || streaming || this.wasStreaming || message !== this.message) {
      this.body.updateContent(display === 'hidden'
        ? { ...message, content: message.content.filter((part) => part.type !== 'thinking') } : message, streaming);
    }
    this.display = display;
    this.message = message;
    this.wasStreaming = streaming;
  }
}

/** One compact row per call, with the SDK's full rendering behind its disclosure. */
class ToolCard extends Container {
  private readonly body: ToolExecutionComponent;
  private expanded: boolean;
  private call: ToolCall;
  private result?: ToolResult;
  private event?: ToolEvent;
  private status = '准备中';
  private argsKey?: string;
  private wasIdle?: boolean;
  private readonly onChange: () => void;

  constructor(call: ToolCall, slot: SessionSlot, tui: TUI, expanded: boolean, onChange: () => void) {
    super();
    this.call = call;
    this.expanded = expanded;
    this.onChange = onChange;
    const session = slot.runtime.session;
    const definition: ToolRenderers = session.extensionRunner?.resolveToolRenderers(call.name,
      () => session.getToolDefinition(call.name)) ?? {};
    this.body = new ToolExecutionComponent(call.name, call.id, call.arguments,
      { showImages: false }, definition, tui, slot.runtime.cwd);
    this.body.setExpanded(true);
  }
  applySettings(settings: SessionSlot['runtime']['services']['settingsManager']): void {
    this.body.setShowImages(settings.getShowImages());
    this.body.setImageWidthCells(settings.getImageWidthCells());
    this.body.setOutputPad(settings.getOutputPad());
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.rebuild();
  }
  override invalidate(): void {
    this.rebuild();
    super.invalidate();
  }

  update(call: ToolCall, result: ToolResult | undefined, event: ToolEvent | undefined, idle: boolean): void {
    const argsKey = JSON.stringify(call.arguments);
    if (argsKey === this.argsKey && result === this.result && event === this.event && idle === this.wasIdle) return;
    this.argsKey = argsKey;
    this.wasIdle = idle;
    this.call = call;
    this.result = result;
    this.event = event;
    this.body.updateArgs(call.arguments);
    if (event) this.body.markExecutionStarted();
    if (result) this.body.updateResult(result);
    else if (event?.type === 'tool_execution_end') {
      this.body.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
    } else if (event?.type === 'tool_execution_update' && event.partialResult?.content) {
      this.body.updateResult({ ...event.partialResult, isError: false }, true);
    }
    const failed = result?.isError || (event?.type === 'tool_execution_end' && event.isError);
    this.status = result || event?.type === 'tool_execution_end' ? failed ? '失败' : '完成'
      : idle ? '未完成 / 已停止' : event ? '运行中' : '准备中';
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const args = this.call.arguments ?? {};
    const subject = [args.path, args.command, args.pattern, args.query].find((value) => typeof value === 'string') ?? '';
    const duration = this.result?.durationMs ?? (this.event?.type === 'tool_execution_end' ? this.event.durationMs : undefined);
    const title = `${this.expanded ? '▼' : '▶'} ${this.call.name} · ${this.status}${duration !== undefined ? ` · ${(duration / 1000).toFixed(1)}s` : ''}  ${String(subject).replace(/\s+/g, ' ')}`;
    const heading = new TruncatedText(getMarkdownTheme().link(title), 1, 0);
    this.addChild(new MouseRegion(heading, (event) => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      this.setExpanded(!this.expanded);
      this.onChange();
      return { handled: true };
    }));
    if (this.expanded) {
      // The title owns disclosure; the body remains selectable instead of toggling on every click.
      this.addChild({ render: (width) => this.body.render(width), invalidate: () => this.body.invalidate() });
    }
    this.addChild(new Spacer(1));
  }
}

export class Transcript extends Container {
  thinking: ThinkingDisplay = 'collapsed';
  toolsExpanded = false;
  private readonly slot: SessionSlot;
  private readonly tui: TUI;
  private readonly onInteraction: () => void;
  private revision = -1;
  private readonly cards = new Map<string, Component>();
  private shellOffset = 0;
  applySettings(): void {
    for (const card of this.cards.values()) this.configureCard(card);
    this.revision = -1;
  }
  private configureCard(card: Component): void {
    const settings = this.slot.runtime.services.settingsManager;
    if (card instanceof ToolCard) card.applySettings(settings);
    else if (card instanceof UserBubble || card instanceof AssistantCard || card instanceof BashExecutionComponent) card.setOutputPad(settings.getOutputPad());
  }

  resetHistory(): void {
    for (const card of this.cards.values()) if (card instanceof BashExecutionComponent) card.setComplete(undefined, true);
    this.cards.clear(); this.revision = -1;
  }

  resetTheme(): void {
    // Native Markdown colors read Pi's live theme. Invalidate caches while
    // retaining the native per-block thinking and tool disclosure state.
    for (const [key, card] of this.cards) {
      if (key.startsWith('report:')) this.cards.delete(key);
      else card.invalidate();
    }
    this.revision = -1;
  }

  constructor(slot: SessionSlot, tui: TUI, onInteraction: () => void) {
    super();
    this.slot = slot;
    this.tui = tui;
    this.onInteraction = onInteraction;
  }

  setThinking(display?: ThinkingDisplay): void {
    const modes: ThinkingDisplay[] = ['collapsed', 'expanded', 'hidden'];
    this.thinking = display ?? modes[(modes.indexOf(this.thinking) + 1) % modes.length]!;
    this.revision = -1;
    this.onInteraction();
  }

  setToolsExpanded(expanded = !this.toolsExpanded): void {
    this.toolsExpanded = expanded;
    for (const card of this.cards.values()) if (card instanceof ToolCard) card.setExpanded(expanded);
    for (const card of this.cards.values()) if (card instanceof BashExecutionComponent) card.setExpanded(expanded);
    this.onInteraction();
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container['handleMouse']> {
    const result = super.handleMouse(event);
    if (result?.handled && event.type === 'click') this.onInteraction();
    return result;
  }

  private sync(): void {
    if (this.revision === this.slot.revision) return;
    this.revision = this.slot.revision;
    const messages = [...this.slot.runtime.session.messages];
    const streaming = this.slot.streaming;
    if (streaming && !messages.some((message) => message.role === 'assistant' && message.timestamp === streaming.timestamp)) {
      messages.push(streaming);
    } else if (streaming) {
      const index = messages.findIndex((message) => message.role === 'assistant' && message.timestamp === streaming.timestamp);
      messages[index] = streaming;
    }
    const results = new Map(messages.filter((message): message is ToolResult => message.role === 'toolResult')
      .map((message) => [message.toolCallId, message]));
    const calls = new Set(messages.flatMap((message) => message.role === 'assistant'
      ? message.content.filter((part): part is ToolCall => part.type === 'toolCall').map((call) => call.id) : []));
    const used = new Set<string>();
    const reports = readTaskReports(this.slot.runtime.session).filter((report) => report.id !== this.slot.metrics?.current?.id);
    const displayedReports = new Set<string>();
    const currentAssistants = new Set<string>();
    this.clear();
    const add = (key: string, create: () => Component) => {
      let card = this.cards.get(key);
      if (!card) { card = create(); this.configureCard(card); this.cards.set(key, card); }
      used.add(key);
      this.addChild(card);
      return card;
    };
    messages.forEach((message, index) => {
      if (message.role === 'system' || (message.role === 'custom' && !message.display)) return;
      const key = `${index}:${message.role}:${message.timestamp}`;
      if (message.role === 'user') add(key, () => new UserBubble(plainContent(message.content)));
      else if (message.role === 'assistant') {
        currentAssistants.add(key);
        const hasText = message.content.some((part) => part.type === 'text' && part.text.trim()
          || part.type === 'thinking' && part.thinking.trim() && this.thinking !== 'hidden');
        if (hasText || ['error', 'aborted', 'length'].includes(message.stopReason)) {
          const card = add(key, () => new AssistantCard()) as AssistantCard;
          card.update(message, message === streaming, this.thinking);
        }
        for (const call of message.content.filter((part): part is ToolCall => part.type === 'toolCall')) {
          const card = add(`tool:${call.id}`, () => new ToolCard(call, this.slot, this.tui, this.toolsExpanded, this.onInteraction)) as ToolCard;
          card.update(call, results.get(call.id), this.slot.toolEvents.get(call.id), this.slot.runtime.session.isIdle);
        }
      } else if (message.role === 'toolResult') {
        if (!calls.has(message.toolCallId)) {
          const call: ToolCall = { type: 'toolCall', id: message.toolCallId, name: message.toolName, arguments: {} };
          const card = add(`tool:${call.id}`, () => new ToolCard(call, this.slot, this.tui, this.toolsExpanded, this.onInteraction)) as ToolCard;
          card.update(call, message, this.slot.toolEvents.get(call.id), true);
        }
      } else if (message.role === 'bashExecution') {
        add(key, () => {
          const card = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
          card.appendOutput(message.output); card.setExpanded(this.toolsExpanded);
          card.setComplete(message.exitCode, message.cancelled, message.truncated ? { ...truncateTail(message.output), truncated: true } : undefined, message.fullOutputPath);
          return card;
        });
      } else {
        const text = plainContent('content' in message ? message.content : '');
        if (text.trim()) add(key, () => new Markdown(`**通知**\n\n${text}`, 1, 0, getMarkdownTheme()));
      }
      for (const report of reports.filter((report) => report.afterTimestamp === message.timestamp)) {
        displayedReports.add(report.id);
        add(`report:${report.id}`, () => new Text(getMarkdownTheme().quote(formatTaskReport(report)), 1, 1));
      }
    });
    if (this.slot.shell) {
      const shell = this.slot.shell;
      const card = add(`shell:${shell.startedAt}`, () => {
        this.shellOffset = 0;
        return new BashExecutionComponent(shell.command, this.tui, shell.excludeFromContext);
      }) as BashExecutionComponent;
      card.appendOutput(shell.output.slice(this.shellOffset)); this.shellOffset = shell.output.length;
      card.setExpanded(this.toolsExpanded);
    }
    for (const report of reports.filter((report) => !displayedReports.has(report.id))) {
      add(`report:${report.id}`, () => new Text(getMarkdownTheme().quote(formatTaskReport(report)), 1, 1));
    }
    // Keep hidden thinking cards, so switching back from hidden restores per-message overrides.
    for (const [key, card] of this.cards) if (!used.has(key) && !currentAssistants.has(key)) {
      if (card instanceof BashExecutionComponent) card.setComplete(undefined, true);
      this.cards.delete(key);
    }
    if (!this.children.length) this.addChild(new Text('新会话默认只读讨论。输入任务开始；/execute 开放修改。', 1, 1));
  }

  override render(width: number): string[] {
    this.sync();
    return super.render(width);
  }
}
