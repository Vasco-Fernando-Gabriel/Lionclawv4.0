import { describe, it, expect, vi, beforeEach } from 'vitest';

const KEY = 'ts_SECRET_KEY_NEVER_LOGGED_123';

const state = vi.hoisted(() => ({
  secret: { status: 'absent' } as
    { status: 'absent' } | { status: 'found'; value: string } | { status: 'error'; code: string; reason: string },
  settings: new Map<string, string>(),
  warnCalls: [] as unknown[][],
}));

vi.mock('../logger', () => {
  const capture = vi.fn((...args: unknown[]) => {
    state.warnCalls.push(args);
  });
  return { createLogger: () => ({ info: capture, warn: capture, error: capture, debug: capture }) };
});
vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => state.settings.get(key)),
}));
vi.mock('../secrets-vault', () => ({
  getSecretNonInteractive: vi.fn(async () => state.secret),
}));

import { askJev, checkJev, JevError, JEV_SYSTEM_ONE_URL, type JevChoiceQuestion } from '../jev-client';

type FetchInit = { headers: Record<string, string>; body: string; signal: AbortSignal };
type FetchHandler = (
  url: string,
  init: FetchInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function questions(n: number, prefix = 'q'): Record<string, JevChoiceQuestion> {
  const out: Record<string, JevChoiceQuestion> = {};
  for (let i = 1; i <= n; i++) {
    out[`${prefix}${i}`] = {
      type: 'choice',
      instructions: `pergunta ${i}`,
      criteria: { yes: 'sim', no: 'nao', unknown: '?' },
    };
  }
  return out;
}

function okBody(ids: string[], extra: Record<string, unknown> = {}): string {
  const answers: Record<string, unknown> = {};
  for (const id of ids)
    answers[id] = { choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.05, unknown: 0.05 } };
  return JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100 }, ...extra });
}

function response(status: number, text: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function idsOf(init: FetchInit): string[] {
  return Object.keys((JSON.parse(init.body) as { questions: Record<string, unknown> }).questions);
}

function abortable(init: FetchInit): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (init.signal.aborted) fail();
    else init.signal.addEventListener('abort', fail, { once: true });
  });
}

