import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const bridge = vi.hoisted(() => ({
  getCodexBinaryStatus: vi.fn().mockResolvedValue({
    installed: true,
    version: '0.140.0',
    authenticated: true,
    appServerSupported: true,
    binaryPath: '/usr/local/bin/codex',
  }),
  isCodexAvailable: vi.fn().mockResolvedValue({ installed: true, version: '0.140.0', authenticated: true }),
  CodexUnavailableError: class CodexUnavailableError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'CodexUnavailableError';
    }
  },
  CodexAuthError: class CodexAuthError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'CodexAuthError';
    }
  },
}));
vi.mock('../binary', () => ({
  getCodexBinaryStatus: bridge.getCodexBinaryStatus,
  isCodexAvailable: bridge.isCodexAvailable,
}));
vi.mock('../errors', () => ({
  CodexUnavailableError: bridge.CodexUnavailableError,
  CodexAuthError: bridge.CodexAuthError,
}));
vi.mock('../windows-preflight', () => ({
  runOfficialPreFlight: vi.fn().mockReturnValue({ status: 'not-windows' }),
  resetOfficialPreparedRepos: vi.fn(),
}));
vi.mock('../../app-version', () => ({ getAppVersion: () => '9.9.9' }));

import {
  OfficialAppServerDriver,
  type AppServerTransport,
  type AppServerTransportFactory,
} from '../official-app-server-driver';
import type { AppServerEvent } from '../official-event-translator';
import type { CodexRunHandle, CodexRunOptions, CodexRunSessionKey } from '../types';
import {
  CodexLifecycleRegistry,
  MAX_LIVE_OFFICIAL_APP_SERVERS,
  OFFICIAL_APP_SERVER_IDLE_REAP_MS,
  OFFICIAL_APP_SERVER_IDLE_SWEEP_MS,
} from '../lifecycle-registry';
import {
  __resetSwarmCodexGuardForTests,
  SWARM_CODEX_SESSION_CAP_EXTRA,
  configureSwarmCodexSessionCap,
  pinSwarmCodexScope,
  protectSwarmCodexScope,
  releaseSwarmCodexScope,
  swarmCodexOwnerId,
  swarmCodexSessionCap,
} from '../swarm-session-guard';

