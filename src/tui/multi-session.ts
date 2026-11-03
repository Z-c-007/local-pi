import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  getSelectListTheme, initTheme, getAgentDir, keyText, ThinkingSelectorComponent, ThemeSelectorComponent, FooterComponent, ModelSelectorComponent, TreeSelectorComponent,
  type ExtensionUIContext, type ExtensionUIDialogOptions,
} from '@earendil-works/pi-coding-agent';
import {
  CombinedAutocompleteProvider, Container, matchesKey, getKeybindings, type Keybinding,
  ProcessTerminal, ScrollView, SelectList, Text, TuiAltScreen, VStack,
  type Component, type EditorTheme, type SelectItem, type Terminal,
} from '@earendil-works/pi-tui';
import { modeLabel, restoreMode } from '../agent/mode.ts';
import { SessionPool, type SessionSlot } from '../agent/session-pool.ts';
import { parseOptions } from '../cli.ts';
import { Transcript, thinkingLabels, type ThinkingDisplay } from './transcript.ts';
import { SessionEditor, SessionWorking } from './working.ts';
import { installThinkingKeybindings } from './keybindings.ts';
import { loadPiUi, type PiUi } from './pi-ui.ts';
import { SessionClipboard, type ClipboardReader } from './clipboard.ts';
import { settingsPanel } from './settings.ts';
import { infoPanel } from './info-panel.ts';
import { readTaskReports, formatTaskReport } from '../agent/task-metrics.ts';
import { ExtensionPanels } from './extension-panels.ts';
import { changesPanel, displayPath } from './changes-panel.ts';
import type { RestoreDirection } from '../agent/file-restore.ts';
import { sessionSelector } from './session-selector.ts';
import { fileOperationPanel } from './file-operation-panel.ts';

type ThinkingLevel = SessionSlot['runtime']['session']['thinkingLevel'];
export type HostServices = Partial<Pick<PiUi, 'copyToClipboard' | 'editInExternalEditor'>>;

const commands = [
  ['sessions', '切换会话：当前项目历史和已打开会话'], ['new', '新建独立会话，可附工作目录'], ['switch', '按编号切换已打开会话'],
  ['resume', '会话列表（/sessions 的别名）'], ['stop', '停止当前会话，可附编号'], ['close', '关闭空闲会话'],
  ['fork', '选择已保存消息并分叉为独立会话，原任务继续运行'],
  ['tree', '官方会话树：切换当前会话历史分支，不回滚代码'],
  ['export', '导出 HTML；附 .jsonl 路径则导出当前分支'], ['reload', '重载当前空闲会话的扩展、技能和项目说明'],
  ['mcp', '官方 MCP 服务器管理：认证、重连、启停和工具暴露'],
  ['discuss', '切换只读讨论'], ['execute', '切换执行模式'], ['project', '查看项目和模式'],
  ['memory', '全局／项目记忆：自动提取状态、开关、立即整理、管理和本次召回'],
  ['changes', '可视化查看本轮文件变化；/changes git 查看仓库差异'], ['code-review', '审查代码变更'], ['model', '选择模型'],
  ['undo', '预览并确认撤销最近一轮文件变化'], ['redo', '预览并确认重做最近撤销的文件变化'], ['recovery', '恢复未完成操作的备份'],
  ['login', '配置模型认证'], ['name', '为当前会话命名'], ['settings', '官方完整设置菜单'],
  ['session', '当前会话详情和用量统计'], ['hotkeys', '实际快捷键和当前冲突'],
  ['compact', '手动压缩当前空闲会话，可附摘要要求'], ['copy', '复制最近助手回答'],
  ['editor', '使用外部编辑器编辑草稿'], ['dequeue', '取回尚未发送的排队消息'],
  ['theme', '官方主题选择器，可附主题名称或 light/dark'],
  ['thinking', '选择推理等级，可附当前模型支持的 level'],
  ['thinking-display', '思考内容：collapse 折叠、expand 展开、hide 隐藏'], ['tools', '工具结果：expand 展开、collapse 折叠'],
  ['help', '使用帮助'], ['quit', '退出程序'],
].map(([name, description]) => ({ name: name!, description: description! }));

const stateLabels = { idle: '空闲', running: '运行中', waiting: '等待处理', error: '失败' };
const thinkingModes = new Map<string, ThinkingDisplay>([
  ['collapse', 'collapsed'], ['collapsed', 'collapsed'], ['expand', 'expanded'], ['expanded', 'expanded'],
  ['hide', 'hidden'], ['hidden', 'hidden'],
]);
type Dialog = {
  title: string; choices?: string[]; secret?: boolean;
  finish: (answer: string | undefined) => void;
};

type NativeFooterData = InstanceType<PiUi['FooterDataProvider']>;
interface SessionView {
  editor: SessionEditor; scroll: ScrollView; transcript: Transcript; working: SessionWorking;
  footer: FooterComponent; footerData: NativeFooterData;
  clipboard: SessionClipboard;
}

export class MultiSessionTui {
  private readonly terminal: Terminal;
  private readonly tui: TuiAltScreen;
  private readonly header = new Text('', 1, 0);
  private readonly footer = new Text('', 1, 0);
  private readonly notice = new Text('', 1, 0);
  private readonly views = new Map<string, SessionView>();
  private readonly dialogs = new Map<string, Dialog[]>();
  private mounted?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private ended = false;
  private choosing = false;
  private resolveDone?: () => void;
  private readonly pool: SessionPool;
  private readonly restoreKeybindings: ReturnType<typeof installThinkingKeybindings>;
  private readonly extensionPanels: ExtensionPanels;
  private thinkingSelector?: { slotId: string; cancel: () => void };
  private piUi?: PiUi;
  private themeController?: InstanceType<PiUi['InteractiveThemeController']>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private cancelThemeSelector?: () => void;
  private readonly clipboardReader?: ClipboardReader;
  private panel?: { slotId: string; close: () => void };
  private externalEditing = false;
  private readonly hostServices: HostServices;

  constructor(pool: SessionPool, terminal: Terminal = new ProcessTerminal(), clipboardReader?: ClipboardReader, hostServices: HostServices = {}) {
    this.pool = pool;
    this.terminal = terminal;
    this.clipboardReader = clipboardReader;
    this.hostServices = hostServices;
    this.restoreKeybindings = installThinkingKeybindings(pool.options.agentDir ?? getAgentDir());
    this.tui = new TuiAltScreen(terminal, true, undefined, { scrollToEndIndicator: () => '↓ 回到最新输出' });
    this.extensionPanels = new ExtensionPanels(this.tui, () => this.pool.activeId, () => this.piUi!.getTheme(),
      () => getKeybindings() as Parameters<Parameters<ExtensionUIContext['custom']>[0]>[2]);
    initTheme(undefined, false);
    pool.uiFactory = (slot, base) => this.createUi(slot, base);
    pool.hasDraft = (slot) => {
      const view = this.views.get(slot.id);
      return this.extensionPanels.has(slot.id) || !!view && (!!view.editor.getExpandedText().trim() || view.clipboard.isPending || this.externalEditing);
    };
    pool.on('change', () => this.schedule());
    pool.on('active', () => {
      this.panel?.close();
      this.mounted = undefined;
      if (this.themeController && !this.externalEditing) this.applyActiveTheme();
      this.refresh();
      if (!this.externalEditing) this.applySettings(pool.active, false);
      this.extensionPanels.sync();
    });
    pool.on('closing', (slot: SessionSlot) => {
      this.extensionPanels.close(slot.id);
      if (this.panel?.slotId === slot.id) this.panel.close();
      this.views.get(slot.id)?.clipboard.cancelPending();
      if (this.thinkingSelector?.slotId === slot.id) this.thinkingSelector.cancel();
      if (pool.activeId === slot.id) this.cancelThemeSelector?.();
      for (const dialog of [...(this.dialogs.get(slot.id) ?? [])]) dialog.finish(undefined);
    });
    pool.on('closed', (slot: SessionSlot) => {
      this.views.get(slot.id)?.working.dispose();
      this.views.get(slot.id)?.footerData.dispose();
      this.views.get(slot.id)?.transcript.resetHistory();
      this.views.delete(slot.id);
      this.dialogs.delete(slot.id);
    });
    pool.on('background-finished', (slot: SessionSlot) => {
      if (pool.activeId) pool.notify(pool.active, `会话 ${slot.number} ${slot.error ? '失败' : '已完成'}，用 /sessions 查看。`);
    });
  }

