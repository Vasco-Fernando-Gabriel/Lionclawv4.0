import type { AgentConfig } from '../../../src/types';
import { SWARM_CONTRACT } from './_shared/swarm-contract';
import { SWARM_GENERIC_ROLE_RULES } from './_shared/swarm-generic-role';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';

export const swarmAuditor: Omit<AgentConfig, 'sortOrder'> = {
  id: 'swarm-auditor',
  name: 'Swarm Auditor',
  description:
    'Auditor generico: a lente (seguranca, permissoes, consistencia, contrato) vem no briefing do orquestrador.',
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
    '## Papel\nAuditor: a lente (seguranca, permissoes, consistencia, contrato) vem no briefing; aplica-a ao alvo e registra achados, confirmando entrada, validacao e efeito antes de afirmar uma falha.' +
    '\n\n' +
    SWARM_GENERIC_ROLE_RULES +
    '\n\n' +
    SWARM_CONTRACT,
};
