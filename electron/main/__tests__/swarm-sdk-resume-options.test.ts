import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({ getSetting: vi.fn() }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn() }));

import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { buildZaiQueryOptions } from '../agent-runtime/zai-executor';
import { buildMinimaxTpQueryOptions } from '../agent-runtime/minimax-tokenplan-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

function makeReq(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'swarm-agent',
    prompt: 'continue',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
    ...overrides,
  };
}
function makeConfig(runtime: AgentQueryConfig['runtime'], model: string): AgentQueryConfig {
  return {
    model,
    systemPrompt: 'swarm agent',
    allowedTools: ['Read', 'Grep', 'Glob'],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime,
  };
}
const builders: Array<[string, (req: AgentExecutionRequest) => Record<string, unknown>]> = [
  [
    'cloud',
    (req) => buildClaudeQueryOptions(req, makeConfig('cloud', 'claude-opus-5-5'), '/cli.js', new AbortController()),
  ],
  ['zai', (req) => buildZaiQueryOptions(req, makeConfig('zai', 'glm-5-turbo'), '/cli.js', new AbortController(), 'k')],
  [
    'minimax-tp',
    (req) =>
      buildMinimaxTpQueryOptions(req, makeConfig('minimax-tp', 'MiniMax-M2.5'), '/cli.js', new AbortController(), 'k'),
  ],
];

describe('Swarm v2 S3 (AC-11): familia Claude retoma por resume: sessionId, nunca continue', () => {
  it.each(builders)('%s: resumeSessionId vira resume e nenhum continue e enviado ao SDK', (_name, build) => {
    const opts = build(makeReq({ resumeSessionId: 'sess-swarm-a' }));
    expect(opts.resume).toBe('sess-swarm-a');
    expect('continue' in opts).toBe(false);
    expect('sessionId' in opts).toBe(false);
  });
  it.each(builders)('%s: resumeSessionId vence continueSession quando os dois chegam', (_name, build) => {
    const opts = build(makeReq({ resumeSessionId: 'sess-swarm-b', continueSession: true }));
    expect(opts.resume).toBe('sess-swarm-b');
    expect('continue' in opts).toBe(false);
  });
  it.each(builders)('%s: sem resumeSessionId o comportamento do chat (continue) nao muda', (_name, build) => {
    expect(build(makeReq({ continueSession: true })).continue).toBe(true);
    const fresh = build(makeReq());
    expect('continue' in fresh).toBe(false);
    expect('resume' in fresh).toBe(false);
  });
});
