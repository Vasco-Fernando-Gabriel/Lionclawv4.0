import { FILE_LEVEL_TYPES } from './normalize';
import type { FileNodeSummary, LayerOutput, TourStepOutput, TourTopology } from './types';

export const MAX_TOUR_STEPS = 15;

const ENTRY_NAMES = new Set([
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'app.ts',
  'app.js',
  'server.ts',
  'server.js',
  'mod.rs',
  'main.go',
  'main.py',
  'main.rs',
  'manage.py',
  'app.py',
  'wsgi.py',
  'asgi.py',
  'run.py',
  '__main__.py',
  'Application.java',
  'Main.java',
  'Program.cs',
  'config.ru',
  'index.php',
  'App.swift',
  'Application.kt',
  'main.cpp',
  'main.c',
]);

function baseOf(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
}
function depthOf(p: string): number {
  return p.split('/').length - 1;
}

export function computeTourTopology(fileNodes: FileNodeSummary[], edges: Record<string, unknown>[]): TourTopology {
  const byId = new Map(fileNodes.map((n) => [n.id, n]));
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const forward = new Map<string, Set<string>>();
  const undirected = new Map<string, Set<string>>();
  let edgeCount = 0;
  for (const e of edges) {
    const s = String(e.source);
    const t = String(e.target);
    if (!byId.has(s) || !byId.has(t) || s === t) continue;
    edgeCount += 1;
    fanOut.set(s, (fanOut.get(s) ?? 0) + 1);
    fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
    if (e.type === 'imports' || e.type === 'calls') {
      (forward.get(s) ?? forward.set(s, new Set()).get(s)!).add(t);
    }
    (undirected.get(s) ?? undirected.set(s, new Set()).get(s)!).add(t);
    (undirected.get(t) ?? undirected.set(t, new Set()).get(t)!).add(s);
  }
  const ranked = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20);
  const fanOutValues = [...fanOut.values()].sort((a, b) => b - a);
  const fanInValues = [...fanIn.values()].sort((a, b) => a - b);
  const topFanOut = fanOutValues[Math.max(0, Math.floor(fanOutValues.length * 0.1) - 1)] ?? Infinity;
  const lowFanIn = fanInValues[Math.floor(fanInValues.length * 0.25)] ?? 0;

  const candidates: TourTopology['entryPointCandidates'] = [];
  for (const node of fileNodes) {
    let score = 0;
    const base = baseOf(node.filePath);
    const depth = depthOf(node.filePath);
    if (node.type === 'document') {
      if (/^readme\.md$/i.test(base) && depth === 0) score += 5;
      else if (depth === 0 && /\.md$/i.test(base)) score += 2;
    } else {
      if (ENTRY_NAMES.has(base)) score += 3;
      if (depth <= 1) score += 1;
      if ((fanOut.get(node.id) ?? 0) >= topFanOut && fanOutValues.length > 0) score += 1;
      if ((fanIn.get(node.id) ?? 0) <= lowFanIn) score += 1;
    }
    if (score > 0) candidates.push({ id: node.id, score, name: node.name, summary: node.summary });
  }
  candidates.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  const codeEntry =
    candidates.find((c) => byId.get(c.id)?.type !== 'document') ??
    (fileNodes.find((n) => n.type === 'file') ? { id: fileNodes.find((n) => n.type === 'file')!.id } : null);
  const order: string[] = [];
  const byDepth: Record<string, string[]> = {};
  if (codeEntry) {
    const depth = new Map<string, number>([[codeEntry.id, 0]]);
    const queue = [codeEntry.id];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      order.push(current);
      const d = depth.get(current)!;
      (byDepth[String(d)] ??= []).push(current);
      for (const next of [...(forward.get(current) ?? [])].sort()) {
        if (depth.has(next)) continue;
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }

  const bucket = (types: string[]) =>
    fileNodes.filter((n) => types.includes(n.type)).map((n) => ({ id: n.id, name: n.name, summary: n.summary }));

  const clusters: TourTopology['clusters'] = [];
  const clustered = new Set<string>();
  for (const [a, targets] of forward) {
    for (const b of targets) {
      if (clustered.has(a) || clustered.has(b) || !forward.get(b)?.has(a)) continue;
      const members = new Set([a, b]);
      for (const candidate of fileNodes) {
        if (members.has(candidate.id) || members.size >= 5) continue;
        const links = [...(undirected.get(candidate.id) ?? [])].filter((x) => members.has(x)).length;
        if (links >= 2) members.add(candidate.id);
      }
      let internal = 0;
      for (const m of members) for (const n of undirected.get(m) ?? []) if (members.has(n)) internal += 1;
      clusters.push({ nodes: [...members], edgeCount: Math.floor(internal / 2) });
      for (const m of members) clustered.add(m);
      if (clusters.length >= 10) break;
    }
    if (clusters.length >= 10) break;
  }

  return {
    entryPointCandidates: candidates.slice(0, 5),
    fanInRanking: ranked(fanIn).map(([id, n]) => ({ id, fanIn: n, name: byId.get(id)?.name ?? id })),
    fanOutRanking: ranked(fanOut).map(([id, n]) => ({ id, fanOut: n, name: byId.get(id)?.name ?? id })),
    bfsTraversal: { startNode: codeEntry?.id ?? null, order, byDepth },
    nonCodeFiles: {
      documentation: bucket(['document']),
      infrastructure: bucket(['service', 'pipeline', 'resource']),
      data: bucket(['table', 'schema', 'endpoint']),
      config: bucket(['config']),
    },
    clusters,
    totalNodes: fileNodes.length,
    totalEdges: edgeCount,
  };
}

