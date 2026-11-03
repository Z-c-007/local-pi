import { existsSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ProjectMemory, type MemoryConfig } from "./memory.ts";
import {
  MemoryQueue,
  memorySources,
  type MemoryBatch,
  type MemoryPolicy,
} from "./memory-queue.ts";
import {
  MemoryExtractionError,
  type ExtractedChange,
  type MemoryExtractor,
} from "./memory-extractor.ts";

export function memoryPolicy(config: MemoryConfig): MemoryPolicy {
  if (
    config.automatic !== undefined &&
    (!config.automatic ||
      typeof config.automatic !== "object" ||
      Array.isArray(config.automatic))
  )
    throw new Error("自动记忆配置必须为对象。");
  const automatic = config.automatic ?? {};
  const turns = automatic.turnThreshold ?? 20;
  const tokens = automatic.tokenThreshold ?? 8000;
  const idle = automatic.idleMinutes ?? 10;
  if (
    !Number.isInteger(turns) ||
    turns < 1 ||
    turns > 100 ||
    !Number.isInteger(tokens) ||
    tokens < 128 ||
    tokens > 32000 ||
    !Number.isFinite(idle) ||
    idle < 0.01 ||
    idle > 1440 ||
    (automatic.enabled !== undefined &&
      typeof automatic.enabled !== "boolean") ||
    (automatic.model !== undefined &&
      (typeof automatic.model !== "string" ||
        !/^[^/]+\/.+$/.test(automatic.model)))
  )
    throw new Error("自动记忆配置无效。");
  return {
    enabled: automatic.enabled ?? true,
    turns,
    tokens,
    idleMs: idle * 60_000,
    model: automatic.model,
  };
}

export interface MemorySnapshot {
  session: string;
  model: string;
  entries: readonly SessionEntry[];
  busy?: boolean;
}
export interface AutomaticMemoryOptions {
  extractor?: MemoryExtractor;
  now?: () => number;
  timers?: boolean;
  timeoutMs?: number;
  status?: (text: string) => void;
}

