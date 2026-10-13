import type Database from 'better-sqlite3';

const NEW_RUNTIME = 'cloud';
const NEW_MODEL = 'claude-opus-5-5';

const PREVIOUS_SEED_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['codex', 'gpt-6-sol'],
  ['codex', 'gpt-6-astra'],
  ['kimi', 'kimi-code/kimi-for-coding'],
  ['zai', 'glm-4.7'],
  ['cloud', 'claude-opus-4-7'],
];

const SWARM_SEED_AGENT_IDS = [
  'swarm-secrets-scanner',
  'swarm-auth-auditor',
  'swarm-owasp-scanner',
  'swarm-isolation-inspector',
  'swarm-spec-coverage-validator',
  'swarm-doc-drift-detector',
  'swarm-contract-checker',
  'swarm-test-coverage-analyst',
  'swarm-web-researcher',
  'swarm-code-explorer',
  'swarm-bug-hypothesis-hunter',
];

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function applyMigrationV164(db: Database.Database): void {
  const idPlaceholders = SWARM_SEED_AGENT_IDS.map(() => '?').join(', ');
  const clearCodexConfig = hasColumn(db, 'agents', 'codex_config') ? ', codex_config = NULL' : '';
  const update = db.prepare(
    `UPDATE agents
        SET runtime = ?, model = ?${clearCodexConfig}
      WHERE squad = 'swarm'
        AND id IN (${idPlaceholders})
        AND runtime = ?
        AND model = ?`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [runtime, model] of PREVIOUS_SEED_DEFAULTS) {
      update.run(NEW_RUNTIME, NEW_MODEL, ...SWARM_SEED_AGENT_IDS, runtime, model);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const __V164_INTERNAL = { NEW_RUNTIME, NEW_MODEL, PREVIOUS_SEED_DEFAULTS, SWARM_SEED_AGENT_IDS };
