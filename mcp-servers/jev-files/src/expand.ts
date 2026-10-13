import path from 'path';
import {
  CASE_INSENSITIVE_FS,
  EXTENDED_PREFIX_MESSAGE,
  classifyTarget,
  containPath,
  errorText,
  foldCase,
  isSensitiveDirName,
  isSensitiveDirPair,
  resolveRoots,
  type ContainFsLike,
  type ContainReason,
  type ContainedFile,
  type ResolvedRoot,
} from './contain.js';
import { globMaxDepth, globToRegExp, splitGlob, toGlobRelative } from './glob.js';

export const MAX_WALK_DEPTH = 12;
export const MAX_WALK_ENTRIES = 5_000;

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ExpandFsLike extends ContainFsLike {
  readdir: (dirPath: string, options: { withFileTypes: true }) => Promise<DirentLike[]>;
}

export type ExpandSkipReason = ContainReason | 'depth_limit';

export interface ExpandSkip {
  path: string;
  reason: ExpandSkipReason;
  message: string;
}

export interface ExpandResult {
  files: ContainedFile[];
  skipped: ExpandSkip[];
  truncated: boolean;
}

export class TooManyEntriesError extends Error {
  constructor(limit: number) {
    super(`percurso de pastas passou de ${limit} entradas; use um glob ou pasta mais estreita`);
    this.name = 'TooManyEntriesError';
  }
}

interface Matcher {
  re: RegExp;
  base: string;
  maxDepth: number;
}

interface WalkState {
  roots: ResolvedRoot[];
  fsImpl: ExpandFsLike;
  files: Map<string, ContainedFile>;
  dirs: Set<string>;
  skipped: ExpandSkip[];
  truncated: boolean;
  visited: number;
  matched: number;
}

const LITERAL = { literal: true } as const;

function addFile(state: WalkState, file: ContainedFile): void {
  const key = foldCase(file.realPath);
  if (!state.files.has(key)) state.files.set(key, file);
}

function markDir(state: WalkState, realDir: string): boolean {
  const key = foldCase(realDir);
  if (state.dirs.has(key)) return false;
  state.dirs.add(key);
  return true;
}

async function containAndAdd(state: WalkState, target: string): Promise<void> {
  const result = await containPath(target, state.roots, state.fsImpl, LITERAL);
  if (!result.ok) {
    state.skipped.push({ path: target, reason: result.reason, message: result.message });
    return;
  }
  if ('directory' in result) {
    state.skipped.push({ path: target, reason: 'unreadable', message: 'entrada e uma pasta' });
    return;
  }
  addFile(state, result.file);
}

async function walk(
  state: WalkState,
  dirPath: string,
  realDir: string,
  depth: number,
  matcher: Matcher | null,
): Promise<void> {
  let entries: DirentLike[];
  try {
    entries = await state.fsImpl.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    state.skipped.push({ path: dirPath, reason: 'unreadable', message: errorText(err) });
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parentName = path.basename(realDir);
  for (const entry of entries) {
    state.visited++;
    if (state.visited > MAX_WALK_ENTRIES) throw new TooManyEntriesError(MAX_WALK_ENTRIES);
    const full = path.join(dirPath, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    let linkedDir = false;
    if (entry.isSymbolicLink()) {
      try {
        const stat = await state.fsImpl.stat(full);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
        linkedDir = isDir;
      } catch (err) {
        state.skipped.push({ path: full, reason: 'unreadable', message: errorText(err) });
        continue;
      }
    }
    if (isDir) {
      if (isSensitiveDirName(entry.name) || isSensitiveDirPair(parentName, entry.name)) continue;
      if (matcher && depth + 1 > matcher.maxDepth) continue;
      if (depth + 1 > MAX_WALK_DEPTH) {
        state.skipped.push({
          path: full,
          reason: 'depth_limit',
          message: `pasta alem da profundidade ${MAX_WALK_DEPTH}`,
        });
        state.truncated = true;
        continue;
      }
      let realSub = path.join(realDir, entry.name);
      if (linkedDir) {
        const contained = await containPath(full, state.roots, state.fsImpl, LITERAL);
        if (!contained.ok) {
          state.skipped.push({ path: full, reason: contained.reason, message: contained.message });
          continue;
        }
        if (!('directory' in contained)) continue;
        realSub = contained.realPath;
      }
      if (!markDir(state, realSub)) continue;
      await walk(state, full, realSub, depth + 1, matcher);
      continue;
    }
    if (!isFile) continue;
    if (matcher && !matcher.re.test(toGlobRelative(matcher.base, full))) continue;
    state.matched++;
    await containAndAdd(state, full);
  }
}

async function existsLiterally(target: string, fsImpl: ExpandFsLike): Promise<boolean> {
  try {
    await fsImpl.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function expandDirectory(state: WalkState, requested: string, realPath: string, matcher: Matcher | null) {
  state.dirs = new Set();
  markDir(state, realPath);
  await walk(state, requested, realPath, 0, matcher);
}

export async function expandTargets(
  targets: string[],
  configuredRoots: string[],
  fsImpl: ExpandFsLike,
): Promise<ExpandResult> {
  const state: WalkState = {
    roots: await resolveRoots(configuredRoots, fsImpl),
    fsImpl,
    files: new Map(),
    dirs: new Set(),
    skipped: [],
    truncated: false,
    visited: 0,
    matched: 0,
  };
  for (const target of targets) {
    let kind = classifyTarget(target);
    if (kind === 'extended') {
      state.skipped.push({ path: target, reason: 'unreadable', message: EXTENDED_PREFIX_MESSAGE });
      continue;
    }
    if (kind === 'relative') {
      state.skipped.push({
        path: target,
        reason: 'relative_path',
        message: 'caminho relativo; informe o caminho absoluto',
      });
      continue;
    }
    if (kind === 'glob' && path.isAbsolute(target) && (await existsLiterally(target, fsImpl))) kind = 'path';
    if (kind === 'glob') {
      const split = splitGlob(target);
      if (!split || split.baseDir.length === 0 || !path.isAbsolute(split.baseDir)) {
        state.skipped.push({ path: target, reason: 'relative_path', message: 'glob precisa de base absoluta' });
        continue;
      }
      const base = await containPath(split.baseDir, state.roots, fsImpl);
      if (!base.ok) {
        state.skipped.push({ path: target, reason: base.reason, message: base.message });
        continue;
      }
      if (!('directory' in base)) {
        state.skipped.push({ path: target, reason: 'unreadable', message: 'a base do glob nao e uma pasta' });
        continue;
      }
      const matcher: Matcher = {
        re: globToRegExp(split.pattern, CASE_INSENSITIVE_FS),
        base: base.directory,
        maxDepth: globMaxDepth(split.pattern),
      };
      const matchedBefore = state.matched;
      await expandDirectory(state, base.directory, base.realPath, matcher);
      if (state.matched === matchedBefore) {
        state.skipped.push({ path: target, reason: 'unreadable', message: 'nenhum arquivo casou com o glob' });
      }
      continue;
    }
    const contained = await containPath(target, state.roots, fsImpl, LITERAL);
    if (!contained.ok) {
      state.skipped.push({ path: target, reason: contained.reason, message: contained.message });
      continue;
    }
    if ('directory' in contained) {
      await expandDirectory(state, contained.directory, contained.realPath, null);
      continue;
    }
    addFile(state, contained.file);
  }
  return {
    files: [...state.files.values()],
    skipped: state.skipped,
    truncated: state.truncated,
  };
}
