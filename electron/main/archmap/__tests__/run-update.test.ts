import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchmapStatusEvent } from '../../../../src/types/archmap';
import { readGeneration } from '../generation';
import { readCurrentPointer } from '../state';
import {
  cleanupTemps,
  makeHarness,
  nodeSummaries,
  phaseOf,
  runBuild,
  SELECTION,
  sha256,
  temps,
  type FakeAgentHooks,
  type Harness,
} from './harness';
import { makeClusteredRepo } from './helpers';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

afterEach(() => cleanupTemps());

function addFunction(root: string, path: string, name: string): void {
  appendFileSync(join(root, path), `export function ${name}(): number { return 42; }\n`);
}

function addComment(root: string, path: string): void {
  appendFileSync(join(root, path), '// comentario cosmetico\n');
}

function callsSince(h: Harness, from: number, phase: string): number {
  return h.agent.calls.slice(from).filter((c) => c.phase === phase).length;
}

function lastAnalysisEvent(h: Harness, runId: string): ArchmapStatusEvent | undefined {
  return [...h.events].reverse().find((e) => e.run?.id === runId && e.progress?.phase === 'analysis');
}

describe('incremental v2: PARTIAL, SKIP e ARCHITECTURE reaproveitam a geracao anterior', () => {
  it('PARTIAL: so os arquivos alterados voltam ao modelo; cosmetico mantem a anotacao com estrutura e fingerprint do snapshot; camadas e tour mantidos', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const gen0 = (await readGeneration(root))!;
    const oldHashes = Object.fromEntries(Object.entries(gen0.fingerprints.files).map(([p, fp]) => [p, fp.contentHash]));

    addFunction(root, 'src/c3/b.ts', 'extraB');
    addComment(root, 'src/c5/d.ts');
    hooks.version = 'v2';
    const from = h.agent.calls.length;
    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.action).toBe('PARTIAL_UPDATE');
    expect(preview.filesToReanalyze).toBe(1);
    expect(preview.cosmeticFiles).toBe(1);
    expect(preview.rerunLayers).toBe(false);

    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('PARTIAL_UPDATE');
    expect(run.reason).toBeNull();
    expect(callsSince(h, from, 'analysis')).toBe(1);
    expect(callsSince(h, from, 'narrative')).toBe(0);
    expect(callsSince(h, from, 'layers')).toBe(0);
    expect(callsSince(h, from, 'tour')).toBe(0);
    expect(callsSince(h, from, 'review')).toBe(0);
    expect(run.warnings.some((w) => w.startsWith('incremental PARTIAL_UPDATE'))).toBe(true);

    const gen1 = (await readGeneration(root))!;
    expect(gen1.pointer.previous).toBe(gen0.pointer.generation);
    expect(gen1.meta.action).toBe('PARTIAL_UPDATE');
    expect(gen1.meta.partial).toBeUndefined();
    expect(gen1.meta.analyzedFiles).toBe(files.length);
    expect(gen1.graph.layers).toEqual(gen0.graph.layers);
    expect(gen1.graph.tour).toEqual(gen0.graph.tour);
    const summaries = nodeSummaries(gen1.graph);
    for (const path of files) {
      const content = readFileSync(join(root, path), 'utf8');
      if (path === 'src/c3/b.ts') {
        expect(summaries.get(path)?.summary).toContain('Resumo v2');
        expect(gen1.fingerprints.files[path]!.contentHash).toBe(sha256(content));
      } else if (path === 'src/c5/d.ts') {
        expect(summaries.get(path)?.summary).toContain('Resumo v1');
        expect(gen1.fingerprints.files[path]!.contentHash).toBe(sha256(content));
        expect(gen1.fingerprints.files[path]!.contentHash).not.toBe(oldHashes[path]);
      } else {
        expect(summaries.get(path)?.summary).toContain('Resumo v1');
        expect(gen1.fingerprints.files[path]!.contentHash).toBe(oldHashes[path]);
      }
    }
    expect(run.warnings.some((w) => w.includes('1 arquivo(s) com mudanca so cosmetica'))).toBe(true);
    expect((gen1.graph.nodes as Array<{ id: string }>).some((n) => n.id === 'function:src/c3/b.ts:extraB')).toBe(true);
    expect((await h.engine.status('r1')).status).toBe('ready');

    const skipFrom = h.agent.calls.length;
    await runBuild(h, 'r1', 'update');
    const run2 = h.repository.runs[2]!;
    expect(run2.status).toBe('done');
    expect(run2.action).toBe('SKIP');
    expect(h.agent.calls.length).toBe(skipFrom);
    expect(run2.llmCalls).toBe(0);
    const gen2 = (await readGeneration(root))!;
    expect(gen2.pointer.generation).toBe(`gen-${run2.id}`);
    expect(gen2.pointer.previous).toBe(gen1.pointer.generation);
    expect((gen2.graph.nodes as unknown[]).length).toBe((gen1.graph.nodes as unknown[]).length);
    expect(gen2.fingerprints.files['src/c5/d.ts']!.contentHash).toBe(
      gen1.fingerprints.files['src/c5/d.ts']!.contentHash,
    );
    expect(gen2.meta.action).toBe('SKIP');
    expect(run2.warnings.some((w) => w.includes('cosmetica'))).toBe(false);
  }, 120_000);

  it('S3-V3: so cosmetico = SKIP que grava estrutura e fingerprint do snapshot com a anotacao antiga; a segunda atualizacao e SKIP limpo', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const h = makeHarness({ r1: root }, { version: 'v1' }, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const gen0 = (await readGeneration(root))!;
    const target = 'src/c2/b.ts';
    const lineOf = (gen: Awaited<ReturnType<typeof readGeneration>>) =>
      ((gen!.graph.nodes as Array<{ id: string; lineRange?: [number, number] }>).find(
        (n) => n.id === `function:${target}:b2`,
      )?.lineRange ?? [0, 0])[0];
    writeFileSync(
      join(root, target),
      `// cabecalho cosmetico\n// segunda linha\n${readFileSync(join(root, target), 'utf8')}`,
    );
    const first = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(first.action).toBe('SKIP');
    expect(first.cosmeticFiles).toBe(1);
    const from = h.agent.calls.length;
    await runBuild(h, 'r1', 'update');
    const run1 = h.repository.runs[1]!;
    expect(run1.status).toBe('done');
    expect(run1.action).toBe('SKIP');
    expect(h.agent.calls.length).toBe(from);
    const gen1 = (await readGeneration(root))!;
    expect(gen1.fingerprints.files[target]!.contentHash).toBe(sha256(readFileSync(join(root, target), 'utf8')));
    expect(nodeSummaries(gen1.graph).get(target)?.summary).toBe(nodeSummaries(gen0.graph).get(target)?.summary);
    expect(lineOf(gen1)).toBe(lineOf(gen0) + 2);
    expect(gen1.meta.partial).toBeUndefined();
    const second = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(second.action).toBe('SKIP');
    expect(second.cosmeticFiles).toBe(0);
    expect(second.detail).toContain('nenhuma mudanca');
  }, 120_000);

  it('S3-V2: manifest novo e analisado na mesma rodada e a geracao nao sai parcial', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    writeFileSync(join(root, 'package.json'), '{ "name": "fixture", "version": "2.0.0" }\n');
    hooks.version = 'v2';
    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.action).toBe('ARCHITECTURE_UPDATE');
    expect(preview.triggers).toEqual(['manifest']);
    expect(preview.newFiles).toBe(1);
    expect(preview.filesToReanalyze).toBe(1);
    const from = h.agent.calls.length;
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('ARCHITECTURE_UPDATE');
    expect(callsSince(h, from, 'analysis')).toBe(1);
    const gen = (await readGeneration(root))!;
    expect(gen.meta.partial).toBeUndefined();
    expect(gen.meta.pendingFiles).toBeUndefined();
    expect(gen.fingerprints.files['package.json']).toBeDefined();
    const node = (gen.graph.nodes as Array<{ filePath?: string; summary: string; tags: string[] }>).find(
      (n) => n.filePath === 'package.json',
    );
    expect(node?.summary).toContain('Resumo v2');
    expect(node?.tags).not.toContain('pending');
    expect((await h.engine.status('r1')).status).toBe('ready');
  }, 120_000);

  it('AC-22: ARCHITECTURE por manifest refaz camadas e tour quando um resumo mudou e reaproveita do checkpoint quando nada mudou', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "fixture", "version": "1.0.0" }\n');
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');

    writeFileSync(
      join(root, 'package.json'),
      '{ "name": "fixture", "version": "1.0.0", "dependencies": { "zod": "^3" } }\n',
    );
    hooks.version = 'v2';
    let from = h.agent.calls.length;
    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.action).toBe('ARCHITECTURE_UPDATE');
    expect(preview.triggers).toEqual(['manifest']);
    expect(preview.manifestFiles).toEqual(['package.json']);
    expect(preview.rerunLayers).toBe(true);
    await runBuild(h, 'r1', 'update');
    const run1 = h.repository.runs[1]!;
    expect(run1.action).toBe('ARCHITECTURE_UPDATE');
    expect(callsSince(h, from, 'analysis')).toBe(1);
    expect(callsSince(h, from, 'layers')).toBe(1);
    expect(callsSince(h, from, 'tour')).toBe(1);
    expect(callsSince(h, from, 'review')).toBe(0);
    const gen1 = (await readGeneration(root))!;
    expect(gen1.meta.layersStale).toBeUndefined();
    expect(nodeSummaries(gen1.graph).get('src/c1/a.ts')?.summary).toContain('Resumo v1');

    writeFileSync(
      join(root, 'package.json'),
      '{ "name": "fixture", "version": "1.0.0", "dependencies": { "zod": "^4" } }\n',
    );
    from = h.agent.calls.length;
    await runBuild(h, 'r1', 'update');
    const run2 = h.repository.runs[2]!;
    expect(run2.action).toBe('ARCHITECTURE_UPDATE');
    expect(callsSince(h, from, 'analysis')).toBe(1);
    expect(callsSince(h, from, 'layers')).toBe(0);
    expect(callsSince(h, from, 'tour')).toBe(0);
    const layersEvent = h.events.find(
      (e) =>
        e.run?.id === run2.id && e.progress?.phase === 'layers' && e.progress.detail === 'reaproveitado do checkpoint',
    );
    expect(layersEvent).toBeDefined();
  }, 120_000);

  it('AC-22: PARTIAL nao roda camadas/tour mesmo com resumo alterado, salvo layersStale/tourStale da geracao parcial anterior', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    for (const path of files) appendFileSync(join(root, path), 'export const v2 = true;\n');
    hooks.version = 'v2';
    const original = h.agent.executeAgent;
    h.agent.executeAgent = async (req) => {
      if (phaseOf(req.cwd).phase === 'layers') {
        h.engine.cancel('r1');
        req.abortController.signal.throwIfAborted();
      }
      return original(req);
    };
    await runBuild(h, 'r1', 'update', true);
    const cancelled = h.repository.runs[1]!;
    expect(cancelled.status).toBe('cancelled');
    const genPartial = (await readGeneration(root))!;
    expect(genPartial.meta.layersStale).toBe(true);
    expect(genPartial.meta.tourStale).toBe(true);
    h.agent.executeAgent = original;

    addFunction(root, 'src/c2/c.ts', 'extraC');
    const from = h.agent.calls.length;
    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.action).toBe('PARTIAL_UPDATE');
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[2]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('PARTIAL_UPDATE');
    expect(callsSince(h, from, 'layers')).toBe(1);
    expect(callsSince(h, from, 'tour')).toBe(1);
    const gen = (await readGeneration(root))!;
    expect(gen.meta.layersStale).toBeUndefined();
    expect(gen.meta.tourStale).toBeUndefined();

    addFunction(root, 'src/c4/c.ts', 'extraC4');
    const from2 = h.agent.calls.length;
    await runBuild(h, 'r1', 'update');
    expect(h.repository.runs[3]!.action).toBe('PARTIAL_UPDATE');
    expect(callsSince(h, from2, 'analysis')).toBe(1);
    expect(callsSince(h, from2, 'layers')).toBe(0);
    expect(callsSince(h, from2, 'tour')).toBe(0);
  }, 120_000);

  it('FULL por mais de 50% estrutural: sem confirmFull recusa com motivo e numeros; com confirmFull regenera tudo', async () => {
    const { root, files } = makeClusteredRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const changed = files.slice(0, 40);
    for (const path of changed) addFunction(root, path, 'novaFn');
    hooks.version = 'v2';
    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.action).toBe('FULL_UPDATE');
    expect(preview.reason).toBe('too_many_changes');
    expect(preview.structuralCount).toBe(40);
    expect(preview.totalFiles).toBe(files.length);
    expect(preview.threshold).toBe(Math.floor(files.length / 2));
    await expect(h.engine.update('r1', SELECTION)).rejects.toMatchObject({
      code: 'confirm_full',
      details: {
        action: 'FULL_UPDATE',
        reason: 'too_many_changes',
        preview: { structuralCount: 40, totalFiles: files.length },
        fileCount: files.length,
      },
    });
    expect(h.repository.runs).toHaveLength(1);
    expect(h.engine.hasActive('r1')).toBe(false);
    expect((await readCurrentPointer(root))!.generation).toBe(`gen-${h.repository.runs[0]!.id}`);

    const from = h.agent.calls.length;
    await runBuild(h, 'r1', 'update', true);
    const run = h.repository.runs[1]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('FULL_UPDATE');
    expect(run.reason).toBe('too_many_changes');
    expect(callsSince(h, from, 'review')).toBe(1);
    expect(callsSince(h, from, 'analysis')).toBe(2);
    expect(lastAnalysisEvent(h, run.id)?.progress?.reused).toBe(8);
    expect(lastAnalysisEvent(h, run.id)?.progress?.succeeded).toBe(10);
    const gen = (await readGeneration(root))!;
    expect(gen.meta.action).toBe('FULL_UPDATE');
    const summaries = nodeSummaries(gen.graph);
    for (const path of files) {
      expect(summaries.get(path)?.summary).toContain(changed.includes(path) ? 'Resumo v2' : 'Resumo v1');
    }
  }, 120_000);

  it('arquivos removidos saem do grafo com suas arestas e arquivos novos entram pelo incremental', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const { rmSync } = await import('node:fs');
    rmSync(join(root, 'src/c8/d.ts'));
    writeFileSync(
      join(root, 'src/c8/a.ts'),
      "import { b8 } from './b';\nexport function a8(): number { return b8(); }\nexport const marker = 'ORIGINAL';\n",
    );
    writeFileSync(
      join(root, 'src/c8/e.ts'),
      "export function e8(): number { return 8; }\nexport const marker = 'ORIGINAL';\n",
    );
    hooks.version = 'v2';
    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.deletedFiles).toBe(1);
    expect(preview.newFiles).toBe(1);
    expect(preview.action).toBe('PARTIAL_UPDATE');
    await runBuild(h, 'r1', 'update');
    const gen = (await readGeneration(root))!;
    const ids = new Set((gen.graph.nodes as Array<{ id: string }>).map((n) => n.id));
    expect(ids.has('file:src/c8/d.ts')).toBe(false);
    expect(ids.has('file:src/c8/e.ts')).toBe(true);
    expect((gen.graph.edges as Array<{ target: string }>).some((e) => e.target === 'file:src/c8/d.ts')).toBe(false);
    expect(gen.fingerprints.files['src/c8/d.ts']).toBeUndefined();
    expect(nodeSummaries(gen.graph).get('src/c8/e.ts')?.summary).toContain('Resumo v2');
    expect(nodeSummaries(gen.graph).get('src/c8/a.ts')?.summary).toContain('Resumo v2');
    expect(gen.scan.files.some((f) => f.path === 'src/c8/d.ts')).toBe(false);
  }, 120_000);
});

