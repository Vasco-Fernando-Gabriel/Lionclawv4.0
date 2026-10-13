import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../../../src/types';
import type { SwarmRuntime } from '../../../../src/types/swarm';
const REPO_GRAPH_TOOLS = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
].map((t) => `mcp__repo-graph__${t}`);
const mocks = vi.hoisted(() => ({
  agents: new Map<string, AgentConfig>(),
  execute: vi.fn(),
  dispose: vi.fn(),
  enabled: ['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch'],
}));
vi.mock('../../db', () => ({
  getAgent: (id: string) => mocks.agents.get(id),
  getAllAgents: () => [...mocks.agents.values()],
  getEnabledTools: () => mocks.enabled,
}));
vi.mock('../../agent-config-resolver', () => ({
  REPO_GRAPH_READER_TOOLS: [
    'repo_graph_status',
    'repo_graph_search',
    'repo_graph_minimal_context',
    'repo_graph_impact',
    'repo_graph_node',
    'repo_graph_callers',
    'repo_graph_callees',
  ].map((t) => `mcp__repo-graph__${t}`),
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
  mergeRepoGraphAllowlist: (tools: string[]) => [...new Set([...tools, ...REPO_GRAPH_TOOLS])],
  buildRepoGraphMcpSpec: () => ({ 'repo-graph': { command: 'node', args: ['repo-graph.js'] } }),
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
  createSwarmWorkerBridge: () => ({
    extraArgs: ['-c', 'mcp_servers.swarm-worker={}'],
    repoGraphMounted: false,
    setRepoGraphActive: () => {},
    dispose: mocks.dispose,
  }),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../paths', () => ({ getLionClawHome: () => '/fixture' }));
import {
  resolveSwarmMember,
  executeSwarmAttempt,
  closeSwarmSession,
  getSwarmCatalog,
  ephemeralSystemPrompt,
  hasSwarmContract,
} from '../swarm-adapter';
import { SWARM_CONTRACT } from '../../seed-agents/_shared/swarm-contract';
import { SWARM_GENERIC_ROLE_IDS } from '../../swarm/generic-roles';
const runtimes: SwarmRuntime[] = ['cloud', 'zai', 'minimax-tp', 'codex', 'kimi', 'local', 'external'];
function makeAgent(runtime: SwarmRuntime): AgentConfig {
  return {
    id: runtime,
    name: runtime,
    description: 'role',
    model: 'configured-model',
    systemPrompt: 'prompt',
    runtime,
    squad: 'swarm',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash', 'Agent'],
    mcpServers: ['unsafe'],
    skills: [],
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    ...(runtime === 'local'
      ? { localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'provider-model' } }
      : {}),
    ...(runtime === 'external'
      ? {
          externalConfig: {
            provider: 'openai-compatible',
            protocol: 'openai-compatible',
            baseUrl: 'https://fixture.invalid',
            apiKeyRef: 'vault-reference',
            model: 'provider-model',
          },
        }
      : {}),
    ...(runtime === 'codex' ? { codexConfig: { model: 'provider-model', sandbox: 'danger-full-access' } } : {}),
  };
}
beforeEach(() => {
  mocks.agents.clear();
  mocks.enabled = ['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch'];
  mocks.execute.mockReset();
  mocks.dispose.mockClear();
});
describe('Swarm snapshots across all seven runtime families', () => {
  it.each(runtimes)(
    '%s freezes registered configuration, ephemeral provider comes from explicit reference',
    async (runtime) => {
      const original = makeAgent(runtime);
      mocks.agents.set(runtime, original);
      const registered = await resolveSwarmMember({ kind: 'registered', agentId: runtime }, '/fixture');
      original.systemPrompt = 'edited';
      original.model = 'edited';
      original.allowedTools.push('Edit');
      expect(registered.config.systemPrompt).toBe('prompt');
      expect(registered.config.allowedTools).not.toContain('Bash');
      expect(registered.config.allowedTools).not.toContain('Agent');
      const ephemeral = await resolveSwarmMember(
        {
          kind: 'ephemeral',
          runtime,
          model: 'explicit-model',
          rolePrompt: 'only my role',
          allowedTools: ['Read', 'Grep', 'Glob'],
          providerProfileId: `agent:${runtime}`,
        },
        '/fixture',
      );
      expect(ephemeral.model).toBe('explicit-model');
      expect(ephemeral.config.systemPrompt.startsWith('only my role\n\n')).toBe(true);
      expect(ephemeral.config.systemPrompt).toContain(SWARM_CONTRACT);
      expect(ephemeral.agent.systemPrompt).toBe(ephemeral.config.systemPrompt);
      expect(ephemeral.agent.id).toContain('swarm-ephemeral');
      expect(mocks.agents.size).toBe(1);
      expect(JSON.stringify(ephemeral.snapshot)).not.toContain('unsafe');
    },
  );
  it('requires provider profile for local/external and reports honest web restriction', async () => {
    await expect(
      resolveSwarmMember(
        { kind: 'ephemeral', runtime: 'external', model: 'm', rolePrompt: 'p', allowedTools: ['Read'] },
        '/tmp',
      ),
    ).rejects.toThrow('provider-profile-required');
    const agent = makeAgent('local');
    agent.allowedTools = ['WebSearch'];
    mocks.agents.set(agent.id, agent);
    expect((await getSwarmCatalog()).members[0].available).toBe(false);
  });
  it('uses captured snapshot after DB deletion; the Codex worker bridge lives with the swarm agent session and is revoked when the session closes', async () => {
    const a = makeAgent('codex');
    mocks.agents.set(a.id, a);
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: a.id }, '/fixture');
    mocks.agents.clear();
    const abort = new AbortController();
    mocks.execute.mockImplementation(async (req) => {
      expect(req.executionAgent.model).toBe('provider-model');
      expect(req.swarmFindingsMcpArgs).toHaveLength(2);
      expect(typeof req.onCodexSessionCreated).toBe('function');
      abort.abort();
      return { output: 'ok' };
    });
    await executeSwarmAttempt({
      resolved,
      cwd: '/fixture',
      prompt: 'p',
      findingsPath: '/artifact/findings.md',
      runId: 'run',
      slug: 's',
      attemptId: 'a',
      generation: 1,
      settings: { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000, openWindowMs: 1000 },
      abortController: abort,
      writeFindings: async () => {},
      uploadFindings: async () => ({ uploadId: 'u', nextSeq: 0, sha256: '' }),
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).not.toHaveBeenCalled();
    await closeSwarmSession('run', 's');
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});

it('global disabled tools cannot be re-enabled by ephemeral persona; code essentials fail preflight', async () => {
  mocks.enabled = ['Read', 'Glob', 'Write'];
  await expect(
    resolveSwarmMember(
      { kind: 'ephemeral', runtime: 'cloud', model: 'm', rolePrompt: 'p', allowedTools: ['Read', 'Glob', 'Grep'] },
      '/tmp',
    ),
  ).rejects.toThrow('essenciais');
  const web = makeAgent('cloud');
  web.allowedTools = ['WebSearch', 'WebFetch', 'Write'];
  mocks.agents.set(web.id, web);
  const resolved = await resolveSwarmMember({ kind: 'registered', agentId: web.id }, '/tmp');
  expect(resolved.config.allowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
});

it('web nativa do runtime nao depende do catalogo de ferramentas do app', async () => {
  mocks.enabled = ['Read', 'Glob', 'Grep', 'Write'];
  const web = makeAgent('cloud');
  web.allowedTools = ['WebSearch', 'WebFetch', 'Write'];
  mocks.agents.set(web.id, web);
  const resolved = await resolveSwarmMember({ kind: 'registered', agentId: web.id }, '/tmp');
  expect(resolved.config.allowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
  const catalog = await getSwarmCatalog();
  expect(catalog.members.find((m) => m.agentId === web.id)?.available).toBe(true);
});

it('expands per-attempt paths and slug without changing the captured snapshot', async () => {
  const agent = makeAgent('cloud');
  agent.systemPrompt = '{{RUN_DIR}} {{SLUG}} {{FINDINGS_PATH}}';
  mocks.agents.set(agent.id, agent);
  const resolved = await resolveSwarmMember({ kind: 'registered', agentId: agent.id }, '/repo');
  const before = JSON.stringify(resolved.snapshot);
  mocks.execute.mockImplementation(async (req) => {
    expect(req.resolvedConfigOverride.systemPrompt).toBe(
      '/artifacts/run member /artifacts/run/_attempts/member/attempt/findings.md',
    );
    expect(req.prompt).toContain('member');
    expect(req.prompt).not.toContain('{{SLUG}}');
    return { output: 'ok' };
  });
  await executeSwarmAttempt({
    resolved,
    cwd: '/repo',
    prompt: 'Inspect {{SLUG}}',
    findingsPath: '/artifacts/run/_attempts/member/attempt/findings.md',
    runId: 'run',
    slug: 'member',
    attemptId: 'attempt',
    generation: 1,
    settings: { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000, openWindowMs: 1000 },
    abortController: new AbortController(),
    writeFindings: async () => {},
  });
  expect(JSON.stringify(resolved.snapshot)).toBe(before);
  expect(resolved.config.systemPrompt).toContain('{{RUN_DIR}}');
});

describe('Swarm v2 S4 (D5): Grok e Cursor entram como swarm agents', () => {
  it.each(['grok', 'cursor'] as const)('%s e aceito pelo validateCapability e aparece no catalogo', async (runtime) => {
    const agent: AgentConfig = { ...makeAgent('cloud'), id: runtime, runtime };
    mocks.agents.set(agent.id, agent);
    const resolved = await resolveSwarmMember({ kind: 'registered', agentId: agent.id }, '/repo');
    expect(resolved.runtime).toBe(runtime);
    expect(resolved.config.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Write']);
    const catalog = await getSwarmCatalog();
    expect(catalog.members.map((m) => [m.agentId, m.available])).toEqual([[runtime, true]]);
    expect(catalog.runtimes.map((r) => r.runtime)).toEqual([
      'cloud',
      'codex',
      'zai',
      'minimax-tp',
      'kimi',
      'grok',
      'cursor',
      'local',
      'external',
    ]);
    const row = catalog.runtimes.find((r) => r.runtime === runtime)!;
    expect(row).toMatchObject({ read: 'confined', write: 'negada', shell: 'negada', web: 'negada' });
    expect(row.continuation).toBe(runtime === 'cursor' ? 'session' : 'replay');
  });
  it.each(['grok', 'cursor'] as const)('%s continua sem busca web (sem dispatcher seguro)', async (runtime) => {
    const agent: AgentConfig = { ...makeAgent('cloud'), id: runtime, runtime, allowedTools: ['WebSearch', 'WebFetch'] };
    mocks.agents.set(agent.id, agent);
    await expect(resolveSwarmMember({ kind: 'registered', agentId: agent.id }, '/repo')).rejects.toThrow(
      'Busca/leitura web sem dispatcher seguro',
    );
  });
  it('a instrucao de entrega aponta a tool de escrita de cada runtime', async () => {
    const { swarmFindingsDeliveryInstruction } = await import('../swarm-adapter');
    expect(swarmFindingsDeliveryInstruction('cursor', '/f/achados.md')).toContain('use lion_write com file_path');
    expect(swarmFindingsDeliveryInstruction('grok', '/f/achados.md')).toContain('use write_file com file_path');
    expect(swarmFindingsDeliveryInstruction('kimi', '/f/achados.md')).toContain('use Write com file_path');
    expect(swarmFindingsDeliveryInstruction('local', '/f/achados.md')).toContain('use Write com file_path');
    expect(swarmFindingsDeliveryInstruction('grok', '/f/achados.md')).toContain('o host ja gravou');
    expect(swarmFindingsDeliveryInstruction('cloud', '/f/achados.md')).not.toContain('o host ja gravou');
    expect(swarmFindingsDeliveryInstruction('codex', '/f/achados.md')).toContain('swarm_write_findings');
  });
});

describe('Swarm v2 S1: contrato no efemero e catalogo com papeis genericos', () => {
  it('AC-2: o swarm agent efemero recebe o SWARM_CONTRACT com os placeholders expandidos por tentativa', async () => {
    const provider = makeAgent('cloud');
    mocks.agents.set(provider.id, provider);
    const resolved = await resolveSwarmMember(
      {
        kind: 'ephemeral',
        runtime: 'cloud',
        model: 'explicit-model',
        rolePrompt: 'Voce e um revisor de contratos.',
        allowedTools: ['Read', 'Grep', 'Glob'],
      },
      '/repo',
    );
    expect(resolved.config.systemPrompt).toBe(ephemeralSystemPrompt('Voce e um revisor de contratos.'));
    expect(resolved.config.systemPrompt).toContain('STATUS: ok | failed');
    expect(resolved.config.systemPrompt).toContain('{{FINDINGS_PATH}}');
    expect(JSON.stringify(resolved.snapshot)).toContain('{{SLUG}}');
    mocks.execute.mockImplementation(async (req) => {
      expect(req.resolvedConfigOverride.systemPrompt).not.toContain('{{');
      expect(req.resolvedConfigOverride.systemPrompt).toContain('FINDINGS: contrato.md');
      expect(req.resolvedConfigOverride.systemPrompt).toContain('/artifacts/run/_attempts/contrato/a1/findings.md');
      expect(req.executionAgent.systemPrompt).toBe(req.resolvedConfigOverride.systemPrompt);
      return { output: 'ok' };
    });
    await executeSwarmAttempt({
      resolved,
      cwd: '/repo',
      prompt: 'p',
      findingsPath: '/artifacts/run/_attempts/contrato/a1/findings.md',
      runId: 'run',
      slug: 'contrato',
      attemptId: 'a1',
      generation: 1,
      settings: { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000, openWindowMs: 1000 },
      abortController: new AbortController(),
      writeFindings: async () => {},
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('S1-V2: o contrato so e anexado quando o rolePrompt ainda nao o contem', () => {
    const role = 'Voce e um revisor de contratos.';
    expect(ephemeralSystemPrompt(role)).toBe(`${role}\n\n${SWARM_CONTRACT}`);
    expect(ephemeralSystemPrompt(`${role}\n\n${SWARM_CONTRACT}`)).toBe(`${role}\n\n${SWARM_CONTRACT}`);
    expect(ephemeralSystemPrompt(`${role}\n\n${SWARM_CONTRACT}`).split('## Contrato de saída')).toHaveLength(2);
    const trailerOnly = `${role}\nTermine com:\n---\nSTATUS: ok | failed\nSUMMARY: x\nFINDINGS: {{SLUG}}.md`;
    expect(ephemeralSystemPrompt(trailerOnly)).toBe(trailerOnly);
    expect(hasSwarmContract(`${role} Reporte STATUS: ok no fim.`)).toBe(false);
    expect(ephemeralSystemPrompt(`${role} Reporte STATUS: ok no fim.`)).toContain(SWARM_CONTRACT);
  });

  it('S1-V2: resolveSwarmMember nao duplica o contrato de um rolePrompt que ja o traz', async () => {
    const resolved = await resolveSwarmMember(
      {
        kind: 'ephemeral',
        runtime: 'cloud',
        model: 'm',
        rolePrompt: `Revisor.\n\n${SWARM_CONTRACT}`,
        allowedTools: ['Read', 'Grep', 'Glob'],
      },
      '/repo',
    );
    expect(resolved.config.systemPrompt).toBe(`Revisor.\n\n${SWARM_CONTRACT}`);
    expect(resolved.config.systemPrompt.match(/EXATAMENTE este trailer/g)).toHaveLength(1);
  });

  it('AC-1: swarm_catalog marca generic por swarm agent e lista os genericos primeiro', async () => {
    const specialized = { ...makeAgent('cloud'), id: 'swarm-auth-auditor', name: 'Auth' };
    const custom = { ...makeAgent('cloud'), id: 'meu-swarm-agent', name: 'Custom' };
    mocks.agents.set(specialized.id, specialized);
    mocks.agents.set(custom.id, custom);
    for (const id of SWARM_GENERIC_ROLE_IDS) mocks.agents.set(id, { ...makeAgent('cloud'), id, name: id });
    const catalog = await getSwarmCatalog();
    expect(catalog.members.map((m) => m.agentId)).toEqual([
      ...SWARM_GENERIC_ROLE_IDS,
      'swarm-auth-auditor',
      'meu-swarm-agent',
    ]);
    expect(catalog.members.filter((m) => m.generic).map((m) => m.agentId)).toEqual([...SWARM_GENERIC_ROLE_IDS]);
    expect(catalog.members.filter((m) => !m.generic).map((m) => m.agentId)).toEqual([
      'swarm-auth-auditor',
      'meu-swarm-agent',
    ]);
    expect(catalog.members.every((m) => m.available)).toBe(true);
  });
});
