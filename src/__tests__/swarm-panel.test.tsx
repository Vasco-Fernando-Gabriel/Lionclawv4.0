// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmItem, SwarmMessageRecord, SwarmRun, SwarmRunSummary } from '@/types/swarm';
vi.mock('@/stores/chat-store', () => ({
  useChatStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 's1' }),
}));
import { SwarmPanel } from '@/components/swarm/SwarmPanel';
import {
  buildSwarmChains,
  countRunningSwarmAgents,
  swarmContinuationBadge,
  swarmExecutionLabel,
  swarmOpenWindowRemainingMs,
  swarmRunCost,
  swarmRunningBadge,
  swarmItemUsage,
  formatSwarmUsage,
  swarmRepoGraphLabel,
} from '@/components/swarm/swarm-panel-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function run(revision: number, objective: string): SwarmRun {
  return { runId: 'r1', chatSessionId: 's1', revision, objective, status: 'running', items: [] } as unknown as SwarmRun;
}
function item(patch: Partial<SwarmItem> & Pick<SwarmItem, 'slug' | 'status'>): SwarmItem {
  return {
    target: '.',
    prompt: 'p',
    member: { kind: 'registered', agentId: 'swarm-auditor' },
    runtime: 'cloud',
    model: 'claude-opus-5-5',
    resolvedConfigFile: 'cfg.json',
    currentAttemptId: null,
    nextAttemptAt: null,
    attempts: [],
    executions: [],
    generation: 1,
    autoRetries: 0,
    question: null,
    inbox: [],
    launch: null,
    session: null,
    sessionLostReason: null,
    findingsFile: null,
    summary: null,
    lastSignalAt: null,
    error: null,
    ...patch,
  };
}
function attempt(
  id: string,
  n: number,
  costUsd: number | null,
  outcome: SwarmItem['attempts'][number]['outcome'] = 'ok',
) {
  return {
    id,
    n,
    startedAt: '2026-10-11T10:00:00.000Z',
    endedAt: outcome ? '2026-10-11T10:01:00.000Z' : null,
    outcome,
    error: null,
    terminationConfirmedAt: null,
    outputFile: 'output.txt',
    findingsFile: 'findings.md',
    validatedContentHash: null,
    metrics: { costUsd, costStatus: costUsd === null ? ('unknown' as const) : ('known' as const) },
  };
}
function fullRun(patch: Partial<SwarmRun> & Pick<SwarmRun, 'runId'>): SwarmRun {
  return {
    schemaVersion: 2,
    revision: 1,
    terminalRevision: null,
    chatSessionId: 's1',
    requestId: 'req',
    requestHash: 'h',
    mode: 'comite',
    cwd: '/repo',
    objective: 'Auditar',
    parentRunId: null,
    stage: null,
    status: 'running',
    createdAt: '2026-10-11T10:00:00.000Z',
    startedAt: '2026-10-11T10:00:00.000Z',
    finishedAt: null,
    openedAt: null,
    deliveredSignatures: null,
    settings: { concurrencyCap: 5, maxAttempts: 2, idleTimeoutMs: 1, hardTimeoutMs: 2, openWindowMs: 30 * 60_000 },
    items: [],
    ...patch,
  };
}
function summary(run: SwarmRun): SwarmRunSummary {
  return {
    runId: run.runId,
    chatSessionId: run.chatSessionId,
    revision: run.revision,
    mode: run.mode,
    status: run.status,
    itemCount: run.items.length,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    costUsd: null,
    parentRunId: run.parentRunId,
    stage: run.stage,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<SwarmPanel />);
  });
  await flush();
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
function api(
  runs: SwarmRun[],
  extra: Partial<Record<string, unknown>> = {},
): {
  stopAgent: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  openFindings: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
  listRuns: ReturnType<typeof vi.fn>;
  emit: (event: { runId: string; chatSessionId: string; revision: number }) => void;
} {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  let listener: (event: { runId: string; chatSessionId: string; revision: number }) => void = () => {};
  const swarm = {
    getRunState: vi.fn(async (_s: string, runId: string) => byId.get(runId) ?? { error: 'nao existe', code: 'x' }),
    listRuns: vi.fn(async () => ({ runs: runs.map(summary), nextCursor: null })),
    stopAgent: vi.fn(async () => ({ changed: true, status: 'stopping' })),
    abort: vi.fn(async (_s: string, runId: string) => byId.get(runId)),
    openFindings: vi.fn(async () => ({ opened: true })),
    getMessages: vi.fn(async (_s: string, runId: string, slug: string) => ({ runId, slug, messages: [] })),
    onStream: (cb: typeof listener) => {
      listener = cb;
      return () => {};
    },
    ...extra,
  };
  Object.assign(window, { lionclaw: { swarm } });
  return { ...swarm, emit: (event: Parameters<typeof listener>[0]) => listener(event) } as never;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
});

