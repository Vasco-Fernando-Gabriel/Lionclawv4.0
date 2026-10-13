import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { comparePaths } from './scan';
import {
  ARCHMAP_SCHEMA_VERSION,
  type ArchmapBatch,
  type BatchPlan,
  type NeighborEntry,
  type ScanFile,
  type ScanResult,
} from './types';

export const MAX_COMMUNITY_SIZE = 35;
const MIN_BATCH_SIZE = 3;
const MAX_MERGE_TARGET = 25;
const COUNT_FALLBACK_SIZE = 12;
const MAX_GROUP_E = 20;
const MAX_NEIGHBORS = 50;

interface BareBatch {
  files: ScanFile[];
  mergeable: boolean;
}

function dirOf(p: string): string {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}
function baseOf(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
}

function buildNonCodeBatches(nonCode: ScanFile[]): BareBatch[] {
  const byPath = new Map(nonCode.map((f) => [f.path, f]));
  const consumed = new Set<string>();
  const groups: BareBatch[] = [];
  const allPaths = [...byPath.keys()].sort(comparePaths);
  const pathsByDir = new Map<string, string[]>();
  for (const p of allPaths) {
    const d = dirOf(p);
    const list = pathsByDir.get(d) ?? [];
    list.push(p);
    pathsByDir.set(d, list);
  }
  const take = (paths: string[], mergeable: boolean): void => {
    const fresh = paths.filter((p) => !consumed.has(p));
    if (fresh.length === 0) return;
    groups.push({ files: fresh.map((p) => byPath.get(p)!), mergeable });
    for (const p of fresh) consumed.add(p);
  };
  const dockerDirs = new Set<string>();
  for (const p of allPaths) if (baseOf(p) === 'Dockerfile') dockerDirs.add(dirOf(p));
  for (const dir of [...dockerDirs].sort(comparePaths)) {
    take(
      (pathsByDir.get(dir) ?? []).filter((p) => {
        const b = baseOf(p);
        return b === 'Dockerfile' || b === '.dockerignore' || b.startsWith('docker-compose.');
      }),
      false,
    );
  }
  take(
    allPaths.filter((p) => p.startsWith('.github/workflows/') && /\.ya?ml$/.test(p)),
    false,
  );
  take(
    allPaths.filter((p) => p === '.gitlab-ci.yml' || p.startsWith('.circleci/')),
    false,
  );
  const migrationDirs = new Set<string>();
  for (const p of allPaths) {
    if (p.endsWith('.sql') && /(^|\/)migrations?$/.test(dirOf(p))) migrationDirs.add(dirOf(p));
  }
  for (const dir of [...migrationDirs].sort(comparePaths)) {
    take(
      (pathsByDir.get(dir) ?? []).filter((p) => p.endsWith('.sql')),
      false,
    );
  }
  const remainingByDir = new Map<string, string[]>();
  for (const p of allPaths) {
    if (consumed.has(p)) continue;
    const list = remainingByDir.get(dirOf(p)) ?? [];
    list.push(p);
    remainingByDir.set(dirOf(p), list);
  }
  for (const [, paths] of [...remainingByDir.entries()].sort(([a], [b]) => comparePaths(a, b))) {
    for (let i = 0; i < paths.length; i += MAX_GROUP_E) {
      take(paths.slice(i, i + MAX_GROUP_E), true);
    }
  }
  return groups;
}

function runLouvain(codeFiles: ScanFile[], importMap: Record<string, string[]>): Map<string, string> {
  const graph = new Graph({ type: 'undirected', allowSelfLoops: false });
  const paths = codeFiles.map((f) => f.path).sort(comparePaths);
  for (const p of paths) graph.addNode(p);
  for (const [src, targets] of Object.entries(importMap).sort(([a], [b]) => comparePaths(a, b))) {
    if (!graph.hasNode(src)) continue;
    for (const tgt of [...targets].sort(comparePaths)) {
      if (!graph.hasNode(tgt) || src === tgt || graph.hasEdge(src, tgt)) continue;
      graph.addEdge(src, tgt);
    }
  }
  if (graph.order === 0) return new Map();
  const communities = louvain(graph, { randomWalk: false }) as Record<string, number | string>;
  return new Map(Object.entries(communities).map(([k, v]) => [k, String(v)]));
}

function countBased(codeFiles: ScanFile[]): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = codeFiles.map((f) => f.path).sort(comparePaths);
  sorted.forEach((p, i) => out.set(p, `count_${Math.floor(i / COUNT_FALLBACK_SIZE)}`));
  return out;
}

function mergeSmall(bare: BareBatch[]): ScanFile[][] {
  const keepers: BareBatch[] = [];
  const small: BareBatch[] = [];
  for (const b of bare) (b.mergeable && b.files.length < MIN_BATCH_SIZE ? small : keepers).push(b);
  const result = keepers.map((b) => b.files);
  if (small.length === 0) return result;
  const pooled = small.flatMap((b) => b.files).sort((a, b) => comparePaths(a.path, b.path));
  for (let i = 0; i < pooled.length; i += MAX_MERGE_TARGET) {
    result.push(pooled.slice(i, i + MAX_MERGE_TARGET));
  }
  return result;
}

export interface NeighborMapDeps {
  importMap: Record<string, string[]>;
  reverseImportMap: Map<string, string[]>;
  batchOf: Map<string, number>;
  exportsByPath: Record<string, string[]>;
  degree: Map<string, number>;
}

