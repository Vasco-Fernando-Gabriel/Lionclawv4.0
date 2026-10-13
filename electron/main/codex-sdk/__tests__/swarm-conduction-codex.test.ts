import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatFeatureToggles } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MOCK_SERVERS = [
  { id: 'google-drive', description: 'Drive do usuario', isActive: true },
  { id: 'lionclaw-pipeline-control', description: 'Controle de pipelines', isActive: true },
  { id: 'lionclaw-swarm', description: 'LionClaw Swarm', isActive: true },
];

vi.mock('../../db', () => ({
  getAllMCPServers: () => MOCK_SERVERS,
  getPermissionBypass: () => false,
  getSetting: vi.fn((key: string) => (key === 'mcp_prompt_mode' ? 'full' : undefined)),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp/codex-swarm',
}));

vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: () => 'LION-PROMPT',
  loadGeneratedAgentContext: () => 'PERSONA',
}));

vi.mock('../../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
}));

vi.mock('../../mcp-path-resolver', () => ({
  resolveMcpServerRuntime: () => ({ command: '/node', entryPath: '/swarm.js', env: {}, candidates: [] }),
}));

interface CapturedRun {
  mcpProfile: string;
  disableGlobalMcp?: boolean;
  extraArgs?: string[];
  swarmFindingsMcpArgs?: string[];
  swarmFindingsMcpEnv?: Record<string, string>;
  sessionOptions: { systemPrompt: string; sandbox?: string };
}
const capturedRuns: CapturedRun[] = [];
const sessionMocks = vi.hoisted(() => ({ close: vi.fn(), closeConfirmed: vi.fn(async () => {}) }));
vi.mock('../../agent-runtime/codex-session-factory', async () => {
  const actual = await vi.importActual<typeof import('../../agent-runtime/codex-session-factory')>(
    '../../agent-runtime/codex-session-factory',
  );
  return {
    ...actual,
    resolveCodexSessionForRun: vi.fn(async (args: CapturedRun) => {
      capturedRuns.push(args);
      return {
        threadId: null,
        send: vi.fn(),
        reply: vi.fn(),
        close: sessionMocks.close,
        closeConfirmed: sessionMocks.closeConfirmed,
      };
    }),
  };
});

import { createChatCodexSession } from '../session';
import { validateSwarmMcpSpawn, SWARM_MCP_ARG_PREFIXES } from '../../agent-runtime/codex-session-factory';
import { resolveHelperTokenOwner, __resetHelperIdentityForTests } from '../../helper-identity';

const CHIP_ON: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false, swarm: true };
const CHIP_OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false, swarm: false };

beforeEach(() => {
  vi.clearAllMocks();
  capturedRuns.length = 0;
  __resetHelperIdentityForTests();
});

