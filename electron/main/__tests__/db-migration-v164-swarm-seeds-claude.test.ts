import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrationV164, __V164_INTERNAL } from '../db-migrations/v164-swarm-seeds-claude';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { __V169_INTERNAL } from '../db-migrations/v169-codex-gpt-6-1-sol';
import { KIMI_DEFAULT_MODEL } from '../../../src/constants/kimi-models';
import { SWARM_SEED_AGENTS, SWARM_SPECIALIZED_AGENT_IDS } from '../seed-agents/swarm-registry';
import { dynamicWorkflowCoderGlm } from '../seed-agents/dynamic-workflow-coder-glm';

type V164Db = Parameters<typeof applyMigrationV164>[0];

interface AgentRow {
  runtime: string;
  model: string;
  codex_config: string | null;
}

function makeDb(withCodexConfig = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    withCodexConfig
      ? 'CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, runtime TEXT, squad TEXT, codex_config TEXT)'
      : 'CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, runtime TEXT, squad TEXT)',
  );
  return db;
}

function hasCodexConfigColumn(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA table_info(agents)').all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === 'codex_config');
}

function insertAgent(
  db: DatabaseSync,
  id: string,
  runtime: string,
  model: string,
  squad = 'swarm',
  codexConfig: string | null = null,
): void {
  if (!hasCodexConfigColumn(db)) {
    db.prepare('INSERT INTO agents (id, model, runtime, squad) VALUES (?, ?, ?, ?)').run(id, model, runtime, squad);
    return;
  }
  db.prepare('INSERT INTO agents (id, model, runtime, squad, codex_config) VALUES (?, ?, ?, ?, ?)').run(
    id,
    model,
    runtime,
    squad,
    codexConfig,
  );
}

function rowOf(db: DatabaseSync, id: string): AgentRow {
  return db.prepare('SELECT runtime, model, codex_config FROM agents WHERE id = ?').get(id) as unknown as AgentRow;
}

function apply(db: DatabaseSync): void {
  applyMigrationV164(db as unknown as V164Db);
}

const CODEX_CONFIG = JSON.stringify({ model: 'gpt-6-sol', sandbox: 'read-only', reasoningEffort: 'high' });
const MOVED = { runtime: 'cloud', model: 'claude-opus-5-5', codex_config: null };

