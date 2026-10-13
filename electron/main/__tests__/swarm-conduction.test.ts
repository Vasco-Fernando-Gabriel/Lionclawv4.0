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
import { clearProbedContextWindows, setProbedContextWindows } from '../agent-runtime/model-context-windows';
import { swarmContextBudgetChars, swarmContextWindowTokens } from '../swarm/continuation';
import { createSwarmQueue } from './swarm-queue-fixture';

let root: string;
const resolved: SwarmResolvedMember = {
  runtime: 'cloud',
  model: 'claude-opus-5-5',
  snapshot: { agent: { name: 'Swarm Auditor', description: 'generico' }, config: { model: 'claude-opus-5-5' } },
  agent: { name: 'Swarm Auditor', description: 'generico' } as AgentConfig,
  config: {} as AgentQueryConfig,
};
const report =
  '# Auditoria\n## Resumo\nVerificado.\n## Achados\nNenhum achado.\n## Fora de escopo / não verificado\nNão executei o app.\n';
function trailer(slug: string, status = 'ok', extra = ''): string {
  return `${extra}---\nSTATUS: ${status}\n${status === 'needs-input' ? 'QUESTION: Qual branch devo auditar?\n' : ''}SUMMARY: análise concluída\nFINDINGS: ${slug}.md`;
}
function result(slug: string, status = 'ok', body = ''): AgentExecutionResult {
  return {
    runtime: 'cloud',
    model: 'test',
    provider: 'test',
    output: `${body}${trailer(slug, status)}`,
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
function input(requestId: string, n = 1, extra: Partial<SwarmStartInput> = {}): SwarmStartInput {
  return {
    requestId,
    cwd: root,
    objective: 'Auditar',
    mode: 'comite',
    target: 'alvo.ts',
    members: Array.from({ length: n }, (_, i) => ({
      slug: `lens-${i}`,
      objective: `auditar ${i}`,
      lens: `lente ${i}`,
      member: { kind: 'registered', agentId: 'swarm-auditor' },
    })),
    ...extra,
  } as SwarmStartInput;
}
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
type Pending = { req: SwarmAttemptExecution; settle: (r: AgentExecutionResult) => void; fail: (e: unknown) => void };
function controllable() {
  const pending: Pending[] = [];
  const execute = (req: SwarmAttemptExecution) =>
    new Promise<AgentExecutionResult>((settle, fail) => {
      const entry = { req, settle, fail };
      pending.push(entry);
      req.abortController.signal.addEventListener('abort', () => settle(result(req.slug, 'failed')), { once: true });
    });
  const take = (slug: string) => {
    const index = pending.findIndex((p) => p.req.slug === slug);
    if (index === -1) throw new Error(`sem execucao pendente para ${slug}`);
    return pending.splice(index, 1)[0];
  };
  return { pending, execute, take };
}
function setup(overrides: Partial<SwarmRunnerDependencies> = {}) {
  const artifacts = new SwarmArtifacts(path.join(root, 'artifacts'));
  const box = createSwarmQueue(['s']);
  const deliver = vi.fn(box.deps.deliver);
  const cancelDelivery = vi.fn(box.deps.cancelDelivery!);
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
    ...box.deps,
    deliver,
    cancelDelivery,
    reportError: vi.fn(),
    recoverAttempt: async () => true,
    random: () => 0.5,
    ...overrides,
  };
  return { runner: new SwarmRunner(deps), deps, artifacts, deliver, cancelDelivery, settings, box };
}
const ctx = (sessionId = 's') => ({ sessionId, swarmEnabled: true, readRoots: [root] });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-conduction-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Swarm v2 S2: conducao no meio da run (5.3.2, 5.3.3)', () => {
  it('AC-6: swarm_read devolve o parcial em execucao, depois o texto final e os achados, e nunca conteudo de outro chat', async () => {
    const c = controllable();
    const { runner, artifacts } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('read'));
    await flush();
    const live = c.take('lens-0');
    live.req.onText?.('lendo o arquivo A');
    const partial = await runner.read('s', started.runId, 'lens-0');
    expect(partial).toMatchObject({ status: 'running', partial: 'lendo o arquivo A', finalText: null, findings: null });
    await expect(runner.read('outro-chat', started.runId, 'lens-0')).rejects.toMatchObject({ code: 'run-denied' });
    await live.req.writeFindings?.(report);
    live.settle(result('lens-0', 'ok', 'Texto final.\n'));
    await flush();
    const done = await runner.read('s', started.runId, 'lens-0');
    expect(done.status).toBe('ok');
    expect(done.finalText).toContain('Texto final.');
    expect(done.findings).toBe(report);
    expect(done.findingsPath).toBe(path.join(artifacts.root, started.runId, 'lens-0.md'));
    expect(done.partial).toBeNull();
    expect(done.runStatus).toBe('open');
    await runner.shutdown();
  });
  it('AC-7: swarm_stop cancela so um swarm agent; a run segue, o parado nao gasta retentativa nem bloqueia a entrega', async () => {
    const c = controllable();
    const { runner, deliver } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('stop', 2));
    await flush();
    expect(await runner.stop('s', started.runId, 'lens-0')).toEqual({ changed: true, status: 'stopping' });
    await flush();
    const mid = await runner.getRunState('s', started.runId);
    expect(mid.status).toBe('running');
    expect(mid.items[0]).toMatchObject({ status: 'cancelled', autoRetries: 0 });
    expect(mid.items[0].attempts[0].outcome).toBe('cancelled');
    expect(mid.items[1].status).toBe('running');
    expect(deliver).not.toHaveBeenCalled();
    const other = c.take('lens-1');
    await other.req.writeFindings?.(report);
    other.settle(result('lens-1'));
    await flush();
    const end = await runner.getRunState('s', started.runId);
    expect(end.status).toBe('open');
    expect(end.items.map((i) => i.status)).toEqual(['cancelled', 'ok']);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await runner.stop('s', started.runId, 'lens-0')).toEqual({ changed: false, status: 'cancelled' });
    await runner.shutdown();
  });
  it('AC-8: swarm_redispatch inicia nova geracao com o briefing novo, fora do limite de tentativas, zera autoRetries e registra a mensagem', async () => {
    const prompts: string[] = [];
    const { runner, artifacts, deps } = setup({
      readSettings: () => ({ ...DEFAULT_SWARM_SETTINGS, maxAttempts: 1 }),
      execute: vi.fn(async (req) => {
        prompts.push(req.prompt);
        if (prompts.length === 1) return { ...result(req.slug), output: 'sem trailer' };
        await req.writeFindings?.(report);
        return result(req.slug);
      }),
    });
    await runner.recover();
    const started = await runner.start(ctx(), input('redispatch'));
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('failed');
    expect(run.items[0].attempts[0].outcome).toBe('bad-trailer');
    expect(run.status).toBe('open');
    const accepted = await runner.redispatch('s', started.runId, 'lens-0', {
      objective: 'Auditar so os handlers IPC',
      lens: 'injecao de comandos',
      questions: ['Onde entra input externo?'],
    });
    expect(accepted).toEqual({ accepted: true, status: 'pending', generation: 2 });
    expect(deps.resolve).toHaveBeenCalledTimes(1);
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].status).toBe('ok');
    expect(run.items[0].generation).toBe(2);
    expect(run.items[0].autoRetries).toBe(0);
    expect(run.items[0].attempts).toHaveLength(2);
    expect(run.items[0].executions.map((e) => `${e.kind}:${e.generation}`)).toEqual(['initial:1', 'redispatch:2']);
    expect(prompts[1]).toContain('MISSAO: Auditar so os handlers IPC');
    expect(prompts[1]).toContain('LENTE: injecao de comandos');
    expect(prompts[1]).toContain('PAPEL: Swarm Auditor: generico');
    expect(run.items[0].prompt).toContain('PERGUNTAS:\n1. Onde entra input externo?');
    const messages = artifacts.readMessages(started.runId, 'lens-0');
    expect(messages.map((m) => m.kind)).toEqual(['redispatch']);
    expect(messages[0].text).toContain('Auditar so os handlers IPC');
    await expect(runner.redispatch('s', started.runId, 'lens-0', '')).rejects.toMatchObject({ code: 'invalid-input' });
    await runner.shutdown();
  });
  it('AC-9: needs-input deixa o swarm agent waiting, enfileira a pergunta sem gastar autoRetries e expira pelo idle timeout, que so conta a partir da entrega da pergunta (GA-5)', async () => {
    const { runner, deliver, cancelDelivery, deps, box } = setup({
      execute: vi.fn(async (req) => result(req.slug, 'needs-input')),
    });
    await runner.recover();
    const started = await runner.start(ctx(), input('question'));
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('running');
    expect(run.items[0]).toMatchObject({ status: 'waiting', question: 'Qual branch devo auditar?', autoRetries: 0 });
    expect(run.items[0].attempts[0].outcome).toBe('needs-input');
    expect(run.items[0].lastSignalAt).toBeNull();
    const execution = run.items[0].executions[0];
    expect(execution.question).toBe('Qual branch devo auditar?');
    expect(execution.questionRevision).toBe(run.revision);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [, envelope, descriptor] = deliver.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(descriptor).toEqual({
      kind: 'question',
      revision: run.revision,
      slug: 'lens-0',
      attemptId: run.items[0].attempts[0].id,
    });
    expect(envelope).toContain('SWARM QUESTION');
    expect(envelope).toContain('Qual branch devo auditar?');
    expect(box.row(started.runId, 'question', run.revision)).toMatchObject({
      state: 'pending',
      slug: 'lens-0',
      attemptId: run.items[0].attempts[0].id,
    });
    expect(runner.questionPending(started.runId, 'lens-0', run.items[0].attempts[0].id)).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.idleTimeoutMs + 1500);
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('waiting');
    expect(box.row(started.runId, 'question', execution.questionRevision!)?.state).toBe('pending');
    const [claimed] = box.pump();
    expect(claimed).toMatchObject({ kind: 'question', state: 'claimed' });
    expect(await runner.questionDelivered(started.runId, 'lens-0', run.items[0].attempts[0].id)).toBe(true);
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].lastSignalAt).toBe(new Date(Date.now()).toISOString());
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.idleTimeoutMs - 1000);
    await flush();
    expect((await runner.getRunState('s', started.runId)).items[0].status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2500);
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('failed');
    expect(await runner.questionDelivered(started.runId, 'lens-0', run.items[0].attempts[0].id)).toBe(false);
    expect(run.items[0].error).toMatchObject({ code: 'timeout-idle', message: 'Sem resposta do orquestrador.' });
    expect(run.items[0].autoRetries).toBe(0);
    expect(run.status).toBe('open');
    expect(cancelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ runId: started.runId }),
      'question',
      execution.questionRevision,
      expect.stringMatching(/sem resposta/i),
    );
    expect(runner.questionPending(started.runId, 'lens-0', run.items[0].attempts[0].id)).toBe(false);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
  it('AC-20/AC-14: message em execucao fica na fila e roda como continuacao; waiting roda na hora; terminal roda como continuacao; run fechada e recusada', async () => {
    const c = controllable();
    const { runner, artifacts, settings } = setup({ execute: c.execute, contextBudget: () => 100_000 });
    await runner.recover();
    const started = await runner.start(ctx(), input('message'));
    await flush();
    const first = c.take('lens-0');
    const queued = await runner.message('s', started.runId, 'lens-0', 'ignore a pasta vendor');
    expect(queued).toMatchObject({ accepted: true, queued: true, status: 'running' });
    expect(c.pending).toHaveLength(0);
    await first.req.writeFindings?.(report);
    first.settle(result('lens-0', 'ok', 'Primeira analise.\n'));
    await flush();
    const second = c.take('lens-0');
    expect(second.req.prompt).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\nignore a pasta vendor');
    expect(second.req.prompt).toContain('Primeira analise.');
    expect(second.req.prompt).toContain('BRIEFING ORIGINAL:');
    expect(second.req.prompt).toContain(report.trim());
    let run = await runner.getRunState('s', started.runId);
    expect(run.items[0].executions.at(-1)).toMatchObject({
      kind: 'continuation',
      mechanism: 'resend',
      messageId: queued.messageId,
    });
    second.settle(result('lens-0', 'needs-input', 'Preciso de uma decisao.\n'));
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('waiting');
    const attemptId = run.items[0].currentAttemptId!;
    const answer = await runner.message('s', started.runId, 'lens-0', 'use a branch main', attemptId, { turnId: 't1' });
    expect(answer).toMatchObject({ accepted: true, queued: false, status: 'pending' });
    await flush();
    const third = c.take('lens-0');
    expect(third.req.prompt).toContain('use a branch main');
    expect(third.req.prompt).toContain('ignore a pasta vendor');
    await third.req.writeFindings?.(report);
    third.settle(result('lens-0', 'ok', 'Terceira.\n'));
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].status).toBe('ok');
    const again = await runner.message('s', started.runId, 'lens-0', 'agora confira os testes');
    expect(again).toMatchObject({ accepted: true, queued: false, status: 'pending' });
    expect((await runner.getRunState('s', started.runId)).status).toBe('running');
    await flush();
    const fourth = c.take('lens-0');
    await fourth.req.writeFindings?.(report);
    fourth.settle(result('lens-0'));
    await flush();
    const records = artifacts.readMessages(started.runId, 'lens-0');
    expect(records.map((r) => r.kind)).toEqual(['message', 'response', 'answer', 'response', 'message', 'response']);
    expect(records[2]).toMatchObject({ attemptId, text: 'use a branch main' });
    expect(records[1]).toMatchObject({ mechanism: 'resend', costUsd: 0.1 });
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].autoRetries).toBe(0);
    expect(run.items[0].attempts).toHaveLength(4);
    await runner.abort('s', started.runId);
    expect((await runner.getRunState('s', started.runId)).status).toBe('done');
    await expect(runner.message('s', started.runId, 'lens-0', 'tarde demais')).rejects.toMatchObject({
      code: 'run_closed',
    });
    await expect(runner.redispatch('s', started.runId, 'lens-0', 'tarde')).rejects.toMatchObject({
      code: 'run_closed',
    });
    expect(settings.openWindowMs).toBe(DEFAULT_SWARM_SETTINGS.openWindowMs);
    await runner.shutdown();
  });
  it('AC-21: fim da run abre a janela sem descartar configuracoes; redispatch em open reabre, gera nova revisao e entrega incremental; a janela expira e fecha', async () => {
    const { runner, deliver, deps } = setup();
    await runner.recover();
    const started = await runner.start(ctx(), input('window', 2));
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    const firstRevision = run.terminalRevision!;
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as unknown as [unknown, string])[1]).not.toContain('entrega incremental');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await runner.redispatch('s', started.runId, 'lens-1', 'Auditar de novo com outra lente');
    expect(deps.resolve).toHaveBeenCalledTimes(2);
    expect((await runner.getRunState('s', started.runId)).status).toBe('running');
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.terminalRevision).toBeGreaterThan(firstRevision);
    expect(deliver).toHaveBeenCalledTimes(2);
    const [, envelope, descriptor] = deliver.mock.calls[1] as unknown as [unknown, string, Record<string, unknown>];
    expect(descriptor).toEqual({ kind: 'terminal', revision: run.terminalRevision });
    expect(envelope).toContain('entrega incremental');
    expect(envelope).toContain('alterados desde a entrega anterior: lens-1');
    expect(envelope).toContain('sem mudança desde a entrega anterior: lens-0');
    expect(envelope).not.toMatch(/\[ok\] lens-0/);
    await vi.advanceTimersByTimeAsync(DEFAULT_SWARM_SETTINGS.openWindowMs - 1000);
    expect((await runner.getRunState('s', started.runId)).status).toBe('open');
    await vi.advanceTimersByTimeAsync(2500);
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('done');
    expect(run.openedAt).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(deliver).toHaveBeenCalledTimes(2);
    await expect(runner.message('s', started.runId, 'lens-0', 'oi')).rejects.toThrow(/encerrada; dispare uma nova/);
    expect(runner.hasActiveWork('s')).toBe(false);
    await runner.shutdown();
  });
  it('AC-22: stop e termino natural na mesma tentativa, e redispatch durante o finish, passam pela fila serializada e deixam a run consistente', async () => {
    const c = controllable();
    const { runner, deliver } = setup({ execute: c.execute });
    await runner.recover();
    const started = await runner.start(ctx(), input('race'));
    await flush();
    const live = c.take('lens-0');
    await live.req.writeFindings?.(report);
    const stopping = runner.stop('s', started.runId, 'lens-0');
    live.settle(result('lens-0'));
    await stopping;
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('cancelled');
    expect(run.items[0].attempts[0].outcome).toBe('cancelled');
    expect(run.items[0].findingsFile).toBeNull();
    expect(run.status).toBe('open');
    expect(deliver).toHaveBeenCalledTimes(1);
    const second = runner.start(ctx(), input('race-2'));
    await second;
    await flush();
    const live2 = c.take('lens-0');
    await live2.req.writeFindings?.(report);
    live2.settle(result('lens-0'));
    const redispatched = runner.redispatch('s', (await second).runId, 'lens-0', 'Outra missao');
    await flush();
    await redispatched;
    await flush();
    run = await runner.getRunState('s', (await second).runId);
    expect(['running', 'open']).toContain(run.status);
    expect(run.items[0].generation).toBe(2);
    const live3 = c.take('lens-0');
    expect(live3.req.prompt).toContain('MISSAO: Outra missao');
    await live3.req.writeFindings?.(report);
    live3.settle(result('lens-0'));
    await flush();
    run = await runner.getRunState('s', (await second).runId);
    expect(run.status).toBe('open');
    expect(run.items[0].status).toBe('ok');
    expect(run.items[0].executions.map((e) => e.kind)).toEqual(['initial', 'redispatch']);
    await runner.shutdown();
  });
  it('AC-23: resposta atrasada a uma pergunta cujo swarm agent saiu de waiting e recusada com o estado atual', async () => {
    const { runner, cancelDelivery } = setup({ execute: vi.fn(async (req) => result(req.slug, 'needs-input')) });
    await runner.recover();
    const started = await runner.start(ctx(), input('stale'));
    await flush();
    const run = await runner.getRunState('s', started.runId);
    const attemptId = run.items[0].currentAttemptId!;
    await runner.stop('s', started.runId, 'lens-0');
    expect(cancelDelivery).toHaveBeenCalledWith(
      expect.anything(),
      'question',
      expect.any(Number),
      'Parado pelo orquestrador.',
    );
    await expect(runner.message('s', started.runId, 'lens-0', 'resposta', attemptId)).rejects.toMatchObject({
      code: 'stale_attempt',
      message: expect.stringContaining('está cancelled'),
    });
    await runner.shutdown();
  });
  it('AC-27: duas runs na mesma conversa encadeadas por parentRunId e stage; parentRunId de outra conversa e recusado', async () => {
    const { runner } = setup();
    await runner.recover();
    const first = await runner.start(ctx(), input('etapa-1', 1, { stage: 'analise' }));
    await flush();
    vi.setSystemTime(new Date('2026-10-11T12:00:05Z'));
    const second = await runner.start(ctx(), input('etapa-2', 1, { parentRunId: first.runId, stage: 'validacao' }));
    expect(second.status).toBe('queued');
    await flush();
    const runs = await runner.listRuns('s');
    expect(runs.runs.map((r) => [r.runId, r.parentRunId, r.stage])).toEqual([
      [second.runId, first.runId, 'validacao'],
      [first.runId, null, 'analise'],
    ]);
    expect((await runner.getRunState('s', second.runId)).parentRunId).toBe(first.runId);
    await expect(runner.start(ctx('outro'), input('etapa-x', 1, { parentRunId: first.runId }))).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(runner.hasActiveSession('s')).toBe(false);
    await runner.shutdown();
  });
});

