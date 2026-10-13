import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  askJevTransport,
  JevError,
  JEV_SYSTEM_ONE_URL,
  type JevChoiceQuestion,
  type JevNoulQuestion,
  type JevQuestion,
  type JevScoreQuestion,
  type JevTransportOptions,
} from '../jev-transport';

const KEY = 'ts_SECRET_KEY_NEVER_LOGGED_123';

type FetchInit = { headers: Record<string, string>; body: string; signal: AbortSignal };
type FetchHandler = (
  url: string,
  init: FetchInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function choiceQuestions(n: number, prefix = 'q'): Record<string, JevChoiceQuestion> {
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

function okChoiceBody(ids: string[], extra: Record<string, unknown> = {}): string {
  const answers: Record<string, unknown> = {};
  for (const id of ids)
    answers[id] = { choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.05, unknown: 0.05 } };
  return JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100 }, ...extra });
}

function response(status: number, text: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function sentBody(init: FetchInit): { model: string; state: unknown; questions: Record<string, JevQuestion> } {
  return JSON.parse(init.body) as { model: string; state: unknown; questions: Record<string, JevQuestion> };
}

function idsOf(init: FetchInit): string[] {
  return Object.keys(sentBody(init).questions);
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

function baseOpts(fetchImpl: typeof fetch, overrides: Partial<JevTransportOptions> = {}): JevTransportOptions {
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

const noul: JevNoulQuestion = {
  type: 'noul',
  instructions: 'o arquivo exporta a funcao X?',
  criteria: { true: 'exporta', false: 'nao exporta' },
};

const score: JevScoreQuestion = {
  type: 'score',
  instructions: 'quanto este arquivo trata de autenticacao?',
  criteria: ['nada', 'de passagem', 'central'],
};

describe('jev-transport: Noul no formato da API', () => {
  it('envia type noul com instructions e criteria e aceita resposta so com noul', async () => {
    const fetchImpl = makeFetch(async (url, init) => {
      expect(url).toBe(JEV_SYSTEM_ONE_URL);
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      const body = sentBody(init);
      expect(body.questions.q).toEqual({
        type: 'noul',
        instructions: 'o arquivo exporta a funcao X?',
        criteria: { true: 'exporta', false: 'nao exporta' },
      });
      expect(body.state).toEqual({ path: 'a.ts', content: 'export function X() {}' });
      return response(200, JSON.stringify({ model: 'jev-1.13.0', answers: { q: { noul: 0.93 } } }));
    });
    const result = await askJevTransport(
      { path: 'a.ts', content: 'export function X() {}' },
      { q: noul },
      baseOpts(fetchImpl),
    );
    expect(result.answers.q).toEqual({ noul: 0.93 });
    expect('confidence' in result.answers.q).toBe(false);
    expect(result.inputTokens).toBeNull();
  });

  it('noul sem criteria nao envia a chave criteria', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      expect('criteria' in sentBody(init).questions.q).toBe(false);
      return response(200, JSON.stringify({ answers: { q: { noul: 0 } } }));
    });
    const result = await askJevTransport({}, { q: { type: 'noul', instructions: 'x?' } }, baseOpts(fetchImpl));
    expect(result.answers.q.noul).toBe(0);
  });

  it('noul fora de 0..1, nao numerico ou ausente vira JevError(schema)', async () => {
    for (const bad of [1.2, -0.01, '0.5', null, undefined]) {
      const fetchImpl = makeFetch(async () =>
        response(200, JSON.stringify({ answers: { q: bad === undefined ? {} : { noul: bad } } })),
      );
      const err = await rejection(askJevTransport({}, { q: noul }, baseOpts(fetchImpl)));
      expect(err.reason).toBe('schema');
    }
  });
});

