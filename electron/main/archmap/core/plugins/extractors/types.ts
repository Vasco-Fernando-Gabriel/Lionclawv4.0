import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";

export type TreeSitterNode = import("web-tree-sitter").Node;

export interface LanguageExtractor {
  languageIds: string[];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
}
