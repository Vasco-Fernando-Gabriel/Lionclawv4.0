import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileFingerprint } from '../core';
import {
  ARCHMAP_GENERATIONS_KEPT,
  hasTmpFiles,
  listGenerations,
  preflightArchmapDir,
  publishPointer,
  readGeneration,
  writeGeneration,
} from '../generation';
import {
  ARCHMAP_CURRENT_FILE,
  ARCHMAP_FINGERPRINTS_FILE,
  ARCHMAP_GRAPH_FILE,
  ARCHMAP_META_FILE,
  ARCHMAP_SCAN_RESULT_FILE,
  archmapDirPath,
  createArchmapStateReader,
  generationName,
  readCurrentPointer,
} from '../state';
import { ARCHMAP_SCHEMA_VERSION, type ScanResult } from '../pipeline/types';
import { makeTempDir, removeDir, sampleGraph } from './helpers';

let root: string;

beforeEach(() => {
  root = makeTempDir();
});

afterEach(() => {
  removeDir(root);
});

function scanFor(paths: string[]): ScanResult {
  return {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    scanStartedAt: '2026-10-08T00:00:00.000Z',
    contentDigest: 'abc',
    files: paths.map((path) => ({ path, language: 'typescript', sizeLines: 1, sizeBytes: 10, fileCategory: 'code' })),
    totalFiles: paths.length,
    filteredByIgnore: 0,
    importMap: {},
    stats: { byCategory: { code: paths.length }, byLanguage: { typescript: paths.length } },
    warnings: [],
  };
}

function fingerprintsFor(paths: string[]): Record<string, FileFingerprint> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      {
        filePath: path,
        contentHash: `hash-${path}`,
        functions: [],
        classes: [],
        imports: [],
        exports: [],
        totalLines: 1,
        hasStructuralAnalysis: false,
      },
    ]),
  );
}

async function publish(runId: string, paths: string[], head = 'abc1234'): Promise<string> {
  const result = await writeGeneration({
    repoRoot: root,
    runId,
    graph: sampleGraph(head, paths),
    fingerprints: fingerprintsFor(paths),
    scan: scanFor(paths),
    meta: {
      lastAnalyzedAt: '2026-10-08T00:00:00.000Z',
      gitCommitHash: head,
      analyzedFiles: paths.length,
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      lionClawVersion: '4.0.0',
    },
  });
  return result.generation;
}

