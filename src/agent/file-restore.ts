import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { FileChanges, type FileState, type FileChangeReport } from './file-changes.ts';
import { checkedPath, fileState, sameState } from './file-state.ts';
import { canonical, WorkspaceCoordinator } from './workspace-coordinator.ts';
import type { OperationStore } from './operation-store.ts';
import { RestoreHistory } from './restore-history.ts';

export type RestoreDirection = 'undo' | 'redo';
export interface RestoreFile {
  path: string; expected?: FileState; target?: FileState; revision: number; wasUndone: boolean;
}
export interface RestorePlan {
  reportId: string; direction: RestoreDirection; onlyPath?: string; sessionId: string; cwd: string;
  files: RestoreFile[]; conflicts: string[]; warnings: string[]; token: string;
}
interface JournalEntry extends RestoreFile {
  step: 'pending' | 'intent' | 'applied' | 'recovered';
  result?: { state?: FileState; revision: number; undone: boolean };
}
export interface RestoreJournal {
  version: 1; id: string; cwd: string; sessionId: string; reportId: string; direction: RestoreDirection;
  phase: 'prepared' | 'applying' | 'completed' | 'needs_recovery' | 'recovered';
  created: number; sequence?: number; files: JournalEntry[]; error?: string;
  warnings?: string[];
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = (id: string) => /^[a-f\d-]{36}$/i.test(id);

/** Deterministic file restoration. No LLM calls, Git reset, or chat replacement. */
export class FileRestore {
  readonly root: string;
  private readonly snapshots: FileChanges;
  private readonly coordinator: WorkspaceCoordinator;
  // An injected checkpoint supports meaningful failure/crash-path tests.
  private readonly checkpoint?: (stage: string, path: string) => Promise<void>;
  private readonly operations?: OperationStore;
  constructor(snapshots: FileChanges, coordinator: WorkspaceCoordinator, checkpoint?: (stage: string, path: string) => Promise<void>, operations?: OperationStore) {
    this.snapshots = snapshots; this.coordinator = coordinator; this.root = join(snapshots.root, 'restore-operations'); this.checkpoint = checkpoint; this.operations = operations;
  }
  private async save(journal: RestoreJournal): Promise<void> {
    const dir = join(this.root, journal.id); await mkdir(dir, { recursive: true });
    const temporary = join(dir, `${randomUUID()}.tmp`); const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(dir, 'journal.json'));
  }
  async journals(): Promise<RestoreJournal[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: RestoreJournal[] = [];
    for (const id of entries.filter(uuid)) {
      let raw: string;
      try { raw = await readFile(join(this.root, id, 'journal.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const journal = JSON.parse(raw) as RestoreJournal;
      if (journal.version !== 1 || journal.id !== id || !Array.isArray(journal.files)) throw new Error('恢复日志损坏，已拒绝继续。');
      result.push(journal);
    }
    return result.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.created - b.created);
  }
  private async previous(report: FileChangeReport): Promise<Map<string, NonNullable<JournalEntry['result']>>> {
    const result = new Map<string, NonNullable<JournalEntry['result']>>();
    for (const journal of await this.journals()) if (journal.reportId === report.id && journal.sessionId === report.sessionId
      && ['completed', 'recovered'].includes(journal.phase)) {
      for (const file of journal.files) if (file.result) result.set(file.path, file.result);
    }
    return result;
  }
  async annotate(reports: FileChangeReport[]): Promise<void> {
    for (const report of reports) {
      const previous = await this.previous(report);
      for (const change of report.changes) change.restoreState = previous.get(change.path)?.undone ? 'undone' : undefined;
    }
  }
  private async blob(reportId: string, state?: FileState): Promise<Buffer | undefined> {
    if (!state) return undefined;
    if (!uuid(reportId) || !state.hash || !/^[a-f\d]{64}$/.test(state.hash) || !state.stamp || state.links !== 1 || state.issue) throw new Error('文件快照不适合自动恢复');
    const bytes = await readFile(join(this.snapshots.root, reportId, 'blobs', state.hash));
    if (bytes.length !== state.size || digest(bytes) !== state.hash) throw new Error('快照内容校验失败');
    return bytes;
  }
  async prepare(session: AgentSession, reportId: string, direction: RestoreDirection, onlyPath?: string): Promise<RestorePlan> {
    const report = this.snapshots.read(session).find((item) => item.id === reportId);
    if (!report || report.sessionId !== session.sessionId || canonical(report.cwd) !== canonical(session.sessionManager.getCwd())) throw new Error('此任务不属于当前会话和目录。');
    const plan: RestorePlan = { reportId, direction, onlyPath, sessionId: session.sessionId, cwd: report.cwd, files: [], conflicts: [], warnings: [], token: '' };
    const history = new RestoreHistory(this.coordinator, this.operations);
    if (report.status === 'running' || !report.before || !report.after || report.issues.length) plan.conflicts.push('本轮快照未完成或记录不完整，不能自动恢复。');
    const previous = await this.previous(report);
    const candidates = report.changes.filter((file) => !onlyPath || file.path === onlyPath);
    if (onlyPath && !candidates.length) plan.conflicts.push('选中的文件不在本轮记录中。');
    for (const change of candidates) {
      const old = previous.get(change.path); const wasUndone = old?.undone ?? false;
      if (wasUndone !== (direction === 'redo')) { if (onlyPath) plan.conflicts.push(`${change.path}：已经处于目标状态。`); continue; }
      try {
        if (change.restoreBlocked) throw new Error(change.restoreBlocked);
        if (change.attribution !== 'tool' || !Number.isSafeInteger(change.revision)) throw new Error('修改归属不明或属于旧快照，仅允许查看');
        if (change.kind === 'unavailable') throw new Error('文件快照不完整');
        await this.blob(report.id, change.before); await this.blob(report.id, change.after);
        const expected = old ? old.state : change.after;
        const revision = old?.revision ?? change.revision!;
        const evidence = await history.check(resolve(report.cwd, change.path), revision);
        if (evidence.conflicts.length) throw new Error(evidence.conflicts.join('；'));
        const current = (await fileState(report.cwd, change.path)).state;
        if (!sameState(current, expected)) throw new Error('当前文件与预期版本不同，可能被用户或其他程序编辑');
        if (current && !(current.mode & 0o200)) throw new Error('当前文件只读');
        plan.warnings.push(...evidence.warnings.map((warning) => `${change.path}：${warning}`));
        plan.files.push({ path: change.path, expected, target: direction === 'undo' ? change.before : change.after, revision, wasUndone });
      } catch (error) { plan.conflicts.push(`${change.path}：${(error as Error).message}`); }
    }
    if (!plan.files.length && !plan.conflicts.length) plan.conflicts.push('没有可以执行的文件变更。');
    plan.token = digest(JSON.stringify({ files: plan.files, conflicts: plan.conflicts, warnings: plan.warnings }));
    return plan;
  }

  private async replace(cwd: string, path: string, expected: FileState | undefined, target: FileState | undefined, bytes: Buffer | undefined): Promise<FileState | undefined> {
    const absolute = await checkedPath(cwd, path);
    if (!sameState((await fileState(cwd, path)).state, expected)) throw new Error(`${path}：写入前复检冲突`);
    if (!target) {
      if (expected) await unlink(absolute);
    } else {
      if (!bytes || digest(bytes) !== target.hash) throw new Error('恢复内容校验失败');
      const temporary = join(dirname(absolute), `.local-pi-restore-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx');
        try { await handle.writeFile(bytes); await handle.chmod(target.mode & 0o777); await handle.sync(); } finally { await handle.close(); }
        await checkedPath(cwd, path);
        if (!sameState((await fileState(cwd, path)).state, expected)) throw new Error(`${path}：提交前复检冲突`);
        await rename(temporary, absolute);
      } finally { await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    }
    const current = (await fileState(cwd, path)).state;
    if (target ? current?.hash !== target.hash || current?.mode !== target.mode : !!current) throw new Error(`${path}：恢复后验证失败`);
    return current;
  }

  async apply(session: AgentSession, plan: RestorePlan): Promise<RestoreJournal> {
    const lease = await this.coordinator.acquire(plan.cwd, 'restore', session.sessionId);
    let journal: RestoreJournal | undefined;
    try {
      const fresh = await this.prepare(session, plan.reportId, plan.direction, plan.onlyPath);
      if (fresh.conflicts.length || fresh.token !== plan.token) throw new Error(`恢复预览已变化或存在冲突：${fresh.conflicts.join('；')}`);
      journal = { version: 1, id: randomUUID(), cwd: fresh.cwd, sessionId: session.sessionId, reportId: fresh.reportId,
        direction: fresh.direction, phase: 'prepared', created: Date.now(), warnings: fresh.warnings,
        files: fresh.files.map((file) => ({ ...file, step: 'pending' })) };
      const directory = join(this.root, journal.id); await mkdir(join(directory, 'backups'), { recursive: true });
      for (const [i, file] of journal.files.entries()) {
        const current = await fileState(journal.cwd, file.path);
        if (!sameState(current.state, file.expected)) throw new Error(`${file.path}：备份前发现冲突`);
        if (current.bytes) { const backup = await open(join(directory, 'backups', `${i}.bin`), 'wx');
          try { await backup.writeFile(current.bytes); await backup.sync(); } finally { await backup.close(); } }
      }
      await this.save(journal); await this.coordinator.pending(journal.id, journal.cwd, true);
      journal.phase = 'applying'; await this.save(journal);
      for (const file of journal.files) {
        await this.checkpoint?.('before', file.path);
        file.step = 'intent'; await this.save(journal);
        const state = await this.replace(journal.cwd, file.path, file.expected, file.target, await this.blob(journal.reportId, file.target));
        file.step = 'applied'; file.result = { state, revision: 0, undone: journal.direction === 'undo' }; await this.save(journal);
        await this.checkpoint?.('after', file.path);
      }
      journal.sequence = await this.coordinator.record(journal.cwd, journal.sessionId, journal.direction, journal.files.map((file) => resolve(journal!.cwd, file.path)));
      for (const file of journal.files) file.result!.revision = journal.sequence;
      journal.phase = 'completed'; await this.save(journal); await this.coordinator.pending(journal.id, journal.cwd, false);
      return journal;
    } catch (error) {
      if (journal && ['applying', 'needs_recovery'].includes(journal.phase)) {
        journal.phase = 'needs_recovery'; journal.error = String(error); await this.save(journal);
        throw new Error(`恢复未完整完成，已保留备份并阻止相关目录继续运行。请使用 /recovery。日志 ${journal.id}：${String(error)}`);
      }
      throw error;
    } finally { await this.coordinator.release(lease); }
  }

  async recover(session: AgentSession, id: string): Promise<RestoreJournal> {
    const journal = (await this.journals()).find((item) => item.id === id);
    if (!journal || journal.sessionId !== session.sessionId || canonical(journal.cwd) !== canonical(session.sessionManager.getCwd())) throw new Error('恢复日志不属于当前会话和目录。');
    const lease = await this.coordinator.acquire(journal.cwd, 'restore', session.sessionId, id);
    try {
      if (['completed', 'recovered'].includes(journal.phase)) { await this.coordinator.pending(id, journal.cwd, false); return journal; }
      const values: Array<{ file: JournalEntry; current?: FileState; bytes?: Buffer }> = [];
      for (const [i, file] of journal.files.entries()) {
        const current = (await fileState(journal.cwd, file.path)).state;
        const expected = file.result ? file.result.state : file.expected;
        if (!sameState(current, expected)) throw new Error(`${file.path}：恢复备份前发现外部修改／未确认的写入；备份仍保留，拒绝覆盖。`);
        const bytes = file.expected ? await readFile(join(this.root, id, 'backups', `${i}.bin`)) : undefined;
        if (file.expected && (!bytes || digest(bytes) !== file.expected.hash)) throw new Error('恢复备份损坏');
        values.push({ file, current, bytes });
      }
      for (const item of values) {
        const state = sameState(item.current, item.file.expected) ? item.current
          : await this.replace(journal.cwd, item.file.path, item.current, item.file.expected, item.bytes);
        item.file.step = 'recovered'; item.file.result = { state, revision: 0, undone: item.file.wasUndone }; await this.save(journal);
      }
      journal.sequence = await this.coordinator.record(journal.cwd, journal.sessionId, 'recovered restore backup', journal.files.map((file) => resolve(journal.cwd, file.path)));
      for (const file of journal.files) file.result!.revision = journal.sequence;
      journal.phase = 'recovered'; await this.save(journal); await this.coordinator.pending(id, journal.cwd, false); return journal;
    } finally { await this.coordinator.release(lease); }
  }
}
