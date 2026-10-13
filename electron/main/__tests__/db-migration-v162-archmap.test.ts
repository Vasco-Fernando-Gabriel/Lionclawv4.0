import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { applyMigrationV162, __V162_INTERNAL } from '../db-migrations/v162-archmap';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import {
  ARCHMAP_BATCH_PARALLELISM_SETTING_KEY,
  ARCHMAP_ENABLED_SETTING_KEY,
  ARCHMAP_MAX_PARALLEL_REPOS_SETTING_KEY,
} from '../archmap/settings';

interface Harness {
  sqlite: DatabaseSync;
  db: Database.Database;
}

function makeDb(): Harness {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE local_repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      canonical_root_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'absent',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { sqlite, db: sqlite as unknown as Database.Database };
}

function columns(sqlite: DatabaseSync, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function settingValue(sqlite: DatabaseSync, key: string): string | undefined {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

describe('applyMigrationV162 - Mapa de arquitetura', () => {
  it('LATEST_SCHEMA_VERSION e ao menos 162', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(162);
  });

  it('cria archmap_runs com indice e as tres colunas archmap_* em local_repositories', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV162(db);
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    )
      .map((t) => t.name)
      .sort();
    expect(tables).toEqual(['archmap_runs', 'local_repositories', 'settings']);
    const indexes = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_archmap%'").all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toEqual(__V162_INTERNAL.INDEXES);
    const repoColumns = columns(sqlite, 'local_repositories');
    for (const column of __V162_INTERNAL.REPOSITORY_COLUMNS) expect(repoColumns).toContain(column);
    const runColumns = columns(sqlite, 'archmap_runs');
    for (const column of [
      'id',
      'repository_id',
      'kind',
      'status',
      'runtime',
      'provider',
      'model',
      'started_at',
      'finished_at',
      'action',
      'reason',
      'error',
      'llm_calls',
      'llm_ms',
      'jev_dispensed',
      'jev_cost_usd',
    ]) {
      expect(runColumns).toContain(column);
    }
  });

  it('semeia archmap_enabled=true, archmap_max_parallel_repos=2 e archmap_batch_parallelism=5', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV162(db);
    expect(settingValue(sqlite, ARCHMAP_ENABLED_SETTING_KEY)).toBe('true');
    expect(settingValue(sqlite, ARCHMAP_MAX_PARALLEL_REPOS_SETTING_KEY)).toBe('2');
    expect(settingValue(sqlite, ARCHMAP_BATCH_PARALLELISM_SETTING_KEY)).toBe('5');
  });

  it('nao sobrescreve settings existentes e e idempotente', () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ARCHMAP_ENABLED_SETTING_KEY, 'false');
    applyMigrationV162(db);
    applyMigrationV162(db);
    expect(settingValue(sqlite, ARCHMAP_ENABLED_SETTING_KEY)).toBe('false');
    expect(columns(sqlite, 'local_repositories').filter((c) => c === 'archmap_stats_json')).toHaveLength(1);
    const count = sqlite.prepare('SELECT count(*) AS n FROM settings').get() as { n: number };
    expect(count.n).toBe(__V162_INTERNAL.SETTING_DEFAULTS.length);
  });

  it('aceita apenas kind e status validos em archmap_runs e apaga runs com o repositorio', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV162(db);
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite
      .prepare("INSERT INTO local_repositories (id, name, root_path, canonical_root_path) VALUES ('r1','r1','/a','/a')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO archmap_runs (id, repository_id, kind, status, runtime, provider, model) VALUES ('x','r1','build','running','cloud','anthropic','m')",
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO archmap_runs (id, repository_id, kind, status, runtime, provider, model) VALUES ('y','r1','other','running','cloud','anthropic','m')",
        )
        .run(),
    ).toThrow();
    sqlite.prepare("DELETE FROM local_repositories WHERE id = 'r1'").run();
    const left = sqlite.prepare('SELECT count(*) AS n FROM archmap_runs').get() as { n: number };
    expect(left.n).toBe(0);
  });
});
