import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchmapMetaResponse } from '../../../src/types/archmap';
import type { FileFingerprint } from './core';
import { writeGeneration, type ArchmapGenerationMeta } from './generation';
import { parseFingerprintFile, type ArchmapFingerprintFile } from './pipeline/fingerprints';
import { normalizeRelativePath } from './pipeline/node-path';
import { detectCategory, detectLanguage, parseScanResult } from './pipeline/scan';
import { ARCHMAP_SCHEMA_VERSION, type ScanFile, type ScanResult } from './pipeline/types';
import {
  ARCHMAP_FINGERPRINTS_FILE,
  ARCHMAP_GRAPH_FILE,
  ARCHMAP_GRAPH_MAX_BYTES,
  ARCHMAP_META_FILE,
  ARCHMAP_SCAN_RESULT_FILE,
  inspectGraphValue,
  inspectMetaValue,
  legacyArchmapDirPath,
  readCurrentPointer,
  type GraphInspection,
} from './state';

export { legacyArchmapDirPath };

export const LEGACY_ARCHMAP_DIR = '.lioncode/archmap';
export const LEGACY_GENERATION_RUN_ID = 'legado';

export interface LegacyBaseline {
  dir: string;
  graph: Record<string, unknown>;
  inspection: GraphInspection;
  meta: ArchmapMetaResponse;
  fingerprints: ArchmapFingerprintFile | null;
  scan: ScanResult | null;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export async function readBaselineDir(dir: string): Promise<LegacyBaseline | null> {
  let size: number;
  try {
    const st = await stat(join(dir, ARCHMAP_GRAPH_FILE));
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  if (size > ARCHMAP_GRAPH_MAX_BYTES) return null;
  const graphRaw = await readJson(join(dir, ARCHMAP_GRAPH_FILE));
  const metaRaw = await readJson(join(dir, ARCHMAP_META_FILE));
  if (graphRaw === null || metaRaw === null) return null;
  const inspection = inspectGraphValue(graphRaw);
  const meta = inspectMetaValue(metaRaw);
  if (!inspection.valid || !meta.valid || !meta.meta) return null;
  const fingerprints = parseFingerprintFile(await readJson(join(dir, ARCHMAP_FINGERPRINTS_FILE)));
  const scan = parseScanResult(await readJson(join(dir, ARCHMAP_SCAN_RESULT_FILE)));
  return { dir, graph: graphRaw as Record<string, unknown>, inspection, meta: meta.meta, fingerprints, scan };
}

export function readLegacyBaseline(repoRoot: string): Promise<LegacyBaseline | null> {
  return readBaselineDir(legacyArchmapDirPath(repoRoot));
}

export interface ReconstructedBaseline {
  paths: string[];
  fingerprints: Record<string, FileFingerprint>;
  pending: string[];
  scan: ScanResult;
  reconstructedScan: boolean;
}

export interface ReconstructInput {
  graphPaths: Iterable<string>;
  fingerprints: ArchmapFingerprintFile | null;
  previousScan: ScanResult | null;
  currentScan: ScanResult;
  scanStartedAt: string;
}

function hasProvenance(fp: FileFingerprint | undefined): fp is FileFingerprint {
  return fp !== undefined && typeof fp.contentHash === 'string' && fp.contentHash.length > 0;
}

export function reconstructBaseline(input: ReconstructInput): ReconstructedBaseline {
  const paths = new Set<string>();
  for (const path of input.graphPaths) paths.add(normalizeRelativePath(path));
  const files = input.fingerprints?.files ?? {};
  for (const path of Object.keys(files)) paths.add(normalizeRelativePath(path));
  if (input.previousScan) for (const file of input.previousScan.files) paths.add(normalizeRelativePath(file.path));
  const sorted = [...paths].sort();

  const fingerprints: Record<string, FileFingerprint> = {};
  const pending: string[] = [];
  for (const path of sorted) {
    const fp = files[path];
    if (hasProvenance(fp)) fingerprints[path] = { ...fp, filePath: path };
    else pending.push(path);
  }

  if (input.previousScan) {
    return { paths: sorted, fingerprints, pending, scan: input.previousScan, reconstructedScan: false };
  }

  const current = new Map(input.currentScan.files.map((file) => [normalizeRelativePath(file.path), file]));
  const scanFiles: ScanFile[] = sorted.map((path) => {
    const live = current.get(path);
    if (live) return { ...live, path };
    return {
      path,
      language: detectLanguage(path),
      sizeLines: files[path]?.totalLines ?? 0,
      sizeBytes: 0,
      fileCategory: detectCategory(path),
    };
  });
  const importMap: Record<string, string[]> = {};
  for (const path of sorted) {
    const targets = input.currentScan.importMap[path] ?? [];
    importMap[path] = targets.map((t) => normalizeRelativePath(t)).filter((t) => paths.has(t));
  }
  const byCategory: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const file of scanFiles) {
    byCategory[file.fileCategory] = (byCategory[file.fileCategory] ?? 0) + 1;
    byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;
  }
  const scan: ScanResult = {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    scanStartedAt: input.scanStartedAt,
    contentDigest: '',
    files: scanFiles,
    totalFiles: scanFiles.length,
    filteredByIgnore: 0,
    importMap,
    stats: { byCategory, byLanguage },
    warnings: ['scan-result.json recomposto dos fingerprints e do grafo; importMap recalculado do disco'],
  };
  return { paths: sorted, fingerprints, pending, scan, reconstructedScan: true };
}

export interface LegacyMigrationResult {
  generation: string;
  paths: number;
  pending: string[];
  reconstructedScan: boolean;
}

export async function migrateLegacyArchmap(options: {
  repoRoot: string;
  currentScan: ScanResult;
  scanStartedAt: string;
  lionClawVersion: string;
}): Promise<LegacyMigrationResult | null> {
  if (await readCurrentPointer(options.repoRoot)) return null;
  const baseline = await readLegacyBaseline(options.repoRoot);
  if (!baseline) return null;
  const recon = reconstructBaseline({
    graphPaths: baseline.inspection.paths,
    fingerprints: baseline.fingerprints,
    previousScan: baseline.scan,
    currentScan: options.currentScan,
    scanStartedAt: baseline.meta.lastAnalyzedAt,
  });
  const pending = [...new Set([...(baseline.meta.pendingFiles ?? []), ...recon.pending])].sort();
  const meta: ArchmapGenerationMeta = {
    lastAnalyzedAt: baseline.meta.lastAnalyzedAt,
    gitCommitHash: baseline.meta.gitCommitHash,
    analyzedFiles: baseline.meta.analyzedFiles > 0 ? baseline.meta.analyzedFiles : recon.paths.length,
    runtime: baseline.meta.runtime ?? 'lioncode',
    provider: baseline.meta.provider ?? '',
    model: baseline.meta.model ?? '',
    lionClawVersion: options.lionClawVersion,
    migratedFrom: LEGACY_ARCHMAP_DIR,
    ...(pending.length > 0 ? { partial: true, pendingFiles: pending } : {}),
    ...(baseline.meta.layersStale ? { layersStale: true } : {}),
    ...(baseline.meta.tourStale ? { tourStale: true } : {}),
  };
  const written = await writeGeneration({
    repoRoot: options.repoRoot,
    runId: LEGACY_GENERATION_RUN_ID,
    graph: baseline.graph,
    fingerprints: recon.fingerprints,
    scan: recon.scan,
    meta,
  });
  return {
    generation: written.generation,
    paths: recon.paths.length,
    pending,
    reconstructedScan: recon.reconstructedScan,
  };
}
