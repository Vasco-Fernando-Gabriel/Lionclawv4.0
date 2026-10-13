import type { askJev } from '../../jev-client';
import {
  JEV_PRICE_USD_PER_MTOK,
  JevError,
  type JevChoiceQuestion,
} from '../../../../mcp-servers/_shared/jev-transport';
import type { FileFingerprint } from '../core';
import { ArchmapCancelledError } from '../errors';
import { FILE_LEVEL_TYPES } from '../node-types';
import { nodePath, normalizeRelativePath } from './node-path';
import type { PrepareResult } from './prepare';
import type { GraphRecord } from './types';
import { unifiedDiff } from './unified-diff';

export const JEV_TRIAGE_DIFF_MAX_CHARS = 24_000;
export const JEV_TRIAGE_MAX_KEEPS = 3;
export const JEV_TRIAGE_PARALLEL = 6;
export const JEV_TRIAGE_REQUEST_TIMEOUT_MS = 20_000;
export const JEV_TRIAGE_DEADLINE_BASE_MS = 60_000;
export const JEV_TRIAGE_DEADLINE_PER_FILE_MS = 250;
export const JEV_TRIAGE_DEADLINE_MAX_MS = 600_000;
export const JEV_TRIAGE_QUESTION_ID = 'verdict';
export const JEV_TRIAGE_KEEPS_FIELD = 'jevKeeps';
export const JEV_TRIAGE_RETRY_ATTEMPTS = 4;
export const JEV_TRIAGE_RETRY_BASE_MS = 1_500;
export const JEV_TRIAGE_INTERNAL_TAGS: ReadonlySet<string> = new Set(['parser', 'semantic', 'exported']);

export type JevTriageChoice = 'keep' | 'rewrite' | 'unknown';

export function jevTriageQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      'Decide whether the architecture map entry for this file (old_summary, old_tags, old_complexity) must be re-interpreted by an LLM because of state.diff.',
    criteria: {
      keep: 'the change is cosmetic, a refactor with same responsibility, a small fix, renamed internals, formatting, comments, or minor additions that do not alter what the file is for',
      rewrite:
        'the change adds, removes or alters a responsibility, public API, integration, data flow or complexity in a way the summary or tags should reflect',
      unknown: 'the diff is too truncated or ambiguous to decide',
    },
  };
}

export interface JevTriageState {
  path: string;
  old_summary: string;
  old_tags: string[];
  old_complexity: string;
  diff: string;
}

export type JevTriageCandidateKind = 'cosmetic' | 'no_grammar';

export interface JevTriageCandidate {
  path: string;
  kind: JevTriageCandidateKind;
  oldSummary: string;
  oldTags: string[];
  oldComplexity: string;
  oldHash: string;
  keeps: number;
}

export type JevTriageDecision = 'keep' | 'reanalyze' | 'default';

export type JevTriageReason =
  | 'jev_keep'
  | 'jev_rewrite'
  | 'jev_unknown'
  | 'low_confidence'
  | 'keep_cap'
  | 'diff_too_large'
  | 'no_old_content'
  | 'fallback';

export interface JevTriageVerdict {
  path: string;
  kind: JevTriageCandidateKind;
  decision: JevTriageDecision;
  reason: JevTriageReason;
  choice?: JevTriageChoice;
  confidence?: number;
  diffChars?: number;
}

export interface JevTriageResult {
  candidates: number;
  asked: number;
  dispensed: string[];
  reanalyze: string[];
  verdicts: JevTriageVerdict[];
  inputTokens: number | null;
  costUsd: number;
  requests: number;
  wallMs: number;
  fallbackReason: string | null;
  model: string | null;
}

export interface JevTriageCandidateInput {
  plan: Pick<PrepareResult, 'action' | 'cosmeticPaths' | 'nonStructuralPaths' | 'manifestFiles' | 'hubFiles'>;
  previousNodes: readonly GraphRecord[];
  previousFingerprints: Record<string, FileFingerprint>;
  currentFingerprints: Record<string, FileFingerprint>;
  hubPaths?: Iterable<string>;
}

export function jevTriageTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string' && !JEV_TRIAGE_INTERNAL_TAGS.has(tag));
}

