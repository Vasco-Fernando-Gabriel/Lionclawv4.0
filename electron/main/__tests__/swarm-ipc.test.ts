import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  enabled: false,
  sender: {},
  start: vi.fn(),
  abort: vi.fn(),
  stop: vi.fn(),
  getMessages: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(name, handler),
  },
}));
vi.mock('../db', () => ({
  getSession: (id: string) => (id === 's1' ? { id } : null),
  getDesktopActiveSessionById: (id: string) => (id === 's1' ? { id } : null),
  getChatFeatureToggles: () => ({ swarm: h.enabled }),
  getSessionActiveRepository: () => ({ repositoryId: 'repo' }),
  getLocalRepository: () => ({ rootPath: '/authorized' }),
}));
vi.mock('../swarm', () => ({
  getSwarmService: () => ({
    start: h.start,
    abort: h.abort,
    stop: h.stop,
    getMessages: h.getMessages,
    subscribe: h.subscribe,
  }),
}));
import { registerSwarmHandlers } from '../ipc/swarm';
const SWARM_IPC_CHANNELS = [
  'swarm:abort',
  'swarm:get-catalog',
  'swarm:get-messages',
  'swarm:get-run-state',
  'swarm:get-settings',
  'swarm:list-runs',
  'swarm:open-findings',
  'swarm:set-settings',
  'swarm:start',
  'swarm:stop-agent',
];
describe('Swarm IPC', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.enabled = false;
    vi.clearAllMocks();
    registerSwarmHandlers({ getMainWindow: () => ({ webContents: h.sender }) } as never);
  });
  it('golden list dos canais do swarm (registrados por register(), fora do regex do ipc-channel-list)', () => {
    expect([...h.handlers.keys()].sort()).toEqual(SWARM_IPC_CHANNELS);
    expect(h.handlers.size).toBe(10);
  });
  it('recusa remetente externo antes de domínio e aceita remetente correto', async () => {
    const start = h.handlers.get('swarm:start')!;
    expect(await start({ sender: {} }, 's1', {})).toMatchObject({ code: 'auth-required' });
    expect(h.start).not.toHaveBeenCalled();
    await start({ sender: h.sender }, 's1', { objective: 'x' });
    expect(h.start).toHaveBeenCalledWith(
      { sessionId: 's1', swarmEnabled: false, readRoots: ['/authorized'] },
      { objective: 'x' },
    );
  });
  it('aborto permanece disponível com chip desligado e sessão inválida falha', async () => {
    await h.handlers.get('swarm:abort')!({ sender: h.sender }, 's1', 'r1');
    expect(h.abort).toHaveBeenCalledWith('s1', 'r1');
    expect(await h.handlers.get('swarm:abort')!({ sender: h.sender }, 'forged', 'r1')).toMatchObject({
      error: 'Sessão não encontrada.',
    });
  });
  it('S5 (AC-17): swarm:stop-agent para um swarm agent pelo runner (mesma fila, sem chip, origem usuario) e exige remetente e sessao', async () => {
    h.stop.mockResolvedValue({ changed: true, status: 'stopping' });
    const stop = h.handlers.get('swarm:stop-agent')!;
    expect(await stop({ sender: {} }, 's1', 'r1', 'auditor')).toMatchObject({ code: 'auth-required' });
    expect(await stop({ sender: h.sender }, 'forged', 'r1', 'auditor')).toMatchObject({
      error: 'Sessão não encontrada.',
    });
    expect(h.stop).not.toHaveBeenCalled();
    expect(await stop({ sender: h.sender }, 's1', 'r1', 'auditor')).toEqual({ changed: true, status: 'stopping' });
    expect(h.stop).toHaveBeenCalledWith('s1', 'r1', 'auditor', 'user');
    h.stop.mockRejectedValueOnce(Object.assign(new Error('Run abortada; nada a parar.'), { code: 'run_aborted' }));
    expect(await stop({ sender: h.sender }, 's1', 'r1', 'auditor')).toEqual({
      error: 'Run abortada; nada a parar.',
      code: 'run_aborted',
    });
  });
  it('S5 (AC-14): swarm:get-messages devolve o messages.jsonl do swarm agent da sessao', async () => {
    const messages = [
      { id: 'm1', kind: 'message', attemptId: 'a1', at: '2026-10-11T10:00:00.000Z', text: 'foque em X' },
    ];
    h.getMessages.mockResolvedValue({ runId: 'r1', slug: 'auditor', messages });
    const get = h.handlers.get('swarm:get-messages')!;
    expect(await get({ sender: {} }, 's1', 'r1', 'auditor')).toMatchObject({ code: 'auth-required' });
    expect(await get({ sender: h.sender }, 'forged', 'r1', 'auditor')).toMatchObject({
      error: 'Sessão não encontrada.',
    });
    expect(await get({ sender: h.sender }, 's1', 'r1', 'auditor')).toEqual({ runId: 'r1', slug: 'auditor', messages });
    expect(h.getMessages).toHaveBeenCalledWith('s1', 'r1', 'auditor');
  });
});
