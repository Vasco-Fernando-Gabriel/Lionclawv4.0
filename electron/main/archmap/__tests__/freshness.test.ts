import { afterEach, describe, expect, it } from 'vitest';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHMAP_FRESHNESS_MEMO_MS,
  ARCHMAP_STALENESS_CAP,
  computeArchmapFreshness,
  createArchmapFreshnessService,
  type ArchmapFreshnessInput,
} from '../freshness';
import { GitTimeoutError, type GitOutcome, type GitRunner } from '../git';
import { makeTempDir, removeDir, writeFiles } from './helpers';

const INDEXED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LAST_ANALYZED_AT = new Date(Date.now() - 60_000).toISOString();

interface Script {
  head?: string | null;
  porcelain?: string[];
  commitExists?: boolean;
  diff?: string[];
  counts?: [number, number];
  timeout?: boolean;
}

function scriptedGit(script: Script, calls: string[] = []): GitRunner {
  return async (_root, args): Promise<GitOutcome> => {
    calls.push(args[0]!);
    if (script.timeout) return { ok: false, timeout: true, message: 'timeout' };
    switch (args[0]) {
      case 'rev-parse':
        return script.head === null
          ? { ok: false, timeout: false, message: 'not a git repo' }
          : { ok: true, stdout: `${script.head ?? INDEXED}\n` };
      case 'status':
        return { ok: true, stdout: (script.porcelain ?? []).map((path) => ` M ${path}\0`).join('') };
      case 'cat-file':
        return script.commitExists === false
          ? { ok: false, timeout: false, message: 'missing' }
          : { ok: true, stdout: '' };
      case 'diff':
        return { ok: true, stdout: (script.diff ?? []).map((path) => `${path}\0`).join('') };
      case 'rev-list': {
        const [ahead, behind] = script.counts ?? [0, 1];
        return { ok: true, stdout: `${ahead}\t${behind}\n` };
      }
      default:
        return { ok: true, stdout: '' };
    }
  };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) removeDir(dir);
});

function inputFor(root: string, over: Partial<ArchmapFreshnessInput> = {}): ArchmapFreshnessInput {
  return {
    repositoryId: 'r1',
    repoRoot: root,
    generation: 'gen-1',
    graphPresent: true,
    indexedCommit: INDEXED,
    lastAnalyzedAt: LAST_ANALYZED_AT,
    pendingFiles: [],
    mapPaths: new Set(['src/a.ts', 'src/b.ts']),
    changedDuringRun: [],
    ...over,
  };
}

