import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { JEV_SYSTEM_ONE_URL } from '../../../../mcp-servers/_shared/jev-transport';
import type { ArchmapJevTriageDeps } from '../engine';
import { readGeneration } from '../generation';
import { jevSourcesDir } from '../pipeline/jev-sources';
import { jevTriageQuestion } from '../pipeline/jev-triage';
import {
  cleanupTemps,
  fileLevelSummaries,
  gitInitCommit,
  makeHarness,
  nodeSummaries,
  runBuild,
  sha256,
  temps,
  type FakeAgentHooks,
  type Harness,
} from './harness';
import { decodeReadableText, makeClusteredRepo, makeTempDir, writeFiles } from './helpers';
import { loadJevSample } from './jev-sample';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../db', () => ({ getSetting: () => undefined }));
vi.mock('../../secrets-vault', () => ({ getSecretNonInteractive: async () => ({ status: 'absent' }) }));

import { askJev } from '../../jev-client';

afterEach(() => cleanupTemps());

type FetchCall = { url: string; body: { model: string; state: Record<string, unknown>; questions: unknown } };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function replayFetch(calls: FetchCall[], byPath: Map<string, string>): typeof fetch {
  const sample = new Map(loadJevSample().map((entry) => [entry.path, entry]));
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as FetchCall['body'];
    calls.push({ url: String(url), body });
    const entry = sample.get(byPath.get(String(body.state.path)) ?? '');
    if (!entry) return jsonResponse(500, { error: `sem resposta gravada para ${String(body.state.path)}` });
    return jsonResponse(200, { model: entry.model, answers: { verdict: entry.answers.verdict }, usage: entry.usage });
  }) as unknown as typeof fetch;
}

function keepFetch(calls: FetchCall[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as FetchCall['body'];
    calls.push({ url: String(url), body });
    return jsonResponse(200, {
      model: 'jev-1.13.0',
      answers: {
        verdict: { choice: 'keep', confidence: 0.97, probabilities: { keep: 0.97, rewrite: 0.02, unknown: 0.01 } },
      },
      usage: { input_tokens: 900 },
    });
  }) as unknown as typeof fetch;
}

function jevDeps(fetchImpl: typeof fetch, over: Partial<ArchmapJevTriageDeps> = {}): Partial<ArchmapJevTriageDeps> {
  return {
    ask: askJev,
    readApiKey: async () => ({ status: 'found', value: 'chave-de-teste' }),
    readModel: () => 'jev-1.13.0',
    fetchImpl,
    requestTimeoutMs: 2_000,
    deadlineMs: 20_000,
    retryDelayMs: () => 0,
    ...over,
  };
}

const TS_BODY = (name: string, value: number): string =>
  `export function ${name}(): number {\n  const x = ${value};\n  return x;\n}\nexport const marker = 'ORIGINAL';\n`;

function benchRepo(): { root: string; byPath: Map<string, string>; mdPaths: string[]; tsPaths: string[] } {
  const root = makeTempDir();
  const files: Record<string, string> = { 'README.md': '# bench\n\nFixture do replay.\n' };
  const byPath = new Map<string, string>();
  const mdPaths: string[] = [];
  const tsPaths: string[] = [];
  loadJevSample().forEach((entry, i) => {
    const stem = `${String(i).padStart(2, '0')}-${basename(entry.path).replace(/[^A-Za-z0-9]+/g, '-')}`;
    if (i % 4 === 0) {
      const path = `docs/${stem}.md`;
      files[path] = `# ${stem}\n\nparagrafo v1 sobre ${entry.path}\n`;
      byPath.set(path, entry.path);
      mdPaths.push(path);
    } else {
      const path = `src/${stem}.ts`;
      files[path] = TS_BODY(`f${i}`, 1);
      byPath.set(path, entry.path);
      tsPaths.push(path);
    }
  });
  writeFiles(root, files);
  return { root, byPath, mdPaths, tsPaths };
}

function changeBench(root: string, mdPaths: string[], tsPaths: string[]): void {
  for (const path of mdPaths) {
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace('paragrafo v1', 'paragrafo v2'));
  }
  for (const path of tsPaths) {
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace('const x = 1', 'const x = 2'));
  }
}