describe('Swarm v2 S2: reenvio de historico (5.3.4, AC-13)', () => {
  it('tres mensagens consecutivas: a terceira enxerga as duas anteriores, as respostas e os achados; estouro corta na ordem e declara', async () => {
    const prompts: string[] = [];
    let budget = 1_000_000;
    const { runner, artifacts } = setup({
      contextBudget: () => budget,
      execute: vi.fn(async (req) => {
        prompts.push(req.prompt);
        await req.writeFindings?.(report);
        return result(req.slug, 'ok', `Resposta ${prompts.length}.\n${'detalhe da analise '.repeat(25)}\n`);
      }),
    });
    await runner.recover();
    const started = await runner.start(ctx(), input('history'));
    await flush();
    for (const text of ['primeira mensagem', 'segunda mensagem', 'terceira mensagem']) {
      await runner.message('s', started.runId, 'lens-0', text);
      await flush();
    }
    expect(prompts).toHaveLength(4);
    const third = prompts[3];
    expect(third.indexOf('BRIEFING ORIGINAL:')).toBe(0);
    expect(third).toContain('EXECUCAO ANTERIOR 1 (initial, geração 1, resultado ok)');
    expect(third).toContain('EXECUCAO ANTERIOR 3 (continuation, geração 1, resultado ok)');
    expect(third).toContain('Resposta 1.');
    expect(third).toContain('Resposta 3.');
    expect(third.split(report.trim()).length - 1).toBe(3);
    expect(third).toContain('1. Orquestrador:\nprimeira mensagem\nResposta:\nResposta 2.');
    expect(third).toContain('2. Orquestrador:\nsegunda mensagem\nResposta:\nResposta 3.');
    expect(third).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\nterceira mensagem');
    expect(third.indexOf('MENSAGEM NOVA')).toBeGreaterThan(third.indexOf('2. Orquestrador'));
    expect(third).toContain('Continue de onde parou, nao repita o que ja entregou.');
    expect(third.indexOf('Continue de onde parou')).toBeGreaterThan(third.indexOf('MENSAGEM NOVA'));
    expect(third).not.toContain('CORTES POR LIMITE DE CONTEXTO');
    budget = 3_400;
    await runner.message('s', started.runId, 'lens-0', 'quarta mensagem');
    await flush();
    const fourth = prompts[4];
    expect(fourth).toContain('CORTES POR LIMITE DE CONTEXTO:');
    const cuts = /CORTES POR LIMITE DE CONTEXTO: ([^\n]+)\./.exec(fourth)![1].split('; ');
    expect(cuts).toEqual([
      'texto final da execucao 1 removido',
      'texto final da execucao 2 removido',
      'texto final da execucao 3 removido',
      'achados da execucao 1 reduzidos ao Resumo',
      'achados da execucao 2 reduzidos ao Resumo',
      'achados da execucao 3 reduzidos ao Resumo',
      'achados da execucao 4 sem o corpo das evidencias',
      'mensagens antigas resumidas em uma linha',
    ]);
    expect(fourth).toContain('Texto final: (cortado por limite de contexto)');
    expect(fourth).toContain(
      'EXECUCAO ANTERIOR 4 (continuation, geração 1, resultado ok):\n\nTexto final:\nResposta 4.',
    );
    expect(fourth).toContain('Achados publicados, so o Resumo');
    expect(fourth).toContain('1. Orquestrador: primeira mensagem | Resposta: Resposta 2.');
    expect(fourth).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\nquarta mensagem');
    expect(fourth.indexOf('BRIEFING ORIGINAL:')).toBe(0);
    expect(fourth).toContain(/^OBJETIVO DA RUN: Auditar/m.exec(third)![0]);
    expect(fourth.split('\n\nGrave relatório')[0].length).toBeLessThanOrEqual(3_400);
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0].executions.filter((e) => e.mechanism === 'resend')).toHaveLength(4);
    expect(artifacts.readMessages(started.runId, 'lens-0').some((r) => r.cuts?.length)).toBe(true);
    await runner.shutdown();
  });
  it('conteudo obrigatorio maior que o orcamento nao roda: a tentativa termina em context-overflow com motivo e tamanho ao orquestrador; a run open nao reabre (S2-V11)', async () => {
    const { runner, deps, deliver } = setup({ contextBudget: () => 300 });
    await runner.recover();
    const started = await runner.start(ctx(), input('overflow'));
    await flush();
    await expect(
      runner.message(
        's',
        started.runId,
        'lens-0',
        'mensagem que nao cabe junto com o briefing e os achados obrigatorios',
      ),
    ).rejects.toMatchObject({ code: 'context-overflow', message: expect.stringMatching(/caracteres.*orçamento.*300/) });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('failed');
    expect(run.items[0].attempts).toHaveLength(2);
    expect(run.items[0].attempts[1].outcome).toBe('context-overflow');
    expect(run.items[0].executions[1]).toMatchObject({ kind: 'continuation', mechanism: 'resend' });
    expect(run.items[0].autoRetries).toBe(0);
    expect(run.status).toBe('open');
    expect(deliver).toHaveBeenCalledTimes(1);
    await runner.shutdown();
  });
});