function touch(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

describe('AC-14: badge nos quatro estados, com motivo', () => {
  it('HEAD igual, sem mudancas locais e sem pendentes = pronto', async () => {
    const root = makeTempDir();
    temps.push(root);
    writeFiles(root, { 'src/a.ts': 'a', 'src/b.ts': 'b' });
    const result = await computeArchmapFreshness(inputFor(root), scriptedGit({}));
    expect(result.status).toBe('fresh');
    expect(result.label).toBe('pronto');
    expect(result.localChanges).toBe(false);
    expect(result.headCommitHash).toBe(INDEXED);
  });

  it('HEAD diferente = desatualizado com o numero de arquivos e commits', async () => {
    const root = makeTempDir();
    temps.push(root);
    const result = await computeArchmapFreshness(
      inputFor(root),
      scriptedGit({ head: OTHER, diff: ['src/a.ts', 'src/c.ts'], counts: [0, 3] }),
    );
    expect(result.status).toBe('stale');
    expect(result.label).toBe('desatualizado');
    expect(result.reason).toContain('HEAD diferente');
    expect(result.reason).toContain('3 commit(s)');
    expect(result.changedFileCount).toBe(2);
    expect(result.commitsBehind).toBe(3);
    expect(result.relation).toBe('behind');
  });

  it('HEAD igual com mudanca local em arquivo do mapa (mtime > lastIndexedAt) = desatualizado por mudancas locais', async () => {
    const root = makeTempDir();
    temps.push(root);
    writeFiles(root, { 'src/a.ts': 'a', 'src/b.ts': 'b' });
    const result = await computeArchmapFreshness(inputFor(root), scriptedGit({ porcelain: ['src/a.ts'] }));
    expect(result.status).toBe('dirty');
    expect(result.label).toBe('desatualizado');
    expect(result.reason).toBe('mudancas locais em 1 arquivo(s) do mapa');
    expect(result.localChanges).toBe(true);
    expect(result.changedFiles).toEqual(['src/a.ts']);
  });

  it('mudanca local em arquivo fora do mapa ou anterior ao scan nao desatualiza', async () => {
    const root = makeTempDir();
    temps.push(root);
    writeFiles(root, { 'src/a.ts': 'a', 'notes.txt': 'n' });
    touch(join(root, 'src/a.ts'), 10 * 60_000);
    const outside = await computeArchmapFreshness(inputFor(root), scriptedGit({ porcelain: ['notes.txt'] }));
    expect(outside.status).toBe('fresh');
    const older = await computeArchmapFreshness(inputFor(root), scriptedGit({ porcelain: ['src/a.ts'] }));
    expect(older.status).toBe('fresh');
  });

  it('arquivo apagado localmente que esta no mapa conta como mudanca local', async () => {
    const root = makeTempDir();
    temps.push(root);
    writeFiles(root, { 'src/b.ts': 'b' });
    const result = await computeArchmapFreshness(inputFor(root), scriptedGit({ porcelain: ['src/a.ts'] }));
    expect(result.status).toBe('dirty');
    expect(result.changedFiles).toEqual(['src/a.ts']);
  });

  it('pendingFiles nao vazio = parcial, com o HEAD diferente no motivo quando houver', async () => {
    const root = makeTempDir();
    temps.push(root);
    const partial = await computeArchmapFreshness(
      inputFor(root, { pendingFiles: ['src/a.ts', 'src/b.ts'] }),
      scriptedGit({}),
    );
    expect(partial.status).toBe('partial');
    expect(partial.label).toBe('parcial');
    expect(partial.reason).toBe('2 arquivo(s) pendente(s) de analise');
    expect(partial.pendingFiles).toBe(2);
    const both = await computeArchmapFreshness(
      inputFor(root, { pendingFiles: ['src/a.ts'] }),
      scriptedGit({ head: OTHER, diff: ['src/a.ts'] }),
    );
    expect(both.status).toBe('partial');
    expect(both.reason).toContain('1 arquivo(s) pendente(s)');
    expect(both.reason).toContain('HEAD diferente');
  });

  it('commit indexado inexistente = desatualizado, relacao diverged', async () => {
    const root = makeTempDir();
    temps.push(root);
    const result = await computeArchmapFreshness(inputFor(root), scriptedGit({ head: OTHER, commitExists: false }));
    expect(result.status).toBe('stale');
    expect(result.relation).toBe('diverged');
    expect(result.reason).toContain('nao existe mais');
  });

  it('AC-8: arquivo em changedDuringRun editado depois do scan = desatualizado mesmo com porcelain vazio', async () => {
    const root = makeTempDir();
    temps.push(root);
    writeFiles(root, { 'src/a.ts': 'a' });
    const result = await computeArchmapFreshness(
      inputFor(root, { changedDuringRun: ['src/a.ts'] }),
      scriptedGit({ porcelain: [] }),
    );
    expect(result.status).toBe('dirty');
    expect(result.reason).toContain('mudancas locais');
  });

  it('S3-V7: porcelain acima do teto so desatualiza se intersectar o mapa; senao fica desconhecido com motivo', async () => {
    const root = makeTempDir();
    temps.push(root);
    const outside = Array.from({ length: ARCHMAP_STALENESS_CAP + 1 }, (_, i) => `x/${i}.txt`);
    const unknown = await computeArchmapFreshness(inputFor(root), scriptedGit({ porcelain: outside }));
    expect(unknown.status).toBe('unknown');
    expect(unknown.reason).toContain('fora do mapa');
    const inside = Array.from({ length: ARCHMAP_STALENESS_CAP + 1 }, (_, i) => `src/m${i}.ts`);
    const result = await computeArchmapFreshness(
      inputFor(root, { mapPaths: new Set(inside) }),
      scriptedGit({ porcelain: [...outside, ...inside] }),
    );
    expect(result.status).toBe('dirty');
    expect(result.reason).toContain(`mais de ${ARCHMAP_STALENESS_CAP} arquivo(s) do mapa`);
    expect(result.changedFileCount).toBe(ARCHMAP_STALENESS_CAP + 1);
    expect(result.changedFiles).toHaveLength(ARCHMAP_STALENESS_CAP);
    writeFileSync(join(root, 'src'), '');
    const few = await computeArchmapFreshness(
      inputFor(root, { mapPaths: new Set(['src/a.ts']) }),
      scriptedGit({ porcelain: [...outside, 'src/a.ts'] }),
    );
    expect(few.status).toBe('dirty');
    expect(few.changedFiles).toEqual(['src/a.ts']);
  });

  it('sem git = desconhecido (nao desatualizado); mapa ausente = desconhecido', async () => {
    const root = makeTempDir();
    temps.push(root);
    const noGit = await computeArchmapFreshness(inputFor(root), scriptedGit({ head: null }));
    expect(noGit.status).toBe('unknown');
    expect(noGit.label).toBe('desconhecido');
    const absent = await computeArchmapFreshness(inputFor(root, { graphPresent: false }), scriptedGit({}));
    expect(absent.reason).toBe('mapa ausente');
  });

  it('git que nao responde propaga GitTimeoutError (vira "git nao respondeu" no status)', async () => {
    const root = makeTempDir();
    temps.push(root);
    await expect(computeArchmapFreshness(inputFor(root), scriptedGit({ timeout: true }))).rejects.toBeInstanceOf(
      GitTimeoutError,
    );
    const service = createArchmapFreshnessService({ git: scriptedGit({ timeout: true }) });
    await expect(service.compute(inputFor(root))).rejects.toBeInstanceOf(GitTimeoutError);
  });
});

describe('cache de 5 minutos por repositorio', () => {
  it('reusa o resultado dentro da janela, recalcula apos invalidar, muda de geracao ou vencer o prazo', async () => {
    const root = makeTempDir();
    temps.push(root);
    writeFileSync(join(root, 'a.ts'), 'a');
    const calls: string[] = [];
    let now = 1_000_000;
    const service = createArchmapFreshnessService({ git: scriptedGit({}, calls), now: () => now });
    const first = await service.compute(inputFor(root));
    expect(first.status).toBe('fresh');
    const gitCallsAfterFirst = calls.length;
    expect(gitCallsAfterFirst).toBeGreaterThan(0);
    await service.compute(inputFor(root));
    expect(calls.length).toBe(gitCallsAfterFirst);
    service.invalidate('r1');
    await service.compute(inputFor(root));
    expect(calls.length).toBeGreaterThan(gitCallsAfterFirst);
    const afterInvalidate = calls.length;
    await service.compute(inputFor(root, { generation: 'gen-2' }));
    expect(calls.length).toBeGreaterThan(afterInvalidate);
    const afterGeneration = calls.length;
    now += ARCHMAP_FRESHNESS_MEMO_MS + 1;
    await service.compute(inputFor(root, { generation: 'gen-2' }));
    expect(calls.length).toBeGreaterThan(afterGeneration);
    service.forget('r1');
  });
});
