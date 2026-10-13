import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../../src/types';
import type { SwarmRuntime } from '../../../../src/types/swarm';
const mocks = vi.hoisted(() => ({
  readers: [
    'repo_graph_status',
    'repo_graph_search',
    'repo_graph_minimal_context',
    'repo_graph_impact',
    'repo_graph_node',
    'repo_graph_callers',
    'repo_graph_callees',
  ].map((t) => `mcp__repo-graph__${t}`),
  agents: new Map<string, AgentConfig>(),
  repos: [] as Array<{ id: string; canonicalRootPath: string; status: string }>,
  execute: vi.fn(),
  mounts: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  bridges: [] as Array<{ repoGraph: unknown; active: boolean[] }>,
  warns: [] as unknown[],
}));
vi.mock('../../db', () => ({
  getAgent: (id: string) => mocks.agents.get(id),
  getAllAgents: () => [...mocks.agents.values()],
  getEnabledTools: () => ['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch'],
  listLocalRepositories: () => mocks.repos,
  getLocalRepository: (id: string) => mocks.repos.find((r) => r.id === id) ?? null,
}));
vi.mock('../../agent-config-resolver', () => ({
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
  REPO_GRAPH_READER_TOOLS: mocks.readers,
  mergeRepoGraphAllowlist: (tools: string[]) => [...new Set([...tools, ...mocks.readers])],
  buildRepoGraphMcpSpec: () => ({ 'repo-graph': { command: '/node', args: ['/repo-graph.js'] } }),
  resolveAgentQueryConfig: async (id: string) => {
    const a = mocks.agents.get(id)!;
    return {
      model: a.model,
      runtime: a.runtime,
      systemPrompt: a.systemPrompt,
      allowedTools: a.allowedTools,
      mcpServers: [],
      maxTurns: 10,
      effort: a.effort,
      thinking: a.thinking,
    };
  },
}));
vi.mock('../swarm-availability', () => ({ assertSwarmBackendAvailable: async () => {} }));
vi.mock('../execute', () => ({ executeAgent: (req: unknown) => mocks.execute(req) }));
vi.mock('../../swarm/worker-bridge', () => ({
  createSwarmWorkerBridge: (_upload: unknown, repoGraph: unknown) => {
    const entry = { repoGraph, active: [] as boolean[] };
    mocks.bridges.push(entry);
    return {
      setRepoGraphActive: (active: boolean) => entry.active.push(active),
      extraArgs: repoGraph
        ? ['-c', 'mcp_servers.swarm-worker={}', '-c', 'mcp_servers.repo-graph={}']
        : ['-c', 'mcp_servers.swarm-worker={}'],
      spawnEnv: { LIONCLAW_HELPER_TOKEN: 'tok' },
      repoGraphMounted: Boolean(repoGraph),
      dispose: () => {},
    };
  },
}));
vi.mock('../../swarm/repo-graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../swarm/repo-graph')>();
  return {
    ...actual,
    mountSwarmRepoGraphMcp: (binding: { repositoryId: string }) => {
      const mount = { dispose: vi.fn() };
      mocks.mounts.push(mount);
      return {
        owner: `swarm-repo-graph-${binding.repositoryId}`,
        entry: { 'repo-graph': { command: '/node', args: ['/repo-graph.js'], env: { LIONCLAW_HELPER_TOKEN: 'tok' } } },
        dispose: mount.dispose,
      };
    },
  };
});
vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => mocks.warns.push(args),
    error: () => {},
  }),
}));
vi.mock('../../paths', () => ({ getLionClawHome: () => '/fixture' }));
import {
  resolveSwarmMember,
  executeSwarmAttempt,
  closeSwarmSession,
  swarmRepoGraphRequestedFor,
} from '../swarm-adapter';
const REPO_GRAPH_TOOLS = mocks.readers;

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-adapter-rg-')));
fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

function makeAgent(id: string, runtime: SwarmRuntime, mcpServers: string[]): AgentConfig {
  return {
    id,
    name: id,
    description: 'role',
    model: 'claude-opus-5-5',
    systemPrompt: '## Papel\nexplorador',
    runtime,
    squad: 'swarm',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
    mcpServers,
    skills: [],
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    ...(runtime === 'codex' ? { codexConfig: { model: 'gpt-6-sol', sandbox: 'danger-full-access' } } : {}),
  };
}
const settings = { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000, openWindowMs: 1000 };