describe('Swarm v2 S2: recuperacao apos reinicio (5.3.7, AC-31)', () => {
  it('waiting continua waiting com a pergunta reentregue (fila real) e idle contado da entrega; pergunta ainda pendente na fila nao e reenfileirada', async () => {
    const { runner, deps, artifacts, box } = setup({
      execute: vi.fn(async (req) => result(req.slug, 'needs-input')),
    });
    await runner.recover();
    const asked = await runner.start(ctx(), input('boot-waiting'));
    await flush();
    const before = artifacts.load(asked.runId);
    expect(before.items[0].status).toBe('waiting');
    const firstRevision = before.items[0].executions[0].questionRevision!;
    const [claimed] = box.pump();
    box.markDelivered(claimed);
    expect(box.row(asked.runId, 'question', firstRevision)?.state).toBe('delivered');
    vi.setSystemTime(new Date('2026-10-11T13:00:00Z'));
    const deliver = vi.fn(box.deps.deliver);
    const restarted = new SwarmRunner({ ...deps, deliver, execute: vi.fn() });
    await restarted.recover();
    const after = artifacts.load(asked.runId);
    expect(after.items[0].status).toBe('waiting');
    expect(after.items[0].question).toBe('Qual branch devo auditar?');
    expect(after.items[0].lastSignalAt).toBeNull();
    expect(after.items[0].attempts[0].outcome).toBe('needs-input');
    const secondRevision = after.items[0].executions[0].questionRevision!;
    expect(secondRevision).toBeGreaterThan(firstRevision);
    expect(secondRevision).toBe(after.revision);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2]).toMatchObject({ kind: 'question', slug: 'lens-0', revision: secondRevision });
    expect(box.row(asked.runId, 'question', secondRevision)).toMatchObject({ state: 'pending', slug: 'lens-0' });
    expect(box.row(asked.runId, 'question', firstRevision)?.state).toBe('delivered');
    expect(restarted.questionPending(asked.runId, 'lens-0', after.items[0].currentAttemptId!)).toBe(true);
    expect(await restarted.questionDelivered(asked.runId, 'lens-0', after.items[0].currentAttemptId!)).toBe(true);
    expect(artifacts.load(asked.runId).items[0].lastSignalAt).toBe('2026-10-11T13:00:00.000Z');
    const third = new SwarmRunner({ ...deps, deliver: vi.fn(box.deps.deliver), execute: vi.fn() });
    const quiet = vi.fn();
    third.subscribe(quiet);
    await third.recover();
    expect(artifacts.load(asked.runId).items[0].executions[0].questionRevision).toBe(secondRevision);
    expect(box.list().filter((l) => l.startsWith('question:'))).toHaveLength(2);
    expect(deps.reportError).not.toHaveBeenCalled();
    await restarted.shutdown();
    await third.shutdown();
  });
  it('execucao em andamento vira failed "interrompido por reinicio" sem gastar autoRetries; a run passa a open no boot e enfileira a entrega terminal uma unica vez', async () => {
    const c = controllable();
    const { runner, deps, artifacts, box } = setup({ execute: c.execute });
    await runner.recover();
    const live = await runner.start(ctx(), input('boot-running', 2));
    await flush();
    const first = c.take('lens-0');
    await first.req.writeFindings?.(report);
    first.settle(result('lens-0'));
    await flush();
    const snapshot = artifacts.load(live.runId);
    snapshot.items[1].attempts[0].terminationConfirmedAt = null;
    snapshot.items[1].attempts[0].endedAt = null;
    snapshot.items[1].attempts[0].outcome = null;
    artifacts.save(snapshot);
    const deliver = vi.fn(box.deps.deliver);
    const restarted = new SwarmRunner({ ...deps, deliver, execute: vi.fn() });
    await restarted.recover();
    const after = artifacts.load(live.runId);
    expect(after.items[0].status).toBe('ok');
    expect(after.items[1]).toMatchObject({ status: 'failed', autoRetries: 0 });
    expect(after.items[1].error).toMatchObject({
      code: 'interrupted',
      message: 'Interrompido por reinício do aplicativo.',
    });
    expect(after.items[1].attempts[0].outcome).toBe('interrupted');
    expect(after.items[1].executions).toHaveLength(1);
    expect(after.status).toBe('open');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(box.row(live.runId, 'terminal', after.terminalRevision)).toMatchObject({ state: 'pending' });
    expect(box.list().filter((l) => l.startsWith('terminal:'))).toHaveLength(1);
    expect(deps.reportError).not.toHaveBeenCalled();
    expect(restarted.hasActiveWork('s')).toBe(false);
    const again = await restarted.redispatch('s', live.runId, 'lens-1', 'Retomar do zero');
    expect(again).toMatchObject({ accepted: true, generation: 2, status: 'pending' });
    await restarted.shutdown();
  });
  it('manifesto V1 (sem executions/autoRetries/open) carrega com executions derivado e nao e reescrito ao carregar', async () => {
    const { artifacts } = setup();
    const runId = 'swarm-20260101_000000-abc123';
    const v1 = {
      schemaVersion: 1,
      revision: 4,
      terminalRevision: 4,
      runId,
      chatSessionId: 's',
      requestId: 'v1',
      requestHash: 'a'.repeat(64),
      mode: 'comite',
      cwd: root,
      objective: 'Auditar',
      status: 'partial',
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: '2026-01-01T00:10:00.000Z',
      settings: { concurrencyCap: 5, maxAttempts: 2, idleTimeoutMs: 1_200_000, hardTimeoutMs: 7_200_000 },
      items: [
        {
          slug: 'a',
          target: 'alvo.ts',
          prompt: 'p',
          member: { kind: 'registered', agentId: 'swarm-auditor' },
          runtime: 'cloud',
          model: 'm',
          resolvedConfigFile: '_attempts/a/config.json',
          status: 'failed',
          currentAttemptId: 'attempt-2-ffff',
          nextAttemptAt: null,
          attempts: [1, 2].map((n) => ({
            id: `attempt-${n}-ffff`,
            n,
            startedAt: '2026-01-01T00:00:01.000Z',
            endedAt: '2026-01-01T00:05:00.000Z',
            terminationConfirmedAt: '2026-01-01T00:05:00.000Z',
            outcome: 'crash',
            error: { code: 'crash', message: 'x', retryable: true },
            outputFile: `_attempts/a/attempt-${n}-ffff/output.txt`,
            findingsFile: `_attempts/a/attempt-${n}-ffff/findings.md`,
            validatedContentHash: null,
            metrics: { costUsd: null, costStatus: 'unknown' },
          })),
          findingsFile: null,
          summary: null,
          lastSignalAt: null,
          error: { code: 'crash', message: 'x', retryable: true },
        },
      ],
    };
    fs.mkdirSync(path.join(artifacts.root, runId));
    const raw = JSON.stringify(v1, null, 2);
    artifacts.atomic(`${runId}/_run.json`, raw);
    const loaded = artifacts.load(runId);
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.items[0].executions.map((e) => `${e.kind}:${e.generation}`)).toEqual(['initial:1', 'retry:1']);
    expect(loaded.items[0]).toMatchObject({ autoRetries: 1, generation: 1, question: null, inbox: [], launch: null });
    expect(loaded).toMatchObject({ openedAt: null, parentRunId: null, stage: null, deliveredSignatures: null });
    expect(loaded.settings.openWindowMs).toBe(DEFAULT_SWARM_SETTINGS.openWindowMs);
    expect(artifacts.read(`${runId}/_run.json`)).toBe(raw);
    const runner = new SwarmRunner({ ...setup().deps, artifacts, deliver: vi.fn() });
    await runner.recover();
    expect((await runner.listRuns('s')).runs[0].status).toBe('partial');
    expect(artifacts.read(`${runId}/_run.json`)).toBe(raw);
    await runner.shutdown();
  });
});

