import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

type ThemeModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js');
type ControllerModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-controller.js');
type FooterModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js');
type CommandsModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js');
type ClipboardModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/utils/clipboard.js');
type ClipboardImageModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js');
type HttpModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js');
type ExternalEditorModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/external-editor.js');
type BuiltinsModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js');
type McpConfigModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js');
type McpOAuthModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js');
type AuthModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
type PowerShellModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/powershell.js');
type DiffModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js');
type PathsModule = typeof import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js');

export async function loadPiDiff(): Promise<DiffModule> {
  return officialModule()('core/tools/edit-diff.js');
}
export async function loadPiPaths(): Promise<PathsModule> { return officialModule()('core/tools/path-utils.js'); }
export type PiUi = Omit<ThemeModule, 'theme'> & ControllerModule & FooterModule & CommandsModule & ClipboardModule & ClipboardImageModule & HttpModule & ExternalEditorModule & {
  getTheme(): ThemeModule['theme'];
};

/** Keep version-bound official module access in one place. */
function officialModule() {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const dist = dirname(entry);
  const { version } = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8'));
  if (version !== '1.3.0') throw new Error(`Pi UI 兼容层需要 1.3.0，当前为 ${version}；请先核对官方 UI 接口。`);
  return (path: string) => import(pathToFileURL(join(dist, path)).href);
}

export async function loadPiRuntimeSupport() {
  const at = officialModule();
  const [builtins, mcpConfig, oauth, auth, shell] = await Promise.all([
    at('extensions/index.js') as Promise<BuiltinsModule>,
    at('extensions/mcp/config.js') as Promise<McpConfigModule>,
    at('extensions/mcp/oauth.js') as Promise<McpOAuthModule>,
    at('core/auth-storage.js') as Promise<AuthModule>,
    at('core/tools/powershell.js') as Promise<PowerShellModule>,
  ]);
  return { ...builtins, ...mcpConfig, ...oauth, ...auth, ...shell };
}

export async function loadPiUi(): Promise<PiUi> {
  const moduleAt = officialModule();
  const [theme, controller, footer, commands, clipboard, clipboardImage, http, externalEditor] = await Promise.all([
    moduleAt('modes/interactive/theme/theme.js') as Promise<ThemeModule>,
    moduleAt('modes/interactive/theme/theme-controller.js') as Promise<ControllerModule>,
    moduleAt('core/footer-data-provider.js') as Promise<FooterModule>,
    moduleAt('core/slash-commands.js') as Promise<CommandsModule>,
    moduleAt('utils/clipboard.js') as Promise<ClipboardModule>,
    moduleAt('utils/clipboard-image.js') as Promise<ClipboardImageModule>,
    moduleAt('core/http-dispatcher.js') as Promise<HttpModule>,
    moduleAt('modes/interactive/external-editor.js') as Promise<ExternalEditorModule>,
  ]);
  // Preserve the live theme binding, which changes when a theme is selected.
  return Object.assign(Object.create(null), controller, footer, commands, clipboard, clipboardImage, http, externalEditor,
    Object.fromEntries(Object.entries(theme).filter(([key]) => key !== 'theme')),
    { getTheme: () => theme.theme }) as PiUi;
}
