export const JEV_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_PRICE_USD_PER_MTOK = 0.042;
export const JEV_SCORE_MIN_LEVELS = 2;
export const JEV_SCORE_MAX_LEVELS = 10;

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
  noul: number;
}

export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevAnswerFor<Q extends JevQuestion> = Q extends JevNoulQuestion
  ? JevNoulAnswer
  : Q extends JevChoiceQuestion
    ? JevChoiceAnswer
    : Q extends JevScoreQuestion
      ? JevScoreAnswer
      : never;

export type JevFailure = 'http' | 'timeout' | 'schema' | 'context';

export class JevError extends Error {
  readonly reason: JevFailure;
  requestsAttempted: number;

  constructor(reason: JevFailure, message: string, requestsAttempted = 0) {
    super(message);
    this.name = 'JevError';
    this.reason = reason;
    this.requestsAttempted = requestsAttempted;
  }
}

export interface JevTransportResult<A extends JevAnswer = JevAnswer> {
  answers: Record<string, A>;
  requestedModel: string;
  returnedModel: string;
  inputTokens: number | null;
  requests: number;
  wallMs: number;
}

export interface JevTransportOptions {
  apiKey: string;
  model: string;
  batchSize: number;
  parallel: number;
  requestTimeoutMs: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface BatchOutcome<A extends JevAnswer> {
  answers: Record<string, A>;
  returnedModel: string | null;
  inputTokens: number | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function numberRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

function stringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}

function parseNoul(id: string, raw: Record<string, unknown>): JevNoulAnswer {
  const noul = raw.noul;
  if (!isUnitInterval(noul)) throw new JevError('schema', `noul fora de 0..1 na pergunta ${id}`);
  return { noul };
}

function parseChoice(id: string, raw: Record<string, unknown>, question: JevChoiceQuestion): JevChoiceAnswer {
  const choice = raw.choice;
  if (typeof choice !== 'string' || !hasOwn(question.criteria, choice)) {
    throw new JevError('schema', `escolha fora do conjunto pedido na pergunta ${id}`);
  }
  const confidence = raw.confidence;
  if (!isUnitInterval(confidence)) throw new JevError('schema', `confianca invalida na pergunta ${id}`);
  return { choice, confidence, probabilities: numberRecord(raw.probabilities) };
}

function parseScore(id: string, raw: Record<string, unknown>, question: JevScoreQuestion): JevScoreAnswer {
  const max = question.criteria.length - 1;
  const score = raw.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > max) {
    throw new JevError('schema', `score fora de 0..${max} na pergunta ${id}`);
  }
  const confidence = raw.confidence;
  if (!isUnitInterval(confidence)) throw new JevError('schema', `confianca invalida na pergunta ${id}`);
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(numberRecord(raw.probabilities))) {
    if (/^\d+$/.test(key) && Number(key) <= max) probabilities[key] = value;
  }
  return { score, confidence, probabilities, legend: stringRecord(raw.legend) };
}

function parseAnswer<Q extends JevQuestion>(id: string, raw: unknown, question: Q): JevAnswerFor<Q> {
  if (!isRecord(raw)) throw new JevError('schema', `resposta ausente ou invalida para a pergunta ${id}`);
  switch (question.type) {
    case 'noul':
      return parseNoul(id, raw) as JevAnswerFor<Q>;
    case 'choice':
      return parseChoice(id, raw, question) as JevAnswerFor<Q>;
    case 'score':
      return parseScore(id, raw, question) as JevAnswerFor<Q>;
  }
}

function assertQuestionShape(id: string, question: JevQuestion): void {
  if (question.type === 'score') {
    const n = question.criteria.length;
    if (n < JEV_SCORE_MIN_LEVELS || n > JEV_SCORE_MAX_LEVELS) {
      throw new JevError(
        'schema',
        `pergunta ${id}: score exige entre ${JEV_SCORE_MIN_LEVELS} e ${JEV_SCORE_MAX_LEVELS} niveis (recebeu ${n})`,
      );
    }
  }
}

