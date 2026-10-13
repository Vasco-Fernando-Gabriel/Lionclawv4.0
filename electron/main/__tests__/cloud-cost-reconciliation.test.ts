import { describe, expect, it } from 'vitest';

import { reconcileCloudCost } from '../agent-runtime/cloud-executor';

describe('reconcileCloudCost', () => {
  it('rejeita custo do SDK quando Opus 4.8 foi precificado como Opus legado', () => {
    const result = reconcileCloudCost({
      model: 'claude-opus-4-8',
      inputTokens: 30_754_040,
      outputTokens: 477_010,
      cacheReadTokens: 27_982_910,
      cacheCreationTokens: 2_748_181,
      totalCostUsd: 123.920573,
    });

    expect(result.costUsd).toBe(43.207581);
    expect(result.costSource).toBe('calculated');
    expect(result.sdkReportedCostUsd).toBe(123.920573);
    expect(result.reconciliationRelativeDelta).toBeGreaterThan(1.8);
  });

  it('sessao retomada (continuacao do Swarm): ignora o total acumulado do SDK e cobra so os tokens desta tentativa', () => {
    const result = reconcileCloudCost({
      model: 'claude-opus-5-5',
      inputTokens: 811_941,
      outputTokens: 13_923,
      cacheReadTokens: 790_000,
      cacheCreationTokens: 20_000,
      totalCostUsd: 6.819925,
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 1_900,
          outputTokens: 48_760,
          cacheReadInputTokens: 16_000_000,
          cacheCreationInputTokens: 1_200_000,
          costUSD: 6.819925,
        },
      },
      resumedSession: true,
    });

    expect(result.costSource).toBe('calculated');
    expect(result.sdkReportedCostUsd).toBe(6.819925);
    expect(result.costUsd).toBeLessThan(1);
    expect(result.costUsd).toBeCloseTo(0.007764 + 0.158 + 0.1 + 0.27846, 5);
  });

  it('preserva custo do SDK quando bate com a tabela canonica', () => {
    const result = reconcileCloudCost({
      model: 'claude-fable-5',
      inputTokens: 28_592_936,
      outputTokens: 620_024,
      cacheReadTokens: 25_303_792,
      cacheCreationTokens: 2_642_132,
      totalCostUsd: 88.199832,
    });

    expect(result.costUsd).toBe(88.199832);
    expect(result.costSource).toBe('sdk_total_cost_usd');
    expect(result.reconciliationRelativeDelta).toBeUndefined();
  });
});
