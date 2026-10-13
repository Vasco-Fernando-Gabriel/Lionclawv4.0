import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { applyMigrationV153 } from '../db-migrations/v153-swarm';
import { applyMigrationV165 } from '../db-migrations/v165-swarm-generic-roles';
import { applyMigrationV166, swarmDeliveryQueueIsV166 } from '../db-migrations/v166-swarm-delivery-queue';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { DEFAULT_SWARM_SETTINGS } from '../../../src/types/swarm';

type MigrationDb = Parameters<typeof applyMigrationV166>[0];

function baseDb(): { db: MigrationDb; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  let seq = 0;
  const db = {
    prepare: sqlite.prepare.bind(sqlite),
    exec: sqlite.exec.bind(sqlite),
    transaction:
      <T>(fn: () => T) =>
      () => {
        const savepoint = `tx_${++seq}`;
        sqlite.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn();
          sqlite.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      },
  } as unknown as Database.Database;
  sqlite.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, type TEXT DEFAULT 'chat', status TEXT DEFAULT 'active', updated_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, metadata TEXT);
    CREATE TABLE chat_session_features(session_id TEXT PRIMARY KEY, pipeline_control_enabled INTEGER DEFAULT 0, dynamic_workflows_enabled INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,description TEXT,system_prompt TEXT,model TEXT,allowed_tools TEXT,mcp_servers TEXT,is_active INTEGER,sort_order INTEGER,effort TEXT,thinking TEXT,thinking_budget INTEGER,max_turns INTEGER,skills TEXT,runtime TEXT,max_tool_rounds INTEGER,squad TEXT,codex_config TEXT);
    INSERT INTO sessions(id) VALUES ('s1');
    INSERT INTO messages(id, session_id, role, content) VALUES (10, 's1', 'system', 'envelope'), (11, 's1', 'assistant', 'resposta');
  `);
  return { db, sqlite };
}

function columns(sqlite: DatabaseSync, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
}

describe('migration v166 - fila de entrega do Swarm v2 (kind, slug, attempt_id, revision, reservas)', () => {
  it('LATEST_SCHEMA_VERSION e 167 e a V166 vem depois da V165', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(169);
  });

  it('AC-32: banco no estado da S1 (V153 + V165 aplicadas) migra a fila preservando linhas antigas como terminal e os receipts', () => {
    const { db, sqlite } = baseDb();
    applyMigrationV153(db);
    applyMigrationV165(db);
    sqlite
      .prepare(
        `INSERT INTO swarm_delivery_outbox (run_id, terminal_revision, session_id, envelope, run_status, state, claim_id, error)
         VALUES ('run-a', 5, 's1', 'env-a', 'done', 'delivered', NULL, NULL), ('run-b', 2, 's1', 'env-b', 'failed', 'pending', NULL, 'erro antigo')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO swarm_chat_receipts (run_id, terminal_revision, kind, session_id, message_id)
         VALUES ('run-a', 5, 'event', 's1', 10), ('run-a', 5, 'response', 's1', 11)`,
      )
      .run();
    expect(swarmDeliveryQueueIsV166(db)).toBe(false);
    applyMigrationV166(db);
    expect(swarmDeliveryQueueIsV166(db)).toBe(true);
    expect(columns(sqlite, 'swarm_delivery_outbox')).toEqual([
      'run_id',
      'kind',
      'revision',
      'slug',
      'attempt_id',
      'session_id',
      'envelope',
      'run_status',
      'state',
      'claim_id',
      'reserved_by',
      'lease_until',
      'turn_id',
      'error',
      'created_at',
      'updated_at',
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT run_id, kind, revision, slug, attempt_id, envelope, run_status, state, error FROM swarm_delivery_outbox ORDER BY run_id',
        )
        .all(),
    ).toEqual([
      {
        run_id: 'run-a',
        kind: 'terminal',
        revision: 5,
        slug: null,
        attempt_id: null,
        envelope: 'env-a',
        run_status: 'done',
        state: 'delivered',
        error: null,
      },
      {
        run_id: 'run-b',
        kind: 'terminal',
        revision: 2,
        slug: null,
        attempt_id: null,
        envelope: 'env-b',
        run_status: 'failed',
        state: 'pending',
        error: 'erro antigo',
      },
    ]);
    expect(columns(sqlite, 'swarm_chat_receipts')).toEqual([
      'run_id',
      'delivery_kind',
      'revision',
      'kind',
      'session_id',
      'message_id',
    ]);
    expect(
      sqlite
        .prepare('SELECT run_id, delivery_kind, revision, kind, message_id FROM swarm_chat_receipts ORDER BY kind')
        .all(),
    ).toEqual([
      { run_id: 'run-a', delivery_kind: 'terminal', revision: 5, kind: 'event', message_id: 10 },
      { run_id: 'run-a', delivery_kind: 'terminal', revision: 5, kind: 'response', message_id: 11 },
    ]);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='swarm_open_window_ms'").get()).toEqual({
      value: String(DEFAULT_SWARM_SETTINGS.openWindowMs),
    });
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%v166%'").all()).toEqual([]);
    sqlite.close();
  });

  it('aceita os estados e tipos novos, recusa run_status fora da lista antiga sem CHECK e mantem a FK dos receipts', () => {
    const { db, sqlite } = baseDb();
    applyMigrationV153(db);
    applyMigrationV166(db);
    sqlite
      .prepare(
        `INSERT INTO swarm_delivery_outbox (run_id, kind, revision, slug, attempt_id, session_id, envelope, run_status, state, reserved_by, lease_until)
         VALUES ('run', 'question', 3, 'auditor', 'attempt-1-ab', 's1', 'pergunta', 'running', 'reserved-by-wait', 'wait-1', 123)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO swarm_delivery_outbox (run_id, kind, revision, session_id, envelope, run_status, state, turn_id)
         VALUES ('run', 'terminal', 3, 's1', 'fim', 'open', 'consumed-by-turn', 'turn-9')`,
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO swarm_delivery_outbox (run_id, kind, revision, session_id, envelope, run_status) VALUES ('run', 'other', 4, 's1', 'x', 'open')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO swarm_delivery_outbox (run_id, kind, revision, session_id, envelope, run_status, state) VALUES ('run', 'terminal', 4, 's1', 'x', 'open', 'weird')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO swarm_chat_receipts (run_id, delivery_kind, revision, kind, session_id, message_id) VALUES ('run', 'terminal', 99, 'event', 's1', 10)`,
        )
        .run(),
    ).toThrow();
    sqlite
      .prepare(
        `INSERT INTO swarm_chat_receipts (run_id, delivery_kind, revision, kind, session_id, message_id) VALUES ('run', 'question', 3, 'event', 's1', 10)`,
      )
      .run();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM swarm_chat_receipts').get()).toEqual({ n: 1 });
    sqlite.close();
  });

  it('e idempotente: a segunda aplicacao nao recria tabelas nem apaga linhas, e um banco novo sem a fila ganha a tabela nova', () => {
    const { db, sqlite } = baseDb();
    applyMigrationV153(db);
    applyMigrationV166(db);
    sqlite
      .prepare(
        `INSERT INTO swarm_delivery_outbox (run_id, kind, revision, session_id, envelope, run_status) VALUES ('run', 'terminal', 1, 's1', 'x', 'open')`,
      )
      .run();
    sqlite.prepare("UPDATE settings SET value='99' WHERE key='swarm_open_window_ms'").run();
    applyMigrationV166(db);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM swarm_delivery_outbox').get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='swarm_open_window_ms'").get()).toEqual({
      value: '99',
    });
    sqlite.close();
    const fresh = baseDb();
    applyMigrationV166(fresh.db);
    expect(swarmDeliveryQueueIsV166(fresh.db)).toBe(true);
    expect(columns(fresh.sqlite, 'swarm_chat_receipts')).toContain('delivery_kind');
    fresh.sqlite.close();
  });
});
