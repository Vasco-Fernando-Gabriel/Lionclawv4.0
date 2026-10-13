import { z } from 'zod';
import { SWARM_BRIEFING_DESCRIPTIONS, SWARM_BRIEFING_LIMITS } from '../../_shared/swarm-briefing.js';

const text = (max: number) => z.string().trim().min(1).max(max);
export const member = z.union([
  z.object({ kind: z.literal('registered'), agentId: z.string() }).strict(),
  z
    .object({
      kind: z.literal('ephemeral'),
      runtime: z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok', 'cursor', 'local', 'external']),
      model: z.string(),
      rolePrompt: z.string(),
      allowedTools: z.array(z.string()),
      providerProfileId: z.string().optional(),
    })
    .strict(),
]);
export const briefing = {
  lens: text(SWARM_BRIEFING_LIMITS.lens).optional().describe(SWARM_BRIEFING_DESCRIPTIONS.lens),
  questions: z
    .array(text(SWARM_BRIEFING_LIMITS.question))
    .min(1)
    .max(SWARM_BRIEFING_LIMITS.questions)
    .optional()
    .describe(SWARM_BRIEFING_DESCRIPTIONS.questions),
  evidenceRule: text(SWARM_BRIEFING_LIMITS.evidenceRule).optional().describe(SWARM_BRIEFING_DESCRIPTIONS.evidenceRule),
  avoid: text(SWARM_BRIEFING_LIMITS.avoid).optional().describe(SWARM_BRIEFING_DESCRIPTIONS.avoid),
  deliverableHint: text(SWARM_BRIEFING_LIMITS.deliverableHint)
    .optional()
    .describe(SWARM_BRIEFING_DESCRIPTIONS.deliverableHint),
};
export const swarmRedispatchShape = z
  .union([
    z.string().trim().min(1).max(4000),
    z
      .object({
        objective: z.string().trim().min(1).max(4000).describe('MISSAO nova do swarm agent.'),
        knownContext: z.string().max(8000).optional(),
        ...briefing,
      })
      .strict(),
  ])
  .describe(
    'Briefing novo: texto (vira a MISSAO) ou objeto com objective + lens/questions/evidenceRule/avoid/deliverableHint.',
  );
export const swarmStartShape = {
  requestId: z.string(),
  cwd: z.string(),
  objective: z.string(),
  knownContext: z.string().optional(),
  parentRunId: z.string().optional().describe('Run anterior desta mesma conversa quando esta e a proxima etapa.'),
  stage: z.string().trim().min(1).max(80).optional().describe('Nome curto da etapa (ex.: "validacao").'),
  mode: z
    .enum(['fanout', 'comite'])
    .describe(
      'comite: varios swarm agents no mesmo alvo (briefing dentro de cada item de members; nada de briefing no topo); fanout: um perfil em varios alvos (briefing no topo, como molde com {{item}}).',
    ),
  promptTemplate: z
    .string()
    .optional()
    .describe('Obrigatório apenas em fanout; deve conter {{item}}. E a MISSAO de cada swarm agent no molde.'),
  member: member.optional().describe('Obrigatório apenas em fanout: perfil único (swarm agent) aplicado aos items.'),
  items: z
    .array(z.object({ target: z.string() }).strict())
    .min(1)
    .max(100)
    .optional()
    .describe('Obrigatório apenas em fanout: alvos do perfil único.'),
  ...briefing,
  target: z.string().optional().describe('Obrigatório apenas em comite: alvo comum a todos os swarm agents.'),
  members: z
    .array(z.object({ slug: z.string(), objective: z.string(), member, ...briefing }).strict())
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Obrigatório apenas em comite. Um item por swarm agent, todos na mesma run; objective e a MISSAO dele e lens/questions/evidenceRule/avoid/deliverableHint sao o briefing.',
    ),
};
export const swarmStartSchema = z.object(swarmStartShape).strict();
