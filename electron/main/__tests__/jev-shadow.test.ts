import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KEY = 'ts_SECRET_SHADOW_KEY_999';

const state = vi.hoisted(() => ({
  home: '',
  settings: new Map<string, string>(),
  secret: { status: 'absent' } as
    { status: 'absent' } | { status: 'found'; value: string } | { status: 'error'; code: string; reason: string },
  logs: [] as unknown[][],
}));

vi.mock('../logger', () => {
  const capture = vi.fn((...args: unknown[]) => {
    state.logs.push(args);
  });
  return { createLogger: () => ({ info: capture, warn: capture, error: capture, debug: capture }) };
});
vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../db', () => ({ getSetting: vi.fn((key: string) => state.settings.get(key)) }));
vi.mock('../secrets-vault', () => ({ getSecretNonInteractive: vi.fn(async () => state.secret) }));
vi.mock('../jev-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../jev-client')>();
  return { ...original, askJev: vi.fn() };
});

import { getSetting } from '../db';
import { getSecretNonInteractive } from '../secrets-vault';
import { askJev, JevError, type JevChoiceAnswer, type JevChoiceQuestion } from '../jev-client';
import {
  __jevShadowInternals,
  JEV_SHADOW_JSONL_FILE,
  recomposeShadowPlan,
  runJevShadow,
  runJevShadowSafe,
  type JevShadowGateInfo,
  type JevShadowRecord,
  type JevShadowSnapshot,
} from '../jev-shadow';
import { composeShadowPlan, JEV_SHADOW_DEFAULT_THRESHOLDS } from '../jev-shadow-compose';
import type { DreamingGateResult } from '../dreaming-gate';

const askMock = vi.mocked(askJev);

function answerAll(questions: Record<string, JevChoiceQuestion>): Record<string, JevChoiceAnswer> {
  const out: Record<string, JevChoiceAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const prefix = id.slice(0, 2);
    const choice =
      prefix === 'o_'
        ? 'no'
        : prefix === 's_' || prefix === 'd_' || prefix === 'a_'
          ? 'none'
          : prefix === 'n_'
            ? 'keep_new'
            : Object.keys(q.criteria)[0];
    out[id] = { choice, confidence: 0.95, probabilities: {} };
  }
  return out;
}

function okAsk(returnedModel = 'jev-1.13.0') {
  return async (_state: unknown, questions: Record<string, JevChoiceQuestion>, opts: { model: string }) => ({
    answers: answerAll(questions),
    requestedModel: opts.model,
    returnedModel,
    inputTokens: 1234,
    requests: 2,
    wallMs: 5,
  });
}

function snapshot(over: Partial<JevShadowSnapshot> = {}): JevShadowSnapshot {
  return {
    sessionId: 'sess-1',
    today: '2026-10-08',
    memoryMd: '## Decisoes ativas\nDecisao antiga [2026-01-01]\n\n## Workarounds e bugs conhecidos\nBug B\n',
    userMd: '# Sobre o Usuario\n\n## Preferencias\n- Prefere X [2026-02-02]\n',
    candidates: [
      { kind: 'add', text: 'Decisao nova' },
      { kind: 'add', text: 'estado efemero' },
      { kind: 'remove', text: 'Decisao antiga [2026-01-01]' },
    ],
    userCandidates: [{ action: 'add', section: 'preferencias', fact: 'Prefere Y' }],
    conversationText: 'conversa '.repeat(100),
    gateModelLabel: 'lion-sdk/lmstudio/qwen',
    ...over,
  };
}

function gateOk(over: Partial<DreamingGateResult> = {}): JevShadowGateInfo {
  return {
    result: {
      apply: { add: [{ section: 'decisoes_ativas', text: 'Decisao nova' }], remove: [], userAdd: [], userRemove: [] },
      quarantine: [],
      discarded: [{ text: 'estado efemero', reason: 'efemero' }],
      report: '',
      failSafeTriggered: false,
      ...over,
    },
    userAccounting: [{ candidateId: 'c1', destination: 'userAdd' }],
    gateReportFile: '2026-10-08_000000_x_compaction-dreaming-report.md',
  };
}

