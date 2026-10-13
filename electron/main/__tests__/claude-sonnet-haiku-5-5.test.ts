import { describe, it, expect } from 'vitest';

import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { VISION_MODELS, VISION_DEFAULT, defaultVisionModelForProvider } from '../../../src/constants/vision-models';
import { CURSOR_MODELS } from '../../../src/constants/cursor-models';
import { formatModelLabel, shortenModel, displayModelWithContext } from '../../../src/utils/model-display';
import { MODEL_CATALOG } from '../../../src/lib/provider-presets';
import { MODEL_PRICING, CURSOR_MODEL_PRICING, PRICING_VERSION, calculateCost, hasKnownPricing } from '../pricing';
import { getContextWindow } from '../agent-runtime/model-context-windows';
import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest, AgentPermissionProfile } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

const SONNET_5_5 = 'claude-sonnet-5-5';
const HAIKU_5_5 = 'claude-haiku-5-5';

function makeReq(
  permission: AgentPermissionProfile = PERM_BYPASS_NO_GUARD,
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    agentId: 'test-cloud-agent',
    prompt: 'Do the thing',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: SONNET_5_5,
    systemPrompt: 'You are a helpful coding agent.',
    allowedTools: ['Read', 'Edit'],
    mcpServers: [],
    maxTurns: undefined,
    effort: undefined,
    thinking: undefined,
    thinkingBudget: undefined,
    runtime: 'cloud',
    ...overrides,
  } as unknown as AgentQueryConfig;
}

function buildOpts(config: AgentQueryConfig): Record<string, unknown> {
  return buildClaudeQueryOptions(makeReq(), config, '/path/to/cli.js', new AbortController());
}

