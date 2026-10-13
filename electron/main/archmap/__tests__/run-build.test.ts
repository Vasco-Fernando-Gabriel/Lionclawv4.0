import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { validateGraph } from '../core/schema';
import { readGeneration } from '../generation';
import { ARCHMAP_AGENT_CACHE_DIR, ARCHMAP_TASK_CACHE_DIR } from '../pipeline/checkpoints';
import { archmapDirPath, readCurrentPointer } from '../state';
import {
  cleanupTemps,
  gitIn,
  makeHarness,
  nodeSummaries,
  phaseOf,
  REPO_ROOT,
  runBuild,
  SELECTION,
  sha256,
  temps,
  type FakeAgentHooks,
  type Harness,
} from './harness';
import { makeClusteredRepo, makeTempDir, writeFiles } from './helpers';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

afterEach(() => cleanupTemps());

describe('AC-6: build completo de um repo pequeno termina ready com grafo valido, camadas e tour', () => {
  it('fixture copiada de mcp-servers/_shared com git real', async () => {
    const root = makeTempDir();
    temps.push(root);
    const shared = join(REPO_ROOT, 'mcp-servers', '_shared');
    const sources = readdirSync(shared).filter((name) => name.endsWith('.ts'));
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const name of sources) copyFileSync(join(shared, name), join(root, 'src', name));
    writeFiles(root, {
      'README.md': '# Fixture AC-6\n\nCopia de mcp-servers/_shared para o teste do mapa.\n',
      'package.json': '{ "name": "fixture-ac6", "version": "1.0.0" }\n',
      '.gitignore': '/.lionclaw/\n',
    });
    const git = gitIn(root);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    const head = git('rev-parse', 'HEAD');

    const h = makeHarness(
      { r1: root },
      { version: 'v1' },
      { realGit: true, settings: { archmap_batch_parallelism: '5' } },
    );
    await runBuild(h, 'r1');

    const run = h.repository.runs[0]!;
    expect(run.status).toBe('done');
    expect(run.runtime).toBe('cloud');
    expect(run.provider).toBe('anthropic');
    expect(run.model).toBe('claude-opus-5-5');
    expect(run.llmCalls).toBe(h.llmCalls.length);
    expect(run.llmCalls).toBeGreaterThanOrEqual(4);
    const status = await h.engine.status('r1');
    expect(status.status).toBe('ready');
    expect(status.indexedCommit).toBe(head);
    expect(status.pendingFiles).toBeUndefined();

    const generation = await readGeneration(root);
    expect(generation).not.toBeNull();
    const validated = validateGraph(generation!.graph);
    expect(validated.success).toBe(true);
    expect(generation!.graph.layers as unknown[]).not.toHaveLength(0);
    expect((generation!.graph.tour as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(generation!.meta.gitCommitHash).toBe(head);
    expect(generation!.meta.partial).toBeUndefined();
    expect(generation!.meta.analyzedFiles).toBe(generation!.scan.files.length);
    const summaries = nodeSummaries(generation!.graph);
    expect(summaries.size).toBe(sources.length);
    for (const [, entry] of summaries) {
      expect(entry.summary).toContain('Resumo v1');
      expect(entry.tags).toContain('semantic');
    }
    expect(Object.keys(generation!.fingerprints.files).sort()).toEqual(
      generation!.scan.files.map((f) => f.path).sort(),
    );

    const phases = h.events.map((event) => event.progress?.phase).filter(Boolean);
    for (const phase of [
      'scan',
      'narrative',
      'extraction',
      'analysis',
      'merge',
      'review',
      'layers',
      'tour',
      'finalize',
    ]) {
      expect(phases).toContain(phase);
    }
    expect(h.events.at(-1)?.run).toEqual({ id: run.id, kind: 'build', status: 'done' });
    expect(h.agent.calls.filter((call) => call.phase === 'review')).toHaveLength(1);
    expect(h.agent.calls.filter((call) => call.phase === 'layers')).toHaveLength(1);
    expect(h.agent.calls.filter((call) => call.phase === 'tour')).toHaveLength(1);

    const cacheDir = join(archmapDirPath(root), ARCHMAP_AGENT_CACHE_DIR);
    expect(readdirSync(cacheDir).some((name) => name.startsWith('batch-'))).toBe(true);
    expect(readdirSync(cacheDir).some((name) => name.startsWith('plan-'))).toBe(true);
    const taskNames = readdirSync(join(archmapDirPath(root), ARCHMAP_TASK_CACHE_DIR));
    for (const phase of ['narrative', 'review', 'layers', 'tour']) {
      expect(taskNames.some((name) => name.startsWith(`${phase}-`))).toBe(true);
    }
    expect(git('status', '--porcelain')).toBe('');
    expect(h.engine.hasActive('r1')).toBe(false);
  }, 60_000);

  it('update sem mapa exige confirmFull (graph_invalid) e com confirmFull roda o caminho de build completo', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const h = makeHarness({ r1: root }, { version: 'v1' }, { settings: { archmap_batch_parallelism: '5' } });
    await expect(h.engine.update('r1', SELECTION)).rejects.toMatchObject({
      code: 'confirm_full',
      details: { action: 'FULL_UPDATE', reason: 'graph_invalid' },
    });
    expect(h.engine.hasActive('r1')).toBe(false);
    await runBuild(h, 'r1', 'update', true);
    const run = h.repository.runs[0]!;
    expect(run.status).toBe('done');
    expect(run.kind).toBe('update');
    expect(run.action).toBe('FULL_UPDATE');
    expect(run.reason).toBe('graph_invalid');
    expect((await h.engine.status('r1')).status).toBe('ready');
    expect(h.agent.calls.filter((call) => call.phase === 'review')).toHaveLength(1);
  }, 60_000);
});

