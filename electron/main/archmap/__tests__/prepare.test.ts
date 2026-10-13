import { describe, expect, it } from 'vitest';
import type { FileFingerprint } from '../core';
import { ARCHMAP_SCHEMA_VERSION, type ScanFile, type ScanResult } from '../pipeline/types';
import {
  ARCHITECTURE_RATIO,
  FULL_UPDATE_RATIO,
  HUB_MIN_FILES,
  hubPaths,
  isManifestPath,
  prepareUpdate,
  previewOf,
  topDirectories,
  tsconfigManifestPaths,
  type PrepareInput,
} from '../pipeline/prepare';

interface FpOptions {
  hash?: string;
  structural?: boolean;
  functions?: string[];
  imports?: string[];
}

function fp(path: string, options: FpOptions = {}): FileFingerprint {
  const structural = options.structural ?? /\.(ts|tsx|js|py|go)$/.test(path);
  return {
    filePath: path,
    contentHash: options.hash ?? `hash-${path}`,
    functions: (options.functions ?? (structural ? ['fn'] : [])).map((name) => ({
      name,
      params: [],
      exported: true,
      lineCount: 3,
    })),
    classes: [],
    imports: (options.imports ?? []).map((source) => ({ source, specifiers: ['x'] })),
    exports: structural ? ['fn'] : [],
    totalLines: 10,
    hasStructuralAnalysis: structural,
  };
}

function scanFile(path: string): ScanFile {
  const ext = path.slice(path.lastIndexOf('.'));
  const language = ext === '.ts' ? 'typescript' : ext === '.md' ? 'markdown' : ext === '.json' ? 'json' : 'yaml';
  const fileCategory = ext === '.ts' ? 'code' : ext === '.md' ? 'docs' : 'config';
  return { path, language, sizeLines: 10, sizeBytes: 100, fileCategory };
}

function scanOf(paths: string[], importMap: Record<string, string[]> = {}): ScanResult {
  return {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    scanStartedAt: '2026-10-09T00:00:00.000Z',
    contentDigest: 'd',
    files: paths.map(scanFile),
    totalFiles: paths.length,
    filteredByIgnore: 0,
    importMap,
    stats: { byCategory: {}, byLanguage: {} },
    warnings: [],
  };
}

function baseInput(over: Partial<PrepareInput> = {}): PrepareInput {
  return {
    hasGit: true,
    metaValid: true,
    graphValid: true,
    indexedCommitExists: true,
    previousPaths: [],
    previousFingerprints: {},
    previousImportMap: {},
    currentScan: scanOf([]),
    currentFingerprints: {},
    ...over,
  };
}

function withFiles(
  previous: Record<string, FileFingerprint>,
  current: Record<string, FileFingerprint>,
  over: Partial<PrepareInput> = {},
): PrepareInput {
  return baseInput({
    previousPaths: Object.keys(previous),
    previousFingerprints: previous,
    currentScan: scanOf(Object.keys(current), over.currentScan?.importMap ?? {}),
    currentFingerprints: current,
    ...over,
  });
}

