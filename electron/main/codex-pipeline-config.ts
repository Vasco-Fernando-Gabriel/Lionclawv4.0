import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger';

const logger = createLogger('codex-pipeline-config');

export interface CodexSpawnExtras {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export function getPipelineCodexHomeDir(): string {
  return path.join(os.homedir(), '.lionclaw', 'runtime', 'codex-pipeline-home');
}

export function listConfiguredCodexMcpServerNames(): string[] {
  const configPath = path.join(resolveCodexHome(), 'config.toml');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (e) {
    logger.debug({ err: e, configPath }, 'config.toml do codex ilegivel/ausente; sem overrides de mcp_servers');
    return [];
  }
  return Array.from(collectMcpServerHeaderNames(raw)).sort();
}

function collectMcpServerHeaderNames(segment: string): Set<string> {
  const names = new Set<string>();
  for (const line of segment.split('\n')) {
    const name = parseMcpServerHeaderName(line);
    if (name) names.add(name);
  }
  return names;
}

export function parseMcpServerHeaderName(line: string): string | null {
  const header = /^\s*\[mcp_servers\.(.+?)\]\s*(?:#.*)?$/.exec(line);
  if (!header) return null;
  const rest = header[1];
  const quoted = /^"([^"]+)"/.exec(rest);
  const bare = /^([A-Za-z0-9_-]+)/.exec(rest);
  return quoted ? quoted[1] : bare ? bare[1] : null;
}

export const LIONCLAW_MANAGED_BEGIN_MARKER = '# >>> LIONCLAW_MANAGED (do not edit manually)';
export const LIONCLAW_MANAGED_END_MARKER = '# <<< LIONCLAW_MANAGED';

export function segmentDeclaresMcpServer(segment: string, id: string): boolean {
  return collectMcpServerHeaderNames(segment).has(id);
}

function readManagedBlockSegment(): string | null {
  const configPath = path.join(resolveCodexHome(), 'config.toml');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (e) {
    logger.debug({ err: e, configPath }, 'config.toml do codex ilegivel/ausente; managed block sem entry');
    return null;
  }
  const beginIdx = raw.indexOf(LIONCLAW_MANAGED_BEGIN_MARKER);
  if (beginIdx === -1) return null;
  const endIdx = raw.indexOf(LIONCLAW_MANAGED_END_MARKER, beginIdx);
  return raw.slice(beginIdx, endIdx === -1 ? raw.length : endIdx);
}

export function codexManagedBlockDeclaresServer(id: string): boolean {
  const managed = readManagedBlockSegment();
  if (managed === null) return false;
  return segmentDeclaresMcpServer(managed, id);
}

export function listCodexManagedBlockServerNames(): string[] {
  const managed = readManagedBlockSegment();
  if (managed === null) return [];
  return Array.from(collectMcpServerHeaderNames(managed)).sort();
}

export function getOfficialPhaseCodexSpawnExtraArgs(): string[] {
  const args: string[] = [];
  for (const name of listCodexManagedBlockServerNames()) {
    const key = tomlKeyForConfigPath(name);
    if (!key) continue;
    args.push('-c', `mcp_servers.${key}.enabled=false`);
  }
  return args;
}

export function tomlKeyForConfigPath(name: string): string | null {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  if (!name.includes('"')) return `"${name}"`;
  logger.warn({ name }, 'nome de mcp_server com aspas nao suportado no override -c; server ignorado');
  return null;
}

export const PIPELINE_WINDOWS_SANDBOX_MODE = 'unelevated';

export function pipelineCodexHomeConfigToml(platform: NodeJS.Platform = process.platform): string {
  const lines = [
    '# CODEX_HOME dedicado das sessoes de pipeline do LionClaw (B6, fallback).',
    '# Gerado por codex-pipeline-config.ts - NAO editar a mao.',
    '# Sem nenhum [mcp_servers.*]: frota MCP zero para agentes de fase.',
    '# auth.json deste home e um link (symlink ou hardlink) ou copia do auth real do codex.',
  ];
  if (platform === 'win32') {
    lines.push(
      '# Sandbox do Windows sem elevacao: o modo elevated exige preparo por maquina que este home nao tem',
      '# e sem a secao o Codex recusa todo comando em read-only ("blocked by policy").',
      '',
      '[windows]',
      `sandbox = "${PIPELINE_WINDOWS_SANDBOX_MODE}"`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function getPipelineCodexHomeFallbackExtras(): CodexSpawnExtras {
  const home = getPipelineCodexHomeDir();
  fs.mkdirSync(home, { recursive: true });

  const configPath = path.join(home, 'config.toml');
  let currentConfig: string | null = null;
  try {
    currentConfig = fs.readFileSync(configPath, 'utf-8');
  } catch {
    currentConfig = null;
  }
  const expectedConfig = pipelineCodexHomeConfigToml();
  if (currentConfig !== expectedConfig) {
    fs.writeFileSync(configPath, expectedConfig, 'utf-8');
  }

  ensurePipelineAuthLink(path.join(resolveCodexHome(), 'auth.json'), path.join(home, 'auth.json'));

  return { args: [], env: { ...process.env, CODEX_HOME: home } };
}

export type PipelineAuthLinkKind = 'symlink' | 'hardlink' | 'copy';

function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
}

export function ensurePipelineAuthLink(realAuthPath: string, linkPath: string): PipelineAuthLinkKind {
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) === realAuthPath) return 'symlink';
      logger.warn({ linkPath }, 'auth.json do home dedicado aponta para outro alvo; recriando');
      fs.unlinkSync(linkPath);
    } else if (existing.isFile()) {
      const real = fs.statSync(realAuthPath);
      if (sameInode(existing, real)) return 'hardlink';
      if (existing.mtimeMs >= real.mtimeMs && existing.size === real.size) return 'copy';
      logger.info({ linkPath }, 'auth.json copiado do home dedicado esta desatualizado; recopiando do auth real');
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  try {
    fs.symlinkSync(realAuthPath, linkPath);
    return 'symlink';
  } catch (symlinkError) {
    logger.warn(
      { err: symlinkError, linkPath },
      'symlink do auth.json indisponivel (Windows sem modo desenvolvedor?); tentando hardlink',
    );
  }
  try {
    fs.linkSync(realAuthPath, linkPath);
    return 'hardlink';
  } catch (linkError) {
    logger.warn({ err: linkError, linkPath }, 'hardlink do auth.json indisponivel; copiando o arquivo');
  }
  fs.copyFileSync(realAuthPath, linkPath);
  return 'copy';
}
