import { buildStructuralGraph } from './hybrid-structure';
import type { MergeBatchInput } from './merge';
import { nodePath, normalizeRelativePath } from './node-path';
import type { BatchInput, ExtractedFile, GraphRecord, ScanFile } from './types';

export const ARCHMAP_PENDING_TAG = 'pending';
export const RETAINED_BATCH_INDEX = -2;
export const PLACEHOLDER_BATCH_INDEX = -1;

export function retainedPreviousBatch(
  previous: { nodes: readonly GraphRecord[]; edges: readonly GraphRecord[] },
  keepPaths: ReadonlySet<string>,
): MergeBatchInput {
  const keep = new Set([...keepPaths].map((p) => normalizeRelativePath(p)));
  const retainedIds = new Set<string>();
  const nodes: GraphRecord[] = [];
  const paths = new Set<string>();
  for (const node of previous.nodes) {
    const path = nodePath(node);
    if (path === null || !keep.has(path)) continue;
    retainedIds.add(String(node.id));
    paths.add(path);
    nodes.push({ ...node });
  }
  const edges = previous.edges.filter((edge) => retainedIds.has(String(edge.source))).map((edge) => ({ ...edge }));
  return { batchIndex: RETAINED_BATCH_INDEX, paths: [...paths].sort(), nodes, edges };
}

export function placeholderBatch(
  projectName: string,
  files: readonly ScanFile[],
  extraction: readonly ExtractedFile[],
  importMap: Record<string, string[]>,
): MergeBatchInput {
  const paths = files.map((file) => file.path);
  const input: BatchInput = {
    projectName,
    batchIndex: PLACEHOLDER_BATCH_INDEX,
    files: [...files],
    extraction: extraction.filter((entry) => paths.includes(entry.path)),
    batchImportData: Object.fromEntries(paths.map((path) => [path, importMap[path] ?? []])),
    neighborMap: {},
    sources: {},
    context: { languages: [], frameworks: [] },
  };
  const graph = buildStructuralGraph(input);
  const nodes = graph.nodes.map((node) => ({
    ...node,
    tags: [...new Set([...((node.tags as string[] | undefined) ?? []), ARCHMAP_PENDING_TAG])],
  }));
  return { batchIndex: PLACEHOLDER_BATCH_INDEX, paths: [...paths].sort(), nodes, edges: graph.edges };
}