describe('SPEC 7.1: chave da narrativa = README, manifests e caminhos de topo', () => {
  it('arquivo novo dentro de uma pasta de topo existente reaproveita a narrativa; pasta de topo nova paga uma chamada', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const hooks: FakeAgentHooks = { version: 'v1' };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    expect(h.agent.calls.filter((c) => c.phase === 'narrative')).toHaveLength(1);

    writeFileSync(
      join(root, 'src/c8/e.ts'),
      "export function e8(): number { return 8; }\nexport const marker = 'ORIGINAL';\n",
    );
    hooks.version = 'v2';
    let from = h.agent.calls.length;
    expect((await h.engine.estimate('r1', SELECTION, 'update')).update!.newFiles).toBe(1);
    await runBuild(h, 'r1', 'update');
    expect(h.repository.runs[1]!.status).toBe('done');
    expect(callsSince(h, from, 'narrative')).toBe(0);
    expect(callsSince(h, from, 'analysis')).toBeGreaterThan(0);

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(
      join(root, 'tools/t.ts'),
      "export function tool(): number { return 1; }\nexport const marker = 'ORIGINAL';\n",
    );
    hooks.version = 'v3';
    from = h.agent.calls.length;
    await runBuild(h, 'r1', 'update');
    expect(h.repository.runs[2]!.status).toBe('done');
    expect(callsSince(h, from, 'narrative')).toBe(1);
  }, 180_000);
});

