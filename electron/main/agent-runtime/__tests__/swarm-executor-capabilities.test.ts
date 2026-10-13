import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../../../../src/types';
import type { SwarmRuntime } from '../../../../src/types/swarm';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import type { AgentExecutionRequest } from '../types';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'lionclaw-swarm-cap-home-'));
process.env.LIONCLAW_TEST_HOME = TEST_HOME;

const captured = vi.hoisted(() => ({
  queryOptions: [] as Array<Record<string, unknown>>,
  kimiRuns: [] as Array<Record<string, unknown>>,
  kimiBridges: [] as Array<
    Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<{ output: string; isError?: boolean }> }>
  >,
  grokRuns: [] as Array<Record<string, unknown>>,
  cursorRuns: [] as Array<{ config: Record<string, unknown>; dispatchTool: (...args: unknown[]) => Promise<unknown> }>,
  codexRuns: [] as Array<Record<string, unknown>>,
  ollamaCalls: [] as Array<{ options: Record<string, unknown> }>,
  genaiCalls: [] as Array<Record<string, unknown>>,
  localToolCalls: 0,
  grokBridges: [] as Array<
    Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<{ output: string }> }>
  >,
  ollamaTools: [] as Array<Array<{ function: { name: string } }>>,
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../db', () => ({
  getSetting: (key: string) => {
    if (key === 'orchestrator_zai_api_key_ref') return 'zai-ref';
    if (key === 'orchestrator_minimax_api_key_ref') return 'minimax-ref';
    if (key === 'grok_max_concurrency') return '3';
    return '';
  },
  getAgent: () => undefined,
  getAllAgents: () => [],
  getEnabledTools: () => ['Read', 'Glob', 'Grep', 'Write', 'WebSearch', 'WebFetch'],
  getCodexWindowsPrepConsent: () => null,
  CODEX_PREP_VERSION_CURRENT: 1,
  insertAuditEntry: () => {},
}));
vi.mock('../../secrets-vault', () => ({ getSecret: async () => 'segredo-de-teste' }));
vi.mock('../../vault-registry', () => ({ getSecret: async () => 'segredo-de-teste' }));
vi.mock('../../pricing', () => ({
  calculateCost: () => 0,
  getPricingSnapshot: () => ({ pricingVersion: 'teste', model: 'm', entry: null }),
  hasKnownPricing: () => false,
  MODEL_PRICING: {},
}));
vi.mock('../../pipeline-shared/ipc-emitter', () => ({ emitIPC: () => {} }));
vi.mock('../../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: () => {},
  ensureAuthForSDK: async () => {},
  getClaudeSdkProcessOptions: () => ({ pathToClaudeCodeExecutable: __filename, executable: 'node' }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    captured.queryOptions.push(args.options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'STATUS: ok' };
    })();
  },
}));
vi.mock('../../stream-processor', () => ({
  processAgentStream: async () => ({
    output: 'STATUS: ok',
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 1,
    },
    accumulatedText: 'STATUS: ok',
    textBlocks: ['STATUS: ok'],
  }),
}));
vi.mock('../swarm-process', () => ({
  createSwarmProcessOwner: () => ({ spawnProcess: () => ({}), closeConfirmed: async () => {} }),
  recoverSwarmProcessMarker: async () => true,
}));
vi.mock('../swarm-availability', () => ({ assertSwarmBackendAvailable: async () => {} }));
vi.mock('../../swarm/worker-bridge', () => ({
  createSwarmWorkerBridge: () => ({ extraArgs: [], spawnEnv: {}, dispose: () => {} }),
  toToml: () => '',
}));
vi.mock('../mcp-warning', () => ({ warnMcpToolsDroppedOnce: () => {}, warnOncePerAgent: () => {} }));

vi.mock('../kimi-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kimi-availability')>();
  return {
    ...actual,
    isKimiAvailable: async () => ({
      installed: true,
      authMode: 'subscription',
      usable: true,
      modelAvailable: true,
      managedProviderVerified: true,
    }),
    resolveKimiBinary: async () => '/fake/kimi',
  };
});
vi.mock('../kimi-concurrency', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kimi-concurrency')>();
  return { ...actual, acquireKimiSlot: async () => () => {} };
});
vi.mock('../kimi-session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kimi-session-config')>();
  return { ...actual, buildKimiSessionTools: async () => ({ systemPrompt: '', externalTools: [] }) };
});
vi.mock('../../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: () => ({
    createRun: async (opts: Record<string, unknown>) => {
      captured.kimiRuns.push(opts);
      return {
        send: async () => ({
          content: 'STATUS: ok',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          toolUses: 0,
          status: 'finished',
        }),
        reply: async () => {
          throw new Error('nao usado');
        },
        interrupt: async () => {},
        close: async () => {},
        forceKillFallback: async () => {},
      };
    },
  }),
}));
vi.mock('../../kimi-acp/mcp-http-bridge', () => ({
  startKimiMcpBridge: async (config: { tools: (typeof captured.kimiBridges)[number] }) => {
    captured.kimiBridges.push(config.tools);
    return { mcpServerEntry: { name: 'bridge', url: 'http://127.0.0.1:1' }, stop: async () => {} };
  },
}));

