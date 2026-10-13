import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { getSetting } from './db';
import { getSecretNonInteractive } from './secrets-vault';
import { askJev, JevError, JEV_PRICE_USD_PER_MTOK } from './jev-client';
import type { JevBatchResult, JevChoiceAnswer, JevFailure } from './jev-client';
import {
  JEV_API_KEY_VAULT_KEY,
  JEV_MODEL_SETTING_KEY,
  JEV_SHADOW_ENABLED_SETTING_KEY,
  resolveJevModel,
} from './jev-settings';
import {
  buildShadowDraft,
  buildShadowQuestions,
  buildShadowState,
  compareWithGate,
  composeShadowPlan,
  JEV_SHADOW_COMPOSITION_VERSION,
  JEV_SHADOW_DEFAULT_THRESHOLDS,
  JEV_SHADOW_QUESTIONS_VERSION,
} from './jev-shadow-compose';
import type {
  GateCandidateView,
  GateComparisonCounts,
  ShadowDraft,
  ShadowIgnoredRemoval,
  ShadowLine,
  ShadowNewFact,
  ShadowNote,
  ShadowPlan,
  ShadowThresholds,
} from './jev-shadow-compose';
import type { DreamingGateResult, UserAccountingTraceEntry } from './dreaming-gate';

const logger = createLogger('jev-shadow');

export const JEV_SHADOW_SCHEMA_VERSION = 1;
export const JEV_SHADOW_JSONL_FILE = 'jev-shadow.jsonl';

export interface JevShadowLimits {
  batchSize: number;
  parallel: number;
  requestTimeoutMs: number;
  deadlineMs: number;
  conversationChars: number;
  retryConversationChars: number;
  maxLines: number;
}

export const JEV_SHADOW_LIMITS: JevShadowLimits = {
  batchSize: 12,
  parallel: 6,
  requestTimeoutMs: 15_000,
  deadlineMs: 30_000,
  conversationChars: 60_000,
  retryConversationChars: 30_000,
  maxLines: 150,
};

export interface JevShadowSnapshot {
  sessionId: string | null;
  today: string;
  memoryMd: string;
  userMd: string;
  candidates: Array<{ kind: 'add' | 'remove'; text: string }>;
  userCandidates: Array<{ action: 'add' | 'remove'; section: string; fact: string }>;
  conversationText: string;
  gateModelLabel: string | null;
}

export interface JevShadowGateInfo {
  result: DreamingGateResult;
  userAccounting: UserAccountingTraceEntry[] | null;
  gateReportFile: string | null;
}

export type JevShadowStatus = 'success' | 'failed' | 'skipped';
export type JevShadowSkipReason = 'empty' | 'too_many_lines';
export type JevShadowFailureReason = JevFailure | 'config' | 'unknown';

export interface JevShadowFailure {
  reason: JevShadowFailureReason;
  message: string;
}

export interface JevShadowRecord {
  schemaVersion: number;
  questionsVersion: number;
  compositionVersion: number;
  status: JevShadowStatus;
  runId: string;
  gateReportFile: string | null;
  timestamp: string;
  sessionId: string | null;
  today: string;
  thresholds: ShadowThresholds;
  jevModelRequested: string;
  jevModelReturned: string | null;
  gateModelLabel: string | null;
  gateFailSafe: boolean;
  conversationCharsSent: number | null;
  contextRetry: boolean;
  inputTokens: number | null;
  requests: number;
  wallMs: number;
  lines: ShadowLine[];
  newFacts: ShadowNewFact[];
  ignoredRemovals: ShadowIgnoredRemoval[];
  answers: Record<string, JevChoiceAnswer>;
  plan: ShadowPlan | null;
  notes: ShadowNote[];
  gate: GateCandidateView[];
  counts: GateComparisonCounts | null;
  failure?: JevShadowFailure;
  skipReason?: JevShadowSkipReason;
}

type SecretRead = Awaited<ReturnType<typeof getSecretNonInteractive>>;

