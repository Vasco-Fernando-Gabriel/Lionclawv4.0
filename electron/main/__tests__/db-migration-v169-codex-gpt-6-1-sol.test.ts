import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrationV169, __V169_INTERNAL } from '../db-migrations/v169-codex-gpt-6-1-sol';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { CODEX_DEFAULT_MODEL, CODEX_MODELS } from '../../../src/constants/codex-models';
import { dynamicWorkflowCoderCodex } from '../seed-agents/dynamic-workflow-coder-codex';

type V169Db = Parameters<typeof applyMigrationV169>[0];

const SEED_ID = 'dynamic-workflow-coder-codex';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, runtime TEXT, codex_config TEXT)`);
  return db;
}

function insertAgent(db: DatabaseSync, id: string, model: string, runtime: string, codexConfig: string | null) {
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?)').run(id, model, runtime, codexConfig);
}

function setSetting(db: DatabaseSync, key: string, value: string) {
  db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, value);
}

function rowOf(db: DatabaseSync, id: string): { model: string; codex_config: string | null } {
  return db.prepare('SELECT model, codex_config FROM agents WHERE id = ?').get(id) as {
    model: string;
    codex_config: string | null;
  };
}

function orchestratorModel(db: DatabaseSync): string | undefined {
  return (
    db.prepare(`SELECT value FROM settings WHERE key = 'orchestrator_model'`).get() as { value: string } | undefined
  )?.value;
}

const apply = (db: DatabaseSync) => applyMigrationV169(db as unknown as V169Db);

describe('migration v169 - GPT-6.1 Sol como default do Codex', () => {
  it('LATEST_SCHEMA_VERSION = 169; o modelo novo bate com CODEX_DEFAULT_MODEL, com o seed e com a posicao 0 do catalogo', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(169);
    expect(__V169_INTERNAL.NEW_MODEL).toBe('gpt-6.1-sol');
    expect(__V169_INTERNAL.NEW_MODEL).toBe(CODEX_DEFAULT_MODEL);
    expect(CODEX_MODELS[0].slug).toBe('gpt-6.1-sol');
    expect(dynamicWorkflowCoderCodex.model).toBe(__V169_INTERNAL.NEW_MODEL);
    expect(dynamicWorkflowCoderCodex.codexConfig?.model).toBe(__V169_INTERNAL.NEW_MODEL);
    expect(__V169_INTERNAL.RETIRED_CODEX_MODELS).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']);
    for (const retired of __V169_INTERNAL.RETIRED_CODEX_MODELS) {
      expect(CODEX_MODELS.map((m) => m.slug)).not.toContain(retired);
    }
  });

  it('(a) seed coder-codex no default anterior (gpt-6-sol): muda model e codex_config.$.model; resto preservado', () => {
    const db = makeDb();
    insertAgent(
      db,
      SEED_ID,
      'gpt-6-sol',
      'codex',
      JSON.stringify({ model: 'gpt-6-sol', sandbox: 'workspace-write', x: 1 }),
    );
    apply(db);
    const row = rowOf(db, SEED_ID);
    expect(row.model).toBe('gpt-6.1-sol');
    expect(JSON.parse(row.codex_config!)).toEqual({ model: 'gpt-6.1-sol', sandbox: 'workspace-write', x: 1 });
  });

  it('(a) seed coder-codex com modelo customizado (gpt-6-luna, gpt-6-astra) fica intocado', () => {
    for (const custom of ['gpt-6-luna', 'gpt-6-astra']) {
      const db = makeDb();
      insertAgent(db, SEED_ID, custom, 'codex', JSON.stringify({ model: custom }));
      apply(db);
      expect(rowOf(db, SEED_ID).model, custom).toBe(custom);
      expect(JSON.parse(rowOf(db, SEED_ID).codex_config!).model, custom).toBe(custom);
    }
  });

  it('(b) agente codex em modelo retirado com codex_config JSON valido: model e $.model vao para gpt-6.1-sol', () => {
    const db = makeDb();
    insertAgent(db, 'meu-codex-55', 'gpt-5.5', 'codex', JSON.stringify({ model: 'gpt-5.5', reasoningEffort: 'high' }));
    insertAgent(db, 'meu-codex-54', 'gpt-5.4', 'codex', JSON.stringify({ model: 'gpt-5.4' }));
    insertAgent(db, 'meu-codex-54m', 'gpt-5.4-mini', 'codex', JSON.stringify({ model: 'gpt-5.4-mini' }));
    insertAgent(
      db,
      'meu-codex-spark',
      'gpt-5.3-codex-spark',
      'codex',
      JSON.stringify({ model: 'gpt-5.3-codex-spark' }),
    );
    apply(db);
    for (const id of ['meu-codex-55', 'meu-codex-54', 'meu-codex-54m', 'meu-codex-spark']) {
      const row = rowOf(db, id);
      expect(row.model, id).toBe('gpt-6.1-sol');
      expect(JSON.parse(row.codex_config!).model, id).toBe('gpt-6.1-sol');
    }
    expect(JSON.parse(rowOf(db, 'meu-codex-55').codex_config!)).toEqual({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    });
  });

  it('(b) agente codex em modelo retirado SEM codex_config valido (NULL ou JSON quebrado): so model muda', () => {
    const db = makeDb();
    insertAgent(db, 'codex-null', 'gpt-5.5', 'codex', null);
    insertAgent(db, 'codex-quebrado', 'gpt-5.4', 'codex', '{not json');
    apply(db);
    expect(rowOf(db, 'codex-null')).toEqual({ model: 'gpt-6.1-sol', codex_config: null });
    expect(rowOf(db, 'codex-quebrado')).toEqual({ model: 'gpt-6.1-sol', codex_config: '{not json' });
  });

  it('(b) agente customizado em modelo fora da lista, ou em modelo retirado mas em outro runtime, fica intocado', () => {
    const db = makeDb();
    insertAgent(db, 'codex-56', 'gpt-5.6-sol', 'codex', JSON.stringify({ model: 'gpt-5.6-sol' }));
    insertAgent(db, 'codex-6-sol', 'gpt-6-sol', 'codex', JSON.stringify({ model: 'gpt-6-sol' }));
    insertAgent(db, 'codex-52', 'gpt-5.2', 'codex', JSON.stringify({ model: 'gpt-5.2' }));
    insertAgent(db, 'cloud-55', 'gpt-5.5', 'cloud', null);
    insertAgent(db, 'external-55', 'gpt-5.5', 'external', JSON.stringify({ model: 'gpt-5.5' }));
    apply(db);
    expect(rowOf(db, 'codex-56').model).toBe('gpt-5.6-sol');
    expect(rowOf(db, 'codex-6-sol').model).toBe('gpt-6-sol');
    expect(rowOf(db, 'codex-52').model).toBe('gpt-5.2');
    expect(rowOf(db, 'cloud-55').model).toBe('gpt-5.5');
    expect(rowOf(db, 'external-55')).toEqual({ model: 'gpt-5.5', codex_config: JSON.stringify({ model: 'gpt-5.5' }) });
  });

  it('(c) orchestrator_model em modelo retirado muda SOMENTE quando orchestrator_runtime = codex-sdk', () => {
    for (const retired of __V169_INTERNAL.RETIRED_CODEX_MODELS) {
      const db = makeDb();
      setSetting(db, 'orchestrator_runtime', 'codex-sdk');
      setSetting(db, 'orchestrator_model', retired);
      apply(db);
      expect(orchestratorModel(db), retired).toBe('gpt-6.1-sol');
    }

    const otherRuntime = makeDb();
    setSetting(otherRuntime, 'orchestrator_runtime', 'claude-sdk');
    setSetting(otherRuntime, 'orchestrator_model', 'gpt-5.5');
    apply(otherRuntime);
    expect(orchestratorModel(otherRuntime)).toBe('gpt-5.5');

    const noRuntime = makeDb();
    setSetting(noRuntime, 'orchestrator_model', 'gpt-5.5');
    apply(noRuntime);
    expect(orchestratorModel(noRuntime)).toBe('gpt-5.5');

    const keptChoice = makeDb();
    setSetting(keptChoice, 'orchestrator_runtime', 'codex-sdk');
    setSetting(keptChoice, 'orchestrator_model', 'gpt-6-astra');
    apply(keptChoice);
    expect(orchestratorModel(keptChoice)).toBe('gpt-6-astra');
  });

  it('e idempotente (a, b e c)', () => {
    const db = makeDb();
    setSetting(db, 'orchestrator_runtime', 'codex-sdk');
    setSetting(db, 'orchestrator_model', 'gpt-5.5');
    insertAgent(db, SEED_ID, 'gpt-6-sol', 'codex', JSON.stringify({ model: 'gpt-6-sol' }));
    insertAgent(db, 'meu-codex', 'gpt-5.4', 'codex', JSON.stringify({ model: 'gpt-5.4' }));
    insertAgent(db, 'codex-custom', 'gpt-6-luna', 'codex', JSON.stringify({ model: 'gpt-6-luna' }));
    apply(db);
    const first = {
      orchestrator: orchestratorModel(db),
      seed: rowOf(db, SEED_ID),
      mine: rowOf(db, 'meu-codex'),
      custom: rowOf(db, 'codex-custom'),
    };
    apply(db);
    expect({
      orchestrator: orchestratorModel(db),
      seed: rowOf(db, SEED_ID),
      mine: rowOf(db, 'meu-codex'),
      custom: rowOf(db, 'codex-custom'),
    }).toEqual(first);
    expect(first.orchestrator).toBe('gpt-6.1-sol');
    expect(first.seed.model).toBe('gpt-6.1-sol');
    expect(first.mine.model).toBe('gpt-6.1-sol');
    expect(first.custom.model).toBe('gpt-6-luna');
  });
});
