import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchmapMetaResponse, ArchmapStats, ArchmapUpdateAction } from '../../../src/types/archmap';
import { validateGraph } from './core/schema';
import { LIONCLAW_DIR } from './git';
import { FILE_LEVEL_TYPES } from './node-types';
import { normalizeRelativePath } from './pipeline/node-path';

export const ARCHMAP_DIR_NAME = 'archmap';
export const ARCHMAP_GRAPH_FILE = 'knowledge-graph.json';
export const ARCHMAP_META_FILE = 'meta.json';
export const ARCHMAP_FINGERPRINTS_FILE = 'fingerprints.json';
export const ARCHMAP_SCAN_RESULT_FILE = 'scan-result.json';
export const ARCHMAP_CURRENT_FILE = 'current.json';
export const ARCHMAP_GENERATION_PREFIX = 'gen-';
export const ARCHMAP_SUPPORTED_GRAPH_MAJOR = 1;
export const ARCHMAP_GRAPH_MAX_BYTES = 50 * 1024 * 1024;

const GENERATION_NAME = /^gen-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARCHMAP_UPDATE_ACTIONS: ReadonlySet<string> = new Set([
  'SKIP',
  'PARTIAL_UPDATE',
  'ARCHITECTURE_UPDATE',
  'FULL_UPDATE',
]);
export const LEGACY_ARCHMAP_DIR_SEGMENTS = ['.lioncode', 'archmap'] as const;

export function archmapDirPath(repoRoot: string): string {
  return join(repoRoot, LIONCLAW_DIR, ARCHMAP_DIR_NAME);
}

export function legacyArchmapDirPath(repoRoot: string): string {
  return join(repoRoot, ...LEGACY_ARCHMAP_DIR_SEGMENTS);
}

export function archmapCurrentPath(repoRoot: string): string {
  return join(archmapDirPath(repoRoot), ARCHMAP_CURRENT_FILE);
}

