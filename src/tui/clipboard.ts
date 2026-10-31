import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEditor } from './working.ts';
import type { PiUi } from './pi-ui.ts';

export type ClipboardReader = Pick<PiUi, 'readClipboardFilePaths' | 'readClipboardImage' | 'readClipboardText' | 'extensionForImageMimeType'>;

/** Same file -> image -> text flow as Pi's InteractiveMode, bound to one draft. */
export class SessionClipboard {
  private generation = 0;
  private pending = false;
  private readonly editor: SessionEditor;
  private readonly reader: ClipboardReader;
  private readonly available: () => boolean;
  private readonly changed: () => void;
  private readonly notify: (message: string) => void;

  constructor(editor: SessionEditor, reader: ClipboardReader, available: () => boolean,
    changed: () => void, notify: (message: string) => void) {
    this.editor = editor; this.reader = reader; this.available = available;
    this.changed = changed; this.notify = notify;
  }

  cancelPending(): void { this.generation++; }
  get isPending(): boolean { return this.pending; }

  private insertPath(text: string): void {
    const cursor = this.editor.getCursor();
    const line = this.editor.getText().split('\n')[cursor.line] ?? '';
    const before = cursor.col > 0 ? line[cursor.col - 1] : '';
    const after = line[cursor.col] ?? '';
    this.editor.insertTextAtCursor(`${before && !/\s/.test(before) ? ' ' : ''}${text}${after && !/\s/.test(after) ? ' ' : ''}`);
    this.changed();
  }

  async paste(): Promise<void> {
    if (this.pending || !this.available()) return;
    this.pending = true;
    const generation = this.generation;
    const valid = () => generation === this.generation && this.available();
    try {
      const paths = await this.reader.readClipboardFilePaths();
      if (!valid()) return;
      if (paths?.length) {
        if (paths.some((path) => /\p{Cc}/u.test(path))) throw new Error('剪贴板文件路径包含控制字符。');
        this.insertPath(paths.join('\n'));
        return;
      }
      const image = await this.reader.readClipboardImage();
      if (!valid()) return;
      if (image) {
        const extension = this.reader.extensionForImageMimeType(image.mimeType) ?? 'png';
        const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
        writeFileSync(path, image.bytes);
        this.insertPath(path);
        return;
      }
      const text = await this.reader.readClipboardText();
      if (!valid()) return;
      if (text) { this.editor.insertTextAtCursor(text); this.changed(); }
      else this.notify('剪贴板没有可粘贴的图片、文件或文字。');
    } catch (error) {
      if (valid()) this.notify(`剪贴板粘贴失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { this.pending = false; }
  }
}