function makeFetch(handler: FetchHandler) {
  return vi.fn(handler) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function baseOpts(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof askJev>[2]> = {}) {
  return {
    apiKey: KEY,
    model: 'jev-1.13.0',
    batchSize: 12,
    parallel: 6,
    requestTimeoutMs: 1_000,
    signal: new AbortController().signal,
    fetchImpl,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(JevError);
    return err as JevError;
  }
  throw new Error('esperava rejeicao');
}

beforeEach(() => {
  state.secret = { status: 'absent' };
  state.settings = new Map();
  state.warnCalls = [];
});

describe('askJev: lotes, paralelismo e fusao', () => {
  it('25 perguntas em lotes de 12 viram 3 requests com as respostas fundidas e o uso somado', async () => {
    const fetchImpl = makeFetch(async (url, init) => {
      expect(url).toBe(JEV_SYSTEM_ONE_URL);
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      const ids = idsOf(init);
      expect(ids.length).toBeLessThanOrEqual(12);
      return response(200, okBody(ids));
    });
    const result = await askJev({ a: 1 }, questions(25), baseOpts(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Object.keys(result.answers)).toHaveLength(25);
    expect(result.answers.q7).toEqual({
      choice: 'yes',
      confidence: 0.9,
      probabilities: { yes: 0.9, no: 0.05, unknown: 0.05 },
    });
    expect(result.inputTokens).toBe(300);
    expect(result.requests).toBe(3);
    expect(result.requestedModel).toBe('jev-1.13.0');
    expect(result.returnedModel).toBe('jev-1.13.0');
    const sent = (JSON.parse(fetchImpl.mock.calls[0][1].body) as { model: string; state: unknown }).model;
    expect(sent).toBe('jev-1.13.0');
  });

  it('respeita o paralelismo pedido', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return response(200, okBody(idsOf(init)));
    });
    await askJev({}, questions(10), baseOpts(fetchImpl, { batchSize: 2, parallel: 2 }));

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it('uso ausente em um lote deixa inputTokens indisponivel (null), nunca zero', async () => {
    let n = 0;
    const fetchImpl = makeFetch(async (_url, init) => {
      n++;
      const ids = idsOf(init);
      return response(200, n === 2 ? okBody(ids, { usage: undefined }) : okBody(ids));
    });
    const result = await askJev({}, questions(3), baseOpts(fetchImpl, { batchSize: 1, parallel: 1 }));
    expect(result.inputTokens).toBeNull();
  });

  it('modelo devolvido diferente do pedido e aceito e registrado', async () => {
    const fetchImpl = makeFetch(async (_url, init) => response(200, okBody(idsOf(init), { model: 'jev-1.14.0' })));
    const result = await askJev({}, questions(2), baseOpts(fetchImpl, { model: 'jev-1.13.0' }));
    expect(result.requestedModel).toBe('jev-1.13.0');
    expect(result.returnedModel).toBe('jev-1.14.0');
  });

  it('sem perguntas nao faz request', async () => {
    const fetchImpl = makeFetch(async () => response(200, '{}'));
    const result = await askJev({}, {}, baseOpts(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.requests).toBe(0);
  });
});

describe('askJev: falhas', () => {
  it('HTTP != 2xx vira JevError(http) sem a chave na mensagem', async () => {
    const fetchImpl = makeFetch(async () => response(500, 'boom'));
    const err = await rejection(askJev({}, questions(2), baseOpts(fetchImpl)));
    expect(err.reason).toBe('http');
    expect(err.message).toContain('500');
    expect(err.message).not.toContain(KEY);
  });

  it('HTTP 400 com max_tokens_exceeded vira JevError(context)', async () => {
    const fetchImpl = makeFetch(async () =>
      response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } })),
    );
    const err = await rejection(askJev({}, questions(2), baseOpts(fetchImpl)));
    expect(err.reason).toBe('context');
  });

  it('id pedido ausente na resposta vira JevError(schema)', async () => {
    const fetchImpl = makeFetch(async (_url, init) => response(200, okBody(idsOf(init).slice(1))));
    const err = await rejection(askJev({}, questions(3), baseOpts(fetchImpl)));
    expect(err.reason).toBe('schema');
  });

  it('escolha fora do conjunto pedido vira JevError(schema)', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      const body = JSON.parse(okBody(idsOf(init))) as { answers: Record<string, { choice: string }> };
      body.answers.q1.choice = 'maybe';
      return response(200, JSON.stringify(body));
    });
    const err = await rejection(askJev({}, questions(2), baseOpts(fetchImpl)));
    expect(err.reason).toBe('schema');
  });

  it('confianca fora de 0..1 ou nao finita vira JevError(schema)', async () => {
    for (const bad of [1.5, -0.1, 'alta', null]) {
      const fetchImpl = makeFetch(async (_url, init) => {
        const body = JSON.parse(okBody(idsOf(init))) as { answers: Record<string, { confidence: unknown }> };
        body.answers.q1.confidence = bad;
        return response(200, JSON.stringify(body));
      });
      const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl)));
      expect(err.reason).toBe('schema');
    }
  });

  it('corpo que nao e JSON vira JevError(schema)', async () => {
    const fetchImpl = makeFetch(async () => response(200, '<html>'));
    const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl)));
    expect(err.reason).toBe('schema');
  });

  it('falha de rede vira JevError(http) sem a chave', async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error(`ECONNREFUSED`);
    });
    const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl)));
    expect(err.reason).toBe('http');
    expect(err.message).not.toContain(KEY);
  });

  it('request que passa do prazo por request vira JevError(timeout)', async () => {
    const fetchImpl = makeFetch((_url, init) => abortable(init));
    const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl, { requestTimeoutMs: 20 })));
    expect(err.reason).toBe('timeout');
  });

  it('prazo total (signal externo) cancela e vira JevError(timeout)', async () => {
    const controller = new AbortController();
    const fetchImpl = makeFetch((_url, init) => abortable(init));
    const pending = askJev(
      {},
      questions(1),
      baseOpts(fetchImpl, { signal: controller.signal, requestTimeoutMs: 5_000 }),
    );
    setTimeout(() => controller.abort(), 10);
    const err = await rejection(pending);
    expect(err.reason).toBe('timeout');
  });

  it('signal externo ja abortado nao faz request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = makeFetch(async () => response(200, '{}'));
    const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl, { signal: controller.signal })));
    expect(err.reason).toBe('timeout');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('o primeiro lote que falha aborta os demais e nada parcial e devolvido', async () => {
    let slowSignal: AbortSignal | null = null;
    let slowAborted = false;
    const fetchImpl = makeFetch(async (_url, init) => {
      const ids = idsOf(init);
      if (ids[0] === 'q1') return response(500, 'falhou');
      slowSignal = init.signal;
      init.signal.addEventListener('abort', () => {
        slowAborted = true;
      });
      return abortable(init);
    });
    const err = await rejection(askJev({}, questions(2), baseOpts(fetchImpl, { batchSize: 1, parallel: 2 })));
    expect(err.reason).toBe('http');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(slowSignal).not.toBeNull();
    expect(slowAborted).toBe(true);
  });
});

