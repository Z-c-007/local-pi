import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileStamp, within, type FileState } from './file-changes.ts';
import { canonical } from './workspace-coordinator.ts';

export async function checkedPath(cwd: string, path: string): Promise<string> {
  if (!path || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') || /[:\0]/.test(path)) throw new Error('非法恢复路径');
  if (canonical(await realpath(cwd)) !== canonical(cwd)) throw new Error('工作目录真实路径已变化');
  const parts = path.split(/[\\/]/); let parent = cwd;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part); const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !within(cwd, await realpath(parent))) throw new Error('父目录不是工作区内的普通目录');
  }
  const absolute = resolve(cwd, ...parts);
  if (!within(cwd, absolute)) throw new Error('恢复目标超出工作区');
  return absolute;
}

export async function fileState(cwd: string, path: string, maxBytes = 2 * 1024 * 1024): Promise<{ state?: FileState; bytes?: Buffer }> {
  const absolute = await checkedPath(cwd, path);
  let stat;
  try { stat = await lstat(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !within(cwd, await realpath(absolute))) throw new Error('文件类型、链接数或真实路径不适合自动恢复');
  if (stat.size > maxBytes) throw new Error('当前文件超过版本校验大小上限');
  const handle = await open(absolute, 'r');
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  const after = await lstat(absolute);
  if (fileStamp(after) !== fileStamp(stat) || bytes.length !== stat.size) throw new Error('校验期间文件发生变化');
  return { state: { hash: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode, size: stat.size, stamp: fileStamp(stat), links: stat.nlink }, bytes };
}
export const sameState = (a?: FileState, b?: FileState): boolean => !a && !b || !!a?.hash && a.hash === b?.hash && a.mode === b.mode && a.stamp === b.stamp && a.links === 1 && b.links === 1;
