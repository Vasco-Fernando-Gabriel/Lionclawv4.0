import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type {
  SwarmAttemptExecution,
  SwarmAttemptResult,
  SwarmResolvedMember,
  SwarmSessionContinuation,
} from '../agent-runtime/swarm-adapter';
import type {
  SwarmAttempt,
  SwarmCatalog,
  SwarmContinuationMode,
  SwarmDeliveryError,
  SwarmDeliveryKind,
  SwarmDeliveryState,
  SwarmError,
  SwarmExecution,
  SwarmExecutionKind,
  SwarmItem,
  SwarmItemStatus,
  SwarmLiveMetrics,
  SwarmMessageRecord,
  SwarmMetrics,
  SwarmOutcome,
  SwarmReadResult,
  SwarmRun,
  SwarmRunSummary,
  SwarmSessionRef,
  SwarmSettings,
  SwarmWaitAgentResult,
  SwarmWaitResult,
} from '../../../src/types/swarm';
import { SwarmArtifacts, parseSwarmTrailer, SWARM_MANIFEST_VERSION } from './artifacts';
import {
  buildContinuationPrompt,
  buildRepairPrompt,
  buildSessionContinuationPrompt,
  buildSessionRepairPrompt,
  swarmContextBudgetChars,
  swarmSessionRuntime,
  type SwarmRepairReason,
} from './continuation';
import { swarmRuntimeCapabilitiesFor } from './runtime-capabilities';
import {
  SwarmDomainError,
  briefingOf,
  inputHash,
  normalizedItems,
  parseSwarmInput,
  parseSwarmMessage,
  parseSwarmRedispatch,
  parseSwarmSlug,
  swarmItemPrompt,
  swarmTargetPathWarnings,
  validateSwarmSettings,
} from './validation';

const terminal = (status: string) => ['done', 'partial', 'failed', 'aborted'].includes(status);
const itemTerminal = (status: string) => ['ok', 'failed', 'cancelled'].includes(status);
const working = (run: SwarmRun) => !terminal(run.status) && run.status !== 'open';
const outcomeOf = (run: SwarmRun): 'done' | 'partial' | 'failed' =>
  run.items.every((i) => i.status === 'ok') ? 'done' : run.items.some((i) => i.status === 'ok') ? 'partial' : 'failed';
const stamp = (time: number) => new Date(time).toISOString();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
export const SWARM_WAIT_MAX_SLICE_MS = 50_000;
export const SWARM_WAIT_LEASE_MS = 90_000;
const READ_CAP = 64 * 1024;
const WAIT_FINDINGS_CAP = 16 * 1024;
const RESPONSE_LOG_CAP = 32 * 1024;
const SESSION_LOST_ON_BOOT = 'Sessão perdida por reinício do aplicativo; reenvio de histórico.';
const SETTLED_STATES: ReadonlySet<SwarmDeliveryState> = new Set(['delivered', 'consumed-by-turn', 'undeliverable']);
export const SWARM_RETAINED_TERMINAL_RUNS = 20;
export const SWARM_WAIT_CANCELLED_REASON =
  'Espera interrompida (turno encerrado ou chat parado); a run continua em segundo plano e a conclusão chega num turno automático.';
const FINAL_INSTRUCTION = (slug: string) =>
  `Grave relatório com # título, ## Resumo, ## Achados, ## Fora de escopo / não verificado. Seções livres (ex.: a tabela pedida em FORMATO) entram antes de ## Fora de escopo / não verificado. Cada achado factual exige arquivo:linha ou URL. Se faltar informação que só o orquestrador tem, pare e pergunte: STATUS: needs-input com a linha QUESTION: <uma frase>. Termine com:\n---\nSTATUS: ok | failed | needs-input\nQUESTION: <só com needs-input>\nSUMMARY: resumo em uma linha\nFINDINGS: ${slug}.md`;
export interface SwarmStartContext {
  sessionId: string;
  swarmEnabled: boolean;
  readRoots: readonly string[];
}
export interface SwarmDeliveryDescriptor {
  kind: SwarmDeliveryKind;
  revision: number;
  slug?: string;
  attemptId?: string;
  reservedBy?: string;
  leaseUntil?: number;
}
export type SwarmAuditAction = 'start' | 'abort' | 'stop' | 'message' | 'redispatch';
export interface SwarmRunnerDependencies {
  artifacts: SwarmArtifacts;
  resolve: (member: SwarmItem['member'], cwd: string) => Promise<SwarmResolvedMember>;
  execute: (request: SwarmAttemptExecution) => Promise<SwarmAttemptResult>;
  closeSession?: (run: SwarmRun, item: SwarmItem) => Promise<void> | void;
  pinSession?: (run: SwarmRun, item: SwarmItem, pinned: boolean) => Promise<void> | void;
  catalog: () => Promise<SwarmCatalog>;
  readSettings: () => SwarmSettings;
  beginAdmission?: () => { assertActive: () => void; release: () => void };
  writeSettings: (settings: SwarmSettings) => void;
  project: (summary: SwarmRunSummary) => void;
  audit?: (event: { sessionId: string; runId: string; action: SwarmAuditAction; itemCount: number }) => void;
  deliver: (run: SwarmRun, envelope: string, descriptor: SwarmDeliveryDescriptor) => void;
  deliveryState?: (
    run: SwarmRun,
    kind: SwarmDeliveryKind,
    revision: number,
  ) => { state: SwarmDeliveryState; error: string | null } | undefined;
  reserveDelivery?: (
    run: SwarmRun,
    kind: SwarmDeliveryKind,
    revision: number,
    waitId: string,
    leaseUntil: number,
  ) => boolean;
  renewDeliveryLease?: (waitId: string, leaseUntil: number) => void;
  releaseDeliveryReservation?: (waitId: string) => void;
  consumeDelivery?: (
    run: SwarmRun,
    kind: SwarmDeliveryKind,
    revision: number,
    waitId: string,
    turnId: string,
  ) => boolean;
  cancelDelivery?: (run: SwarmRun, kind: SwarmDeliveryKind, revision: number, reason: string) => void;
  contextBudget?: (item: SwarmItem) => number;
  recoverAttempt?: (run: SwarmRun, item: SwarmItem, attempt: SwarmAttempt) => Promise<boolean>;
  now?: () => number;
  random?: () => number;
  reportError: (error: unknown, context: string) => void;
}
export interface SwarmWaitInput {
  sessionId: string;
  runId: string;
  waitId: string;
  turnId: string;
  slugs?: string[];
  sliceMs?: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}
interface ActiveAttempt {
  controller: AbortController;
  reason: SwarmOutcome | null;
  completion: Promise<void>;
  stopped: boolean;
  redispatch: boolean;
}
interface WaitEntry {
  waitId: string;
  runId: string;
  turnId: string;
  slugs: string[] | null;
  leaseUntil: number;
  settledAtStart: boolean;
}
const settledRun = (run: SwarmRun) => (run.status === 'open' || terminal(run.status)) && run.terminalRevision !== null;
interface DeliveryRequest {
  run: SwarmRun;
  envelope: string;
  descriptor: SwarmDeliveryDescriptor;
}
export function summarizeSwarm(run: SwarmRun): SwarmRunSummary {
  const metrics = run.items.flatMap((i) => i.attempts.map((a) => a.metrics));
  const known = metrics.filter((m) => m.costUsd !== null);
  return {
    runId: run.runId,
    chatSessionId: run.chatSessionId,
    revision: run.revision,
    mode: run.mode,
    status: run.status,
    itemCount: run.items.length,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    costUsd: known.length ? known.reduce((n, m) => n + (m.costUsd ?? 0), 0) : null,
    parentRunId: run.parentRunId,
    stage: run.stage,
  };
}
export function swarmItemSignatures(run: SwarmRun): Record<string, string> {
  return Object.fromEntries(
    run.items.map((i) => [
      i.slug,
      `${i.status}|${i.attempts.length}|${i.generation}|${i.attempts.at(-1)?.validatedContentHash ?? ''}`,
    ]),
  );
}
const safe = (s: string) =>
  s
    .replace(/[\r\n|]/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
export function swarmEnvelope(run: SwarmRun, previous: Record<string, string> | null = null): string {
  const metrics = run.items.flatMap((i) => i.attempts.map((a) => a.metrics));
  const knownCost = metrics.reduce((n, m) => n + (m.costUsd ?? 0), 0);
  const incomplete = metrics.some((m) => m.costUsd === null || m.costStatus !== 'known');
  const current = swarmItemSignatures(run);
  const changed = previous ? run.items.filter((i) => previous[i.slug] !== current[i.slug]) : run.items;
  const unchanged = previous ? run.items.filter((i) => previous[i.slug] === current[i.slug]) : [];
  const line = (i: SwarmItem) =>
    `[${i.status}] ${i.slug} | ${safe((i.status === 'failed' ? i.error?.message : null) ?? i.summary ?? i.error?.message ?? 'Sem resultado')} | ${i.findingsFile ?? '(sem findings completo)'} | ${i.attempts.length} exec | geracao ${i.generation}`;
  return [
    previous
      ? `SWARM RUN ${run.runId} (entrega incremental, revisão ${run.terminalRevision ?? run.revision})`
      : `SWARM RUN ${run.runId}`,
    ...(run.stage || run.parentRunId
      ? [`etapa: ${run.stage ?? '(sem nome)'}${run.parentRunId ? ` | run anterior: ${run.parentRunId}` : ''}`]
      : []),
    `status: ${run.status === 'open' ? `${outcomeOf(run)} (run aberta para conducao)` : run.status} | items: ${run.items.length} | ok: ${run.items.filter((i) => i.status === 'ok').length} | failed: ${run.items.filter((i) => i.status === 'failed').length} | cancelled: ${run.items.filter((i) => i.status === 'cancelled').length}`,
    ...(previous
      ? [`alterados desde a entrega anterior: ${changed.length ? changed.map((i) => i.slug).join(', ') : 'nenhum'}`]
      : []),
    ...changed.map(line),
    ...(unchanged.length ? [`sem mudança desde a entrega anterior: ${unchanged.map((i) => i.slug).join(', ')}`] : []),
    `Custo ${incomplete ? 'conhecido parcial/estimado' : 'estimado'}: US$ ${knownCost.toFixed(6)}${incomplete ? ' (há uso desconhecido ou estimativas parciais)' : ''}`,
    'Relatórios e retornos integrais preservados nos artifacts da run. Falhas/cancelamentos não significam ausência de problemas no alvo.',
  ].join('\n');
}
export function swarmQuestionEnvelope(run: SwarmRun, item: SwarmItem, attemptId: string, question: string): string {
  return [
    `SWARM QUESTION ${run.runId}`,
    `swarm agent: ${item.slug} | tentativa: ${attemptId} | geração ${item.generation}`,
    `pergunta: ${safe(question)}`,
    `Responda com swarm_message(runId: "${run.runId}", slug: "${item.slug}", message, attemptId: "${attemptId}"). O swarm agent fica aguardando até o timeout de inatividade.`,
  ].join('\n');
}
export type SwarmStopOrigin = 'user' | 'orchestrator';
export function swarmProgressLine(run: SwarmRun): string {
  const by = (status: SwarmItemStatus[]) => run.items.filter((i) => status.includes(i.status));
  const running = by(['running', 'stopping']);
  const parts = [
    `${running.length} swarm agent${running.length === 1 ? '' : 's'} rodando${running.length ? `: ${running.map((i) => i.slug).join(', ')}` : ''}`,
  ];
  const waiting = by(['waiting']);
  if (waiting.length) parts.push(`${waiting.length} aguardando resposta: ${waiting.map((i) => i.slug).join(', ')}`);
  const queued = by(['pending', 'retrying']);
  if (queued.length) parts.push(`${queued.length} na fila`);
  const finished = by(['ok', 'failed', 'cancelled']);
  if (finished.length) parts.push(`${finished.length} concluido${finished.length === 1 ? '' : 's'}`);
  return parts.join('; ');
}
export const SWARM_QUOTA_MESSAGE = 'Limite de uso do provedor; tente mais tarde ou troque o runtime.';
function quotaMessage(raw: string): string {
  const reset =
    /reset(?:s|a|ar[aá])?\s+(?:at|em|[aà]s)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
      raw,
    )?.[1];
  return `${SWARM_QUOTA_MESSAGE}${reset ? ` Reset previsto: ${reset}.` : ''} Provedor: ${raw}`;
}
function truncate(text: string | null, cap: number): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= cap) return { text, truncated: false };
  return { text: `${text.slice(0, cap)}\n[... truncado; use swarm_read ou abra o relatório]`, truncated: true };
}