beforeEach(() => {
  mocks.agents.clear();
  mocks.repos = [];
  mocks.execute.mockReset();
  mocks.mounts.length = 0;
  mocks.bridges.length = 0;
  mocks.warns.length = 0;
});

describe('repo-graph por swarm agent: marca no agente x repositorio registrado da run', () => {
  it('seed com repo-graph marcado + run dentro de repositorio ready: tools de leitura entram na allowlist, estado ready, snapshot carrega o binding', async () => {
    mocks.agents.set('swarm-explorer', makeAgent('swarm-explorer', 'cloud', ['repo-graph']));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'ready' }];
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, path.join(cwd, 'src'));
    expect(resolved.repoGraphState).toBe('ready');
    expect(resolved.repoGraph).toEqual({ repositoryId: 'repo-1', rootPath: cwd, status: 'ready' });
    expect(resolved.config.allowedTools).toEqual(expect.arrayContaining(REPO_GRAPH_TOOLS));
    expect(resolved.config.allowedTools.filter((t) => t.startsWith('mcp__'))).toHaveLength(7);
    expect(resolved.config.mcpServers).toEqual([]);
    expect(resolved.agent.mcpServers).toEqual(['repo-graph']);
    expect((resolved.snapshot as { repoGraphState: string }).repoGraphState).toBe('ready');
    expect((resolved.snapshot as { repoGraph: { repositoryId: string } }).repoGraph.repositoryId).toBe('repo-1');
  });
  it('agente do usuario sem a marca, ou seed desmarcado (repo-graph:off): nenhuma tool do repo-graph chega mesmo com repositorio registrado; estado off', async () => {
    mocks.agents.set('meu-swarm', makeAgent('meu-swarm', 'cloud', []));
    mocks.agents.set('swarm-auditor', makeAgent('swarm-auditor', 'cloud', ['repo-graph:off']));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'ready' }];
    const custom = await resolveSwarmMember({ kind: 'registered', agentId: 'meu-swarm' }, cwd);
    expect(custom.repoGraphState).toBe('off');
    expect(custom.config.allowedTools.some((t) => t.startsWith('mcp__'))).toBe(false);
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-auditor' }, cwd);
    expect(resolved.repoGraphState).toBe('off');
    expect(resolved.repoGraph).toBe(null);
    expect(resolved.config.allowedTools.some((t) => t.startsWith('mcp__'))).toBe(false);
    expect(resolved.agent.mcpServers).toEqual([]);
  });
  it('marcado mas run fora de repositorio registrado (ou graph building): sem tools, estado no-repository; outros MCPs marcados sao ignorados com aviso', async () => {
    mocks.agents.set('swarm-explorer', makeAgent('swarm-explorer', 'cloud', ['repo-graph', 'knowledge-base']));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: path.join(cwd, 'outro'), status: 'ready' }];
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, cwd);
    expect(resolved.repoGraphState).toBe('no-repository');
    expect(resolved.repoGraph).toBe(null);
    expect(resolved.config.allowedTools.some((t) => t.startsWith('mcp__'))).toBe(false);
    expect(resolved.agent.mcpServers).toEqual(['repo-graph']);
    expect(JSON.stringify(resolved.snapshot)).not.toContain('knowledge-base');
    expect(mocks.warns.some((args) => JSON.stringify(args).includes('knowledge-base'))).toBe(true);
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'building' }];
    const building = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, cwd);
    expect(building.repoGraphState).toBe('no-repository');
  });
  it('agente efemero recebe o repo-graph por padrao quando ha repositorio', async () => {
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'stale' }];
    const ephemeral = await resolveSwarmMember(
      {
        kind: 'ephemeral',
        runtime: 'cloud',
        model: 'claude-opus-5-5',
        rolePrompt: 'papel',
        allowedTools: ['Read', 'Grep', 'Glob'],
      },
      cwd,
    );
    expect(ephemeral.repoGraphState).toBe('stale');
    expect(ephemeral.config.allowedTools).toEqual(expect.arrayContaining(REPO_GRAPH_TOOLS));
    expect(ephemeral.agent.mcpServers).toEqual(['repo-graph']);
    mocks.repos = [];
    const alone = await resolveSwarmMember(
      {
        kind: 'ephemeral',
        runtime: 'cloud',
        model: 'claude-opus-5-5',
        rolePrompt: 'papel',
        allowedTools: ['Read', 'Grep', 'Glob'],
      },
      cwd,
    );
    expect(alone.repoGraphState).toBe('no-repository');
    expect(alone.config.allowedTools.some((t) => t.startsWith('mcp__'))).toBe(false);
  });
  it('familia Claude: a tentativa sobe o MCP repo-graph no resolvedConfigOverride com token proprio e o derruba ao terminar', async () => {
    mocks.agents.set('swarm-explorer', makeAgent('swarm-explorer', 'cloud', ['repo-graph']));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'ready' }];
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, cwd);
    mocks.execute.mockImplementation(async (req) => {
      expect(req.resolvedConfigOverride.mcpServers).toEqual([
        { 'repo-graph': { command: '/node', args: ['/repo-graph.js'], env: { LIONCLAW_HELPER_TOKEN: 'tok' } } },
      ]);
      expect(req.resolvedConfigOverride.allowedTools).toEqual(expect.arrayContaining(REPO_GRAPH_TOOLS));
      expect(mocks.mounts[0]!.dispose).not.toHaveBeenCalled();
      return { output: 'STATUS: ok', metrics: { apiRequests: 1, toolUses: 0 } };
    });
    await executeSwarmAttempt({
      resolved,
      cwd,
      prompt: 'p',
      findingsPath: path.join(cwd, 'findings.md'),
      runId: 'run',
      slug: 's',
      attemptId: 'a',
      generation: 1,
      settings,
      abortController: new AbortController(),
      writeFindings: async () => {},
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.mounts).toHaveLength(1);
    expect(mocks.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
  });
  it('familia Claude sem repositorio: nenhum MCP sobe e nada e montado', async () => {
    mocks.agents.set('swarm-explorer', makeAgent('swarm-explorer', 'cloud', ['repo-graph']));
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, cwd);
    mocks.execute.mockImplementation(async (req) => {
      expect(req.resolvedConfigOverride.mcpServers).toEqual([]);
      return { output: 'STATUS: ok', metrics: { apiRequests: 1, toolUses: 0 } };
    });
    await executeSwarmAttempt({
      resolved,
      cwd,
      prompt: 'p',
      findingsPath: path.join(cwd, 'findings.md'),
      runId: 'run2',
      slug: 's',
      attemptId: 'a',
      generation: 1,
      settings,
      abortController: new AbortController(),
      writeFindings: async () => {},
    });
    expect(mocks.mounts).toHaveLength(0);
  });
  it('Codex: o worker bridge da sessao recebe o binding do repo-graph e o -c do segundo servidor chega ao executor', async () => {
    mocks.agents.set('swarm-codex', makeAgent('swarm-codex', 'codex', ['repo-graph']));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'ready' }];
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-codex' }, cwd);
    expect(resolved.repoGraphState).toBe('ready');
    mocks.execute.mockImplementation(async (req) => {
      expect(req.swarmFindingsMcpArgs).toEqual([
        '-c',
        'mcp_servers.swarm-worker={}',
        '-c',
        'mcp_servers.repo-graph={}',
      ]);
      expect(req.resolvedConfigOverride.mcpServers).toEqual([]);
      return { output: 'STATUS: ok', metrics: { apiRequests: 1, toolUses: 0 } };
    });
    await executeSwarmAttempt({
      resolved,
      cwd,
      prompt: 'p',
      findingsPath: path.join(cwd, 'findings.md'),
      runId: 'run3',
      slug: 's',
      attemptId: 'a',
      generation: 1,
      settings,
      abortController: new AbortController(),
      writeFindings: async () => {},
      uploadFindings: async () => ({ uploadId: 'u', nextSeq: 0, sha256: '' }),
    });
    expect(mocks.bridges).toHaveLength(1);
    expect(mocks.bridges[0]!.repoGraph).toEqual({ repositoryId: 'repo-1', rootPath: cwd, status: 'ready' });
    expect(mocks.mounts).toHaveLength(0);
    await closeSwarmSession('run3', 's');
  });
});

