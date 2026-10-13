import { posix } from 'node:path';
import type { RawImport } from './scan';
import type { ScanFile } from './types';

export interface ImportMapContext {
  tsconfigText?: string | null;
  goModText?: string | null;
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.vue', '.svelte'];
const JS_LANGS = new Set(['typescript', 'javascript', 'vue', 'svelte']);

function dirOf(p: string): string {
  const d = posix.dirname(p);
  return d === '.' ? '' : d;
}

function normalize(p: string): string {
  const n = posix.normalize(p).replace(/^\.\/+/, '');
  return n.startsWith('../') || n === '..' ? '' : n;
}

function probeJs(base: string, fileSet: Set<string>): string | null {
  if (fileSet.has(base)) return base;
  const stripped = base.replace(/\.(m|c)?jsx?$/, '');
  if (stripped !== base) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']) {
      if (fileSet.has(stripped + ext)) return stripped + ext;
    }
  }
  for (const ext of JS_EXTS) if (fileSet.has(base + ext)) return base + ext;
  for (const ext of JS_EXTS) {
    const idx = posix.join(base, `index${ext}`);
    if (fileSet.has(idx)) return idx;
  }
  return null;
}

function stripJsonc(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

interface TsAliases {
  baseUrl: string;
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

function parseTsconfig(text: string | null | undefined): TsAliases | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(stripJsonc(text)) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const opts = parsed.compilerOptions ?? {};
    const baseUrl = normalize(opts.baseUrl ?? '.') || '';
    const paths: TsAliases['paths'] = [];
    for (const [alias, targets] of Object.entries(opts.paths ?? {})) {
      const star = alias.indexOf('*');
      paths.push({
        prefix: star < 0 ? alias : alias.slice(0, star),
        suffix: star < 0 ? '' : alias.slice(star + 1),
        targets: Array.isArray(targets) ? targets : [],
      });
    }
    if (paths.length === 0 && !opts.baseUrl) return null;
    return { baseUrl, paths };
  } catch {
    return null;
  }
}

function resolveTsAlias(src: string, aliases: TsAliases, fileSet: Set<string>): string | null {
  for (const alias of aliases.paths) {
    if (!src.startsWith(alias.prefix) || !src.endsWith(alias.suffix)) continue;
    const wildcard = src.slice(alias.prefix.length, src.length - alias.suffix.length);
    for (const target of alias.targets) {
      const candidate = normalize(posix.join(aliases.baseUrl, target.replace('*', wildcard)));
      const found = candidate ? probeJs(candidate, fileSet) : null;
      if (found) return found;
    }
  }
  const direct = normalize(posix.join(aliases.baseUrl, src));
  return direct ? probeJs(direct, fileSet) : null;
}

function resolveJs(imp: RawImport, file: ScanFile, fileSet: Set<string>, aliases: TsAliases | null): string | null {
  const src = imp.source;
  if (src.startsWith('./') || src.startsWith('../') || src === '.' || src === '..') {
    const base = normalize(posix.join(dirOf(file.path), src));
    return base ? probeJs(base, fileSet) : null;
  }
  if (src.startsWith('/')) return null;
  return aliases ? resolveTsAlias(src, aliases, fileSet) : null;
}

