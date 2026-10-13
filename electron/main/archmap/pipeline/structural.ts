import { nodePath } from './node-path';
import type { BatchInput, GraphRecord } from './types';

export function structuralEdges(
  input: BatchInput,
  nodes: readonly GraphRecord[],
  edges: readonly GraphRecord[],
): GraphRecord[] {
  const out = [...edges];
  const known = new Set(edges.map((edge) => `${edge.source}\0${edge.target}\0${edge.type}`));
  const fileNodes = new Map<string, string>();
  const files = new Map(input.files.filter((f) => f.fileCategory === 'code').map((f) => [f.path, f]));
  const extraction = new Map(input.extraction.map((entry) => [entry.path, entry]));
  for (const node of nodes) {
    const path = nodePath(node);
    if (node.type === 'file' && path && files.has(path) && typeof node.id === 'string') fileNodes.set(path, node.id);
  }
  const add = (source: string, target: string, type: string, weight: number) => {
    const key = `${source}\0${target}\0${type}`;
    if (!known.has(key)) {
      known.add(key);
      out.push({ source, target, type, weight, direction: 'forward' });
    }
  };
  for (const [path, id] of fileNodes) {
    for (const target of input.batchImportData[path] ?? [])
      add(id, fileNodes.get(target) ?? `file:${target}`, 'imports', 0.7);
  }
  for (const node of nodes) {
    if (node.type !== 'function' && node.type !== 'class') continue;
    const path = nodePath(node);
    const owner = path ? fileNodes.get(path) : undefined;
    if (!owner || typeof node.id !== 'string') continue;
    add(owner, node.id, 'contains', 1);
    if (extraction.get(path!)?.exports?.some((exp) => exp.name === node.name)) add(owner, node.id, 'exports', 0.8);
  }
  return out;
}
