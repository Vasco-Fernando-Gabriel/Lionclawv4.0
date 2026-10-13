import { normalizeRelativePath } from './node-path';
import { FILE_LEVEL_TYPES, nodePath } from './normalize';

export interface MergeBatchInput {
  batchIndex: number;
  part?: number;
  paths: string[];
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export interface MergeResult {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  warnings: string[];
  stats: {
    inputNodes: number;
    inputEdges: number;
    droppedOutOfBatch: number;
    duplicates: number;
    danglingEdges: number;
    testedByAdded: number;
    recoveredImports: number;
  };
}

const JS_TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
const MIRROR_ROOTS = ['src', 'app', 'lib', ''];
const TEST_NAME_PATTERNS: Record<string, [string[], string[]]> = {
  '.go': [[], ['_test']],
  '.py': [['test_'], ['_test']],
  '.java': [[], ['Test', 'Tests', 'IT']],
  '.kt': [[], ['Test', 'Tests']],
  '.scala': [[], ['Spec', 'Suite', 'Test', 'Tests']],
  '.cs': [[], ['Test', 'Tests']],
  '.c': [['test_'], ['_test']],
  '.cpp': [['test_'], ['_test']],
  '.cc': [['test_'], ['_test']],
};

function splitExt(base: string): [string, string] {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return [base, ''];
  return [base.slice(0, dot), base.slice(dot)];
}
function basenameOf(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
}
function joinDir(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function isTestPath(path: string): boolean {
  const [stem, ext] = splitExt(basenameOf(path));
  if (JS_TS_EXTS.includes(ext)) return stem.endsWith('.test') || stem.endsWith('.spec');
  const patterns = TEST_NAME_PATTERNS[ext];
  if (!patterns) return false;
  const [prefixes, suffixes] = patterns;
  return prefixes.some((p) => stem.startsWith(p)) || suffixes.some((s) => stem.endsWith(s));
}

function addUnique(out: string[], p: string): void {
  if (p && !out.includes(p)) out.push(p);
}

export function productionCandidates(testPath: string): string[] {
  const [stem, ext] = splitExt(basenameOf(testPath));
  const segs = testPath.split('/').filter(Boolean);
  const dirSegs = segs.slice(0, -1);
  const dir = dirSegs.join('/');
  const out: string[] = [];
  if (JS_TS_EXTS.includes(ext)) {
    const infix = stem.endsWith('.test') ? '.test' : stem.endsWith('.spec') ? '.spec' : null;
    if (infix) {
      const base = stem.slice(0, -infix.length);
      addUnique(out, joinDir(dir, `${base}${ext}`));
      for (const e of JS_TS_EXTS) addUnique(out, joinDir(dir, `${base}${e}`));
      const last = dirSegs[dirSegs.length - 1];
      if (last && ['__tests__', 'test', 'spec', 'tests'].includes(last)) {
        const parent = dirSegs.slice(0, -1).join('/');
        addUnique(out, joinDir(parent, `${base}${ext}`));
        for (const e of JS_TS_EXTS) addUnique(out, joinDir(parent, `${base}${e}`));
      }
      if (dirSegs[0] && ['tests', 'test', '__tests__'].includes(dirSegs[0])) {
        const tail = dirSegs.slice(1).join('/');
        for (const root of MIRROR_ROOTS) {
          const newDir = [root, tail].filter(Boolean).join('/');
          addUnique(out, joinDir(newDir, `${base}${ext}`));
          for (const e of JS_TS_EXTS) addUnique(out, joinDir(newDir, `${base}${e}`));
        }
      }
    }
  } else if (ext === '.go' && stem.endsWith('_test')) {
    addUnique(out, joinDir(dir, `${stem.slice(0, -5)}.go`));
  } else if (ext === '.py' && (stem.startsWith('test_') || stem.endsWith('_test'))) {
    const base = stem.startsWith('test_') ? stem.slice(5) : stem.slice(0, -5);
    addUnique(out, joinDir(dir, `${base}.py`));
    const last = dirSegs[dirSegs.length - 1];
    if (last && ['tests', 'test'].includes(last)) {
      addUnique(out, joinDir(dirSegs.slice(0, -1).join('/'), `${base}.py`));
    }
    if (dirSegs[0] && ['tests', 'test'].includes(dirSegs[0])) {
      const tail = dirSegs.slice(1).join('/');
      for (const root of MIRROR_ROOTS) {
        addUnique(out, joinDir([root, tail].filter(Boolean).join('/'), `${base}.py`));
      }
    }
  } else if (ext === '.java' || ext === '.kt' || ext === '.scala' || ext === '.cs') {
    const suffixes = TEST_NAME_PATTERNS[ext]?.[1] ?? [];
    for (const suffix of [...suffixes].sort((a, b) => b.length - a.length)) {
      if (!stem.endsWith(suffix)) continue;
      const base = stem.slice(0, -suffix.length);
      const langDir = ext === '.java' ? 'java' : ext === '.kt' ? 'kotlin' : 'scala';
      for (let i = 0; i + 2 < dirSegs.length; i += 1) {
        if (dirSegs[i] === 'src' && dirSegs[i + 1] === 'test' && dirSegs[i + 2] === langDir) {
          const newDir = [...dirSegs.slice(0, i), 'src', 'main', langDir, ...dirSegs.slice(i + 3)].join('/');
          addUnique(out, `${newDir}/${base}${ext}`);
          break;
        }
      }
      addUnique(out, joinDir(dir, `${base}${ext}`));
      if (ext === '.cs') {
        const testsIdx = [...dirSegs].map((s) => s.toLowerCase()).lastIndexOf('tests');
        const idx = testsIdx >= 0 ? testsIdx : [...dirSegs].map((s) => s.toLowerCase()).lastIndexOf('test');
        if (idx >= 0) {
          const parent = dirSegs.slice(0, idx);
          const tail = dirSegs.slice(idx + 1);
          addUnique(out, joinDir(parent.join('/'), `${base}.cs`));
          addUnique(out, joinDir([...parent, 'src', ...tail].join('/'), `${base}.cs`));
        }
        const top = dirSegs[0];
        if (top && (top.endsWith('.Tests') || top.endsWith('.Test'))) {
          const sibling = top.endsWith('.Tests') ? top.slice(0, -6) : top.slice(0, -5);
          if (sibling) addUnique(out, joinDir([sibling, ...dirSegs.slice(1)].join('/'), `${base}.cs`));
        }
      }
      break;
    }
  } else if (['.c', '.cpp', '.cc'].includes(ext)) {
    const base = stem.startsWith('test_') ? stem.slice(5) : stem.endsWith('_test') ? stem.slice(0, -5) : null;
    if (base !== null) addUnique(out, joinDir(dir, `${base}${ext}`));
  }
  return out;
}

function fileNodePath(node: Record<string, unknown>): string | null {
  if (node.type !== 'file' || typeof node.id !== 'string' || !node.id.startsWith('file:')) return null;
  if (typeof node.filePath === 'string' && node.filePath.length > 0) return node.filePath;
  return node.id.slice(5);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number.parseFloat(String(v)) || 0;
}

function linkTests(
  nodesById: Map<string, Record<string, unknown>>,
  edges: Record<string, unknown>[],
): { edges: Record<string, unknown>[]; added: number; dropped: number } {
  const pathToNode = new Map<string, Record<string, unknown>>();
  const classification = new Map<string, 'test' | 'prod'>();
  const testNodes: Array<[string, Record<string, unknown>]> = [];
  for (const node of nodesById.values()) {
    const path = fileNodePath(node);
    if (!path) continue;
    pathToNode.set(path, node);
    if (isTestPath(path)) {
      classification.set(String(node.id), 'test');
      testNodes.push([path, node]);
    } else {
      classification.set(String(node.id), 'prod');
    }
  }
  const covered = new Map<string, number>();
  const out: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const edge of edges) {
    if (edge.type !== 'tested_by') {
      out.push(edge);
      continue;
    }
    const src = String(edge.source);
    const tgt = String(edge.target);
    const sc = classification.get(src);
    const tc = classification.get(tgt);
    let pair: [string, string];
    let swap = false;
    if (sc === 'prod' && tc === 'test') pair = [src, tgt];
    else if (sc === 'test' && tc === 'prod') {
      pair = [tgt, src];
      swap = true;
    } else {
      dropped += 1;
      continue;
    }
    const key = `${pair[0]}|${pair[1]}`;
    const canonical = swap
      ? {
          ...edge,
          source: pair[0],
          target: pair[1],
          direction: 'forward',
          description: edge.description
            ? `${String(edge.description)} [direcao corrigida]`
            : 'Direcao corrigida (era teste → producao)',
        }
      : edge;
    const existing = covered.get(key);
    if (existing !== undefined) {
      if (num(edge.weight) > num(out[existing]!.weight)) out[existing] = canonical;
      dropped += 1;
      continue;
    }
    covered.set(key, out.length);
    out.push(canonical);
  }
  const pairedTests = new Set([...covered.keys()].map((k) => k.split('|')[1]!));
  let added = 0;
  for (const [testPath, testNode] of testNodes) {
    if (pairedTests.has(String(testNode.id))) continue;
    for (const candidate of productionCandidates(testPath)) {
      const prod = pathToNode.get(candidate);
      if (!prod || isTestPath(candidate)) continue;
      const key = `${String(prod.id)}|${String(testNode.id)}`;
      if (covered.has(key)) continue;
      out.push({
        source: prod.id,
        target: testNode.id,
        type: 'tested_by',
        direction: 'forward',
        weight: 0.5,
        description: 'Pareamento por convencao de path (deterministico)',
      });
      covered.set(key, out.length - 1);
      added += 1;
      break;
    }
  }
  for (const key of covered.keys()) {
    const prod = nodesById.get(key.split('|')[0]!);
    if (!prod) continue;
    const tags = Array.isArray(prod.tags) ? (prod.tags as string[]) : [];
    if (!tags.includes('tested')) prod.tags = [...tags, 'tested'];
  }
  return { edges: out, added, dropped };
}

export function mergeBatches(
  batches: MergeBatchInput[],
  importMap: Record<string, string[]>,
  preserveReviewedEdges = false,
): MergeResult {
  const warnings: string[] = [];
  const stats: MergeResult['stats'] = {
    inputNodes: 0,
    inputEdges: 0,
    droppedOutOfBatch: 0,
    duplicates: 0,
    danglingEdges: 0,
    testedByAdded: 0,
    recoveredImports: 0,
  };
  const ordered = [...batches].sort((a, b) => a.batchIndex - b.batchIndex || (a.part ?? 0) - (b.part ?? 0));
  const nodesById = new Map<string, Record<string, unknown>>();
  const allEdges: Record<string, unknown>[] = [];
  for (const batch of ordered) {
    const label = `lote ${batch.batchIndex}${batch.part ? `-part-${batch.part}` : ''}`;
    const owned = new Set(batch.paths.map((p) => normalizeRelativePath(p)));
    stats.inputNodes += batch.nodes.length;
    stats.inputEdges += batch.edges.length;
    for (const node of batch.nodes) {
      const path = nodePath(node, owned);
      if (path === null || !owned.has(path)) {
        stats.droppedOutOfBatch += 1;
        warnings.push(`${label}: no ${String(node.id)} fora dos arquivos do lote — descartado`);
        continue;
      }
      const id = String(node.id);
      if (nodesById.has(id)) stats.duplicates += 1;
      nodesById.set(id, { ...node });
    }
    allEdges.push(...batch.edges.map((e) => ({ ...e })));
  }

  const linked = preserveReviewedEdges ? { edges: allEdges, added: 0, dropped: 0 } : linkTests(nodesById, allEdges);
  stats.testedByAdded = linked.added;

  const byKey = new Map<string, Record<string, unknown>>();
  for (const edge of linked.edges) {
    const src = String(edge.source);
    const tgt = String(edge.target);
    if (src === tgt) continue;
    if (!nodesById.has(src) || !nodesById.has(tgt)) {
      stats.danglingEdges += 1;
      continue;
    }
    const direction = typeof edge.direction === 'string' ? edge.direction : 'forward';
    const key = `${src}\u0000${tgt}\u0000${String(edge.type)}\u0000${direction}`;
    const existing = byKey.get(key);
    if (!existing || num(edge.weight) > num(existing.weight)) byKey.set(key, { ...edge, direction });
  }

  const wholeFileByPath = new Map<string, string>();
  const selectedType = new Map<string, string>();
  for (const node of nodesById.values()) {
    const type = String(node.type);
    const path = typeof node.filePath === 'string' ? node.filePath : null;
    if (!FILE_LEVEL_TYPES.has(type) || !path || node.id !== `${type}:${path}`) continue;
    const existing = wholeFileByPath.get(path);
    if (!existing) {
      wholeFileByPath.set(path, String(node.id));
      selectedType.set(path, type);
    } else if (type === 'file' && selectedType.get(path) !== 'file') {
      wholeFileByPath.set(path, String(node.id));
      selectedType.set(path, type);
      warnings.push(`merge: varios nos de arquivo para ${path}; selecionado ${String(node.id)}`);
    }
  }
  const existingImports = new Set<string>();
  for (const edge of byKey.values()) {
    if (edge.type === 'imports') existingImports.add(`${String(edge.source)}\u0000${String(edge.target)}`);
  }
  for (const [srcPath, targets] of Object.entries(importMap)) {
    const srcId = wholeFileByPath.get(srcPath);
    if (!srcId || !Array.isArray(targets)) continue;
    for (const tgtPath of targets) {
      const tgtId = wholeFileByPath.get(tgtPath);
      if (!tgtId || tgtId === srcId) continue;
      const pairKey = `${srcId}\u0000${tgtId}`;
      if (existingImports.has(pairKey)) continue;
      byKey.set(`${srcId}\u0000${tgtId}\u0000imports\u0000forward`, {
        source: srcId,
        target: tgtId,
        type: 'imports',
        direction: 'forward',
        weight: 0.7,
      });
      existingImports.add(pairKey);
      stats.recoveredImports += 1;
    }
  }

  return { nodes: [...nodesById.values()], edges: [...byKey.values()], warnings, stats };
}
