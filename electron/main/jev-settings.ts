import fs from 'fs';
import path from 'path';
import {
  JEV_API_KEY_VAULT_KEY,
  JEV_DEFAULT_MODEL,
  JEV_MODEL_MAX_LENGTH,
  normalizeJevModel,
  resolveJevModel,
} from '../../src/constants/jev';
import {
  JEV_FILES_MAX_ROOTS,
  isJevFilesSensitiveDirName,
  isJevFilesSensitiveDirPair,
} from '../../mcp-servers/_shared/jev-files-config';

export { JEV_API_KEY_VAULT_KEY, JEV_DEFAULT_MODEL, JEV_MODEL_MAX_LENGTH, normalizeJevModel, resolveJevModel };

export const JEV_SHADOW_ENABLED_SETTING_KEY = 'jev_shadow_enabled';
export const JEV_MODEL_SETTING_KEY = 'jev_model';
export const JEV_FILE_TOOLS_ENABLED_SETTING_KEY = 'jev_file_tools_enabled';
export const JEV_FILE_TOOLS_ROOTS_SETTING_KEY = 'jev_file_tools_roots';

export const JEV_SHADOW_SETTING_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  [JEV_SHADOW_ENABLED_SETTING_KEY, 'false'],
  [JEV_MODEL_SETTING_KEY, JEV_DEFAULT_MODEL],
];

export interface JevFileToolsRegistrationDecision {
  isActive: boolean;
  reason?: string;
}

let jevFileToolsRegistration: JevFileToolsRegistrationDecision = {
  isActive: false,
  reason: 'jev-files.json ainda nao foi escrito neste boot',
};

export function setJevFileToolsRegistration(decision: JevFileToolsRegistrationDecision): void {
  jevFileToolsRegistration = decision;
}

export function resolveJevFileToolsRegistration(): JevFileToolsRegistrationDecision {
  return jevFileToolsRegistration;
}

export function defaultJevFileToolsRoot(lionclawHome: string): string {
  return path.join(lionclawHome, 'workspaces');
}

export function jevFileToolsSettingDefaults(defaultRoot: string): ReadonlyArray<readonly [string, string]> {
  return [
    [JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'false'],
    [JEV_FILE_TOOLS_ROOTS_SETTING_KEY, JSON.stringify([defaultRoot])],
  ];
}

export function parseJevFileToolsRoots(raw: string | undefined | null, fallback: string[]): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [...fallback];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...fallback];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [...fallback];
  const roots: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || !path.isAbsolute(entry)) return [...fallback];
    roots.push(entry);
  }
  return roots;
}

export interface JevFileToolsRootsFs {
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory(): boolean };
}

export interface NormalizeJevFileToolsRootsOptions {
  homeDir: string;
  fsImpl?: JevFileToolsRootsFs;
}

export type NormalizeJevFileToolsRootsResult = { ok: true; roots: string[] } | { ok: false; error: string };

const CASE_INSENSITIVE_FS = process.platform === 'win32';

function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

export function expandHomeInRoot(entry: string, homeDir: string): string {
  if (entry === '~') return homeDir;
  if (entry.startsWith('~/') || entry.startsWith('~\\')) return path.join(homeDir, entry.slice(2));
  return entry;
}

export function normalizeJevFileToolsRoots(
  raw: unknown,
  options: NormalizeJevFileToolsRootsOptions,
): NormalizeJevFileToolsRootsResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'Pastas permitidas: informe uma lista de caminhos.' };
  const fsImpl = options.fsImpl ?? fs;
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') return { ok: false, error: 'Pastas permitidas: cada linha precisa ser um caminho.' };
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const expanded = expandHomeInRoot(trimmed, options.homeDir);
    if (!path.isAbsolute(expanded)) {
      return { ok: false, error: `Pastas permitidas: "${trimmed}" nao e um caminho absoluto.` };
    }
    const resolved = path.resolve(expanded);
    if (
      isJevFilesSensitiveDirName(path.basename(resolved)) ||
      isJevFilesSensitiveDirPair(path.basename(path.dirname(resolved)), path.basename(resolved))
    ) {
      return { ok: false, error: `Pastas permitidas: "${trimmed}" e uma pasta sensivel e nao pode ser raiz.` };
    }
    let isDirectory = false;
    try {
      isDirectory = fsImpl.existsSync(resolved) && fsImpl.statSync(resolved).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return { ok: false, error: `Pastas permitidas: "${trimmed}" nao existe ou nao e uma pasta.` };
    }
    const key = foldCase(resolved);
    if (seen.has(key)) return { ok: false, error: `Pastas permitidas: "${trimmed}" esta repetida.` };
    seen.add(key);
    roots.push(resolved);
    if (roots.length > JEV_FILES_MAX_ROOTS) {
      return { ok: false, error: `Pastas permitidas: no maximo ${JEV_FILES_MAX_ROOTS} pastas.` };
    }
  }
  if (roots.length === 0) return { ok: false, error: 'Pastas permitidas: informe ao menos uma pasta.' };
  return { ok: true, roots };
}
