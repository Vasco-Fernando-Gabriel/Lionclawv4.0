import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../../src/types';

const state = vi.hoisted(() => ({
  grok: vi.fn(),
  secret: vi.fn(),
}));
vi.mock('../grok-availability', () => ({ isGrokAvailable: state.grok }));
vi.mock('../../secrets-vault', () => ({ getSecret: state.secret }));

import { assertSwarmBackendAvailable } from '../swarm-availability';

function agent(runtime: AgentConfig['runtime']): AgentConfig {
  return {
    id: `swarm-${runtime}`,
    name: runtime,
    description: '',
    systemPrompt: '',
    runtime,
    model: 'm',
    allowedTools: ['Read'],
    mcpServers: [],
    skills: [],
    squad: 'swarm',
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
  };
}

describe('Swarm v2 S4 (S4-V6): disponibilidade de Grok e Cursor como swarm agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('grok exige o Grok Build usavel (instalado, autenticado e isolado)', async () => {
    state.grok.mockResolvedValue({ usable: true });
    await expect(assertSwarmBackendAvailable(agent('grok'))).resolves.toBeUndefined();
    state.grok.mockResolvedValue({ usable: false, reason: 'Grok Build nao autenticado' });
    await expect(assertSwarmBackendAvailable(agent('grok'))).rejects.toThrow('Grok Build nao autenticado');
    state.grok.mockResolvedValue({ usable: false });
    await expect(assertSwarmBackendAvailable(agent('grok'))).rejects.toThrow(/Grok Build/);
    expect(state.secret).not.toHaveBeenCalled();
  });
  it('cursor exige CURSOR_API_KEY no Vault', async () => {
    state.secret.mockResolvedValue('chave-de-teste');
    await expect(assertSwarmBackendAvailable(agent('cursor'))).resolves.toBeUndefined();
    expect(state.secret).toHaveBeenCalledWith('CURSOR_API_KEY');
    state.secret.mockResolvedValue(null);
    await expect(assertSwarmBackendAvailable(agent('cursor'))).rejects.toThrow('CURSOR_API_KEY');
    expect(state.grok).not.toHaveBeenCalled();
  });
});
