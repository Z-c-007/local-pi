import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { ProjectMemory, type MemoryRecord, type MemoryScope } from '../agent/memory.ts';
import { infoPanel } from '../tui/info-panel.ts';
import { panelFrame } from '../tui/panel-frame.ts';
import { AutomaticMemory, type MemorySnapshot } from '../agent/automatic-memory.ts';
import { piMemoryExtractor } from '../agent/memory-extractor.ts';
import { MemoryFileError } from '../agent/markdown-memory.ts';

const help = `/memory status 查看配置与存储位置
/memory list [project|global] 查看记忆（最多 100 条）
/memory add project 内容 保存当前项目记忆
/memory add global 内容 保存全局记忆
/memory search project 关键词 搜索当前项目
/memory search global 关键词 搜索全局
/memory delete project|global ID 预览并确认删除
/memory edit project|global ID 内容 预览并确认修改
/memory used 查看本会话最近一轮召回
/memory reindex project|global 从 MD 重建检索索引
/memory auto on|off 开启／暂停当前项目自动提取
/memory extract 立即检查当前项目的待处理内容并加入后台
/memory retry 重试当前项目的失败批次

记忆只有全局和项目两个范围。会话 ID 仅记录来源。
默认按同一会话的新增20轮／约8000 Token／空闲10分钟批量提取。
切换会话不触发提取；关闭时保存待处理批次，启动后恢复。`;

function scopeOf(value: string | undefined): MemoryScope {
  if (value !== 'project' && value !== 'global') throw new Error('请明确指定 project 或 global。');
  return value;
}
export function formatMemories(records: MemoryRecord[]): string {
  return records.length ? records.map((record) => `## ${record.id}\n\n${record.memory}\n\n来源：${String(record.metadata?.sourceSessionId ?? '未知')}\n保存时间：${String(record.metadata?.savedAt ?? '未知')}`).join('\n\n') : '没有找到记忆。';
}
async function show(ctx: ExtensionContext, title: string, content: string): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify(`${title}\n${content}`, 'info'); return; }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const panel = infoPanel(() => content, () => Math.max(4, tui.terminal.rows - 10), () => tui.requestRender(), () => done());
    return {
      render(width: number) {
        if (width < 10) return panel.render(width);
        const frame = panelFrame(width, () => theme);
        return [frame.top(title), ...panel.render(frame.inner).map(frame.row), frame.bottom()];
      },
      invalidate: () => panel.invalidate(), handleInput: (data: string) => panel.handleInput?.(data),
    };
  }, { overlay: true, overlayOptions: { width: '90%', maxHeight: '85%', anchor: 'center' } });
}

