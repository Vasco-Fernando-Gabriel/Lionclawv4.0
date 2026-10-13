import type Database from 'better-sqlite3';
import { ARCHMAP_JEV_TRIAGE_SETTING_DEFAULTS } from '../archmap/settings';

const ARCHMAP_RUN_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['jev_asked', 'INTEGER NOT NULL DEFAULT 0'],
  ['jev_fallback_reason', 'TEXT'],
];

function existingColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export function applyMigrationV163(db: Database.Database): void {
  const columns = existingColumns(db, 'archmap_runs');
  for (const [name, type] of ARCHMAP_RUN_COLUMNS) {
    if (columns.has(name)) continue;
    db.exec(`ALTER TABLE archmap_runs ADD COLUMN ${name} ${type}`);
  }
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of ARCHMAP_JEV_TRIAGE_SETTING_DEFAULTS) {
    stmt.run(key, value);
  }
}

export const __V163_INTERNAL = {
  RUN_COLUMNS: ARCHMAP_RUN_COLUMNS.map(([name]) => name),
  SETTING_DEFAULTS: ARCHMAP_JEV_TRIAGE_SETTING_DEFAULTS,
};
