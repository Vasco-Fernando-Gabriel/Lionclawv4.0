import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  SwarmBriefing,
  SwarmMember,
  SwarmRedispatchBriefing,
  SwarmSettings,
  SwarmStartInput,
} from '../../../src/types/swarm';
import type { AgentConfig } from '../../../src/types';
import { SWARM_BRIEFING_KEYS, SWARM_BRIEFING_LIMITS } from '../../../mcp-servers/_shared/swarm-briefing';

export class SwarmDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SwarmDomainError';
  }
}
const nonempty = z.string().trim().min(1);
const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const runtime = z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok', 'cursor', 'local', 'external']);
const member = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registered'), agentId: nonempty }).strict(),
  z
    .object({
      kind: z.literal('ephemeral'),
      runtime,
      model: nonempty,
      rolePrompt: nonempty,
      allowedTools: z.array(nonempty),
      providerProfileId: nonempty.optional(),
    })
    .strict(),
]);
export const swarmMemberSchema = member;
export { SWARM_BRIEFING_LIMITS };
const briefingText = (max: number) => z.string().trim().min(1).max(max);
const briefing = {
  lens: briefingText(SWARM_BRIEFING_LIMITS.lens).optional(),
  questions: z
    .array(briefingText(SWARM_BRIEFING_LIMITS.question))
    .min(1)
    .max(SWARM_BRIEFING_LIMITS.questions)
    .optional(),
  evidenceRule: briefingText(SWARM_BRIEFING_LIMITS.evidenceRule).optional(),
  avoid: briefingText(SWARM_BRIEFING_LIMITS.avoid).optional(),
  deliverableHint: briefingText(SWARM_BRIEFING_LIMITS.deliverableHint).optional(),
};
export const swarmBriefingSchema = z.object(briefing).strict();
export const SWARM_RUN_ID_PATTERN = /^swarm-\d{8}_\d{6}-[a-f0-9]{6}$/;
export const SWARM_SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;
const common = {
  requestId: safeId,
  cwd: nonempty,
  objective: nonempty,
  knownContext: z.string().optional(),
  parentRunId: z.string().regex(SWARM_RUN_ID_PATTERN).optional(),
  stage: z.string().trim().min(1).max(80).optional(),
};
export const swarmRedispatchSchema = z.union([
  nonempty.max(4000),
  z.object({ objective: nonempty.max(4000), knownContext: z.string().max(8000).optional(), ...briefing }).strict(),
]);
export function parseSwarmRedispatch(value: unknown): SwarmRedispatchBriefing {
  const parsed = swarmRedispatchSchema.safeParse(value);
  if (!parsed.success)
    throw new SwarmDomainError(
      'invalid-input',
      `Briefing de redisparo inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return typeof parsed.data === 'string' ? { objective: parsed.data } : parsed.data;
}
export function parseSwarmMessage(value: unknown): string {
  const parsed = z.string().trim().min(1).max(32_000).safeParse(value);
  if (!parsed.success) throw new SwarmDomainError('invalid-input', 'Mensagem vazia ou acima de 32.000 caracteres.');
  return parsed.data;
}
export function parseSwarmSlug(value: unknown): string {
  const parsed = z.string().regex(SWARM_SLUG_PATTERN).safeParse(value);
  if (!parsed.success) throw new SwarmDomainError('invalid-input', 'slug inválido.');
  return parsed.data;
}
export const swarmStartSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...common,
      mode: z.literal('fanout'),
      promptTemplate: nonempty.refine((v) => v.includes('{{item}}')),
      member,
      items: z
        .array(z.object({ target: nonempty }).strict())
        .min(1)
        .max(100),
      ...briefing,
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal('comite'),
      target: nonempty,
      members: z
        .array(z.object({ slug: z.string(), objective: nonempty, member, ...briefing }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
]);
export function validateSwarmSettings(value: unknown): SwarmSettings {
  const parsed = z
    .object({
      concurrencyCap: z.number().int().min(1).max(100),
      maxAttempts: z.number().int().min(1).max(16),
      idleTimeoutMs: z.number().int().min(1).max(2_147_483_647),
      hardTimeoutMs: z.number().int().min(1).max(2_147_483_647),
      openWindowMs: z.number().int().min(1).max(2_147_483_647),
    })
    .strict()
    .refine((s) => s.idleTimeoutMs <= s.hardTimeoutMs)
    .safeParse(value);
  if (!parsed.success)
    throw new SwarmDomainError(
      'invalid-settings',
      'Settings Swarm inválidos: concorrência 1-100, tentativas 1-16, timeouts e janela de conducao positivos, idle <= teto duro.',
    );
  return parsed.data;
}
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
const WHOLE_TREE_TOKENS = new Set(['.', './', '.\\', '/', '\\', '*', '**', '**/*', '**\\*', './**', '.\\**']);
export const SWARM_TARGET_TOO_BROAD_CODE = 'target_too_broad';
function swarmTargetTokens(target: string): string[] {
  return target
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[("'`[{<]+|[)"'`\]}>,;:!?]+$/g, ''))
    .filter((token) => token.length > 0 && !WHOLE_TREE_TOKENS.has(token));
}
function pathTokenExists(cwd: string, token: string): boolean {
  try {
    return fs.existsSync(path.resolve(cwd, token));
  } catch {
    return false;
  }
}
function isPathLikeToken(token: string): boolean {
  return /[\\/]/.test(token) && /[A-Za-z0-9_]/.test(token) && !/^https?:\/\//i.test(token);
}
function normalizedPathToken(token: string): string {
  return token.replace(/[#:].*$/, '');
}
export function swarmTargetPathWarnings(target: string, cwd: string): string[] {
  if (/^https?:\/\//i.test(target.trim())) return [];
  const missing = swarmTargetTokens(target)
    .map(normalizedPathToken)
    .filter((token) => isPathLikeToken(token) && !WHOLE_TREE_TOKENS.has(token) && !pathTokenExists(cwd, token));
  return [...new Set(missing)].map((token) => `caminho citado no alvo nao existe no cwd: ${token}`);
}
export function swarmTargetTooBroadReason(target: string, cwd: string): string | null {
  const text = target.trim();
  if (/^https?:\/\//i.test(text)) return null;
  const concrete = swarmTargetTokens(text).some((token) => {
    if (/^https?:\/\//i.test(token)) return true;
    const normalized = normalizedPathToken(token);
    if (!normalized || WHOLE_TREE_TOKENS.has(normalized)) return false;
    if (isPathLikeToken(normalized)) return true;
    if (/^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(normalized) && !/^\d+(\.\d+)+$/.test(normalized)) return true;
    return pathTokenExists(cwd, normalized);
  });
  if (concrete) return null;
  return (
    `${SWARM_TARGET_TOO_BROAD_CODE}: o alvo "${text.slice(0, 120)}" nao aponta para nenhuma pasta ou arquivo relativo ao cwd nem URL. ` +
    'Informe pelo menos um caminho (ex.: src/auth/, docs/SPEC.md) ou uma URL; "o repositorio", "o codigo" e "todo o projeto" nao sao alvos. ' +
    'Antes de disparar, consulte o repo-graph (repo_graph_search/repo_graph_minimal_context) se a conversa tem repositorio, ou rode uma etapa curta com um swarm-explorer de alvo apertado e use a resposta para briefar.'
  );
}
export function parseSwarmInput(value: unknown, readRoots: readonly string[]): SwarmStartInput {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new SwarmDomainError('invalid-input', 'Entrada Swarm precisa ser JSON válido.');
  }
  if (bytes > 64 * 1024)
    throw new SwarmDomainError('input-too-large', 'Entrada excede 64 KiB. Divida em runs menores.');
  const parsed = swarmStartSchema.safeParse(value);
  if (!parsed.success)
    throw new SwarmDomainError(
      'invalid-input',
      `Plano Swarm inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const input = parsed.data;
  if (!path.isAbsolute(input.cwd)) throw new SwarmDomainError('invalid-cwd', 'cwd precisa ser absoluto.');
  let cwd: string;
  let roots: string[];
  try {
    cwd = fs.realpathSync(input.cwd);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    roots = readRoots.map((root) => fs.realpathSync(root));
  } catch {
    throw new SwarmDomainError('invalid-cwd', 'Workspace inexistente ou não legível.');
  }
  if (!roots.some((root) => isWithin(root, cwd)))
    throw new SwarmDomainError('workspace-denied', 'cwd está fora dos workspaces autorizados para a sessão.');
  const targets = input.mode === 'fanout' ? input.items.map((item) => item.target) : [input.target];
  for (const target of targets) {
    const broad = swarmTargetTooBroadReason(target, cwd);
    if (broad) throw new SwarmDomainError(SWARM_TARGET_TOO_BROAD_CODE, broad);
    if (/^https?:\/\//i.test(target)) {
      try {
        new URL(target);
      } catch {
        throw new SwarmDomainError('invalid-target', 'URL inválida.');
      }
      continue;
    }
    const candidate = path.resolve(cwd, target);
    if (fs.existsSync(candidate)) {
      if (!roots.some((root) => isWithin(root, fs.realpathSync(candidate))))
        throw new SwarmDomainError('target-denied', 'Alvo resolve fora do workspace autorizado.');
      fs.accessSync(candidate, fs.constants.R_OK);
    } else if (path.isAbsolute(target) || /^(\.\.?[\\/]|[\w.-]+[\\/])/.test(target)) {
      throw new SwarmDomainError('invalid-target', `Alvo local inexistente: ${target}`);
    }
  }
  return { ...input, cwd };
}
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJSON(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function inputHash(value: SwarmStartInput): string {
  return createHash('sha256').update(stableJSON(value)).digest('hex');
}
export const SWARM_PROMPT_HEADERS = {
  runObjective: 'OBJETIVO DA RUN',
  role: 'PAPEL',
  mission: 'MISSAO',
  target: 'ALVO',
  lens: 'LENTE',
  questions: 'PERGUNTAS',
  evidenceRule: 'CRITERIO DE EVIDENCIA',
  avoid: 'NAO FACA',
  knownContext: 'CONTEXTO CONHECIDO',
  deliverableHint: 'FORMATO',
} as const;
const ROLE_LABEL_MAX = 200;
function fillItem(value: string, item: string | undefined): string {
  return item === undefined ? value : value.split('{{item}}').join(item);
}
export function briefingOf(source: SwarmBriefing, item?: string): SwarmBriefing {
  const out: SwarmBriefing = {};
  for (const key of SWARM_BRIEFING_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'questions') out.questions = (value as string[]).map((question) => fillItem(question, item));
    else out[key] = fillItem(value as string, item);
  }
  return out;
}
export function swarmRoleLabel(member: SwarmMember, agent?: Pick<AgentConfig, 'name' | 'description'>): string {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, ROLE_LABEL_MAX);
  if (member.kind === 'ephemeral') return oneLine(member.rolePrompt.split('\n').find((line) => line.trim()) ?? '');
  const label = oneLine([agent?.name, agent?.description].filter((part) => part?.trim()).join(': '));
  return label || member.agentId;
}
export function buildSwarmAgentPrompt(input: {
  objective: string;
  role: string;
  mission: string;
  target: string;
  briefing: SwarmBriefing;
  knownContext?: string;
}): string {
  const h = SWARM_PROMPT_HEADERS;
  const lines = [
    `${h.runObjective}: ${input.objective}`,
    `${h.role}: ${input.role}`,
    `${h.mission}: ${input.mission}`,
    `${h.target}: ${input.target}`,
  ];
  if (input.briefing.lens) lines.push(`${h.lens}: ${input.briefing.lens}`);
  if (input.briefing.questions?.length)
    lines.push(`${h.questions}:`, ...input.briefing.questions.map((question, i) => `${i + 1}. ${question}`));
  if (input.briefing.evidenceRule) lines.push(`${h.evidenceRule}: ${input.briefing.evidenceRule}`);
  if (input.briefing.avoid) lines.push(`${h.avoid}: ${input.briefing.avoid}`);
  if (input.knownContext?.trim()) lines.push(`${h.knownContext}: ${input.knownContext}`);
  if (input.briefing.deliverableHint) lines.push(`${h.deliverableHint}: ${input.briefing.deliverableHint}`);
  return lines.join('\n');
}
export interface SwarmNormalizedItem {
  slug: string;
  target: string;
  prompt: string;
  member: SwarmMember;
  mission: string;
  briefing: SwarmBriefing;
}
export function swarmItemPrompt(
  input: Pick<SwarmStartInput, 'objective' | 'knownContext'>,
  item: Pick<SwarmNormalizedItem, 'member' | 'mission' | 'target' | 'briefing'>,
  agent?: Pick<AgentConfig, 'name' | 'description'>,
): string {
  return buildSwarmAgentPrompt({
    objective: input.objective,
    role: swarmRoleLabel(item.member, agent),
    mission: item.mission,
    target: item.target,
    briefing: item.briefing,
    knownContext: input.knownContext,
  });
}
export function normalizedItems(input: SwarmStartInput): SwarmNormalizedItem[] {
  const seen = new Set<string>();
  const items =
    input.mode === 'fanout'
      ? input.items.map((item) => ({
          slug: item.target,
          target: item.target,
          objective: fillItem(input.promptTemplate, item.target),
          member: input.member,
          briefing: briefingOf(input, item.target),
        }))
      : input.members.map((item) => ({ ...item, target: input.target, briefing: briefingOf(item) }));
  return items.map((item, i) => {
    const source =
      input.mode === 'fanout'
        ? item.slug
            .replace(/\.[a-zA-Z0-9]+$/, '')
            .split(/[\\/]/)
            .slice(-2)
            .join('-')
        : item.slug;
    const base =
      source
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70) || `item-${String(i + 1).padStart(2, '0')}`;
    let slug = base;
    let suffix = 2;
    while (seen.has(slug)) slug = `${base}-${suffix++}`;
    seen.add(slug);
    const normalized = {
      slug,
      target: item.target,
      member: item.member,
      mission: item.objective,
      briefing: item.briefing,
    };
    return { ...normalized, prompt: swarmItemPrompt(input, normalized) };
  });
}
