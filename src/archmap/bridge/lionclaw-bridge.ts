import type { ArchmapAPI, ArchmapErrorPayload, ArchmapFreshness } from '@/types/archmap';

export type ArchmapBridgeResource =
  'graph' | 'meta' | 'config' | 'staleness' | 'file' | 'diff-overlay' | 'domain-graph';

export const ARCHMAP_BRIDGE_RESOURCES: readonly ArchmapBridgeResource[] = [
  'graph',
  'meta',
  'config',
  'staleness',
  'file',
  'diff-overlay',
  'domain-graph',
];

export interface BridgeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface BridgeInit {
  viewSessionId: string;
  projectName: string;
  outputLanguage: string;
}

export interface BridgeFetchOptions {
  signal?: AbortSignal;
}

export interface ArchmapBridge {
  fetch(
    resource: ArchmapBridgeResource,
    params?: { path?: string },
    options?: BridgeFetchOptions,
  ): Promise<BridgeResponse>;
  getInit(): BridgeInit | null;
  onInit(listener: (init: BridgeInit) => void): () => void;
  dispose(): void;
}

export type ArchmapBridgeApi = Pick<ArchmapAPI, 'graph' | 'meta' | 'file' | 'freshness'>;

export interface LionClawArchmapBridgeOptions {
  repositoryId: string;
  projectName: string;
  outputLanguage?: string;
  api?: ArchmapBridgeApi;
  viewSessionId?: string;
}

export type DashboardFreshnessRelation = 'behind' | 'ahead' | 'diverged';

export type DashboardFreshnessUnknownReason =
  | 'graph-missing'
  | 'meta-missing'
  | 'missing-graph-commit'
  | 'git-head-unavailable'
  | 'graph-commit-unavailable'
  | 'git-command-timeout'
  | 'freshness-request-failed';

export type DashboardGraphFreshness =
  | {
      status: 'fresh';
      graphCommitHash: string;
      headCommitHash: string;
      changedFileCount: 0;
      changedFiles: [];
      commitsBehind: 0;
      commitsAhead: 0;
      lastAnalyzedAt?: string;
    }
  | {
      status: 'dirty';
      graphCommitHash: string;
      headCommitHash: string;
      changedFileCount: number;
      changedFiles: string[];
      commitsBehind: 0;
      commitsAhead: 0;
      lastAnalyzedAt?: string;
    }
  | {
      status: 'stale';
      relation: DashboardFreshnessRelation;
      graphCommitHash: string;
      headCommitHash: string;
      changedFileCount: number;
      changedFiles: string[];
      commitsBehind: number;
      commitsAhead: number;
      lastAnalyzedAt?: string;
    }
  | {
      status: 'unknown';
      reason: DashboardFreshnessUnknownReason;
      graphCommitHash?: string;
      headCommitHash?: string;
      lastAnalyzedAt?: string;
    };

export interface DashboardFreshnessReport {
  graphs: { knowledge: DashboardGraphFreshness };
}

export const ARCHMAP_BRIDGE_CONFIG = { autoUpdate: false, outputLanguage: 'pt-BR' } as const;

const ERROR_STATUS: Record<string, number> = {
  repository_not_found: 404,
  absent: 404,
  graph_too_large: 413,
  invalid_request: 400,
  cancelled: 409,
  git_timeout: 504,
  disabled: 403,
};

const FILE_REASON_STATUS: Record<string, number> = {
  outside: 403,
  not_in_graph: 403,
  invalid: 400,
  missing: 404,
  graph_absent: 404,
  root_missing: 404,
  not_a_file: 404,
  too_large: 413,
  binary: 415,
};

export function archmapErrorStatus(payload: ArchmapErrorPayload): number {
  if (payload.code === 'file') {
    const reason = /\(([a-z_]+)\)/.exec(payload.error)?.[1];
    return (reason && FILE_REASON_STATUS[reason]) || 422;
  }
  if (payload.code && ERROR_STATUS[payload.code] !== undefined) return ERROR_STATUS[payload.code];
  return 500;
}

function isErrorPayload(value: unknown): value is ArchmapErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string' &&
    !('nodes' in (value as Record<string, unknown>)) &&
    !('content' in (value as Record<string, unknown>))
  );
}

