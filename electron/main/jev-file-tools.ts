import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getSetting, listDynamicWorkflowDefinitions, listHarnessProjects, onProjectPathsChanged } from './db';
import { getSecretNonInteractive } from './secrets-vault';
import { getLionClawHome } from './paths';
import {
  JEV_API_KEY_VAULT_KEY,
  JEV_FILE_TOOLS_ENABLED_SETTING_KEY,
  JEV_FILE_TOOLS_ROOTS_SETTING_KEY,
  JEV_MODEL_SETTING_KEY,
  defaultJevFileToolsRoot,
  parseJevFileToolsRoots,
  resolveJevFileToolsRegistration,
  resolveJevModel,
  setJevFileToolsRegistration,
  type JevFileToolsRegistrationDecision,
} from './jev-settings';

export { resolveJevFileToolsRegistration, type JevFileToolsRegistrationDecision };
import {
  JEV_FILES_CONFIG_RELATIVE_PATH,
  JEV_FILES_CONFIG_VERSION,
  JEV_FILES_USAGE_LOG_RELATIVE_PATH,
  fingerprintFor,
  generateSalt,
  isJevFilesSensitiveDirName,
  isJevFilesSensitiveDirPair,
  isValidSaltHex,
  type JevFilesConfig,
} from '../../mcp-servers/_shared/jev-files-config';

const logger = createLogger('jev-file-tools');

export const JEV_FILES_SERVER_ID = 'jev-files';

export type JevFileToolsChangeReason = 'flag' | 'roots' | 'model' | 'key';

export interface JevFileToolsState {
  flagEnabled: boolean;
  keyConfigured: boolean;
  keyError: string | null;
  enabled: boolean;
  model: string;
  roots: string[];
  manualRoots: string[];
  projectRoots: string[];
  configPath: string;
  written: boolean;
}

export interface JevFileToolsRoots {
  manual: string[];
  projects: string[];
}

export interface JevFileToolsStats {
  calls: number;
  files: number;
  charsRead: number;
  costUsd: number;
  estimatedTokensAvoided: number;
  lastAt: string | null;
}

export function resolveJevFilesConfigPath(): string {
  return path.join(getLionClawHome(), ...JEV_FILES_CONFIG_RELATIVE_PATH);
}

