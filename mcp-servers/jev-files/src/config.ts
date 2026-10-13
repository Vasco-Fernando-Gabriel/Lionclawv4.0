import path from 'path';
import {
  JEV_FILES_CONFIG_RELATIVE_PATH,
  parseJevFilesConfig,
  type JevFilesConfig,
} from '../../_shared/jev-files-config.js';

export const JEV_API_KEY_ENV = 'TYPESAFE_JEV_API_KEY';
export const LIONCLAW_HOME_ENV = 'LIONCLAW_HOME';
export const RUNTIME_HINT_ENV = 'LIONCLAW_RUNTIME';

export type { JevFilesConfig };

export type JevFilesConfigRead =
  { status: 'absent' } | { status: 'invalid'; message: string } | { status: 'ok'; config: JevFilesConfig };

export interface ConfigFsLike {
  readFileSync: (filePath: string, encoding: 'utf8') => string;
}

export type EnvLike = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveLionclawHome(homeDir: string, env: EnvLike): string {
  const fromEnv = env[LIONCLAW_HOME_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.join(homeDir, '.lionclaw');
}

export function resolveConfigPath(homeDir: string, env: EnvLike): string {
  return path.join(resolveLionclawHome(homeDir, env), ...JEV_FILES_CONFIG_RELATIVE_PATH);
}

export function readJevFilesConfig(filePath: string, fsImpl: ConfigFsLike): JevFilesConfigRead {
  let text: string;
  try {
    text = fsImpl.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent' };
    return {
      status: 'invalid',
      message: `jev-files.json ilegivel: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'invalid', message: 'jev-files.json nao e JSON valido' };
  }
  const validated = parseJevFilesConfig(parsed);
  if (!validated.ok) return { status: 'invalid', message: validated.message };
  return { status: 'ok', config: validated.config };
}

export function readApiKeyFromEnv(env: EnvLike): string | null {
  const raw = env[JEV_API_KEY_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readRuntimeHint(env: EnvLike): string | null {
  const raw = env[RUNTIME_HINT_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
