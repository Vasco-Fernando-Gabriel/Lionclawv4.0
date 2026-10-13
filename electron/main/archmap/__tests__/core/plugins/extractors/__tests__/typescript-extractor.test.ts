import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { resolveArchmapGrammarsDir } from "../../../../../core/plugins/tree-sitter-plugin.js";
import { TypeScriptExtractor } from "../../../../../core/plugins/extractors/typescript-extractor.js";


let Parser: any;
let Language: any;
let tsLang: any;

beforeAll(async () => {
  const mod = await import("web-tree-sitter");
  Parser = mod.Parser;
  Language = mod.Language;
  await Parser.init();
  const wasmPath = join(resolveArchmapGrammarsDir(), "tree-sitter-typescript.wasm");
  tsLang = await Language.load(wasmPath);
});

function parse(code: string) {
  const parser = new Parser();
  parser.setLanguage(tsLang);
  const tree = parser.parse(code);
  const root = tree.rootNode;
  return { tree, parser, root };
}

describe("TypeScriptExtractor", () => {
  const extractor = new TypeScriptExtractor();

  it("extracts a plain class declaration", () => {
    const { tree, parser, root } = parse(`class Widget {
  run(): void {
    console.log("x");
  }
}
`);
    const result = extractor.extractStructure(root);
    expect(result.classes.some((c) => c.name === "Widget")).toBe(true);
    tree.delete();
    parser.delete();
  });

  describe("extractStructure - abstract classes", () => {
    it("extracts an abstract class as a class node with its concrete methods", () => {
      const { tree, parser, root } = parse(`abstract class Repository {
  abstract find(id: string): Promise<string>;
  save(value: string): void {
    this.items.push(value);
  }
  private items: string[] = [];
}
`);
      const result = extractor.extractStructure(root);

      const repo = result.classes.find((c) => c.name === "Repository");
      expect(repo).toBeDefined();
      expect(repo!.methods).toContain("save");
      expect(repo!.methods).toContain("find");

      tree.delete();
      parser.delete();
    });

    it("records an exported abstract class in exports", () => {
      const { tree, parser, root } = parse(`export abstract class Base {
  abstract run(): void;
}
`);
      const result = extractor.extractStructure(root);

      expect(result.classes.some((c) => c.name === "Base")).toBe(true);
      const baseExport = result.exports.find((e) => e.name === "Base");
      expect(baseExport).toBeDefined();
      expect(baseExport!.isDefault).toBe(false);

      tree.delete();
      parser.delete();
    });
  });
});
