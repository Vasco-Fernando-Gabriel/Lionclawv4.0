import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHMAP_AGENT_CACHE_DIR,
  ARCHMAP_TASK_CACHE_DIR,
  batchCheckpointInput,
  checkpointKey,
  createCheckpointStore,
  pathsIdentity,
  type GenerationConfig,
} from '../pipeline/checkpoints';
import { buildStructuralGraph } from '../pipeline/hybrid-structure';
import type { BatchInput, BatchPlan } from '../pipeline/types';
import { preflightArchmapDir } from '../generation';
import { archmapDirPath } from '../state';
import { makeTempDir, removeDir } from './helpers';

const config: GenerationConfig = { runtime: 'cloud', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' };

function batchInput(paths: string[], batchIndex = 1): BatchInput {
  return {
    projectName: 'fixture',
    batchIndex,
    files: paths.map((path) => ({ path, language: 'typescript', sizeLines: 1, sizeBytes: 10, fileCategory: 'code' })),
    extraction: paths.map((path) => ({
      path,
      language: 'typescript',
      fileCategory: 'code',
      totalLines: 1,
      nonEmptyLines: 1,
      functions: [{ name: 'f', startLine: 1, endLine: 1, params: [] }],
      metrics: {},
    })),
    batchImportData: Object.fromEntries(paths.map((path) => [path, []])),
    neighborMap: {},
    sources: {},
    context: { languages: [], frameworks: [] },
  };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) removeDir(dir);
});

describe('chave comum dos checkpoints (SPEC 7.1)', () => {
  it('muda com fase, configuracao de geracao, input e hash dos artefatos consultados', () => {
    const input = batchCheckpointInput(batchInput(['a.ts']), new Map([['a.ts', 'h1']]));
    const base = checkpointKey('analysis', config, input, [{ path: 'b.ts', hash: 'x' }]);
    expect(checkpointKey('analysis', config, input, [{ path: 'b.ts', hash: 'x' }])).toBe(base);
    expect(checkpointKey('layers', config, input, [{ path: 'b.ts', hash: 'x' }])).not.toBe(base);
    expect(checkpointKey('analysis', { ...config, model: 'outro' }, input, [{ path: 'b.ts', hash: 'x' }])).not.toBe(
      base,
    );
    expect(checkpointKey('analysis', { ...config, effort: 'low' }, input, [{ path: 'b.ts', hash: 'x' }])).not.toBe(
      base,
    );
    expect(checkpointKey('analysis', config, input, [{ path: 'b.ts', hash: 'y' }])).not.toBe(base);
    const changedContent = batchCheckpointInput(batchInput(['a.ts']), new Map([['a.ts', 'h2']]));
    expect(checkpointKey('analysis', config, changedContent, [{ path: 'b.ts', hash: 'x' }])).not.toBe(base);
    expect(
      checkpointKey('analysis', config, input, [
        { path: 'b.ts', hash: 'x' },
        { path: 'c.ts', hash: 'z' },
      ]),
    ).not.toBe(base);
  });

  it('identidade do lote e o conjunto ordenado de caminhos', () => {
    expect(pathsIdentity(['b.ts', 'a.ts'])).toBe(pathsIdentity(['a.ts', 'b.ts']));
    expect(pathsIdentity(['a.ts'])).not.toBe(pathsIdentity(['a.ts', 'b.ts']));
  });
});

