import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, realpath, writeFile, rename, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, relative, join, isAbsolute } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { loadPiDiff } from '../tui/pi-ui.ts';
import { forkEntryType } from './fork.ts';
import type { WorkspaceCoordinator } from './workspace-coordinator.ts';

export const fileChangesType = 'local-pi-file-changes';
export const snapshotExcludes = ['.git', '.svn', '.hg', 'node_modules', '.local-pi', 'dist', 'build', 'coverage', '.next', '.nuxt'];
const MAX_FILE = 2 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
export interface FileState { hash?: string; size: number; mode: number; stamp?: string; links?: number; issue?: string }
export const fileStamp = (stat: { dev: number; ino: number; size: number; mode: number; mtimeMs: number; ctimeMs: number; nlink: number }) =>
  [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
interface Manifest { files: Record<string, FileState>; skipped: string[]; issues: string[] }
export interface FileChange {
  path: string; kind: 'added' | 'modified' | 'deleted' | 'unavailable';
  before?: FileState; after?: FileState; added?: number; removed?: number; diff?: string; note?: string;
  attribution?: 'tool' | 'ambiguous'; revision?: number;
  restoreBlocked?: string;
  restoreState?: 'undone';
}
export interface FileChangeReport {
  version: 1; id: string; sessionId: string; cwd: string; startedAt: number; finishedAt?: number;
  afterTimestamp?: number; status: 'running' | 'completed' | 'failed' | 'aborted';
  source: 'task' | 'shell'; title: string; changes: FileChange[]; issues: string[];
  before?: Manifest; after?: Manifest;
  operationBased?: boolean; observedChanges?: FileChange[]; observationIssues?: string[];
}
export interface ToolWrite { before?: FileState; after?: FileState; complete: boolean; revision?: number; operationId?: string }
export interface Capture { report: FileChangeReport; directory: string; before: Manifest; writes: Map<string, ToolWrite[]>; sequence?: number }
export function within(root: string, path: string): boolean {
  const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

/** Byte snapshots belong to the host, never to model-visible messages. */
export class FileChanges {
  readonly root: string;
  private readonly coordinator?: WorkspaceCoordinator;
  constructor(root: string, coordinator?: WorkspaceCoordinator) { this.root = resolve(root, 'file-snapshots'); this.coordinator = coordinator; }

  private async save(report: FileChangeReport): Promise<void> {
    const dir = join(this.root, report.id); await mkdir(dir, { recursive: true });
    const temporary = join(dir, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(report)); await rename(temporary, join(dir, 'record.json'));
  }

  private async scan(cwd: string, agentDir: string, dir: string): Promise<Manifest> {
    const result: Manifest = { files: Object.create(null), skipped: [], issues: [] };
    let count = 0; let bytes = 0;
    const skip = (path: string, reason: string) => { result.skipped.push(path); result.issues.push(`${path || '.'}: ${reason}`); };
    const visit = async (folder: string, prefix: string): Promise<void> => {
      let entries;
      try {
        if ((await lstat(folder)).isSymbolicLink()) { skip(prefix, '不跟随符号链接／目录联接'); return; }
        if (!within(cwd, await realpath(folder))) { skip(prefix, '目录已移动到工作区之外'); return; }
        entries = await readdir(folder, { withFileTypes: true });
      } catch { skip(prefix, '目录无法读取'); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = join(folder, entry.name);
        if ((entry.isDirectory() || entry.name.startsWith('.')) && snapshotExcludes.includes(entry.name.toLowerCase())
          || within(this.root, absolute) || within(agentDir, absolute)) continue;
        if (++count > MAX_FILES) { skip(prefix, `扫描条目超过 ${MAX_FILES} 上限`); return; }
        try {
          const stat = await lstat(absolute);
          if (stat.isSymbolicLink()) { skip(path, '符号链接未快照'); continue; }
          if (stat.isDirectory()) { await visit(absolute, path); continue; }
          if (!stat.isFile()) { skip(path, '非普通文件'); continue; }
          const state: FileState = { size: stat.size, mode: stat.mode, stamp: fileStamp(stat), links: stat.nlink }; result.files[path] = state;
          if (stat.size > MAX_FILE || bytes + stat.size > MAX_BYTES) {
            state.issue = stat.size > MAX_FILE ? '文件超过 2 MiB' : '快照总大小超过 64 MiB'; skip(path, state.issue); continue;
          }
          if (!within(cwd, await realpath(absolute))) { state.issue = '文件位于工作区之外'; skip(path, state.issue); continue; }
          const handle = await open(absolute, 'r');
          let content: Buffer;
          try {
            const buffer = Buffer.alloc(stat.size + 1);
            let size = 0;
            while (size < buffer.length) {
              const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
              if (!bytesRead) break;
              size += bytesRead;
            }
            content = buffer.subarray(0, size);
          } finally { await handle.close(); }
          const after = await lstat(absolute);
          if (after.isSymbolicLink() || fileStamp(after) !== fileStamp(stat) || content.length !== stat.size) {
            state.issue = '读取期间文件发生变化'; skip(path, state.issue); continue;
          }
          bytes += content.length;
          const hash = createHash('sha256').update(content).digest('hex');
          await writeFile(join(dir, 'blobs', hash), content, { flag: 'wx' }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          });
          state.hash = hash;
        } catch { skip(path, '文件读取或快照保存失败'); }
      }
    };
    await visit(cwd, ''); return result;
  }

  async begin(session: AgentSession, agentDir: string, title: string, source: FileChangeReport['source'], operationBased = false): Promise<Capture> {
    const report: FileChangeReport = { version: 1, id: randomUUID(), sessionId: session.sessionId,
      cwd: await realpath(session.sessionManager.getCwd()), startedAt: Date.now(), status: 'running', source,
      title: title.replace(/\s+/g, ' ').slice(0, 100), changes: [], issues: [], operationBased };
    session.sessionManager.appendCustomEntry(fileChangesType, { version: 1, id: report.id });
    const directory = join(this.root, report.id); await mkdir(join(directory, 'blobs'), { recursive: true });
    await this.save(report);
    const sequence = await this.coordinator?.sequence();
    const before = await this.scan(report.cwd, resolve(agentDir), directory);
    report.before = before; report.issues = before.issues; await this.save(report);
    return { report, directory, before, writes: new Map(), sequence };
  }

  async finish(capture: Capture, session: AgentSession, agentDir: string, status: FileChangeReport['status']): Promise<FileChangeReport> {
    const { report, before, directory } = capture;
    const after = await this.scan(report.cwd, resolve(agentDir), directory);
    report.after = after; report.status = status; report.finishedAt = Date.now();
    report.afterTimestamp = session.messages.at(-1)?.timestamp;
    report.issues = [...new Set([...before.issues, ...after.issues, ...report.issues])];
    const covered = (manifest: Manifest, path: string) => !manifest.skipped.some((p) => !p || path === p || path.startsWith(`${p}/`));
    for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
      const a = before.files[path]; const b = after.files[path];
      if (a?.hash && a.hash === b?.hash && a.mode === b.mode) continue;
      if (a?.hash && b?.hash || !a && b?.hash && covered(before, path) || a?.hash && !b && covered(after, path)) {
        const change: FileChange = { path, kind: !a ? 'added' : !b ? 'deleted' : 'modified', before: a, after: b };
        let previous = a; let attributed = report.source === 'task';
        const writes = capture.writes.get(path) ?? [];
        const equal = (x: FileState | undefined, y: FileState | undefined) => !x && !y || !!x?.hash && x.hash === y?.hash && x.stamp === y.stamp && x.links === 1;
        for (const write of writes) { if (!write.complete || !equal(previous, write.before)) attributed = false; previous = write.after; }
        change.attribution = attributed && writes.length > 0 && equal(previous, b) ? 'tool' : 'ambiguous';
        await this.describe(change, directory); report.changes.push(change);
      } else {
        report.changes.push({ path, kind: 'unavailable', before: a, after: b, note: '前后快照不完整，无法确认文件变化' });
      }
    }
    if (report.operationBased && report.source === 'task') {
      const observed = report.changes;
      report.changes = []; report.observationIssues = report.issues; report.issues = [];
      report.before = { files: {}, skipped: [], issues: [] }; report.after = { files: {}, skipped: [], issues: [] };
      for (const [path, writes] of capture.writes) {
        const first = writes[0]; const last = writes.at(-1); if (!first || !last) continue;
        const a = first.before; const b = last.after;
        if (a?.hash === b?.hash && a?.mode === b?.mode) continue;
        let contiguous = true; let previous = a;
        for (const write of writes) {
          if (!write.complete || (previous || write.before) && (!previous?.hash || previous.hash !== write.before?.hash || previous.stamp !== write.before?.stamp)) contiguous = false;
          previous = write.after;
        }
        const change: FileChange = { path, kind: !a ? 'added' : !b ? 'deleted' : 'modified', before: a, after: b,
          attribution: contiguous ? 'tool' : 'ambiguous', revision: last.revision,
          note: contiguous ? undefined : '本轮对此文件的修改间存在其他操作，不能整体自动撤销' };
        try {
          // Per-operation backups may include a version created after the task baseline.
          for (const state of [a, b]) if (state?.hash) {
            const bytes = await readFile(join(this.root, '..', 'workspace-operations', 'blobs', state.hash));
            if (createHash('sha256').update(bytes).digest('hex') !== state.hash) throw new Error('操作备份校验失败');
            await writeFile(join(directory, 'blobs', state.hash), bytes, { flag: 'wx' }).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            });
          }
          await this.describe(change, directory);
        } catch { change.attribution = 'ambiguous'; report.issues.push(`${path}：操作备份缺失或损坏，仅允许查看`); }
        if ([a, b].some((state) => state && state.size > MAX_FILE)) {
          change.restoreBlocked = '文件超过 2 MiB 自动恢复上限，仅可查看';
          change.note = `${change.restoreBlocked}。${change.note ?? '已保存工具修改的原始字节。'}`;
        }
        if (a) report.before.files[path] = a; if (b) report.after.files[path] = b;
        report.changes.push(change);
      }
      report.observedChanges = observed.filter((change) => {
        const writes = capture.writes.get(change.path); if (!writes?.length) return true;
        const own = writes.at(-1)?.after; const current = after.files[change.path];
        return !!(own || current) && (!own?.hash || own.hash !== current?.hash || own.stamp !== current.stamp);
      });
    }
    if (this.coordinator && !report.operationBased && report.changes.length) {
      const revision = await this.coordinator.record(report.cwd, report.sessionId, 'task file changes', report.changes.map((c) => resolve(report.cwd, c.path)));
      for (const change of report.changes) change.revision = revision;
    }
    await this.save(report); return report;
  }

  private async describe(change: FileChange, directory: string): Promise<void> {
    const a = change.before?.hash ? await readFile(join(directory, 'blobs', change.before.hash)) : Buffer.alloc(0);
    const b = change.after?.hash ? await readFile(join(directory, 'blobs', change.after.hash)) : Buffer.alloc(0);
    if (a.includes(0) || b.includes(0)) { change.note = '二进制文件：已保存原始字节，不显示文本 diff'; return; }
    let oldText: string; let newText: string;
    try { const decoder = new TextDecoder('utf-8', { fatal: true }); oldText = decoder.decode(a); newText = decoder.decode(b); }
    catch { change.note = '非 UTF-8 文件：已保存原始字节，不显示文本 diff'; return; }
    if (a.length + b.length > 128 * 1024 || oldText.split('\n').length + newText.split('\n').length > 4000) {
      change.note = '已保存快照；文件较大，暂不计算文本 diff'; return;
    }
    const { diff } = (await loadPiDiff()).generateDiffString(oldText, newText);
    change.diff = diff; change.added = diff.split('\n').filter((line) => line.startsWith('+')).length;
    change.removed = diff.split('\n').filter((line) => line.startsWith('-')).length;
    if (!diff) change.note = '文件属性或编码标记变化；原始字节已保存';
  }

  read(session: AgentSession): FileChangeReport[] {
    const reports: FileChangeReport[] = [];
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === forkEntryType) reports.length = 0;
      if (entry.type !== 'custom' || entry.customType !== fileChangesType) continue;
      const id = (entry.data as { id?: unknown })?.id;
      if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) continue;
      try {
        const report = JSON.parse(readFileSync(join(this.root, id, 'record.json'), 'utf8')) as FileChangeReport;
        if (report.version !== 1 || report.id !== id || !Array.isArray(report.changes) || !Array.isArray(report.issues)
          || typeof report.title !== 'string' || !['running', 'completed', 'failed', 'aborted'].includes(report.status)) throw new Error('Invalid record');
        if (report.sessionId === session.sessionId) reports.push(report);
      } catch { reports.push({ version: 1, id, sessionId: session.sessionId, cwd: session.sessionManager.getCwd(),
        startedAt: 0, status: 'failed', source: 'task', title: '快照记录不可用', changes: [], issues: ['快照文件缺失或损坏，不能展示本轮差异'] }); }
    }
    return reports;
  }
}

export function changeSummary(report: FileChangeReport): string {
  const known = report.changes.filter((change) => change.kind !== 'unavailable');
  return `${known.length} 个文件 · +${known.reduce((n, c) => n + (c.added ?? 0), 0)} -${known.reduce((n, c) => n + (c.removed ?? 0), 0)}${report.issues.length ? ' · 记录不完整' : report.operationBased && report.source === 'task' ? ' · 本会话工具修改' : ' · 限定范围内的观察'}${report.observedChanges?.length ? ` · 另有 ${report.observedChanges.length} 个未归属观察` : ''}`;
}
