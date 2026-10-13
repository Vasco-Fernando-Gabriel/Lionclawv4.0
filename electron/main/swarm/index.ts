import path from 'node:path';
import { DEFAULT_SWARM_SETTINGS, type SwarmSettings } from '../../../src/types/swarm';
import {
  getSetting,
  setSetting,
  insertAuditEntry,
  upsertSwarmRunIndex,
  enqueueSwarmDelivery,
  getSwarmDelivery,
  reserveSwarmDelivery,
  renewSwarmDeliveryLeases,
  releaseSwarmDeliveryReservations,
  consumeSwarmDelivery,
  cancelSwarmDelivery,
} from '../db';
import { getLionClawHome } from '../paths';
import { createLogger } from '../logger';
import { configureSwarmCodexSessionCap } from '../codex-runtime/swarm-session-guard';
import { SwarmArtifacts } from './artifacts';
import { SwarmRunner } from './runner';
import { validateSwarmSettings } from './validation';

const logger = createLogger('swarm');
const keys: Record<keyof SwarmSettings, string> = {
  concurrencyCap: 'swarm_concurrency_cap',
  maxAttempts: 'swarm_max_attempts',
  idleTimeoutMs: 'swarm_idle_timeout_ms',
  hardTimeoutMs: 'swarm_hard_timeout_ms',
  openWindowMs: 'swarm_open_window_ms',
};
let singleton: SwarmRunner | undefined;
export function getSwarmService(): SwarmRunner {
  if (singleton) return singleton;
  singleton = new SwarmRunner({
    artifacts: new SwarmArtifacts(path.join(getLionClawHome(), 'artifacts', 'swarm')),
    resolve: async (member, cwd) => (await import('../agent-runtime/swarm-adapter')).resolveSwarmMember(member, cwd),
    execute: async (request) => (await import('../agent-runtime/swarm-adapter')).executeSwarmAttempt(request),
    closeSession: async (run, item) =>
      (await import('../agent-runtime/swarm-adapter')).closeSwarmSession(run.runId, item.slug),
    pinSession: async (run, item, pinned) =>
      (await import('../agent-runtime/swarm-adapter')).pinSwarmSession(run.runId, item.slug, pinned),
    catalog: async () => (await import('../agent-runtime/swarm-adapter')).getSwarmCatalog(),
    recoverAttempt: async (run, item, attempt) =>
      (await import('../agent-runtime/swarm-adapter')).recoverSwarmAttempt({
        runId: run.runId,
        slug: item.slug,
        attemptId: attempt.id,
        runtime: item.runtime,
      }),
    readSettings: () => {
      const settings = { ...DEFAULT_SWARM_SETTINGS };
      for (const key of Object.keys(keys) as Array<keyof SwarmSettings>) {
        const stored = getSetting(keys[key]);
        if (stored != null) settings[key] = Number(stored);
      }
      const valid = validateSwarmSettings(settings);
      configureSwarmCodexSessionCap(valid.concurrencyCap);
      return valid;
    },
    writeSettings: (settings) => {
      const valid = validateSwarmSettings(settings);
      for (const key of Object.keys(keys) as Array<keyof SwarmSettings>) setSetting(keys[key], String(valid[key]));
      configureSwarmCodexSessionCap(valid.concurrencyCap);
    },
    audit: (event) => {
      insertAuditEntry({
        sessionId: event.sessionId,
        eventType: 'tool_call',
        toolName: `swarm_${event.action}`,
        input: JSON.stringify({ runId: event.runId, itemCount: event.itemCount }),
        output: 'accepted',
      });
    },
    project: (summary) => upsertSwarmRunIndex(summary),
    deliveryState: (run, kind, revision) => getSwarmDelivery(run.runId, kind, revision),
    deliver: (run, envelope, descriptor) => {
      enqueueSwarmDelivery({
        runId: run.runId,
        kind: descriptor.kind,
        revision: descriptor.revision,
        sessionId: run.chatSessionId,
        envelope,
        runStatus: run.status,
        slug: descriptor.slug,
        attemptId: descriptor.attemptId,
        reservedBy: descriptor.reservedBy,
        leaseUntil: descriptor.leaseUntil,
      });
    },
    reserveDelivery: (run, kind, revision, waitId, leaseUntil) =>
      reserveSwarmDelivery(run.runId, kind, revision, waitId, leaseUntil),
    renewDeliveryLease: (waitId, leaseUntil) => {
      renewSwarmDeliveryLeases(waitId, leaseUntil);
    },
    releaseDeliveryReservation: (waitId) => {
      releaseSwarmDeliveryReservations(waitId);
    },
    consumeDelivery: (run, kind, revision, waitId, turnId) =>
      consumeSwarmDelivery(run.runId, kind, revision, waitId, turnId),
    cancelDelivery: (run, kind, revision, reason) => {
      cancelSwarmDelivery(run.runId, kind, revision, reason);
    },
    reportError: (error, context) =>
      logger.error({ error: error instanceof Error ? error.message : String(error) }, context),
  });
  return singleton;
}
export { SwarmDomainError } from './validation';