function benchHarness(
  root: string,
  hooks: FakeAgentHooks,
  settings: Record<string, string>,
  deps: Partial<ArchmapJevTriageDeps>,
  realGit = false,
): Harness {
  const base: Record<string, string> = {
    archmap_enabled: 'true',
    archmap_max_parallel_repos: '2',
    archmap_batch_parallelism: '5',
  };
  return makeHarness({ r1: root }, hooks, {
    realGit,
    deps: { jevTriage: deps, getSetting: (key) => ({ ...base, ...settings })[key] },
  });
}

function gzCount(dir: string): number {
  return existsSync(jevSourcesDir(dir)) ? readdirSync(jevSourcesDir(dir)).length : 0;
}

describe('AC-18: com a flag desligada nenhuma chamada ao Jev acontece', () => {
  it('build + update com arquivos sem gramatica e cosmeticos alterados: fetch nunca e chamado, chave nunca lida, relatorio sem Jev', async () => {
    const { root, byPath, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    const calls: FetchCall[] = [];
    const readApiKey = vi.fn(async () => ({ status: 'found' as const, value: 'chave-de-teste' }));
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('rede proibida no teste');
    });
    try {
      const hooks: FakeAgentHooks = { version: 'v1' };
      const h = benchHarness(
        root,
        hooks,
        { archmap_jev_triage_enabled: 'false' },
        jevDeps(replayFetch(calls, byPath), { readApiKey }),
      );
      await runBuild(h, 'r1');
      const gen0 = (await readGeneration(root))!;
      expect(existsSync(jevSourcesDir(gen0.dir))).toBe(false);
      changeBench(root, mdPaths, tsPaths);
      hooks.version = 'v2';
      await runBuild(h, 'r1', 'update');
      const run = h.repository.runs[1]!;
      expect(run.status).toBe('done');
      expect(run.action).toBe('PARTIAL_UPDATE');
      expect(calls).toHaveLength(0);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(readApiKey).not.toHaveBeenCalled();
      expect(run.jevAsked).toBe(0);
      expect(run.jevDispensed).toBe(0);
      expect(run.jevCostUsd).toBe(0);
      expect(run.jevFallbackReason).toBeNull();
      expect(run.warnings.some((w) => w.includes('triagem Jev'))).toBe(false);
      const summaries = fileLevelSummaries((await readGeneration(root))!.graph);
      for (const path of mdPaths) expect(summaries.get(path)?.summary).toContain('Resumo v2');
      for (const path of tsPaths) expect(summaries.get(path)?.summary).toContain('Resumo v1');
      const status = await h.engine.status('r1');
      expect(status.lastRun?.jevAsked).toBeUndefined();
      expect(status.lastRun?.jevFallbackReason).toBeUndefined();
    } finally {
      globalFetch.mockRestore();
    }
  }, 120_000);
});

