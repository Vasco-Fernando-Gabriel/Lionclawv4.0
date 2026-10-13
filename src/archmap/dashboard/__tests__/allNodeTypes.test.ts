import { describe, it, expect } from "vitest";
import { ALL_NODE_TYPES } from "../store";
import type { NodeType as CoreNodeType } from "../../core/types";

const EXPECTED_NODE_TYPES = {
  file: true, function: true, class: true, module: true, concept: true,
  config: true, document: true, service: true, table: true, endpoint: true,
  pipeline: true, schema: true, resource: true,
  domain: true, flow: true, step: true,
  article: true, entity: true, topic: true, claim: true, source: true,
  page: true, screen: true, component: true, componentSet: true, instance: true, token: true,
} satisfies Record<CoreNodeType, true>;

const DESIGN_TYPES = ["page", "screen", "component", "componentSet", "instance", "token"] as const;

describe("ALL_NODE_TYPES (filter / export default set)", () => {
  it('includes all 6 design node types so kind:"design" graphs survive JSON export', () => {
    for (const t of DESIGN_TYPES) {
      expect(ALL_NODE_TYPES).toContain(t);
    }
  });

  it("contains every core NodeType (regression guard)", () => {
    for (const t of Object.keys(EXPECTED_NODE_TYPES)) {
      expect(ALL_NODE_TYPES).toContain(t);
    }
  });

  it("has no duplicates and no types beyond the core set", () => {
    expect(new Set(ALL_NODE_TYPES).size).toBe(ALL_NODE_TYPES.length);
    expect(ALL_NODE_TYPES.length).toBe(Object.keys(EXPECTED_NODE_TYPES).length);
  });
});
