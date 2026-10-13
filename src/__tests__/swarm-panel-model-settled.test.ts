import { describe, expect, it } from 'vitest';
import { SWARM_SETTLED_DELIVERY_STATUSES, isSwarmDeliverySettled } from '../components/swarm/swarm-panel-model';

describe('GB-5: entregas assentadas nao mantem o poll do painel', () => {
  it('delivered, consumed-by-turn, undeliverable e delivery-error sao assentadas; pending, reserved-by-wait e claimed nao', () => {
    expect(SWARM_SETTLED_DELIVERY_STATUSES).toEqual([
      'delivered',
      'consumed-by-turn',
      'undeliverable',
      'delivery-error',
    ]);
    for (const status of SWARM_SETTLED_DELIVERY_STATUSES)
      expect(isSwarmDeliverySettled({ delivery: { status, error: null } })).toBe(true);
    for (const status of ['pending', 'reserved-by-wait', 'claimed'] as const)
      expect(isSwarmDeliverySettled({ delivery: { status, error: null } })).toBe(false);
    expect(isSwarmDeliverySettled({ delivery: undefined })).toBe(true);
  });
});
