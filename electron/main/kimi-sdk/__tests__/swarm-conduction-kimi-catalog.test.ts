import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChatFeatureToggles } from '../../../../src/types';
import type { CliRunHandle, CliRunOptions } from '../../agent-runtime/cli-agentic/contract';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../agent-runtime/kimi-concurrency', () => ({
  acquireKimiSlot: vi.fn(async () => vi.fn()),
}));
vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp/agent-cwd',
  getLionClawHome: () => '/tmp/lion-home',
}));
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: () => 'SYSTEM PROMPT',
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../../db', () => ({
  getEnabledTools: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
}));
vi.mock('../../agent-runtime/kimi-availability', () => ({
  isKimiAvailable: vi.fn(async () => ({ installed: true, authenticated: true, authMode: 'subscription' })),
  resolveKimiBinary: vi.fn().mockResolvedValue('/usr/local/bin/kimi'),
  KimiUnavailableError: class KimiUnavailableError extends Error {},
  KimiAuthError: class KimiAuthError extends Error {},
}));
vi.mock('@moonshot-ai/kimi-agent-sdk', () => ({
  createExternalTool: (def: { name: string; description: string }) => ({
    name: def.name,
    description: def.description,
    parameters: {},
  }),
}));
const REGISTRY = [
  {
    mcpId: 'google-drive',
    toolName: 'list_files',
    description: 'Lista arquivos',
    inputSchema: null,
    lastDiscoveredAt: '',
  },
  {
    mcpId: 'lionclaw-swarm',
    toolName: 'swarm_wait',
    description: 'Espera a run',
    inputSchema: null,
    lastDiscoveredAt: '',
  },
  {
    mcpId: 'lionclaw-swarm',
    toolName: 'swarm_message',
    description: 'Mensagem',
    inputSchema: null,
    lastDiscoveredAt: '',
  },
];
const MOCK_SERVERS = [
  { id: 'google-drive', name: 'Google Drive', description: 'Drive', isActive: true, indexMode: 'tools' as const },
  { id: 'lionclaw-swarm', name: 'LionClaw Swarm', description: 'Swarm', isActive: true, indexMode: 'tools' as const },
];
const configCalls = vi.hoisted(() => ({ capabilities: [] as Array<ChatFeatureToggles | undefined> }));
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async (_agentId?: string, opts?: { capabilities?: ChatFeatureToggles }) => {
    configCalls.capabilities.push(opts?.capabilities);
    const config: Record<string, { command: string; args: string[] }> = {
      'google-drive': { command: 'node', args: ['drive.js'] },
    };
    if (opts?.capabilities?.swarm) config['lionclaw-swarm'] = { command: 'node', args: ['swarm.js'] };
    return config;
  }),
  getMCPToolsFromRegistry: (ids: string[]) =>
    REGISTRY.filter((e) => ids.includes(e.mcpId)).map((e) => `mcp__${e.mcpId}__${e.toolName}`),
  getMcpToolRegistryEntries: (mcpId?: string) => (mcpId ? REGISTRY.filter((e) => e.mcpId === mcpId) : REGISTRY),
  getAllMCPServers: () => MOCK_SERVERS,
}));
const bridgeState = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../../kimi-acp/mcp-http-bridge', () => ({
  startKimiMcpBridge: vi.fn(async (config: { tools: Array<{ name: string }> }) => {
    bridgeState.calls.push(config.tools.map((t) => t.name));
    return { mcpServerEntry: { name: 'lionbridge', url: 'http://127.0.0.1:1' }, stop: vi.fn(async () => {}) };
  }),
}));
const driverState = vi.hoisted(() => ({ lastRunOptions: undefined as unknown }));
vi.mock('../../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: () => ({
    createRun: async (opts: CliRunOptions): Promise<CliRunHandle> => {
      driverState.lastRunOptions = opts;
      return {
        send: vi.fn(),
        reply: vi.fn(),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        forceKillFallback: vi.fn().mockResolvedValue(undefined),
      } as unknown as CliRunHandle;
    },
  }),
}));

import { createChatKimiSession } from '../session';

const PERMISSION = {
  mode: 'default' as const,
  dangerouslySkipPermissions: false,
  canUseTool: vi.fn(async () => ({ behavior: 'allow' as const })),
};
const CHIP_ON: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false, swarm: true };
const CHIP_OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false, swarm: false };

beforeEach(() => {
  vi.clearAllMocks();
  bridgeState.calls.length = 0;
  configCalls.capabilities.length = 0;
  driverState.lastRunOptions = undefined;
});

describe('Swarm v2 S2-R1: catalogo REAL do Kimi no turno de conducao (buildKimiSessionTools sem mock)', () => {
  it('chip ligado + turno de entrega: o catalogo real materializa mcp__lionclaw-swarm__* e a bridge ACP sobe so com elas', async () => {
    await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission: PERMISSION,
      swarmReadOnly: true,
      capabilities: CHIP_ON,
      turnBinding: { sessionId: 'sess-kimi', turnId: 't1' },
    });
    expect(configCalls.capabilities.every((caps) => caps?.swarm === true)).toBe(true);
    expect(bridgeState.calls).toEqual([['mcp__lionclaw-swarm__swarm_wait', 'mcp__lionclaw-swarm__swarm_message']]);
    const opts = driverState.lastRunOptions as { mcpServers?: unknown[]; profile: string };
    expect(opts.profile).toBe('chat');
    expect(opts.mcpServers).toEqual([{ name: 'lionbridge', url: 'http://127.0.0.1:1' }]);
  });
  it('chip desligado: o catalogo real nao traz o swarm (capability filtrada) e o turno de entrega fica sem bridge', async () => {
    await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission: PERMISSION,
      swarmReadOnly: true,
      capabilities: CHIP_OFF,
    });
    expect(configCalls.capabilities.every((caps) => caps?.swarm === false)).toBe(true);
    expect(bridgeState.calls).toEqual([]);
    expect((driverState.lastRunOptions as { mcpServers?: unknown[] }).mcpServers).toEqual([]);
  });
  it('turno normal com chip ligado: a bridge recebe o catalogo real inteiro (subagente, mcp_invoke/mcp_schema e as tools diretas do swarm)', async () => {
    await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission: PERMISSION,
      capabilities: CHIP_ON,
    });
    expect(bridgeState.calls).toHaveLength(1);
    const names = bridgeState.calls[0];
    expect(names).toContain('lion_run_subagent');
    expect(names).toContain('mcp_invoke');
    expect(names).toContain('mcp_schema');
    expect(names).toContain('mcp__lionclaw-swarm__swarm_wait');
    expect(names).toContain('mcp__lionclaw-swarm__swarm_message');
    expect(names).not.toContain('mcp__google-drive__list_files');
  });
});