vi.mock('../../grok-acp/acp-driver', () => ({
  getGrokAcpDriver: () => ({
    createRun: async (opts: Record<string, unknown>) => {
      captured.grokRuns.push(opts);
      return {
        send: async () => ({
          content: 'STATUS: ok',
          usage: { reported: true, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          toolUses: 0,
          status: 'finished',
        }),
        reply: async () => {
          throw new Error('nao usado');
        },
        interrupt: async () => {},
        close: async () => {},
        forceKillFallback: async () => {},
      };
    },
  }),
}));
vi.mock('../../grok-acp/mcp-http-bridge', () => ({
  startGrokMcpBridge: async (config: { tools: (typeof captured.grokBridges)[number] }) => {
    captured.grokBridges.push(config.tools);
    return { mcpServerEntry: { name: 'lionclaw', url: 'http://127.0.0.1:2' }, stop: async () => {} };
  },
}));
vi.mock('../grok-session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../grok-session-config')>();
  return {
    ...actual,
    buildGrokSessionTools: async () => ({
      externalTools: [],
      systemPrompt: '',
      catalogServerIds: [],
      catalogToolNames: [],
    }),
  };
});
vi.mock('../grok-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../grok-availability')>();
  return {
    ...actual,
    prepareGrokWorkspace: async () => {},
    buildGrokChildEnv: () => ({ GROK_HOME: '/tmp/grok-home', HOME: '/tmp/grok-home' }),
    resolveGrokHome: () => '/tmp/grok-home',
    resolveGrokBinary: async () => '/fake/grok',
    isGrokAvailable: async () => ({
      installed: true,
      version: '0.2.103',
      authenticated: true,
      authMode: 'subscription',
      subscriptionRouteVerified: true,
      backendVerified: true,
      isolationVerified: true,
      toolPolicyVerified: true,
      modelAvailable: true,
      usable: true,
    }),
  };
});
vi.mock('../../grok-sdk/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../grok-sdk/workspace')>();
  return {
    ...actual,
    resolveGrokWorkspaceGrant: vi.fn(actual.resolveGrokWorkspaceGrant),
    acquireGrokSandboxSpawnLock: async () => () => {},
    inspectGrokWorkspace: async () => {},
    ensureGrokSandboxProfile: vi.fn((_grant: unknown, _home: unknown, requested?: string) => requested ?? 'workspace'),
    snapshotGrokSandboxAttestation: () => ({}),
    waitForGrokSandboxApplied: async () => {},
    attestGrokSession: () => {},
    assertGrokWorkspaceUnchanged: () => {},
    grokInputTouchesProtectedSource: () => false,
  };
});

vi.mock('../cursor-sidecar/sidecar-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cursor-sidecar/sidecar-manager')>();
  return {
    ...actual,
    runCursorSidecarExecution: async (opts: {
      config: Record<string, unknown>;
      dispatchTool: (...args: unknown[]) => Promise<unknown>;
    }) => {
      captured.cursorRuns.push({ config: opts.config, dispatchTool: opts.dispatchTool });
      return { status: 'finished', finalText: 'STATUS: ok', durationMs: 1 };
    },
  };
});

vi.mock('../../codex-runtime/factory', () => ({
  createCodexDriver: () => ({
    createRun: async (opts: Record<string, unknown>) => {
      captured.codexRuns.push(opts);
      return { key: opts.key };
    },
    toSyncCodexSession: () => ({
      threadId: 'thread-swarm',
      send: async () => ({
        status: 'completed',
        content: 'STATUS: ok',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        filesChanged: [],
        commandsRun: [],
        applyPatchFailures: 0,
        applyPatchFailureSamples: [],
      }),
      reply: async () => {
        throw new Error('nao usado');
      },
      close: () => {},
      closeConfirmed: async () => {},
    }),
    resetProjectNow: () => {},
    hasActiveRun: () => false,
    closeAll: async () => {},
    shutdown: async () => {},
  }),
}));
vi.mock('../../codex-runtime/model-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../codex-runtime/model-capabilities')>();
  return {
    ...actual,
    getCodexModelCapabilities: async () => null,
    getCodexModelCapabilitiesState: () => 'uninitialized',
  };
});
vi.mock('../../codex-windows-prep', () => ({
  resolveGitRoot: () => null,
  detectCodexWindowsIssues: () => [],
  countActionableIssues: () => 0,
  runPrep: () => ({ applied: false, reason: 'teste' }),
  shouldSilenceWarning: () => true,
}));
vi.mock('../../codex-pipeline-config', () => ({ getOfficialPhaseCodexSpawnExtraArgs: () => [] }));

vi.mock('../../ollama-client', () => ({
  ollamaChatWithTools: async (
    _baseUrl: string,
    model: string,
    _system: string,
    _prompt: string,
    tools: Array<{ function: { name: string } }>,
    options: Record<string, unknown>,
  ) => {
    captured.ollamaCalls.push({ options });
    captured.ollamaTools.push(tools);
    return { content: 'STATUS: ok', model, tokensUsed: 1, promptTokens: 1, toolCalls: [], apiRequests: 1 };
  },
}));
vi.mock('../external-http', () => ({
  resolveExternalAuth: async () => ({}),
  ollamaChatWithRetry: async (
    _baseUrl: string,
    model: string,
    _system: string,
    _prompt: string,
    tools: Array<{ function: { name: string } }>,
    options: Record<string, unknown>,
  ) => {
    captured.ollamaCalls.push({ options });
    captured.ollamaTools.push(tools);
    return { content: 'STATUS: ok', model, tokensUsed: 1, promptTokens: 1, toolCalls: [], apiRequests: 1 };
  },
  mapReasoningParams: () => ({}),
  isContextLengthError: () => false,
  resolveExternalPricing: () => ({ status: 'unknown', pricingKey: 'x' }),
}));
vi.mock('../../local-tool-executor', () => ({
  executeLocalTool: async () => {
    captured.localToolCalls += 1;
    return { result: 'nao deveria chamar', isError: true };
  },
}));
vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContentStream: async (args: Record<string, unknown>) => {
        captured.genaiCalls.push(args);
        const round = captured.genaiCalls.length;
        return (async function* () {
          if (round === 1) {
            const scene = (globalThis as { __swarmGenai?: { cwd: string; findingsPath: string } }).__swarmGenai!;
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { name: 'Write', args: { file_path: join(scene.cwd, 'x.txt'), content: 'x' } } },
                      {
                        functionCall: { name: 'Write', args: { file_path: scene.findingsPath, content: '# achados' } },
                      },
                      { functionCall: { name: 'Bash', args: { command: 'curl https://example.com' } } },
                      { functionCall: { name: 'WebFetch', args: { url: 'https://example.com' } } },
                      { functionCall: { name: 'Read', args: { file_path: join(TEST_HOME, 'fora.txt') } } },
                      { functionCall: { name: 'Read', args: { file_path: join(scene.cwd, 'prompt.txt') } } },
                    ],
                  },
                },
              ],
            };
          } else {
            yield { candidates: [{ content: { parts: [{ text: 'STATUS: ok' }] } }] };
          }
        })();
      },
    };
  }
  return {
    GoogleGenAI,
    FunctionCallingConfigMode: { AUTO: 'AUTO' },
    Type: {
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      NUMBER: 'NUMBER',
      BOOLEAN: 'BOOLEAN',
      ARRAY: 'ARRAY',
      INTEGER: 'INTEGER',
    },
  };
});

