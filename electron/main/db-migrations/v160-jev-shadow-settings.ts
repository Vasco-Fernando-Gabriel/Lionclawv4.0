import type Database from 'better-sqlite3';
import { JEV_SHADOW_SETTING_DEFAULTS } from '../jev-settings';

export function applyMigrationV160(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of JEV_SHADOW_SETTING_DEFAULTS) {
    stmt.run(key, value);
  }
}

export const __V160_INTERNAL = {
  JEV_SHADOW_SETTING_DEFAULTS,
};
