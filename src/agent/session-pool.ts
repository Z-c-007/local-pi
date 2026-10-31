import { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentSessionEvent, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Options } from '../cli.ts';
import { modeEntryType, restoreMode } from './mode.ts';
import { forkEntryType, forkPoints, type ForkPoint, type ForkOrigin } from './fork.ts';
import { createRuntime, type RuntimeOverrides } from './runtime.ts';
import { SessionCatalog, sameProject, type SavedSession } from './session-catalog.ts';
import { TaskMetrics } from './task-metrics.ts';
import { loadPiRuntimeSupport } from '../tui/pi-ui.ts';

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
export type ToolEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }>;
export interface SessionActivity {
  kind: 'working' | 'retry' | 'compaction' | 'branchSummary' | 'shell' | 'reload';
  message: string;
}
export interface SessionSlot {
  id: string;
  number: number;
  runtime: Runtime;
  saved: SavedSession;
  task?: Promise<void>;
  state: 'idle' | 'running' | 'waiting' | 'error';
  activity?: SessionActivity;
  unread: boolean;
  notices: string[];
  statuses: Map<string, string>;
  runningTools: Set<string>;
  toolEvents: Map<string, ToolEvent>;
  streaming?: Extract<AgentSessionEvent, { type: 'message_update' }>['message'];
  error?: string;
  revision: number;
  metrics: TaskMetrics;
  compactionQueue: Array<{ text: string; mode: 'steer' | 'followUp' }>;
  stopping?: boolean;
  operation?: 'shell' | 'reload' | 'tree';
  shell?: { command: string; output: string; excludeFromContext: boolean; startedAt: number };
  unsubscribe: () => void;
}

type RuntimeFactory = (options: Options, overrides: RuntimeOverrides) => Promise<Runtime>;
export interface SessionListEntry extends SavedSession {
  live?: SessionSlot;
}
export class SessionPool extends EventEmitter {
  readonly slots = new Map<string, SessionSlot>();
  activeId?: string;
  private serial = 0;
  private disposing = false;
  private readonly pendingNew = new Map<string, Promise<SessionSlot>>();
  uiFactory?: (slot: SessionSlot, base: ExtensionUIContext) => ExtensionUIContext;
  hasDraft?: (slot: SessionSlot) => boolean;
  readonly options: Options;
  private readonly factory: RuntimeFactory;
  readonly catalog: SessionCatalog;

  constructor(options: Options, factory: RuntimeFactory = createRuntime, sessionsRoot?: string) {
    super();
    this.options = options;
    this.factory = factory;
    this.catalog = new SessionCatalog(sessionsRoot);
  }

  get active(): SessionSlot {
    const slot = this.activeId ? this.slots.get(this.activeId) : undefined;
    if (!slot) throw new Error('当前没有打开的会话。');
    return slot;
  }

  changed(slot: SessionSlot): void {
    slot.revision++;
    this.emit('change', slot);
  }

  notify(slot: SessionSlot, message: string): void {
    slot.notices.push(message);
    slot.notices = slot.notices.slice(-12);
    if (slot.id !== this.activeId) slot.unread = true;
    this.changed(slot);
  }

  save(slot: SessionSlot, title?: string, touch = true): void {
    slot.saved = this.catalog.save(slot.runtime.session.sessionManager, slot.saved, title, touch);
  }

  async listSessions(cwd = this.active.runtime.cwd): Promise<SessionListEntry[]> {
    const records = new Map<string, SessionListEntry>((await this.catalog.list(cwd)).map((record) => [record.id, record]));
    // Keep other projects' live agents reachable when /new was given another directory.
    for (const slot of this.slots.values()) {
      if (slot.saved.hasConversation || this.hasDraft?.(slot)) records.set(slot.id, { ...slot.saved, live: slot });
    }
    return [...records.values()].sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
  }

