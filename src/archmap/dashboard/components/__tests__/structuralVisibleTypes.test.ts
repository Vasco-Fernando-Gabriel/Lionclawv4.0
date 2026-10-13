import { describe, it, expect } from "vitest";
import { STRUCTURAL_VISIBLE_TYPES } from "../GraphView";
import type { NodeType } from "../../../core/types";

const KNOWLEDGE_TYPES = ["article", "entity", "topic", "claim", "source"] as const;
type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

const EXPECTED_STRUCTURAL_TYPES = {
  file: true, function: true, class: true, module: true, concept: true,
  config: true, document: true, service: true, table: true, endpoint: true,
  pipeline: true, schema: true, resource: true,
  domain: true, flow: true, step: true,
  page: true, screen: true, component: true, componentSet: true, instance: true, token: true,
} satisfies Record<Exclude<NodeType, KnowledgeType>, true>;

const DESIGN_TYPES = [
  "page",
  "screen",
  "component",
  "componentSet",
  "instance",
  "token",
] as const;

describe("STRUCTURAL_VISIBLE_TYPES (drill-in / layer-detail visibility)", () => {
  it('includes all 6 design node types so kind:"design" graphs render on drill-in', () => {
    for (const t of DESIGN_TYPES) {
      expect(STRUCTURAL_VISIBLE_TYPES.has(t)).toBe(true);
    }
  });

  it("includes the core structural node types", () => {
    for (const t of ["file", "function", "class", "service", "domain", "flow"]) {
      expect(STRUCTURAL_VISIBLE_TYPES.has(t)).toBe(true);
    }
  });

  it("excludes knowledge node types (they render in KnowledgeGraphView)", () => {
    for (const t of KNOWLEDGE_TYPES) {
      expect(STRUCTURAL_VISIBLE_TYPES.has(t)).toBe(false);
    }
  });

  it("contains every non-knowledge core NodeType (regression guard)", () => {
    for (const t of Object.keys(EXPECTED_STRUCTURAL_TYPES)) {
      expect(STRUCTURAL_VISIBLE_TYPES.has(t)).toBe(true);
    }
  });

  it("contains no node types beyond the expected non-knowledge set", () => {
    expect(STRUCTURAL_VISIBLE_TYPES.size).toBe(
      Object.keys(EXPECTED_STRUCTURAL_TYPES).length,
    );
  });
});
