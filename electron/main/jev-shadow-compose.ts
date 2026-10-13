import { splitIntoSections } from './memory-pipeline/md-sections';
import type { JevChoiceAnswer, JevChoiceQuestion } from './jev-client';
import type { DreamingGateResult } from './dreaming-gate';

export const JEV_SHADOW_QUESTIONS_VERSION = 1;
export const JEV_SHADOW_COMPOSITION_VERSION = 1;

export type ShadowFile = 'memory' | 'user';

export interface ShadowLine {
  id: string;
  file: ShadowFile;
  section: string;
  text: string;
  date: string | null;
}

export interface ShadowNewFact {
  id: string;
  file: ShadowFile;
  text: string;
  sourceIndex: number;
}

export interface ShadowIgnoredRemoval {
  file: ShadowFile;
  text: string;
  sourceIndex: number;
}

export interface ShadowDraft {
  lines: ShadowLine[];
  newFacts: ShadowNewFact[];
  ignoredRemovals: ShadowIgnoredRemoval[];
}

export interface ShadowThresholds {
  general: number;
  userDiscard: number;
  repeat: number;
  protectDays: number;
}

export const JEV_SHADOW_DEFAULT_THRESHOLDS: ShadowThresholds = {
  general: 0.5,
  userDiscard: 0.9,
  repeat: 0.8,
  protectDays: 90,
};

export type NewFactDestination = 'entra' | 'descarta' | 'quarentena';
export type LineDestination = 'fica' | 'sai';

export interface NewFactDecision {
  dest: NewFactDestination;
  why: string | null;
  replaces: string | null;
  section: string | null;
  jev: { choice: string; confidence: number };
}

export interface LineDecision {
  dest: LineDestination;
  why: string | null;
  survivor: string | null;
  replacedBy: string | null;
}

export interface ShadowNote {
  id: string;
  note: string;
}

export interface ShadowPlan {
  newFacts: Record<string, NewFactDecision>;
  lines: Record<string, LineDecision>;
  notes: ShadowNote[];
}

const MEMORY_SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['decisoes_ativas', '## Decisoes ativas'],
  ['workarounds', '## Workarounds e bugs conhecidos'],
  ['estado_de_projetos', '## Estado de projetos'],
  ['referencias_externas', '## Referencias externas'],
];

const USER_SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['identidade', '## Identidade'],
  ['perfil_profissional', '## Perfil profissional'],
  ['negocios_projetos', '## Negocios e projetos'],
  ['stack_ferramentas', '## Stack e ferramentas'],
  ['preferencias', '## Preferencias'],
  ['fatos_duraveis', '## Fatos duraveis'],
];

export const MEMORY_SECTION_IDS = MEMORY_SECTIONS.map(([id]) => id);
export const USER_SECTION_IDS = USER_SECTIONS.map(([id]) => id);

const PROTECTED_MEMORY_SECTIONS = new Set(['referencias_externas', 'decisoes_ativas']);
const IDENTITY_SECTION = 'identidade';
const DATE_TAG_RE = /\[(\d{4}-\d{2}-\d{2})\]/g;

function lastDateTag(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(DATE_TAG_RE)) last = m[1];
  return last;
}

function parseFile(
  content: string,
  file: ShadowFile,
  prefix: string,
  sections: ReadonlyArray<readonly [string, string]>,
  foldUnknownInto: string | null,
  trimHeaders: boolean,
): ShadowLine[] {
  const headerToId = new Map(sections.map(([id, header]) => [header, id]));
  const out: ShadowLine[] = [];
  const push = (section: string, raw: string) => {
    const text = raw.trim();
    out.push({ id: `${prefix}${out.length + 1}`, file, section, text, date: lastDateTag(text) });
  };
  for (const block of splitIntoSections(content)) {
    const body = block.lines.filter((l) => l.trim().length > 0);
    if (block.header === null) {
      if (foldUnknownInto !== null) {
        for (const l of body) if (!l.startsWith('# ')) push(foldUnknownInto, l);
      }
      continue;
    }
    const sectionId = headerToId.get(trimHeaders ? block.header.trim() : block.header);
    if (sectionId !== undefined) {
      for (const l of body) push(sectionId, l);
    } else if (foldUnknownInto !== null) {
      for (const l of body) push(foldUnknownInto, l);
    }
  }
  return out;
}

