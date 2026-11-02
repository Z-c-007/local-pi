import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { dirname, basename, relative, resolve } from 'node:path';
import { fileState, sameState } from './file-state.ts';
import { within, type Capture, type FileState } from './file-changes.ts';
import { canonical, WorkspaceCoordinator } from './workspace-coordinator.ts';
import { OperationStore, type WorkspaceOperation } from './operation-store.ts';
import { loadPiDiff, loadPiPaths } from '../tui/pi-ui.ts';

interface Scope { cwd: string; sessionId: string; kind: 'read' | 'file' | 'workspace'; path?: string; before?: FileState; leases: string[]; revisions: number[] }
interface Call {
  cwd: string; sessionId: string; capture?: Capture; toolName: string; toolCallId: string;
  input: Record<string, unknown>; signal?: AbortSignal; onWait(owner?: string, target?: string): void;
}
const readonly = new Set(['read', 'grep', 'find', 'ls', 'tool_search', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

/** Host coordination surrounds actual execute(), not tool_call/tool_result hooks.
 * Nested codemode calls inherit the workspace lease, but retain their own logs and native queues. */
export class WorkspaceOperations {
  readonly store: OperationStore;
  private readonly coordinator: WorkspaceCoordinator;
  private readonly scope = new AsyncLocalStorage<Scope>();
  constructor(store: OperationStore, coordinator: WorkspaceCoordinator) { this.store = store; this.coordinator = coordinator; }
  async beforeWrite(path: string): Promise<void> {
    const scope = this.scope.getStore();
    if (!scope || scope.kind !== 'file' || canonical(path) !== scope.path) throw new Error('文件修改缺少操作上下文，已拒绝写入。');
    if (!sameState((await this.state(path)).state, scope.before)) throw new Error('文件在写入前已变化；请先重新 read，再基于新内容修改。');
  }
  private async state(path: string): ReturnType<typeof fileState> {
    try { return await fileState(dirname(path), basename(path), 64 * 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async run<T>(call: Call, execute: () => Promise<T>): Promise<T> {
    const paths = await loadPiPaths();
    const file = typeof call.input.path === 'string' && ['read', 'edit', 'write'].includes(call.toolName)
      ? call.toolName === 'read' ? await paths.resolveReadPathAsync(call.input.path, call.cwd) : paths.resolveToCwd(call.input.path, call.cwd) : undefined;
    const kind = ['edit', 'write'].includes(call.toolName) ? 'file' : readonly.has(call.toolName) ? 'read' : 'workspace';
    if (kind === 'file' && !file) throw new Error('文件工具缺少路径。');
    if (kind === 'file' && typeof call.input.content === 'string' && Buffer.byteLength(call.input.content) > 64 * 1024 * 1024) throw new Error('文件超过操作版本校验的 64 MiB 上限，请拆分修改。');
    const localPath = file && ([...Object.keys(call.capture?.before.files ?? {}), ...(call.capture?.writes.keys() ?? [])]
      .find((path) => canonical(resolve(call.cwd, path)) === canonical(file)) ?? relative(call.cwd, file).replaceAll('\\', '/'));
    const parent = this.scope.getStore();
    const cwd = file && !within(canonical(call.cwd), file) ? dirname(file) : canonical(call.cwd);
    let lease: string | undefined; let operation: WorkspaceOperation | undefined; let invoked = false;
    try {
      call.signal?.throwIfAborted();
      if (parent) {
        if (parent.sessionId !== call.sessionId || parent.kind !== 'workspace' || !within(parent.cwd, file ?? cwd)) {
          throw new Error('嵌套工具超出父工具的目录锁范围，不能升级锁；请直接调用该工具。');
        }
      }
      await this.store.reconcile(this.coordinator);
      lease = await this.coordinator.wait(cwd, kind === 'read' ? 'read' : 'write', call.sessionId, {
          path: kind === 'workspace' ? undefined : file, signal: call.signal,
          inherited: parent?.leases,
          onWait: (owner, target) => call.onWait(owner, target),
        });
      // A holder may have died while this call was queued. Reconcile again only
      // after acquiring the lease, before any mutation can pass the new holder.
      await this.store.reconcile(this.coordinator);
      if ((await this.coordinator.pendingFor(cwd)).length) throw new Error('此目录有未确认的操作；请先使用 /recovery 处理。');
      call.onWait(); call.signal?.throwIfAborted();
      let before: Awaited<ReturnType<typeof fileState>> = {};
      if (file) {
        if (kind === 'file') before = await this.state(file);
        else { try { before = await this.state(file); } catch { /* Large or unsupported reads retain native behavior, without a version receipt. */ } }
      }
      operation = this.store.begin({ sessionId: call.sessionId, reportId: call.capture?.report.id, toolCallId: call.toolCallId,
        tool: call.toolName, cwd, path: kind === 'file' || before.state ? file : undefined, kind, before: before.state });
      await this.store.backup(before.bytes);
      if (kind === 'file') {
        const seen = this.store.seen(call.sessionId, file!);
        const baseline = seen ? seen.after : call.capture?.before.files[localPath!];
        const since = seen?.revision ?? call.capture?.sequence;
        if (!sameState(before.state, baseline) || (before.state || baseline) && since !== undefined && await this.coordinator.later(cwd, file!, since, parent?.revisions)) {
          throw new Error(`文件版本已过期：${call.input.path}。其他会话或外部程序可能已修改；请先重新 read，再重新生成修改。`);
        }
        operation.revision = await this.coordinator.record(cwd, call.sessionId, 'file tool attempt', [file!]);
      } else if (kind === 'workspace') {
        operation.revision = await this.coordinator.record(cwd, call.sessionId, `potential side effects: ${call.toolName}`);
      }
      this.store.save(operation); call.signal?.throwIfAborted();
      let expected: string | undefined;
      if (kind === 'file') {
        if (call.toolName === 'write' && typeof call.input.content === 'string') expected = call.input.content;
        if (call.toolName === 'edit' && before.bytes && Array.isArray(call.input.edits)) {
          const official = await loadPiDiff(); const raw = before.bytes.toString('utf8'); const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
          const text = raw.slice(bom.length); const result = official.applyEditsToNormalizedContent(official.normalizeToLF(text), call.input.edits, String(call.input.path));
          expected = bom + official.restoreLineEndings(result.newContent, official.detectLineEnding(text));
        }
        if (expected !== undefined && Buffer.byteLength(expected) > 64 * 1024 * 1024) throw new Error('修改结果超过版本校验的 64 MiB 上限，请拆分修改。');
      }
      const scope: Scope = { cwd, sessionId: call.sessionId, kind, path: file && canonical(file), before: before.state,
        leases: [...(parent?.leases ?? []), lease],
        revisions: [...(parent?.revisions ?? []), ...(kind === 'workspace' && operation.revision ? [operation.revision] : [])] };
      invoked = true;
      const result = await this.scope.run(scope, execute);
      const outcome = result as { isError?: boolean; exitCode?: number; cancelled?: boolean; structuredContent?: { exit_code?: number } } | undefined;
      operation.result = { isError: outcome?.isError === true,
        exitCode: outcome?.exitCode ?? outcome?.structuredContent?.exit_code, cancelled: outcome?.cancelled };
      if (file && operation.path) {
        const after = await this.state(file); operation.after = after.state;
        await this.store.backup(after.bytes);
        if (kind === 'read' && !sameState(before.state, after.state)) throw new Error('读取期间文件已变化，请重新 read。');
        if (kind === 'file' && (expected === undefined || createHash('sha256').update(expected).digest('hex') !== after.state?.hash)) throw new Error('工具执行后的文件版本无法核验，已保留备份。');
        if (kind === 'read') operation.revision = await this.coordinator.sequence();
      }
      operation.status = operation.result.isError ? 'failed' : 'completed'; operation.finishedAt = Date.now(); this.store.save(operation);
      if (kind === 'file' && call.capture && file && within(canonical(call.cwd), file)) {
        const path = localPath!;
        const writes = call.capture.writes.get(path) ?? [];
        writes.push({ before: before.state, after: operation.after, complete: true, revision: operation.revision, operationId: operation.id });
        call.capture.writes.set(path, writes);
      }
      return result;
    } catch (error) {
      if (operation) {
        operation.error = error instanceof Error ? error.message : String(error); operation.finishedAt = Date.now();
        operation.status = 'failed';
        if (invoked && kind === 'file' && file) {
          try {
            operation.after = (await this.state(file)).state;
            if (!sameState(operation.before, operation.after)) operation.status = 'uncertain';
          } catch { operation.status = 'uncertain'; }
        }
        this.store.save(operation);
        if (operation.status === 'uncertain') await this.coordinator.pending(operation.id, cwd, true);
      }
      throw error;
    } finally {
      call.onWait();
      try {
        // Reads are allowed during a shell call so discussion remains usable.
        // Its completion invalidates those receipts, including same-byte writes.
        // Native codemode has no direct filesystem access; its nested tools log their own effects.
        if (invoked && kind === 'workspace' && call.toolName !== 'codemode') {
          const revision = await this.coordinator.record(cwd, call.sessionId, `finished potential side effects: ${call.toolName}`);
          if (operation) { operation.revision = revision; this.store.save(operation); }
        }
      } finally { if (lease) await this.coordinator.release(lease); }
    }
  }
}
