import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionOrchestrator } from '../../../../src/types';
import type { AgentExecutionRequest, AgentExecutionResult } from '../../agent-runtime/types';
import {
  ARCHMAP_CODEX_CONFIG_OVERRIDES,
  ARCHMAP_MAX_REPAIRS,
  ArchmapAgentRejectedError,
  buildArchmapAgent,
  buildArchmapExecutionRequest,
  createArchmapAgentExecutor,
  type ArchmapAgentPatch,
} from '../agent-executor';
import { extractJsonObject } from '../text';
import { makeTempDir, removeDir } from './helpers';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const SELECTIONS: Record<string, SessionOrchestrator> = {
  cloud: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' },
  codex: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
  'codex-official': { runtime: 'codex-sdk', provider: 'codex-official', model: 'gpt-6-sol' },
  zai: { runtime: 'claude-compat-sdk', provider: 'zai', model: 'glm-5.2' },
  'minimax-tp': { runtime: 'claude-compat-sdk', provider: 'minimax', model: 'minimax-m3' },
  kimi: { runtime: 'kimi-sdk', provider: 'kimi', model: 'kimi-k3', effort: 'max' },
  grok: { runtime: 'grok-sdk', provider: 'grok', model: 'grok-4.6', effort: 'medium' },
  cursor: { runtime: 'cursor-sdk', provider: 'cursor', model: 'composer-2.5' },
  local: { runtime: 'lion-sdk', provider: 'ollama', model: 'llama4' },
  external: { runtime: 'lion-sdk', provider: 'openai-compatible', model: 'compat-1' },
  'google-genai': { runtime: 'lion-sdk', provider: 'vertex-ai', model: 'gemini-3' },
};

function fakePatch(selection: SessionOrchestrator): ArchmapAgentPatch {
  switch (`${selection.runtime}|${selection.provider}`) {
    case 'claude-sdk|anthropic':
      return { runtime: 'cloud', model: selection.model, effort: 'high' };
    case 'codex-sdk|codex':
      return {
        runtime: 'codex',
        model: selection.model,
        codexConfig: { model: selection.model, sandbox: 'workspace-write', reasoningEffort: 'high' },
      };
    case 'claude-compat-sdk|zai':
      return { runtime: 'zai', model: selection.model };
    case 'claude-compat-sdk|minimax':
      return { runtime: 'minimax-tp', model: selection.model };
    case 'kimi-sdk|kimi':
      return { runtime: 'kimi', model: selection.model, effort: 'max' };
    case 'grok-sdk|grok':
      return { runtime: 'grok', model: selection.model, effort: 'medium' };
    case 'cursor-sdk|cursor':
      return { runtime: 'cursor', model: selection.model };
    case 'lion-sdk|ollama':
      return {
        runtime: 'local',
        model: selection.model,
        localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: selection.model },
        localMode: 'smart',
      };
    case 'lion-sdk|openai-compatible':
      return {
        runtime: 'external',
        model: selection.model,
        externalConfig: {
          provider: 'openai-compatible',
          protocol: 'openai-compatible',
          model: selection.model,
          baseUrl: 'https://fixture.invalid',
          apiKeyRef: 'vault-ref',
        },
      };
    case 'lion-sdk|vertex-ai':
      return {
        runtime: 'external',
        model: selection.model,
        externalConfig: {
          provider: 'gemini-agent-platform',
          protocol: 'google-genai',
          model: selection.model,
          apiKeyRef: 'vault-ref',
        },
      };
    default:
      throw new Error(`sem patch para ${selection.runtime}/${selection.provider}`);
  }
}

function result(output: string): AgentExecutionResult {
  return {
    output,
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 1,
      costUsd: 0,
      durationMs: 1,
    },
    model: 'm',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

type CanUse = NonNullable<AgentExecutionRequest['permission']['canUseTool']>;

function behavior(result: Awaited<ReturnType<CanUse>>): string {
  return result?.behavior ?? 'null';
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) removeDir(dir);
});

