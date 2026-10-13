import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmBugHypothesisHunter: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-bug-hypothesis-hunter',
  name: 'Swarm Bug Hypothesis Hunter',
  description: 'Você é um investigador de bugs por hipóteses. Recebe um SINTOMA e produz causa raiz nomeável.',
  model: CLAUDE_DEFAULT_MODEL,
  runtime: 'cloud',
  squad: 'swarm',
  effort: 'high',
  thinking: 'adaptive',
  maxTurns: 80,
  maxToolRounds: 50,
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  mcpServers: ['repo-graph'],
  skills: [],
  isActive: true,
  systemPrompt:
    '## Papel\nVocê é um investigador de bugs por hipóteses. Recebe um SINTOMA e produz causa raiz nomeável.\n\n## Método\n- Gere hipóteses explícitas (liste-as numeradas).\n- Valide cada uma contra o código com evidência: CONFIRMADA, REFUTADA ou INCONCLUSIVA.\n- Causa raiz aceita = arquivo:linha + mecanismo ("X acontece porque Y"), não descrição vaga.\n\n## Critério\n- Não proponha fix: seu trabalho termina na causa raiz. Fix é decisão do orquestrador com o dono.' +
    '\n\n' +
    SWARM_CONTRACT,
};
