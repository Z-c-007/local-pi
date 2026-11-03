import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, basename, join, relative, resolve } from 'node:path';
import { fileState, sameState } from './file-state.ts';
import { snapshotExcludes, within, type FileState } from './file-changes.ts';
import { canonical } from './workspace-coordinator.ts';
import type { OperationStore } from './operation-store.ts';

interface Entry { path: string; state?: FileState; issue?: string }
export interface OperationSnapshot {
  version: 1; cwd: string; files: Record<string, Entry>;
  directories: Record<string, { path: string; names: string[] }>;
  issues: string[];
}
export interface OperationFootprint { version: 1; before?: string; after?: string; error?: string }
export interface SnapshotState { known: boolean; state?: FileState; issue?: string }
export interface SnapshotLimits { files: number; bytes: number; fileBytes: number }
const limits: SnapshotLimits = { files: 10000, bytes: 64 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Absence requires a complete directory listing, not a missing entry in a capped scan. */
export function snapshotState(snapshot: OperationSnapshot, path: string): SnapshotState {
  const key = canonical(path); const entry = snapshot.files[key];
  if (entry) return entry.issue ? { known: false, issue: entry.issue } : { known: true, state: entry.state };
  let current = key;
  while (within(canonical(snapshot.cwd), current) && current !== dirname(current)) {
    const parent = dirname(current); const listing = snapshot.directories[canonical(parent)];
    if (listing) {
      if (!listing.names.includes(process.platform === 'win32' ? basename(current).toLowerCase() : basename(current))) return { known: true };
      return { known: false, issue: '目标或其父目录存在，但未完整记录该文件' };
    }
    current = parent;
  }
  return { known: false, issue: '目标不在完整快照覆盖范围内' };
}

export function snapshotChanges(before: OperationSnapshot, after: OperationSnapshot) {
  const result: Array<{ path: string; before?: FileState; after?: FileState }> = [];
  for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const a = snapshotState(before, path); const b = snapshotState(after, path);
    if (!a.known || !b.known || sameState(a.state, b.state)) continue;
    result.push({ path: after.files[path]?.path ?? before.files[path]!.path, before: a.state, after: b.state });
  }
  return result;
}

/** Bounded operation checkpoint taken under the workspace lease. Focus directories
 * are scanned first, independently of unrelated large trees and oversized files. */
export async function takeOperationSnapshot(cwd: string, store: OperationStore, options: {
  tracked: string[]; focus: string[]; priority?: string[]; excluded?: string[]; limits?: Partial<SnapshotLimits>; baseline?: OperationSnapshot;
}): Promise<OperationSnapshot> {
  const budget = { ...limits, ...options.limits }; const root = canonical(cwd);
  const result: OperationSnapshot = { version: 1, cwd, files: Object.create(null), directories: Object.create(null), issues: [] };
  const visited = new Set<string>(); let count = 0; let bytes = 0;
  const excluded = (path: string) => (options.excluded ?? []).some((folder) => within(canonical(folder), canonical(path)));
  const issue = (path: string, reason: string) => {
    result.issues.push(`${relative(cwd, path) || '.'}: ${reason}`);
    result.files[canonical(path)] = { path, issue: reason };
  };
  const capture = async (path: string) => {
    const key = canonical(path);
    if (result.files[key]) return;
    if (excluded(path)) { issue(path, '配置／历史存储目录不参与脚本快照'); return; }
    if (++count > budget.files) { issue(path, '操作快照条目超过上限'); return; }
    try {
      const state = await fileState(cwd, relative(cwd, path).replaceAll('\\', '/'), Math.min(budget.fileBytes, Math.max(0, budget.bytes - bytes)));
      if (bytes + (state.bytes?.length ?? 0) > budget.bytes) { issue(path, '操作快照字节总量超过上限'); return; }
      await store.backup(state.bytes); bytes += state.bytes?.length ?? 0;
      result.files[key] = { path, state: state.state };
    } catch (error) {
      // A missing parent is unknown until its absence can be proved by a listing.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(path, message(error));
    }
  };
  const visit = async (folder: string): Promise<void> => {
    const key = canonical(folder);
    if (visited.has(key) || excluded(folder) || count >= budget.files) return;
    visited.add(key);
    try {
      const stat = await lstat(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory() || canonical(await realpath(folder)) !== key) {
        issue(folder, '不跟随符号链接／目录联接'); return;
      }
      const originalNames = options.baseline?.directories[key]?.names;
      const isNew = (name: string) => originalNames && !originalNames.includes(process.platform === 'win32' ? name.toLowerCase() : name);
      const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => Number(!!isNew(b.name)) - Number(!!isNew(a.name)) || a.name.localeCompare(b.name));
      if (entries.length > budget.files) { issue(folder, '目录条目过多，不能证明未记录文件不存在'); return; }
      result.directories[key] = { path: folder, names: entries.map((entry) => process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) };
      for (const entry of entries) {
        if (count >= budget.files) break;
        const path = join(folder, entry.name);
        if (excluded(path) || snapshotExcludes.includes(entry.name.toLowerCase())) continue;
        if (entry.isDirectory()) { count++; await visit(path); }
        else await capture(path);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(folder, message(error)); }
  };
  // Exact previously written paths remain independently checkable even when the
  // surrounding workspace is too large to scan fully.
  for (const path of options.priority ?? []) {
    if (count >= budget.files) break;
    if (within(root, canonical(path))) await capture(resolve(path));
  }
  for (const folder of options.focus) if (within(root, canonical(folder))) await visit(resolve(folder));
  for (const path of options.tracked) {
    if (count >= budget.files) break;
    if (within(root, canonical(path))) await capture(resolve(path));
  }
  await visit(cwd);
  if (count >= budget.files) result.issues.push('操作快照达到条目上限；未完整记录的现存文件保持未知。');
  return result;
}