describe('AC-8 (segunda metade): badge desatualizado por mudancas locais e reclassificacao na atualizacao seguinte', () => {
  it('arquivo editado durante a rodada deixa o status stale com motivo "mudancas locais" e vira alterado no update', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const target = 'src/c3/a.ts';
    const original = readFileSync(join(root, target), 'utf8');
    let edited = false;
    const hooks: FakeAgentHooks = {
      version: 'v1',
      onAnalysis: () => {
        if (!edited) {
          edited = true;
          writeFileSync(
            join(root, target),
            `${original.replace("marker = 'ORIGINAL'", "marker = 'MODIFIED'")}export function extraA3(): number { return 3; }
`,
            'utf8',
          );
        }
        return null;
      },
    };
    const h = makeHarness({ r1: root }, hooks, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const gen0 = (await readGeneration(root))!;
    expect(gen0.meta.changedDuringRun).toEqual([target]);
    const status = await h.engine.status('r1');
    expect(status.status).toBe('stale');
    expect(status.freshness?.status).toBe('dirty');
    expect(status.freshness?.label).toBe('desatualizado');
    expect(status.freshness?.reason).toContain('mudancas locais');
    expect(status.freshness?.changedFiles).toEqual([target]);
    expect(status.changedFileCount).toBe(1);
    expect(await h.engine.freshness('r1')).toMatchObject({ status: 'dirty', localChanges: true });

    const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
    expect(preview.action).toBe('PARTIAL_UPDATE');
    expect(preview.filesToReanalyze).toBe(1);
    expect(preview.cosmeticFiles).toBe(0);
    hooks.version = 'v2';
    await runBuild(h, 'r1', 'update');
    const gen1 = (await readGeneration(root))!;
    expect(nodeSummaries(gen1.graph).get(target)?.summary).toContain('(MODIFIED)');
    expect(gen1.fingerprints.files[target]!.contentHash).toBe(sha256(readFileSync(join(root, target), 'utf8')));
    expect((await h.engine.status('r1')).status).toBe('ready');
  }, 120_000);

  it('git que nao responde: status erro "git nao respondeu", update e estimativa recusam sem forcar FULL', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const h = makeHarness({ r1: root }, { version: 'v1' }, { settings: { archmap_batch_parallelism: '5' } });
    await runBuild(h, 'r1');
    const { fakeGit } = await import('./helpers');
    const slow = makeHarness({ r1: root }, { version: 'v1' }, { git: fakeGit(null, { timeout: true }) });
    const status = await slow.engine.status('r1');
    expect(status.status).toBe('error');
    expect(status.error).toBe('git nao respondeu');
    await expect(slow.engine.estimate('r1', SELECTION, 'update')).rejects.toMatchObject({ code: 'git_timeout' });
    await expect(slow.engine.update('r1', SELECTION)).rejects.toMatchObject({ code: 'git_timeout' });
    expect(slow.repository.runs).toHaveLength(0);
  }, 60_000);
});