describe('jev-transport: Score no formato da API', () => {
  it('envia criteria como array ordenado e devolve score, confidence, probabilities e legend', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      const body = sentBody(init);
      expect(body.questions.q).toEqual({
        type: 'score',
        instructions: 'quanto este arquivo trata de autenticacao?',
        criteria: ['nada', 'de passagem', 'central'],
      });
      return response(
        200,
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            q: {
              score: 1.4,
              confidence: 0.7,
              probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
              legend: { '0': 'nada', '1': 'de passagem', '2': 'central' },
            },
          },
          usage: { input_tokens: 42 },
        }),
      );
    });
    const result = await askJevTransport({}, { q: score }, baseOpts(fetchImpl));
    expect(result.answers.q).toEqual({
      score: 1.4,
      confidence: 0.7,
      probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
      legend: { '0': 'nada', '1': 'de passagem', '2': 'central' },
    });
    expect(result.inputTokens).toBe(42);
  });

  it('score fora de 0..n-1 vira JevError(schema)', async () => {
    for (const bad of [-0.1, 2.01, 'alto', null]) {
      const fetchImpl = makeFetch(async () =>
        response(
          200,
          JSON.stringify({ answers: { q: { score: bad, confidence: 0.5, probabilities: {}, legend: {} } } }),
        ),
      );
      const err = await rejection(askJevTransport({}, { q: score }, baseOpts(fetchImpl)));
      expect(err.reason).toBe('schema');
    }
  });

  it('confianca invalida no score vira JevError(schema)', async () => {
    const fetchImpl = makeFetch(async () =>
      response(200, JSON.stringify({ answers: { q: { score: 1, confidence: 1.5, probabilities: {}, legend: {} } } })),
    );
    const err = await rejection(askJevTransport({}, { q: score }, baseOpts(fetchImpl)));
    expect(err.reason).toBe('schema');
  });

  it('probabilities de score so guarda chaves numericas dentro dos niveis; legend so textos', async () => {
    const fetchImpl = makeFetch(async () =>
      response(
        200,
        JSON.stringify({
          answers: {
            q: {
              score: 2,
              confidence: 0.9,
              probabilities: { '0': 0.1, '2': 0.9, '7': 0.3, abc: 1, '1': 'x' },
              legend: { '0': 'nada', '1': 5 },
            },
          },
        }),
      ),
    );
    const result = await askJevTransport({}, { q: score }, baseOpts(fetchImpl));
    expect(result.answers.q.probabilities).toEqual({ '0': 0.1, '2': 0.9 });
    expect(result.answers.q.legend).toEqual({ '0': 'nada' });
  });

  it('score com menos de 2 ou mais de 10 niveis e recusado antes de qualquer request', async () => {
    const fetchImpl = makeFetch(async () => response(200, '{}'));
    for (const criteria of [['um'], Array.from({ length: 11 }, (_, i) => `n${i}`)]) {
      const err = await rejection(
        askJevTransport({}, { q: { type: 'score', instructions: 'x', criteria } }, baseOpts(fetchImpl)),
      );
      expect(err.reason).toBe('schema');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('jev-transport: lote misto', () => {
  it('valida cada resposta pelo tipo da pergunta correspondente', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      const body = sentBody(init);
      expect(Object.keys(body.questions)).toEqual(['b', 'c', 's']);
      return response(
        200,
        JSON.stringify({
          answers: {
            b: { noul: 0.2 },
            c: { choice: 'no', confidence: 0.8, probabilities: { yes: 0.2, no: 0.8 } },
            s: { score: 0.5, confidence: 0.6, probabilities: { '0': 0.5, '1': 0.5 }, legend: {} },
          },
        }),
      );
    });
    const questions: Record<string, JevQuestion> = {
      b: noul,
      c: { type: 'choice', instructions: 'c?', criteria: { yes: 's', no: 'n' } },
      s: { type: 'score', instructions: 's?', criteria: ['baixo', 'alto'] },
    };
    const result = await askJevTransport({}, questions, baseOpts(fetchImpl));
    expect(result.answers.b).toEqual({ noul: 0.2 });
    expect(result.answers.c).toEqual({ choice: 'no', confidence: 0.8, probabilities: { yes: 0.2, no: 0.8 } });
    expect(result.answers.s).toEqual({
      score: 0.5,
      confidence: 0.6,
      probabilities: { '0': 0.5, '1': 0.5 },
      legend: {},
    });
  });
});

