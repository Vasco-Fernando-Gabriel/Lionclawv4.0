import { FILE_LEVEL_TYPES } from './normalize';
import type { FileNodeSummary, LayerOutput, LayerStats } from './types';

export interface GraphLike {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export const MAX_LAYERS = 10;

export function fileNodeSummaries(graph: GraphLike): FileNodeSummary[] {
  const out: FileNodeSummary[] = [];
  for (const node of graph.nodes) {
    const type = String(node.type);
    if (!FILE_LEVEL_TYPES.has(type) && !['table', 'endpoint'].includes(type)) continue;
    if (typeof node.filePath !== 'string') continue;
    out.push({
      id: String(node.id),
      type,
      name: String(node.name ?? ''),
      filePath: node.filePath,
      summary: String(node.summary ?? ''),
      tags: Array.isArray(node.tags) ? (node.tags as string[]) : [],
    });
  }
  return out;
}

const DIR_PATTERNS: Array<[string[], string]> = [
  [
    ['routes', 'api', 'controllers', 'endpoints', 'handlers', 'serializers', 'controller', 'routers', 'blueprints'],
    'api',
  ],
  [
    ['services', 'core', 'lib', 'domain', 'logic', 'signals', 'internal', 'composables', 'mailers', 'jobs', 'channels'],
    'service',
  ],
  [
    [
      'models',
      'db',
      'data',
      'persistence',
      'repository',
      'entities',
      'migrations',
      'entity',
      'sql',
      'database',
      'schema',
    ],
    'data',
  ],
  [['components', 'views', 'pages', 'ui', 'layouts', 'screens'], 'ui'],
  [['middleware', 'plugins', 'interceptors', 'guards'], 'middleware'],
  [['utils', 'helpers', 'common', 'shared', 'tools', 'templatetags', 'pkg'], 'utility'],
  [['config', 'constants', 'env', 'settings', 'management', 'commands'], 'config'],
  [['__tests__', 'test', 'tests', 'spec', 'specs'], 'test'],
  [['types', 'interfaces', 'schemas', 'contracts', 'dtos', 'dto', 'request', 'response'], 'types'],
  [['hooks'], 'hooks'],
  [['store', 'state', 'reducers', 'actions', 'slices'], 'state'],
  [['assets', 'static', 'public'], 'assets'],
  [['cmd', 'bin'], 'entry'],
  [['docs', 'documentation', 'wiki'], 'documentation'],
  [
    [
      'deploy',
      'deployment',
      'infra',
      'infrastructure',
      'k8s',
      'kubernetes',
      'helm',
      'charts',
      'terraform',
      'tf',
      'docker',
    ],
    'infrastructure',
  ],
  [['.github', '.gitlab', '.circleci'], 'ci-cd'],
];

function patternFor(group: string): string | null {
  const lower = group.toLowerCase();
  for (const [names, label] of DIR_PATTERNS) if (names.includes(lower)) return label;
  return null;
}

function dirOf(p: string): string {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  let prefixSegs = dirOf(paths[0]!).split('/').filter(Boolean);
  for (const p of paths.slice(1)) {
    const segs = dirOf(p).split('/').filter(Boolean);
    let i = 0;
    while (i < prefixSegs.length && i < segs.length && prefixSegs[i] === segs[i]) i += 1;
    prefixSegs = prefixSegs.slice(0, i);
    if (prefixSegs.length === 0) break;
  }
  return prefixSegs.join('/');
}

export function directoryGroup(path: string, prefix: string): string {
  const rel = prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
  const dir = dirOf(rel);
  if (!dir) return 'root';
  return dir.split('/')[0]!;
}

export function computeLayerStats(fileNodes: FileNodeSummary[], edges: Record<string, unknown>[]): LayerStats {
  const idToNode = new Map(fileNodes.map((n) => [n.id, n]));
  const prefix = commonPrefix(fileNodes.map((n) => n.filePath));
  const groupOf = new Map<string, string>();
  const directoryGroups: Record<string, string[]> = {};
  const nodeTypeGroups: Record<string, string[]> = {};
  for (const node of fileNodes) {
    const group = directoryGroup(node.filePath, prefix);
    groupOf.set(node.id, group);
    (directoryGroups[group] ??= []).push(node.id);
    (nodeTypeGroups[node.type] ??= []).push(node.id);
  }
  const fileEdges = edges.filter((e) => idToNode.has(String(e.source)) && idToNode.has(String(e.target)));
  const importEdges = fileEdges.filter((e) => e.type === 'imports');

  const fanIn: Record<string, number> = {};
  const fanOut: Record<string, number> = {};
  const inter = new Map<string, number>();
  const intra: Record<string, { internalEdges: number; totalEdges: number }> = {};
  for (const e of importEdges) {
    const s = String(e.source);
    const t = String(e.target);
    fanOut[s] = (fanOut[s] ?? 0) + 1;
    fanIn[t] = (fanIn[t] ?? 0) + 1;
    const gs = groupOf.get(s)!;
    const gt = groupOf.get(t)!;
    (intra[gs] ??= { internalEdges: 0, totalEdges: 0 }).totalEdges += 1;
    if (gs !== gt) {
      (intra[gt] ??= { internalEdges: 0, totalEdges: 0 }).totalEdges += 1;
      const key = `${gs}\u0000${gt}`;
      inter.set(key, (inter.get(key) ?? 0) + 1);
    } else {
      intra[gs]!.internalEdges += 1;
    }
  }
  const cross = new Map<string, number>();
  for (const e of fileEdges) {
    const ft = idToNode.get(String(e.source))!.type;
    const tt = idToNode.get(String(e.target))!.type;
    if (ft === tt) continue;
    const key = `${ft}\u0000${tt}\u0000${String(e.type)}`;
    cross.set(key, (cross.get(key) ?? 0) + 1);
  }
  const interGroupImports = [...inter.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('\u0000');
      return { from: from!, to: to!, count };
    })
    .sort((a, b) => b.count - a.count);
  const direction: Array<{ dependent: string; dependsOn: string }> = [];
  const seenPairs = new Set<string>();
  for (const entry of interGroupImports) {
    const pairKey = [entry.from, entry.to].sort().join('\u0000');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const reverse = inter.get(`${entry.to}\u0000${entry.from}`) ?? 0;
    if (entry.count >= reverse) direction.push({ dependent: entry.from, dependsOn: entry.to });
    else direction.push({ dependent: entry.to, dependsOn: entry.from });
  }
  const patternMatches: Record<string, string> = {};
  for (const group of Object.keys(directoryGroups)) {
    const label = patternFor(group);
    if (label) patternMatches[group] = label;
  }
  const paths = fileNodes.map((n) => n.filePath);
  const infraFiles = paths.filter((p) =>
    /(^|\/)(Dockerfile|docker-compose\.[^/]+|compose\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile)$|\.tf$|\.tfvars$|^\.github\/workflows\/|(^|\/)(k8s|kubernetes)\//.test(
      p,
    ),
  );
  const deploymentTopology: LayerStats['deploymentTopology'] = {
    hasDockerfile: paths.some((p) => /(^|\/)Dockerfile(\.|$)/.test(p)),
    hasCompose: paths.some((p) => /(^|\/)(docker-compose\.|compose\.ya?ml$)/.test(p)),
    hasK8s: paths.some((p) => /(^|\/)(k8s|kubernetes)\//.test(p) || /\.k8s\.ya?ml$/.test(p)),
    hasTerraform: paths.some((p) => /\.tf$|\.tfvars$/.test(p)),
    hasCI: paths.some((p) => /^\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$|^\.circleci\//.test(p)),
    infraFiles,
  };
  const groups = Object.keys(directoryGroups);
  const docGroups = new Set<string>();
  for (const node of fileNodes) {
    if (node.type === 'document' || /\.(md|rst)$/i.test(node.filePath)) docGroups.add(groupOf.get(node.id)!);
  }
  const undocumented = groups.filter((g) => !docGroups.has(g));
  const filesPerGroup: Record<string, number> = {};
  for (const [g, ids] of Object.entries(directoryGroups)) filesPerGroup[g] = ids.length;
  const nodeTypeCounts: Record<string, number> = {};
  for (const [t, ids] of Object.entries(nodeTypeGroups)) nodeTypeCounts[t] = ids.length;
  const intraGroupDensity: LayerStats['intraGroupDensity'] = {};
  for (const [g, v] of Object.entries(intra)) {
    intraGroupDensity[g] = {
      ...v,
      density: v.totalEdges > 0 ? Number((v.internalEdges / v.totalEdges).toFixed(3)) : 0,
    };
  }
  const topN = (rec: Record<string, number>, n: number): Record<string, number> =>
    Object.fromEntries(
      Object.entries(rec)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n),
    );
  return {
    directoryGroups,
    nodeTypeGroups,
    crossCategoryEdges: [...cross.entries()].map(([k, count]) => {
      const [fromType, toType, edgeType] = k.split('\u0000');
      return { fromType: fromType!, toType: toType!, edgeType: edgeType!, count };
    }),
    interGroupImports,
    intraGroupDensity,
    patternMatches,
    deploymentTopology,
    docCoverage: {
      groupsWithDocs: docGroups.size,
      totalGroups: groups.length,
      coverageRatio: groups.length > 0 ? Number((docGroups.size / groups.length).toFixed(2)) : 0,
      undocumentedGroups: undocumented,
    },
    dependencyDirection: direction,
    fileStats: { totalFileNodes: fileNodes.length, filesPerGroup, nodeTypeCounts },
    fileFanIn: topN(fanIn, 40),
    fileFanOut: topN(fanOut, 40),
  };
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^layer:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'camada';
}

