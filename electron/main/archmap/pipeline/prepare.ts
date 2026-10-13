import { posix } from 'node:path';
import type { ArchmapFullReason, ArchmapUpdatePreview, ArchmapUpdateTrigger } from '../../../../src/types/archmap';
import { compareFingerprints, type FileFingerprint } from '../core';
import { normalizeRelativePath } from './node-path';
import type { ScanResult } from './types';

export const FULL_UPDATE_RATIO = 0.5;
export const ARCHITECTURE_RATIO = 0.25;
export const HUB_RATIO = 0.05;
export const HUB_MIN_FILES = 5;

const MANIFEST_BASENAMES = new Set(['package.json', 'pnpm-workspace.yaml', 'go.mod', 'pyproject.toml', 'Cargo.toml']);
const WORKFLOW_PATH = /(^|\/)\.github\/workflows\/[^/]+$/;
const TSCONFIG_NAME = /^tsconfig[^/]*\.json$/;
const TSCONFIG_PATHS = /"paths"\s*:/;

export interface PrepareInput {
  hasGit: boolean;
  metaValid: boolean;
  graphValid: boolean;
  indexedCommitExists: boolean | null;
  previousPaths: Iterable<string>;
  previousFingerprints: Record<string, FileFingerprint> | null;
  previousImportMap: Record<string, string[]>;
  previousPending?: Iterable<string>;
  currentScan: ScanResult;
  currentFingerprints: Record<string, FileFingerprint>;
  manifestPaths?: Iterable<string>;
  legacy?: boolean;
}

export interface PrepareResult extends ArchmapUpdatePreview {
  filesToReanalyzeList: string[];
  deletedPaths: string[];
  newPaths: string[];
  cosmeticPaths: string[];
  nonStructuralPaths: string[];
  pendingPaths: string[];
  structuralPaths: string[];
  rerunArchitecture: boolean;
}

export function isManifestPath(path: string, extra?: ReadonlySet<string>): boolean {
  const base = posix.basename(path);
  if (MANIFEST_BASENAMES.has(base)) return true;
  if (base.startsWith('Dockerfile') || base.startsWith('docker-compose')) return true;
  if (WORKFLOW_PATH.test(path)) return true;
  return extra?.has(path) ?? false;
}

export function tsconfigManifestPaths(paths: Iterable<string>, readText: (path: string) => string | null): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    if (!TSCONFIG_NAME.test(posix.basename(path))) continue;
    const text = readText(path);
    if (text === null || TSCONFIG_PATHS.test(text)) out.add(path);
  }
  return out;
}

