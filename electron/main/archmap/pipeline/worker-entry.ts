import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ARCHMAP_WORKER_ENTRY_BASENAME = 'archmap-worker.js';
export const ARCHMAP_GRAMMARS_SUBDIR = join('electron', 'main', 'archmap', 'core', 'grammars');

const DIST_MAIN_SUBDIR = join('dist', 'main');
const ASAR_SEGMENT = 'app.asar';
const ASAR_UNPACKED_SEGMENT = 'app.asar.unpacked';
const ASAR_SEGMENT_POSIX = 'app.asar/';
const ASAR_SEGMENT_WIN = 'app.asar\\';

function insideAsar(p: string): boolean {
  return p.includes(ASAR_SEGMENT_POSIX) || p.includes(ASAR_SEGMENT_WIN) || p.endsWith(ASAR_SEGMENT);
}

function unpackedVariants(p: string): string[] {
  if (insideAsar(p)) {
    return [p.replace(ASAR_SEGMENT, ASAR_UNPACKED_SEGMENT), p];
  }
  return [p];
}

export function unpackedPath(p: string): string {
  return insideAsar(p) ? p.replace(ASAR_SEGMENT, ASAR_UNPACKED_SEGMENT) : p;
}

export function resolveArchmapWorkerEntry(
  dirName: string,
  appPath?: string,
  existsCheck: (p: string) => boolean = existsSync,
  packaged: boolean = electronIsPackaged(),
): string {
  const bases = [join(dirName, ARCHMAP_WORKER_ENTRY_BASENAME)];
  if (typeof appPath === 'string' && appPath.length > 0) {
    bases.push(resolve(appPath, DIST_MAIN_SUBDIR, ARCHMAP_WORKER_ENTRY_BASENAME));
  }
  const candidates = packaged ? bases.map(unpackedPath) : bases;
  for (const candidate of candidates) {
    if (existsCheck(candidate)) return candidate;
  }
  return candidates[0];
}

export function resolveArchmapGrammarsDirForHost(
  appPath: string | undefined,
  existsCheck: (p: string) => boolean = existsSync,
): string | null {
  if (typeof appPath !== 'string' || appPath.length === 0) return null;
  for (const candidate of unpackedVariants(resolve(appPath, ARCHMAP_GRAMMARS_SUBDIR))) {
    if (existsCheck(candidate)) return candidate;
  }
  return null;
}

function electronApp(): { getAppPath?: () => string; isPackaged?: boolean } | undefined {
  try {
    const electron = require('electron') as { app?: { getAppPath?: () => string; isPackaged?: boolean } };
    return electron.app;
  } catch {
    return undefined;
  }
}

export function electronAppPath(): string | undefined {
  return electronApp()?.getAppPath?.();
}

export function electronIsPackaged(): boolean {
  return electronApp()?.isPackaged === true;
}
