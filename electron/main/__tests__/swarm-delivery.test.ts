import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  pending: vi.fn(),
  session: vi.fn(),
  recover: vi.fn(),
  release: vi.fn(),
  persist: vi.fn(),
  submit: vi.fn(),
  toggles: vi.fn(),
  questionPending: vi.fn(),
  questionDelivered: vi.fn(async () => true),
  failWaiting: vi.fn(async () => true),
}));
vi.mock('../db', () => ({
  claimSwarmDelivery: mocks.claim,
  completeSwarmDelivery: mocks.complete,
  getSetting: vi.fn(),
  getChatFeatureToggles: mocks.toggles,
  getPendingSwarmDeliveries: mocks.pending,
  getSession: mocks.session,
  recoverSwarmDeliveryClaims: mocks.recover,
  releaseSwarmDelivery: mocks.release,
  persistSwarmChatMessageOnce: mocks.persist,
}));
vi.mock('../orchestrator', () => ({ submitMessage: mocks.submit }));
vi.mock('../swarm/index', () => ({
  getSwarmService: () => ({
    questionPending: mocks.questionPending,
    questionDelivered: mocks.questionDelivered,
    failWaiting: mocks.failWaiting,
  }),
}));
import {
  startSwarmDeliveryPump,
  swarmDeliveryTurnMessage,
  SWARM_QUESTION_CHIP_OFF_INSTRUCTION,
} from '../swarm/delivery';
import { releaseSwarmTurn, flushSwarmTurnReleases } from '../swarm/chat-persistence';

let stop: (() => void) | undefined;
const delivery = {
  runId: 'run',
  kind: 'terminal',
  revision: 7,
  slug: null,
  attemptId: null,
  sessionId: 'origin',
  envelope: 'evidence',
  runStatus: 'open',
  state: 'pending',
};
const question = {
  ...delivery,
  kind: 'question',
  revision: 4,
  slug: 'auditor',
  attemptId: 'attempt-1-abcd',
  envelope: 'SWARM QUESTION run',
  runStatus: 'running',
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.pending.mockReturnValue([delivery]);
  mocks.claim.mockImplementation((_run, kind, revision, claimId) => ({
    ...(kind === 'question' ? question : delivery),
    revision,
    claimId,
    state: 'claimed',
  }));
  mocks.session.mockReturnValue({ id: 'origin', status: 'active' });
  mocks.submit.mockReturnValue(true);
  mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: true });
  mocks.questionPending.mockReturnValue(true);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});