describe('geracao com ponteiro (SPEC 7.0)', () => {
  it('grava os quatro arquivos em gen-<runId> e o current.json aponta para a geracao', async () => {
    const generation = await publish('run-1', ['src/a.ts', 'src/b.ts']);
    expect(generation).toBe(generationName('run-1'));
    const dir = join(archmapDirPath(root), generation);
    for (const name of [ARCHMAP_GRAPH_FILE, ARCHMAP_FINGERPRINTS_FILE, ARCHMAP_SCAN_RESULT_FILE, ARCHMAP_META_FILE]) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
    const pointer = await readCurrentPointer(root);
    expect(pointer?.generation).toBe(generation);
    expect(pointer?.previous).toBeNull();
    expect(await hasTmpFiles(root)).toBe(false);
  });

  it('le a geracao corrente de volta com grafo, meta, fingerprints e scan', async () => {
    await publish('run-1', ['src/a.ts']);
    const loaded = await readGeneration(root);
    expect(loaded).not.toBeNull();
    expect(loaded?.stats.fileCount).toBe(1);
    expect(loaded?.meta.gitCommitHash).toBe('abc1234');
    expect(loaded?.meta.model).toBe('claude-opus-5-5');
    expect(Object.keys(loaded?.fingerprints.files ?? {})).toEqual(['src/a.ts']);
    expect(loaded?.scan.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('o leitor de estado segue o ponteiro e nao a geracao mais nova sem ponteiro', async () => {
    const first = await publish('run-1', ['src/a.ts']);
    const orphan = generationName('run-orfao');
    mkdirSync(join(archmapDirPath(root), orphan), { recursive: true });
    writeFileSync(join(archmapDirPath(root), orphan, ARCHMAP_GRAPH_FILE), '{}', 'utf8');
    const reader = createArchmapStateReader();
    const state = await reader.read('repo', root);
    expect(state.pointer?.generation).toBe(first);
    expect(state.generationDir).toBe(join(archmapDirPath(root), first));
    expect(state.graph?.valid).toBe(true);
    expect(state.meta?.valid).toBe(true);
  });

  it('a segunda publicacao guarda a anterior como previous; a terceira apaga a mais antiga no preflight', async () => {
    const g1 = await publish('run-1', ['src/a.ts']);
    const g2 = await publish('run-2', ['src/a.ts', 'src/b.ts']);
    let pointer = await readCurrentPointer(root);
    expect(pointer?.generation).toBe(g2);
    expect(pointer?.previous).toBe(g1);
    const g3 = await publish('run-3', ['src/c.ts']);
    pointer = await readCurrentPointer(root);
    expect(pointer?.generation).toBe(g3);
    expect(pointer?.previous).toBe(g2);
    const result = await preflightArchmapDir(root);
    expect(result.removedGenerations).toEqual([g1]);
    expect(await listGenerations(root)).toEqual([g2, g3].sort());
    expect((await listGenerations(root)).length).toBe(ARCHMAP_GENERATIONS_KEPT);
  });

  it('preflight apaga geracao sem ponteiro e arquivos .tmp-* (AC-5, pasta consistente)', async () => {
    const g1 = await publish('run-1', ['src/a.ts']);
    const dir = archmapDirPath(root);
    const orphan = generationName('run-crash');
    mkdirSync(join(dir, orphan), { recursive: true });
    writeFileSync(join(dir, orphan, `.tmp-1-${ARCHMAP_GRAPH_FILE}`), '{', 'utf8');
    writeFileSync(join(dir, `.tmp-1-${ARCHMAP_CURRENT_FILE}`), '{', 'utf8');
    writeFileSync(join(dir, g1, `.tmp-9-${ARCHMAP_META_FILE}`), '{', 'utf8');
    expect(await hasTmpFiles(root)).toBe(true);
    const result = await preflightArchmapDir(root);
    expect(result.removedGenerations).toEqual([orphan]);
    expect(result.removedTmp.length).toBe(2);
    expect(await hasTmpFiles(root)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    expect((await readCurrentPointer(root))?.generation).toBe(g1);
    expect(JSON.parse(readFileSync(join(dir, g1, ARCHMAP_META_FILE), 'utf8')).generation).toBe(g1);
  });

  it('ponteiro invalido ou geracao inexistente deixam o estado como ausente', async () => {
    await publish('run-1', ['src/a.ts']);
    writeFileSync(join(archmapDirPath(root), ARCHMAP_CURRENT_FILE), '{"generation":"../fora"}', 'utf8');
    expect(await readCurrentPointer(root)).toBeNull();
    const reader = createArchmapStateReader();
    expect((await reader.read('repo', root)).graph).toBeNull();
    await publishPointer(root, generationName('nao-existe'));
    const state = await reader.read('repo', root);
    expect(state.pointer?.generation).toBe(generationName('nao-existe'));
    expect(state.generationDir).toBeNull();
    expect(state.graph).toBeNull();
  });

  it('grafo invalido nao publica nada', async () => {
    await expect(
      writeGeneration({
        repoRoot: root,
        runId: 'run-x',
        graph: { version: '1.0.0', nodes: 'nao' },
        fingerprints: {},
        scan: scanFor([]),
        meta: {
          lastAnalyzedAt: '2026-10-08T00:00:00.000Z',
          gitCommitHash: '',
          analyzedFiles: 0,
          runtime: 'cloud',
          provider: 'anthropic',
          model: 'm',
          lionClawVersion: '4.0.0',
        },
      }),
    ).rejects.toThrow(/grafo invalido/);
    expect(await readCurrentPointer(root)).toBeNull();
  });
});
