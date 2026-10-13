import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../mcp-path-resolver', () => ({
  resolveMcpServerRuntime: (id: string) => ({ command: '/node', entryPath: `/${id}.js`, env: {} }),
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../agent-config-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-config-resolver')>()),
  buildRepoGraphMcpSpec: () => ({ 'repo-graph': { command: '/node', args: ['/repo-graph.js'], env: { A: '1' } } }),
}));
import {
  SWARM_REPO_GRAPH_OWNER_PREFIX,
  __resetSwarmRepoGraphScopesForTests,
  createSwarmRepoGraphInvoke,
  isSwarmRepoGraphReaderTool,
  mountSwarmRepoGraphMcp,
  pickSwarmRepository,
  registerSwarmRepoGraphScope,
  resolveSwarmRepoGraphScope,
  splitSwarmMcpServers,
  swarmRepoGraphCodexConfig,
  swarmRepoGraphState,
  swarmRepoGraphToolName,
  swarmRepoGraphToolSchemas,
} from '../swarm/repo-graph';
import { REPO_GRAPH_READER_TOOLS } from '../agent-config-resolver';
import { resolveHelperTokenOwner } from '../helper-identity';
import { createSwarmWorkerBridge } from '../swarm/worker-bridge';
import { executeRepoGraphRead, repoGraphReadBlockedReason } from '../repo-graph/read-tools';
import type { RepoGraphReader } from '../repo-graph/types';
import {
  SWARM_TARGET_TOO_BROAD_CODE,
  SwarmDomainError,
  parseSwarmInput,
  swarmTargetPathWarnings,
  swarmTargetTooBroadReason,
} from '../swarm/validation';
import { SWARM_CONTRACT, SWARM_WORK_METHOD } from '../seed-agents/_shared/swarm-contract';
import { SWARM_GENERIC_SEED_AGENTS, SWARM_SEED_AGENTS } from '../seed-agents/swarm-registry';
import { ephemeralSystemPrompt } from '../agent-runtime/swarm-adapter';
import { validateSwarmMcpSpawn } from '../agent-runtime/codex-session-factory';
import { SWARM_TARGET_GUIDANCE } from '../../../mcp-servers/_shared/swarm-guidance';

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-repo-graph-')));
fs.mkdirSync(path.join(cwd, 'src', 'auth'), { recursive: true });
fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'docs', 'SPEC.md'), '# spec\n', 'utf8');
fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));
afterEach(() => __resetSwarmRepoGraphScopesForTests());

const repo = (id: string, rootPath: string, status: 'ready' | 'stale' | 'building' | 'absent' | 'error') => ({
  id,
  canonicalRootPath: rootPath,
  status,
});

