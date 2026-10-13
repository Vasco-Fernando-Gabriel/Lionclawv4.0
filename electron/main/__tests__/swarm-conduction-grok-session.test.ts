import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFeatureToggles } from '../../../src/types';

const state = vi.hoisted(() => ({
  createRun: vi.fn(),
  bridgeTools: [] as Array<{ name: string }>,
  registry: [] as Array<{
    mcpId: string;
    toolName: string;
    description: string | null;
    inputSchema: string | null;
    lastDiscoveredAt: string;
  }>,
  configCalls: [] as Array<ChatFeatureToggles | undefined>,
}));

vi.mock('../db', () => ({
  getEnabledTools: () => ['Read'],
  getSetting: () => '3',
}));
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => 'Prompt Lion',
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async (_agentId?: string, opts?: { capabilities?: ChatFeatureToggles }) => {
    state.configCalls.push(opts?.capabilities);
    const config: Record<string, { command: string; args: string[] }> = {
      'google-drive': { command: 'node', args: ['drive.js'] },
    };
    if (opts?.capabilities?.swarm) config['lionclaw-swarm'] = { command: 'node', args: ['swarm.js'] };
    return config;
  }),
  getMcpToolRegistryEntries: (mcpId?: string) =>
    mcpId ? state.registry.filter((e) => e.mcpId === mcpId) : state.registry,
}));
vi.mock('../agent-runtime/context-measure', () => ({ estimateTokensRough: () => 1 }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../grok-acp/acp-driver', () => ({
  getGrokAcpDriver: () => ({ createRun: state.createRun }),
}));
vi.mock('../grok-acp/mcp-http-bridge', () => ({
  startGrokMcpBridge: vi.fn(async ({ tools }: { tools: Array<{ name: string }> }) => {
    state.bridgeTools = tools;
    return {
      url: 'http://127.0.0.1/mcp',
      token: 'token',
      bridgeId: 'bridge',
      mcpServerEntry: { id: 'bridge', name: 'bridge', type: 'http', url: 'http://127.0.0.1/mcp', headers: [], env: [] },
      stop: vi.fn(async () => undefined),
    };
  }),
}));
vi.mock('../agent-runtime/subagent-dispatch', () => ({
  createSubagentDispatchContext: () => ({ ownerKind: 'chat', rootExecutionId: 'root', depth: 0 }),
  pendingSubagentProviderAuthError: () => null,
  resolveSubagentHostAllowedTools: async (allowedTools: string[]) => allowedTools,
}));
vi.mock('../agent-runtime/chat-effort-inheritance', () => ({
  resolveChatInheritedEffort: () => ({ grok: 'high' }),
}));
vi.mock('../agent-runtime/grok-concurrency', () => ({
  acquireGrokSlot: vi.fn(async () => vi.fn()),
  configureGrokConcurrency: vi.fn(),
}));
vi.mock('../agent-runtime/grok-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-runtime/grok-availability')>();
  return {
    ...actual,
    buildGrokChildEnv: () => ({ GROK_HOME: '/tmp/grok-home', HOME: '/tmp/grok-home' }),
    isGrokAvailable: vi.fn(async () => ({ usable: true })),
    prepareGrokWorkspace: vi.fn(async () => undefined),
    resolveGrokBinary: vi.fn(async () => '/fake/grok'),
    resolveGrokHome: () => '/tmp/grok-home',
  };
});
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' as const })),
}));
vi.mock('../agent-runtime/permission-profiles', () => ({
  PERM_DEFAULT_WITH_GUARD: (canUseTool: unknown) => ({
    mode: 'default',
    dangerouslySkipPermissions: false,
    canUseTool,
  }),
}));
vi.mock('../grok-sdk/workspace', () => ({
  acquireGrokSandboxSpawnLock: vi.fn(async () => vi.fn()),
  assertGrokWorkspaceUnchanged: vi.fn(),
  attestGrokSession: vi.fn(),
  ensureGrokSandboxProfile: () => 'workspace',
  grokInputTouchesProtectedSource: () => false,
  inspectGrokWorkspace: vi.fn(async () => undefined),
  snapshotGrokSandboxAttestation: vi.fn(() => ({})),
  waitForGrokSandboxApplied: vi.fn(async () => undefined),
}));

import { createChatGrokSession } from '../grok-sdk/session';
import { SwarmConductionMountError } from '../swarm/conduction-mcp';

