import type { AnalyzerPlugin, StructuralAnalysis, ReferenceResolution } from "../../types.js";

export class ShellParser implements AnalyzerPlugin {
  name = "shell-parser";
  languages = ["shell", "jenkinsfile"];

  analyzeFile(_filePath: string, content: string): StructuralAnalysis {
    const functions = this.extractFunctions(content);
    return {
      functions,
      classes: [],
      imports: [],
      exports: [],
    };
  }

  extractReferences(filePath: string, content: string): ReferenceResolution[] {
    const refs: ReferenceResolution[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const sourceMatch = lines[i].match(/^\s*(?:source|\.)[ \t]+["']?([^"'\s]+)["']?/);
      if (sourceMatch) {
        refs.push({
          source: filePath,
          target: sourceMatch[1],
          referenceType: "file",
          line: i + 1,
        });
      }
    }
    return refs;
  }

  private extractFunctions(content: string): Array<{ name: string; lineRange: [number, number]; params: string[] }> {
    const functions: Array<{ name: string; lineRange: [number, number]; params: string[] }> = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{?/) ||
                    lines[i].match(/^function\s+(\w+)\s*\{?/);
      if (!match) continue;
      const name = match[1];
      const hasBraceHere = lines[i].includes("{");
      let nextNonBlank = i + 1;
      while (nextNonBlank < lines.length && lines[nextNonBlank].trim() === "") {
        nextNonBlank++;
      }
      const hasBraceNext = nextNonBlank < lines.length && lines[nextNonBlank].trim().startsWith("{");
      if (!hasBraceHere && !hasBraceNext) continue;

      const startBraceLine = hasBraceHere ? i : nextNonBlank;
      let depth = 0;
      let endLine = startBraceLine;
      for (let j = startBraceLine; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
        }
        if (depth === 0) {
          endLine = j;
          break;
        }
      }
      functions.push({
        name,
        lineRange: [i + 1, endLine + 1],
        params: [],
      });
    }

    return functions;
  }
}
