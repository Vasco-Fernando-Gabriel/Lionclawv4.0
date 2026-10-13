import { describe, expect, it, vi } from 'vitest';
import { JevError } from '../../../../mcp-servers/_shared/jev-transport';
import type { askJev } from '../../jev-client';
import type { FileFingerprint } from '../core';
import { ArchmapCancelledError } from '../errors';
import {
  applyJevTriageToPlan,
  describeJevTriage,
  isRetryableJevError,
  JEV_TRIAGE_DIFF_MAX_CHARS,
  JEV_TRIAGE_MAX_KEEPS,
  JEV_TRIAGE_RETRY_ATTEMPTS,
  jevCostUsd,
  jevKeepsOf,
  jevTriageCandidates,
  jevTriageQuestion,
  jevTriageRetryDelayMs,
  jevTriageTags,
  runJevTriage,
  type JevTriageCandidate,
  type JevTriageDeps,
} from '../pipeline/jev-triage';
import { diffLines, unifiedDiff } from '../pipeline/unified-diff';
import { sha256 } from './harness';
import { loadJevSample, type JevSampleEntry } from './jev-sample';

type SampleEntry = JevSampleEntry;

function fp(path: string, content: string, structural: boolean): FileFingerprint {
  return {
    filePath: path,
    contentHash: sha256(content),
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    totalLines: content.split('\n').length,
    hasStructuralAnalysis: structural,
  };
}

function fileNode(path: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `file:${path}`,
    type: 'file',
    name: path,
    filePath: path,
    summary: `Resumo antigo de ${path}`,
    tags: ['teste'],
    complexity: 'simple',
    ...over,
  };
}

function plan(over: Partial<Parameters<typeof jevTriageCandidates>[0]['plan']> = {}) {
  return {
    action: 'PARTIAL_UPDATE' as const,
    cosmeticPaths: [] as string[],
    nonStructuralPaths: [] as string[],
    manifestFiles: [] as string[],
    hubFiles: [] as string[],
    ...over,
  };
}

function candidate(path: string, kind: 'cosmetic' | 'no_grammar', keeps = 0): JevTriageCandidate {
  return {
    path,
    kind,
    oldSummary: `Resumo antigo de ${path}`,
    oldTags: ['teste'],
    oldComplexity: 'simple',
    oldHash: sha256(`old ${path}\n`),
    keeps,
  };
}

function replayAsk(sample: SampleEntry[], seen: Array<{ state: unknown; questions: unknown }> = []): typeof askJev {
  const byPath = new Map(sample.map((entry) => [entry.path, entry]));
  return async (state, questions, opts) => {
    seen.push({ state, questions });
    if (opts.signal.aborted) throw new JevError('timeout', 'prazo total da execucao esgotado');
    const entry = byPath.get((state as { path: string }).path);
    if (!entry) throw new JevError('schema', `sem resposta gravada para ${(state as { path: string }).path}`);
    return {
      answers: { verdict: entry.answers.verdict },
      requestedModel: opts.model,
      returnedModel: entry.model,
      inputTokens: entry.usage.input_tokens,
      requests: 1,
      wallMs: 1,
    };
  };
}

function deps(ask: typeof askJev, over: Partial<JevTriageDeps> = {}): JevTriageDeps {
  return {
    ask,
    apiKey: 'chave-de-teste',
    model: 'jev-1.13.0',
    threshold: 0.8,
    signal: new AbortController().signal,
    readOldContent: async (path) => `old ${path}\n`,
    readNewContent: async (path) => `new ${path}\n`,
    retryDelayMs: () => 0,
    ...over,
  };
}

describe('pergunta da triagem Jev: criterios literais do bench (archmap-bench.mjs, jevChanges)', () => {
  it('e um Choice keep | rewrite | unknown com as instrucoes e os criterios do bench', () => {
    expect(jevTriageQuestion()).toEqual({
      type: 'choice',
      instructions:
        'Decide whether the architecture map entry for this file (old_summary, old_tags, old_complexity) must be re-interpreted by an LLM because of state.diff.',
      criteria: {
        keep: 'the change is cosmetic, a refactor with same responsibility, a small fix, renamed internals, formatting, comments, or minor additions that do not alter what the file is for',
        rewrite:
          'the change adds, removes or alters a responsibility, public API, integration, data flow or complexity in a way the summary or tags should reflect',
        unknown: 'the diff is too truncated or ambiguous to decide',
      },
    });
  });
});