describe('S2-R1: cancelar durante a gravacao e recusado com motivo; chamada abortada nao conta ok', () => {
  it('cancel no finalize devolve {cancelled:false, reason} e a rodada termina done', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const outcomes: Array<{ cancelled: boolean; reason?: string }> = [];
    const holder: { h: Harness | null } = { h: null };
    holder.h = makeHarness(
      { r1: root },
      { version: 'v1' },
      {
        settings: { archmap_batch_parallelism: '5' },
        deps: {
          emit: (event) => {
            holder.h!.events.push(event);
            if (event.progress?.phase === 'finalize' && outcomes.length === 0) {
              outcomes.push(holder.h!.engine.cancel('r1'));
            }
          },
        },
      },
    );
    const h = holder.h;
    await runBuild(h, 'r1');
    expect(outcomes).toEqual([{ cancelled: false, reason: 'gravando a geracao; a rodada termina em instantes' }]);
    expect(h.repository.runs[0]!.status).toBe('done');
    expect((await readCurrentPointer(root))!.generation).toBe(`gen-${h.repository.runs[0]!.id}`);
  }, 60_000);

  it('chamada interrompida pelo cancelamento e registrada com ok:false e erro "cancelado"', async () => {
    const { root } = makeClusteredRepo();
    temps.push(root);
    const holder: { h: Harness | null } = { h: null };
    holder.h = makeHarness(
      { r1: root },
      {
        version: 'v1',
        onAnalysis: (batchIndex) => {
          if (batchIndex === 2) holder.h!.engine.cancel('r1');
          return null;
        },
      },
      { settings: { archmap_batch_parallelism: '1' } },
    );
    const h = holder.h;
    await runBuild(h, 'r1');
    expect(h.repository.runs[0]!.status).toBe('cancelled');
    const aborted = h.llmCalls.filter((c) => !c.ok);
    expect(aborted.length).toBeGreaterThanOrEqual(1);
    expect(aborted.every((c) => c.error === 'cancelado')).toBe(true);
    expect(h.llmCalls.filter((c) => c.phase === 'analysis' && c.ok)).toHaveLength(1);
    expect(h.repository.runs[0]!.warnings.some((w) => w.includes('cancelado'))).toBe(true);
    expect(lastAnalysisEvent(h, h.repository.runs[0]!.id)?.progress?.succeeded).toBe(1);
  }, 60_000);
});