export function resolveJevFilesUsageLogPath(): string {
  return path.join(getLionClawHome(), ...JEV_FILES_USAGE_LOG_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readExistingSalt(configPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isValidSaltHex(parsed.credentialSalt)) return parsed.credentialSalt.toLowerCase();
  } catch {
    return null;
  }
  return null;
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

const CASE_INSENSITIVE_FS = process.platform === 'win32';

function rootKey(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

function isUsableProjectRoot(resolved: string): boolean {
  if (
    isJevFilesSensitiveDirName(path.basename(resolved)) ||
    isJevFilesSensitiveDirPair(path.basename(path.dirname(resolved)), path.basename(resolved))
  ) {
    return false;
  }
  try {
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

export function collectJevFileToolsProjectRoots(): string[] {
  const candidates: string[] = [];
  try {
    for (const project of listHarnessProjects()) candidates.push(project.projectPath);
    for (const definition of listDynamicWorkflowDefinitions()) candidates.push(definition.projectPath);
  } catch (err) {
    logger.warn({ err }, 'nao foi possivel listar os projetos cadastrados (raizes automaticas ficam vazias)');
    return [];
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    const trimmed = candidate.trim();
    if (!path.isAbsolute(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    const key = rootKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isUsableProjectRoot(resolved)) continue;
    roots.push(resolved);
  }
  return roots;
}

function mergeRoots(manual: string[], projects: string[]): string[] {
  const merged = [...manual];
  const seen = new Set(manual.map(rootKey));
  for (const root of projects) {
    const key = rootKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(root);
  }
  return merged;
}

export function resolveJevFileToolsRoots(): JevFileToolsRoots {
  const defaultRoot = defaultJevFileToolsRoot(getLionClawHome());
  const manual = parseJevFileToolsRoots(getSetting(JEV_FILE_TOOLS_ROOTS_SETTING_KEY), [defaultRoot]);
  const manualKeys = new Set(manual.map(rootKey));
  const projects = collectJevFileToolsProjectRoots().filter((root) => !manualKeys.has(rootKey(root)));
  return { manual, projects };
}

function describeReason(state: Pick<JevFileToolsState, 'flagEnabled' | 'keyConfigured' | 'keyError'>): string {
  if (!state.flagEnabled) return 'desligado nas Settings (jev_file_tools_enabled=false)';
  if (state.keyError !== null) return `chave do Jev ilegivel: ${state.keyError}`;
  if (!state.keyConfigured) return 'chave do Jev ausente no Vault';
  return 'ativo';
}

export async function writeJevFilesConfig(): Promise<JevFileToolsState> {
  const configPath = resolveJevFilesConfigPath();
  const flagEnabled = getSetting(JEV_FILE_TOOLS_ENABLED_SETTING_KEY) === 'true';
  const model = resolveJevModel(getSetting(JEV_MODEL_SETTING_KEY));
  const defaultRoot = defaultJevFileToolsRoot(getLionClawHome());
  const manualRoots = parseJevFileToolsRoots(getSetting(JEV_FILE_TOOLS_ROOTS_SETTING_KEY), [defaultRoot]);
  const manualKeys = new Set(manualRoots.map(rootKey));
  const projectRoots = collectJevFileToolsProjectRoots().filter((root) => !manualKeys.has(rootKey(root)));
  const roots = mergeRoots(manualRoots, projectRoots);
  if (manualRoots.includes(defaultRoot)) {
    try {
      await fs.promises.mkdir(defaultRoot, { recursive: true });
    } catch (err) {
      logger.warn({ err, defaultRoot }, 'nao foi possivel criar a raiz default das pastas permitidas');
    }
  }

  let apiKey: string | null = null;
  let keyError: string | null = null;
  if (flagEnabled) {
    try {
      const secret = await getSecretNonInteractive(JEV_API_KEY_VAULT_KEY);
      if (secret.status === 'found' && secret.value.trim().length > 0) apiKey = secret.value.trim();
      else if (secret.status === 'error') keyError = secret.reason;
    } catch (err) {
      keyError = err instanceof Error ? err.message : String(err);
    }
  }

  const state: JevFileToolsState = {
    flagEnabled,
    keyConfigured: apiKey !== null,
    keyError,
    enabled: flagEnabled && apiKey !== null,
    model,
    roots,
    manualRoots,
    projectRoots,
    configPath,
    written: false,
  };

  try {
    const salt = (await readExistingSalt(configPath)) ?? generateSalt();
    const config: JevFilesConfig = {
      version: JEV_FILES_CONFIG_VERSION,
      enabled: state.enabled,
      model,
      roots,
      credentialSalt: salt,
      credentialFingerprint: apiKey === null ? null : fingerprintFor(salt, apiKey),
      updatedAt: new Date().toISOString(),
    };
    await writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
    state.written = true;
  } catch (err) {
    logger.warn({ err, configPath }, 'nao foi possivel escrever jev-files.json (ferramenta fica inativa)');
    state.enabled = false;
  }

  setJevFileToolsRegistration(
    state.enabled
      ? { isActive: true }
      : { isActive: false, reason: state.written ? describeReason(state) : 'jev-files.json nao pode ser escrito' },
  );
  return state;
}

let projectRootsRefresh: Promise<void> = Promise.resolve();
let lastWrittenProjectRoots: string | null = null;

export function refreshJevFileToolsProjectRoots(): Promise<void> {
  projectRootsRefresh = projectRootsRefresh.then(async () => {
    try {
      const next = JSON.stringify(collectJevFileToolsProjectRoots());
      if (next === lastWrittenProjectRoots) return;
      const state = await writeJevFilesConfig();
      lastWrittenProjectRoots = JSON.stringify(state.projectRoots);
      logger.info({ projectRoots: state.projectRoots.length }, 'jev-files.json reescrito com as pastas dos projetos');
    } catch (err) {
      logger.warn({ err }, 'nao foi possivel atualizar as pastas dos projetos no jev-files.json');
    }
  });
  return projectRootsRefresh;
}

export function watchJevFileToolsProjectRoots(): () => void {
  lastWrittenProjectRoots = JSON.stringify(collectJevFileToolsProjectRoots());
  return onProjectPathsChanged(() => {
    void refreshJevFileToolsProjectRoots();
  });
}

export async function applyJevFileToolsChange(reason: JevFileToolsChangeReason): Promise<void> {
  try {
    const state = await writeJevFilesConfig();
    const { getAllMCPServers, updateMCPServer, startServer, stopServer, restartServer, discoverAndSaveMCPTools } =
      await import('./mcp-manager');
    const row = getAllMCPServers().find((s) => s.id === JEV_FILES_SERVER_ID);
    let registrationChanged = false;
    let processStarted = false;

    if (row === undefined) {
      logger.warn(
        { reason },
        'jev-files nao esta registrado nos built-ins (servidor nao registrado; rode npm run build:mcps e reinicie o app)',
      );
    } else if (!state.enabled) {
      if (row.isActive) {
        try {
          stopServer(JEV_FILES_SERVER_ID);
        } catch (err) {
          logger.warn({ err }, 'stop do jev-files falhou (segue desativacao)');
        }
        updateMCPServer(JEV_FILES_SERVER_ID, { isActive: false });
        registrationChanged = true;
        logger.info({ reason, motivo: describeReason(state) }, 'jev-files desligado: processo parado e desativado');
      } else {
        logger.info({ reason, motivo: describeReason(state) }, 'jev-files segue desligado; arquivo reescrito');
      }
    } else if (!row.isActive) {
      updateMCPServer(JEV_FILES_SERVER_ID, { isActive: true });
      registrationChanged = true;
      try {
        await startServer(JEV_FILES_SERVER_ID);
        processStarted = true;
      } catch (err) {
        logger.warn({ err }, 'start do jev-files falhou (isActive gravado; restart resolve)');
      }
      logger.info({ reason }, 'jev-files ligado: processo iniciado');
    } else {
      registrationChanged = true;
      try {
        await restartServer(JEV_FILES_SERVER_ID);
        processStarted = true;
      } catch (err) {
        logger.warn({ err }, 'restart do jev-files falhou (restart manual resolve)');
      }
      logger.info({ reason }, 'jev-files reiniciado para ler a configuracao nova');
    }

    if (processStarted) {
      try {
        await discoverAndSaveMCPTools(JEV_FILES_SERVER_ID);
        logger.info({ reason }, 'jev-files: tools indexadas no catalogo');
      } catch (err) {
        logger.warn({ err }, 'discovery das tools do jev-files falhou (mcp_invoke re-descobre sob demanda)');
      }
    }

    if (registrationChanged) {
      try {
        const { syncCodexMcpConfig } = await import('./codex-sdk/mcp-config-sync');
        await syncCodexMcpConfig();
      } catch (err) {
        logger.warn({ err }, 're-sync do codex apos mudanca do jev-files falhou (restart resolve)');
      }
    }
  } catch (err) {
    logger.error({ err, reason }, 'applyJevFileToolsChange falhou (setting ja gravado; restart resolve)');
  }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const JEV_FILES_STATS_TAIL_BYTES = 2 * 1024 * 1024;

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size <= maxBytes) return (await handle.readFile()).toString('utf8');
    const buffer = Buffer.allocUnsafe(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, maxBytes - total, size - maxBytes + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const text = buffer.subarray(0, total).toString('utf8');
    const firstBreak = text.indexOf('\n');
    return firstBreak < 0 ? '' : text.slice(firstBreak + 1);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readJevFileToolsStats(
  filePath: string = resolveJevFilesUsageLogPath(),
): Promise<JevFileToolsStats> {
  const stats: JevFileToolsStats = {
    calls: 0,
    files: 0,
    charsRead: 0,
    costUsd: 0,
    estimatedTokensAvoided: 0,
    lastAt: null,
  };
  let text: string;
  try {
    text = await readTail(filePath, JEV_FILES_STATS_TAIL_BYTES);
  } catch {
    return stats;
  }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    stats.calls++;
    stats.files += asNumber(record.files);
    stats.charsRead += asNumber(record.charsRead);
    stats.costUsd += asNumber(record.costUsd);
    if (typeof record.timestamp === 'string') stats.lastAt = record.timestamp;
  }
  stats.estimatedTokensAvoided = Math.round(stats.charsRead / 4);
  return stats;
}