async function runBatch<Q extends JevQuestion>(
  batch: Record<string, Q>,
  state: unknown,
  opts: JevTransportOptions,
  cancel: AbortSignal,
): Promise<BatchOutcome<JevAnswerFor<Q>>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const onCancel = () => controller.abort();
  cancel.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.requestTimeoutMs);

  const classifyAbort = (err: unknown): JevError => {
    if (timedOut) return new JevError('timeout', `request ao Jev estourou ${opts.requestTimeoutMs} ms`);
    if (opts.signal.aborted) return new JevError('timeout', 'prazo total da execucao esgotado');
    if (cancel.aborted) return new JevError('http', 'request cancelado por falha de outro lote');
    return new JevError('http', `falha de rede ao chamar o Jev: ${errorMessage(err)}`);
  };

  try {
    let res: Response;
    try {
      res = await fetchImpl(JEV_SYSTEM_ONE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model, state, questions: batch }),
        signal: controller.signal,
      });
    } catch (err) {
      throw classifyAbort(err);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw classifyAbort(err);
    }

    if (!res.ok) {
      if (res.status === 400 && text.includes('max_tokens_exceeded')) {
        throw new JevError('context', 'state acima do contexto aceito pelo Jev (max_tokens_exceeded)');
      }
      throw new JevError('http', `Jev respondeu HTTP ${res.status}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new JevError('schema', 'corpo da resposta do Jev nao e JSON');
    }
    if (!isRecord(body) || !isRecord(body.answers)) {
      throw new JevError('schema', 'resposta do Jev sem o campo answers');
    }

    const answers: Record<string, JevAnswerFor<Q>> = {};
    for (const [id, question] of Object.entries(batch)) {
      answers[id] = parseAnswer(id, body.answers[id], question);
    }
    const usage = isRecord(body.usage) ? body.usage.input_tokens : undefined;
    return {
      answers,
      returnedModel: typeof body.model === 'string' ? body.model : null,
      inputTokens: typeof usage === 'number' && Number.isInteger(usage) && usage >= 0 ? usage : null,
    };
  } finally {
    clearTimeout(timer);
    cancel.removeEventListener('abort', onCancel);
  }
}

export async function askJevTransport<Q extends JevQuestion>(
  state: unknown,
  questions: Record<string, Q>,
  opts: JevTransportOptions,
): Promise<JevTransportResult<JevAnswerFor<Q>>> {
  const startedAt = Date.now();
  const keys = Object.keys(questions);
  for (const key of keys) assertQuestionShape(key, questions[key]);
  const batchSize = Math.max(1, Math.floor(opts.batchSize));
  const batches: Array<Record<string, Q>> = [];
  for (let i = 0; i < keys.length; i += batchSize) {
    batches.push(Object.fromEntries(keys.slice(i, i + batchSize).map((k) => [k, questions[k]])));
  }
  if (batches.length === 0) {
    return {
      answers: {},
      requestedModel: opts.model,
      returnedModel: opts.model,
      inputTokens: 0,
      requests: 0,
      wallMs: 0,
    };
  }
  if (opts.signal.aborted) throw new JevError('timeout', 'prazo total da execucao esgotado');

  const cancel = new AbortController();
  const onExternalAbort = () => cancel.abort();
  opts.signal.addEventListener('abort', onExternalAbort, { once: true });

  const outcomes: Array<BatchOutcome<JevAnswerFor<Q>> | undefined> = new Array(batches.length);
  let firstError: unknown = null;
  let next = 0;
  let started = 0;

  try {
    const workerCount = Math.max(1, Math.min(Math.floor(opts.parallel), batches.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (next < batches.length && !cancel.signal.aborted) {
          const index = next++;
          started++;
          try {
            outcomes[index] = await runBatch(batches[index], state, opts, cancel.signal);
          } catch (err) {
            if (firstError === null) firstError = err;
            cancel.abort();
            return;
          }
        }
      }),
    );
  } finally {
    opts.signal.removeEventListener('abort', onExternalAbort);
  }

  if (firstError instanceof JevError) firstError.requestsAttempted = started;
  if (firstError !== null) throw firstError;
  if (opts.signal.aborted) throw new JevError('timeout', 'prazo total da execucao esgotado', started);

  const answers: Record<string, JevAnswerFor<Q>> = {};
  let inputTokens: number | null = 0;
  let returnedModel: string | null = null;
  for (const outcome of outcomes) {
    if (!outcome) throw new JevError('http', 'lote sem resultado', started);
    Object.assign(answers, outcome.answers);
    inputTokens = inputTokens === null || outcome.inputTokens === null ? null : inputTokens + outcome.inputTokens;
    if (returnedModel === null && outcome.returnedModel !== null) returnedModel = outcome.returnedModel;
  }

  return {
    answers,
    requestedModel: opts.model,
    returnedModel: returnedModel ?? opts.model,
    inputTokens,
    requests: batches.length,
    wallMs: Date.now() - startedAt,
  };
}