export interface JevShadowDeps {
  now: () => number;
  yieldFirst: boolean;
  readFlag: () => boolean;
  readApiKey: () => Promise<SecretRead>;
  readModel: () => string;
  ask: typeof askJev;
  reportsDir: () => string;
  limits: JevShadowLimits;
  thresholds: ShadowThresholds;
}

const defaultDeps: JevShadowDeps = {
  now: () => Date.now(),
  yieldFirst: true,
  readFlag: () => getSetting(JEV_SHADOW_ENABLED_SETTING_KEY) === 'true',
  readApiKey: () => getSecretNonInteractive(JEV_API_KEY_VAULT_KEY),
  readModel: () => resolveJevModel(getSetting(JEV_MODEL_SETTING_KEY)),
  ask: askJev,
  reportsDir: () => path.join(getLionClawHome(), 'workspaces', 'lionclaw', 'dreaming-reports'),
  limits: JEV_SHADOW_LIMITS,
  thresholds: JEV_SHADOW_DEFAULT_THRESHOLDS,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function fileStamp(date: Date): string {
  const d = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
  const t = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
  return `${d}_${t}`;
}

function estimateCostUsd(inputTokens: number | null): string {
  if (inputTokens === null) return 'indisponivel';
  return `US$ ${((inputTokens / 1_000_000) * JEV_PRICE_USD_PER_MTOK).toFixed(4)}`;
}

function destLabel(view: GateCandidateView | undefined): string {
  if (!view || view.match === 'sem_rastro' || view.dest === null) return 'sem rastro';
  if (view.match === 'failsafe') return 'quarentena (fail-safe)';
  if (view.dest === 'apply') return view.op === 'remove' ? 'gravou (removeu linha)' : 'gravou';
  return view.dest === 'descarta' ? 'descartou' : 'quarentena';
}

export function renderShadowReport(record: JevShadowRecord): string {
  const plan = record.plan;
  const lineById = new Map(record.lines.map((l) => [l.id, l]));
  const viewFor = (f: ShadowNewFact) => record.gate.find((v) => v.file === f.file && v.sourceIndex === f.sourceIndex);
  const parts: string[] = [
    `# Jev em modo sombra - Clear`,
    ``,
    `- **runId:** \`${record.runId}\``,
    `- **Relatorio do gate:** ${record.gateReportFile ? `\`${record.gateReportFile}\`` : '_nao salvo_'}`,
    `- **Modelo Jev:** ${record.jevModelRequested}${record.jevModelReturned && record.jevModelReturned !== record.jevModelRequested ? ` (devolvido: ${record.jevModelReturned})` : ''}`,
    `- **Modelo do gate:** ${record.gateModelLabel ?? '_desconhecido_'}`,
    `- **Tempo:** ${record.wallMs} ms em ${record.requests} request(s)`,
    `- **Custo estimado:** ${estimateCostUsd(record.inputTokens)}`,
    `- **Perguntas:** ${Object.keys(record.answers).length}`,
    `- **Conversa enviada:** ${record.conversationCharsSent ?? 0} caracteres${record.contextRetry ? ' (segunda tentativa, contexto reduzido)' : ''}`,
    `- **Gate em fail-safe:** ${record.gateFailSafe ? 'sim' : 'nao'}`,
    ``,
    `## Fatos novos`,
    ``,
  ];
  if (record.newFacts.length === 0 || plan === null) {
    parts.push('_nenhum_');
  } else {
    parts.push(`| Fato | Gate | Jev | Confianca |`, `|---|---|---|---|`);
    for (const f of record.newFacts) {
      const decision = plan.newFacts[f.id];
      const jev = decision
        ? `${decision.dest}${decision.replaces ? ` (troca ${decision.replaces})` : ''}${decision.section ? ` [${decision.section}]` : ''}${decision.why ? ` - ${decision.why}` : ''}`
        : '-';
      const conf = decision ? `${decision.jev.choice} ${decision.jev.confidence.toFixed(2)}` : '-';
      parts.push(`| ${f.id} (${f.file}) ${cell(f.text)} | ${destLabel(viewFor(f))} | ${cell(jev)} | ${conf} |`);
    }
  }
  parts.push(``, `## Linhas existentes que o Jev tiraria`, ``);
  const leaving = plan ? Object.entries(plan.lines).filter(([, d]) => d.dest === 'sai') : [];
  if (leaving.length === 0) parts.push('_nenhuma_');
  for (const [id, d] of leaving) {
    const line = lineById.get(id);
    const ref = d.replacedBy ? `substituida por ${d.replacedBy}` : d.survivor ? `sobrevivente ${d.survivor}` : '';
    parts.push(
      `- ${id} (${line?.file ?? '?'} · ${line?.section ?? '?'}): ${line?.text ?? ''} _(${d.why ?? ''}${ref ? `; ${ref}` : ''})_`,
    );
  }
  parts.push(``, `## Acoes canceladas`, ``);
  if (record.notes.length === 0) parts.push('_nenhuma_');
  for (const n of record.notes) parts.push(`- ${n.id}: ${n.note}`);
  parts.push(``, `## Propostas de remocao ignoradas (o LLM so insere)`, ``);
  if (record.ignoredRemovals.length === 0) parts.push('_nenhuma_');
  for (const r of record.ignoredRemovals) parts.push(`- (${r.file}) ${r.text}`);
  parts.push(``, `## Contagens (sem rastro excluido)`, ``);
  if (record.counts) {
    parts.push(
      `- Comparados: ${record.counts.compared}`,
      `- Concordancias: ${record.counts.agree}`,
      `- Divergencias: ${record.counts.disagree}`,
      `- Gate gravou e Jev descartaria: ${record.counts.gateAppliedJevDiscards}`,
      `- Jev mandaria para quarentena: ${record.counts.jevQuarantine}`,
      `- Sem rastro: ${record.counts.semRastro}`,
    );
  } else {
    parts.push('_indisponivel_');
  }
  return parts.join('\n') + '\n';
}

