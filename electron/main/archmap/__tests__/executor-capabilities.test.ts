import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionOrchestrator } from '../../../../src/types';
import type { AgentExecutionRequest } from '../../agent-runtime/types';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'lionclaw-archmap-home-'));
process.env.LIONCLAW_TEST_HOME = TEST_HOME;

const captured = vi.hoisted(() => ({
  queryOptions: [] as Array<Record<string, unknown>>,
  kimiRuns: [] as Array<Record<string, unknown>>,
  grokRuns: [] as Array<Record<string, unknown>>,
  cursorRuns: [] as Array<{ config: Record<string, unknown>; dispatchTool: (...args: unknown[]) => Promise<unknown> }>,
  codexRuns: [] as Array<Record<string, unknown>>,
  ollamaCalls: [] as Array<{ options: Record<string, unknown> }>,
  genaiCalls: [] as Array<Record<string, unknown>>,
  localToolCalls: 0,
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../db', () => ({
  getSetting: (key: string) => {
    if (key === 'orchestrator_zai_api_key_ref') return 'zai-ref';
    if (key === 'orchestrator_minimax_api_key_ref') return 'minimax-ref';
    if (key === 'orchestrator_vertex_api_key_ref') return 'vertex-ref';
    if (key === 'grok_max_concurrency') return '3';
    return '';
  },
  getAgent: () => undefined,
  getEnabledTools: () => [],
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
      yield { type: 'result', subtype: 'success', result: '{"ok":true}' };
    })();
  },
}));
vi.mock('../../stream-processor', () => ({
  processAgentStream: async () => ({
    output: '{"ok":true}',
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 1,
    },
    accumulatedText: '{"ok":true}',
    textBlocks: ['{"ok":true}'],
  }),
}));
vi.mock('../../agent-runtime/swarm-process', () => ({
  createSwarmProcessOwner: () => ({ spawnProcess: () => ({}), closeConfirmed: async () => {} }),
}));
vi.mock('../../agent-runtime/mcp-warning', () => ({ warnMcpToolsDroppedOnce: () => {}, warnOncePerAgent: () => {} }));