  private view(slot: SessionSlot): SessionView {
    let view = this.views.get(slot.id);
    if (!view) {
      const editorTheme: EditorTheme = { borderColor: (text) => this.piUi!.getTheme().getThinkingBorderColor(slot.runtime.session.thinkingLevel)(text), selectList: getSelectListTheme() };
      const editor = new SessionEditor(this.tui, editorTheme);
      editor.setPaddingX(slot.runtime.services.settingsManager.getEditorPaddingX());
      editor.setAutocompleteMaxVisible(slot.runtime.services.settingsManager.getAutocompleteMaxVisible());
      editor.onAction('app.model.select', () => { void this.showModelSelector(slot).catch((error) => this.pool.notify(slot, String(error))); });
      editor.onAction('app.session.tree', () => { void this.showTree(slot).catch((error) => this.pool.notify(slot, String(error))); });
      editor.onAction('app.message.followUp', () => this.submitDraft(slot, 'followUp'));
      editor.onAction('app.message.dequeue', () => this.restoreQueue(slot));
      editor.onAction('app.message.copy', () => { void this.copyAnswer(slot, true).catch((error) => this.pool.notify(slot, String(error))); });
      editor.onAction('app.editor.external', () => { void this.externalEditor(slot).catch((error) => this.pool.notify(slot, String(error))); });
      const clipboard = new SessionClipboard(editor, this.clipboardReader ?? this.piUi!,
        () => !this.ended && this.pool.slots.get(slot.id) === slot && !this.dialogs.get(slot.id)?.length,
        () => this.schedule(), (message) => this.pool.notify(slot, message));
      editor.onPasteImage = () => { void clipboard.paste(); };
      editor.onAction('app.thinking.cycle', () => {
        try { this.cycleThinkingLevel(slot); }
        catch (error) { this.pool.notify(slot, String(error)); }
      });
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, slot.runtime.cwd));
      editor.onSubmit = (text) => this.submitDraft(slot, 'steer', text);
      const transcript = new Transcript(slot, this.tui, () => {
        const current = this.views.get(slot.id);
        if (current) current.scroll.scrollTo(current.scroll.scrollTop, { disableFollow: true });
        this.schedule();
      }, (id) => { void this.showChanges(slot, id).catch((error) => this.pool.notify(slot, String(error))); });
      const settings = slot.runtime.services.settingsManager;
      const hideThinking = settings.getProjectSettings().hideThinkingBlock ?? settings.getGlobalSettings().hideThinkingBlock;
      if (hideThinking === false) transcript.setThinking('expanded');
      const footerData = new this.piUi!.FooterDataProvider(slot.runtime.cwd);
      footerData.onBranchChange(() => this.schedule());
      view = { editor, transcript, scroll: new ScrollView(transcript, { follow: 'end', primary: true }),
        working: new SessionWorking(editor, this.tui), footerData, footer: new FooterComponent(slot.runtime.session, footerData), clipboard };
      this.views.set(slot.id, view);
    }
    return view;
  }

  private schedule(): void {
    if (this.ended || this.externalEditing || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, 25);
  }

  private submitDraft(slot: SessionSlot, mode: 'steer' | 'followUp', text = this.view(slot).editor.getExpandedText()): void {
    if (!text.trim()) return;
    const view = this.view(slot);
    view.clipboard.cancelPending(); view.editor.setText('');
    if (!this.dialogs.get(slot.id)?.[0]?.secret) view.editor.addToHistory(text);
    void this.dispatch(slot, text.trim(), mode).catch((error) => {
      if (!text.startsWith('/') && !view.editor.getText() && this.pool.slots.has(slot.id)) view.editor.setText(text);
      this.pool.notify(slot, String(error));
    });
  }

  private restoreQueue(slot: SessionSlot): void {
    const queued = this.pool.clearQueue(slot.id);
    const messages = [...queued.steering, ...queued.followUp];
    if (!messages.length) return;
    const view = this.view(slot);
    view.clipboard.cancelPending();
    view.editor.setText([...messages, view.editor.getText()].filter((text) => text.trim()).join('\n\n'));
    this.pool.notify(slot, `已取回 ${messages.length} 条未发送消息到此会话草稿。`);
  }

  private async stopSession(slot: SessionSlot): Promise<void> {
    this.restoreQueue(slot);
    await this.pool.abort(slot.id);
  }

  private async copyAnswer(slot: SessionSlot, preferSelection = false): Promise<void> {
    if (preferSelection && !this.tui.getCopyOnSelect() && this.tui.hasActiveSelection()) {
      await this.tui.copyActiveSelectionToClipboard(); return;
    }
    const text = slot.runtime.session.getLastAssistantText();
    if (!text) { this.pool.notify(slot, '还没有可复制的助手回答。'); return; }
    await (this.hostServices.copyToClipboard ?? this.piUi!.copyToClipboard)(text);
    this.pool.notify(slot, '已复制最近助手回答。');
  }

  private async externalEditor(slot: SessionSlot): Promise<void> {
    if (this.externalEditing || this.choosing || this.extensionPanels.visible || this.dialogs.get(slot.id)?.length) throw new Error('请先完成当前菜单或确认输入。');
    const view = this.view(slot); const content = view.editor.getExpandedText();
    view.clipboard.cancelPending(); this.externalEditing = true;
    clearTimeout(this.timer); this.timer = undefined;
    for (const item of this.views.values()) item.working.pause();
    this.tui.stop();
    try {
      const result = await (this.hostServices.editInExternalEditor ?? this.piUi!.editInExternalEditor)({
        command: slot.runtime.services.settingsManager.getExternalEditorCommand(), content,
      });
      if (!this.pool.slots.has(slot.id) || this.ended) return;
      if (result.status === 'complete') {
        const current = view.editor.getExpandedText();
        view.editor.setText(current === content ? result.content : [result.content, current].filter(Boolean).join('\n\n'));
      } else this.pool.notify(slot, '外部编辑器未成功退出，原草稿已保留。');
    } finally {
      this.externalEditing = false;
      if (!this.ended) {
        this.tui.start(); this.applyActiveTheme(); this.mounted = undefined; this.refresh();
        this.applySettings(this.pool.active, false); this.tui.requestRender(true);
      }
    }
  }

  private showPanel(slot: SessionSlot, create: (close: () => void) => Component, dispose?: () => void): Promise<void> {
    if (this.choosing || this.ended) return Promise.resolve();
    this.choosing = true;
    return new Promise((resolvePanel, rejectPanel) => {
      let closed = false;
      let overlay: ReturnType<TuiAltScreen['showOverlay']> | undefined;
      const close = (error?: unknown) => {
        if (closed) return;
        closed = true; dispose?.(); overlay?.hide(); this.choosing = false; this.panel = undefined;
        if (error) rejectPanel(error); else resolvePanel();
      };
      try {
        const component = create(close);
        overlay = this.tui.showOverlay(component, { width: '94%', maxHeight: '90%' });
        this.panel = { slotId: slot.id, close };
        this.tui.setFocus(component); this.tui.requestRender();
      } catch (error) { close(error); }
    });
  }

  private async showTree(slot: SessionSlot): Promise<void> {
    if (slot.task || !slot.runtime.session.isIdle || slot.state === 'waiting') throw new Error('请先等待当前任务完成或 /stop，再切换会话树；不会自动中断任务。');
    const session = slot.runtime.session; const manager = session.sessionManager;
    if (!manager.getTree().length) { this.pool.notify(slot, '当前会话没有历史节点。'); return; }
    let selected: string | undefined;
    await this.showPanel(slot, (close) => {
      const selector = new TreeSelectorComponent(manager.getTree(), manager.getLeafId(), this.terminal.rows,
        (id) => { selected = id; close(); }, close,
        (id, label) => { manager.appendLabelChange(id, label); this.pool.save(slot); }, undefined,
        slot.runtime.services.settingsManager.getTreeFilterMode());
      selector.onCopy = (text) => {
        if (text) void (this.hostServices.copyToClipboard ?? this.piUi!.copyToClipboard)(text).catch((error) => this.pool.notify(slot, String(error)));
      };
      const container = new Container();
      container.addChild(new Text('会话树 · 只切换对话分支，不恢复文件 · Esc 返回', 1, 0)); container.addChild(selector);
      return { render: (width) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => selector.handleInput(data),
        get focused() { return selector.focused; }, set focused(value: boolean) { selector.focused = value; } };
    });
    if (!selected || !this.pool.slots.has(slot.id) || slot.id !== this.pool.activeId || selected === manager.getLeafId()) return;
    let summarize = false; let customInstructions: string | undefined;
    if (!slot.runtime.services.settingsManager.getBranchSummarySkipPrompt()) {
      const choice = await this.choose('切换分支前，是否摘要当前分支？（摘要会请求模型）', [
        { value: 'no', label: '不摘要，直接切换' }, { value: 'yes', label: '摘要后切换' }, { value: 'custom', label: '输入摘要要求后切换' },
      ]);
      if (!choice) return;
      summarize = choice !== 'no';
      if (choice === 'custom') {
        customInstructions = await this.ask(slot, '输入摘要要求，Esc 取消');
        if (customInstructions === undefined) return;
      }
    }
    const result = await this.pool.navigateTree(slot.id, selected, { summarize, customInstructions });
    if (result.cancelled) { this.pool.notify(slot, '会话树切换已取消。'); return; }
    const view = this.view(slot); view.clipboard.cancelPending(); view.transcript.resetHistory();
    if (result.editorText) view.editor.setText([result.editorText, view.editor.getExpandedText()].filter(Boolean).join('\n\n'));
    view.scroll.scrollToEnd(); this.pool.changed(slot);
    this.pool.notify(slot, '已切换对话分支；文件未回滚。');
  }

  private async exportSession(slot: SessionSlot, argument: string): Promise<void> {
    if (!slot.saved.hasConversation) throw new Error('请先提交一次提问，再导出正式会话。');
    let name = argument.trim();
    if (name.startsWith('"') || name.startsWith("'")) {
      if (name.length < 2 || name.at(-1) !== name[0]) throw new Error('导出路径的引号未闭合。');
      name = name.slice(1, -1);
    }
    const path = name ? resolve(slot.runtime.cwd, name) : resolve(slot.runtime.cwd, `local-pi-${slot.id}-${Date.now()}.html`);
    if (!/\.(html|jsonl)$/i.test(path)) throw new Error('导出路径请使用 .html 或 .jsonl 扩展名。');
    if (existsSync(path)) throw new Error('导出目标已存在，请换一个文件名。');
    const exported = /\.jsonl$/i.test(path) ? slot.runtime.session.exportToJsonl(path)
      : await slot.runtime.session.exportToHtml(path, { themeName: this.piUi!.getTheme().name });
    this.pool.notify(slot, `会话已导出：${exported}`);
  }

  private async reloadSession(slot: SessionSlot): Promise<void> {
    await this.pool.reload(slot.id);
    if (!this.pool.slots.has(slot.id) || this.ended) return;
    this.restoreKeybindings.reload();
    this.applySettings(slot); this.view(slot).transcript.resetHistory();
    if (slot.id === this.pool.activeId) this.applyActiveTheme();
    const errors = slot.runtime.session.resourceLoader.getExtensions().errors;
    for (const error of errors) this.pool.notify(slot, `扩展加载失败：${error.error}`);
    this.pool.notify(slot, '已重载当前会话的扩展、技能、提示模板、主题、项目说明与快捷键；其他会话任务继续运行。');
  }

  private applySettings(slot: SessionSlot, save = true): void {
    const s = slot.runtime.services.settingsManager;
    const view = this.view(slot);
    view.editor.setPaddingX(s.getEditorPaddingX());
    view.editor.setAutocompleteMaxVisible(s.getAutocompleteMaxVisible());
    view.scroll.setScrollbar(s.getFullscreenScrollbar());
    view.transcript.applySettings();
    const discovered = [
      ...(slot.runtime.session.extensionRunner?.getRegisteredCommands().map((command) => ({ name: command.name, description: command.description })) ?? []),
      ...slot.runtime.session.promptTemplates.map((template) => ({ name: template.name, description: template.description })),
      ...(s.getEnableSkillCommands() ? slot.runtime.session.resourceLoader.getSkills().skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description })) : []),
    ];
    view.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands, ...discovered.filter((entry) => !commands.some((local) => local.name === entry.name))], slot.runtime.cwd));
    if (slot.id === this.pool.activeId) {
      this.tui.setShowHardwareCursor(s.getShowHardwareCursor()); this.tui.setClearOnShrink(s.getClearOnShrink());
      this.tui.setCopyOnSelect(s.getFullscreenCopyOnSelect()); this.tui.setWheelScrollLines(s.getFullscreenWheelScrollLines());
    }
    if (save) this.pool.save(slot);
    this.pool.changed(slot);
  }

  private showSettings(slot: SessionSlot): Promise<void> {
    return this.showPanel(slot, (close) => {
      const initialNotice = slot.notices.at(-1);
      const hint = new Text('', 1, 0);
      const content = new Container();
      const savedTheme = () => this.themeController!.setThemeSetting(slot.runtime.services.settingsManager.getThemeSetting() ?? 'system');
      const selector = settingsPanel(slot, {
        pi: this.piUi!, theme: this.themeController!, changed: () => this.applySettings(slot),
        notify: (message) => this.pool.notify(slot, message), setTheme: (name) => this.setTheme(slot, name),
        close: () => { savedTheme(); close(); },
        setThinkingDisplay: (hidden) => this.view(slot).transcript.setThinking(hidden ? 'collapsed' : 'expanded'),
        hideThinkingBlock: this.view(slot).transcript.thinking !== 'expanded',
      });
      content.addChild(hint); content.addChild(selector);
      return { render: (width) => {
          const message = slot.notices.at(-1);
          hint.setText(`Pi 设置 · 即时保存 · Esc 返回\n${message && message !== initialNotice ? message : '完整原生菜单；未接入功能的选项会注明仅供 --classic 使用。'}`);
          return content.render(width);
        }, invalidate: () => content.invalidate(),
        handleInput: (data) => {
          try { selector.getSettingsList().handleInput(data); }
          catch (error) { this.pool.notify(slot, String(error)); }
        } };
    }, () => this.applyActiveTheme());
  }

  private async showModelSelector(slot: SessionSlot, search = ''): Promise<void> {
    if (slot.task || !slot.runtime.session.isIdle) throw new Error('先停止此会话的任务，再切换模型。');
    let selector: ModelSelectorComponent | undefined;
    let selection: Promise<void> | undefined;
    await this.showPanel(slot, (close) => {
      const s = slot.runtime.services.settingsManager;
      const select = (model: NonNullable<SessionSlot['runtime']['session']['model']>, persist: boolean) => {
        if (selection) return;
        selection = (async () => {
          if (!this.pool.slots.has(slot.id) || slot.task || !slot.runtime.session.isIdle) throw new Error('当前会话已关闭或正在执行，未切换模型。');
          await slot.runtime.session.setModel(model, { persist });
          this.pool.save(slot); this.pool.notify(slot, `模型：${model.provider}/${model.id}${persist ? '（已保存为默认）' : ''}`);
        })().catch((error) => this.pool.notify(slot, String(error))).finally(close);
      };
      selector = new ModelSelectorComponent(this.tui, slot.runtime.session.model, slot.runtime.services.modelRuntime,
        slot.runtime.session.scopedModels, (model) => select(model, false), close, search,
        (model) => select(model, true), s.getDefaultProvider() && s.getDefaultModel() ? { provider: s.getDefaultProvider()!, id: s.getDefaultModel()! } : undefined);
      return selector;
    }, () => selector?.dispose());
    await selection;
  }

  private showInfo(slot: SessionSlot, content: () => string): Promise<void> {
    return this.showPanel(slot, (close) => infoPanel(content, () => Math.floor(this.terminal.rows * 0.9) - 2, () => this.tui.requestRender(), close));
  }

  private async showChanges(slot: SessionSlot, id?: string): Promise<void> {
    const reports = slot.fileChanges;
    if (id && !reports.some((report) => report.id === id)) throw new Error('本轮快照记录已不可用。');
    let request: { id: string; direction: RestoreDirection; path?: string } | undefined;
    await this.showPanel(slot, (close) => changesPanel(reports, () => Math.floor(this.terminal.rows * 0.9) - 2,
      () => this.tui.requestRender(), close, id, (reportId, direction, path) => { request = { id: reportId, direction, path }; close(); }, () => this.piUi!.getTheme()));
    if (request && this.pool.activeId === slot.id && this.pool.slots.has(slot.id)) await this.restorePreview(slot, request.id, request.direction, request.path);
  }

  private async confirmFileOperation(slot: SessionSlot, content: string, enabled: boolean): Promise<boolean> {
    let confirmed = false;
    await this.showPanel(slot, (close) => {
      const confirm = () => { if (enabled) { confirmed = true; close(); } };
      return fileOperationPanel(content, enabled, () => Math.floor(this.terminal.rows * 0.9) - 2,
        () => this.piUi!.getTheme(), () => this.tui.requestRender(), confirm, close);
    });
    return confirmed && this.pool.activeId === slot.id && this.pool.slots.has(slot.id);
  }

  private async restorePreview(slot: SessionSlot, reportId: string, direction: RestoreDirection, path?: string): Promise<void> {
    const plan = await this.pool.restorePlan(slot.id, reportId, direction, path);
    const label = direction === 'undo' ? '撤销' : '重做';
    const content = `# ${label}预览\n\n目录：${displayPath(plan.cwd)}\n\n仅恢复文件，保留聊天记录。执行前再次核对版本；先备份，出现冲突整次拒绝。\n\n${plan.files.map((file) => `- ${displayPath(file.path)}：${file.target ? file.expected ? '替换为保存的版本' : '恢复文件' : '删除本轮新增文件'}`).join('\n')}\n\n${plan.warnings.length ? `## 历史记录需要人工复核\n\n${plan.warnings.map((warning) => `- ${displayPath(warning)}`).join('\n')}\n\n` : ''}${plan.conflicts.length ? `## 无法执行\n\n${plan.conflicts.map((reason) => `- ${displayPath(reason)}`).join('\n')}` : `共 ${plan.files.length} 个文件。确认后开始${label}。`}`;
    if (!await this.confirmFileOperation(slot, content, !plan.conflicts.length)) return;
    const journal = await this.pool.applyRestore(slot.id, plan);
    this.view(slot).transcript.resetHistory();
    this.pool.notify(slot, `已${label} ${journal.files.length} 个文件；操作前备份和日志已保留。`);
  }

  private async recoverFiles(slot: SessionSlot): Promise<void> {
    await this.pool.operations.reconcile(this.pool.coordinator);
    const pending = await this.pool.coordinator.pendingFor(slot.runtime.cwd);
    const journals = (await this.pool.restore.journals()).filter((journal) => pending.some((item) => item.id === journal.id));
    const uncertain = this.pool.operations.uncertain(slot.runtime.cwd);
    if (!journals.length && !uncertain.length) { this.pool.notify(slot, pending.length ? '存在缺失／损坏的恢复日志，请保留备份并人工检查。' : '没有未完成的文件恢复操作。'); return; }
    const id = await this.choose('未完成／未确认的文件操作', [
      ...journals.map((journal) => ({ value: journal.id, label: `${journal.direction} · ${journal.files.length} 个文件 · ${journal.phase}`, description: `会话 ${journal.sessionId} · ${journal.created}` })),
      ...uncertain.map((operation) => ({ value: operation.id, label: `待人工检查 · ${operation.tool} · ${operation.path ?? operation.cwd}`, description: `会话 ${operation.sessionId} · ${operation.error ?? ''}` })),
    ], true);
    const operation = uncertain.find((item) => item.id === id);
    if (operation) {
      const content = `# 确认保留当前文件\n\n操作：${operation.id}\n\n会话：${operation.sessionId}\n\n工具：${displayPath(operation.tool)}\n\n目标：${displayPath(operation.path ?? operation.cwd)}\n\n修改前版本：${operation.before?.hash ?? '不存在／未记录'}\n\n最后核验版本：${operation.after?.hash ?? '结果未确认'}\n\n备份目录：${this.pool.operations.root}/blobs\n\n${operation.error ?? ''}\n\n请先人工检查当前文件和备份。确认表示保留当前文件并解除这项阻塞，不会自动回滚或恢复文件；脚本的远程操作和后台进程需要另行检查。`;
      if (await this.confirmFileOperation(slot, content, true)) {
        await this.pool.acknowledgeOperation(slot.id, operation.id);
        this.pool.notify(slot, '已确认保留当前文件；操作日志和备份保留。其他未确认操作仍需分别处理。');
      }
      return;
    }
    const journal = journals.find((item) => item.id === id); if (!journal) return;
    if (journal.sessionId !== slot.id) throw new Error(`请先切换到此操作所属会话：${journal.sessionId}，其他会话不会被代为恢复。`);
    const content = `# 恢复操作前备份\n\n${journal.id}\n\n将以下文件恢复到这次撤销／重做开始前的状态。发现外部修改会拒绝覆盖；聊天记录保留。\n\n${journal.files.map((file) => `- ${displayPath(file.path)} · ${file.step}`).join('\n')}`;
    if (!await this.confirmFileOperation(slot, content, true)) return;
    await this.pool.recoverRestore(slot.id, journal.id); this.view(slot).transcript.resetHistory();
    this.pool.notify(slot, '已恢复到操作前的文件状态，相关目录可以继续执行任务。');
  }

  private sessionInfo(slot: SessionSlot): string {
    const session = slot.runtime.session; const stats = session.getSessionStats(); const t = stats.tokens;
    const context = stats.contextUsage;
    const latest = readTaskReports(session).at(-1);
    return `# 当前会话统计\n\n- 名称：${slot.saved.name || slot.saved.title || '新会话'}\n- ID：${slot.id}\n- 项目：${slot.runtime.cwd}\n- 状态：${stateLabels[slot.state]}\n- 模式：${modeLabel(restoreMode(session.sessionManager.getBranch()))}\n- 模型：${session.model ? `${session.model.provider}/${session.model.id}` : '未选择'}\n- 推理等级：${session.thinkingLevel}\n${slot.saved.fork ? `- 分叉来源：${slot.saved.fork.sourceSessionId} · 消息 ${slot.saved.fork.entryId}（含该消息）\n- 文件：沿用当前工作目录，未复制或回滚代码。\n` : ''}\n## 会话累计用量\n\n| 项目 | 数量 |\n|---|---:|\n| 输入 | ${t.input} |\n| 输出 | ${t.output} |\n| 缓存读取 | ${t.cacheRead} |\n| 缓存写入 | ${t.cacheWrite} |\n| Token 合计 | ${t.total || '未知 / 尚无返回统计'} |\n\n费用为 SDK 按模型配置估算：$${stats.cost.toFixed(4)}，不代表套餐扣额。套餐剩余额度未接入。\n\n上下文：${context?.tokens ?? '未知'} / ${context?.contextWindow ?? '未知'}（${context?.percent?.toFixed(1) ?? '?'}%，可能包含 SDK 估算）。\n\n## 消息和工具\n\n用户消息 ${stats.userMessages}；助手消息 ${stats.assistantMessages}；工具调用 ${stats.toolCalls}；工具结果 ${stats.toolResults}。\n\n## 最近任务\n\n${slot.metrics.current ? `运行中，已耗时 ${(slot.metrics.elapsedMs() / 1000).toFixed(1)} 秒` : latest ? formatTaskReport(latest) : '暂无已记录任务。'}\n\n会话文件：${session.sessionFile ?? '尚未写入文件'}\n\n统计累计 SDK 保存的已返回用量，包含压缩等开销；缺失的接口用量不会推算补齐。`;
  }

  private hotkeysInfo(): string {
    const kb = getKeybindings();
    const rows = Object.entries(kb.getResolvedBindings()).map(([id]) => {
      const keys = kb.getKeys(id as Keybinding);
      return keys.length ? `| ${keys.join(' / ')} | ${kb.getDefinition(id as Keybinding)?.description ?? id} | ${id} |` : '';
    }).filter(Boolean);
    const conflicts = kb.getConflicts();
    return `# 快捷键帮助\n\n此处显示当前实际绑定，编辑、选择器和滚动快捷键在各自上下文生效。Ctrl+P 的原生切模型用途已由会话列表替代；模型选择使用 app.model.select（默认 Ctrl+L）。\n\n| 按键 | 动作 | 配置名称 |\n|---|---|---|\n${rows.join('\n')}\n\n## 绑定冲突\n\n${conflicts.length ? conflicts.map((entry) => `- ${entry.key}: ${entry.keybindings.join(', ')}`).join('\n') : '未发现绑定冲突。'}\n\n配置位于 Pi 配置目录的 keybindings.json；修改后重启生效。未接入的原生动作不列作已支持功能。`;
  }

  private refresh(): void {
    if (this.ended || this.externalEditing || !this.pool.activeId) return;
    const slot = this.pool.active;
    const view = this.view(slot);
    view.footer.setAutoCompactEnabled(slot.runtime.session.autoCompactionEnabled);
    view.footerData.setAvailableProviderCount(new Set(slot.runtime.services.modelRuntime.getAvailableSnapshot().map((model) => model.provider)).size);
    for (const key of view.footerData.getExtensionStatuses().keys()) if (!slot.statuses.has(key)) view.footerData.setExtensionStatus(key, undefined);
    for (const [key, value] of slot.statuses) view.footerData.setExtensionStatus(key, value);
    for (const [id, other] of this.views) other.working.update(this.pool.slots.get(id) ?? slot, id === slot.id);
    const title = slot.saved.hasConversation ? slot.saved.name || slot.saved.title || `会话 ${slot.number}`
      : slot.saved.name || '新对话（临时）';
    this.header.setText(`Local Pi · ${title} · ${slot.waitingOperations?.size ? '排队中' : stateLabels[slot.state]} · ${modeLabel(restoreMode(slot.runtime.session.sessionManager.getBranch()))}\n${slot.runtime.cwd}`);
    const pending = this.dialogs.get(slot.id)?.[0];
    view.editor.secret = pending?.secret ?? false;
    const queues = [
      ...slot.runtime.session.getSteeringMessages().map((text) => `追加：${text}`),
      ...slot.runtime.session.getFollowUpMessages().map((text) => `后续：${text}`),
      ...slot.compactionQueue.map((entry) => `压缩后：${entry.text}`),
    ];
    const queueText = queues.length ? `\n待发送 ${queues.length} 条（${getKeybindings().getKeys('app.message.dequeue').join('/')} 取回）\n${queues.slice(0, 3).map((text) => text.replace(/\s+/g, ' ').slice(0, 120)).join('\n')}` : '';
    this.notice.setText((pending
      ? `[等待输入] ${pending.title}\n${pending.choices?.map((choice, i) => `${i + 1}. ${choice}`).join('\n') ?? ''}\n直接输入回答，Esc 取消；Ctrl+P 仍可切换会话。`
      : slot.notices.at(-1) ?? '') + queueText);
    const tabs = [...this.pool.slots.values()].filter((s) => s.saved.hasConversation || this.pool.hasDraft?.(s) || s.id === slot.id)
      .map((s) => `${s.id === slot.id ? '▶' : ''}${s.saved.hasConversation ? s.number : this.pool.hasDraft?.(s) ? '草稿' : '新对话'}:${s.waitingOperations?.size ? '排队中' : stateLabels[s.state]}${s.unread ? '●' : ''}`).join('  ');
    const binding = (id: Keybinding) => getKeybindings().getKeys(id).join('/') || '未绑定';
    this.footer.setText(`${tabs} · 推理等级:${slot.runtime.session.thinkingLevel}${slot.runningTools.size ? ` · ${[...slot.runningTools].join(', ')}` : ''}\n${binding('local.session.select')} 会话 · ${binding('local.session.new')} 新建 · ${keyText('app.thinking.cycle') || '/thinking'} 等级 · ${binding('app.thinking.toggle')} 思考内容:${thinkingLabels[view.transcript.thinking]} · ${binding('app.tools.expand')} 工具 · ${binding('app.interrupt')} 停止 · /help`);
    if (this.mounted !== slot.id) {
      this.mounted = slot.id;
      this.tui.resetTextSelection();
      this.tui.setLayoutRoot(new VStack([
        { component: this.header, shrink: 0 },
        { component: view.scroll, grow: 1, minSize: 1 },
        { component: this.notice, shrink: 0, maxSize: 8 },
        { component: view.editor, shrink: 0, maxSize: 8 },
        { component: view.footer, shrink: 0 },
        { component: this.footer, shrink: 0 },
      ]));
      this.tui.setFocus(view.editor);
    }
    this.tui.requestRender();
  }

  private themeChanged(): void {
    for (const view of this.views.values()) {
      view.transcript.resetTheme();
      view.working.pause();
      view.editor.invalidate();
    }
    this.schedule();
  }

  private applyActiveTheme(): void {
    const slot = this.pool.active;
    this.piUi!.setRegisteredThemes(slot.runtime.services.resourceLoader.getThemes().themes);
    this.themeController!.setThemeSetting(slot.runtime.services.settingsManager.getThemeSetting() ?? 'system');
  }

  private setTheme(slot: SessionSlot, setting: string): void {
    if (!this.pool.slots.has(slot.id)) throw new Error('会话已关闭。');
    const names = setting.split('/');
    if (names.length > 2 || names.some((name) => !this.piUi!.getAvailableThemes().includes(name))) {
      throw new Error(`找不到主题 ${setting}。用 /theme 打开官方选择器。`);
    }
    for (const other of this.pool.slots.values()) {
      if (other.runtime.services.agentDir === slot.runtime.services.agentDir) other.runtime.services.settingsManager.setTheme(setting);
    }
    this.themeController!.setThemeSetting(setting);
    this.pool.notify(slot, `主题：${setting}（已保存）。`);
  }

  private showThemeSelector(slot: SessionSlot): Promise<void> {
    if (this.choosing) return Promise.resolve();
    this.choosing = true;
    const previous = this.themeController!.getThemeSelection() ?? 'system';
    return new Promise((resolveSelection) => {
      let finished = false;
      const finish = (name?: string) => {
        if (finished) return;
        finished = true;
        try {
          if (name) this.setTheme(slot, name);
          else this.themeController!.setThemeSetting(previous);
        } catch (error) { this.pool.notify(slot, String(error)); }
        finally {
          this.choosing = false;
          this.cancelThemeSelector = undefined;
          overlay.hide(); resolveSelection();
        }
      };
      const selector = new ThemeSelectorComponent(this.piUi!.getTheme().name ?? previous,
        (name) => finish(name), () => finish(), (name) => { this.themeController!.preview(name); this.themeChanged(); });
      // Native ThemeSelector exposes its SelectList; the host routes keyboard input.
      const component: Component = { render: (width) => selector.render(width), invalidate: () => selector.invalidate(),
        handleInput: (data) => selector.getSelectList().handleInput(data) };
      const overlay = this.tui.showOverlay(component, { width: '90%', maxHeight: '80%' });
      this.cancelThemeSelector = () => finish();
      this.tui.setFocus(component);
      this.tui.requestRender();
    });
  }

  private choose(title: string, items: SelectItem[], wide = false): Promise<string | undefined> {
    if (!items.length || this.choosing) return Promise.resolve(undefined);
    this.choosing = true;
    return new Promise((resolveChoice) => {
      const container = new Container();
      container.addChild(new Text(title, 1, 1));
      const list = new SelectList(items, 12, getSelectListTheme(), wide
        ? { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 54 } : undefined);
      container.addChild(list);
      const component: Component = {
        render: (width) => container.render(width), invalidate: () => container.invalidate(),
        handleInput: (data) => list.handleInput(data),
      };
      const overlay = this.tui.showOverlay(component, { width: '90%', maxHeight: '80%' });
      const finish = (value?: string) => { this.choosing = false; overlay.hide(); resolveChoice(value); };
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish();
      this.tui.setFocus(component);
      this.tui.requestRender();
    });
  }

  private async selectSession(): Promise<void> {
    return this.extensionPanels.temporarilyHide(() => this.selectSessionList());
  }

  private async selectSessionList(): Promise<void> {
    const slot = this.pool.active; const cwd = slot.runtime.cwd;
    const sessions = await this.pool.listSessions(cwd);
    if (this.pool.activeId !== slot.id || !this.pool.slots.has(slot.id)) return;
    if (!sessions.length) { this.pool.notify(slot, '暂无其他会话；空白页不计入历史。'); return; }
    let id: string | undefined;
    await this.showPanel(slot, (close) => sessionSelector(sessions, cwd, slot.id,
      () => Math.floor(this.terminal.rows * 0.9) - 2, () => this.piUi!.getTheme(), () => this.tui.requestRender(),
      (selected) => { id = selected; close(); }, close));
    if (id) await this.pool.openSession(id, cwd);
  }

  private selectThinkingLevel(slot: SessionSlot, level: ThinkingLevel, persist = false): void {
    if (!this.pool.slots.has(slot.id)) throw new Error('会话已关闭。');
    slot.runtime.session.setThinkingLevel(level, { persist });
    this.pool.save(slot);
    this.pool.notify(slot, `推理等级：${slot.runtime.session.thinkingLevel}${persist ? '（已保存为默认）' : ''}`);
  }

  private cycleThinkingLevel(slot: SessionSlot): void {
    const level = slot.runtime.session.cycleThinkingLevel({ persist: false });
    if (level === undefined) { this.pool.notify(slot, '当前模型不支持切换推理等级。'); return; }
    this.pool.save(slot);
    this.pool.notify(slot, `推理等级：${level}`);
  }

  private showThinkingSelector(slot: SessionSlot): Promise<void> {
    if (this.choosing) return Promise.resolve();
    this.choosing = true;
    return new Promise((resolveSelection) => {
      let finished = false;
      const finish = (level?: ThinkingLevel, persist = false) => {
        if (finished) return;
        finished = true;
        try { if (level !== undefined) this.selectThinkingLevel(slot, level, persist); }
        catch (error) { this.pool.notify(slot, String(error)); }
        finally {
          this.choosing = false;
          this.thinkingSelector = undefined;
          overlay.hide();
          resolveSelection();
        }
      };
      const session = slot.runtime.session;
      const selector = new ThinkingSelectorComponent(session.thinkingLevel, session.getAvailableThinkingLevels(),
        (level) => finish(level), () => finish(), (level) => finish(level, true),
        slot.runtime.services.settingsManager.getDefaultThinkingLevel());
      const overlay = this.tui.showOverlay(selector, { width: '90%', maxHeight: '90%' });
      this.thinkingSelector = { slotId: slot.id, cancel: () => finish() };
      this.tui.setFocus(selector);
      this.tui.requestRender();
    });
  }

  private ask(slot: SessionSlot, title: string, choices?: string[], opts?: ExtensionUIDialogOptions, secret = false): Promise<string | undefined> {
    if (opts?.signal?.aborted || this.ended) return Promise.resolve(undefined);
    return new Promise((resolveAnswer) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const abort = () => dialog.finish(undefined);
      const dialog: Dialog = { title, choices, secret, finish: (answer) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', abort);
        this.dialogs.set(slot.id, (this.dialogs.get(slot.id) ?? []).filter((d) => d !== dialog));
        slot.state = this.dialogs.get(slot.id)?.length ? 'waiting' : slot.task ? 'running' : 'idle';
        this.pool.changed(slot);
        resolveAnswer(answer);
      } };
      this.dialogs.set(slot.id, [...(this.dialogs.get(slot.id) ?? []), dialog]);
      slot.state = 'waiting';
      if (slot.id !== this.pool.activeId) slot.unread = true;
      opts?.signal?.addEventListener('abort', abort, { once: true });
      if (opts?.timeout !== undefined) timer = setTimeout(abort, opts.timeout);
      this.pool.changed(slot);
    });
  }

  private createUi(slot: SessionSlot, base: ExtensionUIContext): ExtensionUIContext {
    const piUi = this.piUi!;
    return {
      ...base,
      get theme() { return piUi.getTheme(); },
      getAllThemes: () => piUi.getAvailableThemesWithPaths(),
      getTheme: (name) => piUi.getThemeByName(name),
      setTheme: (theme) => this.themeController
        ? typeof theme === 'string' ? this.themeController.setThemeName(theme, true) : this.themeController.setThemeInstance(theme)
        : { success: false, error: '主题控制器正在初始化。' },
      select: (title, choices, opts) => this.ask(slot, title, choices, opts),
      confirm: async (title, message, opts) => (await this.ask(slot, `${title}\n${message}`, ['确认', '取消'], opts)) === '确认',
      input: (title, placeholder, opts) => this.ask(slot, `${title}${placeholder ? `（${placeholder}）` : ''}`, undefined, opts),
      editor: (title, prefill) => this.ask(slot, `${title}${prefill ? `\n原内容：${prefill}` : ''}`),
      setEditorText: (text) => {
        const view = this.view(slot);
        view.clipboard.cancelPending(); view.editor.setText(text); this.schedule();
      },
      getEditorText: () => this.view(slot).editor.getExpandedText(),
      pasteToEditor: (text) => { this.view(slot).editor.insertTextAtCursor(text); this.schedule(); },
      setWorkingMessage: (text) => { this.view(slot).working.setMessage(text); this.schedule(); },
      setWorkingVisible: (visible) => { this.view(slot).working.setVisible(visible); this.schedule(); },
      setWorkingIndicator: (options) => { this.view(slot).working.setIndicator(options); this.schedule(); },
      setTitle: (title) => { if (slot.id === this.pool.activeId) this.terminal.setTitle(title); },
      custom: (factory, options) => this.extensionPanels.open(slot, factory, options),
    };
  }

  private findSlot(value: string, fallback: SessionSlot): SessionSlot {
    const found = value ? [...this.pool.slots.values()].find((s) => String(s.number) === value || s.id === value) : fallback;
    if (!found) throw new Error('会话编号不存在，用 /sessions 查看。');
    return found;
  }

  private async dispatch(slot: SessionSlot, text: string, mode: 'steer' | 'followUp' = 'steer'): Promise<void> {
    if (!text) return;
    const [command, ...parts] = text.split(/\s+/);
    const args = parts.join(' ');
    const dialog = this.dialogs.get(slot.id)?.[0];
    const navigation = ['/undo', '/redo', '/recovery', '/changes', '/tree', '/export', '/reload', '/fork', '/sessions', '/resume', '/switch', '/new', '/stop', '/quit', '/close', '/thinking', '/thinking-display', '/tools', '/theme', '/session', '/hotkeys', '/settings', '/model', '/copy', '/dequeue', '/compact'];
    if (dialog && !navigation.includes(command!)) {
      let answer = text;
      if (dialog.choices) {
        const choice = dialog.choices[Number(text) - 1] ?? dialog.choices.find((item) => item === text);
        if (!choice) { this.pool.notify(slot, '请输入选项编号或完整选项文字。'); return; }
        answer = choice;
      }
      dialog.finish(answer);
      return;
    }
    if (command === '/tree') return this.showTree(slot);
    if (command === '/undo' || command === '/redo') {
      if (args) throw new Error('用法：/undo 或 /redo；选择某轮／文件请用 /changes。');
      const direction = command === '/undo' ? 'undo' : 'redo';
      const report = slot.fileChanges.findLast((item) => item.changes.some((file) => direction === 'undo' ? file.restoreState !== 'undone' : file.restoreState === 'undone'));
      if (!report) throw new Error('没有对应的文件变更记录。');
      return this.restorePreview(slot, report.id, direction);
    }
    if (command === '/recovery') return this.recoverFiles(slot);
    if (command === '/changes' && args !== 'git') {
      if (args) throw new Error('用法：/changes 或 /changes git');
      return this.showChanges(slot);
    }
    if (command === '/export') return this.exportSession(slot, text.slice('/export'.length));
    if (command === '/reload') return this.reloadSession(slot);
    if (text.startsWith('!')) return this.pool.executeShell(slot.id, text.slice(text.startsWith('!!') ? 2 : 1).trim(), text.startsWith('!!'));
    if (command === '/fork') {
      const points = this.pool.getForkPoints(slot.id).reverse();
      if (!points.length) throw new Error('当前没有完整、已保存的消息可分叉。');
      const entryId = await this.choose('分叉会话 · 保留到所选消息（含），原任务继续；不复制或回滚代码', points.map((point) => ({
        value: point.entryId, label: `${point.role === 'user' ? '你' : '助手'}：${point.text.replace(/\s+/g, ' ').slice(0, 70)}`,
        description: `消息 ${point.entryId} · 在此消息之后继续`,
      })), true);
      if (entryId) await this.pool.fork(slot.id, entryId);
      return;
    }
    if (command === '/sessions' || command === '/resume') return this.selectSession();
    if (command === '/switch') { this.pool.activate(this.findSlot(args, slot).id); return; }
    if (command === '/new') {
      const target = args ? parseOptions(['--cwd', resolve(slot.runtime.cwd, args.replace(/^"|"$/g, ''))]).cwd : slot.runtime.cwd;
      await this.pool.newSession({ ...this.pool.options, cwd: target, continue: false, session: undefined });
      return;
    }
    if (command === '/stop') {
      const target = this.findSlot(args, slot);
      for (const pending of [...(this.dialogs.get(target.id) ?? [])]) pending.finish(undefined);
      await this.stopSession(target);
      this.pool.notify(target, '任务已停止。');
      return;
    }
    if (command === '/close') {
      const target = this.findSlot(args, slot);
      if (this.dialogs.get(target.id)?.length) throw new Error('会话正在等待输入，请先处理或 /stop。');
      await this.pool.close(target.id);
      if (!this.pool.slots.size) await this.pool.open({ ...this.pool.options, cwd: slot.runtime.cwd, continue: false, session: undefined });
      return;
    }
    if (command === '/quit') return this.quit();
    if (command === '/copy') return this.copyAnswer(slot);
    if (command === '/editor') return this.externalEditor(slot);
    if (command === '/dequeue') { this.restoreQueue(slot); return; }
    if (command === '/compact') return this.pool.compact(slot.id, args || undefined);
    if (command === '/theme') {
      if (args) this.setTheme(slot, args);
      else await this.showThemeSelector(slot);
      return;
    }
    if (command === '/thinking') {
      if (!args) return this.showThinkingSelector(slot);
      const levels = slot.runtime.session.getAvailableThinkingLevels();
      const level = levels.find((candidate) => candidate.toLowerCase() === args.toLowerCase());
      if (!level) throw new Error(`当前模型支持的推理等级：${levels.join(', ')}。用 /thinking 打开选择器。显示控制请用 /thinking-display。`);
      this.selectThinkingLevel(slot, level);
      return;
    }
    if (command === '/thinking-display') {
      const display = thinkingModes.get(args);
      if (args && !display) throw new Error('用法：/thinking-display [collapse|expand|hide]');
      const transcript = this.view(slot).transcript;
      transcript.setThinking(display);
      this.pool.notify(slot, `思考显示：${thinkingLabels[transcript.thinking]}（仅影响界面，不改变模型推理设置）。`);
      return;
    }
    if (command === '/tools') {
      if (args && !['expand', 'collapse'].includes(args)) throw new Error('用法：/tools [expand|collapse]');
      const transcript = this.view(slot).transcript;
      transcript.setToolsExpanded(args ? args === 'expand' : undefined);
      this.pool.notify(slot, `工具结果：${transcript.toolsExpanded ? '展开' : '折叠'}；也可点击单条工具标题切换。`);
      return;
    }
    if (command === '/model') {
      if (slot.task || !slot.runtime.session.isIdle) throw new Error('先停止此会话的任务，再切换模型。');
      const models = await slot.runtime.services.modelRuntime.getAvailable();
      const model = args ? models.find((m) => `${m.provider}/${m.id}` === args) : undefined;
      if (!model) return this.showModelSelector(slot, args);
      await slot.runtime.session.setModel(model, { persist: false });
      this.pool.save(slot);
      this.pool.changed(slot);
      return;
    }
    if (command === '/login') {
      if (slot.task || !slot.runtime.session.isIdle) throw new Error('先停止此会话的任务，再配置认证。');
      const runtime = slot.runtime.services.modelRuntime;
      const providers = runtime.getProviders();
      const providerId = args || await this.choose('选择认证提供方', providers.map((p) => ({ value: p.id, label: p.name || p.id })));
      if (!providerId) return;
      const provider = runtime.getProvider(providerId);
      if (!provider) throw new Error('找不到此提供方。');
      const methods = [provider.auth?.apiKey?.login ? 'api_key' : undefined, provider.auth?.oauth ? 'oauth' : undefined].filter((s): s is 'api_key' | 'oauth' => !!s);
      const method = methods.length === 1 ? methods[0] : await this.choose('选择登录方式', methods.map((m) => ({ value: m, label: m })));
      if (method !== 'api_key' && method !== 'oauth') return;
      await runtime.login(providerId, method, {
        prompt: async (prompt) => {
          const options = prompt.type === 'select' ? prompt.options.map((o) => o.label) : undefined;
          const answer = await this.ask(slot, prompt.message, options, { signal: prompt.signal }, prompt.type === 'secret');
          if (answer === undefined) throw new Error('登录已取消。');
          return prompt.type === 'select' ? prompt.options.find((o) => o.label === answer)!.id : answer;
        },
        notify: (event) => this.pool.notify(slot, event.type === 'auth_url' ? event.url
          : event.type === 'device_code' ? `${event.verificationUri} · ${event.userCode}` : event.message),
      });
      this.pool.notify(slot, '认证已保存。使用 /model 选择模型；其他会话在下次新建时加载新配置。');
      return;
    }
    if (command === '/name') {
      if (!args) throw new Error('用法：/name 会话名称');
      slot.runtime.session.setSessionName(args);
      this.pool.save(slot);
      this.pool.changed(slot);
      return;
    }
    if (command === '/settings') {
      return this.showSettings(slot);
    }
    if (command === '/session') return this.showInfo(slot, () => this.sessionInfo(slot));
    if (command === '/hotkeys') return this.showInfo(slot, () => this.hotkeysInfo());
    if (command === '/help') {
      await slot.runtime.session.sendCustomMessage({ customType: 'local-pi-help', content: commands.map((c) => `- /${c.name} ${c.description}`).join('\n'), display: true }, { triggerTurn: false });
      return;
    }
    if (command?.startsWith('/')) {
      const name = command.slice(1);
      const session = slot.runtime.session;
      const extension = session.extensionRunner?.getCommand(name);
      const template = session.promptTemplates.some((template) => template.name === name);
      const skill = name.startsWith('skill:') && session.resourceLoader.getSkills().skills.some((skill) => skill.name === name.slice(6));
      if (skill && !slot.runtime.services.settingsManager.getEnableSkillCommands()) throw new Error('技能命令已关闭，可在 /settings 中启用。');
      if (!extension && !template && !skill) {
        const native = this.piUi!.BUILTIN_SLASH_COMMANDS.some((entry) => entry.name === name);
        throw new Error(native ? `${command} 是 Pi 原生命令，当前多会话界面尚未支持。用 /help 查看可用命令，或使用 local-pi --classic。`
          : `未知命令 ${command}。用 /help 查看可用命令；未发送给模型。`);
      }
    }
    this.view(slot).scroll.scrollToEnd();
    await this.pool.submit(slot.id, text, mode);
  }

  private async quit(force = false): Promise<void> {
    if (!force && [...this.pool.slots.values()].some((slot) => slot.task || slot.state === 'waiting')) {
      const confirmed = await this.choose('退出将停止全部后台任务。是否退出？', [{ value: 'cancel', label: '继续运行' }, { value: 'quit', label: '停止全部并退出' }]);
      if (confirmed !== 'quit') return;
    }
    this.ended = true;
    this.extensionPanels.dispose();
    this.panel?.close();
    this.thinkingSelector?.cancel();
    this.cancelThemeSelector?.();
    clearTimeout(this.timer);
    clearInterval(this.clockTimer);
    for (const view of this.views.values()) view.working.dispose();
    for (const dialogs of this.dialogs.values()) for (const dialog of [...dialogs]) dialog.finish(undefined);
    await this.pool.dispose();
    this.tui.stop();
    this.resolveDone?.();
  }

  async run(): Promise<void> {
    try { this.piUi = await loadPiUi(); await this.pool.open(this.pool.options); }
    catch (error) {
      for (const view of this.views.values()) { view.working.dispose(); view.footerData.dispose(); }
      this.restoreKeybindings(); throw error;
    }
    const done = new Promise<void>((resolveDone) => { this.resolveDone = resolveDone; });
    this.tui.addInputListener((data) => {
      if (this.choosing) return undefined;
      const slot = this.pool.active;
      const keys = getKeybindings();
      if (keys.matches(data, 'local.session.select')) { void this.selectSession().catch((e) => this.pool.notify(slot, String(e))); return { consume: true }; }
      if (keys.matches(data, 'local.session.new')) { void this.dispatch(slot, '/new').catch((e) => this.pool.notify(slot, String(e))); return { consume: true }; }
      if (this.extensionPanels.visible) return undefined;
      if (keys.matches(data, 'app.thinking.toggle')) {
        const transcript = this.view(slot).transcript;
        transcript.setThinking(transcript.thinking === 'expanded' ? 'collapsed' : 'expanded');
        return { consume: true };
      }
      if (keys.matches(data, 'app.tools.expand')) { this.view(slot).transcript.setToolsExpanded(); return { consume: true }; }
      if (keys.matches(data, 'app.interrupt')) {
        const pending = this.dialogs.get(this.pool.activeId!)?.[0];
        if (pending) pending.finish(undefined); else void this.stopSession(slot);
        return { consume: true };
      }
      if (keys.matches(data, 'app.clear')) {
        const view = this.view(this.pool.active);
        view.clipboard.cancelPending(); view.editor.setText(''); this.schedule(); return { consume: true };
      }
      if (keys.matches(data, 'app.exit') && !this.view(this.pool.active).editor.getText()) { void this.quit(); return { consume: true }; }
      return undefined;
    });
    const terminate = () => { void this.quit(true); };
    process.on('SIGINT', terminate);
    process.on('SIGTERM', terminate);
    try {
      this.refresh();
      this.tui.start();
      this.themeController = new this.piUi.InteractiveThemeController(this.tui, {
        getSettingsManager: () => this.pool.active.runtime.services.settingsManager,
        showError: (message) => this.pool.notify(this.pool.active, message), onChanged: () => this.themeChanged(),
      });
      this.piUi.onThemeChange(() => { this.tui.invalidate(); this.themeChanged(); });
      this.applyActiveTheme();
      this.clockTimer = setInterval(() => {
        if (this.pool.activeId && (this.pool.active.metrics.current || this.pool.active.shell)) this.refresh();
      }, 1000);
      await done;
    } finally {
      this.extensionPanels.dispose();
      for (const view of this.views.values()) { view.working.dispose(); view.transcript.resetHistory(); }
      for (const view of this.views.values()) view.footerData.dispose();
      clearInterval(this.clockTimer);
      this.themeController?.dispose();
      this.piUi.onThemeChange(() => {});
      this.piUi.stopThemeWatcher();
      this.restoreKeybindings();
      process.removeListener('SIGINT', terminate);
      process.removeListener('SIGTERM', terminate);
      this.tui.stop();
      // Windows can keep the console read handle referenced after raw input stops.
      if (this.terminal instanceof ProcessTerminal) process.stdin.unref();
    }
  }
}
