import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceCoordinator } from './workspace-coordinator.ts';

export interface OllamaEmbeddingConfig {
  baseURL: string; model: string; dimension: number;
  timeoutMs?: number; queryInstruction?: string;
}

export function ollamaQueryInstruction(config: OllamaEmbeddingConfig): string {
  return config.queryInstruction ?? (/^qwen3-embedding(?::|$)/i.test(config.model)
    ? 'Given a coding assistant request, retrieve relevant user preferences and project facts that help answer it.' : '');
}

/** One endpoint queue per agent directory, shared by sessions and processes.
 * Ollama owns model loading; we never launch another runner for each session. */
export function ollamaEmbedder(config: OllamaEmbeddingConfig, root: string) {
  const base = new URL(config.baseURL);
  base.pathname = base.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/api/embed';
  const gate = join(root, 'inference', createHash('sha256').update(base.href).digest('hex').slice(0, 24));
  const coordinator = new WorkspaceCoordinator(join(root, 'inference'));
  async function encode(texts: string[], action?: string): Promise<number[][]> {
    if (!texts.length) return [];
    const instruction = ollamaQueryInstruction(config);
    const input = action === 'search' && instruction
      ? texts.map((text) => `Instruct: ${instruction}\nQuery:${text}`) : texts;
    const signal = AbortSignal.timeout(config.timeoutMs ?? 60_000);
    await mkdir(gate, { recursive: true });
    const lease = await coordinator.wait(gate, 'write', 'local-pi-embedding', { signal });
    try {
      const response = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model: config.model, input, dimensions: config.dimension,
          truncate: false, keep_alive: '5m', options: { num_thread: 4, num_ctx: 4096 } }),
      });
      if (!response.ok) throw new Error(`本地向量模型请求失败（HTTP ${response.status}）。`);
      const body = await response.json() as { embeddings?: number[][] };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length
        || body.embeddings.some((vector) => !Array.isArray(vector) || vector.length !== config.dimension || !vector.every(Number.isFinite))) {
        throw new Error('Embedding 返回的向量与配置维数不一致或包含无效数值。');
      }
      return body.embeddings;
    } finally { await coordinator.release(lease); }
  }
  return {
    async embed(text: string, action?: string) { return (await encode([text], action))[0]!; },
    embedBatch(texts: string[], action?: string) { return encode(texts, action); },
  };
}