function reportsDir(): string {
  return path.join(state.home, 'workspaces', 'lionclaw', 'dreaming-reports');
}

function listReports(): string[] {
  return fs.existsSync(reportsDir()) ? fs.readdirSync(reportsDir()) : [];
}

function readJsonl(): JevShadowRecord[] {
  const file = path.join(reportsDir(), JEV_SHADOW_JSONL_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JevShadowRecord);
}

function active(): void {
  state.settings.set('jev_shadow_enabled', 'true');
  state.settings.set('jev_model', 'jev-1.13.0');
  state.secret = { status: 'found', value: KEY };
}

const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

beforeEach(async () => {
  vi.clearAllMocks();
  state.home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jev-shadow-'));
  state.settings = new Map();
  state.secret = { status: 'absent' };
  state.logs = [];
  askMock.mockImplementation(okAsk());
});

afterEach(async () => {
  await fs.promises.rm(state.home, { recursive: true, force: true });
});

describe('runJevShadowSafe: estados (secao 7)', () => {
  it('inativa com a flag desligada: nenhum request, nenhum arquivo, Vault nao consultado', async () => {
    state.settings.set('jev_shadow_enabled', 'false');
    state.secret = { status: 'found', value: KEY };
    await runJevShadowSafe(snapshot(), gateOk());
    expect(askMock).not.toHaveBeenCalled();
    expect(getSecretNonInteractive).not.toHaveBeenCalled();
    expect(listReports()).toEqual([]);
  });

  it('inativa com a flag ligada e sem chave: nenhum request, nenhum arquivo', async () => {
    state.settings.set('jev_shadow_enabled', 'true');
    await runJevShadowSafe(snapshot(), gateOk());
    expect(askMock).not.toHaveBeenCalled();
    expect(listReports()).toEqual([]);
  });

  it('chave em branco no Vault conta como ausente', async () => {
    state.settings.set('jev_shadow_enabled', 'true');
    state.secret = { status: 'found', value: '   ' };
    await runJevShadowSafe(snapshot(), gateOk());
    expect(askMock).not.toHaveBeenCalled();
    expect(listReports()).toEqual([]);
  });

  it('erro ao ler a chave vira failed (config) so no jsonl, sem relatorio', async () => {
    state.settings.set('jev_shadow_enabled', 'true');
    state.secret = { status: 'error', code: 'VAULT-CORRUPT', reason: 'arquivo corrompido' };
    await runJevShadowSafe(snapshot(), gateOk());
    const records = readJsonl();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].failure).toEqual({ reason: 'config', message: expect.stringContaining('arquivo corrompido') });
    expect(listReports()).toEqual([JEV_SHADOW_JSONL_FILE]);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rascunho vazio vira skipped (empty) sem request', async () => {
    active();
    await runJevShadowSafe(snapshot({ memoryMd: '', userMd: '', candidates: [], userCandidates: [] }), gateOk());
    const records = readJsonl();
    expect(records[0]).toMatchObject({ status: 'skipped', skipReason: 'empty' });
    expect(listReports()).toEqual([JEV_SHADOW_JSONL_FILE]);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rascunho acima de 150 linhas vira skipped (too_many_lines) sem request', async () => {
    active();
    const memoryMd = `## Workarounds e bugs conhecidos\n${Array.from({ length: 151 }, (_, i) => `linha ${i}`).join('\n')}\n`;
    await runJevShadowSafe(snapshot({ memoryMd }), gateOk());
    expect(readJsonl()[0]).toMatchObject({ status: 'skipped', skipReason: 'too_many_lines' });
    expect(askMock).not.toHaveBeenCalled();
  });

  it('falha do Jev vira failed com o motivo, so no jsonl', async () => {
    active();
    askMock.mockRejectedValueOnce(new JevError('http', 'Jev respondeu HTTP 503'));
    await runJevShadowSafe(snapshot(), gateOk());
    const records = readJsonl();
    expect(records[0]).toMatchObject({
      status: 'failed',
      failure: { reason: 'http', message: 'Jev respondeu HTTP 503' },
    });
    expect(records[0].plan).toBeNull();
    expect(listReports()).toEqual([JEV_SHADOW_JSONL_FILE]);
  });

  it('erro inesperado vira failed (unknown) e nunca rejeita', async () => {
    active();
    askMock.mockRejectedValueOnce(new TypeError('quebrou'));
    await expect(runJevShadowSafe(snapshot(), gateOk())).resolves.toBeUndefined();
    expect(readJsonl()[0]).toMatchObject({ status: 'failed', failure: { reason: 'unknown', message: 'quebrou' } });
  });

  it('sucesso grava relatorio .md e linha no jsonl com todos os campos', async () => {
    active();
    const snap = snapshot();
    await runJevShadowSafe(snap, gateOk());
    const files = listReports();
    const md = files.find((f) => f.endsWith('_jev-shadow-report.md'));
    expect(md).toBeDefined();
    const [record] = readJsonl();
    expect(md).toContain(record.runId);
    expect(record).toMatchObject({
      schemaVersion: 1,
      questionsVersion: 1,
      compositionVersion: 1,
      status: 'success',
      gateReportFile: '2026-10-08_000000_x_compaction-dreaming-report.md',
      sessionId: 'sess-1',
      today: '2026-10-08',
      thresholds: JEV_SHADOW_DEFAULT_THRESHOLDS,
      jevModelRequested: 'jev-1.13.0',
      jevModelReturned: 'jev-1.13.0',
      gateModelLabel: 'lion-sdk/lmstudio/qwen',
      gateFailSafe: false,
      conversationCharsSent: snap.conversationText.length,
      contextRetry: false,
      inputTokens: 1234,
      requests: 2,
    });
    expect(record.lines.map((l) => l.id)).toEqual(['M1', 'M2', 'U1']);
    expect(record.newFacts.map((f) => `${f.id}:${f.file}`)).toEqual(['N1:memory', 'N2:memory', 'N3:user']);
    expect(record.ignoredRemovals).toEqual([{ file: 'memory', text: 'Decisao antiga [2026-01-01]', sourceIndex: 2 }]);
    expect(Object.keys(record.answers).length).toBeGreaterThan(0);
    expect(record.plan?.newFacts.N1.dest).toBe('entra');
    expect(record.gate.map((g) => `${g.file}:${g.sourceIndex}:${g.dest}:${g.match}`)).toEqual([
      'memory:0:apply:exact',
      'memory:1:descarta:exact',
      'memory:2:null:sem_rastro',
      'user:0:apply:accounting',
    ]);
    expect(record.counts).toMatchObject({
      compared: 3,
      agree: 2,
      disagree: 1,
      gateAppliedJevDiscards: 0,
      semRastro: 0,
    });

    const mdText = fs.readFileSync(path.join(reportsDir(), md as string), 'utf-8');
    expect(mdText).toContain('Decisao nova');
    expect(mdText).toContain('Concordancias: 2');
    expect(mdText).not.toContain(KEY);
    expect(JSON.stringify(record)).not.toContain(KEY);
    expect(JSON.stringify(state.logs)).not.toContain(KEY);
  });

  it('A7: recompor a partir da linha do jsonl reproduz o plano gravado', async () => {
    active();
    await runJevShadowSafe(snapshot(), gateOk());
    const [record] = readJsonl();
    expect(recomposeShadowPlan(record)).toEqual(record.plan);
    expect(
      composeShadowPlan(
        { lines: record.lines, newFacts: record.newFacts },
        record.answers,
        record.today,
        record.thresholds,
      ),
    ).toEqual(record.plan);
  });

  it('gate em fail-safe: todos os candidatos com forma failsafe e contagens zeradas', async () => {
    active();
    await runJevShadowSafe(snapshot(), gateOk({ failSafeTriggered: true, failSafeReason: 'timeout' }));
    const [record] = readJsonl();
    expect(record.gateFailSafe).toBe(true);
    expect(record.gate.every((g) => g.match === 'failsafe' && g.dest === 'quarentena')).toBe(true);
    expect(record.counts).toMatchObject({ compared: 0, semRastro: 0 });
  });

  it('varias execucoes acumulam linhas no mesmo jsonl', async () => {
    active();
    await runJevShadowSafe(snapshot(), gateOk());
    await runJevShadowSafe(snapshot(), gateOk());
    expect(readJsonl()).toHaveLength(2);
    expect(listReports().filter((f) => f.endsWith('.md'))).toHaveLength(2);
  });
});