  async openSession(id: string, cwd = this.active.runtime.cwd): Promise<SessionSlot> {
    const live = this.slots.get(id);
    if (live) { this.activate(id); return live; }
    const saved = (await this.catalog.list(cwd)).find((record) => record.id === id);
    if (!saved) throw new Error('会话已不存在，请重新打开会话列表。');
    return this.open({ ...this.options, cwd: saved.cwd, continue: false, session: undefined }, saved);
  }

  async newSession(options: Options): Promise<SessionSlot> {
    if (this.disposing) throw new Error('程序正在退出。');
    const candidates = [...this.slots.values()].sort((a, b) => Number(b.id === this.activeId) - Number(a.id === this.activeId));
    const empty = candidates.find((slot) => !slot.saved.hasConversation && !slot.task && slot.state === 'idle'
      && slot.runtime.session.isIdle && !this.hasDraft?.(slot) && sameProject(slot.runtime.cwd, options.cwd));
    if (empty) { this.activate(empty.id); return empty; }
    const key = process.platform === 'win32' ? options.cwd.toLowerCase() : options.cwd;
    const pending = this.pendingNew.get(key);
    if (pending) return pending;
    const creating = this.open({ ...options, continue: false, session: undefined });
    this.pendingNew.set(key, creating);
    try { return await creating; }
    finally { if (this.pendingNew.get(key) === creating) this.pendingNew.delete(key); }
  }

  private forkSource(id: string): { slot: SessionSlot; manager: SessionManager; points: ForkPoint[] } {
    const slot = this.slots.get(id);
    if (!slot || this.disposing) throw new Error('会话已关闭。');
    const file = slot.runtime.session.sessionFile;
    if (!file || !existsSync(file)) throw new Error('当前没有已保存的消息可分叉。请先完成一次对话。');
    // Read a separate manager: createBranchedSession mutates its receiver.
    const manager = SessionManager.open(file, slot.runtime.session.sessionManager.getSessionDir());
    if (manager.getSessionId() !== id || !sameProject(manager.getCwd(), slot.runtime.cwd)) {
      throw new Error('会话文件与当前运行实例不一致，未分叉。');
    }
    const persisted = new Set(manager.getEntries().map((entry) => entry.id));
    const branch = slot.runtime.session.sessionManager.getBranch().filter((entry) => persisted.has(entry.id));
    return { slot, manager, points: forkPoints(branch) };
  }

  getForkPoints(id: string): ForkPoint[] { return this.forkSource(id).points; }

  async fork(id: string, entryId: string): Promise<SessionSlot | undefined> {
    let source = this.forkSource(id);
    if (!source.points.some((point) => point.entryId === entryId)) throw new Error('该消息不是当前分支中完整、已保存的分叉位置。');
    const result = await source.slot.runtime.session.extensionRunner?.emit({ type: 'session_before_fork', entryId, position: 'at' });
    if (result?.cancel) { this.notify(source.slot, '扩展已取消分叉。'); return; }
    // The source may have advanced, closed, or switched branches while a hook awaited input.
    source = this.forkSource(id);
    if (!source.points.some((point) => point.entryId === entryId)) throw new Error('分叉位置已变化，请重新选择。');
    const sourceSessionFile = source.manager.getSessionFile()!;
    source.manager.createBranchedSession(entryId);
    const origin: ForkOrigin = { sourceSessionId: id, sourceSessionFile, entryId, position: 'at' };
    source.manager.appendCustomEntry(forkEntryType, origin);
    source.manager.appendCustomEntry(modeEntryType, { mode: 'discuss' });
    source.manager.appendSessionInfo(`${source.slot.saved.name || source.slot.saved.title || '会话'} · 分叉`);
    const saved = this.catalog.save(source.manager);
    const child = await this.open({ ...this.options, cwd: source.slot.runtime.cwd, model: undefined,
      continue: false, session: undefined }, saved, { type: 'session_start', reason: 'fork', previousSessionFile: sourceSessionFile });
    this.notify(child, `已从会话 ${source.slot.number} 分叉，默认只读讨论。继承到所选消息（含）；文件仍使用当前工作目录，不复制或回滚代码。`);
    return child;
  }

