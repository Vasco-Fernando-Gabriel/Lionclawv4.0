import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { SwarmAttemptExecution, SwarmResolvedMember } from '../agent-runtime/swarm-adapter';
import {
  SWARM_WAIT_LEASE_MS,
  SWARM_WAIT_MAX_SLICE_MS,
  SwarmRunner,
  type SwarmRunnerDependencies,
} from '../swarm/runner';
import { SwarmArtifacts } from '../swarm/artifacts';
import { DEFAULT_SWARM_SETTINGS, type SwarmStartInput } from '../../../src/types/swarm';
import { createSwarmQueue } from './swarm-queue-fixture';

let root: string;
const resolved: SwarmResolvedMember = {
  runtime: 'cloud',
  model: 'claude-opus-5-5',
  snapshot: { agent: {}, config: {} },
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
    output: `---\nSTATUS: ${status}\n${status === 'needs-input' ? 'QUESTION: Preciso do alvo exato.\n' : ''}SUMMARY: resumo ${slug}\nFINDINGS: ${slug}.md`,
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
      objective: `auditar ${i}`,
      member: { kind: 'registered', agentId: 'swarm-auditor' },
    })),
  };
}
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
type Pending = { req: SwarmAttemptExecution; settle: (r: AgentExecutionResult) => void };
function controllable() {
  const pending: Pending[] = [];
  const execute = (req: SwarmAttemptExecution) =>
    new Promise<AgentExecutionResult>((settle) => {
      pending.push({ req, settle });
      req.abortController.signal.addEventListener('abort', () => settle(result(req.slug, 'failed')), { once: true });
    });
  const finish = async (slug: string, status = 'ok') => {
    const index = pending.findIndex((p) => p.req.slug === slug);
    if (index === -1) throw new Error(`sem execucao pendente para ${slug}`);
    const [entry] = pending.splice(index, 1);
    if (status === 'ok') await entry.req.writeFindings?.(report);
    entry.settle(result(slug, status));
    await flush();
  };
  return { pending, execute, finish };
}
function setup(overrides: Partial<SwarmRunnerDependencies> = {}) {
  const artifacts = new SwarmArtifacts(path.join(root, 'artifacts'));
  const box = createSwarmQueue(['s']);
  const deps: SwarmRunnerDependencies = {
    artifacts,
    resolve: vi.fn(async () => resolved),
    execute: vi.fn(async (req) => {
      await req.writeFindings?.(report);
      return result(req.slug);
    }),
    catalog: async () => ({ members: [], profiles: [], runtimes: [] }),
    readSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
    writeSettings: () => {},
    project: vi.fn(),
    reportError: vi.fn(),
    recoverAttempt: async () => true,
    random: () => 0.5,
    ...box.deps,
    ...overrides,
  };
  return { runner: new SwarmRunner(deps), deps, artifacts, box };
}
const ctx = { sessionId: 's', swarmEnabled: true, readRoots: [] as string[] };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wait-'));
  ctx.readRoots = [root];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Swarm v2 S2: swarm_wait em fatias com reserva atomica (5.3.6, AC-26, AC-30, AC-33, AC-34)', () => {
  it('AC-26: devolve pending com progresso na fatia, question com slug/attemptId, e done com resumos e achados; fatia maxima 50 s', async () => {
    const c = controllable();
    const { runner, artifacts } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('wait', 2));
    await flush();
    const progress: string[] = [];
    const slice = runner.wait({
      ...ctx,
      runId: started.runId,
      waitId: 'turn-1:run',
      turnId: 'turn-1',
      sliceMs: 999_999,
      onProgress: (line) => progress.push(line),
    });
    await vi.advanceTimersByTimeAsync(SWARM_WAIT_MAX_SLICE_MS - 10);
    await c.finish('lens-0');
    await vi.advanceTimersByTimeAsync(20);
    const pending = await slice;
    expect(pending).toMatchObject({ status: 'pending', running: ['lens-1'], finished: ['lens-0'] });
    expect(pending.progress).toBe('1 swarm agent rodando: lens-1; 1 concluido');
    expect(progress).toContain('1 swarm agent rodando: lens-1; 1 concluido');
    const asking = runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    await c.finish('lens-1', 'needs-input');
    const question = await asking;
    expect(question).toMatchObject({
      status: 'question',
      slug: 'lens-1',
      question: 'Preciso do alvo exato.',
    });
    expect('deliveryScheduled' in question).toBe(false);
    expect(question.status === 'question' && question.attemptId).toMatch(/^attempt-1-/);
    const questionRevision = (await runner.getRunState('s', started.runId)).items[1].executions[0].questionRevision!;
    const state = (await runner.getRunState('s', started.runId)).items[1];
    expect(state.status).toBe('waiting');
    const answered = await runner.message(
      's',
      started.runId,
      'lens-1',
      'o alvo e src/ipc',
      question.status === 'question' ? question.attemptId : '',
      { turnId: 'turn-1' },
    );
    expect(answered.accepted).toBe(true);
    const waiting = runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    await flush();
    await c.finish('lens-1');
    const done = await waiting;
    expect(done.status).toBe('done');
    if (done.status !== 'done') throw new Error('esperava done');
    expect(done.deliveryScheduled).toBe(false);
    expect(done.results.map((r) => [r.slug, r.status, r.summary])).toEqual([
      ['lens-0', 'ok', 'resumo lens-0'],
      ['lens-1', 'ok', 'resumo lens-1'],
    ]);
    expect(done.results[0].findings).toBe(report);
    expect(done.results[0].findingsPath).toBe(path.join(artifacts.root, started.runId, 'lens-0.md'));
    expect(questionRevision).toBeGreaterThan(0);
    await runner.shutdown();
  });
  it('AC-30: conclusao consumida pela espera nao gera entrega automatica (a linha nasce reservada e vira consumed-by-turn)', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('consume'));
    await flush();
    const waiting = runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    await flush();
    await c.finish('lens-0');
    const done = await waiting;
    expect(done).toMatchObject({ status: 'done', deliveryScheduled: false, consumedBy: 'turn' });
    const run = await runner.getRunState('s', started.runId);
    expect(box.row(run.runId, 'terminal', run.terminalRevision)).toMatchObject({
      state: 'consumed-by-turn',
      turnId: 'turn-1',
      reservedBy: null,
    });
    expect(box.pump()).toEqual([]);
    const again = await runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    expect(again).toMatchObject({ status: 'done', deliveryScheduled: false, consumedBy: 'delivery' });
    expect(box.pump()).toEqual([]);
    await runner.shutdown();
  });
  it('AC-30: espera interrompida (parar o chat) remove a assinatura, nao aborta a run e preserva a entrega automatica', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('interrupt'));
    await flush();
    const controller = new AbortController();
    const waiting = runner.wait({
      ...ctx,
      runId: started.runId,
      waitId: 'turn-1:run',
      turnId: 'turn-1',
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    expect(await waiting).toMatchObject({ status: 'cancelled', reason: expect.stringMatching(/turno automático/) });
    expect(c.pending).toHaveLength(1);
    expect(c.pending[0].req.abortController.signal.aborted).toBe(false);
    await c.finish('lens-0');
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(box.row(run.runId, 'terminal', run.terminalRevision)).toMatchObject({ state: 'pending', reservedBy: null });
    expect(box.pump().map((r) => r.kind)).toEqual(['terminal']);
    await runner.shutdown();
  });
  it('AC-30: lease expirado (orquestrador nao chamou a proxima fatia) devolve a linha ao pump; nova fatia da mesma espera renova o lease', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('lease'));
    await flush();
    const first = runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1', sliceMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await first).status).toBe('pending');
    await c.finish('lens-0');
    const run = await runner.getRunState('s', started.runId);
    const row = box.row(run.runId, 'terminal', run.terminalRevision)!;
    expect(row).toMatchObject({ state: 'reserved-by-wait', reservedBy: 'turn-1:run' });
    expect(row.leaseUntil).toBe(Date.parse('2026-10-11T12:00:00Z') + SWARM_WAIT_LEASE_MS);
    expect(box.pump()).toEqual([]);
    await vi.advanceTimersByTimeAsync(SWARM_WAIT_LEASE_MS);
    expect(box.pump().map((r) => r.state)).toEqual(['claimed']);
    const late = await runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    expect(late).toMatchObject({ status: 'done', deliveryScheduled: true, consumedBy: null });
    const [claimed] = box.rows().filter((r) => r.state === 'claimed');
    box.markDelivered(claimed);
    expect(box.row(run.runId, 'terminal', run.terminalRevision)?.state).toBe('delivered');
    const old = await runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-7:run', turnId: 'turn-7' });
    expect(old).toMatchObject({ status: 'done', deliveryScheduled: false, consumedBy: 'delivery' });
    await runner.shutdown();
  });
  it('AC-30: pump e espera disputando a mesma conclusao, nas duas ordens, resultam em exatamente uma entrega', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const pumpFirst = await runner.start(ctx, input('pump-first'));
    await flush();
    await c.finish('lens-0');
    let run = await runner.getRunState('s', pumpFirst.runId);
    expect(box.pump().map((r) => `${r.kind}:${r.revision}`)).toEqual([`terminal:${run.terminalRevision}`]);
    const scheduled = await runner.wait({ ...ctx, runId: pumpFirst.runId, waitId: 'turn-2:a', turnId: 'turn-2' });
    expect(scheduled).toMatchObject({ status: 'done', deliveryScheduled: true });
    expect(box.row(run.runId, 'terminal', run.terminalRevision)?.state).toBe('claimed');
    vi.setSystemTime(new Date('2026-10-11T12:01:00Z'));
    const waitFirst = await runner.start(ctx, input('wait-first'));
    await flush();
    const waiting = runner.wait({ ...ctx, runId: waitFirst.runId, waitId: 'turn-3:b', turnId: 'turn-3' });
    await flush();
    await c.finish('lens-0');
    expect(await waiting).toMatchObject({ status: 'done', deliveryScheduled: false });
    run = await runner.getRunState('s', waitFirst.runId);
    expect(box.row(run.runId, 'terminal', run.terminalRevision)?.state).toBe('consumed-by-turn');
    expect(box.pump()).toEqual([]);
    expect(box.list().filter((l) => l.endsWith(':claimed'))).toHaveLength(1);
    await runner.shutdown();
  });
  it('AC-33: pergunta devolvida pela espera fica reservada; turno interrompido antes da resposta devolve a pergunta ao pump com o swarm agent ainda waiting; swarm_message consome', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('question-lease'));
    await flush();
    const controller = new AbortController();
    const waiting = runner.wait({
      ...ctx,
      runId: started.runId,
      waitId: 'turn-1:run',
      turnId: 'turn-1',
      signal: controller.signal,
    });
    await flush();
    await c.finish('lens-0', 'needs-input');
    const question = await waiting;
    expect(question.status).toBe('question');
    if (question.status !== 'question') throw new Error('esperava question');
    const revision = (await runner.getRunState('s', started.runId)).items[0].executions[0].questionRevision!;
    expect(box.row(started.runId, 'question', revision)).toMatchObject({
      state: 'reserved-by-wait',
      reservedBy: 'turn-1:run',
    });
    expect(box.pump()).toEqual([]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(SWARM_WAIT_LEASE_MS + 1000);
    expect((await runner.getRunState('s', started.runId)).items[0].status).toBe('waiting');
    expect(box.pump().map((r) => `${r.kind}:${r.state}`)).toEqual(['question:claimed']);
    expect(runner.questionPending(started.runId, 'lens-0', question.attemptId)).toBe(true);
    vi.setSystemTime(new Date('2026-10-11T12:02:00Z'));
    const second = await runner.start(ctx, input('question-consumed'));
    await flush();
    const asking = runner.wait({ ...ctx, runId: second.runId, waitId: 'turn-2:run', turnId: 'turn-2' });
    await flush();
    await c.finish('lens-0', 'needs-input');
    const asked = await asking;
    if (asked.status !== 'question') throw new Error('esperava question');
    const rev2 = (await runner.getRunState('s', second.runId)).items[0].executions[0].questionRevision!;
    expect(box.row(second.runId, 'question', rev2)?.state).toBe('reserved-by-wait');
    await runner.message('s', second.runId, 'lens-0', 'resposta', asked.attemptId, { turnId: 'turn-2' });
    expect(box.row(second.runId, 'question', rev2)).toMatchObject({ state: 'consumed-by-turn', turnId: 'turn-2' });
    expect(box.pump()).toEqual([]);
    await runner.shutdown();
  });
  it('S2-V5: espera parcial iniciada depois do fim da run nao consome a revisao terminal (done com os slugs e deliveryScheduled)', async () => {
    const { runner, box } = setup();
    await runner.recover();
    const started = await runner.start(ctx, input('partial-late', 2));
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    const partial = await runner.wait({
      ...ctx,
      runId: started.runId,
      waitId: 'turn-9:run',
      turnId: 'turn-9',
      slugs: ['lens-1'],
    });
    expect(partial).toMatchObject({ status: 'done', deliveryScheduled: true, revision: run.terminalRevision });
    if (partial.status !== 'done') throw new Error('esperava done');
    expect(partial.results.map((r) => r.slug)).toEqual(['lens-1']);
    expect(box.row(started.runId, 'terminal', run.terminalRevision)).toMatchObject({
      state: 'pending',
      reservedBy: null,
    });
    const full = await runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-9:run', turnId: 'turn-9' });
    expect(full).toMatchObject({ status: 'done', deliveryScheduled: false });
    expect(box.row(started.runId, 'terminal', run.terminalRevision)?.state).toBe('consumed-by-turn');
    await runner.shutdown();
  });
  it('S2-V12: a entrada da espera some ao devolver done; uma entrega nova da mesma run nasce pendente para o pump', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('entry-gone'));
    await flush();
    const waiting = runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    await flush();
    await c.finish('lens-0');
    expect((await waiting).status).toBe('done');
    await runner.redispatch('s', started.runId, 'lens-0', 'Outra missao');
    await flush();
    await c.finish('lens-0');
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(box.row(started.runId, 'terminal', run.terminalRevision)).toMatchObject({
      state: 'pending',
      reservedBy: null,
    });
    expect(box.pump().map((r) => `${r.kind}:${r.revision}`)).toEqual([`terminal:${run.terminalRevision}`]);
    await runner.shutdown();
  });
  it('AC-34: espera parcial por slugs devolve done sem consumir nada; a entrega final da run chega depois com o segundo', async () => {
    const c = controllable();
    const { runner, box } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('partial', 2));
    await flush();
    const partial = runner.wait({
      ...ctx,
      runId: started.runId,
      waitId: 'turn-1:run',
      turnId: 'turn-1',
      slugs: ['lens-0'],
    });
    await flush();
    await c.finish('lens-0');
    const done = await partial;
    expect(done).toMatchObject({ status: 'done', revision: null, deliveryScheduled: false });
    if (done.status !== 'done') throw new Error('esperava done');
    expect(done.results.map((r) => r.slug)).toEqual(['lens-0']);
    expect(box.list()).toEqual([]);
    expect((await runner.getRunState('s', started.runId)).status).toBe('running');
    await vi.advanceTimersByTimeAsync(SWARM_WAIT_LEASE_MS + 1000);
    await c.finish('lens-1');
    const run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(box.row(run.runId, 'terminal', run.terminalRevision)).toMatchObject({ state: 'pending', reservedBy: null });
    expect(box.pump().map((r) => r.kind)).toEqual(['terminal']);
    await runner.shutdown();
  });
  it('a espera nao bloqueia stop nem finish e um slug desconhecido e recusado', async () => {
    const c = controllable();
    const { runner } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx, input('nonblocking', 2));
    await flush();
    const waiting = runner.wait({ ...ctx, runId: started.runId, waitId: 'turn-1:run', turnId: 'turn-1' });
    await flush();
    expect(await runner.stop('s', started.runId, 'lens-0')).toMatchObject({ changed: true });
    await flush();
    await c.finish('lens-1');
    const done = await waiting;
    expect(done.status).toBe('done');
    if (done.status !== 'done') throw new Error('esperava done');
    expect(done.results.map((r) => r.status)).toEqual(['cancelled', 'ok']);
    await expect(
      runner.wait({ ...ctx, runId: started.runId, waitId: 'x', turnId: 't', slugs: ['nao-existe'] }),
    ).rejects.toMatchObject({ code: 'agent-not-found' });
    await expect(
      runner.wait({ ...ctx, sessionId: 'outro', runId: started.runId, waitId: 'x', turnId: 't' }),
    ).rejects.toMatchObject({ code: 'run-denied' });
    await runner.shutdown();
  });
});
