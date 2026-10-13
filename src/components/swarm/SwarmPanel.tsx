import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import {
  Network,
  Bot,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Ban,
  Clock3,
  ChevronRight,
  FileText,
  Square,
  MessageSquare,
  HelpCircle,
} from 'lucide-react';
import type { SwarmItem, SwarmItemStatus, SwarmMessageRecord, SwarmRun, SwarmRunStatus } from '@/types/swarm';
import {
  SWARM_ABORTABLE_RUN_STATUSES,
  SWARM_ANIMATED_ITEM_STATUSES,
  buildSwarmAgentTimeline,
  buildSwarmChains,
  swarmRunningBadge,
  formatSwarmCost,
  formatSwarmRemaining,
  hasAnimatedSwarmAgent,
  isSwarmItemTerminal,
  isSwarmDeliverySettled,
  isSwarmRunLive,
  swarmContinuationBadge,
  swarmExecutionLabel,
  swarmItemCost,
  swarmItemUsage,
  formatSwarmUsage,
  swarmOpenWindowRemainingMs,
  swarmRepoGraphLabel,
  swarmRunCost,
  swarmStageLabel,
} from './swarm-panel-model';

const PAGE_SIZE = 10;
const DELIVERY_POLL_MS = 5000;
const SLOW_POLL_EVERY = 3;
const STATUS_LABEL: Record<SwarmRunStatus | SwarmItemStatus, string> = {
  queued: 'Na fila',
  pending: 'Na fila',
  running: 'Executando',
  open: 'Aberta para conducao',
  waiting: 'Aguardando o orquestrador',
  aborting: 'Abortando',
  stopping: 'Parando',
  retrying: 'Tentando novamente',
  done: 'Concluido',
  ok: 'Concluido',
  partial: 'Parcial',
  failed: 'Falhou',
  aborted: 'Abortado',
  cancelled: 'Cancelado',
};
const ACTION_BUTTON =
  'inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-1 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-800';
const DANGER_BUTTON =
  'inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-1 text-[10px] text-zinc-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400';
const CONFIRM_BUTTON =
  'inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-1 text-[10px] text-red-300 transition-colors hover:bg-red-500/20';

function SwarmStatus({ status }: { status: SwarmRunStatus | SwarmItemStatus }) {
  const active = ['running', 'retrying', 'stopping', 'waiting', 'aborting'].includes(status);
  const success = status === 'done' || status === 'ok';
  const failed = status === 'failed' || status === 'partial';
  const open = status === 'open';
  const Icon = active
    ? Loader2
    : success
      ? CheckCircle2
      : failed
        ? AlertTriangle
        : open
          ? Clock3
          : status === 'pending' || status === 'queued'
            ? Clock3
            : Ban;
  return (
    <span
      className={`ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] font-medium ${
        active
          ? 'text-amber-400'
          : success
            ? 'text-emerald-400'
            : failed
              ? 'text-red-400'
              : open
                ? 'text-sky-400'
                : 'text-zinc-500'
      }`}
    >
      <span>{STATUS_LABEL[status]}</span>
      <Icon aria-hidden="true" className={`h-3 w-3 ${active ? 'animate-spin' : ''}`} />
    </span>
  );
}

function ConfirmInline({
  question,
  onConfirm,
  onCancel,
}: {
  question: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <span role="group" aria-label={question} className="inline-flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-zinc-300">{question}</span>
      <button type="button" className={CONFIRM_BUTTON} onClick={onConfirm}>
        Confirmar
      </button>
      <button type="button" className={ACTION_BUTTON} onClick={onCancel}>
        Cancelar
      </button>
    </span>
  );
}

