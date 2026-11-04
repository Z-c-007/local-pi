import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryBackend, MemoryRecord } from './memory.ts';

const limit = 10_000;
const header = '# Local Pi 长期记忆\n\n<!-- local-pi-memory v1 -->\n';
const marker = /<!-- local-pi-entry (\{[^\n]*\}) -->\r?\n/g;
export const memoryHash = (text: string) => createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class MemoryFileError extends Error {}

function parse(text: string, modified: number): MemoryRecord[] {
  text = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  if (text.includes('\ufffd')) throw new Error('记忆 MD 编码无效，未修改文件。');
  const matches = [...text.matchAll(marker)];
  const records: MemoryRecord[] = [];
  const manual = (value: string) => {
    const memory = value.trim(); if (!memory) return;
    records.push({ id: `manual-${digest(memory).slice(0, 24)}`, memory,
      metadata: { source: 'markdown-edit', sourceTime: modified, localPiHash: memoryHash(memory) } });
  };
  // A plain Markdown file is accepted as paragraphs, so users can start by hand.
  if (!matches.length) {
    if (text.includes('<!-- local-pi-entry')) throw new Error('记忆条目标记损坏，未覆盖 MD。');
    const plain = text.replace(header, '').replace(/^\uFEFF/, '');
    for (const part of plain.split(/\r?\n\s*\r?\n/)) manual(part);
  } else {
    manual(text.slice(0, matches[0]!.index).replace(header, '').replace(/^\uFEFF/, ''));
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const data = JSON.parse(match[1]!) as { id?: string; metadata?: Record<string, unknown>; hash?: string };
      const memory = text.slice(match.index! + match[0].length, matches[i + 1]?.index ?? text.length).trim();
      if (!memory) continue;
      if (!data.id || !/^[\w-]{1,128}$/.test(data.id) || !data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) throw new Error('记忆条目标记无效。');
      const changed = data.hash !== digest(memory);
      records.push({ id: data.id, memory, metadata: { ...data.metadata,
        ...(changed ? { source: 'markdown-edit', sourceTime: modified, localPiOperation: undefined } : {}), localPiHash: memoryHash(memory) } });
    }
  }
  if (records.length >= limit || records.some((record) => record.memory.length > 4000 || record.memory.includes('<!-- local-pi-entry'))
    || new Set(records.map((record) => record.id)).size !== records.length) throw new Error('记忆 MD 过大、条目重复或格式损坏，未覆盖文件。');
  return records;
}

