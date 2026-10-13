import path from 'path';
import {
  JEV_FILES_SENSITIVE_DIR_NAMES,
  JEV_FILES_SENSITIVE_DIR_PAIRS,
  JEV_FILES_SENSITIVE_DIR_PREFIXES,
  isJevFilesSensitiveDirName,
  isJevFilesSensitiveDirPair,
} from '../../_shared/jev-files-config.js';
import { hasGlobChars } from './glob.js';

export type ContainReason = 'outside_roots' | 'relative_path' | 'sensitive' | 'binary' | 'unreadable';

export type TargetKind = 'extended' | 'relative' | 'glob' | 'path';

export interface ContainedFile {
  requestedPath: string;
  realPath: string;
  root: string;
}

export type ContainResult =
  | { ok: true; file: ContainedFile }
  | { ok: true; directory: string; realPath: string; root: string }
  | { ok: false; reason: ContainReason; message: string };

export interface StatLike {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ContainFsLike {
  realpath: (p: string) => Promise<string>;
  stat: (p: string) => Promise<StatLike>;
}

export interface ResolvedRoot {
  configured: string;
  real: string;
}

export const SENSITIVE_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /^\.envrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /\.secret/i,
  /credentials/i,
  /\.tfstate$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

export const SENSITIVE_DIR_NAMES = JEV_FILES_SENSITIVE_DIR_NAMES;
export const SENSITIVE_DIR_PREFIXES = JEV_FILES_SENSITIVE_DIR_PREFIXES;
export const SENSITIVE_DIR_PAIRS = JEV_FILES_SENSITIVE_DIR_PAIRS;

export interface ContainOptions {
  literal?: boolean;
}

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tif',
  '.tiff',
  '.heic',
  '.psd',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.webm',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.tar',
  '.jar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.lib',
  '.class',
  '.pyc',
  '.node',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.wasm',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
]);

export const BINARY_SNIFF_BYTES = 8 * 1024;
export const BINARY_CONTROL_RATIO = 0.05;
export const EXTENDED_PREFIX_MESSAGE = 'prefixo de caminho estendido nao suportado';

const EXTENDED_PREFIX_RE = /^\\\\[?.]\\/;
const DRIVE_RE = /^[a-zA-Z]:/;
export const CASE_INSENSITIVE_FS = process.platform === 'win32';

export function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

export function hasExtendedPrefix(target: string): boolean {
  return EXTENDED_PREFIX_RE.test(target);
}

export function hasAlternateStream(target: string): boolean {
  if (!CASE_INSENSITIVE_FS) return false;
  const rest = DRIVE_RE.test(target) ? target.slice(2) : target;
  return rest.includes(':');
}

export function classifyTarget(target: string): TargetKind {
  if (hasExtendedPrefix(target)) return 'extended';
  if (hasGlobChars(target)) return 'glob';
  if (!path.isAbsolute(target)) return 'relative';
  return 'path';
}

export function isInside(child: string, base: string): boolean {
  const c = foldCase(child);
  const b = foldCase(base);
  if (c === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return c.startsWith(prefix);
}

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(name));
}

export function isSensitiveDirName(name: string): boolean {
  return isJevFilesSensitiveDirName(name);
}

