import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { SwarmAttemptExecution, SwarmResolvedMember } from '../agent-runtime/swarm-adapter';
import { SWARM_RETAINED_TERMINAL_RUNS, SwarmRunner, type SwarmRunnerDependencies } from '../swarm/runner';
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
function harness() {
  const artifacts = new SwarmArtifacts(path.join(root, 'artifacts'));
  const box = createSwarmQueue(['s']);
  const deps = (overrides: Partial<SwarmRunnerDependencies> = {}): SwarmRunnerDependencies => ({
    artifacts,
    resolve: vi.fn(async () => resolved),
    execute: vi.fn(async (req: SwarmAttemptExecution) => {
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
  });
  return { artifacts, box, deps };
}
const errorsOf = (d: SwarmRunnerDependencies) =>
  (d.reportError as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${String(c[0]?.message ?? c[0])} | ${c[1]}`);
const ctx = { sessionId: 's', swarmEnabled: true, readRoots: [] as string[] };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-boot-'));
  ctx.readRoots = [root];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Gate final GA-1/GB-1: boot com a fila real em SQLite nao reenfileira nem entra em laco', () => {
  it('run fechada pela janela (open -> done): o boot nao reenfileira a linha terminal, nao loga erro e o ticker nao repete', async () => {
    const h = harness();
    const first = h.deps();
    const runner = new SwarmRunner(first);
    await runner.recover();
    const { runId } = await runner.start(ctx, input('closed'));
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    let run = await runner.getRunState('s', runId);
    expect(run.status).toBe('open');
    const row = h.box.row(runId, 'terminal', run.terminalRevision)!;
    expect(row).toMatchObject({ state: 'pending', runStatus: 'open' });
    const [claimed] = h.box.pump();
    h.box.markDelivered(claimed);
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.openWindowMs + 5_000);
    await flush();
    run = await runner.getRunState('s', runId);
    expect(run.status).toBe('done');
    expect(run.delivery).toEqual({ status: 'delivered', error: null });
    expect(errorsOf(first)).toEqual([]);
    await runner.shutdown();

    vi.setSystemTime(new Date('2026-10-11T14:00:00Z'));
    const second = h.deps();
    const deliver = vi.fn(h.box.deps.deliver);
    const restarted = new SwarmRunner({ ...second, deliver });
    await restarted.recover();
    expect(errorsOf(second)).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(h.box.list()).toEqual([`terminal:${run.terminalRevision}:delivered`]);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(errorsOf(second)).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    const after = await restarted.getRunState('s', runId);
    expect(after.status).toBe('done');
    expect(after.deliveryError).toBeNull();
    expect(after.delivery).toEqual({ status: 'delivered', error: null });
    expect(h.artifacts.load(runId).revision).toBe(run.revision);
    await restarted.shutdown();
  });
  it('run open no boot continua open com a janela recomecada, a linha pendente fica unica e o pump a entrega depois', async () => {
    const h = harness();
    const first = h.deps();
    const runner = new SwarmRunner(first);
    await runner.recover();
    const { runId } = await runner.start(ctx, input('open'));
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    const before = await runner.getRunState('s', runId);
    expect(before.status).toBe('open');
    expect(h.box.list()).toEqual([`terminal:${before.terminalRevision}:pending`]);

    vi.setSystemTime(new Date('2026-10-11T13:00:00Z'));
    const second = h.deps();
    const deliver = vi.fn(h.box.deps.deliver);
    const restarted = new SwarmRunner({ ...second, deliver });
    await restarted.recover();
    const after = await restarted.getRunState('s', runId);
    expect(after.status).toBe('open');
    expect(after.openedAt).toBe('2026-10-11T13:00:00.000Z');
    expect(after.terminalRevision).toBe(before.terminalRevision);
    expect(deliver).not.toHaveBeenCalled();
    expect(errorsOf(second)).toEqual([]);
    expect(h.box.list()).toEqual([`terminal:${before.terminalRevision}:pending`]);
    expect(h.box.pump().map((r) => `${r.kind}:${r.revision}:${r.state}`)).toEqual([
      `terminal:${before.terminalRevision}:claimed`,
    ]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(errorsOf(second)).toEqual([]);
    await runner.shutdown();
    await restarted.shutdown();
  });
  it('run com pergunta pendente na fila no boot: a linha nao e duplicada, um claim em voo volta a pending e o idle so comeca quando o pump entrega', async () => {
    const h = harness();
    const first = h.deps({ execute: vi.fn(async (req) => result(req.slug, 'needs-input')) });
    const runner = new SwarmRunner(first);
    await runner.recover();
    const { runId } = await runner.start(ctx, input('asked'));
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    const before = await runner.getRunState('s', runId);
    expect(before.items[0].status).toBe('waiting');
    expect(before.items[0].lastSignalAt).toBeNull();
    const revision = before.items[0].executions[0].questionRevision!;
    expect(h.box.pump().map((r) => r.state)).toEqual(['claimed']);

    vi.setSystemTime(new Date('2026-10-11T13:00:00Z'));
    expect(h.box.recoverClaims()).toBe(1);
    const second = h.deps({ execute: vi.fn() });
    const deliver = vi.fn(h.box.deps.deliver);
    const restarted = new SwarmRunner({ ...second, deliver });
    await restarted.recover();
    const after = await restarted.getRunState('s', runId);
    expect(after.items[0]).toMatchObject({ status: 'waiting', lastSignalAt: null });
    expect(after.items[0].executions[0].questionRevision).toBe(revision);
    expect(deliver).not.toHaveBeenCalled();
    expect(errorsOf(second)).toEqual([]);
    expect(h.box.list()).toEqual([`question:${revision}:pending`]);
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.idleTimeoutMs + 5_000);
    await flush();
    expect((await restarted.getRunState('s', runId)).items[0].status).toBe('waiting');
    const [claimed] = h.box.pump();
    expect(claimed).toMatchObject({ kind: 'question', revision, slug: 'lens-0' });
    expect(await restarted.questionDelivered(runId, 'lens-0', after.items[0].currentAttemptId!)).toBe(true);
    expect((await restarted.getRunState('s', runId)).items[0].lastSignalAt).toBe(new Date().toISOString());
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.idleTimeoutMs + 2_500);
    await flush();
    expect((await restarted.getRunState('s', runId)).items[0]).toMatchObject({ status: 'failed' });
    expect(errorsOf(second)).toEqual([]);
    await restarted.shutdown();
  });
});

describe('Gate final GB-2: dois swarm agents waiting no boot (AC-31)', () => {
  it('cada pergunta reentregue recebe questionRevision propria, persistida em sequencia; as duas linhas nascem na fila real sem conflito', async () => {
    const h = harness();
    const first = h.deps({ execute: vi.fn(async (req) => result(req.slug, 'needs-input')) });
    const runner = new SwarmRunner(first);
    await runner.recover();
    const { runId } = await runner.start(ctx, input('two-questions', 2));
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    const before = await runner.getRunState('s', runId);
    expect(before.items.map((i) => i.status)).toEqual(['waiting', 'waiting']);
    const firstRevisions = before.items.map((i) => i.executions[0].questionRevision!);
    expect(new Set(firstRevisions).size).toBe(2);
    for (const claimed of h.box.pump()) h.box.markDelivered(claimed);
    expect(h.box.rows().map((r) => r.state)).toEqual(['delivered', 'delivered']);

    vi.setSystemTime(new Date('2026-10-11T13:00:00Z'));
    const second = h.deps({ execute: vi.fn() });
    const deliver = vi.fn(h.box.deps.deliver);
    const restarted = new SwarmRunner({ ...second, deliver });
    await restarted.recover();
    const after = await restarted.getRunState('s', runId);
    const revisions = after.items.map((i) => i.executions[0].questionRevision!);
    expect(new Set(revisions).size).toBe(2);
    expect(Math.max(...revisions)).toBe(after.revision);
    expect(revisions.every((r) => r > Math.max(...firstRevisions))).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(errorsOf(second)).toEqual([]);
    const rows = revisions.map((revision) => h.box.row(runId, 'question', revision)!);
    expect(rows.map((r) => [r.slug, r.state, r.attemptId])).toEqual([
      ['lens-0', 'pending', after.items[0].currentAttemptId],
      ['lens-1', 'pending', after.items[1].currentAttemptId],
    ]);
    expect(h.box.rows()).toHaveLength(4);
    expect(h.box.pump().map((r) => r.slug)).toEqual(['lens-0', 'lens-1']);
    for (const item of after.items)
      expect(restarted.questionPending(runId, item.slug, item.currentAttemptId!)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(errorsOf(second)).toEqual([]);
    await restarted.shutdown();
  });
});

describe('Gate final GB-6: poda de runs em RAM', () => {
  it(`mantem em memoria as runs vivas e as ${SWARM_RETAINED_TERMINAL_RUNS} terminais mais recentes; as demais vem do disco sob demanda e o requestId continua idempotente`, async () => {
    const h = harness();
    const d = h.deps();
    const runner = new SwarmRunner(d);
    await runner.recover();
    const closed: string[] = [];
    for (let i = 0; i < SWARM_RETAINED_TERMINAL_RUNS + 5; i++) {
      vi.setSystemTime(new Date(Date.parse('2026-10-11T12:00:00Z') + i * 1_000));
      const { runId } = await runner.start(ctx, input(`req-${i}`));
      await flush();
      expect((await runner.abort('s', runId)).status).toBe('done');
      closed.push(runId);
    }
    expect(runner.retainedRunCount).toBe(SWARM_RETAINED_TERMINAL_RUNS);
    const oldest = closed[0];
    const state = await runner.getRunState('s', oldest);
    expect(state.status).toBe('done');
    expect((await runner.read('s', oldest, 'lens-0')).status).toBe('ok');
    expect(await runner.start(ctx, input('req-0'))).toEqual({ runId: oldest, status: 'done' });
    expect(runner.retainedRunCount).toBe(SWARM_RETAINED_TERMINAL_RUNS);
    expect((await runner.abort('s', oldest)).status).toBe('done');
    await expect(runner.message('s', oldest, 'lens-0', 'oi')).rejects.toMatchObject({ code: 'run_closed' });
    const live = await runner.start(ctx, input('live'));
    expect(runner.retainedRunCount).toBe(SWARM_RETAINED_TERMINAL_RUNS + 1);
    await flush();
    expect((await runner.getRunState('s', live.runId)).status).toBe('open');
    expect((await runner.listRuns('s', undefined, 50)).runs).toHaveLength(SWARM_RETAINED_TERMINAL_RUNS + 6);
    expect(errorsOf(d)).toEqual([]);
    await runner.shutdown();

    const d2 = h.deps();
    const restarted = new SwarmRunner(d2);
    await restarted.recover();
    expect(restarted.retainedRunCount).toBe(SWARM_RETAINED_TERMINAL_RUNS + 1);
    expect((await restarted.getRunState('s', oldest)).status).toBe('done');
    expect(await restarted.start(ctx, input('req-0'))).toEqual({ runId: oldest, status: 'done' });
    expect(errorsOf(d2)).toEqual([]);
    await restarted.shutdown();
  });
});