export function createMemoryExtension(memory: ProjectMemory): ExtensionFactory {
  return (pi) => {
    let ui: ExtensionContext['ui'] | undefined;
    const automatic = new AutomaticMemory(memory, { status: (text) => ui?.setStatus('local-pi-auto-memory', text) });
    const snapshot = (ctx: ExtensionContext): MemorySnapshot => ({ session: ctx.sessionManager.getSessionId(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '', entries: [...ctx.sessionManager.getBranch()], busy: !ctx.isIdle() });
    const safely = async (action: () => Promise<void>) => {
      try { await action(); } catch { ui?.setStatus('local-pi-auto-memory', '自动记忆：采集或配置检查失败'); }
    };
    pi.on('session_start', async (_event, ctx) => {
      ui = ctx.ui; automatic.setExtractor(piMemoryExtractor(ctx.modelRegistry));
      await safely(async () => { await automatic.capture(snapshot(ctx), 'start'); await automatic.tick(); });
    });
    pi.on('agent_settled', async (_event, ctx) => {
      await safely(async () => { await automatic.capture(snapshot(ctx), 'settled'); await automatic.tick(); });
    });
    pi.on('session_before_compact', async (_event, ctx) => { await safely(() => automatic.capture(snapshot(ctx), 'boundary')); });
    pi.on('session_before_fork', async (_event, ctx) => { await safely(() => automatic.capture(snapshot(ctx), 'boundary')); });
    pi.on('session_before_tree', async (_event, ctx) => { await safely(() => automatic.capture(snapshot(ctx), 'boundary')); });
    pi.on('session_tree', async (_event, ctx) => { await safely(() => automatic.baseline(snapshot(ctx))); });
    pi.on('session_shutdown', async (_event, ctx) => {
      try { await automatic.stop(ctx?.sessionManager ? snapshot(ctx) : undefined); }
      finally { await memory.dispose(); }
    });
    pi.registerCommand('memory', {
      description: '全局／项目记忆：查看、添加、搜索、删除及本次召回',
      handler: async (args, ctx) => {
        if (!ctx.isIdle()) { ctx.ui.notify('请等待当前任务完成后管理记忆。', 'warning'); return; }
        try {
          const [action, rawScope, ...rest] = args.trim().split(/\s+/);
          if (!action) { await show(ctx, '记忆 · 使用帮助', help); return; }
          if (action === 'status') {
            const enabled = !!await memory.config();
            await show(ctx, '记忆 · 状态', `状态：${enabled ? '已配置（MD 为正文，数据库为检索索引）' : '未启用'}\n\n配置：${memory.configPath}\n\n项目根目录：${memory.projectRoot}\n\n全局记忆文件：${memory.markdownPath('global')}\n\n项目记忆文件：${memory.markdownPath('project')}\n\n${await automatic.status()}`);
            return;
          }
          if (action === 'used') { await show(ctx, '记忆 · 最近一轮召回', formatMemories(memory.lastRecall)); return; }
          if (['auto', 'extract', 'retry'].includes(action)) {
            const config = await memory.config();
            if (!config) { ctx.ui.notify('请先配置 Embedding 并开启记忆；配置位置见 /memory status。', 'warning'); return; }
            if (action === 'auto') {
              if (rawScope !== 'on' && rawScope !== 'off') throw new Error('用 /memory auto on 或 off。');
              if (rawScope === 'on' && config.automatic?.enabled === false) { ctx.ui.notify('automatic.enabled 总开关已关闭，请先在记忆配置中设为 true。', 'warning'); return; }
              await automatic.enabled(rawScope === 'on', snapshot(ctx));
              ctx.ui.notify(rawScope === 'on' ? '当前项目自动记忆已开启。' : '当前项目自动提取已暂停；已有记忆仍可召回。', 'info');
            } else if (action === 'extract') {
              await automatic.capture(snapshot(ctx), 'settled'); await automatic.tick(true);
              ctx.ui.notify('已检查当前项目的待处理内容；后台状态见 /memory status。', 'info');
            } else { await automatic.retry(); ctx.ui.notify('已安排失败批次重试，状态见 /memory status。', 'info'); }
            return;
          }
          const scope = scopeOf(rawScope ?? (action === 'list' ? 'project' : undefined));
          const label = scope === 'global' ? '全局' : '当前项目';
          if (action === 'list') { await show(ctx, `记忆 · ${label}`, formatMemories(await memory.list(scope))); return; }
          if (action === 'reindex') { await memory.reindex(scope); ctx.ui.notify(`${label}记忆索引已从 MD 重建。`, 'info'); return; }
          if (action === 'search') { await show(ctx, `记忆 · ${label}搜索`, formatMemories(await memory.search(scope, rest.join(' ')))); return; }
          if (action === 'add') {
            const content = rest.join(' ');
            if (scope === 'global' && (!ctx.hasUI || !await ctx.ui.confirm('保存为全局记忆', `所有项目都可召回：\n${content}`))) return;
            await memory.add(scope, content, ctx.sessionManager.getSessionId());
            ctx.ui.notify(`已保存${label}记忆：${memory.markdownPath(scope)}；下一次提问会读取，内容较多时按相关性召回。`, 'info'); return;
          }
          if (action === 'edit') {
            const [id, ...words] = rest; const text = words.join(' ');
            if (!id || !text) throw new Error('请提供记忆 ID 和新内容。');
            const record = await memory.get(scope, id);
            if (!record) throw new Error('当前范围内找不到这条记忆。');
            if (!ctx.hasUI || !await ctx.ui.confirm(`修改${label}记忆`, `原内容：${record.memory}\n新内容：${text}`)) return;
            await memory.edit(scope, id, text, ctx.sessionManager.getSessionId(), record.memory);
            ctx.ui.notify('记忆已更新。', 'info'); return;
          }
          if (action === 'delete') {
            const id = rest[0];
            if (!id || rest.length !== 1) throw new Error('请输入一条完整记忆 ID。');
            const record = await memory.get(scope, id);
            if (!record) throw new Error('当前范围内找不到这条记忆。');
            if (!ctx.hasUI || !await ctx.ui.confirm(`删除${label}记忆`, `${record.memory}\n\n删除后不再从记忆库召回；已有对话记录仍然保留。`)) return;
            await memory.remove(scope, id);
            ctx.ui.notify('记忆已删除。', 'info'); return;
          }
          throw new Error('未知记忆命令。输入 /memory 查看帮助。');
        } catch (error) {
          // Provider exceptions can contain request headers or credentials. Never echo them to the TUI.
          ctx.ui.notify(error instanceof MemoryFileError ? error.message : `记忆操作未完成。请检查命令、${memory.configPath}、MD 文件格式、Embedding 和网络；记忆文件位置见 /memory status。`, 'error');
        }
      },
    });
    pi.on('before_agent_start', async (event, ctx) => {
      // Explicitly replace this section so a previous turn's retrieval never becomes sticky.
      event.systemPromptOptions.sections.local_pi_memory = '';
      memory.lastRecall = [];
      if (event.messageType !== 'user' || !event.prompt?.trim()) return;
      await safely(() => automatic.capture(snapshot(ctx), 'busy'));
      if (await memory.config().catch(() => undefined)) ctx.ui.setStatus('local-pi-memory', '记忆：等待向量模型／检索中…');
      try {
        const content = await memory.recall(event.prompt);
        event.systemPromptOptions.sections.local_pi_memory = content;
        ctx.ui.setStatus('local-pi-memory', content ? `记忆：召回 ${memory.lastRecall.length} 条` : undefined);
      } catch {
        ctx.ui.setStatus('local-pi-memory', '记忆：本轮未能召回');
        ctx.ui.notify('记忆召回失败，本轮使用原有上下文继续；请用 /memory status 检查配置。', 'warning');
      }
    });
  };
}
