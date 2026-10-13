import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ArchmapStatusEvent } from '../../../../src/types/archmap';
import { ARCHMAP_MAX_FILES, createArchmapEngine, estimateMinutes, type ArchmapEngine } from '../engine';
import { ArchmapBusyError, ArchmapCancelledError, ArchmapDisabledError, ArchmapTooLargeError } from '../errors';
import { hasTmpFiles, writeGeneration } from '../generation';
import { archmapDirPath } from '../state';
import { createPipelineWorker, type PipelineWorker } from '../pipeline/worker-client';
import {
  fakeGit,
  inProcessWorker,
  makeLargeRepo,
  makeSmallRepo,
  memoryArchmapRepository,
  removeDir,
  repoRecord,
  sampleGraph,
} from './helpers';

const REAL_REPO = process.env.ARCHMAP_REAL_REPO ?? '';
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const BUNDLE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'lionclaw-archmap-tests');
const BUNDLE_FILE = join(BUNDLE_DIR, 'archmap-worker.mjs');

let bundleReady = false;

async function buildWorkerBundle(): Promise<void> {
  const esbuild = (await import('esbuild')) as typeof import('esbuild');
  mkdirSync(BUNDLE_DIR, { recursive: true });
  await esbuild.build({
    entryPoints: [join(REPO_ROOT, 'electron', 'main', 'archmap', 'pipeline', 'worker.ts')],
    outfile: BUNDLE_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  });
  bundleReady = true;
}

function realWorker(): PipelineWorker {
  return createPipelineWorker({
    entry: BUNDLE_FILE,
    grammarsDir: join(REPO_ROOT, 'electron', 'main', 'archmap', 'core', 'grammars'),
  });
}

const settings = (overrides: Record<string, string> = {}) => {
  const values: Record<string, string> = {
    archmap_enabled: 'true',
    archmap_max_parallel_repos: '2',
    archmap_batch_parallelism: '5',
    ...overrides,
  };
  return (key: string) => values[key];
};

interface Harness {
  engine: ArchmapEngine;
  events: ArchmapStatusEvent[];
  repository: ReturnType<typeof memoryArchmapRepository>;
}

function makeEngine(
  repos: Record<string, string>,
  options: {
    worker?: () => PipelineWorker;
    head?: string | null;
    getSetting?: (key: string) => string | undefined;
  } = {},
): Harness {
  const records = Object.fromEntries(Object.entries(repos).map(([id, root]) => [id, repoRecord(id, root)]));
  const repository = memoryArchmapRepository(Object.keys(repos));
  const events: ArchmapStatusEvent[] = [];
  const engine = createArchmapEngine({
    repository,
    getLocalRepository: (id) => records[id] ?? null,
    getSetting: options.getSetting ?? settings(),
    emit: (event) => events.push(event),
    createWorker: options.worker ?? inProcessWorker,
    git: fakeGit(options.head ?? null),
    emitThrottleMs: 0,
  });
  return { engine, events, repository };
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) removeDir(dir);
});

