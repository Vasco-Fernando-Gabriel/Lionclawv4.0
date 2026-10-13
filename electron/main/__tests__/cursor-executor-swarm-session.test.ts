import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async (key: string) => (key === 'CURSOR_API_KEY' ? 'test-cursor-key' : null)),
}));
vi.mock('../agent-runtime/cursor-sidecar/sidecar-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-runtime/cursor-sidecar/sidecar-manager')>();
  return { ...actual, runCursorSidecarExecution: vi.fn() };
});

import {
  runCursorSidecarExecution,
  type CursorSidecarExecutionOptions,
  type CursorSidecarExecutionResult,
} from '../agent-runtime/cursor-sidecar/sidecar-manager';
import { cursorExecutor } from '../agent-runtime/cursor-executor';
import { buildCursorSessionKey, loadCursorSession } from '../agent-runtime/cursor-sidecar/session-registry';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionRequest } from '../agent-runtime/types';

const mockedRun = vi.mocked(runCursorSidecarExecution);
let testHome = '';
const originalTestHome = process.env['LIONCLAW_TEST_HOME'];
const CONFIG: AgentQueryConfig = {
  model: 'composer-2.5',
  systemPrompt: 'Voce e um swarm agent.',
  allowedTools: [],
  mcpServers: [],
  maxTurns: undefined,
  effort: 'medium',
  thinking: 'disabled',
  thinkingBudget: undefined,
  runtime: 'cursor',
};
function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'swarm-doc-validator',
    prompt: 'Valide o item.',
    cwd: path.join(testHome, 'workspace'),
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    ...overrides,
  };
}
function finished(agentId: string): CursorSidecarExecutionResult {
  return {
    status: 'finished',
    finalText: `resposta ${agentId}`,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
    agentId,
    runId: 'run-1',
    model: 'composer-2.5',
    durationMs: 10,
  };
}
const scope = (slug: string, generation = 1) => ({ runId: 'swarm-20261011_120000-abc123', slug, generation });
const optionsOf = (index: number) => mockedRun.mock.calls[index]![0] as CursorSidecarExecutionOptions;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-swarm-'));
  process.env['LIONCLAW_TEST_HOME'] = testHome;
  fs.mkdirSync(path.join(testHome, 'workspace'), { recursive: true });
  mockedRun.mockReset();
});
afterEach(() => {
  if (originalTestHome === undefined) delete process.env['LIONCLAW_TEST_HOME'];
  else process.env['LIONCLAW_TEST_HOME'] = originalTestHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('Swarm v2 S3 (AC-25): chave de sessao do Cursor por run, slug e geracao', () => {
  it('a chave inclui projectId::agentId::cwd::runId::slug::geracao e nao muda para quem nao passa escopo', () => {
    const cwd = path.join(testHome, 'workspace');
    expect(buildCursorSessionKey({ projectId: 'p', agentId: 'ag', cwd, scope: scope('item-a', 2) })).toBe(
      `p::ag::${path.resolve(cwd)}::swarm-20261011_120000-abc123::item-a::2`,
    );
    expect(buildCursorSessionKey({ agentId: 'ag', cwd })).toBe(`standalone::ag::${path.resolve(cwd)}`);
  });
  it('fanout com dois itens no mesmo agente usa sessoes distintas e cada continuacao retoma o seu agentId', async () => {
    mockedRun.mockResolvedValueOnce(finished('cursor-agent-a')).mockResolvedValueOnce(finished('cursor-agent-b'));
    const a = await cursorExecutor.run(request({ sessionScope: scope('item-a') }), CONFIG);
    const b = await cursorExecutor.run(request({ sessionScope: scope('item-b') }), CONFIG);
    expect(a.metadata?.sessionIds).toEqual(['cursor-agent-a']);
    expect(b.metadata?.sessionIds).toEqual(['cursor-agent-b']);
    expect(optionsOf(0).config.storeDir).not.toBe(optionsOf(1).config.storeDir);
    expect(optionsOf(0).config.resumeAgentId).toBeUndefined();
    expect(optionsOf(1).config.resumeAgentId).toBeUndefined();
    const cwd = path.join(testHome, 'workspace');
    expect(
      loadCursorSession(buildCursorSessionKey({ agentId: 'swarm-doc-validator', cwd, scope: scope('item-a') })),
    ).toMatchObject({
      cursorAgentId: 'cursor-agent-a',
    });
    expect(
      loadCursorSession(buildCursorSessionKey({ agentId: 'swarm-doc-validator', cwd, scope: scope('item-b') })),
    ).toMatchObject({
      cursorAgentId: 'cursor-agent-b',
    });
    expect(loadCursorSession(buildCursorSessionKey({ agentId: 'swarm-doc-validator', cwd }))).toBeNull();
    mockedRun.mockResolvedValueOnce(finished('cursor-agent-b')).mockResolvedValueOnce(finished('cursor-agent-a'));
    await cursorExecutor.run(
      request({ sessionScope: scope('item-b'), continueSession: true, prompt: 'segue b' }),
      CONFIG,
    );
    await cursorExecutor.run(
      request({ sessionScope: scope('item-a'), continueSession: true, prompt: 'segue a' }),
      CONFIG,
    );
    expect(optionsOf(2).config.resumeAgentId).toBe('cursor-agent-b');
    expect(optionsOf(2).config.prompt).toBe('segue b');
    expect(optionsOf(3).config.resumeAgentId).toBe('cursor-agent-a');
    expect(optionsOf(3).config.prompt).toBe('segue a');
    expect(optionsOf(2).config.storeDir).toBe(optionsOf(1).config.storeDir);
    expect(optionsOf(3).config.storeDir).toBe(optionsOf(0).config.storeDir);
  });
  it('redisparo do zero muda a geracao e nao retoma a sessao anterior', async () => {
    mockedRun.mockResolvedValueOnce(finished('cursor-agent-g1')).mockResolvedValueOnce(finished('cursor-agent-g2'));
    await cursorExecutor.run(request({ sessionScope: scope('item-a', 1) }), CONFIG);
    await cursorExecutor.run(request({ sessionScope: scope('item-a', 2), continueSession: true }), CONFIG);
    expect(optionsOf(1).config.resumeAgentId).toBeUndefined();
    expect(optionsOf(1).config.prompt).toContain('## Instrucoes do agente');
    expect(optionsOf(1).config.storeDir).not.toBe(optionsOf(0).config.storeDir);
    mockedRun.mockResolvedValueOnce(finished('cursor-agent-g2'));
    await cursorExecutor.run(request({ sessionScope: scope('item-a', 2), continueSession: true }), CONFIG);
    expect(optionsOf(2).config.resumeAgentId).toBe('cursor-agent-g2');
  });
});
