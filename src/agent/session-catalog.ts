import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { modeEntryType, restoreMode, type WorkMode } from './mode.ts';
import { defaultSessionsRoot, sessionDirectory } from './runtime.ts';
import { forkOrigin, type ForkOrigin } from './fork.ts';

/** The SDK owns transcripts. Unsubmitted sessions only have an in-memory snapshot. */
export interface SavedSession {
  version: 1;
  id: string;
  cwd: string;
  path?: string;
  name?: string;
  title: string;
  created: number;
  modified: number;
  mode: WorkMode;
  hasConversation: boolean;
  fork?: ForkOrigin;
  /** A submitted question whose SDK preflight has not yet produced a transcript. */
  pendingPrompt?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ReturnType<SessionManager['buildSessionContext']>['thinkingLevel'];
}

export function sameProject(a: string, b: string): boolean {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}

export function sessionTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

export class SessionCatalog {
  readonly root: string;
  constructor(root = defaultSessionsRoot) { this.root = root; }

  private directory(cwd: string): string { return join(sessionDirectory(cwd, this.root), 'metadata'); }

  private metadata(cwd: string): SavedSession[] {
    const directory = this.directory(cwd);
    if (!existsSync(directory)) return [];
    const records: SavedSession[] = [];
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as SavedSession;
      if (record.version !== 1 || !/^[\w-]+$/.test(record.id) || file !== `${record.id}.json`
        || typeof record.cwd !== 'string' || !sameProject(record.cwd, cwd)
        || typeof record.title !== 'string' || !Number.isFinite(record.created) || !Number.isFinite(record.modified)
        || !['discuss', 'execute'].includes(record.mode)) {
        throw new Error(`会话索引格式无效：${join(directory, file)}`);
      }
      records.push(record);
    }
    return records;
  }

  async list(cwd: string): Promise<SavedSession[]> {
    const records = new Map(this.metadata(cwd).filter((record) => record.hasConversation).map((record) => [record.id, record]));
    // Existing SDK histories remain readable without a migration or rewriting JSONL.
    for (const info of await SessionManager.list(cwd, sessionDirectory(cwd, this.root))) {
      if (!sameProject(info.cwd, cwd)) continue;
      const saved = records.get(info.id);
      const manager = SessionManager.open(info.path);
      const hasUser = manager.getEntries().some((entry) => entry.type === 'message' && entry.message.role === 'user');
      if (!hasUser && !saved?.pendingPrompt) { records.delete(info.id); continue; }
      records.set(info.id, {
        ...saved, version: 1, id: info.id, cwd: info.cwd, path: info.path,
        name: info.name, title: saved?.title || sessionTitle(info.firstMessage),
        created: saved?.created ?? info.created.getTime(),
        modified: Math.max(saved?.modified ?? 0, info.modified.getTime()),
        mode: saved?.mode ?? 'discuss', hasConversation: true,
        fork: forkOrigin(manager.getBranch()),
      });
    }
    return [...records.values()].sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
  }

  save(manager: SessionManager, previous?: SavedSession, title?: string, touch = true): SavedSession {
    const context = manager.buildSessionContext();
    const firstUser = manager.getEntries().find((entry) => entry.type === 'message' && entry.message.role === 'user');
    const userMessage = firstUser?.type === 'message' && firstUser.message.role === 'user' ? firstUser.message : undefined;
    const firstText = userMessage ? typeof userMessage.content === 'string' ? userMessage.content
      : userMessage.content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
    const record: SavedSession = {
      version: 1, id: manager.getSessionId(), cwd: manager.getCwd(), path: manager.getSessionFile(),
      name: manager.getSessionName(), title: previous?.title || sessionTitle(title || firstText),
      created: previous?.created ?? Date.parse(manager.getHeader()!.timestamp),
      modified: !touch && previous ? previous.modified : Date.now(),
      mode: restoreMode(manager.getBranch()), model: context.model ?? undefined, thinkingLevel: context.thinkingLevel,
      hasConversation: previous?.hasConversation === true || !!userMessage || !!title?.trim(),
      fork: forkOrigin(manager.getBranch()),
      pendingPrompt: userMessage ? undefined : previous?.pendingPrompt || title?.trim() || undefined,
    };
    if (!record.hasConversation) return record;
    const directory = this.directory(record.cwd);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, 'utf8');
    renameSync(temporary, join(directory, `${record.id}.json`));
    return record;
  }

  restore(record: SavedSession): SessionManager {
    if (record.path && existsSync(record.path)) {
      const manager = SessionManager.open(record.path);
      if (manager.getSessionId() !== record.id || !sameProject(manager.getCwd(), record.cwd)) {
        throw new Error('会话文件与索引不一致，未打开该会话。');
      }
      return manager;
    }
    // A transcript can appear after a crash between the SDK write and our index update.
    const existing = SessionManager.findById(record.cwd, record.id, sessionDirectory(record.cwd, this.root));
    if (existing) return SessionManager.open(existing);
    if (record.hasConversation && !record.pendingPrompt) throw new Error('会话记录文件已不存在，未创建空白会话替代它。');
    const manager = SessionManager.create(record.cwd, sessionDirectory(record.cwd, this.root), { id: record.id });
    if (record.name) manager.appendSessionInfo(record.name);
    manager.appendCustomEntry(modeEntryType, { mode: record.mode });
    if (record.model) manager.appendModelChange(record.model.provider, record.model.modelId);
    if (record.thinkingLevel) manager.appendThinkingLevelChange(record.thinkingLevel);
    if (record.pendingPrompt) manager.appendMessage({ role: 'user', content: record.pendingPrompt, timestamp: record.created });
    return manager;
  }
}
