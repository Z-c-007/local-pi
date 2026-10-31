import { randomUUID } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { forkEntryType } from './fork.ts';

export const taskMetricsType = 'local-pi-task-metrics';
type Tokens = ReturnType<AgentSession['getSessionStats']>['tokens'];
export interface TaskReport {
  version: 1;
  id: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  afterTimestamp?: number;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  tokens?: Tokens;
  partialUsage?: boolean;
}

export function readTaskReports(session: AgentSession): TaskReport[] {
  const reports = new Map<string, TaskReport>();
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === 'custom' && entry.customType === forkEntryType) reports.clear();
    if (entry.type !== 'custom' || entry.customType !== taskMetricsType) continue;
    const data = entry.data as TaskReport | undefined;
    if (data?.version === 1 && typeof data.id === 'string' && Number.isFinite(data.startedAt)) reports.set(data.id, data);
  }
  return [...reports.values()];
}

export class TaskMetrics {
  current?: TaskReport;
  private baseline?: Tokens;
  private clock = 0;
  private firstEntry = 0;

  begin(session: AgentSession): void {
    if (this.current) return;
    this.baseline = session.getSessionStats().tokens;
    this.firstEntry = session.sessionManager.getEntryCount();
    this.clock = performance.now();
    this.current = { version: 1, id: randomUUID(), startedAt: Date.now(), status: 'running' };
    session.sessionManager.appendCustomEntry(taskMetricsType, this.current);
  }

  elapsedMs(): number { return this.current ? Math.max(0, performance.now() - this.clock) : 0; }

  finish(session: AgentSession, status: Exclude<TaskReport['status'], 'running'>): void {
    if (!this.current || !this.baseline) return;
    const total = session.getSessionStats().tokens;
    const tokens = Object.fromEntries(Object.entries(total).map(([key, value]) => [key,
      Math.max(0, value - this.baseline![key as keyof Tokens])])) as Tokens;
    const afterTimestamp = session.messages.at(-1)?.timestamp;
    const missingUsage = session.sessionManager.getEntries().slice(this.firstEntry).some((entry) =>
      entry.type === 'message' && entry.message.role === 'assistant'
      && !['error', 'aborted'].includes(entry.message.stopReason) && entry.message.usage.totalTokens === 0);
    const report: TaskReport = { ...this.current, status, finishedAt: Date.now(), durationMs: this.elapsedMs(),
      ...(afterTimestamp !== undefined ? { afterTimestamp } : {}),
      ...(tokens.total > 0 ? { tokens, ...(missingUsage ? { partialUsage: true } : {}) } : {}) };
    session.sessionManager.appendCustomEntry(taskMetricsType, report);
    this.current = undefined;
    this.baseline = undefined;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatTaskReport(report: TaskReport): string {
  if (report.status === 'running') return '上次任务未记录结束（程序退出或中断），耗时和 Token 未知。';
  const labels = { completed: '已完成', failed: '失败', aborted: '已停止' };
  const tokens = report.tokens;
  return `本次耗时 ${formatDuration(report.durationMs ?? 0)} · ${labels[report.status]} · ${tokens
    ? `Token ${tokens.total.toLocaleString()}（输入 ${tokens.input.toLocaleString()} / 输出 ${tokens.output.toLocaleString()} / 缓存读 ${tokens.cacheRead.toLocaleString()} / 写 ${tokens.cacheWrite.toLocaleString()}）${report.partialUsage ? ' · 部分响应未返回用量' : ''}`
    : 'Token 未知（接口未提供可用统计）'}`;
}
