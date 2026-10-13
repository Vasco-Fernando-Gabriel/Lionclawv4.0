import type Database from 'better-sqlite3';
import { DEFAULT_SWARM_SETTINGS } from '../../../src/types/swarm';

export const SWARM_DELIVERY_OUTBOX_V166_SQL = `CREATE TABLE swarm_delivery_outbox (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('terminal','question')),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        slug TEXT,
        attempt_id TEXT,
        session_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        run_status TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved-by-wait','claimed','consumed-by-turn','delivered','undeliverable')),
        claim_id TEXT,
        reserved_by TEXT,
        lease_until INTEGER,
        turn_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (run_id, kind, revision)
      )`;
export const SWARM_CHAT_RECEIPTS_V166_SQL = `CREATE TABLE swarm_chat_receipts (
        run_id TEXT NOT NULL,
        delivery_kind TEXT NOT NULL CHECK(delivery_kind IN ('terminal','question')),
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('event','response')),
        session_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY (run_id, delivery_kind, revision, kind),
        FOREIGN KEY (run_id, delivery_kind, revision) REFERENCES swarm_delivery_outbox(run_id, kind, revision)
      )`;
function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}
export function swarmDeliveryQueueIsV166(db: Database.Database): boolean {
  const outbox = columns(db, 'swarm_delivery_outbox');
  return outbox.includes('kind') && outbox.includes('revision') && !outbox.includes('terminal_revision');
}
export function applyMigrationV166(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const outbox = columns(db, 'swarm_delivery_outbox');
    if (outbox.length && !swarmDeliveryQueueIsV166(db)) {
      const receipts = columns(db, 'swarm_chat_receipts');
      db.exec(
        SWARM_DELIVERY_OUTBOX_V166_SQL.replace(
          'CREATE TABLE swarm_delivery_outbox',
          'CREATE TABLE swarm_delivery_outbox_v166',
        ),
      );
      db.exec(`INSERT INTO swarm_delivery_outbox_v166
        (run_id,kind,revision,slug,attempt_id,session_id,envelope,run_status,state,claim_id,reserved_by,lease_until,turn_id,error,created_at,updated_at)
        SELECT run_id,'terminal',terminal_revision,NULL,NULL,session_id,envelope,run_status,state,claim_id,NULL,NULL,NULL,error,created_at,updated_at
        FROM swarm_delivery_outbox`);
      if (receipts.length) {
        db.exec(`CREATE TEMP TABLE swarm_chat_receipts_v166_backup AS
          SELECT run_id,'terminal' AS delivery_kind,terminal_revision AS revision,kind,session_id,message_id FROM swarm_chat_receipts`);
        db.exec('DROP TABLE swarm_chat_receipts');
      }
      db.exec('DROP TABLE swarm_delivery_outbox');
      db.exec('ALTER TABLE swarm_delivery_outbox_v166 RENAME TO swarm_delivery_outbox');
      db.exec(SWARM_CHAT_RECEIPTS_V166_SQL);
      if (receipts.length) {
        db.exec(`INSERT INTO swarm_chat_receipts (run_id,delivery_kind,revision,kind,session_id,message_id)
          SELECT run_id,delivery_kind,revision,kind,session_id,message_id FROM swarm_chat_receipts_v166_backup`);
        db.exec('DROP TABLE swarm_chat_receipts_v166_backup');
      }
    } else if (!outbox.length) {
      db.exec(SWARM_DELIVERY_OUTBOX_V166_SQL);
      if (!columns(db, 'swarm_chat_receipts').length) db.exec(SWARM_CHAT_RECEIPTS_V166_SQL);
    }
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
      'swarm_open_window_ms',
      String(DEFAULT_SWARM_SETTINGS.openWindowMs),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