describe('AC-7: lote invalido recebe 2 reparos e vira pendente; a rodada continua', () => {
  it('termina com pendingFiles do lote falho, placeholders do parser e aviso', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const h = makeHarness(
      { r1: root },
      {
        version: 'v1',
        onAnalysis: (batchIndex) => (batchIndex === 2 ? JSON.stringify({ annotations: [], edges: [] }) : null),
      },
    );
    await runBuild(h, 'r1');
    const run = h.repository.runs[0]!;
    expect(run.status).toBe('done');
    expect(h.agent.calls.filter((call) => call.batchIndex === 2)).toHaveLength(3);
    expect(run.warnings.some((w) => w.startsWith('lote 2:') && w.includes('3 tentativa'))).toBe(true);
    const generation = (await readGeneration(root))!;
    expect(generation.meta.partial).toBe(true);
    const pending = generation.meta.pendingFiles!;
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(files.length);
    const summaries = nodeSummaries(generation.graph);
    for (const path of pending) {
      expect(summaries.get(path)?.tags).toContain('pending');
      expect(summaries.get(path)?.summary).not.toContain('Resumo v1');
      expect(generation.fingerprints.files[path]).toBeUndefined();
    }
    for (const path of files.filter((p) => !pending.includes(p))) {
      expect(summaries.get(path)?.summary).toContain('Resumo v1');
      expect(generation.fingerprints.files[path]).toBeDefined();
    }
    expect(run.warnings.some((w) => w.includes(`${pending.length} arquivo(s) pendente(s)`))).toBe(true);
    const status = await h.engine.status('r1');
    expect(status.status).toBe('partial');
    expect(status.pendingFiles).toBe(pending.length);
    expect(h.events.some((event) => event.progress?.failed === 1)).toBe(true);
    expect(h.agent.calls.filter((call) => call.phase === 'layers')).toHaveLength(1);
    expect(h.agent.calls.filter((call) => call.phase === 'tour')).toHaveLength(1);
  }, 60_000);
});

