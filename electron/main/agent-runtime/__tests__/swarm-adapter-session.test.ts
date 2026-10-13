import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../../../src/types';
import type { SwarmFindingsOperation, SwarmRuntime } from '../../../../src/types/swarm';
import type { CodexSession } from '../../codex-runtime/types';
import type { AgentExecutionRequest, AgentExecutionResult } from '../types';
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
  execute: vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(),
}));
vi.mock('../../db', () => ({
  getAgent: (id: string) => mocks.agents.get(id),
  getAllAgents: () => [...mocks.agents.values()],
  getEnabledTools: () => ['Read', 'Grep', 'Glob', 'Write'],
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
vi.mock('../execute', () => ({ executeAgent: (req: AgentExecutionRequest) => mocks.execute(req) }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../paths', () => ({ getLionClawHome: () => '/fixture' }));
vi.mock('../../mcp-path-resolver', () => ({
  resolveMcpServerRuntime: () => ({ command: '/node', entryPath: '/swarm.js', env: {} }),
}));
import {
  resolveSwarmMember,
  executeSwarmAttempt,
  closeSwarmSession,
  hasSwarmCodexSession,
  type SwarmAttemptExecution,
} from '../swarm-adapter';
import { dispatchSwarmFindings } from '../../swarm/worker-bridge';
import { resolveHelperTokenOwner, __resetHelperIdentityForTests } from '../../helper-identity';
import { pinSwarmSession, refusalReason } from '../swarm-adapter';
import {
  __resetSwarmCodexGuardForTests,
  swarmCodexOwnerId,
  swarmCodexShield,
} from '../../codex-runtime/swarm-session-guard';

function makeAgent(runtime: SwarmRuntime): AgentConfig {
  return {
    id: `agent-${runtime}`,
    name: runtime,
    description: 'role',
    model: 'configured-model',
    systemPrompt: 'prompt',
    runtime,
    squad: 'swarm',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
    mcpServers: [],
    skills: [],
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    ...(runtime === 'codex' ? { codexConfig: { model: 'provider-model', sandbox: 'read-only' } } : {}),
  };
}
const SETTINGS = { concurrencyCap: 1, maxAttempts: 1, idleTimeoutMs: 100, hardTimeoutMs: 1000, openWindowMs: 1000 };
async function attempt(
  runtime: SwarmRuntime,
  overrides: Partial<SwarmAttemptExecution> = {},
): Promise<SwarmAttemptExecution> {
  const agent = makeAgent(runtime);
  mocks.agents.set(agent.id, agent);
  const resolved = await resolveSwarmMember({ kind: 'registered', agentId: agent.id }, '/repo');
  return {
    resolved,
    cwd: '/repo',
    prompt: 'briefing',
    findingsPath: '/artifacts/run/_attempts/s/attempt-1/findings.md',
    runId: 'run',
    slug: 's',
    attemptId: 'attempt-1',
    generation: 1,
    settings: SETTINGS,
    abortController: new AbortController(),
    writeFindings: async () => {},
    uploadFindings: async () => ({ uploadId: 'u', nextSeq: 0, sha256: '' }),
    ...overrides,
  };
}
const session = (id: string, generation = 1) => ({ runtime: 'cloud' as const, id, attemptId: 'attempt-1', generation });
function fakeCodexSession(threadId: string): CodexSession {
  return {
    threadId,
    send: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    closeConfirmed: vi.fn(async () => {}),
  };
}
const begin: SwarmFindingsOperation = { operation: 'begin', uploadId: 'u' };
beforeEach(async () => {
  mocks.agents.clear();
  mocks.execute.mockReset();
  __resetHelperIdentityForTests();
  await closeSwarmSession('run', 's');
  __resetSwarmCodexGuardForTests();
});

describe('Swarm v2 S3 (AC-11): familia Claude retoma por resume com fallback para o reenvio', () => {
  it('a continuacao passa resume: sessionId (nunca continue) no mesmo cwd, com o prompt curto e o destino novo dos achados', async () => {
    mocks.execute.mockImplementation(async (req) => {
      expect(req.resumeSessionId).toBe('sess-1');
      expect(req.continueSession).toBeUndefined();
      expect(req.cwd).toBe('/repo');
      expect(req.prompt).toContain('mensagem nova');
      expect(req.prompt).toContain(
        'Entrega: use Write com file_path "/artifacts/run/_attempts/s/attempt-2/findings.md"',
      );
      expect(req.prompt).not.toContain('FALLBACK');
      req.onText?.('continuando');
      return { output: 'ok', metadata: { sessionIds: ['sess-1'] } } as AgentExecutionResult;
    });
    const req = await attempt('cloud', {
      attemptId: 'attempt-2',
      findingsPath: '/artifacts/run/_attempts/s/attempt-2/findings.md',
      prompt: 'mensagem nova',
      continuation: { session: session('sess-1'), fallbackPrompt: 'FALLBACK' },
    });
    const result = await executeSwarmAttempt(req);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(result.continuation).toEqual({ mode: 'session', reason: null });
    expect(result.metadata?.sessionIds).toEqual(['sess-1']);
  });
  it('sem continuacao (primeira execucao, retry ou redisparo) nenhum resume e enviado', async () => {
    mocks.execute.mockImplementation(async (req) => {
      expect(req.resumeSessionId).toBeUndefined();
      expect(req.continueSession).toBeUndefined();
      return { output: 'ok', metadata: { sessionIds: ['sess-nova'] } } as AgentExecutionResult;
    });
    const result = await executeSwarmAttempt(await attempt('cloud'));
    expect(result.continuation).toBeUndefined();
    expect(result.metadata?.sessionIds).toEqual(['sess-nova']);
  });
  it('sessao de outra geracao nao e retomada: a continuacao roda o reenvio e e marcada replay com o motivo', async () => {
    mocks.execute.mockImplementation(async (req) => {
      expect(req.resumeSessionId).toBeUndefined();
      expect(req.prompt).toContain('FALLBACK-G2');
      expect(req.prompt).not.toContain('prompt curto');
      return { output: 'ok' } as AgentExecutionResult;
    });
    const result = await executeSwarmAttempt(
      await attempt('cloud', {
        generation: 2,
        prompt: 'prompt curto',
        continuation: { session: session('sess-1', 1), fallbackPrompt: 'FALLBACK-G2' },
      }),
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(result.continuation).toEqual({
      mode: 'replay',
      reason: 'Sessao de outra geracao (1) nao e retomada na geracao 2',
    });
  });
  it('SDK recusa a sessao antes de qualquer evento: a mesma tentativa roda o reenvio sem resume e devolve replay com motivo', async () => {
    const prompts: Array<string | undefined> = [];
    mocks.execute.mockImplementation(async (req) => {
      prompts.push(req.resumeSessionId);
      if (req.resumeSessionId) throw new Error('No conversation found with session ID: sess-1');
      expect(req.prompt).toContain('FALLBACK');
      expect(req.prompt).toContain('Entrega: use Write com file_path');
      req.onActivity?.();
      return { output: 'ok', metadata: { sessionIds: ['sess-2'] } } as AgentExecutionResult;
    });
    const result = await executeSwarmAttempt(
      await attempt('cloud', { continuation: { session: session('sess-1'), fallbackPrompt: 'FALLBACK' } }),
    );
    expect(prompts).toEqual(['sess-1', undefined]);
    expect(result.continuation).toEqual({
      mode: 'replay',
      reason: 'Sessao inexistente no runtime cloud (No conversation found with session ID: sess-1)',
    });
    expect(result.metadata?.sessionIds).toEqual(['sess-2']);
  });
  it('resultado vazio sem nenhum evento tambem conta como recusa; erro depois de eventos NAO cai no reenvio', async () => {
    mocks.execute
      .mockImplementationOnce(async () => ({ output: '', error: { code: 'LLM-EMPTY', userMessage: 'vazio' } }) as never)
      .mockImplementationOnce(async (req) => {
        expect(req.resumeSessionId).toBeUndefined();
        return { output: 'ok' } as AgentExecutionResult;
      });
    const replayed = await executeSwarmAttempt(
      await attempt('cloud', { continuation: { session: session('sess-1'), fallbackPrompt: 'FALLBACK' } }),
    );
    expect(replayed.continuation?.mode).toBe('replay');
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    mocks.execute.mockReset();
    mocks.execute.mockImplementation(async (req) => {
      req.onText?.('comecei');
      throw new Error('crash no meio');
    });
    await expect(
      executeSwarmAttempt(
        await attempt('cloud', { continuation: { session: session('sess-1'), fallbackPrompt: 'FALLBACK' } }),
      ),
    ).rejects.toThrow('crash no meio');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('recusa sem reenvio possivel termina em session-lost', async () => {
    mocks.execute.mockImplementation(async () => {
      throw new Error('No conversation found');
    });
    await expect(
      executeSwarmAttempt(
        await attempt('cloud', { continuation: { session: session('sess-1'), fallbackPrompt: null } }),
      ),
    ).rejects.toMatchObject({ code: 'session-lost', message: expect.stringContaining('Reenvio impossivel') });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});

describe('Swarm v2 S3 (AC-12, AC-24): Codex com sessao viva por swarm agent e bridge por sessao', () => {
  it('dois turnos na mesma thread gravam achados em tentativas diferentes; upload para tentativa encerrada e recusado; token revogado ao fechar', async () => {
    const codex = fakeCodexSession('thread-1');
    const upload1 = vi.fn(async () => ({ uploadId: 'u', nextSeq: 1, sha256: '' }));
    const upload2 = vi.fn(async () => ({ uploadId: 'u', nextSeq: 2, sha256: '' }));
    let token = '';
    mocks.execute.mockImplementationOnce(async (req) => {
      expect(req.codexSession).toBeUndefined();
      expect(req.swarmFindingsMcpArgs?.[1]).toMatch(/^mcp_servers\.swarm-worker=/);
      token = req.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN;
      req.onCodexSessionCreated?.(codex);
      await dispatchSwarmFindings(resolveHelperTokenOwner(token)!, begin);
      req.onText?.('turno 1');
      return { output: 'turno 1' } as AgentExecutionResult;
    });
    const first = await executeSwarmAttempt(await attempt('codex', { uploadFindings: upload1 }));
    expect(first.metadata?.sessionIds).toEqual(['thread-1']);
    expect(upload1).toHaveBeenCalledWith(begin);
    expect(hasSwarmCodexSession('run', 's')).toBe(true);
    const owner = resolveHelperTokenOwner(token)!;
    await expect(dispatchSwarmFindings(owner, begin)).rejects.toThrow('Tentativa encerrada');
    expect(codex.closeConfirmed).not.toHaveBeenCalled();
    mocks.execute.mockImplementationOnce(async (req) => {
      expect(req.codexSession).toBe(codex);
      expect(req.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN).toBe(token);
      expect(req.prompt).toContain('mensagem nova');
      expect(req.prompt).toContain('Entrega pelo MCP swarm-worker');
      expect(req.resumeSessionId).toBeUndefined();
      await dispatchSwarmFindings(owner, begin);
      req.onText?.('turno 2');
      return { output: 'turno 2' } as AgentExecutionResult;
    });
    const second = await executeSwarmAttempt(
      await attempt('codex', {
        attemptId: 'attempt-2',
        findingsPath: '/artifacts/run/_attempts/s/attempt-2/findings.md',
        prompt: 'mensagem nova',
        uploadFindings: upload2,
        continuation: { session: { ...session('thread-1'), runtime: 'codex' }, fallbackPrompt: 'FALLBACK' },
      }),
    );
    expect(second.continuation).toEqual({ mode: 'session', reason: null });
    expect(second.metadata?.sessionIds).toEqual(['thread-1']);
    expect(upload2).toHaveBeenCalledTimes(1);
    expect(upload1).toHaveBeenCalledTimes(1);
    await expect(dispatchSwarmFindings(owner, begin)).rejects.toThrow('Tentativa encerrada');
    expect(resolveHelperTokenOwner(token)).toBe(owner);
    await closeSwarmSession('run', 's');
    expect(codex.closeConfirmed).toHaveBeenCalledTimes(1);
    expect(resolveHelperTokenOwner(token)).toBeNull();
    await expect(dispatchSwarmFindings(owner, begin)).rejects.toThrow('revogada');
    expect(hasSwarmCodexSession('run', 's')).toBe(false);
  });
  it('thread morta na continuacao: a sessao e fechada, o token antigo revogado e o reenvio roda numa sessao nova', async () => {
    const dead = fakeCodexSession('thread-dead');
    const fresh = fakeCodexSession('thread-fresh');
    mocks.execute.mockImplementationOnce(async (req) => {
      req.onCodexSessionCreated?.(dead);
      return { output: 'turno 1' } as AgentExecutionResult;
    });
    const first = await executeSwarmAttempt(await attempt('codex'));
    const oldToken = (mocks.execute.mock.calls[0][0] as AgentExecutionRequest).swarmFindingsMcpEnv!
      .LIONCLAW_HELPER_TOKEN;
    expect(first.metadata?.sessionIds).toEqual(['thread-dead']);
    mocks.execute
      .mockImplementationOnce(async (req) => {
        expect(req.codexSession).toBe(dead);
        throw new Error('thread closed');
      })
      .mockImplementationOnce(async (req) => {
        expect(req.codexSession).toBeUndefined();
        expect(req.prompt).toContain('FALLBACK');
        expect(req.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN).not.toBe(oldToken);
        req.onCodexSessionCreated?.(fresh);
        return { output: 'turno 2' } as AgentExecutionResult;
      });
    const result = await executeSwarmAttempt(
      await attempt('codex', {
        attemptId: 'attempt-2',
        continuation: { session: { ...session('thread-dead'), runtime: 'codex' }, fallbackPrompt: 'FALLBACK' },
      }),
    );
    expect(dead.closeConfirmed).toHaveBeenCalledTimes(1);
    expect(resolveHelperTokenOwner(oldToken)).toBeNull();
    expect(result.continuation).toEqual({
      mode: 'replay',
      reason: 'Falha antes do primeiro evento do runtime codex (thread closed)',
    });
    expect(result.metadata?.sessionIds).toEqual(['thread-fresh']);
    expect(hasSwarmCodexSession('run', 's')).toBe(true);
    await closeSwarmSession('run', 's');
    expect(fresh.closeConfirmed).toHaveBeenCalledTimes(1);
  });
  it('execucao sem continuacao (retry ou redisparo) com sessao viva fecha a anterior e abre outra com token novo', async () => {
    const old = fakeCodexSession('thread-old');
    const next = fakeCodexSession('thread-next');
    mocks.execute.mockImplementationOnce(async (req) => {
      req.onCodexSessionCreated?.(old);
      return { output: 'g1' } as AgentExecutionResult;
    });
    await executeSwarmAttempt(await attempt('codex'));
    const oldToken = (mocks.execute.mock.calls[0][0] as AgentExecutionRequest).swarmFindingsMcpEnv!
      .LIONCLAW_HELPER_TOKEN;
    mocks.execute.mockImplementationOnce(async (req) => {
      expect(req.codexSession).toBeUndefined();
      expect(req.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN).not.toBe(oldToken);
      req.onCodexSessionCreated?.(next);
      return { output: 'g2' } as AgentExecutionResult;
    });
    const result = await executeSwarmAttempt(await attempt('codex', { attemptId: 'attempt-2', generation: 2 }));
    expect(old.closeConfirmed).toHaveBeenCalledTimes(1);
    expect(resolveHelperTokenOwner(oldToken)).toBeNull();
    expect(result.metadata?.sessionIds).toEqual(['thread-next']);
    await closeSwarmSession('run', 's');
  });
});

describe('Swarm v2 S3 correcoes (S3-V1, S3-V2, S3-V3, S3-V5): guarda do registry, descarte integral, threadId real e motivo real', () => {
  it('S3-V1: a sessao Codex nasce com escopo proprio (ownerKind swarm, ownerId run/slug/geracao) protegida do reap; waiting fixa (pinned); o fechamento libera', async () => {
    const codex = fakeCodexSession('thread-1');
    mocks.execute.mockImplementationOnce(async (req) => {
      expect(req.sessionScope).toEqual({ runId: 'run', slug: 's', generation: 1 });
      req.onCodexSessionCreated?.(codex);
      return { output: 'ok' } as AgentExecutionResult;
    });
    const ownerId = swarmCodexOwnerId({ runId: 'run', slug: 's', generation: 1 });
    await executeSwarmAttempt(await attempt('codex'));
    expect(swarmCodexShield(ownerId)).toBe('protected');
    pinSwarmSession('run', 's', true);
    expect(swarmCodexShield(ownerId)).toBe('pinned');
    pinSwarmSession('run', 's', false);
    expect(swarmCodexShield(ownerId)).toBe('protected');
    mocks.execute.mockImplementationOnce(async (req) => {
      expect(req.sessionScope).toEqual({ runId: 'run', slug: 's', generation: 2 });
      req.onCodexSessionCreated?.(fakeCodexSession('thread-2'));
      return { output: 'g2' } as AgentExecutionResult;
    });
    await executeSwarmAttempt(await attempt('codex', { attemptId: 'attempt-2', generation: 2 }));
    expect(swarmCodexShield(ownerId)).toBe('none');
    expect(swarmCodexShield(swarmCodexOwnerId({ runId: 'run', slug: 's', generation: 2 }))).toBe('protected');
    await closeSwarmSession('run', 's');
    expect(swarmCodexShield(swarmCodexOwnerId({ runId: 'run', slug: 's', generation: 2 }))).toBe('none');
  });
  it('S3-V1/S3-V3: sessao fechada no runtime (isClosed) nao e retomada: a continuacao cai no reenvio com motivo e abre sessao nova; sem threadId nao ha sessionIds', async () => {
    const closed = { ...fakeCodexSession('thread-closed'), isClosed: () => true };
    mocks.execute.mockImplementationOnce(async (req) => {
      req.onCodexSessionCreated?.(closed);
      return { output: 'turno 1' } as AgentExecutionResult;
    });
    const first = await executeSwarmAttempt(await attempt('codex'));
    expect(first.metadata?.sessionIds).toBeUndefined();
    expect(hasSwarmCodexSession('run', 's')).toBe(false);
    const fresh = fakeCodexSession('thread-fresh');
    mocks.execute.mockImplementationOnce(async (req) => {
      expect(req.codexSession).toBeUndefined();
      expect(req.prompt).toContain('FALLBACK');
      req.onCodexSessionCreated?.(fresh);
      return { output: 'turno 2' } as AgentExecutionResult;
    });
    const result = await executeSwarmAttempt(
      await attempt('codex', {
        attemptId: 'attempt-2',
        prompt: 'prompt curto',
        continuation: { session: { ...session('thread-closed'), runtime: 'codex' }, fallbackPrompt: 'FALLBACK' },
      }),
    );
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(closed.closeConfirmed).toHaveBeenCalledTimes(1);
    expect(result.continuation).toEqual({
      mode: 'replay',
      reason: 'Sessao thread-closed nao esta mais viva no runtime codex',
    });
    expect(result.metadata?.sessionIds).toEqual(['thread-fresh']);
    const noThread = { ...fakeCodexSession('x'), threadId: null };
    mocks.execute.mockImplementationOnce(async (req) => {
      req.onCodexSessionCreated?.(noThread);
      return { output: 'g2', metadata: { sessionIds: ['nao-deve-vazar'] } } as AgentExecutionResult;
    });
    const third = await executeSwarmAttempt(await attempt('codex', { attemptId: 'attempt-3', generation: 2 }));
    expect(third.metadata?.sessionIds).toBeUndefined();
    await closeSwarmSession('run', 's');
  });
  it('S3-V2: execucao que lanca (turno falho, abort) descarta sessao, bridge e token do swarm agent na hora', async () => {
    const codex = fakeCodexSession('thread-fail');
    let token = '';
    mocks.execute.mockImplementationOnce(async (req) => {
      token = req.swarmFindingsMcpEnv!.LIONCLAW_HELPER_TOKEN;
      req.onCodexSessionCreated?.(codex);
      throw new Error('turno falhou');
    });
    await expect(executeSwarmAttempt(await attempt('codex'))).rejects.toThrow('turno falhou');
    expect(codex.closeConfirmed).toHaveBeenCalledTimes(1);
    expect(resolveHelperTokenOwner(token)).toBeNull();
    expect(hasSwarmCodexSession('run', 's')).toBe(false);
    expect(swarmCodexShield(swarmCodexOwnerId({ runId: 'run', slug: 's', generation: 1 }))).toBe('none');
    await closeSwarmSession('run', 's');
  });
  it('S3-V5: o motivo da recusa traz a classe e a mensagem real do erro e distingue sessao inexistente de falha antes do inicio', () => {
    class CodexUnavailableError extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'CodexUnavailableError';
      }
    }
    expect(refusalReason('codex', new CodexUnavailableError('codex app-server handshake failed'))).toBe(
      'Falha antes do primeiro evento do runtime codex (CodexUnavailableError: codex app-server handshake failed)',
    );
    expect(refusalReason('cloud', new Error('No conversation found with session ID: abc'))).toBe(
      'Sessao inexistente no runtime cloud (No conversation found with session ID: abc)',
    );
    expect(refusalReason('zai', 'MCP Swarm não instalado')).toBe(
      'Falha antes do primeiro evento do runtime zai (MCP Swarm não instalado)',
    );
    expect(refusalReason('cloud', new Error('x'.repeat(500))).length).toBeLessThan(260);
  });
});
