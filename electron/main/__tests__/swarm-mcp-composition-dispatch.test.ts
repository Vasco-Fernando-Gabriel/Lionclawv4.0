import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ServerRow {
  id: string;
  name: string;
  description: string | null;
  command: string;
  args: string;
  env_keys: string;
  is_active: number;
  visible_to: 'all' | 'codex-lion-only';
  index_mode: 'tools' | 'server';
}

function serverRow(id: string, visibleTo: 'all' | 'codex-lion-only' = 'all'): ServerRow {
  return {
    id,
    name: `Server ${id}`,
    description: null,
    command: 'node',
    args: JSON.stringify([`/path/${id}.js`]),
    env_keys: '[]',
    is_active: 1,
    visible_to: visibleTo,
    index_mode: 'tools',
  };
}

const domain = vi.hoisted(() => ({
  catalog: vi.fn(async () => ({ members: [], profiles: [], runtimes: [] })),
  start: vi.fn(async () => ({ runId: 'accepted' })),
  list: vi.fn(async () => ({ runs: [] })),
  read: vi.fn(async () => ({ slug: 'a', status: 'ok' })),
  stop: vi.fn(async () => ({ changed: true, status: 'stopping' })),
  inspect: vi.fn(async () => ({ runId: 'r' })),
  message: vi.fn(async () => ({ accepted: true })),
  redispatch: vi.fn(async () => ({ accepted: true })),
  wait: vi.fn(async () => ({ status: 'done' })),
  activity: vi.fn(),
}));
vi.mock('../swarm', () => ({
  getSwarmService: () => ({
    getCatalog: domain.catalog,
    start: domain.start,
    listRuns: domain.list,
    read: domain.read,
    stop: domain.stop,
    getRunState: domain.inspect,
    message: domain.message,
    redispatch: domain.redispatch,
    wait: domain.wait,
  }),
}));
const state = vi.hoisted(() => ({
  servers: [] as Array<Record<string, unknown>>,
  agents: new Map<string, string>(), // agentId -> mcp_servers JSON
  settings: new Map<string, string>(),
}));

vi.mock('../db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('FROM mcp_servers')) return state.servers;
        return [];
      },
      get: (...args: unknown[]) => {
        if (sql.includes('FROM agents')) {
          const id = args[0] as string;
          const mcp = state.agents.get(id);
          return mcp !== undefined ? { mcp_servers: mcp } : undefined;
        }
        if (sql.includes('FROM mcp_servers WHERE id')) {
          return state.servers.find((s) => s['id'] === args[0]);
        }
        return undefined;
      },
      run: () => undefined,
    }),
    transaction:
      (fn: (...a: unknown[]) => unknown) =>
      (...a: unknown[]) =>
        fn(...a),
  }),
  getSetting: (key: string) => state.settings.get(key),
  getLatestUserTurnIndex: () => 3,
  upsertActivityLog: (...args: unknown[]) => domain.activity(...args),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../app-version', () => ({
  getAppVersion: () => '0.0.0-test',
}));

import { getMCPConfigForAgent } from '../mcp-manager';
import { resolveHelperTokenOwner, __resetHelperIdentityForTests } from '../helper-identity';
import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  clearChatCapabilityTurn,
  getChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { resetDesktopLanesForTests } from '../desktop-lanes';