describe('Swarm sidebar', () => {
  it('ignora resposta antiga e eventos de outra sessão; remove listener', async () => {
    let listener: (event: { runId: string; chatSessionId: string; revision: number }) => void = () => {};
    let resolveOld: (run: SwarmRun) => void = () => {};
    const old = new Promise<SwarmRun>((resolve) => {
      resolveOld = resolve;
    });
    const dispose = vi.fn();
    const getRunState = vi.fn().mockReturnValueOnce(old).mockResolvedValue(run(3, 'Atual'));
    Object.assign(window, {
      lionclaw: {
        swarm: {
          getRunState,
          listRuns: async () => ({ runs: [{ runId: 'r1' }], nextCursor: null }),
          onStream: (cb: typeof listener) => {
            listener = cb;
            return dispose;
          },
        },
      },
    });
    const element = document.createElement('div');
    document.body.append(element);
    const localRoot = createRoot(element);
    await act(async () => {
      localRoot.render(<SwarmPanel />);
    });
    await act(async () => {
      listener({ runId: 'r1', chatSessionId: 's2', revision: 9 });
    });
    expect(getRunState).toHaveBeenCalledTimes(1);
    await act(async () => {
      listener({ runId: 'r1', chatSessionId: 's1', revision: 3 });
    });
    expect(element.textContent).toContain('Atual');
    await act(async () => {
      resolveOld(run(1, 'Obsoleto'));
    });
    expect(element.textContent).not.toContain('Obsoleto');
    await act(async () => {
      localRoot.unmount();
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    element.remove();
  });

  it('S5 (AC-27, AC-17): lista as runs recentes encadeadas por etapa e soma quem esta rodando', async () => {
    const stage1 = fullRun({
      runId: 'swarm-20261011_100000-aaa',
      stage: 'analise',
      status: 'done',
      finishedAt: '2026-10-11T10:05:00.000Z',
      items: [
        item({ slug: 'a1', status: 'ok', attempts: [attempt('t1', 1, 0.1)] }),
        item({ slug: 'a2', status: 'ok', attempts: [attempt('t2', 1, 0.2)] }),
        item({ slug: 'a3', status: 'failed', attempts: [attempt('t3', 1, null, 'crash')] }),
      ],
    });
    const stage2 = fullRun({
      runId: 'swarm-20261011_101000-bbb',
      parentRunId: stage1.runId,
      stage: 'validacao',
      objective: 'Validar os achados da etapa 1',
      items: [
        item({ slug: 'v1', status: 'running', currentAttemptId: 'u1', attempts: [attempt('u1', 1, null, null)] }),
        item({ slug: 'v2', status: 'pending' }),
      ],
    });
    const lonely = fullRun({
      runId: 'swarm-20261011_090000-ccc',
      status: 'done',
      items: [item({ slug: 'x', status: 'ok' })],
    });
    api([stage2, stage1, lonely]);
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Etapa 1: analise, 3 swarm agents');
    expect(text).toContain('Etapa 2: validacao, 2 swarm agents');
    expect(text).toContain('Validar os achados da etapa 1');
    expect(container.querySelectorAll('[data-testid="swarm-chain"]')).toHaveLength(2);
    const ids = [...container.querySelectorAll('[data-testid="swarm-run"]')].map((el) =>
      el.getAttribute('data-run-id'),
    );
    expect(ids).toEqual([stage1.runId, stage2.runId, lonely.runId]);
    expect(container.querySelector('[data-testid="swarm-running"]')?.textContent).toContain('1 rodando, 1 na fila');
    const costs = [...container.querySelectorAll('[data-testid="swarm-run-cost"]')].map((el) => el.textContent);
    expect(costs[0]).toBe('custo total $0.3000 (parcial)');
    expect(text).toContain('Abortar run');
    expect(text).not.toContain('Abortar Swarm');
  });

  it('S5 (AC-9, AC-14): swarm agent waiting mostra a pergunta e, em Mensagens, a resposta do orquestrador', async () => {
    const waiting = fullRun({
      runId: 'swarm-20261011_100000-aaa',
      items: [
        item({
          slug: 'auditor',
          status: 'waiting',
          currentAttemptId: 't1',
          question: 'Posso ignorar a pasta vendor?',
          attempts: [attempt('t1', 1, 0.05, 'needs-input')],
          executions: [
            {
              attemptId: 't1',
              kind: 'initial',
              generation: 1,
              mechanism: null,
              continuationMode: null,
              continuationReason: null,
              messageId: null,
              reason: null,
              question: 'Posso ignorar a pasta vendor?',
              questionRevision: 3,
            },
          ],
        }),
      ],
    });
    const records: SwarmMessageRecord[] = [
      { id: 'm1', kind: 'message', attemptId: 't1', at: '2026-10-11T10:00:30.000Z', text: 'Foque nos handlers IPC' },
      { id: 'm2', kind: 'answer', attemptId: 't1', at: '2026-10-11T10:02:00.000Z', text: 'Sim, ignore vendor' },
      {
        id: 'm2-t2-response',
        kind: 'response',
        attemptId: 't2',
        at: '2026-10-11T10:03:00.000Z',
        text: 'Continuando sem vendor',
        mechanism: 'resend',
        costUsd: 0.02,
      },
    ];
    const mocks = api([waiting], {
      getMessages: vi.fn(async (_s: string, runId: string, slug: string) => ({ runId, slug, messages: records })),
    });
    await mount();
    expect(container.textContent).toContain('Aguardando o orquestrador');
    expect(container.textContent).toContain('Pergunta: Posso ignorar a pasta vendor?');
    expect(container.querySelector('[data-testid="swarm-running"]')?.textContent).toContain('1 rodando');
    await act(async () => {
      button('Mensagens').click();
    });
    await flush();
    expect(mocks.getMessages).toHaveBeenCalledWith('s1', waiting.runId, 'auditor');
    const timeline = container.querySelector('[data-testid="swarm-messages"]');
    expect(timeline).not.toBeNull();
    const kinds = [...timeline!.querySelectorAll('[data-kind]')].map((el) => el.getAttribute('data-kind'));
    expect(kinds).toEqual(['message', 'question', 'answer', 'response']);
    expect(timeline!.textContent).toContain('Pergunta do swarm agent');
    expect(timeline!.textContent).toContain('Resposta do orquestrador a pergunta');
    expect(timeline!.textContent).toContain('Sim, ignore vendor');
    expect(timeline!.textContent).toContain('Swarm agent (reenvio) · $0.0200');
  });

  it('S5 (AC-17): Parar confirma e chama swarm:stop-agent so daquele swarm agent; Abortar run confirma; Abrir relatorio', async () => {
    const live = fullRun({
      runId: 'swarm-20261011_100000-aaa',
      items: [
        item({ slug: 'auditor', status: 'running', currentAttemptId: 't1', attempts: [attempt('t1', 1, null, null)] }),
        item({ slug: 'explorer', status: 'ok', findingsFile: 'explorer.md', attempts: [attempt('t2', 1, 0.3)] }),
      ],
    });
    const mocks = api([live]);
    await mount();
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Parar')).toHaveLength(1);
    await act(async () => {
      button('Parar').click();
    });
    expect(container.textContent).toContain('Parar auditor? So este swarm agent; a run segue.');
    await act(async () => {
      button('Cancelar').click();
    });
    expect(mocks.stopAgent).not.toHaveBeenCalled();
    await act(async () => {
      button('Parar').click();
    });
    await act(async () => {
      button('Confirmar').click();
    });
    await flush();
    expect(mocks.stopAgent).toHaveBeenCalledTimes(1);
    expect(mocks.stopAgent).toHaveBeenCalledWith('s1', live.runId, 'auditor');
    await act(async () => {
      button('Abrir relatorio').click();
    });
    await flush();
    expect(mocks.openFindings).toHaveBeenCalledWith('s1', live.runId, 'explorer');
    await act(async () => {
      button('Abortar run').click();
    });
    expect(container.textContent).toContain('Abortar a run inteira?');
    expect(mocks.abort).not.toHaveBeenCalled();
    await act(async () => {
      button('Confirmar').click();
    });
    await flush();
    expect(mocks.abort).toHaveBeenCalledWith('s1', live.runId);
  });

  it('S5 (AC-13, S3-V6): mostra geracao, execucao atual e o mecanismo de continuacao com o motivo', async () => {
    const done = fullRun({
      runId: 'swarm-20261011_100000-aaa',
      status: 'open',
      openedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      terminalRevision: 4,
      items: [
        item({
          slug: 'kimi-agent',
          status: 'ok',
          runtime: 'kimi',
          model: 'k2',
          currentAttemptId: 't2',
          generation: 1,
          attempts: [attempt('t1', 1, 0.1), attempt('t2', 2, 0.2)],
          executions: [
            {
              attemptId: 't1',
              kind: 'initial',
              generation: 1,
              mechanism: null,
              continuationMode: null,
              continuationReason: null,
              messageId: null,
              reason: null,
              question: null,
              questionRevision: null,
            },
            {
              attemptId: 't2',
              kind: 'continuation',
              generation: 1,
              mechanism: 'resend',
              continuationMode: 'replay',
              continuationReason: 'Runtime kimi sem retomada de sessao',
              messageId: 'm1',
              reason: null,
              question: null,
              questionRevision: null,
            },
          ],
        }),
        item({
          slug: 'claude-agent',
          status: 'ok',
          currentAttemptId: 't4',
          generation: 2,
          attempts: [attempt('t2b', 1, 0.1), attempt('t3', 2, 0.1), attempt('t4', 3, 0.2)],
          executions: [
            {
              attemptId: 't2b',
              kind: 'initial',
              generation: 1,
              mechanism: null,
              continuationMode: null,
              continuationReason: null,
              messageId: null,
              reason: null,
              question: null,
              questionRevision: null,
            },
            {
              attemptId: 't3',
              kind: 'redispatch',
              generation: 2,
              mechanism: null,
              continuationMode: null,
              continuationReason: null,
              messageId: 'm2',
              reason: null,
              question: null,
              questionRevision: null,
            },
            {
              attemptId: 't4',
              kind: 'continuation',
              generation: 2,
              mechanism: 'session',
              continuationMode: 'session',
              continuationReason: null,
              messageId: 'm3',
              reason: null,
              question: null,
              questionRevision: null,
            },
          ],
        }),
      ],
    });
    api([done]);
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('geracao 1 · execucao 2: continuacao');
    expect(text).toContain('retomado por reenvio · Runtime kimi sem retomada de sessao');
    expect(text).toContain('geracao 2 · execucao 2: continuacao');
    expect(text).toContain('retomado por sessao');
    expect(text).toContain('kimi / k2');
    expect(text).toContain('Aberta para conducao: 25 min restantes');
    expect(text).toContain('custo total $0.7000');
    expect(text).toContain('geracao 2 · execucao 1: redisparo');
    expect(container.querySelector('[data-testid="swarm-running"]')).toBeNull();
    expect(text).toContain('Abortar run');
  });

  it('S5: pagina as runs por swarm:list-runs com o cursor devolvido', async () => {
    const first = fullRun({ runId: 'swarm-20261011_100000-aaa', status: 'done', items: [] });
    const older = fullRun({ runId: 'swarm-20261011_090000-bbb', status: 'done', items: [] });
    const byId = new Map([first, older].map((r) => [r.runId, r]));
    const listRuns = vi
      .fn()
      .mockResolvedValueOnce({ runs: [summary(first)], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ runs: [summary(older)], nextCursor: null });
    api([], {
      listRuns,
      getRunState: vi.fn(async (_s: string, runId: string) => byId.get(runId)),
    });
    await mount();
    expect(container.querySelectorAll('[data-testid="swarm-run"]')).toHaveLength(1);
    await act(async () => {
      button('Carregar runs anteriores').click();
    });
    await flush();
    expect(listRuns).toHaveBeenLastCalledWith('s1', 'cursor-1', 10);
    expect(container.querySelectorAll('[data-testid="swarm-run"]')).toHaveLength(2);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Carregar runs'))).toBe(false);
  });
});

describe('swarm-panel-model', () => {
  it('encadeia por parentRunId, trata pai ausente como raiz e ordena as cadeias da mais recente', () => {
    const a = fullRun({ runId: 'swarm-1-a' });
    const b = fullRun({ runId: 'swarm-2-b', parentRunId: 'swarm-1-a' });
    const c = fullRun({ runId: 'swarm-3-c', parentRunId: 'swarm-0-missing' });
    const chains = buildSwarmChains([b, c, a]);
    expect(chains.map((chain) => chain.runs.map((r) => r.runId))).toEqual([['swarm-3-c'], ['swarm-1-a', 'swarm-2-b']]);
  });
  it('conta so swarm agents nao terminais de runs vivas; badge do chip', () => {
    const live = fullRun({
      runId: 'r',
      items: [
        item({ slug: 'a', status: 'running' }),
        item({ slug: 'b', status: 'waiting' }),
        item({ slug: 'c', status: 'ok' }),
      ],
    });
    const finished = fullRun({ runId: 'f', status: 'done', items: [item({ slug: 'x', status: 'ok' })] });
    const aborted = fullRun({ runId: 'ab', status: 'aborted', items: [item({ slug: 'y', status: 'running' })] });
    const queued = fullRun({ runId: 'q', status: 'queued', items: [item({ slug: 'p', status: 'pending' })] });
    expect(countRunningSwarmAgents([live, finished, aborted, queued])).toBe(2);
    expect(swarmRunningBadge([live, finished])).toBe('2 rodando');
    expect(swarmRunningBadge([live, queued])).toBe('2 rodando, 1 na fila');
    expect(swarmRunningBadge([queued])).toBe('0 rodando, 1 na fila');
    expect(swarmRunningBadge([finished])).toBeNull();
  });
  it('soma o custo de todas as execucoes (D7) e marca parcial quando falta custo', () => {
    const all = fullRun({
      runId: 'r',
      items: [
        item({ slug: 'a', status: 'ok', attempts: [attempt('1', 1, 0.5), attempt('2', 2, 0.25)] }),
        item({ slug: 'b', status: 'ok', attempts: [attempt('3', 1, 0.25)] }),
      ],
    });
    expect(swarmRunCost(all)).toEqual({ costUsd: 1, partial: false });
    const missing = fullRun({
      runId: 'r2',
      items: [item({ slug: 'a', status: 'ok', attempts: [attempt('1', 1, null)] })],
    });
    expect(swarmRunCost(missing)).toEqual({ costUsd: null, partial: true });
  });
  it('mecanismo de continuacao: ultima execucao com modo; mechanism resend da S2 vale como reenvio', () => {
    const legacy = item({
      slug: 'a',
      status: 'ok',
      sessionLostReason: 'Sessao perdida por reinicio',
      executions: [
        {
          attemptId: 't2',
          kind: 'continuation',
          generation: 1,
          mechanism: 'resend',
          continuationMode: null,
          continuationReason: null,
          messageId: 'm',
          reason: null,
          question: null,
          questionRevision: null,
        },
      ],
    });
    expect(swarmContinuationBadge(legacy)).toEqual({
      label: 'retomado por reenvio',
      reason: 'Sessao perdida por reinicio',
    });
    expect(swarmContinuationBadge(item({ slug: 'b', status: 'ok' }))).toBeNull();
  });
  it('numera a execucao dentro da geracao (S5-V3)', () => {
    const execution = (attemptId: string, kind: 'initial' | 'continuation' | 'redispatch', generation: number) => ({
      attemptId,
      kind,
      generation,
      mechanism: null,
      continuationMode: null,
      continuationReason: null,
      messageId: null,
      reason: null,
      question: null,
      questionRevision: null,
    });
    const redispatched = item({
      slug: 'a',
      status: 'running',
      generation: 2,
      currentAttemptId: 't3',
      executions: [execution('t1', 'initial', 1), execution('t2', 'continuation', 1), execution('t3', 'redispatch', 2)],
    });
    expect(swarmExecutionLabel(redispatched)).toBe('geracao 2 · execucao 1: redisparo');
    expect(swarmExecutionLabel({ ...redispatched, currentAttemptId: 't2' })).toBe(
      'geracao 1 · execucao 2: continuacao',
    );
    expect(swarmExecutionLabel(item({ slug: 'b', status: 'pending' }))).toBe('geracao 1');
  });
  it('janela restante so em run open', () => {
    const now = Date.parse('2026-10-11T10:10:00.000Z');
    const open = fullRun({ runId: 'r', status: 'open', openedAt: '2026-10-11T10:00:00.000Z' });
    expect(swarmOpenWindowRemainingMs(open, now)).toBe(20 * 60_000);
    expect(swarmOpenWindowRemainingMs({ ...open, status: 'done' }, now)).toBeNull();
    expect(swarmOpenWindowRemainingMs(open, now + 60 * 60_000)).toBe(0);
  });
});

describe('Swarm sidebar: repo-graph, turnos e tokens por swarm agent', () => {
  it('mostra repo-graph sim/nao/sem repositorio e turnos + tokens ao vivo (ou "em andamento") enquanto roda, e os finais ao terminar', async () => {
    const running = fullRun({
      runId: 'swarm-20261012_100000-aaa',
      items: [
        item({
          slug: 'vivo',
          status: 'running',
          repoGraph: 'ready',
          currentAttemptId: 'u1',
          attempts: [attempt('u1', 1, null, null)],
          live: { attemptId: 'u1', turns: 3, inputTokens: 1200, outputTokens: 340 },
        }),
        item({
          slug: 'pendente',
          status: 'running',
          repoGraph: 'no-repository',
          currentAttemptId: 'u2',
          attempts: [attempt('u2', 1, null, null)],
          live: { attemptId: 'u2', turns: 1, inputTokens: null, outputTokens: null },
        }),
        item({
          slug: 'final',
          status: 'ok',
          repoGraph: 'off',
          attempts: [
            {
              ...attempt('t1', 1, 0.2),
              metrics: { costUsd: 0.2, costStatus: 'known', inputTokens: 5000, outputTokens: 800, turns: 7 },
            },
          ],
        }),
        item({
          slug: 'sem-uso',
          status: 'ok',
          attempts: [
            {
              ...attempt('t2', 1, null),
              metrics: { costUsd: null, costStatus: 'unknown', tokenStatus: 'not_reported' },
            },
          ],
        }),
      ],
    });
    api([running]);
    await mount();
    const usages = Object.fromEntries(
      [...container.querySelectorAll('[data-testid="swarm-agent"]')].map((el) => [
        el.getAttribute('data-slug'),
        el.querySelector('[data-testid="swarm-agent-usage"]')?.textContent,
      ]),
    );
    expect(usages).toEqual({
      vivo: 'turnos 3 · tokens 1200 entrada / 340 saida (ao vivo)',
      pendente: 'turnos 1 · tokens em andamento (ao vivo)',
      final: 'turnos 7 · tokens 5000 entrada / 800 saida',
      'sem-uso': 'turnos - · tokens nao reportados',
    });
    const repoGraph = Object.fromEntries(
      [...container.querySelectorAll('[data-testid="swarm-agent"]')].map((el) => [
        el.getAttribute('data-slug'),
        el.querySelector('[data-testid="swarm-agent-repo-graph"]')?.textContent,
      ]),
    );
    expect(repoGraph).toEqual({
      vivo: 'repo-graph: sim',
      pendente: 'repo-graph: sem repositorio',
      final: 'repo-graph: nao',
      'sem-uso': 'repo-graph: nao',
    });
    expect(formatSwarmUsage(swarmItemUsage(item({ slug: 'x', status: 'running', repoGraph: 'stale' })))).toBe(
      'turnos - · tokens nao reportados',
    );
    expect(swarmRepoGraphLabel(item({ slug: 'y', status: 'ok', repoGraph: 'stale' }))).toBe(
      'repo-graph: sim (graph desatualizado)',
    );
    const stale = item({
      slug: 'y',
      status: 'ok',
      currentAttemptId: 'old',
      live: { attemptId: 'other', turns: 9, inputTokens: 1, outputTokens: 1 },
      attempts: [{ ...attempt('old', 1, 0.1), metrics: { costUsd: 0.1, costStatus: 'known', turns: 2 } }],
    });
    expect(swarmItemUsage(stale)).toEqual({
      turns: 2,
      inputTokens: null,
      outputTokens: null,
      live: false,
      pending: false,
    });
  });
});

describe('PG-2: o painel so diz "sim" quando a tentativa vigente montou o repo-graph', () => {
  it('tentativa sem o binding mostra "nao nesta tentativa"; com binding (ou sem informacao) mantem o estado do item', () => {
    const base = item({ slug: 'x', status: 'running', repoGraph: 'ready', currentAttemptId: 't2' });
    const mounted = { ...attempt('t1', 1, 0.1), repoGraph: true };
    const unmounted = { ...attempt('t2', 2, null, null), repoGraph: false };
    expect(swarmRepoGraphLabel({ ...base, attempts: [mounted, unmounted] })).toBe(
      'repo-graph: nao nesta tentativa (nao montado)',
    );
    expect(swarmRepoGraphLabel({ ...base, currentAttemptId: 't1', attempts: [mounted, unmounted] })).toBe(
      'repo-graph: sim',
    );
    expect(swarmRepoGraphLabel({ ...base, attempts: [attempt('t2', 1, null, null)] })).toBe('repo-graph: sim');
    expect(swarmRepoGraphLabel({ ...base, repoGraph: 'off', attempts: [unmounted] })).toBe('repo-graph: nao');
  });
});