export function hubPaths(importMap: Record<string, string[]>, paths: Iterable<string>): string[] {
  const known = new Set<string>();
  for (const path of paths) known.add(normalizeRelativePath(path));
  const inDegree = new Map<string, number>();
  for (const [source, targets] of Object.entries(importMap)) {
    if (!known.has(normalizeRelativePath(source))) continue;
    for (const target of new Set(targets.map((t) => normalizeRelativePath(t)))) {
      if (!known.has(target) || target === normalizeRelativePath(source)) continue;
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }
  const ranked = [...inDegree.entries()]
    .filter(([, degree]) => degree > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const keep = Math.max(HUB_MIN_FILES, Math.ceil(known.size * HUB_RATIO));
  return ranked.slice(0, keep).map(([path]) => path);
}

export function topDirectories(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRelativePath(path);
    const cut = normalized.indexOf('/');
    if (cut > 0) dirs.add(normalized.slice(0, cut));
  }
  return dirs;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function hasProvenance(fp: FileFingerprint | undefined): fp is FileFingerprint {
  return fp !== undefined && typeof fp.contentHash === 'string' && fp.contentHash.length > 0;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function full(
  reason: ArchmapFullReason,
  detail: string,
  base: Omit<PrepareResult, 'action' | 'reason' | 'detail' | 'rerunLayers' | 'rerunTour' | 'rerunArchitecture'>,
): PrepareResult {
  return {
    ...base,
    action: 'FULL_UPDATE',
    reason,
    detail,
    rerunArchitecture: true,
    rerunLayers: true,
    rerunTour: true,
  };
}

export function prepareUpdate(input: PrepareInput): PrepareResult {
  const previousSet = new Set<string>();
  for (const path of input.previousPaths) previousSet.add(normalizeRelativePath(path));
  const pendingBefore = new Set<string>();
  for (const path of input.previousPending ?? []) pendingBefore.add(normalizeRelativePath(path));
  const currentPaths = input.currentScan.files.map((file) => normalizeRelativePath(file.path));
  const currentSet = new Set(currentPaths);
  const extraManifests = new Set<string>();
  for (const path of input.manifestPaths ?? []) extraManifests.add(normalizeRelativePath(path));
  const before = input.previousFingerprints ?? {};
  const total = previousSet.size;

  const deletedPaths: string[] = [];
  const newPaths: string[] = [];
  const cosmeticPaths: string[] = [];
  const nonStructuralPaths: string[] = [];
  const pendingPaths: string[] = [];
  const structuralPaths: string[] = [];
  const manifestFiles = new Set<string>();
  let deletedStructural = 0;

  for (const path of [...previousSet].sort()) {
    if (currentSet.has(path)) continue;
    deletedPaths.push(path);
    if (isManifestPath(path, extraManifests)) manifestFiles.add(path);
    else if (hasProvenance(before[path]) && before[path].hasStructuralAnalysis) deletedStructural += 1;
  }

  for (const path of currentPaths) {
    const after = input.currentFingerprints[path];
    const manifest = isManifestPath(path, extraManifests);
    if (!previousSet.has(path)) {
      newPaths.push(path);
      if (manifest) manifestFiles.add(path);
      continue;
    }
    const prior = before[path];
    if (pendingBefore.has(path) || !hasProvenance(prior) || !after) {
      pendingPaths.push(path);
      if (manifest) manifestFiles.add(path);
      continue;
    }
    const result = compareFingerprints(prior, after);
    if (result.changeLevel === 'NONE') continue;
    if (manifest) {
      manifestFiles.add(path);
      nonStructuralPaths.push(path);
      continue;
    }
    if (result.changeLevel === 'COSMETIC') {
      cosmeticPaths.push(path);
      continue;
    }
    if (!prior.hasStructuralAnalysis || !after.hasStructuralAnalysis) nonStructuralPaths.push(path);
    else structuralPaths.push(path);
  }

  const structuralCount = structuralPaths.length + deletedStructural;
  const structuralRatio = total > 0 ? structuralCount / total : 0;
  const threshold = Math.floor(total * FULL_UPDATE_RATIO);
  const hubs = hubPaths(input.previousImportMap, previousSet);
  const touched = new Set([...structuralPaths, ...nonStructuralPaths, ...deletedPaths]);
  const hubFiles = hubs.filter((path) => touched.has(path));
  const directoryChanged = !sameSet(topDirectories(previousSet), topDirectories(currentSet));
  const filesToReanalyzeList = [
    ...new Set([...structuralPaths, ...nonStructuralPaths, ...pendingPaths, ...newPaths]),
  ].sort();

  const base = {
    totalFiles: total,
    structuralCount,
    structuralRatio,
    threshold,
    filesToReanalyze: filesToReanalyzeList.length,
    newFiles: newPaths.length,
    deletedFiles: deletedPaths.length,
    cosmeticFiles: cosmeticPaths.length,
    nonStructuralFiles: nonStructuralPaths.length,
    pendingFiles: pendingPaths.length,
    manifestFiles: [...manifestFiles].sort(),
    hubFiles,
    triggers: [] as ArchmapUpdateTrigger[],
    legacy: input.legacy === true,
    filesToReanalyzeList,
    deletedPaths,
    newPaths,
    cosmeticPaths,
    nonStructuralPaths,
    pendingPaths,
    structuralPaths,
  };

  if (!input.graphValid) return full('graph_invalid', 'knowledge-graph.json ausente ou invalido', base);
  if (!input.hasGit) return full('no_git', 'repositorio sem git: a atualizacao incremental nao e possivel', base);
  if (!input.metaValid) return full('meta_invalid', 'meta.json do mapa ausente ou invalido', base);
  if (input.indexedCommitExists === false) {
    return full('indexed_commit_missing', 'o commit indexado nao existe mais no repositorio', base);
  }

  const nothingChanged = filesToReanalyzeList.length === 0 && deletedPaths.length === 0 && manifestFiles.size === 0;
  if (nothingChanged) {
    const detail =
      cosmeticPaths.length > 0
        ? `${cosmeticPaths.length} arquivo(s) com mudanca so cosmetica; nada a reanalisar`
        : 'nenhuma mudanca detectada';
    return {
      ...base,
      action: 'SKIP',
      detail,
      rerunArchitecture: false,
      rerunLayers: false,
      rerunTour: false,
    };
  }

  if (structuralCount > total * FULL_UPDATE_RATIO) {
    return full(
      'too_many_changes',
      `${structuralCount} de ${total} arquivo(s) do grafo com mudanca estrutural (${percent(structuralRatio)}), acima do limite de 50% (${threshold})`,
      base,
    );
  }

  const triggers: ArchmapUpdateTrigger[] = [];
  const reasons: string[] = [];
  if (structuralRatio >= ARCHITECTURE_RATIO) {
    triggers.push('structural_ratio');
    reasons.push(`${structuralCount} de ${total} arquivo(s) com mudanca estrutural (${percent(structuralRatio)})`);
  }
  if (directoryChanged) {
    triggers.push('top_directory');
    reasons.push('diretorio de topo criado ou removido');
  }
  if (manifestFiles.size > 0) {
    triggers.push('manifest');
    reasons.push(`manifest ou configuracao de dependencias alterado (${[...manifestFiles].sort().join(', ')})`);
  }
  if (hubFiles.length > 0) {
    triggers.push('hub');
    reasons.push(`mudanca estrutural em arquivo hub (${hubFiles.join(', ')})`);
  }

  const summary = [
    structuralPaths.length > 0 ? `${structuralPaths.length} estrutural(is)` : null,
    nonStructuralPaths.length > 0 ? `${nonStructuralPaths.length} sem gramatica` : null,
    pendingPaths.length > 0 ? `${pendingPaths.length} pendente(s)` : null,
    newPaths.length > 0 ? `${newPaths.length} novo(s)` : null,
    deletedPaths.length > 0 ? `${deletedPaths.length} removido(s)` : null,
    cosmeticPaths.length > 0 ? `${cosmeticPaths.length} so cosmetico(s), anotacao mantida` : null,
  ]
    .filter(Boolean)
    .join(', ');

  if (triggers.length > 0) {
    return {
      ...base,
      triggers,
      action: 'ARCHITECTURE_UPDATE',
      detail: `${reasons.join('; ')} — ${filesToReanalyzeList.length} arquivo(s) relido(s) (${summary}); camadas e tour refeitos`,
      rerunArchitecture: true,
      rerunLayers: true,
      rerunTour: true,
    };
  }
  return {
    ...base,
    action: 'PARTIAL_UPDATE',
    detail: `${filesToReanalyzeList.length} arquivo(s) relido(s) (${summary}); camadas e tour mantidos`,
    rerunArchitecture: false,
    rerunLayers: false,
    rerunTour: false,
  };
}

export function previewOf(result: PrepareResult): ArchmapUpdatePreview {
  return {
    action: result.action,
    ...(result.reason ? { reason: result.reason } : {}),
    detail: result.detail,
    totalFiles: result.totalFiles,
    structuralCount: result.structuralCount,
    structuralRatio: result.structuralRatio,
    threshold: result.threshold,
    filesToReanalyze: result.filesToReanalyze,
    newFiles: result.newFiles,
    deletedFiles: result.deletedFiles,
    cosmeticFiles: result.cosmeticFiles,
    nonStructuralFiles: result.nonStructuralFiles,
    pendingFiles: result.pendingFiles,
    manifestFiles: result.manifestFiles,
    hubFiles: result.hubFiles,
    triggers: result.triggers,
    rerunLayers: result.rerunLayers,
    rerunTour: result.rerunTour,
    legacy: result.legacy,
  };
}
