import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { alive } from './workspace-coordinator.ts';

export interface MemoryPolicy { enabled: boolean; turns: number; tokens: number; idleMs: number; model?: string }
export interface MemorySource { id: string; role: 'user' | 'assistant' | 'verification'; text: string; time: number }
export interface MemoryBatch { id: string; project: string; session: string; model: string; sources: MemorySource[]; context: MemorySource[]; created: number; attempts: number; plan?: string; owner?: string }
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const estimatedTokens = (text: string) => {
  const nonAscii = text.replace(/[\x00-\x7f]/g, '').length;
  return nonAscii + Math.ceil((text.length - nonAscii) / 4);
};
export function redactMemoryText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '[代码块省略]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[凭证已省略]')
    .replace(/\b(?:sk-[\w-]{12,}|AKIA[A-Z0-9]{16})\b/g, '[凭证已省略]')
    .replace(/\bBearer\s+[\w.\-+/=]+/gi, 'Bearer [凭证已省略]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization|密钥|密码)\s*[=:：]\s*)[^\s,;，；]+/gi, '$1[凭证已省略]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

/** Only public text and bounded, successful verification metadata enter extraction. */
export function memorySources(entries: readonly SessionEntry[]): MemorySource[] {
  const sources: MemorySource[] = []; const calls = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'toolCall') {
        const command = block.arguments?.command;
        if (typeof command === 'string' && /\b(?:npm|pnpm|yarn|vitest|tsc|pytest|cargo|node --test)\b/.test(command)
          && /\b(?:test|lint|check|build|tsc|vitest|pytest)\b/.test(command)) calls.set(block.id, redactMemoryText(command).slice(0, 200));
      }
      if (message.stopReason !== 'stop') continue;
    }
    let role: MemorySource['role']; let text: string;
    if (message.role === 'user' || message.role === 'assistant') {
      role = message.role;
      text = typeof message.content === 'string' ? message.content : message.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    } else if (message.role === 'toolResult' && !message.isError && calls.has(message.toolCallId)
      && (message.details as { exitCode?: number } | undefined)?.exitCode === 0) {
      role = 'verification'; text = JSON.stringify({ command: calls.get(message.toolCallId), exitCode: 0 });
    } else continue;
    text = redactMemoryText(text).slice(0, role === 'user' ? 6000 : 3000);
    if (!text) continue;
    const time = Number(message.timestamp) || Date.parse(entry.timestamp);
    sources.push({ id: digest(JSON.stringify([role, time, text])), role, text, time });
  }
  return sources;
}

