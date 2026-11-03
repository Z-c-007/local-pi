import { sameState } from './file-state.ts';
import { canonical, type WorkspaceCoordinator } from './workspace-coordinator.ts';
import { snapshotState, type OperationSnapshot } from './operation-snapshot.ts';
import type { OperationStore } from './operation-store.ts';

/** Read-receipt invalidation stays conservative. Undo uses actual per-file
 * evidence, so a known unchanged shell checkpoint is not a file write. */
export class RestoreHistory {
  private readonly coordinator: WorkspaceCoordinator;
  private readonly operations?: OperationStore;
  private readonly snapshots = new Map<string, Promise<OperationSnapshot>>();
  constructor(coordinator: WorkspaceCoordinator, operations?: OperationStore) { this.coordinator = coordinator; this.operations = operations; }
  private snapshot(hash: string) {
    if (!this.snapshots.has(hash)) this.snapshots.set(hash, this.operations!.loadSnapshot(hash));
    return this.snapshots.get(hash)!;
  }
  async check(path: string, since: number): Promise<{ conflicts: string[]; warnings: string[] }> {
    const conflicts: string[] = []; const warnings: string[] = []; const checked = new Set<string>();
    for (const event of await this.coordinator.eventsAfter(path, since)) {
      const operation = event.operationId && this.operations?.get(event.operationId);
      const owner = `会话 ${event.sessionId.slice(0, 8)}，${operation ? `工具 ${operation.tool}，操作 ${operation.id.slice(0, 8)}` : `事件 ${event.seq}`}`;
      if (event.paths) { conflicts.push(`本轮之后发生过针对此文件的操作（${owner}），不会覆盖后续修改`); continue; }
      if (!event.operationId && /^(finished )?potential side effects: /.test(event.reason)) {
        warnings.push(`历史脚本／工具事件 ${event.seq}（${owner}）缺少逐文件快照。当前完整版本一致时，可人工确认仅恢复本预览列出的文件；未归属文件不包含在内。`);
        continue;
      }
      if (!operation || operation.sessionId !== event.sessionId || canonical(operation.cwd) !== canonical(event.cwd)) {
        conflicts.push(`后续操作缺少可核验日志（${owner}），无法确认是否影响此文件`); continue;
      }
      if (checked.has(operation.id)) continue;
      checked.add(operation.id);
      if (!['completed', 'failed'].includes(operation.status)) { conflicts.push(`后续操作尚未完整结束（${owner}），请先处理 /recovery`); continue; }
      if (operation.invoked === false || operation.tool === 'codemode') continue;
      if (operation.footprint?.error || !operation.footprint?.before || !operation.footprint?.after) {
        conflicts.push(`后续操作的文件快照不完整（${owner}）：${operation.footprint?.error ?? '缺少操作前／后记录'}`); continue;
      }
      try {
        const [before, after] = await Promise.all([this.snapshot(operation.footprint.before), this.snapshot(operation.footprint.after)]);
        if (canonical(before.cwd) !== canonical(operation.cwd) || canonical(after.cwd) !== canonical(operation.cwd)) throw new Error('快照目录与操作不一致');
        const a = snapshotState(before, path); const b = snapshotState(after, path);
        if (!a.known || !b.known) conflicts.push(`无法核验后续操作对该文件的影响（${owner}）：${a.issue ?? b.issue}`);
        else if (!sameState(a.state, b.state)) conflicts.push(`后续脚本／工具确实改变了此文件的版本（${owner}），不会覆盖后续修改`);
      } catch (error) { conflicts.push(`后续操作的快照缺失或损坏（${owner}）：${String(error)}`); }
    }
    return { conflicts, warnings };
  }
}
