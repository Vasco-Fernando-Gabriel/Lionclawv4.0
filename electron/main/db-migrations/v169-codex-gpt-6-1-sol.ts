import type Database from 'better-sqlite3';

const CODER_CODEX_SEED_ID = 'dynamic-workflow-coder-codex';
const PREVIOUS_SEED_MODEL = 'gpt-6-sol';
const NEW_MODEL = 'gpt-6.1-sol';
const RETIRED_CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];

export function applyMigrationV169(db: Database.Database): void {
  const retiredPlaceholders = RETIRED_CODEX_MODELS.map(() => '?').join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE agents
          SET model = ?,
              codex_config = json_set(codex_config, '$.model', ?)
        WHERE id = ?
          AND model = ?
          AND codex_config IS NOT NULL
          AND json_valid(codex_config)
          AND json_extract(codex_config, '$.model') = ?`,
    ).run(NEW_MODEL, NEW_MODEL, CODER_CODEX_SEED_ID, PREVIOUS_SEED_MODEL, PREVIOUS_SEED_MODEL);

    db.prepare(
      `UPDATE agents
          SET model = ?,
              codex_config = json_set(codex_config, '$.model', ?)
        WHERE runtime = 'codex'
          AND model IN (${retiredPlaceholders})
          AND codex_config IS NOT NULL
          AND json_valid(codex_config)`,
    ).run(NEW_MODEL, NEW_MODEL, ...RETIRED_CODEX_MODELS);

    db.prepare(
      `UPDATE agents
          SET model = ?
        WHERE runtime = 'codex'
          AND model IN (${retiredPlaceholders})
          AND (codex_config IS NULL OR NOT json_valid(codex_config))`,
    ).run(NEW_MODEL, ...RETIRED_CODEX_MODELS);

    db.prepare(
      `UPDATE settings
          SET value = ?
        WHERE key = 'orchestrator_model'
          AND value IN (${retiredPlaceholders})
          AND EXISTS (
            SELECT 1 FROM settings runtime
             WHERE runtime.key = 'orchestrator_runtime'
               AND runtime.value = 'codex-sdk'
          )`,
    ).run(NEW_MODEL, ...RETIRED_CODEX_MODELS);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const __V169_INTERNAL = { CODER_CODEX_SEED_ID, PREVIOUS_SEED_MODEL, NEW_MODEL, RETIRED_CODEX_MODELS };
