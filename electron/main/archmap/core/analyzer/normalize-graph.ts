const VALID_PREFIXES = new Set([
  "file", "func", "class", "module", "concept",
  "config", "document", "service", "table", "endpoint",
  "pipeline", "schema", "resource",
  "domain", "flow", "step",
]);

const TYPE_TO_PREFIX: Record<string, string> = {
  file: "file",
  function: "func",
  class: "class",
  module: "module",
  concept: "concept",
  config: "config",
  document: "document",
  service: "service",
  table: "table",
  endpoint: "endpoint",
  pipeline: "pipeline",
  schema: "schema",
  resource: "resource",
  domain: "domain",
  flow: "flow",
  step: "step",
};

function stripToValidPrefix(id: string): { prefix: string | null; path: string } {
  let remaining = id;

  while (true) {
    const colonIdx = remaining.indexOf(":");
    if (colonIdx <= 0) break;

    const segment = remaining.slice(0, colonIdx);
    if (VALID_PREFIXES.has(segment)) {
      const rest = remaining.slice(colonIdx + 1);
      const innerColonIdx = rest.indexOf(":");
      if (innerColonIdx > 0 && VALID_PREFIXES.has(rest.slice(0, innerColonIdx))) {
        remaining = rest;
        continue;
      }
      return { prefix: segment, path: rest };
    }

    remaining = remaining.slice(colonIdx + 1);
  }

  return { prefix: null, path: remaining };
}

export function normalizeNodeId(
  id: string,
  node: { type: string; filePath?: string; name?: string; parentFlowSlug?: string },
): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;

  const expectedPrefix = TYPE_TO_PREFIX[node.type];
  const { prefix, path } = stripToValidPrefix(trimmed);

  if (prefix) {
    if (node.type === "step" && node.filePath) {
      const segments = path.split(":");
      const stepSlug = segments.length > 0 ? segments[segments.length - 1] : path;
      const flowSlug = segments.length > 1 ? segments[segments.length - 2] : "";
      return flowSlug
        ? `${prefix}:${flowSlug}:${node.filePath}:${stepSlug}`
        : `${prefix}:${node.filePath}:${stepSlug}`;
    }
    return `${prefix}:${path}`;
  }

  if (expectedPrefix) {
    if (
      (node.type === "function" || node.type === "class") &&
      node.filePath &&
      node.name
    ) {
      return `${expectedPrefix}:${node.filePath}:${node.name}`;
    }
    if (node.type === "step" && node.filePath) {
      const slug = path.toLowerCase().replace(/\s+/g, "-");
      return node.parentFlowSlug
        ? `${expectedPrefix}:${node.parentFlowSlug}:${node.filePath}:${slug}`
        : `${expectedPrefix}:${node.filePath}:${slug}`;
    }
    return `${expectedPrefix}:${path}`;
  }

  return trimmed;
}

const VALID_COMPLEXITIES = new Set(["simple", "moderate", "complex"]);

const COMPLEXITY_STRING_MAP: Record<string, string> = {
  low: "simple",
  easy: "simple",
  trivial: "simple",
  basic: "simple",
  medium: "moderate",
  intermediate: "moderate",
  mid: "moderate",
  average: "moderate",
  high: "complex",
  hard: "complex",
  difficult: "complex",
  advanced: "complex",
};

export function normalizeComplexity(
  value: unknown,
): "simple" | "moderate" | "complex" {
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (VALID_COMPLEXITIES.has(lower)) return lower as "simple" | "moderate" | "complex";
    const aliased = COMPLEXITY_STRING_MAP[lower];
    if (aliased) return aliased as "simple" | "moderate" | "complex";
    return "moderate";
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    if (value <= 3) return "simple";
    if (value <= 6) return "moderate";
    return "complex";
  }

  return "moderate";
}

export interface DroppedEdge {
  source: string;
  target: string;
  type: string;
  reason: "missing-source" | "missing-target" | "missing-both";
}

export interface NormalizationStats {
  idsFixed: number;
  complexityFixed: number;
  edgesRewritten: number;
  danglingEdgesDropped: number;
  droppedEdges: DroppedEdge[];
}

export interface NormalizeBatchResult {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  idMap: Map<string, string>;
  stats: NormalizationStats;
}

