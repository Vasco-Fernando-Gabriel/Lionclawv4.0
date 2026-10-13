import type Database from 'better-sqlite3';
import { SWARM_GENERIC_SEED_AGENTS } from '../seed-agents/swarm-registry';

export function applyMigrationV165(db: Database.Database): void {
  const seedInsert = db.prepare(`INSERT OR IGNORE INTO agents (
      id,name,description,system_prompt,model,allowed_tools,mcp_servers,is_active,sort_order,
      effort,thinking,thinking_budget,max_turns,skills,runtime,max_tool_rounds,squad,codex_config
    ) VALUES (@id,@name,@description,@system_prompt,@model,@allowed_tools,@mcp_servers,@is_active,0,
      @effort,@thinking,@thinking_budget,@max_turns,@skills,@runtime,@max_tool_rounds,@squad,@codex_config)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const seed of SWARM_GENERIC_SEED_AGENTS)
      seedInsert.run({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        system_prompt: seed.systemPrompt,
        model: seed.model,
        allowed_tools: JSON.stringify(seed.allowedTools),
        mcp_servers: JSON.stringify(seed.mcpServers),
        is_active: seed.isActive ? 1 : 0,
        effort: seed.effort,
        thinking: seed.thinking,
        thinking_budget: seed.thinkingBudget ?? 0,
        max_turns: seed.maxTurns,
        skills: JSON.stringify(seed.skills),
        runtime: seed.runtime,
        max_tool_rounds: seed.maxToolRounds,
        squad: seed.squad,
        codex_config: seed.codexConfig ? JSON.stringify(seed.codexConfig) : null,
      });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const __V165_INTERNAL = { SEED_IDS: SWARM_GENERIC_SEED_AGENTS.map((seed) => seed.id) };