describe('parser tolerante do texto final', () => {
  it('aceita JSON puro, cercado e com prosa em volta', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Segue:\n```json\n{"a":1,"b":[1,2]}\n```\nfim')).toEqual({ a: 1, b: [1, 2] });
    expect(extractJsonObject('texto antes {"a":{"b":"}"}} texto depois')).toEqual({ a: { b: '}' } });
    expect(extractJsonObject('Pensei: {"rascunho": true}. Resposta final:\n{"final": true}')).toEqual({ final: true });
  });

  it('recusa texto sem objeto JSON e arrays soltos', () => {
    expect(() => extractJsonObject('nada aqui')).toThrow(/JSON/);
    expect(() => extractJsonObject('[1,2,3]')).toThrow(/JSON/);
  });
});

describe('executor do mapa sobre executeAgent (SPEC 5.2)', () => {
  it('devolve o valor validado do texto final e conta a chamada', async () => {
    const cwd = makeTempDir();
    temps.push(cwd);
    const executeAgent = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () =>
      result('Aqui esta:\n```json\n{"name":"fixture"}\n```'),
    );
    const calls: number[] = [];
    const executor = createArchmapAgentExecutor({
      selection: SELECTIONS.cloud,
      executeAgent,
      patchFor: fakePatch,
      onCall: (call) => calls.push(call.attempt),
    });
    const value = await executor.execute({
      phase: 'narrative',
      label: 'narrativa',
      cwd,
      prompt: 'Responda {"name": string}',
      validate: (raw) => {
        if (typeof raw.name !== 'string') throw new Error('name obrigatorio');
        return { name: raw.name };
      },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(value).toEqual({ name: 'fixture' });
    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([0]);
    const request = executeAgent.mock.calls[0]![0] as AgentExecutionRequest;
    expect(request.prompt).toContain('Responda {"name": string}');
    expect(request.prompt).toContain(cwd);
    expect(readFileSync(join(cwd, 'prompt.txt'), 'utf8')).toContain('Responda');
  });

  it('AC-7: validacao falha -> nova execucao com prompt original + resposta anterior + erro, no maximo 2 reparos', async () => {
    const cwd = makeTempDir();
    temps.push(cwd);
    const outputs = ['{"name": 1}', '{"name": 2}', '{"name": "ok"}'];
    const executeAgent = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () =>
      result(outputs.shift()!),
    );
    const executor = createArchmapAgentExecutor({ selection: SELECTIONS.cloud, executeAgent, patchFor: fakePatch });
    const value = await executor.execute({
      phase: 'analysis',
      label: 'lote 1',
      cwd,
      prompt: 'TAREFA ORIGINAL',
      validate: (raw) => {
        if (typeof raw.name !== 'string') throw new Error('name deve ser string');
        return raw.name;
      },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(value).toBe('ok');
    expect(executeAgent).toHaveBeenCalledTimes(3);
    const second = (executeAgent.mock.calls[1]![0] as AgentExecutionRequest).prompt;
    expect(second).toContain('TAREFA ORIGINAL');
    expect(second).toContain('reparo 1');
    expect(second).toContain('name deve ser string');
    expect(second).toContain('{"name": 1}');
    expect(second).toContain('preservando o trabalho');
    const third = (executeAgent.mock.calls[2]![0] as AgentExecutionRequest).prompt;
    expect(third).toContain('reparo 2');
    expect(third).toContain('{"name": 2}');
    expect(existsSync(join(cwd, 'previous-result-1.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'previous-result-2.txt'))).toBe(true);
    for (const call of executeAgent.mock.calls) {
      expect((call[0] as AgentExecutionRequest).continueSession).toBeUndefined();
      expect((call[0] as AgentExecutionRequest).priorMessages).toBeUndefined();
    }
  });

  it('AC-7: na terceira falha lanca ArchmapAgentRejectedError sem quarta chamada', async () => {
    const cwd = makeTempDir();
    temps.push(cwd);
    const executeAgent = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () =>
      result('{"name": 1}'),
    );
    const executor = createArchmapAgentExecutor({ selection: SELECTIONS.cloud, executeAgent, patchFor: fakePatch });
    await expect(
      executor.execute({
        phase: 'analysis',
        label: 'lote 1',
        cwd,
        prompt: 'x',
        validate: () => {
          throw new Error('sempre invalido');
        },
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(ArchmapAgentRejectedError);
    expect(executeAgent).toHaveBeenCalledTimes(ARCHMAP_MAX_REPAIRS + 1);
  });

  it('S2-V4: erro de provedor nao entra no reparo; rate limit tenta de novo uma vez apos o atraso', async () => {
    const cwd = makeTempDir();
    temps.push(cwd);
    const { TypedProviderError } = await import('../../agent-runtime/llm-error');
    const executeAgent = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () => {
      if (executeAgent.mock.calls.length === 1) throw new TypedProviderError('LLM-RATE-429');
      return result('{"name":"ok"}');
    });
    const calls: Array<{ ok: boolean; error?: string }> = [];
    const executor = createArchmapAgentExecutor({
      selection: SELECTIONS.cloud,
      executeAgent,
      patchFor: fakePatch,
      retryDelayMs: 0,
      onCall: (call) => calls.push({ ok: call.ok, error: call.error }),
    });
    const value = await executor.execute({
      phase: 'analysis',
      label: 'lote 1',
      cwd,
      prompt: 'x',
      validate: (raw) => raw.name,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(value).toBe('ok');
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.error).toContain('LLM-RATE-429');
    expect(calls[1]?.ok).toBe(true);
    expect((executeAgent.mock.calls[1]![0] as AgentExecutionRequest).prompt).not.toContain('reparo');
  });

  it('S2-V4: segunda falha de provedor, erro nao recuperavel, result.error e resposta vazia viram pendente sem reparo', async () => {
    const cwd = makeTempDir();
    temps.push(cwd);
    const { TypedProviderError } = await import('../../agent-runtime/llm-error');
    const base = {
      phase: 'analysis' as const,
      label: 'lote 1',
      cwd,
      prompt: 'x',
      validate: (raw: Record<string, unknown>) => raw,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    };
    const twice = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () => {
      throw new TypedProviderError('LLM-OVERLOADED-529');
    });
    await expect(
      createArchmapAgentExecutor({
        selection: SELECTIONS.cloud,
        executeAgent: twice,
        patchFor: fakePatch,
        retryDelayMs: 0,
      }).execute(base),
    ).rejects.toMatchObject({ name: 'ArchmapProviderError', code: 'LLM-OVERLOADED-529' });
    expect(twice).toHaveBeenCalledTimes(2);

    const auth = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () => {
      throw new TypedProviderError('LLM-AUTH-401');
    });
    await expect(
      createArchmapAgentExecutor({
        selection: SELECTIONS.cloud,
        executeAgent: auth,
        patchFor: fakePatch,
        retryDelayMs: 0,
      }).execute(base),
    ).rejects.toMatchObject({ name: 'ArchmapProviderError', code: 'LLM-AUTH-401' });
    expect(auth).toHaveBeenCalledTimes(1);

    const withError = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () => ({
      ...result(''),
      error: { code: 'LLM-QUOTA', category: 'provider', userMessage: 'cota esgotada', suggestedAction: 'x' } as never,
    }));
    await expect(
      createArchmapAgentExecutor({
        selection: SELECTIONS.cloud,
        executeAgent: withError,
        patchFor: fakePatch,
        retryDelayMs: 0,
      }).execute(base),
    ).rejects.toMatchObject({ name: 'ArchmapProviderError', code: 'LLM-QUOTA' });
    expect(withError).toHaveBeenCalledTimes(1);

    const empty = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async () => result('   '));
    await expect(
      createArchmapAgentExecutor({
        selection: SELECTIONS.cloud,
        executeAgent: empty,
        patchFor: fakePatch,
        retryDelayMs: 0,
      }).execute(base),
    ).rejects.toMatchObject({ name: 'ArchmapProviderError', code: 'LLM-EMPTY' });
    expect(empty).toHaveBeenCalledTimes(1);

    const timeout = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async (req) => {
      req.swarmLifecycle?.onTimeout('timeout-hard');
      return result('{"name":"tarde"}');
    });
    await expect(
      createArchmapAgentExecutor({
        selection: SELECTIONS.cloud,
        executeAgent: timeout,
        patchFor: fakePatch,
        retryDelayMs: 0,
      }).execute(base),
    ).rejects.toMatchObject({ name: 'ArchmapProviderError', code: 'LLM-TIMEOUT' });
    expect(timeout).toHaveBeenCalledTimes(2);
  });

  it('cancelamento propaga o abort para o executeAgent e nao tenta reparo', async () => {
    const cwd = makeTempDir();
    temps.push(cwd);
    const controller = new AbortController();
    const executeAgent = vi.fn<(req: AgentExecutionRequest) => Promise<AgentExecutionResult>>(async (req) => {
      controller.abort();
      expect(req.abortController.signal.aborted).toBe(true);
      throw new Error('aborted');
    });
    const executor = createArchmapAgentExecutor({ selection: SELECTIONS.cloud, executeAgent, patchFor: fakePatch });
    await expect(
      executor.execute({
        phase: 'narrative',
        label: 'narrativa',
        cwd,
        prompt: 'x',
        validate: (raw) => raw,
        signal: controller.signal,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });
});

describe('config efemera e isolamento por runtime (SPEC 5.2)', () => {
  it.each(Object.keys(SELECTIONS))(
    '%s: executionAgent efemero, cwd = rascunho, timeout da fase e perfil',
    async (key) => {
      const cwd = makeTempDir();
      temps.push(cwd);
      const build = buildArchmapAgent(SELECTIONS[key]!, fakePatch);
      const abortController = new AbortController();
      writeFileSync(join(cwd, 'prompt.txt'), 'p', 'utf8');
      const request = buildArchmapExecutionRequest({ build, cwd, prompt: 'p', abortController, timeoutMs: 360_000 });
      expect(request.executionAgent?.id).toBe(request.agentId);
      expect(request.executionAgent?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(request.executionAgent?.mcpServers).toEqual([]);
      expect(request.resolvedConfigOverride?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(request.resolvedConfigOverride?.mcpServers).toEqual([]);
      expect(request.cwd).toBe(cwd);
      expect(request.swarmLifecycle?.hardTimeoutMs).toBe(360_000);
      expect(request.permission.mode).toBe('default');
      expect(request.permission.dangerouslySkipPermissions).toBe(false);
      const canUseTool = request.permission.canUseTool!;
      const ctx = { signal: abortController.signal, toolUseID: 't', requestId: 'r' } as never;
      expect(behavior(await canUseTool('Write', { file_path: join(cwd, 'x.txt'), content: 'x' }, ctx))).toBe('deny');
      expect(behavior(await canUseTool('Bash', { command: 'curl https://example.com' }, ctx))).toBe('deny');
      expect(behavior(await canUseTool('WebFetch', { url: 'https://example.com' }, ctx))).toBe('deny');
      expect(behavior(await canUseTool('WebSearch', { query: 'x' }, ctx))).toBe('deny');
      expect(behavior(await canUseTool('Read', { file_path: join(cwd, 'prompt.txt') }, ctx))).toBe('allow');
      expect(behavior(await canUseTool('Read', { file_path: join(cwd, '..', 'fora.txt') }, ctx))).toBe('deny');
      const usesDispatch = ['local', 'external', 'google-genai'].includes(key);
      expect(request.swarmToolDispatch !== undefined).toBe(usesDispatch);
      if (usesDispatch) {
        expect((await request.swarmToolDispatch!('Write', { file_path: join(cwd, 'x'), content: 'x' })).isError).toBe(
          true,
        );
        expect((await request.swarmToolDispatch!('Bash', { command: 'ls' })).isError).toBe(true);
        expect((await request.swarmToolDispatch!('WebFetch', { url: 'https://x' })).isError).toBe(true);
      }
      if (key === 'codex' || key === 'codex-official') {
        expect(request.codexConfigOverrides).toEqual(ARCHMAP_CODEX_CONFIG_OVERRIDES);
        expect(request.codexConfigOverrides).toContain('web_search="disabled"');
        expect(request.executionAgent?.codexConfig?.model).toBe('gpt-6-sol');
      } else {
        expect(request.codexConfigOverrides).toBeUndefined();
      }
      const expectedRuntime = key === 'google-genai' ? 'external' : key === 'codex-official' ? 'codex' : key;
      expect(build.agent.runtime).toBe(expectedRuntime);
      if (key === 'google-genai') expect(build.agent.externalConfig?.protocol).toBe('google-genai');
      expect(build.runtime).toBe(key === 'codex-official' ? 'codex' : key);
    },
  );

  it('runtime fora do mapa e recusado antes de qualquer chamada', () => {
    expect(() =>
      buildArchmapAgent({ runtime: 'claude-sdk', provider: 'codex', model: 'x' } as SessionOrchestrator, fakePatch),
    ).toThrow(/fora do mapa/);
  });
});
