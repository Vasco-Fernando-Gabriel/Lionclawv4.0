import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger';
import { REPO_GRAPH_MCP_SERVER_ID, REPO_GRAPH_READER_TOOLS } from '../repo-graph/reader-tools';
import type { McpServerEntry } from '../agent-config-resolver';
import { mintHelperToken, revokeHelperToken, LIONCLAW_HELPER_TOKEN_ENV } from '../helper-identity';
import { resolveMcpServerRuntime } from '../mcp-path-resolver';
import { CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE, codexMcpCommand } from './codex-mcp-command';
import { executeRepoGraphRead, repoGraphReadBlockedReason, isRepoGraphReadTool } from '../repo-graph/read-tools';
import type { LocalRepositoryRecord } from '../repo-graph/types';
import type { OllamaToolSchema } from '../ollama-client';
import type { SwarmRepoGraphState } from '../../../src/types/swarm';
import { isWithin } from './validation';
import { isRepoGraphMark } from '../../../src/lib/swarm-repo-graph-mark';

const logger = createLogger('swarm-repo-graph');

export interface SwarmRepoGraphBinding {
  repositoryId: string;
  rootPath: string;
  status: 'ready' | 'stale';
}
export const SWARM_ALLOWED_MCP_SERVER_IDS: ReadonlySet<string> = new Set([REPO_GRAPH_MCP_SERVER_ID]);
export const SWARM_REPO_GRAPH_OWNER_PREFIX = 'swarm-repo-graph-';
export const SWARM_REPO_GRAPH_MCP_ENTRY = 'dist/repo-graph/src/index.js';
export const SWARM_REPO_GRAPH_TOOL_PREFIX = `mcp__${REPO_GRAPH_MCP_SERVER_ID}__`;
const READER_TOOL_SET: ReadonlySet<string> = new Set(REPO_GRAPH_READER_TOOLS);

export function isSwarmRepoGraphReaderTool(name: string): boolean {
  return READER_TOOL_SET.has(name);
}
export function swarmRepoGraphToolName(fullName: string): string | null {
  if (!isSwarmRepoGraphReaderTool(fullName)) return null;
  const short = fullName.slice(SWARM_REPO_GRAPH_TOOL_PREFIX.length);
  return isRepoGraphReadTool(short) ? short : null;
}

export function splitSwarmMcpServers(mcpServers: readonly string[]): { allowed: string[]; ignored: string[] } {
  const allowed: string[] = [];
  const ignored: string[] = [];
  for (const id of new Set(mcpServers))
    (SWARM_ALLOWED_MCP_SERVER_IDS.has(id) || isRepoGraphMark(id) ? allowed : ignored).push(id);
  return { allowed, ignored };
}
export function swarmRepoGraphRequested(mcpServers: readonly string[]): boolean {
  return mcpServers.includes(REPO_GRAPH_MCP_SERVER_ID);
}
export function swarmRepoGraphState(requested: boolean, binding: SwarmRepoGraphBinding | null): SwarmRepoGraphState {
  if (!requested) return 'off';
  return binding ? binding.status : 'no-repository';
}

export function pickSwarmRepository(
  cwd: string,
  repositories: readonly Pick<LocalRepositoryRecord, 'id' | 'canonicalRootPath' | 'status'>[],
): SwarmRepoGraphBinding | null {
  let best: SwarmRepoGraphBinding | null = null;
  for (const repo of repositories) {
    if (repo.status !== 'ready' && repo.status !== 'stale') continue;
    if (!isWithin(repo.canonicalRootPath, cwd)) continue;
    if (!best || repo.canonicalRootPath.length > best.rootPath.length)
      best = { repositoryId: repo.id, rootPath: repo.canonicalRootPath, status: repo.status };
  }
  return best;
}

export async function findSwarmRepoGraphBinding(cwd: string): Promise<SwarmRepoGraphBinding | null> {
  try {
    const real = fs.realpathSync(cwd);
    const { listLocalRepositories } = await import('../db');
    return pickSwarmRepository(path.resolve(real), listLocalRepositories());
  } catch (error) {
    logger.warn({ err: error, cwd }, 'repositorio registrado nao resolvido para o cwd do swarm; segue sem repo-graph');
    return null;
  }
}

const scopes = new Map<string, SwarmRepoGraphBinding>();
export function registerSwarmRepoGraphScope(owner: string, binding: SwarmRepoGraphBinding): void {
  scopes.set(owner, binding);
}
export function unregisterSwarmRepoGraphScope(owner: string): void {
  scopes.delete(owner);
}
export function resolveSwarmRepoGraphScope(owner: string | undefined | null): SwarmRepoGraphBinding | null {
  if (!owner) return null;
  return scopes.get(owner) ?? null;
}
export function isSwarmRepoGraphOnlyOwner(owner: string | undefined | null): boolean {
  return typeof owner === 'string' && owner.startsWith(SWARM_REPO_GRAPH_OWNER_PREFIX);
}
export function __resetSwarmRepoGraphScopesForTests(): void {
  scopes.clear();
}

