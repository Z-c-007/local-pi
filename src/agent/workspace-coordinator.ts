import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, realpath, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { within } from './file-changes.ts';

export type LeaseMode = 'read' | 'write' | 'restore';
interface Lease { id: string; pid: number; cwd: string; mode: LeaseMode; sessionId: string; paths?: string[] }
export interface WorkspaceEvent { seq: number; cwd: string; paths?: string[]; sessionId: string; reason: string }
interface State { seq: number; leases: Lease[]; tickets?: Lease[]; events: WorkspaceEvent[]; pending: Array<{ id: string; cwd: string }> }
export const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export const overlaps = (a: string, b: string) => within(canonical(a), canonical(b)) || within(canonical(b), canonical(a));
export const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
const conflicts = (a: Lease, b: Lease) => overlaps(a.cwd, b.cwd) && (a.mode === 'restore' || b.mode === 'restore'
  || a.mode === 'write' && b.mode === 'write' && (!a.paths || !b.paths || a.paths.some((path) => b.paths!.includes(path)))
  || !!a.paths && !!b.paths && (a.mode === 'write' || b.mode === 'write') && a.paths.some((path) => b.paths!.includes(path)));

/** Cooperative cross-process leases for one Local Pi installation/session root. */
export class WorkspaceCoordinator {
  readonly root: string;
  constructor(root: string) { this.root = join(root, 'workspace-coordination'); }
  private async reclaim(mutex: string): Promise<void> {
    // The OS releases SQLite's lock on process death. Only stale-owner removal
    // uses this gate; it prevents two reclaimers deleting a newly acquired mutex.
    const db = new DatabaseSync(join(this.root, 'mutex-recovery.sqlite'));
    let transaction = false;
    try {
      db.exec('PRAGMA busy_timeout=0');
      try { db.exec('BEGIN IMMEDIATE'); transaction = true; }
      catch (error) { if ((error as { errcode?: number }).errcode === 5) return; throw error; }
      const raw = await readFile(mutex, 'utf8'); const owner = JSON.parse(raw) as { pid: number };
      if (Number.isInteger(owner.pid) && !alive(owner.pid)) await unlink(mutex);
      db.exec('COMMIT'); transaction = false;
    } finally {
      if (transaction) db.exec('ROLLBACK'); db.close();
    }
  }
  private async critical<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
    await mkdir(this.root, { recursive: true }); const mutex = join(this.root, 'mutex');
    const ownerPath = join(this.root, `${randomUUID()}.owner`); const handle = await open(ownerPath, 'wx');
    let locked = false;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); await handle.sync();
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await link(ownerPath, mutex); locked = true; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          try {
            const raw = await readFile(mutex, 'utf8'); const owner = JSON.parse(raw) as { pid: number };
            if (Number.isInteger(owner.pid) && !alive(owner.pid)) await this.reclaim(mutex);
          } catch { /* An incomplete or live lock is never taken over. */ }
          await new Promise((done) => setTimeout(done, 15));
        }
      }
      if (!locked) throw new Error('工作区协调锁被占用；请稍后重试。');
      let state: State;
      try { state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('工作区协调记录损坏，已拒绝文件操作。');
        state = { seq: 0, leases: [], events: [], pending: [] };
      }
      if (!Array.isArray(state.leases) || !Array.isArray(state.events) || !Array.isArray(state.pending) || !Number.isSafeInteger(state.seq)) throw new Error('工作区协调记录无效。');
      state.leases = state.leases.filter((lease) => alive(lease.pid));
      state.tickets = (state.tickets ?? []).filter((ticket) => alive(ticket.pid));
      const result = await fn(state);
      const temporary = join(this.root, `${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx');
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.root, 'state.json'));
      return result;
    } finally {
      await handle.close();
      try { if (locked) await unlink(mutex); } finally { await unlink(ownerPath); }
    }
  }

  async acquire(cwd: string, mode: LeaseMode, sessionId: string, recoveryId?: string): Promise<string> {
    const root = canonical(await realpath(cwd));
    return this.critical((state) => {
      if (state.pending.some((pending) => pending.id !== recoveryId && overlaps(root, pending.cwd))) throw new Error('此目录存在未完成的恢复操作；请先使用 /recovery 处理。');
      const conflict = state.leases.find((lease) => overlaps(root, lease.cwd)
        && (mode === 'restore' || lease.mode === 'restore' || mode === 'write' && lease.mode === 'write'));
      if (conflict) throw new Error(`相关目录有${conflict.mode === 'restore' ? '文件恢复' : '会话任务'}运行（${conflict.sessionId.slice(0, 8)}）；不会自动停止其他会话，请稍后重试。`);
      const id = randomUUID(); state.leases.push({ id, pid: process.pid, cwd: root, mode, sessionId }); return id;
    });
  }
  async release(id: string): Promise<void> { await this.critical((state) => { state.leases = state.leases.filter((lease) => lease.id !== id); }); }
  /** FIFO for conflicting operations only; different files need not wait for each other.
   * Broad write leases remain compatible with older Local Pi processes' task leases. */
  async wait(cwd: string, mode: LeaseMode, sessionId: string, options: {
    path?: string; signal?: AbortSignal; onWait?: (owner: string, target: string) => void; inherited?: string[];
  } = {}): Promise<string> {
    const ticket: Lease = { id: randomUUID(), pid: process.pid, cwd: canonical(await realpath(cwd)), mode, sessionId,
      paths: options.path ? [canonical(options.path)] : undefined };
    let granted = false;
    try {
      while (true) {
        options.signal?.throwIfAborted();
        const blocker = await this.critical((state) => {
          if (state.pending.some((pending) => overlaps(ticket.cwd, pending.cwd))) throw new Error('此目录有未确认的操作；请先使用 /recovery 处理。');
          if (!state.tickets!.some((item) => item.id === ticket.id)) state.tickets!.push(ticket);
          const earlier = state.tickets!.slice(0, state.tickets!.findIndex((item) => item.id === ticket.id));
          const ancestors = state.leases.filter((item) => options.inherited?.includes(item.id) && item.pid === process.pid && item.sessionId === sessionId);
          // A queued outsider blocked by our parent cannot jump ahead of the parent's
          // nested call: doing so would deadlock both. Siblings still queue normally.
          const owner = [...state.leases.filter((item) => !ancestors.includes(item)),
            ...earlier.filter((item) => !ancestors.some((ancestor) => conflicts(item, ancestor)))].find((item) => conflicts(ticket, item));
          if (owner) return owner.sessionId;
          state.tickets = state.tickets!.filter((item) => item.id !== ticket.id); state.leases.push(ticket); return undefined;
        });
        if (!blocker) { granted = true; options.signal?.throwIfAborted(); return ticket.id; }
        options.onWait?.(blocker, options.path ?? ticket.cwd);
        await new Promise<void>((done, reject) => {
          const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(options.signal?.reason); };
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); done(); }, 50);
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
        });
      }
    } catch (error) {
      await this.critical((state) => {
        state.tickets = state.tickets!.filter((item) => item.id !== ticket.id);
        if (granted) state.leases = state.leases.filter((item) => item.id !== ticket.id);
      });
      throw error;
    }
  }
  async record(cwd: string, sessionId: string, reason: string, paths?: string[]): Promise<number> {
    return this.critical((state) => {
      const seq = ++state.seq; state.events.push({ seq, cwd: canonical(cwd), sessionId, reason, paths: paths?.map(canonical) }); return seq;
    });
  }
  async sequence(): Promise<number> { return this.critical((state) => state.seq); }
  async latestRestore(cwd: string): Promise<WorkspaceEvent | undefined> {
    return this.critical((state) => state.events.findLast((event) => overlaps(cwd, event.cwd)
      && ['undo', 'redo', 'recovered restore backup'].includes(event.reason)));
  }
  async later(cwd: string, path: string, since: number, inherited: number[] = []): Promise<boolean> {
    return this.critical((state) => state.events.some((event) => event.seq > since && !inherited.includes(event.seq)
      && (event.paths ? event.paths.includes(canonical(path)) : overlaps(cwd, event.cwd))));
  }
  async pending(id: string, cwd: string, present: boolean | (() => boolean)): Promise<void> {
    await this.critical((state) => {
      state.pending = state.pending.filter((entry) => entry.id !== id);
      if (typeof present === 'function' ? present() : present) state.pending.push({ id, cwd: canonical(cwd) });
    });
  }
  async pendingFor(cwd: string): Promise<Array<{ id: string; cwd: string }>> {
    return this.critical((state) => state.pending.filter((entry) => overlaps(cwd, entry.cwd)));
  }
}
