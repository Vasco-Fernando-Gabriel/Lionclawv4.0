import type {
  SwarmExecution,
  SwarmItem,
  SwarmItemStatus,
  SwarmMessageRecord,
  SwarmRepoGraphState,
  SwarmRun,
  SwarmRunStatus,
} from '@/types/swarm';

export const SWARM_TERMINAL_ITEM_STATUSES: readonly SwarmItemStatus[] = ['ok', 'failed', 'cancelled'];
export const SWARM_ANIMATED_ITEM_STATUSES: readonly SwarmItemStatus[] = ['running', 'stopping', 'waiting', 'retrying'];
export const SWARM_RUNNING_ITEM_STATUSES: readonly SwarmItemStatus[] = ['running', 'stopping', 'waiting'];
export const SWARM_QUEUED_ITEM_STATUSES: readonly SwarmItemStatus[] = ['pending', 'retrying'];
export const SWARM_LIVE_RUN_STATUSES: readonly SwarmRunStatus[] = ['queued', 'running', 'open', 'aborting'];
export const SWARM_ABORTABLE_RUN_STATUSES: readonly SwarmRunStatus[] = ['queued', 'running', 'open'];
export const SWARM_SETTLED_DELIVERY_STATUSES: readonly NonNullable<SwarmRun['delivery']>['status'][] = [
  'delivered',
  'consumed-by-turn',
  'undeliverable',
  'delivery-error',
];

export function isSwarmDeliverySettled(run: Pick<SwarmRun, 'delivery'>): boolean {
  return run.delivery === undefined || SWARM_SETTLED_DELIVERY_STATUSES.includes(run.delivery.status);
}

type RunLike = Pick<SwarmRun, 'status' | 'items'>;

export function isSwarmItemTerminal(status: SwarmItemStatus): boolean {
  return SWARM_TERMINAL_ITEM_STATUSES.includes(status);
}

export function isSwarmRunLive(run: Pick<SwarmRun, 'status'>): boolean {
  return SWARM_LIVE_RUN_STATUSES.includes(run.status);
}

export function countSwarmAgents(runs: Iterable<RunLike>): { running: number; queued: number } {
  let running = 0;
  let queued = 0;
  for (const run of runs) {
    if (!isSwarmRunLive(run)) continue;
    for (const item of run.items ?? []) {
      if (SWARM_RUNNING_ITEM_STATUSES.includes(item.status)) running += 1;
      else if (SWARM_QUEUED_ITEM_STATUSES.includes(item.status)) queued += 1;
    }
  }
  return { running, queued };
}

export function countRunningSwarmAgents(runs: Iterable<RunLike>): number {
  return countSwarmAgents(runs).running;
}

export function hasAnimatedSwarmAgent(runs: Iterable<RunLike>): boolean {
  for (const run of runs)
    for (const item of run.items ?? []) if (SWARM_ANIMATED_ITEM_STATUSES.includes(item.status)) return true;
  return false;
}

export function swarmRunningBadge(runs: Iterable<RunLike>): string | null {
  const { running, queued } = countSwarmAgents(runs);
  if (running === 0 && queued === 0) return null;
  return `${running} rodando${queued > 0 ? `, ${queued} na fila` : ''}`;
}

export interface SwarmCost {
  costUsd: number | null;
  partial: boolean;
}

export function swarmItemCost(item: Pick<SwarmItem, 'attempts'>): SwarmCost {
  let costUsd: number | null = null;
  let partial = false;
  for (const attempt of item.attempts ?? []) {
    const metrics = attempt.metrics;
    if (!metrics || metrics.costUsd === null || metrics.costStatus === 'unknown') {
      partial = true;
      continue;
    }
    if (metrics.costStatus === 'estimated-partial') partial = true;
    costUsd = (costUsd ?? 0) + metrics.costUsd;
  }
  return { costUsd, partial };
}

export function swarmRunCost(run: RunLike): SwarmCost {
  let costUsd: number | null = null;
  let partial = false;
  for (const item of run.items ?? []) {
    const cost = swarmItemCost(item);
    if (cost.partial) partial = true;
    if (cost.costUsd !== null) costUsd = (costUsd ?? 0) + cost.costUsd;
  }
  return { costUsd, partial };
}

export function formatSwarmCost(cost: SwarmCost): string {
  if (cost.costUsd === null) return 'custo desconhecido';
  return `$${cost.costUsd.toFixed(4)}${cost.partial ? ' (parcial)' : ''}`;
}

