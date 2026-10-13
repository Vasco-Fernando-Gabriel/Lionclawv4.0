import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ArchmapFullReason,
  ArchmapRunKind,
  ArchmapRunStatus,
  ArchmapUpdateAction,
} from '../../../src/types/archmap';
import { getDb } from '../db';

export const ARCHMAP_RUNS_RETENTION = 20;

export interface ArchmapRepositoryState {
  repositoryId: string;
  indexedCommit: string | null;
  lastIndexedAt: string | null;
  statsJson: string | null;
}

export interface ArchmapRunRecord {
  id: string;
  repositoryId: string;
  kind: ArchmapRunKind;
  status: ArchmapRunStatus;
  runtime: string;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  action: ArchmapUpdateAction | null;
  reason: ArchmapFullReason | null;
  error: string | null;
  llmCalls: number;
  llmMs: number;
  jevAsked: number;
  jevDispensed: number;
  jevCostUsd: number;
  jevFallbackReason: string | null;
  warnings: string[];
  durationMs: number | null;
}

export interface ArchmapIndexedPatch {
  indexedCommit: string | null;
  lastIndexedAt: string | null;
  statsJson: string | null;
}

export interface CreateArchmapRunInput {
  id?: string;
  repositoryId: string;
  kind: ArchmapRunKind;
  runtime: string;
  provider: string;
  model: string;
}

export interface FinishArchmapRunPatch {
  status: Exclude<ArchmapRunStatus, 'running'>;
  action?: ArchmapUpdateAction | null;
  reason?: ArchmapFullReason | null;
  llmCalls?: number;
  llmMs?: number;
  jevAsked?: number;
  jevDispensed?: number;
  jevCostUsd?: number;
  jevFallbackReason?: string | null;
  warnings?: string[] | null;
  error?: string | null;
  durationMs?: number | null;
}

export interface ArchmapRepository {
  getState(repositoryId: string): ArchmapRepositoryState | null;
  setIndexed(repositoryId: string, patch: ArchmapIndexedPatch): void;
  clearState(repositoryId: string): void;
  createRun(input: CreateArchmapRunInput): ArchmapRunRecord;
  finishRun(id: string, patch: FinishArchmapRunPatch): void;
  getRun(id: string): ArchmapRunRecord | null;
  getLast(repositoryId: string): ArchmapRunRecord | null;
  listByRepository(repositoryId: string): ArchmapRunRecord[];
  listRunningRuns(): ArchmapRunRecord[];
}

interface StateRow {
  id: string;
  archmap_indexed_commit: string | null;
  archmap_last_indexed_at: string | null;
  archmap_stats_json: string | null;
}

interface RunRow {
  id: string;
  repository_id: string;
  kind: string;
  status: string;
  runtime: string;
  provider: string;
  model: string;
  started_at: string;
  finished_at: string | null;
  action: string | null;
  reason: string | null;
  error: string | null;
  llm_calls: number;
  llm_ms: number;
  jev_asked: number | null;
  jev_dispensed: number;
  jev_cost_usd: number;
  jev_fallback_reason: string | null;
  warnings_json: string | null;
  duration_ms: number | null;
}

function parseWarnings(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapRun(row: RunRow): ArchmapRunRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    kind: row.kind as ArchmapRunKind,
    status: row.status as ArchmapRunStatus,
    runtime: row.runtime ?? '',
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    action: (row.action as ArchmapUpdateAction | null) ?? null,
    reason: (row.reason as ArchmapFullReason | null) ?? null,
    error: row.error ?? null,
    llmCalls: row.llm_calls ?? 0,
    llmMs: row.llm_ms ?? 0,
    jevAsked: row.jev_asked ?? 0,
    jevDispensed: row.jev_dispensed ?? 0,
    jevCostUsd: row.jev_cost_usd ?? 0,
    jevFallbackReason: row.jev_fallback_reason ?? null,
    warnings: parseWarnings(row.warnings_json),
    durationMs: row.duration_ms ?? null,
  };
}

