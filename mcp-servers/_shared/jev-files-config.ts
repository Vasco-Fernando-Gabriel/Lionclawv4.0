import crypto from 'crypto';
import path from 'path';

export const JEV_FILES_CONFIG_VERSION = 1;
export const JEV_FILES_SALT_BYTES = 32;
export const JEV_FILES_SALT_HEX_LENGTH = JEV_FILES_SALT_BYTES * 2;
export const JEV_FILES_FINGERPRINT_HEX_LENGTH = 64;
export const JEV_FILES_CONFIG_RELATIVE_PATH: ReadonlyArray<string> = ['data', 'jev-files.json'];
export const JEV_FILES_USAGE_LOG_RELATIVE_PATH: ReadonlyArray<string> = ['workspaces', 'lionclaw', 'jev-files.jsonl'];
export const JEV_FILES_MAX_ROOTS = 20;

export const JEV_FILES_SENSITIVE_DIR_NAMES: ReadonlyArray<string> = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.ssh',
  '.aws',
  '.gnupg',
];

export const JEV_FILES_SENSITIVE_DIR_PREFIXES: ReadonlyArray<string> = ['.venv'];

export const JEV_FILES_SENSITIVE_DIR_PAIRS: ReadonlyArray<readonly [string, string]> = [['.lionclaw', 'data']];

export function isJevFilesSensitiveDirName(name: string): boolean {
  const lower = name.toLowerCase();
  if (JEV_FILES_SENSITIVE_DIR_NAMES.includes(lower)) return true;
  return JEV_FILES_SENSITIVE_DIR_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isJevFilesSensitiveDirPair(parentName: string, childName: string): boolean {
  const parent = parentName.toLowerCase();
  const child = childName.toLowerCase();
  return JEV_FILES_SENSITIVE_DIR_PAIRS.some(([a, b]) => a === parent && b === child);
}

export interface JevFilesConfig {
  version: typeof JEV_FILES_CONFIG_VERSION;
  enabled: boolean;
  model: string;
  roots: string[];
  credentialSalt: string;
  credentialFingerprint: string | null;
  updatedAt: string | null;
}

export type JevFilesConfigParse = { ok: true; config: JevFilesConfig } | { ok: false; message: string };

const SALT_RE = new RegExp(`^[0-9a-f]{${JEV_FILES_SALT_HEX_LENGTH}}$`, 'i');
const FINGERPRINT_RE = new RegExp(`^[0-9a-f]{${JEV_FILES_FINGERPRINT_HEX_LENGTH}}$`, 'i');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidSaltHex(value: unknown): value is string {
  return typeof value === 'string' && SALT_RE.test(value);
}

export function isValidFingerprintHex(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

export function parseJevFilesConfig(raw: unknown): JevFilesConfigParse {
  if (!isRecord(raw)) return { ok: false, message: 'jev-files.json nao e um objeto' };
  if (raw.version !== JEV_FILES_CONFIG_VERSION) {
    return { ok: false, message: `jev-files.json com version diferente de ${JEV_FILES_CONFIG_VERSION}` };
  }
  if (typeof raw.enabled !== 'boolean') return { ok: false, message: 'jev-files.json sem enabled booleano' };
  if (typeof raw.model !== 'string' || raw.model.trim().length === 0) {
    return { ok: false, message: 'jev-files.json sem model' };
  }
  if (!Array.isArray(raw.roots)) return { ok: false, message: 'jev-files.json sem roots' };
  const roots: string[] = [];
  for (const entry of raw.roots) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || !path.isAbsolute(entry)) {
      return { ok: false, message: 'jev-files.json com raiz que nao e caminho absoluto' };
    }
    roots.push(entry);
  }
  if (!isValidSaltHex(raw.credentialSalt)) {
    return { ok: false, message: `jev-files.json sem credentialSalt de ${JEV_FILES_SALT_HEX_LENGTH} caracteres hex` };
  }
  const fingerprint = raw.credentialFingerprint;
  if (fingerprint !== null && !isValidFingerprintHex(fingerprint)) {
    return { ok: false, message: 'jev-files.json com credentialFingerprint invalido' };
  }
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return {
    ok: true,
    config: {
      version: JEV_FILES_CONFIG_VERSION,
      enabled: raw.enabled,
      model: raw.model.trim(),
      roots,
      credentialSalt: raw.credentialSalt.toLowerCase(),
      credentialFingerprint: fingerprint === null ? null : fingerprint.toLowerCase(),
      updatedAt,
    },
  };
}

export function fingerprintFor(saltHex: string, apiKey: string): string {
  return crypto.createHmac('sha256', Buffer.from(saltHex, 'hex')).update(apiKey, 'utf8').digest('hex');
}

export function generateSalt(): string {
  return crypto.randomBytes(JEV_FILES_SALT_BYTES).toString('hex');
}
