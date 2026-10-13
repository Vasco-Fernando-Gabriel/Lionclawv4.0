import path from 'node:path';
import fs from 'node:fs/promises';
import { getLionClawHome } from '../paths';
import { createSwarmWorkerBridge } from '../swarm/worker-bridge';
import { randomUUID } from 'node:crypto';
import { getAgent, getAllAgents, getEnabledTools } from '../db';
import { resolveAgentQueryConfig, type AgentQueryConfig, type McpServerEntry } from '../agent-config-resolver';
import { REPO_GRAPH_MCP_SERVER_ID, mergeRepoGraphAllowlist } from '../repo-graph/reader-tools';
import { createLogger } from '../logger';
import type { AgentConfig } from '../../../src/types';
import type {
  SwarmMember,
  SwarmRuntime,
  SwarmSettings,
  SwarmCatalog,
  SwarmContinuationMode,
  SwarmFindingsOperation,
  SwarmFindingsAck,
  SwarmSessionRef,
  SwarmRepoGraphState,
} from '../../../src/types/swarm';
import {
  createSwarmRepoGraphInvoke,
  findSwarmRepoGraphBinding,
  mountSwarmRepoGraphMcp,
  splitSwarmMcpServers,
  swarmRepoGraphState,
  type SwarmRepoGraphBinding,
  type SwarmRepoGraphInvoke,
} from '../swarm/repo-graph';
import type { CodexSession } from '../codex-runtime/types';
import {
  pinSwarmCodexScope,
  protectSwarmCodexScope,
  releaseSwarmCodexScope,
  swarmCodexOwnerId,
  type SwarmCodexScope,
} from '../codex-runtime/swarm-session-guard';
import { executeAgent } from './execute';
import type { AgentExecutionRequest, AgentExecutionResult } from './types';
import { assertSwarmBackendAvailable } from './swarm-availability';
import { recoverSwarmProcessMarker } from './swarm-process';
import { createSwarmPermission, createSwarmToolDispatch, swarmEffectiveTools, swarmCatalogTools } from './swarm-policy';
import { pruneStaleRuntimeConfigs, swarmEffectiveModel } from './swarm-member-config';
import { SWARM_CONTRACT } from '../seed-agents/_shared/swarm-contract';
import { SWARM_AGENT_IDS } from '../seed-agents/swarm-registry';
import { repoGraphMarkEnabled } from '../../../src/lib/swarm-repo-graph-mark';
import { isSwarmGenericRole } from '../swarm/generic-roles';
import { listSwarmRuntimeCapabilities } from '../swarm/runtime-capabilities';

const logger = createLogger('swarm-adapter');
const CONTRACT_MARKERS = ['## Contrato de saída', '## Contrato de saida'];
export function hasSwarmContract(rolePrompt: string): boolean {
  return (
    CONTRACT_MARKERS.some((marker) => rolePrompt.includes(marker)) ||
    (/^STATUS:/m.test(rolePrompt) && /^FINDINGS:/m.test(rolePrompt))
  );
}
export function ephemeralSystemPrompt(rolePrompt: string): string {
  const role = rolePrompt.trim();
  return hasSwarmContract(role) ? role : `${role}\n\n${SWARM_CONTRACT}`;
}