const ON = { pipelineControl: false, dynamicWorkflows: false, swarm: true };
const OFF = { ...ON, swarm: false };
const turn = { sessionId: 'swarm-chat', turnId: 'swarm-turn' };
beforeEach(() => {
  vi.clearAllMocks();
  __resetHelperIdentityForTests();
  __resetChatCapabilityContextForTests();
  resetDesktopLanesForTests();
  state.settings = new Map([['mcp_prompt_mode', 'index']]);
  state.agents.clear();
  state.servers = [serverRow('lionclaw-swarm')] as unknown as Array<Record<string, unknown>>;
});
function register(enabled: boolean, origin: 'user' | 'system-event' = 'user') {
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      ...turn,
      origin,
      capabilities: enabled ? ON : OFF,
      cwd: '/authorized',
      readRoots: ['/authorized'],
      writeRoots: [],
      allowedTools: [],
      allowedServerIds: ['lionclaw-swarm'],
    },
    60_000,
  );
  setActiveChatTurn({ ...turn, lane: 'desktop' });
}
function connectionFromSpawn(
  config: Awaited<ReturnType<typeof getMCPConfigForAgent>>,
  serverId = 'lionclaw-swarm',
): JsonRpcContext {
  const token = config?.[serverId]?.env?.LIONCLAW_HELPER_TOKEN;
  const owner = typeof token === 'string' ? resolveHelperTokenOwner(token) : null;
  expect(owner).toBe(serverId);
  return {
    getWindow: () => null,
    connection: {
      authenticatedHelper: owner !== null,
      ...(owner ? { serverId: owner } : {}),
      connectionId: 'spawn-from-composition',
    },
  };
}
function call(ctx: JsonRpcContext, method: string, binding: Record<string, unknown> = turn) {
  return dispatch(ctx, { jsonrpc: '2.0', id: 1, method, params: { ...binding, lane: 'desktop' } });
}
describe('Swarm composição real -> identidade do spawn -> gate do dispatch', () => {
  for (const surface of ['claude-sdk', 'claude-compat-sdk', 'lion-sdk', 'codex-sdk'] as const) {
    for (const fullCatalog of surface === 'claude-sdk' || surface === 'claude-compat-sdk' ? [false, true] : [true]) {
      it(`${surface} fullCatalog=${fullCatalog}: ON recebe identidade e binding, catálogo entra no domínio`, async () => {
        register(true);
        const config = await getMCPConfigForAgent(undefined, {
          surface,
          fullCatalog,
          capabilities: ON,
          lane: 'desktop',
          turn,
        });
        expect(config?.['lionclaw-swarm']).toBeDefined();
        const ctx = connectionFromSpawn(config);
        expect(config!['lionclaw-swarm'].env).toMatchObject({
          LIONCLAW_MCP_SESSION_ID: turn.sessionId,
          LIONCLAW_MCP_TURN_ID: turn.turnId,
        });
        expect((await call(ctx, 'swarm_catalog')).result).toEqual({ members: [], profiles: [], runtimes: [] });
        expect(domain.catalog).toHaveBeenCalledWith(turn.sessionId, true);
        await call(ctx, 'swarm_list');
        expect(domain.list).toHaveBeenCalledWith(turn.sessionId, undefined, undefined);
        expect((await call(ctx, 'swarm_catalog', { ...turn, turnId: 'another-turn' })).result).toMatchObject({
          code: 'chat_capability_no_turn_context',
        });
        expect((await call(ctx, 'swarm_catalog', {})).result).toMatchObject({
          code: 'chat_capability_no_turn_context',
        });
        expect(domain.catalog).toHaveBeenCalledTimes(1);
      });
    }
  }
  it('OFF oculta helper na composição normal; token obtido no pool não concede capability', async () => {
    register(false);
    const normal = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: OFF,
      lane: 'desktop',
      turn,
    });
    expect(normal?.['lionclaw-swarm']).toBeUndefined();
    const pool = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk', fullCatalog: true });
    const ctx = connectionFromSpawn(pool);
    for (const method of ['swarm_catalog', 'swarm_start']) {
      expect((await call(ctx, method)).result).toMatchObject({ code: 'chat_capability_swarm_disabled' });
    }
    expect(domain.catalog).not.toHaveBeenCalled();
    expect(domain.start).not.toHaveBeenCalled();
  });
});

