import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

vi.mock('../paths', () => ({ getLionClawHome: () => '/home/teste/.lionclaw' }));

import { applyMigrationV161, __V161_INTERNAL } from '../db-migrations/v161-jev-file-tools-settings';
import { JEV_FILE_TOOLS_ENABLED_SETTING_KEY, JEV_FILE_TOOLS_ROOTS_SETTING_KEY } from '../jev-settings';

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

describe('applyMigrationV161 - seed dos settings do Jev para arquivos', () => {
  it('semeia a flag desligada e a raiz default absoluta informada', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV161(db, 'C:\\Users\\x\\.lionclaw\\workspaces');

    expect(settingValue(sqlite, JEV_FILE_TOOLS_ENABLED_SETTING_KEY)).toBe('false');
    expect(JSON.parse(settingValue(sqlite, JEV_FILE_TOOLS_ROOTS_SETTING_KEY) ?? '[]')).toEqual([
      'C:\\Users\\x\\.lionclaw\\workspaces',
    ]);
  });

  it('sem parametro, a raiz default vem do home do LionClaw no momento da migration', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV161(db);
    const roots = JSON.parse(settingValue(sqlite, JEV_FILE_TOOLS_ROOTS_SETTING_KEY) ?? '[]') as string[];
    expect(roots).toHaveLength(1);
    expect(roots[0].replace(/\\/g, '/')).toBe('/home/teste/.lionclaw/workspaces');
  });

  it('nao sobrescreve valores ja existentes', () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, '["/x"]');
    applyMigrationV161(db, '/default');

    expect(settingValue(sqlite, JEV_FILE_TOOLS_ENABLED_SETTING_KEY)).toBe('true');
    expect(settingValue(sqlite, JEV_FILE_TOOLS_ROOTS_SETTING_KEY)).toBe('["/x"]');
  });

  it('e idempotente e nao cria tabela nova', () => {
    const { sqlite, db } = makeDb();
    applyMigrationV161(db, '/default');
    applyMigrationV161(db, '/default');

    const count = sqlite.prepare('SELECT count(*) AS n FROM settings').get() as { n: number };
    expect(count.n).toBe(__V161_INTERNAL.jevFileToolsSettingDefaults('/default').length);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['settings']);
  });
});