describe('AC-8: arquivo editado durante a rodada nao aborta; anotacao e fingerprint sao do snapshot', () => {
  it('registra meta.changedDuringRun e mantem o hash do snapshot', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const target = 'src/c3/a.ts';
    const original = readFileSync(join(root, target), 'utf8');
    let edited = false;
    const h = makeHarness(
      { r1: root },
      {
        version: 'v1',
        onAnalysis: () => {
          if (!edited) {
            edited = true;
            writeFileSync(join(root, target), original.replace("marker = 'ORIGINAL'", "marker = 'MODIFIED'"), 'utf8');
          }
          return null;
        },
      },
    );
    await runBuild(h, 'r1');
    const run = h.repository.runs[0]!;
    expect(run.status).toBe('done');
    const generation = (await readGeneration(root))!;
    expect(generation.meta.changedDuringRun).toEqual([target]);
    expect(generation.meta.pendingFiles).toBeUndefined();
    expect(generation.fingerprints.files[target]!.contentHash).toBe(sha256(original));
    expect(nodeSummaries(generation.graph).get(target)?.summary).toContain('(ORIGINAL)');
    expect(run.warnings.some((w) => w.includes('mudaram durante a rodada') && w.includes(target))).toBe(true);
    expect(generation.meta.analyzedFiles).toBe(files.length);
  }, 60_000);
});