export interface ShadowDraftInput {
  memoryMd: string;
  userMd: string;
  candidates: Array<{ kind: 'add' | 'remove'; text: string }>;
  userCandidates: Array<{ action: 'add' | 'remove'; section: string; fact: string }>;
}

export function buildShadowDraft(input: ShadowDraftInput): ShadowDraft {
  const lines = [
    ...parseFile(input.memoryMd, 'memory', 'M', MEMORY_SECTIONS, null, false),
    ...parseFile(input.userMd, 'user', 'U', USER_SECTIONS, 'fatos_duraveis', true),
  ];
  const newFacts: ShadowNewFact[] = [];
  const ignoredRemovals: ShadowIgnoredRemoval[] = [];
  input.candidates.forEach((c, index) => {
    if (c.kind === 'add')
      newFacts.push({ id: `N${newFacts.length + 1}`, file: 'memory', text: c.text, sourceIndex: index });
    else ignoredRemovals.push({ file: 'memory', text: c.text, sourceIndex: index });
  });
  input.userCandidates.forEach((c, index) => {
    if (c.action === 'add')
      newFacts.push({ id: `N${newFacts.length + 1}`, file: 'user', text: c.fact, sourceIndex: index });
    else ignoredRemovals.push({ file: 'user', text: c.fact, sourceIndex: index });
  });
  return { lines, newFacts, ignoredRemovals };
}

const MEMORY_RULES =
  'This is a candidate line for the working memory. It deserves to stay only if it is a NEW decision with motivation, a NEW still-active workaround, a project state that CHANGED, a still-open task, or a NEW non-derivable reference (URL, id, path, measured result). It is junk if it is ephemeral session state, a finished session deliverable, a countable/derivable fact, or something already resolved in the conversation.';
const USER_RULES =
  'This is a candidate fact about the USER. It deserves to stay only if it is a genuinely NEW and DURABLE fact or preference about the user. It is junk if it is a one-off event, ephemeral, or has no durable value.';

function idCriteria(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, `the line with id ${id}`]));
}

export function buildShadowQuestions(
  draft: Pick<ShadowDraft, 'lines' | 'newFacts'>,
): Record<string, JevChoiceQuestion> {
  const q: Record<string, JevChoiceQuestion> = {};
  const lineIds = draft.lines.map((l) => l.id);
  const newIds = draft.newFacts.map((f) => f.id);
  for (const l of draft.lines) {
    q[`o_${l.id}`] = {
      type: 'choice',
      instructions: `Look at existing_lines entry "${l.id}". Does the conversation show that this entry is now resolved, finished, obsolete or contradicted? Also answer yes if the entry itself is ephemeral session state, a code map citing file + line, or a countable fact derivable from a database. A topic merely being mentioned or confirmed is NOT evidence.`,
      criteria: { no: 'nothing shows it should leave', yes: 'it is obsolete and should leave', unknown: 'cannot tell' },
    };
    q[`s_${l.id}`] = {
      type: 'choice',
      instructions: `Look at existing_lines entry "${l.id}". Is there an entry in new_lines that is a newer or more complete version of this same fact, so that the existing entry should be replaced by it? If yes, pick that new entry. Entries that are only about the same broad topic do NOT replace it.`,
      criteria: { none: 'no new entry replaces it', ...idCriteria(newIds), unknown: 'cannot tell' },
    };
    if (l.section !== IDENTITY_SECTION) {
      q[`d_${l.id}`] = {
        type: 'choice',
        instructions: `Look at existing_lines entry "${l.id}". Is there ANOTHER entry in existing_lines that states the same fact or preference (same specific subject, same content), so that keeping both is redundant? If yes, pick it.`,
        criteria: {
          none: 'no other existing entry repeats it',
          ...idCriteria(lineIds.filter((id) => id !== l.id)),
          unknown: 'cannot tell',
        },
      };
    }
  }
  for (const f of draft.newFacts) {
    q[`n_${f.id}`] = {
      type: 'choice',
      instructions: `Look at new_lines entry "${f.id}". ${f.file === 'memory' ? MEMORY_RULES : USER_RULES}`,
      criteria: {
        keep_new: 'durable and nothing like it exists in existing_lines',
        replaces_existing: 'durable, and it is a newer or more complete version of an entry in existing_lines',
        redundant: 'an entry in existing_lines already states all of it',
        junk: 'no durable value',
        conflict: 'contradicts an entry in existing_lines; a human should decide',
        unknown: 'cannot tell',
      },
    };
    q[`a_${f.id}`] = {
      type: 'choice',
      instructions: `Look at new_lines entry "${f.id}". Which entry of existing_lines states the same specific fact (an older, shorter or equal version of it)?`,
      criteria: { none: 'no existing entry states the same fact', ...idCriteria(lineIds), unknown: 'cannot tell' },
    };
    const sections = f.file === 'memory' ? MEMORY_SECTION_IDS : USER_SECTION_IDS;
    q[`c_${f.id}`] = {
      type: 'choice',
      instructions: `If new_lines entry "${f.id}" were stored, which section fits best?`,
      criteria: { ...Object.fromEntries(sections.map((s) => [s, `section ${s}`])), unknown: 'cannot tell' },
    };
  }
  return q;
}

