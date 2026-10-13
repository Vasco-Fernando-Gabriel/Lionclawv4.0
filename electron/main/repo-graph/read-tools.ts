import type { LocalRepositoryRecord, RepoGraphReader } from './types';

export const REPO_GRAPH_READ_TOOL_NAMES = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
] as const;
export type RepoGraphReadToolName = (typeof REPO_GRAPH_READ_TOOL_NAMES)[number];
const READ_TOOL_SET: ReadonlySet<string> = new Set(REPO_GRAPH_READ_TOOL_NAMES);
export function isRepoGraphReadTool(name: string): name is RepoGraphReadToolName {
  return READ_TOOL_SET.has(name);
}

function requireText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}
function optionalText(params: Record<string, unknown>, key: string): string | undefined {
  return typeof params[key] === 'string' ? (params[key] as string) : undefined;
}
function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  return typeof params[key] === 'number' ? (params[key] as number) : undefined;
}

export function repoGraphReadBlockedReason(
  toolName: string,
  repo: Pick<LocalRepositoryRecord, 'status'>,
): string | null {
  if (toolName === 'repo_graph_status') return null;
  if (repo.status === 'ready' || repo.status === 'stale') return null;
  return repo.status === 'building'
    ? 'o graph deste repositorio esta sendo indexado; tente novamente quando o build concluir.'
    : 'o graph deste repositorio ainda nao foi criado; o usuario precisa criar pela badge CodeGraph do chat.';
}

export async function executeRepoGraphRead(
  reader: RepoGraphReader,
  repo: Pick<LocalRepositoryRecord, 'id' | 'name' | 'canonicalRootPath' | 'status' | 'indexedCommit' | 'lastIndexedAt'>,
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const rootPath = repo.canonicalRootPath;
  switch (toolName) {
    case 'repo_graph_status': {
      const detect = await reader.detect(rootPath);
      return {
        repository: {
          id: repo.id,
          name: repo.name,
          rootPath,
          status: repo.status,
          indexedCommit: repo.indexedCommit,
          lastIndexedAt: repo.lastIndexedAt,
        },
        graphExists: detect.exists,
        stats: detect.stats ?? null,
        ...(detect.error ? { providerError: detect.error } : {}),
      };
    }
    case 'repo_graph_search':
      return reader.search({
        rootPath,
        term: requireText(params, 'term'),
        kind: optionalText(params, 'kind'),
        limit: optionalNumber(params, 'limit'),
      });
    case 'repo_graph_minimal_context':
      return reader.minimalContext({ rootPath, repositoryId: repo.id, task: requireText(params, 'task') });
    case 'repo_graph_impact':
      return reader.impact({ rootPath, symbol: requireText(params, 'symbol'), depth: optionalNumber(params, 'depth') });
    case 'repo_graph_node':
      return reader.node({ rootPath, name: requireText(params, 'name') });
    case 'repo_graph_callers':
      return reader.callers({
        rootPath,
        symbol: requireText(params, 'symbol'),
        limit: optionalNumber(params, 'limit'),
      });
    case 'repo_graph_callees':
      return reader.callees({
        rootPath,
        symbol: requireText(params, 'symbol'),
        limit: optionalNumber(params, 'limit'),
      });
    default:
      throw new Error(`unknown repo_graph tool: ${toolName}`);
  }
}

export function repoGraphResultCount(toolName: string, result: unknown): number {
  const r = result as Record<string, unknown>;
  switch (toolName) {
    case 'repo_graph_search':
      return Array.isArray(r['symbols']) ? r['symbols'].length : 0;
    case 'repo_graph_minimal_context': {
      const files = Array.isArray(r['files']) ? r['files'].length : 0;
      const symbols = Array.isArray(r['symbols']) ? r['symbols'].length : 0;
      return files + symbols;
    }
    case 'repo_graph_impact':
      return Array.isArray(r['affected']) ? r['affected'].length : 0;
    case 'repo_graph_node':
      return r['node'] ? 1 : 0;
    case 'repo_graph_callers':
    case 'repo_graph_callees':
      return Array.isArray(r['related']) ? r['related'].length : 0;
    default:
      return 1;
  }
}