describe('runJevShadowSafe: contrato de nao-interferencia (S2, S14)', () => {
  it('le flag, modelo e chave uma unica vez por execucao', async () => {
    active();
    await runJevShadowSafe(snapshot(), gateOk());
    const flagReads = vi.mocked(getSetting).mock.calls.filter(([k]) => k === 'jev_shadow_enabled');
    const modelReads = vi.mocked(getSetting).mock.calls.filter(([k]) => k === 'jev_model');
    expect(flagReads).toHaveLength(1);
    expect(modelReads).toHaveLength(1);
    expect(getSecretNonInteractive).toHaveBeenCalledTimes(1);
  });

  it('cede o controle antes de ler qualquer configuracao', async () => {
    active();
    const pending = runJevShadowSafe(snapshot(), gateOk());
    expect(getSetting).not.toHaveBeenCalled();
    expect(getSecretNonInteractive).not.toHaveBeenCalled();
    await flush();
    expect(getSetting).toHaveBeenCalledWith('jev_shadow_enabled');
    await pending;
  });

  it('nao usa escrita sincrona em disco', async () => {
    active();
    const writeSync = vi.spyOn(fs, 'writeFileSync');
    const appendSync = vi.spyOn(fs, 'appendFileSync');
    try {
      await runJevShadowSafe(snapshot(), gateOk());
      expect(listReports().length).toBe(2);
      expect(writeSync).not.toHaveBeenCalled();
      expect(appendSync).not.toHaveBeenCalled();
    } finally {
      writeSync.mockRestore();
      appendSync.mockRestore();
    }
  });

  it('falha ao gravar o registro vira so log e nao rejeita', async () => {
    active();
    const blocker = path.join(state.home, 'workspaces');
    fs.mkdirSync(state.home, { recursive: true });
    fs.writeFileSync(blocker, 'arquivo no lugar da pasta');
    await expect(runJevShadowSafe(snapshot(), gateOk())).resolves.toBeUndefined();
    expect(state.logs.some((args) => JSON.stringify(args).includes('falha ao gravar registro'))).toBe(true);
  });
});