export function recomposeShadowPlan(
  record: Pick<JevShadowRecord, 'lines' | 'newFacts' | 'answers' | 'today' | 'thresholds'>,
): ShadowPlan {
  return composeShadowPlan(
    { lines: record.lines, newFacts: record.newFacts },
    record.answers,
    record.today,
    record.thresholds,
  );
}

let jsonlQueue: Promise<void> = Promise.resolve();

function appendJsonl(dir: string, record: JevShadowRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const next = jsonlQueue.then(async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(path.join(dir, JEV_SHADOW_JSONL_FILE), line, 'utf-8');
  });
  jsonlQueue = next.catch(() => undefined);
  return next;
}

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

async function writeReport(dir: string, record: JevShadowRecord, stamp: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp}_${record.runId}_jev-shadow-report.md`);
  await fs.promises.writeFile(file, renderShadowReport(record), 'utf-8');
  return file;
}

export async function runJevShadow(
  snapshot: JevShadowSnapshot,
  gate: JevShadowGateInfo,
  deps: JevShadowDeps,
): Promise<void> {
  if (deps.yieldFirst) await new Promise<void>((resolve) => setImmediate(resolve));

  const startedAt = deps.now();
  const runId = randomUUID();
  const stamp = fileStamp(new Date(startedAt));
  const base = (): JevShadowRecord => ({
    schemaVersion: JEV_SHADOW_SCHEMA_VERSION,
    questionsVersion: JEV_SHADOW_QUESTIONS_VERSION,
    compositionVersion: JEV_SHADOW_COMPOSITION_VERSION,
    status: 'failed',
    runId,
    gateReportFile: gate.gateReportFile,
    timestamp: new Date(startedAt).toISOString(),
    sessionId: snapshot.sessionId,
    today: snapshot.today,
    thresholds: deps.thresholds,
    jevModelRequested: '',
    jevModelReturned: null,
    gateModelLabel: snapshot.gateModelLabel,
    gateFailSafe: gate.result.failSafeTriggered,
    conversationCharsSent: null,
    contextRetry: false,
    inputTokens: null,
    requests: 0,
    wallMs: 0,
    lines: [],
    newFacts: [],
    ignoredRemovals: [],
    answers: {},
    plan: null,
    notes: [],
    gate: [],
    counts: null,
  });

  let record = base();
  const finish = async (final: JevShadowRecord): Promise<void> => {
    final.wallMs = deps.now() - startedAt;
    let dir: string;
    try {
      dir = deps.reportsDir();
    } catch (err) {
      logger.warn({ runId, err: errorMessage(err) }, 'jev-shadow: pasta de relatorios indisponivel');
      return;
    }
    if (final.status === 'success') {
      try {
        const file = await writeReport(dir, final, stamp);
        logger.info({ runId, file }, 'jev-shadow: relatorio salvo');
      } catch (err) {
        logger.warn({ runId, err: errorMessage(err) }, 'jev-shadow: falha ao gravar relatorio .md');
      }
    }
    try {
      await appendJsonl(dir, final);
    } catch (err) {
      logger.warn({ runId, err: errorMessage(err) }, 'jev-shadow: falha ao gravar registro');
    }
  };
  const fail = async (reason: JevShadowFailureReason, message: string): Promise<void> => {
    logger.warn({ runId, reason, message }, 'jev-shadow: execucao falhou');
    await finish({ ...record, status: 'failed', failure: { reason, message } });
  };

  try {
    if (!deps.readFlag()) return;
    const secret = await deps.readApiKey();
    if (secret.status === 'absent' || (secret.status === 'found' && secret.value.trim().length === 0)) return;
    if (secret.status === 'error') {
      await fail('config', `chave do Jev ilegivel no Vault: ${secret.reason}`);
      return;
    }
    const apiKey = secret.value;
    const model = deps.readModel();
    record = { ...record, jevModelRequested: model };

    const draft: ShadowDraft = buildShadowDraft(snapshot);
    record = { ...record, lines: draft.lines, newFacts: draft.newFacts, ignoredRemovals: draft.ignoredRemovals };
    if (draft.lines.length === 0 && draft.newFacts.length === 0) {
      await finish({ ...record, status: 'skipped', skipReason: 'empty' });
      return;
    }
    if (draft.lines.length > deps.limits.maxLines) {
      await finish({ ...record, status: 'skipped', skipReason: 'too_many_lines' });
      return;
    }

    const questions = buildShadowQuestions(draft);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deps.limits.deadlineMs);
    let result: JevBatchResult;
    let chars = deps.limits.conversationChars;
    let contextRetry = false;
    const attempt = (limit: number) =>
      deps.ask(buildShadowState(draft, snapshot.today, snapshot.conversationText.slice(-limit)), questions, {
        apiKey,
        model,
        batchSize: deps.limits.batchSize,
        parallel: deps.limits.parallel,
        requestTimeoutMs: deps.limits.requestTimeoutMs,
        signal: deadline.signal,
      });
    try {
      try {
        result = await attempt(chars);
      } catch (err) {
        if (!(err instanceof JevError) || err.reason !== 'context') throw err;
        contextRetry = true;
        chars = deps.limits.retryConversationChars;
        result = await attempt(chars);
      }
    } finally {
      clearTimeout(timer);
    }
    record = {
      ...record,
      conversationCharsSent: Math.min(chars, snapshot.conversationText.length),
      contextRetry,
      jevModelReturned: result.returnedModel,
      inputTokens: result.inputTokens,
      requests: result.requests,
      answers: result.answers,
    };

    const plan = composeShadowPlan(draft, result.answers, snapshot.today, deps.thresholds);
    const comparison = compareWithGate(snapshot, plan, draft, gate.result, gate.userAccounting);
    await finish({
      ...record,
      status: 'success',
      plan,
      notes: plan.notes,
      gate: comparison.candidates,
      counts: comparison.counts,
    });
  } catch (err) {
    const reason: JevShadowFailureReason = err instanceof JevError ? err.reason : 'unknown';
    await fail(reason, errorMessage(err));
  }
}

export async function runJevShadowSafe(snapshot: JevShadowSnapshot, gate: JevShadowGateInfo): Promise<void> {
  try {
    await runJevShadow(snapshot, gate, defaultDeps);
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, 'jev-shadow: erro inesperado fora do fluxo protegido');
  }
}

export const __jevShadowInternals = { defaultDeps };
