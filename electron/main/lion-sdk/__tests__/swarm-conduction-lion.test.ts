import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';

const settings = new Map<string, string>();

vi.mock('../../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getAllAgents: vi.fn(() => []),
  getSession: vi.fn(() => ({ id: 'sid', title: 't', type: 'chat' })),
  getSessionMessages: vi.fn(() => []),
  insertMessage: vi.fn(() => 1),
  getTurnIndexForUserMessage: vi.fn(() => 7),
  getLatestUserTurnIndex: vi.fn(() => 0),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => false),
  getSetting: vi.fn((key: string) => settings.get(key) ?? ''),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../pricing', () => ({ calculateCost: vi.fn(() => 0.5) }));

const CONFIG: Record<string, { command: string; args: string[] }> = {
  'google-drive': { command: 'node', args: ['drive.js'] },
  'lionclaw-swarm': { command: 'node', args: ['swarm.js'] },
};
const MOCK_SERVERS = [
  { id: 'google-drive', name: 'Google Drive', description: 'Drive', isActive: true, indexMode: 'tools' as const },
  { id: 'lionclaw-swarm', name: 'LionClaw Swarm', description: 'Swarm', isActive: true, indexMode: 'tools' as const },
];
const REGISTRY = [
  {
    mcpId: 'google-drive',
    toolName: 'list_files',
    description: 'List files',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-swarm',
    toolName: 'swarm_wait',
    description: 'Espera a run',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
];
const getMCPConfigForAgent = vi.fn(async () => CONFIG);
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: () => getMCPConfigForAgent(),
  getMcpToolRegistryEntries: (mcpId?: string) => (mcpId ? REGISTRY.filter((e) => e.mcpId === mcpId) : REGISTRY),
  getMCPToolsFromRegistry: (ids: string[]) =>
    REGISTRY.filter((e) => ids.includes(e.mcpId)).map((e) => `mcp__${e.mcpId}__${e.toolName}`),
  discoverAndSaveMCPTools: vi.fn(async () => []),
  getAllMCPServers: () => MOCK_SERVERS,
}));
const EAGER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp__lionclaw-swarm__swarm_wait',
      description: 'Espera a run',
      parameters: { type: 'object', properties: { runId: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__google-drive__list_files',
      description: 'List files',
      parameters: { type: 'object', properties: {} },
    },
  },
];
const setupMCPsForSession = vi.fn(async (config: Record<string, unknown>) => ({
  client: { connections: Object.keys(config).map((serverId) => ({ serverId })) },
  tools: EAGER_TOOLS.filter((t) => Object.keys(config).some((id) => t.function.name.startsWith(`mcp__${id}__`))),
}));
const callMCPTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"status":"done"}' }] }));
vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: (config: Record<string, unknown>) => setupMCPsForSession(config),
  teardownMCPsForSession: vi.fn(async () => {}),
  callMCPTool: (...a: unknown[]) => callMCPTool(...(a as [])),
}));
vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => vi.fn(async () => ({ behavior: 'allow' }))),
}));
vi.mock('../../skills', () => ({ listSkills: vi.fn(() => []) }));
vi.mock('../../title-generator', () => ({ ensureInitialSessionTitle: vi.fn() }));
vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../../onboarding', () => ({
  completeOnboardingFromConversationMessages: vi.fn(),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'SYS'),
  buildPipelineControlSection: vi.fn(() => 'PIPE'),
  buildPipelineControlStub: vi.fn(() => 'PIPE-STUB'),
  getSubagentsPromptMode: vi.fn(() => 'index'),
}));
vi.mock('../../prompt-builder-repo-graph', () => ({ getRepoGraphPromptSection: vi.fn(() => '') }));
vi.mock('../runtime-context', () => ({ buildLionRuntimeContextPrompt: vi.fn(() => 'RUNTIME-CONTEXT') }));
vi.mock('../adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(() => ({ name: 'ollama', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(() => ({ name: 'lmstudio', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(() => ({ name: 'openai-compatible', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(() => ({ name: 'google-genai', streamCompletion: vi.fn() })),
}));
vi.mock('../title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));
vi.mock('../compaction', () => ({
  compactIfNeeded: vi.fn(async () => ({ messages: [{ role: 'user', content: 'oi' }], compacted: false })),
}));
vi.mock('../../swarm/chat-persistence', () => ({
  persistSwarmResponse: vi.fn(() => true),
  releaseSwarmTurn: vi.fn(),
  canBeginSwarmTurn: vi.fn(() => true),
}));

interface CapturedLoopOpts {
  initialMessages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string }>;
  dispatcher: (call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }) => Promise<{ content: string; isError?: boolean }>;
}
let captured: CapturedLoopOpts | null = null;
vi.mock('../runtime', () => ({
  MAX_TOOL_TURNS: 5,
  runLionLoop: vi.fn(async (opts: CapturedLoopOpts) => {
    captured = opts;
    return { finalText: 'resposta lion', ok: true, usage: { inputTokens: 1, outputTokens: 1 } };
  }),
}));