export function buildShadowState(
  draft: Pick<ShadowDraft, 'lines' | 'newFacts'>,
  today: string,
  conversation: string,
): Record<string, unknown> {
  return {
    today,
    conversation,
    existing_lines: draft.lines.map(({ id, file, section, text }) => ({ id, file, section, text })),
    new_lines: draft.newFacts.map(({ id, file, text }) => ({ id, file, text })),
  };
}

function daysBetween(today: string, date: string): number | null {
  const parse = (s: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const t = Date.UTC(year, month - 1, day);
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return t;
  };
  const a = parse(today);
  const b = parse(date);
  if (a === null || b === null) return null;
  return (a - b) / 86_400_000;
}

export function composeShadowPlan(
  draft: Pick<ShadowDraft, 'lines' | 'newFacts'>,
  answers: Record<string, JevChoiceAnswer | undefined>,
  today: string,
  thresholds: ShadowThresholds = JEV_SHADOW_DEFAULT_THRESHOLDS,
): ShadowPlan {
  const A = (key: string): JevChoiceAnswer | undefined => answers[key];
  const sure = (a: JevChoiceAnswer | undefined, cut = thresholds.general): a is JevChoiceAnswer =>
    a !== undefined && a.choice !== 'unknown' && a.confidence >= cut;
  const fmt = (a: JevChoiceAnswer | undefined): string => (a ? `${a.choice} ${a.confidence.toFixed(2)}` : '-');

  const lineById = new Map(draft.lines.map((l, index) => [l.id, { ...l, index }]));
  const newFacts: Record<string, NewFactDecision> = {};
  const lines: Record<string, LineDecision> = {};
  const notes: ShadowNote[] = [];
  const protectedIds = new Set<string>();
  const anchorOf = new Map<string, string>();
  const replaceClaims: string[] = [];

  for (const f of draft.newFacts) {
    const n = A(`n_${f.id}`);
    const a = A(`a_${f.id}`);
    const c = A(`c_${f.id}`);
    const discardCut = f.file === 'user' ? thresholds.userDiscard : thresholds.general;
    const anchor = sure(a) && a.choice !== 'none' ? (lineById.get(a.choice) ?? null) : null;
    const sameFile = anchor !== null && anchor.file === f.file;
    const quarantine = (why: string): NewFactDecision => ({
      dest: 'quarentena',
      why,
      replaces: null,
      section: null,
      jev: { choice: n?.choice ?? '-', confidence: n?.confidence ?? 0 },
    });
    let out: NewFactDecision;
    if (!sure(n)) out = quarantine(`duvida (${fmt(n)})`);
    else if (n.choice === 'conflict') out = quarantine('conflito');
    else if (n.choice === 'junk') {
      out =
        n.confidence >= discardCut
          ? {
              dest: 'descarta',
              why: 'junk',
              replaces: null,
              section: null,
              jev: { choice: n.choice, confidence: n.confidence },
            }
          : quarantine(`junk abaixo de ${discardCut}`);
    } else if (n.choice === 'redundant') {
      if (!sameFile) out = quarantine(anchor ? 'redundante com linha de outro arquivo' : 'redundante sem ancora');
      else if (n.confidence >= discardCut)
        out = {
          dest: 'descarta',
          why: `redundante com ${anchor.id}`,
          replaces: null,
          section: null,
          jev: { choice: n.choice, confidence: n.confidence },
        };
      else out = quarantine(`redundant abaixo de ${discardCut}`);
    } else if (n.choice === 'replaces_existing') {
      out = sameFile
        ? {
            dest: 'entra',
            why: null,
            replaces: anchor.id,
            section: null,
            jev: { choice: n.choice, confidence: n.confidence },
          }
        : quarantine(anchor ? 'substitui linha de outro arquivo' : 'substitui, mas alvo incerto');
    } else if (n.choice === 'keep_new') {
      out = anchor
        ? quarantine(`novo, mas aponta ${anchor.id} como igual`)
        : {
            dest: 'entra',
            why: null,
            replaces: null,
            section: null,
            jev: { choice: n.choice, confidence: n.confidence },
          };
    } else out = quarantine(`destino desconhecido (${fmt(n)})`);

    if (out.dest === 'entra') {
      if (!sure(c)) out = quarantine(`secao incerta (${fmt(c)})`);
      else out.section = c.choice;
    }
    if (anchor && out.dest !== 'entra') {
      protectedIds.add(anchor.id);
      anchorOf.set(f.id, anchor.id);
    }
    if (out.dest === 'entra' && out.replaces !== null) replaceClaims.push(f.id);
    newFacts[f.id] = out;
  }

  const claimsByTarget = new Map<string, string[]>();
  for (const id of replaceClaims) {
    const target = newFacts[id].replaces as string;
    claimsByTarget.set(target, [...(claimsByTarget.get(target) ?? []), id]);
  }
  const replacedBy = new Map<string, string>();
  for (const [target, claimers] of claimsByTarget) {
    const s = A(`s_${target}`);
    const oldSideDisagrees = sure(s) && s.choice !== claimers[0];
    if (claimers.length > 1 || oldSideDisagrees) {
      for (const id of claimers) {
        newFacts[id] = {
          ...newFacts[id],
          dest: 'quarentena',
          why: claimers.length > 1 ? `varios novos trocam ${target}` : `lado antigo discorda (${fmt(s)})`,
          replaces: null,
          section: null,
        };
      }
      protectedIds.add(target);
    } else {
      replacedBy.set(target, claimers[0]);
    }
  }
  for (const f of draft.newFacts) {
    const decision = newFacts[f.id];
    const anchor = anchorOf.get(f.id);
    if (
      decision.dest === 'descarta' &&
      anchor !== undefined &&
      decision.why === `redundante com ${anchor}` &&
      replacedBy.has(anchor)
    ) {
      newFacts[f.id] = {
        ...decision,
        dest: 'quarentena',
        why: `redundante com ${anchor}, que sera trocada por ${replacedBy.get(anchor)}`,
      };
    }
  }

  const leaving = new Set<string>();
  for (const l of draft.lines) {
    const o = A(`o_${l.id}`);
    const s = A(`s_${l.id}`);
    let out: LineDecision = { dest: 'fica', why: null, survivor: null, replacedBy: null };
    const replacement = replacedBy.get(l.id);
    if (replacement !== undefined)
      out = { dest: 'sai', why: `trocada por ${replacement}`, survivor: null, replacedBy: replacement };
    else if (protectedIds.has(l.id))
      out = { dest: 'fica', why: 'ancora de fato novo', survivor: null, replacedBy: null };
    else if (o !== undefined && o.choice === 'yes' && o.confidence >= thresholds.general) {
      const days = l.date === null ? null : daysBetween(today, l.date);
      const protectedLine =
        l.file === 'memory' &&
        PROTECTED_MEMORY_SECTIONS.has(l.section) &&
        (days === null || days < thresholds.protectDays);
      out = protectedLine
        ? {
            dest: 'fica',
            why: 'obsoleta para o Jev, mas protegida (referencia ou decisao recente ou sem data)',
            survivor: null,
            replacedBy: null,
          }
        : { dest: 'sai', why: 'obsoleta', survivor: null, replacedBy: null };
    }
    if (out.dest === 'sai') leaving.add(l.id);
    if (out.dest === 'fica' && sure(s) && s.choice !== 'none' && replacement === undefined) {
      notes.push({ id: l.id, note: `lado antigo diz superada por ${s.choice}, sem confirmacao do fato novo` });
    }
    lines[l.id] = out;
  }

  for (const l of draft.lines) {
    const d = A(`d_${l.id}`);
    if (!sure(d, thresholds.repeat) || d.choice === 'none') continue;
    const me = lineById.get(l.id);
    const other = lineById.get(d.choice);
    if (!me || !other) continue;
    if (other.id === me.id) {
      notes.push({ id: l.id, note: 'diz repetir a si mesma: sem acao' });
      continue;
    }
    if (other.file !== me.file) {
      notes.push({ id: l.id, note: `repete ${other.id}, de outro arquivo: sem acao` });
      continue;
    }
    const loser =
      me.date !== null && other.date !== null && me.date !== other.date
        ? me.date < other.date
          ? me
          : other
        : me.index > other.index
          ? me
          : other;
    const survivor = loser.id === me.id ? other : me;
    const cancel = (why: string) =>
      notes.push({ id: l.id, note: `repete ${other.id}: ${loser.id} sairia, mas ${why}` });
    if (leaving.has(loser.id)) {
      cancel('ja sai por outro motivo');
      continue;
    }
    if (leaving.has(survivor.id)) {
      cancel(`a sobrevivente ${survivor.id} ja sai`);
      continue;
    }
    if (protectedIds.has(loser.id)) {
      cancel('esta protegida');
      continue;
    }
    if (loser.section === IDENTITY_SECTION) {
      cancel('e linha de Identidade');
      continue;
    }
    leaving.add(loser.id);
    protectedIds.add(survivor.id);
    lines[loser.id] = { dest: 'sai', why: `repete ${survivor.id}`, survivor: survivor.id, replacedBy: null };
  }

  return { newFacts, lines, notes };
}

