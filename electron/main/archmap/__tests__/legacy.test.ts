import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { readGeneration } from '../generation';
import { LEGACY_GENERATION_RUN_ID, legacyArchmapDirPath, readLegacyBaseline, reconstructBaseline } from '../legacy';
import { archmapDirPath, generationName, readCurrentPointer } from '../state';
import { cleanupTemps, gitInitCommit, makeHarness, nodeSummaries, runBuild, SELECTION, temps } from './harness';
import { inProcessWorker, makeTempDir } from './helpers';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const FIXTURE = join(__dirname, 'fixtures', 'legacy-archmap');
const REAL_REPO = process.env.ARCHMAP_REAL_REPO ?? '';
const REAL_MAP = REAL_REPO ? join(REAL_REPO, '.lioncode', 'archmap') : '';
const MISSING_FP = 'src/util/strings.ts';

afterEach(() => cleanupTemps());

function writeLegacyMap(root: string, sourceDir: string, head: string, dropFingerprints: string[] = []): void {
  const target = legacyArchmapDirPath(root);
  mkdirSync(target, { recursive: true });
  for (const name of ['knowledge-graph.json', 'meta.json', 'fingerprints.json']) {
    const raw = JSON.parse(readFileSync(join(sourceDir, name), 'utf8')) as Record<string, unknown>;
    if (name === 'fingerprints.json') {
      const files = raw.files as Record<string, unknown>;
      for (const path of dropFingerprints) delete files[path];
      raw.gitCommitHash = head;
    } else if (name === 'meta.json') {
      raw.gitCommitHash = head;
    } else {
      (raw.project as Record<string, unknown>).gitCommitHash = head;
    }
    writeFileSync(join(target, name), JSON.stringify(raw), 'utf8');
  }
}

function setupLegacyRepo(): { root: string; head: string } {
  const root = makeTempDir();
  temps.push(root);
  cpSync(join(FIXTURE, 'repo'), root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), '/.lionclaw/\n/.lioncode/\n', 'utf8');
  const { head } = gitInitCommit(root);
  writeLegacyMap(root, join(FIXTURE, 'lioncode-archmap'), head);
  return { root, head };
}