describe('jev-transport: lotes, paralelismo e fusao (Choice)', () => {
  it('25 perguntas em lotes de 12 viram 3 requests com as respostas fundidas e o uso somado', async () => {
    const fetchImpl = makeFetch(async (url, init) => {
      expect(url).toBe(JEV_SYSTEM_ONE_URL);
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      const ids = idsOf(init);
      expect(ids.length).toBeLessThanOrEqual(12);
      return response(200, okChoiceBody(ids));
    });
    const result = await askJevTransport({ a: 1 }, choiceQuestions(25), baseOpts(fetchImpl));

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
    expect(sentBody(fetchImpl.mock.calls[0][1]).model).toBe('jev-1.13.0');
  });

  it('respeita o paralelismo pedido', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return response(200, okChoiceBody(idsOf(init)));
    });
    await askJevTransport({}, choiceQuestions(10), baseOpts(fetchImpl, { batchSize: 2, parallel: 2 }));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it('uso ausente em um lote deixa inputTokens indisponivel (null), nunca zero', async () => {
    let n = 0;
    const fetchImpl = makeFetch(async (_url, init) => {
      n++;
      const ids = idsOf(init);
      return response(200, n === 2 ? okChoiceBody(ids, { usage: undefined }) : okChoiceBody(ids));
    });
    const result = await askJevTransport({}, choiceQuestions(3), baseOpts(fetchImpl, { batchSize: 1, parallel: 1 }));
    expect(result.inputTokens).toBeNull();
  });

  it('modelo devolvido diferente do pedido e aceito e registrado', async () => {
    const fetchImpl = makeFetch(async (_url, init) =>
      response(200, okChoiceBody(idsOf(init), { model: 'jev-1.14.0' })),
    );
    const result = await askJevTransport({}, choiceQuestions(2), baseOpts(fetchImpl, { model: 'jev-1.13.0' }));
    expect(result.requestedModel).toBe('jev-1.13.0');
    expect(result.returnedModel).toBe('jev-1.14.0');
  });

  it('sem perguntas nao faz request', async () => {
    const fetchImpl = makeFetch(async () => response(200, '{}'));
    const result = await askJevTransport({}, {}, baseOpts(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.requests).toBe(0);
  });
});

