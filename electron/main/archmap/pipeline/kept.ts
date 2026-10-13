import { buildStructuralGraph } from './hybrid-structure';
import type { MergeBatchInput } from './merge';
import { FILE_LEVEL_TYPES } from '../node-types';
import { JEV_TRIAGE_KEEPS_FIELD, jevKeepsOf } from './jev-triage';
import { nodePath, normalizeRelativePath } from './node-path';
import type { BatchInput, ExtractedFile, GraphRecord, ScanFile } from './types';

export const KEPT_BATCH_INDEX = -3;
const STRUCTURAL_EDGE_TYPES = new Set(['imports', 'exports', 'contains']);
const ANNOTATION_FIELDS = ['summary', 'tags', 'complexity', 'languageNotes'] as const;

function withJevKeeps(node: GraphRecord, keeps: number): GraphRecord {
  const metadata =
    typeof node.metadata === 'object' && node.metadata !== null ? (node.metadata as Record<string, unknown>) : {};
  return { ...node, metadata: { ...metadata, [JEV_TRIAGE_KEEPS_FIELD]: keeps } };
}

export interface KeptBatchInput {
  projectName: string;
  runId: string;
  files: readonly ScanFile[];
  extraction: readonly ExtractedFile[];
  importMap: Record<string, string[]>;
  previous: { nodes: readonly GraphRecord[]; edges: readonly GraphRecord[] };
  knownIds: ReadonlySet<string>;
  jevKeptPaths?: ReadonlySet<string>;
}

export interface KeptBatchResult {
  batch: MergeBatchInput;
  droppedEdges: number;
  keptEdges: number;
  unannotated: string[];
}

export function keptFileBatch(input: KeptBatchInput): KeptBatchResult {
  const paths = input.files.map((file) => normalizeRelativePath(file.path));
  const pathSet = new Set(paths);
  const structural = buildStructuralGraph({
    projectName: input.projectName,
    batchIndex: KEPT_BATCH_INDEX,
    files: [...input.files],
    extraction: input.extraction.filter((entry) => pathSet.has(normalizeRelativePath(entry.path))),
    batchImportData: Object.fromEntries(paths.map((path) => [path, input.importMap[path] ?? []])),
    neighborMap: {},
    sources: {},
    context: { languages: [], frameworks: [] },
  } satisfies BatchInput);
  const previousById = new Map(input.previous.nodes.map((node) => [String(node.id), node]));
  const jevKept = new Set([...(input.jevKeptPaths ?? [])].map((path) => normalizeRelativePath(path)));
  const unannotated: string[] = [];
  const nodes = structural.nodes.map((node) => {
    const prior = previousById.get(String(node.id));
    if (!prior) {
      unannotated.push(String(node.id));
      return node;
    }
    let merged: GraphRecord = { ...node };
    for (const field of ANNOTATION_FIELDS) {
      if (prior[field] !== undefined) merged[field] = prior[field];
    }
    if (typeof node.type === 'string' && FILE_LEVEL_TYPES.has(node.type)) {
      const path = nodePath(node);
      const keeps = jevKeepsOf(prior) + (path !== null && jevKept.has(path) ? 1 : 0);
      if (keeps > 0) merged = withJevKeeps(merged, keeps);
    }
    return merged;
  });
  const ownIds = new Set(nodes.map((node) => String(node.id)));
  const pathOf = new Map<string, string | null>();
  for (const node of input.previous.nodes) pathOf.set(String(node.id), nodePath(node));
  for (const node of nodes) pathOf.set(String(node.id), nodePath(node));
  const importsOf = (path: string): ReadonlySet<string> =>
    new Set((input.importMap[path] ?? []).map((target) => normalizeRelativePath(target)));

  let dropped = 0;
  const semantic: GraphRecord[] = [];
  for (const edge of input.previous.edges) {
    const source = String(edge.source);
    if (!ownIds.has(source)) continue;
    if (STRUCTURAL_EDGE_TYPES.has(String(edge.type))) continue;
    const target = String(edge.target);
    const targetKnown = ownIds.has(target) || input.knownIds.has(target);
    if (!targetKnown) {
      dropped += 1;
      continue;
    }
    const sourcePath = pathOf.get(source) ?? null;
    const targetPath = pathOf.get(target) ?? null;
    if (
      sourcePath &&
      targetPath &&
      sourcePath !== targetPath &&
      !importsOf(sourcePath).has(targetPath) &&
      !importsOf(targetPath).has(sourcePath)
    ) {
      dropped += 1;
      continue;
    }
    const metadata =
      typeof edge.metadata === 'object' && edge.metadata !== null ? (edge.metadata as Record<string, unknown>) : {};
    semantic.push({ ...edge, metadata: { ...metadata, unverifiedSince: input.runId } });
  }
  return {
    batch: {
      batchIndex: KEPT_BATCH_INDEX,
      paths: [...paths].sort(),
      nodes,
      edges: [...structural.edges, ...semantic],
    },
    droppedEdges: dropped,
    keptEdges: semantic.length,
    unannotated,
  };
}