class FakeTransport implements AppServerTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public readonly notifications: Array<{ method: string; params?: unknown }> = [];
  public killed: string[] = [];
  private notificationHandlers = new Set<(e: AppServerEvent) => void>();
  private errorHandlers = new Set<(e: Error) => void>();
  private exited = false;
  public turnScript: AppServerEvent[] | null = null;
  constructor(private readonly threadId: string) {}
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { threadId: this.threadId };
    if (method === 'turn/start') {
      if (this.turnScript) {
        const script = this.turnScript;
        this.turnScript = null;
        queueMicrotask(() => {
          for (const e of script) this.emit(e);
        });
      }
      return { turnId: 'turn-fake-1' };
    }
    return {};
  }
  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }
  onNotification(handler: (e: AppServerEvent) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }
  onError(handler: (e: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
  kill(reason: string): void {
    this.killed.push(reason);
    this.exited = true;
  }
  async waitClosed(): Promise<boolean> {
    return this.exited;
  }
  emit(event: AppServerEvent): void {
    for (const h of [...this.notificationHandlers]) h(event);
  }
}
const COMPLETED: AppServerEvent[] = [
  { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
  { method: 'turn/completed', params: { status: 'completed' } },
];
const RUN_ID = 'swarm-20261011_120000-abc123';
function swarmKey(slug: string, generation = 1): CodexRunSessionKey {
  return {
    surface: 'pipeline',
    ownerKind: 'swarm',
    mcpProfile: 'pipeline',
    runId: `s9-${slug}-${generation}`,
    ownerId: swarmCodexOwnerId({ runId: RUN_ID, slug, generation }),
  };
}
function pipelineKey(runId: string): CodexRunSessionKey {
  return { surface: 'pipeline', ownerKind: 'pipeline', mcpProfile: 'pipeline', runId, projectId: 'p1' };
}
function opts(key: CodexRunSessionKey): CodexRunOptions {
  return {
    key,
    model: 'gpt-5-codex',
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    reasoningEffort: 'high',
    timeoutMs: 7_200_000,
    disableGlobalMcp: false,
  };
}
function recordingDriver(): { driver: OfficialAppServerDriver; transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];
  const factory: AppServerTransportFactory = async () => {
    const t = new FakeTransport(`thread-${transports.length + 1}`);
    transports.push(t);
    return t;
  };
  return { driver: new OfficialAppServerDriver(factory), transports };
}
async function runTurn(
  driver: OfficialAppServerDriver,
  transports: FakeTransport[],
  key: CodexRunSessionKey,
): Promise<{ handle: CodexRunHandle; transport: FakeTransport }> {
  const before = transports.length;
  const handle = await driver.createRun(opts(key));
  const transport = transports[before];
  transport.turnScript = COMPLETED;
  await handle.send('go');
  expect(handle.status).toBe('completed');
  return { handle, transport };
}

beforeEach(() => {
  __resetSwarmCodexGuardForTests();
});
afterEach(() => {
  vi.useRealTimers();
  __resetSwarmCodexGuardForTests();
});

describe('Swarm v2 S3-V1: sessao Codex de swarm agent isenta do reap do registry de lifecycle', () => {
  it('duas sessoes de swarm agents distintos coexistem, sobrevivem ao createRun de outro escopo e a 120 s ociosas com a run open; fecham quando a run fecha', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const { driver, transports } = recordingDriver();
    const a = swarmKey('auditor');
    const b = swarmKey('explorer');
    protectSwarmCodexScope(a.ownerId!);
    protectSwarmCodexScope(b.ownerId!);
    const first = await runTurn(driver, transports, a);
    const second = await runTurn(driver, transports, b);
    expect(first.transport.killed).toEqual([]);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: a.ownerId })).toBe(true);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: b.ownerId })).toBe(true);
    await runTurn(driver, transports, pipelineKey('phase-1'));
    await runTurn(driver, transports, pipelineKey('phase-2'));
    expect(first.transport.killed).toEqual([]);
    expect(second.transport.killed).toEqual([]);
    expect(transports[2].killed.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(OFFICIAL_APP_SERVER_IDLE_REAP_MS + OFFICIAL_APP_SERVER_IDLE_SWEEP_MS * 2);
    expect(first.transport.killed).toEqual([]);
    expect(second.transport.killed).toEqual([]);
    expect(transports[3].killed.length).toBeGreaterThan(0);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: a.ownerId })).toBe(true);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: b.ownerId })).toBe(true);
    releaseSwarmCodexScope(a.ownerId!);
    releaseSwarmCodexScope(b.ownerId!);
    await first.handle.close();
    await second.handle.close();
    expect(first.transport.killed.length).toBeGreaterThan(0);
    expect(second.transport.killed.length).toBeGreaterThan(0);
    expect(driver.hasActiveRun({ ownerKind: 'swarm' })).toBe(false);
    await driver.shutdown();
  });
  it('sem a protecao (run fechada sem fechar a sessao) o reaper ocioso volta a valer para o swarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const { driver, transports } = recordingDriver();
    const a = swarmKey('orfao');
    const { transport } = await runTurn(driver, transports, a);
    await vi.advanceTimersByTimeAsync(OFFICIAL_APP_SERVER_IDLE_REAP_MS + OFFICIAL_APP_SERVER_IDLE_SWEEP_MS * 2);
    expect(transport.killed.length).toBeGreaterThan(0);
    await driver.shutdown();
  });
  it('reapForCap: sessoes de swarm protegidas ficam FORA do teto global de 6 e nunca sao ceifadas enquanto pinned (waiting)', () => {
    const registry = new CodexLifecycleRegistry();
    const handles: CodexRunHandle[] = [];
    const add = (key: CodexRunSessionKey, createdAt: number) => {
      const handle = fakeHandle(key, createdAt);
      registry.register(key, handle);
      handles.push(handle);
      return handle;
    };
    const waiting = swarmKey('waiting');
    const idle = swarmKey('idle');
    protectSwarmCodexScope(waiting.ownerId!);
    protectSwarmCodexScope(idle.ownerId!);
    pinSwarmCodexScope(waiting.ownerId!, true);
    const now = 1_000_000;
    const pinned = add(waiting, now - 10_000);
    const protectedIdle = add(idle, now - 9_000);
    const pipelines = Array.from({ length: MAX_LIVE_OFFICIAL_APP_SERVERS - 2 }, (_, i) =>
      add(pipelineKey(`pipe-${i}`), now - 5_000 + i),
    );
    expect(registry.liveCount()).toBe(MAX_LIVE_OFFICIAL_APP_SERVERS);
    expect(registry.liveUnshieldedCount()).toBe(MAX_LIVE_OFFICIAL_APP_SERVERS - 2);
    expect(registry.liveSwarmShieldedCount()).toBe(2);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now)).toEqual([]);
    expect(registry.reapSameScope(pipelineKey('pipe-new'))).toEqual(pipelines);
    expect(registry.liveCount()).toBe(2);
    expect(registry.reapForCap(1, now)).toEqual([]);
    expect(registry.reapForCap(1, now, 2)).toEqual([]);
    expect(registry.reapForCap(1, now, 2, swarmKey('novo'))).toEqual([protectedIdle]);
    expect(registry.reapForCap(1, now, 1, swarmKey('novo'))).toEqual([]);
    expect(registry.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, now + 1_000_000)).toEqual([]);
    pinSwarmCodexScope(waiting.ownerId!, false);
    expect(registry.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, now + 1_000_000)).toEqual([]);
    releaseSwarmCodexScope(waiting.ownerId!);
    expect(registry.reapIdle(OFFICIAL_APP_SERVER_IDLE_REAP_MS, now + 1_000_000)).toEqual([pinned]);
    expect(registry.liveCount()).toBe(0);
  });
});

