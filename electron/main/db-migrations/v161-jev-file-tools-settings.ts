import type Database from 'better-sqlite3';
import { getLionClawHome } from '../paths';
import { defaultJevFileToolsRoot, jevFileToolsSettingDefaults } from '../jev-settings';

export function applyMigrationV161(
  db: Database.Database,
  defaultRoot: string = defaultJevFileToolsRoot(getLionClawHome()),
): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of jevFileToolsSettingDefaults(defaultRoot)) {
    stmt.run(key, value);
  }
}

export const __V161_INTERNAL = {
  jevFileToolsSettingDefaults,
};
