export const SWARM_BRIEFING_LIMITS = {
  lens: 2000,
  question: 500,
  questions: 20,
  evidenceRule: 2000,
  avoid: 2000,
  deliverableHint: 1000,
} as const;

export const SWARM_BRIEFING_KEYS = ['lens', 'questions', 'evidenceRule', 'avoid', 'deliverableHint'] as const;

export const SWARM_BRIEFING_SCOPE =
  'Briefing: em comite vai dentro de cada item de members; em fanout vai no topo (molde) e aceita {{item}}.';

export const SWARM_BRIEFING_DESCRIPTIONS: Record<(typeof SWARM_BRIEFING_KEYS)[number], string> = {
  lens: `${SWARM_BRIEFING_SCOPE} Lente do swarm agent neste disparo (ex.: controle de acesso; fidelidade da SPEC ao codigo). Ate ${SWARM_BRIEFING_LIMITS.lens} caracteres.`,
  questions: `${SWARM_BRIEFING_SCOPE} Perguntas que o swarm agent deve responder, na ordem: 1 a ${SWARM_BRIEFING_LIMITS.questions}, ate ${SWARM_BRIEFING_LIMITS.question} caracteres cada.`,
  evidenceRule: `${SWARM_BRIEFING_SCOPE} O que conta como prova neste disparo (ex.: arquivo:linha do handler; URL da fonte). Ate ${SWARM_BRIEFING_LIMITS.evidenceRule} caracteres.`,
  avoid: `${SWARM_BRIEFING_SCOPE} O que o swarm agent nao deve fazer nem olhar. Ate ${SWARM_BRIEFING_LIMITS.avoid} caracteres.`,
  deliverableHint: `${SWARM_BRIEFING_SCOPE} Formato extra do relatorio (ex.: tabela regra x status), alem da estrutura obrigatoria. Ate ${SWARM_BRIEFING_LIMITS.deliverableHint} caracteres.`,
};
