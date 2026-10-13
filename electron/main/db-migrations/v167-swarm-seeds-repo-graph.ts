import type Database from 'better-sqlite3';
import { SWARM_SEED_AGENTS } from '../seed-agents/swarm-registry';

export const V167_REPO_GRAPH_MCP_SERVERS = JSON.stringify(['repo-graph']);

export function applyMigrationV167(db: Database.Database): { updated: string[] } {
  const update = db.prepare(
    `UPDATE agents SET mcp_servers = ? WHERE id = ? AND squad = 'swarm'
       AND (mcp_servers IS NULL OR TRIM(mcp_servers) IN ('', '[]'))`,
  );
  const updated: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const seed of SWARM_SEED_AGENTS) {
      const result = update.run(V167_REPO_GRAPH_MCP_SERVERS, seed.id) as { changes: number };
      if (result.changes > 0) updated.push(seed.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { updated };
}

export const __V167_INTERNAL = { SEED_IDS: SWARM_SEED_AGENTS.map((seed) => seed.id) };
