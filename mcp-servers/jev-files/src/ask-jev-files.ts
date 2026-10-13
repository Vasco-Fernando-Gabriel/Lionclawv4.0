import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { fingerprintFor } from '../../_shared/jev-files-config.js';
import { askJevTransport, JevError, JEV_PRICE_USD_PER_MTOK } from '../../_shared/jev-transport.js';
import {
  CALL_DEADLINE_MS,
  MAX_FILES_PER_CALL,
  MAX_PARALLEL,
  REQUEST_TIMEOUT_MS,
  payloadWithinBudget,
  readBounded,
  type BoundedReadFsLike,
} from './budget.js';
import {
  readApiKeyFromEnv,
  readJevFilesConfig,
  readRuntimeHint,
  resolveConfigPath,
  type ConfigFsLike,
  type EnvLike,
} from './config.js';
import { isBinaryContent, type ContainedFile } from './contain.js';
import { expandTargets, TooManyEntriesError, type ExpandFsLike } from './expand.js';
import { buildPickRequest, resolvePick, selectCandidates, singlePick, sortAnswers } from './pick.js';
import { parseInput, toFileAnswer, toPrimitive, type FileAnswer, type ParsedQuestion } from './questions.js';
import { appendUsageRecord, resolveUsageLogPath, type UsageLogFsLike, type UsageRecord } from './usage-log.js';

export type SkipReason =
  | 'outside_roots'
  | 'relative_path'
  | 'sensitive'
  | 'binary'
  | 'too_large'
  | 'context'
  | 'empty'
  | 'unreadable'
  | 'depth_limit'
  | 'deadline'
  | 'jev_error';

export type PickReason =
  'no_candidates' | 'single' | 'chosen' | 'none' | 'low_confidence' | 'deadline' | 'context' | 'error';

export type ToolError =
  | 'disabled'
  | 'stale_process'
  | 'no_key'
  | 'config_invalid'
  | 'invalid_question'
  | 'too_many_files'
  | 'too_many_entries'
  | 'jev_http'
  | 'jev_timeout'
  | 'jev_schema'
  | 'jev_context'
  | 'internal';

export interface AskJevFilesStats {
  callId: string;
  files: number;
  eligible: number;
  charsRead: number;
  inputTokens: number | null;
  costUsd: number | null;
  wallMs: number;
  partial: boolean;
  truncated: boolean;
  requests: number;
}

export interface AskJevFilesResponse {
  answers: FileAnswer[];
  picked: { path: string; confidence: number } | null;
  pickReason?: PickReason;
  skipped: Array<{ path: string; reason: SkipReason }>;
  stats: AskJevFilesStats;
  error?: ToolError;
  message?: string;
}

export interface AskJevFilesFsLike extends ConfigFsLike {
  promises: ExpandFsLike & BoundedReadFsLike & UsageLogFsLike;
}

export interface AskJevFilesDeps {
  fetchImpl?: typeof fetch;
  now: () => number;
  homeDir: string;
  env: EnvLike;
  fs: AskJevFilesFsLike;
  apiKey: string | null;
  randomUUID: () => string;
  stderr: (text: string) => void;
  requestTimeoutMs?: number;
  callDeadlineMs?: number;
  parallel?: number;
}