vi.mock('../../agent-runtime/kimi-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/kimi-availability')>();
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
vi.mock('../../agent-runtime/kimi-concurrency', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/kimi-concurrency')>();
  return { ...actual, acquireKimiSlot: async () => () => {} };
});
vi.mock('../../agent-runtime/kimi-session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/kimi-session-config')>();
  return { ...actual, buildKimiSessionTools: async () => ({ systemPrompt: '', externalTools: [] }) };
});
vi.mock('../../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: () => ({
    createRun: async (opts: Record<string, unknown>) => {
      captured.kimiRuns.push(opts);
      return {
        send: async () => ({
          content: '{"ok":true}',
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
vi.mock('../../kimi-acp/mcp-http-bridge', () => ({ startKimiMcpBridge: async () => ({}) }));

vi.mock('../../grok-acp/acp-driver', () => ({
  getGrokAcpDriver: () => ({
    createRun: async (opts: Record<string, unknown>) => {
      captured.grokRuns.push(opts);
      return {
        send: async () => ({
          content: '{"ok":true}',
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
vi.mock('../../grok-acp/mcp-http-bridge', () => ({ startGrokMcpBridge: async () => ({}) }));
vi.mock('../../agent-runtime/grok-session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/grok-session-config')>();
  return { ...actual, buildGrokSessionTools: async () => ({ externalTools: [], systemPrompt: '' }) };
});
vi.mock('../../agent-runtime/grok-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/grok-availability')>();
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
    ensureGrokSandboxProfile: (_grant: unknown, _home: unknown, requested?: string) => requested ?? 'workspace',
    snapshotGrokSandboxAttestation: () => ({}),
    waitForGrokSandboxApplied: async () => {},
    attestGrokSession: () => {},
    assertGrokWorkspaceUnchanged: () => {},
    grokInputTouchesProtectedSource: () => false,
  };
});

vi.mock('../../agent-runtime/cursor-sidecar/sidecar-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/cursor-sidecar/sidecar-manager')>();
  return {
    ...actual,
    runCursorSidecarExecution: async (opts: {
      config: Record<string, unknown>;
      dispatchTool: (...args: unknown[]) => Promise<unknown>;
    }) => {
      captured.cursorRuns.push({ config: opts.config, dispatchTool: opts.dispatchTool });
      return { status: 'finished', finalText: '{"ok":true}', durationMs: 1 };
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
      threadId: null,
      send: async () => ({
        status: 'completed',
        content: '{"ok":true}',
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
    _tools: unknown[],
    options: Record<string, unknown>,
  ) => {
    captured.ollamaCalls.push({ options });
    return { content: '{"ok":true}', model, tokensUsed: 1, promptTokens: 1, toolCalls: [], apiRequests: 1 };
  },
}));
vi.mock('../../agent-runtime/external-http', () => ({
  resolveExternalAuth: async () => ({}),
  ollamaChatWithRetry: async (
    _baseUrl: string,
    model: string,
    _system: string,
    _prompt: string,
    _tools: unknown[],
    options: Record<string, unknown>,
  ) => {
    captured.ollamaCalls.push({ options });
    return { content: '{"ok":true}', model, tokensUsed: 1, promptTokens: 1, toolCalls: [], apiRequests: 1 };
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
            const cwd = (globalThis as { __archmapCwd?: string }).__archmapCwd ?? '';
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { name: 'Write', args: { file_path: join(cwd, 'x.txt'), content: 'x' } } },
                      { functionCall: { name: 'Bash', args: { command: 'curl https://example.com' } } },
                      { functionCall: { name: 'WebFetch', args: { url: 'https://example.com' } } },
                      { functionCall: { name: 'Read', args: { file_path: join(cwd, '..', 'fora.txt') } } },
                      { functionCall: { name: 'Read', args: { file_path: join(cwd, 'prompt.txt') } } },
                    ],
                  },
                },
              ],
            };
          } else {
            yield { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] };
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

import { buildArchmapAgent, buildArchmapExecutionRequest } from '../agent-executor';
import { fakeArchmapPatch } from './helpers';

const SELECTIONS: Record<string, SessionOrchestrator> = {
  cloud: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' },
  zai: { runtime: 'claude-compat-sdk', provider: 'zai', model: 'glm-5.2' },
  'minimax-tp': { runtime: 'claude-compat-sdk', provider: 'minimax', model: 'minimax-m3' },
  kimi: { runtime: 'kimi-sdk', provider: 'kimi', model: 'kimi-code/k3', effort: 'max' },
  grok: { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.6', effort: 'medium' },
  cursor: { runtime: 'cursor-sdk', provider: 'cursor', model: 'composer-2.5' },
  codex: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
  local: { runtime: 'lion-sdk', provider: 'ollama', model: 'llama4' },
  external: { runtime: 'lion-sdk', provider: 'openai-compatible', model: 'compat-1' },
  'google-genai': { runtime: 'lion-sdk', provider: 'vertex-ai', model: 'gemini-3' },
};

type CanUse = NonNullable<AgentExecutionRequest['permission']['canUseTool']>;

function behavior(result: Awaited<ReturnType<CanUse>>): string {
  return result?.behavior ?? 'null';
}

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lionclaw-archmap-scratch-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'prompt.txt'), 'prompt', 'utf8');
  writeFileSync(join(dir, 'sub', 'source-1.txt'), '1: export const a = 1;', 'utf8');
  writeFileSync(join(TEST_HOME, 'fora.txt'), 'fora', 'utf8');
  return dir;
}

function requestFor(key: string, cwd: string) {
  const build = buildArchmapAgent(SELECTIONS[key]!, fakeArchmapPatch);
  const abortController = new AbortController();
  const request = buildArchmapExecutionRequest({ build, cwd, prompt: 'tarefa', abortController, timeoutMs: 60_000 });
  return { build, request };
}

async function expectProfileGuarantees(canUseTool: CanUse, cwd: string, signal: AbortSignal): Promise<void> {
  const ctx = { signal, toolUseID: 't', requestId: 'r' } as never;
  expect(behavior(await canUseTool('Write', { file_path: join(cwd, 'resultado.json'), content: '{}' }, ctx))).toBe(
    'deny',
  );
  expect(behavior(await canUseTool('Write', { file_path: join(TEST_HOME, 'home.txt'), content: 'x' }, ctx))).toBe(
    'deny',
  );
  expect(
    behavior(await canUseTool('Edit', { file_path: join(cwd, 'prompt.txt'), old_string: 'a', new_string: 'b' }, ctx)),
  ).toBe('deny');
  expect(behavior(await canUseTool('Bash', { command: 'curl https://example.com' }, ctx))).toBe('deny');
  expect(behavior(await canUseTool('Bash', { command: 'ls' }, ctx))).toBe('deny');
  expect(behavior(await canUseTool('WebFetch', { url: 'https://example.com' }, ctx))).toBe('deny');
  expect(behavior(await canUseTool('WebSearch', { query: 'lionclaw' }, ctx))).toBe('deny');
  expect(behavior(await canUseTool('mcp__lionclaw__anything', {}, ctx))).toBe('deny');
  expect(behavior(await canUseTool('Read', { file_path: join(cwd, 'prompt.txt') }, ctx))).toBe('allow');
  expect(behavior(await canUseTool('Read', { file_path: join(TEST_HOME, 'fora.txt') }, ctx))).toBe('deny');
  expect(behavior(await canUseTool('Glob', { pattern: '**/*.txt', path: cwd }, ctx))).toBe('allow');
  expect(behavior(await canUseTool('Grep', { pattern: 'a', path: TEST_HOME }, ctx))).toBe('deny');
}

async function expectDispatchGuarantees(
  dispatch: NonNullable<AgentExecutionRequest['swarmToolDispatch']>,
  cwd: string,
): Promise<void> {
  expect((await dispatch('Write', { file_path: join(cwd, 'x.txt'), content: 'x' })).isError).toBe(true);
  expect((await dispatch('Edit', { file_path: join(cwd, 'prompt.txt') })).isError).toBe(true);
  expect((await dispatch('Bash', { command: 'curl https://example.com' })).isError).toBe(true);
  expect((await dispatch('WebFetch', { url: 'https://example.com' })).isError).toBe(true);
  expect((await dispatch('WebSearch', { query: 'x' })).isError).toBe(true);
  const inside = await dispatch('Read', { file_path: join(cwd, 'prompt.txt') });
  expect(inside.isError).toBe(false);
  expect(inside.result).toBe('prompt');
  expect((await dispatch('Read', { file_path: join(TEST_HOME, 'fora.txt') })).isError).toBe(true);
}

const scratches: string[] = [];
beforeEach(() => {
  captured.queryOptions.length = 0;
  captured.kimiRuns.length = 0;
  captured.grokRuns.length = 0;
  captured.cursorRuns.length = 0;
  captured.codexRuns.length = 0;
  captured.ollamaCalls.length = 0;
  captured.genaiCalls.length = 0;
  captured.localToolCalls = 0;
});
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('AC-10: o perfil do mapa chega ao executor real de cada runtime (SDKs mockados, sem rede)', () => {
  it.each(['cloud', 'zai', 'minimax-tp'])(
    '%s: canUseTool e hook PreToolUse do Agent SDK sao o perfil do mapa; tools = Read/Glob/Grep',
    async (key) => {
      const cwd = makeScratch();
      scratches.push(cwd);
      const { build, request } = requestFor(key, cwd);
      const executor =
        key === 'cloud'
          ? (await import('../../agent-runtime/cloud-executor')).cloudExecutor
          : key === 'zai'
            ? (await import('../../agent-runtime/zai-executor')).zaiExecutor
            : (await import('../../agent-runtime/minimax-tokenplan-executor')).minimaxTokenplanExecutor;
      const result = await executor.run(request, build.config);
      expect(result.output).toBe('{"ok":true}');
      expect(captured.queryOptions).toHaveLength(1);
      const options = captured.queryOptions[0]!;
      expect(options.cwd).toBe(cwd);
      expect(options.permissionMode).toBe('default');
      expect(options.allowDangerouslySkipPermissions).toBe(false);
      expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
      expect(options.allowedTools).toEqual([]);
      expect(options.settingSources).toEqual([]);
      expect(options.mcpServers).toBeUndefined();
      expect(typeof options.canUseTool).toBe('function');
      expect((options.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);
      await expectProfileGuarantees(options.canUseTool as CanUse, cwd, request.abortController.signal);
      const hook = (
        options.hooks as {
          PreToolUse: Array<{ hooks: Array<(e: unknown, id: string, o: unknown) => Promise<unknown>> }>;
        }
      ).PreToolUse[0]!.hooks[0]!;
      const denied = (await hook(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl x' } },
        'id',
        { signal: request.abortController.signal },
      )) as { hookSpecificOutput: { permissionDecision: string } };
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    },
  );

  it('kimi: o driver ACP recebe o perfil do mapa como permission e cwd = rascunho', async () => {
    const cwd = makeScratch();
    scratches.push(cwd);
    const { build, request } = requestFor('kimi', cwd);
    const { kimiExecutor } = await import('../../agent-runtime/kimi-executor');
    const result = await kimiExecutor.run(request, build.config);
    expect(result.output).toBe('{"ok":true}');
    expect(captured.kimiRuns).toHaveLength(1);
    const run = captured.kimiRuns[0]!;
    expect(run.workDir).toBe(cwd);
    expect(run.permission).toBe(request.permission);
    expect(run.mcpServers).toEqual([]);
    expect(run.swarmSupervised).toBe(true);
    const permission = run.permission as AgentExecutionRequest['permission'];
    expect(permission.dangerouslySkipPermissions).toBe(false);
    expect(permission.mode).toBe('default');
    await expectProfileGuarantees(permission.canUseTool!, cwd, request.abortController.signal);
  });

  it('grok: workspace grant com sessionCwd/readRoots = rascunho, perfil no driver e busca web desligada', async () => {
    const cwd = makeScratch();
    scratches.push(cwd);
    const { build, request } = requestFor('grok', cwd);
    const { grokExecutor } = await import('../../agent-runtime/grok-executor');
    const workspace = await import('../../grok-sdk/workspace');
    const result = await grokExecutor.run(request, build.config);
    expect(result.output).toBe('{"ok":true}');
    const grant = (
      workspace.resolveGrokWorkspaceGrant as unknown as { mock: { results: Array<{ value: unknown }> } }
    ).mock.results.at(-1)!.value as {
      sessionCwd: string;
      readRoots: string[];
      writeRoots: string[];
      processCwd: string;
    };
    const { realpathSync } = await import('node:fs');
    expect(grant.sessionCwd).toBe(realpathSync(cwd));
    expect(grant.readRoots).toEqual([realpathSync(cwd)]);
    expect(grant.writeRoots).toEqual([realpathSync(cwd)]);
    expect(captured.grokRuns).toHaveLength(1);
    const run = captured.grokRuns[0]!;
    expect(run.workDir).toBe(cwd);
    expect(run.processCwd).toBe(realpathSync(cwd));
    expect(run.permission).toBe(request.permission);
    expect(run.nativeToolArgs).toContain('--disable-web-search');
    const tools = String((run.nativeToolArgs as string[])[1] ?? '');
    expect(tools).not.toMatch(/web_search|web_fetch|bash|shell|write|edit/);
    await expectProfileGuarantees(
      (run.permission as AgentExecutionRequest['permission']).canUseTool!,
      cwd,
      request.abortController.signal,
    );
  });

  it('cursor: perfil sem bypass obriga o conjunto guardado; lion_write, lion_edit, lion_shell e leitura fora sao negados', async () => {
    const cwd = makeScratch();
    scratches.push(cwd);
    const { build, request } = requestFor('cursor', cwd);
    const { cursorExecutor } = await import('../../agent-runtime/cursor-executor');
    const result = await cursorExecutor.run(request, build.config);
    expect(result.output).toBe('{"ok":true}');
    expect(captured.cursorRuns).toHaveLength(1);
    const { config, dispatchTool } = captured.cursorRuns[0]!;
    expect(config.cwd).toBe(cwd);
    expect(config.guarded).toBe(true);
    expect(config.sandbox).toBeUndefined();
    const names = (config.customTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['lion_read', 'lion_glob', 'lion_grep', 'lion_write', 'lion_edit', 'lion_shell']),
    );
    const call = (toolName: string, args: Record<string, unknown>) =>
      dispatchTool({ toolName, args, callId: 'c' }, { signal: request.abortController.signal });
    await expect(call('lion_write', { file_path: join(cwd, 'x.txt'), content: 'x' })).rejects.toThrow(/negada/);
    await expect(
      call('lion_edit', { file_path: join(cwd, 'prompt.txt'), old_string: 'p', new_string: 'q' }),
    ).rejects.toThrow(/negada/);
    await expect(call('lion_shell', { command: 'curl https://example.com' })).rejects.toThrow(/negada/);
    await expect(call('lion_read', { file_path: join(TEST_HOME, 'fora.txt') })).rejects.toThrow(/negada/);
    await expect(call('lion_read', { file_path: join(cwd, 'prompt.txt') })).resolves.toContain('prompt');
  });

  it('codex: executionAgent forca sandbox read-only, MCP global isolado e app-server com web_search="disabled" (F42)', async () => {
    const cwd = makeScratch();
    scratches.push(cwd);
    const { build, request } = requestFor('codex', cwd);
    expect(request.codexConfigOverrides).toContain('web_search="disabled"');
    const { codexExecutor } = await import('../../agent-runtime/codex-executor');
    const result = await codexExecutor.run(request, build.config);
    expect(result.output).toBe('{"ok":true}');
    expect(captured.codexRuns).toHaveLength(1);
    const run = captured.codexRuns[0]!;
    expect(run.cwd).toBe(cwd);
    expect(run.sandbox).toBe('read-only');
    expect(run.approvalPolicy).toBe('never');
    expect(run.disableGlobalMcp).toBe(true);
    const extraArgs = run.extraArgs as string[];
    expect(extraArgs).toEqual([
      '-c',
      'web_search="disabled"',
      '-c',
      'features.browser_use=false',
      '-c',
      'features.in_app_browser=false',
      '-c',
      'features.computer_use=false',
    ]);
  });

  it('codex: overrides fora da allowlist ou fora do sandbox read-only sao recusados pelo adaptador', async () => {
    const { validateCodexConfigOverrides } = await import('../../agent-runtime/codex-session-factory');
    const base = {
      surface: 'agent-scoped' as const,
      mcpProfile: 'agent-scoped' as const,
      sessionOptions: { model: 'gpt-6-sol', cwd: '/x', systemPrompt: '', sandbox: 'read-only' as const },
      disableGlobalMcp: true,
    };
    expect(validateCodexConfigOverrides({ ...base, codexConfigOverrides: ['web_search="disabled"'] })).toEqual([
      '-c',
      'web_search="disabled"',
    ]);
    expect(validateCodexConfigOverrides({ ...base })).toEqual([]);
    expect(() => validateCodexConfigOverrides({ ...base, codexConfigOverrides: ['model="x"'] })).toThrow(
      /nao permitido/,
    );
    expect(() =>
      validateCodexConfigOverrides({ ...base, codexConfigOverrides: ['web_search="live"; rm -rf /'] }),
    ).toThrow(/nao permitido/);
    expect(() =>
      validateCodexConfigOverrides({
        ...base,
        sessionOptions: { ...base.sessionOptions, sandbox: 'workspace-write' },
        codexConfigOverrides: ['web_search="disabled"'],
      }),
    ).toThrow(/read-only/);
    expect(() =>
      validateCodexConfigOverrides({
        ...base,
        disableGlobalMcp: false,
        codexConfigOverrides: ['web_search="disabled"'],
      }),
    ).toThrow(/read-only/);
  });

  it.each(['local', 'external'])(
    '%s: o dispatcher do mapa e o toolDispatch da chamada; escrita, shell e web dao erro',
    async (key) => {
      const cwd = makeScratch();
      scratches.push(cwd);
      const { build, request } = requestFor(key, cwd);
      const executor =
        key === 'local'
          ? (await import('../../agent-runtime/local-executor')).localExecutor
          : (await import('../../agent-runtime/external-executor')).externalExecutor;
      const result = await executor.run(request, build.config);
      expect(result.output).toBe('{"ok":true}');
      expect(captured.ollamaCalls).toHaveLength(1);
      const options = captured.ollamaCalls[0]!.options;
      expect(options.cwd).toBe(cwd);
      expect(options.toolDispatch).toBe(request.swarmToolDispatch);
      expect(options.disableTaskRetry).toBe(true);
      await expectDispatchGuarantees(
        options.toolDispatch as NonNullable<AgentExecutionRequest['swarmToolDispatch']>,
        cwd,
      );
    },
  );

  it('google-genai: runtime external com protocolo google-genai usa o dispatcher do mapa em cada functionCall', async () => {
    const cwd = makeScratch();
    scratches.push(cwd);
    (globalThis as { __archmapCwd?: string }).__archmapCwd = cwd;
    const { build, request } = requestFor('google-genai', cwd);
    expect(build.agent.externalConfig?.protocol).toBe('google-genai');
    const { externalExecutor } = await import('../../agent-runtime/external-executor');
    const result = await externalExecutor.run(request, build.config);
    expect(result.output).toBe('{"ok":true}');
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
      ['Bash', true],
      ['WebFetch', true],
      ['Read', true],
      ['Read', false],
    ]);
    expect(responses[4]!.response.result).toBe('prompt');
    const tools = (
      captured.genaiCalls[0]!.config as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }
    ).tools;
    expect(tools.flatMap((t) => t.functionDeclarations.map((d) => d.name)).sort()).toEqual(['Glob', 'Grep', 'Read']);
  });
});