describe('jev-transport: classificacao de falhas', () => {
  it('HTTP != 2xx vira JevError(http) sem a chave na mensagem', async () => {
    const fetchImpl = makeFetch(async () => response(500, 'boom'));
    const err = await rejection(askJevTransport({}, choiceQuestions(2), baseOpts(fetchImpl)));
    expect(err.reason).toBe('http');
    expect(err.message).toContain('500');
    expect(err.message).not.toContain(KEY);
  });

  it('HTTP 400 com max_tokens_exceeded vira JevError(context)', async () => {
    const fetchImpl = makeFetch(async () =>
      response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } })),
    );
    const err = await rejection(askJevTransport({}, choiceQuestions(2), baseOpts(fetchImpl)));
    expect(err.reason).toBe('context');
  });

  it('id pedido ausente na resposta vira JevError(schema)', async () => {
    const fetchImpl = makeFetch(async (_url, init) => response(200, okChoiceBody(idsOf(init).slice(1))));
    const err = await rejection(askJevTransport({}, choiceQuestions(3), baseOpts(fetchImpl)));
    expect(err.reason).toBe('schema');
  });

  it('escolha fora do conjunto pedido (inclusive herdada do prototype) vira JevError(schema)', async () => {
    for (const bad of ['maybe', 'constructor']) {
      const fetchImpl = makeFetch(async (_url, init) => {
        const body = JSON.parse(okChoiceBody(idsOf(init))) as { answers: Record<string, { choice: string }> };
        body.answers.q1.choice = bad;
        return response(200, JSON.stringify(body));
      });
      const err = await rejection(askJevTransport({}, choiceQuestions(2), baseOpts(fetchImpl)));
      expect(err.reason).toBe('schema');
    }
  });

  it('confianca fora de 0..1 ou nao finita vira JevError(schema)', async () => {
    for (const bad of [1.5, -0.1, 'alta', null]) {
      const fetchImpl = makeFetch(async (_url, init) => {
        const body = JSON.parse(okChoiceBody(idsOf(init))) as { answers: Record<string, { confidence: unknown }> };
        body.answers.q1.confidence = bad;
        return response(200, JSON.stringify(body));
      });
      const err = await rejection(askJevTransport({}, choiceQuestions(1), baseOpts(fetchImpl)));
      expect(err.reason).toBe('schema');
    }
  });

  it('corpo que nao e JSON ou sem answers vira JevError(schema)', async () => {
    for (const text of ['<html>', '{"model":"x"}']) {
      const fetchImpl = makeFetch(async () => response(200, text));
      const err = await rejection(askJevTransport({}, choiceQuestions(1), baseOpts(fetchImpl)));
      expect(err.reason).toBe('schema');
    }
  });

  it('falha de rede vira JevError(http) sem a chave', async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const err = await rejection(askJevTransport({}, choiceQuestions(1), baseOpts(fetchImpl)));
    expect(err.reason).toBe('http');
    expect(err.message).not.toContain(KEY);
  });

  it('request que passa do prazo por request vira JevError(timeout)', async () => {
    const fetchImpl = makeFetch((_url, init) => abortable(init));
    const err = await rejection(askJevTransport({}, choiceQuestions(1), baseOpts(fetchImpl, { requestTimeoutMs: 20 })));
    expect(err.reason).toBe('timeout');
  });

  it('res.text() rejeitando por abort tambem vira timeout', async () => {
    const fetchImpl = makeFetch(async (_url, init) => ({ ok: true, status: 200, text: () => abortable(init) }));
    const err = await rejection(askJevTransport({}, { q: noul }, baseOpts(fetchImpl, { requestTimeoutMs: 20 })));
    expect(err.reason).toBe('timeout');
  });

  it('prazo total (signal externo) cancela todos os lotes em voo e vira JevError(timeout)', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      signals.push(init.signal);
      return abortable(init);
    });
    const pending = askJevTransport(
      {},
      choiceQuestions(3),
      baseOpts(fetchImpl, { batchSize: 1, parallel: 3, signal: controller.signal, requestTimeoutMs: 5_000 }),
    );
    setTimeout(() => controller.abort(), 10);
    const err = await rejection(pending);
    expect(err.reason).toBe('timeout');
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('signal externo ja abortado nao faz request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = makeFetch(async () => response(200, '{}'));
    const err = await rejection(
      askJevTransport({}, choiceQuestions(1), baseOpts(fetchImpl, { signal: controller.signal })),
    );
    expect(err.reason).toBe('timeout');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('o primeiro lote que falha aborta os demais e nada parcial e devolvido', async () => {
    let slowAborted = false;
    const fetchImpl = makeFetch(async (_url, init) => {
      if (idsOf(init)[0] === 'q1') return response(500, 'falhou');
      init.signal.addEventListener('abort', () => {
        slowAborted = true;
      });
      return abortable(init);
    });
    const err = await rejection(
      askJevTransport({}, choiceQuestions(2), baseOpts(fetchImpl, { batchSize: 1, parallel: 2 })),
    );
    expect(err.reason).toBe('http');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(slowAborted).toBe(true);
  });

  it('o erro devolvido e o do lote que falhou de verdade, nao o dos lotes cancelados', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      if (idsOf(init)[0] === 'q2')
        return response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }));
      return abortable(init);
    });
    const err = await rejection(
      askJevTransport({}, choiceQuestions(3), baseOpts(fetchImpl, { batchSize: 1, parallel: 3 })),
    );
    expect(err.reason).toBe('context');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('nenhuma mensagem de erro (schema, context, timeout, http) carrega a chave', async () => {
    const cases: Array<[string, FetchHandler]> = [
      ['schema', async () => response(200, '<html>')],
      ['context', async () => response(400, 'max_tokens_exceeded')],
      ['timeout', (_url, init) => abortable(init)],
      [
        'http',
        async () => {
          throw new Error(`rede caiu com ${KEY}`);
        },
      ],
    ];
    for (const [reason, handler] of cases) {
      const err = await rejection(
        askJevTransport({}, choiceQuestions(1), baseOpts(makeFetch(handler), { requestTimeoutMs: 20 })),
      );
      expect(err.reason).toBe(reason);
      if (reason !== 'http') expect(err.message).not.toContain(KEY);
    }
  });
});

