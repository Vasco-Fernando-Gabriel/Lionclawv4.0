import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { SwarmAttemptExecution, SwarmAttemptResult, SwarmResolvedMember } from '../agent-runtime/swarm-adapter';
import { SwarmRunner, type SwarmRunnerDependencies } from '../swarm/runner';
import { SwarmArtifacts } from '../swarm/artifacts';
import { DEFAULT_SWARM_SETTINGS, type SwarmRuntime, type SwarmStartInput } from '../../../src/types/swarm';

let root: string;
function resolvedFor(runtime: SwarmRuntime): SwarmResolvedMember {
  return {
    runtime,
    model: 'modelo',
    snapshot: { agent: { name: 'Swarm Auditor', description: 'generico' }, config: { model: 'modelo' } },
    agent: { name: 'Swarm Auditor', description: 'generico' } as AgentConfig,
    config: {} as AgentQueryConfig,
  };
}
const report =
  '# Auditoria\n## Resumo\nVerificado.\n## Achados\nNenhum achado.\n## Fora de escopo / não verificado\nNão executei o app.\n';
function result(slug: string, sessionId: string | null, body = ''): SwarmAttemptResult {
  return {
    runtime: 'cloud',
    model: 'modelo',
    provider: 'test',
    output: `${body}---\nSTATUS: ok\nSUMMARY: análise concluída\nFINDINGS: ${slug}.md`,
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
    ...(sessionId ? { metadata: { sessionIds: [sessionId] } } : {}),
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
      objective: `auditar ${i}`,
      member: { kind: 'registered', agentId: 'swarm-auditor' },
    })),
  };
}
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
type Pending = { req: SwarmAttemptExecution; settle: (r: SwarmAttemptResult) => void; fail: (e: unknown) => void };
function controllable() {
  const pending: Pending[] = [];
  const execute = (req: SwarmAttemptExecution) =>
    new Promise<SwarmAttemptResult>((settle, fail) => {
      const entry = { req, settle, fail };
      pending.push(entry);
      req.abortController.signal.addEventListener('abort', () => fail(new Error('abortado')), { once: true });
    });
  const take = (slug: string) => {
    const index = pending.findIndex((p) => p.req.slug === slug);
    if (index === -1) throw new Error(`sem execucao pendente para ${slug}`);
    return pending.splice(index, 1)[0];
  };
  return { pending, execute, take };
}
function setup(overrides: Partial<SwarmRunnerDependencies> = {}, runtime: SwarmRuntime = 'cloud') {
  const artifacts = new SwarmArtifacts(path.join(root, 'artifacts'));
  const deliver = vi.fn();
  const closeSession = vi.fn(async () => {});
  const settings = { ...DEFAULT_SWARM_SETTINGS };
  const deps: SwarmRunnerDependencies = {
    artifacts,
    resolve: vi.fn(async () => resolvedFor(runtime)),
    execute: vi.fn(async (req) => {
      await req.writeFindings?.(report);
      return result(req.slug, `sess-${req.slug}`);
    }),
    closeSession,
    catalog: async () => ({ members: [], profiles: [], runtimes: [] }),
    readSettings: () => settings,
    writeSettings: (s) => Object.assign(settings, s),
    project: vi.fn(),
    deliver,
    reportError: vi.fn(),
    recoverAttempt: async () => true,
    random: () => 0.5,
    contextBudget: () => 100_000,
    ...overrides,
  };
  return { runner: new SwarmRunner(deps), deps, artifacts, deliver, closeSession, settings };
}
const ctx = (sessionId = 's') => ({ sessionId, swarmEnabled: true, readRoots: [root] });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-session-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Swarm v2 S3: retomada de sessao no runner (5.3.4, 5.3.7)', () => {
  it('AC-11: a primeira execucao guarda o sessionId no manifesto; swarm_message continua pela sessao com prompt curto; dois swarm agents no mesmo cwd nao trocam de sessao', async () => {
    const c = controllable();
    const { runner, artifacts } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('resume', 2));
    await flush();
    for (const slug of ['lens-0', 'lens-1']) {
      const first = c.take(slug);
      expect(first.req.continuation).toBeUndefined();
      expect(first.req.generation).toBe(1);
      await first.req.writeFindings?.(report);
      first.settle(result(slug, `sess-${slug}`, 'Primeira analise.\n'));
    }
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items.map((i) => i.session)).toEqual([
      { runtime: 'cloud', id: 'sess-lens-0', attemptId: run.items[0].attempts[0].id, generation: 1 },
      { runtime: 'cloud', id: 'sess-lens-1', attemptId: run.items[1].attempts[0].id, generation: 1 },
    ]);
    const firstAttemptId = run.items[0].attempts[0].id;
    const sent = await runner.message('s', started.runId, 'lens-1', 'foque na pasta ipc');
    await runner.message('s', started.runId, 'lens-0', 'ignore a pasta vendor');
    await flush();
    const second1 = c.take('lens-1');
    const second0 = c.take('lens-0');
    expect(second1.req.continuation).toMatchObject({ session: { id: 'sess-lens-1', generation: 1 } });
    expect(second0.req.continuation).toMatchObject({ session: { id: 'sess-lens-0', generation: 1 } });
    expect(second0.req.prompt).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\nignore a pasta vendor');
    expect(second0.req.prompt).toContain('continuacao da sua sessao anterior');
    expect(second0.req.prompt).toContain('Continue de onde parou');
    expect(second0.req.prompt).toContain('Grave relatório com # título');
    expect(second0.req.prompt).not.toContain('BRIEFING ORIGINAL');
    expect(second0.req.prompt).not.toContain('Primeira analise.');
    expect(second0.req.continuation?.fallbackPrompt).toContain('BRIEFING ORIGINAL:');
    expect(second0.req.continuation?.fallbackPrompt).toContain('Primeira analise.');
    expect(second0.req.continuation?.fallbackPrompt).toContain('Grave relatório com # título');
    expect(second0.req.findingsPath).not.toBe(first0Path(run));
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].executions.at(-1)).toMatchObject({
      kind: 'continuation',
      continuationMode: 'session',
      continuationReason: null,
      mechanism: 'session',
    });
    await second0.req.writeFindings?.(report);
    second0.settle({
      ...result('lens-0', 'sess-lens-0', 'Segunda analise.\n'),
      continuation: { mode: 'session', reason: null },
    });
    await second1.req.writeFindings?.(report);
    second1.settle({ ...result('lens-1', 'sess-lens-1'), continuation: { mode: 'session', reason: null } });
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].session).toEqual({
      runtime: 'cloud',
      id: 'sess-lens-0',
      attemptId: firstAttemptId,
      generation: 1,
    });
    expect(run.items[1].session?.id).toBe('sess-lens-1');
    const read = await runner.read('s', started.runId, 'lens-0');
    expect(read.continuation).toEqual({ mode: 'session', reason: null });
    expect(read.finalText).toContain('Segunda analise.');
    const records = artifacts.readMessages(started.runId, 'lens-0');
    expect(records.map((r) => r.kind)).toEqual(['message', 'response']);
    expect(records[1]).toMatchObject({ mechanism: 'session', costUsd: 0.1 });
    expect(sent.messageId).toBeTruthy();
    await runner.shutdown();
    function first0Path(r: typeof run): string {
      return artifacts.attemptPath(r.runId, 'lens-0', r.items[0].attempts[0].id);
    }
  });
  it('AC-11: quando o SDK recusa a sessao, a execucao cai no reenvio e o manifesto marca replay com o motivo; a nova sessao substitui a antiga', async () => {
    const c = controllable();
    const { runner } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('refused'));
    await flush();
    const first = c.take('lens-0');
    await first.req.writeFindings?.(report);
    first.settle(result('lens-0', 'sess-antiga'));
    await flush();
    await runner.message('s', started.runId, 'lens-0', 'continue');
    await flush();
    const second = c.take('lens-0');
    expect(second.req.continuation?.session.id).toBe('sess-antiga');
    await second.req.writeFindings?.(report);
    second.settle({
      ...result('lens-0', 'sess-nova'),
      continuation: { mode: 'replay', reason: 'Sessao recusada pelo runtime cloud: No conversation found' },
    });
    await flush();
    const run = await runner.getRunState('s', started.runId);
    const execution = run.items[0].executions.at(-1)!;
    expect(execution).toMatchObject({
      kind: 'continuation',
      continuationMode: 'replay',
      continuationReason: 'Sessao recusada pelo runtime cloud: No conversation found',
      mechanism: 'resend',
    });
    expect(run.items[0].session).toEqual({
      runtime: 'cloud',
      id: 'sess-nova',
      attemptId: run.items[0].attempts[1].id,
      generation: 1,
    });
    expect((await runner.read('s', started.runId, 'lens-0')).continuation).toEqual({
      mode: 'replay',
      reason: 'Sessao recusada pelo runtime cloud: No conversation found',
    });
    await runner.message('s', started.runId, 'lens-0', 'de novo');
    await flush();
    expect(c.take('lens-0').req.continuation?.session.id).toBe('sess-nova');
    await runner.shutdown();
  });
  it('sessao recusada sem reenvio possivel (historico excede o contexto) termina em context-overflow sem retentativa e descarta a sessao', async () => {
    const c = controllable();
    const { runner } = setup({ execute: c.execute, contextBudget: () => 10 });
    await runner.recover();
    const started = await runner.start(ctx(), input('lost'));
    await flush();
    const first = c.take('lens-0');
    await first.req.writeFindings?.(report);
    first.settle(result('lens-0', 'sess-1'));
    await flush();
    await runner.message('s', started.runId, 'lens-0', 'continue');
    await flush();
    const second = c.take('lens-0');
    expect(second.req.continuation).toEqual({
      session: { runtime: 'cloud', id: 'sess-1', attemptId: expect.any(String), generation: 1 },
      fallbackPrompt: null,
    });
    second.fail(Object.assign(new Error('Sessao recusada. Reenvio impossivel.'), { code: 'session-lost' }));
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0]).toMatchObject({ status: 'failed', autoRetries: 0, session: null });
    expect(run.items[0].error).toMatchObject({ code: 'context-overflow', retryable: false });
    expect(run.items[0].attempts.at(-1)?.outcome).toBe('context-overflow');
    expect(run.items[0].sessionLostReason).toContain('Reenvio impossivel');
    expect(run.status).toBe('open');
    await runner.shutdown();
  });
  it('runtime sem retomada (kimi) nunca guarda sessao: a continuacao e replay com o motivo do runtime', async () => {
    const c = controllable();
    const { runner } = setup({ execute: c.execute }, 'kimi');
    await runner.recover();
    const started = await runner.start(ctx(), input('kimi'));
    await flush();
    const first = c.take('lens-0');
    await first.req.writeFindings?.(report);
    first.settle({ ...result('lens-0', 'sess-ignorada'), runtime: 'kimi' });
    await flush();
    expect((await runner.getRunState('s', started.runId)).items[0].session).toBeNull();
    await runner.message('s', started.runId, 'lens-0', 'continue');
    await flush();
    const second = c.take('lens-0');
    expect(second.req.continuation).toBeUndefined();
    expect(second.req.prompt).toContain('BRIEFING ORIGINAL:');
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0].executions.at(-1)).toMatchObject({
      continuationMode: 'replay',
      continuationReason: 'Runtime kimi sem retomada de sessão; reenvio de histórico.',
      mechanism: 'resend',
    });
    await runner.shutdown();
  });
  it('5.3.7: no boot as sessoes vivas sao perdidas; a proxima mensagem cai no reenvio com motivo "reinicio"', async () => {
    const { runner, deps, artifacts } = setup();
    await runner.recover();
    const started = await runner.start(ctx(), input('boot'));
    await flush();
    expect(artifacts.load(started.runId).items[0].session?.id).toBe('sess-lens-0');
    await runner.shutdown();
    const c = controllable();
    const restarted = new SwarmRunner({ ...deps, execute: c.execute });
    await restarted.recover();
    const after = artifacts.load(started.runId);
    expect(after.status).toBe('open');
    expect(after.items[0].session).toBeNull();
    expect(after.items[0].sessionLostReason).toBe('Sessão perdida por reinício do aplicativo; reenvio de histórico.');
    await restarted.message('s', started.runId, 'lens-0', 'continue depois do boot');
    await flush();
    const next = c.take('lens-0');
    expect(next.req.continuation).toBeUndefined();
    expect(next.req.prompt).toContain('BRIEFING ORIGINAL:');
    const run = await restarted.getRunState('s', started.runId);
    expect(run.items[0].executions.at(-1)).toMatchObject({
      continuationMode: 'replay',
      continuationReason: 'Sessão perdida por reinício do aplicativo; reenvio de histórico.',
    });
    expect((await restarted.read('s', started.runId, 'lens-0')).continuation?.reason).toContain('reinício');
    await next.req.writeFindings?.(report);
    next.settle(result('lens-0', 'sess-pos-boot'));
    await flush();
    expect((await restarted.getRunState('s', started.runId)).items[0].session?.id).toBe('sess-pos-boot');
    await restarted.shutdown();
  });
  it('5.3.7: a recuperacao confere tambem o marcador da tentativa que abriu a sessao viva', async () => {
    const c = controllable();
    const { runner, deps, artifacts } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('marker'));
    await flush();
    const first = c.take('lens-0');
    await first.req.writeFindings?.(report);
    first.settle(result('lens-0', 'sess-1'));
    await flush();
    await runner.message('s', started.runId, 'lens-0', 'continue');
    await flush();
    c.take('lens-0');
    const snapshot = artifacts.load(started.runId);
    expect(snapshot.items[0].status).toBe('running');
    expect(snapshot.items[0].attempts).toHaveLength(2);
    const recoverAttempt = vi.fn(async () => true);
    const restarted = new SwarmRunner({ ...deps, execute: vi.fn(), recoverAttempt });
    await restarted.recover();
    expect(recoverAttempt).toHaveBeenCalledTimes(2);
    expect(
      recoverAttempt.mock.calls.map((call) => (call as unknown as [unknown, unknown, { id: string }])[2].id),
    ).toEqual([snapshot.items[0].attempts[1].id, snapshot.items[0].attempts[0].id]);
    const after = artifacts.load(started.runId);
    expect(after.items[0]).toMatchObject({ status: 'failed', session: null });
    await restarted.shutdown();
    await runner.shutdown();
  });
  it('AC-12: a sessao do swarm agent fecha no stop, no redispatch (nova geracao = sessao nova), no fim da run e no abort', async () => {
    const c = controllable();
    const { runner, closeSession, artifacts } = setup({ execute: c.execute }, 'codex');
    await runner.recover();
    const started = await runner.start(ctx(), input('codex', 3));
    await flush();
    for (const slug of ['lens-0', 'lens-1', 'lens-2']) {
      const first = c.take(slug);
      await first.req.writeFindings?.(report);
      first.settle({ ...result(slug, `thread-${slug}`), runtime: 'codex' });
    }
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.items.every((i) => i.session?.runtime === 'codex')).toBe(true);
    expect(closeSession).not.toHaveBeenCalled();
    await runner.message('s', started.runId, 'lens-0', 'continue');
    await flush();
    const live = c.take('lens-0');
    expect(live.req.continuation?.session.id).toBe('thread-lens-0');
    await runner.stop('s', started.runId, 'lens-0');
    await flush();
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect((closeSession.mock.calls[0] as unknown as [unknown, { slug: string }])[1].slug).toBe('lens-0');
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0]).toMatchObject({ status: 'cancelled', session: null });
    await runner.redispatch('s', started.runId, 'lens-1', 'Outra lente');
    await flush();
    expect(closeSession).toHaveBeenCalledTimes(2);
    const redispatched = c.take('lens-1');
    expect(redispatched.req.continuation).toBeUndefined();
    expect(redispatched.req.generation).toBe(2);
    run = await runner.getRunState('s', started.runId);
    expect(run.items[1].session).toBeNull();
    await redispatched.req.writeFindings?.(report);
    redispatched.settle({ ...result('lens-1', 'thread-g2'), runtime: 'codex' });
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[1].session).toEqual({
      runtime: 'codex',
      id: 'thread-g2',
      attemptId: run.items[1].attempts[1].id,
      generation: 2,
    });
    await runner.message('s', started.runId, 'lens-1', 'segue na geracao 2');
    await flush();
    const gen2 = c.take('lens-1');
    expect(gen2.req.continuation?.session).toMatchObject({ id: 'thread-g2', generation: 2 });
    await gen2.req.writeFindings?.(report);
    gen2.settle({
      ...result('lens-1', 'thread-g2'),
      runtime: 'codex',
      continuation: { mode: 'session', reason: null },
    });
    await flush();
    expect(closeSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.openWindowMs + 2500);
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('partial');
    expect(closeSession).toHaveBeenCalledTimes(5);
    expect(
      closeSession.mock.calls
        .slice(2)
        .map((call) => (call as unknown as [unknown, { slug: string }])[1].slug)
        .sort(),
    ).toEqual(['lens-0', 'lens-1', 'lens-2']);
    expect(artifacts.load(started.runId).items.every((i) => i.session === null)).toBe(true);
    const other = await runner.start(ctx(), input('codex-abort', 2));
    await flush();
    const a = c.take('lens-0');
    await a.req.writeFindings?.(report);
    a.settle({ ...result('lens-0', 'thread-a'), runtime: 'codex' });
    await flush();
    await runner.abort('s', other.runId);
    await flush();
    expect(closeSession.mock.calls.slice(5).map((call) => (call as unknown as [{ runId: string }])[0].runId)).toEqual([
      other.runId,
      other.runId,
    ]);
    await runner.shutdown();
  });
  it('S3-V2: o fechamento da run fecha a sessao de TODO swarm agent, inclusive o que falhou sem registrar sessao; o shutdown fecha runs open', async () => {
    const c = controllable();
    const { runner, closeSession } = setup({ execute: c.execute }, 'codex');
    await runner.recover();
    const started = await runner.start(ctx(), input('close-all', 2));
    await flush();
    const bad = c.take('lens-0');
    bad.fail(new Error('turno falhou'));
    const good = c.take('lens-1');
    await good.req.writeFindings?.(report);
    good.settle({ ...result('lens-1', 'thread-good'), runtime: 'codex' });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    const retry = c.take('lens-0');
    retry.fail(new Error('turno falhou de novo'));
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0]).toMatchObject({ status: 'failed', session: null });
    expect(run.items[1].session?.id).toBe('thread-good');
    expect(closeSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.openWindowMs + 2500);
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('partial');
    expect(closeSession.mock.calls.map((call) => (call as unknown as [unknown, { slug: string }])[1].slug)).toEqual([
      'lens-0',
      'lens-1',
    ]);
    const second = await runner.start(ctx(), input('shutdown-open', 2));
    await flush();
    for (const slug of ['lens-0', 'lens-1']) {
      const live = c.take(slug);
      await live.req.writeFindings?.(report);
      live.settle({ ...result(slug, `thread-${slug}`), runtime: 'codex' });
    }
    await flush();
    expect((await runner.getRunState('s', second.runId)).status).toBe('open');
    await runner.shutdown();
    expect(
      closeSession.mock.calls
        .slice(2)
        .map((call) => (call as unknown as [{ runId: string }, { slug: string }])[1].slug)
        .sort(),
    ).toEqual(['lens-0', 'lens-1']);
    expect(
      closeSession.mock.calls
        .slice(2)
        .every((call) => (call as unknown as [{ runId: string }])[0].runId === second.runId),
    ).toBe(true);
  });
  it('S3-V4: a retentativa automatica de uma continuacao nao retoma a sessao (cai no reenvio) e toda resposta de continuacao entra em messages.jsonl', async () => {
    const c = controllable();
    const { runner, artifacts, closeSession } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('retry-replay'));
    await flush();
    const first = c.take('lens-0');
    await first.req.writeFindings?.(report);
    first.settle(result('lens-0', 'sess-1'));
    await flush();
    const sent = await runner.message('s', started.runId, 'lens-0', 'continue');
    await flush();
    const bySession = c.take('lens-0');
    expect(bySession.req.continuation?.session.id).toBe('sess-1');
    bySession.settle({
      ...result('lens-0', 'sess-1'),
      output: 'conexao caiu no meio',
      error: { code: 'LLM-NET', category: 'network', userMessage: 'Rede indisponível.', suggestedAction: '' },
      continuation: { mode: 'session', reason: null },
    });
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.items[0]).toMatchObject({ status: 'retrying', autoRetries: 1, session: null });
    expect(run.items[0].launch).toMatchObject({ kind: 'continuation', mode: 'replay', messageId: sent.messageId });
    expect(run.items[0].sessionLostReason).toContain('Retentativa automática');
    expect(closeSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    const retried = c.take('lens-0');
    expect(retried.req.continuation).toBeUndefined();
    expect(retried.req.prompt).toContain('BRIEFING ORIGINAL:');
    expect(retried.req.prompt).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\ncontinue');
    await retried.req.writeFindings?.(report);
    retried.settle(result('lens-0', 'sess-2', 'Resposta da retentativa.\n'));
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('ok');
    expect(run.items[0].executions.map((e) => `${e.kind}:${e.continuationMode}`)).toEqual([
      'initial:null',
      'continuation:session',
      'retry:replay',
    ]);
    expect(run.items[0].executions[2].messageId).toBe(sent.messageId);
    expect(run.items[0].executions[2].continuationReason).toContain('Retentativa automática');
    expect(run.items[0].session?.id).toBe('sess-2');
    const records = artifacts.readMessages(started.runId, 'lens-0');
    expect(records.map((r) => `${r.kind}:${r.mechanism ?? ''}`)).toEqual([
      'message:',
      'response:session',
      'response:resend',
    ]);
    expect(records[2].text).toContain('Resposta da retentativa.');
    await runner.shutdown();
  });
});
