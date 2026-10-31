import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS,
  type Keybinding, type KeybindingDefinitions, type KeybindingsConfig, type KeyId,
} from '@earendil-works/pi-tui';

declare module '@earendil-works/pi-tui' {
  interface Keybindings { 'local.session.select': true; 'local.session.new': true }
}

/** Register the native actions used by this host's CustomEditor and selectors. */
export function installThinkingKeybindings(agentDir: string): (() => void) & { reload(): void } {
  const previous = getKeybindings();
  const definitions: KeybindingDefinitions = { ...TUI_KEYBINDINGS };
  for (const id of Object.keys(previous.getResolvedBindings())) {
    const definition = previous.getDefinition(id as Keybinding);
    if (definition) definitions[id as Keybinding] = definition;
  }
  definitions['app.thinking.cycle'] ??= { defaultKeys: 'shift+tab', description: 'Cycle thinking level' };
  definitions['app.thinking.save'] ??= { defaultKeys: 'ctrl+s', description: 'Save thinking level' };
  definitions['app.session.tree'] ??= { defaultKeys: [], description: 'Open session tree' };
  const actions = {
    'app.model.select': ['ctrl+l', '选择当前会话模型'], 'app.models.save': ['ctrl+s', '选择器中保存默认模型'],
    'app.interrupt': ['escape', '停止当前任务 / 取消输入'], 'app.clear': ['ctrl+c', '清空草稿'], 'app.exit': ['ctrl+d', '空草稿时退出'],
    'app.tools.expand': ['ctrl+o', '展开 / 折叠工具结果'], 'app.thinking.toggle': ['ctrl+t', '展开 / 折叠思考内容'],
    'local.session.select': ['ctrl+p', '切换独立会话'], 'local.session.new': ['ctrl+n', '新建独立会话'],
    'app.message.followUp': [process.platform === 'win32' || !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP ? 'ctrl+q' : 'alt+enter', '排队为后续消息'],
    'app.message.dequeue': [process.platform === 'win32' || !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP ? 'alt+q' : 'alt+up', '取回未发送队列到草稿'],
    'app.message.copy': ['ctrl+x', '复制选中内容或最近助手回答'], 'app.editor.external': ['ctrl+g', '外部编辑器编辑草稿'],
  };
  for (const [id, [key, description]] of Object.entries(actions)) definitions[id as Keybinding] ??= { defaultKeys: key as KeyId, description };
  definitions['app.clipboard.pasteImage'] ??= {
    defaultKeys: process.platform === 'win32' || !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP ? 'alt+v' : 'ctrl+v',
    description: 'Paste files, images, or text from clipboard',
  };
  const readBindings = (): KeybindingsConfig => {
    const bindings: KeybindingsConfig = { ...previous.getUserBindings() };
    const path = join(agentDir, 'keybindings.json');
    if (existsSync(path)) {
      const configured: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error(`快捷键配置必须是对象：${path}`);
      for (const [id, keys] of Object.entries(configured)) {
        if (typeof keys === 'string' || Array.isArray(keys) && keys.every((key) => typeof key === 'string')) {
          bindings[id as Keybinding] = keys as KeybindingsConfig[Keybinding];
        }
      }
    }
    return bindings;
  };
  const keybindings = new KeybindingsManager(definitions, readBindings());
  setKeybindings(keybindings);
  const restore = () => { if (getKeybindings() === keybindings) setKeybindings(previous); };
  restore.reload = () => keybindings.setUserBindings(readBindings());
  return restore;
}