describe('estimativa sem LLM (scan -> lotes -> minutos)', () => {
  it('devolve arquivos, lotes e minutos para um repo pequeno e nao escreve no repo', async () => {
    const root = makeSmallRepo();
    temps.push(root);
    const { engine, events } = makeEngine({ r1: root });
    const result = await engine.estimate('r1', {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
    expect(result.fileCount).toBe(8);
    expect(result.batchCount).toBeGreaterThan(0);
    expect(result.estimatedMinutes).toBe(estimateMinutes(result.batchCount, 5));
    expect(result.runtime).toBe('cloud');
    expect(result.model).toBe('claude-opus-5-5');
    expect(existsSync(join(root, '.lionclaw'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(events.at(-1)).toEqual({ repositoryId: 'r1' });
    expect(engine.hasActive('r1')).toBe(false);
  });

  it('recusa quando archmap_enabled = false', async () => {
    const root = makeSmallRepo();
    temps.push(root);
    const { engine } = makeEngine({ r1: root }, { getSetting: settings({ archmap_enabled: 'false' }) });
    await expect(engine.estimate('r1')).rejects.toBeInstanceOf(ArchmapDisabledError);
  });

  it('AC-4: repo com mais de 3000 arquivos apos filtros recebe recusa clara antes de qualquer LLM', async () => {
    const root = makeLargeRepo(ARCHMAP_MAX_FILES + 5);
    temps.push(root);
    const { engine } = makeEngine({ r1: root });
    const error = await engine.estimate('r1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ArchmapTooLargeError);
    expect((error as ArchmapTooLargeError).fileCount).toBe(ARCHMAP_MAX_FILES + 5);
    expect((error as ArchmapTooLargeError).message).toContain('3000');
    expect((error as ArchmapTooLargeError).message).toContain('archmap.ignore');
  }, 60_000);

  it('uma estimativa por repositorio por vez (RM4)', async () => {
    const root = makeLargeRepo(400);
    temps.push(root);
    const { engine } = makeEngine({ r1: root });
    const first = engine.estimate('r1');
    await expect(engine.estimate('r1')).rejects.toBeInstanceOf(ArchmapBusyError);
    await first;
  }, 60_000);
});

describe('status do mapa por repositorio', () => {
  it('absent sem geracao; ready com geracao no HEAD; stale com HEAD diferente; partial com pendentes', async () => {
    const root = makeSmallRepo();
    temps.push(root);
    const head = 'a1b2c3d4';
    const { engine, repository } = makeEngine({ r1: root }, { head });
    expect((await engine.status('r1')).status).toBe('absent');
    const scan = (await inProcessWorker().scan({ projectPath: root, scanStartedAt: new Date().toISOString() })).scan;
    const meta = {
      lastAnalyzedAt: new Date().toISOString(),
      gitCommitHash: head,
      analyzedFiles: scan.files.length,
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'm',
      lionClawVersion: '4.0.0',
    };
    await writeGeneration({
      repoRoot: root,
      runId: 'run-1',
      graph: sampleGraph(head, ['src/index.ts']),
      fingerprints: {},
      scan,
      meta,
    });
    const ready = await engine.status('r1');
    expect(ready.status).toBe('ready');
    expect(ready.indexedCommit).toBe(head);
    expect(ready.stats?.fileCount).toBe(1);
    expect(repository.getState('r1')?.indexedCommit).toBe(head);

    const other = makeEngine({ r1: root }, { head: 'ffffffff' });
    expect((await other.engine.status('r1')).status).toBe('stale');

    await writeGeneration({
      repoRoot: root,
      runId: 'run-2',
      graph: sampleGraph(head, ['src/index.ts']),
      fingerprints: {},
      scan,
      meta: { ...meta, partial: true, pendingFiles: ['src/math.ts'] },
    });
    const partial = await engine.status('r1');
    expect(partial.status).toBe('partial');
    expect(partial.pendingFiles).toBe(1);
  });

  it('git que nao responde no status vira erro "git nao respondeu", nunca pronto', async () => {
    const root = makeSmallRepo();
    temps.push(root);
    const head = 'a1b2c3d4';
    const scan = (await inProcessWorker().scan({ projectPath: root, scanStartedAt: new Date().toISOString() })).scan;
    await writeGeneration({
      repoRoot: root,
      runId: 'run-1',
      graph: sampleGraph(head, ['src/index.ts']),
      fingerprints: {},
      scan,
      meta: {
        lastAnalyzedAt: new Date().toISOString(),
        gitCommitHash: head,
        analyzedFiles: 1,
        runtime: 'cloud',
        provider: 'anthropic',
        model: 'm',
        lionClawVersion: '4.0.0',
      },
    });
    const records = { r1: repoRecord('r1', root) };
    const engine = createArchmapEngine({
      repository: memoryArchmapRepository(['r1']),
      getLocalRepository: (id) => records[id as 'r1'] ?? null,
      getSetting: settings(),
      createWorker: inProcessWorker,
      git: fakeGit(head, { timeout: true }),
    });
    const status = await engine.status('r1');
    expect(status.status).toBe('error');
    expect(status.error).toBe('git nao respondeu');
    expect(status.stats?.fileCount).toBe(1);
  });

  it('erro quando a ultima rodada falhou e nao ha grafo', async () => {
    const root = makeSmallRepo();
    temps.push(root);
    const { engine, repository } = makeEngine({ r1: root });
    const run = repository.createRun({
      repositoryId: 'r1',
      kind: 'build',
      runtime: 'cloud',
      provider: 'a',
      model: 'm',
    });
    repository.finishRun(run.id, { status: 'error', error: 'boom' });
    const status = await engine.status('r1');
    expect(status.status).toBe('error');
    expect(status.lastRun?.error).toBe('boom');
  });

  it('preflight garante o .gitignore, cria a pasta e limpa .tmp-* (AC-3)', async () => {
    const root = makeSmallRepo();
    temps.push(root);
    const { engine } = makeEngine({ r1: root }, { head: 'abc' });
    const first = await engine.preflight('r1');
    expect(first.gitignoreChanged).toBe(true);
    expect(first.head0).toBe('abc');
    expect(existsSync(archmapDirPath(root))).toBe(true);
    const second = await engine.preflight('r1');
    expect(second.gitignoreChanged).toBe(false);
    expect(await hasTmpFiles(root)).toBe(false);
  });
});

describe('worker real em worker_threads (bundle esbuild do pipeline/worker.ts)', () => {
  beforeAll(async () => {
    await buildWorkerBundle();
  }, 120_000);

  afterAll(() => {
    bundleReady = false;
  });

  it('scan e lotes no worker; cancelar durante o scan encerra em ate 10 s sem .tmp-* (AC-5)', async () => {
    expect(bundleReady).toBe(true);
    const root = makeLargeRepo(1500);
    temps.push(root);
    let worker: PipelineWorker | null = null;
    const { engine, events } = makeEngine(
      { r1: root },
      {
        worker: () => {
          worker = realWorker();
          return worker;
        },
      },
    );
    const started = Date.now();
    const pending = engine.estimate('r1');
    await new Promise<void>((resolveWait, rejectWait) => {
      const deadline = setTimeout(() => rejectWait(new Error('sem progresso do scan')), 60_000);
      const tick = () => {
        if (events.some((event) => event.progress?.phase === 'scan')) {
          clearTimeout(deadline);
          resolveWait();
        } else setTimeout(tick, 5);
      };
      tick();
    });
    expect(engine.cancel('r1')).toEqual({ cancelled: true });
    const cancelledAt = Date.now();
    await expect(pending).rejects.toBeInstanceOf(ArchmapCancelledError);
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    expect(worker!.dead).toBe(true);
    expect(engine.hasActive('r1')).toBe(false);
    expect(engine.cancel('r1')).toEqual({ cancelled: false });
    expect(existsSync(join(root, '.lionclaw'))).toBe(false);
    expect(await hasTmpFiles(root)).toBe(false);
    expect(Date.now() - started).toBeLessThan(70_000);
  }, 90_000);

  it('scan completo no worker real devolve os mesmos numeros do worker em processo', async () => {
    expect(bundleReady).toBe(true);
    const root = makeSmallRepo();
    temps.push(root);
    const real = makeEngine({ r1: root }, { worker: realWorker });
    const local = makeEngine({ r1: root });
    const [a, b] = await Promise.all([real.engine.estimate('r1'), local.engine.estimate('r1')]);
    expect(a.fileCount).toBe(b.fileCount);
    expect(a.batchCount).toBe(b.batchCount);
  }, 60_000);

  it.skipIf(!REAL_REPO || !existsSync(REAL_REPO))(
    'AC-2: estimativa de um repositorio real em menos de 30 s, sem LLM e sem escrever no repo',
    async () => {
      expect(bundleReady).toBe(true);
      const before = readdirSync(REAL_REPO).sort();
      const gitignoreBefore = existsSync(join(REAL_REPO, '.gitignore'))
        ? statSync(join(REAL_REPO, '.gitignore')).mtimeMs
        : null;
      const { engine } = makeEngine({ realRepo: REAL_REPO }, { worker: realWorker });
      const started = Date.now();
      const result = await engine.estimate('realRepo', {
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(30_000);
      expect(result.fileCount).toBeGreaterThanOrEqual(1100);
      expect(result.fileCount).toBeLessThanOrEqual(1400);
      expect(result.batchCount).toBeGreaterThan(10);
      expect(result.estimatedMinutes).toBeGreaterThan(2);
      expect(readdirSync(REAL_REPO).sort()).toEqual(before);
      const gitignoreAfter = existsSync(join(REAL_REPO, '.gitignore'))
        ? statSync(join(REAL_REPO, '.gitignore')).mtimeMs
        : null;
      expect(gitignoreAfter).toBe(gitignoreBefore);
    },
    45_000,
  );
});
