import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { SwarmAttemptExecution, SwarmResolvedMember } from '../agent-runtime/swarm-adapter';
import { SwarmRunner, type SwarmRunnerDependencies } from '../swarm/runner';
import { SwarmArtifacts } from '../swarm/artifacts';
import { DEFAULT_SWARM_SETTINGS, type SwarmStartInput } from '../../../src/types/swarm';
import { SWARM_RUNTIME_CAPABILITIES } from '../swarm/runtime-capabilities';

let root: string;
const resolved: SwarmResolvedMember = {
  runtime: 'cloud',
  model: 'test',
  snapshot: { model: 'test' },
  agent: {} as AgentConfig,
  config: {} as AgentQueryConfig,
};
const report =
  '# Auditoria\n## Resumo\nVerificado.\n## Achados\nNenhum achado.\n## Fora de escopo / não verificado\nNão executei o app.\n';
function result(slug: string, status = 'ok'): AgentExecutionResult {
  return {
    runtime: 'cloud',
    model: 'test',
    provider: 'test',
    output: `---\nSTATUS: ${status}\nSUMMARY: análise concluída\nFINDINGS: ${slug}.md`,
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 1,
      apiRequests: 1,
      costUsd: 0.1,
      durationMs: 1,
    },
  };
}
function input(requestId: string, n = 1): SwarmStartInput {
  return {
    requestId,
    cwd: root,
    objective: 'Auditar',
    mode: 'comite',
    target: 'alvo.ts',
    members: Array.from({ length: n }, (_, i) => ({
      slug: `lens-${i}`,
      objective: 'auditar',
      member: { kind: 'registered', agentId: 'swarm-code-explorer' },
    })),
  };
}
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
function setup(overrides: Partial<SwarmRunnerDependencies> = {}) {
  const artifacts = new SwarmArtifacts(path.join(root, 'artifacts'));
  const deliver = vi.fn();
  const settings = { ...DEFAULT_SWARM_SETTINGS };
  const deps: SwarmRunnerDependencies = {
    artifacts,
    resolve: vi.fn(async () => resolved),
    execute: vi.fn(async (req) => {
      await req.writeFindings?.(report);
      return result(req.slug);
    }),
    catalog: async () => ({ members: [], profiles: [], runtimes: [] }),
    readSettings: () => settings,
    writeSettings: (s) => Object.assign(settings, s),
    project: vi.fn(),
    deliver,
    reportError: vi.fn(),
    recoverAttempt: async () => true,
    random: () => 0.5,
    ...overrides,
  };
  return { runner: new SwarmRunner(deps), deps, artifacts, deliver };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runner-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
describe('Swarm runner lifecycle', () => {
  it('S5 (AC-14): getMessages devolve o messages.jsonl do swarm agent da sessao e recusa outra sessao ou slug inexistente', async () => {
    const { runner, artifacts } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('messages'));
    await flush();
    expect(await runner.getMessages('s', started.runId, 'lens-0')).toEqual({
      runId: started.runId,
      slug: 'lens-0',
      messages: [],
    });
    const record = {
      id: 'msg-1-abc',
      kind: 'message' as const,
      attemptId: null,
      at: '2026-09-13T12:00:01.000Z',
      text: 'foque na pasta src',
    };
    artifacts.appendMessage(started.runId, 'lens-0', record);
    expect((await runner.getMessages('s', started.runId, 'lens-0')).messages).toEqual([record]);
    await expect(runner.getMessages('other', started.runId, 'lens-0')).rejects.toMatchObject({ code: 'run-denied' });
    await expect(runner.getMessages('s', started.runId, 'lens-9')).rejects.toMatchObject({ code: 'agent-not-found' });
    await runner.shutdown();
  });
  it('S4 (S4-V6): swarm_inspect devolve runtimeCapabilities dos runtimes da run sem gravar nada no manifesto', async () => {
    const { runner } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('inspect'));
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.runtimeCapabilities).toEqual([SWARM_RUNTIME_CAPABILITIES.cloud]);
    expect(run.runtimeCapabilities![0]).toMatchObject({ readLabel: 'leitura confinada', continuation: 'session' });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', started.runId, '_run.json'), 'utf8'));
    expect(manifest).not.toHaveProperty('runtimeCapabilities');
    expect(manifest).not.toHaveProperty('delivery');
    await runner.shutdown();
  });
  it('fences asynchronous admission on logout and holds its maintenance lease', async () => {
    let resolve!: (value: SwarmResolvedMember) => void;
    const release = vi.fn();
    const { runner, deps, artifacts } = setup({
      resolve: () =>
        new Promise((done) => {
          resolve = done;
        }),
      beginAdmission: () => ({ assertActive: vi.fn(), release }),
    });
    await runner.recover();
    const pending = runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('admission'));
    const rejection = expect(pending).rejects.toThrow(/Admissão cancelada/);
    await flush();
    expect(runner.hasActiveWork('s')).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await runner.abortAll();
    resolve(resolved);
    await rejection;
    expect(release).toHaveBeenCalledTimes(1);
    expect(runner.hasActiveWork()).toBe(false);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(artifacts.list()).toEqual([]);
    await runner.shutdown();
  });
  it('GA-1: falha ao enfileirar a entrega marca a run com delivery-error, loga uma vez e nao entra em laco; o proximo boot reconcilia e inclui o diretorio absoluto', async () => {
    let available = false;
    const deliver = vi.fn(() => {
      if (!available) throw new Error('db unavailable');
    });
    const { runner, artifacts, deps } = setup({ deliver });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('delivery'));
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect((deps.reportError as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/delivery-error/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    const marked = await runner.getRunState('s', started.runId);
    expect(marked.delivery).toEqual({ status: 'delivery-error', error: 'db unavailable' });
    expect(marked.deliveryError).toMatchObject({ kind: 'terminal', revision: marked.terminalRevision });
    available = true;
    const restarted = new SwarmRunner({ ...deps, deliver });
    await restarted.recover();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((deliver.mock.calls as unknown as Array<[unknown, string]>)[1][1]).toContain(
      path.join(artifacts.root, started.runId),
    );
    expect(artifacts.load(started.runId).deliveryError).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(deliver).toHaveBeenCalledTimes(2);
    await runner.shutdown();
    await restarted.shutdown();
  });
  it('returns a queued run, publishes findings and produces one immutable terminal event', async () => {
    const { runner, deliver, artifacts } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's1', swarmEnabled: true, readRoots: [root] }, input('a'));
    expect(started.status).toBe('queued');
    await flush();
    const run = await runner.getRunState('s1', started.runId);
    expect(run.status).toBe('open');
    expect(run.openedAt).not.toBeNull();
    expect(run.items[0].findingsFile).toBe('lens-0.md');
    expect(artifacts.read(`${run.runId}/lens-0.md`)).toBe(report);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2]).toMatchObject({ kind: 'terminal', revision: run.terminalRevision });
    const closed = await runner.abort('s1', run.runId);
    expect(closed.status).toBe('done');
    expect(closed.openedAt).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await runner.abort('s1', run.runId)).toEqual(closed);
    await runner.shutdown();
  });
  it('rejects chip OFF and performs the entire preflight before spawning', async () => {
    const { runner, deps } = setup({
      resolve: vi.fn().mockResolvedValueOnce(resolved).mockRejectedValueOnce(new Error('last member invalid')),
    });
    await runner.recover();
    await expect(runner.start({ sessionId: 's', swarmEnabled: false, readRoots: [root] }, input('a'))).rejects.toThrow(
      /chip/,
    );
    await expect(
      runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('a', 2)),
    ).rejects.toThrow(/last member/);
    expect(deps.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });
  it('shares capacity across chats and drains a reduced cap without killing workers', async () => {
    const pending: Array<{ req: SwarmAttemptExecution; settle: (r: AgentExecutionResult) => void }> = [];
    const { runner } = setup({ execute: (req) => new Promise((settle) => pending.push({ req, settle })) });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 2 });
    await runner.start({ sessionId: 'a', swarmEnabled: true, readRoots: [root] }, input('a', 2));
    await runner.start({ sessionId: 'b', swarmEnabled: true, readRoots: [root] }, input('b', 2));
    await flush();
    expect(pending).toHaveLength(2);
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 1 });
    expect(pending.every((p) => !p.req.abortController.signal.aborted)).toBe(true);
    pending[0].settle(result(pending[0].req.slug, 'failed'));
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].settle(result(pending[1].req.slug, 'failed'));
    await flush();
    expect(pending).toHaveLength(3);
    pending[2].settle(result(pending[2].req.slug, 'failed'));
    await flush();
    expect(pending).toHaveLength(4);
    pending[3].settle(result(pending[3].req.slug, 'failed'));
    await flush();
    expect(runner.hasActiveWork()).toBe(false);
    await runner.shutdown();
  });
  it('starts four committee specialists concurrently in one run before any member finishes', async () => {
    const pending: Array<{ req: SwarmAttemptExecution; settle: (r: AgentExecutionResult) => void }> = [];
    const { runner, artifacts, deliver } = setup({
      execute: (req) => new Promise((settle) => pending.push({ req, settle })),
    });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 4 });
    const slugs = ['secrets', 'auth', 'owasp', 'isolation'];
    const agentIds = [
      'swarm-secrets-scanner',
      'swarm-auth-auditor',
      'swarm-owasp-scanner',
      'swarm-isolation-inspector',
    ];
    const started = await runner.start(
      { sessionId: 'security-chat', swarmEnabled: true, readRoots: [root] },
      {
        requestId: 'security-committee',
        cwd: root,
        objective: 'Auditar segurança',
        mode: 'comite',
        target: 'alvo.ts',
        members: slugs.map((slug, i) => ({
          slug,
          objective: `Analisar ${slug}`,
          member: { kind: 'registered', agentId: agentIds[i] },
        })),
      },
    );
    await flush();

    expect(pending.map(({ req }) => req.slug).sort()).toEqual([...slugs].sort());
    expect(new Set(pending.map(({ req }) => req.runId))).toEqual(new Set([started.runId]));
    expect(artifacts.list()).toEqual([started.runId]);
    const running = await runner.getRunState('security-chat', started.runId);
    expect(running.status).toBe('running');
    expect(running.items.map((item) => item.status)).toEqual(['running', 'running', 'running', 'running']);
    expect(deliver).not.toHaveBeenCalled();

    for (const { req, settle } of pending) {
      await req.writeFindings?.(report);
      settle(result(req.slug));
    }
    await flush();
    const completed = await runner.getRunState('security-chat', started.runId);
    expect(completed.status).toBe('open');
    expect(completed.items.map((item) => item.findingsFile).sort()).toEqual(slugs.map((slug) => `${slug}.md`).sort());
    expect(deliver).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
  it('recovers a validated checkpoint before publication without rerunning its worker', async () => {
    const { runner, artifacts, deps } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('publication'));
    await flush();
    await runner.shutdown();
    const run = artifacts.load(started.runId);
    run.status = 'running';
    run.finishedAt = null;
    run.terminalRevision = null;
    run.openedAt = null;
    run.deliveredSignatures = null;
    const item = run.items[0];
    item.status = 'running';
    item.findingsFile = null;
    const attempt = item.attempts[0];
    attempt.outcome = null;
    attempt.endedAt = null;
    attempt.terminationConfirmedAt = null;
    artifacts.save(run);
    fs.unlinkSync(path.join(artifacts.root, run.runId, `${item.slug}.md`));
    const execute = vi.fn();
    const recoverAttempt = vi.fn(async () => true);
    const recovered = new SwarmRunner({ ...deps, execute, recoverAttempt });
    await recovered.recover();
    expect(recoverAttempt).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect((await recovered.getRunState('s', run.runId)).status).toBe('open');
    expect(artifacts.read(`${run.runId}/${item.slug}.md`)).toBe(report);
    await recovered.shutdown();
  });
  it('deduplicates simultaneous requests and refuses conflicting reuse', async () => {
    const { runner } = setup();
    await runner.recover();
    const ctx = { sessionId: 's', swarmEnabled: true, readRoots: [root] };
    const [a, b] = await Promise.all([runner.start(ctx, input('a')), runner.start(ctx, input('a'))]);
    expect(a.runId).toBe(b.runId);
    await expect(runner.start(ctx, { ...input('a'), objective: 'different' })).rejects.toThrow(/outro plano/);
    await flush();
    await runner.shutdown();
  });
  it('keeps request identity when persisting a snapshot fails before dispatch', async () => {
    const { runner, artifacts, deps } = setup();
    await runner.recover();
    const atomic = artifacts.atomic.bind(artifacts);
    vi.spyOn(artifacts, 'atomic').mockImplementation((relative, content) => {
      if (relative.endsWith('/config.json')) throw new Error('snapshot disk failure');
      atomic(relative, content);
    });
    const ctx = { sessionId: 's', swarmEnabled: true, readRoots: [root] };
    await expect(runner.start(ctx, input('snapshot'))).rejects.toThrow(/snapshot disk failure/);
    const repeated = await runner.start(ctx, input('snapshot'));
    expect(repeated.status).toBe('failed');
    expect(artifacts.list()).toEqual([repeated.runId]);
    expect(deps.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });
  it('retries only a transiently failed item after backoff and preserves every attempt', async () => {
    let calls = 0;
    const { runner, artifacts } = setup({
      execute: vi.fn(async (req) => {
        calls++;
        req.onText?.('texto parcial');
        if (calls === 1) throw Object.assign(new Error('network reset'), { code: 'ECONNRESET' });
        await req.writeFindings?.(report);
        return result(req.slug);
      }),
    });
    await runner.recover();
    const start = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('retry'));
    await flush();
    expect((await runner.getRunState('s', start.runId)).items[0].status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(calls).toBe(2);
    const run = await runner.getRunState('s', start.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].attempts).toHaveLength(2);
    expect(run.items[0].autoRetries).toBe(1);
    expect(run.items[0].executions.map((e) => e.kind)).toEqual(['initial', 'retry']);
    expect(artifacts.read(`${run.runId}/${run.items[0].attempts[0].outputFile}`)).toBe('texto parcial');
    await runner.shutdown();
  });
  it('does not retry honest task failure or claim success when findings are missing', async () => {
    const { runner, deps } = setup({ execute: vi.fn(async (req) => result(req.slug, 'failed')) });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('logical'));
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].status).toBe('failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
  it('uses exponential backoff after the first retry without occupying slots', async () => {
    const { runner, deps } = setup({
      execute: vi.fn(async () => {
        throw Object.assign(new Error('temporary'), { code: 'ECONNRESET' });
      }),
    });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, maxAttempts: 3 });
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('exponential'));
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.execute).toHaveBeenCalledTimes(3);
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].status).toBe('failed');
    expect(run.items[0].autoRetries).toBe(2);
    await runner.shutdown();
  });
  it('exposes persistence failure and rejects subsequent work', async () => {
    let req!: SwarmAttemptExecution;
    let settle!: (r: AgentExecutionResult) => void;
    const { runner, artifacts } = setup({
      execute: (r) => {
        req = r;
        return new Promise((done) => {
          settle = done;
        });
      },
    });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('disk'));
    await flush();
    const save = vi.spyOn(artifacts, 'save').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    await expect(runner.abort('s', started.runId)).rejects.toThrow('ENOSPC');
    expect(req.abortController.signal.aborted).toBe(true);
    await expect(runner.getRunState('s', started.runId)).rejects.toThrow(/Persistência Swarm indisponível/);
    await expect(
      runner.start({ sessionId: 'b', swarmEnabled: true, readRoots: [root] }, input('later')),
    ).rejects.toThrow(/indisponível/);
    settle(result(req.slug));
    await flush();
    save.mockRestore();
    await runner.shutdown();
  });
  it('awaits process exit during shutdown even when the abort checkpoint fails', async () => {
    let req!: SwarmAttemptExecution;
    let settle!: (r: AgentExecutionResult) => void;
    const { runner, artifacts } = setup({
      execute: (r) => {
        req = r;
        return new Promise((done) => {
          settle = done;
        });
      },
    });
    await runner.recover();
    await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('shutdown'));
    await flush();
    vi.spyOn(artifacts, 'save').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    let closed = false;
    const closing = runner.shutdown().then(() => {
      closed = true;
    });
    await flush();
    expect(req.abortController.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    settle(result(req.slug));
    await closing;
    expect(closed).toBe(true);
  });
  it('retains a stopping slot and fences late writes until the executor really exits', async () => {
    let req!: SwarmAttemptExecution;
    let settle!: (r: AgentExecutionResult) => void;
    const { runner } = setup({
      execute: (r) => {
        req = r;
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('abort'));
    await flush();
    const stopping = await runner.abort('s', started.runId);
    expect(stopping.status).toBe('aborting');
    expect(stopping.items[0].status).toBe('stopping');
    await expect(req.writeFindings?.(report)).rejects.toThrow(/escrita/);
    settle(result(req.slug));
    await flush();
    const done = await runner.getRunState('s', started.runId);
    expect(done.status).toBe('aborted');
    expect(done.items[0].status).toBe('cancelled');
    await runner.shutdown();
  });
  it('recovers interrupted pending work without replay and reconstructs terminal delivery', async () => {
    const { runner, artifacts, deps } = setup();
    await runner.recover();
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('recover'));
    await flush();
    await runner.shutdown();
    const before = artifacts.load(started.runId);
    expect(before.status).toBe('open');
    vi.setSystemTime(new Date('2026-09-13T12:10:00Z'));
    const deliver = vi.fn();
    const restarted = new SwarmRunner({ ...deps, deliver });
    await restarted.recover();
    const after = artifacts.load(started.runId);
    expect(after.status).toBe('open');
    expect(after.openedAt).toBe('2026-09-13T12:10:00.000Z');
    expect({ ...after, openedAt: null, revision: 0 }).toEqual({ ...before, openedAt: null, revision: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2]).toMatchObject({ kind: 'terminal', revision: before.terminalRevision });
    await restarted.shutdown();
  });
});
describe('Swarm v2 S1: swarm agent efemero sob o mesmo contrato', () => {
  it('AC-2: efemero que termina sem trailer vira bad-trailer, nunca ok; o prompt leva os cabecalhos do briefing', async () => {
    const seen: string[] = [];
    const { runner, deps } = setup({
      readSettings: () => ({ ...DEFAULT_SWARM_SETTINGS, maxAttempts: 1 }),
      execute: vi.fn(async (req) => {
        seen.push(req.prompt);
        await req.writeFindings?.(report);
        return { ...result(req.slug), output: 'Relatorio gravado. Fim.' };
      }),
    });
    await runner.recover();
    const started = await runner.start(
      { sessionId: 's', swarmEnabled: true, readRoots: [root] },
      {
        requestId: 'efemero',
        cwd: root,
        objective: 'Auditar',
        mode: 'comite',
        target: 'alvo.ts',
        members: [
          {
            slug: 'persona',
            objective: 'Auditar contratos',
            lens: 'contrato entre MCP e host',
            questions: ['O schema bate?'],
            member: {
              kind: 'ephemeral',
              runtime: 'cloud',
              model: 'm',
              rolePrompt: 'Voce e um revisor de contratos.',
              allowedTools: ['Read', 'Grep', 'Glob'],
            },
          },
        ],
      },
    );
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain('PAPEL: Voce e um revisor de contratos.\nMISSAO: Auditar contratos\nALVO: alvo.ts');
    expect(seen[0]).toContain('LENTE: contrato entre MCP e host');
    expect(Object.keys(run.items[0])).not.toContain('briefing');
    expect(Object.keys(run.items[0])).not.toContain('mission');
    expect(seen[0]).toContain('PERGUNTAS:\n1. O schema bate?');
    expect(run.items[0].member.kind).toBe('ephemeral');
    expect(run.items[0].status).toBe('failed');
    expect(run.items[0].attempts[0].outcome).toBe('bad-trailer');
    expect(run.items[0].findingsFile).toBeNull();
    expect(run.status).toBe('open');
    await runner.shutdown();
  });
  it('S1-V5: PAPEL de um swarm agent registrado vem do nome e da descricao resolvidos, com o agentId como reserva', async () => {
    const seen: string[] = [];
    const { runner } = setup({
      resolve: vi.fn(async (member) => ({
        ...resolved,
        agent:
          member.kind === 'registered' && member.agentId === 'swarm-auditor'
            ? ({ name: 'Swarm Auditor', description: 'Auditor generico: a lente vem no briefing.' } as AgentConfig)
            : ({} as AgentConfig),
      })),
      execute: vi.fn(async (req) => {
        seen.push(req.prompt);
        await req.writeFindings?.(report);
        return result(req.slug);
      }),
    });
    await runner.recover();
    const started = await runner.start(
      { sessionId: 's', swarmEnabled: true, readRoots: [root] },
      {
        requestId: 'papel',
        cwd: root,
        objective: 'Auditar',
        mode: 'comite',
        target: 'alvo.ts',
        members: [
          { slug: 'auditor', objective: 'Auditar acesso', member: { kind: 'registered', agentId: 'swarm-auditor' } },
          { slug: 'reserva', objective: 'Explorar', member: { kind: 'registered', agentId: 'swarm-code-explorer' } },
        ],
      },
    );
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0].prompt.split('\n').slice(0, 3)).toEqual([
      'OBJETIVO DA RUN: Auditar',
      'PAPEL: Swarm Auditor: Auditor generico: a lente vem no briefing.',
      'MISSAO: Auditar acesso',
    ]);
    expect(run.items[1].prompt).toContain('PAPEL: swarm-code-explorer\nMISSAO: Explorar');
    expect(seen.some((prompt) => prompt.startsWith(run.items[0].prompt))).toBe(true);
    expect(run.status).toBe('open');
    await runner.shutdown();
  });
});
describe('Swarm format repair and provider quota', () => {
  const withSession = (r: AgentExecutionResult, id: string) => ({ ...r, metadata: { sessionIds: [id] } });
  it('bad-trailer with a live session: the retry is a repair continuation by session, counts as autoRetry and reuses the rejected findings', async () => {
    const requests: SwarmAttemptExecution[] = [];
    const seeded: string[] = [];
    const { runner, deps, artifacts } = setup({
      execute: vi.fn(async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          await req.writeFindings?.(report);
          return withSession({ ...result(req.slug), output: 'analise pronta, sem trailer' }, 'sess-1');
        }
        seeded.push(fs.readFileSync(req.findingsPath, 'utf8'));
        return { ...withSession(result(req.slug), 'sess-1'), continuation: { mode: 'session' as const, reason: null } };
      }),
    });
    await runner.recover();
    const started = await runner.start(
      { sessionId: 's', swarmEnabled: true, readRoots: [root] },
      input('repair-session'),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(deps.execute).toHaveBeenCalledTimes(2);
    const repair = requests[1];
    expect(repair.continuation?.session.id).toBe('sess-1');
    expect(repair.prompt).toContain('MENSAGEM NOVA DO ORQUESTRADOR:');
    expect(repair.prompt).toContain('rejeitado pelo motivo: o trailer final STATUS/SUMMARY/FINDINGS');
    expect(repair.prompt).toContain('Corrija SO o formato preservando o conteudo');
    expect(repair.prompt).toContain('FINDINGS: lens-0.md');
    expect(repair.prompt).not.toContain('BRIEFING ORIGINAL:');
    expect(repair.continuation?.fallbackPrompt).toContain('BRIEFING ORIGINAL:');
    expect(repair.continuation?.fallbackPrompt).toContain('Arquivo de achados gravado e rejeitado:\n# Auditoria');
    expect(repair.continuation?.fallbackPrompt).toContain('Texto final:\nanalise pronta, sem trailer');
    expect(seeded).toEqual([report]);
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0]).toMatchObject({ status: 'ok', autoRetries: 1, findingsFile: 'lens-0.md', launch: null });
    expect(run.items[0].attempts.map((a) => a.outcome)).toEqual(['bad-trailer', 'ok']);
    expect(run.items[0].executions.map((e) => `${e.kind}:${e.continuationMode}:${e.mechanism}`)).toEqual([
      'initial:null:null',
      'repair:session:session',
    ]);
    expect(run.items[0].executions[1].continuationReason).toContain('Reparo de formato após bad-trailer');
    expect(run.items[0].attempts[1].metrics).toMatchObject({ costUsd: 0.1, costStatus: 'known', durationMs: 1 });
    expect(artifacts.read(`${run.runId}/lens-0.md`)).toBe(report);
    expect(artifacts.exists(`${run.runId}/_attempts/lens-0/repair-${run.items[0].attempts[0].id}-session.txt`)).toBe(
      true,
    );
    await runner.shutdown();
  });
  it('invalid-findings without a session: the repair is a resend with the rejected file and the final text, then the report is published', async () => {
    const requests: SwarmAttemptExecution[] = [];
    const rejected = `# Auditoria\n## Resumo\nOk.\n## Achados\nTudo certo, nada a reportar aqui.\n## Fora de escopo / não verificado\nNada.\n`;
    const { runner, deps } = setup({
      execute: vi.fn(async (req) => {
        requests.push(req);
        await req.writeFindings?.(requests.length === 1 ? rejected : report);
        return { ...result(req.slug), output: `Texto final ${requests.length}\n${result(req.slug).output}` };
      }),
    });
    await runner.recover();
    const started = await runner.start(
      { sessionId: 's', swarmEnabled: true, readRoots: [root] },
      input('repair-replay'),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(deps.execute).toHaveBeenCalledTimes(2);
    const repair = requests[1];
    expect(repair.continuation).toBeUndefined();
    expect(repair.prompt).toContain('BRIEFING ORIGINAL:');
    expect(repair.prompt).toContain('EXECUCAO ANTERIOR (rejeitada por formato: invalid-findings):');
    expect(repair.prompt).toContain('Texto final:\nTexto final 1');
    expect(repair.prompt).toContain(`Arquivo de achados gravado e rejeitado:\n${rejected}`);
    expect(repair.prompt).toContain('rejeitado pelo motivo: o arquivo de achados nao segue a estrutura obrigatoria');
    expect(repair.prompt).toContain('Declare os achados ou sua ausência explicitamente.');
    expect(repair.prompt).toContain('Grave relatório com # título');
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0]).toMatchObject({ status: 'ok', autoRetries: 1 });
    expect(run.items[0].attempts.map((a) => a.outcome)).toEqual(['invalid-findings', 'ok']);
    expect(run.items[0].executions.map((e) => `${e.kind}:${e.continuationMode}:${e.mechanism}`)).toEqual([
      'initial:null:null',
      'repair:replay:resend',
    ]);
    expect(run.items[0].executions[1].continuationReason).toContain('Reparo de formato após invalid-findings');
    expect(run.items[0].executions[1].continuationReason).toContain('reenvio de histórico');
    await runner.shutdown();
  });
  it('a failed repair is followed by a full reanalysis from scratch after backoff, with cost and time kept per attempt', async () => {
    const requests: SwarmAttemptExecution[] = [];
    const { runner, deps } = setup({
      execute: vi.fn(async (req) => {
        requests.push(req);
        await req.writeFindings?.(report);
        if (requests.length < 3)
          return withSession(
            {
              ...result(req.slug),
              output: `sem trailer ${requests.length}`,
              metrics: { ...result(req.slug).metrics, costUsd: requests.length, durationMs: 10 * requests.length },
            },
            'sess-1',
          );
        return result(req.slug);
      }),
    });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, maxAttempts: 3 });
    const started = await runner.start(
      { sessionId: 's', swarmEnabled: true, readRoots: [root] },
      input('repair-fails'),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(deps.execute).toHaveBeenCalledTimes(2);
    let run = await runner.getRunState('s', started.runId);
    expect(run.items[0]).toMatchObject({ status: 'retrying', autoRetries: 2, launch: null });
    expect(run.items[0].executions.map((e) => e.kind)).toEqual(['initial', 'repair']);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(11_000);
    await flush();
    expect(deps.execute).toHaveBeenCalledTimes(3);
    expect(requests[2].continuation).toBeUndefined();
    expect(requests[2].prompt).not.toContain('rejeitado pelo motivo');
    expect(requests[2].prompt).not.toContain('BRIEFING ORIGINAL:');
    run = await runner.getRunState('s', started.runId);
    expect(requests[2].prompt.startsWith(run.items[0].prompt)).toBe(true);
    expect(run.items[0]).toMatchObject({ status: 'ok', autoRetries: 2 });
    expect(run.items[0].executions.map((e) => e.kind)).toEqual(['initial', 'repair', 'retry']);
    expect(run.items[0].attempts.map((a) => a.outcome)).toEqual(['bad-trailer', 'bad-trailer', 'ok']);
    expect(run.items[0].attempts.map((a) => a.metrics.costUsd)).toEqual([1, 2, 0.1]);
    expect(run.items[0].attempts.map((a) => a.metrics.durationMs)).toEqual([10, 20, 1]);
    expect(run.items[0].attempts.every((a) => a.endedAt && a.terminationConfirmedAt)).toBe(true);
    await runner.shutdown();
  });
  it('provider quota (LLM-QUOTA) and auth (LLM-AUTH-401) fail the swarm agent at once, without retries, with the provider message and reset time in the run summary', async () => {
    const raw =
      'Claude Code returned an error result: API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-12 21:56:08][2026101217]';
    const { runner, deps, deliver } = setup({
      execute: vi.fn(async (req) => ({
        ...result(req.slug),
        output: '',
        error: {
          code: req.slug === 'lens-0' ? ('LLM-QUOTA' as const) : ('LLM-AUTH-401' as const),
          category: req.slug === 'lens-0' ? ('quota' as const) : ('auth' as const),
          userMessage: req.slug === 'lens-0' ? raw : 'Chave da API inválida.',
          suggestedAction: '',
        },
      })),
    });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, maxAttempts: 3 });
    const started = await runner.start({ sessionId: 's', swarmEnabled: true, readRoots: [root] }, input('quota', 2));
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0]).toMatchObject({ status: 'failed', autoRetries: 0 });
    expect(run.items[0].error).toEqual({
      code: 'LLM-QUOTA',
      message: `Limite de uso do provedor; tente mais tarde ou troque o runtime. Reset previsto: 2026-10-12 21:56:08. Provedor: ${raw}`,
      retryable: false,
    });
    expect(run.items[0].attempts[0].outcome).toBe('provider-error');
    expect(run.items[1]).toMatchObject({ status: 'failed', autoRetries: 0 });
    expect(run.items[1].error).toEqual({ code: 'LLM-AUTH-401', message: 'Chave da API inválida.', retryable: false });
    expect(run.items[1].attempts[0].outcome).toBe('auth-required');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    const envelope = deliver.mock.calls.at(-1)?.[1] as string;
    expect(envelope).toContain(
      '[failed] lens-0 | Limite de uso do provedor; tente mais tarde ou troque o runtime. Reset previsto: 2026-10-12 21:56:08.',
    );
    expect(envelope).toContain('[failed] lens-1 | Chave da API inválida.');
    await runner.shutdown();
  });
});