import { SWARM_CODEX_CONFIG_OVERRIDES, buildSwarmExecutionRequest, type SwarmResolvedMember } from '../swarm-adapter';
import { swarmEffectiveTools } from '../swarm-policy';
import { SWARM_RUNTIME_CAPABILITIES, listSwarmRuntimeCapabilities } from '../../swarm/runtime-capabilities';
import { SWARM_RUNTIMES } from '../../../../src/types/swarm';

const MODELS: Record<SwarmRuntime, string> = {
  cloud: 'claude-opus-5-5',
  zai: 'glm-5.2',
  'minimax-tp': 'minimax-m3',
  kimi: 'kimi-code/k3',
  grok: 'grok-4.6',
  cursor: 'composer-2.5',
  codex: 'gpt-6-sol',
  local: 'llama4',
  external: 'compat-1',
};
const RUN_ID = 'swarm-20261011_120000-abc123';

type ExternalProtocol = 'openai-compatible' | 'google-genai';
function resolvedFor(
  runtime: SwarmRuntime,
  requestedTools: string[],
  protocol: ExternalProtocol = 'openai-compatible',
): SwarmResolvedMember {
  const allowedTools = swarmEffectiveTools(requestedTools);
  const agent: AgentConfig = {
    id: `swarm-${runtime}`,
    name: `swarm ${runtime}`,
    description: 'swarm agent de teste',
    systemPrompt: 'Voce e um swarm agent. Escreva em {{FINDINGS_PATH}}.',
    runtime,
    model: MODELS[runtime],
    allowedTools,
    mcpServers: [],
    skills: [],
    squad: 'swarm',
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    ...(runtime === 'local'
      ? { localConfig: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: MODELS.local } }
      : {}),
    ...(runtime === 'external'
      ? {
          externalConfig:
            protocol === 'google-genai'
              ? {
                  provider: 'gemini-agent-platform',
                  protocol: 'google-genai',
                  apiKeyRef: 'vault-reference',
                  model: MODELS.external,
                }
              : {
                  provider: 'openai-compatible',
                  protocol: 'openai-compatible',
                  baseUrl: 'https://fixture.invalid',
                  apiKeyRef: 'vault-reference',
                  model: MODELS.external,
                },
        }
      : {}),
    ...(runtime === 'codex' ? { codexConfig: { model: MODELS.codex, sandbox: 'danger-full-access' } } : {}),
  };
  const config: AgentQueryConfig = {
    model: agent.model,
    runtime,
    systemPrompt: agent.systemPrompt,
    allowedTools,
    mcpServers: [],
    maxTurns: undefined,
    effort: 'high',
    thinking: 'adaptive',
    thinkingBudget: undefined,
  };
  return { runtime, model: agent.model, snapshot: {}, agent, config };
}

interface Harness {
  cwd: string;
  findingsPath: string;
  writer: ReturnType<typeof vi.fn<(content: string) => Promise<void>>>;
  request: AgentExecutionRequest;
  resolved: SwarmResolvedMember;
}

const scratches: string[] = [];
function makeHarness(
  runtime: SwarmRuntime,
  requestedTools = ['Read', 'Glob', 'Grep', 'Write'],
  protocol: ExternalProtocol = 'openai-compatible',
): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'lionclaw-swarm-cap-cwd-'));
  scratches.push(cwd);
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  writeFileSync(join(cwd, 'prompt.txt'), 'prompt', 'utf8');
  writeFileSync(join(cwd, 'sub', 'source-1.txt'), '1: export const a = 1;', 'utf8');
  writeFileSync(join(TEST_HOME, 'fora.txt'), 'fora', 'utf8');
  const runDir = join(TEST_HOME, 'artifacts', 'swarm', RUN_ID);
  const attemptDir = join(runDir, '_attempts', 'auditor', 'attempt-1-abcd');
  mkdirSync(attemptDir, { recursive: true });
  const findingsPath = join(attemptDir, 'findings.md');
  const writer = vi.fn<(content: string) => Promise<void>>(async () => {});
  const resolved = resolvedFor(runtime, requestedTools, protocol);
  const request = buildSwarmExecutionRequest({
    resolved,
    cwd,
    prompt: 'ALVO: {{RUN_DIR}}',
    findingsPath,
    runId: RUN_ID,
    slug: 'auditor',
    generation: 1,
    settings: { concurrencyCap: 5, maxAttempts: 2, idleTimeoutMs: 60_000, hardTimeoutMs: 60_000, openWindowMs: 1 },
    abortController: new AbortController(),
    writeFindings: writer,
    ...(runtime === 'codex'
      ? {
          codexBridge: {
            extraArgs: ['-c', 'mcp_servers.swarm-worker={command="node"}'],
            spawnEnv: { LIONCLAW_HELPER_TOKEN: 'token-de-teste' },
          },
          sessionOptions: { onCodexSessionCreated: () => {} },
        }
      : {}),
  });
  return { cwd, findingsPath, writer, request, resolved };
}

type CanUse = NonNullable<AgentExecutionRequest['permission']['canUseTool']>;
type Dispatch = NonNullable<AgentExecutionRequest['swarmToolDispatch']>;
const ctx = (signal: AbortSignal) => ({ signal, toolUseID: 't', requestId: 'r' }) as never;
function behavior(result: Awaited<ReturnType<CanUse>>): string {
  return result?.behavior ?? 'null';
}
function message(result: Awaited<ReturnType<CanUse>>): string {
  return result && result.behavior === 'deny' ? result.message : '';
}