export function createArchmapRepository(db: Database.Database): ArchmapRepository {
  const repository: ArchmapRepository = {
    getState(repositoryId) {
      const row = db
        .prepare(
          `SELECT id, archmap_indexed_commit, archmap_last_indexed_at, archmap_stats_json
           FROM local_repositories WHERE id = ?`,
        )
        .get(repositoryId) as StateRow | undefined;
      if (!row) return null;
      return {
        repositoryId: row.id,
        indexedCommit: row.archmap_indexed_commit ?? null,
        lastIndexedAt: row.archmap_last_indexed_at ?? null,
        statsJson: row.archmap_stats_json ?? null,
      };
    },
    setIndexed(repositoryId, patch) {
      db.prepare(
        `UPDATE local_repositories SET
           archmap_indexed_commit = @indexedCommit,
           archmap_last_indexed_at = @lastIndexedAt,
           archmap_stats_json = @statsJson,
           updated_at = datetime('now')
         WHERE id = @id`,
      ).run({
        id: repositoryId,
        indexedCommit: patch.indexedCommit,
        lastIndexedAt: patch.lastIndexedAt,
        statsJson: patch.statsJson,
      });
    },
    clearState(repositoryId) {
      db.prepare(
        `UPDATE local_repositories SET
           archmap_indexed_commit = NULL,
           archmap_last_indexed_at = NULL,
           archmap_stats_json = NULL,
           updated_at = datetime('now')
         WHERE id = @id`,
      ).run({ id: repositoryId });
    },
    createRun(input) {
      const id = input.id ?? randomUUID();
      const insert = db.prepare(
        `INSERT INTO archmap_runs (id, repository_id, kind, status, runtime, provider, model)
         VALUES (@id, @repositoryId, @kind, 'running', @runtime, @provider, @model)`,
      );
      const prune = db.prepare(
        `DELETE FROM archmap_runs
         WHERE repository_id = @repositoryId
           AND id NOT IN (
             SELECT id FROM archmap_runs WHERE repository_id = @repositoryId
             ORDER BY started_at DESC, rowid DESC LIMIT @keep
           )`,
      );
      const create = db.transaction(() => {
        insert.run({
          id,
          repositoryId: input.repositoryId,
          kind: input.kind,
          runtime: input.runtime,
          provider: input.provider,
          model: input.model,
        });
        prune.run({ repositoryId: input.repositoryId, keep: ARCHMAP_RUNS_RETENTION });
      });
      create();
      const created = repository.getRun(id);
      if (!created) throw new Error(`Falha ao criar archmap_run ${id}: nao encontrado.`);
      return created;
    },
    finishRun(id, patch) {
      db.prepare(
        `UPDATE archmap_runs SET
           status = @status,
           finished_at = datetime('now'),
           action = @action,
           reason = @reason,
           llm_calls = @llmCalls,
           llm_ms = @llmMs,
           jev_asked = @jevAsked,
           jev_dispensed = @jevDispensed,
           jev_cost_usd = @jevCostUsd,
           jev_fallback_reason = @jevFallbackReason,
           warnings_json = @warningsJson,
           error = @error,
           duration_ms = @durationMs
         WHERE id = @id`,
      ).run({
        id,
        status: patch.status,
        action: patch.action ?? null,
        reason: patch.reason ?? null,
        llmCalls: patch.llmCalls ?? 0,
        llmMs: patch.llmMs ?? 0,
        jevAsked: patch.jevAsked ?? 0,
        jevDispensed: patch.jevDispensed ?? 0,
        jevCostUsd: patch.jevCostUsd ?? 0,
        jevFallbackReason: patch.jevFallbackReason ?? null,
        warningsJson: patch.warnings && patch.warnings.length > 0 ? JSON.stringify(patch.warnings) : null,
        error: patch.error ?? null,
        durationMs: patch.durationMs ?? null,
      });
    },
    getRun(id) {
      const row = db.prepare('SELECT * FROM archmap_runs WHERE id = ?').get(id) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    getLast(repositoryId) {
      const row = db
        .prepare(`SELECT * FROM archmap_runs WHERE repository_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
        .get(repositoryId) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    listByRepository(repositoryId) {
      const rows = db
        .prepare(`SELECT * FROM archmap_runs WHERE repository_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`)
        .all(repositoryId, ARCHMAP_RUNS_RETENTION) as RunRow[];
      return rows.map(mapRun);
    },
    listRunningRuns() {
      const rows = db
        .prepare(`SELECT * FROM archmap_runs WHERE status = 'running' ORDER BY started_at ASC`)
        .all() as RunRow[];
      return rows.map(mapRun);
    },
  };
  return repository;
}

export function getArchmapRepository(): ArchmapRepository {
  return createArchmapRepository(getDb());
}
