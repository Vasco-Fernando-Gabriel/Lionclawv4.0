import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallGraphEntry, StructuralAnalysis } from '../core';
import type { ArchmapRegistry } from './registry';
import type { ArchmapBatch, ExtractedFile, ExtractResult, ScanFile } from './types';

function isLineRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n));
}

export function buildExtractedFile(
  file: ScanFile,
  content: string,
  analysis: StructuralAnalysis | null,
  callGraph: CallGraphEntry[] | null,
  batchImportData: Record<string, string[]>,
): ExtractedFile {
  const lines = content.split('\n');
  const totalLines = content.endsWith('\n') ? Math.max(0, lines.length - 1) : lines.length;
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0).length;
  const base: ExtractedFile = {
    path: file.path,
    language: file.language,
    fileCategory: file.fileCategory,
    totalLines,
    nonEmptyLines,
    metrics: {},
  };
  if (!analysis) return base;
  const metrics: Record<string, number> = {};
  if (analysis.functions.length > 0) {
    base.functions = analysis.functions
      .filter((fn) => isLineRange(fn.lineRange))
      .map((fn) => ({
        name: fn.name,
        startLine: fn.lineRange[0],
        endLine: fn.lineRange[1],
        params: [...(fn.params ?? [])],
      }));
    metrics.functionCount = analysis.functions.length;
  }
  if (analysis.classes.length > 0) {
    base.classes = analysis.classes
      .filter((c) => isLineRange(c.lineRange))
      .map((c) => ({
        name: c.name,
        startLine: c.lineRange[0],
        endLine: c.lineRange[1],
        methods: [...(c.methods ?? [])],
        properties: [...(c.properties ?? [])],
      }));
    metrics.classCount = analysis.classes.length;
  }
  if (analysis.exports.length > 0) {
    base.exports = analysis.exports.map((e) => ({
      name: e.name,
      line: e.lineNumber,
      isDefault: e.isDefault === true,
    }));
    metrics.exportCount = analysis.exports.length;
  }
  const internal = batchImportData[file.path];
  if (internal && internal.length > 0) metrics.importCount = internal.length;
  else if (analysis.imports.length > 0) {
    metrics.importCount = analysis.imports.filter((i) => (i.source ?? '').startsWith('.')).length;
  }
  if (analysis.sections && analysis.sections.length > 0) {
    base.sections = analysis.sections.map((s) => ({
      heading: s.name,
      level: s.level,
      line: s.lineRange[0],
    }));
    metrics.sectionCount = analysis.sections.length;
  }
  if (analysis.definitions && analysis.definitions.length > 0) {
    base.definitions = analysis.definitions.map((d) => ({
      name: d.name,
      kind: d.kind,
      fields: [...(d.fields ?? [])],
      startLine: d.lineRange[0],
      endLine: d.lineRange[1],
    }));
    metrics.definitionCount = analysis.definitions.length;
  }
  if (analysis.services && analysis.services.length > 0) {
    base.services = analysis.services.map((s) => ({
      name: s.name,
      image: s.image,
      ports: [...(s.ports ?? [])],
      startLine: s.lineRange?.[0] ?? 0,
      endLine: s.lineRange?.[1] ?? 0,
    }));
    metrics.serviceCount = analysis.services.length;
  }
  if (analysis.endpoints && analysis.endpoints.length > 0) {
    base.endpoints = analysis.endpoints.map((e) => ({
      name: `${e.method ?? ''}${e.method ? '-' : ''}${e.path}`,
      method: e.method,
      path: e.path,
      startLine: e.lineRange[0],
      endLine: e.lineRange[1],
    }));
    metrics.endpointCount = analysis.endpoints.length;
  }
  if (analysis.steps && analysis.steps.length > 0) {
    base.steps = analysis.steps.map((s) => ({
      name: s.name,
      startLine: s.lineRange[0],
      endLine: s.lineRange[1],
    }));
    metrics.stepCount = analysis.steps.length;
  }
  if (analysis.resources && analysis.resources.length > 0) {
    base.resources = analysis.resources.map((r) => ({
      name: r.name,
      kind: r.kind,
      startLine: r.lineRange[0],
      endLine: r.lineRange[1],
    }));
    metrics.resourceCount = analysis.resources.length;
  }
  if (callGraph && callGraph.length > 0) {
    base.callGraph = callGraph.map((c) => ({
      caller: c.caller,
      callee: c.callee,
      lineNumber: c.lineNumber,
    }));
  }
  base.metrics = metrics;
  return base;
}

export function extractBatch(
  projectPath: string,
  batch: Pick<ArchmapBatch, 'batchIndex' | 'files' | 'batchImportData'>,
  archmap: ArchmapRegistry,
): ExtractResult {
  const { registry } = archmap;
  const results: ExtractedFile[] = [];
  const filesSkipped: string[] = [];
  const missing: string[] = [];
  for (const file of batch.files) {
    let content: string;
    try {
      content = readFileSync(join(projectPath, file.path), 'utf8');
    } catch {
      missing.push(file.path);
      continue;
    }
    const plugin = registry.getPluginForFile(file.path);
    if (!plugin) {
      filesSkipped.push(file.path);
      results.push(buildExtractedFile(file, content, null, null, batch.batchImportData));
      continue;
    }
    const wantsCallGraph = file.fileCategory === 'code' || file.fileCategory === 'script';
    let analysis: StructuralAnalysis | null = null;
    let callGraph: CallGraphEntry[] | null = null;
    try {
      if (wantsCallGraph && plugin.analyzeFileFull) {
        const full = plugin.analyzeFileFull(file.path, content);
        analysis = full.structure;
        callGraph = full.callGraph;
      } else {
        analysis = plugin.analyzeFile(file.path, content);
        if (wantsCallGraph && plugin.extractCallGraph) {
          callGraph = plugin.extractCallGraph(file.path, content);
        }
      }
    } catch {
      analysis = null;
      callGraph = null;
    }
    results.push(buildExtractedFile(file, content, analysis, callGraph, batch.batchImportData));
  }
  return { batchIndex: batch.batchIndex, results, filesSkipped, missing };
}
