import type { CodexSessionOptions, CodexSession } from '../codex-runtime/types';
import { type OfficialAppServerDriver } from '../codex-runtime/official-app-server-driver';
import { createCodexDriver } from '../codex-runtime/factory';
import type {
  CodexMcpProfile,
  CodexOwnerKind,
  CodexRunOptions,
  CodexRunSessionKey,
  CodexSurface,
  CodexSelectableSurface,
} from '../codex-runtime/types';
import { createLogger } from '../logger';
import { getOfficialPhaseCodexSpawnExtraArgs } from '../codex-pipeline-config';
import type { CodexChatReasoningEffort } from '../../../src/types';
import { isKnownStaticCodexModel, staticEffortsFor } from '../../../src/constants/codex-models';
import { CodexCapabilityUnsupportedError } from '../codex-runtime/errors';
import {
  getCodexModelCapabilities,
  getCodexModelCapabilitiesState,
  clampCodexEffortForModelDiscovered,
} from '../codex-runtime/model-capabilities';
import { registerCodexSessionSignature, registerCodexUsageSemantics } from './codex-session-signature';

const logger = createLogger('codex-session-factory');

const officialDriverCache = new Map<string, OfficialAppServerDriver>();

function getOfficialCodexDriver(): OfficialAppServerDriver {
  const key = 'official-app-server';
  const cached = officialDriverCache.get(key);
  if (cached) return cached;
  const driver = createCodexDriver();
  officialDriverCache.set(key, driver);
  return driver;
}

export function __resetOfficialCodexDriverCacheForTests(): void {
  officialDriverCache.clear();
}

export function resetOfficialProjectRunsNow(projectId: string, reason: string): void {
  for (const driver of officialDriverCache.values()) driver.resetProjectNow(projectId, reason);
}

export function hasActiveOfficialRun(scope: Partial<CodexRunSessionKey>): boolean {
  for (const driver of officialDriverCache.values()) {
    if (driver.hasActiveRun(scope)) return true;
  }
  return false;
}

export async function closeAllOfficialRuns(reason: string): Promise<void> {
  await Promise.allSettled([...officialDriverCache.values()].map((driver) => driver.closeAll(reason)));
}

export async function shutdownOfficialCodexDrivers(reason: string): Promise<void> {
  const drivers = [...officialDriverCache.values()];
  officialDriverCache.clear();
  await Promise.allSettled(drivers.map((driver) => driver.shutdown()));
  logger.info({ reason, count: drivers.length }, 'drivers Codex oficiais encerrados');
}

export interface ResolveCodexSessionArgs {
  surface: CodexSelectableSurface;
  mcpProfile: CodexMcpProfile;
  sessionOptions: CodexSessionOptions;
  disableGlobalMcp?: boolean;
  reasoningEffortOverride?: CodexChatReasoningEffort;
  extraArgs?: string[];
  swarmFindingsMcpArgs?: string[];
  swarmFindingsMcpEnv?: Record<string, string>;
  codexConfigOverrides?: readonly string[];
}

export const CODEX_CONFIG_OVERRIDE_PATTERN = /^(web_search|features\.[a-z0-9_]+)=("[a-z_-]+"|true|false)$/;
export const SWARM_MCP_ARG_PREFIXES: readonly string[] = ['mcp_servers.swarm-worker=', 'mcp_servers.lionclaw-swarm='];
export const SWARM_MCP_COMPANION_ARG_PREFIXES: readonly string[] = ['mcp_servers.repo-graph='];
function validSwarmMcpPairs(parts: readonly string[]): boolean {
  if (parts.length < 2 || parts.length % 2 !== 0 || parts.length > 4) return false;
  for (let i = 0; i < parts.length; i += 2) {
    const value = parts[i + 1] ?? '';
    const prefixes = i === 0 ? SWARM_MCP_ARG_PREFIXES : SWARM_MCP_COMPANION_ARG_PREFIXES;
    if (parts[i] !== '-c' || !prefixes.some((prefix) => value.startsWith(prefix))) return false;
  }
  return true;
}
export function validateSwarmMcpSpawn(args: {
  disableGlobalMcp?: boolean;
  sandbox?: string;
  swarmFindingsMcpArgs?: string[];
  swarmFindingsMcpEnv?: Record<string, string>;
}): { extraArgs: string[]; spawnEnv?: Record<string, string> } | null {
  if (!args.swarmFindingsMcpArgs) return null;
  const parts = args.swarmFindingsMcpArgs;
  if (!args.disableGlobalMcp || args.sandbox !== 'read-only' || !validSwarmMcpPairs(parts)) {
    throw new Error('Invalid isolated Swarm findings MCP configuration');
  }
  if (args.swarmFindingsMcpEnv && Object.keys(args.swarmFindingsMcpEnv).some((key) => key !== 'LIONCLAW_HELPER_TOKEN'))
    throw new Error('Invalid Swarm MCP environment');
  return {
    extraArgs: [...parts],
    ...(args.swarmFindingsMcpEnv ? { spawnEnv: { ...args.swarmFindingsMcpEnv } } : {}),
  };
}

export function validateCodexConfigOverrides(args: ResolveCodexSessionArgs): string[] {
  const overrides = args.codexConfigOverrides ?? [];
  if (overrides.length === 0) return [];
  if (!args.disableGlobalMcp || args.sessionOptions.sandbox !== 'read-only') {
    throw new Error('codexConfigOverrides exige sessao isolada (disableGlobalMcp) em sandbox read-only');
  }
  for (const entry of overrides) {
    if (!CODEX_CONFIG_OVERRIDE_PATTERN.test(entry)) throw new Error(`codexConfigOverride nao permitido: ${entry}`);
  }
  return overrides.flatMap((entry) => ['-c', entry]);
}

