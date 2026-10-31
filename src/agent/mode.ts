export type WorkMode = 'discuss' | 'execute';

export const modeEntryType = 'local-pi-mode';
export const readTools = ['read', 'grep', 'find', 'ls'];
export const codingTools = ['read', 'edit', 'write', 'grep', 'find', 'ls', process.platform === 'win32' ? 'powershell' : 'bash'];
export const mcpTools = ['codemode', 'tool_search', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];

export function toolsForMode(mode: WorkMode): string[] {
  return [...(mode === 'discuss' ? readTools : codingTools)];
}

// The active branch owns the mode; abandoned branches must not affect it.
export function restoreMode(entries: readonly { type: string; customType?: string; data?: unknown }[]): WorkMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== 'custom' || entry.customType !== modeEntryType) continue;
    const mode = (entry.data as { mode?: unknown } | null)?.mode;
    if (mode === 'discuss' || mode === 'execute') return mode;
  }
  return 'discuss';
}

export function modeLabel(mode: WorkMode): string {
  return mode === 'discuss' ? '讨论（只读）' : '执行（可修改）';
}

export function modeInstruction(mode: WorkMode): string {
  const state = `[Local Pi 当前模式] mode=${mode}；${modeLabel(mode)}。这是程序提供的当前状态，取代历史对话中的模式说明。`;
  return mode === 'discuss'
    ? `${state}仅可读取和搜索，不得修改文件或执行命令。需要实施时，请用户直接发送 /execute 切换。`
    : `${state}用户已通过程序切换到执行模式，编辑、写入和命令工具已开放。收到“开始改”等实施任务时，结合已有方案执行，不要再次要求 /execute。切换本身不自动开始任务。`;
}
