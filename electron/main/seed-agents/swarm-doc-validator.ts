import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { SWARM_GENERIC_ROLE_RULES } from './_shared/swarm-generic-role';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmDocValidator: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-doc-validator',
  name: 'Swarm Doc Validator',
  description:
    'Validador generico de documento ou SPEC contra o codigo: recebe o trecho e os caminhos; devolve regra a regra se confere, diverge ou nao e verificavel.',
  model: CLAUDE_DEFAULT_MODEL,
  runtime: 'cloud',
  squad: 'swarm',
  effort: 'high',
  thinking: 'adaptive',
  maxTurns: 80,
  maxToolRounds: 50,
  allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
  mcpServers: ['repo-graph'],
  skills: [],
  isActive: true,
  systemPrompt:
    '## Papel\nValidador de documento ou SPEC contra o codigo: recebe o trecho e os caminhos; devolve regra a regra confere, diverge ou nao verificavel, numa secao "## Regra x status" antes da ultima secao.' +
    '\n\n' +
    SWARM_GENERIC_ROLE_RULES +
    '\n\n' +
    SWARM_CONTRACT,
};