import { executeLionSdkQuery } from '../index';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../../chat-capability-context';

const OLLAMA: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'ollama',
  model: 'qwen3:32b',
  baseUrl: 'http://localhost:11434',
  source: 'settings',
};
const DELIVERY = { runId: 'swarm-20260101_000000-abc123', kind: 'terminal' as const, revision: 3, claimId: 'c' };

async function runTurn(options: Record<string, unknown>): Promise<CapturedLoopOpts> {
  captured = null;
  await executeLionSdkQuery('oi', { sessionId: 'sid', ...options }, () => null, undefined, OLLAMA);
  if (!captured) throw new Error('runLionLoop nao foi chamado');
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.clear();
  settings.set('onboarding_completed', 'true');
  settings.set('mcp_prompt_mode', 'full');
  __resetChatCapabilityContextForTests();
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: 'sid',
    turnId: 'turn-1',
    origin: 'system-event',
    capabilities: { pipelineControl: false, dynamicWorkflows: false, swarm: true },
  });
  setActiveChatTurn({ sessionId: 'sid', lane: 'desktop', turnId: 'turn-1' });
});

describe('Swarm v2 S2-V2: turno de conducao com orquestrador em lion-sdk (local/external)', () => {
  it('turno de entrega conecta SO o MCP lionclaw-swarm, expoe Read/Grep/Glob + mcp_call e nega o resto', async () => {
    const opts = await runTurn({ swarmDelivery: DELIVERY });
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    expect(Object.keys(setupMCPsForSession.mock.calls[0][0])).toEqual(['lionclaw-swarm']);
    expect(opts.tools.map((t) => t.name).sort()).toEqual(['Glob', 'Grep', 'Read', 'mcp_call']);
    expect(opts.initialMessages[0].content).toContain('lionclaw-swarm');
    expect(opts.initialMessages[0].content).not.toContain('google-drive');
    const swarm = await opts.dispatcher({
      id: '1',
      name: 'mcp_call',
      input: { server_id: 'lionclaw-swarm', tool: 'swarm_wait', args: { runId: 'r' } },
    });
    expect(swarm.isError).toBeFalsy();
    expect(callMCPTool).toHaveBeenCalledTimes(1);
    const drive = await opts.dispatcher({
      id: '2',
      name: 'mcp_call',
      input: { server_id: 'google-drive', tool: 'list_files', args: {} },
    });
    expect(drive).toMatchObject({ isError: true, content: expect.stringContaining('tools do swarm') });
    const write = await opts.dispatcher({ id: '3', name: 'Write', input: { file_path: '/x', content: 'y' } });
    expect(write).toMatchObject({ isError: true });
    const bash = await opts.dispatcher({ id: '4', name: 'Bash', input: { command: 'rm -rf /' } });
    expect(bash).toMatchObject({ isError: true });
    expect(callMCPTool).toHaveBeenCalledTimes(1);
  });
  it('turno de entrega com o chip desligado (swarm fora da composicao) fica so com Read/Grep/Glob, sem MCP', async () => {
    getMCPConfigForAgent.mockResolvedValueOnce({ 'google-drive': CONFIG['google-drive'] });
    const opts = await runTurn({ swarmDelivery: DELIVERY });
    expect(setupMCPsForSession).not.toHaveBeenCalled();
    expect(opts.tools.map((t) => t.name).sort()).toEqual(['Glob', 'Grep', 'Read']);
    const call = await opts.dispatcher({
      id: '1',
      name: 'mcp_call',
      input: { server_id: 'lionclaw-swarm', tool: 'swarm_wait', args: {} },
    });
    expect(call).toMatchObject({ isError: true });
  });
  it('turno normal mantem a composicao inteira', async () => {
    const opts = await runTurn({});
    expect(Object.keys(setupMCPsForSession.mock.calls[0][0]).sort()).toEqual(['google-drive', 'lionclaw-swarm']);
    expect(opts.tools.map((t) => t.name)).toContain('Write');
  });
});
