import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrationV165, __V165_INTERNAL } from '../db-migrations/v165-swarm-generic-roles';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import {
  SWARM_GENERIC_SEED_AGENTS,
  SWARM_SPECIALIZED_SEED_AGENTS,
  SWARM_SEED_AGENTS,
  SWARM_GENERIC_AGENT_IDS,
} from '../seed-agents/swarm-registry';
import { ALL_SEED_AGENTS } from '../seed-agents';
import { SWARM_CONTRACT } from '../seed-agents/_shared/swarm-contract';
import { SWARM_GENERIC_ROLE_IDS, isSwarmGenericRole } from '../swarm/generic-roles';

type V165Db = Parameters<typeof applyMigrationV165>[0];

interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  model: string;
  runtime: string;
  squad: string;
  allowed_tools: string;
  is_active: number;
  sort_order: number;
  codex_config: string | null;
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,description TEXT,system_prompt TEXT,model TEXT,allowed_tools TEXT,mcp_servers TEXT,is_active INTEGER,sort_order INTEGER,effort TEXT,thinking TEXT,thinking_budget INTEGER,max_turns INTEGER,skills TEXT,runtime TEXT,max_tool_rounds INTEGER,squad TEXT,codex_config TEXT)',
  );
  return db;
}

function insertAgent(db: DatabaseSync, row: Partial<AgentRow> & { id: string }): void {
  db.prepare(
    'INSERT INTO agents (id,name,description,system_prompt,model,allowed_tools,mcp_servers,is_active,sort_order,effort,thinking,thinking_budget,max_turns,skills,runtime,max_tool_rounds,squad,codex_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    row.id,
    row.name ?? row.id,
    'desc',
    row.system_prompt ?? 'custom prompt',
    row.model ?? 'custom-model',
    row.allowed_tools ?? '["Read"]',
    '[]',
    row.is_active ?? 1,
    row.sort_order ?? 7,
    'high',
    'adaptive',
    0,
    80,
    '[]',
    row.runtime ?? 'kimi',
    50,
    row.squad ?? 'swarm',
    row.codex_config ?? null,
  );
}

function rows(db: DatabaseSync): AgentRow[] {
  return db.prepare('SELECT * FROM agents ORDER BY id').all() as unknown as AgentRow[];
}

function apply(db: DatabaseSync): void {
  applyMigrationV165(db as unknown as V165Db);
}

