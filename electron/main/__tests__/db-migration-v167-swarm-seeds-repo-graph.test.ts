import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  applyMigrationV167,
  V167_REPO_GRAPH_MCP_SERVERS,
  __V167_INTERNAL,
} from '../db-migrations/v167-swarm-seeds-repo-graph';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { SWARM_SEED_AGENTS, SWARM_AGENT_IDS } from '../seed-agents/swarm-registry';

type V167Db = Parameters<typeof applyMigrationV167>[0];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,mcp_servers TEXT,squad TEXT)');
  return db;
}
function insert(db: DatabaseSync, id: string, mcpServers: string | null, squad = 'swarm'): void {
  db.prepare('INSERT INTO agents (id,name,mcp_servers,squad) VALUES (?,?,?,?)').run(id, id, mcpServers, squad);
}
function mcpOf(db: DatabaseSync, id: string): string | null {
  return (db.prepare('SELECT mcp_servers FROM agents WHERE id = ?').get(id) as { mcp_servers: string | null })
    .mcp_servers;
}
const apply = (db: DatabaseSync) => applyMigrationV167(db as unknown as V167Db);

describe('migration v167 - repo-graph marcado nos seeds do Swarm', () => {
  it('LATEST_SCHEMA_VERSION e 169 e a migration cobre os 15 seeds, que nascem com o repo-graph marcado', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(169);
    expect(__V167_INTERNAL.SEED_IDS).toEqual(SWARM_AGENT_IDS);
    expect(SWARM_SEED_AGENTS).toHaveLength(15);
    for (const seed of SWARM_SEED_AGENTS) expect(seed.mcpServers, seed.id).toEqual(['repo-graph']);
    expect(V167_REPO_GRAPH_MCP_SERVERS).toBe('["repo-graph"]');
  });

  it('marca o repo-graph so no seed do Swarm sem nenhum MCP ([] , vazio ou NULL) e nao sobrescreve agente ja configurado', () => {
    const db = makeDb();
    insert(db, 'swarm-explorer', '[]');
    insert(db, 'swarm-auditor', '');
    insert(db, 'swarm-doc-validator', null);
    insert(db, 'swarm-researcher', '["knowledge-base"]');
    insert(db, 'swarm-secrets-scanner', '["repo-graph","skills"]');
    insert(db, 'swarm-custom-do-usuario', '[]');
    insert(db, 'dynamic-workflow-coder', '[]', 'workflow');
    insert(db, 'swarm-owasp-scanner', '[]', 'harness');
    const { updated } = apply(db);
    expect(updated.sort()).toEqual(['swarm-auditor', 'swarm-doc-validator', 'swarm-explorer']);
    expect(mcpOf(db, 'swarm-explorer')).toBe('["repo-graph"]');
    expect(mcpOf(db, 'swarm-auditor')).toBe('["repo-graph"]');
    expect(mcpOf(db, 'swarm-doc-validator')).toBe('["repo-graph"]');
    expect(mcpOf(db, 'swarm-researcher')).toBe('["knowledge-base"]');
    expect(mcpOf(db, 'swarm-secrets-scanner')).toBe('["repo-graph","skills"]');
    expect(mcpOf(db, 'swarm-custom-do-usuario')).toBe('[]');
    expect(mcpOf(db, 'dynamic-workflow-coder')).toBe('[]');
    expect(mcpOf(db, 'swarm-owasp-scanner')).toBe('[]');
  });

  it('e idempotente e tolera banco sem nenhum seed', () => {
    const db = makeDb();
    for (const id of SWARM_AGENT_IDS) insert(db, id, '[]');
    expect(apply(db).updated).toHaveLength(15);
    expect(apply(db).updated).toEqual([]);
    for (const id of SWARM_AGENT_IDS) expect(mcpOf(db, id)).toBe('["repo-graph"]');
    const empty = makeDb();
    expect(apply(empty).updated).toEqual([]);
  });
});
