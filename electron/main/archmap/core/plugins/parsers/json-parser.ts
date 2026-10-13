import type { AnalyzerPlugin, StructuralAnalysis, SectionInfo, ReferenceResolution } from "../../types.js";

export function stripJsoncSyntax(content: string): string {
  let out = "";
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = content[i];
        out += c;
        if (c === "\\" && i + 1 < n) {
          out += content[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && content[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}

export class JSONConfigParser implements AnalyzerPlugin {
  name = "json-config-parser";
  languages = ["json", "jsonc", "json-schema", "openapi"];

  analyzeFile(_filePath: string, content: string): StructuralAnalysis {
    const sections = this.extractSections(content);
    return {
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      sections,
    };
  }

  extractReferences(filePath: string, content: string): ReferenceResolution[] {
    const refs: ReferenceResolution[] = [];
    const refRegex = /"\$ref"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = refRegex.exec(content)) !== null) {
      const target = match[1];
      if (target.startsWith("#")) continue;
      const line = content.slice(0, match.index).split("\n").length;
      refs.push({
        source: filePath,
        target,
        referenceType: "schema",
        line,
      });
    }
    return refs;
  }

  private extractSections(content: string): SectionInfo[] {
    const sections: SectionInfo[] = [];
    try {
      const doc = JSON.parse(stripJsoncSyntax(content));
      if (doc && typeof doc === "object" && !Array.isArray(doc)) {
        const lines = content.split("\n");
        for (const key of Object.keys(doc)) {
          const escapedKey = JSON.stringify(key);
          const lineIdx = lines.findIndex((l) => l.includes(escapedKey));
          if (lineIdx !== -1) {
            sections.push({
              name: key,
              level: 1,
              lineRange: [lineIdx + 1, lineIdx + 1],
            });
          }
        }
        for (let i = 0; i < sections.length; i++) {
          const next = sections[i + 1];
          sections[i].lineRange[1] = next ? next.lineRange[0] - 1 : lines.length;
        }
      }
    } catch (err) {
      console.warn(`[json-parser] Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return sections;
  }
}
