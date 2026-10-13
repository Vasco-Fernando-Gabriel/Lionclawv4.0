import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchmapFreshness, ArchmapFreshnessLabel, ArchmapFreshnessStatus } from '../../../src/types/archmap';
import { GitTimeoutError, gitCommitExists, gitDiffNames, gitHead, gitPorcelainPaths, gitRevListCounts } from './git';
import type { GitRunner } from './git';
import { normalizeRelativePath } from './pipeline/node-path';

export const ARCHMAP_FRESHNESS_MEMO_MS = 5 * 60 * 1000;
export const ARCHMAP_STALENESS_CAP = 200;

export interface ArchmapFreshnessInput {
  repositoryId: string;
  repoRoot: string;
  generation: string | null;
  graphPresent: boolean;
  indexedCommit: string | null;
  lastAnalyzedAt: string | null;
  pendingFiles: readonly string[];
  mapPaths: ReadonlySet<string>;
  changedDuringRun: readonly string[];
}

export interface ArchmapFreshnessService {
  compute(input: ArchmapFreshnessInput): Promise<ArchmapFreshness>;
  invalidate(repositoryId: string): void;
  forget(repositoryId: string): void;
}

const LABELS: Record<ArchmapFreshnessStatus, ArchmapFreshnessLabel> = {
  fresh: 'pronto',
  dirty: 'desatualizado',
  stale: 'desatualizado',
  partial: 'parcial',
  unknown: 'desconhecido',
};

function capList(paths: Iterable<string>): { list: string[]; count: number } {
  const unique = Array.from(new Set(paths)).sort();
  return { list: unique.slice(0, ARCHMAP_STALENESS_CAP), count: unique.length };
}

function base(input: ArchmapFreshnessInput, status: ArchmapFreshnessStatus, reason: string): ArchmapFreshness {
  const result: ArchmapFreshness = {
    status,
    label: LABELS[status],
    reason,
    changedFileCount: 0,
    changedFiles: [],
    commitsBehind: 0,
    commitsAhead: 0,
    localChanges: false,
    pendingFiles: input.pendingFiles.length,
  };
  if (input.lastAnalyzedAt) result.lastAnalyzedAt = input.lastAnalyzedAt;
  return result;
}

function withPending(input: ArchmapFreshnessInput, result: ArchmapFreshness): ArchmapFreshness {
  const pending = input.pendingFiles.length;
  if (pending === 0) return result;
  const suffix = result.status === 'fresh' || result.status === 'unknown' ? '' : `; ${result.reason}`;
  return {
    ...result,
    status: 'partial',
    label: LABELS.partial,
    reason: `${pending} arquivo(s) pendente(s) de analise${suffix}`,
  };
}

async function localChanges(
  input: ArchmapFreshnessInput,
  porcelain: readonly string[],
): Promise<{ paths: string[]; reason: string } | null> {
  const candidates = new Set<string>();
  for (const path of porcelain) {
    const normalized = normalizeRelativePath(path);
    if (input.mapPaths.has(normalized)) candidates.add(normalized);
  }
  for (const path of input.changedDuringRun) candidates.add(normalizeRelativePath(path));
  if (candidates.size === 0) return null;
  if (candidates.size > ARCHMAP_STALENESS_CAP) {
    return {
      paths: [...candidates].sort(),
      reason: `mudancas locais em mais de ${ARCHMAP_STALENESS_CAP} arquivo(s) do mapa`,
    };
  }
  const indexedAtMs = input.lastAnalyzedAt ? Date.parse(input.lastAnalyzedAt) : Number.NaN;
  const changed: string[] = [];
  for (const path of candidates) {
    if (!Number.isFinite(indexedAtMs)) {
      changed.push(path);
      continue;
    }
    try {
      const st = await stat(join(input.repoRoot, path));
      if (st.mtimeMs > indexedAtMs) changed.push(path);
    } catch {
      if (input.mapPaths.has(path)) changed.push(path);
    }
  }
  if (changed.length === 0) return null;
  return { paths: changed.sort(), reason: `mudancas locais em ${changed.length} arquivo(s) do mapa` };
}

