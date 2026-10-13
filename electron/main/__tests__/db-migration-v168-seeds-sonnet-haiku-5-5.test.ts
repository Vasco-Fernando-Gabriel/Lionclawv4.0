import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { applyMigrationV168, __V168_INTERNAL } from '../db-migrations/v168-seeds-sonnet-haiku-5-5';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { specBuilder } from '../seed-agents/spec-builder';
import { dynamicWorkflowMaestro } from '../seed-agents/dynamic-workflow-builder';
import { repoProfiler } from '../seed-agents/repo-profiler';
import { CLAUDE_MODELS } from '../../../src/constants/claude-models';

type V168Db = Parameters<typeof applyMigrationV168>[0];

const SEEDS_DIR = path.join(__dirname, '..', 'seed-agents');

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, model TEXT, runtime TEXT)`);
  return db;
}

function insertAgent(db: DatabaseSync, id: string, model: string, runtime = 'cloud') {
  db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(id, model, runtime);
}

function modelOf(db: DatabaseSync, id: string): string {
  return (db.prepare('SELECT model FROM agents WHERE id = ?').get(id) as { model: string }).model;
}

const apply = (db: DatabaseSync) => applyMigrationV168(db as unknown as V168Db);

describe('migration v168 - seeds placeholder em Sonnet 5.5 e Haiku 5.5', () => {
  it('LATEST_SCHEMA_VERSION cobre a migration e os modelos novos estao no catalogo Claude', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(168);
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(ids).toContain(__V168_INTERNAL.NEW_SONNET_MODEL);
    expect(ids).toContain(__V168_INTERNAL.NEW_HAIKU_MODEL);
    expect(__V168_INTERNAL.NEW_SONNET_MODEL).toBe('claude-sonnet-5-5');
    expect(__V168_INTERNAL.NEW_HAIKU_MODEL).toBe('claude-haiku-5-5');
  });

  it('listas explicitas: 49 seeds Sonnet (48 arquivos + maestro) e 8 seeds Haiku, sem repeticao', () => {
    expect(__V168_INTERNAL.SONNET_SEED_AGENT_IDS).toHaveLength(49);
    expect(__V168_INTERNAL.HAIKU_SEED_AGENT_IDS).toHaveLength(8);
    expect(new Set(__V168_INTERNAL.SONNET_SEED_AGENT_IDS).size).toBe(49);
    expect(new Set(__V168_INTERNAL.HAIKU_SEED_AGENT_IDS).size).toBe(8);
    expect(__V168_INTERNAL.SONNET_SEED_AGENT_IDS).toContain('dynamic-workflow-maestro');
    expect(__V168_INTERNAL.HAIKU_SEED_AGENT_IDS).toEqual([
      'dynamic-workflow-plan-validator-coverage',
      'dynamic-workflow-plan-validator-criteria',
      'dynamic-workflow-plan-validator-topology',
      'dynamic-workflow-validator-regression',
      'dynamic-workflow-validator-spec',
      'dynamic-workflow-validator-tests',
      'repo-profiler',
      'security-resolution-tracker',
    ]);
  });

  it('nenhum seed .ts continua no Sonnet 4.6 ou no Haiku 4.5; os seeds da lista nascem no modelo novo', () => {
    const files = fs.readdirSync(SEEDS_DIR).filter((name) => name.endsWith('.ts'));
    for (const name of files) {
      const source = fs.readFileSync(path.join(SEEDS_DIR, name), 'utf8');
      expect(source, name).not.toContain(`model: '${__V168_INTERNAL.PREVIOUS_SONNET_MODEL}'`);
      expect(source, name).not.toContain(`model: '${__V168_INTERNAL.PREVIOUS_HAIKU_MODEL}'`);
    }
    expect(specBuilder.model).toBe(__V168_INTERNAL.NEW_SONNET_MODEL);
    expect(dynamicWorkflowMaestro.model).toBe(__V168_INTERNAL.NEW_SONNET_MODEL);
    expect(repoProfiler.model).toBe(__V168_INTERNAL.NEW_HAIKU_MODEL);
    expect(__V168_INTERNAL.SONNET_SEED_AGENT_IDS).toContain(specBuilder.id);
    expect(__V168_INTERNAL.SONNET_SEED_AGENT_IDS).toContain(dynamicWorkflowMaestro.id);
    expect(__V168_INTERNAL.HAIKU_SEED_AGENT_IDS).toContain(repoProfiler.id);
  });

  it('seed cloud no modelo antigo sobe para o novo (Sonnet e Haiku)', () => {
    const db = makeDb();
    insertAgent(db, 'spec-builder', 'claude-sonnet-4-6');
    insertAgent(db, 'dynamic-workflow-maestro', 'claude-sonnet-4-6');
    insertAgent(db, 'repo-profiler', 'claude-haiku-4-5-20251001');
    insertAgent(db, 'security-resolution-tracker', 'claude-haiku-4-5-20251001');
    apply(db);
    expect(modelOf(db, 'spec-builder')).toBe('claude-sonnet-5-5');
    expect(modelOf(db, 'dynamic-workflow-maestro')).toBe('claude-sonnet-5-5');
    expect(modelOf(db, 'repo-profiler')).toBe('claude-haiku-5-5');
    expect(modelOf(db, 'security-resolution-tracker')).toBe('claude-haiku-5-5');
  });

  it('nao toca agente customizado (id fora da lista), seed com modelo alterado pelo usuario nem seed em outro runtime', () => {
    const db = makeDb();
    insertAgent(db, 'meu-agente', 'claude-sonnet-4-6');
    insertAgent(db, 'meu-validador', 'claude-haiku-4-5-20251001');
    insertAgent(db, 'spec-builder', 'claude-opus-5-5');
    insertAgent(db, 'repo-profiler', 'claude-sonnet-5');
    insertAgent(db, 'tech-backend', 'claude-sonnet-4-6', 'zai');
    insertAgent(db, 'prd-generator', 'claude-sonnet-4-6', 'codex');
    insertAgent(db, 'dynamic-workflow-validator-spec', 'claude-haiku-4-5-20251001', 'kimi');
    apply(db);
    expect(modelOf(db, 'meu-agente')).toBe('claude-sonnet-4-6');
    expect(modelOf(db, 'meu-validador')).toBe('claude-haiku-4-5-20251001');
    expect(modelOf(db, 'spec-builder')).toBe('claude-opus-5-5');
    expect(modelOf(db, 'repo-profiler')).toBe('claude-sonnet-5');
    expect(modelOf(db, 'tech-backend')).toBe('claude-sonnet-4-6');
    expect(modelOf(db, 'prd-generator')).toBe('claude-sonnet-4-6');
    expect(modelOf(db, 'dynamic-workflow-validator-spec')).toBe('claude-haiku-4-5-20251001');
  });

  it('seed Sonnet da lista em Haiku 4.5 (ou vice-versa) nao e tocado: cada lista so promove o seu modelo antigo', () => {
    const db = makeDb();
    insertAgent(db, 'spec-builder', 'claude-haiku-4-5-20251001');
    insertAgent(db, 'repo-profiler', 'claude-sonnet-4-6');
    apply(db);
    expect(modelOf(db, 'spec-builder')).toBe('claude-haiku-4-5-20251001');
    expect(modelOf(db, 'repo-profiler')).toBe('claude-sonnet-4-6');
  });

  it('e idempotente', () => {
    const db = makeDb();
    insertAgent(db, 'spec-builder', 'claude-sonnet-4-6');
    insertAgent(db, 'repo-profiler', 'claude-haiku-4-5-20251001');
    insertAgent(db, 'meu-agente', 'claude-sonnet-4-6');
    apply(db);
    apply(db);
    expect(modelOf(db, 'spec-builder')).toBe('claude-sonnet-5-5');
    expect(modelOf(db, 'repo-profiler')).toBe('claude-haiku-5-5');
    expect(modelOf(db, 'meu-agente')).toBe('claude-sonnet-4-6');
  });
});