export type GateMatch = 'accounting' | 'exact' | 'similar' | 'failsafe' | 'sem_rastro';
export type GateDestination = 'apply' | 'quarentena' | 'descarta';

export interface GateCandidateView {
  file: ShadowFile;
  sourceIndex: number;
  kind: 'add' | 'remove';
  text: string;
  dest: GateDestination | null;
  op: 'add' | 'remove' | null;
  match: GateMatch;
}

export interface GateComparisonCounts {
  compared: number;
  agree: number;
  disagree: number;
  gateAppliedJevDiscards: number;
  jevQuarantine: number;
  jevQuarantineTotal: number;
  semRastro: number;
}

export interface GateComparison {
  candidates: GateCandidateView[];
  counts: GateComparisonCounts;
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/^-\s+/, '')
    .replace(/\[\d{4}-\d{2}-\d{2}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function jaccardTokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter((t) => t.length > 0));
  const tokensB = new Set(b.split(' ').filter((t) => t.length > 0));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  return intersection / (tokensA.size + tokensB.size - intersection);
}

const SIMILARITY_CUT = 0.5;

interface PoolItem {
  dest: GateDestination;
  op: 'add' | 'remove' | null;
  normalized: string;
}

function accountingDestination(destination: string): { dest: GateDestination; op: 'add' | 'remove' | null } | null {
  switch (destination) {
    case 'userAdd':
      return { dest: 'apply', op: 'add' };
    case 'userRemove':
      return { dest: 'apply', op: 'remove' };
    case 'quarantine':
      return { dest: 'quarentena', op: null };
    case 'discarded':
      return { dest: 'descarta', op: null };
    default:
      return null;
  }
}