function hashOf(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function mapFreshnessToReport(freshness: ArchmapFreshness): DashboardFreshnessReport {
  const graphCommitHash = hashOf(freshness.graphCommitHash);
  const headCommitHash = hashOf(freshness.headCommitHash);
  const lastAnalyzedAt = freshness.lastAnalyzedAt ? { lastAnalyzedAt: freshness.lastAnalyzedAt } : {};
  const unknown = (reason: DashboardFreshnessUnknownReason): DashboardFreshnessReport => ({
    graphs: {
      knowledge: {
        status: 'unknown',
        reason,
        ...(graphCommitHash ? { graphCommitHash } : {}),
        ...(headCommitHash ? { headCommitHash } : {}),
        ...lastAnalyzedAt,
      },
    },
  });
  if (freshness.status === 'unknown') return unknown('git-head-unavailable');
  if (!graphCommitHash) return unknown('missing-graph-commit');
  if (!headCommitHash) return unknown('git-head-unavailable');
  const changedFiles = Array.isArray(freshness.changedFiles)
    ? freshness.changedFiles.filter((f) => typeof f === 'string')
    : [];
  const commitsBehind = Math.max(0, Math.floor(freshness.commitsBehind ?? 0));
  const commitsAhead = Math.max(0, Math.floor(freshness.commitsAhead ?? 0));
  const changedFileCount = Math.max(Math.floor(freshness.changedFileCount ?? 0), changedFiles.length);
  const headDiffers = graphCommitHash !== headCommitHash || commitsBehind > 0 || commitsAhead > 0;
  const stale = freshness.status === 'stale' || (freshness.status === 'partial' && headDiffers);
  if (stale) {
    const relation: DashboardFreshnessRelation =
      freshness.relation ??
      (commitsAhead > 0 && commitsBehind === 0 ? 'ahead' : commitsBehind > 0 ? 'behind' : 'diverged');
    return {
      graphs: {
        knowledge: {
          status: 'stale',
          relation,
          graphCommitHash,
          headCommitHash,
          changedFileCount,
          changedFiles,
          commitsBehind,
          commitsAhead,
          ...lastAnalyzedAt,
        },
      },
    };
  }
  const dirty =
    freshness.status === 'dirty' ||
    (freshness.status === 'partial' && (changedFileCount > 0 || freshness.localChanges));
  if (dirty) {
    return {
      graphs: {
        knowledge: {
          status: 'dirty',
          graphCommitHash,
          headCommitHash,
          changedFileCount: Math.max(1, changedFileCount),
          changedFiles,
          commitsBehind: 0,
          commitsAhead: 0,
          ...lastAnalyzedAt,
        },
      },
    };
  }
  return {
    graphs: {
      knowledge: {
        status: 'fresh',
        graphCommitHash,
        headCommitHash,
        changedFileCount: 0,
        changedFiles: [],
        commitsBehind: 0,
        commitsAhead: 0,
        ...lastAnalyzedAt,
      },
    },
  };
}

function response(ok: boolean, status: number, body: unknown): BridgeResponse {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)),
  };
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function failure(err: unknown): BridgeResponse {
  const message = err instanceof Error ? err.message : String(err);
  return response(false, 0, { error: message, code: 'ipc' });
}

function fromPayload(result: unknown): BridgeResponse {
  if (isErrorPayload(result)) return response(false, archmapErrorStatus(result), result);
  return response(true, 200, result);
}

function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createLionClawArchmapBridge(options: LionClawArchmapBridgeOptions): ArchmapBridge {
  const api: ArchmapBridgeApi = options.api ?? window.lionclaw.archmap;
  const init: BridgeInit = {
    viewSessionId: options.viewSessionId ?? newSessionId(),
    projectName: options.projectName,
    outputLanguage: options.outputLanguage ?? ARCHMAP_BRIDGE_CONFIG.outputLanguage,
  };
  let disposed = false;

  const resolve = async (resource: ArchmapBridgeResource, params?: { path?: string }): Promise<BridgeResponse> => {
    switch (resource) {
      case 'graph':
        return fromPayload(await api.graph(options.repositoryId));
      case 'meta':
        return fromPayload(await api.meta(options.repositoryId));
      case 'config':
        return response(true, 200, { ...ARCHMAP_BRIDGE_CONFIG, outputLanguage: init.outputLanguage });
      case 'staleness': {
        const result = await api.freshness(options.repositoryId);
        if (isErrorPayload(result)) return response(false, archmapErrorStatus(result), result);
        return response(true, 200, mapFreshnessToReport(result as ArchmapFreshness));
      }
      case 'file': {
        const path = params?.path;
        if (typeof path !== 'string' || path.length === 0) {
          return response(false, 400, { error: 'caminho obrigatorio', code: 'invalid_request' });
        }
        return fromPayload(await api.file({ repositoryId: options.repositoryId, path }));
      }
      case 'diff-overlay':
      case 'domain-graph':
        return response(false, 404, null);
      default:
        return response(false, 400, { error: `recurso desconhecido: ${String(resource)}`, code: 'invalid_request' });
    }
  };

  return {
    fetch(resource, params, fetchOptions) {
      if (disposed) return Promise.reject(new Error('Bridge disposed'));
      const signal = fetchOptions?.signal;
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<BridgeResponse>((resolveFetch, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        resolve(resource, params)
          .catch(failure)
          .then((result) => {
            signal?.removeEventListener('abort', onAbort);
            if (settled) return;
            settled = true;
            if (disposed) reject(new Error('Bridge disposed'));
            else resolveFetch(result);
          });
      });
    },
    getInit: () => init,
    onInit(listener) {
      listener(init);
      return () => {};
    },
    dispose() {
      disposed = true;
    },
  };
}