describe('PG-1/PG-2/PG-5: marca do repo-graph por runtime, reabertura do Codex e escopo por turno', () => {
  it('regra do adaptador: marca ligada ou seed sem MCP = ligado; repo-graph:off = desligado; agente nao-seed sem marca = desligado', () => {
    expect(swarmRepoGraphRequestedFor('swarm-explorer', ['repo-graph'])).toBe(true);
    expect(swarmRepoGraphRequestedFor('swarm-explorer', [])).toBe(true);
    expect(swarmRepoGraphRequestedFor('swarm-secrets-scanner', [])).toBe(true);
    expect(swarmRepoGraphRequestedFor('swarm-explorer', ['repo-graph:off'])).toBe(false);
    expect(swarmRepoGraphRequestedFor('swarm-explorer', ['repo-graph', 'repo-graph:off'])).toBe(false);
    expect(swarmRepoGraphRequestedFor('meu-swarm-custom', [])).toBe(false);
    expect(swarmRepoGraphRequestedFor('meu-swarm-custom', ['repo-graph'])).toBe(true);
  });
  it('seed em Codex que perdeu a marca (mcpServers = []) continua com o repo-graph; repo-graph:off desliga de verdade', async () => {
    mocks.agents.set('swarm-explorer', makeAgent('swarm-explorer', 'codex', []));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'ready' }];
    const seedless = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, cwd);
    expect(seedless.repoGraphState).toBe('ready');
    expect(seedless.config.allowedTools).toEqual(expect.arrayContaining(REPO_GRAPH_TOOLS));
    expect(mocks.warns.some((args) => JSON.stringify(args).includes('repo-graph'))).toBe(false);
    mocks.agents.set('swarm-explorer', makeAgent('swarm-explorer', 'codex', ['repo-graph:off']));
    const off = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-explorer' }, cwd);
    expect(off.repoGraphState).toBe('off');
    expect(off.config.allowedTools.some((t) => t.startsWith('mcp__'))).toBe(false);
    expect(off.agent.mcpServers).toEqual([]);
    expect(mocks.warns.some((args) => JSON.stringify(args).includes('repo-graph:off'))).toBe(false);
  });
  it('PG-2: continuacao recusada reabre a sessao Codex com o binding do repo-graph; PG-5: escopo ativo so durante o turno', async () => {
    mocks.agents.set('swarm-codex', makeAgent('swarm-codex', 'codex', ['repo-graph']));
    mocks.repos = [{ id: 'repo-1', canonicalRootPath: cwd, status: 'ready' }];
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: 'swarm-codex' }, cwd);
    let calls = 0;
    mocks.execute.mockImplementation(async (req) => {
      calls += 1;
      if (calls === 1) {
        req.onCodexSessionCreated?.({ threadId: 'thread-1', isClosed: () => false, close: () => {} });
        return { output: 'STATUS: ok', metrics: { apiRequests: 1, toolUses: 0 } };
      }
      if (calls === 2) throw Object.assign(new Error('thread not found'), { code: 'session-missing' });
      expect(req.swarmFindingsMcpArgs).toEqual([
        '-c',
        'mcp_servers.swarm-worker={}',
        '-c',
        'mcp_servers.repo-graph={}',
      ]);
      return { output: 'STATUS: ok', metrics: { apiRequests: 1, toolUses: 0 } };
    });
    const base = {
      resolved,
      cwd,
      findingsPath: path.join(cwd, 'findings.md'),
      runId: 'run-pg2',
      slug: 's',
      generation: 1,
      settings,
      writeFindings: async () => {},
      uploadFindings: async () => ({ uploadId: 'u', nextSeq: 0, sha256: '' }),
    };
    const first = await executeSwarmAttempt({
      ...base,
      prompt: 'p',
      attemptId: 'a1',
      abortController: new AbortController(),
    });
    expect(first.repoGraphMounted).toBe(true);
    expect(mocks.bridges).toHaveLength(1);
    expect(mocks.bridges[0]!.active).toEqual([true, false]);
    const second = await executeSwarmAttempt({
      ...base,
      prompt: 'continue',
      attemptId: 'a2',
      abortController: new AbortController(),
      continuation: {
        session: { runtime: 'codex', id: 'thread-1', attemptId: 'a1', generation: 1 },
        fallbackPrompt: 'historico + continue',
      },
    });
    expect(second.continuation?.mode).toBe('replay');
    expect(second.repoGraphMounted).toBe(true);
    expect(mocks.bridges).toHaveLength(2);
    expect(mocks.bridges[1]!.repoGraph).toEqual({ repositoryId: 'repo-1', rootPath: cwd, status: 'ready' });
    expect(mocks.bridges[0]!.active).toEqual([true, false, true]);
    expect(mocks.bridges[1]!.active).toEqual([true, false]);
    await closeSwarmSession('run-pg2', 's');
  });
});