describe('Swarm v2 S2 - correcoes do validador', () => {
  it('S2-V1: a resposta a needs-input vai primeiro como MENSAGEM NOVA; a mensagem que ja estava na fila roda depois, em ordem, e nao vira historico antes de ser enviada', async () => {
    const c = controllable();
    const { runner, artifacts } = setup({ execute: c.execute, contextBudget: () => 100_000 });
    await runner.recover();
    const started = await runner.start(ctx(), input('answer-first'));
    await flush();
    const first = c.take('lens-0');
    const queued = await runner.message('s', started.runId, 'lens-0', 'mensagem enfileirada A');
    expect(queued.queued).toBe(true);
    first.settle(result('lens-0', 'needs-input', 'Pergunta do agente.\n'));
    await flush();
    let run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('waiting');
    expect(run.items[0].inbox.map((m) => m.message)).toEqual(['mensagem enfileirada A']);
    const attemptId = run.items[0].currentAttemptId!;
    await runner.message('s', started.runId, 'lens-0', 'RESPOSTA: use a branch main', attemptId, { turnId: 't' });
    await flush();
    const second = c.take('lens-0');
    expect(second.req.prompt).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\nRESPOSTA: use a branch main');
    expect(second.req.prompt).not.toContain('mensagem enfileirada A');
    expect(second.req.prompt).not.toContain('(sem resposta)');
    run = await runner.getRunState('s', started.runId);
    expect(run.items[0].executions.at(-1)).toMatchObject({
      kind: 'continuation',
      messageId: expect.stringMatching(/^msg-/),
    });
    expect(run.items[0].inbox.map((m) => m.message)).toEqual(['mensagem enfileirada A']);
    await second.req.writeFindings?.(report);
    second.settle(result('lens-0', 'ok', 'Resposta a pergunta.\n'));
    await flush();
    const third = c.take('lens-0');
    expect(third.req.prompt).toContain('MENSAGEM NOVA DO ORQUESTRADOR:\n\nmensagem enfileirada A');
    expect(third.req.prompt).toContain(
      '1. Orquestrador:\nRESPOSTA: use a branch main\nResposta:\nResposta a pergunta.',
    );
    await third.req.writeFindings?.(report);
    third.settle(result('lens-0'));
    await flush();
    run = await runner.getRunState('s', started.runId);
    expect(run.status).toBe('open');
    expect(run.items[0].inbox).toEqual([]);
    expect(artifacts.readMessages(started.runId, 'lens-0').map((r) => r.kind)).toEqual([
      'message',
      'answer',
      'response',
      'response',
    ]);
    await runner.shutdown();
  });
  it('S2-V3: o orcamento do runtime local usa a janela sondada do modelo e so cai no padrao pequeno sem sonda', async () => {
    const localResolved: SwarmResolvedMember = {
      ...resolved,
      runtime: 'local',
      model: 'tiny-local',
      snapshot: {
        agent: { localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'tiny-local' } },
        config: {},
      },
      agent: {
        localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'tiny-local' },
      } as AgentConfig,
    };
    setProbedContextWindows('ollama', [{ id: 'tiny-local', contextWindow: 2_000 }]);
    try {
      const { runner, deps } = setup({ resolve: vi.fn(async () => localResolved) });
      await runner.recover();
      const started = await runner.start(ctx(), input('local-budget'));
      await flush();
      await expect(runner.message('s', started.runId, 'lens-0', 'mensagem curta '.repeat(300))).rejects.toMatchObject({
        code: 'context-overflow',
        message: expect.stringContaining('é 3000'),
      });
      expect(deps.execute).toHaveBeenCalledTimes(1);
      await runner.shutdown();
    } finally {
      clearProbedContextWindows();
    }
  });
  it('S2-V4/S2-V7: swarm_read nao renova a janela; falha ao iniciar a execucao (prompt de continuacao perdido) marca o swarm agent failed em vez de reportar para sempre', async () => {
    const c = controllable();
    const { runner, deps, artifacts } = setup({ execute: c.execute, contextBudget: () => 100_000 });
    await runner.recover();
    runner.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 1 });
    const started = await runner.start(ctx(), input('read-window'));
    await flush();
    await runner.stop('s', started.runId, 'lens-0');
    await flush();
    c.pending.length = 0;
    const opened = await runner.getRunState('s', started.runId);
    expect(opened.status).toBe('open');
    vi.setSystemTime(new Date('2026-10-11T12:20:00Z'));
    await runner.read('s', started.runId, 'lens-0');
    expect((await runner.getRunState('s', started.runId)).openedAt).toBe(opened.openedAt);
    const blocker = await runner.start(ctx(), input('blocker'));
    await flush();
    expect(c.pending.map((p) => p.req.runId)).toEqual([blocker.runId]);
    const accepted = await runner.message('s', started.runId, 'lens-0', 'continue');
    expect(accepted.status).toBe('pending');
    await flush();
    expect(c.pending).toHaveLength(1);
    const promptFile = (await runner.getRunState('s', started.runId)).items[0].launch!.promptFile!;
    fs.unlinkSync(path.join(artifacts.root, started.runId, ...promptFile.split('/')));
    const blocking = c.take('lens-0');
    await blocking.req.writeFindings?.(report);
    blocking.settle(result('lens-0'));
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0].status).toBe('failed');
    expect(run.items[0].error).toMatchObject({ code: 'continuation-missing' });
    expect(run.status).toBe('open');
    expect(deps.reportError).toHaveBeenCalledWith(expect.anything(), 'início de tentativa Swarm');
    expect(
      (deps.reportError as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[1] === 'início de tentativa Swarm',
      ),
    ).toHaveLength(1);
    await runner.shutdown();
  });
  it('S2-V2 (limite): failWaiting marca o swarm agent waiting como failed "orquestrador sem conducao" e a run abre; fora de waiting nao muda nada', async () => {
    const { runner } = setup({ execute: vi.fn(async (req) => result(req.slug, 'needs-input')) });
    await runner.recover();
    const started = await runner.start(ctx(), input('unsupported'));
    await flush();
    const attemptId = (await runner.getRunState('s', started.runId)).items[0].currentAttemptId!;
    expect(await runner.failWaiting(started.runId, 'lens-0', 'outra-tentativa', 'motivo')).toBe(false);
    expect(
      await runner.failWaiting(
        started.runId,
        'lens-0',
        attemptId,
        'Orquestrador sem conducao neste runtime (grok-sdk)',
      ),
    ).toBe(true);
    const run = await runner.getRunState('s', started.runId);
    expect(run.items[0]).toMatchObject({ status: 'failed', question: null, autoRetries: 0 });
    expect(run.items[0].error).toMatchObject({
      code: 'conduction-unsupported',
      message: expect.stringContaining('grok-sdk'),
    });
    expect(run.status).toBe('open');
    expect(await runner.failWaiting(started.runId, 'lens-0', attemptId, 'de novo')).toBe(false);
    await runner.shutdown();
  });
  it('S2-V3: janela por runtime: local sondado > tabela > 32k; external pelo catalogo > 128k', () => {
    setProbedContextWindows('lmstudio', [{ id: 'sondado', contextWindow: 16_384 }]);
    try {
      expect(swarmContextWindowTokens('local', 'sondado', 'lmstudio')).toBe(16_384);
      expect(swarmContextWindowTokens('local', 'sondado', 'ollama')).toBe(32_000);
      expect(swarmContextWindowTokens('local', 'qwen2.5:7b', 'ollama')).toBe(131_072);
      expect(swarmContextWindowTokens('local', 'modelo-desconhecido', 'ollama')).toBe(32_000);
      expect(swarmContextWindowTokens('external', 'deepseek-chat', 'openai-compatible')).toBe(128_000);
      expect(swarmContextWindowTokens('external', 'modelo-desconhecido', 'openrouter')).toBe(128_000);
      expect(swarmContextWindowTokens('cloud', 'claude-opus-5-5')).toBe(1_000_000);
      expect(swarmContextBudgetChars('local', 'sondado', 'lmstudio')).toBe(8_192 * 3);
    } finally {
      clearProbedContextWindows();
    }
  });
});