describe('AC-21 e AC-9: cancelamento publica geracao parcial e a repeticao reaproveita lotes', () => {
  it('cancelado com 0 lotes nao publica nada', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const harness: { current: Harness | null } = { current: null };
    harness.current = makeHarness(
      { r1: root },
      {
        version: 'v1',
        onNarrative: () => {
          harness.current!.engine.cancel('r1');
        },
      },
    );
    const h = harness.current;
    await runBuild(h, 'r1');
    expect(h.repository.runs[0]!.status).toBe('cancelled');
    expect(await readCurrentPointer(root)).toBeNull();
    expect((await h.engine.status('r1')).status).toBe('absent');
  }, 60_000);

  it('3 de 10 lotes concluidos publica parcial; a repeticao reaproveita; importado alterado invalida so quem o consulta', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const state = { version: 'v1', cancelAfter: Infinity, done: 0 };
    const harness: { current: Harness | null } = { current: null };
    const hooks: FakeAgentHooks = {
      get version() {
        return state.version;
      },
      afterAnalysis: () => {
        state.done += 1;
        if (state.done >= state.cancelAfter) harness.current!.engine.cancel('r1');
      },
    };
    harness.current = makeHarness({ r1: root }, hooks);
    const h = harness.current;

    await runBuild(h, 'r1');
    const gen0 = (await readGeneration(root))!;
    expect(h.repository.runs[0]!.status).toBe('done');
    expect(gen0.meta.partial).toBeUndefined();
    const plan = JSON.parse(
      readFileSync(
        join(
          archmapDirPath(root),
          ARCHMAP_AGENT_CACHE_DIR,
          readdirSync(join(archmapDirPath(root), ARCHMAP_AGENT_CACHE_DIR)).find((n) => n.startsWith('plan-'))!,
        ),
        'utf8',
      ),
    ) as { plan: { batches: Array<{ batchIndex: number; files: Array<{ path: string }> }> } };
    expect(plan.plan.batches).toHaveLength(10);
    const batchOf = new Map<number, string[]>(plan.plan.batches.map((b) => [b.batchIndex, b.files.map((f) => f.path)]));
    const oldHashes = Object.fromEntries(Object.entries(gen0.fingerprints.files).map(([p, fp]) => [p, fp.contentHash]));

    for (const path of files) appendFileSync(join(root, path), `export const touched = '${path}';\n`);
    state.version = 'v2';
    state.cancelAfter = 3;
    state.done = 0;
    await runBuild(h, 'r1');
    const run1 = h.repository.runs[1]!;
    expect(run1.status).toBe('cancelled');
    expect(run1.warnings.some((w) => w.includes('rodada cancelada com 3 de 10'))).toBe(true);
    const pointer = (await readCurrentPointer(root))!;
    expect(pointer.generation).toBe(`gen-${run1.id}`);
    expect(pointer.previous).toBe(gen0.pointer.generation);
    const gen1 = (await readGeneration(root))!;
    expect(gen1.meta.partial).toBe(true);
    expect(gen1.meta.layersStale).toBe(true);
    expect(gen1.meta.tourStale).toBe(true);
    expect(gen1.graph.layers).toEqual(gen0.graph.layers);
    const analyzed = h.agent.calls
      .filter((c) => c.phase === 'analysis' && c.cwd.includes(`${sep}analysis${sep}`))
      .slice(-3);
    const doneBatches = new Set(analyzed.map((c) => c.batchIndex!));
    expect(doneBatches.size).toBe(3);
    const donePaths = new Set([...doneBatches].flatMap((index) => batchOf.get(index)!));
    const summaries = nodeSummaries(gen1.graph);
    expect(gen1.meta.pendingFiles!.sort()).toEqual(files.filter((p) => !donePaths.has(p)).sort());
    for (const path of files) {
      const content = readFileSync(join(root, path), 'utf8');
      if (donePaths.has(path)) {
        expect(summaries.get(path)?.summary).toContain('Resumo v2');
        expect(gen1.fingerprints.files[path]!.contentHash).toBe(sha256(content));
      } else {
        expect(summaries.get(path)?.summary).toContain('Resumo v1');
        expect(gen1.fingerprints.files[path]!.contentHash).toBe(oldHashes[path]);
        expect(gen1.fingerprints.files[path]!.contentHash).not.toBe(sha256(content));
      }
    }
    expect(h.agent.calls.filter((c) => c.phase === 'review')).toHaveLength(1);
    expect((await h.engine.status('r1')).status).toBe('partial');

    state.cancelAfter = Infinity;
    state.done = 0;
    const callsBefore = h.agent.calls.length;
    await runBuild(h, 'r1');
    const run2 = h.repository.runs[2]!;
    expect(run2.status).toBe('done');
    expect(run2.warnings).toContain('plano de lotes reaproveitado da tentativa anterior');
    const reusedEvent = [...h.events].reverse().find((e) => e.run?.id === run2.id && e.progress?.phase === 'analysis');
    expect(reusedEvent?.progress?.reused).toBe(3);
    expect(reusedEvent?.progress?.succeeded).toBe(10);
    const run2Calls = h.agent.calls.slice(callsBefore);
    expect(run2Calls.filter((c) => c.phase === 'analysis')).toHaveLength(7);
    expect(run2Calls.filter((c) => c.phase === 'narrative')).toHaveLength(0);
    const gen2 = (await readGeneration(root))!;
    expect(gen2.meta.partial).toBeUndefined();
    for (const path of files) expect(nodeSummaries(gen2.graph).get(path)?.summary).toContain('Resumo v2');
    expect((await h.engine.status('r1')).status).toBe('ready');

    const imported = 'src/big/f35.ts';
    appendFileSync(join(root, imported), 'export const again = 1;\n');
    const consulting = plan.plan.batches
      .filter((b) => b.files.some((f) => f.path === imported) || b.files.some((f) => f.path === 'src/big/f00.ts'))
      .map((b) => b.batchIndex);
    expect(consulting).toHaveLength(2);
    const callsBefore3 = h.agent.calls.length;
    await runBuild(h, 'r1');
    const run3 = h.repository.runs[3]!;
    expect(run3.status).toBe('done');
    const run3Analysis = h.agent.calls.slice(callsBefore3).filter((c) => c.phase === 'analysis');
    expect(run3Analysis.map((c) => c.batchIndex).sort()).toEqual([...consulting].sort());
    const event3 = [...h.events].reverse().find((e) => e.run?.id === run3.id && e.progress?.phase === 'analysis');
    expect(event3?.progress?.reused).toBe(8);
    expect(existsSync(join(archmapDirPath(root), ARCHMAP_AGENT_CACHE_DIR))).toBe(true);
  }, 120_000);
});