export const SWARM_REPO_GRAPH_LABEL: Record<SwarmRepoGraphState, string> = {
  ready: 'sim',
  stale: 'sim (graph desatualizado)',
  'no-repository': 'sem repositorio',
  off: 'nao',
};

export function swarmRepoGraphLabel(item: Pick<SwarmItem, 'repoGraph' | 'attempts' | 'currentAttemptId'>): string {
  const state = item.repoGraph ?? 'off';
  const attempts = item.attempts ?? [];
  const current = attempts.find((a) => a.id === item.currentAttemptId) ?? attempts[attempts.length - 1];
  if ((state === 'ready' || state === 'stale') && current?.repoGraph === false)
    return 'repo-graph: nao nesta tentativa (nao montado)';
  return `repo-graph: ${SWARM_REPO_GRAPH_LABEL[state]}`;
}

export interface SwarmUsageView {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  live: boolean;
  pending: boolean;
}

export function swarmItemUsage(
  item: Pick<SwarmItem, 'attempts' | 'live' | 'currentAttemptId' | 'status'>,
): SwarmUsageView {
  const live = item.live;
  if (live && live.attemptId === item.currentAttemptId && SWARM_RUNNING_ITEM_STATUSES.includes(item.status)) {
    const pending = live.inputTokens === null && live.outputTokens === null;
    return {
      turns: live.turns,
      inputTokens: live.inputTokens,
      outputTokens: live.outputTokens,
      live: true,
      pending,
    };
  }
  let turns: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const attempt of item.attempts ?? []) {
    const metrics = attempt.metrics;
    if (!metrics) continue;
    if (typeof metrics.turns === 'number') turns = (turns ?? 0) + metrics.turns;
    if (metrics.tokenStatus === 'not_reported') continue;
    if (typeof metrics.inputTokens === 'number') inputTokens = (inputTokens ?? 0) + metrics.inputTokens;
    if (typeof metrics.outputTokens === 'number') outputTokens = (outputTokens ?? 0) + metrics.outputTokens;
  }
  return { turns, inputTokens, outputTokens, live: false, pending: false };
}

export function formatSwarmUsage(view: SwarmUsageView): string {
  const turns = view.turns === null ? 'turnos -' : `turnos ${view.turns}`;
  const tokens = view.pending
    ? 'tokens em andamento'
    : view.inputTokens === null && view.outputTokens === null
      ? 'tokens nao reportados'
      : `tokens ${view.inputTokens ?? 0} entrada / ${view.outputTokens ?? 0} saida`;
  return `${turns} · ${tokens}${view.live ? ' (ao vivo)' : ''}`;
}

export interface SwarmChain {
  id: string;
  runs: SwarmRun[];
}

export function buildSwarmChains(runs: Iterable<SwarmRun>): SwarmChain[] {
  const byId = new Map<string, SwarmRun>();
  for (const run of runs) byId.set(run.runId, run);
  const rootOf = (run: SwarmRun): string => {
    const seen = new Set<string>([run.runId]);
    let current = run;
    while (current.parentRunId && byId.has(current.parentRunId) && !seen.has(current.parentRunId)) {
      seen.add(current.parentRunId);
      current = byId.get(current.parentRunId)!;
    }
    return current.runId;
  };
  const groups = new Map<string, SwarmRun[]>();
  for (const run of byId.values()) {
    const root = rootOf(run);
    const group = groups.get(root);
    if (group) group.push(run);
    else groups.set(root, [run]);
  }
  const chains = [...groups.entries()].map(([id, members]) => ({
    id,
    runs: members.sort((a, b) => a.runId.localeCompare(b.runId)),
  }));
  chains.sort((a, b) => b.runs[b.runs.length - 1].runId.localeCompare(a.runs[a.runs.length - 1].runId));
  return chains;
}

export function swarmStageLabel(run: Pick<SwarmRun, 'stage' | 'mode' | 'items'>, index: number): string {
  const count = run.items?.length ?? 0;
  const name = run.stage?.trim() || run.mode;
  return `Etapa ${index + 1}: ${name}, ${count} swarm agent${count === 1 ? '' : 's'}`;
}

export const SWARM_EXECUTION_KIND_LABEL: Record<SwarmExecution['kind'], string> = {
  initial: 'inicial',
  retry: 'retentativa automatica',
  continuation: 'continuacao',
  redispatch: 'redisparo',
  repair: 'reparo de formato',
};