export class SwarmRunner {
  private readonly runs = new Map<string, SwarmRun>();
  private readonly resolved = new Map<string, SwarmResolvedMember>();
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly live = new Map<string, SwarmLiveMetrics>();
  private readonly waits = new Map<string, WaitEntry>();
  private readonly listeners = new Set<(event: { runId: string; chatSessionId: string; revision: number }) => void>();
  private admission: Promise<unknown> = Promise.resolve();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private recovered = false;
  private closing = false;
  private fatal: Error | null = null;
  private cursor = 0;
  private recoveryPromise: Promise<void> | null = null;
  private cancelEpoch = 0;
  private readonly admitting = new Map<string, number>();
  private readonly requestIndex = new Map<string, string>();
  private readonly sessionClosures = new Set<Promise<void>>();
  private readonly expiring = new Set<string>();
  private dispatching = false;
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(private readonly deps: SwarmRunnerDependencies) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }
  subscribe(cb: (event: { runId: string; chatSessionId: string; revision: number }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getSettings(): SwarmSettings {
    return validateSwarmSettings(this.deps.readSettings());
  }
  setSettings(settings: SwarmSettings): SwarmSettings {
    const valid = validateSwarmSettings(settings);
    this.deps.writeSettings(valid);
    this.schedule();
    return valid;
  }
  async getCatalog(_sessionId: string, enabled: boolean): Promise<SwarmCatalog> {
    if (!enabled) throw new SwarmDomainError('swarm-disabled', 'Ative o chip Swarm para consultar o catálogo.');
    return this.deps.catalog();
  }
  private serialized<T>(fn: () => Promise<T> | T): Promise<T> {
    const operation = this.admission.then(fn);
    this.admission = operation.catch(() => undefined);
    return operation;
  }
  private audit(run: SwarmRun, action: SwarmAuditAction): void {
    try {
      this.deps.audit?.({ sessionId: run.chatSessionId, runId: run.runId, action, itemCount: run.items.length });
    } catch (error) {
      this.deps.reportError(error, 'Auditoria Swarm indisponível');
    }
  }
  private emit(run: SwarmRun): void {
    for (const cb of this.listeners) {
      try {
        cb({ runId: run.runId, chatSessionId: run.chatSessionId, revision: run.revision });
      } catch (error) {
        this.deps.reportError(error, 'listener');
      }
    }
  }
  private checkpoint(run: SwarmRun, emit = true): void {
    run.revision++;
    try {
      this.deps.artifacts.save(run);
    } catch (error) {
      this.fatal = error instanceof Error ? error : new Error(String(error));
      for (const task of this.active.values()) task.controller.abort(this.fatal);
      this.deps.reportError(error, 'persistência Swarm interrompida');
      throw error;
    }
    try {
      this.deps.project(summarizeSwarm(run));
    } catch (error) {
      this.deps.reportError(error, 'índice Swarm será reconstruído');
    }
    if (emit) this.emit(run);
  }
  private ensureOpen(): void {
    if (this.fatal) throw new SwarmDomainError('swarm-unavailable', `Swarm indisponível: ${this.fatal.message}`);
    if (!this.recovered || this.closing)
      throw new SwarmDomainError('swarm-not-ready', 'Swarm inicializando ou encerrando.');
  }
  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      try {
        this.schedule();
      } catch (error) {
        this.deps.reportError(error, 'fila Swarm');
      }
    }, 1000);
    this.ticker.unref?.();
  }
  private runOf(sessionId: string, runId: string): SwarmRun {
    let run = this.runs.get(runId);
    if (!run) {
      try {
        run = this.deps.artifacts.load(runId);
      } catch {
        throw new SwarmDomainError('run-denied', 'Run não encontrada nesta sessão.');
      }
      if (!terminal(run.status)) this.runs.set(runId, run);
    }
    if (run.chatSessionId !== sessionId) throw new SwarmDomainError('run-denied', 'Run não encontrada nesta sessão.');
    return run;
  }
  private itemOf(run: SwarmRun, slug: string): SwarmItem {
    const item = run.items.find((i) => i.slug === parseSwarmSlug(slug));
    if (!item) throw new SwarmDomainError('agent-not-found', `Swarm agent ${slug} não existe nesta run.`);
    return item;
  }
  private resolvedOf(run: SwarmRun, item: SwarmItem): SwarmResolvedMember {
    const key = `${run.runId}/${item.slug}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let snapshot: {
      agent: SwarmResolvedMember['agent'];
      config: SwarmResolvedMember['config'];
      repoGraph?: SwarmResolvedMember['repoGraph'];
      repoGraphState?: SwarmResolvedMember['repoGraphState'];
    };
    try {
      snapshot = JSON.parse(this.deps.artifacts.read(`${run.runId}/${item.resolvedConfigFile}`));
    } catch {
      throw new SwarmDomainError('snapshot-missing', 'Snapshot de execução indisponível.');
    }
    const resolved: SwarmResolvedMember = {
      runtime: item.runtime,
      model: item.model,
      snapshot: snapshot as unknown as Record<string, unknown>,
      agent: snapshot.agent,
      config: snapshot.config,
      repoGraph: snapshot.repoGraph ?? null,
      repoGraphState: snapshot.repoGraphState ?? item.repoGraph ?? 'off',
    };
    this.resolved.set(key, resolved);
    return resolved;
  }
  private executionOf(item: SwarmItem, attemptId: string | null): SwarmExecution | undefined {
    return attemptId ? item.executions.find((e) => e.attemptId === attemptId) : undefined;
  }
  private requestKey(sessionId: string, requestId: string): string {
    return `${sessionId}\n${requestId}`;
  }
  private previousRun(sessionId: string, requestId: string): SwarmRun | undefined {
    const runId = this.requestIndex.get(this.requestKey(sessionId, requestId));
    if (!runId) return undefined;
    try {
      return this.runOf(sessionId, runId);
    } catch {
      return undefined;
    }
  }
  private prune(): void {
    const closed = [...this.runs.values()]
      .filter((run) => terminal(run.status))
      .sort((a, b) => b.runId.localeCompare(a.runId));
    for (const run of closed.slice(SWARM_RETAINED_TERMINAL_RUNS)) {
      this.runs.delete(run.runId);
      for (const item of run.items) this.resolved.delete(`${run.runId}/${item.slug}`);
    }
  }
  get retainedRunCount(): number {
    return this.runs.size;
  }
  async start(context: SwarmStartContext, value: unknown): Promise<{ runId: string; status: SwarmRun['status'] }> {
    const epoch = this.cancelEpoch;
    this.admitting.set(context.sessionId, (this.admitting.get(context.sessionId) ?? 0) + 1);
    const operation = this.serialized(async () => {
      let lease: ReturnType<NonNullable<SwarmRunnerDependencies['beginAdmission']>> | undefined;
      const assertAdmission = () => {
        this.ensureOpen();
        if (epoch !== this.cancelEpoch)
          throw new SwarmDomainError('admission-cancelled', 'Admissão cancelada pelo encerramento de acesso.');
        lease?.assertActive();
      };
      try {
        assertAdmission();
        lease = this.deps.beginAdmission?.();
        assertAdmission();
        if (!context.sessionId || !context.swarmEnabled)
          throw new SwarmDomainError('swarm-disabled', 'Ative o chip Swarm para iniciar.');
        const input = parseSwarmInput(value, context.readRoots);
        const hash = inputHash(input);
        const previous = this.previousRun(context.sessionId, input.requestId);
        if (previous) {
          if (previous.requestHash !== hash)
            throw new SwarmDomainError('request-conflict', 'requestId já utilizado com outro plano.');
          return { runId: previous.runId, status: previous.status };
        }
        if (input.parentRunId) {
          try {
            this.runOf(context.sessionId, input.parentRunId);
          } catch {
            throw new SwarmDomainError('invalid-input', 'parentRunId não pertence a esta conversa.');
          }
        }
        const settings = this.getSettings();
        const plan = normalizedItems(input);
        const snapshots: SwarmResolvedMember[] = [];
        for (const item of plan) {
          snapshots.push(await this.deps.resolve(item.member, input.cwd));
          assertAdmission();
        }
        assertAdmission();
        const now = stamp(this.now());
        const runId = `swarm-${now.slice(0, 10).replace(/-/g, '')}_${now.slice(11, 19).replace(/:/g, '')}-${hex(3)}`;
        const run: SwarmRun = {
          schemaVersion: SWARM_MANIFEST_VERSION,
          revision: 1,
          terminalRevision: null,
          runId,
          chatSessionId: context.sessionId,
          requestId: input.requestId,
          requestHash: hash,
          mode: input.mode,
          cwd: input.cwd,
          objective: input.objective,
          parentRunId: input.parentRunId ?? null,
          stage: input.stage ?? null,
          status: 'queued',
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          openedAt: null,
          deliveredSignatures: null,
          deliveryError: null,
          settings,
          items: plan.map(({ mission: _mission, briefing: _briefing, ...item }, i) => ({
            ...item,
            prompt: swarmItemPrompt(input, plan[i], snapshots[i].agent),
            runtime: snapshots[i].runtime,
            model: snapshots[i].model,
            resolvedConfigFile: `_attempts/${item.slug}/config.json`,
            status: 'pending',
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
            repoGraph: snapshots[i].repoGraphState ?? 'off',
            targetWarning: swarmTargetPathWarnings(item.target, input.cwd).join('; ') || null,
            findingsFile: null,
            summary: null,
            lastSignalAt: null,
            error: null,
          })),
        };
        this.deps.artifacts.create(run);
        this.runs.set(runId, run);
        this.requestIndex.set(this.requestKey(context.sessionId, input.requestId), runId);
        try {
          for (let i = 0; i < run.items.length; i++) {
            this.deps.artifacts.atomic(
              `${runId}/${run.items[i].resolvedConfigFile}`,
              JSON.stringify(snapshots[i].snapshot, null, 2),
            );
            this.resolved.set(`${runId}/${run.items[i].slug}`, snapshots[i]);
          }
        } catch (error) {
          for (const item of run.items) {
            item.status = 'failed';
            item.error = {
              code: 'snapshot-persistence',
              message: 'Falha ao persistir configuração; nenhum worker iniciado.',
              retryable: false,
            };
          }
          this.evaluate(run);
          throw new SwarmDomainError(
            'snapshot-persistence',
            `Run ${runId} falhou antes de iniciar: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.audit(run, 'start');
        try {
          this.deps.project(summarizeSwarm(run));
        } catch (error) {
          this.deps.reportError(error, 'índice Swarm');
        }
        this.emit(run);
        this.ensureTicker();
        queueMicrotask(() => {
          try {
            this.schedule();
          } catch (error) {
            this.deps.reportError(error, 'admissão Swarm');
          }
        });
        return { runId, status: 'queued' as const };
      } finally {
        lease?.release();
      }
    });
    return operation.finally(() => {
      const remaining = (this.admitting.get(context.sessionId) ?? 1) - 1;
      if (remaining) this.admitting.set(context.sessionId, remaining);
      else this.admitting.delete(context.sessionId);
    });
  }
  async getRunState(sessionId: string, runId: string): Promise<SwarmRun> {
    if (this.fatal)
      throw new SwarmDomainError(
        'swarm-unavailable',
        `Persistência Swarm indisponível; execuções interrompidas: ${this.fatal.message}`,
      );
    const run = this.deps.artifacts.load(runId);
    if (run.chatSessionId !== sessionId) throw new SwarmDomainError('run-denied', 'Run não pertence a esta sessão.');
    const delivery =
      run.terminalRevision === null ? undefined : this.deps.deliveryState?.(run, 'terminal', run.terminalRevision);
    if (delivery) run.delivery = { status: delivery.state, error: delivery.error };
    else if (run.deliveryError?.kind === 'terminal' && run.deliveryError.revision === run.terminalRevision)
      run.delivery = { status: 'delivery-error', error: run.deliveryError.message };
    run.runtimeCapabilities = swarmRuntimeCapabilitiesFor(run.items.map((item) => item.runtime));
    const clone = structuredClone(run);
    for (const item of clone.items) {
      const live = this.live.get(`${run.runId}/${item.slug}`);
      if (live && live.attemptId === item.currentAttemptId) item.live = { ...live };
    }
    return clone;
  }
  async getFindingsPath(sessionId: string, runId: string, slug: string): Promise<string> {
    const run = await this.getRunState(sessionId, runId);
    const item = run.items.find((i) => i.slug === slug);
    const attempt = [...(item?.attempts ?? [])].reverse().find((a) => a.outcome === 'ok' && a.validatedContentHash);
    if (!item?.findingsFile || !attempt?.validatedContentHash)
      throw new SwarmDomainError('findings-unavailable', 'Este item não possui findings completo.');
    return this.deps.artifacts.verifiedFindingsPath(runId, slug, attempt.validatedContentHash);
  }
  async getMessages(
    sessionId: string,
    runId: string,
    slug: string,
  ): Promise<{ runId: string; slug: string; messages: SwarmMessageRecord[] }> {
    const run = await this.getRunState(sessionId, runId);
    const item = this.itemOf(run, slug);
    return { runId: run.runId, slug: item.slug, messages: this.deps.artifacts.readMessages(run.runId, item.slug) };
  }
  async listRuns(
    sessionId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ runs: SwarmRunSummary[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new SwarmDomainError('invalid-limit', 'Limite precisa estar entre 1 e 50.');
    const all = this.deps.artifacts
      .list()
      .map((id) => this.deps.artifacts.load(id))
      .filter((r) => r.chatSessionId === sessionId)
      .sort((a, b) => b.runId.localeCompare(a.runId));
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null;
    if (after && !all.some((r) => r.runId === after)) throw new SwarmDomainError('invalid-cursor', 'Cursor inválido.');
    const start = after ? all.findIndex((r) => r.runId === after) + 1 : 0;
    const page = all.slice(start, start + limit);
    return {
      runs: page.map(summarizeSwarm),
      nextCursor:
        start + page.length < all.length ? Buffer.from(page[page.length - 1].runId).toString('base64url') : null,
    };
  }
  hasActiveSession(sessionId: string): boolean {
    return [...this.runs.values()].some((r) => r.chatSessionId === sessionId && working(r));
  }
  hasActiveWork(sessionId?: string): boolean {
    return sessionId
      ? this.hasActiveSession(sessionId) || this.admitting.has(sessionId)
      : this.activeRunCount > 0 || this.admitting.size > 0;
  }
  get activeRunCount(): number {
    return [...this.runs.values()].filter(working).length;
  }
  questionPending(runId: string, slug: string, attemptId: string): boolean {
    const run = this.runs.get(runId);
    const item = run?.items.find((i) => i.slug === slug);
    return !!item && item.status === 'waiting' && item.currentAttemptId === attemptId && !terminal(run!.status);
  }
  async abort(sessionId: string, runId: string): Promise<SwarmRun> {
    return this.serialized(() => {
      const run = this.runOf(sessionId, runId);
      if (terminal(run.status) || run.status === 'aborting') return structuredClone(run);
      this.audit(run, 'abort');
      if (run.status === 'open') {
        this.close(run, null);
        return structuredClone(run);
      }
      run.status = 'aborting';
      for (const item of run.items) {
        this.discardInbox(run, item, 'run abortada');
        item.launch = null;
        if (item.status === 'pending' || item.status === 'retrying') {
          item.status = 'cancelled';
          item.error = { code: 'cancelled', message: 'Cancelado antes de executar.', retryable: false };
        } else if (item.status === 'waiting') this.cancelWaiting(run, item, 'Cancelado pelo aborto da run.');
        else if (!itemTerminal(item.status)) item.status = 'stopping';
      }
      this.checkpoint(run);
      for (const item of run.items) {
        const task = this.active.get(`${runId}/${item.slug}`);
        if (task) {
          task.reason = 'cancelled';
          task.stopped = true;
          task.redispatch = false;
          task.controller.abort(new Error('Swarm cancelado'));
        }
      }
      this.evaluate(run);
      return structuredClone(run);
    });
  }
  async stop(
    sessionId: string,
    runId: string,
    slug: string,
    origin: SwarmStopOrigin = 'orchestrator',
  ): Promise<{ changed: boolean; status: SwarmItemStatus }> {
    const who = origin === 'user' ? 'usuario' : 'orquestrador';
    return this.serialized(() => {
      this.ensureOpen();
      const run = this.runOf(sessionId, runId);
      const item = this.itemOf(run, slug);
      if (run.status === 'aborted' || run.status === 'aborting')
        throw new SwarmDomainError('run_aborted', 'Run abortada; nada a parar.');
      if (itemTerminal(item.status)) return { changed: false, status: item.status };
      this.discardInbox(run, item, 'swarm agent parado');
      item.launch = null;
      this.dropSession(run, item, null);
      const task = this.active.get(`${runId}/${item.slug}`);
      if (task) {
        task.reason = 'cancelled';
        task.stopped = true;
        task.redispatch = false;
        task.controller.abort(new Error(`Swarm agent parado pelo ${who}`));
        item.status = 'stopping';
      } else if (item.status === 'waiting') this.cancelWaiting(run, item, `Parado pelo ${who}.`);
      else {
        item.status = 'cancelled';
        item.nextAttemptAt = null;
        item.error = { code: 'cancelled', message: `Parado pelo ${who} antes de executar.`, retryable: false };
      }
      this.audit(run, 'stop');
      this.checkpoint(run);
      this.evaluate(run);
      return { changed: true, status: item.status };
    });
  }
  async message(
    sessionId: string,
    runId: string,
    slug: string,
    value: unknown,
    attemptId?: string,
    turn?: { turnId: string },
  ): Promise<{ accepted: true; queued: boolean; status: SwarmItemStatus; generation: number; messageId: string }> {
    return this.serialized(() => {
      this.ensureOpen();
      const run = this.runOf(sessionId, runId);
      const item = this.itemOf(run, slug);
      this.assertConductible(run);
      const text = parseSwarmMessage(value);
      if (attemptId !== undefined) {
        if (item.status !== 'waiting' || item.currentAttemptId !== attemptId)
          throw new SwarmDomainError(
            'stale_attempt',
            `Resposta atrasada: o swarm agent ${item.slug} está ${item.status}${item.currentAttemptId ? ` (tentativa atual ${item.currentAttemptId})` : ''} e a pergunta da tentativa ${attemptId} não está mais aberta. Envie uma mensagem nova ou redispare.`,
          );
      }
      const id = `msg-${item.inbox.length + item.executions.length + 1}-${hex(3)}`;
      const at = stamp(this.now());
      const record = { id, message: text, attemptId: attemptId ?? null, createdAt: at };
      this.audit(run, 'message');
      if (item.status === 'waiting') {
        item.inbox.unshift(record);
        this.pinSession(run, item, false);
        const execution = this.executionOf(item, item.currentAttemptId);
        if (execution?.questionRevision !== null && execution?.questionRevision !== undefined)
          this.safely(
            () => this.deps.consumeDelivery?.(run, 'question', execution.questionRevision!, '', turn?.turnId ?? ''),
            'consumo da pergunta Swarm',
          );
        item.question = null;
        this.log(run, item, { id, kind: 'answer', attemptId: item.currentAttemptId, at, text });
      } else {
        item.inbox.push(record);
        this.log(run, item, { id, kind: 'message', attemptId: item.currentAttemptId, at, text });
      }
      if (item.status === 'waiting' || itemTerminal(item.status)) {
        this.prepareContinuation(run, item);
        if (item.status === 'failed') {
          this.checkpoint(run);
          throw new SwarmDomainError('context-overflow', item.error?.message ?? 'Histórico excede o contexto.');
        }
        this.reopen(run);
        this.checkpoint(run);
        this.ensureTicker();
        queueMicrotask(() => this.safely(() => this.schedule(), 'fila Swarm'));
        return {
          accepted: true as const,
          queued: false,
          status: item.status,
          generation: item.generation,
          messageId: id,
        };
      }
      this.checkpoint(run);
      return { accepted: true as const, queued: true, status: item.status, generation: item.generation, messageId: id };
    });
  }
  async redispatch(
    sessionId: string,
    runId: string,
    slug: string,
    value: unknown,
  ): Promise<{ accepted: true; status: SwarmItemStatus; generation: number }> {
    return this.serialized(() => {
      this.ensureOpen();
      const run = this.runOf(sessionId, runId);
      const item = this.itemOf(run, slug);
      this.assertConductible(run);
      const briefing = parseSwarmRedispatch(value);
      const resolved = this.resolvedOf(run, item);
      const { objective, knownContext, ...rest } = briefing;
      item.prompt = swarmItemPrompt(
        { objective: run.objective, knownContext },
        { member: item.member, mission: objective, target: item.target, briefing: briefingOf(rest) },
        resolved.agent,
      );
      this.discardInbox(run, item, 'redisparo');
      const id = `redispatch-${item.generation + 1}-${hex(3)}`;
      this.log(run, item, {
        id,
        kind: 'redispatch',
        attemptId: item.currentAttemptId,
        at: stamp(this.now()),
        text: JSON.stringify(briefing),
      });
      if (item.status === 'waiting') this.cancelWaiting(run, item, 'Redisparado pelo orquestrador.');
      this.dropSession(run, item, null);
      item.generation++;
      item.autoRetries = 0;
      item.question = null;
      item.summary = null;
      item.error = null;
      item.nextAttemptAt = null;
      item.launch = {
        kind: 'redispatch',
        messageId: id,
        promptFile: null,
        mode: null,
        fallbackPromptFile: null,
        reason: null,
      };
      const task = this.active.get(`${runId}/${item.slug}`);
      if (task) {
        task.reason = 'cancelled';
        task.redispatch = true;
        task.controller.abort(new Error('Swarm agent redisparado pelo orquestrador'));
        item.status = 'stopping';
      } else item.status = 'pending';
      this.reopen(run);
      this.audit(run, 'redispatch');
      this.checkpoint(run);
      this.ensureTicker();
      queueMicrotask(() => this.safely(() => this.schedule(), 'fila Swarm'));
      return { accepted: true as const, status: item.status, generation: item.generation };
    });
  }
  async read(sessionId: string, runId: string, slug: string): Promise<SwarmReadResult> {
    this.ensureOpen();
    const run = this.runOf(sessionId, runId);
    const item = this.itemOf(run, slug);
    const attempt = item.attempts.at(-1);
    const base = attempt ? `${run.runId}/_attempts/${item.slug}/${attempt.id}` : null;
    const busy = item.status === 'running' || item.status === 'stopping';
    const partial = busy && base ? truncate(this.deps.artifacts.readOptional(`${base}/output.txt`), READ_CAP) : null;
    const finalText =
      !busy && base ? truncate(this.deps.artifacts.readOptional(`${base}/final-output.txt`), READ_CAP) : null;
    const published = this.publishedFindings(run, item, READ_CAP);
    return {
      runId: run.runId,
      runStatus: run.status,
      slug: item.slug,
      status: item.status,
      generation: item.generation,
      attemptId: item.currentAttemptId,
      summary: item.summary,
      question: item.question,
      partial: partial?.text ?? null,
      finalText: finalText?.text ?? null,
      findings: busy ? null : published.text,
      findingsPath: published.path,
      truncated: Boolean(partial?.truncated || finalText?.truncated || published.truncated),
      continuation: this.continuationOf(item),
      messages: this.deps.artifacts.readMessages(run.runId, item.slug),
      error: item.error,
    };
  }
  private continuationOf(item: SwarmItem): SwarmReadResult['continuation'] {
    const execution = item.executions.at(-1);
    if (!execution?.continuationMode) return null;
    return { mode: execution.continuationMode, reason: execution.continuationReason };
  }
  private dropSession(run: SwarmRun, item: SwarmItem, lostReason: string | null): void {
    item.session = null;
    item.sessionLostReason = lostReason;
    const close = this.deps.closeSession;
    if (!close) return;
    const closure: Promise<void> = Promise.resolve()
      .then(() => close(run, item))
      .catch((error) => this.deps.reportError(error, 'fechamento de sessão Swarm'))
      .finally(() => this.sessionClosures.delete(closure));
    this.sessionClosures.add(closure);
  }
  private captureSession(item: SwarmItem, attempt: SwarmAttempt, result: AgentExecutionResult): void {
    if (!swarmSessionRuntime(item.runtime)) return;
    const id = result.metadata?.sessionIds?.[0];
    if (!id) return;
    if (item.session?.id === id && item.session.generation === item.generation) return;
    item.session = { runtime: item.runtime, id, attemptId: attempt.id, generation: item.generation };
    item.sessionLostReason = null;
  }
  private pinSession(run: SwarmRun, item: SwarmItem, pinned: boolean): void {
    const pin = this.deps.pinSession;
    if (!pin) return;
    void Promise.resolve()
      .then(() => pin(run, item, pinned))
      .catch((error) => this.deps.reportError(error, 'retenção de sessão Swarm'));
  }
  private retryByReplay(run: SwarmRun, item: SwarmItem): void {
    const plan = item.launch;
    if (!plan || plan.kind !== 'continuation' || plan.mode !== 'session') return;
    const reason = 'Retentativa automática da continuação; a sessão não é retomada, reenvio de histórico.';
    if (!plan.fallbackPromptFile) {
      item.status = 'failed';
      item.nextAttemptAt = null;
      item.launch = null;
      item.error = {
        code: 'context-overflow',
        message: `${reason} Reenvio impossível: o histórico obrigatório excede o contexto.`,
        retryable: false,
      };
      this.discardInbox(run, item, 'estouro de contexto');
      return;
    }
    item.launch = { ...plan, mode: 'replay', promptFile: plan.fallbackPromptFile, fallbackPromptFile: null, reason };
    this.dropSession(run, item, reason);
  }
  private prepareRepair(
    run: SwarmRun,
    item: SwarmItem,
    attempt: SwarmAttempt,
    execution: SwarmExecution,
    reason: SwarmRepairReason,
    detail: string,
  ): boolean {
    const base = `${run.runId}/_attempts/${item.slug}/${attempt.id}`;
    const findings = this.deps.artifacts.readOptional(`${base}/findings.md`);
    const finalText = this.deps.artifacts.readOptional(`${base}/final-output.txt`);
    if (!findings?.trim() && !finalText?.trim()) return false;
    const built = buildRepairPrompt({
      briefing: item.prompt,
      finalText,
      findings,
      reason,
      detail,
      slug: item.slug,
      budgetChars: this.deps.contextBudget?.(item) ?? this.contextBudget(run, item),
    });
    const launchReason = `Reparo de formato após ${reason}: ${detail}`;
    const replayFile = `_attempts/${item.slug}/repair-${attempt.id}.txt`;
    if (this.sessionFor(item)) {
      const promptFile = `_attempts/${item.slug}/repair-${attempt.id}-session.txt`;
      this.deps.artifacts.atomic(`${run.runId}/${promptFile}`, buildSessionRepairPrompt(reason, detail, item.slug));
      if (!built.overflow) this.deps.artifacts.atomic(`${run.runId}/${replayFile}`, built.prompt);
      item.launch = {
        kind: 'repair',
        messageId: execution.messageId,
        promptFile,
        mode: 'session',
        fallbackPromptFile: built.overflow ? null : replayFile,
        reason: launchReason,
      };
      return true;
    }
    if (built.overflow) return false;
    this.deps.artifacts.atomic(`${run.runId}/${replayFile}`, built.prompt);
    item.launch = {
      kind: 'repair',
      messageId: execution.messageId,
      promptFile: replayFile,
      mode: 'replay',
      fallbackPromptFile: null,
      reason: `${launchReason}; ${this.replayReason(item)}`,
    };
    return true;
  }
  private sessionFor(item: SwarmItem): SwarmSessionRef | null {
    const session = item.session;
    if (!session || !swarmSessionRuntime(item.runtime) || session.generation !== item.generation) return null;
    return session;
  }
  private replayReason(item: SwarmItem): string {
    if (item.sessionLostReason) return item.sessionLostReason;
    if (!swarmSessionRuntime(item.runtime))
      return `Runtime ${item.runtime} sem retomada de sessão; reenvio de histórico.`;
    if (item.session && item.session.generation !== item.generation)
      return 'Sessão descartada no redisparo; reenvio de histórico.';
    return 'Sem sessão registrada para esta geração; reenvio de histórico.';
  }
  async wait(input: SwarmWaitInput): Promise<SwarmWaitResult> {
    this.ensureOpen();
    const run = this.runOf(input.sessionId, input.runId);
    const slugs = input.slugs?.length ? input.slugs.map((slug) => this.itemOf(run, slug).slug) : null;
    const slice = Math.min(
      Math.max(Math.floor(input.sliceMs ?? SWARM_WAIT_MAX_SLICE_MS), 1_000),
      SWARM_WAIT_MAX_SLICE_MS,
    );
    let entry = this.waits.get(input.waitId);
    if (!entry || entry.runId !== run.runId) {
      entry = {
        waitId: input.waitId,
        runId: run.runId,
        turnId: input.turnId,
        slugs,
        leaseUntil: 0,
        settledAtStart: settledRun(run),
      };
      this.waits.set(input.waitId, entry);
    }
    entry.slugs = slugs;
    entry.leaseUntil = this.now() + SWARM_WAIT_LEASE_MS;
    this.safely(() => this.deps.renewDeliveryLease?.(input.waitId, entry!.leaseUntil), 'renovação de lease Swarm');
    this.ensureTicker();
    const immediate = this.resolveWait(run, entry);
    if (immediate.status !== 'pending') return immediate;
    if (input.signal?.aborted) return this.cancelWait(run, entry);
    let lastProgress = immediate.progress;
    return new Promise<SwarmWaitResult>((resolve) => {
      let settled = false;
      const current = entry!;
      const finish = (result: SwarmWaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        input.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onEvent = () => {
        try {
          const result = this.resolveWait(run, current);
          if (result.status !== 'pending') finish(result);
          else if (result.progress !== lastProgress) {
            lastProgress = result.progress;
            input.onProgress?.(result.progress);
          }
        } catch (error) {
          this.deps.reportError(error, 'espera Swarm');
        }
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.runId === run.runId) onEvent();
      });
      const timer = setTimeout(() => finish(this.resolveWait(run, current)), slice);
      const onAbort = () => finish(this.cancelWait(run, current));
      input.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  private cancelWait(run: SwarmRun, entry: WaitEntry): SwarmWaitResult {
    this.waits.delete(entry.waitId);
    this.safely(() => this.deps.releaseDeliveryReservation?.(entry.waitId), 'liberação de reserva Swarm');
    return {
      status: 'cancelled',
      runId: run.runId,
      runStatus: run.status,
      progress: swarmProgressLine(run),
      reason: SWARM_WAIT_CANCELLED_REASON,
    };
  }
  private waitFor(runId: string): WaitEntry | undefined {
    for (const entry of this.waits.values()) if (entry.runId === runId && entry.leaseUntil > this.now()) return entry;
    return undefined;
  }
  private resolveWait(run: SwarmRun, entry: WaitEntry): SwarmWaitResult {
    const progress = swarmProgressLine(run);
    const scope = entry.slugs ? run.items.filter((i) => entry.slugs!.includes(i.slug)) : run.items;
    const asking = scope.find((i) => i.status === 'waiting' && i.question && i.currentAttemptId);
    if (asking) {
      if (!asking.lastSignalAt) {
        asking.lastSignalAt = stamp(this.now());
        this.safely(() => this.checkpoint(run, false), 'registro da entrega da pergunta Swarm');
      }
      const execution = this.executionOf(asking, asking.currentAttemptId);
      if (execution?.questionRevision != null) {
        const state = this.safely(
          () => this.deps.deliveryState?.(run, 'question', execution.questionRevision!)?.state,
          'estado da pergunta Swarm',
        );
        if (state === 'pending' || state === 'reserved-by-wait')
          this.safely(
            () =>
              this.deps.reserveDelivery?.(run, 'question', execution.questionRevision!, entry.waitId, entry.leaseUntil),
            'reserva da pergunta Swarm',
          );
      }
      return {
        status: 'question',
        runId: run.runId,
        runStatus: run.status,
        slug: asking.slug,
        attemptId: asking.currentAttemptId!,
        question: asking.question!,
        progress,
      };
    }
    const settled = settledRun(run);
    if (!scope.every((i) => itemTerminal(i.status)) || (!settled && run.items.every((i) => itemTerminal(i.status))))
      return {
        status: 'pending',
        runId: run.runId,
        runStatus: run.status,
        progress,
        running: run.items.filter((i) => !itemTerminal(i.status)).map((i) => i.slug),
        finished: run.items.filter((i) => itemTerminal(i.status)).map((i) => i.slug),
      };
    let scheduled = false;
    let consumedBy: 'turn' | 'delivery' | null = null;
    let revision: number | null = null;
    if (settled) {
      revision = run.terminalRevision;
      const state = this.safely(
        () => this.deps.deliveryState?.(run, 'terminal', revision!)?.state,
        'estado da entrega Swarm',
      );
      const partialAfterSettled = Boolean(entry.slugs && entry.settledAtStart);
      if (state === 'claimed') scheduled = true;
      else if (state === 'pending' || state === 'reserved-by-wait') {
        if (partialAfterSettled) scheduled = true;
        else {
          const reserved = this.safely(
            () => this.deps.reserveDelivery?.(run, 'terminal', revision!, entry.waitId, entry.leaseUntil) ?? true,
            'reserva da entrega Swarm',
          );
          const consumed = reserved
            ? this.safely(
                () => this.deps.consumeDelivery?.(run, 'terminal', revision!, entry.waitId, entry.turnId) ?? true,
                'consumo da entrega Swarm',
              )
            : false;
          if (consumed) consumedBy = 'turn';
          else scheduled = true;
        }
      } else if (state && SETTLED_STATES.has(state)) consumedBy = 'delivery';
      else if (!(run.deliveryError?.kind === 'terminal' && run.deliveryError.revision === revision)) scheduled = true;
    }
    this.waits.delete(entry.waitId);
    return {
      status: 'done',
      runId: run.runId,
      runStatus: run.status,
      revision,
      deliveryScheduled: scheduled,
      consumedBy,
      results: scope.map((item) => this.waitResultOf(run, item)),
      progress,
    };
  }
  async questionDelivered(runId: string, slug: string, attemptId: string): Promise<boolean> {
    return this.serialized(() => {
      const run = this.runs.get(runId);
      const item = run?.items.find((i) => i.slug === slug);
      if (!run || !item || item.status !== 'waiting' || item.currentAttemptId !== attemptId || terminal(run.status))
        return false;
      item.lastSignalAt = stamp(this.now());
      this.checkpoint(run);
      return true;
    });
  }
  async failWaiting(runId: string, slug: string, attemptId: string, reason: string): Promise<boolean> {
    return this.serialized(() => {
      const run = this.runs.get(runId);
      const item = run?.items.find((i) => i.slug === slug);
      if (!run || !item || item.status !== 'waiting' || item.currentAttemptId !== attemptId || terminal(run.status))
        return false;
      this.pinSession(run, item, false);
      item.status = 'failed';
      item.question = null;
      item.launch = null;
      item.error = { code: 'conduction-unsupported', message: reason, retryable: false };
      this.discardInbox(run, item, 'orquestrador sem conducao');
      this.checkpoint(run);
      this.evaluate(run);
      return true;
    });
  }
  private waitResultOf(run: SwarmRun, item: SwarmItem): SwarmWaitAgentResult {
    const published = this.publishedFindings(run, item, WAIT_FINDINGS_CAP);
    return {
      slug: item.slug,
      status: item.status,
      summary: item.summary,
      findingsPath: published.path,
      findings: published.text,
      truncated: published.truncated,
      error: item.error,
    };
  }
  private publishedFindings(
    run: SwarmRun,
    item: SwarmItem,
    cap: number,
  ): { text: string | null; path: string | null; truncated: boolean } {
    if (!item.findingsFile) return { text: null, path: null, truncated: false };
    const content = truncate(this.deps.artifacts.readOptional(`${run.runId}/${item.findingsFile}`), cap);
    return {
      text: content.text,
      path: path.join(this.deps.artifacts.root, run.runId, item.findingsFile),
      truncated: content.truncated,
    };
  }
  private safely<T>(fn: () => T, context: string): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.deps.reportError(error, context);
      return undefined;
    }
  }
  private log(run: SwarmRun, item: SwarmItem, record: SwarmMessageRecord): void {
    this.safely(() => this.deps.artifacts.appendMessage(run.runId, item.slug, record), 'registro de mensagens Swarm');
  }
  private assertConductible(run: SwarmRun): void {
    if (terminal(run.status))
      throw new SwarmDomainError(
        'run_closed',
        `Run ${run.runId} encerrada; dispare uma nova (swarm_start com parentRunId).`,
      );
    if (run.status === 'aborting') throw new SwarmDomainError('run_closed', `Run ${run.runId} está abortando.`);
  }
  private discardInbox(run: SwarmRun, item: SwarmItem, reason: string): void {
    for (const queued of item.inbox)
      this.log(run, item, {
        id: queued.id,
        kind: 'discarded',
        attemptId: queued.attemptId,
        at: stamp(this.now()),
        text: `${reason}: ${queued.message}`,
      });
    item.inbox = [];
  }
  private cancelWaiting(run: SwarmRun, item: SwarmItem, message: string): void {
    this.pinSession(run, item, false);
    const execution = this.executionOf(item, item.currentAttemptId);
    if (execution?.questionRevision != null)
      this.safely(
        () => this.deps.cancelDelivery?.(run, 'question', execution.questionRevision!, message),
        'cancelamento da pergunta Swarm',
      );
    item.status = 'cancelled';
    item.question = null;
    item.error = { code: 'cancelled', message, retryable: false };
  }
  private reopen(run: SwarmRun): void {
    if (run.status !== 'open') return;
    run.status = 'running';
    run.openedAt = null;
  }
  private prepareContinuation(run: SwarmRun, item: SwarmItem): void {
    const next = item.inbox.shift();
    if (!next) return;
    const previous = item.attempts.map((attempt, i) => {
      const base = `${run.runId}/_attempts/${item.slug}/${attempt.id}`;
      const findings = attempt.validatedContentHash ? this.deps.artifacts.readOptional(`${base}/findings.md`) : null;
      const execution = item.executions[i];
      return {
        label: `${execution?.kind ?? 'initial'}, geração ${execution?.generation ?? 1}, resultado ${attempt.outcome ?? 'desconhecido'}`,
        finalText: this.deps.artifacts.readOptional(`${base}/final-output.txt`),
        findings,
        findingsPath: findings ? path.join(this.deps.artifacts.root, base, 'findings.md') : null,
      };
    });
    const records = this.deps.artifacts.readMessages(run.runId, item.slug);
    const exchanges: Array<{ message: string; response: string | null }> = [];
    const queued = new Set(item.inbox.map((entry) => entry.id));
    for (const record of records) {
      if (record.id === next.id || queued.has(record.id)) continue;
      if (record.kind === 'message' || record.kind === 'answer')
        exchanges.push({ message: record.text, response: null });
      else if (record.kind === 'response' && exchanges.length && exchanges[exchanges.length - 1].response === null)
        exchanges[exchanges.length - 1].response = record.text;
    }
    const built = buildContinuationPrompt({
      briefing: item.prompt,
      executions: previous.filter((p) => p.finalText || p.findings),
      exchanges,
      newMessage: next.message,
      budgetChars: this.deps.contextBudget?.(item) ?? this.contextBudget(run, item),
    });
    const session = this.sessionFor(item);
    if (session) {
      const promptFile = `_attempts/${item.slug}/continuation-${next.id}-session.txt`;
      this.deps.artifacts.atomic(`${run.runId}/${promptFile}`, buildSessionContinuationPrompt(next.message));
      let fallbackPromptFile: string | null = null;
      if (!built.overflow) {
        fallbackPromptFile = `_attempts/${item.slug}/continuation-${next.id}.txt`;
        this.deps.artifacts.atomic(`${run.runId}/${fallbackPromptFile}`, built.prompt);
      }
      item.launch = {
        kind: 'continuation',
        messageId: next.id,
        promptFile,
        mode: 'session',
        fallbackPromptFile,
        reason: null,
      };
      item.status = 'pending';
      item.nextAttemptAt = null;
      item.question = null;
      return;
    }
    if (built.overflow) {
      const now = stamp(this.now());
      const attempt: SwarmAttempt = {
        id: `attempt-${item.attempts.length + 1}-${hex(4)}`,
        n: item.attempts.length + 1,
        startedAt: now,
        endedAt: now,
        outcome: 'context-overflow',
        error: {
          code: 'context-overflow',
          message: `Continuação não executada: o histórico obrigatório tem ${built.size} caracteres e o orçamento do modelo ${item.model} é ${built.budget}. Redispare com briefing mais curto ou reparta o alvo.`,
          retryable: false,
        },
        terminationConfirmedAt: now,
        outputFile: '',
        findingsFile: '',
        validatedContentHash: null,
        metrics: { costUsd: null, costStatus: 'unknown' },
      };
      attempt.outputFile = `_attempts/${item.slug}/${attempt.id}/output.txt`;
      attempt.findingsFile = `_attempts/${item.slug}/${attempt.id}/findings.md`;
      item.attempts.push(attempt);
      item.executions.push({
        attemptId: attempt.id,
        kind: 'continuation',
        generation: item.generation,
        mechanism: 'resend',
        continuationMode: 'replay',
        continuationReason: this.replayReason(item),
        messageId: next.id,
        reason: `cortes: ${built.cuts.join('; ') || 'nenhum'}`,
        question: null,
        questionRevision: null,
      });
      item.currentAttemptId = attempt.id;
      item.status = 'failed';
      item.error = attempt.error;
      item.launch = null;
      this.discardInbox(run, item, 'estouro de contexto');
      this.log(run, item, {
        id: `${next.id}-overflow`,
        kind: 'response',
        attemptId: attempt.id,
        at: now,
        text: attempt.error!.message,
        mechanism: 'resend',
        costUsd: null,
        cuts: built.cuts,
      });
      return;
    }
    const promptFile = `_attempts/${item.slug}/continuation-${next.id}.txt`;
    this.deps.artifacts.atomic(`${run.runId}/${promptFile}`, built.prompt);
    item.launch = {
      kind: 'continuation',
      messageId: next.id,
      promptFile,
      mode: 'replay',
      fallbackPromptFile: null,
      reason: this.replayReason(item),
    };
    item.status = 'pending';
    item.nextAttemptAt = null;
    item.question = null;
    if (built.cuts.length)
      this.log(run, item, {
        id: `${next.id}-cuts`,
        kind: 'message',
        attemptId: null,
        at: stamp(this.now()),
        text: `Cortes por limite de contexto no reenvio: ${built.cuts.join('; ')}`,
        mechanism: 'resend',
        cuts: built.cuts,
      });
  }
  private contextBudget(run: SwarmRun, item: SwarmItem): number {
    const agent = this.safely(() => this.resolvedOf(run, item).agent, 'snapshot do swarm agent');
    const provider =
      item.runtime === 'local'
        ? agent?.localConfig?.provider
        : item.runtime === 'external'
          ? agent?.externalConfig?.provider
          : undefined;
    return swarmContextBudgetChars(item.runtime, item.model, provider);
  }
  private schedule(): void {
    if (!this.recovered || this.closing || this.fatal) return;
    const now = this.now();
    for (const [waitId, wait] of this.waits) if (wait.leaseUntil <= now) this.waits.delete(waitId);
    for (const run of this.runs.values()) {
      if (terminal(run.status)) continue;
      if (run.status === 'open' && run.openedAt && Date.parse(run.openedAt) + run.settings.openWindowMs <= now) {
        if (!this.expiring.has(run.runId)) {
          this.expiring.add(run.runId);
          void this.serialized(() => {
            this.expiring.delete(run.runId);
            if (
              run.status === 'open' &&
              run.openedAt &&
              Date.parse(run.openedAt) + run.settings.openWindowMs <= this.now()
            )
              this.close(run, null);
          }).catch((error) => this.deps.reportError(error, 'fechamento da janela Swarm'));
        }
        continue;
      }
      for (const item of run.items) {
        const key = `${run.runId}/${item.slug}`;
        if (
          item.status === 'waiting' &&
          item.lastSignalAt &&
          Date.parse(item.lastSignalAt) + run.settings.idleTimeoutMs <= now &&
          !this.expiring.has(key)
        ) {
          this.expiring.add(key);
          void this.serialized(() => {
            this.expiring.delete(key);
            if (item.status !== 'waiting' || terminal(run.status)) return;
            const execution = this.executionOf(item, item.currentAttemptId);
            if (execution?.questionRevision != null)
              this.safely(
                () =>
                  this.deps.cancelDelivery?.(
                    run,
                    'question',
                    execution.questionRevision!,
                    'Swarm agent expirou sem resposta do orquestrador.',
                  ),
                'cancelamento da pergunta Swarm',
              );
            this.pinSession(run, item, false);
            item.status = 'failed';
            item.question = null;
            item.error = { code: 'timeout-idle', message: 'Sem resposta do orquestrador.', retryable: false };
            item.launch = null;
            this.discardInbox(run, item, 'sem resposta do orquestrador');
            this.checkpoint(run);
            this.evaluate(run);
          }).catch((error) => this.deps.reportError(error, 'timeout de pergunta Swarm'));
        }
      }
    }
    if (!this.dispatching) {
      this.dispatching = true;
      void this.serialized(() => {
        this.dispatching = false;
        this.dispatch();
      }).catch((error) => this.deps.reportError(error, 'despacho Swarm'));
    }
    const dormant = ![...this.runs.values()].some((r) => !terminal(r.status)) && !this.waits.size;
    if (dormant && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
  private dispatch(): void {
    if (!this.recovered || this.closing || this.fatal) return;
    const now = this.now();
    const globalCap = this.getSettings().concurrencyCap;
    const candidates = [...this.runs.values()].filter(working).filter((r) => r.status !== 'aborting');
    let idleVisits = 0;
    while (this.active.size < globalCap && candidates.length && idleVisits < candidates.length) {
      const run = candidates[this.cursor++ % candidates.length];
      const used = run.items.filter((i) => i.status === 'running' || i.status === 'stopping').length;
      const item =
        used < run.settings.concurrencyCap
          ? run.items.find(
              (i) => i.status === 'pending' || (i.status === 'retrying' && Date.parse(i.nextAttemptAt ?? '') <= now),
            )
          : undefined;
      if (!item) {
        idleVisits++;
        continue;
      }
      idleVisits = 0;
      try {
        this.launch(run, item);
      } catch (error) {
        if (this.fatal) throw error;
        const code = (error as { code?: string })?.code ?? 'launch-failed';
        item.status = 'failed';
        item.launch = null;
        item.nextAttemptAt = null;
        item.error = { code, message: error instanceof Error ? error.message : String(error), retryable: false };
        this.discardInbox(run, item, 'falha ao iniciar a execução');
        this.deps.reportError(error, 'início de tentativa Swarm');
        this.checkpoint(run);
        this.evaluate(run);
      }
    }
  }
  private launch(run: SwarmRun, item: SwarmItem): void {
    const key = `${run.runId}/${item.slug}`;
    const resolved = this.resolvedOf(run, item);
    const plan = item.launch;
    const resumable = plan?.kind === 'continuation' || plan?.kind === 'repair';
    const rejected = plan?.kind === 'repair' ? item.attempts.at(-1) : undefined;
    const kind: SwarmExecutionKind =
      plan?.kind === 'repair'
        ? 'repair'
        : item.status === 'retrying'
          ? 'retry'
          : (plan?.kind ?? (item.attempts.length === 0 ? 'initial' : 'retry'));
    let prompt = item.prompt;
    if (plan?.promptFile) {
      const stored = this.deps.artifacts.readOptional(`${run.runId}/${plan.promptFile}`);
      if (stored === null) throw new SwarmDomainError('continuation-missing', 'Prompt de continuação indisponível.');
      prompt = stored;
    }
    let continuation: SwarmSessionContinuation | undefined;
    if (resumable && plan.mode === 'session') {
      const session = this.sessionFor(item);
      if (!session) throw new SwarmDomainError('continuation-missing', 'Sessão da continuação indisponível.');
      const fallback = plan.fallbackPromptFile
        ? this.deps.artifacts.readOptional(`${run.runId}/${plan.fallbackPromptFile}`)
        : null;
      continuation = {
        session,
        fallbackPrompt: fallback === null ? null : `${fallback}\n\n${FINAL_INSTRUCTION(item.slug)}`,
      };
    }
    const mode: SwarmContinuationMode | null = resumable ? (plan.mode ?? 'replay') : null;
    const attempt: SwarmAttempt = {
      id: `attempt-${item.attempts.length + 1}-${hex(4)}`,
      n: item.attempts.length + 1,
      startedAt: stamp(this.now()),
      endedAt: null,
      outcome: null,
      error: null,
      terminationConfirmedAt: null,
      outputFile: '',
      findingsFile: '',
      validatedContentHash: null,
      metrics: { costUsd: null, costStatus: 'unknown' },
    };
    const execution: SwarmExecution = {
      attemptId: attempt.id,
      kind,
      generation: item.generation,
      mechanism: mode === 'session' ? 'session' : mode === 'replay' ? 'resend' : null,
      continuationMode: mode,
      continuationReason: mode ? (plan?.reason ?? null) : null,
      messageId: plan?.messageId ?? null,
      reason: null,
      question: null,
      questionRevision: null,
    };
    const dir = `_attempts/${item.slug}/${attempt.id}`;
    attempt.outputFile = `${dir}/output.txt`;
    attempt.findingsFile = `${dir}/findings.md`;
    item.attempts.push(attempt);
    item.executions.push(execution);
    item.currentAttemptId = attempt.id;
    item.status = 'running';
    item.nextAttemptAt = null;
    item.question = null;
    item.lastSignalAt = stamp(this.now());
    run.status = 'running';
    run.startedAt ??= stamp(this.now());
    const findingsPath = this.deps.artifacts.attemptPath(run.runId, item.slug, attempt.id);
    const priorFindings = rejected ? this.deps.artifacts.readOptional(`${run.runId}/${rejected.findingsFile}`) : null;
    if (priorFindings !== null) this.deps.artifacts.writeAttempt(run.runId, item.slug, attempt.id, priorFindings);
    this.checkpoint(run);
    const task: ActiveAttempt = {
      controller: new AbortController(),
      reason: null,
      completion: Promise.resolve(),
      stopped: false,
      redispatch: false,
    };
    this.active.set(key, task);
    const valid = () =>
      this.active.get(key) === task &&
      item.currentAttemptId === attempt.id &&
      item.status === 'running' &&
      !task.controller.signal.aborted &&
      !this.fatal;
    const activity = () => {
      if (valid()) item.lastSignalAt = stamp(this.now());
    };
    const live: SwarmLiveMetrics = { attemptId: attempt.id, turns: 0, inputTokens: null, outputTokens: null };
    this.live.set(key, live);
    const stopping = (reason: 'timeout-idle' | 'timeout-hard') => {
      if (this.active.get(key) !== task || itemTerminal(item.status)) return;
      task.reason ??= reason;
      item.status = 'stopping';
      this.checkpoint(run);
    };
    task.completion = (async () => {
      let result: SwarmAttemptResult | null = null;
      let failure: unknown = null;
      try {
        result = await this.deps.execute({
          resolved,
          cwd: run.cwd,
          prompt: `${prompt}\n\n${FINAL_INSTRUCTION(item.slug)}`,
          findingsPath,
          runId: run.runId,
          slug: item.slug,
          attemptId: attempt.id,
          generation: item.generation,
          ...(continuation ? { continuation } : {}),
          settings: run.settings,
          abortController: task.controller,
          onActivity: activity,
          onToolUse: () => {
            if (this.active.get(key) === task) live.turns += 1;
          },
          onUsage: (usage) => {
            if (this.active.get(key) !== task) return;
            live.inputTokens = usage.inputTokens;
            live.outputTokens = usage.outputTokens;
          },
          onStopping: stopping,
          onText: (text) => {
            if (this.active.get(key) === task) {
              this.deps.artifacts.appendOutput(run.runId, item.slug, attempt.id, text);
              activity();
            }
          },
          writeFindings: async (content) => {
            if (!valid()) throw new SwarmDomainError('attempt-revoked', 'Tentativa não aceita mais escrita.');
            this.deps.artifacts.writeAttempt(run.runId, item.slug, attempt.id, content);
          },
          uploadFindings: async (op) => {
            if (!valid()) throw new SwarmDomainError('attempt-revoked', 'Tentativa não aceita mais escrita.');
            return this.deps.artifacts.upload(run.runId, item.slug, attempt.id, op);
          },
        });
      } catch (error) {
        failure = error;
      }
      await this.serialized(() => this.settle(run, item, attempt, execution, task, key, dir, result, failure));
    })().catch((error) => {
      this.deps.reportError(error, 'finalização de tentativa Swarm');
    });
  }
  private settle(
    run: SwarmRun,
    item: SwarmItem,
    attempt: SwarmAttempt,
    execution: SwarmExecution,
    task: ActiveAttempt,
    key: string,
    dir: string,
    result: SwarmAttemptResult | null,
    failure: unknown,
  ): void {
    let asked = false;
    const live = this.live.get(key);
    if (live?.attemptId === attempt.id) this.live.delete(key);
    try {
      if (result) {
        attempt.metrics = this.metrics(result, live);
        if (typeof result.repoGraphMounted === 'boolean') attempt.repoGraph = result.repoGraphMounted;
        this.deps.artifacts.atomic(`${run.runId}/${dir}/final-output.txt`, result.output);
        if (result.continuation) {
          execution.continuationMode = result.continuation.mode;
          execution.continuationReason = result.continuation.reason ?? execution.continuationReason;
          execution.mechanism = result.continuation.mode === 'session' ? 'session' : 'resend';
        }
        if (!task.reason && !task.controller.signal.aborted) this.captureSession(item, attempt, result);
      }
      if ((failure as { code?: string } | null)?.code === 'session-lost') {
        item.session = null;
        item.sessionLostReason = failure instanceof Error ? failure.message : String(failure);
      }
      if (task.reason || task.controller.signal.aborted)
        throw new SwarmDomainError(task.reason ?? 'cancelled', 'Execução interrompida.');
      if (failure) throw failure;
      if (!result) throw new SwarmDomainError('crash', 'Execução sem resultado.');
      if (result.error) throw Object.assign(new Error(result.error.userMessage), { code: result.error.code });
      const trailer = parseSwarmTrailer(result.output, item.slug);
      item.summary = trailer.summary;
      if (trailer.status === 'failed') throw new SwarmDomainError('task-failed', trailer.summary);
      if (trailer.status === 'needs-input') {
        attempt.outcome = 'needs-input';
        execution.question = trailer.question;
        item.question = trailer.question;
        item.status = 'waiting';
        item.error = null;
        item.launch = null;
        asked = true;
      } else {
        const findings = this.deps.artifacts.validateFindings(run.runId, item.slug, attempt.id);
        attempt.validatedContentHash = findings.sha256;
        this.checkpoint(run);
        this.deps.artifacts.publish(run.runId, item.slug, attempt.id, findings.sha256);
        item.findingsFile = `${item.slug}.md`;
        item.status = 'ok';
        item.error = null;
        attempt.outcome = 'ok';
      }
    } catch (error) {
      const classified = this.classify(error, task.reason);
      attempt.outcome = classified.outcome;
      attempt.error = classified.error;
      item.error = classified.error;
      if (execution.kind === 'repair') item.launch = null;
      if (run.status === 'aborting' || task.reason === 'cancelled') item.status = 'cancelled';
      else if (
        classified.error.retryable &&
        1 + item.autoRetries < run.settings.maxAttempts &&
        !this.closing &&
        !this.fatal
      ) {
        item.autoRetries++;
        item.status = 'retrying';
        const repairable =
          execution.kind !== 'repair' &&
          (classified.outcome === 'bad-trailer' || classified.outcome === 'invalid-findings');
        const repaired =
          repairable &&
          this.safely(
            () =>
              this.prepareRepair(
                run,
                item,
                attempt,
                execution,
                classified.outcome as SwarmRepairReason,
                classified.error.message,
              ),
            'reparo de formato Swarm',
          );
        if (repaired) item.nextAttemptAt = stamp(this.now());
        else {
          const delay = 30_000 * 2 ** (item.autoRetries - 1) + (this.random() * 20_000 - 10_000);
          item.nextAttemptAt = stamp(this.now() + delay);
        }
      } else item.status = 'failed';
    } finally {
      attempt.endedAt = stamp(this.now());
      attempt.terminationConfirmedAt = stamp(this.now());
      this.active.delete(key);
      if (execution.messageId && execution.kind !== 'redispatch' && result)
        this.log(run, item, {
          id: `${execution.messageId}-${attempt.id}-response`,
          kind: 'response',
          attemptId: attempt.id,
          at: attempt.endedAt,
          text: result.output.slice(0, RESPONSE_LOG_CAP),
          mechanism: execution.mechanism ?? 'resend',
          costUsd: attempt.metrics.costUsd,
        });
      if (task.redispatch) {
        item.status = 'pending';
        item.nextAttemptAt = null;
        item.error = null;
      } else if (item.status === 'retrying') {
        if (item.launch && item.launch.kind === 'redispatch') item.launch = null;
        else if (item.launch && item.launch.mode === 'session') this.retryByReplay(run, item);
      } else {
        item.launch = null;
        if (itemTerminal(item.status) && !task.stopped && item.inbox.length)
          this.safely(() => this.prepareContinuation(run, item), 'continuação Swarm');
        else if (task.stopped) this.discardInbox(run, item, 'swarm agent parado');
      }
      if (!this.fatal) {
        if (asked) {
          this.pinSession(run, item, true);
          execution.questionRevision = run.revision + 1;
          item.lastSignalAt = null;
          this.checkpoint(run, false);
          this.deliverQuestion(run, item, attempt.id, execution);
          this.emit(run);
        } else this.checkpoint(run);
        this.evaluate(run);
      }
      this.schedule();
    }
  }
  private metrics(result: AgentExecutionResult, live?: SwarmLiveMetrics): SwarmMetrics {
    const m = result.metrics;
    const turns = m.apiRequests > 0 ? m.apiRequests : Math.max(live?.turns ?? 0, m.toolUses) + 1;
    return {
      costUsd: m.costStatus === 'unknown' ? null : m.costUsd,
      costStatus: m.costStatus ?? 'known',
      tokenStatus: m.tokenStatus,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      turns,
      durationMs: m.durationMs,
      costStatusReasons: m.costStatusReasons,
    };
  }
  private classify(error: unknown, reason: SwarmOutcome | null): { outcome: SwarmOutcome; error: SwarmError } {
    const value = error as { code?: string; message?: string };
    const code = reason ?? (value?.code === 'session-lost' ? 'context-overflow' : value?.code) ?? 'provider-error';
    const message = value?.message ?? String(error);
    if (code === 'LLM-QUOTA')
      return { outcome: 'provider-error', error: { code, message: quotaMessage(message), retryable: false } };
    const auth = /auth|credential|login|unauthorized|permission.denied|invalid.api.key/i.test(code);
    const outcome: SwarmOutcome = auth
      ? 'auth-required'
      : [
            'timeout-idle',
            'timeout-hard',
            'bad-trailer',
            'invalid-findings',
            'task-failed',
            'cancelled',
            'unsupported-capability',
            'crash',
            'context-overflow',
          ].includes(code)
        ? (code as SwarmOutcome)
        : 'provider-error';
    const retryable =
      ['timeout-idle', 'timeout-hard', 'bad-trailer', 'invalid-findings', 'crash'].includes(outcome) ||
      (outcome === 'provider-error' && !/config|invalid|unsupported|context|400|404/i.test(code));
    return { outcome, error: { code, message, retryable } };
  }
  private envelopeOf(run: SwarmRun): string {
    const envelope = `${swarmEnvelope(run, run.deliveredSignatures)}\nDiretório absoluto dos artifacts: ${path.join(this.deps.artifacts.root, run.runId)}\n`;
    run.deliveredSignatures = swarmItemSignatures(run);
    return envelope;
  }
  private evaluate(run: SwarmRun): void {
    if (terminal(run.status) || run.status === 'open') return;
    if (!run.items.every((i) => itemTerminal(i.status))) return;
    if (run.status === 'aborting' || run.items.every((i) => i.attempts.length === 0)) {
      this.close(run, run.status === 'aborting' ? 'aborted' : null);
      return;
    }
    run.status = 'open';
    run.openedAt = stamp(this.now());
    run.terminalRevision = run.revision + 1;
    const envelope = this.envelopeOf(run);
    this.checkpoint(run, false);
    this.deliverTerminal(run, envelope);
    this.emit(run);
  }
  private close(run: SwarmRun, status: 'aborted' | null): void {
    const wasOpen = run.status === 'open';
    for (const item of run.items) this.dropSession(run, item, null);
    run.status = status ?? outcomeOf(run);
    run.openedAt = null;
    run.finishedAt = stamp(this.now());
    if (wasOpen) this.checkpoint(run);
    else {
      run.terminalRevision = run.revision + 1;
      const envelope = this.envelopeOf(run);
      this.checkpoint(run, false);
      this.deliverTerminal(run, envelope);
      this.emit(run);
    }
    for (const item of run.items) this.resolved.delete(`${run.runId}/${item.slug}`);
    this.prune();
  }
  private reservation(run: SwarmRun): Pick<SwarmDeliveryDescriptor, 'reservedBy' | 'leaseUntil'> {
    const wait = this.waitFor(run.runId);
    return wait ? { reservedBy: wait.waitId, leaseUntil: wait.leaseUntil } : {};
  }
  private deliverTerminal(run: SwarmRun, envelope: string): void {
    if (run.terminalRevision === null) return;
    this.safely(() => this.deps.artifacts.atomic(`${run.runId}/_envelope.md`, envelope), 'envelope Swarm');
    this.safely(
      () => this.deps.artifacts.atomic(`${run.runId}/_envelope-r${run.terminalRevision}.md`, envelope),
      'envelope Swarm',
    );
    this.enqueueDelivery({
      run,
      envelope,
      descriptor: { kind: 'terminal', revision: run.terminalRevision, ...this.reservation(run) },
    });
  }
  private deliverQuestion(run: SwarmRun, item: SwarmItem, attemptId: string, execution: SwarmExecution): void {
    if (execution.questionRevision === null || !execution.question) return;
    this.enqueueDelivery({
      run,
      envelope: swarmQuestionEnvelope(run, item, attemptId, execution.question),
      descriptor: {
        kind: 'question',
        revision: execution.questionRevision,
        slug: item.slug,
        attemptId,
        ...this.reservation(run),
      },
    });
  }
  private enqueueDelivery(request: DeliveryRequest): void {
    const { run, descriptor } = request;
    try {
      this.deps.deliver(run, request.envelope, descriptor);
      if (run.deliveryError?.kind === descriptor.kind && run.deliveryError.revision === descriptor.revision) {
        run.deliveryError = null;
        this.safely(() => this.checkpoint(run), 'registro da entrega Swarm');
      }
    } catch (error) {
      run.deliveryError = {
        kind: descriptor.kind,
        revision: descriptor.revision,
        message: error instanceof Error ? error.message : String(error),
        at: stamp(this.now()),
      } satisfies SwarmDeliveryError;
      this.safely(() => this.checkpoint(run), 'registro da falha de entrega Swarm');
      this.deps.reportError(
        error,
        `entrega Swarm nao enfileirada (${run.runId} ${descriptor.kind} r${descriptor.revision}); run marcada com delivery-error, sem nova tentativa ate o proximo reinicio`,
      );
    }
  }
  private reconcileTerminalDelivery(run: SwarmRun): void {
    if (run.terminalRevision === null) return;
    const state = this.safely(
      () => this.deps.deliveryState?.(run, 'terminal', run.terminalRevision!)?.state,
      'estado da entrega Swarm',
    );
    if (state) return;
    this.deliverTerminal(run, this.storedEnvelope(run));
  }
  private storedEnvelope(run: SwarmRun): string {
    return (
      this.deps.artifacts.readOptional(`${run.runId}/_envelope-r${run.terminalRevision}.md`) ??
      this.deps.artifacts.readOptional(`${run.runId}/_envelope.md`) ??
      `${swarmEnvelope(run)}\nDiretório absoluto dos artifacts: ${path.join(this.deps.artifacts.root, run.runId)}\n`
    );
  }
  recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.recoverAll();
    return this.recoveryPromise;
  }
  private async recoverAll(): Promise<void> {
    for (const id of this.deps.artifacts.list()) {
      const run = this.deps.artifacts.load(id);
      this.runs.set(id, run);
      this.requestIndex.set(this.requestKey(run.chatSessionId, run.requestId), run.runId);
      if (!terminal(run.status)) {
        const requeue: Array<{ item: SwarmItem; execution: SwarmExecution }> = [];
        for (const item of run.items) {
          const sessionAttemptId = item.session?.attemptId ?? null;
          if (item.session) {
            item.session = null;
            item.sessionLostReason = SESSION_LOST_ON_BOOT;
          }
          if (itemTerminal(item.status)) continue;
          if (item.status === 'waiting') {
            item.lastSignalAt = null;
            const execution = this.executionOf(item, item.currentAttemptId);
            if (execution) {
              const state =
                execution.questionRevision === null
                  ? undefined
                  : this.deps.deliveryState?.(run, 'question', execution.questionRevision)?.state;
              if (!state || SETTLED_STATES.has(state)) requeue.push({ item, execution });
            }
            continue;
          }
          const attempt = item.attempts.at(-1);
          if (attempt && !attempt.terminationConfirmedAt) {
            const origin =
              sessionAttemptId && sessionAttemptId !== attempt.id
                ? item.attempts.find((a) => a.id === sessionAttemptId)
                : undefined;
            const confirmed =
              ((await this.deps.recoverAttempt?.(run, item, attempt)) ?? false) &&
              (!origin || ((await this.deps.recoverAttempt?.(run, item, origin)) ?? false));
            if (!confirmed)
              throw new SwarmDomainError(
                'cleanup-required',
                `Encerramento não confirmado: ${id}/${item.slug}/${attempt.id}.`,
              );
            attempt.endedAt = stamp(this.now());
            attempt.terminationConfirmedAt = stamp(this.now());
            attempt.outcome = 'interrupted';
          }
          this.discardInbox(run, item, 'reinício do aplicativo');
          item.launch = null;
          item.nextAttemptAt = null;
          if (attempt?.validatedContentHash && run.status !== 'aborting') {
            this.deps.artifacts.publish(id, item.slug, attempt.id, attempt.validatedContentHash);
            item.status = 'ok';
            item.findingsFile = `${item.slug}.md`;
            attempt.outcome = 'ok';
          } else {
            item.status = run.status === 'aborting' ? 'cancelled' : 'failed';
            item.error = {
              code: 'interrupted',
              message: 'Interrompido por reinício do aplicativo.',
              retryable: false,
            };
            if (attempt && attempt.outcome === 'interrupted') attempt.error = item.error;
          }
        }
        if (run.status === 'open') run.openedAt = stamp(this.now());
        if (requeue.length) {
          for (const { item, execution } of requeue) {
            execution.questionRevision = run.revision + 1;
            this.checkpoint(run, false);
            this.deliverQuestion(run, item, item.currentAttemptId!, execution);
          }
          this.emit(run);
        } else this.checkpoint(run);
        const wasOpen = run.status === 'open';
        this.evaluate(run);
        if (wasOpen) this.reconcileTerminalDelivery(run);
      } else this.reconcileTerminalDelivery(run);
      this.deps.project(summarizeSwarm(run));
    }
    this.prune();
    this.recovered = true;
    if ([...this.runs.values()].some((r) => !terminal(r.status))) this.ensureTicker();
  }
  async shutdown(): Promise<void> {
    this.cancelEpoch++;
    this.closing = true;
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    await this.stopAllRuns();
  }
  async abortAll(_reason?: string): Promise<void> {
    this.cancelEpoch++;
    await this.stopAllRuns();
  }
  private async stopAllRuns(): Promise<void> {
    for (const run of this.runs.values())
      if (working(run)) {
        try {
          await this.abort(run.chatSessionId, run.runId);
        } catch (error) {
          this.deps.reportError(error, 'Erro de persistência durante encerramento Swarm');
        }
      } else if (run.status === 'open') for (const item of run.items) this.dropSession(run, item, null);
    for (const task of this.active.values()) {
      task.reason ??= 'cancelled';
      task.controller.abort();
    }
    await Promise.allSettled([...this.active.values()].map((task) => task.completion));
    await Promise.allSettled([...this.sessionClosures]);
  }
}