export async function computeArchmapFreshness(input: ArchmapFreshnessInput, git: GitRunner): Promise<ArchmapFreshness> {
  if (!input.graphPresent) return base(input, 'unknown', 'mapa ausente');
  const head = await gitHead(input.repoRoot, git);
  if (!head) return withPending(input, base(input, 'unknown', 'git indisponivel neste repositorio'));
  const indexed = input.indexedCommit?.trim() ?? '';
  if (indexed.length === 0) return withPending(input, base(input, 'unknown', 'commit do mapa desconhecido'));

  const porcelain = await gitPorcelainPaths(input.repoRoot, git);
  const start: ArchmapFreshness = { ...base(input, 'fresh', 'mapa no mesmo commit do HEAD, sem mudancas locais') };
  start.graphCommitHash = indexed;
  start.headCommitHash = head;

  if (!(await gitCommitExists(input.repoRoot, indexed, git))) {
    const { list, count } = capList(porcelain);
    return withPending(input, {
      ...start,
      status: 'stale',
      label: LABELS.stale,
      reason: 'o commit indexado nao existe mais no repositorio (rebase ou force-push)',
      relation: 'diverged',
      changedFiles: list,
      changedFileCount: count,
    });
  }

  if (head !== indexed) {
    const counts = await gitRevListCounts(input.repoRoot, indexed, head, git);
    const ahead = counts?.ahead ?? 0;
    const behind = counts?.behind ?? 0;
    const relation: ArchmapFreshness['relation'] =
      ahead > 0 && behind > 0 ? 'diverged' : ahead > 0 ? 'ahead' : 'behind';
    const diff = await gitDiffNames(input.repoRoot, indexed, head, git);
    const { list, count } = capList([...diff, ...porcelain]);
    const local = await localChanges(input, porcelain);
    const parts = [`HEAD diferente do commit do mapa (${count} arquivo(s) alterado(s)`];
    if (behind > 0 && ahead > 0) parts.push(`, ${behind} commit(s) a frente e ${ahead} atras do mapa)`);
    else if (behind > 0) parts.push(`, ${behind} commit(s) desde o mapa)`);
    else parts.push(')');
    if (local) parts.push(`; ${local.reason}`);
    return withPending(input, {
      ...start,
      status: 'stale',
      label: LABELS.stale,
      reason: parts.join(''),
      relation,
      commitsAhead: ahead,
      commitsBehind: behind,
      changedFiles: list,
      changedFileCount: count,
      localChanges: local !== null,
    });
  }

  const local = await localChanges(input, porcelain);
  if (local) {
    const { list, count } = capList(local.paths);
    return withPending(input, {
      ...start,
      status: 'dirty',
      label: LABELS.dirty,
      reason: local.reason,
      changedFiles: list,
      changedFileCount: count,
      localChanges: true,
    });
  }
  if (porcelain.length > ARCHMAP_STALENESS_CAP) {
    return withPending(input, {
      ...start,
      status: 'unknown',
      label: LABELS.unknown,
      reason: `mais de ${ARCHMAP_STALENESS_CAP} mudancas locais fora do mapa; estado nao verificado`,
    });
  }
  return withPending(input, start);
}

function memoKey(input: ArchmapFreshnessInput): string {
  return [input.repositoryId, input.generation ?? '', input.indexedCommit ?? '', input.lastAnalyzedAt ?? ''].join('|');
}

export function createArchmapFreshnessService(deps: {
  git: GitRunner;
  now?: () => number;
  memoMs?: number;
}): ArchmapFreshnessService {
  const now = deps.now ?? Date.now;
  const memoMs = deps.memoMs ?? ARCHMAP_FRESHNESS_MEMO_MS;
  const memo = new Map<string, { key: string; at: number; value: ArchmapFreshness }>();
  const epochs = new Map<string, number>();

  return {
    async compute(input) {
      const key = memoKey(input);
      const cached = memo.get(input.repositoryId);
      if (cached && cached.key === key && now() - cached.at < memoMs) return cached.value;
      const epochAtStart = epochs.get(input.repositoryId) ?? 0;
      let value: ArchmapFreshness;
      try {
        value = await computeArchmapFreshness(input, deps.git);
      } catch (error) {
        if (error instanceof GitTimeoutError) throw error;
        value = withPending(
          input,
          base(input, 'unknown', `git falhou: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      if ((epochs.get(input.repositoryId) ?? 0) === epochAtStart) {
        memo.set(input.repositoryId, { key, at: now(), value });
      }
      return value;
    },
    invalidate(repositoryId) {
      memo.delete(repositoryId);
      epochs.set(repositoryId, (epochs.get(repositoryId) ?? 0) + 1);
    },
    forget(repositoryId) {
      memo.delete(repositoryId);
      epochs.delete(repositoryId);
    },
  };
}