describe('candidatos da triagem (SPEC 7.5): quem nunca e perguntado', () => {
  const oldA = 'export function a(): number {\n  const x = 1;\n  return x;\n}\n';
  const newA = 'export function a(): number {\n  const x = 2;\n  return x;\n}\n';
  const base = {
    previousNodes: [fileNode('src/a.ts'), fileNode('docs/guia.md'), fileNode('config/app.json')],
    previousFingerprints: {
      'src/a.ts': fp('src/a.ts', oldA, true),
      'docs/guia.md': fp('docs/guia.md', '# v1\n', false),
      'config/app.json': fp('config/app.json', '{"a":1}\n', false),
    },
    currentFingerprints: {
      'src/a.ts': fp('src/a.ts', newA, true),
      'docs/guia.md': fp('docs/guia.md', '# v2\n', false),
      'config/app.json': fp('config/app.json', '{"a":2}\n', false),
    },
  };

  it('PARTIAL e ARCHITECTURE aceitam cosmeticos (mudanca so de corpo) e sem gramatica; FULL e SKIP nunca', () => {
    const partial = jevTriageCandidates({
      ...base,
      plan: plan({ cosmeticPaths: ['src/a.ts'], nonStructuralPaths: ['docs/guia.md', 'config/app.json'] }),
    });
    expect(partial.map((c) => [c.path, c.kind])).toEqual([
      ['config/app.json', 'no_grammar'],
      ['docs/guia.md', 'no_grammar'],
      ['src/a.ts', 'cosmetic'],
    ]);
    expect(partial[2]).toMatchObject({
      oldSummary: 'Resumo antigo de src/a.ts',
      oldTags: ['teste'],
      oldComplexity: 'simple',
      oldHash: sha256(oldA),
      keeps: 0,
    });
    const architecture = jevTriageCandidates({
      ...base,
      plan: plan({ action: 'ARCHITECTURE_UPDATE', cosmeticPaths: ['src/a.ts'] }),
    });
    expect(architecture).toHaveLength(1);
    expect(
      jevTriageCandidates({
        ...base,
        plan: plan({ action: 'FULL_UPDATE', cosmeticPaths: ['src/a.ts'], nonStructuralPaths: ['docs/guia.md'] }),
      }),
    ).toEqual([]);
    expect(
      jevTriageCandidates({
        ...base,
        plan: plan({ action: 'SKIP', cosmeticPaths: ['src/a.ts'], nonStructuralPaths: ['docs/guia.md'] }),
      }),
    ).toEqual([]);
  });

  it('S5-V3/S5-R1: old_tags vai como no bench: sem parser, semantic e exported, mantendo a categoria do arquivo', () => {
    const tags = ['parser', 'code', 'semantic', 'exported', 'auth', 'config'];
    expect(jevTriageTags(tags)).toEqual(['code', 'auth', 'config']);
    expect(jevTriageTags(['test', 'parser'])).toEqual(['test']);
    expect(jevTriageTags(undefined)).toEqual([]);
    const [c] = jevTriageCandidates({
      ...base,
      previousNodes: [fileNode('docs/guia.md', { tags: ['parser', 'document', 'semantic', 'guia'] })],
      plan: plan({ nonStructuralPaths: ['docs/guia.md'] }),
    });
    expect(c?.oldTags).toEqual(['document', 'guia']);
  });

  it('manifest, hub, novo, pendente, sem resumo e mudanca de forma ficam fora', () => {
    const structural = {
      ...base,
      currentFingerprints: {
        ...base.currentFingerprints,
        'src/a.ts': {
          ...fp('src/a.ts', newA, true),
          functions: [{ name: 'b', params: [], exported: true, lineCount: 1 }],
        },
      },
    };
    expect(
      jevTriageCandidates({
        ...structural,
        plan: plan({ nonStructuralPaths: ['config/app.json', 'docs/guia.md'], manifestFiles: ['config/app.json'] }),
      }).map((c) => c.path),
    ).toEqual(['docs/guia.md']);
    expect(
      jevTriageCandidates({
        ...base,
        plan: plan({ nonStructuralPaths: ['docs/guia.md'], hubFiles: ['docs/guia.md'] }),
      }),
    ).toEqual([]);
    expect(
      jevTriageCandidates({
        ...base,
        plan: plan({ cosmeticPaths: ['src/a.ts'] }),
        hubPaths: ['src/a.ts'],
      }),
    ).toEqual([]);
    expect(
      jevTriageCandidates({
        ...base,
        previousNodes: [fileNode('docs/guia.md', { tags: ['pending'] })],
        plan: plan({ nonStructuralPaths: ['docs/guia.md'] }),
      }),
    ).toEqual([]);
    expect(
      jevTriageCandidates({
        ...base,
        previousNodes: [fileNode('docs/guia.md', { summary: '   ' })],
        plan: plan({ nonStructuralPaths: ['docs/guia.md'] }),
      }),
    ).toEqual([]);
    expect(
      jevTriageCandidates({
        ...base,
        previousFingerprints: {},
        plan: plan({ nonStructuralPaths: ['docs/guia.md'], cosmeticPaths: ['src/a.ts'] }),
      }),
    ).toEqual([]);
    expect(
      jevTriageCandidates({
        ...base,
        plan: plan({ nonStructuralPaths: ['src/novo.ts', 'docs/guia.md'] }),
      }).map((c) => c.path),
    ).toEqual(['docs/guia.md']);
    expect(
      jevTriageCandidates({
        ...base,
        plan: plan({ nonStructuralPaths: ['src/a.ts'], cosmeticPaths: ['docs/guia.md'] }),
      }),
    ).toEqual([]);
  });

  it('le o contador de keeps seguidos de metadata.jevKeeps do no de arquivo', () => {
    expect(jevKeepsOf(fileNode('x', { metadata: { jevKeeps: 2 } }))).toBe(2);
    expect(jevKeepsOf(fileNode('x', { metadata: { jevKeeps: '2' } }))).toBe(0);
    expect(jevKeepsOf(fileNode('x'))).toBe(0);
    expect(jevKeepsOf(undefined)).toBe(0);
    const [c] = jevTriageCandidates({
      ...base,
      previousNodes: [fileNode('docs/guia.md', { metadata: { jevKeeps: 3 } })],
      plan: plan({ nonStructuralPaths: ['docs/guia.md'] }),
    });
    expect(c?.keeps).toBe(3);
  });
});

