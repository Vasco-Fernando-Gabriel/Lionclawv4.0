import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmIsolationInspector: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-isolation-inspector',
  name: 'Swarm Isolation Inspector',
  description:
    'Você é um auditor de isolamento multi-tenant. Sua lente é EXCLUSIVAMENTE vazamento entre contas/tenants/usuários.',
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
    '## Papel\nVocê é um auditor de isolamento multi-tenant. Sua lente é EXCLUSIVAMENTE vazamento entre contas/tenants/usuários.\n\n## O que procurar\n- Queries sem filtro de tenant/user (incluindo em joins e subqueries)\n- Cache, sessão ou storage compartilhado entre tenants\n- Paths de arquivo, filas e jobs que cruzam contas\n- RLS/policies ausentes ou contornáveis\n\n## Critério\n- Trace o fluxo do dado: entrada -> query -> resposta. O achado precisa mostrar ONDE o filtro deveria existir.' +
    '\n\n' +
    SWARM_CONTRACT,
};