describe('runJevShadow: prazo total e fallback de contexto (S8)', () => {
  const deps = () => ({
    ...__jevShadowInternals.defaultDeps,
    yieldFirst: false,
    readFlag: () => true,
    readApiKey: async () => ({ status: 'found' as const, value: KEY }),
    readModel: () => 'jev-1.13.0',
    ask: askMock,
    reportsDir,
  });

  it('max_tokens_exceeded recomeca uma vez com 30.000 caracteres, no mesmo prazo, sem misturar respostas', async () => {
    const calls: Array<{ conversation: string; signal: AbortSignal }> = [];
    askMock
      .mockImplementationOnce(async (st, _q, opts) => {
        calls.push({ conversation: (st as { conversation: string }).conversation, signal: opts.signal });
        throw new JevError('context', 'max_tokens_exceeded');
      })
      .mockImplementationOnce(async (st, questions, opts) => {
        calls.push({ conversation: (st as { conversation: string }).conversation, signal: opts.signal });
        return { ...(await okAsk('jev-1.13.0-segunda')(st, questions, opts)) };
      });
    const snap = snapshot({ conversationText: 'x'.repeat(70_000) });
    await runJevShadow(snap, gateOk(), deps());
    expect(calls).toHaveLength(2);
    expect(calls[0].conversation.length).toBe(60_000);
    expect(calls[1].conversation.length).toBe(30_000);
    expect(calls[0].signal).toBe(calls[1].signal);
    const [record] = readJsonl();
    expect(record).toMatchObject({
      status: 'success',
      contextRetry: true,
      conversationCharsSent: 30_000,
      jevModelReturned: 'jev-1.13.0-segunda',
    });
  });

  it('segunda falha de contexto nao gera terceira tentativa e vira failed (context)', async () => {
    askMock.mockRejectedValue(new JevError('context', 'max_tokens_exceeded'));
    await runJevShadow(snapshot(), gateOk(), deps());
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(readJsonl()[0]).toMatchObject({ status: 'failed', failure: { reason: 'context' } });
  });

  it('o prazo total de 30 s e unico: a segunda tentativa e abortada pelo mesmo relogio', async () => {
    const signals: AbortSignal[] = [];
    askMock
      .mockImplementationOnce(async (_s, _q, opts) => {
        signals.push(opts.signal);
        await new Promise((r) => setTimeout(r, 20));
        throw new JevError('context', 'max_tokens_exceeded');
      })
      .mockImplementationOnce(
        (_s, _q, opts) =>
          new Promise((_, reject) => {
            signals.push(opts.signal);
            opts.signal.addEventListener(
              'abort',
              () => reject(new JevError('timeout', 'prazo total da execucao esgotado')),
              { once: true },
            );
          }),
      );
    const d = deps();
    const startedAt = Date.now();
    await runJevShadow(snapshot(), gateOk(), { ...d, limits: { ...d.limits, deadlineMs: 80 } });
    const elapsed = Date.now() - startedAt;
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0].aborted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(2_000);
    expect(readJsonl()[0]).toMatchObject({ status: 'failed', failure: { reason: 'timeout' } });
  });

  it('passa os limites da SPEC ao cliente', async () => {
    let seen: { batchSize: number; parallel: number; requestTimeoutMs: number; apiKey: string; model: string } | null =
      null;
    askMock.mockImplementationOnce(async (st, questions, opts) => {
      seen = {
        batchSize: opts.batchSize,
        parallel: opts.parallel,
        requestTimeoutMs: opts.requestTimeoutMs,
        apiKey: opts.apiKey,
        model: opts.model,
      };
      return okAsk()(st, questions, opts);
    });
    await runJevShadow(snapshot(), gateOk(), deps());
    expect(seen).toEqual({ batchSize: 12, parallel: 6, requestTimeoutMs: 15_000, apiKey: KEY, model: 'jev-1.13.0' });
  });
});