  async open(options: Options = { ...this.options, continue: false, session: undefined }, saved?: SavedSession,
    sessionStartEvent?: RuntimeOverrides['sessionStartEvent']): Promise<SessionSlot> {
    if (this.disposing) throw new Error('程序正在退出。');
    if (options.continue && !options.session && !saved) saved = (await this.catalog.list(options.cwd))[0];
    if (saved && this.slots.has(saved.id)) { this.activate(saved.id); return this.slots.get(saved.id)!; }
    if (options.session) {
      const path = resolve(options.session);
      const existing = [...this.slots.values()].find((s) => s.runtime.session.sessionFile === path);
      if (existing) { this.activate(existing.id); return existing; }
    }
    // The catalog has already resolved --continue; never fall back to a hidden
    // SDK-only empty transcript when no formal conversation was found.
    const runtime = await this.factory({ ...options, model: saved?.fork ? undefined : options.model, continue: false }, {
      sessionsRoot: this.catalog.root,
      sessionManager: saved ? this.catalog.restore(saved) : undefined,
      sessionStartEvent,
    });
    if (this.disposing) { await runtime.dispose(); throw new Error('程序正在退出。'); }
    let snapshot: SavedSession;
    try {
      saved ??= (await this.catalog.list(options.cwd)).find((record) => record.id === runtime.session.sessionId);
      if (this.disposing) throw new Error('程序正在退出。');
      const duplicate = this.slots.get(runtime.session.sessionId);
      if (duplicate) { await runtime.dispose(); this.activate(duplicate.id); return duplicate; }
      snapshot = this.catalog.save(runtime.session.sessionManager, saved, undefined, !saved);
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
    const slot: SessionSlot = {
      id: runtime.session.sessionId, number: ++this.serial, runtime, state: 'idle', unread: false,
      saved: snapshot,
      notices: [], statuses: new Map(), runningTools: new Set(), toolEvents: new Map(), revision: 0, metrics: new TaskMetrics(), compactionQueue: [], unsubscribe: () => {},
    };
    slot.unsubscribe = runtime.session.subscribe((event) => this.onEvent(slot, event));
    this.slots.set(slot.id, slot);
    const oldActive = this.activeId;
    this.activate(slot.id);
    try {
      const base = runtime.session.extensionRunner!.createContext().ui;
      const basic: ExtensionUIContext = {
        ...base,
        notify: (message) => this.notify(slot, message),
        setStatus: (key, text) => {
          if (text === undefined) slot.statuses.delete(key); else slot.statuses.set(key, text);
          this.changed(slot);
        },
      };
      await runtime.session.bindExtensions({
        uiContext: this.uiFactory?.(slot, basic) ?? basic,
        mode: 'tui',
        abortHandler: () => { void this.abort(slot.id); },
        shutdownHandler: () => this.notify(slot, '请使用 /close 关闭本会话，或 /quit 退出程序。'),
        onError: (error) => this.notify(slot, `扩展错误：${error.error}`),
      });
      for (const diagnostic of runtime.diagnostics) this.notify(slot, diagnostic.message);
      this.changed(slot);
      return slot;
    } catch (error) {
      slot.unsubscribe();
      this.slots.delete(slot.id);
      if (this.activeId === slot.id) {
        this.activeId = oldActive && this.slots.has(oldActive) ? oldActive : this.slots.keys().next().value;
        if (this.activeId) this.activate(this.activeId);
      }
      await runtime.dispose();
      throw error;
    }
  }

  activate(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) throw new Error('找不到这个已打开的会话。');
    // Viewing another session never aborts or disposes the outgoing one.
    this.activeId = id;
    slot.unread = false;
    this.emit('active', slot);
    this.changed(slot);
  }

