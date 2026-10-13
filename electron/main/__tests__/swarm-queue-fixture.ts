import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { applyMigrationV153 } from '../db-migrations/v153-swarm';
import { applyMigrationV166 } from '../db-migrations/v166-swarm-delivery-queue';
import {
  cancelSwarmDelivery,
  claimSwarmDelivery,
  completeSwarmDelivery,
  consumeSwarmDelivery,
  enqueueSwarmDelivery,
  getPendingSwarmDeliveries,
  getSwarmDelivery,
  persistSwarmChatMessageOnce,
  recoverSwarmDeliveryClaims,
  releaseSwarmDeliveryReservations,
  renewSwarmDeliveryLeases,
  reserveSwarmDelivery,
  type SwarmDelivery,
} from '../db';
import type { SwarmRunnerDependencies } from '../swarm/runner';
import type { SwarmDeliveryKind } from '../../../src/types/swarm';

export type SwarmQueueDeps = Pick<
  SwarmRunnerDependencies,
  | 'deliver'
  | 'deliveryState'
  | 'reserveDelivery'
  | 'renewDeliveryLease'
  | 'releaseDeliveryReservation'
  | 'consumeDelivery'
  | 'cancelDelivery'
>;

export interface SwarmQueueFixture {
  db: Database.Database;
  deps: SwarmQueueDeps;
  pump: (claimId?: string) => SwarmDelivery[];
  complete: (
    delivery: Pick<SwarmDelivery, 'runId' | 'kind' | 'revision' | 'claimId'>,
    status?: 'delivered' | 'undeliverable',
    reason?: string,
  ) => boolean;
  markDelivered: (delivery: Pick<SwarmDelivery, 'runId' | 'kind' | 'revision' | 'claimId' | 'sessionId'>) => void;
  recoverClaims: () => number;
  row: (runId: string, kind: SwarmDeliveryKind, revision: number | null) => SwarmDelivery | undefined;
  rows: () => SwarmDelivery[];
  list: () => string[];
}

export function createSwarmQueueDb(sessionIds: readonly string[] = ['s']): Database.Database {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  let seq = 0;
  const db = {
    prepare: sqlite.prepare.bind(sqlite),
    exec: sqlite.exec.bind(sqlite),
    transaction:
      <T>(fn: () => T) =>
      () => {
        const savepoint = `swarm_queue_tx_${++seq}`;
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
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, type TEXT DEFAULT 'chat',status TEXT DEFAULT 'active',updated_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,role TEXT CHECK(role IN ('user','assistant','system')),content TEXT,metadata TEXT);
    CREATE TABLE chat_session_features(session_id TEXT PRIMARY KEY REFERENCES sessions(id),pipeline_control_enabled INTEGER DEFAULT 0,dynamic_workflows_enabled INTEGER DEFAULT 0,updated_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,description TEXT,system_prompt TEXT,model TEXT,allowed_tools TEXT,mcp_servers TEXT,is_active INTEGER,sort_order INTEGER,effort TEXT,thinking TEXT,thinking_budget INTEGER,max_turns INTEGER,skills TEXT,runtime TEXT,max_tool_rounds INTEGER,squad TEXT,codex_config TEXT);
  `);
  const insert = db.prepare('INSERT INTO sessions(id) VALUES (?)');
  for (const id of sessionIds) insert.run(id);
  applyMigrationV153(db);
  applyMigrationV166(db);
  return db;
}

export function createSwarmQueue(sessionIds: readonly string[] = ['s']): SwarmQueueFixture {
  const db = createSwarmQueueDb(sessionIds);
  const deps: SwarmQueueDeps = {
    deliver: (run, envelope, d) => {
      enqueueSwarmDelivery(
        {
          runId: run.runId,
          kind: d.kind,
          revision: d.revision,
          sessionId: run.chatSessionId,
          envelope,
          runStatus: run.status,
          slug: d.slug,
          attemptId: d.attemptId,
          reservedBy: d.reservedBy,
          leaseUntil: d.leaseUntil,
        },
        db,
      );
    },
    deliveryState: (run, kind, revision) => getSwarmDelivery(run.runId, kind, revision, db),
    reserveDelivery: (run, kind, revision, waitId, leaseUntil) =>
      reserveSwarmDelivery(run.runId, kind, revision, waitId, leaseUntil, db),
    renewDeliveryLease: (waitId, leaseUntil) => {
      renewSwarmDeliveryLeases(waitId, leaseUntil, db);
    },
    releaseDeliveryReservation: (waitId) => {
      releaseSwarmDeliveryReservations(waitId, db);
    },
    consumeDelivery: (run, kind, revision, waitId, turnId) =>
      consumeSwarmDelivery(run.runId, kind, revision, waitId, turnId, db),
    cancelDelivery: (run, kind, revision, reason) => {
      cancelSwarmDelivery(run.runId, kind, revision, reason, db);
    },
  };
  const rows = () =>
    (
      db.prepare('SELECT * FROM swarm_delivery_outbox ORDER BY created_at,run_id,kind,revision').all() as Array<
        Record<string, unknown>
      >
    ).map((r) => getSwarmDelivery(r.run_id as string, r.kind as SwarmDeliveryKind, r.revision as number, db)!);
  return {
    db,
    deps,
    pump: (claimId = 'pump') => {
      const claimed: SwarmDelivery[] = [];
      for (const pending of getPendingSwarmDeliveries(db)) {
        const row = claimSwarmDelivery(pending.runId, pending.kind, pending.revision, claimId, db);
        if (row) claimed.push(row);
      }
      return claimed;
    },
    complete: (delivery, status = 'undeliverable', reason = 'teste') =>
      completeSwarmDelivery(delivery.runId, delivery.kind, delivery.revision, delivery.claimId!, status, reason, db),
    markDelivered: (delivery) => {
      persistSwarmChatMessageOnce(
        {
          sessionId: delivery.sessionId,
          runId: delivery.runId,
          kind: delivery.kind,
          revision: delivery.revision,
          messageKind: 'response',
          content: 'consolidado',
          claimId: delivery.claimId ?? undefined,
        },
        db,
      );
    },
    recoverClaims: () => recoverSwarmDeliveryClaims(db),
    row: (runId, kind, revision) => (revision === null ? undefined : getSwarmDelivery(runId, kind, revision, db)),
    rows,
    list: () => rows().map((r) => `${r.kind}:${r.revision}:${r.state}`),
  };
}
