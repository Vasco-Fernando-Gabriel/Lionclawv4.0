import type { GraphNode, Layer } from "../../core/types";

export type Complexity = "simple" | "moderate" | "complex";

export interface LayerStats {
  resolvedCount: number;
  aggregateComplexity: Complexity;
}

export function computeLayerStats(
  layer: Layer,
  nodesById: Map<string, GraphNode>,
): LayerStats {
  const counts: Record<Complexity, number> = { simple: 0, moderate: 0, complex: 0 };
  let resolved = 0;
  for (const nid of layer.nodeIds) {
    const node = nodesById.get(nid);
    if (!node) continue;
    resolved++;
    counts[node.complexity]++;
  }
  const aggregateComplexity: Complexity =
    counts.complex > resolved * 0.3
      ? "complex"
      : counts.moderate > resolved * 0.3
        ? "moderate"
        : "simple";
  return { resolvedCount: resolved, aggregateComplexity };
}
