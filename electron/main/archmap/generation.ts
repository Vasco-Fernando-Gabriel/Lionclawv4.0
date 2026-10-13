import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchmapMetaResponse, ArchmapStats, ArchmapUpdateAction } from '../../../src/types/archmap';
import type { FileFingerprint } from './core';
import { validateGraph } from './core/schema';
import { makeFingerprintFile, parseFingerprintFile, type ArchmapFingerprintFile } from './pipeline/fingerprints';
import { parseScanResult } from './pipeline/scan';
import type { ScanResult } from './pipeline/types';
import {
  ARCHMAP_CURRENT_FILE,
  ARCHMAP_FINGERPRINTS_FILE,
  ARCHMAP_GRAPH_FILE,
  ARCHMAP_META_FILE,
  ARCHMAP_SCAN_RESULT_FILE,
  archmapDirPath,
  generationDirPath,
  generationName,
  inspectGraphValue,
  inspectMetaValue,
  isGenerationName,
  readCurrentPointer,
  type ArchmapPointer,
} from './state';

export const ARCHMAP_GENERATIONS_KEPT = 2;
export const ARCHMAP_CACHE_DIRS = ['agent-cache', 'agent-task-cache'] as const;
export const ARCHMAP_TMP_PREFIX = '.tmp-';

export interface ArchmapGenerationMeta {
  lastAnalyzedAt: string;
  gitCommitHash: string;
  analyzedFiles: number;
  runtime: string;
  provider: string;
  model: string;
  lionClawVersion: string;
  partial?: boolean;
  pendingFiles?: string[];
  changedDuringRun?: string[];
  layersStale?: boolean;
  tourStale?: boolean;
  fallback?: string[];
  migratedFrom?: string;
  action?: ArchmapUpdateAction;
}

export interface WriteGenerationInput {
  repoRoot: string;
  runId: string;
  graph: Record<string, unknown>;
  fingerprints: Record<string, FileFingerprint>;
  scan: ScanResult;
  meta: ArchmapGenerationMeta;
  publishedAt?: string;
}

export interface WriteGenerationResult {
  generation: string;
  dir: string;
  stats: ArchmapStats;
  dropped: string[];
  pointer: ArchmapPointer;
}

export interface ArchmapGeneration {
  pointer: ArchmapPointer;
  dir: string;
  graph: Record<string, unknown>;
  meta: ArchmapMetaResponse;
  fingerprints: ArchmapFingerprintFile;
  scan: ScanResult;
  stats: ArchmapStats;
}

