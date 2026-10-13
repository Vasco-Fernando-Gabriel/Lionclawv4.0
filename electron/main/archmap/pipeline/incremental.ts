import { normalizeRelativePath } from './node-path';
import { nodePath } from './normalize';
import type { ExtractedFile } from './types';

export type GraphRecord = Record<string, unknown>;

const SYMBOL_TYPES = new Set(['function', 'class']);

function nodeName(node: GraphRecord): string {
  return typeof node.name === 'string' ? node.name : '';
}

function shortName(name: string): string {
  const normalized = name.replaceAll('::', '.').replaceAll('#', '.');
  const cut = normalized.lastIndexOf('.');
  return cut >= 0 ? normalized.slice(cut + 1) : normalized;
}

export function graphNodePath(node: GraphRecord): string | null {
  return nodePath(node);
}

export function previousSymbolsByPath(
  nodes: readonly GraphRecord[],
  paths: Iterable<string>,
): Record<string, string[]> {
  const wanted = new Set([...paths].map((p) => normalizeRelativePath(p)));
  const out: Record<string, string[]> = {};
  for (const node of nodes) {
    if (!SYMBOL_TYPES.has(String(node.type))) continue;
    const path = graphNodePath(node);
    if (!path || !wanted.has(path)) continue;
    const name = nodeName(node);
    if (name.length === 0) continue;
    const list = (out[path] ??= []);
    if (!list.includes(name)) list.push(name);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

function extractedNames(entry: ExtractedFile | undefined): Set<string> {
  const names = new Set<string>();
  if (!entry) return names;
  for (const fn of entry.functions ?? []) names.add(fn.name);
  for (const cls of entry.classes ?? []) {
    names.add(cls.name);
    for (const method of cls.methods ?? []) {
      names.add(method);
      names.add(`${cls.name}.${method}`);
    }
  }
  return names;
}

export function requiredSymbols(
  previousSymbols: Record<string, string[]>,
  extraction: readonly ExtractedFile[],
): Record<string, string[]> {
  const byPath = new Map(extraction.map((e) => [normalizeRelativePath(e.path), e]));
  const out: Record<string, string[]> = {};
  for (const [rawPath, symbols] of Object.entries(previousSymbols)) {
    if (symbols.length === 0) continue;
    const path = normalizeRelativePath(rawPath);
    const entry = byPath.get(path);
    const names = extractedNames(entry);
    const required =
      entry === undefined ? [...symbols] : symbols.filter((s) => names.has(s) || names.has(shortName(s)));
    if (required.length > 0) out[path] = required.sort();
  }
  return out;
}

export function findMissingSymbols(
  required: Record<string, string[]>,
  nodes: readonly GraphRecord[],
): Record<string, string[]> {
  const present = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!SYMBOL_TYPES.has(String(node.type))) continue;
    const path = graphNodePath(node);
    if (!path) continue;
    const set = present.get(path) ?? new Set<string>();
    const name = nodeName(node);
    if (name.length > 0) {
      set.add(name);
      set.add(shortName(name));
    }
    if (typeof node.id === 'string') {
      const tail = node.id.slice(node.id.lastIndexOf(':') + 1);
      if (tail.length > 0) {
        set.add(tail);
        set.add(shortName(tail));
      }
    }
    present.set(path, set);
  }
  const out: Record<string, string[]> = {};
  for (const [path, symbols] of Object.entries(required)) {
    const have = present.get(path) ?? new Set<string>();
    const missing = symbols.filter((s) => !have.has(s) && !have.has(shortName(s)));
    if (missing.length > 0) out[path] = missing;
  }
  return out;
}