const PREFIX_TO_TYPE: Record<string, string> = {
  file: "file", func: "function", class: "class", module: "module",
  concept: "concept", config: "config", document: "document",
  service: "service", table: "table", endpoint: "endpoint",
  pipeline: "pipeline", schema: "schema", resource: "resource",
  domain: "domain", flow: "flow", step: "step",
};

function inferTypeFromId(id: string): string {
  const colonIdx = id.indexOf(":");
  if (colonIdx > 0) {
    const prefix = id.slice(0, colonIdx);
    if (prefix in PREFIX_TO_TYPE) return PREFIX_TO_TYPE[prefix];
  }
  return "file";
}

export function normalizeBatchOutput(data: {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}): NormalizeBatchResult {
  const stats: NormalizationStats = {
    idsFixed: 0,
    complexityFixed: 0,
    edgesRewritten: 0,
    danglingEdgesDropped: 0,
    droppedEdges: [],
  };

  const idMap = new Map<string, string>();

  const stepToFlowSlug = new Map<string, string>();
  const flowNodeNames = new Map<string, string>();
  for (const raw of data.nodes) {
    if (String(raw.type ?? "") === "flow" && raw.id && raw.name) {
      flowNodeNames.set(String(raw.id), String(raw.name).toLowerCase().replace(/\s+/g, "-"));
    }
  }
  for (const raw of data.edges) {
    if (String(raw.type ?? "") === "flow_step" && raw.source && raw.target) {
      const flowSlug = flowNodeNames.get(String(raw.source));
      if (flowSlug) {
        stepToFlowSlug.set(String(raw.target), flowSlug);
      }
    }
  }

  const nodes = data.nodes.map((raw) => {
    const oldId = String(raw.id ?? "");
    const nodeType = String(raw.type ?? "file");
    const newId = normalizeNodeId(oldId, {
      type: nodeType,
      filePath: typeof raw.filePath === "string" ? raw.filePath : undefined,
      name: typeof raw.name === "string" ? raw.name : undefined,
      parentFlowSlug: nodeType === "step" ? stepToFlowSlug.get(oldId) : undefined,
    });

    if (newId !== oldId) {
      stats.idsFixed++;
    }
    idMap.set(oldId, newId);

    const result: Record<string, unknown> = { ...raw, id: newId };

    if (raw.complexity !== undefined) {
      const normalized = normalizeComplexity(raw.complexity);
      if (normalized !== raw.complexity) {
        result.complexity = normalized;
        stats.complexityFixed++;
      }
    }

    return result;
  });

  const seenIds = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    seenIds.set(String(nodes[i].id), i);
  }
  const deduped = nodes.filter((_, i) => seenIds.get(String(nodes[i].id)) === i);
  const validNodeIds = new Set(deduped.map((n) => String(n.id)));

  const edges: Record<string, unknown>[] = [];
  const seenEdges = new Set<string>();
  for (const raw of data.edges) {
    const oldSource = String(raw.source ?? "");
    const oldTarget = String(raw.target ?? "");
    let newSource = idMap.get(oldSource) ?? oldSource;
    let newTarget = idMap.get(oldTarget) ?? oldTarget;

    if (!validNodeIds.has(newSource)) {
      const inferredType = inferTypeFromId(newSource);
      const normalized = normalizeNodeId(newSource, { type: inferredType });
      if (validNodeIds.has(normalized)) newSource = normalized;
    }
    if (!validNodeIds.has(newTarget)) {
      const inferredType = inferTypeFromId(newTarget);
      const normalized = normalizeNodeId(newTarget, { type: inferredType });
      if (validNodeIds.has(normalized)) newTarget = normalized;
    }

    if (newSource !== oldSource || newTarget !== oldTarget) {
      stats.edgesRewritten++;
    }

    if (!validNodeIds.has(newSource) || !validNodeIds.has(newTarget)) {
      const missingSource = !validNodeIds.has(newSource);
      const missingTarget = !validNodeIds.has(newTarget);
      stats.danglingEdgesDropped++;
      stats.droppedEdges.push({
        source: newSource,
        target: newTarget,
        type: String(raw.type ?? ""),
        reason: missingSource && missingTarget ? "missing-both" : missingSource ? "missing-source" : "missing-target",
      });
      continue;
    }

    const edgeType = String(raw.type ?? "");
    const edgeKey = `${newSource}|${newTarget}|${edgeType}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    edges.push({ ...raw, source: newSource, target: newTarget });
  }

  return {
    nodes: deduped,
    edges,
    idMap,
    stats,
  };
}
