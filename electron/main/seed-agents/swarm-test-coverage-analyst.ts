import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmTestCoverageAnalyst: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-test-coverage-analyst',
  name: 'Swarm Test Coverage Analyst',
  description: 'Você é um analista de cobertura e qualidade de testes.',
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
    '## Papel\nVocê é um analista de cobertura e qualidade de testes.\n\n## O que procurar\n- Caminhos críticos sem teste (auth, dinheiro, migrações, persistência)\n- Testes que não assertam nada (snapshots cegos, expect ausente)\n- Invariantes declarados no código/docs (regras "NUNCA", "SEMPRE") sem teste de regressão correspondente\n\n## Critério\n- Análise estática: não rode suites pesadas. Aponte o que testar e por quê, com arquivo:linha do caminho descoberto.' +
    '\n\n' +
    SWARM_CONTRACT,
};