async function expectProfileGuarantees(canUseTool: CanUse, h: Harness): Promise<void> {
  const c = ctx(h.request.abortController.signal);
  const findings = await canUseTool('Write', { file_path: h.findingsPath, content: '# achados' }, c);
  expect(behavior(findings)).toBe('deny');
  expect(message(findings)).toContain('Operacao concluida pelo host');
  expect(h.writer).toHaveBeenCalledTimes(1);
  expect(h.writer).toHaveBeenCalledWith('# achados');
  const elsewhere = await canUseTool('Write', { file_path: join(h.cwd, 'novo.md'), content: 'x' }, c);
  expect(behavior(elsewhere)).toBe('deny');
  expect(message(elsewhere)).toContain('Escrita permitida somente no findings');
  expect(behavior(await canUseTool('Write', { file_path: join(TEST_HOME, 'home.txt'), content: 'x' }, c))).toBe('deny');
  expect(h.writer).toHaveBeenCalledTimes(1);
  expect(
    behavior(await canUseTool('Edit', { file_path: join(h.cwd, 'prompt.txt'), old_string: 'a', new_string: 'b' }, c)),
  ).toBe('deny');
  expect(behavior(await canUseTool('Bash', { command: 'curl https://example.com' }, c))).toBe('deny');
  expect(behavior(await canUseTool('Bash', { command: 'ls' }, c))).toBe('deny');
  expect(behavior(await canUseTool('WebFetch', { url: 'https://example.com' }, c))).toBe('deny');
  expect(behavior(await canUseTool('WebSearch', { query: 'lionclaw' }, c))).toBe('deny');
  expect(behavior(await canUseTool('mcp__lionclaw__anything', {}, c))).toBe('deny');
  expect(behavior(await canUseTool('Read', { file_path: join(h.cwd, 'prompt.txt') }, c))).toBe('allow');
  const outside = await canUseTool('Read', { file_path: join(TEST_HOME, 'fora.txt') }, c);
  expect(behavior(outside)).toBe('deny');
  expect(message(outside)).toContain('Leitura fora do alvo autorizado');
  expect(behavior(await canUseTool('Glob', { pattern: '**/*.txt', path: h.cwd }, c))).toBe('allow');
  expect(behavior(await canUseTool('Grep', { pattern: 'a', path: TEST_HOME }, c))).toBe('deny');
}

async function expectDispatchGuarantees(dispatch: Dispatch, h: Harness): Promise<void> {
  const findings = await dispatch('Write', { file_path: h.findingsPath, content: '# achados' });
  expect(findings.isError).toBe(false);
  expect(h.writer).toHaveBeenCalledWith('# achados');
  expect((await dispatch('Write', { file_path: join(h.cwd, 'novo.md'), content: 'x' })).isError).toBe(true);
  expect((await dispatch('Write', { file_path: join(TEST_HOME, 'home.txt'), content: 'x' })).isError).toBe(true);
  expect(h.writer).toHaveBeenCalledTimes(1);
  expect((await dispatch('Edit', { file_path: join(h.cwd, 'prompt.txt') })).isError).toBe(true);
  expect((await dispatch('Bash', { command: 'curl https://example.com' })).isError).toBe(true);
  expect((await dispatch('WebFetch', { url: 'https://example.com' })).isError).toBe(true);
  expect((await dispatch('WebSearch', { query: 'x' })).isError).toBe(true);
  const inside = await dispatch('Read', { file_path: join(h.cwd, 'prompt.txt') });
  expect(inside.isError).toBe(false);
  expect(inside.result).toBe('prompt');
  expect((await dispatch('Read', { file_path: join(TEST_HOME, 'fora.txt') })).isError).toBe(true);
  expect((await dispatch('Grep', { pattern: 'a', path: TEST_HOME })).isError).toBe(true);
}