describe('Sonnet 5.5 e Haiku 5.5 — catalogo e ordem', () => {
  it('CLAUDE_MODELS segue a ordem decidida (Fable 5.1, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5/4.6, Haiku 5.5/4.5)', () => {
    expect(CLAUDE_MODELS.map((m) => m.id)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-5-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(CLAUDE_MODELS.find((m) => m.id === SONNET_5_5)?.displayName).toBe('Claude Sonnet 5.5');
    expect(CLAUDE_MODELS.find((m) => m.id === HAIKU_5_5)?.displayName).toBe('Claude Haiku 5.5');
  });

  it('o default do orquestrador continua o Opus 5.5', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  it('estao no catalogo OpenRouter (ids com ponto) logo depois do Opus 5.5, com pricingKey or:', () => {
    const ids = MODEL_CATALOG.openrouter.map((m) => m.id);
    const opus = ids.indexOf('anthropic/claude-opus-5-5');
    expect(ids[opus + 1]).toBe('anthropic/claude-sonnet-5.5');
    expect(ids[opus + 2]).toBe('anthropic/claude-haiku-5.5');
    expect(ids).not.toContain('anthropic/claude-sonnet-5-5');
    expect(ids).not.toContain('anthropic/claude-haiku-5-5');
    for (const id of ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']) {
      const entry = MODEL_CATALOG.openrouter.find((m) => m.id === id);
      expect(entry?.pricingKey).toBe(`or:${id}`);
      expect(entry?.contextWindow).toBe(1_000_000);
      expect(MODEL_PRICING[`or:${id}`]).toBeDefined();
    }
  });

  it('vision: entram no fim do bloco anthropic; gpt-6.1-sol vem depois do gpt-5.5; defaults nao mudam', () => {
    const anthropic = VISION_MODELS.filter((m) => m.provider === 'anthropic').map((m) => m.id);
    expect(anthropic.slice(-2)).toEqual([SONNET_5_5, HAIKU_5_5]);
    const openai = VISION_MODELS.filter((m) => m.provider === 'openai').map((m) => m.id);
    expect(openai.indexOf('gpt-6.1-sol')).toBe(openai.indexOf('gpt-5.5') + 1);
    expect(VISION_DEFAULT.id).toBe('gpt-5.5');
    expect(defaultVisionModelForProvider('anthropic')).toBe('claude-opus-4-8');
  });

  it('cursor: fallback estatico lista os dois com 1M e pricing espelhado', () => {
    for (const slug of [SONNET_5_5, HAIKU_5_5, 'claude-fable-5-1', 'claude-opus-5-5']) {
      expect(CURSOR_MODELS.find((m) => m.slug === slug)?.contextWindow, slug).toBe(1_000_000);
      expect(CURSOR_MODEL_PRICING[slug], slug).toBe(MODEL_PRICING[slug]);
    }
  });
});

describe('Sonnet 5.5 e Haiku 5.5 — display', () => {
  it('formatModelLabel / shortenModel / displayModelWithContext', () => {
    expect(formatModelLabel(SONNET_5_5)).toBe('Sonnet 5.5');
    expect(formatModelLabel(HAIKU_5_5)).toBe('Haiku 5.5');
    expect(shortenModel(SONNET_5_5)).toBe('sonnet');
    expect(shortenModel('claude-sonnet-5')).toBe('sonnet');
    expect(shortenModel(HAIKU_5_5)).toBe('haiku');
    expect(formatModelLabel('anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5');
    expect(formatModelLabel('anthropic/claude-haiku-5.5')).toBe('Haiku 5.5');
    expect(displayModelWithContext('anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5 1M');
    expect(displayModelWithContext('anthropic/claude-haiku-5.5')).toBe('Haiku 5.5 1M');
  });
});

describe('Sonnet 5.5 e Haiku 5.5 — pricing', () => {
  it('PRICING_VERSION e 2026-10-12', () => {
    expect(PRICING_VERSION).toBe('2026-10-12');
  });

  it('Sonnet 5.5: $2 in / $10 out / $0.10 cache read / $2.50 cache write, sem faixa de long context', () => {
    expect(MODEL_PRICING[SONNET_5_5]).toEqual({ input: 2.0, output: 10.0, cacheRead: 0.1, cacheCreation: 2.5 });
    expect(MODEL_PRICING['or:anthropic/claude-sonnet-5.5']).toEqual({
      input: 2.0,
      output: 10.0,
      cacheRead: 0.1,
      cacheCreation: 2.5,
    });
    expect(calculateCost(SONNET_5_5, 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(12, 4);
  });

  it('Haiku 5.5: $0.10 / $0.50 / $0.01 / $0.125 e faixa 5x acima de 100K tokens de prompt', () => {
    expect(MODEL_PRICING[HAIKU_5_5]).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheCreation: 0.125,
      longContext: { thresholdTokens: 100_000, inputMultiplier: 5, outputMultiplier: 5 },
    });
    expect(MODEL_PRICING['or:anthropic/claude-haiku-5.5']).toEqual(MODEL_PRICING[HAIKU_5_5]);
  });

  it('calculateCost do Haiku 5.5: ate 100K cobra a faixa base; acima de 100K (perRequestInput) cobra 5x', () => {
    expect(calculateCost(HAIKU_5_5, 100_000, 10_000, 0, 0, 0, { perRequestInput: true })).toBeCloseTo(0.015, 6);
    expect(calculateCost(HAIKU_5_5, 200_000, 10_000, 0, 0, 0, { perRequestInput: true })).toBeCloseTo(0.125, 6);
    expect(calculateCost(HAIKU_5_5, 200_000, 10_000, 0, 0)).toBeCloseTo(0.025, 6);
    expect(calculateCost(HAIKU_5_5, 200_000, 0, 150_000, 0, 0, { perRequestInput: true })).toBeCloseTo(0.0325, 6);
  });

  it('hasKnownPricing reconhece os dois slugs; precos do Sonnet 5 e do Haiku 4.5 inalterados', () => {
    expect(hasKnownPricing(SONNET_5_5)).toBe(true);
    expect(hasKnownPricing(HAIKU_5_5)).toBe(true);
    expect(MODEL_PRICING['claude-sonnet-5']).toEqual({ input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 });
    expect(MODEL_PRICING['claude-haiku-4-5-20251001']).toEqual({
      input: 1.0,
      output: 5.0,
      cacheRead: 0.1,
      cacheCreation: 1.25,
    });
  });
});

describe('Sonnet 5.5 e Haiku 5.5 — janelas de contexto', () => {
  it('resolvem 1M; Haiku 4.5 continua em 200K', () => {
    expect(getContextWindow(SONNET_5_5, 'anthropic')).toBe(1_000_000);
    expect(getContextWindow(HAIKU_5_5, 'anthropic')).toBe(1_000_000);
    expect(getContextWindow('claude-haiku-4-5-20251001', 'anthropic')).toBe(200_000);
  });
});

describe('Sonnet 5.5 e Haiku 5.5 — opcoes do SDK (familia 5 nao aceita budget_tokens; thinking pode ser desligado)', () => {
  for (const model of [SONNET_5_5, HAIKU_5_5]) {
    it(`${model}: thinking ENABLED + thinkingBudget -> { type: enabled } SEM budgetTokens`, () => {
      const opts = buildOpts(makeConfig({ model, thinking: 'enabled', thinkingBudget: 8000 }));
      expect(opts.thinking).toEqual({ type: 'enabled' });
    });

    it(`${model}: thinking DISABLED + effort high -> envia { type: disabled } (adaptativo, nao e always-on)`, () => {
      const opts = buildOpts(makeConfig({ model, thinking: 'disabled', effort: 'high' }));
      expect(opts.thinking).toEqual({ type: 'disabled' });
    });

    it(`${model}: thinking DISABLED + effort max -> envia { type: disabled } (a excecao do max e so do Opus 5)`, () => {
      const opts = buildOpts(makeConfig({ model, thinking: 'disabled', effort: 'max' }));
      expect(opts.thinking).toEqual({ type: 'disabled' });
    });
  }

  it('regressao: Sonnet 5 tambem nao recebe budgetTokens; Sonnet 4.6 e Haiku 4.5 continuam recebendo', () => {
    expect(
      buildOpts(makeConfig({ model: 'claude-sonnet-5', thinking: 'enabled', thinkingBudget: 8000 })).thinking,
    ).toEqual({
      type: 'enabled',
    });
    expect(
      buildOpts(makeConfig({ model: 'claude-sonnet-4-6', thinking: 'enabled', thinkingBudget: 8000 })).thinking,
    ).toEqual({ type: 'enabled', budgetTokens: 8000 });
    expect(
      buildOpts(makeConfig({ model: 'claude-haiku-4-5-20251001', thinking: 'enabled', thinkingBudget: 4000 })).thinking,
    ).toEqual({ type: 'enabled', budgetTokens: 4000 });
  });

  it('regressao: Opus 5.5 continua always-on (disabled omite a chave) e Opus 5 omite so no effort max', () => {
    expect(
      buildOpts(makeConfig({ model: 'claude-opus-5-5', thinking: 'disabled', effort: 'high' })),
    ).not.toHaveProperty('thinking');
    expect(buildOpts(makeConfig({ model: 'claude-opus-5', thinking: 'disabled', effort: 'max' }))).not.toHaveProperty(
      'thinking',
    );
    expect(buildOpts(makeConfig({ model: 'claude-opus-5', thinking: 'disabled', effort: 'high' })).thinking).toEqual({
      type: 'disabled',
    });
  });
});