function probePy(parts: string[], fileSet: Set<string>): string | null {
  if (parts.length === 0) return null;
  const base = parts.join('/');
  if (fileSet.has(`${base}.py`)) return `${base}.py`;
  if (fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return null;
}

function resolvePython(imp: RawImport, file: ScanFile, fileSet: Set<string>): string[] {
  const src = imp.source;
  const results: string[] = [];
  const relMatch = /^(\.+)(.*)$/.exec(src);
  if (relMatch) {
    const level = relMatch[1]!.length;
    let dir = dirOf(file.path);
    for (let i = 1; i < level; i += 1) dir = dirOf(dir);
    const rest = relMatch[2]!.split('.').filter(Boolean);
    const baseParts = dir ? dir.split('/') : [];
    const direct = probePy([...baseParts, ...rest], fileSet);
    if (direct) results.push(direct);
    for (const spec of imp.specifiers) {
      const viaSpec = probePy([...baseParts, ...rest, spec], fileSet);
      if (viaSpec) results.push(viaSpec);
    }
    return results;
  }
  const parts = src.split('.').filter(Boolean);
  for (const root of ['', 'src']) {
    const baseParts = root ? [root, ...parts] : parts;
    const direct = probePy(baseParts, fileSet);
    if (direct) {
      results.push(direct);
      for (const spec of imp.specifiers) {
        const viaSpec = probePy([...baseParts, spec], fileSet);
        if (viaSpec) results.push(viaSpec);
      }
      return results;
    }
  }
  return results;
}

function parseGoModule(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /^\s*module\s+(\S+)/m.exec(text);
  return match ? match[1]! : null;
}

function resolveGo(imp: RawImport, goModule: string | null, files: ScanFile[]): string[] {
  if (!goModule) return [];
  const src = imp.source.replace(/^"|"$/g, '');
  if (!src.startsWith(goModule)) return [];
  const rest = src.slice(goModule.length).replace(/^\//, '');
  return files
    .filter((f) => f.path.endsWith('.go') && !f.path.endsWith('_test.go') && dirOf(f.path) === rest)
    .map((f) => f.path);
}

function probeRust(base: string, fileSet: Set<string>): string | null {
  if (fileSet.has(`${base}.rs`)) return `${base}.rs`;
  if (fileSet.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
  return null;
}

function resolveRust(imp: RawImport, file: ScanFile, fileSet: Set<string>): string | null {
  const parts = imp.source
    .replace(/^use\s+/, '')
    .replace(/;$/, '')
    .split('::')
    .filter(Boolean);
  if (parts.length === 0) return null;
  const head = parts[0]!;
  let baseDir: string;
  if (head === 'crate') {
    let dir = dirOf(file.path);
    while (dir && !fileSet.has(`${dir}/lib.rs`) && !fileSet.has(`${dir}/main.rs`)) dir = dirOf(dir);
    baseDir = dir;
    parts.shift();
  } else if (head === 'super') {
    baseDir = dirOf(dirOf(file.path));
    parts.shift();
  } else if (head === 'self') {
    baseDir = dirOf(file.path);
    parts.shift();
  } else {
    return null;
  }
  for (let len = parts.length; len >= 1; len -= 1) {
    const candidate = posix.join(baseDir, ...parts.slice(0, len));
    const found = probeRust(candidate, fileSet);
    if (found && found !== file.path) return found;
  }
  return null;
}

function buildSuffixIndex(files: ScanFile[], exts: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const f of files) {
    if (!exts.some((ext) => f.path.endsWith(ext))) continue;
    const segments = f.path.replace(/\.[^./]+$/, '').split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const key = segments.slice(i).join('/');
      const list = index.get(key) ?? [];
      list.push(f.path);
      index.set(key, list);
    }
  }
  return index;
}

function resolveDotted(fqn: string, index: Map<string, string[]>, self: string): string | null {
  const parts = fqn.replace(/;$/, '').split(/[.\\]/).filter(Boolean);
  for (let len = parts.length; len >= 1; len -= 1) {
    const key = parts.slice(0, len).join('/');
    const hits = index.get(key);
    if (hits && hits.length > 0) {
      const pick = hits.find((h) => h !== self) ?? null;
      if (pick) return pick;
    }
  }
  return null;
}

function resolveRuby(imp: RawImport, file: ScanFile, fileSet: Set<string>): string | null {
  const src = imp.source.replace(/\.rb$/, '');
  const candidates = [normalize(posix.join(dirOf(file.path), src)), posix.join('lib', src), src];
  for (const c of candidates) {
    if (c && fileSet.has(`${c}.rb`)) return `${c}.rb`;
  }
  return null;
}

function resolveC(imp: RawImport, file: ScanFile, fileSet: Set<string>): string | null {
  const src = imp.source.replace(/^[<"]|[>"]$/g, '');
  const candidates = [
    normalize(posix.join(dirOf(file.path), src)),
    posix.join('include', src),
    posix.join('src', src),
    src,
  ];
  for (const c of candidates) if (c && fileSet.has(c)) return c;
  return null;
}

export function resolveImportMap(
  files: ScanFile[],
  rawImports: Record<string, RawImport[]>,
  context: ImportMapContext = {},
): Record<string, string[]> {
  const fileSet = new Set(files.map((f) => f.path));
  const aliases = parseTsconfig(context.tsconfigText);
  const goModule = parseGoModule(context.goModText);
  const jvmIndex = buildSuffixIndex(files, ['.java', '.kt', '.kts', '.scala', '.cs']);
  const phpIndex = buildSuffixIndex(files, ['.php']);
  const importMap: Record<string, string[]> = {};

  for (const file of files) {
    const imports = rawImports[file.path] ?? [];
    const targets = new Set<string>();
    for (const imp of imports) {
      let resolved: Array<string | null> = [];
      if (JS_LANGS.has(file.language)) {
        resolved = [resolveJs(imp, file, fileSet, aliases)];
      } else if (file.language === 'python') {
        resolved = resolvePython(imp, file, fileSet);
      } else if (file.language === 'go') {
        resolved = resolveGo(imp, goModule, files);
      } else if (file.language === 'rust') {
        resolved = [resolveRust(imp, file, fileSet)];
      } else if (['java', 'kotlin', 'scala', 'csharp'].includes(file.language)) {
        resolved = [resolveDotted(imp.source, jvmIndex, file.path)];
      } else if (file.language === 'php') {
        resolved = [resolveDotted(imp.source, phpIndex, file.path)];
      } else if (file.language === 'ruby') {
        resolved = [resolveRuby(imp, file, fileSet)];
      } else if (file.language === 'c' || file.language === 'cpp') {
        resolved = [resolveC(imp, file, fileSet)];
      }
      for (const target of resolved) {
        if (target && target !== file.path && fileSet.has(target)) targets.add(target);
      }
    }
    importMap[file.path] = [...targets].sort();
  }
  return importMap;
}