beforeEach(() => {
  captured.queryOptions.length = 0;
  captured.kimiRuns.length = 0;
  captured.kimiBridges.length = 0;
  captured.grokRuns.length = 0;
  captured.cursorRuns.length = 0;
  captured.codexRuns.length = 0;
  captured.ollamaCalls.length = 0;
  captured.genaiCalls.length = 0;
  captured.localToolCalls = 0;
  captured.grokBridges.length = 0;
  captured.ollamaTools.length = 0;
});
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('AC-15 (S4): o confinamento do swarm agent chega ao executor real de cada runtime (SDKs mockados, sem rede)', () => {
  it('a tabela de capacidades cobre os nove runtimes e bate com o que este arquivo prova', () => {
    expect(listSwarmRuntimeCapabilities().map((entry) => entry.runtime)).toEqual([...SWARM_RUNTIMES]);
    for (const runtime of SWARM_RUNTIMES) {
      const entry = SWARM_RUNTIME_CAPABILITIES[runtime];
      expect(entry.provedBy).toContain('swarm-executor-capabilities.test.ts');
      expect(entry.read).toBe(runtime === 'codex' ? 'free' : 'confined');
      expect(entry.readLabel).toBe(runtime === 'codex' ? 'leitura livre' : 'leitura confinada');
      expect(entry.write).toBe(runtime === 'codex' ? 'sandbox' : 'negada');
      expect(entry.shell).toBe(runtime === 'codex' ? 'sandbox' : 'negada');
      expect(entry.web).toBe(['cloud', 'zai', 'minimax-tp'].includes(runtime) ? 'permitida' : 'negada');
      expect(entry.continuation).toBe(
        ['cloud', 'zai', 'minimax-tp', 'codex', 'cursor'].includes(runtime) ? 'session' : 'replay',
      );
    }
  });

  it.each(['cloud', 'zai', 'minimax-tp'] as const)(
    '%s: canUseTool e hook PreToolUse do Agent SDK sao o perfil do swarm; Write so no arquivo de achados pelo host',
    async (runtime) => {
      const h = makeHarness(runtime);
      const executor =
        runtime === 'cloud'
          ? (await import('../cloud-executor')).cloudExecutor
          : runtime === 'zai'
            ? (await import('../zai-executor')).zaiExecutor
            : (await import('../minimax-tokenplan-executor')).minimaxTokenplanExecutor;
      const result = await executor.run(h.request, h.resolved.config);
      expect(result.output).toBe('STATUS: ok');
      expect(captured.queryOptions).toHaveLength(1);
      const options = captured.queryOptions[0]!;
      expect(options.cwd).toBe(h.cwd);
      expect(options.permissionMode).toBe('default');
      expect(options.allowDangerouslySkipPermissions).toBe(false);
      expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Write']);
      expect(options.allowedTools).toEqual([]);
      expect(options.settingSources).toEqual([]);
      expect(options.mcpServers).toBeUndefined();
      expect(options.canUseTool).toBe(h.request.permission.canUseTool);
      await expectProfileGuarantees(options.canUseTool as CanUse, h);
      const hook = (
        options.hooks as {
          PreToolUse: Array<{ hooks: Array<(e: unknown, id: string, o: unknown) => Promise<unknown>> }>;
        }
      ).PreToolUse[0]!.hooks[0]!;
      const denied = (await hook(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl x' } },
        'id',
        { signal: h.request.abortController.signal },
      )) as { hookSpecificOutput: { permissionDecision: string } };
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    },
  );

  it('cloud (papel pesquisador): WebSearch/WebFetch permitidas e Read/Bash negadas', async () => {
    const h = makeHarness('cloud', ['WebSearch', 'WebFetch', 'Write']);
    const { cloudExecutor } = await import('../cloud-executor');
    await cloudExecutor.run(h.request, h.resolved.config);
    const canUseTool = captured.queryOptions[0]!.canUseTool as CanUse;
    const c = ctx(h.request.abortController.signal);
    expect(behavior(await canUseTool('WebFetch', { url: 'https://example.com' }, c))).toBe('allow');
    expect(behavior(await canUseTool('WebSearch', { query: 'lionclaw' }, c))).toBe('allow');
    expect(behavior(await canUseTool('Read', { file_path: join(h.cwd, 'prompt.txt') }, c))).toBe('deny');
    expect(behavior(await canUseTool('Bash', { command: 'ls' }, c))).toBe('deny');
    expect(behavior(await canUseTool('Write', { file_path: join(h.cwd, 'x.md'), content: 'x' }, c))).toBe('deny');
  });

  it('kimi: o driver ACP recebe o perfil do swarm e as ferramentas de arquivo da bridge passam pelo dispatcher confinado', async () => {
    const h = makeHarness('kimi');
    const { kimiExecutor } = await import('../kimi-executor');
    const result = await kimiExecutor.run(h.request, h.resolved.config);
    expect(result.output).toBe('STATUS: ok');
    expect(captured.kimiRuns).toHaveLength(1);
    const run = captured.kimiRuns[0]!;
    expect(run.workDir).toBe(h.cwd);
    expect(run.permission).toBe(h.request.permission);
    expect(run.swarmSupervised).toBe(true);
    await expectProfileGuarantees((run.permission as AgentExecutionRequest['permission']).canUseTool!, h);
    expect(captured.kimiBridges).toHaveLength(1);
    const tools = captured.kimiBridges[0]!;
    expect(tools.map((tool) => tool.name).sort()).toEqual(['Glob', 'Grep', 'Read', 'Write']);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.handler]));
    expect((await byName.Write!({ file_path: join(h.cwd, 'novo.md'), content: 'x' })).isError).toBe(true);
    expect((await byName.Read!({ file_path: join(TEST_HOME, 'fora.txt') })).isError).toBe(true);
    expect((await byName.Read!({ file_path: join(h.cwd, 'prompt.txt') })).output).toBe('prompt');
  });

  it('grok: workspace grant com sessionCwd/readRoots = cwd da run e writeRoots vazio, sandbox base read-only, perfil do swarm no driver ACP, busca web desligada', async () => {
    const h = makeHarness('grok');
    const { grokExecutor } = await import('../grok-executor');
    const workspace = await import('../../grok-sdk/workspace');
    const result = await grokExecutor.run(h.request, h.resolved.config);
    expect(result.output).toBe('STATUS: ok');
    const grant = (
      workspace.resolveGrokWorkspaceGrant as unknown as { mock: { results: Array<{ value: unknown }> } }
    ).mock.results.at(-1)!.value as { sessionCwd: string; readRoots: string[]; writeRoots: string[] };
    expect(grant.sessionCwd).toBe(realpathSync(h.cwd));
    expect(grant.readRoots).toEqual([realpathSync(h.cwd)]);
    const sandboxCalls = (workspace.ensureGrokSandboxProfile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const [sandboxGrant, , sandboxBase] = sandboxCalls.at(-1)! as [
      { writeRoots: string[]; readRoots: string[]; sessionCwd: string },
      unknown,
      string | undefined,
    ];
    expect(sandboxGrant.writeRoots).toEqual([]);
    expect(sandboxGrant.readRoots).toEqual([realpathSync(h.cwd)]);
    expect(sandboxGrant.sessionCwd).toBe(realpathSync(h.cwd));
    expect(sandboxBase).toBe('read-only');
    expect(captured.grokRuns).toHaveLength(1);
    const run = captured.grokRuns[0]!;
    expect(run.sandbox).toBe('read-only');
    expect(run.workDir).toBe(h.cwd);
    expect(run.processCwd).toBe(realpathSync(h.cwd));
    expect(run.permission).toBe(h.request.permission);
    expect(run.profile).toBe('agent-scoped');
    expect(run.nativeToolArgs).toContain('--disable-web-search');
    const tools = String((run.nativeToolArgs as string[])[1] ?? '');
    expect(tools).not.toMatch(/web_search|web_fetch|run_terminal_cmd|search_replace/);
    await expectProfileGuarantees((run.permission as AgentExecutionRequest['permission']).canUseTool!, h);
    expect(h.request.prompt).toContain('use write_file com file_path');
    expect(h.request.prompt).toContain('o host ja gravou');
  });

  it('grok: mesmo que a resposta de permissao ACP permitisse, o sandbox read-only sem writeRoots nega a escrita no repositorio alvo (grant do chat normal continua com writeRoots = cwd)', async () => {
    const h = makeHarness('grok');
    const { grokExecutor } = await import('../grok-executor');
    const workspace = await import('../../grok-sdk/workspace');
    const permissive: AgentExecutionRequest = {
      ...h.request,
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
      },
    };
    await grokExecutor.run(permissive, h.resolved.config);
    const [sandboxGrant, , sandboxBase] = (
      workspace.ensureGrokSandboxProfile as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1)! as [{ writeRoots: string[] }, unknown, string | undefined];
    expect(sandboxGrant.writeRoots).toEqual([]);
    expect(sandboxBase).toBe('read-only');
    expect(captured.grokRuns.at(-1)!.sandbox).toBe('read-only');
    const chat: AgentExecutionRequest = { ...h.request, executionAgent: undefined, swarmToolDispatch: undefined };
    await grokExecutor.run(chat, h.resolved.config);
    const [chatGrant, , chatBase] = (
      workspace.ensureGrokSandboxProfile as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1)! as [{ writeRoots: string[] }, unknown, string | undefined];
    expect(chatGrant.writeRoots).toEqual([realpathSync(h.cwd)]);
    expect(chatBase).toBeUndefined();
  });

  it('cursor: perfil sem bypass obriga o conjunto guardado; lion_write so no arquivo de achados pelo host, lion_edit, lion_shell e leitura fora negados', async () => {
    const h = makeHarness('cursor');
    const { cursorExecutor } = await import('../cursor-executor');
    const result = await cursorExecutor.run(h.request, h.resolved.config);
    expect(result.output).toBe('STATUS: ok');
    expect(captured.cursorRuns).toHaveLength(1);
    const { config, dispatchTool } = captured.cursorRuns[0]!;
    expect(config.cwd).toBe(h.cwd);
    expect(config.guarded).toBe(true);
    expect(config.sandbox).toBeUndefined();
    expect(config.allowedTools).toEqual(['mcp']);
    const names = (config.customTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['lion_read', 'lion_glob', 'lion_grep', 'lion_write', 'lion_edit', 'lion_shell']),
    );
    const call = (toolName: string, args: Record<string, unknown>) =>
      dispatchTool({ toolName, args, callId: 'c' }, { signal: h.request.abortController.signal });
    await expect(call('lion_write', { file_path: h.findingsPath, content: '# achados' })).rejects.toThrow(
      /Operacao concluida pelo host/,
    );
    expect(h.writer).toHaveBeenCalledWith('# achados');
    await expect(call('lion_write', { file_path: join(h.cwd, 'x.txt'), content: 'x' })).rejects.toThrow(/negada/);
    expect(h.writer).toHaveBeenCalledTimes(1);
    await expect(
      call('lion_edit', { file_path: join(h.cwd, 'prompt.txt'), old_string: 'p', new_string: 'q' }),
    ).rejects.toThrow(/negada/);
    await expect(call('lion_shell', { command: 'curl https://example.com' })).rejects.toThrow(/negada/);
    await expect(call('lion_read', { file_path: join(TEST_HOME, 'fora.txt') })).rejects.toThrow(/negada/);
    await expect(call('lion_read', { file_path: join(h.cwd, 'prompt.txt') })).resolves.toContain('prompt');
    expect(h.request.prompt).toContain('use lion_write com file_path');
    expect(h.request.sessionScope).toEqual({ runId: RUN_ID, slug: 'auditor', generation: 1 });
  });

  it('codex: sandbox read-only forcado, MCP global isolado, achados so pelo swarm-worker, web desligada; leitura livre registrada', async () => {
    const h = makeHarness('codex');
    expect(h.request.codexConfigOverrides).toEqual([...SWARM_CODEX_CONFIG_OVERRIDES]);
    const { codexExecutor } = await import('../codex-executor');
    const result = await codexExecutor.run(h.request, h.resolved.config);
    expect(result.output).toBe('STATUS: ok');
    expect(captured.codexRuns).toHaveLength(1);
    const run = captured.codexRuns[0]!;
    expect(run.cwd).toBe(h.cwd);
    expect(run.sandbox).toBe('read-only');
    expect(run.approvalPolicy).toBe('never');
    expect(run.disableGlobalMcp).toBe(true);
    expect(run.extraArgs).toEqual([
      '-c',
      'mcp_servers.swarm-worker={command="node"}',
      '-c',
      'web_search="disabled"',
      '-c',
      'features.browser_use=false',
      '-c',
      'features.in_app_browser=false',
      '-c',
      'features.computer_use=false',
    ]);
    expect(run.swarmSpawnEnv).toEqual({ LIONCLAW_HELPER_TOKEN: 'token-de-teste' });
    expect((run.key as { ownerKind: string; ownerId: string }).ownerKind).toBe('swarm');
    expect((run.key as { ownerKind: string; ownerId: string }).ownerId).toBe(`${RUN_ID}/auditor/1`);
    expect(h.request.prompt).toContain('swarm_write_findings');
    expect(h.request.prompt).toContain('Nao use Write nem shell');
    expect(SWARM_RUNTIME_CAPABILITIES.codex.read).toBe('free');
  });

  it.each(['local', 'external'] as const)(
    '%s: o dispatcher do swarm e o toolDispatch da chamada; escrita fora dos achados, shell e web dao erro',
    async (runtime) => {
      const h = makeHarness(runtime);
      const executor =
        runtime === 'local'
          ? (await import('../local-executor')).localExecutor
          : (await import('../external-executor')).externalExecutor;
      const result = await executor.run(h.request, h.resolved.config);
      expect(result.output).toBe('STATUS: ok');
      expect(captured.ollamaCalls).toHaveLength(1);
      const options = captured.ollamaCalls[0]!.options;
      expect(options.cwd).toBe(h.cwd);
      expect(options.toolDispatch).toBe(h.request.swarmToolDispatch);
      expect(options.disableTaskRetry).toBe(true);
      await expectDispatchGuarantees(options.toolDispatch as Dispatch, h);
    },
  );

  it('external (protocolo google-genai): cada functionCall passa pelo dispatcher do swarm; Write so nos achados pelo host, shell, web e leitura fora negados', async () => {
    const h = makeHarness('external', ['Read', 'Glob', 'Grep', 'Write'], 'google-genai');
    (globalThis as { __swarmGenai?: { cwd: string; findingsPath: string } }).__swarmGenai = {
      cwd: h.cwd,
      findingsPath: h.findingsPath,
    };
    expect(h.resolved.agent.externalConfig?.protocol).toBe('google-genai');
    const { externalExecutor } = await import('../external-executor');
    const result = await externalExecutor.run(h.request, h.resolved.config);
    expect(result.output).toBe('STATUS: ok');
    expect(captured.localToolCalls).toBe(0);
    expect(captured.genaiCalls).toHaveLength(2);
    const contents = captured.genaiCalls[1]!.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const responses = contents
      .filter((entry) => entry.role === 'user')
      .flatMap((entry) => entry.parts)
      .map(
        (part) => part.functionResponse as { name: string; response: { result: string; isError: boolean } } | undefined,
      )
      .filter((part): part is NonNullable<typeof part> => part !== undefined);
    expect(responses.map((r) => [r.name, r.response.isError])).toEqual([
      ['Write', true],
      ['Write', false],
      ['Bash', true],
      ['WebFetch', true],
      ['Read', true],
      ['Read', false],
    ]);
    expect(h.writer).toHaveBeenCalledTimes(1);
    expect(h.writer).toHaveBeenCalledWith('# achados');
    expect(responses[5]!.response.result).toBe('prompt');
    const tools = (
      captured.genaiCalls[0]!.config as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }
    ).tools;
    expect(tools.flatMap((t) => t.functionDeclarations.map((d) => d.name)).sort()).toEqual([
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
  });
});