describe('runJevShadowSafe: achados do validador da sprint 3', () => {
  it('falha ao gravar o .md nao impede a linha do jsonl', async () => {
    active();
    const writeFile = vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error('disco cheio'));
    try {
      await runJevShadowSafe(snapshot(), gateOk());
      const records = readJsonl();
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('success');
      expect(listReports().filter((f) => f.endsWith('.md'))).toHaveLength(0);
    } finally {
      writeFile.mockRestore();
    }
  });

  it('fato com quebra de linha nao quebra a tabela do relatorio', async () => {
    active();
    await runJevShadowSafe(
      snapshot({ candidates: [{ kind: 'add', text: 'linha um\nlinha dois | com barra' }] }),
      gateOk(),
    );
    const md = listReports().find((f) => f.endsWith('.md')) as string;
    const text = fs.readFileSync(path.join(reportsDir(), md), 'utf-8');
    expect(text).toContain('| N1 (memory) linha um linha dois \\| com barra |');
  });

  it('duas execucoes concorrentes gravam duas linhas inteiras no jsonl', async () => {
    active();
    await Promise.all([runJevShadowSafe(snapshot(), gateOk()), runJevShadowSafe(snapshot(), gateOk())]);
    const records = readJsonl();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.runId)).size).toBe(2);
  });
});