describe('loja de checkpoints: lote, fase global e plano de lotes', () => {
  it('grava e reaproveita um lote so quando a chave e a estrutura batem', async () => {
    const dir = makeTempDir();
    temps.push(dir);
    const store = createCheckpointStore(dir);
    const input = batchInput(['src/a.ts']);
    const key = checkpointKey('analysis', config, batchCheckpointInput(input, new Map([['src/a.ts', 'h']])));
    const identity = pathsIdentity(['src/a.ts']);
    expect(await store.readBatch(key, identity, input)).toBeNull();
    const graph = buildStructuralGraph(input);
    await store.writeBatch(key, identity, graph);
    const saved = await store.readBatch(key, identity, input);
    expect(saved?.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
    expect(await store.readBatch('outra', identity, input)).toBeNull();
    const other = batchInput(['src/a.ts']);
    other.extraction[0]!.functions = [{ name: 'g', startLine: 1, endLine: 1, params: [] }];
    expect(await store.readBatch(key, identity, other)).toBeNull();
  });

  it('poda 3 versoes por identidade de lote e 3 por fase global', async () => {
    const dir = makeTempDir();
    temps.push(dir);
    const store = createCheckpointStore(dir);
    const input = batchInput(['src/a.ts']);
    const identity = pathsIdentity(['src/a.ts']);
    const otherIdentity = pathsIdentity(['src/b.ts']);
    const graph = buildStructuralGraph(input);
    const batchDir = join(dir, ARCHMAP_AGENT_CACHE_DIR);
    for (let i = 0; i < 5; i += 1) {
      await store.writeBatch(`k${i}`, identity, graph);
      const name = readdirSync(batchDir).find((n) => n.endsWith(`-k${i}.json`))!;
      const when = new Date(Date.now() - (10 - i) * 60_000);
      utimesSync(join(batchDir, name), when, when);
    }
    await store.writeBatch('outro', otherIdentity, graph);
    const batchFiles = readdirSync(batchDir).filter((n) => n.startsWith('batch-'));
    expect(batchFiles.filter((n) => n.includes(identity.slice(0, 24)))).toHaveLength(3);
    expect(batchFiles.filter((n) => n.includes(otherIdentity.slice(0, 24)))).toHaveLength(1);
    expect(batchFiles.some((n) => n.endsWith('-k4.json'))).toBe(true);
    expect(batchFiles.some((n) => n.endsWith('-k0.json'))).toBe(false);

    const taskDir = join(dir, ARCHMAP_TASK_CACHE_DIR);
    for (let i = 0; i < 5; i += 1) {
      await store.writeTask('layers', `l${i}`, { layers: [i] });
      const when = new Date(Date.now() - (10 - i) * 60_000);
      utimesSync(join(taskDir, `layers-l${i}.json`), when, when);
    }
    await store.writeTask('tour', 't1', { steps: [] });
    const taskFiles = readdirSync(taskDir);
    expect(taskFiles.filter((n) => n.startsWith('layers-'))).toHaveLength(3);
    expect(taskFiles.filter((n) => n.startsWith('tour-'))).toHaveLength(1);
    expect(await store.readTask('layers', 'l4')).toEqual({ layers: [4] });
    expect(await store.readTask('layers', 'l0')).toBeNull();
    expect(await store.readTask('tour', 'l4')).toBeNull();
  });

  it('reaproveita o plano de lotes pela identidade do conjunto de caminhos', async () => {
    const dir = makeTempDir();
    temps.push(dir);
    const store = createCheckpointStore(dir);
    const plan: BatchPlan = {
      schemaVersion: 1,
      algorithm: 'louvain',
      totalFiles: 1,
      totalBatches: 1,
      exportsByPath: {},
      batches: [{ batchIndex: 1, files: batchInput(['a.ts']).files, batchImportData: {}, neighborMap: {} }],
      warnings: [],
    };
    const identity = pathsIdentity(['a.ts']);
    expect(await store.readBatchPlan(identity)).toBeNull();
    await store.writeBatchPlan(identity, plan);
    expect((await store.readBatchPlan(identity))?.batches).toHaveLength(1);
    expect(await store.readBatchPlan(pathsIdentity(['a.ts', 'b.ts']))).toBeNull();
  });
});

describe('S2-V5: preflight varre .tmp-* das pastas de checkpoint', () => {
  it('remove arquivos .tmp-* orfaos de agent-cache e agent-task-cache', async () => {
    const repo = makeTempDir();
    temps.push(repo);
    const dir = archmapDirPath(repo);
    const store = createCheckpointStore(dir);
    await store.writeTask('layers', 'k1', { layers: [] });
    const batchDir = join(dir, ARCHMAP_AGENT_CACHE_DIR);
    const taskDir = join(dir, ARCHMAP_TASK_CACHE_DIR);
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, '.tmp-orfao'), '{', 'utf8');
    writeFileSync(join(taskDir, '.tmp-orfao'), '{', 'utf8');
    const result = await preflightArchmapDir(repo);
    expect(result.removedTmp.length).toBe(2);
    expect(readdirSync(batchDir).some((n) => n.startsWith('.tmp-'))).toBe(false);
    expect(readdirSync(taskDir)).toEqual(['layers-k1.json']);
  });
});