export function isSensitiveDirPair(parentName: string, childName: string): boolean {
  return isJevFilesSensitiveDirPair(parentName, childName);
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

export function hasSensitiveSegment(absolutePath: string, root: string): boolean {
  const all = segmentsOf(absolutePath);
  for (let i = 0; i + 1 < all.length; i++) {
    for (const [a, b] of SENSITIVE_DIR_PAIRS) {
      if (all[i].toLowerCase() === a && all[i + 1].toLowerCase() === b) return true;
    }
  }
  const rootSegments = segmentsOf(root);
  const below = all.slice(rootSegments.length);
  const dirs = below.slice(0, -1);
  return dirs.some(isSensitiveDirName);
}

export function isSensitivePath(absolutePath: string, root: string): boolean {
  return isSensitiveFileName(path.basename(absolutePath)) || hasSensitiveSegment(absolutePath, root);
}

export function isSensitiveDirectoryPath(absolutePath: string, root: string): boolean {
  if (foldCase(absolutePath) === foldCase(root)) return false;
  return isSensitiveDirName(path.basename(absolutePath)) || hasSensitiveSegment(absolutePath, root);
}

export function hasBinaryExtension(absolutePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
}

export function isBinaryContent(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  if (limit === 0) return false;
  let control = 0;
  for (let i = 0; i < limit; i++) {
    const b = buffer[i];
    if (b === 0) return true;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control++;
  }
  return control / limit > BINARY_CONTROL_RATIO;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function resolveRoots(roots: string[], fsImpl: ContainFsLike): Promise<ResolvedRoot[]> {
  const out: ResolvedRoot[] = [];
  for (const root of roots) {
    const configured = path.resolve(root);
    try {
      out.push({ configured, real: await fsImpl.realpath(configured) });
    } catch {
      continue;
    }
  }
  return out;
}

export async function containPath(
  target: string,
  resolvedRoots: ResolvedRoot[],
  fsImpl: ContainFsLike,
  options: ContainOptions = {},
): Promise<ContainResult> {
  const kind = classifyTarget(target);
  if (kind === 'extended') return { ok: false, reason: 'unreadable', message: EXTENDED_PREFIX_MESSAGE };
  if (kind === 'relative' || (kind === 'glob' && !path.isAbsolute(target))) {
    return { ok: false, reason: 'relative_path', message: 'caminho relativo; informe o caminho absoluto' };
  }
  if (kind === 'glob' && options.literal !== true) {
    return { ok: false, reason: 'unreadable', message: 'glob precisa ser expandido antes da contencao' };
  }
  if (hasAlternateStream(target)) {
    return { ok: false, reason: 'sensitive', message: 'fluxo alternativo de dados (ADS) nao e permitido' };
  }
  const requestedPath = path.resolve(target);
  const requestedRoot = resolvedRoots.find(
    (r) => isInside(requestedPath, r.configured) || isInside(requestedPath, r.real),
  );
  if (!requestedRoot) {
    return { ok: false, reason: 'outside_roots', message: 'caminho fora das pastas permitidas' };
  }
  const requestedBase = isInside(requestedPath, requestedRoot.configured)
    ? requestedRoot.configured
    : requestedRoot.real;
  if (isSensitivePath(requestedPath, requestedBase)) {
    return { ok: false, reason: 'sensitive', message: 'caminho recusado pela politica de arquivos sensiveis' };
  }

  let realPath: string;
  try {
    realPath = await fsImpl.realpath(requestedPath);
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: errorText(err) };
  }
  if (hasAlternateStream(realPath)) {
    return { ok: false, reason: 'sensitive', message: 'fluxo alternativo de dados (ADS) nao e permitido' };
  }
  const realRoot = resolvedRoots.find((r) => isInside(realPath, r.real));
  if (!realRoot) {
    return { ok: false, reason: 'outside_roots', message: 'o caminho real aponta para fora das pastas permitidas' };
  }
  if (isSensitivePath(realPath, realRoot.real)) {
    return { ok: false, reason: 'sensitive', message: 'o caminho real e recusado pela politica de arquivos sensiveis' };
  }

  let stat: StatLike;
  try {
    stat = await fsImpl.stat(realPath);
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: errorText(err) };
  }
  if (stat.isDirectory()) {
    if (isSensitiveDirectoryPath(requestedPath, requestedBase) || isSensitiveDirectoryPath(realPath, realRoot.real)) {
      return { ok: false, reason: 'sensitive', message: 'pasta recusada pela politica de pastas sensiveis' };
    }
    return { ok: true, directory: requestedPath, realPath, root: realRoot.real };
  }
  if (!stat.isFile()) return { ok: false, reason: 'unreadable', message: 'o alvo nao e um arquivo regular' };

  if (hasBinaryExtension(requestedPath) || hasBinaryExtension(realPath)) {
    return { ok: false, reason: 'binary', message: 'extensao de arquivo binario' };
  }

  return { ok: true, file: { requestedPath, realPath, root: realRoot.real } };
}

export async function containFile(target: string, roots: string[], fsImpl: ContainFsLike): Promise<ContainResult> {
  return containPath(target, await resolveRoots(roots, fsImpl), fsImpl);
}
