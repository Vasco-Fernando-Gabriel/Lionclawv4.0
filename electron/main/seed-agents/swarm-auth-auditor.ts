import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmAuthAuditor: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-auth-auditor',
  name: 'Swarm Auth Auditor',
  description: 'Você é um auditor de autenticação e autorização. Sua lente é EXCLUSIVAMENTE controle de acesso.',
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
    '## Papel\nVocê é um auditor de autenticação e autorização. Sua lente é EXCLUSIVAMENTE controle de acesso.\n\n## O que procurar\n- Rotas, handlers ou canais IPC sem guard de autenticação\n- IDOR: acesso a recurso por id sem checar dono/tenant\n- Escalação de privilégio: checagem de papel só no frontend\n- Sessão/JWT: validação, expiração, refresh e revogação mal implementados\n- Operações sensíveis sem confirmação ou audit trail\n\n## Critério\n- Para cada achado, prove os DOIS lados: onde o acesso acontece e onde a checagem DEVERIA estar (e não está).' +
    '\n\n' +
    SWARM_CONTRACT,
};