export interface SwarmResolvedMember {
  runtime: SwarmRuntime;
  model: string;
  snapshot: Record<string, unknown>;
  agent: AgentConfig;
  config: AgentQueryConfig;
  repoGraph?: SwarmRepoGraphBinding | null;
  repoGraphState?: SwarmRepoGraphState;
}
export function swarmResolvedRepoGraphState(
  resolved: Pick<SwarmResolvedMember, 'repoGraphState'>,
): SwarmRepoGraphState {
  return resolved.repoGraphState ?? 'off';
}
export interface SwarmSessionContinuation {
  session: SwarmSessionRef;
  fallbackPrompt: string | null;
}
export interface SwarmAttemptExecution {
  resolved: SwarmResolvedMember;
  cwd: string;
  prompt: string;
  findingsPath: string;
  runId: string;
  slug: string;
  attemptId: string;
  generation: number;
  continuation?: SwarmSessionContinuation;
  settings: SwarmSettings;
  abortController: AbortController;
  onText?: (text: string) => void;
  onActivity?: () => void;
  onToolUse?: (tool: string) => void;
  onUsage?: (usage: SwarmLiveUsage) => void;
  onStopping?: (reason: 'timeout-idle' | 'timeout-hard') => void;
  writeFindings?: (content: string) => Promise<void>;
  uploadFindings?: (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck>;
}
export interface SwarmLiveUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface SwarmAttemptResult extends AgentExecutionResult {
  continuation?: { mode: SwarmContinuationMode; reason: string | null };
  repoGraphMounted?: boolean;
}
export class SwarmCapabilityError extends Error {
  readonly code = 'unsupported-capability';
}
export class SwarmSessionLostError extends Error {
  readonly code = 'session-lost';
}
const CLAUDE_FAMILY: ReadonlySet<string> = new Set(['cloud', 'zai', 'minimax-tp']);
type SwarmUpload = (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck>;
interface CodexSwarmSession {
  session: CodexSession | null;
  bridge: ReturnType<typeof createSwarmWorkerBridge>;
  upload: { current: SwarmUpload | null };
  generation: number;
  ownerId: string;
}
const codexSessions = new Map<string, CodexSwarmSession>();
const sessionKeyOf = (runId: string, slug: string) => `${runId}/${slug}`;
const liveCodexSession = (entry: CodexSwarmSession | undefined): CodexSession | null =>
  entry?.session && !(entry.session.isClosed?.() ?? false) ? entry.session : null;
function openCodexSession(
  key: string,
  scope: SwarmCodexScope,
  repoGraph: SwarmRepoGraphBinding | null = null,
): CodexSwarmSession {
  const upload: CodexSwarmSession['upload'] = { current: null };
  const ownerId = swarmCodexOwnerId(scope);
  const entry: CodexSwarmSession = {
    session: null,
    bridge: createSwarmWorkerBridge((operation) => {
      if (!upload.current) throw new Error('Tentativa encerrada: upload de achados recusado.');
      return upload.current(operation);
    }, repoGraph),
    upload,
    generation: scope.generation,
    ownerId,
  };
  protectSwarmCodexScope(ownerId);
  codexSessions.set(key, entry);
  return entry;
}
async function disposeCodexSession(entry: CodexSwarmSession): Promise<void> {
  entry.upload.current = null;
  entry.bridge.dispose();
  releaseSwarmCodexScope(entry.ownerId);
  const session = entry.session;
  entry.session = null;
  if (!session) return;
  if (session.closeConfirmed) await session.closeConfirmed();
  else session.close();
}
export async function closeSwarmSession(runId: string, slug: string): Promise<void> {
  const key = sessionKeyOf(runId, slug);
  const entry = codexSessions.get(key);
  if (!entry) return;
  codexSessions.delete(key);
  await disposeCodexSession(entry);
}
export function pinSwarmSession(runId: string, slug: string, pinned: boolean): void {
  const entry = codexSessions.get(sessionKeyOf(runId, slug));
  if (entry) pinSwarmCodexScope(entry.ownerId, pinned);
}
export function hasSwarmCodexSession(runId: string, slug: string): boolean {
  return liveCodexSession(codexSessions.get(sessionKeyOf(runId, slug))) !== null;
}
function validateCapability(
  agent: AgentConfig,
  tools: string[],
): asserts agent is AgentConfig & { runtime: SwarmRuntime } {
  if (agent.runtime === 'codex' && !agent.codexConfig) throw new SwarmCapabilityError('codexConfig obrigatoria');
  if (agent.runtime === 'local' && !agent.localConfig) throw new SwarmCapabilityError('localConfig obrigatoria');
  if (agent.runtime === 'external' && !agent.externalConfig)
    throw new SwarmCapabilityError('externalConfig obrigatoria');
  if (
    (agent.runtime === 'local' || agent.runtime === 'external') &&
    tools.some((t) => t === 'WebSearch' || t === 'WebFetch')
  )
    throw new SwarmCapabilityError('Busca/leitura web nao implementada neste dispatcher');
  const webRole = agent.allowedTools.some((tool) => tool === 'WebSearch' || tool === 'WebFetch');
  const essential = webRole ? ['WebSearch', 'WebFetch'] : ['Read', 'Glob', 'Grep'];
  if (essential.some((tool) => !tools.includes(tool)))
    throw new SwarmCapabilityError(
      `Ferramentas essenciais indisponiveis: ${essential.filter((tool) => !tools.includes(tool)).join(', ')}`,
    );
  if (webRole && !['cloud', 'zai', 'minimax-tp'].includes(agent.runtime))
    throw new SwarmCapabilityError('Busca/leitura web sem dispatcher seguro neste runtime');
  if (agent.externalConfig?.extraHeaders && Object.keys(agent.externalConfig.extraHeaders).length)
    throw new SwarmCapabilityError('Perfil Swarm requer autenticacao por referencia Vault, sem extraHeaders');
}
const SWARM_SEED_ID_SET: ReadonlySet<string> = new Set(SWARM_AGENT_IDS);
export function swarmRepoGraphRequestedFor(agentId: string, mcpServers: readonly string[]): boolean {
  return repoGraphMarkEnabled(mcpServers, SWARM_SEED_ID_SET.has(agentId));
}
export async function resolveSwarmMember(member: SwarmMember, cwd: string): Promise<SwarmResolvedMember> {
  let agent: AgentConfig;
  let config: AgentQueryConfig;
  let repoGraphRequested = true;
  if (member.kind === 'registered') {
    const record = getAgent(member.agentId);
    if (!record?.isActive || record.squad !== 'swarm')
      throw new SwarmCapabilityError('Agente Swarm ativo nao encontrado');
    agent = pruneStaleRuntimeConfigs(structuredClone(record));
    config = await resolveAgentQueryConfig(record.id);
    const marked = splitSwarmMcpServers(agent.mcpServers ?? []);
    if (marked.ignored.length)
      logger.warn(
        { agentId: agent.id, ignored: marked.ignored },
        'MCPs marcados no agente fora do catalogo permitido ao swarm; ignorados (so repo-graph de leitura)',
      );
    repoGraphRequested = swarmRepoGraphRequestedFor(agent.id, marked.allowed);
  } else {
    const profile = member.providerProfileId;
    const providerRecord = profile?.startsWith('agent:') ? getAgent(profile.slice(6)) : undefined;
    const provider = providerRecord ? pruneStaleRuntimeConfigs(providerRecord) : undefined;
    if (profile && !provider && profile !== `settings:${member.runtime}`)
      throw new SwarmCapabilityError('provider-profile-required: perfil inexistente');
    if (provider && (!provider.isActive || provider.runtime !== member.runtime))
      throw new SwarmCapabilityError('Perfil de provider incompativel');
    if (!provider && ['local', 'external', 'codex'].includes(member.runtime))
      throw new SwarmCapabilityError('provider-profile-required: selecione agent:<id>');
    const systemPrompt = ephemeralSystemPrompt(member.rolePrompt);
    agent = {
      id: `swarm-ephemeral-${randomUUID()}`,
      name: 'Persona Swarm',
      description: '',
      systemPrompt,
      runtime: member.runtime,
      model: member.model,
      allowedTools: [...member.allowedTools],
      mcpServers: [],
      skills: [],
      squad: 'swarm',
      isActive: true,
      sortOrder: 0,
      effort: provider?.effort ?? 'high',
      thinking: provider?.thinking ?? 'adaptive',
      ...(provider?.localConfig ? { localConfig: { ...provider.localConfig, model: member.model } } : {}),
      ...(provider?.externalConfig ? { externalConfig: { ...provider.externalConfig, model: member.model } } : {}),
      ...(provider?.codexConfig ? { codexConfig: { ...provider.codexConfig, model: member.model } } : {}),
      maxTurns: provider?.maxTurns,
      maxToolRounds: provider?.maxToolRounds,
    };
    config = {
      model: agent.model,
      runtime: agent.runtime,
      systemPrompt,
      allowedTools: agent.allowedTools,
      mcpServers: [],
      maxTurns: agent.maxTurns,
      effort: agent.effort,
      thinking: agent.thinking,
      thinkingBudget: agent.thinkingBudget,
    };
  }
  const enabled = new Set(getEnabledTools());
  config = {
    ...config,
    allowedTools: swarmEffectiveTools(swarmCatalogTools(config.allowedTools, enabled)),
    mcpServers: [],
  };
  validateCapability(agent, config.allowedTools);
  const repoGraph = repoGraphRequested ? await findSwarmRepoGraphBinding(cwd) : null;
  const repoGraphState = swarmRepoGraphState(repoGraphRequested, repoGraph);
  if (repoGraph) config = { ...config, allowedTools: mergeRepoGraphAllowlist(config.allowedTools) };
  agent = {
    ...agent,
    model: swarmEffectiveModel(agent),
    allowedTools: [...config.allowedTools],
    mcpServers: repoGraphRequested ? [REPO_GRAPH_MCP_SERVER_ID] : [],
    skills: [],
  };
  config = { ...config, model: agent.model };
  try {
    await assertSwarmBackendAvailable(agent);
  } catch (error) {
    throw new SwarmCapabilityError(error instanceof Error ? error.message : String(error));
  }
  const snapshot = JSON.parse(JSON.stringify({ agent, config, repoGraph, repoGraphState })) as Record<string, unknown>;
  return {
    runtime: agent.runtime as SwarmRuntime,
    model: agent.model,
    snapshot,
    agent,
    config,
    repoGraph,
    repoGraphState,
  };
}
export async function getSwarmCatalog(): Promise<SwarmCatalog> {
  const agents = getAllAgents()
    .filter((a) => a.isActive)
    .map(pruneStaleRuntimeConfigs);
  const status = async (a: AgentConfig): Promise<{ available: boolean; reason?: string }> => {
    try {
      validateCapability(a, swarmEffectiveTools(swarmCatalogTools(a.allowedTools, new Set(getEnabledTools()))));
      await assertSwarmBackendAvailable(a);
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const members = await Promise.all(
    agents
      .filter((a) => a.squad === 'swarm')
      .map(async (a) => ({
        agentId: a.id,
        name: a.name,
        description: a.description,
        runtime: a.runtime as SwarmRuntime,
        model: swarmEffectiveModel(a),
        generic: isSwarmGenericRole(a.id),
        ...(await status(a)),
      })),
  );
  return {
    members: members.sort((a, b) => Number(b.generic) - Number(a.generic)),
    profiles: await Promise.all(
      agents.map(async (a) => ({
        id: `agent:${a.id}`,
        runtime: a.runtime as SwarmRuntime,
        model: swarmEffectiveModel(a),
        ...(await status(a)),
      })),
    ),
    runtimes: listSwarmRuntimeCapabilities(),
  };
}
export const SWARM_CODEX_CONFIG_OVERRIDES: readonly string[] = [
  'web_search="disabled"',
  'features.browser_use=false',
  'features.in_app_browser=false',
  'features.computer_use=false',
];
export interface SwarmExecutionRequestInput {
  resolved: SwarmResolvedMember;
  cwd: string;
  prompt: string;
  findingsPath: string;
  runId: string;
  slug: string;
  generation: number;
  settings: SwarmSettings;
  abortController: AbortController;
  writeFindings: (content: string) => Promise<void>;
  codexBridge?: { extraArgs?: string[]; spawnEnv?: Record<string, string> } | null;
  repoGraphMcp?: McpServerEntry | null;
  repoGraphInvoke?: SwarmRepoGraphInvoke | null;
  sessionOptions?: Partial<AgentExecutionRequest>;
  onText?: (text: string) => void;
  onActivity?: () => void;
  onThinking?: () => void;
  onToolUse?: (tool: string) => void;
  onToolUseComplete?: () => void;
  onUsage?: (usage: SwarmLiveUsage) => void;
  onStopping?: (reason: 'timeout-idle' | 'timeout-hard') => void;
}
export function swarmFindingsDeliveryInstruction(runtime: SwarmRuntime, findingsPath: string): string {
  if (runtime === 'codex')
    return 'Entrega pelo MCP swarm-worker: use swarm_write_findings operation begin/chunk/finalize. Cada chunk UTF-8 ate 32768 bytes; seq inicia 0. Use sha256 e nextSeq retornados pelo host para finalize. Nao use Write nem shell para salvar findings.';
  const tool = runtime === 'cursor' ? 'lion_write' : runtime === 'grok' ? 'write_file' : 'Write';
  const refusal =
    runtime === 'grok'
      ? ' Se o runtime recusar a escrita, o host ja gravou o conteudo enviado; nao repita, prossiga para o trailer.'
      : '';
  return `Entrega: use ${tool} com file_path ${JSON.stringify(findingsPath)}. O host grava o conteudo; se a tool informar operacao concluida pelo host, prossiga para o trailer sem repetir.${refusal}`;
}
export function buildSwarmExecutionRequest(input: SwarmExecutionRequestInput): AgentExecutionRequest {
  const runtime = input.resolved.runtime;
  const findingsPath = path.resolve(input.findingsPath);
  const binding = input.resolved.repoGraph ?? null;
  const repoGraphInvoke =
    input.repoGraphInvoke !== undefined ? input.repoGraphInvoke : binding ? createSwarmRepoGraphInvoke(binding) : null;
  const dispatch = createSwarmToolDispatch({
    cwd: input.cwd,
    findingsPath,
    allowedTools: input.resolved.config.allowedTools,
    signal: input.abortController.signal,
    writeFindings: input.writeFindings,
    repoGraph: repoGraphInvoke,
  });
  const configOverride: AgentQueryConfig = {
    ...input.resolved.config,
    mcpServers: CLAUDE_FAMILY.has(runtime) && input.repoGraphMcp ? [input.repoGraphMcp] : [],
  };
  const runDirectory = path.resolve(path.dirname(input.findingsPath), '../../..');
  const expand = (value: string): string =>
    value.replace(/\{\{(RUN_DIR|SLUG|FINDINGS_PATH)\}\}/g, (_token, key: string) =>
      key === 'RUN_DIR' ? runDirectory : key === 'SLUG' ? input.slug : input.findingsPath,
    );
  const scope = { runId: input.runId, slug: input.slug, generation: input.generation };
  return {
    agentId: input.resolved.agent.id,
    executionAgent: { ...input.resolved.agent, systemPrompt: expand(input.resolved.agent.systemPrompt) },
    resolvedConfigOverride: { ...configOverride, systemPrompt: expand(configOverride.systemPrompt) },
    swarmOwnerDirectory: path.dirname(input.findingsPath),
    cwd: input.cwd,
    prompt: `${expand(input.prompt)}\n\n${swarmFindingsDeliveryInstruction(runtime, input.findingsPath)}`,
    abortController: input.abortController,
    permission: createSwarmPermission({
      cwd: input.cwd,
      findingsPath,
      allowedTools: input.resolved.config.allowedTools,
      signal: input.abortController.signal,
      dispatch,
    }),
    swarmToolDispatch: dispatch,
    swarmLifecycle: {
      idleTimeoutMs: input.settings.idleTimeoutMs,
      hardTimeoutMs: input.settings.hardTimeoutMs,
      onTimeout: (reason) => input.onStopping?.(reason),
    },
    onText: input.onText,
    onActivity: input.onActivity,
    onThinking: input.onThinking,
    onToolUse: input.onToolUse,
    onToolUseComplete: input.onToolUseComplete,
    onUsage: input.onUsage,
    ...(runtime === 'codex'
      ? {
          swarmFindingsMcpArgs: input.codexBridge?.extraArgs,
          swarmFindingsMcpEnv: input.codexBridge?.spawnEnv,
          codexConfigOverrides: [...SWARM_CODEX_CONFIG_OVERRIDES],
          sessionScope: scope,
        }
      : runtime === 'cursor'
        ? { sessionScope: scope }
        : {}),
    ...input.sessionOptions,
  };
}
export async function executeSwarmAttempt(req: SwarmAttemptExecution): Promise<SwarmAttemptResult> {
  req.abortController.signal.throwIfAborted();
  validateCapability(req.resolved.agent, req.resolved.config.allowedTools);
  if (!req.writeFindings) throw new SwarmCapabilityError('Host writer obrigatorio');
  const runtime = req.resolved.runtime;
  const key = sessionKeyOf(req.runId, req.slug);
  let codex: CodexSwarmSession | null = null;
  let resume = false;
  const sessionOf = (continuation: SwarmSessionContinuation | undefined) =>
    continuation && continuation.session.generation === req.generation ? continuation.session : null;
  const session = sessionOf(req.continuation);
  const scope: SwarmCodexScope = { runId: req.runId, slug: req.slug, generation: req.generation };
  if (runtime === 'codex') {
    if (!req.uploadFindings) throw new SwarmCapabilityError('Codex requer uploadFindings');
    const existing = codexSessions.get(key);
    if (existing && session && liveCodexSession(existing) && existing.generation === session.generation) {
      codex = existing;
      resume = true;
    } else {
      if (existing) {
        codexSessions.delete(key);
        await disposeCodexSession(existing);
      }
      codex = openCodexSession(key, scope, req.resolved.repoGraph ?? null);
    }
    codex.upload.current = req.uploadFindings;
  } else resume = session !== null;
  const repoGraphMounts: Array<{ dispose: () => void }> = [];
  const mountRepoGraph = async (): Promise<McpServerEntry | null> => {
    const binding = req.resolved.repoGraph ?? null;
    if (!binding || !CLAUDE_FAMILY.has(runtime)) return null;
    const mount = await mountSwarmRepoGraphMcp(binding);
    if (!mount) return null;
    repoGraphMounts.push(mount);
    return mount.entry;
  };
  let repoGraphMounted = false;
  const closeTurn = (): void => {
    if (!codex) return;
    codex.upload.current = null;
    codex.bridge.setRepoGraphActive(false);
  };
  req.abortController.signal.addEventListener('abort', closeTurn, { once: true });
  let streamed = false;
  const seen =
    <T extends unknown[]>(cb?: (...args: T) => void) =>
    (...args: T): void => {
      streamed = true;
      cb?.(...args);
    };
  const execute = async (prompt: string, continueSession: boolean): Promise<AgentExecutionResult> => {
    const repoGraphMcp = await mountRepoGraph();
    if (codex) codex.bridge.setRepoGraphActive(true);
    repoGraphMounted = codex
      ? codex.bridge.repoGraphMounted
      : CLAUDE_FAMILY.has(runtime)
        ? repoGraphMcp !== null
        : (req.resolved.repoGraph ?? null) !== null;
    const sessionOptions: Partial<AgentExecutionRequest> = codex
      ? {
          ...(continueSession && codex.session ? { codexSession: codex.session } : {}),
          onCodexSessionCreated: (created) => {
            if (codex) codex.session = created;
          },
        }
      : CLAUDE_FAMILY.has(runtime) && continueSession && session
        ? { resumeSessionId: session.id }
        : runtime === 'cursor' && continueSession
          ? { continueSession: true }
          : {};
    return executeAgent(
      buildSwarmExecutionRequest({
        resolved: req.resolved,
        cwd: req.cwd,
        prompt,
        findingsPath: req.findingsPath,
        runId: req.runId,
        slug: req.slug,
        generation: req.generation,
        settings: req.settings,
        abortController: req.abortController,
        writeFindings: req.writeFindings!,
        codexBridge: codex?.bridge ?? null,
        repoGraphMcp,
        sessionOptions,
        onText: seen(req.onText),
        onActivity: seen(req.onActivity),
        onThinking: seen(() => req.onActivity?.()),
        onToolUse: seen((tool: string) => {
          req.onActivity?.();
          req.onToolUse?.(tool);
        }),
        onToolUseComplete: seen(() => req.onActivity?.()),
        onUsage: req.onUsage,
        onStopping: req.onStopping,
      }),
    );
  };
  const withSession = (result: AgentExecutionResult): SwarmAttemptResult => {
    if (!codex) return { ...result, repoGraphMounted };
    const id = liveCodexSession(codex)?.threadId;
    if (!id) {
      const { sessionIds: _ignored, ...metadata } = result.metadata ?? {};
      return { ...result, metadata, repoGraphMounted };
    }
    return { ...result, metadata: { ...result.metadata, sessionIds: [id] }, repoGraphMounted };
  };
  const replay = async (continuation: SwarmSessionContinuation, reason: string): Promise<SwarmAttemptResult> => {
    if (!continuation.fallbackPrompt)
      throw new SwarmSessionLostError(`${reason}. Reenvio impossivel: o historico obrigatorio excede o contexto.`);
    req.abortController.signal.throwIfAborted();
    const result = await execute(continuation.fallbackPrompt, false);
    return { ...withSession(result), continuation: { mode: 'replay', reason } };
  };
  try {
    if (!req.continuation) return withSession(await execute(req.prompt, false));
    if (!resume)
      return await replay(
        req.continuation,
        session
          ? `Sessao ${session.id} nao esta mais viva no runtime ${runtime}`
          : `Sessao de outra geracao (${req.continuation.session.generation}) nao e retomada na geracao ${req.generation}`,
      );
    try {
      const result = await execute(req.prompt, true);
      if (result.error && !streamed)
        throw Object.assign(new Error(result.error.userMessage), { code: result.error.code });
      return { ...withSession(result), continuation: { mode: 'session', reason: null } };
    } catch (error) {
      if (streamed || req.abortController.signal.aborted) throw error;
      const reason = refusalReason(runtime, error);
      if (codex) {
        codexSessions.delete(key);
        await disposeCodexSession(codex);
        codex = openCodexSession(key, scope, req.resolved.repoGraph ?? null);
        codex.upload.current = req.uploadFindings ?? null;
      }
      return await replay(req.continuation, reason);
    }
  } catch (error) {
    if (codex) {
      const entry = codex;
      codex = null;
      if (codexSessions.get(key) === entry) codexSessions.delete(key);
      await disposeCodexSession(entry).catch(() => undefined);
    }
    throw error;
  } finally {
    req.abortController.signal.removeEventListener('abort', closeTurn);
    closeTurn();
    for (const mount of repoGraphMounts.splice(0)) mount.dispose();
  }
}
const REFUSAL_DETAIL_CAP = 200;
export function refusalReason(runtime: string, error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const name = error instanceof Error && error.name && error.name !== 'Error' ? `${error.name}: ` : '';
  const detail = `${name}${message}`.slice(0, REFUSAL_DETAIL_CAP);
  if (/no conversation found|session.*not found|thread.*not found|unknown thread/i.test(message))
    return `Sessao inexistente no runtime ${runtime} (${detail})`;
  return `Falha antes do primeiro evento do runtime ${runtime} (${detail})`;
}

export async function recoverSwarmAttempt(input: {
  runId: string;
  slug: string;
  attemptId: string;
  runtime: SwarmRuntime;
}): Promise<boolean> {
  if (input.runtime === 'local' || input.runtime === 'external') return true;
  if (
    !/^swarm-\d{8}_\d{6}-[a-f0-9]{6}$/.test(input.runId) ||
    !/^[a-z0-9-]{1,80}$/.test(input.slug) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.attemptId)
  )
    return false;
  const directory = path.join(
    getLionClawHome(),
    'artifacts',
    'swarm',
    input.runId,
    '_attempts',
    input.slug,
    input.attemptId,
  );
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  for (const name of names.filter((n) => /^\.owner-[a-f0-9-]+\.json$/.test(n))) {
    if (!(await recoverSwarmProcessMarker(path.join(directory, name)))) return false;
  }
  return true;
}
