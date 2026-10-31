import type { Terminal } from '@earendil-works/pi-tui';

export class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 32;
  kittyProtocolActive = false;
  output = '';
  input?: (data: string) => void;
  private onResize?: () => void;
  start(onInput: (data: string) => void, onResize: () => void) { this.input = onInput; this.onResize = onResize; }
  stop() { this.input = undefined; this.onResize = undefined; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  type(text: string) { for (const char of text) this.input?.(char); }
  resize(columns: number, rows = this.rows) { this.columns = columns; this.rows = rows; this.onResize?.(); }
  click(x: number, y: number) {
    this.input?.(`\x1b[<0;${x + 1};${y + 1}M`);
    this.input?.(`\x1b[<0;${x + 1};${y + 1}m`);
  }
}

export async function until(predicate: () => boolean, description = 'UI state'): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