export function jevKeepsOf(node: GraphRecord | undefined): number {
  const metadata = node?.metadata;
  if (typeof metadata !== 'object' || metadata === null) return 0;
  const value = (metadata as Record<string, unknown>)[JEV_TRIAGE_KEEPS_FIELD];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function jevTriageApplies(action: PrepareResult['action']): boolean {
  return action === 'PARTIAL_UPDATE' || action === 'ARCHITECTURE_UPDATE';
}

function fileNodesByPath(nodes: readonly GraphRecord[]): Map<string, GraphRecord> {
  const out = new Map<string, GraphRecord>();
  for (const node of nodes) {
    if (typeof node.type !== 'string' || !FILE_LEVEL_TYPES.has(node.type)) continue;
    const path = nodePath(node);
    if (path !== null && !out.has(path)) out.set(path, node);
  }
  return out;
}

export function jevTriageCandidates(input: JevTriageCandidateInput): JevTriageCandidate[] {
  if (!jevTriageApplies(input.plan.action)) return [];
  const excluded = new Set<string>();
  for (const path of input.plan.manifestFiles) excluded.add(normalizeRelativePath(path));
  for (const path of input.plan.hubFiles) excluded.add(normalizeRelativePath(path));
  for (const path of input.hubPaths ?? []) excluded.add(normalizeRelativePath(path));
  const fileNodes = fileNodesByPath(input.previousNodes);
  const out: JevTriageCandidate[] = [];
  const seen = new Set<string>();
  const consider = (rawPath: string, kind: JevTriageCandidateKind): void => {
    const path = normalizeRelativePath(rawPath);
    if (seen.has(path) || excluded.has(path)) return;
    seen.add(path);
    const prior = input.previousFingerprints[path];
    const current = input.currentFingerprints[path];
    if (!prior || !current || typeof prior.contentHash !== 'string' || prior.contentHash.length === 0) return;
    if (prior.contentHash === current.contentHash) return;
    if (kind === 'cosmetic' && (!prior.hasStructuralAnalysis || !current.hasStructuralAnalysis)) return;
    if (kind === 'no_grammar' && (prior.hasStructuralAnalysis || current.hasStructuralAnalysis)) return;
    const node = fileNodes.get(path);
    if (!node || typeof node.summary !== 'string' || node.summary.trim().length === 0) return;
    const rawTags = Array.isArray(node.tags) ? node.tags : [];
    if (rawTags.includes('pending')) return;
    out.push({
      path,
      kind,
      oldSummary: node.summary,
      oldTags: jevTriageTags(rawTags),
      oldComplexity: typeof node.complexity === 'string' ? node.complexity : 'moderate',
      oldHash: prior.contentHash,
      keeps: jevKeepsOf(node),
    });
  };
  for (const path of input.plan.cosmeticPaths) consider(path, 'cosmetic');
  for (const path of input.plan.nonStructuralPaths) consider(path, 'no_grammar');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface JevTriageDeps {
  ask: typeof askJev;
  apiKey: string;
  model: string;
  threshold: number;
  signal: AbortSignal;
  readOldContent: (path: string, hash: string) => Promise<string | null>;
  readNewContent: (path: string) => Promise<string | null>;
  parallel?: number;
  requestTimeoutMs?: number;
  deadlineMs?: number;
  retryDelayMs?: (attempt: number) => number;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
}

export function jevTriageRetryDelayMs(attempt: number): number {
  return JEV_TRIAGE_RETRY_BASE_MS * attempt;
}

export function isRetryableJevError(error: unknown): boolean {
  if (!(error instanceof JevError) || error.reason !== 'http') return false;
  return /HTTP (429|5\d\d)\b/.test(error.message) || error.message.includes('falha de rede');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function jevTriageDeadlineMs(candidates: number): number {
  return Math.min(
    JEV_TRIAGE_DEADLINE_MAX_MS,
    JEV_TRIAGE_DEADLINE_BASE_MS + candidates * JEV_TRIAGE_DEADLINE_PER_FILE_MS,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyResult(candidates: number): JevTriageResult {
  return {
    candidates,
    asked: 0,
    dispensed: [],
    reanalyze: [],
    verdicts: [],
    inputTokens: 0,
    costUsd: 0,
    requests: 0,
    wallMs: 0,
    fallbackReason: null,
    model: null,
  };
}

export function jevCostUsd(inputTokens: number | null): number {
  if (inputTokens === null || inputTokens <= 0) return 0;
  return Math.round((inputTokens / 1e6) * JEV_PRICE_USD_PER_MTOK * 1e6) / 1e6;
}

interface Prepared {
  candidate: JevTriageCandidate;
  state: JevTriageState;
}

export async function runJevTriage(
  candidates: readonly JevTriageCandidate[],
  deps: JevTriageDeps,
): Promise<JevTriageResult> {
  const startedAt = Date.now();
  const result = emptyResult(candidates.length);
  if (candidates.length === 0) return result;
  const checkCancel = (): void => {
    if (deps.signal.aborted) throw new ArchmapCancelledError();
  };
  const prepared: Prepared[] = [];
  for (const candidate of candidates) {
    checkCancel();
    if (candidate.keeps >= JEV_TRIAGE_MAX_KEEPS) {
      result.verdicts.push({ path: candidate.path, kind: candidate.kind, decision: 'reanalyze', reason: 'keep_cap' });
      continue;
    }
    const oldContent = await deps.readOldContent(candidate.path, candidate.oldHash);
    const newContent = oldContent === null ? null : await deps.readNewContent(candidate.path);
    if (oldContent === null || newContent === null) {
      result.verdicts.push({
        path: candidate.path,
        kind: candidate.kind,
        decision: 'default',
        reason: 'no_old_content',
      });
      continue;
    }
    const diff = unifiedDiff(oldContent, newContent, candidate.path);
    if (diff === null || diff.length > JEV_TRIAGE_DIFF_MAX_CHARS) {
      result.verdicts.push({
        path: candidate.path,
        kind: candidate.kind,
        decision: 'reanalyze',
        reason: 'diff_too_large',
        diffChars: diff?.length,
      });
      continue;
    }
    prepared.push({
      candidate,
      state: {
        path: candidate.path,
        old_summary: candidate.oldSummary,
        old_tags: candidate.oldTags,
        old_complexity: candidate.oldComplexity,
        diff,
      },
    });
  }

  if (prepared.length === 0) {
    result.wallMs = Date.now() - startedAt;
    finish(result);
    return result;
  }

  const deadline = new AbortController();
  const onCancel = (): void => deadline.abort();
  deps.signal.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => deadline.abort(), deps.deadlineMs ?? jevTriageDeadlineMs(prepared.length));
  const answered: JevTriageVerdict[] = [];
  let inputTokens: number | null = 0;
  let requests = 0;
  let model: string | null = null;
  let firstError: unknown = null;
  let next = 0;
  let done = 0;
  const question = { [JEV_TRIAGE_QUESTION_ID]: jevTriageQuestion() };
  const workers = Math.max(1, Math.min(deps.parallel ?? JEV_TRIAGE_PARALLEL, prepared.length));
  try {
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < prepared.length && !deadline.signal.aborted && firstError === null) {
          const entry = prepared[next]!;
          next += 1;
          try {
            let reply: Awaited<ReturnType<typeof deps.ask>> | null = null;
            for (let attempt = 1; reply === null; attempt += 1) {
              requests += 1;
              try {
                reply = await deps.ask(entry.state, question, {
                  apiKey: deps.apiKey,
                  model: deps.model,
                  batchSize: 1,
                  parallel: 1,
                  requestTimeoutMs: deps.requestTimeoutMs ?? JEV_TRIAGE_REQUEST_TIMEOUT_MS,
                  signal: deadline.signal,
                  ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
                });
              } catch (error) {
                if (attempt >= JEV_TRIAGE_RETRY_ATTEMPTS || deadline.signal.aborted || !isRetryableJevError(error)) {
                  throw error;
                }
                await sleep((deps.retryDelayMs ?? jevTriageRetryDelayMs)(attempt), deadline.signal);
                if (deadline.signal.aborted) throw error;
              }
            }
            inputTokens = inputTokens === null || reply.inputTokens === null ? null : inputTokens + reply.inputTokens;
            if (model === null) model = reply.returnedModel;
            const answer = reply.answers[JEV_TRIAGE_QUESTION_ID];
            if (!answer) throw new JevError('schema', `resposta sem a pergunta ${JEV_TRIAGE_QUESTION_ID}`);
            const choice = answer.choice as JevTriageChoice;
            const keep = choice === 'keep' && answer.confidence >= deps.threshold;
            answered.push({
              path: entry.candidate.path,
              kind: entry.candidate.kind,
              decision: keep ? 'keep' : 'reanalyze',
              reason: keep
                ? 'jev_keep'
                : choice === 'keep'
                  ? 'low_confidence'
                  : choice === 'rewrite'
                    ? 'jev_rewrite'
                    : 'jev_unknown',
              choice,
              confidence: answer.confidence,
              diffChars: entry.state.diff.length,
            });
            done += 1;
            deps.onProgress?.(done, prepared.length);
          } catch (error) {
            if (firstError === null) firstError = error;
            deadline.abort();
            return;
          }
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener('abort', onCancel);
  }
  checkCancel();
  result.inputTokens = inputTokens;
  result.costUsd = jevCostUsd(inputTokens);
  result.requests = requests;
  result.model = model;
  result.wallMs = Date.now() - startedAt;

  if (firstError !== null || deadline.signal.aborted) {
    const reason =
      firstError instanceof JevError
        ? `${firstError.reason}: ${firstError.message}`
        : firstError !== null
          ? `falha inesperada: ${errorMessage(firstError)}`
          : 'prazo total da triagem esgotado';
    const retried =
      firstError !== null && isRetryableJevError(firstError) ? ` apos ${JEV_TRIAGE_RETRY_ATTEMPTS} tentativas` : '';
    const discarded = answered.length > 0 ? `; ${answered.length} resposta(s) ja obtida(s) descartada(s)` : '';
    result.fallbackReason = `${reason}${retried}${discarded}`;
    for (const entry of prepared) {
      result.verdicts.push({
        path: entry.candidate.path,
        kind: entry.candidate.kind,
        decision: 'default',
        reason: 'fallback',
      });
    }
    finish(result);
    return result;
  }

  result.asked = answered.length;
  result.verdicts.push(...answered);
  finish(result);
  return result;
}

function finish(result: JevTriageResult): void {
  result.verdicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  result.dispensed = result.verdicts.filter((v) => v.decision === 'keep').map((v) => v.path);
  result.reanalyze = result.verdicts
    .filter((v) => v.decision === 'reanalyze' && v.kind === 'cosmetic')
    .map((v) => v.path);
}

export interface JevTriagePlanAdjustment {
  plan: PrepareResult;
  keptPaths: Set<string>;
  jevKeptPaths: Set<string>;
}

export function applyJevTriageToPlan(
  plan: PrepareResult,
  result: Pick<JevTriageResult, 'dispensed' | 'reanalyze'>,
): JevTriagePlanAdjustment {
  const dispensed = new Set(result.dispensed);
  const forced = new Set(result.reanalyze);
  const filesToReanalyzeList = [
    ...new Set([...plan.filesToReanalyzeList.filter((path) => !dispensed.has(path)), ...forced]),
  ].sort();
  const cosmeticPaths = plan.cosmeticPaths.filter((path) => !forced.has(path));
  const adjusted: PrepareResult = {
    ...plan,
    filesToReanalyzeList,
    filesToReanalyze: filesToReanalyzeList.length,
    cosmeticPaths,
    cosmeticFiles: cosmeticPaths.length,
  };
  return {
    plan: adjusted,
    keptPaths: new Set([...cosmeticPaths, ...dispensed]),
    jevKeptPaths: dispensed,
  };
}

export function describeJevTriage(result: JevTriageResult): string[] {
  const lines: string[] = [];
  if (result.fallbackReason) {
    lines.push(`triagem Jev indisponivel: ${result.fallbackReason}; atualizacao segue sem triagem`);
  }
  if (result.asked > 0) {
    lines.push(
      `triagem Jev: dispensou ${result.dispensed.length} de ${result.asked} arquivo(s) (US$ ${result.costUsd.toFixed(4)}, ${result.requests} request(s), ${Math.round(result.wallMs / 100) / 10} s)`,
    );
  }
  const count = (reason: JevTriageReason): number => result.verdicts.filter((v) => v.reason === reason).length;
  const parts = [
    count('jev_rewrite') > 0 ? `${count('jev_rewrite')} relido(s) por rewrite` : null,
    count('jev_unknown') > 0 ? `${count('jev_unknown')} relido(s) por unknown` : null,
    count('low_confidence') > 0 ? `${count('low_confidence')} relido(s) por confianca baixa` : null,
    count('keep_cap') > 0 ? `${count('keep_cap')} relido(s) pelo teto de 3 keeps seguidos` : null,
    count('diff_too_large') > 0 ? `${count('diff_too_large')} relido(s) por diff acima de 24k` : null,
    count('no_old_content') > 0
      ? `${count('no_old_content')} sem conteudo anterior gravado (sem pergunta; a triagem vale a partir da proxima atualizacao)`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) lines.push(`triagem Jev: ${parts.join('; ')}`);
  return lines;
}