export function createDefaultDeps(): AskJevFilesDeps {
  const env: EnvLike = { ...process.env };
  return {
    now: () => Date.now(),
    homeDir: os.homedir(),
    env,
    fs,
    apiKey: readApiKeyFromEnv(env),
    randomUUID: () => crypto.randomUUID(),
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

interface CallContext {
  callId: string;
  startedAt: number;
  now: () => number;
  apiKey: string | null;
}

type FileOutcome =
  | { kind: 'answer'; answer: FileAnswer; chars: number; inputTokens: number | null; requests: number }
  | { kind: 'skip'; reason: SkipReason; message: string | null; requests: number; error?: ToolError };

function scrub(text: string, apiKey: string | null): string {
  if (apiKey === null || apiKey.length === 0) return text;
  return text.split(apiKey).join('[chave]');
}

function elapsed(ctx: CallContext): number {
  return Math.max(0, ctx.now() - ctx.startedAt);
}

function emptyStats(ctx: CallContext): AskJevFilesStats {
  return {
    callId: ctx.callId,
    files: 0,
    eligible: 0,
    charsRead: 0,
    inputTokens: null,
    costUsd: null,
    wallMs: elapsed(ctx),
    partial: false,
    truncated: false,
    requests: 0,
  };
}

function failure(ctx: CallContext, error: ToolError, message: string): AskJevFilesResponse {
  return {
    answers: [],
    picked: null,
    skipped: [],
    stats: emptyStats(ctx),
    error,
    message: scrub(message, ctx.apiKey),
  };
}

function costOf(inputTokens: number | null): number | null {
  return inputTokens === null ? null : (inputTokens * JEV_PRICE_USD_PER_MTOK) / 1_000_000;
}

function jevErrorCode(reason: JevError['reason']): ToolError {
  switch (reason) {
    case 'http':
      return 'jev_http';
    case 'timeout':
      return 'jev_timeout';
    case 'schema':
      return 'jev_schema';
    case 'context':
      return 'jev_context';
  }
}

function addTokens(total: number | null, part: number | null): number | null {
  return total === null || part === null ? null : total + part;
}

interface CallSettings {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch | undefined;
  requestTimeoutMs: number;
  deadline: AbortController;
}

async function processFile(
  file: ContainedFile,
  question: ParsedQuestion,
  threshold: number,
  deps: AskJevFilesDeps,
  settings: CallSettings,
): Promise<FileOutcome> {
  const read = await readBounded(file.realPath, deps.fs.promises);
  if (!read.ok) return { kind: 'skip', reason: read.reason, message: read.message, requests: 0 };
  if (isBinaryContent(read.bytes)) {
    return {
      kind: 'skip',
      reason: 'binary',
      message: 'conteudo binario (byte nulo ou excesso de bytes de controle)',
      requests: 0,
    };
  }
  const content = read.bytes.toString('utf8');
  const state = { path: file.requestedPath, content };
  const questions = { q: toPrimitive(question) };
  const budget = payloadWithinBudget({ model: settings.model, state, questions });
  if (!budget.ok) {
    return {
      kind: 'skip',
      reason: 'too_large',
      message: `payload estimado em ${budget.tokens} tokens, acima do orcamento por request`,
      requests: 0,
    };
  }
  try {
    const result = await askJevTransport(state, questions, {
      apiKey: settings.apiKey,
      model: settings.model,
      batchSize: 1,
      parallel: 1,
      requestTimeoutMs: settings.requestTimeoutMs,
      signal: settings.deadline.signal,
      fetchImpl: settings.fetchImpl,
    });
    return {
      kind: 'answer',
      answer: toFileAnswer(file.requestedPath, question, result.answers.q, threshold),
      chars: content.length,
      inputTokens: result.inputTokens,
      requests: result.requests,
    };
  } catch (err) {
    const attempted = err instanceof JevError ? err.requestsAttempted : 1;
    if (settings.deadline.signal.aborted) {
      return { kind: 'skip', reason: 'deadline', message: null, requests: attempted };
    }
    if (err instanceof JevError && err.reason === 'context') {
      return { kind: 'skip', reason: 'context', message: err.message, requests: attempted };
    }
    if (err instanceof JevError) {
      return {
        kind: 'skip',
        reason: 'jev_error',
        message: err.message,
        requests: attempted,
        error: jevErrorCode(err.reason),
      };
    }
    return {
      kind: 'skip',
      reason: 'jev_error',
      message: err instanceof Error ? err.message : String(err),
      requests: attempted,
      error: 'internal',
    };
  }
}

async function run(input: unknown, deps: AskJevFilesDeps, ctx: CallContext): Promise<AskJevFilesResponse> {
  const config = readJevFilesConfig(resolveConfigPath(deps.homeDir, deps.env), deps.fs);
  if (config.status === 'absent') return failure(ctx, 'disabled', 'ferramenta desligada: configuracao ausente');
  if (config.status === 'invalid') return failure(ctx, 'config_invalid', config.message);
  if (!config.config.enabled) return failure(ctx, 'disabled', 'ferramenta desligada nas configuracoes');
  if (deps.apiKey === null) return failure(ctx, 'no_key', 'chave do Jev ausente no ambiente do processo');
  const expected = config.config.credentialFingerprint;
  if (expected === null || expected !== fingerprintFor(config.config.credentialSalt, deps.apiKey)) {
    return failure(ctx, 'stale_process', 'a chave do Jev mudou; este processo precisa reiniciar');
  }

  const parsed = parseInput(input);
  if (!parsed.ok) return failure(ctx, 'invalid_question', parsed.message);
  const { targets, question, pick, threshold } = parsed.input;

  let expansion;
  try {
    expansion = await expandTargets(targets, config.config.roots, deps.fs.promises);
  } catch (err) {
    if (err instanceof TooManyEntriesError) return failure(ctx, 'too_many_entries', err.message);
    throw err;
  }
  if (expansion.files.length > MAX_FILES_PER_CALL) {
    return failure(
      ctx,
      'too_many_files',
      `${expansion.files.length} arquivos elegiveis, acima do teto de ${MAX_FILES_PER_CALL}; use um alvo mais estreito`,
    );
  }

  const skipped: Array<{ path: string; reason: SkipReason }> = [];
  const messages: string[] = [];
  for (const entry of expansion.skipped) {
    skipped.push({ path: entry.path, reason: entry.reason });
    messages.push(entry.message);
  }

  const callDeadlineMs = deps.callDeadlineMs ?? CALL_DEADLINE_MS;
  const expired = () => elapsed(ctx) >= callDeadlineMs;
  const deadline = new AbortController();
  const settings: CallSettings = {
    apiKey: deps.apiKey,
    model: config.config.model,
    fetchImpl: deps.fetchImpl,
    requestTimeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    deadline,
  };
  const remaining = callDeadlineMs - elapsed(ctx);
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (remaining <= 0) deadline.abort();
  else timer = setTimeout(() => deadline.abort(), remaining);

  const files = expansion.files;
  const outcomes: Array<FileOutcome | undefined> = new Array(files.length);
  let next = 0;
  const workers = Math.max(1, Math.min(deps.parallel ?? MAX_PARALLEL, files.length));
  let answers: FileAnswer[] = [];
  let charsRead = 0;
  let inputTokens: number | null = 0;
  let answered = 0;
  let sent = 0;
  let contextSkips = 0;
  let firstContextMessage: string | null = null;
  let requests = 0;
  let partial = false;
  let error: ToolError | undefined;
  let errorMessage: string | null = null;
  let picked: AskJevFilesResponse['picked'] = null;
  let pickReason: PickReason | undefined;

  try {
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (true) {
          const index = next++;
          if (index >= files.length) return;
          if (!deadline.signal.aborted && expired()) deadline.abort();
          if (deadline.signal.aborted) {
            outcomes[index] = { kind: 'skip', reason: 'deadline', message: null, requests: 0 };
            continue;
          }
          outcomes[index] = await processFile(files[index], question, threshold, deps, settings);
        }
      }),
    );

    for (let i = 0; i < files.length; i++) {
      const outcome = outcomes[i];
      if (!outcome) continue;
      requests += outcome.requests;
      if (outcome.kind === 'answer') {
        answers.push(outcome.answer);
        charsRead += outcome.chars;
        inputTokens = addTokens(inputTokens, outcome.inputTokens);
        answered++;
        sent++;
        continue;
      }
      skipped.push({ path: files[i].requestedPath, reason: outcome.reason });
      if (outcome.message !== null) messages.push(outcome.message);
      if (outcome.reason === 'deadline') partial = true;
      if (outcome.reason === 'context' || outcome.reason === 'deadline' || outcome.reason === 'jev_error') sent++;
      if (outcome.reason === 'context') {
        contextSkips++;
        if (firstContextMessage === null) firstContextMessage = outcome.message;
      }
      if (outcome.error !== undefined && error === undefined) {
        error = outcome.error;
        errorMessage = outcome.message;
      }
    }
    if (answered === 0) inputTokens = null;
    if (answered > 0) {
      error = undefined;
      errorMessage = null;
    } else if (error === undefined && contextSkips > 0 && contextSkips === files.length) {
      error = 'jev_context';
      errorMessage = firstContextMessage;
    }
    answers = sortAnswers(answers);

    if (pick) {
      const candidates = selectCandidates(answers);
      if (candidates.length === 0) {
        pickReason = 'no_candidates';
      } else if (candidates.length === 1) {
        picked = singlePick(candidates[0]);
        pickReason = 'single';
      } else {
        if (!deadline.signal.aborted && expired()) deadline.abort();
        if (deadline.signal.aborted) {
          pickReason = 'deadline';
          partial = true;
        } else {
          const request = buildPickRequest(question, candidates);
          const budget = payloadWithinBudget({
            model: settings.model,
            state: request.state,
            questions: request.questions,
          });
          if (!budget.ok) {
            pickReason = 'context';
            messages.push(`payload do pick estimado em ${budget.tokens} tokens, acima do orcamento por request`);
          } else {
            try {
              const result = await askJevTransport(request.state, request.questions, {
                apiKey: settings.apiKey,
                model: settings.model,
                batchSize: 1,
                parallel: 1,
                requestTimeoutMs: settings.requestTimeoutMs,
                signal: deadline.signal,
                fetchImpl: settings.fetchImpl,
              });
              requests += result.requests;
              inputTokens = addTokens(inputTokens, result.inputTokens);
              const outcome = resolvePick(result.answers.pick, threshold, request);
              picked = outcome.picked;
              pickReason = outcome.pickReason;
            } catch (err) {
              requests += err instanceof JevError ? err.requestsAttempted : 1;
              if (deadline.signal.aborted) {
                pickReason = 'deadline';
                partial = true;
              } else if (err instanceof JevError && err.reason === 'context') {
                pickReason = 'context';
                messages.push(err.message);
              } else {
                pickReason = 'error';
                messages.unshift(`pick falhou: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      }
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const response: AskJevFilesResponse = {
    answers,
    picked,
    skipped,
    stats: {
      callId: ctx.callId,
      files: sent,
      eligible: files.length,
      charsRead,
      inputTokens,
      costUsd: costOf(inputTokens),
      wallMs: elapsed(ctx),
      partial,
      truncated: expansion.truncated,
      requests,
    },
  };
  if (pickReason !== undefined) response.pickReason = pickReason;
  if (error !== undefined) response.error = error;
  const message = error !== undefined ? (errorMessage ?? messages[0]) : messages[0];
  if (message !== undefined && message !== null) response.message = scrub(message, ctx.apiKey);
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeInput(input: unknown): { targets: string[]; question: UsageRecord['question'] } {
  const targets: string[] = [];
  let question: UsageRecord['question'] = null;
  if (isRecord(input)) {
    if (Array.isArray(input.targets)) {
      for (const target of input.targets) if (typeof target === 'string') targets.push(target);
    }
    if (isRecord(input.question) && typeof input.question.kind === 'string') {
      question = {
        kind: input.question.kind,
        instructions: typeof input.question.instructions === 'string' ? input.question.instructions : '',
      };
    }
  }
  return { targets, question };
}

function buildUsageRecord(
  input: unknown,
  response: AskJevFilesResponse,
  deps: AskJevFilesDeps,
  nowMs: number,
): UsageRecord {
  const described = describeInput(input);
  let timestamp: string;
  try {
    timestamp = new Date(nowMs).toISOString();
  } catch {
    timestamp = new Date().toISOString();
  }
  return {
    timestamp,
    callId: response.stats.callId,
    runtimeHint: readRuntimeHint(deps.env),
    targets: described.targets,
    files: response.stats.files,
    eligible: response.stats.eligible,
    charsRead: response.stats.charsRead,
    inputTokens: response.stats.inputTokens,
    costUsd: response.stats.costUsd,
    wallMs: response.stats.wallMs,
    partial: response.stats.partial,
    question: described.question,
    answers: response.answers.map((a) => ({ path: a.path, answer: a.answer })),
    picked: response.picked,
    pickReason: response.pickReason ?? null,
    skipped: response.skipped,
    error: response.error ?? null,
  };
}

export async function handleAskJevFiles(input: unknown, deps: AskJevFilesDeps): Promise<AskJevFilesResponse> {
  let lastKnownNow = Date.now();
  const safeNow = (): number => {
    try {
      const value = deps.now();
      if (Number.isFinite(value)) lastKnownNow = value;
    } catch {
      return lastKnownNow;
    }
    return lastKnownNow;
  };
  let callId: string | null = null;
  let startedAt: number | null = null;
  let response: AskJevFilesResponse;
  try {
    callId = deps.randomUUID();
    startedAt = safeNow();
    response = await run(input, deps, { callId, startedAt, now: safeNow, apiKey: deps.apiKey });
  } catch (err) {
    const ctx: CallContext = {
      callId: callId ?? crypto.randomUUID(),
      startedAt: startedAt ?? Date.now(),
      now: safeNow,
      apiKey: deps.apiKey,
    };
    response = failure(ctx, 'internal', `falha inesperada: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const record = buildUsageRecord(input, response, deps, safeNow());
    await appendUsageRecord(resolveUsageLogPath(deps.homeDir, deps.env), record, deps.fs.promises, deps.stderr);
  } catch (err) {
    try {
      deps.stderr(
        `jev-files: falha ao montar o registro de uso: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } catch {
      return response;
    }
  }
  return response;
}