const GRANT = {
  processCwd: '/tmp/grok',
  sessionCwd: '/tmp/grok',
  readRoots: ['/tmp/grok'],
  writeRoots: ['/tmp/grok'],
  source: 'desktop-repository' as const,
  projectSources: [],
};
const SCHEMA = JSON.stringify({ type: 'object', properties: {} });
const REGISTRY = [
  { mcpId: 'google-drive', toolName: 'list_files', description: 'Lista', inputSchema: SCHEMA, lastDiscoveredAt: '' },
  { mcpId: 'lionclaw-swarm', toolName: 'swarm_wait', description: 'Espera', inputSchema: SCHEMA, lastDiscoveredAt: '' },
  { mcpId: 'lionclaw-swarm', toolName: 'swarm_message', description: 'Msg', inputSchema: SCHEMA, lastDiscoveredAt: '' },
];

function options(chip: boolean, kind?: 'terminal' | 'question') {
  return {
    sessionId: 'sess-grok',
    model: 'grok-4.6',
    effort: 'high' as const,
    getWindow: () => null,
    abortSignal: new AbortController().signal,
    lane: 'desktop' as const,
    capabilities: { pipelineControl: false, dynamicWorkflows: false, swarm: chip },
    workspaceGrant: GRANT,
    ...(kind ? { swarmDelivery: { kind } } : {}),
  };
}

describe('Swarm v2 S4 (D8, S4-V1/S4-V4): turno de conducao em Grok com o catalogo gerenciado REAL (buildGrokSessionTools) e transporte mockado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.bridgeTools = [];
    state.configCalls.length = 0;
    state.registry = [...REGISTRY];
    state.createRun.mockResolvedValue({
      send: vi.fn(),
      reply: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(async () => undefined),
      forceKillFallback: vi.fn(),
    });
  });

  it('chip ligado: lionclaw-swarm entra no catalogo do turno, a bridge sobe com mcp_invoke/mcp_schema e a sessao marca as tools montadas', async () => {
    const session = await createChatGrokSession(options(true, 'terminal'));
    expect(state.configCalls).toContainEqual(expect.objectContaining({ swarm: true }));
    expect(state.bridgeTools.map((tool) => tool.name)).toEqual([
      'lion_run_subagent',
      'lion_ask_user_question',
      'mcp_invoke',
      'mcp_schema',
    ]);
    expect(session.swarmConductionMounted).toBe(true);
    const run = state.createRun.mock.calls[0]![0] as { profile: string; mcpServers: unknown[] };
    expect(run.profile).toBe('chat');
    expect(run.mcpServers).toHaveLength(1);
    await session.close();
  });

  it('chip desligado na entrega terminal: o catalogo filtra o servidor, a sessao sobe mesmo assim e so consolida (tools do swarm ausentes)', async () => {
    const session = await createChatGrokSession(options(false, 'terminal'));
    expect(state.configCalls).toContainEqual(expect.objectContaining({ swarm: false }));
    expect(session.swarmConductionMounted).toBe(false);
    expect(state.createRun).toHaveBeenCalledOnce();
    await session.close();
  });

  it('chip desligado na pergunta: sem as tools do swarm a resposta nao pode ser dada; SwarmConductionMountError (caminho fail-closed da S2)', async () => {
    await expect(createChatGrokSession(options(false, 'question'))).rejects.toBeInstanceOf(SwarmConductionMountError);
    await expect(createChatGrokSession(options(false, 'question'))).rejects.toThrow(/fora do catalogo do turno/);
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it('chip ligado mas registro sem tools do swarm: pergunta recusada com "sem tools registradas"; terminal consolida sem as tools', async () => {
    state.registry = REGISTRY.filter((e) => e.mcpId !== 'lionclaw-swarm');
    await expect(createChatGrokSession(options(true, 'question'))).rejects.toThrow(/sem tools registradas/);
    const session = await createChatGrokSession(options(true, 'terminal'));
    expect(session.swarmConductionMounted).toBe(false);
    await session.close();
  });

  it('chip ligado na pergunta: sessao sobe com as tools montadas', async () => {
    const session = await createChatGrokSession(options(true, 'question'));
    expect(session.swarmConductionMounted).toBe(true);
    await session.close();
  });

  it('turno normal nunca exige o MCP do swarm', async () => {
    const session = await createChatGrokSession(options(false));
    expect(session.swarmConductionMounted).toBe(false);
    expect(state.createRun).toHaveBeenCalledOnce();
    await session.close();
  });
});