describe('S2-V1: cancelar funciona em qualquer fase (RM4)', () => {
  it.each(['layers', 'tour'] as const)(
    'cancelar durante %s aborta a fase, publica a geracao com camadas/tour anteriores e current.json consistente',
    async (phase) => {
      const { root, files } = makeClusteredRepo();
      temps.push(root);
      const harness: { current: Harness | null } = { current: null };
      const seen: string[] = [];
      const hooks: FakeAgentHooks = { version: 'v1' };
      harness.current = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
      const h = harness.current;
      await runBuild(h, 'r1');
      const gen0 = (await readGeneration(root))!;
      expect(h.repository.runs[0]!.status).toBe('done');
      for (const path of files) appendFileSync(join(root, path), 'export const v2 = true;\n');
      hooks.version = 'v2';

      const original = h.agent.executeAgent;
      h.agent.executeAgent = async (req) => {
        const { phase: current } = phaseOf(req.cwd);
        seen.push(current);
        if (current === phase) {
          const outcome = h.engine.cancel('r1');
          expect(outcome).toEqual({ cancelled: true });
          req.abortController.signal.throwIfAborted();
        }
        return original(req);
      };
      await runBuild(h, 'r1');
      const run1 = h.repository.runs[1]!;
      expect(run1.status).toBe('cancelled');
      const pointer = (await readCurrentPointer(root))!;
      expect(pointer.generation).toBe(`gen-${run1.id}`);
      const gen1 = (await readGeneration(root))!;
      expect(gen1.meta.pendingFiles).toBeUndefined();
      expect(gen1.meta.layersStale).toBe(phase === 'layers' ? true : undefined);
      expect(gen1.meta.tourStale).toBe(true);
      expect(gen1.graph.tour).toEqual(gen0.graph.tour);
      if (phase === 'layers') expect(gen1.graph.layers).toEqual(gen0.graph.layers);
      expect(gen1.meta.fallback?.some((f) => f.includes('rodada cancelada'))).toBe(true);
      expect(gen1.meta.analyzedFiles).toBe(files.length);
      expect(seen.filter((p) => p === 'tour')).toHaveLength(phase === 'tour' ? 1 : 0);
      const status = await h.engine.status('r1');
      expect(status.status).toBe('ready');
      expect(status.tourStale).toBe(true);
      expect(status.fallback?.join(' ')).toContain('rodada cancelada');
      expect(status.lastRun?.status).toBe('cancelled');
      expect(status.lastRun?.warnings?.length).toBeGreaterThan(0);
      expect(existsSync(join(archmapDirPath(root), gen0.pointer.generation))).toBe(true);
    },
    60_000,
  );

  it('cancelar durante a revisao de montagem publica sem revisao', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const harness: { current: Harness | null } = { current: null };
    harness.current = makeHarness({ r1: root }, { version: 'v1' }, { settings: { archmap_batch_parallelism: '5' } });
    const h = harness.current;
    const original = h.agent.executeAgent;
    h.agent.executeAgent = async (req) => {
      if (phaseOf(req.cwd).phase === 'review') {
        expect(h.engine.cancel('r1')).toEqual({ cancelled: true });
        req.abortController.signal.throwIfAborted();
      }
      return original(req);
    };
    await runBuild(h, 'r1');
    const run = h.repository.runs[0]!;
    expect(run.status).toBe('cancelled');
    const gen = (await readGeneration(root))!;
    expect(gen.meta.layersStale).toBe(true);
    expect(gen.meta.tourStale).toBe(true);
    expect(run.warnings.some((w) => w.includes('revisao de montagem cancelada'))).toBe(true);
    expect(h.agent.calls.filter((c) => c.phase === 'layers')).toHaveLength(0);
  }, 60_000);

  it('erro de provedor em todos os lotes: rodada em erro, sem reparo, com o codigo nos warnings', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const { TypedProviderError } = await import('../../agent-runtime/llm-error');
    const h = makeHarness({ r1: root }, { version: 'v1' }, { settings: { archmap_batch_parallelism: '5' } });
    const original = h.agent.executeAgent;
    h.agent.executeAgent = async (req) => {
      if (phaseOf(req.cwd).phase === 'analysis') throw new TypedProviderError('LLM-AUTH-401');
      return original(req);
    };
    await runBuild(h, 'r1');
    const run = h.repository.runs[0]!;
    expect(run.status).toBe('error');
    expect(run.error).toContain('Nenhum dos 10');
    expect(h.llmCalls.filter((c) => c.phase === 'analysis')).toHaveLength(10);
    expect(h.llmCalls.every((c) => c.phase !== 'analysis' || (!c.ok && c.error?.includes('LLM-AUTH-401')))).toBe(true);
    expect(run.warnings.some((w) => w.includes('LLM-AUTH-401'))).toBe(true);
    expect(run.warnings.some((w) => w.startsWith('llm lote'))).toBe(true);
    expect(await readCurrentPointer(root)).toBeNull();
    const status = await h.engine.status('r1');
    expect(status.status).toBe('error');
    expect(status.lastRun?.error).toContain('Nenhum dos 10');
  }, 60_000);
});