export interface SwarmRepoGraphMount {
  entry: McpServerEntry;
  owner: string;
  dispose: () => void;
}
export async function mountSwarmRepoGraphMcp(binding: SwarmRepoGraphBinding): Promise<SwarmRepoGraphMount | null> {
  let base: McpServerEntry[string] | undefined;
  try {
    const { buildRepoGraphMcpSpec } = await import('../agent-config-resolver');
    base = buildRepoGraphMcpSpec()?.[REPO_GRAPH_MCP_SERVER_ID];
  } catch (error) {
    logger.warn({ err: error, repositoryId: binding.repositoryId }, 'spec do MCP repo-graph indisponivel para o swarm');
    base = undefined;
  }
  if (!base) {
    logger.warn({ repositoryId: binding.repositoryId }, 'MCP repo-graph nao registrado; swarm agent segue sem ele');
    return null;
  }
  const owner = `${SWARM_REPO_GRAPH_OWNER_PREFIX}${randomBytes(16).toString('hex')}`;
  const token = mintHelperToken(owner);
  registerSwarmRepoGraphScope(owner, binding);
  let disposed = false;
  return {
    owner,
    entry: {
      [REPO_GRAPH_MCP_SERVER_ID]: {
        ...base,
        env: { ...(base.env ?? {}), [LIONCLAW_HELPER_TOKEN_ENV]: token },
      },
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unregisterSwarmRepoGraphScope(owner);
      revokeHelperToken(token);
    },
  };
}

export function swarmRepoGraphCodexConfig(toolTimeoutSec: number): Record<string, unknown> | null {
  const runtime = resolveMcpServerRuntime(REPO_GRAPH_MCP_SERVER_ID, SWARM_REPO_GRAPH_MCP_ENTRY);
  if (!runtime.command || !runtime.entryPath) {
    logger.warn('MCP repo-graph nao instalado (build:mcps); swarm agent Codex segue sem ele');
    return null;
  }
  return {
    command: codexMcpCommand(runtime.command),
    args: [runtime.entryPath],
    env_vars: [LIONCLAW_HELPER_TOKEN_ENV],
    enabled: true,
    default_tools_approval_mode: CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE,
    tool_timeout_sec: toolTimeoutSec,
  };
}

export type SwarmRepoGraphInvoke = (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
export function createSwarmRepoGraphInvoke(binding: SwarmRepoGraphBinding): SwarmRepoGraphInvoke {
  return async (toolName, params) => {
    const short = swarmRepoGraphToolName(toolName) ?? (isRepoGraphReadTool(toolName) ? toolName : null);
    if (!short) throw new Error(`Tool do repo-graph nao permitida ao swarm: ${toolName}`);
    const db = await import('../db');
    const repo = db.getLocalRepository(binding.repositoryId);
    if (!repo) throw new Error('Repositorio do swarm agent nao esta mais registrado.');
    const blocked = repoGraphReadBlockedReason(short, repo);
    if (blocked) throw new Error(blocked);
    const { getRepoGraphEngine } = await import('../ipc/repo-graph');
    return executeRepoGraphRead(getRepoGraphEngine().asReader(), repo, short, params);
  };
}

const STRING = { type: 'string' } as const;
const NUMBER = { type: 'number' } as const;
const TOOL_SPECS: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  repo_graph_status: {
    description: 'Estado do code graph do repositorio da run (status, commit indexado, stats).',
    properties: {},
    required: [],
  },
  repo_graph_search: {
    description:
      'Busca simbolos (funcoes, classes, tipos, rotas, componentes) e arquivos no code graph. Use ANTES de Grep/Read em massa.',
    properties: { term: STRING, kind: STRING, limit: NUMBER },
    required: ['term'],
  },
  repo_graph_minimal_context: {
    description: 'Contexto compacto (arquivos + simbolos relevantes) para uma tarefa no repositorio da run.',
    properties: { task: STRING },
    required: ['task'],
  },
  repo_graph_impact: {
    description: 'Raio de impacto de um simbolo: o que e afetado (direto e transitivo) quando ele muda.',
    properties: { symbol: STRING, depth: NUMBER },
    required: ['symbol'],
  },
  repo_graph_node: {
    description: 'Detalhes de um simbolo pelo nome EXATO (tipo, arquivo, linhas, assinatura).',
    properties: { name: STRING },
    required: ['name'],
  },
  repo_graph_callers: {
    description: 'Quem chama um simbolo (onde ele e usado).',
    properties: { symbol: STRING, limit: NUMBER },
    required: ['symbol'],
  },
  repo_graph_callees: {
    description: 'O que um simbolo chama (dependencias de saida).',
    properties: { symbol: STRING, limit: NUMBER },
    required: ['symbol'],
  },
};
export function swarmRepoGraphToolSchemas(allowedTools: readonly string[]): OllamaToolSchema[] {
  const schemas: OllamaToolSchema[] = [];
  for (const name of allowedTools) {
    const short = swarmRepoGraphToolName(name);
    const spec = short ? TOOL_SPECS[short] : undefined;
    if (!spec) continue;
    schemas.push({
      type: 'function',
      function: {
        name,
        description: spec.description,
        parameters: { type: 'object', properties: spec.properties, required: spec.required },
      },
    });
  }
  return schemas;
}
