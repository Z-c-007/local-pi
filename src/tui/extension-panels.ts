import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { OverlayHandle, TUI } from '@earendil-works/pi-tui';
import type { SessionSlot } from '../agent/session-pool.ts';

type Factory = Parameters<ExtensionUIContext['custom']>[0];
type CustomComponent = Awaited<ReturnType<Factory>>;
type Options = Parameters<ExtensionUIContext['custom']>[1];
type CustomFactory<T> = (tui: Parameters<Factory>[0], theme: Parameters<Factory>[1], keys: Parameters<Factory>[2], done: (result: T) => void) => ReturnType<Factory>;
interface Panel {
  slot: SessionSlot; component?: CustomComponent; handle?: OverlayHandle;
  close(): void;
}

/** Native extension components retain their own state while another session is visible. */
export class ExtensionPanels {
  private readonly panels = new Map<string, Panel>();
  private suspended = 0;
  private readonly tui: TUI;
  private readonly activeId: () => string | undefined;
  private readonly theme: () => Parameters<Factory>[1];
  private readonly keys: () => Parameters<Factory>[2];
  constructor(tui: TUI, activeId: () => string | undefined,
    theme: () => Parameters<Factory>[1], keys: () => Parameters<Factory>[2]) {
    this.tui = tui; this.activeId = activeId; this.theme = theme; this.keys = keys;
  }

  has(id: string): boolean { return this.panels.has(id); }
  get visible(): boolean {
    return !this.suspended && !!this.activeId() && this.panels.has(this.activeId()!);
  }

  sync(): void {
    for (const [id, panel] of this.panels) {
      const hidden = !!this.suspended || id !== this.activeId();
      panel.handle?.setHidden(hidden);
      if (!hidden) panel.handle?.focus();
    }
  }

  async temporarilyHide<T>(action: () => Promise<T>): Promise<T> {
    this.suspended++; this.sync();
    try { return await action(); }
    finally { this.suspended--; this.sync(); }
  }

  open<T>(slot: SessionSlot, factory: CustomFactory<T>, options?: Options): Promise<T> {
    if (this.panels.has(slot.id)) return Promise.reject(new Error('当前会话已有扩展面板，请先关闭。'));
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (result?: T, error?: unknown) => {
        if (finished) return;
        finished = true;
        panel.handle?.hide();
        this.panels.delete(slot.id);
        panel.component?.dispose?.();
        if (error) reject(error); else resolve(result as T);
        this.sync(); this.tui.requestRender();
      };
      const panel: Panel = { slot, close: () => {
        // Let native menus unsubscribe and finish their current wait before teardown.
        panel.component?.handleInput?.('\x1b');
        finish();
      } };
      this.panels.set(slot.id, panel);
      void Promise.resolve().then(() => factory(this.tui, this.theme(), this.keys(), (result) => finish(result)))
        .then((component) => {
          if (finished) { component.dispose?.(); return; }
          panel.component = component;
          const overlayOptions = typeof options?.overlayOptions === 'function' ? options.overlayOptions() : options?.overlayOptions;
          panel.handle = this.tui.showOverlay(component, { width: '94%', maxHeight: '90%', ...overlayOptions,
            visible: (width, height) => slot.id === this.activeId() && !this.suspended && (overlayOptions?.visible?.(width, height) ?? true) });
          options?.onHandle?.(panel.handle);
          this.sync(); this.tui.requestRender();
        }).catch((error) => finish(undefined, error));
    });
  }

  close(id: string): void { this.panels.get(id)?.close(); }
  dispose(): void { for (const id of [...this.panels.keys()]) this.close(id); }
}