describe('Swarm v2 S2-V2: turno de conducao com orquestrador em Codex', () => {
  it('chip ligado + turno de entrega: sessao one-shot isolada recebe SO o MCP lionclaw-swarm com binding de sessao e token no env', async () => {
    await createChatCodexSession({
      sessionId: 'sess-codex',
      model: 'gpt-5.5',
      capabilities: CHIP_ON,
      swarmReadOnly: true,
    });
    const run = capturedRuns.at(-1)!;
    expect(run.mcpProfile).toBe('one-shot');
    expect(run.disableGlobalMcp).toBe(true);
    expect(run.sessionOptions.sandbox).toBe('read-only');
    expect(run.extraArgs).toBeUndefined();
    expect(run.swarmFindingsMcpArgs).toHaveLength(2);
    expect(run.swarmFindingsMcpArgs![0]).toBe('-c');
    const toml = run.swarmFindingsMcpArgs![1];
    expect(toml.startsWith('mcp_servers.lionclaw-swarm=')).toBe(true);
    expect(toml).toContain('"command"="/node"');
    expect(toml).toContain('"args"=["/swarm.js"]');
    expect(toml).toContain('"LIONCLAW_MCP_LANE"="desktop"');
    expect(toml).toContain('"LIONCLAW_MCP_SESSION_ID"="sess-codex"');
    expect(toml).toContain('"env_vars"=["LIONCLAW_HELPER_TOKEN"]');
    expect(toml).not.toContain('google-drive');
    const token = run.swarmFindingsMcpEnv?.LIONCLAW_HELPER_TOKEN;
    expect(typeof token).toBe('string');
    expect(toml).not.toContain(token!);
    expect(resolveHelperTokenOwner(token!)).toBe('lionclaw-swarm');
    expect(Object.keys(run.swarmFindingsMcpEnv!)).toEqual(['LIONCLAW_HELPER_TOKEN']);
    expect(run.sessionOptions.systemPrompt).toContain('lionclaw-swarm');
    expect(run.sessionOptions.systemPrompt).not.toContain('google-drive');
    expect(run.sessionOptions.systemPrompt).not.toContain('lionclaw-pipeline-control');
  });
  it('chip desligado no turno de entrega: sessao isolada continua sem nenhum MCP (trava), e o turno normal segue com a composicao do chat', async () => {
    await createChatCodexSession({
      sessionId: 'sess-codex',
      model: 'gpt-5.5',
      capabilities: CHIP_OFF,
      swarmReadOnly: true,
    });
    const locked = capturedRuns.at(-1)!;
    expect(locked.mcpProfile).toBe('one-shot');
    expect(locked.disableGlobalMcp).toBe(true);
    expect(locked.swarmFindingsMcpArgs).toBeUndefined();
    expect(locked.swarmFindingsMcpEnv).toBeUndefined();
    expect(locked.sessionOptions.systemPrompt).not.toContain('lionclaw-swarm');
    await createChatCodexSession({ sessionId: 'sess-codex', model: 'gpt-5.5', capabilities: CHIP_ON });
    const normal = capturedRuns.at(-1)!;
    expect(normal.mcpProfile).toBe('chat');
    expect(normal.disableGlobalMcp).toBeFalsy();
    expect(normal.swarmFindingsMcpArgs).toBeUndefined();
    expect(normal.sessionOptions.systemPrompt).toContain('google-drive');
  });
  it('S2-R2: o token de helper do turno de conducao e revogado quando a sessao Codex fecha (close e closeConfirmed), nunca antes', async () => {
    const session = await createChatCodexSession({
      sessionId: 'sess-codex',
      model: 'gpt-5.5',
      capabilities: CHIP_ON,
      swarmReadOnly: true,
    });
    const token = capturedRuns.at(-1)!.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN;
    expect(resolveHelperTokenOwner(token)).toBe('lionclaw-swarm');
    session.close();
    expect(sessionMocks.close).toHaveBeenCalledTimes(1);
    expect(resolveHelperTokenOwner(token)).toBeNull();
    session.close();
    expect(sessionMocks.close).toHaveBeenCalledTimes(2);
    const confirmed = await createChatCodexSession({
      sessionId: 'sess-codex',
      model: 'gpt-5.5',
      capabilities: CHIP_ON,
      swarmReadOnly: true,
    });
    const second = capturedRuns.at(-1)!.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN;
    expect(second).not.toBe(token);
    expect(resolveHelperTokenOwner(second)).toBe('lionclaw-swarm');
    await confirmed.closeConfirmed!();
    expect(sessionMocks.closeConfirmed).toHaveBeenCalledTimes(1);
    expect(resolveHelperTokenOwner(second)).toBeNull();
    const normal = await createChatCodexSession({ sessionId: 'sess-codex', model: 'gpt-5.5', capabilities: CHIP_ON });
    expect(capturedRuns.at(-1)!.swarmFindingsMcpEnv).toBeUndefined();
    normal.close();
    expect(sessionMocks.close).toHaveBeenCalledTimes(3);
  });
  it('a fabrica aceita o MCP do swarm e o do worker so em sessao isolada read-only, e recusa qualquer outro servidor ou env', () => {
    expect(SWARM_MCP_ARG_PREFIXES).toEqual(['mcp_servers.swarm-worker=', 'mcp_servers.lionclaw-swarm=']);
    const ok = validateSwarmMcpSpawn({
      disableGlobalMcp: true,
      sandbox: 'read-only',
      swarmFindingsMcpArgs: ['-c', 'mcp_servers.lionclaw-swarm={"command"="/node"}'],
      swarmFindingsMcpEnv: { LIONCLAW_HELPER_TOKEN: 't' },
    });
    expect(ok).toEqual({
      extraArgs: ['-c', 'mcp_servers.lionclaw-swarm={"command"="/node"}'],
      spawnEnv: { LIONCLAW_HELPER_TOKEN: 't' },
    });
    expect(
      validateSwarmMcpSpawn({
        disableGlobalMcp: true,
        sandbox: 'read-only',
        swarmFindingsMcpArgs: ['-c', 'mcp_servers.swarm-worker={}'],
      }),
    ).toEqual({ extraArgs: ['-c', 'mcp_servers.swarm-worker={}'] });
    expect(validateSwarmMcpSpawn({ disableGlobalMcp: true, sandbox: 'read-only' })).toBeNull();
    expect(() =>
      validateSwarmMcpSpawn({
        disableGlobalMcp: true,
        sandbox: 'read-only',
        swarmFindingsMcpArgs: ['-c', 'mcp_servers.google-drive={}'],
      }),
    ).toThrow(/Invalid isolated Swarm/);
    expect(() =>
      validateSwarmMcpSpawn({
        disableGlobalMcp: true,
        sandbox: 'workspace-write',
        swarmFindingsMcpArgs: ['-c', 'mcp_servers.lionclaw-swarm={}'],
      }),
    ).toThrow(/Invalid isolated Swarm/);
    expect(() =>
      validateSwarmMcpSpawn({
        disableGlobalMcp: false,
        sandbox: 'read-only',
        swarmFindingsMcpArgs: ['-c', 'mcp_servers.lionclaw-swarm={}'],
      }),
    ).toThrow(/Invalid isolated Swarm/);
    expect(() =>
      validateSwarmMcpSpawn({
        disableGlobalMcp: true,
        sandbox: 'read-only',
        swarmFindingsMcpArgs: ['-c', 'mcp_servers.lionclaw-swarm={}'],
        swarmFindingsMcpEnv: { LIONCLAW_HELPER_TOKEN: 't', PATH: '/x' },
      }),
    ).toThrow(/Invalid Swarm MCP environment/);
  });
});
