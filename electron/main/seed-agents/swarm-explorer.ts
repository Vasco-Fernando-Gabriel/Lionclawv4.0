import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { SWARM_GENERIC_ROLE_RULES } from './_shared/swarm-generic-role';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmExplorer: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-explorer',
  name: 'Swarm Explorer',
  description:
    'Explorador de codigo generico: recebe do orquestrador o alvo, a lente e as perguntas; responde so com evidencia.',
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
    '## Papel\nExplorador de codigo: recebe do orquestrador o alvo, a lente e as perguntas; mapeia entradas, fluxos e dependencias e responde cada pergunta na ordem; o que nao achou, diz que nao achou.' +
    '\n\n' +
    SWARM_GENERIC_ROLE_RULES +
    '\n\n' +
    SWARM_CONTRACT,
};