describe('migration v164 - agentes de seed do Swarm nascem em Claude Opus 5.5', () => {
  it('LATEST_SCHEMA_VERSION e 167 (V165, V166 e V167 do Swarm v2 vem depois)', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(169);
  });

  it('o alvo da migration bate com o que uma instalacao nova recebe dos seeds', () => {
    expect(__V164_INTERNAL.NEW_MODEL).toBe(CLAUDE_DEFAULT_MODEL);
    expect(__V164_INTERNAL.SWARM_SEED_AGENT_IDS).toEqual([...SWARM_SPECIALIZED_AGENT_IDS]);
    expect(SWARM_SEED_AGENTS).toHaveLength(15);
    for (const seed of SWARM_SEED_AGENTS) {
      expect(seed.runtime).toBe(__V164_INTERNAL.NEW_RUNTIME);
      expect(seed.model).toBe(__V164_INTERNAL.NEW_MODEL);
      expect(seed.squad).toBe('swarm');
      expect(seed.codexConfig).toBeUndefined();
    }
  });

  it('os defaults antigos cobrem o default do codex da epoca (gpt-6-sol, substituido pela V169), do kimi e o GLM do seed zai', () => {
    const defaults = __V164_INTERNAL.PREVIOUS_SEED_DEFAULTS.map(([runtime, model]) => `${runtime}:${model}`);
    expect(defaults).toContain('codex:gpt-6-sol');
    expect(__V169_INTERNAL.PREVIOUS_SEED_MODEL).toBe('gpt-6-sol');
    expect(defaults).toContain(`kimi:${KIMI_DEFAULT_MODEL}`);
    expect(defaults).toContain(`zai:${dynamicWorkflowCoderGlm.model}`);
    expect(defaults).toContain('cloud:claude-opus-4-7');
  });

  it('move os seeds ainda nos defaults antigos para cloud + claude-opus-5-5 e limpa o codex_config', () => {
    const db = makeDb();
    insertAgent(db, 'swarm-auth-auditor', 'codex', 'gpt-6-sol', 'swarm', CODEX_CONFIG);
    insertAgent(db, 'swarm-contract-checker', 'codex', 'gpt-6-astra', 'swarm', CODEX_CONFIG);
    insertAgent(db, 'swarm-secrets-scanner', 'kimi', 'kimi-code/kimi-for-coding');
    insertAgent(db, 'swarm-test-coverage-analyst', 'zai', 'glm-4.7');
    insertAgent(db, 'swarm-owasp-scanner', 'cloud', 'claude-opus-4-7');
    insertAgent(db, 'swarm-web-researcher', 'cloud', 'claude-opus-5-5');
    apply(db);
    for (const id of [
      'swarm-auth-auditor',
      'swarm-contract-checker',
      'swarm-secrets-scanner',
      'swarm-test-coverage-analyst',
      'swarm-owasp-scanner',
      'swarm-web-researcher',
    ]) {
      expect(rowOf(db, id)).toEqual(MOVED);
    }
  });

  it('PRESERVA agente customizado: runtime ou modelo diferentes do seed, squad trocado ou id fora da lista', () => {
    const db = makeDb();
    insertAgent(db, 'swarm-auth-auditor', 'codex', 'gpt-6-luna', 'swarm', CODEX_CONFIG);
    insertAgent(db, 'swarm-secrets-scanner', 'grok', 'grok-4-5');
    insertAgent(db, 'swarm-code-explorer', 'kimi', 'kimi-k3');
    insertAgent(db, 'swarm-doc-drift-detector', 'kimi', 'kimi-code/kimi-for-coding', 'quality');
    insertAgent(db, 'meu-agente', 'codex', 'gpt-6-sol', 'swarm', CODEX_CONFIG);
    insertAgent(db, 'dynamic-workflow-coder-codex', 'codex', 'gpt-6-sol', 'workflow', CODEX_CONFIG);
    apply(db);
    expect(rowOf(db, 'swarm-auth-auditor')).toEqual({
      runtime: 'codex',
      model: 'gpt-6-luna',
      codex_config: CODEX_CONFIG,
    });
    expect(rowOf(db, 'swarm-secrets-scanner')).toEqual({ runtime: 'grok', model: 'grok-4-5', codex_config: null });
    expect(rowOf(db, 'swarm-code-explorer')).toEqual({ runtime: 'kimi', model: 'kimi-k3', codex_config: null });
    expect(rowOf(db, 'swarm-doc-drift-detector')).toEqual({
      runtime: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      codex_config: null,
    });
    expect(rowOf(db, 'meu-agente')).toEqual({ runtime: 'codex', model: 'gpt-6-sol', codex_config: CODEX_CONFIG });
    expect(rowOf(db, 'dynamic-workflow-coder-codex')).toEqual({
      runtime: 'codex',
      model: 'gpt-6-sol',
      codex_config: CODEX_CONFIG,
    });
  });

  it('e idempotente', () => {
    const db = makeDb();
    insertAgent(db, 'swarm-auth-auditor', 'codex', 'gpt-6-sol', 'swarm', CODEX_CONFIG);
    insertAgent(db, 'swarm-code-explorer', 'kimi', 'kimi-k3');
    apply(db);
    const first = [rowOf(db, 'swarm-auth-auditor'), rowOf(db, 'swarm-code-explorer')];
    apply(db);
    expect([rowOf(db, 'swarm-auth-auditor'), rowOf(db, 'swarm-code-explorer')]).toEqual(first);
    expect(first[0]).toEqual(MOVED);
    expect(first[1]).toEqual({ runtime: 'kimi', model: 'kimi-k3', codex_config: null });
  });

  it('funciona sem a coluna codex_config', () => {
    const db = makeDb(false);
    insertAgent(db, 'swarm-auth-auditor', 'codex', 'gpt-6-sol');
    insertAgent(db, 'swarm-secrets-scanner', 'kimi', 'kimi-code/kimi-for-coding');
    apply(db);
    const rows = db.prepare('SELECT runtime, model FROM agents ORDER BY id').all() as unknown as Array<{
      runtime: string;
      model: string;
    }>;
    expect(rows).toEqual([
      { runtime: 'cloud', model: 'claude-opus-5-5' },
      { runtime: 'cloud', model: 'claude-opus-5-5' },
    ]);
  });
});
