import { dirname } from "node:path";
import type { ChangeAnalysis } from "./fingerprint.js";

export interface UpdateDecision {
  action: "SKIP" | "PARTIAL_UPDATE" | "ARCHITECTURE_UPDATE" | "FULL_UPDATE";
  filesToReanalyze: string[];
  rerunArchitecture: boolean;
  rerunTour: boolean;
  reason: string;
}

export function classifyUpdate(
  analysis: ChangeAnalysis,
  totalFilesInGraph: number,
  previousFiles: string[] = [],
  currentFiles?: string[],
): UpdateDecision {
  const { newFiles, deletedFiles, structurallyChangedFiles, cosmeticOnlyFiles } = analysis;
  const structuralCount = structurallyChangedFiles.length + newFiles.length + deletedFiles.length;

  if (structuralCount === 0) {
    const cosmeticCount = cosmeticOnlyFiles.length;
    const reason = cosmeticCount > 0
      ? `${cosmeticCount} file(s) have cosmetic-only changes (no structural impact)`
      : "No changes detected";

    return {
      action: "SKIP",
      filesToReanalyze: [],
      rerunArchitecture: false,
      rerunTour: false,
      reason,
    };
  }

  const triggeredByCount = structuralCount > 90;
  const triggeredByPercentage = totalFilesInGraph > 0 && structuralCount / totalFilesInGraph > 0.5;
  if (triggeredByCount || triggeredByPercentage) {
    const thresholdReason =
      triggeredByCount && triggeredByPercentage
        ? ">90 files and >50% of project"
        : triggeredByCount
          ? ">90 files"
          : ">50% of project";
    return {
      action: "FULL_UPDATE",
      filesToReanalyze: [...structurallyChangedFiles, ...newFiles],
      rerunArchitecture: true,
      rerunTour: true,
      reason: `${structuralCount} files have structural changes (${thresholdReason}) — full rebuild recommended`,
    };
  }

  const hasDirectoryChanges = detectDirectoryChanges(
    newFiles,
    deletedFiles,
    previousFiles,
    currentFiles,
  );

  if (hasDirectoryChanges || structuralCount > 10) {
    return {
      action: "ARCHITECTURE_UPDATE",
      filesToReanalyze: [...structurallyChangedFiles, ...newFiles],
      rerunArchitecture: true,
      rerunTour: true,
      reason: hasDirectoryChanges
        ? `Directory structure changed (${newFiles.length} new, ${deletedFiles.length} deleted files)`
        : `${structuralCount} files have structural changes — architecture re-analysis needed`,
    };
  }

  return {
    action: "PARTIAL_UPDATE",
    filesToReanalyze: [...structurallyChangedFiles, ...newFiles],
    rerunArchitecture: false,
    rerunTour: false,
    reason: `${structuralCount} file(s) have structural changes: ${summarizeChanges(analysis)}`,
  };
}

function detectDirectoryChanges(
  newFiles: string[],
  deletedFiles: string[],
  previousFiles: string[],
  currentFiles?: string[],
): boolean {
  const before = new Set(previousFiles);
  for (const file of deletedFiles) before.add(file);

  const after = currentFiles === undefined
    ? new Set(previousFiles.filter(file => !deletedFiles.includes(file)))
    : new Set(currentFiles);
  if (currentFiles === undefined) {
    for (const file of newFiles) after.add(file);
  }

  const beforeDirs = topDirectories(before);
  const afterDirs = topDirectories(after);
  if (beforeDirs.size !== afterDirs.size) return true;
  for (const dir of beforeDirs) {
    if (!afterDirs.has(dir)) return true;
  }
  return false;
}

function topDirectories(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const platformPath = process.platform === "win32" ? file.replaceAll("\\", "/") : file;
    const dir = topDirectory(platformPath);
    if (dir) dirs.add(dir);
  }
  return dirs;
}

function topDirectory(filePath: string): string | null {
  const dir = dirname(filePath);
  if (dir === "." || dir === "") return null;
  const segments = dir.split("/");
  return segments[0] || null;
}

function summarizeChanges(analysis: ChangeAnalysis): string {
  const parts: string[] = [];

  if (analysis.newFiles.length > 0) {
    parts.push(`${analysis.newFiles.length} new`);
  }
  if (analysis.deletedFiles.length > 0) {
    parts.push(`${analysis.deletedFiles.length} deleted`);
  }
  if (analysis.structurallyChangedFiles.length > 0) {
    parts.push(`${analysis.structurallyChangedFiles.length} modified`);
  }

  return parts.join(", ");
}