describe('repo-graph para swarm agents: repositorio registrado pelo cwd da run', () => {
  it('escolhe o repositorio ready/stale que contem o cwd, preferindo a raiz mais profunda; building/absent nao contam', () => {
    const nested = path.join(cwd, 'src');
    expect(pickSwarmRepository(cwd, [repo('a', cwd, 'ready')])).toEqual({
      repositoryId: 'a',
      rootPath: cwd,
      status: 'ready',
    });
    expect(
      pickSwarmRepository(path.join(cwd, 'src', 'auth'), [repo('a', cwd, 'stale'), repo('b', nested, 'ready')]),
    ).toEqual({ repositoryId: 'b', rootPath: nested, status: 'ready' });
    expect(
      pickSwarmRepository(cwd, [repo('a', cwd, 'building'), repo('b', cwd, 'absent'), repo('c', cwd, 'error')]),
    ).toBe(null);
    expect(pickSwarmRepository(os.tmpdir(), [repo('a', cwd, 'ready')])).toBe(null);
    expect(pickSwarmRepository(`${cwd}-irmao`, [repo('a', cwd, 'ready')])).toBe(null);
  });

  it('so o repo-graph passa pelo catalogo de MCPs do swarm; o estado por swarm agent segue a marca e o repositorio', () => {
    expect(splitSwarmMcpServers(['repo-graph', 'knowledge-base', 'repo-graph', 'skills'])).toEqual({
      allowed: ['repo-graph'],
      ignored: ['knowledge-base', 'skills'],
    });
    const binding = { repositoryId: 'a', rootPath: cwd, status: 'ready' as const };
    expect(swarmRepoGraphState(true, binding)).toBe('ready');
    expect(swarmRepoGraphState(true, { ...binding, status: 'stale' })).toBe('stale');
    expect(swarmRepoGraphState(true, null)).toBe('no-repository');
    expect(swarmRepoGraphState(false, binding)).toBe('off');
  });

  it('as tools expostas sao exatamente as sete de leitura do repo-graph, com nome completo mcp__repo-graph__*', () => {
    const names = swarmRepoGraphToolSchemas([
      ...REPO_GRAPH_READER_TOOLS,
      'Read',
      'mcp__repo-graph__repo_graph_build',
    ]).map((schema) => schema.function.name);
    expect(names).toEqual([...REPO_GRAPH_READER_TOOLS]);
    expect(names).toHaveLength(7);
    expect(isSwarmRepoGraphReaderTool('mcp__repo-graph__repo_graph_build')).toBe(false);
    expect(isSwarmRepoGraphReaderTool('mcp__repo-graph__repo_graph_search')).toBe(true);
    expect(swarmRepoGraphToolName('mcp__repo-graph__repo_graph_callers')).toBe('repo_graph_callers');
    expect(swarmRepoGraphToolName('mcp__repo-graph__repo_graph_update')).toBe(null);
    const search = swarmRepoGraphToolSchemas(['mcp__repo-graph__repo_graph_search'])[0]!;
    expect(search.function.parameters.required).toEqual(['term']);
  });

  it('o executor compartilhado mapeia cada tool de leitura para o reader e recusa tool desconhecida', async () => {
    const calls: string[] = [];
    const reader = {
      detect: async () => ({ exists: true, stats: { files: 1 } }),
      search: async (input: unknown) => (calls.push(`search:${JSON.stringify(input)}`), { symbols: [{}] }),
      minimalContext: async (input: unknown) => (
        calls.push(`ctx:${JSON.stringify(input)}`),
        { files: [], symbols: [] }
      ),
      impact: async () => ({ affected: [] }),
      node: async () => ({ node: null }),
      callers: async (input: unknown) => (calls.push(`callers:${JSON.stringify(input)}`), { related: [] }),
      callees: async () => ({ related: [] }),
    } as unknown as RepoGraphReader;
    const record = {
      id: 'r',
      name: 'repo',
      canonicalRootPath: cwd,
      status: 'ready' as const,
      indexedCommit: 'abc',
      lastIndexedAt: null,
    };
    await executeRepoGraphRead(reader, record, 'repo_graph_search', { term: 'login', limit: 5 });
    await executeRepoGraphRead(reader, record, 'repo_graph_callers', { symbol: 'login' });
    await executeRepoGraphRead(reader, record, 'repo_graph_minimal_context', { task: 'auth' });
    expect(calls).toEqual([
      `search:${JSON.stringify({ rootPath: cwd, term: 'login', kind: undefined, limit: 5 })}`,
      `callers:${JSON.stringify({ rootPath: cwd, symbol: 'login', limit: undefined })}`,
      `ctx:${JSON.stringify({ rootPath: cwd, repositoryId: 'r', task: 'auth' })}`,
    ]);
    const status = (await executeRepoGraphRead(reader, record, 'repo_graph_status', {})) as { graphExists: boolean };
    expect(status.graphExists).toBe(true);
    await expect(executeRepoGraphRead(reader, record, 'repo_graph_search', {})).rejects.toThrow('term is required');
    await expect(executeRepoGraphRead(reader, record, 'repo_graph_build', {})).rejects.toThrow(
      'unknown repo_graph tool',
    );
    expect(repoGraphReadBlockedReason('repo_graph_search', { status: 'building' })).toMatch(/sendo indexado/);
    expect(repoGraphReadBlockedReason('repo_graph_status', { status: 'building' })).toBe(null);
    expect(repoGraphReadBlockedReason('repo_graph_search', { status: 'stale' })).toBe(null);
  });

  it('a invocacao em processo recusa qualquer nome fora da lista de leitura antes de tocar o banco', async () => {
    const invoke = createSwarmRepoGraphInvoke({ repositoryId: 'r', rootPath: cwd, status: 'ready' });
    await expect(invoke('mcp__repo-graph__repo_graph_build', {})).rejects.toThrow('nao permitida');
    await expect(invoke('Bash', {})).rejects.toThrow('nao permitida');
  });

  it('familia Claude: o MCP repo-graph sobe com token proprio por tentativa, escopo registrado e revogado no dispose', async () => {
    const binding = { repositoryId: 'r', rootPath: cwd, status: 'ready' as const };
    const mount = await mountSwarmRepoGraphMcp(binding);
    expect(mount).not.toBe(null);
    const entry = mount!.entry['repo-graph']!;
    expect(entry.command).toBeTruthy();
    const token = entry.env?.LIONCLAW_HELPER_TOKEN ?? '';
    expect(token).not.toBe('');
    expect(mount!.owner.startsWith(SWARM_REPO_GRAPH_OWNER_PREFIX)).toBe(true);
    expect(resolveHelperTokenOwner(token)).toBe(mount!.owner);
    expect(resolveSwarmRepoGraphScope(mount!.owner)).toEqual(binding);
    mount!.dispose();
    mount!.dispose();
    expect(resolveHelperTokenOwner(token)).toBe(null);
    expect(resolveSwarmRepoGraphScope(mount!.owner)).toBe(null);
  });

  it('Codex: o worker bridge monta o repo-graph como segundo MCP (-c) com o mesmo token da tentativa e escopo do worker', () => {
    const binding = { repositoryId: 'r', rootPath: cwd, status: 'stale' as const };
    const bridge = createSwarmWorkerBridge(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }), binding);
    try {
      expect(bridge.repoGraphMounted).toBe(true);
      expect(bridge.extraArgs).toHaveLength(4);
      expect(bridge.extraArgs[2]).toBe('-c');
      expect(bridge.extraArgs[3]).toMatch(/^mcp_servers\.repo-graph=\{/);
      expect(bridge.extraArgs[3]).toContain('"env_vars"=["LIONCLAW_HELPER_TOKEN"]');
      expect(bridge.extraArgs[3]).toContain('/repo-graph.js');
      const owner = resolveHelperTokenOwner(bridge.spawnEnv.LIONCLAW_HELPER_TOKEN)!;
      expect(resolveSwarmRepoGraphScope(owner)).toEqual(binding);
      bridge.setRepoGraphActive(false);
      expect(resolveSwarmRepoGraphScope(owner)).toBe(null);
      bridge.setRepoGraphActive(true);
      expect(resolveSwarmRepoGraphScope(owner)).toEqual(binding);
      bridge.dispose();
      bridge.setRepoGraphActive(true);
      expect(resolveSwarmRepoGraphScope(owner)).toBe(null);
    } finally {
      bridge.dispose();
    }
    const without = createSwarmWorkerBridge(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }));
    expect(without.repoGraphMounted).toBe(false);
    expect(without.extraArgs).toHaveLength(2);
    without.dispose();
    expect(swarmRepoGraphCodexConfig(120)).toMatchObject({ command: '/node', tool_timeout_sec: 120 });
  });

  it('escopos registrados a mao sao resolvidos pelo owner e some ao desregistrar', () => {
    registerSwarmRepoGraphScope('x', { repositoryId: 'r', rootPath: cwd, status: 'ready' });
    expect(resolveSwarmRepoGraphScope('x')?.repositoryId).toBe('r');
    expect(resolveSwarmRepoGraphScope(undefined)).toBe(null);
    __resetSwarmRepoGraphScopesForTests();
    expect(resolveSwarmRepoGraphScope('x')).toBe(null);
  });
});