async function writeAtomic(dir: string, name: string, suffix: string, content: string): Promise<void> {
  const tmp = join(dir, `${ARCHMAP_TMP_PREFIX}${suffix}-${name}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, join(dir, name));
}

function tmpSuffix(runId: string): string {
  return `${process.pid}-${runId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

export async function publishPointer(
  repoRoot: string,
  generation: string,
  publishedAt: string = new Date().toISOString(),
): Promise<ArchmapPointer> {
  if (!isGenerationName(generation)) throw new Error(`nome de geracao invalido: ${generation}`);
  const dir = archmapDirPath(repoRoot);
  await mkdir(dir, { recursive: true });
  const current = await readCurrentPointer(repoRoot);
  const pointer: ArchmapPointer = {
    generation,
    publishedAt,
    previous: current && current.generation !== generation ? current.generation : (current?.previous ?? null),
  };
  await writeAtomic(dir, ARCHMAP_CURRENT_FILE, tmpSuffix(generation), JSON.stringify(pointer, null, 2));
  return pointer;
}

export async function writeGeneration(input: WriteGenerationInput): Promise<WriteGenerationResult> {
  const validated = validateGraph(input.graph);
  if (!validated.success || !validated.data) {
    throw new Error(`grafo invalido na geracao: ${validated.fatal ?? validated.errors?.[0] ?? 'schema'}`);
  }
  const dropped = validated.issues.filter((issue) => issue.level === 'dropped').map((issue) => issue.message);
  const generation = generationName(input.runId);
  const dir = generationDirPath(input.repoRoot, generation);
  await mkdir(dir, { recursive: true });
  const suffix = tmpSuffix(input.runId);

  await writeAtomic(dir, ARCHMAP_GRAPH_FILE, suffix, JSON.stringify(validated.data, null, 2));
  const reread = inspectGraphValue(JSON.parse(await readFile(join(dir, ARCHMAP_GRAPH_FILE), 'utf8')));
  if (!reread.valid || !reread.stats) {
    throw new Error(`releitura do grafo falhou: ${reread.invalidReason ?? 'invalido'}`);
  }

  const fingerprintFile = makeFingerprintFile(input.fingerprints, input.meta.gitCommitHash, input.meta.lastAnalyzedAt);
  await writeAtomic(dir, ARCHMAP_FINGERPRINTS_FILE, suffix, JSON.stringify(fingerprintFile));
  await writeAtomic(dir, ARCHMAP_SCAN_RESULT_FILE, suffix, JSON.stringify(input.scan));
  const meta = { ...input.meta, version: '1.0.0', generation };
  await writeAtomic(dir, ARCHMAP_META_FILE, suffix, JSON.stringify(meta, null, 2));

  const pointer = await publishPointer(input.repoRoot, generation, input.publishedAt);
  return { generation, dir, stats: reread.stats, dropped, pointer };
}

export async function readGeneration(repoRoot: string): Promise<ArchmapGeneration | null> {
  const pointer = await readCurrentPointer(repoRoot);
  if (!pointer) return null;
  const dir = generationDirPath(repoRoot, pointer.generation);
  let graphRaw: unknown;
  let metaRaw: unknown;
  let fingerprintsRaw: unknown;
  let scanRaw: unknown;
  try {
    [graphRaw, metaRaw, fingerprintsRaw, scanRaw] = await Promise.all(
      [ARCHMAP_GRAPH_FILE, ARCHMAP_META_FILE, ARCHMAP_FINGERPRINTS_FILE, ARCHMAP_SCAN_RESULT_FILE].map(
        async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown,
      ),
    );
  } catch {
    return null;
  }
  const graph = inspectGraphValue(graphRaw);
  const meta = inspectMetaValue(metaRaw);
  const fingerprints = parseFingerprintFile(fingerprintsRaw);
  const scan = parseScanResult(scanRaw);
  if (!graph.valid || !graph.stats || !meta.valid || !meta.meta || !fingerprints || !scan) return null;
  return {
    pointer,
    dir,
    graph: graphRaw as Record<string, unknown>,
    meta: meta.meta,
    fingerprints,
    scan,
    stats: graph.stats,
  };
}

export async function listGenerations(repoRoot: string): Promise<string[]> {
  try {
    const names = await readdir(archmapDirPath(repoRoot));
    const out: string[] = [];
    for (const name of names) {
      if (!isGenerationName(name)) continue;
      try {
        if ((await stat(join(archmapDirPath(repoRoot), name))).isDirectory()) out.push(name);
      } catch {}
    }
    return out.sort();
  } catch {
    return [];
  }
}

export async function removeTmpFiles(dir: string): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(ARCHMAP_TMP_PREFIX)) continue;
    const path = join(dir, name);
    await rm(path, { recursive: true, force: true }).catch(() => {});
    removed.push(path);
  }
  return removed;
}

export interface PreflightResult {
  removedTmp: string[];
  removedGenerations: string[];
  pointer: ArchmapPointer | null;
}

export async function preflightArchmapDir(repoRoot: string): Promise<PreflightResult> {
  const dir = archmapDirPath(repoRoot);
  await mkdir(dir, { recursive: true });
  const pointer = await readCurrentPointer(repoRoot);
  const keep = new Set<string>();
  if (pointer) {
    keep.add(pointer.generation);
    if (pointer.previous) keep.add(pointer.previous);
  }
  const removedTmp = await removeTmpFiles(dir);
  const removedGenerations: string[] = [];
  for (const name of await listGenerations(repoRoot)) {
    const genDir = join(dir, name);
    if (!keep.has(name)) {
      await rm(genDir, { recursive: true, force: true }).catch(() => {});
      removedGenerations.push(name);
      continue;
    }
    removedTmp.push(...(await removeTmpFiles(genDir)));
  }
  for (const cacheDir of ARCHMAP_CACHE_DIRS) removedTmp.push(...(await removeTmpFiles(join(dir, cacheDir))));
  return { removedTmp, removedGenerations, pointer };
}

export async function hasTmpFiles(repoRoot: string): Promise<boolean> {
  const dir = archmapDirPath(repoRoot);
  const dirs = [dir, ...(await listGenerations(repoRoot)).map((name) => join(dir, name))];
  for (const candidate of dirs) {
    try {
      if ((await readdir(candidate)).some((name) => name.startsWith(ARCHMAP_TMP_PREFIX))) return true;
    } catch {}
  }
  return false;
}
