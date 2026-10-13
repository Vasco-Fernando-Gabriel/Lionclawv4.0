import { GraphEdgeSchema, GraphNodeSchema, normalizeGraph, sanitizeGraph } from '../core/schema';
import { nodePath, normalizeRelativePath } from './node-path';

export { nodePath };
import { FILE_LEVEL_TYPES, SUB_NODE_TYPES } from '../node-types';

export { FILE_LEVEL_TYPES, SUB_NODE_TYPES };

const VALID_PREFIXES = new Set([
  'file',
  'func',
  'function',
  'class',
  'module',
  'concept',
  'config',
  'document',
  'service',
  'table',
  'endpoint',
  'pipeline',
  'schema',
  'resource',
  'domain',
  'flow',
  'step',
]);

const COMPLEXITY_MAP: Record<string, string> = {
  low: 'simple',
  easy: 'simple',
  trivial: 'simple',
  basic: 'simple',
  medium: 'moderate',
  intermediate: 'moderate',
  mid: 'moderate',
  average: 'moderate',
  high: 'complex',
  hard: 'complex',
  difficult: 'complex',
  advanced: 'complex',
};

export class SchemaGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaGateError';
  }
}

export function normalizeComplexity(value: unknown): 'simple' | 'moderate' | 'complex' {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'simple' || lower === 'moderate' || lower === 'complex') return lower;
    const mapped = COMPLEXITY_MAP[lower];
    if (mapped) return mapped as 'simple' | 'moderate' | 'complex';
    return 'moderate';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 3) return 'simple';
    if (value <= 6) return 'moderate';
    return 'complex';
  }
  return 'moderate';
}

export function normalizeNodeId(rawId: string, node: { type?: string; filePath?: string; name?: string }): string {
  let nid = rawId.trim();
  for (const prefix of VALID_PREFIXES) {
    const double = `${prefix}:${prefix}:`;
    if (nid.startsWith(double)) {
      nid = nid.slice(prefix.length + 1);
      break;
    }
  }
  const projectMatch = /^([^:]+):([^:]+):(.+)$/.exec(nid);
  if (projectMatch && !VALID_PREFIXES.has(projectMatch[1]!) && VALID_PREFIXES.has(projectMatch[2]!)) {
    nid = `${projectMatch[2]}:${projectMatch[3]}`;
  }
  if (nid.startsWith('func:')) nid = `function:${nid.slice(5)}`;
  const hasPrefix = [...VALID_PREFIXES].some((p) => nid.startsWith(`${p}:`));
  if (!hasPrefix) {
    const type = node.type ?? 'file';
    const prefix = type === 'func' ? 'function' : type;
    if (type === 'function' || type === 'class') {
      const name = node.name ?? nid;
      nid = node.filePath ? `${prefix}:${node.filePath}:${name}` : `${prefix}:__nofilepath__:${name}`;
    } else {
      nid = `${prefix}:${nid}`;
    }
  }
  return nid;
}

export interface NormalizedBatch {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  idMap: Map<string, string>;
  warnings: string[];
}