function tsFiles(count: number, prefix = 'src/mod'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${Math.floor(i / 50)}/f${i}.ts`);
}

describe('AC-12: percentual estrutural decide ARCHITECTURE (25-50%) ou FULL (> 50%); o teto de 90 nao existe', () => {
  const total = 1228;
  const paths = tsFiles(total);
  const previous = Object.fromEntries(paths.map((path) => [path, fp(path)]));

  it('1.616 arquivos alterados de 1.228 com 400 estruturais (32%) classifica ARCHITECTURE_UPDATE, nao FULL', () => {
    const current: Record<string, FileFingerprint> = {};
    paths.forEach((path, index) => {
      if (index < 400) current[path] = fp(path, { hash: `novo-${path}`, functions: ['fn', 'extra'] });
      else if (index < 1200) current[path] = fp(path, { hash: `cosmetico-${path}` });
      else current[path] = previous[path]!;
    });
    const docs = Array.from({ length: 416 }, (_, i) => `src/docs/novo-${i}.md`);
    for (const path of docs) current[path] = fp(path, { structural: false });
    const result = prepareUpdate(withFiles(previous, current));
    expect(result.newFiles + result.cosmeticFiles + result.structuralPaths.length).toBe(1616);
    expect(result.filesToReanalyzeList).toEqual(expect.arrayContaining(docs));
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.reason).toBeUndefined();
    expect(result.structuralCount).toBe(400);
    expect(result.totalFiles).toBe(total);
    expect(result.structuralRatio).toBeGreaterThanOrEqual(ARCHITECTURE_RATIO);
    expect(result.structuralRatio).toBeLessThanOrEqual(FULL_UPDATE_RATIO);
    expect(result.triggers).toEqual(['structural_ratio']);
    expect(result.filesToReanalyze).toBe(400 + 416);
    expect(result.newFiles).toBe(416);
    expect(result.nonStructuralFiles).toBe(0);
    expect(result.cosmeticFiles).toBe(800);
    expect(result.rerunLayers).toBe(true);
    expect(result.rerunTour).toBe(true);
    expect(result.detail).toContain('400 de 1228');
  });

  it('S3-V1: dado real de um repositorio real (353 novos, 325 removidos, 409 modificados) e ARCHITECTURE, nao FULL', () => {
    const current: Record<string, FileFingerprint> = {};
    const previousReal: Record<string, FileFingerprint> = {};
    paths.forEach((path, index) => {
      const structural = !(index >= 179 && index < 325) && !(index >= 1095 && index < 1177);
      previousReal[path] = fp(path, { structural });
      if (index < 325) return;
      if (index < 734) current[path] = fp(path, { hash: `novo-${path}`, functions: ['fn', 'g'] });
      else if (index < 1095) current[path] = fp(path, { hash: `cosmetico-${path}` });
      else if (index < 1177) current[path] = fp(path, { hash: `md-${path}`, structural: false });
      else current[path] = previousReal[path]!;
    });
    for (let i = 0; i < 353; i += 1) {
      const path = `src/mod${i % 25}/novo-${i}.${i < 314 ? 'ts' : 'md'}`;
      current[path] = fp(path);
    }
    const result = prepareUpdate(withFiles(previousReal, current));
    expect(result.deletedFiles).toBe(325);
    expect(result.newFiles).toBe(353);
    expect(result.structuralPaths).toHaveLength(409);
    expect(result.cosmeticFiles).toBe(361);
    expect(result.nonStructuralFiles).toBe(82);
    expect(result.structuralCount).toBe(409 + 179);
    expect(result.totalFiles).toBe(1228);
    expect(result.threshold).toBe(614);
    expect(result.structuralRatio).toBeLessThan(FULL_UPDATE_RATIO);
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.reason).toBeUndefined();
    expect(result.triggers).toContain('structural_ratio');
    expect(result.filesToReanalyze).toBe(409 + 82 + 353);
  });

  it('arquivos novos nunca entram no numerador: 600 novos com gramatica em 100 do grafo continua PARTIAL', () => {
    const small = tsFiles(100, 'src/g');
    const prev = Object.fromEntries(small.map((path) => [path, fp(path)]));
    const current = { ...prev };
    for (let i = 0; i < 600; i += 1) current[`src/g0/n${i}.ts`] = fp(`src/g0/n${i}.ts`);
    const result = prepareUpdate(withFiles(prev, current));
    expect(result.structuralCount).toBe(0);
    expect(result.newFiles).toBe(600);
    expect(result.filesToReanalyze).toBe(600);
    expect(result.action).toBe('PARTIAL_UPDATE');
  });

  it('700 estruturais (57%) pede FULL com motivo too_many_changes, contagem e limite', () => {
    const current: Record<string, FileFingerprint> = {};
    paths.forEach((path, index) => {
      current[path] = index < 700 ? fp(path, { hash: `novo-${path}`, functions: ['fn', 'g'] }) : previous[path]!;
    });
    const result = prepareUpdate(withFiles(previous, current));
    expect(result.action).toBe('FULL_UPDATE');
    expect(result.reason).toBe('too_many_changes');
    expect(result.structuralCount).toBe(700);
    expect(result.threshold).toBe(614);
    expect(result.detail).toContain('700 de 1228');
    expect(result.detail).toContain('limite de 50% (614)');
    const preview = previewOf(result);
    expect(preview.action).toBe('FULL_UPDATE');
    expect(preview.structuralCount).toBe(700);
    expect(preview.threshold).toBe(614);
  });

  it('91 estruturais em 1.228 (7%) e PARTIAL: o teto absoluto de 90 nao existe', () => {
    const current: Record<string, FileFingerprint> = {};
    paths.forEach((path, index) => {
      current[path] = index < 91 ? fp(path, { hash: `novo-${path}`, functions: ['fn', 'g'] }) : previous[path]!;
    });
    const result = prepareUpdate(withFiles(previous, current));
    expect(result.action).toBe('PARTIAL_UPDATE');
    expect(result.filesToReanalyze).toBe(91);
  });

  it('exatamente 50% nao e FULL; um a mais e', () => {
    const small = tsFiles(10, 'src/a');
    const prev = Object.fromEntries(small.map((path) => [path, fp(path)]));
    const change = (n: number) =>
      Object.fromEntries(
        small.map((path, index) => [
          path,
          index < n ? fp(path, { hash: `n-${path}`, functions: ['fn', 'g'] }) : prev[path]!,
        ]),
      );
    expect(prepareUpdate(withFiles(prev, change(5))).action).toBe('ARCHITECTURE_UPDATE');
    expect(prepareUpdate(withFiles(prev, change(6))).action).toBe('FULL_UPDATE');
  });
});

describe('AC-13: arquivos sem gramatica, manifests e hubs', () => {
  it('so md/json/yaml alterados nunca empurram para FULL e cada um e reanotado', () => {
    const docs = ['README.md', 'docs/a.md', 'docs/b.md', 'config/app.yaml', 'config/x.json', 'data/y.json'];
    const code = ['src/a.ts', 'src/b.ts'];
    const previous = Object.fromEntries([...docs, ...code].map((path) => [path, fp(path)]));
    const current = { ...previous };
    for (const path of docs) current[path] = fp(path, { hash: `novo-${path}` });
    const result = prepareUpdate(withFiles(previous, current));
    expect(result.action).toBe('PARTIAL_UPDATE');
    expect(result.structuralCount).toBe(0);
    expect(result.structuralRatio).toBe(0);
    expect(result.nonStructuralPaths.sort()).toEqual([...docs].sort());
    expect(result.filesToReanalyzeList).toEqual([...docs].sort());
    expect(result.rerunLayers).toBe(false);
  });

  it('so package.json alterado classifica ARCHITECTURE pelo gatilho de manifest, abaixo de 25%', () => {
    const code = tsFiles(40);
    const previous = Object.fromEntries([...code, 'package.json'].map((path) => [path, fp(path)]));
    const current = { ...previous, 'package.json': fp('package.json', { hash: 'deps-mudaram' }) };
    const result = prepareUpdate(withFiles(previous, current));
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.triggers).toEqual(['manifest']);
    expect(result.manifestFiles).toEqual(['package.json']);
    expect(result.structuralCount).toBe(0);
    expect(result.filesToReanalyzeList).toEqual(['package.json']);
    expect(result.rerunLayers).toBe(true);
    expect(result.rerunTour).toBe(true);
  });

  it('manifest novo ou removido tambem dispara o gatilho e nao conta no percentual', () => {
    const code = tsFiles(20);
    const previous = Object.fromEntries([...code, 'apps/web/package.json'].map((path) => [path, fp(path)]));
    const current = { ...previous };
    delete current['apps/web/package.json'];
    current['Dockerfile.prod'] = fp('Dockerfile.prod', { structural: false });
    const result = prepareUpdate(withFiles(previous, current));
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.triggers).toContain('manifest');
    expect(result.manifestFiles).toEqual(['Dockerfile.prod', 'apps/web/package.json']);
    expect(result.structuralCount).toBe(0);
    expect(result.filesToReanalyzeList).toContain('Dockerfile.prod');
    expect(result.filesToReanalyzeList).not.toContain('apps/web/package.json');
  });

  it('S3-V2: manifest pendente da geracao anterior dispara o gatilho de manifest', () => {
    const code = tsFiles(10);
    const previous = Object.fromEntries([...code, 'package.json'].map((path) => [path, fp(path)]));
    const result = prepareUpdate(withFiles(previous, previous, { previousPending: ['package.json'] }));
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.triggers).toEqual(['manifest']);
    expect(result.pendingPaths).toEqual(['package.json']);
    expect(result.filesToReanalyzeList).toEqual(['package.json']);
  });

  it('S3-V6: hub sem gramatica alterado tambem dispara o gatilho de hub', () => {
    const code = tsFiles(20, 'src/m');
    const hub = 'src/data/schema.json';
    const previous = Object.fromEntries([...code, hub].map((path) => [path, fp(path)]));
    const importMap: Record<string, string[]> = {};
    for (const path of code.slice(0, 15)) importMap[path] = [hub];
    const current = { ...previous, [hub]: fp(hub, { hash: 'novo', structural: false }) };
    const result = prepareUpdate(withFiles(previous, current, { previousImportMap: importMap }));
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.triggers).toEqual(['hub']);
    expect(result.hubFiles).toEqual([hub]);
    expect(result.nonStructuralPaths).toEqual([hub]);
    expect(result.structuralCount).toBe(0);
  });

  it('mudanca estrutural num arquivo hub classifica ARCHITECTURE mesmo com 1 de 20 arquivos (5%)', () => {
    const code = tsFiles(20, 'src/m');
    const hub = 'src/core.ts';
    const previous = Object.fromEntries([...code, hub].map((path) => [path, fp(path)]));
    const importMap: Record<string, string[]> = {};
    for (const path of code.slice(0, 15)) importMap[path] = [hub];
    const current = { ...previous, [hub]: fp(hub, { hash: 'novo', functions: ['fn', 'novaFn'] }) };
    const result = prepareUpdate(withFiles(previous, current, { previousImportMap: importMap }));
    expect(result.action).toBe('ARCHITECTURE_UPDATE');
    expect(result.triggers).toEqual(['hub']);
    expect(result.hubFiles).toEqual([hub]);
    expect(result.structuralCount).toBe(1);
    expect(result.structuralRatio).toBeLessThan(ARCHITECTURE_RATIO);
  });

  it('a mesma mudanca num arquivo que nao e hub fica PARTIAL', () => {
    const code = tsFiles(20, 'src/m');
    const hub = 'src/core.ts';
    const leaf = code[19]!;
    const previous = Object.fromEntries([...code, hub].map((path) => [path, fp(path)]));
    const importMap: Record<string, string[]> = {};
    for (const path of code.slice(0, 15)) importMap[path] = [hub];
    const current = { ...previous, [leaf]: fp(leaf, { hash: 'novo', functions: ['fn', 'novaFn'] }) };
    const result = prepareUpdate(withFiles(previous, current, { previousImportMap: importMap }));
    expect(result.action).toBe('PARTIAL_UPDATE');
    expect(result.triggers).toEqual([]);
  });

  it('mudanca so cosmetica e SKIP com fingerprint mantido; nada mudou e SKIP', () => {
    const previous = { 'src/a.ts': fp('src/a.ts'), 'src/b.ts': fp('src/b.ts') };
    const current = { ...previous, 'src/a.ts': fp('src/a.ts', { hash: 'cosmetico' }) };
    const cosmetic = prepareUpdate(withFiles(previous, current));
    expect(cosmetic.action).toBe('SKIP');
    expect(cosmetic.cosmeticPaths).toEqual(['src/a.ts']);
    expect(cosmetic.filesToReanalyze).toBe(0);
    expect(cosmetic.detail).toContain('so cosmetica');
    const same = prepareUpdate(withFiles(previous, previous));
    expect(same.action).toBe('SKIP');
    expect(same.detail).toContain('nenhuma mudanca');
  });

  it('diretorio de topo criado ou removido dispara ARCHITECTURE', () => {
    const previous = Object.fromEntries(tsFiles(10, 'src/t').map((path) => [path, fp(path)]));
    const added = prepareUpdate(withFiles(previous, { ...previous, 'lib/x.ts': fp('lib/x.ts') }));
    expect(added.action).toBe('ARCHITECTURE_UPDATE');
    expect(added.triggers).toEqual(['top_directory']);
    const noDir = prepareUpdate(withFiles(previous, { ...previous, 'src/d.ts': fp('src/d.ts') }));
    expect(noDir.action).toBe('PARTIAL_UPDATE');
  });
});

describe('7.3: pendentes e arquivos sem procedencia voltam como alterados sem contar para FULL', () => {
  it('pendentes da geracao anterior e caminhos sem contentHash entram em filesToReanalyze com estrutural 0', () => {
    const paths = tsFiles(10, 'src/p');
    const previous = Object.fromEntries(paths.map((path) => [path, fp(path)]));
    delete previous[paths[9]!];
    const current = Object.fromEntries(paths.map((path) => [path, fp(path)]));
    const result = prepareUpdate(
      withFiles(previous, current, { previousPaths: paths, previousPending: [paths[0]!, paths[1]!] }),
    );
    expect(result.action).toBe('PARTIAL_UPDATE');
    expect(result.pendingPaths.sort()).toEqual([paths[0]!, paths[1]!, paths[9]!].sort());
    expect(result.structuralCount).toBe(0);
    expect(result.filesToReanalyze).toBe(3);
  });

  it('todos pendentes (fingerprints ausente) e PARTIAL grande, nunca FULL', () => {
    const paths = tsFiles(200, 'src/q');
    const current = Object.fromEntries(paths.map((path) => [path, fp(path)]));
    const result = prepareUpdate(
      baseInput({
        previousPaths: paths,
        previousFingerprints: null,
        currentScan: scanOf(paths),
        currentFingerprints: current,
      }),
    );
    expect(result.action).toBe('PARTIAL_UPDATE');
    expect(result.pendingFiles).toBe(200);
    expect(result.structuralCount).toBe(0);
  });
});

describe('7.4: motivos de FULL sao so os quatro da SPEC; baseline_missing nao existe', () => {
  const previous = { 'src/a.ts': fp('src/a.ts') };
  it.each([
    [{ graphValid: false }, 'graph_invalid'],
    [{ hasGit: false }, 'no_git'],
    [{ metaValid: false }, 'meta_invalid'],
    [{ indexedCommitExists: false }, 'indexed_commit_missing'],
  ] as const)('%o => %s', (over, reason) => {
    const result = prepareUpdate(withFiles(previous, previous, over));
    expect(result.action).toBe('FULL_UPDATE');
    expect(result.reason).toBe(reason);
  });

  it('commit indexado nao verificavel (null) nao forca FULL', () => {
    const result = prepareUpdate(withFiles(previous, previous, { indexedCommitExists: null }));
    expect(result.action).toBe('SKIP');
  });
});

describe('utilitarios: manifests, tsconfig com paths, hubs e diretorios de topo', () => {
  it('isManifestPath reconhece a lista da SPEC em qualquer profundidade', () => {
    for (const path of [
      'package.json',
      'apps/x/package.json',
      'pnpm-workspace.yaml',
      'go.mod',
      'pyproject.toml',
      'Cargo.toml',
      '.github/workflows/ci.yml',
      'Dockerfile',
      'docker/Dockerfile.dev',
      'docker-compose.yml',
      'deploy/docker-compose.prod.yaml',
    ]) {
      expect(isManifestPath(path)).toBe(true);
    }
    for (const path of ['src/package.ts', 'docs/go.md', 'tsconfig.json', 'README.md']) {
      expect(isManifestPath(path)).toBe(false);
    }
    expect(isManifestPath('tsconfig.json', new Set(['tsconfig.json']))).toBe(true);
  });

  it('tsconfigManifestPaths inclui tsconfig*.json com paths e os ilegiveis', () => {
    const texts: Record<string, string> = {
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
      'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }',
    };
    const out = tsconfigManifestPaths(
      ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.old.json', 'src/a.ts'],
      (path) => texts[path] ?? null,
    );
    expect([...out].sort()).toEqual(['tsconfig.json', 'tsconfig.old.json']);
  });

  it('hubPaths devolve os 5% de maior grau de entrada, minimo 5, so com grau > 0', () => {
    const files = tsFiles(100, 'src/h');
    const importMap: Record<string, string[]> = {};
    for (const [index, path] of files.entries()) {
      importMap[path] = [files[(index + 1) % 100]!];
      if (index < 60) importMap[path]!.push('src/h0/f0.ts');
      if (index < 30) importMap[path]!.push('src/h0/f1.ts');
    }
    const hubs = hubPaths(importMap, files);
    expect(hubs).toHaveLength(HUB_MIN_FILES);
    expect(hubs[0]).toBe('src/h0/f0.ts');
    expect(hubs[1]).toBe('src/h0/f1.ts');
    const few = hubPaths({ 'a.ts': ['b.ts'] }, ['a.ts', 'b.ts', 'c.ts']);
    expect(few).toEqual(['b.ts']);
  });

  it('topDirectories ignora arquivos na raiz', () => {
    expect([...topDirectories(['README.md', 'src/a.ts', 'src/x/b.ts', 'lib/c.ts'])].sort()).toEqual(['lib', 'src']);
  });
});