export function generationName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${ARCHMAP_GENERATION_PREFIX}${safe}`;
}

export function isGenerationName(name: string): boolean {
  return GENERATION_NAME.test(name);
}

export function generationDirPath(repoRoot: string, generation: string): string {
  return join(archmapDirPath(repoRoot), generation);
}

export interface ArchmapPointer {
  generation: string;
  publishedAt: string;
  previous: string | null;
}

export function parsePointer(raw: unknown): ArchmapPointer | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.generation !== 'string' || !isGenerationName(raw.generation)) return null;
  const previous = typeof raw.previous === 'string' && isGenerationName(raw.previous) ? raw.previous : null;
  return {
    generation: raw.generation,
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : '',
    previous,
  };
}

export async function readCurrentPointer(repoRoot: string): Promise<ArchmapPointer | null> {
  try {
    return parsePointer(JSON.parse(await readFile(archmapCurrentPath(repoRoot), 'utf8')));
  } catch {
    return null;
  }
}

export interface ArchmapGraphInfo {
  mtimeMs: number;
  size: number;
  valid: boolean;
  invalidReason: string | null;
  stats: ArchmapStats | null;
  paths: ReadonlySet<string>;
  gitCommitHash: string | null;
  version: string | null;
}

export interface ArchmapMetaInfo {
  mtimeMs: number;
  size: number;
  valid: boolean;
  invalidReason: string | null;
  meta: ArchmapMetaResponse | null;
}

export interface ArchmapDiskState {
  dirPresent: boolean;
  pointer: ArchmapPointer | null;
  generationDir: string | null;
  graph: ArchmapGraphInfo | null;
  meta: ArchmapMetaInfo | null;
  fingerprintsPresent: boolean;
  scanResultPresent: boolean;
  legacy: boolean;
}

export interface GraphInspection {
  valid: boolean;
  invalidReason: string | null;
  stats: ArchmapStats | null;
  paths: Set<string>;
  gitCommitHash: string | null;
  version: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function graphNodePath(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const filePath = node.filePath;
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    return normalizeRelativePath(filePath.trim());
  }
  const id = node.id;
  const type = node.type;
  if (typeof id === 'string' && typeof type === 'string' && FILE_LEVEL_TYPES.has(type) && id.startsWith(`${type}:`)) {
    const rest = id.slice(type.length + 1).trim();
    return rest.length > 0 ? normalizeRelativePath(rest) : null;
  }
  return null;
}

function isSupportedVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)(?:\.\d+)*$/.exec(version.trim());
  return match !== null && Number(match[1]) === ARCHMAP_SUPPORTED_GRAPH_MAJOR;
}

export function inspectGraphText(raw: string): GraphInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('JSON invalido');
  }
  return inspectGraphValue(parsed);
}

export function inspectGraphValue(parsed: unknown): GraphInspection {
  if (!isRecord(parsed)) return invalid('raiz nao e objeto');
  for (const key of ['nodes', 'edges', 'layers', 'tour'] as const) {
    if (!Array.isArray(parsed[key])) return invalid(`\`${key}\` nao e array`);
  }
  if (!isRecord(parsed.project)) return invalid('`project` ausente');
  if (typeof parsed.project.gitCommitHash !== 'string') {
    return invalid('`project.gitCommitHash` nao e string');
  }
  if (!isSupportedVersion(parsed.version)) {
    return invalid(`\`version\` nao suportada (esperado major ${ARCHMAP_SUPPORTED_GRAPH_MAJOR})`);
  }
  let validated: ReturnType<typeof validateGraph>;
  try {
    validated = validateGraph(parsed);
  } catch (error) {
    return invalid(`validateGraph lancou: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validated.success || !validated.data) {
    return invalid(validated.fatal ?? validated.errors?.[0] ?? 'grafo invalido');
  }
  const graph = validated.data;
  const paths = new Set<string>();
  for (const node of graph.nodes) {
    const path = graphNodePath(node);
    if (path) paths.add(path);
  }
  return {
    valid: true,
    invalidReason: null,
    stats: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      fileCount: paths.size,
      layerCount: graph.layers.length,
    },
    paths,
    gitCommitHash: graph.project.gitCommitHash,
    version: parsed.version,
  };
}

function invalid(reason: string): GraphInspection {
  return {
    valid: false,
    invalidReason: reason,
    stats: null,
    paths: new Set(),
    gitCommitHash: null,
    version: null,
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export function inspectMetaText(raw: string): {
  valid: boolean;
  invalidReason: string | null;
  meta: ArchmapMetaResponse | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, invalidReason: 'JSON invalido', meta: null };
  }
  return inspectMetaValue(parsed);
}

export function inspectMetaValue(parsed: unknown): {
  valid: boolean;
  invalidReason: string | null;
  meta: ArchmapMetaResponse | null;
} {
  if (!isRecord(parsed)) {
    return { valid: false, invalidReason: 'raiz nao e objeto', meta: null };
  }
  if (typeof parsed.gitCommitHash !== 'string') {
    return { valid: false, invalidReason: '`gitCommitHash` nao e string', meta: null };
  }
  if (typeof parsed.lastAnalyzedAt !== 'string' || !Number.isFinite(Date.parse(parsed.lastAnalyzedAt))) {
    return { valid: false, invalidReason: '`lastAnalyzedAt` invalido', meta: null };
  }
  const meta: ArchmapMetaResponse = {
    lastAnalyzedAt: parsed.lastAnalyzedAt,
    gitCommitHash: parsed.gitCommitHash,
    version: typeof parsed.version === 'string' ? parsed.version : '',
    analyzedFiles:
      typeof parsed.analyzedFiles === 'number' && Number.isFinite(parsed.analyzedFiles) ? parsed.analyzedFiles : 0,
  };
  if (typeof parsed.runtime === 'string') meta.runtime = parsed.runtime;
  if (typeof parsed.provider === 'string') meta.provider = parsed.provider;
  if (typeof parsed.model === 'string') meta.model = parsed.model;
  if (typeof parsed.lionClawVersion === 'string') meta.lionClawVersion = parsed.lionClawVersion;
  if (parsed.partial === true) meta.partial = true;
  const pending = stringList(parsed.pendingFiles);
  if (pending) meta.pendingFiles = pending;
  const changed = stringList(parsed.changedDuringRun);
  if (changed) meta.changedDuringRun = changed;
  if (parsed.layersStale === true) meta.layersStale = true;
  if (parsed.tourStale === true) meta.tourStale = true;
  const fallback = stringList(parsed.fallback);
  if (fallback && fallback.length > 0) meta.fallback = fallback;
  if (typeof parsed.migratedFrom === 'string') meta.migratedFrom = parsed.migratedFrom;
  if (typeof parsed.action === 'string' && ARCHMAP_UPDATE_ACTIONS.has(parsed.action)) {
    meta.action = parsed.action as ArchmapUpdateAction;
  }
  return { valid: true, invalidReason: null, meta };
}

interface FileStat {
  mtimeMs: number;
  size: number;
}

async function statFile(path: string): Promise<FileStat | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export type ArchmapGraphRead =
  { kind: 'absent' } | { kind: 'too_large'; size: number } | { kind: 'ok'; graph: unknown; size: number };

export interface ArchmapStateReader {
  read(repositoryId: string, repoRoot: string): Promise<ArchmapDiskState>;
  readGraph(repositoryId: string, repoRoot: string): Promise<ArchmapGraphRead>;
  clear(repositoryId: string): void;
}

interface CacheEntry {
  generationDir: string | null;
  graph: ArchmapGraphInfo | null;
  meta: ArchmapMetaInfo | null;
}

const EMPTY_STATE: ArchmapDiskState = {
  dirPresent: false,
  pointer: null,
  generationDir: null,
  graph: null,
  meta: null,
  fingerprintsPresent: false,
  scanResultPresent: false,
  legacy: false,
};

export function createArchmapStateReader(): ArchmapStateReader {
  const cache = new Map<string, CacheEntry>();

  async function readGraphInfo(path: string, cached: ArchmapGraphInfo | null): Promise<ArchmapGraphInfo | null> {
    const st = await statFile(path);
    if (!st) return null;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    if (st.size > ARCHMAP_GRAPH_MAX_BYTES) {
      return { mtimeMs: st.mtimeMs, size: st.size, ...invalid(`grafo acima de ${ARCHMAP_GRAPH_MAX_BYTES} bytes`) };
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    return { mtimeMs: st.mtimeMs, size: st.size, ...inspectGraphText(raw) };
  }

  async function readMetaInfo(path: string, cached: ArchmapMetaInfo | null): Promise<ArchmapMetaInfo | null> {
    const st = await statFile(path);
    if (!st) return null;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    return { mtimeMs: st.mtimeMs, size: st.size, ...inspectMetaText(raw) };
  }

  async function readFrom(
    repositoryId: string,
    generationDir: string,
    pointer: ArchmapPointer | null,
    legacy: boolean,
  ): Promise<ArchmapDiskState> {
    const cachedEntry = cache.get(repositoryId);
    const cached =
      cachedEntry && cachedEntry.generationDir === generationDir
        ? cachedEntry
        : { generationDir, graph: null, meta: null };
    const [graph, meta, fingerprints, scanResult] = await Promise.all([
      readGraphInfo(join(generationDir, ARCHMAP_GRAPH_FILE), cached.graph),
      readMetaInfo(join(generationDir, ARCHMAP_META_FILE), cached.meta),
      statFile(join(generationDir, ARCHMAP_FINGERPRINTS_FILE)),
      statFile(join(generationDir, ARCHMAP_SCAN_RESULT_FILE)),
    ]);
    cache.set(repositoryId, { generationDir, graph, meta });
    return {
      dirPresent: true,
      pointer,
      generationDir,
      graph,
      meta,
      fingerprintsPresent: fingerprints !== null,
      scanResultPresent: scanResult !== null,
      legacy,
    };
  }

  async function read(repositoryId: string, repoRoot: string): Promise<ArchmapDiskState> {
    const dir = archmapDirPath(repoRoot);
    const dirPresent = await isDirectory(dir);
    const pointer = dirPresent ? await readCurrentPointer(repoRoot) : null;
    if (!pointer) {
      const legacyDir = legacyArchmapDirPath(repoRoot);
      if (await statFile(join(legacyDir, ARCHMAP_GRAPH_FILE))) {
        return readFrom(repositoryId, legacyDir, null, true);
      }
      cache.delete(repositoryId);
      return { ...EMPTY_STATE, dirPresent };
    }
    const generationDir = generationDirPath(repoRoot, pointer.generation);
    if (!(await isDirectory(generationDir))) {
      cache.delete(repositoryId);
      return { ...EMPTY_STATE, dirPresent: true, pointer };
    }
    return readFrom(repositoryId, generationDir, pointer, false);
  }

  return {
    read,
    async readGraph(repositoryId, repoRoot) {
      const state = await read(repositoryId, repoRoot);
      if (!state.graph || !state.generationDir) return { kind: 'absent' };
      if (state.graph.size > ARCHMAP_GRAPH_MAX_BYTES) return { kind: 'too_large', size: state.graph.size };
      if (!state.graph.valid) return { kind: 'absent' };
      try {
        const raw = await readFile(join(state.generationDir, ARCHMAP_GRAPH_FILE), 'utf8');
        return { kind: 'ok', graph: JSON.parse(raw) as unknown, size: state.graph.size };
      } catch {
        return { kind: 'absent' };
      }
    },
    clear(repositoryId) {
      cache.delete(repositoryId);
    },
  };
}
