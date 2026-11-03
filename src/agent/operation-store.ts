import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, readFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { within, type FileState } from './file-changes.ts';
import { alive, canonical, overlaps, type WorkspaceCoordinator } from './workspace-coordinator.ts';
import type { OperationFootprint, OperationSnapshot } from './operation-snapshot.ts';

export interface WorkspaceOperation {
  id: string; pid: number; sessionId: string; reportId?: string; toolCallId: string; tool: string;
  cwd: string; path?: string; kind: 'read' | 'file' | 'workspace';
  startedAt: number; finishedAt?: number; status: 'prepared' | 'completed' | 'failed' | 'uncertain' | 'acknowledged';
  before?: FileState; after?: FileState; revision?: number; error?: string;
  result?: { isError: boolean; exitCode?: number; cancelled?: boolean };
  footprint?: OperationFootprint;
  invoked?: boolean;
}

/** SDK JSONL remains the conversation store. SQLite indexes host operations only. */
export class OperationStore {
  readonly root: string;
  private database?: DatabaseSync;
  constructor(root: string) { this.root = join(root, 'workspace-operations'); }
  private db(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(join(this.root, 'blobs'), { recursive: true });
    const db = new DatabaseSync(join(this.root, 'operations.sqlite'));
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (
        n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session TEXT NOT NULL,
        cwd TEXT NOT NULL, path TEXT, status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operation_session_path ON operations(session,path,n);
      CREATE INDEX IF NOT EXISTS operation_status ON operations(status);
      CREATE TABLE IF NOT EXISTS tracked_files(path TEXT PRIMARY KEY, cwd TEXT NOT NULL);
      INSERT OR IGNORE INTO tracked_files(path,cwd)
        SELECT path,cwd FROM operations WHERE path IS NOT NULL AND json_extract(data,'$.kind')='file';`);
    this.database = db; return db;
  }
  begin(input: Omit<WorkspaceOperation, 'id' | 'pid' | 'startedAt' | 'status'>): WorkspaceOperation {
    const operation: WorkspaceOperation = { ...input, cwd: canonical(input.cwd), path: input.path && canonical(input.path),
      id: randomUUID(), pid: process.pid, startedAt: Date.now(), status: 'prepared', invoked: false };
    this.db().prepare('INSERT INTO operations(id,session,cwd,path,status,data) VALUES(?,?,?,?,?,?)')
      .run(operation.id, operation.sessionId, operation.cwd, operation.path ?? null, operation.status, JSON.stringify(operation));
    if (operation.kind === 'file' && operation.path) this.track(operation.cwd, operation.path);
    return operation;
  }
  save(operation: WorkspaceOperation): void {
    this.db().prepare('UPDATE operations SET status=?,data=? WHERE id=?').run(operation.status, JSON.stringify(operation), operation.id);
  }
  list(): WorkspaceOperation[] {
    return this.db().prepare('SELECT data FROM operations ORDER BY n').all().map((row) => JSON.parse(row.data as string));
  }
  seen(sessionId: string, path: string): WorkspaceOperation | undefined {
    const row = this.db().prepare("SELECT data FROM operations WHERE session=? AND path=? AND status='completed' ORDER BY n DESC LIMIT 1")
      .get(sessionId, canonical(path));
    return row ? JSON.parse(row.data as string) : undefined;
  }
  get(id: string): WorkspaceOperation | undefined {
    const row = this.db().prepare('SELECT data FROM operations WHERE id=?').get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  tracked(cwd: string): string[] {
    const root = canonical(cwd);
    return this.db().prepare('SELECT path FROM tracked_files ORDER BY rowid DESC').all()
      .map((row) => row.path as string).filter((path) => within(root, path));
  }
  track(cwd: string, path: string): void {
    this.db().prepare('INSERT OR IGNORE INTO tracked_files(path,cwd) VALUES(?,?)').run(canonical(path), canonical(cwd));
  }
  async archiveSnapshot(snapshot: OperationSnapshot): Promise<string> {
    const raw = Buffer.from(JSON.stringify(snapshot));
    if (raw.length > 16 * 1024 * 1024) throw new Error('操作快照索引超过 16 MiB 上限');
    const bytes = gzipSync(raw); await this.backup(bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }
  async loadSnapshot(hash: string): Promise<OperationSnapshot> {
    if (!/^[a-f\d]{64}$/.test(hash)) throw new Error('操作快照索引无效');
    const bytes = await readFile(join(this.root, 'blobs', hash));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('操作快照索引校验失败');
    const snapshot = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')) as OperationSnapshot;
    if (snapshot.version !== 1 || typeof snapshot.cwd !== 'string' || !snapshot.files || !snapshot.directories || !Array.isArray(snapshot.issues)) throw new Error('操作快照格式无效');
    return snapshot;
  }
  async backup(bytes?: Buffer): Promise<void> {
    if (!bytes) return;
    this.db(); const hash = createHash('sha256').update(bytes).digest('hex'); const path = join(this.root, 'blobs', hash);
    try {
      if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('操作备份校验失败，已拒绝修改。');
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = join(this.root, 'blobs', `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx');
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      // Publish complete bytes atomically without replacing an existing hash. A second
      // process must never mistake an in-progress backup for a corrupt existing blob.
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('操作备份校验失败，已拒绝修改。');
      }
    } finally { await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  async reconcile(coordinator: WorkspaceCoordinator): Promise<void> {
    const pending = this.db().prepare("SELECT data FROM operations WHERE status IN ('prepared','uncertain') ORDER BY n").all();
    for (const row of pending) {
      const operation: WorkspaceOperation = JSON.parse(row.data as string);
      if (operation.status === 'prepared' && !alive(operation.pid)) {
        operation.status = operation.kind === 'read' ? 'failed' : 'uncertain';
        operation.error = '进程退出时没有确认操作结果；不会推测或自动回滚。';
        this.db().prepare("UPDATE operations SET status=?,data=? WHERE id=? AND status='prepared'")
          .run(operation.status, JSON.stringify(operation), operation.id);
      }
      if (operation.status === 'uncertain') await coordinator.pending(operation.id, operation.cwd,
        () => this.db().prepare('SELECT status FROM operations WHERE id=?').get(operation.id)?.status === 'uncertain');
    }
  }
  uncertain(cwd: string): WorkspaceOperation[] {
    return this.db().prepare("SELECT data FROM operations WHERE status='uncertain' ORDER BY n").all()
      .map((row) => JSON.parse(row.data as string) as WorkspaceOperation).filter((operation) => overlaps(operation.cwd, cwd));
  }
  async acknowledge(id: string, cwd: string, coordinator: WorkspaceCoordinator): Promise<void> {
    await this.reconcile(coordinator);
    const operation = this.uncertain(cwd).find((item) => item.id === id);
    if (!operation) throw new Error('未找到待确认操作。');
    // Persist the invalidation before clearing the recovery gate, even when bytes match.
    await coordinator.record(operation.cwd, operation.sessionId, 'acknowledged uncertain operation', operation.path ? [operation.path] : undefined);
    operation.status = 'acknowledged'; operation.finishedAt = Date.now(); this.save(operation);
    await coordinator.pending(id, operation.cwd, false);
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