function freshRunId(): string {
  return `s9-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toLifecycleSurface(surface: CodexSelectableSurface): CodexSurface {
  return surface === 'agent-scoped' ? 'codex-agents-mcp' : surface;
}

function buildRunKey(args: ResolveCodexSessionArgs): CodexRunSessionKey {
  const ownerKind: CodexOwnerKind = args.sessionOptions.ownerKind ?? 'pipeline';
  return {
    surface: toLifecycleSurface(args.surface),
    projectId: args.sessionOptions.projectId,
    runId: freshRunId(),
    ownerKind,
    ownerId: args.sessionOptions.ownerId,
    mcpProfile: args.mcpProfile,
  };
}

function buildRunOptions(args: ResolveCodexSessionArgs, effectiveEffort?: CodexChatReasoningEffort): CodexRunOptions {
  const b = args.sessionOptions;
  return {
    key: buildRunKey(args),
    model: b.model,
    cwd: b.cwd,
    systemPrompt: b.systemPrompt,
    approvalPolicy: b.approvalPolicy ?? 'never',
    sandbox: b.sandbox ?? 'workspace-write',
    reasoningEffort: effectiveEffort ?? b.reasoningEffort,
    timeoutMs: b.timeoutMs,
    idleTimeoutMs: b.idleTimeoutMs,
    turnSettleMs: b.turnSettleMs,
    externallyManagedWatchdog: b.externallyManagedWatchdog,
    swarmOwnerDirectory: b.swarmOwnerDirectory,
    disableGlobalMcp: args.disableGlobalMcp,
    extraArgs: args.extraArgs,
  };
}

function hasStructuralExtraArgs(args: ResolveCodexSessionArgs): boolean {
  return args.extraArgs !== undefined && args.extraArgs.length > 0;
}

export async function resolveCodexSessionForRun(args: ResolveCodexSessionArgs): Promise<CodexSession> {
  const requestedEffort = args.reasoningEffortOverride ?? args.sessionOptions.reasoningEffort;

  const discovered = await getCodexModelCapabilities();
  if (getCodexModelCapabilitiesState() === 'ready') {
    const model = args.sessionOptions.model;
    const slug = model.trim().toLowerCase();
    const cap = discovered?.find((c) => c.id.toLowerCase() === slug);
    if (!cap && !isKnownStaticCodexModel(model)) {
      throw new CodexCapabilityUnsupportedError(
        `O modelo "${model}" nao existe no model/list do Codex CLI instalado nem no catalogo local. ` +
          `Modelos disponiveis: ${(discovered ?? []).map((c) => c.id).join(', ')}.`,
      );
    }
    if (!cap) {
      throw new CodexCapabilityUnsupportedError(
        `O modelo "${model}" nao e anunciado pelo Codex CLI instalado (provavelmente desatualizado). ` +
          `Atualize com "npm i -g @openai/codex@latest" e reinicie o LionClaw, ou escolha outro modelo. ` +
          `Modelos anunciados: ${(discovered ?? []).map((c) => c.id).join(', ')}.`,
      );
    }
    const req = requestedEffort as CodexChatReasoningEffort | undefined;
    if (req !== undefined && staticEffortsFor(model).includes(req) && !cap.supportedEfforts.includes(req)) {
      throw new CodexCapabilityUnsupportedError(
        `O effort "${req}" nao e anunciado pelo Codex CLI para "${model}" ` +
          `(anuncia: ${cap.supportedEfforts.join(', ')}).`,
      );
    }
  }
  const signature = {
    model: args.sessionOptions.model,
    requestedEffort: requestedEffort as string | undefined,
  };

  const effectiveEffort =
    requestedEffort !== undefined
      ? clampCodexEffortForModelDiscovered(requestedEffort as CodexChatReasoningEffort, args.sessionOptions.model)
      : undefined;

  const runOptions = buildRunOptions(args, effectiveEffort);

  if (runOptions.key.ownerKind !== 'chat') {
    if (hasStructuralExtraArgs(args)) {
      throw new Error(
        'extraArgs estruturais em spawn codex de fase/subagente (ownerKind nao-chat): a composicao index e exclusiva do chat (mcp-index-codex P6/P8)',
      );
    }
    if (!args.disableGlobalMcp) {
      const phaseExtras = getOfficialPhaseCodexSpawnExtraArgs();
      if (phaseExtras.length > 0) {
        runOptions.extraArgs = phaseExtras;
      }
    }
  }

  const swarmSpawn = validateSwarmMcpSpawn({
    disableGlobalMcp: args.disableGlobalMcp,
    sandbox: args.sessionOptions.sandbox,
    swarmFindingsMcpArgs: args.swarmFindingsMcpArgs,
    swarmFindingsMcpEnv: args.swarmFindingsMcpEnv,
  });
  if (swarmSpawn) {
    runOptions.extraArgs = swarmSpawn.extraArgs;
    if (swarmSpawn.spawnEnv) runOptions.swarmSpawnEnv = swarmSpawn.spawnEnv;
  }
  const overrideArgs = validateCodexConfigOverrides(args);
  if (overrideArgs.length > 0) runOptions.extraArgs = [...(runOptions.extraArgs ?? []), ...overrideArgs];
  const driver = getOfficialCodexDriver();
  const handle = await driver.createRun(runOptions);
  const officialSession = driver.toSyncCodexSession(handle) as CodexSession;
  registerCodexSessionSignature(officialSession, signature);
  registerCodexUsageSemantics(officialSession, 'thread-cumulative');
  return officialSession;
}
