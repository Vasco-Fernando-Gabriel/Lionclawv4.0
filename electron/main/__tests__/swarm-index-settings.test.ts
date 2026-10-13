import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  home: '',
}));
vi.mock('../db', () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    state.settings.set(key, value);
  },
  insertAuditEntry: vi.fn(),
  upsertSwarmRunIndex: vi.fn(),
  enqueueSwarmDelivery: vi.fn(),
  getSwarmDelivery: vi.fn(),
  reserveSwarmDelivery: vi.fn(),
  renewSwarmDeliveryLeases: vi.fn(),
  releaseSwarmDeliveryReservations: vi.fn(),
  consumeSwarmDelivery: vi.fn(),
  cancelSwarmDelivery: vi.fn(),
}));
vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getSwarmService } from '../swarm/index';
import { DEFAULT_SWARM_SETTINGS } from '../../../src/types/swarm';
import { __resetSwarmCodexGuardForTests, swarmCodexSessionCap } from '../codex-runtime/swarm-session-guard';

beforeEach(() => {
  __resetSwarmCodexGuardForTests();
  state.settings.clear();
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-index-settings-'));
});
afterEach(() => {
  fs.rmSync(state.home, { recursive: true, force: true });
});

describe('Swarm v2 S4 (S3-R1, S4-V6): o teto das sessoes Codex de swarm acompanha swarm_concurrency_cap pelas settings', () => {
  it('ler as settings configura o teto = concurrencyCap + 2 e gravar as settings reconfigura', () => {
    expect(swarmCodexSessionCap()).toBe(7);
    const service = getSwarmService();
    state.settings.set('swarm_concurrency_cap', '3');
    expect(service.getSettings().concurrencyCap).toBe(3);
    expect(swarmCodexSessionCap()).toBe(5);
    service.setSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 4 });
    expect(state.settings.get('swarm_concurrency_cap')).toBe('4');
    expect(swarmCodexSessionCap()).toBe(6);
    expect(service.getSettings().concurrencyCap).toBe(4);
    expect(swarmCodexSessionCap()).toBe(6);
  });
});
