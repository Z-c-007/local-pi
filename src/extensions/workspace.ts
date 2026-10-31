import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { mcpTools, modeEntryType, modeInstruction, modeLabel, readTools, restoreMode, toolsForMode, type WorkMode } from '../agent/mode.ts';

export const createWorkspaceExtension = (initialMode: WorkMode): ExtensionFactory => (pi) => {
  let mode = initialMode;
  const executionMcpTools = new Set<string>();
  const activeTools = () => {
    const tools = pi.getAllTools();
    // Remember the native MCP extension's choices before discussion temporarily hides them.
    // Do not eagerly declare deferred tools or override autoEnableCodemode=false.
    for (const name of pi.getActiveTools()) if (name.startsWith('mcp__') || mcpTools.includes(name)) executionMcpTools.add(name);
    return [...toolsForMode(mode), ...(mode === 'execute' ? tools.filter((tool) =>
      tool.exposure === 'direct' && tool.name.startsWith('mcp__') || executionMcpTools.has(tool.name)).map((tool) => tool.name) : [])];
  };
  const apply = (ctx: ExtensionContext) => {
    pi.setActiveTools(activeTools());
    ctx.ui.setStatus('local-pi', `Local Pi · ${modeLabel(mode)}`);
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    mode = restoreMode(ctx.sessionManager.getBranch());
    apply(ctx);
  };
  pi.on('session_start', restore);
  pi.on('session_tree', restore);

  const switchMode = (next: WorkMode, ctx: ExtensionContext) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify('请先停止当前任务，再切换模式。', 'warning');
      return;
    }
    if (mode !== next) {
      mode = next;
      pi.appendEntry(modeEntryType, { mode });
      // A metadata entry restores application state but is not sent to the model.
      pi.sendMessage({
        customType: 'local-pi-mode-change', content: modeInstruction(mode), display: false, details: { mode },
      }, { triggerTurn: false });
    }
    apply(ctx);
    ctx.ui.notify(next === 'discuss'
      ? '已进入讨论模式：仅开放读取和搜索工具。'
      : '已进入执行模式：可修改文件和执行命令。请输入需要执行的任务。', 'info');
  };
  pi.registerCommand('discuss', {
    description: '进入讨论模式：只读分析，不修改文件或执行命令',
    handler: async (_args, ctx) => switchMode('discuss', ctx),
  });
  pi.registerCommand('execute', {
    description: '进入执行模式：允许修改代码和执行命令，不自动开始任务',
    handler: async (_args, ctx) => switchMode('execute', ctx),
  });

  pi.on('before_agent_start', (event, ctx) => {
    apply(ctx);
    const instruction = modeInstruction(mode);
    // Structured sections are persisted and updated with Pi's normal prompt protocol.
    event.systemPromptOptions.sections.local_pi_mode = instruction;
    event.systemPromptOptions.selectedTools = activeTools();
    // Also give the model a fresh state notice after the user's input. This repairs
    // old conversations that contain an assistant's incorrect "still in discuss" claim.
    return { message: {
      customType: 'local-pi-mode-context', content: instruction, display: false, details: { mode },
    } };
  });
  pi.on('tool_call', (event) => {
    if (mode === 'discuss' && !readTools.includes(event.toolName)) {
      return { block: true, reason: '讨论模式仅允许读取和搜索。请用户手动切换 /execute 后再执行修改或命令。', terminate: true };
    }
  });

  pi.registerCommand('project', {
    description: '显示当前工作目录、模型和工具',
    handler: async (_args, ctx) => {
      ctx.ui.notify([
        `项目：${ctx.cwd}`,
        `模式：${modeLabel(mode)}`,
        `模型：${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '未选择（使用 /login、/model）'}`,
        `工具：${pi.getActiveTools().join(', ')}`,
      ].join('\n'), 'info');
    },
  });

  pi.registerCommand('changes', {
    description: '查看工作区、暂存区的 Git diff 和未跟踪文件列表',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify('请先停止当前任务，再查看完整变更。', 'warning');
        return;
      }
      const git = async (args: string[]) => pi.exec('git', ['-C', ctx.cwd, ...args], { timeout: 10_000 });
      const status = await git(['status', '--short']);
      if (status.code !== 0) {
        ctx.ui.notify('当前目录不是 Git 仓库，或 Git 不可用。', 'warning');
        return;
      }
      const unstaged = await git(['diff', '--no-ext-diff', '--no-textconv']);
      const staged = await git(['diff', '--cached', '--no-ext-diff', '--no-textconv']);
      if (unstaged.code !== 0 || staged.code !== 0) {
        ctx.ui.notify('读取 Git diff 失败，请在终端执行 git diff 查看。', 'error');
        return;
      }
      const content = [
        '# 当前 Git 变更',
        '```text', status.stdout.trim() || '没有变更', '```',
        '## 未暂存', '```diff', unstaged.stdout.trim() || '无', '```',
        '## 已暂存', '```diff', staged.stdout.trim() || '无', '```',
        '未跟踪文件仅列出文件名；完整内容可让助手读取。',
      ].join('\n');
      pi.sendMessage({ customType: 'local-pi-changes', content, display: true }, { triggerTurn: false });
    },
  });
};