  private onEvent(slot: SessionSlot, event: AgentSessionEvent): void {
    if (event.type === 'agent_start') slot.metrics.begin(slot.runtime.session);
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      slot.activity = { kind: 'working', message: 'Working' };
      if (slot.state !== 'waiting') slot.state = 'running';
    }
    if (event.type === 'compaction_start') {
      slot.activity = { kind: 'compaction', message: 'Compacting context' };
      if (slot.state !== 'waiting') slot.state = 'running';
    }
    if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') {
      slot.activity = { kind: 'retry', message: `Retrying (${event.attempt}/${event.maxAttempts})` };
      if (slot.state !== 'waiting') slot.state = 'running';
    }
    if (event.type === 'auto_retry_end') {
      slot.activity = { kind: 'working', message: 'Working' };
      if (event.success) slot.error = undefined;
    }
    if (event.type === 'summarization_retry_attempt_start') {
      slot.activity = event.source === 'compaction'
        ? { kind: 'compaction', message: 'Compacting context' }
        : { kind: 'branchSummary', message: 'Summarizing branch' };
    }
    if (event.type === 'compaction_end') {
      slot.activity = slot.task ? { kind: 'working', message: 'Working' } : undefined;
      if (slot.state !== 'waiting') slot.state = slot.task || !slot.runtime.session.isIdle ? 'running' : 'idle';
      if (event.result && !slot.task && !slot.stopping) {
        // Extensions may compact through the SDK directly, outside compact().
        queueMicrotask(() => { void this.drainCompactionQueue(slot).catch((error) => this.notify(slot, String(error))); });
      }
    }
    if (event.type === 'summarization_retry_finished' && slot.activity?.kind === 'retry') slot.activity = undefined;
    if (event.type === 'message_update') slot.streaming = event.message;
    if (event.type === 'message_end') {
      slot.streaming = undefined;
      if (event.message.role === 'assistant' && event.message.stopReason === 'error') {
        slot.error = event.message.errorMessage || '模型请求失败。';
      } else if (event.message.role === 'assistant') {
        slot.error = undefined;
      }
      if (slot.id !== this.activeId) slot.unread = true;
    }
    if (event.type === 'tool_execution_start') slot.runningTools.add(event.toolName);
    if (event.type === 'tool_execution_end') slot.runningTools.delete(event.toolName);
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      slot.toolEvents.set(event.toolCallId, event);
    }
    if (event.type === 'agent_settled') {
      slot.metrics.finish(slot.runtime.session, event.aborted ? 'aborted' : slot.error ? 'failed' : 'completed');
      slot.activity = undefined;
      slot.state = slot.error ? 'error' : 'idle';
      if (slot.id !== this.activeId) {
        slot.unread = true;
        this.emit('background-finished', slot);
      }
    }
    this.changed(slot);
  }

  async submit(id: string, text: string, mode: 'steer' | 'followUp' = 'steer'): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || this.disposing) throw new Error('会话已关闭。');
    if (slot.stopping) throw new Error('会话正在停止，请稍后再发送。');
    if (slot.operation) throw new Error('当前会话正在执行终端命令、重载或会话树操作；请等待完成，草稿会保留。');
    const name = text.startsWith('/') ? text.slice(1).split(/\s/, 1)[0]! : '';
    if (name && slot.runtime.session.extensionRunner?.getCommand(name)) {
      try { await slot.runtime.session.prompt(text); }
      finally {
        if (slot.runtime.session.isIdle && !slot.task && slot.state !== 'waiting') {
          slot.activity = undefined;
          slot.state = slot.error ? 'error' : 'idle';
        }
        this.save(slot);
        this.changed(slot);
      }
      return;
    }
    if (slot.runtime.session.isCompacting || slot.activity?.kind === 'compaction') {
      slot.compactionQueue.push({ text, mode });
      this.notify(slot, '消息已排队，压缩完成后继续。');
      return;
    }
    if (slot.task || !slot.runtime.session.isIdle) {
      const result = await (mode === 'steer' ? slot.runtime.session.steer(text) : slot.runtime.session.followUp(text));
      if (result === 'queued') this.notify(slot, mode === 'steer' ? '已加入追加指令队列。' : '已加入后续消息队列。');
      this.changed(slot);
      return;
    }
    if (restoreMode(slot.runtime.session.sessionManager.getBranch()) === 'execute') {
      const workspace = realpathSync(slot.runtime.cwd);
      const conflict = [...this.slots.values()].find((other) => other !== slot && other.task
        && sameProject(realpathSync(other.runtime.cwd), workspace)
        && (other.operation === 'shell' || restoreMode(other.runtime.session.sessionManager.getBranch()) === 'execute'));
      if (conflict) throw new Error(`会话 ${conflict.number} 正在此目录执行。请等待、停止它，或在独立 worktree 中执行；讨论模式仍可使用。`);
    }
    slot.error = undefined;
    this.save(slot, text);
    slot.state = 'running';
    slot.activity = { kind: 'working', message: 'Working' };
    slot.metrics.begin(slot.runtime.session);
    const task = slot.runtime.session.prompt(text);
    slot.task = task;
    this.changed(slot);
    try { await task; }
    catch (error) {
      slot.error = error instanceof Error ? error.message : String(error);
      this.notify(slot, slot.error);
    } finally {
      slot.metrics.finish(slot.runtime.session, slot.error ? 'failed' : 'completed');
      slot.task = undefined;
      slot.activity = undefined;
      slot.streaming = undefined;
      slot.runningTools.clear();
      slot.state = slot.error ? 'error' : 'idle';
      this.save(slot);
      this.changed(slot);
    }
    if (!slot.error) await this.drainCompactionQueue(slot);
  }

  private async drainCompactionQueue(slot: SessionSlot): Promise<void> {
    if (this.disposing || slot.stopping || !this.slots.has(slot.id) || !slot.compactionQueue.length) return;
    const queued = slot.compactionQueue.splice(0);
    // Start one SDK run; all remaining entries join its native steering/follow-up queues.
    const first = queued.shift()!;
    const task = this.submit(slot.id, first.text, first.mode);
    if (!slot.task) {
      try { await task; }
      catch (error) {
        slot.compactionQueue.unshift(first, ...queued);
        this.notify(slot, `压缩后的消息仍保留在队列：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    for (const entry of queued) await this.submit(slot.id, entry.text, entry.mode);
    await task;
  }

  clearQueue(id: string): { steering: string[]; followUp: string[] } {
    const slot = this.slots.get(id);
    if (!slot) return { steering: [], followUp: [] };
    const queued = slot.runtime.session.clearQueue();
    for (const entry of slot.compactionQueue.splice(0)) queued[entry.mode === 'steer' ? 'steering' : 'followUp'].push(entry.text);
    this.changed(slot);
    return queued;
  }

  async compact(id: string, instructions?: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || this.disposing) throw new Error('会话已关闭。');
    if (slot.task || !slot.runtime.session.isIdle || slot.state === 'waiting') throw new Error('请先停止当前任务或处理确认，再手动压缩；不会自动中断任务。');
    slot.error = undefined;
    slot.state = 'running'; slot.activity = { kind: 'compaction', message: 'Compacting context' };
    // Defer the SDK call until slot.task is installed (compact() first awaits abort()).
    const task = Promise.resolve().then(async () => { await slot.runtime.session.compact(instructions); });
    slot.task = task; this.changed(slot);
    let completed = false;
    try { await task; completed = true; this.notify(slot, '上下文压缩完成。'); }
    catch (error) {
      if (!slot.stopping) { slot.error = error instanceof Error ? error.message : String(error); this.notify(slot, `压缩失败：${slot.error}`); }
    } finally {
      slot.task = undefined; slot.activity = undefined; slot.state = slot.error ? 'error' : 'idle';
      this.save(slot); this.changed(slot);
    }
    if (completed) await this.drainCompactionQueue(slot);
  }

  /** Reserve this slot before any await; other sessions continue independently. */
  private async idleOperation<T>(id: string, operation: NonNullable<SessionSlot['operation']>, action: (slot: SessionSlot) => Promise<T>): Promise<T> {
    const slot = this.slots.get(id);
    if (!slot || this.disposing) throw new Error('会话已关闭。');
    if (slot.task || slot.stopping || !slot.runtime.session.isIdle || slot.runtime.session.isBashRunning || slot.state === 'waiting') {
      throw new Error('请先等待当前任务完成或 /stop；此操作不会自动中断任务。');
    }
    slot.operation = operation; slot.state = 'running'; slot.error = undefined;
    slot.activity = { kind: operation === 'tree' ? 'branchSummary' : operation,
      message: operation === 'tree' ? 'Navigating session tree' : operation === 'reload' ? 'Reloading resources' : 'Running shell' };
    let result!: T;
    const task = Promise.resolve().then(() => action(slot)).then((value) => { result = value; });
    slot.task = task; this.changed(slot);
    try { await task; return result; }
    finally {
      slot.task = undefined; slot.operation = undefined; slot.shell = undefined; slot.activity = undefined;
      slot.state = 'idle'; this.save(slot); this.changed(slot);
    }
  }

  async navigateTree(id: string, targetId: string, options?: Parameters<Runtime['session']['navigateTree']>[1]) {
    return this.idleOperation(id, 'tree', async (slot) => {
      const result = await slot.runtime.session.navigateTree(targetId, options);
      slot.toolEvents.clear(); slot.streaming = undefined;
      return result;
    });
  }

  async reload(id: string): Promise<void> {
    await this.idleOperation(id, 'reload', async (slot) => {
      slot.statuses.clear();
      await slot.runtime.session.reload();
    });
  }

  async executeShell(id: string, command: string, excludeFromContext = false): Promise<void> {
    if (!command.trim()) throw new Error('请在 ! 后输入终端命令。');
    await this.idleOperation(id, 'shell', async (slot) => {
      const conflict = [...this.slots.values()].find((other) => other !== slot && other.task
        && sameProject(other.runtime.cwd, slot.runtime.cwd)
        && (other.operation === 'shell' || restoreMode(other.runtime.session.sessionManager.getBranch()) === 'execute'));
      if (conflict) throw new Error(`会话 ${conflict.number} 正在此目录执行；请等待、停止它或使用独立 worktree。`);
      const session = slot.runtime.session;
      slot.shell = { command, output: '', excludeFromContext, startedAt: Date.now() }; this.changed(slot);
      const intercepted = await session.extensionRunner.emitUserBash({ type: 'user_bash', command, cwd: slot.runtime.cwd, excludeFromContext });
      if (slot.stopping) return;
      if (intercepted?.result) {
        session.recordBashResult(command, intercepted.result, { excludeFromContext });
      } else {
        const official = await loadPiRuntimeSupport();
        if (slot.stopping) return;
        await session.executeBash(command, (chunk) => {
          if (slot.shell) slot.shell.output += chunk;
          this.changed(slot);
        }, { excludeFromContext, operations: intercepted?.operations
          ?? (process.platform === 'win32' ? official.createLocalPowerShellOperations() : undefined) });
      }
      this.notify(slot, '终端命令已结束；不会自动请求模型。');
    });
  }

  async abort(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.stopping = true;
    try {
      slot.runtime.session.abortBash(); slot.runtime.session.abortBranchSummary();
      await slot.runtime.session.abort(); await slot.task?.catch(() => {});
    }
    finally { slot.stopping = false; this.changed(slot); }
  }

  async close(id: string, stop = false): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    if ((slot.task || !slot.runtime.session.isIdle) && !stop) throw new Error('会话正在运行；用 /stop 停止后再关闭，或切换到其他会话让它继续。');
    this.emit('closing', slot);
    await this.abort(id);
    this.save(slot, undefined, false);
    slot.unsubscribe();
    await slot.runtime.dispose();
    this.slots.delete(id);
    if (this.activeId === id) {
      this.activeId = this.slots.keys().next().value;
      if (this.activeId) this.activate(this.activeId);
    }
    this.emit('closed', slot);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await Promise.all([...this.slots.keys()].map((id) => this.close(id, true)));
  }
}