const READERS = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
].map((t) => `mcp__repo-graph__${t}`);
const REPO_GRAPH_WRITE_TOOL = 'mcp__repo-graph__repo_graph_build';
const REPO_GRAPH_ENTRY = {
  'repo-graph': { command: '/node', args: ['/repo-graph.js'], env: { LIONCLAW_HELPER_TOKEN: 't' } },
};
interface RepoGraphHarness extends Harness {
  invoke: ReturnType<typeof vi.fn<(tool: string, params: Record<string, unknown>) => Promise<unknown>>>;
}
function makeRepoGraphHarness(
  runtime: SwarmRuntime,
  protocol: ExternalProtocol = 'openai-compatible',
  withRepository = true,
): RepoGraphHarness {
  const base = makeHarness(runtime, ['Read', 'Glob', 'Grep', 'Write'], protocol);
  const invoke = vi.fn<(tool: string, params: Record<string, unknown>) => Promise<unknown>>(async (tool, params) => ({
    tool,
    params,
    symbols: [],
  }));
  const allowedTools = withRepository
    ? [...base.resolved.config.allowedTools, ...READERS]
    : base.resolved.config.allowedTools;
  const resolved: SwarmResolvedMember = {
    ...base.resolved,
    agent: { ...base.resolved.agent, allowedTools, mcpServers: ['repo-graph'] },
    config: { ...base.resolved.config, allowedTools },
    repoGraph: withRepository ? { repositoryId: 'repo-1', rootPath: base.cwd, status: 'ready' } : null,
    repoGraphState: withRepository ? 'ready' : 'no-repository',
  };
  const request = buildSwarmExecutionRequest({
    resolved,
    cwd: base.cwd,
    prompt: 'ALVO: src/',
    findingsPath: base.findingsPath,
    runId: RUN_ID,
    slug: 'auditor',
    generation: 1,
    settings: { concurrencyCap: 5, maxAttempts: 2, idleTimeoutMs: 60_000, hardTimeoutMs: 60_000, openWindowMs: 1 },
    abortController: new AbortController(),
    writeFindings: base.writer,
    repoGraphInvoke: withRepository ? invoke : null,
    repoGraphMcp: withRepository ? REPO_GRAPH_ENTRY : null,
    ...(runtime === 'codex'
      ? {
          codexBridge: {
            extraArgs: [
              '-c',
              'mcp_servers.swarm-worker={command="node"}',
              '-c',
              'mcp_servers.repo-graph={command="node"}',
            ],
            spawnEnv: { LIONCLAW_HELPER_TOKEN: 'token-de-teste' },
          },
          sessionOptions: { onCodexSessionCreated: () => {} },
        }
      : {}),
  });
  return { ...base, resolved, request, invoke };
}