export interface LayerPostResult {
  layers: LayerOutput[];
  warnings: string[];
}

export function postProcessLayers(raw: unknown, fileNodes: FileNodeSummary[], label = 'camadas'): LayerPostResult {
  const warnings: string[] = [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { layers?: unknown }).layers)
      ? (raw as { layers: unknown[] }).layers
      : [];
  const known = new Map(fileNodes.map((n) => [n.id, n]));
  const assigned = new Set<string>();
  const usedIds = new Set<string>();
  const layers: LayerOutput[] = [];
  list.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const l = entry as Record<string, unknown>;
    const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim() : `Camada ${index + 1}`;
    let id = `layer:${slugify(typeof l.id === 'string' && l.id.trim() ? l.id : name)}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `layer:${slugify(name)}-${suffix++}`;
    const nodeIds: string[] = [];
    for (const rawId of Array.isArray(l.nodeIds) ? (l.nodeIds as unknown[]) : []) {
      const nid = String(rawId);
      if (!known.has(nid)) {
        warnings.push(`${label}: id desconhecido ${nid} em ${id} — removido`);
        continue;
      }
      if (assigned.has(nid)) continue;
      assigned.add(nid);
      nodeIds.push(nid);
    }
    if (nodeIds.length === 0) {
      warnings.push(`${label}: camada ${id} vazia — removida`);
      return;
    }
    usedIds.add(id);
    layers.push({
      id,
      name,
      description: typeof l.description === 'string' ? l.description : '',
      nodeIds,
    });
  });

  const layerOfNode = new Map<string, LayerOutput>();
  for (const layer of layers) for (const nid of layer.nodeIds) layerOfNode.set(nid, layer);
  const layerByDir = new Map<string, Map<LayerOutput, number>>();
  for (const node of fileNodes) {
    const layer = layerOfNode.get(node.id);
    if (!layer) continue;
    let dir = dirOf(node.filePath);
    for (;;) {
      const counts = layerByDir.get(dir) ?? new Map<LayerOutput, number>();
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
      layerByDir.set(dir, counts);
      if (!dir) break;
      dir = dirOf(dir);
    }
  }
  const pickLayer = (path: string): LayerOutput | null => {
    let dir = dirOf(path);
    for (;;) {
      const counts = layerByDir.get(dir);
      if (counts && counts.size > 0) {
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      }
      if (!dir) return null;
      dir = dirOf(dir);
    }
  };
  let fallback: LayerOutput | null = null;
  for (const node of fileNodes) {
    if (assigned.has(node.id)) continue;
    let target = pickLayer(node.filePath) ?? layers[0] ?? null;
    if (!target) {
      fallback ??= { id: 'layer:outros', name: 'Outros', description: 'Arquivos sem camada atribuida.', nodeIds: [] };
      target = fallback;
    }
    target.nodeIds.push(node.id);
    assigned.add(node.id);
    warnings.push(`${label}: ${node.id} sem camada — atribuido a ${target.id}`);
  }
  if (fallback) layers.push(fallback);

  const minLayers = Math.min(3, fileNodes.length);
  while (layers.length > MAX_LAYERS) {
    layers.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    const smallest = layers.pop()!;
    const target = layers[layers.length - 1]!;
    target.nodeIds.push(...smallest.nodeIds);
    warnings.push(`${label}: acima de ${MAX_LAYERS} camadas — ${smallest.id} fundida em ${target.id}`);
  }
  while (layers.length < minLayers) {
    layers.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    const largest = layers[0];
    if (!largest || largest.nodeIds.length < 2) break;
    const groups = new Map<string, string[]>();
    for (const nid of largest.nodeIds) {
      const path = known.get(nid)?.filePath ?? '';
      const group = directoryGroup(path, '');
      (groups.get(group) ?? groups.set(group, []).get(group)!).push(nid);
    }
    let moved: [string, string[]] | null = null;
    if (groups.size >= 2) {
      moved = [...groups.entries()].sort((a, b) => a[1].length - b[1].length)[0]!;
    } else {
      const half = Math.floor(largest.nodeIds.length / 2);
      moved = ['parte', largest.nodeIds.slice(half)];
    }
    const movedSet = new Set(moved[1]);
    largest.nodeIds = largest.nodeIds.filter((nid) => !movedSet.has(nid));
    let id = `layer:${slugify(`${largest.id}-${moved[0]}`)}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `layer:${slugify(`${largest.id}-${moved[0]}`)}-${suffix++}`;
    usedIds.add(id);
    layers.push({
      id,
      name: `${largest.name} — ${moved[0]}`,
      description: `${largest.description} (subconjunto ${moved[0]}).`.trim(),
      nodeIds: moved[1],
    });
    warnings.push(`${label}: abaixo de ${minLayers} camadas — ${largest.id} dividida em ${id}`);
  }
  return { layers, warnings };
}