/** Short SQLite transactions publish batches; no transaction spans model/network calls. */
export class MemoryQueue {
  readonly path: string;
  constructor(root: string) { this.path = join(root, 'automatic.sqlite'); }
  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(join(this.path, '..'), { recursive: true });
    const db = new DatabaseSync(this.path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions(project TEXT, session TEXT, model TEXT, activity INTEGER, busy INTEGER DEFAULT 0, pid INTEGER, PRIMARY KEY(project,session));
        CREATE TABLE IF NOT EXISTS seen(project TEXT, session TEXT, fingerprint TEXT, PRIMARY KEY(project,session,fingerprint));
        CREATE TABLE IF NOT EXISTS sources(seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, session TEXT, fingerprint TEXT,
          data TEXT, job TEXT, done INTEGER DEFAULT 0, UNIQUE(project,fingerprint));
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT, session TEXT, model TEXT, payload TEXT, context TEXT,
          created INTEGER, state TEXT, attempts INTEGER DEFAULT 0, owner TEXT, pid INTEGER, next_at INTEGER DEFAULT 0, plan TEXT, result TEXT);
        CREATE TABLE IF NOT EXISTS switches(project TEXT PRIMARY KEY, paused INTEGER NOT NULL);`);
      db.exec('CREATE TABLE IF NOT EXISTS projects(project TEXT PRIMARY KEY, root TEXT NOT NULL)');
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(db); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  paused(project: string): boolean {
    return this.transaction((db) => !!(db.prepare('SELECT paused FROM switches WHERE project=?').get(project) as { paused: number } | undefined)?.paused);
  }
  pause(project: string, paused: boolean): void {
    this.transaction((db) => db.prepare('INSERT OR REPLACE INTO switches VALUES (?,?)').run(project, Number(paused)));
  }
  observe(project: string, session: string, sources: MemorySource[], model: string, now: number, collect = true, root = ''): void {
    this.transaction((db) => {
      if (root) db.prepare('INSERT OR REPLACE INTO projects VALUES (?,?)').run(project, root);
      const exists = db.prepare('SELECT session FROM sessions WHERE project=? AND session=?').get(project, session);
      db.prepare('INSERT INTO sessions(project,session,model,activity) VALUES (?,?,?,?) ON CONFLICT(project,session) DO UPDATE SET model=excluded.model').run(project, session, model, now);
      const disabled = !!(db.prepare('SELECT paused FROM switches WHERE project=?').get(project) as { paused: number } | undefined)?.paused;
      let added = false;
      for (const source of sources) {
        const seen = db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?,?)').run(project, session, source.id);
        if (!seen.changes || !exists || !collect || disabled) continue;
        const result = db.prepare('INSERT OR IGNORE INTO sources(project,session,fingerprint,data) VALUES (?,?,?,?)')
          .run(project, session, source.id, JSON.stringify(source));
        added ||= !!result.changes;
      }
      if (added) db.prepare('UPDATE sessions SET activity=? WHERE project=? AND session=?').run(now, project, session);
    });
  }
  projects(): Array<{ project: string; root: string }> {
    return this.transaction((db) => db.prepare('SELECT * FROM projects').all() as Array<{ project: string; root: string }>);
  }
  touch(project: string, session: string, now: number, busy: boolean): void {
    this.transaction((db) => db.prepare('UPDATE sessions SET activity=?,busy=?,pid=? WHERE project=? AND session=?').run(now, Number(busy), process.pid, project, session));
  }
  seal(project: string, policy: MemoryPolicy, now: number, forceSession?: string, forceAll = false): number {
    return this.transaction((db) => {
      if ((db.prepare('SELECT paused FROM switches WHERE project=?').get(project) as { paused: number } | undefined)?.paused) return 0;
      const sessions = db.prepare('SELECT * FROM sessions WHERE project=? ORDER BY activity').all(project) as Array<{ session: string; activity: number; model: string; busy: number; pid: number }>;
      let count = 0;
      for (const session of sessions) {
        if (forceSession && session.session !== forceSession) continue;
        if (!forceSession && session.busy && session.pid && alive(session.pid)) continue;
        // Bound each publication; subsequent timer passes pick up any remaining batches.
        for (let pass = 0; pass < 8; pass++) {
          const pending = db.prepare('SELECT seq,data FROM sources WHERE project=? AND session=? AND job IS NULL AND done=0 ORDER BY seq LIMIT 1000')
            .all(project, session.session) as Array<{ seq: number; data: string }>;
          if (!pending.length) break;
          const total = pending.map((row) => JSON.parse(row.data) as MemorySource);
          const turns = total.filter((source) => source.role === 'user').length;
          const tokens = total.reduce((sum, source) => sum + estimatedTokens(source.text), 0);
          const forced = forceAll || forceSession === session.session;
          if (!forced && turns < policy.turns && tokens < policy.tokens && now - session.activity < policy.idleMs) break;
          const selected: typeof pending = []; let used = 0; let users = 0;
          for (const row of pending) {
            const source = JSON.parse(row.data) as MemorySource;
            if (source.role === 'user' && selected.length && (used >= policy.tokens || users >= policy.turns)) break;
            selected.push(row); used += estimatedTokens(source.text); if (source.role === 'user') users++;
            if (used >= policy.tokens * 2) break;
          }
          const context = db.prepare("SELECT data FROM sources WHERE project=? AND session=? AND seq<? AND data!='' ORDER BY seq DESC LIMIT 4")
            .all(project, session.session, selected[0]!.seq).reverse().map((row) => JSON.parse(row.data as string));
          const id = digest(project + selected.map((row) => String(row.seq)).join(','));
          db.prepare("INSERT OR IGNORE INTO jobs(id,project,session,model,payload,context,created,state) VALUES (?,?,?,?,?,?,?,'pending')")
            .run(id, project, session.session, policy.model ?? session.model, JSON.stringify(selected.map((row) => JSON.parse(row.data))), JSON.stringify(context), now);
          for (const row of selected) db.prepare('UPDATE sources SET job=? WHERE seq=?').run(id, row.seq);
          count++;
        }
      }
      return count;
    });
  }
  claim(project: string, now: number): MemoryBatch | undefined {
    return this.transaction((db) => {
      const running = db.prepare("SELECT id,pid FROM jobs WHERE project=? AND state='running'").all(project) as Array<{ id: string; pid: number }>;
      for (const job of running) {
        if (alive(job.pid)) return;
        db.prepare("UPDATE jobs SET state='pending',owner=NULL,pid=NULL,result='上次进程中断，等待恢复' WHERE id=?").run(job.id);
      }
      const row = db.prepare("SELECT * FROM jobs WHERE project=? AND state!='done' ORDER BY created,rowid LIMIT 1").get(project) as Record<string, string | number> | undefined;
      if (!row || row.state !== 'pending' || Number(row.next_at) > now) return;
      const owner = randomUUID();
      db.prepare("UPDATE jobs SET state='running',owner=?,pid=?,attempts=attempts+1 WHERE id=?").run(owner, process.pid, String(row.id));
      return { id: String(row.id), project, session: String(row.session), model: String(row.model), sources: JSON.parse(String(row.payload)),
        context: JSON.parse(String(row.context)), created: Number(row.created), attempts: Number(row.attempts) + 1, plan: row.plan ? String(row.plan) : undefined, owner };
    });
  }
  plan(job: MemoryBatch, plan: string): void {
    this.transaction((db) => {
      if (!db.prepare("UPDATE jobs SET plan=? WHERE id=? AND owner=? AND state='running'").run(plan, job.id, job.owner!).changes) throw new Error('记忆任务所有权已变化。');
    });
  }
  finish(job: MemoryBatch, result: string): void {
    this.transaction((db) => {
      if (!db.prepare("UPDATE jobs SET state='done',result=?,owner=NULL,pid=NULL,payload='[]',context='[]',plan=NULL WHERE id=? AND owner=? AND state='running'").run(result, job.id, job.owner!).changes) throw new Error('记忆任务所有权已变化。');
      db.prepare('UPDATE sources SET done=1 WHERE job=?').run(job.id);
      // Keep only a small cross-batch context tail. Queue inputs are not another chat-history archive.
      db.prepare(`UPDATE sources SET data='' WHERE project=? AND session=? AND done=1 AND seq NOT IN
        (SELECT seq FROM sources WHERE project=? AND session=? AND done=1 ORDER BY seq DESC LIMIT 4)`)
        .run(job.project, job.session, job.project, job.session);
    });
  }
  fail(job: MemoryBatch, now: number, interrupted = false, reason?: string): void {
    this.transaction((db) => db.prepare(`UPDATE jobs SET state=?,result=?,next_at=?,owner=NULL,pid=NULL,
      plan=CASE WHEN ? THEN plan ELSE NULL END, attempts=CASE WHEN ? THEN max(0,attempts-1) ELSE attempts END
      WHERE id=? AND owner=? AND state='running'`).run(interrupted || job.attempts < 3 ? 'pending' : 'failed',
      interrupted ? '已暂停，等待恢复' : reason ?? '提取或保存失败；请检查模型、Embedding 配置，或用 /memory retry 重试',
      interrupted ? now : now + 30_000 * 2 ** Math.min(job.attempts - 1, 5), Number(interrupted), Number(interrupted), job.id, job.owner!));
  }
  retry(project: string): void {
    this.transaction((db) => db.prepare("UPDATE jobs SET state='pending',attempts=0,next_at=0 WHERE project=? AND state IN ('failed','pending')").run(project));
  }
  status(project: string): { pendingTurns: number; pendingTokens: number; jobs: Array<{ state: string; total: number }>; recent: Array<{ id: string; state: string; result: string; created: number }> } {
    return this.transaction((db) => {
      const sources = db.prepare('SELECT data FROM sources WHERE project=? AND done=0').all(project).map((row) => JSON.parse(row.data as string) as MemorySource);
      return { pendingTurns: sources.filter((source) => source.role === 'user').length, pendingTokens: sources.reduce((sum, source) => sum + estimatedTokens(source.text), 0),
        jobs: db.prepare('SELECT state,count(*) AS total FROM jobs WHERE project=? GROUP BY state').all(project) as Array<{ state: string; total: number }>,
        recent: db.prepare('SELECT id,state,result,created FROM jobs WHERE project=? ORDER BY created DESC,rowid DESC LIMIT 5').all(project) as Array<{ id: string; state: string; result: string; created: number }> };
    });
  }
}