describe('Swarm durable delivery admission', () => {
  it('retries a failed database release after the turn ended, without keeping the claim stuck', () => {
    mocks.release
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      })
      .mockReturnValue(true);
    expect(() =>
      releaseSwarmTurn(
        { swarmDelivery: { runId: 'released', kind: 'terminal', revision: 3, claimId: 'owner' } },
        'finalizado',
      ),
    ).not.toThrow();
    flushSwarmTurnReleases();
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenLastCalledWith('released', 'terminal', 3, 'owner', 'finalizado');
    flushSwarmTurnReleases();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it('preserves origin/correlation, persists a system event before admission and carries the session chip (RM2)', () => {
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'origin',
        runId: 'run',
        kind: 'terminal',
        revision: 7,
        messageKind: 'event',
        content: 'evidence',
      }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.stringContaining('parentRunId'),
      expect.objectContaining({
        sessionId: 'origin',
        origin: 'system-event',
        swarmDelivery: expect.objectContaining({ runId: 'run', kind: 'terminal', revision: 7 }),
        featureToggles: { pipelineControl: false, dynamicWorkflows: false, swarm: true },
      }),
      expect.any(Function),
    );
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('chip OFF in the session keeps the conduction turn without swarm authorization', () => {
    mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: false });
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ featureToggles: { pipelineControl: false, dynamicWorkflows: false, swarm: false } }),
      expect.any(Function),
    );
  });
  it('maintenance rejection releases claim and reattempts later', () => {
    mocks.submit.mockReturnValue(false);
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.release).toHaveBeenCalledWith('run', 'terminal', 7, expect.any(String), 'Manutenção em andamento');
    vi.advanceTimersByTime(5000);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
  });
  it('removed session is undeliverable; aborted does not call LLM', () => {
    mocks.session.mockReturnValue(undefined);
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.complete).toHaveBeenCalledWith(
      'run',
      'terminal',
      7,
      expect.any(String),
      'undeliverable',
      'Sessão removida',
    );
    mocks.session.mockReturnValue({ status: 'active' });
    mocks.claim.mockImplementation((_run, _kind, _revision, claimId) => ({
      ...delivery,
      claimId,
      runStatus: 'aborted',
    }));
    vi.advanceTimersByTime(5000);
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('question delivery asks the orchestrator to answer with swarm_message and the slug/attemptId (AC-9)', () => {
    mocks.pending.mockReturnValue([question]);
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.questionPending).toHaveBeenCalledWith('run', 'auditor', 'attempt-1-abcd');
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'question', revision: 4, messageKind: 'event', content: 'SWARM QUESTION run' }),
    );
    const [message, options] = mocks.submit.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toMatch(/swarm_message/);
    expect(message).toMatch(/<swarm-question>/);
    expect(options.swarmDelivery).toEqual({
      runId: 'run',
      kind: 'question',
      revision: 4,
      slug: 'auditor',
      attemptId: 'attempt-1-abcd',
      claimId: expect.any(String),
    });
    expect(swarmDeliveryTurnMessage({ kind: 'question', envelope: question.envelope, slug: question.slug })).toContain(
      'aguardando sua resposta',
    );
  });
  it('S2-V2: orquestrador em runtime desconhecido nao prende o swarm agent: evento no chat com o motivo, failed e undeliverable', async () => {
    mocks.pending.mockReturnValue([question]);
    mocks.session.mockReturnValue({ id: 'origin', status: 'active', orchestrator: { runtime: 'legacy-sdk' } });
    stop = startSwarmDeliveryPump(() => null);
    await Promise.resolve();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'question',
        revision: 4,
        messageKind: 'event',
        content: expect.stringMatching(
          /^Orquestrador sem conducao neste runtime \(legacy-sdk\)[^]*SWARM QUESTION run$/,
        ),
      }),
    );
    expect(mocks.failWaiting).toHaveBeenCalledWith(
      'run',
      'auditor',
      'attempt-1-abcd',
      expect.stringContaining('legacy-sdk'),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      'run',
      'question',
      4,
      expect.any(String),
      'undeliverable',
      expect.stringContaining('Orquestrador sem conducao neste runtime (legacy-sdk)'),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('S4 (D8): orquestrador em grok-sdk ou cursor-sdk recebe a entrega terminal como os demais (SWARM-AGGREGATOR-UNSUPPORTED saiu)', () => {
    for (const runtime of ['grok-sdk', 'cursor-sdk']) {
      vi.clearAllMocks();
      mocks.pending.mockReturnValue([{ ...delivery, error: `SWARM-AGGREGATOR-UNSUPPORTED:${runtime}` }]);
      mocks.session.mockReturnValue({ id: 'origin', status: 'active', orchestrator: { runtime } });
      mocks.submit.mockReturnValue(true);
      mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: true });
      mocks.claim.mockImplementation((_run, _kind, revision, claimId) => ({
        ...delivery,
        revision,
        claimId,
        state: 'claimed',
      }));
      stop = startSwarmDeliveryPump(() => null);
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.submit).toHaveBeenCalledTimes(1);
      expect(mocks.submit).toHaveBeenCalledWith(
        expect.stringContaining('Consolide'),
        expect.objectContaining({
          origin: 'system-event',
          swarmDelivery: expect.objectContaining({ kind: 'terminal' }),
        }),
        expect.any(Function),
      );
      stop();
      stop = undefined;
    }
  });
  it('S2-V2: runtimes com conducao (codex, kimi, lion, claude, grok, cursor) recebem a pergunta normalmente', () => {
    for (const runtime of [
      'codex-sdk',
      'kimi-sdk',
      'lion-sdk',
      'claude-sdk',
      'claude-compat-sdk',
      'grok-sdk',
      'cursor-sdk',
    ]) {
      vi.clearAllMocks();
      mocks.pending.mockReturnValue([question]);
      mocks.questionPending.mockReturnValue(true);
      mocks.session.mockReturnValue({ id: 'origin', status: 'active', orchestrator: { runtime } });
      mocks.submit.mockReturnValue(true);
      mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: true });
      mocks.claim.mockImplementation((_run, _kind, revision, claimId) => ({
        ...question,
        revision,
        claimId,
        state: 'claimed',
      }));
      stop = startSwarmDeliveryPump(() => null);
      expect(mocks.failWaiting).not.toHaveBeenCalled();
      expect(mocks.submit).toHaveBeenCalledTimes(1);
      stop();
      stop = undefined;
    }
  });
  it('GA-5: pergunta entregue com o chip desligado roda sem autorizacao do swarm e manda mostrar a pergunta ao usuario com "ligue o chip e responda"; o idle comeca na entrega', async () => {
    mocks.pending.mockReturnValue([question]);
    mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: false });
    stop = startSwarmDeliveryPump(() => null);
    await Promise.resolve();
    const [message, options] = mocks.submit.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain(SWARM_QUESTION_CHIP_OFF_INSTRUCTION);
    expect(message).toContain('ligue o chip Swarm e responda');
    expect(message).toMatch(/<swarm-question>/);
    expect(message).not.toMatch(/aguardando sua resposta/);
    expect(options.featureToggles).toEqual({ pipelineControl: false, dynamicWorkflows: false, swarm: false });
    expect(options.swarmDelivery).toMatchObject({ kind: 'question', slug: 'auditor', attemptId: 'attempt-1-abcd' });
    expect(mocks.questionDelivered).toHaveBeenCalledWith('run', 'auditor', 'attempt-1-abcd');
    expect(mocks.failWaiting).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(swarmDeliveryTurnMessage({ kind: 'question', envelope: 'q', slug: 'a' }, true)).toContain(
      'aguardando sua resposta',
    );
    expect(swarmDeliveryTurnMessage({ kind: 'terminal', envelope: 'e', slug: null }, false)).toContain('Consolide');
  });
  it('GA-5: com o chip ligado a pergunta entregue tambem inicia o idle do swarm agent; entrega terminal nao chama questionDelivered; turno recusado nao conta como entrega', async () => {
    mocks.pending.mockReturnValue([question]);
    stop = startSwarmDeliveryPump(() => null);
    await Promise.resolve();
    expect(mocks.questionDelivered).toHaveBeenCalledTimes(1);
    expect(mocks.questionDelivered).toHaveBeenCalledWith('run', 'auditor', 'attempt-1-abcd');
    stop();
    stop = undefined;
    vi.clearAllMocks();
    mocks.pending.mockReturnValue([delivery]);
    mocks.session.mockReturnValue({ id: 'origin', status: 'active' });
    mocks.submit.mockReturnValue(true);
    mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: true });
    mocks.claim.mockImplementation((_run, _kind, revision, claimId) => ({ ...delivery, revision, claimId }));
    stop = startSwarmDeliveryPump(() => null);
    await Promise.resolve();
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.questionDelivered).not.toHaveBeenCalled();
    stop();
    stop = undefined;
    vi.clearAllMocks();
    mocks.pending.mockReturnValue([question]);
    mocks.questionPending.mockReturnValue(true);
    mocks.session.mockReturnValue({ id: 'origin', status: 'active' });
    mocks.submit.mockReturnValue(false);
    mocks.toggles.mockReturnValue({ pipelineControl: false, dynamicWorkflows: false, swarm: true });
    mocks.claim.mockImplementation((_run, _kind, revision, claimId) => ({ ...question, revision, claimId }));
    stop = startSwarmDeliveryPump(() => null);
    await Promise.resolve();
    expect(mocks.release).toHaveBeenCalledWith('run', 'question', 4, expect.any(String), 'Manutenção em andamento');
    expect(mocks.questionDelivered).not.toHaveBeenCalled();
  });
  it('question whose swarm agent is no longer waiting becomes undeliverable with the reason (AC-23)', () => {
    mocks.pending.mockReturnValue([question]);
    mocks.questionPending.mockReturnValue(false);
    stop = startSwarmDeliveryPump(() => null);
    expect(mocks.complete).toHaveBeenCalledWith(
      'run',
      'question',
      4,
      expect.any(String),
      'undeliverable',
      'Swarm agent não está mais aguardando esta pergunta',
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
