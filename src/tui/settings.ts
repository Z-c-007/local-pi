import { SettingsSelectorComponent, type SettingsConfig, type SettingsCallbacks } from '@earendil-works/pi-coding-agent';
import type { SessionSlot } from '../agent/session-pool.ts';
import type { PiUi } from './pi-ui.ts';

interface Host {
  pi: PiUi;
  theme: InstanceType<PiUi['InteractiveThemeController']>;
  changed(): void;
  notify(message: string): void;
  setTheme(name: string): void;
  close(): void;
  setThinkingDisplay(hidden: boolean): void;
  hideThinkingBlock: boolean;
}

/** The native settings menu and SDK persistence; host-only behavior stays explicit. */
export function settingsPanel(slot: SessionSlot, host: Host): SettingsSelectorComponent {
  const session = slot.runtime.session;
  const s = slot.runtime.services.settingsManager;
  const provider = s.getDefaultProvider(); const model = s.getDefaultModel();
  const config: SettingsConfig = {
    autoCompact: session.autoCompactionEnabled, defaultModel: provider && model ? `${provider}/${model}` : 'not set',
    currentModel: session.model, availableDefaultModels: session.modelRuntime.getAvailableSnapshot(),
    showImages: s.getShowImages(), imageWidthCells: s.getImageWidthCells(), autoResizeImages: s.getImageAutoResize(),
    blockImages: s.getBlockImages(), enableSkillCommands: s.getEnableSkillCommands(),
    steeringMode: session.steeringMode, followUpMode: session.followUpMode, transport: s.getTransport(),
    sessionShareDestination: s.getSessionShareDestination(), httpIdleTimeoutMs: s.getHttpIdleTimeoutMs(),
    cacheWarmingMode: s.getCacheWarmingMode(), thinkingLevel: s.getDefaultThinkingLevel() ?? 'medium',
    availableThinkingLevels: session.getAvailableThinkingLevels(), modelThinkingLevels: s.getAllModelThinkingLevels(),
    currentTheme: host.theme.getThemeSelection() ?? 'system', terminalTheme: host.theme.getTerminalTheme(),
    availableThemes: host.pi.getAvailableThemes(), hideThinkingBlock: host.hideThinkingBlock,
    mermaidRenderingMode: s.getMermaidRenderingMode(), showCacheMissNotices: s.getShowCacheMissNotices(),
    collapseChangelog: s.getCollapseChangelog(), enableInstallTelemetry: s.getEnableInstallTelemetry(),
    doubleEscapeAction: s.getDoubleEscapeAction(), treeFilterMode: s.getTreeFilterMode(),
    showHardwareCursor: s.getShowHardwareCursor(), editorPaddingX: s.getEditorPaddingX(), outputPad: s.getOutputPad(),
    autocompleteMaxVisible: s.getAutocompleteMaxVisible(), quietStartup: s.getQuietStartup(), defaultProjectTrust: s.getDefaultProjectTrust(),
    clearOnShrink: s.getClearOnShrink(), showTerminalProgress: s.getShowTerminalProgress(), tuiMode: 'fullscreen',
    fullscreenExitOutput: s.getFullscreenExitOutput(), fullscreenScrollbar: s.getFullscreenScrollbar(),
    fullscreenCopyOnSelect: s.getFullscreenCopyOnSelect(), fullscreenWheelScrollLines: s.getFullscreenWheelScrollLines(), warnings: s.getWarnings(),
  };
  const savedOnly = (name: string) => host.notify(`${name} 已保存；该功能尚未接入多会话界面，可在 --classic 中使用。`);
  const callbacks: SettingsCallbacks = {
    onAutoCompactChange: (value) => session.setAutoCompactionEnabled(value),
    onShowImagesChange: (value) => s.setShowImages(value),
    onImageWidthCellsChange: (value) => s.setImageWidthCells(value),
    onAutoResizeImagesChange: (value) => s.setImageAutoResize(value),
    onBlockImagesChange: (value) => s.setBlockImages(value),
    onEnableSkillCommandsChange: (value) => s.setEnableSkillCommands(value),
    onSteeringModeChange: (value) => session.setSteeringMode(value),
    onFollowUpModeChange: (value) => session.setFollowUpMode(value),
    onTransportChange: (value) => { s.setTransport(value); session.agent.transport = value; },
    onSessionShareDestinationChange: (value) => { s.setSessionShareDestination(value); savedOnly('分享目标'); },
    onHttpIdleTimeoutMsChange: (value) => { s.setHttpIdleTimeoutMs(value); host.pi.configureHttpDispatcher(value); },
    onCacheWarmingModeChange: (value) => session.setCacheWarmingMode(value),
    onModelThinkingLevelChange: (provider, modelId, level) => {
      s.setModelThinkingLevel(provider, modelId, level);
      if (session.model?.provider === provider && session.model.id === modelId) session.setThinkingLevel(level, { persist: false });
    },
    onModelThinkingLevelRemove: (provider, modelId) => {
      s.removeModelThinkingLevel(provider, modelId);
      if (session.model?.provider === provider && session.model.id === modelId) session.setThinkingLevel(s.getDefaultThinkingLevel() ?? 'medium', { persist: false });
    },
    onThemeChange: (value) => host.setTheme(value), onThemePreview: (value) => host.theme.preview(value),
    onHideThinkingBlockChange: (value) => { s.setHideThinkingBlock(value); host.setThinkingDisplay(value); },
    onMermaidRenderingModeChange: (value) => { s.setMermaidRenderingMode(value); savedOnly('Mermaid 渲染'); },
    onShowCacheMissNoticesChange: (value) => { s.setShowCacheMissNotices(value); savedOnly('缓存未命中通知'); },
    onCollapseChangelogChange: (value) => { s.setCollapseChangelog(value); savedOnly('更新日志折叠'); },
    onEnableInstallTelemetryChange: (value) => { s.setEnableInstallTelemetry(value); host.notify('安装遥测设置已保存。'); },
    onDoubleEscapeActionChange: (value) => { s.setDoubleEscapeAction(value); savedOnly('双击 Esc'); },
    onTreeFilterModeChange: (value) => s.setTreeFilterMode(value),
    onShowHardwareCursorChange: (value) => s.setShowHardwareCursor(value),
    onEditorPaddingXChange: (value) => s.setEditorPaddingX(value),
    onOutputPadChange: (value) => s.setOutputPad(value),
    onAutocompleteMaxVisibleChange: (value) => s.setAutocompleteMaxVisible(value),
    onQuietStartupChange: (value) => { s.setQuietStartup(value); savedOnly('原版启动显示'); },
    onDefaultProjectTrustChange: (value) => s.setDefaultProjectTrust(value),
    onClearOnShrinkChange: (value) => s.setClearOnShrink(value),
    onShowTerminalProgressChange: (value) => { s.setShowTerminalProgress(value); savedOnly('终端进度'); },
    onTuiModeChange: () => {
      queueMicrotask(() => selector.getSettingsList().updateValue('tui-mode', 'fullscreen'));
      host.notify('多会话界面固定使用全屏模式；其他布局请使用 --classic。');
    },
    onFullscreenExitOutputChange: (value) => { s.setFullscreenExitOutput(value); savedOnly('退出时输出'); },
    onFullscreenScrollbarChange: (value) => s.setFullscreenScrollbar(value),
    onFullscreenCopyOnSelectChange: (value) => s.setFullscreenCopyOnSelect(value),
    onFullscreenWheelScrollLinesChange: (value) => s.setFullscreenWheelScrollLines(value),
    onWarningsChange: (value) => s.setWarnings(value), onCancel: host.close,
  };
  for (const key of Object.keys(callbacks) as Array<keyof SettingsCallbacks>) {
    if (key === 'onCancel' || key === 'onThemePreview') continue;
    const handler = callbacks[key] as (...args: unknown[]) => void;
    // Each native callback persists through SettingsManager, then updates this host.
    (callbacks as unknown as Record<string, (...args: unknown[]) => void>)[key] = (...args) => { handler(...args); host.changed(); };
  }
  const selector = new SettingsSelectorComponent(config, callbacks);
  return selector;
}
