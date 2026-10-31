import {
  CustomEditor, getMarkdownTheme,
  type WorkingIndicatorOptions,
} from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER, Loader, getKeybindings, truncateToWidth,
  type EditorTheme, type TUI,
} from '@earendil-works/pi-tui';
import type { SessionSlot } from '../agent/session-pool.ts';
import { formatDuration } from '../agent/task-metrics.ts';

/** The public Loader supplies the animation; CustomEditor supplies Pi's native border layout. */
class WorkingIndicator extends Loader {
  readonly kind = 'working';
  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? '';
    return truncateToWidth(line.startsWith(' ') ? line.slice(1).trimEnd() : line.trimEnd(), width, '');
  }
  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, '');
  }
  dispose(): void { this.stop(); }
}

export class SessionEditor extends CustomEditor {
  secret = false;
  constructor(tui: TUI, theme: EditorTheme) {
    // 1.3.0's public CustomEditor types name a non-exported coding-agent manager.
    // Its editor only uses matches(); pass the public pi-tui manager without private imports.
    super(tui, theme, getKeybindings() as ConstructorParameters<typeof CustomEditor>[2], { embedWorkingStatus: true });
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.secret) return lines;
    return [lines[0] ?? '', ` ${'●'.repeat(Math.min(this.getText().length, Math.max(0, width - 4)))}${CURSOR_MARKER}`, lines.at(-1) ?? ''];
  }
}

/** UI preferences and animation belong to one view; the SDK task lives in the session pool. */
export class SessionWorking {
  private readonly editor: SessionEditor;
  private readonly tui: TUI;
  private loader?: WorkingIndicator;
  private message?: string;
  private visible = true;
  private options?: WorkingIndicatorOptions;
  private lastMessage?: string;
  private staticIndicator = false;

  constructor(editor: SessionEditor, tui: TUI) { this.editor = editor; this.tui = tui; }

  setMessage(message?: string): void { this.message = message; }
  setVisible(visible: boolean): void { this.visible = visible; }
  setIndicator(options?: WorkingIndicatorOptions): void {
    this.options = options ? { ...options, frames: options.frames ? [...options.frames] : undefined } : undefined;
    this.pause();
  }

  update(slot: SessionSlot, active: boolean): void {
    const waiting = slot.state === 'waiting';
    const busy = waiting || !!slot.task || !slot.runtime.session.isIdle || slot.state === 'running';
    const ordinary = !slot.activity || slot.activity.kind === 'working';
    if (!active || !busy || (ordinary && (!this.visible || this.options?.frames?.length === 0))) {
      this.pause();
      return;
    }
    const elapsed = slot.metrics?.current ? ` · ${formatDuration(slot.metrics.elapsedMs())}`
      : slot.shell ? ` · ${formatDuration(Date.now() - slot.shell.startedAt)}` : '';
    const message = waiting ? `Waiting for input${elapsed} (Esc to cancel)`
      : `${ordinary ? this.message ?? 'Working' : slot.activity!.message}${elapsed} (Esc to interrupt)`;
    if (this.loader && waiting !== this.staticIndicator) this.pause();
    if (!this.loader) {
      const theme = getMarkdownTheme();
      const color = (text: string) => (this.editor.borderColor ?? theme.quote)(text);
      this.loader = new WorkingIndicator(this.tui, color, color, message, waiting ? { frames: ['●'] } : this.options);
      this.staticIndicator = waiting;
      this.editor.setWorkingStatusIndicator(this.loader);
    } else if (message !== this.lastMessage) this.loader.setMessage(message);
    this.lastMessage = message;
  }

  pause(): void {
    this.loader?.dispose();
    this.loader = undefined;
    this.lastMessage = undefined;
    this.editor.setWorkingStatusIndicator(undefined);
  }
  dispose(): void { this.pause(); }
}