export function buildNeighborDeps(
  importMap: Record<string, string[]>,
  batches: Array<{ batchIndex: number; files: ScanFile[] }>,
  exportsByPath: Record<string, string[]>,
): NeighborMapDeps {
  const reverse = new Map<string, string[]>();
  for (const [src, targets] of Object.entries(importMap)) {
    for (const tgt of targets) {
      const list = reverse.get(tgt) ?? [];
      list.push(src);
      reverse.set(tgt, list);
    }
  }
  const batchOf = new Map<string, number>();
  for (const b of batches) for (const f of b.files) batchOf.set(f.path, b.batchIndex);
  const degree = new Map<string, number>();
  for (const path of batchOf.keys()) {
    degree.set(path, (importMap[path] ?? []).length + (reverse.get(path) ?? []).length);
  }
  return { importMap, reverseImportMap: reverse, batchOf, exportsByPath, degree };
}

export function buildBatchPayload(
  analysisFiles: ScanFile[],
  deps: NeighborMapDeps,
  warnings: string[],
  symbolOverrides?: Record<string, string[]>,
): Pick<ArchmapBatch, 'batchImportData' | 'neighborMap'> {
  const analysisPaths = new Set(analysisFiles.map((f) => f.path));
  const batchImportData: Record<string, string[]> = {};
  const neighborMap: Record<string, NeighborEntry[]> = {};
  for (const f of analysisFiles) {
    batchImportData[f.path] = [...(deps.importMap[f.path] ?? [])];
    const all = new Set([...(deps.importMap[f.path] ?? []), ...(deps.reverseImportMap.get(f.path) ?? [])]);
    const rawCount = all.size;
    let kept: NeighborEntry[] = [...all]
      .filter((p) => deps.batchOf.has(p) && !analysisPaths.has(p))
      .map((p) => ({
        path: p,
        batchIndex: deps.batchOf.get(p)!,
        symbols: symbolOverrides?.[p] ?? deps.exportsByPath[p] ?? [],
      }));
    if (rawCount > MAX_NEIGHBORS) {
      kept.sort(
        (a, b) => (deps.degree.get(b.path) ?? 0) - (deps.degree.get(a.path) ?? 0) || comparePaths(a.path, b.path),
      );
      const before = kept.length;
      kept = kept.slice(0, MAX_NEIGHBORS);
      warnings.push(
        `batches: neighborMap de ${f.path} com grau ${rawCount} acima do cap ${MAX_NEIGHBORS} — mantidos ${kept.length} (${before - kept.length} descartados)`,
      );
    } else {
      kept.sort((a, b) => comparePaths(a.path, b.path));
    }
    if (kept.length > 0) neighborMap[f.path] = kept;
  }
  return { batchImportData, neighborMap };
}

export function computeBatches(scan: ScanResult, exportsByPath: Record<string, string[]>): BatchPlan {
  const warnings: string[] = [];
  const codeFiles = scan.files.filter((f) => f.fileCategory === 'code');
  const nonCode = scan.files.filter((f) => f.fileCategory !== 'code');
  const importMap = scan.importMap;

  let algorithm: BatchPlan['algorithm'] = 'louvain';
  let community: Map<string, string>;
  try {
    community = runLouvain(codeFiles, importMap);
  } catch (error) {
    warnings.push(
      `batches: louvain falhou (${error instanceof Error ? error.message : String(error)}) — agrupamento por contagem (${COUNT_FALLBACK_SIZE}/lote)`,
    );
    community = countBased(codeFiles);
    algorithm = 'count-fallback';
  }
  const byCommunity = new Map<string, string[]>();
  for (const [path, cid] of community) {
    const list = byCommunity.get(cid) ?? [];
    list.push(path);
    byCommunity.set(cid, list);
  }
  const split = new Map<string, string[]>();
  let synthetic = 0;
  for (const [cid, paths] of byCommunity) {
    if (algorithm !== 'louvain' || paths.length <= MAX_COMMUNITY_SIZE) {
      split.set(cid, paths);
      continue;
    }
    warnings.push(
      `batches: comunidade com ${paths.length} arquivos acima de ${MAX_COMMUNITY_SIZE} — dividida alfabeticamente`,
    );
    const sorted = [...paths].sort(comparePaths);
    const parts = Math.ceil(paths.length / MAX_COMMUNITY_SIZE);
    const perPart = Math.ceil(paths.length / parts);
    for (let i = 0; i < parts; i += 1) {
      split.set(`__split_${cid}_${synthetic++}`, sorted.slice(i * perPart, (i + 1) * perPart));
    }
  }
  const sortedCommunities = [...split.values()]
    .map((paths) => [...paths].sort(comparePaths))
    .sort((a, b) => b.length - a.length || comparePaths(a[0] ?? '', b[0] ?? ''));

  const metaByPath = new Map(scan.files.map((f) => [f.path, f]));
  const bare: BareBatch[] = sortedCommunities.map((paths) => ({
    files: paths.map((p) => metaByPath.get(p)!),
    mergeable: true,
  }));
  bare.push(...buildNonCodeBatches(nonCode));
  const merged = mergeSmall(bare).map((files, i) => ({ batchIndex: i + 1, files }));
  const deps = buildNeighborDeps(importMap, merged, exportsByPath);
  const batches: ArchmapBatch[] = merged.map((b) => ({
    batchIndex: b.batchIndex,
    files: b.files,
    ...buildBatchPayload(b.files, deps, warnings),
  }));
  return {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    algorithm,
    totalFiles: scan.files.length,
    totalBatches: batches.length,
    exportsByPath,
    batches,
    warnings,
  };
}
