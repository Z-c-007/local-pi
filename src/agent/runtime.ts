import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createMcpExtension,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ModelRuntime,
  type SettingsManager,
  type SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import type { Options } from '../cli.ts';
import { createWorkspaceExtension } from '../extensions/workspace.ts';
import { codingTools, mcpTools, restoreMode, toolsForMode } from './mode.ts';
import { loadPiRuntimeSupport } from '../tui/pi-ui.ts';

export { codingTools } from './mode.ts';

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const defaultSessionsRoot = join(appRoot, '.local-pi', 'sessions');

export function sessionDirectory(cwd: string, sessionsRoot = defaultSessionsRoot): string {
  const canonical = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return join(sessionsRoot, key);
}

export interface RuntimeOverrides {
  modelRuntime?: ModelRuntime;
  settingsManager?: SettingsManager;
  sessionsRoot?: string;
  sessionManager?: SessionManager;
  sessionStartEvent?: SessionStartEvent;
}

export async function createRuntime(
  options: Options,
  overrides: RuntimeOverrides = {},
) {
  const { sessionsRoot, sessionManager: suppliedManager, sessionStartEvent: initialStartEvent, ...servicesOverrides } = overrides;
  const agentDir = options.agentDir ?? getAgentDir();
  const sessionDir = sessionDirectory(options.cwd, sessionsRoot);
  let sessionManager: SessionManager;
  if (options.doctor) {
    sessionManager = SessionManager.inMemory(options.cwd);
  } else if (suppliedManager) {
    if (realpathSync(suppliedManager.getCwd()) !== realpathSync(options.cwd)) {
      throw new Error('会话管理器的工作目录与目标项目不一致。');
    }
    sessionManager = suppliedManager;
  } else if (options.session) {
    if (!existsSync(options.session)) throw new Error(`会话文件不存在：${options.session}`);
    sessionManager = SessionManager.open(options.session);
    const storedCwd = sessionManager.getCwd();
    if (!existsSync(storedCwd) || realpathSync(storedCwd) !== realpathSync(options.cwd)) {
      throw new Error(`会话所属项目是 ${storedCwd}，请用 --cwd 指定该项目。`);
    }
  } else {
    sessionManager = options.continue
      ? SessionManager.continueRecent(options.cwd, sessionDir)
      : SessionManager.create(options.cwd, sessionDir);
  }
  const instructions = readFileSync(join(appRoot, 'resources', 'coding.md'), 'utf8');
  const official = await loadPiRuntimeSupport();
  const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager: manager, sessionStartEvent }) => {
    const mode = restoreMode(manager.getBranch());
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...servicesOverrides,
      resourceLoaderOptions: {
        extensionFactories: [createWorkspaceExtension(mode), ...official.builtInExtensions.map((extension) =>
          typeof extension === 'function' || extension.name !== 'mcp' ? extension : { ...extension, factory: createMcpExtension({
            loadConfig: (ctx) => official.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }),
            credentials: new official.McpOAuthCredentialStore(new official.FileAuthStorageBackend(join(agentDir, 'mcp-auth.json')), agentDir),
            logPath: join(agentDir, 'mcp.log'),
          }) })],
        additionalPromptTemplatePaths: [join(appRoot, 'resources', 'prompts')],
        appendSystemPrompt: [instructions],
      },
    });
    let model;
    if (options.model) {
      const slash = options.model.indexOf('/');
      model = services.modelRuntime.getModel(options.model.slice(0, slash), options.model.slice(slash + 1));
      if (!model) throw new Error(`找不到模型 ${options.model}。请检查 Pi 的 models.json 或使用 /model。`);
    }
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      sessionStartEvent,
      model,
      // The SDK restores settings automatically only when messages exist. Empty
      // sessions also keep explicit level entries in our session catalog.
      thinkingLevel: manager.getBranch().some((entry) => entry.type === 'thinking_level_change')
        ? manager.buildSessionContext().thinkingLevel as AgentSession['thinkingLevel'] : undefined,
      tools: [...codingTools, ...mcpTools, 'mcp__*'],
    });
    // Keep coding tools registered for switching, but expose only the current mode's tools.
    result.session.setActiveToolsByName(toolsForMode(mode));
    return { ...result, services, diagnostics: services.diagnostics };
  };
  return createAgentSessionRuntime(create, { cwd: options.cwd, agentDir, sessionManager, sessionStartEvent: initialStartEvent });
}
