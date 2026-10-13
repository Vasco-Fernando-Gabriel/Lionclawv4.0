import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalyzerPlugin,
  StructuralAnalysis,
  ImportResolution,
  CallGraphEntry,
} from "../types.js";
import type { LanguageConfig } from "../languages/types.js";
import type { LanguageExtractor } from "./extractors/types.js";
import { collectSymbolEvidence, type SymbolEvidence } from "./symbol-evidence.js";
import { builtinExtractors } from "./extractors/index.js";

const require = createRequire(import.meta.url);

export const LIONCLAW_GRAMMARS_PACKAGE = "lionclaw-archmap-grammars";
let grammarsDirOverride: string | null = null;

export function setArchmapGrammarsDir(dir: string | null): void {
  grammarsDirOverride = dir;
}

const GRAMMARS_SUBDIR = "electron/main/archmap/core/grammars";

export function archmapGrammarsDirCandidates(): string[] {
  const candidates: string[] = [];
  if (grammarsDirOverride) candidates.push(grammarsDirOverride);
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(
    resolve(here, "../grammars"),
    resolve(here, "../../", GRAMMARS_SUBDIR),
    resolve(here, "../../../", GRAMMARS_SUBDIR),
  );
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    candidates.push(
      join(resourcesPath, "app.asar.unpacked", GRAMMARS_SUBDIR),
      join(resourcesPath, "app", GRAMMARS_SUBDIR),
    );
  }
  const out: string[] = [];
  for (const candidate of candidates) {
    for (const variant of [candidate.replace("app.asar", "app.asar.unpacked"), candidate]) {
      if (!out.includes(variant)) out.push(variant);
    }
  }
  return out;
}