describe('alvo concreto no swarm_start (target_too_broad)', () => {
  const base = {
    requestId: 'r1',
    cwd,
    objective: 'o',
    mode: 'comite' as const,
    members: [{ slug: 'a', objective: 'm', member: { kind: 'registered' as const, agentId: 'swarm-explorer' } }],
  };
  it('recusa "o repositorio", "o codigo", "todo o projeto", "." e vazio com codigo target_too_broad e mensagem orientando', () => {
    for (const target of [
      'o repositorio',
      'o codigo',
      'todo o projeto',
      '.',
      './',
      '/',
      '*',
      '**/*',
      'tudo',
      'a base de codigo',
    ]) {
      const reason = swarmTargetTooBroadReason(target, cwd);
      expect(reason, target).toMatch(/^target_too_broad: /);
      expect(reason).toContain('repo-graph');
      expect(reason).toContain('swarm-explorer');
      let error: unknown;
      try {
        parseSwarmInput({ ...base, target }, [cwd]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SwarmDomainError);
      expect((error as SwarmDomainError).code).toBe(SWARM_TARGET_TOO_BROAD_CODE);
    }
  });
  it('aceita pasta ou arquivo relativo ao cwd, caminho dentro de uma frase, extensao de arquivo e URL', () => {
    for (const target of [
      'src/auth/',
      'src',
      'docs/SPEC.md',
      'secao 5.2 de docs/SPEC.md',
      'package.json',
      'o package.json do projeto',
      'https://example.com/spec',
      'compare (docs/SPEC.md) com o codigo',
    ]) {
      expect(swarmTargetTooBroadReason(target, cwd), target).toBe(null);
      const parsed = parseSwarmInput({ ...base, target }, [cwd]);
      expect(parsed.mode === 'comite' ? parsed.target : null).toBe(target);
    }
    expect(swarmTargetTooBroadReason('versao 2.0 do projeto', cwd)).toMatch(/target_too_broad/);
    for (const word of ['validar Node.js', 'o app Next.js', 'README.md', 'config.yaml inexistente'])
      expect(swarmTargetTooBroadReason(word, cwd), word).toBe(null);
    expect(swarmTargetPathWarnings('validar Node.js', cwd)).toEqual([]);
    expect(swarmTargetPathWarnings('secao 5.2 de docs/SPEC.md', cwd)).toEqual([]);
    expect(swarmTargetPathWarnings('src/auth/ e docs/NAO-EXISTE.md e src/nada/', cwd)).toEqual([
      'caminho citado no alvo nao existe no cwd: docs/NAO-EXISTE.md',
      'caminho citado no alvo nao existe no cwd: src/nada/',
    ]);
    expect(swarmTargetPathWarnings('https://example.com/a/b', cwd)).toEqual([]);
  });
  it('fanout valida cada item e o caminho inexistente continua caindo na checagem de existencia', () => {
    expect(() =>
      parseSwarmInput(
        {
          requestId: 'r2',
          cwd,
          objective: 'o',
          mode: 'fanout',
          promptTemplate: 'x {{item}}',
          member: { kind: 'registered', agentId: 'swarm-explorer' },
          items: [{ target: 'src/auth/' }, { target: 'o codigo' }],
        },
        [cwd],
      ),
    ).toThrow(/target_too_broad/);
    expect(() => parseSwarmInput({ ...base, target: 'src/nao-existe/' }, [cwd])).toThrow(/inexistente/);
  });
});

describe('prompt dos swarm agents e do orquestrador', () => {
  it('o contrato ganha o bloco "Metodo de trabalho" (repo-graph primeiro, Grep, leitura por faixa, sem releitura, arquivo:linha na hora) e vale para seeds e efemeros', () => {
    expect(SWARM_CONTRACT).toContain(SWARM_WORK_METHOD);
    expect(SWARM_WORK_METHOD).toContain('## Metodo de trabalho');
    expect(SWARM_WORK_METHOD).toMatch(/repo_graph_search/);
    expect(SWARM_WORK_METHOD).toMatch(/repo_graph_callers\/repo_graph_callees/);
    expect(SWARM_WORK_METHOD).toMatch(/localize com Grep/);
    expect(SWARM_WORK_METHOD).toMatch(/Read devolve ate 400 linhas/);
    expect(SWARM_WORK_METHOD).toMatch(/Nao releia o que ja leu/);
    expect(SWARM_WORK_METHOD).toMatch(/Anote arquivo:linha na hora/);
    expect(SWARM_SEED_AGENTS).toHaveLength(15);
    for (const seed of SWARM_SEED_AGENTS) {
      expect(seed.systemPrompt, seed.id).toContain(SWARM_WORK_METHOD);
      expect(seed.mcpServers, seed.id).toEqual(['repo-graph']);
    }
    for (const seed of SWARM_GENERIC_SEED_AGENTS) {
      const rolePart = seed.systemPrompt.slice(0, seed.systemPrompt.indexOf(SWARM_CONTRACT));
      expect(rolePart.length, seed.id).toBeLessThanOrEqual(450 + 2);
    }
    expect(ephemeralSystemPrompt('## Papel\nSo o papel.')).toContain(SWARM_WORK_METHOD);
  });
  it('Codex: o -c do repo-graph so e aceito como par companheiro do swarm-worker, em sessao isolada read-only', () => {
    const base = { disableGlobalMcp: true, sandbox: 'read-only' };
    const worker = ['-c', 'mcp_servers.swarm-worker={}'];
    const companion = ['-c', 'mcp_servers.repo-graph={}'];
    expect(validateSwarmMcpSpawn({ ...base, swarmFindingsMcpArgs: [...worker, ...companion] })?.extraArgs).toEqual([
      ...worker,
      ...companion,
    ]);
    expect(validateSwarmMcpSpawn({ ...base, swarmFindingsMcpArgs: worker })?.extraArgs).toEqual(worker);
    for (const bad of [
      [...companion, ...worker],
      [...worker, '-c'],
      [...worker, '-c', 'mcp_servers.knowledge-base={}'],
      [...worker, ...companion, ...companion],
      [...worker, '--x', 'mcp_servers.repo-graph={}'],
    ])
      expect(() => validateSwarmMcpSpawn({ ...base, swarmFindingsMcpArgs: bad })).toThrow(/Invalid isolated Swarm/);
    expect(() =>
      validateSwarmMcpSpawn({ ...base, sandbox: 'workspace-write', swarmFindingsMcpArgs: [...worker, ...companion] }),
    ).toThrow();
  });
  it('o guidance manda consultar o repo-graph ou rodar um swarm-explorer apertado antes de disparar e recusa alvos genericos', () => {
    expect(SWARM_TARGET_GUIDANCE).toContain('## Alvo concreto');
    expect(SWARM_TARGET_GUIDANCE).toContain('target_too_broad');
    expect(SWARM_TARGET_GUIDANCE).toMatch(/"o repositorio", "o codigo", "todo o projeto"/);
    expect(SWARM_TARGET_GUIDANCE).toMatch(/consulte o repo-graph/);
    expect(SWARM_TARGET_GUIDANCE).toMatch(/swarm-explorer de alvo apertado/);
  });
});