function fakeHandle(
  key: CodexRunSessionKey,
  createdAt: number,
  status: CodexRunHandle['status'] = 'completed',
): CodexRunHandle {
  return {
    key,
    implementation: 'official-app-server' as const,
    sessionId: 's',
    threadId: `t-${key.runId}`,
    turnId: null,
    status,
    createdAt,
    lastActivityAt: createdAt,
    hasStartedTurn: true,
    send: vi.fn(),
    reply: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(async () => {}),
    waitClosed: vi.fn(async () => true),
    forceKillFallback: vi.fn(async () => {}),
  } as unknown as CodexRunHandle;
}

describe('Swarm v2 S3-R1: sessoes de swarm protegidas fora do teto de 6; teto proprio = swarm_concurrency_cap + 2', () => {
  it('o teto padrao do swarm e 5 + 2 e acompanha swarm_concurrency_cap', () => {
    expect(SWARM_CODEX_SESSION_CAP_EXTRA).toBe(2);
    expect(swarmCodexSessionCap()).toBe(7);
    expect(configureSwarmCodexSessionCap(3)).toBe(5);
    expect(swarmCodexSessionCap()).toBe(5);
    expect(configureSwarmCodexSessionCap(0)).toBe(7);
  });
  it('seis handles fora do swarm + duas sessoes protegidas: o teto global ceifa so a pipeline mais antiga e nunca o swarm', () => {
    const registry = new CodexLifecycleRegistry();
    const now = 1_000_000;
    const a = swarmKey('auditor');
    const b = swarmKey('explorer');
    protectSwarmCodexScope(a.ownerId!);
    protectSwarmCodexScope(b.ownerId!);
    const swarmA = fakeHandle(a, now - 50_000);
    const swarmB = fakeHandle(b, now - 40_000);
    registry.register(a, swarmA);
    registry.register(b, swarmB);
    const pipelines = Array.from({ length: MAX_LIVE_OFFICIAL_APP_SERVERS }, (_, i) => {
      const key = pipelineKey(`pipe-${i}`);
      const handle = fakeHandle(key, now - 10_000 + i);
      registry.register(key, handle);
      return handle;
    });
    expect(registry.liveCount()).toBe(MAX_LIVE_OFFICIAL_APP_SERVERS + 2);
    const reaped = registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now);
    expect(reaped).toEqual([pipelines[0]]);
    expect(registry.liveUnshieldedCount()).toBe(MAX_LIVE_OFFICIAL_APP_SERVERS - 1);
    expect(registry.liveSwarmShieldedCount()).toBe(2);
    expect(registry.get(a)).toBe(swarmA);
    expect(registry.get(b)).toBe(swarmB);
  });
  it('acima de swarm_concurrency_cap + 2 as sessoes open sao fechadas da mais antiga para a mais nova, nunca waiting (pinned) nem running', () => {
    configureSwarmCodexSessionCap(5);
    const registry = new CodexLifecycleRegistry();
    const now = 1_000_000;
    const keys = Array.from({ length: 9 }, (_, i) => swarmKey(`agent-${i}`));
    for (const key of keys) protectSwarmCodexScope(key.ownerId!);
    pinSwarmCodexScope(keys[0].ownerId!, true);
    const handles = keys.map((key, i) => fakeHandle(key, now - 100_000 + i * 1_000, i === 1 ? 'running' : 'completed'));
    handles.forEach((handle, i) => registry.register(keys[i], handle));
    expect(registry.liveSwarmShieldedCount()).toBe(9);
    const reaped = registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now, undefined, pipelineKey('fase'));
    expect(reaped).toEqual([handles[2], handles[3]]);
    expect(registry.liveSwarmShieldedCount()).toBe(7);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now)).toEqual([]);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now, undefined, pipelineKey('outra'))).toEqual([]);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now, undefined, swarmKey('novo'))).toEqual([handles[4]]);
    expect(registry.liveSwarmShieldedCount()).toBe(6);
    expect(registry.get(keys[0])).toBe(handles[0]);
    expect(registry.get(keys[1])).toBe(handles[1]);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now, undefined, swarmKey('outro'))).toEqual([]);
  });
  it('S4-V3: o teto efetivo em repouso e o configurado (7 vivas com teto 7 ficam) e so a chegada de um swarm agent abre a vaga', () => {
    configureSwarmCodexSessionCap(5);
    const registry = new CodexLifecycleRegistry();
    const now = 1_000_000;
    const keys = Array.from({ length: 7 }, (_, i) => swarmKey(`agent-${i}`));
    for (const key of keys) protectSwarmCodexScope(key.ownerId!);
    const handles = keys.map((key, i) => fakeHandle(key, now - 100_000 + i * 1_000));
    handles.forEach((handle, i) => registry.register(keys[i], handle));
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now, undefined, pipelineKey('fase'))).toEqual([]);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now)).toEqual([]);
    expect(registry.liveSwarmShieldedCount()).toBe(7);
    expect(registry.reapForCap(MAX_LIVE_OFFICIAL_APP_SERVERS, now, undefined, swarmKey('novo'))).toEqual([handles[0]]);
    expect(registry.liveSwarmShieldedCount()).toBe(6);
  });
  it('registry e driver reais: o createRun de um swarm agent acima do teto do swarm fecha a sessao open mais antiga e preserva a pinned', async () => {
    configureSwarmCodexSessionCap(1);
    const { driver, transports } = recordingDriver();
    const keys = ['a', 'b', 'c', 'd'].map((slug) => swarmKey(slug));
    for (const key of keys) protectSwarmCodexScope(key.ownerId!);
    const first = await runTurn(driver, transports, keys[0]);
    pinSwarmCodexScope(keys[0].ownerId!, true);
    const second = await runTurn(driver, transports, keys[1]);
    const third = await runTurn(driver, transports, keys[2]);
    expect(first.transport.killed).toEqual([]);
    expect(second.transport.killed).toEqual([]);
    expect(third.transport.killed).toEqual([]);
    await runTurn(driver, transports, keys[3]);
    expect(first.transport.killed).toEqual([]);
    expect(second.transport.killed.length).toBeGreaterThan(0);
    expect(third.transport.killed).toEqual([]);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: keys[0].ownerId })).toBe(true);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: keys[1].ownerId })).toBe(false);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: keys[2].ownerId })).toBe(true);
    expect(driver.hasActiveRun({ ownerKind: 'swarm', ownerId: keys[3].ownerId })).toBe(true);
    await driver.shutdown();
  });
});