describe('Swarm v2 S2: gate por chip, sem origem (RM2/D9), tools de conducao e swarm_wait (AC-10, AC-19, AC-28)', () => {
  async function conductionContext(enabled: boolean, origin: 'user' | 'system-event') {
    register(enabled, origin);
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      fullCatalog: true,
      lane: 'desktop',
      turn,
    });
    return connectionFromSpawn(config);
  }
  it('AC-19/AC-28: turno de conducao (origin system-event) com o chip ligado dispara swarm_start, conduz e consulta', async () => {
    const ctx = await conductionContext(true, 'system-event');
    expect(
      (
        await call(ctx, 'swarm_start', {
          ...turn,
          requestId: 'etapa-2',
          parentRunId: 'swarm-20260101_000000-abc123',
          stage: 'validacao',
        })
      ).result,
    ).toEqual({ runId: 'accepted' });
    expect(domain.start).toHaveBeenCalledWith(
      { sessionId: turn.sessionId, swarmEnabled: true, readRoots: ['/authorized'] },
      expect.objectContaining({
        requestId: 'etapa-2',
        parentRunId: 'swarm-20260101_000000-abc123',
        stage: 'validacao',
      }),
    );
    expect(
      (
        await call(ctx, 'swarm_message', {
          ...turn,
          runId: 'r',
          slug: 'a',
          message: 'foco em X',
          attemptId: 'attempt-1',
        })
      ).result,
    ).toEqual({ accepted: true });
    expect(domain.message).toHaveBeenCalledWith(turn.sessionId, 'r', 'a', 'foco em X', 'attempt-1', {
      turnId: turn.turnId,
    });
    expect(
      (await call(ctx, 'swarm_redispatch', { ...turn, runId: 'r', slug: 'a', briefing: { objective: 'nova' } })).result,
    ).toEqual({ accepted: true });
    expect(domain.redispatch).toHaveBeenCalledWith(turn.sessionId, 'r', 'a', { objective: 'nova' });
    expect((await call(ctx, 'swarm_read', { ...turn, runId: 'r', slug: 'a' })).result).toEqual({
      slug: 'a',
      status: 'ok',
    });
    expect((await call(ctx, 'swarm_stop', { ...turn, runId: 'r', slug: 'a' })).result).toEqual({
      changed: true,
      status: 'stopping',
    });
    expect((await call(ctx, 'swarm_catalog')).result).toEqual({ members: [], profiles: [], runtimes: [] });
    expect(domain.catalog).toHaveBeenCalledWith(turn.sessionId, true);
  });
  it('AC-10/AC-28: chip desligado em qualquer turno recusa start/catalog/message/redispatch/wait e mantem read/stop/inspect/list', async () => {
    for (const origin of ['user', 'system-event'] as const) {
      __resetChatCapabilityContextForTests();
      __resetHelperIdentityForTests();
      vi.clearAllMocks();
      const ctx = await conductionContext(false, origin);
      for (const method of ['swarm_start', 'swarm_catalog', 'swarm_message', 'swarm_redispatch', 'swarm_wait'])
        expect(
          (await call(ctx, method, { ...turn, runId: 'r', slug: 'a', message: 'm', briefing: 'b' })).result,
        ).toMatchObject({ code: 'chat_capability_swarm_disabled', error: 'Ligue o chip Swarm e reenvie.' });
      expect(domain.start).not.toHaveBeenCalled();
      expect(domain.message).not.toHaveBeenCalled();
      expect(domain.redispatch).not.toHaveBeenCalled();
      expect(domain.wait).not.toHaveBeenCalled();
      expect((await call(ctx, 'swarm_read', { ...turn, runId: 'r', slug: 'a' })).result).toEqual({
        slug: 'a',
        status: 'ok',
      });
      expect((await call(ctx, 'swarm_stop', { ...turn, runId: 'r', slug: 'a' })).result).toEqual({
        changed: true,
        status: 'stopping',
      });
      expect((await call(ctx, 'swarm_inspect', { ...turn, runId: 'r' })).result).toEqual({ runId: 'r' });
      expect((await call(ctx, 'swarm_list')).result).toEqual({ runs: [] });
      expect(domain.read).toHaveBeenCalledWith(turn.sessionId, 'r', 'a');
      expect(domain.stop).toHaveBeenCalledWith(turn.sessionId, 'r', 'a');
    }
  });
  it('erros tipados do dominio voltam como resultado com code, nao como falha de transporte', async () => {
    const ctx = await conductionContext(true, 'user');
    for (const code of ['run_closed', 'stale_attempt', 'context-overflow', 'agent-not-found']) {
      domain.message.mockRejectedValueOnce(Object.assign(new Error(`motivo ${code}`), { code }));
      const response = await call(ctx, 'swarm_message', { ...turn, runId: 'r', slug: 'a', message: 'm' });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ error: `motivo ${code}`, code });
    }
  });
  it('swarm_wait: waitId estavel por turno/run, progresso vira linha de atividade do turno e o fim do turno cancela a espera', async () => {
    vi.useFakeTimers();
    try {
      const ctx = await conductionContext(true, 'user');
      const sent: unknown[] = [];
      const window = {
        isDestroyed: () => false,
        webContents: { send: (channel: string, chunk: unknown) => sent.push([channel, chunk]) },
      };
      const withWindow = { ...ctx, getWindow: () => window as never };
      let captured: {
        signal?: AbortSignal;
        onProgress?: (line: string) => void;
        waitId?: string;
        turnId?: string;
        slugs?: string[];
        sliceMs?: number;
      } = {};
      domain.wait.mockImplementationOnce(
        ((input: typeof captured) =>
          new Promise((resolve) => {
            captured = input;
            input.onProgress?.('2 swarm agents rodando: a, b');
            input.signal?.addEventListener('abort', () =>
              resolve({ status: 'cancelled', runId: 'r', runStatus: 'running', progress: 'x' }),
            );
          })) as never,
      );
      const pending = call(withWindow, 'swarm_wait', { ...turn, runId: 'r', slugs: ['a'], sliceMs: 20_000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(captured).toMatchObject({
        waitId: `${turn.turnId}:r`,
        turnId: turn.turnId,
        slugs: ['a'],
        sliceMs: 20_000,
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual([
        'chat:stream',
        expect.objectContaining({
          type: 'activity',
          sessionId: turn.sessionId,
          activity: expect.objectContaining({
            id: 'swarm-wait:r',
            kind: 'tool',
            phase: 'update',
            toolName: 'swarm_wait',
            description: '2 swarm agents rodando: a, b',
            status: 'running',
            turnIndex: 3,
          }),
        }),
      ]);
      expect(domain.activity).toHaveBeenCalledWith(turn.sessionId, 3, expect.objectContaining({ id: 'swarm-wait:r' }));
      expect(captured.signal?.aborted).toBe(false);
      clearChatCapabilityTurn(turn);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(captured.signal?.aborted).toBe(true);
      expect((await pending).result).toMatchObject({ status: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('GA-2: swarm_wait em fatias por 45 min renova o TTL do turno (registrado com 60 s) e a espera nao e cancelada; o fim do turno ainda cancela', async () => {
    vi.useFakeTimers();
    try {
      const ctx = await conductionContext(true, 'user');
      let captured: { signal?: AbortSignal } = {};
      domain.wait.mockImplementation(
        ((input: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            captured = input;
            input.signal?.addEventListener('abort', () =>
              resolve({ status: 'cancelled', runId: 'r', runStatus: 'running', progress: 'x', reason: 'turno' }),
            );
          })) as never,
      );
      const pending = call(ctx, 'swarm_wait', { ...turn, runId: 'r' });
      for (let i = 0; i < 54; i++) {
        await vi.advanceTimersByTimeAsync(50_000);
        expect(captured.signal?.aborted).toBe(false);
        expect(getChatCapabilityTurn(turn)).toBeDefined();
      }
      clearChatCapabilityTurn(turn);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(captured.signal?.aborted).toBe(true);
      expect((await pending).result).toMatchObject({ status: 'cancelled', reason: 'turno' });
      domain.wait.mockReset();
    } finally {
      vi.useRealTimers();
    }
  });
});
