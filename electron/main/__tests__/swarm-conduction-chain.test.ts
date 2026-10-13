import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryCalls: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  inTurn: [] as Array<Record<string, unknown>>,
  swarmStart: vi.fn(async () => ({ runId: 'swarm-20260101_000100-def456', status: 'queued' })),
  questionDelivered: vi.fn(async () => true),
  pending: [] as Array<Record<string, unknown>>,
  toggles: { pipelineControl: false, dynamicWorkflows: false, swarm: true },
  claimed: [] as string[],
  completed: [] as unknown[],
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    h.queryCalls.push(args);
    const iter = (async function* () {
      for (const step of h.inTurn)
        await (step.run as (options: Record<string, unknown>) => Promise<void>)(args.options);
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: 'ok',
        session_id: 'sdk-session',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    })();
    return Object.assign(iter, { toggleMcpServer: vi.fn(async () => undefined) });
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn((id: string) =>
    id === 'origin' ? { id, status: 'active', orchestrator: { runtime: 'claude-sdk' } } : null,
  ),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getHarnessProject: vi.fn(() => undefined),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  listHarnessProjects: vi.fn(() => []),
  listHarnessProjectsBySession: vi.fn(() => []),
  findEngagedDriveBySession: vi.fn(() => null),
  getDriveState: vi.fn(() => null),
  getDriveSessionId: vi.fn(() => null),
  isDriveEngaged: vi.fn(() => false),
  getOpenLaneSessionById: vi.fn((id: string) => (id ? { id, laneBadge: 1, title: id } : null)),
  setDriveState: vi.fn(),
  getDynamicWorkflowRun: vi.fn(() => null),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  updateDynamicWorkflowRun: vi.fn(),
  getDb: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }),
    transaction:
      (fn: (...a: unknown[]) => unknown) =>
      (...a: unknown[]) =>
        fn(...a),
  }),
  upsertActivityLog: vi.fn(),
  getChatFeatureToggles: vi.fn(() => h.toggles),
  getPendingSwarmDeliveries: vi.fn(() => h.pending),
  claimSwarmDelivery: vi.fn((runId: string, kind: string, revision: number, claimId: string) => {
    const row = h.pending.find((p) => p.runId === runId && p.kind === kind && p.revision === revision);
    if (!row || h.claimed.includes(`${runId}/${kind}/${revision}`)) return undefined;
    h.claimed.push(`${runId}/${kind}/${revision}`);
    return { ...row, claimId, state: 'claimed' };
  }),
  completeSwarmDelivery: vi.fn((...args: unknown[]) => {
    h.completed.push(args);
    return true;
  }),
  recoverSwarmDeliveryClaims: vi.fn(() => 0),
  releaseSwarmDelivery: vi.fn(() => true),
  getSwarmDelivery: vi.fn(() => undefined),
  persistSwarmChatMessageOnce: vi.fn(() => ({ messageId: 1, inserted: true })),
}));
vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'chave-de-teste'),
  getApiKey: vi.fn(async () => 'chave-de-teste'),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
  deriveToolDetail: vi.fn(() => ''),
}));
vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(
    async (_agentId?: string, opts?: { capabilities?: { swarm?: boolean }; fullCatalog?: boolean }) => {
      const swarm = opts?.capabilities === undefined ? opts?.fullCatalog === true : opts.capabilities.swarm === true;
      return {
        ...(swarm
          ? {
              'lionclaw-swarm': {
                command: 'node',
                args: ['swarm.js'],
                env: { LIONCLAW_HELPER_TOKEN: 'token-de-teste' },
              },
            }
          : {}),
        'google-drive': { command: 'node', args: ['drive.js'] },
      };
    },
  ),
}));
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => ''),
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../agent-config-resolver', () => ({
  REPO_GRAPH_READER_TOOLS: [
    'repo_graph_status',
    'repo_graph_search',
    'repo_graph_minimal_context',
    'repo_graph_impact',
    'repo_graph_node',
    'repo_graph_callers',
    'repo_graph_callees',
  ].map((t) => `mcp__repo-graph__${t}`),
  resolveAgentQueryConfig: vi.fn(async () => ({ allowedTools: [], systemPrompt: '', mcpServers: [], maxTurns: 0 })),
  mergeRepoGraphAllowlist: (tools: string[]) => tools,
  buildRepoGraphMcpSpec: () => ({}),
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [], getCachedSDKMcpServers: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getCronCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({ pathToClaudeCodeExecutable: '/tmp/claude-cli.js', executable: 'node' }),
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
  setRepoGraphTurnSession: vi.fn(),
  clearRepoGraphTurnSession: vi.fn(),
  setRepoGraphTurnContext: vi.fn(),
}));
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
  buildRepoGraphSection: () => '',
  buildRepoGraphSubagentSection: () => '',
  summarizeRepoGraphStats: () => '',
}));
vi.mock('../sdk-session-id', () => ({
  makeScopedSdkSessionId: (scope: string, sessionId: string) => `${scope}:${sessionId}`,
}));
vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async () => ({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'model-a',
      source: 'settings',
    })),
  };
});
vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
  buildCompatEnv: vi.fn(() => ({})),
}));
vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));
vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: vi.fn(async () => undefined),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));
vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));
vi.mock('../chat-push', () => ({ pushAssistantMessage: vi.fn(() => 1), pushDrivePaused: vi.fn() }));
vi.mock('../telegram-bridge', () => ({ notifyDriveHandoff: vi.fn(async () => {}) }));
vi.mock('../pipeline-control-core', async () => {
  const actual = await vi.importActual<typeof import('../pipeline-control-core')>('../pipeline-control-core');
  return { ...actual, resolvePendingQuestion: vi.fn(() => null) };
});
vi.mock('../swarm/chat-persistence', () => ({
  canBeginSwarmTurn: vi.fn(() => true),
  persistSwarmResponse: vi.fn(() => true),
  releaseSwarmTurn: vi.fn(),
  flushSwarmTurnReleases: vi.fn(),
}));
vi.mock('../pipeline-shared/chat-persist', () => ({ persistSwarmChatMessage: vi.fn() }));
vi.mock('../swarm/index', () => ({
  getSwarmService: () => ({
    start: h.swarmStart,
    questionPending: vi.fn(() => true),
    questionDelivered: h.questionDelivered,
    failWaiting: vi.fn(async () => true),
  }),
}));

