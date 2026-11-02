import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { constants } from 'node:fs';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createMcpExtension,
  createEditToolDefinition, createWriteToolDefinition, defineTool,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ModelRuntime,
  type SettingsManager,
  type SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import type { Options } from '../cli.ts';
import { createWorkspaceExtension, type WorkspaceHooks } from '../extensions/workspace.ts';
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
  workspaceHooks?: WorkspaceHooks;
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
  const { workspaceHooks, sessionsRoot, sessionManager: suppliedManager, sessionStartEvent: initialStartEvent, ...servicesOverrides } = overrides;
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
    let session: AgentSession | undefined;
    const wrapped = new WeakSet<object>();
    const wrap = (name: string) => {
      const definition = session?.getToolDefinition(name);
      if (!definition || !workspaceHooks?.executeTool || wrapped.has(definition)) return;
      const execute = definition.execute;
      definition.execute = (id, input, signal, update, ctx) => workspaceHooks.executeTool!({ toolName: name, toolCallId: id,
        input: input as Record<string, unknown>, signal }, () => execute.call(definition, id, input, signal, update, ctx));
      wrapped.add(definition);
    };
    const hooks = workspaceHooks && { ...workspaceHooks, beforeTool: async (event: Parameters<WorkspaceHooks['beforeTool']>[0]) => {
      // Also covers tools registered lazily by MCP and fresh native definitions after /reload.
      wrap(event.toolName); await workspaceHooks.beforeTool(event);
    } };
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...servicesOverrides,
      resourceLoaderOptions: {
        extensionFactories: [createWorkspaceExtension(mode, hooks), ...official.builtInExtensions.map((extension) =>
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
      customTools: workspaceHooks?.executeTool ? [
        defineTool(createEditToolDefinition(cwd, { operations: { readFile: (path) => readFile(path),
          access: (path) => access(path, constants.R_OK | constants.W_OK),
          writeFile: async (path, content) => { await workspaceHooks.beforeWrite?.(path); await writeFile(path, content, 'utf8'); } } })),
        defineTool(createWriteToolDefinition(cwd, { operations: {
          mkdir: async (path) => { await mkdir(path, { recursive: true }); },
          writeFile: async (path, content) => { await workspaceHooks.beforeWrite?.(path); await writeFile(path, content, 'utf8'); } } })),
      ] : undefined,
    });
    session = result.session;
    for (const tool of session.getAllTools()) wrap(tool.name);
    // Keep coding tools registered for switching, but expose only the current mode's tools.
    result.session.setActiveToolsByName(toolsForMode(mode));
    return { ...result, services, diagnostics: services.diagnostics };
  };
  return createAgentSessionRuntime(create, { cwd: options.cwd, agentDir, sessionManager, sessionStartEvent: initialStartEvent });
}
