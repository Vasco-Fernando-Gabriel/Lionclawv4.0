import type Database from 'better-sqlite3';
import { ARCHMAP_SETTING_DEFAULTS } from '../archmap/settings';

const ARCHMAP_REPOSITORY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['archmap_indexed_commit', 'TEXT'],
  ['archmap_last_indexed_at', 'TEXT'],
  ['archmap_stats_json', 'TEXT'],
];

function existingColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export function applyMigrationV162(db: Database.Database): void {
  const columns = existingColumns(db, 'local_repositories');
  for (const [name, type] of ARCHMAP_REPOSITORY_COLUMNS) {
    if (columns.has(name)) continue;
    db.exec(`ALTER TABLE local_repositories ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS archmap_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('build','update')),
      status TEXT NOT NULL CHECK (status IN ('running','done','error','cancelled')),
      runtime TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      action TEXT,
      reason TEXT,
      error TEXT,
      llm_calls INTEGER NOT NULL DEFAULT 0,
      llm_ms INTEGER NOT NULL DEFAULT 0,
      jev_dispensed INTEGER NOT NULL DEFAULT 0,
      jev_cost_usd REAL NOT NULL DEFAULT 0,
      warnings_json TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_archmap_runs_repo_started ON archmap_runs (repository_id, started_at DESC);
  `);
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of ARCHMAP_SETTING_DEFAULTS) {
    stmt.run(key, value);
  }
}

export const __V162_INTERNAL = {
  TABLES: ['archmap_runs'],
  INDEXES: ['idx_archmap_runs_repo_started'],
  REPOSITORY_COLUMNS: ARCHMAP_REPOSITORY_COLUMNS.map(([name]) => name),
  SETTING_DEFAULTS: ARCHMAP_SETTING_DEFAULTS,
};
