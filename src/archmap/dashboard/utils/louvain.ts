import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { GraphEdge } from "../../core/types";

export function detectCommunities(
  nodeIds: string[],
  edges: GraphEdge[],
): Map<string, number> {
  const ids = new Set(nodeIds);
  const g = new Graph({ type: "undirected", multi: false });
  for (const id of nodeIds) g.addNode(id);
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (e.source === e.target) continue;
    if (g.hasEdge(e.source, e.target)) continue;
    g.addEdge(e.source, e.target);
  }
  const result = louvain(g) as Record<string, number>;
  const map = new Map<string, number>();
  for (const id of nodeIds) {
    map.set(id, result[id] ?? -1);
  }
  let maxCommunity = -1;
  for (const v of map.values()) {
    if (v >= 0 && v > maxCommunity) maxCommunity = v;
  }
  let next = maxCommunity + 1;
  for (const [id, c] of map) {
    if (c === -1) {
      map.set(id, next++);
    }
  }
  return map;
}