describe('checkJev', () => {
  it('sem chave salva responde ok=false sem chamar a rede', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await checkJev();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('nao configurada');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('erro ao ler o Vault responde ok=false com o motivo', async () => {
    state.secret = { status: 'error', code: 'VAULT-CORRUPT', reason: 'arquivo corrompido' };
    const result = await checkJev();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('arquivo corrompido');
  });

  it('com chave salva e API respondendo, devolve modelo e latencia usando o modelo configurado', async () => {
    state.secret = { status: 'found', value: KEY };
    state.settings.set('jev_model', 'jev-1.13.0');
    const fetchSpy = vi.fn(async (_url: string, init: FetchInit) => {
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect((JSON.parse(init.body) as { model: string }).model).toBe('jev-1.13.0');
      return response(200, okBody(idsOf(init), { model: 'jev-1.13.0' }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await checkJev();
      expect(result.ok).toBe(true);
      expect(result.model).toBe('jev-1.13.0');
      expect(typeof result.latencyMs).toBe('number');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('API fora do ar responde ok=false com erro legivel, sem a chave em lugar nenhum', async () => {
    state.secret = { status: 'found', value: KEY };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(503, 'down')),
    );
    try {
      const result = await checkJev();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('503');
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(state.warnCalls)).not.toContain(KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('askJev: achados do validador da sprint 1', () => {
  it('escolha herdada do prototype (constructor) nao passa como valida', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      const body = JSON.parse(okBody(idsOf(init))) as { answers: Record<string, { choice: string }> };
      body.answers.q1.choice = 'constructor';
      return response(200, JSON.stringify(body));
    });
    const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl)));
    expect(err.reason).toBe('schema');
  });

  it('o erro devolvido e o do lote que falhou de verdade, nao o dos lotes cancelados', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      const ids = idsOf(init);
      if (ids[0] === 'q2') return response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }));
      return abortable(init);
    });
    const err = await rejection(askJev({}, questions(3), baseOpts(fetchImpl, { batchSize: 1, parallel: 3 })));
    expect(err.reason).toBe('context');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('signal externo com varios lotes em voo cancela todos e vira timeout', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      signals.push(init.signal);
      return abortable(init);
    });
    const pending = askJev(
      {},
      questions(3),
      baseOpts(fetchImpl, { batchSize: 1, parallel: 3, signal: controller.signal, requestTimeoutMs: 5_000 }),
    );
    setTimeout(() => controller.abort(), 10);
    const err = await rejection(pending);
    expect(err.reason).toBe('timeout');
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('nenhuma mensagem de erro (schema, context, timeout) carrega a chave', async () => {
    const cases: Array<[string, FetchHandler]> = [
      ['schema', async () => response(200, '<html>')],
      ['context', async () => response(400, 'max_tokens_exceeded')],
      ['timeout', (_url, init) => abortable(init)],
    ];
    for (const [reason, handler] of cases) {
      const err = await rejection(askJev({}, questions(1), baseOpts(makeFetch(handler), { requestTimeoutMs: 20 })));
      expect(err.reason).toBe(reason);
      expect(err.message).not.toContain(KEY);
    }
  });

  it('res.text() rejeitando por abort tambem vira timeout', async () => {
    const fetchImpl = makeFetch(async (_url, init) => ({
      ok: true,
      status: 200,
      text: () => abortable(init),
    }));
    const err = await rejection(askJev({}, questions(1), baseOpts(fetchImpl, { requestTimeoutMs: 20 })));
    expect(err.reason).toBe('timeout');
  });
});

describe('checkJev: achados do validador da sprint 1', () => {
  it('funciona com a flag explicitamente desligada e usa o modelo default quando jev_model esta ausente', async () => {
    state.secret = { status: 'found', value: KEY };
    state.settings.set('jev_shadow_enabled', 'false');
    const fetchSpy = vi.fn(async (_url: string, init: FetchInit) => {
      expect((JSON.parse(init.body) as { model: string }).model).toBe('jev-1.13.0');
      return response(200, okBody(idsOf(init)));
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await checkJev();
      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