export class AutomaticMemory {
  readonly queue: MemoryQueue;
  private memory: ProjectMemory;
  private extractor?: MemoryExtractor;
  private options: AutomaticMemoryOptions;
  private now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private abort?: AbortController;
  private job?: MemoryBatch;
  private previousSnapshot?: MemorySnapshot;
  private closed = false;
  constructor(memory: ProjectMemory, options: AutomaticMemoryOptions = {}) {
    this.memory = memory;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.extractor = options.extractor;
    this.queue = new MemoryQueue(memory.root);
  }
  setExtractor(extractor: MemoryExtractor): void {
    this.extractor = extractor;
  }
  private report(text: string): void {
    if (!this.closed) this.options.status?.(text);
  }
  async capture(
    snapshot: MemorySnapshot,
    phase: "start" | "busy" | "settled" | "boundary" | "close" = "settled",
  ): Promise<void> {
    const config = await this.memory.config();
    const enabled = !!config && memoryPolicy(config).enabled;
    const previous = this.previousSnapshot;
    this.previousSnapshot = snapshot;
    if (!enabled && !existsSync(this.queue.path)) return;
    if (enabled && previous?.session === snapshot.session) {
      this.queue.observe(
        this.memory.projectKey,
        snapshot.session,
        memorySources(previous.entries),
        snapshot.model,
        this.now(),
        false,
        this.memory.projectRoot,
      );
    }
    this.queue.observe(
      this.memory.projectKey,
      snapshot.session,
      memorySources(snapshot.entries),
      snapshot.model,
      this.now(),
      enabled,
      this.memory.projectRoot,
    );
    this.queue.touch(
      this.memory.projectKey,
      snapshot.session,
      this.now(),
      phase === "busy" || (phase === "boundary" && !!snapshot.busy),
    );
    if (enabled && phase === "close")
      this.queue.seal(
        this.memory.projectKey,
        memoryPolicy(config!),
        this.now(),
        snapshot.session,
      );
    if (
      enabled &&
      phase !== "close" &&
      !this.timer &&
      this.options.timers !== false &&
      !this.closed
    ) {
      this.timer = setInterval(() => {
        void this.tick().catch(() =>
          this.report("自动记忆：检查失败，请查看配置"),
        );
      }, 15_000);
      this.timer.unref();
    }
  }
  async tick(force = false): Promise<void> {
    if (this.closed || this.work) return;
    const config = await this.memory.config();
    if (this.closed || this.work || !config) return;
    const policy = memoryPolicy(config);
    if (!policy.enabled || !existsSync(this.queue.path)) return;
    const projects = this.queue.projects();
    for (const project of projects)
      this.queue.seal(
        project.project,
        policy,
        this.now(),
        undefined,
        force && project.project === this.memory.projectKey,
      );
    if (!this.extractor) return;
    // Set the guard before invoking an async drain. Multiple callbacks cannot claim two jobs locally.
    this.work = Promise.resolve()
      .then(() => this.drain(projects))
      .catch(() => this.report("自动记忆：后台任务失败"))
      .finally(() => {
        this.work = undefined;
      });
  }
  private async drain(
    projects: Array<{ project: string; root: string }>,
  ): Promise<void> {
    for (const project of projects) {
      if (this.closed) return;
      for (let pass = 0; pass < 8; pass++) {
        const config = await this.memory.config();
        if (this.closed || !config || !memoryPolicy(config).enabled) return;
        if (this.queue.paused(project.project)) break;
        const job = this.queue.claim(project.project, this.now());
        if (!job) break;
        job.model = memoryPolicy(config).model ?? job.model;
        this.job = job;
        this.abort = new AbortController();
        const controller = this.abort;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        let target: ProjectMemory | undefined;
        try {
          target =
            project.project === this.memory.projectKey
              ? this.memory
              : this.memory.forProject(project.root);
          if (target.projectKey !== project.project)
            throw new Error("记忆项目身份已改变。");
          this.report("自动记忆：后台提取中");
          const run = async () => {
            if (
              !job.sources.some(
                (source) =>
                  source.role === "user" || source.role === "verification",
              )
            ) {
              this.queue.finish(job, "没有需要长期保存的信息");
              return;
            }
            let changes: ExtractedChange[];
            if (job.plan) changes = JSON.parse(job.plan) as ExtractedChange[];
            else {
              const query = job.sources
                .filter((source) => source.role === "user")
                .map((source) => source.text)
                .join("\n")
                .slice(0, 1000);
              const existing = (
                await Promise.all(
                  (["project", "global"] as const).map(async (scope) =>
                    (await target!.search(scope, query || "项目决策")).map(
                      (record) => ({ ...record, scope }),
                    ),
                  ),
                )
              ).flat();
              controller.signal.throwIfAborted();
              changes = await this.extractor!(
                { batch: job, existing },
                controller.signal,
              );
              controller.signal.throwIfAborted();
              this.queue.plan(job, JSON.stringify(changes));
            }
            const results: string[] = [];
            for (const change of changes) {
              controller.signal.throwIfAborted();
              const current = await this.memory.config();
              if (
                this.closed ||
                !current ||
                !memoryPolicy(current).enabled ||
                this.queue.paused(project.project)
              )
                throw new Error("自动记忆已暂停。");
              results.push(
                await target!.apply(
                  change,
                  change.operationId,
                  job.session,
                  true,
                  change.evidence,
                  controller.signal,
                ),
              );
            }
            controller.signal.throwIfAborted();
            this.queue.finish(
              job,
              changes.length
                ? `完成 ${changes.length} 项：${results.join("、")}`
                : "没有需要长期保存的信息",
            );
            this.report(
              changes.length
                ? `自动记忆：完成 ${changes.length} 项整理`
                : "自动记忆：本批无新增",
            );
          };
          // A timed-out provider cannot apply a late result. Every mutation rechecks this signal.
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error("记忆提取超时。"));
            }, this.options.timeoutMs ?? 60_000);
            const abort = () => reject(new Error("记忆任务已暂停。"));
            controller.signal.addEventListener("abort", abort, { once: true });
          });
          await Promise.race([run(), timeout]);
        } catch (error) {
          this.queue.fail(
            job,
            this.now(),
            this.closed || this.queue.paused(project.project),
            timedOut
              ? "自动记忆提取超时，等待重试"
              : error instanceof MemoryExtractionError
                ? error.message
                : undefined,
          );
          this.report("自动记忆：任务待重试，用 /memory status 查看");
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
          if (target && target !== this.memory) await target.dispose();
          this.job = undefined;
          this.abort = undefined;
        }
      }
    }
  }
  async enabled(enabled: boolean, snapshot: MemorySnapshot): Promise<void> {
    const config = await this.memory.config();
    if (!config) throw new Error("请先启用并配置记忆。");
    // Establish the disabled-period boundary before resuming, so it is not backfilled.
    this.queue.observe(
      this.memory.projectKey,
      snapshot.session,
      memorySources(snapshot.entries),
      snapshot.model,
      this.now(),
      false,
      this.memory.projectRoot,
    );
    if (enabled && !memoryPolicy(config).enabled)
      throw new Error("请先在配置中开启 automatic.enabled 总开关。");
    this.queue.pause(this.memory.projectKey, !enabled);
    if (!enabled && this.job?.project === this.memory.projectKey)
      this.abort?.abort();
    if (enabled) {
      await this.capture(snapshot, "start");
      await this.tick();
    }
  }
  async retry(): Promise<void> {
    this.queue.retry(this.memory.projectKey);
    await this.tick();
  }
  async baseline(snapshot: MemorySnapshot): Promise<void> {
    this.previousSnapshot = snapshot;
    if (!existsSync(this.queue.path)) return;
    this.queue.observe(
      this.memory.projectKey,
      snapshot.session,
      memorySources(snapshot.entries),
      snapshot.model,
      this.now(),
      false,
      this.memory.projectRoot,
    );
    this.queue.touch(
      this.memory.projectKey,
      snapshot.session,
      this.now(),
      false,
    );
  }
  async status(): Promise<string> {
    const config = await this.memory.config();
    if (!config) return "自动记忆：尚未配置 Embedding，未采集或调用提取模型。";
    const policy = memoryPolicy(config);
    const stored = existsSync(this.queue.path)
      ? this.queue.status(this.memory.projectKey)
      : undefined;
    const paused =
      existsSync(this.queue.path) && this.queue.paused(this.memory.projectKey);
    return `自动记忆：${policy.enabled && !paused ? "开启" : "暂停"}\n触发：${policy.turns} 个用户轮次 / 约 ${policy.tokens} Token / 空闲 ${policy.idleMs / 60_000} 分钟\n提取模型：${policy.model ?? "沿用采集时的 Pi 会话模型与认证"}\n待处理：${stored?.pendingTurns ?? 0} 轮，约 ${stored?.pendingTokens ?? 0} Token\n任务：${stored?.jobs.map((item) => `${item.state} ${item.total}`).join("；") || "无"}\n\n最近任务：\n${stored?.recent.map((item) => `${item.id.slice(0, 10)} · ${item.state} · ${item.result || "等待处理"}`).join("\n") || "无"}`;
  }
  async idle(): Promise<void> {
    await this.work;
  }
  async stop(snapshot?: MemorySnapshot): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    if (this.job) this.queue.fail(this.job, this.now(), true);
    if (snapshot) await this.capture(snapshot, "close");
  }
}
