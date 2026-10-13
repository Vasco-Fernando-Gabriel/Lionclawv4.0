import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

import { applyMigrationV160, __V160_INTERNAL } from '../db-migrations/v160-jev-shadow-settings';
import { JEV_DEFAULT_MODEL, JEV_MODEL_SETTING_KEY, JEV_SHADOW_ENABLED_SETTING_KEY } from '../jev-settings';

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
  `);
  return { sqlite, db: sqlite as unknown as Database.Database };
}

function settingValue(sqlite: DatabaseSync, key: string): string | undefined {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

describe('applyMigrationV160 - seed dos settings do modo sombra do Jev', () => {
  it('semeia a flag desligada e o modelo explicito', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV160(db);

    expect(settingValue(sqlite, JEV_SHADOW_ENABLED_SETTING_KEY)).toBe('false');
    expect(settingValue(sqlite, JEV_MODEL_SETTING_KEY)).toBe(JEV_DEFAULT_MODEL);
    expect(JEV_DEFAULT_MODEL).not.toBe('jev-latest');
  });

  it('nao sobrescreve valores ja existentes', () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(JEV_SHADOW_ENABLED_SETTING_KEY, 'true');
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(JEV_MODEL_SETTING_KEY, 'jev-9.9.9');
    applyMigrationV160(db);

    expect(settingValue(sqlite, JEV_SHADOW_ENABLED_SETTING_KEY)).toBe('true');
    expect(settingValue(sqlite, JEV_MODEL_SETTING_KEY)).toBe('jev-9.9.9');
  });

  it('e idempotente e nao cria tabela nova', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV160(db);
    applyMigrationV160(db);

    const count = sqlite.prepare('SELECT count(*) AS n FROM settings').get() as { n: number };
    expect(count.n).toBe(__V160_INTERNAL.JEV_SHADOW_SETTING_DEFAULTS.length);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['settings']);
  });
});