describe('AC-11: mapa legado (.lioncode/archmap sem scan-result.json) nunca pede regeneracao completa', () => {
  it('a fixture nao tem scan-result.json e deixa um arquivo do grafo sem fingerprint', () => {
    expect(existsSync(join(FIXTURE, 'lioncode-archmap', 'scan-result.json'))).toBe(false);
    const fp = JSON.parse(readFileSync(join(FIXTURE, 'lioncode-archmap', 'fingerprints.json'), 'utf8')) as {
      files: Record<string, unknown>;
    };
    expect(fp.files[MISSING_FP]).toBeUndefined();
    expect(Object.keys(fp.files)).toHaveLength(7);
  });

  it('status le o mapa legado antes da migracao e a estimativa de update classifica PARTIAL sem escrever no repo', async () => {
    const { root, head } = setupLegacyRepo();
    const h = makeHarness({ r1: root }, { version: 'v1' }, { realGit: true });
    const status = await h.engine.status('r1');
    expect(status.status).toBe('ready');
    expect(status.legacy).toBe(true);
    expect(status.indexedCommit).toBe(head);
    expect(status.stats?.fileCount).toBe(8);
    const graph = (await h.engine.graph('r1')) as { nodes: unknown[] };
    expect(graph.nodes).toHaveLength(13);

    const estimate = await h.engine.estimate('r1', SELECTION, 'update');
    expect(estimate.update?.action).toBe('PARTIAL_UPDATE');
    expect(estimate.update?.legacy).toBe(true);
    expect(estimate.update?.pendingFiles).toBe(1);
    expect(estimate.update?.filesToReanalyze).toBe(1);
    expect(estimate.update?.structuralCount).toBe(0);
    expect(estimate.update?.deletedFiles).toBe(0);
    expect(estimate.update?.newFiles).toBe(0);
    expect(existsSync(join(root, '.lionclaw'))).toBe(false);
  });

  it('reconstrucao conservadora: scan-result recomposto dos fingerprints + grafo, importMap do disco, sem fingerprint = pendente', async () => {
    const { root } = setupLegacyRepo();
    const baseline = (await readLegacyBaseline(root))!;
    expect(baseline.scan).toBeNull();
    expect(baseline.fingerprints).not.toBeNull();
    const worker = inProcessWorker();
    const scanned = await worker.scan({ projectPath: root, scanStartedAt: '2026-10-09T00:00:00.000Z' });
    await worker.terminate();
    const recon = reconstructBaseline({
      graphPaths: baseline.inspection.paths,
      fingerprints: baseline.fingerprints,
      previousScan: null,
      currentScan: scanned.scan,
      scanStartedAt: baseline.meta.lastAnalyzedAt,
    });
    expect(recon.reconstructedScan).toBe(true);
    expect(recon.paths).toHaveLength(8);
    expect(recon.pending).toEqual([MISSING_FP]);
    expect(Object.keys(recon.fingerprints)).toHaveLength(7);
    expect(recon.scan.files.map((f) => f.path).sort()).toEqual(recon.paths);
    expect(recon.scan.importMap['src/index.ts']).toEqual(['src/greet.ts', 'src/math.ts']);
    expect(recon.scan.importMap['src/greet.ts']).toEqual([MISSING_FP]);
    expect(recon.scan.warnings[0]).toContain('recomposto');
    for (const [path, fp] of Object.entries(recon.fingerprints)) {
      expect(fp.contentHash).toBe(scanned.fingerprints[path]!.contentHash);
    }
  });

  it('Atualizar migra para gen-legado e reanalisa so o pendente; os demais mantem anotacao e fingerprint com procedencia', async () => {
    const { root, head } = setupLegacyRepo();
    const h = makeHarness(
      { r1: root },
      { version: 'v1' },
      { realGit: true, settings: { archmap_batch_parallelism: '5' } },
    );
    const legacyHashes = Object.fromEntries(
      Object.entries(
        (
          JSON.parse(readFileSync(join(legacyArchmapDirPath(root), 'fingerprints.json'), 'utf8')) as {
            files: Record<string, { contentHash: string }>;
          }
        ).files,
      ).map(([path, fp]) => [path, fp.contentHash]),
    );
    await runBuild(h, 'r1', 'update');
    const run = h.repository.runs[0]!;
    expect(run.status).toBe('done');
    expect(run.action).toBe('PARTIAL_UPDATE');
    expect(run.reason).toBeNull();
    expect(run.warnings.some((w) => w.includes('mapa legado') && w.includes('scan-result recomposto'))).toBe(true);

    const legacyGen = generationName(LEGACY_GENERATION_RUN_ID);
    const legacyDir = join(archmapDirPath(root), legacyGen);
    expect(existsSync(join(legacyDir, 'scan-result.json'))).toBe(true);
    const legacyMeta = JSON.parse(readFileSync(join(legacyDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(legacyMeta.migratedFrom).toBe('.lioncode/archmap');
    expect(legacyMeta.pendingFiles).toEqual([MISSING_FP]);
    expect(legacyMeta.gitCommitHash).toBe(head);
    const pointer = (await readCurrentPointer(root))!;
    expect(pointer.generation).toBe(`gen-${run.id}`);
    expect(pointer.previous).toBe(legacyGen);

    expect(h.agent.calls.filter((c) => c.phase === 'analysis')).toHaveLength(1);
    expect(h.agent.calls.filter((c) => c.phase === 'layers')).toHaveLength(0);
    expect(h.agent.calls.filter((c) => c.phase === 'tour')).toHaveLength(0);
    expect(h.agent.calls.filter((c) => c.phase === 'review')).toHaveLength(0);

    const gen = (await readGeneration(root))!;
    expect(gen.meta.partial).toBeUndefined();
    expect(gen.meta.action).toBe('PARTIAL_UPDATE');
    expect(gen.meta.analyzedFiles).toBe(8);
    const summaries = nodeSummaries(gen.graph);
    expect(summaries.get(MISSING_FP)?.summary).toContain('Resumo v1');
    for (const path of ['src/index.ts', 'src/math.ts', 'src/greet.ts']) {
      expect(summaries.get(path)?.summary).toBe(`Resumo legado de ${path}`);
      expect(gen.fingerprints.files[path]!.contentHash).toBe(legacyHashes[path]);
    }
    expect(gen.fingerprints.files[MISSING_FP]).toBeDefined();
    const legacyLayers = (
      JSON.parse(readFileSync(join(legacyDir, 'knowledge-graph.json'), 'utf8')) as {
        layers: Array<{ id: string; name: string }>;
      }
    ).layers;
    expect((gen.graph.layers as Array<{ id: string; name: string }>)[0]).toMatchObject({
      id: legacyLayers[0]!.id,
      name: legacyLayers[0]!.name,
    });
    expect(gen.meta.layersStale).toBeUndefined();
    expect(
      (gen.graph.edges as Array<Record<string, unknown>>).some(
        (e) => e.type === 'calls' && e.source === 'file:src/index.ts' && e.target === 'file:src/greet.ts',
      ),
    ).toBe(true);
    const status = await h.engine.status('r1');
    expect(status.status).toBe('ready');
    expect(status.legacy).toBeUndefined();
    expect(existsSync(join(root, '.lioncode', 'archmap', 'knowledge-graph.json'))).toBe(true);
  }, 60_000);
});

describe('cenario real: mapa legado de um repositorio real (somente leitura; o repo temporario vem de read-tree + checkout-index com indice temporario)', () => {
  const realMap = REAL_MAP.length > 0 && existsSync(REAL_MAP);

  function mapSnapshot(): string[] {
    return readdirSync(REAL_MAP)
      .map((name) => `${name}:${statSync(join(REAL_MAP, name)).mtimeMs}`)
      .sort();
  }

  function archiveInto(treeish: string): string {
    const root = makeTempDir('lionclaw-real-');
    temps.push(root);
    const index = join(root, '..', `${basename(root)}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const gitDir = join(REAL_REPO, '.git');
    execFileSync('git', ['--git-dir', gitDir, '--work-tree', root, 'read-tree', treeish], { env });
    execFileSync('git', ['--git-dir', gitDir, '--work-tree', root, 'checkout-index', '-a', '-f'], { env });
    rmSync(index, { force: true });
    writeFileSync(
      join(root, '.gitignore'),
      `${existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : ''}\n/.lionclaw/\n/.lioncode/\n`,
      'utf8',
    );
    return root;
  }

  function realMeta(): { gitCommitHash: string } {
    return JSON.parse(readFileSync(join(REAL_MAP, 'meta.json'), 'utf8')) as { gitCommitHash: string };
  }

  function realFingerprintPaths(): string[] {
    const fp = JSON.parse(readFileSync(join(REAL_MAP, 'fingerprints.json'), 'utf8')) as {
      files: Record<string, { contentHash: string; hasStructuralAnalysis: boolean }>;
    };
    return Object.keys(fp.files);
  }

  it.skipIf(!realMap)(
    'S3-V4: commit indexado: migracao real, update, depois SKIP, PARTIAL e ARCHITECTURE deterministas',
    async () => {
      const before = mapSnapshot();
      const paths = realFingerprintPaths();
      const root = archiveInto(realMeta().gitCommitHash);
      const { head } = gitInitCommit(root);
      const dropped = paths.filter((path) => existsSync(join(root, path))).slice(0, 5);
      writeLegacyMap(root, REAL_MAP, head, dropped);
      expect(existsSync(join(legacyArchmapDirPath(root), 'scan-result.json'))).toBe(false);

      const h = makeHarness(
        { r1: root },
        { version: 'v1' },
        { realGit: true, settings: { archmap_batch_parallelism: '5' } },
      );
      const status = await h.engine.status('r1');
      expect(status.legacy).toBe(true);
      expect(status.stats?.fileCount).toBe(paths.length);
      const first = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
      expect(first.legacy).toBe(true);
      expect(first.totalFiles).toBe(paths.length);
      expect(first.pendingFiles).toBeGreaterThanOrEqual(dropped.length);
      expect(first.newFiles).toBe(0);
      expect(['SKIP', 'PARTIAL_UPDATE', 'ARCHITECTURE_UPDATE']).toContain(first.action);
      expect(first.reason).toBeUndefined();
      expect(first.filesToReanalyze).toBeGreaterThanOrEqual(first.pendingFiles);
      expect(first.filesToReanalyze).toBeLessThan(paths.length / 2);
      expect(existsSync(join(root, '.lionclaw'))).toBe(false);

      await runBuild(h, 'r1', 'update');
      const run0 = h.repository.runs[0]!;
      expect(run0.status).toBe('done');
      expect(run0.action).toBe(first.action);
      const legacyDir = join(archmapDirPath(root), generationName(LEGACY_GENERATION_RUN_ID));
      expect(existsSync(join(legacyDir, 'scan-result.json'))).toBe(true);
      const legacyMeta = JSON.parse(readFileSync(join(legacyDir, 'meta.json'), 'utf8')) as { pendingFiles?: string[] };
      for (const path of dropped) expect(legacyMeta.pendingFiles).toContain(path);
      const gen0 = (await readGeneration(root))!;
      expect(gen0.pointer.previous).toBe(generationName(LEGACY_GENERATION_RUN_ID));
      expect(
        gen0.meta.partial,
        run0.warnings
          .filter((w) => /ausente|extracao|lote d+:/.test(w))
          .slice(0, 8)
          .join(' || '),
      ).toBeUndefined();
      expect(gen0.stats.fileCount).toBeGreaterThan(paths.length - first.deletedFiles - 1);
      expect((await h.engine.status('r1')).status).toBe('ready');

      const skip = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
      expect(skip.action).toBe('SKIP');
      expect(skip.cosmeticFiles).toBe(0);
      expect(skip.filesToReanalyze).toBe(0);

      const code = gen0.scan.files.find(
        (file) => file.language === 'typescript' && gen0.fingerprints.files[file.path]?.hasStructuralAnalysis,
      )!;
      appendFileSync(join(root, code.path), '\nexport function archmapProbe(): number { return 1; }\n');
      const partial = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
      expect(partial.action).toBe('PARTIAL_UPDATE');
      expect(partial.filesToReanalyze).toBe(1);
      expect(partial.structuralCount).toBe(1);
      const from = h.agent.calls.length;
      await runBuild(h, 'r1', 'update');
      expect(h.repository.runs[1]!.action).toBe('PARTIAL_UPDATE');
      expect(h.agent.calls.slice(from).filter((c) => c.phase === 'analysis')).toHaveLength(1);
      expect(h.agent.calls.slice(from).filter((c) => c.phase === 'layers')).toHaveLength(0);

      const manifest = gen0.scan.files.find(
        (file) => file.path === 'package.json' || file.path.endsWith('/package.json'),
      )!;
      const text = readFileSync(join(root, manifest.path), 'utf8');
      writeFileSync(join(root, manifest.path), text.replace(/\}\s*$/, ', "archmapProbe": true }\n'), 'utf8');
      const arch = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
      expect(arch.action).toBe('ARCHITECTURE_UPDATE');
      expect(arch.triggers).toContain('manifest');
      expect(arch.manifestFiles).toContain(manifest.path);
      expect(arch.filesToReanalyze).toBe(1);

      expect(mapSnapshot()).toEqual(before);
      expect(existsSync(join(REAL_REPO, '.lionclaw'))).toBe(false);
    },
    600_000,
  );

  it.skipIf(!realMap)(
    'HEAD real: invariantes independentes da deriva (novos nunca forcam FULL)',
    async () => {
      const before = mapSnapshot();
      const paths = realFingerprintPaths();
      const root = archiveInto('HEAD');
      const { head } = gitInitCommit(root);
      const dropped = paths.filter((path) => existsSync(join(root, path))).slice(0, 5);
      writeLegacyMap(root, REAL_MAP, head, dropped);
      const h = makeHarness({ r1: root }, { version: 'v1' }, { realGit: true });
      const preview = (await h.engine.estimate('r1', SELECTION, 'update')).update!;
      expect(preview.totalFiles).toBe(paths.length);
      expect(preview.pendingFiles).toBeGreaterThanOrEqual(dropped.length);
      expect(preview.filesToReanalyze).toBeGreaterThanOrEqual(preview.pendingFiles + preview.newFiles);
      expect(preview.structuralCount).toBeLessThanOrEqual(preview.totalFiles);
      expect(preview.structuralCount).toBeLessThanOrEqual(
        preview.totalFiles - preview.cosmeticFiles - preview.nonStructuralFiles,
      );
      if (preview.action === 'FULL_UPDATE') {
        expect(preview.reason).toBe('too_many_changes');
        expect(preview.structuralCount).toBeGreaterThan(preview.threshold);
      } else {
        expect(preview.structuralCount).toBeLessThanOrEqual(preview.threshold);
      }
      expect(['graph_invalid', 'meta_invalid', 'no_git', 'indexed_commit_missing']).not.toContain(preview.reason);
      expect(existsSync(join(root, '.lionclaw'))).toBe(false);
      expect(mapSnapshot()).toEqual(before);
    },
    300_000,
  );
});
