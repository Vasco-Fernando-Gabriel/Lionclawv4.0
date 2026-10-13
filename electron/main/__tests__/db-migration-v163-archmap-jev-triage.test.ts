import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { applyMigrationV162 } from '../db-migrations/v162-archmap';
import { applyMigrationV163, __V163_INTERNAL } from '../db-migrations/v163-archmap-jev-triage';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import {
  ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY,
  ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY,
  ARCHMAP_SETTING_DEFAULTS,
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
  const db = sqlite as unknown as Database.Database;
  applyMigrationV162(db);
  return { sqlite, db };
}

function columns(sqlite: DatabaseSync, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function settingValue(sqlite: DatabaseSync, key: string): string | undefined {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

describe('applyMigrationV163 - triagem Jev do Mapa de arquitetura', () => {
  it('LATEST_SCHEMA_VERSION e ao menos 163', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(163);
  });

  it('acrescenta jev_asked e jev_fallback_reason em archmap_runs sem tocar nas colunas da V162', () => {
    const { sqlite, db } = makeDb();
    const before = columns(sqlite, 'archmap_runs');
    applyMigrationV163(db);
    const after = columns(sqlite, 'archmap_runs');
    for (const column of before) expect(after).toContain(column);
    for (const column of __V163_INTERNAL.RUN_COLUMNS) expect(after).toContain(column);
    expect(after.length).toBe(before.length + __V163_INTERNAL.RUN_COLUMNS.length);
  });

  it('semeia archmap_jev_triage_enabled=false e archmap_jev_keep_threshold=0.8', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV163(db);
    expect(settingValue(sqlite, ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY)).toBe('false');
    expect(settingValue(sqlite, ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY)).toBe('0.8');
  });

  it('nao sobrescreve settings existentes e e idempotente', () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY, 'true');
    applyMigrationV163(db);
    applyMigrationV163(db);
    expect(settingValue(sqlite, ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY)).toBe('true');
    expect(columns(sqlite, 'archmap_runs').filter((c) => c === 'jev_asked')).toHaveLength(1);
    const count = sqlite.prepare('SELECT count(*) AS n FROM settings').get() as { n: number };
    expect(count.n).toBe(ARCHMAP_SETTING_DEFAULTS.length + __V163_INTERNAL.SETTING_DEFAULTS.length);
  });

  it('runs antigos leem jev_asked = 0 e jev_fallback_reason nulo', () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare("INSERT INTO local_repositories (id, name, root_path, canonical_root_path) VALUES ('r1','r1','/a','/a')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO archmap_runs (id, repository_id, kind, status, runtime, provider, model) VALUES ('x','r1','update','done','cloud','anthropic','m')",
      )
      .run();
    applyMigrationV163(db);
    const row = sqlite.prepare('SELECT jev_asked, jev_fallback_reason FROM archmap_runs WHERE id = ?').get('x') as {
      jev_asked: number;
      jev_fallback_reason: string | null;
    };
    expect(row.jev_asked).toBe(0);
    expect(row.jev_fallback_reason).toBeNull();
  });
});