describe('migration v165 - papeis genericos do Swarm v2', () => {
  it('LATEST_SCHEMA_VERSION e 167 (V166 e V167 vem depois da V165)', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(169);
  });

  it('os quatro seeds genericos existem no registry, nos seeds do boot, em cloud + Opus 5.5, com contrato e regra do briefing', () => {
    expect(__V165_INTERNAL.SEED_IDS).toEqual([...SWARM_GENERIC_ROLE_IDS]);
    expect(SWARM_GENERIC_AGENT_IDS).toEqual([...SWARM_GENERIC_ROLE_IDS]);
    expect(SWARM_GENERIC_SEED_AGENTS).toHaveLength(4);
    expect(SWARM_SPECIALIZED_SEED_AGENTS).toHaveLength(11);
    expect(SWARM_SEED_AGENTS.slice(0, 4)).toEqual(SWARM_GENERIC_SEED_AGENTS);
    for (const seed of SWARM_GENERIC_SEED_AGENTS) {
      expect(isSwarmGenericRole(seed.id)).toBe(true);
      expect(ALL_SEED_AGENTS.filter((agent) => agent.id === seed.id)).toHaveLength(1);
      expect(seed.runtime).toBe('cloud');
      expect(seed.model).toBe(CLAUDE_DEFAULT_MODEL);
      expect(seed.squad).toBe('swarm');
      expect(seed.isActive).toBe(true);
      expect(seed.codexConfig).toBeUndefined();
      expect(seed.systemPrompt.endsWith(SWARM_CONTRACT)).toBe(true);
      expect(seed.systemPrompt).toContain('O briefing do orquestrador e o seu trabalho');
      expect(seed.systemPrompt).toContain('Pergunte: STATUS: needs-input + QUESTION');
      const rolePart = seed.systemPrompt.slice(0, seed.systemPrompt.length - SWARM_CONTRACT.length - 2);
      expect(seed.systemPrompt).toBe(`${rolePart}\n\n${SWARM_CONTRACT}`);
      expect(rolePart.length).toBeLessThanOrEqual(450);
      expect(rolePart).not.toMatch(/READ-ONLY|arquivo:linha|trailer|Nunca altere/i);
      expect(seed.systemPrompt).not.toMatch(/EXCLUSIVAMENTE/);
      expect(seed.allowedTools).not.toContain('Bash');
      expect(seed.allowedTools).toContain('Write');
    }
    for (const seed of SWARM_SPECIALIZED_SEED_AGENTS) expect(isSwarmGenericRole(seed.id)).toBe(false);
    const researcher = SWARM_GENERIC_SEED_AGENTS.find((seed) => seed.id === 'swarm-researcher')!;
    expect(researcher.allowedTools).toEqual(['WebSearch', 'WebFetch', 'Write']);
    for (const seed of SWARM_GENERIC_SEED_AGENTS.filter((s) => s.id !== 'swarm-researcher'))
      expect(seed.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Write']);
  });

  it('AC-5: insere os quatro seeds num banco que ja tem o esquadrao Swarm sem tocar nos agentes existentes', () => {
    const db = makeDb();
    for (const seed of SWARM_SPECIALIZED_SEED_AGENTS)
      insertAgent(db, { id: seed.id, runtime: 'cloud', model: 'claude-opus-5-5', system_prompt: seed.systemPrompt });
    insertAgent(db, { id: 'swarm-auth-auditor-custom', runtime: 'codex', model: 'gpt-6-luna', codex_config: '{}' });
    insertAgent(db, { id: 'dynamic-workflow-coder', squad: 'workflow', runtime: 'codex', model: 'gpt-6-sol' });
    const before = rows(db);
    apply(db);
    const after = rows(db);
    expect(after).toHaveLength(before.length + 4);
    for (const row of before) expect(after.find((r) => r.id === row.id)).toEqual(row);
    for (const seed of SWARM_GENERIC_SEED_AGENTS) {
      const row = after.find((r) => r.id === seed.id)!;
      expect(row).toMatchObject({
        name: seed.name,
        system_prompt: seed.systemPrompt,
        model: CLAUDE_DEFAULT_MODEL,
        runtime: 'cloud',
        squad: 'swarm',
        is_active: 1,
        sort_order: 0,
        codex_config: null,
        allowed_tools: JSON.stringify(seed.allowedTools),
      });
    }
  });

  it('e idempotente e preserva um agente que o usuario ja tinha com o mesmo id', () => {
    const db = makeDb();
    insertAgent(db, { id: 'swarm-auditor', runtime: 'kimi', model: 'kimi-k3', system_prompt: 'meu auditor' });
    apply(db);
    const first = rows(db);
    expect(first).toHaveLength(4);
    expect(first.find((r) => r.id === 'swarm-auditor')).toMatchObject({
      runtime: 'kimi',
      model: 'kimi-k3',
      system_prompt: 'meu auditor',
    });
    apply(db);
    expect(rows(db)).toEqual(first);
  });

  it('segue o padrao da V153: INSERT OR IGNORE; a protecao contra recriar seed apagado e a schema_version que roda a migration uma unica vez', () => {
    const db = makeDb();
    apply(db);
    db.prepare("DELETE FROM agents WHERE id='swarm-explorer'").run();
    expect(rows(db).map((r) => r.id)).not.toContain('swarm-explorer');
    apply(db);
    expect(rows(db).map((r) => r.id)).toContain('swarm-explorer');
  });
});