export interface TourPostResult {
  steps: TourStepOutput[];
  warnings: string[];
}

export function postProcessTour(
  raw: unknown,
  validNodeIds: ReadonlySet<string>,
  fileNodes: FileNodeSummary[],
  layers: LayerOutput[],
  topology: TourTopology,
  label = 'tour',
): TourPostResult {
  const warnings: string[] = [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { steps?: unknown }).steps)
      ? (raw as { steps: unknown[] }).steps
      : [];
  const steps: TourStepOutput[] = [];
  const ordered = [...list].sort((a, b) => {
    const oa = typeof (a as { order?: unknown })?.order === 'number' ? (a as { order: number }).order : Infinity;
    const ob = typeof (b as { order?: unknown })?.order === 'number' ? (b as { order: number }).order : Infinity;
    return oa - ob;
  });
  ordered.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const s = entry as Record<string, unknown>;
    const nodeIds: string[] = [];
    for (const rawId of Array.isArray(s.nodeIds) ? (s.nodeIds as unknown[]) : []) {
      const nid = String(rawId);
      if (!validNodeIds.has(nid)) {
        warnings.push(`${label}: id inexistente ${nid} no passo ${index + 1} — removido`);
        continue;
      }
      if (!nodeIds.includes(nid)) nodeIds.push(nid);
    }
    if (nodeIds.length === 0) {
      warnings.push(`${label}: passo ${index + 1} sem ids validos — removido`);
      return;
    }
    const step: TourStepOutput = {
      order: 0,
      title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : `Passo ${index + 1}`,
      description: typeof s.description === 'string' ? s.description : '',
      nodeIds: nodeIds.slice(0, 5),
    };
    if (typeof s.languageLesson === 'string' && s.languageLesson.trim()) {
      step.languageLesson = s.languageLesson;
    }
    steps.push(step);
  });

  const minSteps = Math.min(5, fileNodes.length);
  if (steps.length > MAX_TOUR_STEPS) {
    warnings.push(`${label}: ${steps.length} passos acima de ${MAX_TOUR_STEPS} — cortado`);
    steps.length = MAX_TOUR_STEPS;
  }
  if (steps.length < minSteps) {
    const used = new Set(steps.flatMap((s) => s.nodeIds));
    const nameOf = new Map(fileNodes.map((n) => [n.id, n.name]));
    const layerOf = new Map<string, string>();
    for (const layer of layers) for (const nid of layer.nodeIds) layerOf.set(nid, layer.name);
    const pool = [...topology.bfsTraversal.order, ...fileNodes.map((n) => n.id)];
    for (const nid of pool) {
      if (steps.length >= minSteps) break;
      if (used.has(nid) || !validNodeIds.has(nid)) continue;
      used.add(nid);
      const name = nameOf.get(nid) ?? nid;
      const layerName = layerOf.get(nid);
      steps.push({
        order: 0,
        title: name,
        description: layerName ? `Explore ${name}, parte da camada ${layerName}.` : `Explore ${name}.`,
        nodeIds: [nid],
      });
    }
    warnings.push(`${label}: abaixo de ${minSteps} passos — completado com passos sinteticos`);
  }
  steps.forEach((s, i) => {
    s.order = i + 1;
  });
  return { steps, warnings };
}

export function tourNodeIds(nodes: Record<string, unknown>[]): Set<string> {
  return new Set(nodes.map((n) => String(n.id)));
}

export function tourNodeIndex(
  nodes: Record<string, unknown>[],
): Record<string, { name: string; type: string; summary: string }> {
  const index: Record<string, { name: string; type: string; summary: string }> = {};
  for (const node of nodes) {
    const type = String(node.type);
    if (!FILE_LEVEL_TYPES.has(type) && !['table', 'endpoint', 'class'].includes(type)) continue;
    index[String(node.id)] = {
      name: String(node.name ?? ''),
      type,
      summary: String(node.summary ?? ''),
    };
  }
  return index;
}
