import type Database from 'better-sqlite3';

const PREVIOUS_SONNET_MODEL = 'claude-sonnet-4-6';
const NEW_SONNET_MODEL = 'claude-sonnet-5-5';
const PREVIOUS_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const NEW_HAIKU_MODEL = 'claude-haiku-5-5';

const SONNET_SEED_AGENT_IDS = [
  'arch-spec-validator',
  'architecture-decision-interviewer',
  'architecture-spec-enricher',
  'architecture-target-triage',
  'bug-spec-validator',
  'discovery-agent',
  'dynamic-workflow-closer',
  'dynamic-workflow-coder',
  'dynamic-workflow-doc-writer',
  'dynamic-workflow-fixer',
  'dynamic-workflow-maestro',
  'dynamic-workflow-narrator',
  'dynamic-workflow-refuter',
  'dynamic-workflow-scout',
  'feat-prd-completo',
  'feat-prd-generator',
  'feat-prd-validator',
  'feat-tech-backend',
  'feat-tech-database',
  'feat-tech-frontend',
  'feat-tech-security',
  'harness-coder',
  'harness-evaluator',
  'nextjs-developer',
  'pipe2-spec-enricher',
  'pipe2-spec-validator',
  'pipe2-tech-frontend',
  'prd-generator',
  'prd-validator',
  'security-auth-auditor',
  'security-deduplicator',
  'security-duplication-detector',
  'security-isolation-inspector',
  'security-logic-analyzer',
  'security-owasp-scanner',
  'security-secrets-scanner',
  'security-skeptic-quality',
  'security-spec-validator',
  'security-standards-checker',
  'skill-creator',
  'spec-builder',
  'spec-enricher',
  'spec-validator',
  'spec-validator-enrich',
  'sprint-validator',
  'tech-backend',
  'tech-database',
  'tech-frontend',
  'tech-security',
];

const HAIKU_SEED_AGENT_IDS = [
  'dynamic-workflow-plan-validator-coverage',
  'dynamic-workflow-plan-validator-criteria',
  'dynamic-workflow-plan-validator-topology',
  'dynamic-workflow-validator-regression',
  'dynamic-workflow-validator-spec',
  'dynamic-workflow-validator-tests',
  'repo-profiler',
  'security-resolution-tracker',
];

function promoteSeeds(db: Database.Database, ids: string[], previousModel: string, newModel: string): void {
  const idPlaceholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE agents
        SET model = ?
      WHERE id IN (${idPlaceholders})
        AND runtime = 'cloud'
        AND model = ?`,
  ).run(newModel, ...ids, previousModel);
}

export function applyMigrationV168(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    promoteSeeds(db, SONNET_SEED_AGENT_IDS, PREVIOUS_SONNET_MODEL, NEW_SONNET_MODEL);
    promoteSeeds(db, HAIKU_SEED_AGENT_IDS, PREVIOUS_HAIKU_MODEL, NEW_HAIKU_MODEL);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const __V168_INTERNAL = {
  PREVIOUS_SONNET_MODEL,
  NEW_SONNET_MODEL,
  PREVIOUS_HAIKU_MODEL,
  NEW_HAIKU_MODEL,
  SONNET_SEED_AGENT_IDS,
  HAIKU_SEED_AGENT_IDS,
};
