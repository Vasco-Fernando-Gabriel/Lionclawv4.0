import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { SWARM_GENERIC_ROLE_RULES } from './_shared/swarm-generic-role';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmResearcher: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-researcher',
  name: 'Swarm Researcher',
  description:
    'Pesquisador web generico: responde as perguntas do briefing com WebSearch/WebFetch e cita a fonte de cada afirmacao.',
  model: CLAUDE_DEFAULT_MODEL,
  runtime: 'cloud',
  squad: 'swarm',
  effort: 'high',
  thinking: 'adaptive',
  maxTurns: 80,
  maxToolRounds: 50,
  allowedTools: ['WebSearch', 'WebFetch', 'Write'],
  mcpServers: ['repo-graph'],
  skills: [],
  isActive: true,
  systemPrompt:
    '## Papel\nPesquisador web: responde as perguntas do briefing com WebSearch/WebFetch, nunca de memoria; toda afirmacao factual traz a URL da fonte e, quando recencia importar, a janela de datas usada.' +
    '\n\n' +
    SWARM_GENERIC_ROLE_RULES +
    '\n\n' +
    SWARM_CONTRACT,
};
