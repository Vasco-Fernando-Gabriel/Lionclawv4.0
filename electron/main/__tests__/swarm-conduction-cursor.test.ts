import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  chunks: [] as Array<Record<string, unknown>>,
  finalize: vi.fn(),
  fail: vi.fn(),
  send: vi.fn(),
  createSession: vi.fn(),
  warn: vi.fn(),
  persistSwarmResponse: vi.fn(() => true),
  completeSwarmDelivery: vi.fn(),
  failWaiting: vi.fn(async () => true),
  extractOnboarding: vi.fn((content: string) => content),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ warn: state.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  clearSessionPendingSeed: vi.fn(),
  completeSwarmDelivery: state.completeSwarmDelivery,
  getSession: vi.fn(() => ({ id: 'session-1', pendingSeed: null, compactedUpToMessageId: null, type: 'chat' })),
  getSessionMessages: vi.fn(() => []),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getSetting: vi.fn((key: string) => (key === 'onboarding_completed' ? 'true' : undefined)),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  insertAuditEntry: vi.fn(),
  insertMessage: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  updateSessionTokens: vi.fn(),
}));
vi.mock('../swarm/index', () => ({ getSwarmService: () => ({ failWaiting: state.failWaiting }) }));
vi.mock('../swarm/chat-persistence', () => ({ persistSwarmResponse: state.persistSwarmResponse }));
vi.mock('../mcp-path-resolver', () => ({ resolveMcpServerRuntime: () => ({ command: '/node', entryPath: '/x.js' }) }));
vi.mock('../user-attachments-meta', () => ({ persistUserChatMessage: vi.fn() }));
vi.mock('../token-estimator', () => ({ estimateTokens: vi.fn(() => 1) }));
vi.mock('../agent-runtime/context-measure', () => ({
  estimateAgenticContentTokens: vi.fn(() => 0),
  estimateStrongFloor: vi.fn(() => 0),
  reconcileActiveContext: vi.fn(() => 0),
}));
vi.mock('../chat-context-usage', () => ({ buildChatContextUsage: vi.fn(() => null) }));
vi.mock('../chat-compaction-trigger', () => ({
  maybeCompactChatSession: vi.fn(),
  isChatTimelineReinjectEnabled: () => false,
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../onboarding', () => ({
  completeOnboardingFromPersistedProfile: vi.fn(),
  extractAndProcessOnboardingData: state.extractOnboarding,
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));
vi.mock('../chat-capability-context', () => ({
  computeEffectiveCapabilitiesForTurn: vi.fn(),
  getActiveChatTurnBinding: vi.fn(() => undefined),
  getChatCapabilityTurn: vi.fn(),
}));
vi.mock('../cursor-sdk/workspace', () => ({ cleanupCursorChatWorkspaces: vi.fn() }));
vi.mock('../cursor-sdk/session', () => ({ createChatCursorSession: state.createSession }));
vi.mock('../cursor-sdk/stream-translator', () => ({
  buildCursorUsageSnapshot: vi.fn(() => ({
    runtime: 'cursor-sdk',
    provider: 'cursor',
    model: 'composer-2.5',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    tokenStatus: 'not_reported',
    costStatus: 'unknown',
  })),
  createCursorStreamTranslator: vi.fn(() => ({
    onEvent: vi.fn(),
    finalize: state.finalize,
    fail: state.fail,
    timelineEvents: () => [],
    toolUses: () => 0,
    assistantText: () => '',
    settledPending: () => false,
  })),
}));

import { executeCursorSdkQuery } from '../cursor-sdk';
import {
  SwarmConductionMountError,
  SWARM_CONDUCTION_UNGUARDED_LOG,
  SWARM_CONDUCTION_UNMOUNTED_LOG,
} from '../swarm/conduction-mcp';
import { SWARM_CONDUCTION_READ_ONLY_NOTICE } from '../swarm/aggregation-policy';
import type { SwarmDeliveryRef } from '../../../src/types/swarm';

const SELECTION = { runtime: 'cursor-sdk', provider: 'cursor', model: 'composer-2.5', source: 'settings' } as const;
const terminal: SwarmDeliveryRef = { runId: 'run-1', kind: 'terminal', revision: 7, claimId: 'claim-7' };
const question: SwarmDeliveryRef = {
  runId: 'run-1',
  kind: 'question',
  revision: 4,
  slug: 'auditor',
  attemptId: 'attempt-1-abcd',
  claimId: 'claim-4',
};
const result = {
  status: 'finished',
  finalText: 'Consolidado: dois achados ALTA, uma divergencia.',
  agentId: 'cursor-agent-1',
  durationMs: 5,
};

async function run(swarmDelivery: SwarmDeliveryRef | undefined, message = 'Uma execução Swarm terminou.') {
  await executeCursorSdkQuery(
    message,
    {
      sessionId: 'session-1',
      origin: 'system-event',
      skipUserMessagePersistence: true,
      ...(swarmDelivery ? { swarmDelivery } : {}),
      onStreamChunk: (chunk) => state.chunks.push(chunk as unknown as Record<string, unknown>),
    },
    () => null,
    undefined,
    SELECTION,
  );
}

describe('Swarm v2 S4 (D8, AC-16): orquestrador em Cursor consolida sem trava por codigo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.chunks.length = 0;
    state.send.mockResolvedValue(result);
    state.createSession.mockResolvedValue({
      resuming: false,
      contextMeta: { systemPromptTokens: 0, toolSchemasTokens: 0 },
      workspace: { workspaceDir: '/tmp/cursor-ws' },
      swarmConductionMounted: true,
      send: state.send,
      close: vi.fn(),
    });
    state.persistSwarmResponse.mockReturnValue(true);
  });

  it('turno de entrega terminal: sessao com o MCP do swarm, log "consolidacao sem trava por codigo", prompt so de leitura e resposta persistida na entrega', async () => {
    const db = await import('../db');
    await run(terminal);
    expect(state.createSession).toHaveBeenCalledWith(expect.objectContaining({ swarmDelivery: { kind: 'terminal' } }));
    expect(state.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'cursor-sdk', runId: 'run-1', kind: 'terminal', swarmToolsMounted: true }),
      expect.stringContaining(SWARM_CONDUCTION_UNGUARDED_LOG),
    );
    expect(String(state.warn.mock.calls.at(-1)![1])).not.toContain(SWARM_CONDUCTION_UNMOUNTED_LOG);
    expect(db.insertAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolName: 'swarm.consolidation',
        output: SWARM_CONDUCTION_UNGUARDED_LOG,
        input: expect.stringContaining('"runtime":"cursor-sdk"'),
      }),
    );
    const prompt = String(state.send.mock.calls[0]![0]);
    expect(prompt.startsWith(SWARM_CONDUCTION_READ_ONLY_NOTICE)).toBe(true);
    expect(prompt).toContain('Uma execução Swarm terminou.');
    expect(state.persistSwarmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ swarmDelivery: terminal }),
      'session-1',
      result.finalText,
      undefined,
    );
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(state.extractOnboarding).not.toHaveBeenCalled();
    expect(state.finalize).toHaveBeenCalledOnce();
    expect(state.fail).not.toHaveBeenCalled();
    expect(state.completeSwarmDelivery).not.toHaveBeenCalled();
  });

  it('turno de pergunta (swarm_wait/needs-input) tambem roda em Cursor', async () => {
    await run(question, 'Um swarm agent (auditor) pediu ajuda.');
    expect(state.createSession).toHaveBeenCalledWith(expect.objectContaining({ swarmDelivery: { kind: 'question' } }));
    expect(state.persistSwarmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ swarmDelivery: question }),
      'session-1',
      result.finalText,
      undefined,
    );
    expect(state.failWaiting).not.toHaveBeenCalled();
  });

  it('turno normal (sem entrega) nao loga a consolidacao, nao usa o aviso e persiste pelo insertMessage', async () => {
    const db = await import('../db');
    state.persistSwarmResponse.mockReturnValue(false);
    await run(undefined, 'ola');
    expect(state.createSession.mock.calls[0]![0]).not.toHaveProperty('swarmDelivery');
    expect(state.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(SWARM_CONDUCTION_UNGUARDED_LOG),
    );
    expect(String(state.send.mock.calls[0]![0])).not.toContain(SWARM_CONDUCTION_READ_ONLY_NOTICE);
    expect(db.insertMessage).toHaveBeenCalledOnce();
    expect(state.extractOnboarding).toHaveBeenCalledOnce();
  });

  it('MCP do swarm nao montou (pergunta): comportamento da S2, undeliverable com o motivo e swarm agent failed', async () => {
    const error = new SwarmConductionMountError('cursor-sdk', 'servidor lionclaw-swarm fora do catalogo do turno');
    state.createSession.mockRejectedValue(error);
    await run(question, 'Um swarm agent (auditor) pediu ajuda.');
    expect(state.failWaiting).toHaveBeenCalledWith('run-1', 'auditor', 'attempt-1-abcd', error.message);
    expect(state.completeSwarmDelivery).toHaveBeenCalledWith(
      'run-1',
      'question',
      4,
      'claim-4',
      'undeliverable',
      error.message,
    );
    expect(state.chunks).toContainEqual(expect.objectContaining({ type: 'error', error: error.message }));
    expect(state.send).not.toHaveBeenCalled();
    expect(state.persistSwarmResponse).not.toHaveBeenCalled();
  });

  it('S4-V1: chip desligado (ou MCP ausente) na entrega terminal: o turno consolida mesmo assim, sem as tools do swarm, e o log registra a ausencia', async () => {
    const db = await import('../db');
    state.createSession.mockResolvedValue({
      ...(await state.createSession.getMockImplementation()!()),
      swarmConductionMounted: false,
    });
    await run(terminal);
    expect(state.createSession).toHaveBeenCalledWith(expect.objectContaining({ swarmDelivery: { kind: 'terminal' } }));
    expect(state.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'cursor-sdk', kind: 'terminal', swarmToolsMounted: false }),
      expect.stringContaining(SWARM_CONDUCTION_UNMOUNTED_LOG),
    );
    expect(db.insertAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'swarm.consolidation',
        input: expect.stringContaining('"swarmToolsMounted":false'),
      }),
    );
    expect(state.persistSwarmResponse).toHaveBeenCalledOnce();
    expect(state.completeSwarmDelivery).not.toHaveBeenCalled();
    expect(state.failWaiting).not.toHaveBeenCalled();
    expect(state.fail).not.toHaveBeenCalled();
  });

  it('turno de entrega que o sidecar nao finaliza nao persiste a consolidacao', async () => {
    state.send.mockResolvedValue({ ...result, status: 'error', errorMessage: 'sidecar caiu' });
    await run(terminal);
    expect(state.persistSwarmResponse).not.toHaveBeenCalled();
    expect(state.fail).toHaveBeenCalledOnce();
  });
});