describe('AC-19: replay do bench com a flag ligada', () => {
  it('keep >= 0.8 dispensado, os demais relidos, relatorio com os numeros; pergunta e state iguais ao bench; conteudo anterior vem do git nos arquivos limpos', async () => {
    const { root, byPath, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    gitInitCommit(root);
    const sample = loadJevSample();
    const verdictOf = (path: string) => sample.find((e) => e.path === byPath.get(path))!.answers.verdict;
    const calls: FetchCall[] = [];
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = benchHarness(
      root,
      hooks,
      { archmap_jev_triage_enabled: 'true' },
      jevDeps(replayFetch(calls, byPath)),
      true,
    );
    await runBuild(h, 'r1');
    const gen0 = (await readGeneration(root))!;
    expect(Object.keys(gen0.fingerprints.files)).toHaveLength(41);
    expect(gzCount(gen0.dir)).toBe(0);
    expect(calls).toHaveLength(0);

    changeBench(root, mdPaths, tsPaths);
    hooks.version = 'v2';
    const analyzed = new Set<string>();
    hooks.onAnalysis = (_batchIndex, req) => {
      const manifest = JSON.parse(decodeReadableText(readFileSync(join(req.cwd, 'manifest.txt'), 'utf8'))) as {
        files: Array<{ path: string }>;
      };
      for (const file of manifest.files) analyzed.add(file.path);
      return null;
    };
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.error).toBeNull();
    expect(run.action).toBe('PARTIAL_UPDATE');
    const all = [...mdPaths, ...tsPaths];
    const kept = all.filter((p) => verdictOf(p).choice === 'keep' && verdictOf(p).confidence >= 0.8);
    const reread = all.filter((p) => !kept.includes(p));
    expect(calls).toHaveLength(40);
    expect(run.jevAsked).toBe(40);
    expect(run.jevDispensed).toBe(kept.length);
    const tokens = sample.reduce((sum, e) => sum + e.usage.input_tokens, 0);
    expect(run.jevCostUsd).toBeCloseTo((tokens / 1e6) * 0.042, 6);
    expect(run.jevFallbackReason).toBeNull();
    expect(run.warnings.some((w) => w.includes(`triagem Jev: dispensou ${kept.length} de 40 arquivo(s) (US$`))).toBe(
      true,
    );
    expect(run.warnings.some((w) => w.includes(`${kept.length} arquivo(s) dispensado(s) pela triagem Jev`))).toBe(true);
    const triageEvents = h.events.filter((e) => e.progress?.phase === 'triage');
    expect(triageEvents.length).toBeGreaterThan(1);
    expect(triageEvents.some((e) => e.progress?.current === 40 && e.progress?.total === 40)).toBe(true);

    for (const call of calls) {
      expect(call.url).toBe(JEV_SYSTEM_ONE_URL);
      expect(call.body.model).toBe('jev-1.13.0');
      expect(call.body.questions).toEqual({ verdict: jevTriageQuestion() });
      const state = call.body.state as {
        path: string;
        old_summary: string;
        old_tags: string[];
        old_complexity: string;
        diff: string;
      };
      expect(Object.keys(state).sort()).toEqual(['diff', 'old_complexity', 'old_summary', 'old_tags', 'path']);
      expect(state.old_summary).toContain(`Resumo v1 de ${state.path}`);
      expect(state.old_tags).toEqual(mdPaths.includes(state.path) ? ['docs', 'teste'] : ['code', 'teste']);
      expect(state.old_complexity).toBe('simple');
      expect(state.diff.startsWith(`--- a/${state.path}\n+++ b/${state.path}\n@@ `)).toBe(true);
      expect(state.diff).toMatch(/\n-.*(paragrafo v1|const x = 1)/);
      expect(state.diff).toMatch(/\n\+.*(paragrafo v2|const x = 2)/);
    }
    expect(new Set(calls.map((c) => String(c.body.state.path))).size).toBe(40);

    const gen1 = (await readGeneration(root))!;
    const summaries = fileLevelSummaries(gen1.graph);
    for (const path of kept) {
      expect(summaries.get(path)?.summary).toContain('Resumo v1');
      expect(gen1.fingerprints.files[path]!.contentHash).toBe(sha256(readFileSync(join(root, path), 'utf8')));
      expect(gen1.fingerprints.files[path]!.contentHash).not.toBe(gen0.fingerprints.files[path]!.contentHash);
      expect((summaries.get(path)!.metadata as { jevKeeps: number }).jevKeeps).toBe(1);
    }
    for (const path of reread) {
      expect(summaries.get(path)?.summary).toContain('Resumo v2');
      expect(summaries.get(path)!.metadata).toBeUndefined();
    }
    for (const path of kept) expect(analyzed.has(path)).toBe(false);
    for (const path of reread) expect(analyzed.has(path)).toBe(true);
    expect(gen1.meta.partial).toBeUndefined();
    const status = await h.engine.status('r1');
    expect(status.status).toBe('ready');
    expect(status.lastRun?.jevAsked).toBe(40);
    expect(status.lastRun?.jevDispensed).toBe(kept.length);
    expect(status.lastRun?.jevCostUsd).toBe(run.jevCostUsd);
    const sources1 = readdirSync(jevSourcesDir(gen1.dir));
    expect(sources1).toHaveLength(40);
    for (const path of all) expect(sources1).toContain(`${gen1.fingerprints.files[path]!.contentHash}.gz`);
    expect(sources1).not.toContain(`${gen1.fingerprints.files['README.md']!.contentHash}.gz`);
    expect(run.warnings.some((w) => w.includes('40 arquivo(s) com conteudo diferente do commit'))).toBe(true);
  }, 180_000);

  it('primeira atualizacao depois de ligar a flag com git: os arquivos limpos vem de git show e ja sao perguntados; nada e gravado para eles', async () => {
    const { root, byPath, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    gitInitCommit(root);
    const calls: FetchCall[] = [];
    const hooks: FakeAgentHooks = { version: 'v1' };
    const settings = { archmap_jev_triage_enabled: 'false' };
    const h = benchHarness(root, hooks, settings, jevDeps(replayFetch(calls, byPath)), true);
    await runBuild(h, 'r1');
    expect(gzCount((await readGeneration(root))!.dir)).toBe(0);
    settings.archmap_jev_triage_enabled = 'true';
    changeBench(root, mdPaths.slice(0, 3), tsPaths.slice(0, 3));
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(calls).toHaveLength(6);
    expect(run.jevAsked).toBe(6);
    expect(run.jevFallbackReason).toBeNull();
    const gen1 = (await readGeneration(root))!;
    expect(gzCount(gen1.dir)).toBe(6);
    expect(run.warnings.some((w) => w.includes('6 arquivo(s) com conteudo diferente do commit'))).toBe(true);
  }, 180_000);

  it('sem blobs no git (git falso): sem conteudo anterior, nada e perguntado na primeira atualizacao e a base e gravada para a proxima', async () => {
    const { root, byPath, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    const calls: FetchCall[] = [];
    const hooks: FakeAgentHooks = { version: 'v1' };
    const settings = { archmap_jev_triage_enabled: 'false' };
    const h = benchHarness(root, hooks, settings, jevDeps(replayFetch(calls, byPath)));
    await runBuild(h, 'r1');
    settings.archmap_jev_triage_enabled = 'true';
    changeBench(root, mdPaths.slice(0, 3), tsPaths.slice(0, 3));
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(calls).toHaveLength(0);
    expect(run.jevAsked).toBe(0);
    expect(run.jevFallbackReason).toBeNull();
    expect(run.warnings.filter((w) => w.includes('triagem Jev')).join(' | ')).toContain(
      '6 sem conteudo anterior gravado',
    );
    const gen1 = (await readGeneration(root))!;
    expect(readdirSync(jevSourcesDir(gen1.dir)).length).toBe(Object.keys(gen1.fingerprints.files).length);
    const summaries = fileLevelSummaries(gen1.graph);
    for (const path of mdPaths.slice(0, 3)) expect(summaries.get(path)?.summary).toContain('Resumo v2');
    for (const path of tsPaths.slice(0, 3)) expect(summaries.get(path)?.summary).toContain('Resumo v1');

    changeBench(root, mdPaths.slice(3, 5), tsPaths.slice(3, 5));
    await runBuild(h, 'r1', 'update');
    expect(calls).toHaveLength(4);
    expect(h.repository.runs[2]!.jevAsked).toBe(4);
  }, 180_000);
});

describe('AC-20: Jev fora do ar com a flag ligada', () => {
  it('fetch rejeita: a atualizacao segue sem triagem, sem erro ao usuario, jev_fallback_reason gravado', async () => {
    const { root, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    let attempts = 0;
    const down = (async () => {
      attempts += 1;
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    const h = benchHarness(root, hooks, { archmap_jev_triage_enabled: 'true' }, jevDeps(down));
    await runBuild(h, 'r1');
    changeBench(root, mdPaths, tsPaths);
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.error).toBeNull();
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(run.jevAsked).toBe(0);
    expect(run.jevDispensed).toBe(0);
    expect(run.jevFallbackReason).toContain('http: falha de rede ao chamar o Jev');
    expect(run.jevFallbackReason).toContain('apos 4 tentativas');
    expect(run.warnings.some((w) => w.startsWith('triagem Jev indisponivel: http: falha de rede'))).toBe(true);
    const summaries = fileLevelSummaries((await readGeneration(root))!.graph);
    for (const path of mdPaths) expect(summaries.get(path)?.summary).toContain('Resumo v2');
    for (const path of tsPaths) expect(summaries.get(path)?.summary).toContain('Resumo v1');
    const status = await h.engine.status('r1');
    expect(status.status).toBe('ready');
    expect(status.error).toBeUndefined();
    expect(status.lastRun?.status).toBe('done');
    expect(status.lastRun?.jevFallbackReason).toContain('falha de rede');
    expect(status.lastRun?.jevAsked).toBeUndefined();
  }, 120_000);

  it('timeout do request: fallback por timeout e a rodada termina normalmente', async () => {
    const { root, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const h = benchHarness(
      root,
      hooks,
      { archmap_jev_triage_enabled: 'true' },
      jevDeps(hanging, { requestTimeoutMs: 50 }),
    );
    await runBuild(h, 'r1');
    changeBench(root, mdPaths.slice(0, 2), tsPaths.slice(0, 2));
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.jevFallbackReason).toContain('timeout');
    expect(run.jevAsked).toBe(0);
  }, 120_000);

  it('chave do Jev ausente no Vault: fallback com motivo, sem chamada', async () => {
    const { root, byPath, mdPaths, tsPaths } = benchRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const calls: FetchCall[] = [];
    const h = benchHarness(
      root,
      hooks,
      { archmap_jev_triage_enabled: 'true' },
      jevDeps(replayFetch(calls, byPath), { readApiKey: async () => ({ status: 'absent' }) }),
    );
    await runBuild(h, 'r1');
    changeBench(root, mdPaths.slice(0, 1), tsPaths.slice(0, 1));
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(calls).toHaveLength(0);
    expect(run.jevFallbackReason).toBe('chave do Jev nao configurada no Vault');
  }, 120_000);
});

describe('nunca pergunta em FULL nem para arquivos novos, hub, manifest ou mudanca de forma', () => {
  it('update FULL confirmado, arquivo novo, package.json, hub e funcao nova: zero chamadas; so o cosmetico e o md antigo sao perguntados', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    writeFiles(root, { 'docs/guia.md': '# guia\n\nv1\n', 'package.json': '{"name":"fixture","version":"1.0.0"}\n' });
    const calls: FetchCall[] = [];
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = benchHarness(root, hooks, { archmap_jev_triage_enabled: 'true' }, jevDeps(keepFetch(calls)));
    await runBuild(h, 'r1');

    writeFileSync(
      join(root, 'src/c2/b.ts'),
      readFileSync(join(root, 'src/c2/b.ts'), 'utf8') + 'export function extra(): number { return 1; }\n',
    );
    writeFiles(root, { 'docs/novo.md': '# novo\n' });
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n');
    writeFileSync(join(root, 'docs/guia.md'), '# guia\n\nv2\n');
    writeFileSync(
      join(root, 'src/c3/d.ts'),
      readFileSync(join(root, 'src/c3/d.ts'), 'utf8').replace('return 3', 'return 3 + 0'),
    );
    writeFileSync(
      join(root, 'src/big/f01.ts'),
      readFileSync(join(root, 'src/big/f01.ts'), 'utf8').replace('return 1', 'return 1 + 0'),
    );
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('ARCHITECTURE_UPDATE');
    expect(calls.map((c) => String(c.body.state.path)).sort()).toEqual(['docs/guia.md', 'src/c3/d.ts']);
    expect(run.jevAsked).toBe(2);
    expect(run.jevDispensed).toBe(2);
    const summaries = fileLevelSummaries((await readGeneration(root))!.graph);
    expect(summaries.get('src/c2/b.ts')?.summary).toContain('Resumo v2');
    expect(summaries.get('docs/novo.md')?.summary).toContain('Resumo v2');
    expect(summaries.get('package.json')?.summary).toContain('Resumo v2');
    expect(summaries.get('docs/guia.md')?.summary).toContain('Resumo v1');
    expect(summaries.get('src/c3/d.ts')?.summary).toContain('Resumo v1');
    expect(summaries.get('src/big/f01.ts')?.summary).toContain('Resumo v1');

    calls.length = 0;
    for (const path of ['src/c1/a.ts', 'src/c1/b.ts']) {
      writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace('return', 'return 0 +'));
    }
    const preview = (await h.engine.estimate('r1', undefined, 'update')).update!;
    expect(preview.action).not.toBe('FULL_UPDATE');
    writeFileSync(
      join(root, 'src/big/f00.ts'),
      'export function f00(): number { return 0; }\nexport function g(): number { return 1; }\n',
    );
    for (let c = 1; c <= 8; c += 1) {
      for (const name of ['a', 'b', 'c', 'd']) {
        const path = `src/c${c}/${name}.ts`;
        writeFileSync(
          join(root, path),
          readFileSync(join(root, path), 'utf8') + `export function z${name}${c}(): number { return 0; }\n`,
        );
      }
    }
    for (let i = 1; i < 40; i += 1) {
      const path = `src/big/f${String(i).padStart(2, '0')}.ts`;
      writeFileSync(
        join(root, path),
        readFileSync(join(root, path), 'utf8') + `export function w${i}(): number { return 0; }\n`,
      );
    }
    const full = (await h.engine.estimate('r1', undefined, 'update')).update!;
    expect(full.action).toBe('FULL_UPDATE');
    hooks.version = 'v3';
    await runBuild(h, 'r1', 'update', true);
    expect(h.repository.runs[2]!.action).toBe('FULL_UPDATE');
    expect(calls).toHaveLength(0);
    expect(h.repository.runs[2]!.jevAsked).toBe(0);
  }, 180_000);
});

describe('S5-V2: SKIP nunca chama o Jev', () => {
  it('so cosmeticos = SKIP com zero chamadas, acao mantida, anotacao do parser e contador de keeps intacto', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const calls: FetchCall[] = [];
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = benchHarness(root, hooks, { archmap_jev_triage_enabled: 'true' }, jevDeps(keepFetch(calls)));
    await runBuild(h, 'r1');
    writeFileSync(
      join(root, 'src/c3/d.ts'),
      readFileSync(join(root, 'src/c3/d.ts'), 'utf8').replace('return 3', 'return 3 + 0'),
    );
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('SKIP');
    expect(calls).toHaveLength(0);
    expect(run.jevAsked).toBe(0);
    expect(run.llmCalls).toBe(0);
    const gen1 = (await readGeneration(root))!;
    const node = fileLevelSummaries(gen1.graph).get('src/c3/d.ts')!;
    expect(node.summary).toContain('Resumo v1');
    expect(node.metadata).toBeUndefined();
    expect(gen1.fingerprints.files['src/c3/d.ts']!.contentHash).toBe(
      sha256(readFileSync(join(root, 'src/c3/d.ts'), 'utf8')),
    );
  }, 120_000);
});

describe('AC-23: arquivo mantido pelo Jev', () => {
  it('nos de funcao e imports vem do snapshot novo, aresta cujo import sumiu e removida, quarta rodada seguida de keep reanalisa', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const calls: FetchCall[] = [];
    const hooks: FakeAgentHooks = {
      version: 'v1',
      edgesFor: (ids) =>
        ids.includes('file:src/c1/b.ts') && ids.includes('file:src/c1/a.ts')
          ? [
              {
                source: 'file:src/c1/b.ts',
                target: 'file:src/c1/a.ts',
                type: 'depends_on',
                description: 'b alimenta a',
              },
              { source: 'file:src/c1/b.ts', target: 'file:src/c1/d.ts', type: 'related', description: 'b usa d' },
            ]
          : [],
    };
    const bump = (round: number) => {
      const header = Array.from({ length: round }, (_, i) => `const pad${i} = ${i};`).join('\n');
      writeFileSync(
        join(root, 'src/c1/b.ts'),
        `${header}${round > 0 ? '\n' : ''}import { d1 } from './d';\nexport function b1(): number { return d1(); }\nexport const marker = 'ORIGINAL';\n`,
      );
    };
    bump(0);
    const h = benchHarness(root, hooks, { archmap_jev_triage_enabled: 'true' }, jevDeps(keepFetch(calls)));
    await runBuild(h, 'r1');
    const gen0 = (await readGeneration(root))!;
    const edgesFrom = (graph: Record<string, unknown>, source: string) =>
      (graph.edges as Array<Record<string, unknown>>).filter(
        (e) => e.source === source && !['imports', 'exports', 'contains'].includes(String(e.type)),
      );
    expect(
      edgesFrom(gen0.graph, 'file:src/c1/b.ts')
        .map((e) => e.target)
        .sort(),
    ).toEqual(['file:src/c1/a.ts', 'file:src/c1/d.ts']);
    const fnNode = (graph: Record<string, unknown>) =>
      (graph.nodes as Array<Record<string, unknown>>).find((n) => n.id === 'function:src/c1/b.ts:b1')!;
    const fileNode = (graph: Record<string, unknown>) =>
      (graph.nodes as Array<Record<string, unknown>>).find((n) => n.id === 'file:src/c1/b.ts')!;
    const range0 = fnNode(gen0.graph).lineRange as [number, number];

    bump(1);
    writeFileSync(
      join(root, 'src/c1/a.ts'),
      "import { c1 } from './c';\nimport { d1 } from './d';\nexport function a1(): number { return c1() + d1(); }\nexport const marker = 'ORIGINAL';\n",
    );
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const run1 = h.repository.runs[1]!;
    expect(run1.status).toBe('done');
    expect(calls.map((c) => String(c.body.state.path))).toEqual(['src/c1/b.ts']);
    expect(run1.jevDispensed).toBe(1);
    const gen1 = (await readGeneration(root))!;
    expect(nodeSummaries(gen1.graph).get('src/c1/b.ts')?.summary).toContain('Resumo v1');
    expect(nodeSummaries(gen1.graph).get('src/c1/a.ts')?.summary).toContain('Resumo v2');
    const range1 = fnNode(gen1.graph).lineRange as [number, number];
    expect(range1[0]).toBe(range0[0] + 1);
    expect(fnNode(gen1.graph).summary).toBe(fnNode(gen0.graph).summary);
    expect(gen1.fingerprints.files['src/c1/b.ts']!.contentHash).toBe(
      sha256(readFileSync(join(root, 'src/c1/b.ts'), 'utf8')),
    );
    const imports1 = (gen1.graph.edges as Array<Record<string, unknown>>).filter(
      (e) => e.type === 'imports' && e.source === 'file:src/c1/a.ts',
    );
    expect(imports1.map((e) => e.target).sort()).toEqual(['file:src/c1/c.ts', 'file:src/c1/d.ts']);
    const semantic1 = edgesFrom(gen1.graph, 'file:src/c1/b.ts');
    expect(semantic1.map((e) => e.target)).toEqual(['file:src/c1/d.ts']);
    expect((semantic1[0]!.metadata as { unverifiedSince: string }).unverifiedSince).toBe(run1.id);
    expect((fileNode(gen1.graph).metadata as { jevKeeps: number }).jevKeeps).toBe(1);
    expect(run1.warnings.some((w) => w.includes('1 aresta(s) semantica(s) removida(s)'))).toBe(true);

    const touchOther = (round: number) =>
      writeFileSync(
        join(root, 'src/c2/b.ts'),
        readFileSync(join(root, 'src/c2/b.ts'), 'utf8') +
          `export function extra${round}(): number { return ${round}; }\n`,
      );

    for (const round of [2, 3]) {
      calls.length = 0;
      bump(round);
      touchOther(round);
      await runBuild(h, 'r1', 'update');
      const run = h.repository.runs[round]!;
      expect(run.action).toBe('PARTIAL_UPDATE');
      expect(run.jevAsked).toBe(1);
      expect(run.jevDispensed).toBe(1);
      const gen = (await readGeneration(root))!;
      expect((fileNode(gen.graph).metadata as { jevKeeps: number }).jevKeeps).toBe(round);
      expect(nodeSummaries(gen.graph).get('src/c1/b.ts')?.summary).toContain('Resumo v1');
    }

    calls.length = 0;
    bump(4);
    touchOther(4);
    hooks.version = 'v4';
    await runBuild(h, 'r1', 'update');
    const run4 = h.repository.runs[4]!;
    expect(run4.status).toBe('done');
    expect(run4.action).toBe('PARTIAL_UPDATE');
    expect(calls).toHaveLength(0);
    expect(run4.jevAsked).toBe(0);
    expect(run4.warnings.some((w) => w.includes('1 relido(s) pelo teto de 3 keeps seguidos'))).toBe(true);
    const gen4 = (await readGeneration(root))!;
    expect(nodeSummaries(gen4.graph).get('src/c1/b.ts')?.summary).toContain('Resumo v4');
    expect(fileNode(gen4.graph).metadata).toBeUndefined();

    calls.length = 0;
    bump(5);
    touchOther(5);
    await runBuild(h, 'r1', 'update');
    expect(h.repository.runs[5]!.jevAsked).toBe(1);
    expect(h.repository.runs[5]!.jevDispensed).toBe(1);
    expect((fileNode((await readGeneration(root))!.graph).metadata as { jevKeeps: number }).jevKeeps).toBe(1);
  }, 240_000);
});