import { startSwarmDeliveryPump, SWARM_QUESTION_CHIP_OFF_INSTRUCTION } from '../swarm/delivery';
import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { clearDesktopQueuesForTests, listDesktopLanes } from '../desktop-lanes';
import {
  __resetChatCapabilityContextForTests,
  getChatCapabilityTurn,
  listActiveDesktopTurns,
  type ChatCapabilityTurnContext,
} from '../chat-capability-context';
import { SWARM_MCP_SERVER_ID } from '../swarm/aggregation-policy';
import { canBeginSwarmTurn } from '../swarm/chat-persistence';

type CanUseTool = (
  name: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; toolUseID: string; requestId: string },
) => Promise<{ behavior: string }>;

const helper: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: SWARM_MCP_SERVER_ID, connectionId: 'chain' },
};
const terminal = {
  runId: 'swarm-20260101_000000-abc123',
  kind: 'terminal',
  revision: 3,
  slug: null,
  attemptId: null,
  sessionId: 'origin',
  envelope: 'SWARM RUN swarm-20260101_000000-abc123',
  runStatus: 'open',
  state: 'pending',
};
const question = {
  ...terminal,
  kind: 'question',
  revision: 4,
  slug: 'auditor',
  attemptId: 'attempt-1-abcd',
  envelope: 'SWARM QUESTION swarm-20260101_000000-abc123',
  runStatus: 'running',
};
let stop: (() => void) | undefined;
async function waitTurnDone(): Promise<void> {
  await vi.waitFor(() => expect(h.queryCalls.length).toBeGreaterThan(0), { timeout: 5_000 });
  await vi.waitFor(() => expect(listDesktopLanes().some((lane) => lane.queue.isProcessing)).toBe(false), {
    timeout: 5_000,
  });
}
function gateCall(method: string, params: Record<string, unknown>) {
  const active = listActiveDesktopTurns()[0];
  expect(active).toBeDefined();
  return dispatch(helper, {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { sessionId: active.sessionId, turnId: active.turnId, lane: 'desktop', ...params },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.queryCalls.length = 0;
  h.inTurn.length = 0;
  h.pending.length = 0;
  h.claimed.length = 0;
  h.completed.length = 0;
  h.toggles = { pipelineControl: false, dynamicWorkflows: false, swarm: true };
  clearDesktopQueuesForTests();
  __resetChatCapabilityContextForTests();
});
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('GA-7 (AC-19/AC-28): entrega -> turno de conducao -> SDK com o MCP do swarm -> gate -> swarm_start da etapa 2', () => {
  it('familia Claude: a entrega terminal sobe o SDK so com o MCP lionclaw-swarm, o guard libera swarm_start e nega Write, e o gate aceita a etapa 2 com o chip ligado', async () => {
    h.pending.push(terminal);
    const seen: Record<string, unknown> = {};
    h.inTurn.push({
      run: async (options: Record<string, unknown>) => {
        const canUseTool = options.canUseTool as CanUseTool;
        const ctx = { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' };
        seen.start = (
          await canUseTool(`mcp__${SWARM_MCP_SERVER_ID}__swarm_start`, { requestId: 'etapa-2' }, ctx)
        ).behavior;
        seen.write = (await canUseTool('Write', { file_path: '/tmp/x' }, ctx)).behavior;
        seen.bash = (await canUseTool('Bash', { command: 'ls' }, ctx)).behavior;
        seen.edit = (await canUseTool('Edit', { file_path: '/tmp/x' }, ctx)).behavior;
        const active = listActiveDesktopTurns()[0];
        seen.turn = getChatCapabilityTurn(active) as ChatCapabilityTurnContext;
        seen.gate = (
          await gateCall('swarm_start', {
            requestId: 'etapa-2',
            cwd: '/tmp',
            objective: 'Validar os achados da etapa 1',
            mode: 'comite',
            target: 'alvo.ts',
            parentRunId: terminal.runId,
            stage: 'validacao',
            members: [],
          })
        ).result;
        seen.read = (await gateCall('swarm_read', { runId: terminal.runId, slug: 'auditor' })).result;
      },
    });
    stop = startSwarmDeliveryPump(() => null);
    await waitTurnDone();

    expect(h.queryCalls).toHaveLength(1);
    const options = h.queryCalls[0].options;
    expect(String(h.queryCalls[0].prompt)).toContain('<swarm-results>');
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual([SWARM_MCP_SERVER_ID]);
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.allowedTools).toEqual([]);
    expect(seen).toMatchObject({ start: 'allow', write: 'deny', bash: 'deny', edit: 'deny' });
    const turn = seen.turn as ChatCapabilityTurnContext;
    expect(turn).toMatchObject({ sessionId: 'origin', origin: 'system-event', capabilities: { swarm: true } });
    expect(seen.gate).toEqual({ runId: 'swarm-20260101_000100-def456', status: 'queued' });
    expect(h.swarmStart).toHaveBeenCalledTimes(1);
    expect(h.swarmStart).toHaveBeenCalledWith(
      { sessionId: 'origin', swarmEnabled: true, readRoots: expect.any(Array) },
      expect.objectContaining({ requestId: 'etapa-2', parentRunId: terminal.runId, stage: 'validacao' }),
    );
    expect(canBeginSwarmTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'origin',
        swarmDelivery: expect.objectContaining({ runId: terminal.runId, kind: 'terminal', revision: 3 }),
      }),
    );
    expect(h.questionDelivered).not.toHaveBeenCalled();
  });
  it('chip desligado: a pergunta chega num turno sem o MCP do swarm, com a instrucao "ligue o chip e responda"; swarm_start e recusado no gate e o idle da pergunta comeca na entrega (GA-5)', async () => {
    h.toggles = { pipelineControl: false, dynamicWorkflows: false, swarm: false };
    h.pending.push(question);
    const seen: Record<string, unknown> = {};
    h.inTurn.push({
      run: async () => {
        seen.gate = (await gateCall('swarm_start', { requestId: 'etapa-2', mode: 'comite' })).result;
        seen.message = (
          await gateCall('swarm_message', { runId: question.runId, slug: 'auditor', message: 'resposta' })
        ).result;
      },
    });
    stop = startSwarmDeliveryPump(() => null);
    await waitTurnDone();
    expect(h.queryCalls).toHaveLength(1);
    const { prompt, options } = h.queryCalls[0];
    expect(String(prompt)).toContain(SWARM_QUESTION_CHIP_OFF_INSTRUCTION);
    expect(String(prompt)).toContain('ligue o chip Swarm e responda');
    expect(options.mcpServers).toEqual({});
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(seen.gate).toMatchObject({ code: 'chat_capability_swarm_disabled' });
    expect(seen.message).toMatchObject({ code: 'chat_capability_swarm_disabled' });
    expect(h.swarmStart).not.toHaveBeenCalled();
    expect(h.questionDelivered).toHaveBeenCalledWith(question.runId, 'auditor', 'attempt-1-abcd');
    expect(h.completed).toEqual([]);
  });
});