function SwarmAgentCard({
  sessionId,
  run,
  item,
  now,
  onError,
}: {
  sessionId: string;
  run: SwarmRun;
  item: SwarmItem;
  now: number;
  onError: (message: string) => void;
}) {
  const [confirmStop, setConfirmStop] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [messages, setMessages] = useState<SwarmMessageRecord[] | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const terminal = isSwarmItemTerminal(item.status);
  const lastAttempt = item.attempts[item.attempts.length - 1];
  const end = terminal ? (lastAttempt?.endedAt ?? run.finishedAt) : null;
  const elapsed = item.attempts[0]
    ? Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(item.attempts[0].startedAt)) / 1000))
    : null;
  const animated = SWARM_ANIMATED_ITEM_STATUSES.includes(item.status);
  const stoppable = !terminal && !['aborted', 'aborting'].includes(run.status);
  const continuation = swarmContinuationBadge(item);
  const cost = swarmItemCost(item);
  const usage = formatSwarmUsage(swarmItemUsage(item));
  useEffect(() => {
    if (!showMessages) return;
    let live = true;
    setLoadingMessages(true);
    window.lionclaw.swarm
      .getMessages(sessionId, run.runId, item.slug)
      .then((result) => {
        if (!live) return;
        if ('error' in result) onError(result.error);
        else setMessages(result.messages);
      })
      .catch((e) => {
        if (live) onError(String(e));
      })
      .finally(() => {
        if (live) setLoadingMessages(false);
      });
    return () => {
      live = false;
    };
  }, [showMessages, sessionId, run.runId, run.revision, item.slug, onError]);
  useEffect(() => {
    if (terminal) setConfirmStop(false);
  }, [terminal]);
  const timeline = showMessages && messages ? buildSwarmAgentTimeline(item, messages) : [];
  return (
    <details
      data-testid="swarm-agent"
      data-slug={item.slug}
      data-status={item.status}
      className="group rounded border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5"
    >
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5">
          <Bot
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 ${animated ? 'animate-pulse text-amber-400' : 'text-zinc-500'}`}
          />
          <span className="min-w-0 truncate text-[11px] text-zinc-300" title={item.slug}>
            {item.slug}
          </span>
          <SwarmStatus status={item.status} />
          <ChevronRight
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-zinc-600 transition-transform group-open:rotate-90"
          />
        </span>
        <span className="mt-1 block pl-5 font-mono text-[10px] text-zinc-500">
          {swarmExecutionLabel(item)}
          {elapsed !== null && ` · ${elapsed}s`} · {formatSwarmCost(cost)}
        </span>
        <span data-testid="swarm-agent-usage" className="mt-0.5 block pl-5 font-mono text-[10px] text-zinc-500">
          {usage}
        </span>
        {item.status === 'waiting' && item.question && (
          <span className="mt-1 flex items-start gap-1 pl-5 text-[10px] text-amber-300">
            <HelpCircle aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
            <span className="break-words">Pergunta: {item.question}</span>
          </span>
        )}
      </summary>
      <div className="mt-1.5 space-y-1 break-words border-t border-zinc-800/70 pt-1.5 text-[10px] text-zinc-500">
        <p>
          {item.runtime} / {item.model}
        </p>
        <p data-testid="swarm-agent-repo-graph">{swarmRepoGraphLabel(item)}</p>
        {continuation && (
          <p className="text-sky-300" title={continuation.reason ?? undefined}>
            {continuation.label}
            {continuation.reason ? ` · ${continuation.reason}` : ''}
          </p>
        )}
        {item.sessionLostReason && !continuation && <p className="text-zinc-400">{item.sessionLostReason}</p>}
        {item.summary && <p className="text-zinc-400">{item.summary}</p>}
        {item.error && <p className="text-red-400">{item.error.message}</p>}
        {item.attempts.map((attempt, index) => {
          const execution = item.executions?.[index];
          return (
            <p key={attempt.id}>
              #{attempt.n} {attempt.outcome ?? 'executando'}
              {execution ? ` · ${swarmExecutionLabel({ ...item, currentAttemptId: attempt.id })}` : ''} ·{' '}
              {attempt.metrics.costUsd === null || attempt.metrics.costStatus === 'unknown'
                ? 'custo desconhecido'
                : `$${attempt.metrics.costUsd.toFixed(4)}${attempt.metrics.costStatus === 'estimated-partial' ? ' (parcial/estimado)' : ''}`}
            </p>
          );
        })}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {stoppable &&
            (confirmStop ? (
              <ConfirmInline
                question={`Parar ${item.slug}? So este swarm agent; a run segue.`}
                onConfirm={async () => {
                  setConfirmStop(false);
                  try {
                    const result = await window.lionclaw.swarm.stopAgent(sessionId, run.runId, item.slug);
                    if ('error' in result) onError(result.error);
                  } catch (e) {
                    onError(String(e));
                  }
                }}
                onCancel={() => setConfirmStop(false)}
              />
            ) : (
              <button
                type="button"
                className={DANGER_BUTTON}
                aria-label={`Parar ${item.slug}`}
                onClick={() => setConfirmStop(true)}
              >
                <Square aria-hidden="true" className="h-2.5 w-2.5" />
                Parar
              </button>
            ))}
          {item.findingsFile && (
            <button
              type="button"
              className={ACTION_BUTTON}
              aria-label={`Abrir relatorio de ${item.slug}`}
              onClick={async () => {
                try {
                  const result = await window.lionclaw.swarm.openFindings(sessionId, run.runId, item.slug);
                  if ('error' in result) onError(result.error);
                } catch (e) {
                  onError(String(e));
                }
              }}
            >
              <FileText aria-hidden="true" className="h-3 w-3" />
              Abrir relatorio
            </button>
          )}
          <button
            type="button"
            className={ACTION_BUTTON}
            aria-pressed={showMessages}
            aria-label={`Mensagens de ${item.slug}`}
            onClick={() => setShowMessages((v) => !v)}
          >
            <MessageSquare aria-hidden="true" className="h-3 w-3" />
            Mensagens
          </button>
        </div>
        {showMessages && (
          <div
            data-testid="swarm-messages"
            className="space-y-1 rounded border border-zinc-800/70 bg-zinc-950/40 p-1.5"
          >
            {loadingMessages && messages === null && <p>Carregando mensagens...</p>}
            {messages !== null && timeline.length === 0 && <p>Nenhuma mensagem trocada com este swarm agent.</p>}
            {timeline.map((entry) => (
              <div key={entry.id} data-kind={entry.kind} className="border-l border-zinc-800 pl-1.5">
                <p
                  className={
                    entry.kind === 'question'
                      ? 'text-amber-300'
                      : entry.kind === 'answer' || entry.kind === 'message' || entry.kind === 'redispatch'
                        ? 'text-sky-300'
                        : entry.kind === 'discarded'
                          ? 'text-zinc-600'
                          : 'text-zinc-400'
                  }
                >
                  {entry.label}
                  {entry.mechanism ? ` (${entry.mechanism === 'session' ? 'sessao' : 'reenvio'})` : ''}
                  {typeof entry.costUsd === 'number' ? ` · $${entry.costUsd.toFixed(4)}` : ''}
                </p>
                <p className="whitespace-pre-wrap text-zinc-300">{entry.text}</p>
                {entry.cuts && entry.cuts.length > 0 && (
                  <p className="text-zinc-600">Cortes: {entry.cuts.join('; ')}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function SwarmRunCard({
  sessionId,
  run,
  stageLabel,
  now,
  onError,
}: {
  sessionId: string;
  run: SwarmRun;
  stageLabel: string | null;
  now: number;
  onError: (message: string) => void;
}) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const live = isSwarmRunLive(run);
  const abortable = SWARM_ABORTABLE_RUN_STATUSES.includes(run.status);
  const items = run.items ?? [];
  const completed = items.filter((item) => isSwarmItemTerminal(item.status)).length;
  const remaining = swarmOpenWindowRemainingMs(run, now);
  const cost = swarmRunCost(run);
  useEffect(() => {
    if (!abortable) setConfirmAbort(false);
  }, [abortable]);
  return (
    <div
      data-testid="swarm-run"
      data-run-id={run.runId}
      data-status={run.status}
      className={`rounded border px-2 py-1.5 ${live ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-700/60 bg-zinc-900/60'}`}
    >
      <div className="flex items-center gap-1.5">
        <Network aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${live ? 'text-amber-400' : 'text-zinc-500'}`} />
        <span className="min-w-0 truncate text-[11px] font-medium text-zinc-200" title={run.objective}>
          {stageLabel ?? run.objective}
        </span>
        <SwarmStatus status={run.status} />
      </div>
      {stageLabel && (
        <p className="mt-0.5 line-clamp-2 pl-5 text-[10px] text-zinc-400" title={run.objective}>
          {run.objective}
        </p>
      )}
      <p className="mt-1 pl-5 font-mono text-[10px] text-zinc-500">
        {run.runId.slice(-13)} · {completed} de {items.length} swarm agents ·{' '}
        <span data-testid="swarm-run-cost">custo total {formatSwarmCost(cost)}</span>
      </p>
      {remaining !== null && (
        <p className="mt-0.5 pl-5 text-[10px] text-sky-300">
          Aberta para conducao: {formatSwarmRemaining(remaining)} restantes
        </p>
      )}
      {items.length > 0 && (
        <div
          role="progressbar"
          aria-label="Swarm agents finalizados"
          aria-valuenow={completed}
          aria-valuemin={0}
          aria-valuemax={items.length}
          className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-amber-400 transition-all"
            style={{ width: `${(completed / items.length) * 100}%` }}
          />
        </div>
      )}
      <div className="mt-1.5 space-y-1 border-l border-zinc-800 pl-2">
        {items.map((item) => (
          <SwarmAgentCard key={item.slug} sessionId={sessionId} run={run} item={item} now={now} onError={onError} />
        ))}
      </div>
      {run.delivery && run.delivery.status !== 'delivered' && (
        <p className="mt-1.5 break-words text-[10px] text-amber-400">
          Entrega: {run.delivery.status}
          {run.delivery.error ? ` · ${run.delivery.error}` : ''}
        </p>
      )}
      {abortable && (
        <div className="mt-2">
          {confirmAbort ? (
            <ConfirmInline
              question="Abortar a run inteira? Todos os swarm agents param."
              onConfirm={async () => {
                setConfirmAbort(false);
                try {
                  const result = await window.lionclaw.swarm.abort(sessionId, run.runId);
                  if ('error' in result) onError(result.error);
                } catch (e) {
                  onError(String(e));
                }
              }}
              onCancel={() => setConfirmAbort(false)}
            />
          ) : (
            <button
              type="button"
              className={DANGER_BUTTON}
              aria-label={`Abortar run ${run.runId}`}
              onClick={() => setConfirmAbort(true)}
            >
              <Square aria-hidden="true" className="h-2.5 w-2.5" />
              Abortar run
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SwarmPanel() {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const [runs, setRuns] = useState<Record<string, SwarmRun>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const revisions = useRef(new Map<string, number>());
  const refreshRef = useRef<(runId: string) => Promise<void>>(async () => {});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const onError = useCallback((message: string) => setError(message), []);
  useEffect(() => {
    let live = true;
    setRuns({});
    setNextCursor(null);
    setError('');
    revisions.current.clear();
    if (!sessionId) return;
    const refresh = async (runId: string) => {
      try {
        const result = await window.lionclaw.swarm.getRunState(sessionId, runId);
        if (!live) return;
        if ('error' in result) {
          setError(result.error);
          return;
        }
        if (result.revision < (revisions.current.get(runId) ?? -1)) return;
        revisions.current.set(runId, result.revision);
        setRuns((prev) => ({ ...prev, [runId]: result }));
      } catch (e) {
        if (live) setError(String(e));
      }
    };
    refreshRef.current = refresh;
    const dispose = window.lionclaw.swarm.onStream((event) => {
      if (event.chatSessionId === sessionId && event.revision > (revisions.current.get(event.runId) ?? -1))
        void refresh(event.runId);
    });
    window.lionclaw.swarm
      .listRuns(sessionId, undefined, PAGE_SIZE)
      .then((result) => {
        if (!live) return;
        if ('error' in result) {
          setError(result.error);
          return;
        }
        setNextCursor(result.nextCursor ?? null);
        for (const summary of result.runs) if (!revisions.current.has(summary.runId)) void refresh(summary.runId);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    let tick = 0;
    const deliveryTimer = setInterval(() => {
      tick += 1;
      for (const [runId, run] of Object.entries(runsRef.current)) {
        const hot = hasAnimatedSwarmAgent([run]);
        const warm = isSwarmRunLive(run) || !isSwarmDeliverySettled(run);
        if (hot || (warm && tick % SLOW_POLL_EVERY === 0)) void refresh(runId);
      }
    }, DELIVERY_POLL_MS);
    return () => {
      live = false;
      dispose();
      clearInterval(deliveryTimer);
    };
  }, [sessionId]);
  const loadMore = async () => {
    if (!sessionId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await window.lionclaw.swarm.listRuns(sessionId, nextCursor, PAGE_SIZE);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setNextCursor(result.nextCursor ?? null);
      await Promise.all(result.runs.map((summary) => refreshRef.current(summary.runId)));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  };
  const list = Object.values(runs);
  if (list.length === 0 && !error) return null;
  const chains = buildSwarmChains(list);
  const badge = swarmRunningBadge(list);
  const animated = hasAnimatedSwarmAgent(list);
  return (
    <section aria-label="Swarm" className="max-h-[45vh] overflow-y-auto px-2 py-2 text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
        <Network
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 ${animated ? 'text-amber-400' : 'text-zinc-500'}`}
        />
        <h3 className="text-xs font-medium text-zinc-200">Swarm</h3>
        {badge && (
          <span
            data-testid="swarm-running"
            className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-amber-400"
          >
            <span>{badge}</span>
            {animated && <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-1 break-words text-[10px] text-red-400">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {chains.map((chain) => {
          const chained = chain.runs.length > 1 || Boolean(chain.runs[0].stage);
          return (
            <div key={chain.id} data-testid="swarm-chain" className="space-y-1">
              {chain.runs.map((run, index) =>
                sessionId ? (
                  <SwarmRunCard
                    key={run.runId}
                    sessionId={sessionId}
                    run={run}
                    stageLabel={chained ? swarmStageLabel(run, index) : null}
                    now={now}
                    onError={onError}
                  />
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      {nextCursor && (
        <button
          type="button"
          className={`${ACTION_BUTTON} mt-2`}
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? 'Carregando...' : 'Carregar runs anteriores'}
        </button>
      )}
    </section>
  );
}
