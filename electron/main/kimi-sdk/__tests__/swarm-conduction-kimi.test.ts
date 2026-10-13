import { beforeEach, describe, it, expect, vi } from 'vitest';
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
vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
}));
vi.mock('../../db', () => ({
  getEnabledTools: vi.fn(() => []),
}));
vi.mock('../../agent-runtime/kimi-availability', () => ({
  isKimiAvailable: vi.fn(async () => ({ installed: true, authenticated: true, authMode: 'subscription' })),
  resolveKimiBinary: vi.fn().mockResolvedValue('/usr/local/bin/kimi'),
  KimiUnavailableError: class KimiUnavailableError extends Error {},
  KimiAuthError: class KimiAuthError extends Error {},
}));
const toolState = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('../../agent-runtime/kimi-session-config', () => ({
  buildKimiSessionTools: vi.fn(async () => ({
    externalTools: toolState.names.map((name) => ({
      name,
      description: name,
      parameters: {},
      handler: async () => ({ output: 'ok' }),
    })),
    systemPrompt: 'RECONCILED PROMPT',
  })),
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
const CATALOG = [
  'lion_run_subagent',
  'mcp_invoke',
  'mcp_schema',
  'mcp__lionclaw-swarm__swarm_wait',
  'mcp__lionclaw-swarm__swarm_message',
  'mcp__google-drive__list_files',
  'mcp__lionclaw-pipeline-control__pipeline_drive',
];

beforeEach(() => {
  vi.clearAllMocks();
  bridgeState.calls.length = 0;
  driverState.lastRunOptions = undefined;
  toolState.names = [...CATALOG];
});

describe('Swarm v2 S2-V2: turno de conducao com orquestrador em Kimi', () => {
  it('turno de entrega (swarmReadOnly) sobe a bridge ACP SO com as tools mcp__lionclaw-swarm__*', async () => {
    await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission: PERMISSION,
      swarmReadOnly: true,
      capabilities: { pipelineControl: false, dynamicWorkflows: false, swarm: true },
    });
    expect(bridgeState.calls).toEqual([['mcp__lionclaw-swarm__swarm_wait', 'mcp__lionclaw-swarm__swarm_message']]);
    const opts = driverState.lastRunOptions as { mcpServers?: unknown[]; profile: string };
    expect(opts.profile).toBe('chat');
    expect(opts.mcpServers).toEqual([{ name: 'lionbridge', url: 'http://127.0.0.1:1' }]);
  });
  it('turno de entrega sem tools do swarm no catalogo (chip desligado) fica sem bridge, como antes', async () => {
    toolState.names = CATALOG.filter((name) => !name.startsWith('mcp__lionclaw-swarm__'));
    await createChatKimiSession({
      sessionId: 'sess-kimi',
      model: 'kimi-code/kimi-for-coding',
      permission: PERMISSION,
      swarmReadOnly: true,
      capabilities: { pipelineControl: false, dynamicWorkflows: false, swarm: false },
    });
    expect(bridgeState.calls).toEqual([]);
    expect((driverState.lastRunOptions as { mcpServers?: unknown[] }).mcpServers).toEqual([]);
  });
  it('turno normal continua com o catalogo inteiro na bridge', async () => {
    await createChatKimiSession({ sessionId: 'sess-kimi', model: 'kimi-code/kimi-for-coding', permission: PERMISSION });
    expect(bridgeState.calls).toEqual([CATALOG]);
  });
});
