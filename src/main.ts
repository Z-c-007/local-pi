#!/usr/bin/env node
import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { createRuntime } from './agent/runtime.ts';
import { help, parseOptions } from './cli.ts';
import { restoreMode } from './agent/mode.ts';
import { SessionPool } from './agent/session-pool.ts';
import { MultiSessionTui } from './tui/multi-session.ts';

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  if (!options.doctor && options.print === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('TUI 需要交互式终端。请在 PowerShell 中运行 npm start；单次任务可用 --print "任务"。');
  }
  if (!options.classic && !options.doctor && options.print === undefined) {
    const pool = new SessionPool(options);
    try { await new MultiSessionTui(pool).run(); }
    finally { await pool.dispose(); }
    // Like Pi's interactive entry point, exit after all sessions and the terminal
    // are shut down; Windows console handles may otherwise keep Node alive.
    process.exit(0);
  }
  const runtime = await createRuntime(options);
  try {
    if (options.doctor) {
      console.log(JSON.stringify({
        workspace: runtime.cwd,
        mode: restoreMode(runtime.session.sessionManager.getBranch()),
        agentDir: runtime.services.agentDir,
        model: runtime.session.model ? `${runtime.session.model.provider}/${runtime.session.model.id}` : null,
        availableModels: runtime.services.modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`),
        modelConfigError: runtime.services.modelRuntime.getError() ?? null,
        tools: runtime.session.getActiveToolNames(),
        commands: runtime.services.resourceLoader.getExtensions().extensions.flatMap((e) => [...e.commands.keys()]),
        diagnostics: runtime.diagnostics,
        hint: '未发送模型请求。没有可用模型时，在 TUI 中使用 /login 和 /model；自定义接口配置在 agentDir/models.json。',
      }, null, 2));
      return;
    }
    if (options.print !== undefined) {
      await runtime.session.bindExtensions({});
      const unsubscribe = runtime.session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          process.stdout.write(event.assistantMessageEvent.delta);
        } else if (event.type === 'tool_execution_start') {
          process.stderr.write(`\n[工具] ${event.toolName}\n`);
        } else if (event.type === 'tool_execution_end' && event.isError) {
          process.stderr.write(`[工具失败] ${event.toolName}\n`);
        }
      });
      const abort = () => { void runtime.session.abort(); };
      process.once('SIGINT', abort);
      try {
        await runtime.session.prompt(options.print);
        process.stdout.write('\n');
        const last = runtime.session.messages.findLast((message) => message.role === 'assistant');
        if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
          throw new Error(last.errorMessage || '任务中断或模型请求失败。');
        }
      } finally {
        unsubscribe();
        process.removeListener('SIGINT', abort);
      }
      return;
    }
    const tui = new InteractiveMode(runtime, {
      startupDiagnostics: [
        { type: 'info', message: `Local Pi · 项目：${runtime.cwd} · /project 查看配置 · /changes 查看变更` },
        ...runtime.diagnostics,
      ],
      modelFallbackMessage: runtime.modelFallbackMessage,
    });
    await tui.run();
  } finally {
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`Local Pi：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
