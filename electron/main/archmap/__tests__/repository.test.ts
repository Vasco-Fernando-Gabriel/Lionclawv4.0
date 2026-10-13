import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

vi.mock('../../db', () => ({ getDb: () => null }));

import { applyMigrationV162 } from '../../db-migrations/v162-archmap';
import { applyMigrationV163 } from '../../db-migrations/v163-archmap-jev-triage';
import { ARCHMAP_RUNS_RETENTION, createArchmapRepository } from '../repository';

function makeDb(): Database.Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE local_repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      canonical_root_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'absent',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO local_repositories (id, name, root_path, canonical_root_path) VALUES ('r1', 'r1', '/a', '/a');
  `);
  const db = sqlite as unknown as Database.Database;
  applyMigrationV162(db);
  applyMigrationV163(db);
  const transaction = <T>(fn: () => T) => {
    return () => {
      sqlite.exec('BEGIN');
      try {
        const out = fn();
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    };
  };
  (db as unknown as { transaction: typeof transaction }).transaction = transaction;
  return db;
}

describe('repositorio de acesso do mapa (archmap_runs + colunas archmap_*)', () => {
  it('estado inicial sem commit; setIndexed e clearState regravam as colunas', () => {
    const repo = createArchmapRepository(makeDb());
    expect(repo.getState('r1')).toEqual({
      repositoryId: 'r1',
      indexedCommit: null,
      lastIndexedAt: null,
      statsJson: null,
    });
    expect(repo.getState('nao-existe')).toBeNull();
    repo.setIndexed('r1', {
      indexedCommit: 'abc',
      lastIndexedAt: '2026-10-08T00:00:00Z',
      statsJson: '{"nodeCount":1}',
    });
    expect(repo.getState('r1')?.indexedCommit).toBe('abc');
    repo.clearState('r1');
    expect(repo.getState('r1')?.indexedCommit).toBeNull();
  });

  it('cria, finaliza e lista rodadas; listRunningRuns so devolve as em andamento', () => {
    const repo = createArchmapRepository(makeDb());
    const run = repo.createRun({
      repositoryId: 'r1',
      kind: 'build',
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'm',
    });
    expect(run.status).toBe('running');
    expect(run.runtime).toBe('cloud');
    expect(repo.listRunningRuns().map((r) => r.id)).toEqual([run.id]);
    repo.finishRun(run.id, {
      status: 'done',
      llmCalls: 3,
      llmMs: 1200,
      warnings: ['a', 'b'],
      durationMs: 5000,
      jevAsked: 5,
      jevDispensed: 2,
      jevCostUsd: 0.01,
      jevFallbackReason: null,
    });
    const finished = repo.getRun(run.id);
    expect(finished?.status).toBe('done');
    expect(finished?.finishedAt).not.toBeNull();
    expect(finished?.warnings).toEqual(['a', 'b']);
    expect(finished?.jevAsked).toBe(5);
    expect(finished?.jevDispensed).toBe(2);
    expect(finished?.jevCostUsd).toBe(0.01);
    expect(finished?.jevFallbackReason).toBeNull();
    const fallback = repo.createRun({
      repositoryId: 'r1',
      kind: 'update',
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'm',
    });
    repo.finishRun(fallback.id, { status: 'done', jevFallbackReason: 'timeout: request ao Jev estourou 20000 ms' });
    const withFallback = repo.getRun(fallback.id);
    expect(withFallback?.jevAsked).toBe(0);
    expect(withFallback?.jevFallbackReason).toBe('timeout: request ao Jev estourou 20000 ms');
    expect(repo.listByRepository('r1')).toHaveLength(2);
    expect(repo.listRunningRuns()).toEqual([]);
    expect(repo.getLast('r1')?.id).toBe(fallback.id);
  });

  it('mantem no maximo ARCHMAP_RUNS_RETENTION rodadas por repositorio', () => {
    const repo = createArchmapRepository(makeDb());
    for (let i = 0; i < ARCHMAP_RUNS_RETENTION + 5; i += 1) {
      const run = repo.createRun({
        id: `run-${String(i).padStart(3, '0')}`,
        repositoryId: 'r1',
        kind: 'update',
        runtime: 'codex',
        provider: 'codex',
        model: 'gpt-6-sol',
      });
      repo.finishRun(run.id, { status: 'cancelled' });
    }
    expect(repo.listByRepository('r1').length).toBeLessThanOrEqual(ARCHMAP_RUNS_RETENTION);
    expect(repo.getRun('run-000')).toBeNull();
  });
});