describe('repo-graph (so leitura) chega ao executor real de cada runtime quando a run roda num repositorio registrado', () => {
  it.each(['cloud', 'zai', 'minimax-tp'] as const)(
    '%s: o MCP repo-graph sobe no query do SDK, as sete tools de leitura entram em tools e no canUseTool; build e negada; Read ganha limit 400',
    async (runtime) => {
      const h = makeRepoGraphHarness(runtime);
      const executor =
        runtime === 'cloud'
          ? (await import('../cloud-executor')).cloudExecutor
          : runtime === 'zai'
            ? (await import('../zai-executor')).zaiExecutor
            : (await import('../minimax-tokenplan-executor')).minimaxTokenplanExecutor;
      await executor.run(h.request, h.request.resolvedConfigOverride!);
      const options = captured.queryOptions[0]!;
      expect(options.mcpServers).toEqual(REPO_GRAPH_ENTRY);
      expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Write', ...READERS]);
      const canUseTool = options.canUseTool as CanUse;
      const c = ctx(h.request.abortController.signal);
      for (const tool of READERS) expect(behavior(await canUseTool(tool, { term: 'x' }, c)), tool).toBe('allow');
      expect(behavior(await canUseTool(REPO_GRAPH_WRITE_TOOL, {}, c))).toBe('deny');
      expect(behavior(await canUseTool('mcp__repo-graph__repo_graph_update', {}, c))).toBe('deny');
      const read = await canUseTool('Read', { file_path: join(h.cwd, 'prompt.txt') }, c);
      expect(read).toEqual({ behavior: 'allow', updatedInput: { file_path: join(h.cwd, 'prompt.txt'), limit: 400 } });
      const hook = (
        options.hooks as {
          PreToolUse: Array<{ hooks: Array<(e: unknown, id: string, o: unknown) => Promise<unknown>> }>;
        }
      ).PreToolUse[0]!.hooks[0]!;
      const allowed = (await hook(
        { hook_event_name: 'PreToolUse', tool_name: 'mcp__repo-graph__repo_graph_search', tool_input: { term: 'x' } },
        'id',
        { signal: h.request.abortController.signal },
      )) as { hookSpecificOutput: { permissionDecision: string } };
      expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
      const denied = (await hook(
        { hook_event_name: 'PreToolUse', tool_name: REPO_GRAPH_WRITE_TOOL, tool_input: {} },
        'id',
        { signal: h.request.abortController.signal },
      )) as { hookSpecificOutput: { permissionDecision: string } };
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
      await expectProfileGuarantees(canUseTool, h);
    },
  );

  it('cloud sem repositorio registrado: nenhum MCP sobe e nenhuma tool do repo-graph entra', async () => {
    const h = makeRepoGraphHarness('cloud', 'openai-compatible', false);
    const { cloudExecutor } = await import('../cloud-executor');
    await cloudExecutor.run(h.request, h.request.resolvedConfigOverride!);
    const options = captured.queryOptions[0]!;
    expect(options.mcpServers).toBeUndefined();
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Write']);
    const canUseTool = options.canUseTool as CanUse;
    expect(behavior(await canUseTool(READERS[1]!, { term: 'x' }, ctx(h.request.abortController.signal)))).toBe('deny');
  });

  it('kimi: as sete tools de leitura entram na bridge e chamam o repo-graph em processo; build nao existe na bridge', async () => {
    const h = makeRepoGraphHarness('kimi');
    const { kimiExecutor } = await import('../kimi-executor');
    await kimiExecutor.run(h.request, h.request.resolvedConfigOverride!);
    const tools = captured.kimiBridges[0]!;
    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep', 'Write', ...READERS]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.handler]));
    const result = await byName['mcp__repo-graph__repo_graph_search']!({ term: 'login' });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      tool: 'mcp__repo-graph__repo_graph_search',
      params: { term: 'login' },
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(byName[REPO_GRAPH_WRITE_TOOL]).toBeUndefined();
    expect((await (h.request.swarmToolDispatch as Dispatch)(REPO_GRAPH_WRITE_TOOL, {})).isError).toBe(true);
  });

  it('grok: as tools de leitura viram external tools diretas da bridge (sem mcp_invoke) e o nativo continua sem web; build nao entra', async () => {
    const h = makeRepoGraphHarness('grok');
    const { grokExecutor } = await import('../grok-executor');
    await grokExecutor.run(h.request, h.request.resolvedConfigOverride!);
    expect(captured.grokBridges).toHaveLength(1);
    const tools = captured.grokBridges[0]!;
    expect(tools.map((tool) => tool.name)).toEqual(READERS);
    const callers = tools.find((tool) => tool.name === 'mcp__repo-graph__repo_graph_callers')!;
    const search = await callers.handler({ symbol: 'login' });
    expect(JSON.parse(search.output)).toMatchObject({
      tool: 'mcp__repo-graph__repo_graph_callers',
      params: { symbol: 'login' },
    });
    const run = captured.grokRuns[0]!;
    expect(run.nativeToolArgs).toContain('--disable-web-search');
    expect(String((run.nativeToolArgs as string[])[1] ?? '')).not.toMatch(/mcp/);
    expect(run.mcpServers).toEqual([{ name: 'lionclaw', url: 'http://127.0.0.1:2' }]);
  });

  it('cursor: as tools de leitura entram como custom tools do sidecar e lion_read sem faixa devolve so 400 linhas', async () => {
    const h = makeRepoGraphHarness('cursor');
    writeFileSync(join(h.cwd, 'grande.ts'), Array.from({ length: 500 }, (_, i) => `linha ${i + 1}`).join('\n'), 'utf8');
    const { cursorExecutor } = await import('../cursor-executor');
    await cursorExecutor.run(h.request, h.request.resolvedConfigOverride!);
    const { config, dispatchTool } = captured.cursorRuns[0]!;
    const names = (config.customTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['lion_read', ...READERS]));
    expect(names).not.toContain(REPO_GRAPH_WRITE_TOOL);
    const call = (toolName: string, args: Record<string, unknown>) =>
      dispatchTool({ toolName, args, callId: 'c' }, { signal: h.request.abortController.signal });
    const node = (await call('mcp__repo-graph__repo_graph_node', { name: 'login' })) as string;
    expect(JSON.parse(node)).toMatchObject({ tool: 'mcp__repo-graph__repo_graph_node', params: { name: 'login' } });
    const read = (await call('lion_read', { file_path: join(h.cwd, 'grande.ts') })) as string;
    expect(read).toContain('linha 400');
    expect(read).not.toContain('linha 401\n');
    expect(read).toMatch(/100 linhas restantes; use offset\/limit/);
    const ranged = (await call('lion_read', { file_path: join(h.cwd, 'grande.ts'), offset: 450, limit: 10 })) as string;
    expect(ranged.startsWith('linha 451\n')).toBe(true);
    expect(ranged).toContain('linha 460');
  });

  it('codex: o segundo MCP (-c mcp_servers.repo-graph) viaja com o worker e o sandbox read-only continua; nenhuma tool entra no override', async () => {
    const h = makeRepoGraphHarness('codex');
    const { codexExecutor } = await import('../codex-executor');
    await codexExecutor.run(h.request, h.request.resolvedConfigOverride!);
    const run = captured.codexRuns[0]!;
    expect(run.sandbox).toBe('read-only');
    expect(run.extraArgs).toEqual(
      expect.arrayContaining([
        '-c',
        'mcp_servers.swarm-worker={command="node"}',
        '-c',
        'mcp_servers.repo-graph={command="node"}',
      ]),
    );
    expect(h.request.resolvedConfigOverride!.mcpServers).toEqual([]);
  });

  it.each(['local', 'external'] as const)(
    '%s: os schemas das sete tools de leitura entram ao lado das builtin e o dispatcher resolve; build e negada',
    async (runtime) => {
      const h = makeRepoGraphHarness(runtime);
      const executor =
        runtime === 'local'
          ? (await import('../local-executor')).localExecutor
          : (await import('../external-executor')).externalExecutor;
      await executor.run(h.request, h.request.resolvedConfigOverride!);
      expect(captured.ollamaTools[0]!.map((tool) => tool.function.name)).toEqual([
        'Read',
        'Glob',
        'Grep',
        'Write',
        ...READERS,
      ]);
      const dispatch = captured.ollamaCalls[0]!.options.toolDispatch as Dispatch;
      const result = await dispatch('mcp__repo-graph__repo_graph_minimal_context', { task: 'auth' });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.result)).toMatchObject({ params: { task: 'auth' } });
      expect((await dispatch(REPO_GRAPH_WRITE_TOOL, {})).isError).toBe(true);
      expect(h.invoke).toHaveBeenCalledTimes(1);
    },
  );

  it('external (google-genai): as function declarations incluem as sete tools de leitura', async () => {
    const h = makeRepoGraphHarness('external', 'google-genai');
    (globalThis as { __swarmGenai?: { cwd: string; findingsPath: string } }).__swarmGenai = {
      cwd: h.cwd,
      findingsPath: h.findingsPath,
    };
    const { externalExecutor } = await import('../external-executor');
    await externalExecutor.run(h.request, h.request.resolvedConfigOverride!);
    const tools = (
      captured.genaiCalls[0]!.config as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }
    ).tools;
    expect(tools.flatMap((t) => t.functionDeclarations.map((d) => d.name))).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      ...READERS,
    ]);
  });
});