describe('fila: uma rodada por repositorio e repos em paralelo pela setting', () => {
  it('segunda rodada no mesmo repo e recusada; terceiro repo entra na fila com archmap_max_parallel_repos = 2', async () => {
    const roots = [makeClusteredRepo().root, makeClusteredRepo().root, makeClusteredRepo().root];
    temps.push(...roots);
    const gate: { release: (() => void) | null } = { release: null };
    const blocked = new Promise<void>((resolveGate) => {
      gate.release = resolveGate;
    });
    const h = makeHarness(
      { r1: roots[0]!, r2: roots[1]!, r3: roots[2]! },
      {
        version: 'v1',
        onNarrative: async () => {
          await blocked;
        },
      },
      { settings: { archmap_batch_parallelism: '5' } },
    );
    await h.engine.build('r1', SELECTION);
    await expect(h.engine.build('r1', SELECTION)).rejects.toThrow(/rodada em andamento/);
    await h.engine.build('r2', SELECTION);
    const third = await h.engine.build('r3', SELECTION);
    expect(third.status).toBe('running');
    expect((await h.engine.status('r3')).status).toBe('queued');
    expect((await h.engine.status('r3')).queuePosition).toBe(1);
    expect((await h.engine.status('r1')).status).toBe('building');
    expect(h.engine.cancel('r3')).toEqual({ cancelled: true });
    expect((await h.engine.status('r3')).status).toBe('absent');
    expect(h.repository.runs.find((r) => r.repositoryId === 'r3')).toBeUndefined();
    expect(h.events.at(-1)).toEqual({ repositoryId: 'r3', run: { id: third.id, kind: 'build', status: 'cancelled' } });
    gate.release!();
    await h.engine.waitForJob('r1');
    await h.engine.waitForJob('r2');
    expect(h.repository.runs.filter((r) => r.status === 'done')).toHaveLength(2);
  }, 120_000);
});

describe('archmap:file e archmap:graph', () => {
  it('le so arquivos do grafo dentro do repo e recusa caminhos fora', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const h = makeHarness({ r1: root }, { version: 'v1' }, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const file = await h.engine.file('r1', 'src/c1/a.ts');
    expect(file.path).toBe('src/c1/a.ts');
    expect(file.language).toBe('typescript');
    expect(file.content).toContain('export function a1');
    await expect(h.engine.file('r1', '../fora.txt')).rejects.toThrow(/outside/);
    await expect(h.engine.file('r1', join(root, '..', basename(root), 'src', 'c1', 'a.ts'))).rejects.toThrow(/outside/);
    await expect(h.engine.file('r1', '.lionclaw/archmap/current.json')).rejects.toThrow(/not_in_graph/);
    const graph = (await h.engine.graph('r1')) as { nodes: unknown[] };
    expect(graph.nodes.length).toBeGreaterThanOrEqual(files.length);
    const meta = await h.engine.meta('r1');
    expect(meta.analyzedFiles).toBe(files.length);
    expect(h.engine.runs('r1')).toHaveLength(1);
    expect(h.engine.runs('r1')[0]!.warnings).toBeDefined();
  }, 60_000);
});
