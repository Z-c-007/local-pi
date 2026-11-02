import { statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface Options {
  cwd: string;
  agentDir?: string;
  model?: string;
  continue: boolean;
  session?: string;
  print?: string;
  doctor: boolean;
  help: boolean;
  classic: boolean;
}

export function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: 'string' },
      'agent-dir': { type: 'string' },
      model: { type: 'string' },
      continue: { type: 'boolean', default: false },
      session: { type: 'string' },
      print: { type: 'string' },
      doctor: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      classic: { type: 'boolean', default: false },
    },
  });
  if (values.continue && values.session) throw new Error('--continue 和 --session 只能选一个。');
  if (values.model && (values.model.indexOf('/') < 1 || values.model.endsWith('/'))) {
    throw new Error('--model 格式为 provider/model-id。');
  }
  if (values.print !== undefined && !values.print.trim()) throw new Error('--print 需要非空任务。');
  const target = resolve(values.cwd ?? process.cwd());
  if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`工作目录不存在或不是文件夹：${target}`);
  }
  return {
    cwd: realpathSync(target),
    agentDir: values['agent-dir'] ? resolve(values['agent-dir']) : undefined,
    model: values.model,
    continue: values.continue,
    session: values.session ? resolve(values.session) : undefined,
    print: values.print,
    doctor: values.doctor,
    help: values.help,
    classic: values.classic,
  };
}

export const help = `Local Pi — 个人终端编程助手

用法：local-pi [选项]（或在开发目录运行 npm start -- [选项]）

  --cwd <目录>          要操作的代码项目，默认当前目录
  --model <厂商/模型>   覆盖当前会话的模型；默认沿用 Pi 配置
  --continue            恢复该项目最近一次正式 Local Pi 会话，跳过空白页
  --session <文件>      恢复指定会话（必须属于当前工作目录）
  --agent-dir <目录>    指定 Pi 配置目录；默认使用已有 ~/.pi/agent
  --print <任务>        执行一次任务后退出，不启动 TUI
  --doctor              检查模型、工具、配置路径，不发送模型请求
  --classic             使用 Pi 原有单会话 TUI（切换会话会停止原任务）
  --help, -h            显示帮助

TUI 内置命令：/login、/model、/new、/resume、/settings、/quit
原生菜单：/settings 完整设置；/model 或 Ctrl+L 搜索模型（Enter 当前会话，Ctrl+S 保存默认）
只读页面：/session 会话统计；/hotkeys 实际快捷键与冲突（方向键/PageUp/PageDown 滚动，Esc 关闭）
多会话命令：/sessions 会话列表（/resume 同义）；/switch 编号；/stop 停止；/close 关闭
分叉：/fork 选择已保存消息，新建继承上下文的独立讨论会话；原任务继续，不复制或回滚代码
会话树：/tree 使用官方选择器切换当前会话历史分支，可选摘要；仅限空闲，不回滚文件
原生入口：/export [路径.html|路径.jsonl] 导出；/reload 重载当前空闲会话资源；/mcp 管理 MCP 服务器
终端命令：!命令 直接执行并把输出加入上下文；!!命令 仅保留在记录中，输出不发给模型
快捷键：Ctrl+P 会话列表；Ctrl+N 新建；Esc 停止当前会话
剪贴板：Windows / WSL 用 Alt+V 粘贴图片，其他系统默认 Ctrl+V；沿用 Pi 的图片临时文件路径流程
推理等级：/thinking 打开原生选择器；Shift+Tab 循环切换；/thinking high 直接设置
主题：/theme 打开官方选择器；/theme dark、/theme light 或 /theme light/dark 保存配置
消息展示：Ctrl+T 折叠／展开思考；/thinking-display [collapse|expand|hide]；Ctrl+O 或 /tools 展开、收起工具
任务队列：运行中 Enter 追加指令；Windows Ctrl+Q 排队后续消息、Alt+Q 取回（其他系统 Alt+Enter、Alt+Up）
会话工具：/compact [摘要要求] 手动压缩；/copy 或 Ctrl+X 复制回答；/editor 或 Ctrl+G 外部编辑草稿
本项目命令：/discuss 只读讨论；/execute 允许执行；/project 查看项目
文件变更：/changes 查看本轮快照和彩色 diff；面板可预览撤销／重做；/changes git 查看 Git 变更
文件恢复：/undo 撤销最近一轮；/redo 重做；均先预览，Enter 确认，Esc 取消；/recovery 恢复未完成操作的备份
新会话默认讨论模式；恢复会话时沿用上次模式。切换模式不会自动开始任务。
未发送提问的页面只是临时草稿，不计入历史；新建时复用无草稿的空白页。
`;
