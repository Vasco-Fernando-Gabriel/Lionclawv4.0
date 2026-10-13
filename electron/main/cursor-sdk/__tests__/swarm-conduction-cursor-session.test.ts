import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChatFeatureToggles } from '../../../../src/types';

const tempState = vi.hoisted(() => ({ home: '' }));
const catalogState = vi.hoisted(() => ({
  registry: [] as Array<{
    mcpId: string;
    toolName: string;
    description: string | null;
    inputSchema: string | null;
    lastDiscoveredAt: string;
  }>,
  configCalls: [] as Array<ChatFeatureToggles | undefined>,
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../paths', () => ({ getLionClawHome: () => tempState.home }));
vi.mock('../../db', () => ({
  getEnabledTools: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getSessionActiveRepository: vi.fn(() => null),
  getLocalRepository: vi.fn(() => null),
}));
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'LION PROMPT'),
  loadGeneratedAgentContext: vi.fn(() => ''),
}));
vi.mock('../../prompt-builder-repo-graph', () => ({ appendRepoGraphSection: (prompt: string) => prompt }));
vi.mock('../../secrets-vault', () => ({ getSecret: vi.fn(async () => 'cursor-key-123') }));
vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))),
}));
vi.mock('../../agent-runtime/subagent-dispatch', () => ({
  createSubagentDispatchContext: vi.fn((args: Record<string, unknown>) => ({
    ...args,
    rootExecutionId: 'root',
    depth: 0,
  })),
  pendingSubagentProviderAuthError: vi.fn(() => null),
  resolveSubagentHostAllowedTools: vi.fn(async () => []),
}));
vi.mock('../../agent-runtime/chat-effort-inheritance', () => ({ resolveChatInheritedEffort: vi.fn(() => undefined) }));
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async (_agentId?: string, opts?: { capabilities?: ChatFeatureToggles }) => {
    catalogState.configCalls.push(opts?.capabilities);
    const config: Record<string, { command: string; args: string[] }> = {
      'google-drive': { command: 'node', args: ['drive.js'] },
    };
    if (opts?.capabilities?.swarm) config['lionclaw-swarm'] = { command: 'node', args: ['swarm.js'] };
    return config;
  }),
  getMcpToolRegistryEntries: (mcpId?: string) =>
    mcpId ? catalogState.registry.filter((e) => e.mcpId === mcpId) : catalogState.registry,
}));
const sidecarState = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown>> }));
vi.mock('../../agent-runtime/cursor-sidecar/sidecar-manager', () => ({
  runCursorSidecarExecution: vi.fn(async (opts: { config: Record<string, unknown> }) => {
    sidecarState.configs.push(opts.config);
    return { status: 'finished', finalText: 'ok', agentId: 'agent-abc' };
  }),
}));

import { createChatCursorSession } from '../session';
import { SwarmConductionMountError } from '../../swarm/conduction-mcp';

const SCHEMA = JSON.stringify({ type: 'object', properties: {} });
const REGISTRY = [
  { mcpId: 'google-drive', toolName: 'list_files', description: 'Lista', inputSchema: SCHEMA, lastDiscoveredAt: '' },
  { mcpId: 'lionclaw-swarm', toolName: 'swarm_wait', description: 'Espera', inputSchema: SCHEMA, lastDiscoveredAt: '' },
  { mcpId: 'lionclaw-swarm', toolName: 'swarm_message', description: 'Msg', inputSchema: SCHEMA, lastDiscoveredAt: '' },
];

function options(chip: boolean, kind?: 'terminal' | 'question') {
  return {
    sessionId: 'sess-cursor',
    model: 'composer-2.5',
    getWindow: () => null,
    abortController: new AbortController(),
    lane: 'desktop' as const,
    capabilities: { pipelineControl: false, dynamicWorkflows: false, swarm: chip },
    ...(kind ? { swarmDelivery: { kind } } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sidecarState.configs.length = 0;
  catalogState.configCalls.length = 0;
  catalogState.registry = [...REGISTRY];
  tempState.home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-swarm-conduction-'));
});
afterEach(() => {
  fs.rmSync(tempState.home, { recursive: true, force: true });
});

describe('Swarm v2 S4 (D8, S4-V1/S4-V4): turno de conducao em Cursor com o catalogo REAL do sidecar (buildCursorSessionTools) e transporte mockado', () => {
  it('chip ligado: lionclaw-swarm entra no catalogo, a sessao guardada sobe com mcp_invoke/mcp_schema e marca as tools montadas', async () => {
    const session = await createChatCursorSession(options(true, 'terminal'));
    expect(catalogState.configCalls).toContainEqual(expect.objectContaining({ swarm: true }));
    expect(session.swarmConductionMounted).toBe(true);
    await session.send('consolide', () => {});
    const config = sidecarState.configs[0]!;
    expect(config.guarded).toBe(true);
    const names = (config.customTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['mcp_invoke', 'mcp_schema', 'lion_read']));
    expect(names).not.toContain('lion_shell');
  });

  it('chip desligado na entrega terminal: o catalogo filtra o servidor, a sessao sobe mesmo assim e so consolida', async () => {
    const session = await createChatCursorSession(options(false, 'terminal'));
    expect(catalogState.configCalls).toContainEqual(expect.objectContaining({ swarm: false }));
    expect(session.swarmConductionMounted).toBe(false);
    await session.send('consolide', () => {});
    expect(sidecarState.configs).toHaveLength(1);
  });

  it('chip desligado na pergunta: SwarmConductionMountError (caminho fail-closed da S2)', async () => {
    await expect(createChatCursorSession(options(false, 'question'))).rejects.toBeInstanceOf(SwarmConductionMountError);
    await expect(createChatCursorSession(options(false, 'question'))).rejects.toThrow(/fora do catalogo do turno/);
    expect(sidecarState.configs).toHaveLength(0);
  });

  it('chip ligado mas registro sem tools do swarm: pergunta recusada com "sem tools registradas"; terminal consolida sem as tools', async () => {
    catalogState.registry = REGISTRY.filter((e) => e.mcpId !== 'lionclaw-swarm');
    await expect(createChatCursorSession(options(true, 'question'))).rejects.toThrow(/sem tools registradas/);
    const session = await createChatCursorSession(options(true, 'terminal'));
    expect(session.swarmConductionMounted).toBe(false);
  });

  it('turno normal nunca exige o MCP do swarm', async () => {
    const session = await createChatCursorSession(options(false));
    expect(session.swarmConductionMounted).toBe(false);
    await session.send('ola', () => {});
    expect(sidecarState.configs).toHaveLength(1);
  });
});