export function resolveArchmapGrammarsDir(): string {
  const candidates = archmapGrammarsDirCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Mapa de arquitetura: pasta de gramaticas tree-sitter nao encontrada. Procurado em: ${candidates.join("; ")}`,
  );
}

export function resolveGrammarWasm(wasmPackage: string, wasmFile: string): string {
  const dir = wasmPackage === LIONCLAW_GRAMMARS_PACKAGE ? resolveArchmapGrammarsDir() : dirname(require.resolve(`${wasmPackage}/package.json`));
  const wasmPath = join(dir, wasmFile);
  if (!existsSync(wasmPath)) {
    throw new Error(`Mapa de arquitetura: gramatica tree-sitter ausente: ${wasmPath}`);
  }
  return wasmPath;
}

type TreeSitterParser = import("web-tree-sitter").Parser;
type TreeSitterLanguage = import("web-tree-sitter").Language;

export class TreeSitterPlugin implements AnalyzerPlugin {
  readonly name = "tree-sitter";
  readonly languages: string[];

  private configs: LanguageConfig[];

  private _ParserClass:
    | (new () => TreeSitterParser)
    | null = null;
  private _languages = new Map<string, TreeSitterLanguage>();
  private _extensionToLang = new Map<string, string>();
  private _parsers = new Map<string, TreeSitterParser>();
  private _initialized = false;

  private extractors = new Map<string, LanguageExtractor>();

  constructor(configs?: LanguageConfig[], extractors?: LanguageExtractor[]) {
    if (configs) {
      this.configs = configs.filter((c) => c.treeSitter);
    } else {
      this.configs = [];
    }

    const langs: string[] = [];
    for (const config of this.configs) {
      langs.push(config.id);
      for (const ext of config.extensions) {
        const key = ext.startsWith(".") ? ext : `.${ext}`;
        this._extensionToLang.set(key, config.id);
      }
    }

    if (langs.length === 0) {
      langs.push("typescript", "javascript");
      this._extensionToLang.set(".ts", "typescript");
      this._extensionToLang.set(".tsx", "typescript");
      this._extensionToLang.set(".js", "javascript");
      this._extensionToLang.set(".mjs", "javascript");
      this._extensionToLang.set(".cjs", "javascript");
      this._extensionToLang.set(".jsx", "javascript");
    }

    this.languages = langs;

    if (extractors && extractors.length > 0) {
      for (const extractor of extractors) {
        this.registerExtractor(extractor);
      }
    } else {
      for (const extractor of builtinExtractors) {
        this.registerExtractor(extractor);
      }
    }
  }

  registerExtractor(extractor: LanguageExtractor): void {
    for (const id of extractor.languageIds) {
      this.extractors.set(id, extractor);
    }
  }

  private getExtractor(langKey: string): LanguageExtractor | null {
    const key = langKey === "tsx" ? "typescript" : langKey;
    return this.extractors.get(key) ?? null;
  }

  private languageKeyFromPath(filePath: string): string | null {
    const ext = extname(filePath).toLowerCase();

    if (ext === ".tsx") return "tsx";

    return this._extensionToLang.get(ext) ?? null;
  }

  async init(): Promise<void> {
    if (this._initialized) return;

    const mod = await import("web-tree-sitter");
    const ParserCls = mod.Parser;
    const LanguageCls = mod.Language;

    await ParserCls.init();
    this._ParserClass = ParserCls as unknown as new () => TreeSitterParser;

    if (this.configs.length > 0) {
      const loadPromises: Promise<void>[] = [];

      for (const config of this.configs) {
        if (!config.treeSitter) continue;

        const loadGrammar = async () => {
          try {
            const wasmPath = resolveGrammarWasm(
              config.treeSitter!.wasmPackage,
              config.treeSitter!.wasmFile,
            );
            const lang = await LanguageCls.load(wasmPath);
            this._languages.set(config.id, lang);

            if (config.id === "typescript") {
              const tsxWasm = resolveGrammarWasm(
                config.treeSitter!.wasmPackage,
                "tree-sitter-tsx.wasm",
              );
              const tsxLang = await LanguageCls.load(tsxWasm);
              this._languages.set("tsx", tsxLang);
            }
          } catch (error) {
            throw new Error(
              `tree-sitter: gramatica de ${config.id} nao carregou (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        };

        loadPromises.push(loadGrammar());
      }

      await Promise.all(loadPromises);
    } else {
      const tsWasm = resolveGrammarWasm(LIONCLAW_GRAMMARS_PACKAGE, "tree-sitter-typescript.wasm");
      const tsxWasm = resolveGrammarWasm(LIONCLAW_GRAMMARS_PACKAGE, "tree-sitter-tsx.wasm");
      const jsWasm = resolveGrammarWasm(LIONCLAW_GRAMMARS_PACKAGE, "tree-sitter-javascript.wasm");

      const [tsLang, tsxLang, jsLang] = await Promise.all([
        LanguageCls.load(tsWasm),
        LanguageCls.load(tsxWasm),
        LanguageCls.load(jsWasm),
      ]);

      this._languages.set("typescript", tsLang);
      this._languages.set("tsx", tsxLang);
      this._languages.set("javascript", jsLang);
    }

    this._initialized = true;
  }

  private getParser(filePath: string): TreeSitterParser | null {
    if (!this._initialized || !this._ParserClass) {
      throw new Error(
        "TreeSitterPlugin.init() must be called before use",
      );
    }
    const langKey = this.languageKeyFromPath(filePath);
    if (!langKey) return null;
    const lang = this._languages.get(langKey);
    if (!lang) {
      return null;
    }
    let parser = this._parsers.get(langKey);
    if (!parser) {
      parser = new this._ParserClass();
      parser.setLanguage(lang);
      this._parsers.set(langKey, parser);
    }
    return parser;
  }

  private static emptyStructure(): StructuralAnalysis {
    return { functions: [], classes: [], imports: [], exports: [] };
  }

  analyzeFile(
    filePath: string,
    content: string,
  ): StructuralAnalysis {
    const parser = this.getParser(filePath);
    if (!parser) {
      return { functions: [], classes: [], imports: [], exports: [] };
    }

    const tree = parser.parse(content);
    if (!tree) {
      return { functions: [], classes: [], imports: [], exports: [] };
    }

    const langKey = this.languageKeyFromPath(filePath);
    const extractor = langKey ? this.getExtractor(langKey) : null;

    let result: StructuralAnalysis;
    if (extractor) {
      result = extractor.extractStructure(tree.rootNode);
    } else {
      result = { functions: [], classes: [], imports: [], exports: [] };
    }

    tree.delete();

    return result;
  }

  analyzeFileStrict(
    filePath: string,
    content: string,
  ): {
    status: "succeeded" | "unsupported" | "failed";
    structure: StructuralAnalysis | null;
    symbolEvidence: SymbolEvidence | null;
    language?: string;
  } {
    let tree: ReturnType<TreeSitterParser["parse"]> = null;
    try {
      const parser = this.getParser(filePath);
      const langKey = this.languageKeyFromPath(filePath);
      const extractor = langKey ? this.getExtractor(langKey) : null;
      if (!parser || !extractor) {
        return { status: "unsupported", structure: null, symbolEvidence: null };
      }
      tree = parser.parse(content);
      if (!tree || tree.rootNode.hasError) {
        return { status: "failed", structure: null, symbolEvidence: null };
      }
      const structure = extractor.extractStructure(tree.rootNode);
      return {
        status: "succeeded",
        language: langKey!,
        structure,
        symbolEvidence: collectSymbolEvidence(tree.rootNode, structure, langKey!),
      };
    } catch {
      return { status: "failed", structure: null, symbolEvidence: null };
    } finally {
      tree?.delete();
    }
  }

  analyzeFileFull(
    filePath: string,
    content: string,
  ): { structure: StructuralAnalysis; callGraph: CallGraphEntry[] } {
    const parser = this.getParser(filePath);
    if (!parser) {
      return { structure: TreeSitterPlugin.emptyStructure(), callGraph: [] };
    }

    const tree = parser.parse(content);
    if (!tree) {
      return { structure: TreeSitterPlugin.emptyStructure(), callGraph: [] };
    }

    const langKey = this.languageKeyFromPath(filePath);
    const extractor = langKey ? this.getExtractor(langKey) : null;

    const structure = extractor
      ? extractor.extractStructure(tree.rootNode)
      : TreeSitterPlugin.emptyStructure();
    const callGraph = extractor ? extractor.extractCallGraph(tree.rootNode) : [];

    tree.delete();

    return { structure, callGraph };
  }

  resolveImports(
    filePath: string,
    content: string,
  ): ImportResolution[] {
    const analysis = this.analyzeFile(filePath, content);
    const dir = dirname(filePath);

    return analysis.imports.map((imp) => {
      let resolvedPath: string;
      if (
        imp.source.startsWith("./") ||
        imp.source.startsWith("../")
      ) {
        resolvedPath = resolve(dir, imp.source);
      } else {
        resolvedPath = imp.source;
      }
      return {
        source: imp.source,
        resolvedPath,
        specifiers: imp.specifiers,
      };
    });
  }

  extractCallGraph(
    filePath: string,
    content: string,
  ): CallGraphEntry[] {
    const parser = this.getParser(filePath);
    if (!parser) return [];

    const tree = parser.parse(content);
    if (!tree) {
      return [];
    }

    const langKey = this.languageKeyFromPath(filePath);
    const extractor = langKey ? this.getExtractor(langKey) : null;
    const result = extractor ? extractor.extractCallGraph(tree.rootNode) : [];

    tree.delete();

    return result;
  }
}