export function compareWithGate(
  input: ShadowDraftInput,
  plan: ShadowPlan,
  draft: ShadowDraft,
  gate: DreamingGateResult,
  userAccounting: Array<{ candidateId: string; destination: string }> | null,
): GateComparison {
  const views: GateCandidateView[] = [];
  const memoryCandidates = input.candidates.map((c, sourceIndex) => ({ ...c, sourceIndex }));

  if (gate.failSafeTriggered) {
    for (const c of memoryCandidates) {
      views.push({
        file: 'memory',
        sourceIndex: c.sourceIndex,
        kind: c.kind,
        text: c.text,
        dest: 'quarentena',
        op: null,
        match: 'failsafe',
      });
    }
    input.userCandidates.forEach((c, sourceIndex) => {
      views.push({
        file: 'user',
        sourceIndex,
        kind: c.action,
        text: c.fact,
        dest: 'quarentena',
        op: null,
        match: 'failsafe',
      });
    });
  } else {
    const pool: PoolItem[] = [
      ...gate.apply.add.map((i) => ({
        dest: 'apply' as const,
        op: 'add' as const,
        normalized: normalizeForMatch(i.text),
      })),
      ...gate.apply.remove.map((t) => ({
        dest: 'apply' as const,
        op: 'remove' as const,
        normalized: normalizeForMatch(t),
      })),
      ...gate.quarantine.map((q) => ({ dest: 'quarentena' as const, op: null, normalized: normalizeForMatch(q.text) })),
      ...gate.discarded.map((d) => ({ dest: 'descarta' as const, op: null, normalized: normalizeForMatch(d.text) })),
    ].filter((item) => item.normalized.length > 0);
    const eligible = (kind: 'add' | 'remove', item: PoolItem): boolean =>
      item.op === null || (kind === 'add' ? item.op === 'add' : item.op === 'remove');

    const scores = memoryCandidates.map((c) => {
      const normalized = normalizeForMatch(c.text);
      return pool.map((item) => {
        if (normalized.length === 0 || !eligible(c.kind, item)) return 0;
        return item.normalized === normalized ? 1 : jaccardTokenSimilarity(item.normalized, normalized);
      });
    });
    const exact = memoryCandidates.map((c) => {
      const normalized = normalizeForMatch(c.text);
      if (normalized.length === 0) return [];
      return pool
        .map((item, index) => (eligible(c.kind, item) && item.normalized === normalized ? index : -1))
        .filter((i) => i >= 0);
    });
    const bestSets = scores.map((row) => {
      const max = Math.max(0, ...row);
      if (max <= 0) return new Set<number>();
      return new Set(row.map((score, index) => (score === max ? index : -1)).filter((index) => index >= 0));
    });

    memoryCandidates.forEach((c, i) => {
      let chosen: number | null = null;
      let match: GateMatch = 'sem_rastro';
      if (exact[i].length === 1) {
        chosen = exact[i][0];
        match = 'exact';
      } else if (exact[i].length === 0) {
        const similar = scores[i].map((s, index) => (s >= SIMILARITY_CUT ? index : -1)).filter((index) => index >= 0);
        if (similar.length === 1) {
          const candidateIndex = similar[0];
          const disputed = bestSets.some((set, j) => j !== i && set.has(candidateIndex));
          if (!disputed) {
            chosen = candidateIndex;
            match = 'similar';
          }
        }
      }
      const item = chosen === null ? null : pool[chosen];
      views.push({
        file: 'memory',
        sourceIndex: c.sourceIndex,
        kind: c.kind,
        text: c.text,
        dest: item ? item.dest : null,
        op: item ? item.op : null,
        match,
      });
    });

    const accounting = new Map<string, string | null>();
    for (const entry of userAccounting ?? []) {
      const id = entry.candidateId.trim().toLowerCase();
      accounting.set(id, accounting.has(id) ? null : entry.destination);
    }
    input.userCandidates.forEach((c, sourceIndex) => {
      const mapped = accountingDestination(accounting.get(`c${sourceIndex + 1}`) ?? '');
      views.push({
        file: 'user',
        sourceIndex,
        kind: c.action,
        text: c.fact,
        dest: mapped ? mapped.dest : null,
        op: mapped ? mapped.op : null,
        match: mapped ? 'accounting' : 'sem_rastro',
      });
    });
  }

  const counts: GateComparisonCounts = {
    compared: 0,
    agree: 0,
    disagree: 0,
    gateAppliedJevDiscards: 0,
    jevQuarantine: 0,
    jevQuarantineTotal: 0,
    semRastro: 0,
  };
  for (const f of draft.newFacts) {
    const decision = plan.newFacts[f.id];
    if (!decision) continue;
    if (decision.dest === 'quarentena') counts.jevQuarantineTotal++;
    const view = views.find((v) => v.file === f.file && v.sourceIndex === f.sourceIndex);
    if (!view || view.match === 'sem_rastro') {
      counts.semRastro++;
      continue;
    }
    if (view.match === 'failsafe' || view.dest === null) continue;
    counts.compared++;
    if (decision.dest === 'quarentena') counts.jevQuarantine++;
    const jevAsGate: GateDestination =
      decision.dest === 'entra' ? 'apply' : decision.dest === 'descarta' ? 'descarta' : 'quarentena';
    if (jevAsGate === view.dest) counts.agree++;
    else counts.disagree++;
    if (view.dest === 'apply' && decision.dest === 'descarta') counts.gateAppliedJevDiscards++;
  }
  return { candidates: views, counts };
}
