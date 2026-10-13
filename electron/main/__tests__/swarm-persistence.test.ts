import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV153 } from '../db-migrations/v153-swarm';
import { applyMigrationV166 } from '../db-migrations/v166-swarm-delivery-queue';
import { SWARM_SEED_AGENTS, ALL_SEED_AGENTS } from '../seed-agents';
import {
  upsertSwarmRunIndex,
  listSwarmRunIndex,
  enqueueSwarmDelivery,
  claimSwarmDelivery,
  releaseSwarmDelivery,
  completeSwarmDelivery,
  recoverSwarmDeliveryClaims,
  getPendingSwarmDeliveries,
  getSwarmDelivery,
  persistSwarmChatMessageOnce,
  getChatFeatureToggles,
  setChatFeatureToggles,
  reserveSwarmDelivery,
  renewSwarmDeliveryLeases,
  releaseSwarmDeliveryReservations,
  consumeSwarmDelivery,
  cancelSwarmDelivery,
} from '../db';
import type { SwarmRunSummary } from '../../../src/types/swarm';

function fixture() {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  let seq = 0;
  const db = {
    prepare: sqlite.prepare.bind(sqlite),
    exec: sqlite.exec.bind(sqlite),
    transaction:
      <T>(fn: () => T) =>
      () => {
        const savepoint = `test_tx_${++seq}`;
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
    INSERT INTO sessions(id) VALUES ('s1'),('s2');
    INSERT INTO chat_session_features(session_id) VALUES ('s1');
  `);
  applyMigrationV153(db);
  applyMigrationV166(db);
  return { db, sqlite };
}
const summary = (runId: string, revision: number, chatSessionId = 's1'): SwarmRunSummary => ({
  runId,
  revision,
  chatSessionId,
  mode: 'comite',
  status: 'running',
  itemCount: 2,
  createdAt: '2026-09-13T00:00:00Z',
  finishedAt: null,
  costUsd: null,
});

describe('Swarm migration, projection and delivery', () => {
  it('seeds all fifteen independent profiles with full contracts, preserving customizations and defaults on replay', () => {
    const { db, sqlite } = fixture();
    try {
      expect(SWARM_SEED_AGENTS).toHaveLength(15);
      for (const seed of SWARM_SEED_AGENTS) {
        expect(ALL_SEED_AGENTS.filter((agent) => agent.id === seed.id)).toHaveLength(1);
        const row = db.prepare('SELECT * FROM agents WHERE id=?').get(seed.id) as Record<string, unknown>;
        expect(row.system_prompt).toBe(seed.systemPrompt);
        expect(row.squad).toBe('swarm');
        expect(row.model).toBe(seed.model);
        expect(seed.systemPrompt).toContain('{{FINDINGS_PATH}}');
      }
      db.prepare('UPDATE agents SET system_prompt=?,model=?,squad=? WHERE id=?').run(
        'custom',
        'custom-model',
        'quality',
        SWARM_SEED_AGENTS[0].id,
      );
      db.prepare("UPDATE settings SET value='3' WHERE key='swarm_concurrency_cap'").run();
      applyMigrationV153(db);
      expect(
        db.prepare('SELECT system_prompt,model,squad FROM agents WHERE id=?').get(SWARM_SEED_AGENTS[0].id),
      ).toEqual({ system_prompt: 'custom', model: 'custom-model', squad: 'quality' });
      expect(db.prepare("SELECT value FROM settings WHERE key='swarm_concurrency_cap'").get()).toEqual({ value: '3' });
      expect(getChatFeatureToggles('s1', db)?.swarm).toBe(false);
      expect(setChatFeatureToggles('s1', { swarm: true }, db)).toEqual({
        ok: true,
        toggles: { pipelineControl: false, dynamicWorkflows: false, swarm: true },
      });
      expect(setChatFeatureToggles('s1', { pipelineControl: true }, db)).toEqual({
        ok: true,
        toggles: { pipelineControl: true, dynamicWorkflows: false, swarm: true },
      });
    } finally {
      sqlite.close();
    }
  });
  it('rejects stale revisions and paginates equal timestamps without crossing sessions', () => {
    const { db, sqlite } = fixture();
    try {
      upsertSwarmRunIndex(summary('a', 2), db);
      upsertSwarmRunIndex(summary('a', 1), db);
      upsertSwarmRunIndex(summary('b', 1), db);
      upsertSwarmRunIndex(summary('c', 1, 's2'), db);
      expect(listSwarmRunIndex('s1', undefined, 1, db)).toEqual({ runs: [summary('b', 1)], nextCursor: 'b' });
      expect(listSwarmRunIndex('s1', 'b', 1, db)).toEqual({ runs: [summary('a', 2)], nextCursor: null });
      expect(() => listSwarmRunIndex('s1', 'c', 20, db)).toThrow('Cursor');
    } finally {
      sqlite.close();
    }
  });
  it('claims once, fences stale workers and commits final response with delivery atomically', () => {
    const { db, sqlite } = fixture();
    try {
      const base = {
        runId: 'run',
        kind: 'terminal' as const,
        revision: 5,
        sessionId: 's1',
        envelope: 'envelope',
        runStatus: 'open' as const,
      };
      enqueueSwarmDelivery(base, db);
      enqueueSwarmDelivery(base, db);
      expect(() => enqueueSwarmDelivery({ ...base, sessionId: 's2' }, db)).toThrow('Conflito');
      expect(getPendingSwarmDeliveries(db)).toHaveLength(1);
      expect(claimSwarmDelivery('run', 'terminal', 5, 'owner1', db)?.state).toBe('claimed');
      expect(claimSwarmDelivery('run', 'terminal', 5, 'owner2', db)).toBeUndefined();
      expect(() => completeSwarmDelivery('run', 'terminal', 5, 'owner1', 'delivered', undefined, db)).toThrow(
        'sem mensagem',
      );
      const event = {
        sessionId: 's1',
        runId: 'run',
        kind: 'terminal' as const,
        revision: 5,
        messageKind: 'event' as const,
        content: 'envelope',
        claimId: 'owner1',
      };
      const first = persistSwarmChatMessageOnce(event, db);
      expect(persistSwarmChatMessageOnce(event, db)).toEqual({ ...first, inserted: false });
      expect(getSwarmDelivery('run', 'terminal', 5, db)?.state).toBe('claimed');
      expect(recoverSwarmDeliveryClaims(db)).toBe(1);
      claimSwarmDelivery('run', 'terminal', 5, 'owner2', db);
      expect(() => persistSwarmChatMessageOnce({ ...event, messageKind: 'response', content: 'late' }, db)).toThrow(
        'Claim',
      );
      expect(releaseSwarmDelivery('run', 'terminal', 5, 'owner1', undefined, db)).toBe(false);
      persistSwarmChatMessageOnce({ ...event, messageKind: 'response', content: 'final', claimId: 'owner2' }, db);
      expect(getSwarmDelivery('run', 'terminal', 5, db)?.state).toBe('delivered');
      expect(
        persistSwarmChatMessageOnce({ ...event, messageKind: 'response', content: 'repeat', claimId: 'owner2' }, db)
          .inserted,
      ).toBe(false);
      expect(db.prepare('SELECT role,content FROM messages ORDER BY id').all()).toEqual([
        { role: 'system', content: 'envelope' },
        { role: 'assistant', content: 'final' },
      ]);
      const metadata = JSON.parse(
        (db.prepare('SELECT metadata FROM messages ORDER BY id LIMIT 1').get() as { metadata: string }).metadata,
      ) as { swarm: Record<string, unknown> };
      expect(metadata.swarm).toMatchObject({ runId: 'run', deliveryKind: 'terminal', revision: 5, kind: 'event' });
    } finally {
      sqlite.close();
    }
  });
  it('question deliveries share the queue with their own identity, state and dedupe per revision', () => {
    const { db, sqlite } = fixture();
    try {
      const question = {
        runId: 'run',
        kind: 'question' as const,
        revision: 3,
        sessionId: 's1',
        envelope: 'pergunta',
        runStatus: 'running' as const,
        slug: 'auditor',
        attemptId: 'attempt-1-abcd',
      };
      enqueueSwarmDelivery(question, db);
      enqueueSwarmDelivery(
        { ...question, kind: 'terminal', slug: undefined, attemptId: undefined, envelope: 'fim', runStatus: 'open' },
        db,
      );
      expect(getPendingSwarmDeliveries(db).map((d) => `${d.kind}:${d.revision}:${d.slug}`)).toEqual([
        'question:3:auditor',
        'terminal:3:null',
      ]);
      expect(getSwarmDelivery('run', 'question', 3, db)).toMatchObject({
        slug: 'auditor',
        attemptId: 'attempt-1-abcd',
        runStatus: 'running',
        state: 'pending',
      });
      expect(cancelSwarmDelivery('run', 'question', 3, 'swarm agent parado', db)).toBe(true);
      expect(getSwarmDelivery('run', 'question', 3, db)).toMatchObject({
        state: 'undeliverable',
        error: 'swarm agent parado',
      });
      expect(cancelSwarmDelivery('run', 'question', 3, 'de novo', db)).toBe(false);
    } finally {
      sqlite.close();
    }
  });
  it('reservation by a wait is atomic, renewable, consumable by the turn and expires back to pending', () => {
    const { db, sqlite } = fixture();
    try {
      const base = {
        runId: 'run',
        kind: 'terminal' as const,
        revision: 9,
        sessionId: 's1',
        envelope: 'e',
        runStatus: 'open' as const,
      };
      enqueueSwarmDelivery({ ...base, reservedBy: 'wait-a', leaseUntil: 1_000 }, db);
      expect(getSwarmDelivery('run', 'terminal', 9, db)).toMatchObject({
        state: 'reserved-by-wait',
        reservedBy: 'wait-a',
        leaseUntil: 1_000,
      });
      expect(getPendingSwarmDeliveries(db, 500)).toHaveLength(0);
      expect(claimSwarmDelivery('run', 'terminal', 9, 'pump', db)).toBeUndefined();
      expect(reserveSwarmDelivery('run', 'terminal', 9, 'wait-b', 2_000, db)).toBe(false);
      expect(reserveSwarmDelivery('run', 'terminal', 9, 'wait-a', 2_000, db)).toBe(true);
      expect(renewSwarmDeliveryLeases('wait-a', 3_000, db)).toBe(1);
      expect(getSwarmDelivery('run', 'terminal', 9, db)?.leaseUntil).toBe(3_000);
      expect(consumeSwarmDelivery('run', 'terminal', 9, 'wait-b', 'turn-1', db)).toBe(false);
      expect(consumeSwarmDelivery('run', 'terminal', 9, 'wait-a', 'turn-1', db)).toBe(true);
      expect(getSwarmDelivery('run', 'terminal', 9, db)).toMatchObject({
        state: 'consumed-by-turn',
        turnId: 'turn-1',
        reservedBy: null,
      });
      expect(getPendingSwarmDeliveries(db, 10_000)).toHaveLength(0);
      enqueueSwarmDelivery({ ...base, revision: 10, reservedBy: 'wait-c', leaseUntil: 1_000 }, db);
      expect(getPendingSwarmDeliveries(db, 5_000).map((d) => d.revision)).toEqual([10]);
      expect(getSwarmDelivery('run', 'terminal', 10, db)).toMatchObject({ state: 'pending', reservedBy: null });
      enqueueSwarmDelivery({ ...base, revision: 11 }, db);
      expect(reserveSwarmDelivery('run', 'terminal', 11, 'wait-d', 9_000, db)).toBe(true);
      expect(releaseSwarmDeliveryReservations('wait-d', db)).toBe(1);
      expect(getSwarmDelivery('run', 'terminal', 11, db)?.state).toBe('pending');
      reserveSwarmDelivery('run', 'terminal', 11, 'wait-e', 9_000, db);
      expect(recoverSwarmDeliveryClaims(db)).toBe(1);
      expect(getSwarmDelivery('run', 'terminal', 11, db)?.state).toBe('pending');
    } finally {
      sqlite.close();
    }
  });
  it('aborted event is final without an LLM, and removed session keeps undeliverable evidence', () => {
    const { db, sqlite } = fixture();
    try {
      enqueueSwarmDelivery(
        { runId: 'abort', kind: 'terminal', revision: 2, sessionId: 's1', envelope: 'cancelado', runStatus: 'aborted' },
        db,
      );
      claimSwarmDelivery('abort', 'terminal', 2, 'owner', db);
      persistSwarmChatMessageOnce(
        {
          sessionId: 's1',
          runId: 'abort',
          kind: 'terminal',
          revision: 2,
          messageKind: 'event',
          content: 'cancelado',
          claimId: 'owner',
        },
        db,
      );
      expect(getSwarmDelivery('abort', 'terminal', 2, db)?.state).toBe('delivered');
      enqueueSwarmDelivery(
        { runId: 'removed', kind: 'terminal', revision: 2, sessionId: 's2', envelope: 'resultado', runStatus: 'done' },
        db,
      );
      claimSwarmDelivery('removed', 'terminal', 2, 'owner', db);
      db.prepare("DELETE FROM sessions WHERE id='s2'").run();
      expect(() =>
        persistSwarmChatMessageOnce(
          {
            sessionId: 's2',
            runId: 'removed',
            kind: 'terminal',
            revision: 2,
            messageKind: 'event',
            content: 'resultado',
            claimId: 'owner',
          },
          db,
        ),
      ).toThrow('removida');
      expect(completeSwarmDelivery('removed', 'terminal', 2, 'owner', 'undeliverable', 'Sessão removida', db)).toBe(
        true,
      );
      expect(getSwarmDelivery('removed', 'terminal', 2, db)?.envelope).toBe('resultado');
    } finally {
      sqlite.close();
    }
  });
});