export function swarmCurrentExecution(item: Pick<SwarmItem, 'executions' | 'currentAttemptId'>): {
  execution: SwarmExecution | null;
  index: number;
} {
  const executions = item.executions ?? [];
  const byCurrent = item.currentAttemptId ? executions.findIndex((e) => e.attemptId === item.currentAttemptId) : -1;
  const position = byCurrent >= 0 ? byCurrent : executions.length - 1;
  if (position < 0) return { execution: null, index: -1 };
  const execution = executions[position];
  const index = executions.slice(0, position).filter((e) => e.generation === execution.generation).length;
  return { execution, index };
}

export function swarmExecutionLabel(item: Pick<SwarmItem, 'executions' | 'currentAttemptId' | 'generation'>): string {
  const { execution, index } = swarmCurrentExecution(item);
  const generation = execution?.generation ?? item.generation ?? 1;
  if (!execution) return `geracao ${generation}`;
  return `geracao ${generation} · execucao ${index + 1}: ${SWARM_EXECUTION_KIND_LABEL[execution.kind]}`;
}

export interface SwarmContinuationBadge {
  label: 'retomado por sessao' | 'retomado por reenvio';
  reason: string | null;
}

export function swarmContinuationBadge(
  item: Pick<SwarmItem, 'executions' | 'sessionLostReason'>,
): SwarmContinuationBadge | null {
  const executions = item.executions ?? [];
  for (let i = executions.length - 1; i >= 0; i--) {
    const execution = executions[i];
    const mode = execution.continuationMode ?? (execution.mechanism === 'resend' ? 'replay' : null);
    if (!mode) continue;
    return {
      label: mode === 'session' ? 'retomado por sessao' : 'retomado por reenvio',
      reason: execution.continuationReason ?? (mode === 'replay' ? item.sessionLostReason : null),
    };
  }
  return null;
}

export function swarmOpenWindowRemainingMs(
  run: Pick<SwarmRun, 'status' | 'openedAt' | 'settings'>,
  now: number,
): number | null {
  if (run.status !== 'open' || !run.openedAt) return null;
  const openedAt = Date.parse(run.openedAt);
  if (Number.isNaN(openedAt)) return null;
  const windowMs = run.settings?.openWindowMs;
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs)) return null;
  return Math.max(0, openedAt + windowMs - now);
}

export function formatSwarmRemaining(ms: number): string {
  if (ms >= 60_000) return `${Math.ceil(ms / 60_000)} min`;
  return `${Math.ceil(ms / 1000)} s`;
}

export const SWARM_MESSAGE_KIND_LABEL: Record<SwarmMessageRecord['kind'], string> = {
  message: 'Orquestrador',
  answer: 'Resposta do orquestrador a pergunta',
  redispatch: 'Redisparo',
  response: 'Swarm agent',
  discarded: 'Mensagem descartada',
};

export interface SwarmTimelineEntry {
  id: string;
  kind: SwarmMessageRecord['kind'] | 'question';
  label: string;
  at: string;
  text: string;
  attemptId: string | null;
  mechanism?: SwarmMessageRecord['mechanism'];
  costUsd?: number | null;
  cuts?: string[];
}

export function buildSwarmAgentTimeline(
  item: Pick<SwarmItem, 'executions' | 'attempts'>,
  messages: readonly SwarmMessageRecord[],
): SwarmTimelineEntry[] {
  const entries: SwarmTimelineEntry[] = [];
  for (const execution of item.executions ?? []) {
    if (!execution.question) continue;
    const attempt = (item.attempts ?? []).find((a) => a.id === execution.attemptId);
    entries.push({
      id: `question:${execution.attemptId}`,
      kind: 'question',
      label: 'Pergunta do swarm agent',
      at: attempt?.endedAt ?? attempt?.startedAt ?? '',
      text: execution.question,
      attemptId: execution.attemptId,
    });
  }
  for (const record of messages) {
    entries.push({
      id: record.id + ':' + record.kind + ':' + (record.attemptId ?? ''),
      kind: record.kind,
      label: SWARM_MESSAGE_KIND_LABEL[record.kind],
      at: record.at,
      text: record.text,
      attemptId: record.attemptId,
      mechanism: record.mechanism,
      costUsd: record.costUsd,
      cuts: record.cuts,
    });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
