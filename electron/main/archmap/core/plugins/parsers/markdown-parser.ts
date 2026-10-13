import type { AnalyzerPlugin, StructuralAnalysis, ReferenceResolution, SectionInfo } from "../../types.js";

export class MarkdownParser implements AnalyzerPlugin {
  name = "markdown-parser";
  languages = ["markdown"];

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
    const linkRegex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const target = match[2];
      if (target.startsWith("http")) continue;
      const line = content.slice(0, match.index).split("\n").length;
      refs.push({
        source: filePath,
        target,
        referenceType: match[0].startsWith("!") ? "image" : "file",
        line,
      });
    }
    return refs;
  }

  private extractSections(content: string): SectionInfo[] {
    const sections: SectionInfo[] = [];
    const lines = content.split("\n");
    let inFence = false;
    let fenceMarker: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const fenceMatch = lines[i].match(/^(```+|~~~+)/);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fenceMatch[1][0];
        } else if (fenceMarker && lines[i].startsWith(fenceMarker)) {
          inFence = false;
          fenceMarker = null;
        }
        continue;
      }
      if (inFence) continue;

      const match = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (match) {
        sections.push({
          name: match[2].trim(),
          level: match[1].length,
          lineRange: [i + 1, i + 1],
        });
      }
    }
    for (let i = 0; i < sections.length; i++) {
      const next = sections[i + 1];
      sections[i].lineRange[1] = next ? next.lineRange[0] - 1 : lines.length;
    }
    return sections;
  }
}
