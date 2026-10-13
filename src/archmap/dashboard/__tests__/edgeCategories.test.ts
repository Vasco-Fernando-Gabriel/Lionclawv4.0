import { describe, it, expect } from "vitest";
import { EDGE_CATEGORY_MAP, ALL_EDGE_CATEGORIES } from "../store";
import type { EdgeType as CoreEdgeType } from "../../core/types";

const EXPECTED_EDGE_TYPES = {
  imports: true, exports: true, contains: true, inherits: true, implements: true,
  calls: true, subscribes: true, publishes: true, middleware: true,
  reads_from: true, writes_to: true, transforms: true, validates: true,
  depends_on: true, tested_by: true, configures: true,
  related: true, similar_to: true,
  deploys: true, serves: true, provisions: true, triggers: true,
  migrates: true, documents: true, routes: true, defines_schema: true,
  contains_flow: true, flow_step: true, cross_domain: true,
  cites: true, contradicts: true, builds_on: true, exemplifies: true,
  categorized_under: true, authored_by: true,
  instance_of: true, variant_of: true, uses_token: true,
} satisfies Record<CoreEdgeType, true>;

describe("EDGE_CATEGORY_MAP (edge-category filter)", () => {
  const mapped = Object.values(EDGE_CATEGORY_MAP).flat();

  it("covers every core EdgeType (regression guard)", () => {
    for (const t of Object.keys(EXPECTED_EDGE_TYPES)) {
      expect(mapped).toContain(t);
    }
  });

  it("maps each edge type to exactly one category", () => {
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped.length).toBe(Object.keys(EXPECTED_EDGE_TYPES).length);
  });

  it("lists every map key in ALL_EDGE_CATEGORIES so the FilterPanel renders it", () => {
    for (const category of Object.keys(EDGE_CATEGORY_MAP)) {
      expect(ALL_EDGE_CATEGORIES).toContain(category);
    }
    expect(ALL_EDGE_CATEGORIES.length).toBe(Object.keys(EDGE_CATEGORY_MAP).length);
  });
});