describe('jev-transport: fetchImpl que nao devolve Response', () => {
  it('undefined, objeto vazio ou sem text() viram JevError(http) sem derrubar o chamador', async () => {
    const bogus: unknown[] = [undefined, {}, { ok: true, status: 200 }, null];
    for (const value of bogus) {
      const fetchImpl = makeFetch(async () => value as never);
      const err = await rejection(askJevTransport({}, { q: noul }, baseOpts(fetchImpl)));
      expect(err.reason).toBe('http');
      expect(err.message).not.toContain(KEY);
    }
  });
});

describe('jev-transport: requests tentados em falha', () => {
  it('JevError carrega requestsAttempted com os lotes iniciados', async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      if (idsOf(init)[0] === 'q2') return response(500, 'falhou');
      return response(200, okChoiceBody(idsOf(init)));
    });
    const err = await rejection(
      askJevTransport({}, choiceQuestions(3), baseOpts(fetchImpl, { batchSize: 1, parallel: 1 })),
    );
    expect(err.reason).toBe('http');
    expect(err.requestsAttempted).toBe(2);
  });

  it('signal ja abortado => requestsAttempted 0; sucesso => requests igual aos lotes', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(
      askJevTransport(
        {},
        choiceQuestions(2),
        baseOpts(
          makeFetch(async () => response(200, '{}')),
          {
            signal: controller.signal,
          },
        ),
      ),
    );
    expect(err.requestsAttempted).toBe(0);
    const ok = await askJevTransport(
      {},
      choiceQuestions(2),
      baseOpts(
        makeFetch(async (_url, init) => response(200, okChoiceBody(idsOf(init)))),
        { batchSize: 1 },
      ),
    );
    expect(ok.requests).toBe(2);
  });
});

describe('jev-transport: usage.input_tokens', () => {
  it('so inteiro >= 0 conta; negativo, fracionario, texto ou ausente viram null', async () => {
    const cases: Array<[unknown, number | null]> = [
      [120, 120],
      [0, 0],
      [-5, null],
      [12.5, null],
      ['120', null],
      [undefined, null],
    ];
    for (const [usage, expected] of cases) {
      const fetchImpl = makeFetch(async () =>
        response(
          200,
          JSON.stringify({
            answers: { q: { noul: 0.5 } },
            ...(usage === undefined ? {} : { usage: { input_tokens: usage } }),
          }),
        ),
      );
      const result = await askJevTransport({}, { q: noul }, baseOpts(fetchImpl));
      expect(result.inputTokens, String(usage)).toBe(expected);
    }
  });
});

describe('jev-transport: isolamento do Electron', () => {
  const transportPath = path.join(__dirname, '..', 'jev-transport.ts');

  function importsOf(source: string): string[] {
    const specifiers: string[] = [];
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm))
      specifiers.push(match[1]);
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
    return specifiers;
  }

  it('o fonte nao importa nada de electron/ nem de modulos do app', () => {
    const source = fs.readFileSync(transportPath, 'utf8');
    expect(importsOf(source)).toEqual([]);
    expect(source).not.toMatch(/electron/i);
    expect(source).not.toMatch(/createLogger|getSetting|secrets-vault/);
  });

  it('o grafo de imports relativos a partir do transporte fica dentro de _shared', () => {
    const seen = new Set<string>();
    const pending = [transportPath];
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importsOf(fs.readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
        pending.push(fs.existsSync(resolved) ? resolved : `${resolved}.ts`);
      }
    }
    for (const file of seen) {
      expect(file.replace(/\\/g, '/')).toContain('/mcp-servers/_shared/');
      expect(file.replace(/\\/g, '/')).not.toMatch(/\/electron\//);
    }
  });

  it('o metafile do bundle do transporte nao contem nenhum input de electron/', async () => {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [transportPath],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, '/'));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).not.toMatch(/(^|\/)electron\//);
      expect(input).not.toMatch(/node_modules/);
      expect(input).toContain('mcp-servers/_shared/');
    }
  });
});
