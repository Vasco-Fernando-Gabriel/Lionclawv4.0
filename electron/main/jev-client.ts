import { createLogger } from './logger';
import { getSetting } from './db';
import { getSecretNonInteractive } from './secrets-vault';
import { JEV_API_KEY_VAULT_KEY, JEV_MODEL_SETTING_KEY, resolveJevModel } from './jev-settings';
import {
  askJevTransport,
  JevError,
  JEV_PRICE_USD_PER_MTOK,
  JEV_SYSTEM_ONE_URL,
  type JevChoiceAnswer,
  type JevChoiceQuestion,
  type JevFailure,
  type JevTransportOptions,
  type JevTransportResult,
} from '../../mcp-servers/_shared/jev-transport';

export { JevError, JEV_PRICE_USD_PER_MTOK, JEV_SYSTEM_ONE_URL };
export type { JevChoiceAnswer, JevChoiceQuestion, JevFailure };

const logger = createLogger('jev');

export type JevBatchResult = JevTransportResult<JevChoiceAnswer>;

export type AskJevOptions = JevTransportOptions;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevChoiceQuestion>,
  opts: AskJevOptions,
): Promise<JevBatchResult> {
  return askJevTransport(state, questions, opts);
}

export interface JevCheckResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 10_000;

export async function checkJev(): Promise<JevCheckResult> {
  const secret = await getSecretNonInteractive(JEV_API_KEY_VAULT_KEY);
  if (secret.status === 'absent' || (secret.status === 'found' && secret.value.trim().length === 0)) {
    return { ok: false, error: 'Chave do Jev nao configurada no Vault.' };
  }
  if (secret.status === 'error') {
    return { ok: false, error: `Nao foi possivel ler a chave do Jev: ${secret.reason}` };
  }

  const model = resolveJevModel(getSetting(JEV_MODEL_SETTING_KEY));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), CHECK_TIMEOUT_MS + 1_000);
  const startedAt = Date.now();
  try {
    const result = await askJev(
      { ping: 'pong' },
      {
        ping: {
          type: 'choice',
          instructions: 'Does the field "ping" of the state equal the word "pong"?',
          criteria: { yes: 'it equals pong', no: 'it does not equal pong', unknown: 'cannot tell' },
        },
      },
      {
        apiKey: secret.value,
        model,
        batchSize: 1,
        parallel: 1,
        requestTimeoutMs: CHECK_TIMEOUT_MS,
        signal: deadline.signal,
      },
    );
    return { ok: true, model: result.returnedModel, latencyMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof JevError ? err.message : `falha inesperada: ${errorMessage(err)}`;
    logger.warn({ reason: err instanceof JevError ? err.reason : 'unknown' }, 'jev:check falhou');
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