const sample = loadJevSample();

describe('AC-19: replay do bench com o Jev mockado (40 respostas gravadas)', () => {
  const expectedKeeps = sample.filter(
    (e) => e.answers.verdict.choice === 'keep' && e.answers.verdict.confidence >= 0.8,
  );

  it('a amostra cobre keep >= 0.8, keep < 0.8, rewrite e unknown', () => {
    expect(sample).toHaveLength(40);
    const counts = { keepHigh: 0, keepLow: 0, rewrite: 0, unknown: 0 };
    for (const entry of sample) {
      const v = entry.answers.verdict;
      if (v.choice === 'keep') counts[v.confidence >= 0.8 ? 'keepHigh' : 'keepLow'] += 1;
      else if (v.choice === 'rewrite') counts.rewrite += 1;
      else counts.unknown += 1;
    }
    expect(counts.keepHigh).toBeGreaterThanOrEqual(10);
    expect(counts.keepLow).toBeGreaterThanOrEqual(5);
    expect(counts.rewrite).toBeGreaterThanOrEqual(10);
    expect(counts.unknown).toBeGreaterThanOrEqual(1);
  });

  it('keep com confianca >= 0.8 e dispensado; keep abaixo, rewrite e unknown sao relidos; state e pergunta exatos', async () => {
    const seen: Array<{ state: unknown; questions: unknown }> = [];
    const candidates = sample.map((entry, i) => candidate(entry.path, i % 3 === 0 ? 'no_grammar' : 'cosmetic'));
    const result = await runJevTriage(candidates, deps(replayAsk(sample, seen)));
    expect(result.fallbackReason).toBeNull();
    expect(result.candidates).toBe(40);
    expect(result.asked).toBe(40);
    expect(result.requests).toBe(40);
    expect(result.model).toBe('jev-1.13.0');
    expect(result.dispensed).toEqual(expectedKeeps.map((e) => e.path).sort());
    expect(result.reanalyze).toEqual(
      candidates
        .filter((c) => c.kind === 'cosmetic' && !expectedKeeps.some((e) => e.path === c.path))
        .map((c) => c.path)
        .sort(),
    );
    const tokens = sample.reduce((sum, e) => sum + e.usage.input_tokens, 0);
    expect(result.inputTokens).toBe(tokens);
    expect(result.costUsd).toBe(jevCostUsd(tokens));
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(0.01);
    for (const verdict of result.verdicts) {
      const entry = sample.find((e) => e.path === verdict.path)!;
      expect(verdict.choice).toBe(entry.answers.verdict.choice);
      expect(verdict.confidence).toBe(entry.answers.verdict.confidence);
      const expected =
        entry.answers.verdict.choice === 'keep'
          ? entry.answers.verdict.confidence >= 0.8
            ? 'jev_keep'
            : 'low_confidence'
          : entry.answers.verdict.choice === 'rewrite'
            ? 'jev_rewrite'
            : 'jev_unknown';
      expect(verdict.reason).toBe(expected);
      expect(verdict.decision).toBe(expected === 'jev_keep' ? 'keep' : 'reanalyze');
    }
    expect(seen).toHaveLength(40);
    const first = seen.find((s) => (s.state as { path: string }).path === sample[0]!.path)!;
    expect(first.state).toEqual({
      path: sample[0]!.path,
      old_summary: `Resumo antigo de ${sample[0]!.path}`,
      old_tags: ['teste'],
      old_complexity: 'simple',
      diff: unifiedDiff(`old ${sample[0]!.path}\n`, `new ${sample[0]!.path}\n`, sample[0]!.path),
    });
    expect(first.questions).toEqual({ verdict: jevTriageQuestion() });
    const lines = describeJevTriage(result);
    expect(lines[0]).toContain(
      `triagem Jev: dispensou ${expectedKeeps.length} de 40 arquivo(s) (US$ ${result.costUsd.toFixed(4)}`,
    );
  });

  it('o limiar da setting manda: com 0.5 todo keep passa; com 1 so confianca total', async () => {
    const candidates = sample.map((entry) => candidate(entry.path, 'no_grammar'));
    const low = await runJevTriage(candidates, deps(replayAsk(sample), { threshold: 0.5 }));
    expect(low.dispensed).toEqual(
      sample
        .filter((e) => e.answers.verdict.choice === 'keep' && e.answers.verdict.confidence >= 0.5)
        .map((e) => e.path)
        .sort(),
    );
    expect(low.dispensed.length).toBeGreaterThan(expectedKeeps.length);
    const strict = await runJevTriage(candidates, deps(replayAsk(sample), { threshold: 1 }));
    expect(strict.dispensed).toEqual(
      sample
        .filter((e) => e.answers.verdict.choice === 'keep' && e.answers.verdict.confidence >= 1)
        .map((e) => e.path)
        .sort(),
    );
  });

  it('applyJevTriageToPlan tira os dispensados da releitura e empurra os cosmeticos nao mantidos para o LLM, sem mudar a acao', () => {
    const base = {
      action: 'PARTIAL_UPDATE' as const,
      detail: 'x',
      totalFiles: 5,
      structuralCount: 0,
      structuralRatio: 0,
      threshold: 2,
      filesToReanalyze: 3,
      newFiles: 1,
      deletedFiles: 0,
      cosmeticFiles: 2,
      nonStructuralFiles: 2,
      pendingFiles: 0,
      manifestFiles: [],
      hubFiles: [],
      triggers: [],
      rerunLayers: false,
      rerunTour: false,
      legacy: false,
      filesToReanalyzeList: ['docs/a.md', 'docs/b.md', 'src/novo.ts'],
      deletedPaths: [],
      newPaths: ['src/novo.ts'],
      cosmeticPaths: ['src/c.ts', 'src/d.ts'],
      nonStructuralPaths: ['docs/a.md', 'docs/b.md'],
      pendingPaths: [],
      structuralPaths: [],
      rerunArchitecture: false,
    };
    const adjusted = applyJevTriageToPlan(base, { dispensed: ['docs/a.md', 'src/c.ts'], reanalyze: ['src/d.ts'] });
    expect(adjusted.plan.action).toBe('PARTIAL_UPDATE');
    expect(adjusted.plan.filesToReanalyzeList).toEqual(['docs/b.md', 'src/d.ts', 'src/novo.ts']);
    expect(adjusted.plan.filesToReanalyze).toBe(3);
    expect(adjusted.plan.cosmeticPaths).toEqual(['src/c.ts']);
    expect(adjusted.plan.cosmeticFiles).toBe(1);
    expect([...adjusted.keptPaths].sort()).toEqual(['docs/a.md', 'src/c.ts']);
    expect([...adjusted.jevKeptPaths].sort()).toEqual(['docs/a.md', 'src/c.ts']);
    expect(adjusted.plan.detail).toBe('x');
    const architecture = applyJevTriageToPlan(
      { ...base, action: 'ARCHITECTURE_UPDATE' },
      { dispensed: ['docs/a.md'], reanalyze: [] },
    );
    expect(architecture.plan.action).toBe('ARCHITECTURE_UPDATE');
    expect(architecture.plan.rerunLayers).toBe(false);
  });

  it('S5-V3: o state enviado para um item da amostra e identico ao gravado (path, old_summary, old_tags, old_complexity, diff)', async () => {
    const entry = sample[0]!;
    const lines = entry.state.diff.split('\n');
    const oldText = `${lines[3]!.slice(1)}\n${lines[4]!.slice(1)}\n${lines[5]!.slice(1)}\n${lines[7]!.slice(1)}\n`;
    const newText = `${lines[3]!.slice(1)}\n${lines[4]!.slice(1)}\n${lines[6]!.slice(1)}\n${lines[7]!.slice(1)}\n`;
    const [c] = jevTriageCandidates({
      previousNodes: [
        fileNode(entry.path, {
          summary: entry.state.old_summary,
          tags: ['parser', ...entry.state.old_tags, 'semantic'],
          complexity: entry.state.old_complexity,
        }),
      ],
      previousFingerprints: { [entry.path]: fp(entry.path, oldText, true) },
      currentFingerprints: { [entry.path]: fp(entry.path, newText, true) },
      plan: plan({ cosmeticPaths: [entry.path] }),
    });
    const seen: Array<{ state: unknown; questions: unknown }> = [];
    await runJevTriage([c!], {
      ...deps(replayAsk(sample, seen)),
      readOldContent: async () => oldText,
      readNewContent: async () => newText,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toEqual(entry.state);
    expect(seen[0]!.questions).toEqual({ verdict: jevTriageQuestion() });
  });
});

describe('sem perguntar: teto de keeps, diff acima de 24k, sem conteudo anterior', () => {
  it(`na quarta rodada seguida de keep (jevKeeps = ${JEV_TRIAGE_MAX_KEEPS}) o arquivo e relido sem pergunta`, async () => {
    const ask = vi.fn(replayAsk(loadJevSample()));
    const result = await runJevTriage(
      [candidate('docs/x.md', 'no_grammar', JEV_TRIAGE_MAX_KEEPS), candidate('src/y.ts', 'cosmetic', 2)],
      deps(ask as unknown as typeof askJev, {
        ask: async (state, q, o) => {
          const entry = { ...loadJevSample()[0]!, path: (state as { path: string }).path };
          return replayAsk([entry])(state, q, o);
        },
      }),
    );
    expect(result.verdicts.find((v) => v.path === 'docs/x.md')).toMatchObject({
      decision: 'reanalyze',
      reason: 'keep_cap',
    });
    expect(result.verdicts.find((v) => v.path === 'src/y.ts')).toMatchObject({ decision: 'keep', reason: 'jev_keep' });
    expect(result.asked).toBe(1);
    expect(describeJevTriage(result).join('\n')).toContain('1 relido(s) pelo teto de 3 keeps seguidos');
  });

  it('diff acima de 24k chars = releitura sem pergunta; diff impossivel (muitas edicoes) idem', async () => {
    const ask = vi.fn();
    const big = Array.from({ length: 300 }, (_, i) => `linha ${i} ${'x'.repeat(100)}`).join('\n');
    const result = await runJevTriage([candidate('docs/grande.md', 'no_grammar'), candidate('src/c.ts', 'cosmetic')], {
      ...deps(ask as unknown as typeof askJev),
      readOldContent: async (path) => (path === 'docs/grande.md' ? `${big}\n` : 'a\nb\n'),
      readNewContent: async (path) =>
        path === 'docs/grande.md'
          ? `${big.replace(/linha/g, 'line')}\n`
          : Array.from({ length: 5000 }, (_, i) => `n${i}`).join('\n'),
    });
    expect(ask).not.toHaveBeenCalled();
    expect(result.asked).toBe(0);
    const grande = result.verdicts.find((v) => v.path === 'docs/grande.md')!;
    expect(grande).toMatchObject({ decision: 'reanalyze', reason: 'diff_too_large' });
    expect(grande.diffChars).toBeGreaterThan(JEV_TRIAGE_DIFF_MAX_CHARS);
    expect(result.verdicts.find((v) => v.path === 'src/c.ts')).toMatchObject({
      decision: 'reanalyze',
      reason: 'diff_too_large',
    });
    expect(result.reanalyze).toEqual(['src/c.ts']);
  });

  it('sem conteudo anterior gravado nao pergunta e deixa o comportamento da flag desligada', async () => {
    const ask = vi.fn();
    const result = await runJevTriage([candidate('docs/x.md', 'no_grammar'), candidate('src/y.ts', 'cosmetic')], {
      ...deps(ask as unknown as typeof askJev),
      readOldContent: async () => null,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(result.verdicts.map((v) => [v.path, v.decision, v.reason])).toEqual([
      ['docs/x.md', 'default', 'no_old_content'],
      ['src/y.ts', 'default', 'no_old_content'],
    ]);
    expect(result.dispensed).toEqual([]);
    expect(result.reanalyze).toEqual([]);
    expect(result.fallbackReason).toBeNull();
    expect(describeJevTriage(result).join('\n')).toContain('2 sem conteudo anterior gravado');
  });
});

describe('AC-20 (unidade): falha ou timeout do Jev = fallback integral, sem erro', () => {
  it('S5-V4: 429, 5xx e rede sao repetidos ate 4 vezes com backoff 1,5 s x tentativa; outros erros nao', () => {
    expect(JEV_TRIAGE_RETRY_ATTEMPTS).toBe(4);
    expect([1, 2, 3].map(jevTriageRetryDelayMs)).toEqual([1500, 3000, 4500]);
    expect(isRetryableJevError(new JevError('http', 'Jev respondeu HTTP 429'))).toBe(true);
    expect(isRetryableJevError(new JevError('http', 'Jev respondeu HTTP 503'))).toBe(true);
    expect(isRetryableJevError(new JevError('http', 'falha de rede ao chamar o Jev: fetch failed'))).toBe(true);
    expect(isRetryableJevError(new JevError('http', 'Jev respondeu HTTP 401'))).toBe(false);
    expect(isRetryableJevError(new JevError('schema', 'corpo da resposta do Jev nao e JSON'))).toBe(false);
    expect(isRetryableJevError(new JevError('timeout', 'request ao Jev estourou 20000 ms'))).toBe(false);
    expect(isRetryableJevError(new Error('x'))).toBe(false);
  });

  it('S5-V4: 429 duas vezes e depois sucesso = sem fallback, 3 requests contados', async () => {
    const sample = loadJevSample();
    const delays: number[] = [];
    let attempts = 0;
    const ask: typeof askJev = async (state, q, o) => {
      attempts += 1;
      if (attempts <= 2) throw new JevError('http', 'Jev respondeu HTTP 429');
      return replayAsk(sample)(state, q, o);
    };
    const result = await runJevTriage([candidate(sample[0]!.path, 'no_grammar')], {
      ...deps(ask),
      retryDelayMs: (attempt) => {
        delays.push(attempt);
        return 0;
      },
    });
    expect(result.fallbackReason).toBeNull();
    expect(result.asked).toBe(1);
    expect(result.requests).toBe(3);
    expect(delays).toEqual([1, 2]);
  });

  it('erro HTTP 503 persistente no terceiro arquivo: 4 tentativas, depois fallback integral com as respostas obtidas descartadas e o custo contado', async () => {
    const sample = loadJevSample();
    const attemptsByPath = new Map<string, number>();
    const ask: typeof askJev = async (state, q, o) => {
      const path = (state as { path: string }).path;
      attemptsByPath.set(path, (attemptsByPath.get(path) ?? 0) + 1);
      if (path === sample[2]!.path) throw new JevError('http', 'Jev respondeu HTTP 503');
      return replayAsk(sample)(state, q, o);
    };
    const result = await runJevTriage(
      sample.slice(0, 8).map((e) => candidate(e.path, 'cosmetic')),
      deps(ask, { parallel: 1 }),
    );
    expect(attemptsByPath.get(sample[2]!.path)).toBe(4);
    expect(result.fallbackReason).toBe(
      'http: Jev respondeu HTTP 503 apos 4 tentativas; 2 resposta(s) ja obtida(s) descartada(s)',
    );
    expect(result.asked).toBe(0);
    expect(result.requests).toBe(6);
    expect(result.dispensed).toEqual([]);
    expect(result.reanalyze).toEqual([]);
    expect(result.verdicts.every((v) => v.decision === 'default' && v.reason === 'fallback')).toBe(true);
    expect(result.verdicts).toHaveLength(8);
    expect(result.inputTokens).toBe(sample[0]!.usage.input_tokens + sample[1]!.usage.input_tokens);
    expect(result.costUsd).toBe(jevCostUsd(result.inputTokens));
    expect(describeJevTriage(result)[0]).toBe(
      'triagem Jev indisponivel: http: Jev respondeu HTTP 503 apos 4 tentativas; 2 resposta(s) ja obtida(s) descartada(s); atualizacao segue sem triagem',
    );
  });

  it('erro de schema nao e repetido: fallback na primeira tentativa', async () => {
    let attempts = 0;
    const ask: typeof askJev = async () => {
      attempts += 1;
      throw new JevError('schema', 'escolha fora do conjunto pedido na pergunta verdict');
    };
    const result = await runJevTriage([candidate('docs/x.md', 'no_grammar')], deps(ask));
    expect(attempts).toBe(1);
    expect(result.fallbackReason).toBe('schema: escolha fora do conjunto pedido na pergunta verdict');
  });

  it('prazo total esgotado vira fallback por timeout', async () => {
    const ask: typeof askJev = (_state, _q, o) =>
      new Promise((_resolve, reject) => {
        o.signal.addEventListener('abort', () => reject(new JevError('timeout', 'prazo total da execucao esgotado')));
      });
    const result = await runJevTriage([candidate('docs/x.md', 'no_grammar')], deps(ask, { deadlineMs: 30 }));
    expect(result.fallbackReason).toContain('timeout');
    expect(result.asked).toBe(0);
  });

  it('cancelamento da rodada propaga como ArchmapCancelledError', async () => {
    const controller = new AbortController();
    const ask: typeof askJev = async () => {
      controller.abort();
      throw new JevError('timeout', 'prazo total da execucao esgotado');
    };
    await expect(
      runJevTriage([candidate('docs/x.md', 'no_grammar')], deps(ask, { signal: controller.signal })),
    ).rejects.toBeInstanceOf(ArchmapCancelledError);
  });
});

describe('unifiedDiff: gerado dos conteudos, sem git', () => {
  it('produz cabecalho, hunks com 3 linhas de contexto e reconstrucao exata', () => {
    const oldText = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n') + '\n';
    const newText = oldText.replace('l5\n', 'L5\nextra\n');
    const diff = unifiedDiff(oldText, newText, 'src/x.ts')!;
    expect(diff.split('\n').slice(0, 3)).toEqual(['--- a/src/x.ts', '+++ b/src/x.ts', '@@ -3,7 +3,8 @@']);
    expect(diff).toContain('-l5\n+L5\n+extra\n');
    expect(unifiedDiff('a\n', 'a\n', 'f')).toBe('');
    const ops = diffLines(['a', 'b', 'c'], ['a', 'c', 'd'])!;
    expect(ops.filter((o) => o.kind !== '+').map((o) => o.line)).toEqual(['a', 'b', 'c']);
    expect(ops.filter((o) => o.kind !== '-').map((o) => o.line)).toEqual(['a', 'c', 'd']);
    expect(diffLines(['a', 'b'], ['c', 'd'], 1)).toBeNull();
  });
});