export function normalizeBatchOutput(
  raw: unknown,
  batchPaths: readonly string[],
  label: string,
  options: { allowIncomplete?: boolean } = {},
): NormalizedBatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaGateError('a resposta nao e um objeto JSON');
  }
  const envelope = raw as Record<string, unknown>;
  if (!Array.isArray(envelope.nodes) || !Array.isArray(envelope.edges)) {
    throw new SchemaGateError('a resposta nao contem os arrays `nodes` e `edges`');
  }
  const warnings: string[] = [];
  const idMap = new Map<string, string>();

  const aliased = normalizeGraph(sanitizeGraph({ nodes: envelope.nodes, edges: envelope.edges })) as {
    nodes: unknown[];
    edges: unknown[];
  };

  const nodes: Record<string, unknown>[] = [];
  aliased.nodes.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`${label}: nodes[${index}] nao e objeto — descartado`);
      return;
    }
    const node = { ...(entry as Record<string, unknown>) };
    if (typeof node.id !== 'string' || node.id.trim().length === 0 || typeof node.type !== 'string') {
      warnings.push(`${label}: nodes[${index}] sem id/type — descartado`);
      return;
    }
    const originalId = node.id;
    const corrected = normalizeNodeId(originalId, {
      type: node.type,
      filePath: typeof node.filePath === 'string' ? node.filePath : undefined,
      name: typeof node.name === 'string' ? node.name : undefined,
    });
    if (corrected !== originalId) idMap.set(originalId, corrected);
    node.id = corrected;
    if (typeof node.filePath === 'string') node.filePath = normalizeRelativePath(node.filePath.trim());
    node.complexity = normalizeComplexity(node.complexity);
    if (!Array.isArray(node.tags) || node.tags.length === 0) {
      node.tags = ['untagged'];
    } else {
      node.tags = (node.tags as unknown[]).filter((t) => typeof t === 'string' && t.length > 0);
      if ((node.tags as string[]).length === 0) node.tags = ['untagged'];
    }
    if (typeof node.name !== 'string' || node.name.length === 0) {
      node.name = corrected.slice(corrected.lastIndexOf(':') + 1) || corrected;
    }
    if (typeof node.summary !== 'string' || node.summary.trim().length === 0) {
      node.summary = String(node.name);
    }
    if (Array.isArray(node.lineRange)) {
      const [a, b] = node.lineRange as unknown[];
      if (typeof a === 'number' && typeof b === 'number') node.lineRange = [Math.round(a), Math.round(b)];
      else delete node.lineRange;
    } else if (node.lineRange !== undefined) {
      delete node.lineRange;
    }
    const parsed = GraphNodeSchema.safeParse(node);
    if (!parsed.success) {
      warnings.push(`${label}: no ${corrected} invalido (${parsed.error.issues[0]?.message ?? 'schema'}) — descartado`);
      return;
    }
    nodes.push(parsed.data as Record<string, unknown>);
  });

  const edges: Record<string, unknown>[] = [];
  aliased.edges.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`${label}: edges[${index}] nao e objeto — descartada`);
      return;
    }
    const edge = { ...(entry as Record<string, unknown>) };
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      warnings.push(`${label}: edges[${index}] sem source/target — descartada`);
      return;
    }
    edge.source = idMap.get(edge.source) ?? edge.source;
    edge.target = idMap.get(edge.target) ?? edge.target;
    if (typeof edge.direction !== 'string') edge.direction = 'forward';
    const rawWeight: unknown = typeof edge.weight === 'string' ? Number.parseFloat(edge.weight) : edge.weight;
    const weight = typeof rawWeight === 'number' && Number.isFinite(rawWeight) ? rawWeight : 0.5;
    edge.weight = Math.max(0, Math.min(1, weight));
    if (edge.description !== undefined && typeof edge.description !== 'string') delete edge.description;
    const parsed = GraphEdgeSchema.safeParse(edge);
    if (!parsed.success) {
      warnings.push(
        `${label}: aresta ${edge.source} → ${edge.target} invalida (${parsed.error.issues[0]?.message ?? 'schema'}) — descartada`,
      );
      return;
    }
    edges.push(parsed.data as Record<string, unknown>);
  });

  const known = new Set(batchPaths.map((p) => normalizeRelativePath(p)));
  const covered = new Set<string>();
  for (const node of nodes) {
    if (!FILE_LEVEL_TYPES.has(String(node.type))) continue;
    const path = nodePath(node, known);
    if (path && known.has(path)) covered.add(path);
  }
  const missing = [...known].filter((p) => !covered.has(p));
  if (missing.length > 0 && !options.allowIncomplete) {
    throw new SchemaGateError(
      `faltou o no de nivel de arquivo (file:/config:/document:/…) de: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` e mais ${missing.length - 10}` : ''}`,
    );
  }
  return { nodes, edges, idMap, warnings };
}