function render(records: MemoryRecord[]): string {
  const contents = header + '\n' + records.map((record) => {
    const json = JSON.stringify({ id: record.id, hash: digest(record.memory), metadata: record.metadata ?? {} }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return `<!-- local-pi-entry ${json} -->\n${record.memory}\n`;
  }).join('\n');
  if (Buffer.byteLength(contents) > 8 * 1024 * 1024) throw new Error('记忆 MD 超过 8MiB，未发布文件。');
  return contents;
}

/** The surrounding ProjectMemory lease serializes cooperating writers. The
 * byte check also refuses a hand edit made while the embedding request ran. */
export async function markdownBackend(directory: string, index: MemoryBackend): Promise<MemoryBackend> {
  const path = join(directory, 'MEMORY.md'); const initialized = join(directory, 'markdown-v1.json');
  async function bytes(): Promise<string | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('记忆 MD 必须是独立普通文件，且不超过 8MiB。');
      return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async function allIndexed(): Promise<MemoryRecord[]> {
    const rows = (await index.getAll({ filters: { user_id: 'local-pi' }, topK: limit, showExpired: true })).results;
    if (rows.length >= limit) throw new Error('记忆库超过自动迁移上限，请先备份并拆分；未截断数据。');
    return rows;
  }
  let raw = await bytes();
  if (raw === undefined) {
    let migrated = false;
    try { await readFile(initialized); migrated = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!migrated) {
      const previous = await allIndexed();
      // A complete legacy snapshot is retained independently from the rebuilt index.
      await writeFile(join(directory, 'legacy-before-markdown.json'), JSON.stringify(previous, null, 2), { flag: 'wx' }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      raw = render(previous);
      await writeFile(path, raw, { flag: 'wx' });
    }
  }
  await writeFile(initialized, '{"version":1}\n', { flag: 'wx' }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const legacyPath = join(directory, 'legacy-before-markdown.json');
  let legacy: MemoryRecord[];
  try { legacy = JSON.parse(await readFile(legacyPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    legacy = await allIndexed();
    await writeFile(legacyPath, JSON.stringify(legacy, null, 2), { flag: 'wx' });
  }
  const legacyIds = new Set(legacy.map((record) => record.id));
  let records = parse(raw ?? '', (await lstat(path).catch(() => undefined))?.mtimeMs ?? Date.now());
  function observe(next: MemoryRecord[]): void {
    const db = new DatabaseSync(join(directory, 'control.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tombstones(hash TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS markdown_seen(id TEXT PRIMARY KEY, memory TEXT NOT NULL);');
      for (const old of db.prepare('SELECT id,memory FROM markdown_seen').all() as Array<{ id: string; memory: string }>) {
        if (next.find((record) => record.id === old.id)?.memory !== old.memory) db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(memoryHash(old.memory));
      }
      db.exec('BEGIN IMMEDIATE');
      db.exec('DELETE FROM markdown_seen');
      for (const record of next) db.prepare('INSERT INTO markdown_seen VALUES (?,?)').run(record.id, record.memory);
      db.exec('COMMIT');
    } finally { db.close(); }
  }
  observe(records);

  async function unchanged(): Promise<void> {
    if (await bytes() !== raw) throw new MemoryFileError('记忆 MD 已被手动或其他进程修改，请重新操作；未覆盖新内容。');
  }
  async function commit(next: MemoryRecord[]): Promise<void> {
    const contents = render(next); parse(contents, Date.now());
    const temporary = join(directory, `.memory-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx');
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      await unchanged();
      // Save exactly the version this operation replaced, not the user's next edit.
      if (raw !== undefined) await writeFile(join(directory, `memory-backup-${digest(raw)}.md`), raw, { flag: 'wx' }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      await unchanged(); await rename(temporary, path); raw = contents; records = next;
      observe(records);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function knownIndexed(): Promise<MemoryRecord[]> {
    const rows = await allIndexed();
    if (rows.some((row) => !row.metadata?.localPiMarkdownId && !legacyIds.has(row.id))) {
      throw new MemoryFileError('索引发现旧版本进程或外部程序写入的未迁移记忆；请关闭旧版 local-pi 后检查，未删除这些内容。');
    }
    return rows;
  }
  async function sync(): Promise<void> {
    const wanted = new Map(records.map((record) => [record.id, record]));
    const rows = await knownIndexed(); const indexed = new Set<string>();
    for (const row of rows) {
      const id = String(row.metadata?.localPiMarkdownId ?? row.id); const record = wanted.get(id);
      if (!record || indexed.has(id)) { await index.delete(row.id); continue; }
      indexed.add(id);
      if (record.memory !== row.memory || !Object.entries({ ...record.metadata, localPiMarkdownId: id })
        .every(([key, value]) => JSON.stringify(row.metadata?.[key]) === JSON.stringify(value))) {
        if (!index.update) throw new Error('记忆索引不支持更新。');
        await index.update(row.id, { text: record.memory, metadata: { ...record.metadata, localPiMarkdownId: id } });
      }
    }
    for (const record of records) if (!indexed.has(record.id)) await index.add([{ role: 'user', content: record.memory }], {
      userId: 'local-pi', infer: false, metadata: { ...record.metadata, localPiMarkdownId: record.id } });
    await unchanged();
  }
  return {
    async reindex() { await unchanged(); for (const row of await knownIndexed()) await index.delete(row.id); await sync(); },
    async getAll(options) {
      await unchanged();
      const filters = options.filters as Record<string, unknown> | undefined;
      return { results: records.filter((record) => Object.entries(filters ?? {}).every(([key, value]) => key === 'user_id' || record.metadata?.[key] === value)).slice(0, Number(options.topK ?? limit)) };
    },
    async get(id) { await unchanged(); return records.find((record) => record.id === id) ?? null; },
    async search(query, options) {
      await sync();
      const result = await index.search(query, options); await unchanged();
      return { results: result.results.flatMap((row) => {
        const record = records.find((item) => item.id === String(row.metadata?.localPiMarkdownId ?? row.id));
        return record ? [{ ...record, score: row.score }] : [];
      }) };
    },
    async add(messages, options) {
      await sync();
      const record = { id: randomUUID(), memory: messages.map((message) => message.content).join('\n'), metadata: options.metadata as Record<string, unknown> };
      await index.add(messages, { ...options, metadata: { ...record.metadata, localPiMarkdownId: record.id } });
      await commit([...records, record]);
    },
    async update(id, options) {
      await sync();
      const row = (await allIndexed()).find((item) => String(item.metadata?.localPiMarkdownId ?? item.id) === id);
      if (!row || !index.update) throw new Error('当前范围内找不到这条记忆。');
      await index.update(row.id, { text: options.text, metadata: { ...options.metadata, localPiMarkdownId: id } });
      await commit(records.map((record) => record.id === id ? { id, memory: options.text, metadata: options.metadata } : record));
    },
    async delete(id) {
      // File publication commits a deletion; stale index rows are filtered and
      // removed by the next sync. Forgetting does not depend on model availability.
      await commit(records.filter((record) => record.id !== id));
    },
  };
}
