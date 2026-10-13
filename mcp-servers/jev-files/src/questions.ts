import {
  JEV_SCORE_MAX_LEVELS,
  JEV_SCORE_MIN_LEVELS,
  type JevAnswer,
  type JevChoiceAnswer,
  type JevChoiceQuestion,
  type JevNoulAnswer,
  type JevNoulQuestion,
  type JevQuestion,
  type JevScoreAnswer,
  type JevScoreQuestion,
} from '../../_shared/jev-transport.js';

export const DEFAULT_YES_AT = 0.8;
export const DEFAULT_NO_AT = 0.2;
export const DEFAULT_THRESHOLD = 0.5;
export const CHOICE_UNKNOWN_ID = 'unknown';
export const CHOICE_UNKNOWN_DESCRIPTION = 'nao e possivel responder com o conteudo deste arquivo';
export const RESERVED_CHOICE_IDS: ReadonlySet<string> = new Set(['unknown', 'none']);
export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 20;
export const CHOICE_ID_RE = /^[a-z0-9_]{1,40}$/;

export type QuestionKind = 'bool' | 'choice' | 'score';

export interface BoolQuestion {
  kind: 'bool';
  instructions: string;
  criteria?: { true: string; false: string };
  yesAt: number;
  noAt: number;
}

export interface ChoiceQuestion {
  kind: 'choice';
  instructions: string;
  options: Record<string, string>;
  negativeOption?: string;
}

export interface ScoreQuestion {
  kind: 'score';
  instructions: string;
  levels: string[];
  minScore?: number;
}

export type ParsedQuestion = BoolQuestion | ChoiceQuestion | ScoreQuestion;

export interface ParsedInput {
  targets: string[];
  question: ParsedQuestion;
  pick: boolean;
  threshold: number;
}

export type ParseResult = { ok: true; input: ParsedInput } | { ok: false; message: string };

export interface FileAnswer {
  path: string;
  kind: QuestionKind;
  answer: boolean | 'unsure' | string | number;
  probability?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  score?: number;
  legend?: Record<string, string>;
  candidate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFinite01(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(message: string): ParseResult {
  return { ok: false, message };
}

function parseBool(
  raw: Record<string, unknown>,
): { ok: true; question: BoolQuestion } | { ok: false; message: string } {
  let criteria: { true: string; false: string } | undefined;
  if (raw.criteria !== undefined) {
    if (!isRecord(raw.criteria) || !nonEmptyString(raw.criteria.true) || !nonEmptyString(raw.criteria.false)) {
      return { ok: false, message: 'criteria de bool precisa de true e false como textos' };
    }
    criteria = { true: raw.criteria.true, false: raw.criteria.false };
  }
  let yesAt = DEFAULT_YES_AT;
  let noAt = DEFAULT_NO_AT;
  if (raw.thresholds !== undefined) {
    if (!isRecord(raw.thresholds)) return { ok: false, message: 'thresholds precisa ser um objeto' };
    if (raw.thresholds.yesAt !== undefined) {
      if (!isFinite01(raw.thresholds.yesAt)) return { ok: false, message: 'yesAt precisa estar em 0..1' };
      yesAt = raw.thresholds.yesAt;
    }
    if (raw.thresholds.noAt !== undefined) {
      if (!isFinite01(raw.thresholds.noAt)) return { ok: false, message: 'noAt precisa estar em 0..1' };
      noAt = raw.thresholds.noAt;
    }
  }
  if (!(noAt >= 0 && noAt < yesAt && yesAt <= 1)) {
    return { ok: false, message: 'cortes invalidos: exige 0 <= noAt < yesAt <= 1' };
  }
  return { ok: true, question: { kind: 'bool', instructions: String(raw.instructions), criteria, yesAt, noAt } };
}

function parseChoice(
  raw: Record<string, unknown>,
): { ok: true; question: ChoiceQuestion } | { ok: false; message: string } {
  if (!isRecord(raw.options)) return { ok: false, message: 'choice exige options como objeto id -> descricao' };
  const ids = Object.keys(raw.options);
  if (ids.length < MIN_CHOICE_OPTIONS || ids.length > MAX_CHOICE_OPTIONS) {
    return { ok: false, message: `choice exige entre ${MIN_CHOICE_OPTIONS} e ${MAX_CHOICE_OPTIONS} opcoes` };
  }
  const options: Record<string, string> = {};
  for (const id of ids) {
    if (!CHOICE_ID_RE.test(id)) return { ok: false, message: `id de opcao invalido: ${id} (use [a-z0-9_]{1,40})` };
    if (RESERVED_CHOICE_IDS.has(id)) return { ok: false, message: `id de opcao reservado pelo servidor: ${id}` };
    const description = raw.options[id];
    if (!nonEmptyString(description)) return { ok: false, message: `opcao ${id} sem descricao` };
    options[id] = description;
  }
  let negativeOption: string | undefined;
  if (raw.negativeOption !== undefined) {
    if (typeof raw.negativeOption !== 'string' || !Object.prototype.hasOwnProperty.call(options, raw.negativeOption)) {
      return { ok: false, message: 'negativeOption precisa ser um dos ids de options' };
    }
    negativeOption = raw.negativeOption;
  }
  return { ok: true, question: { kind: 'choice', instructions: String(raw.instructions), options, negativeOption } };
}

function parseScore(
  raw: Record<string, unknown>,
): { ok: true; question: ScoreQuestion } | { ok: false; message: string } {
  if (!Array.isArray(raw.levels)) return { ok: false, message: 'score exige levels como lista ordenada de niveis' };
  if (raw.levels.length < JEV_SCORE_MIN_LEVELS || raw.levels.length > JEV_SCORE_MAX_LEVELS) {
    return { ok: false, message: `score exige entre ${JEV_SCORE_MIN_LEVELS} e ${JEV_SCORE_MAX_LEVELS} niveis` };
  }
  const levels: string[] = [];
  for (const level of raw.levels) {
    if (!nonEmptyString(level)) return { ok: false, message: 'cada nivel de score precisa ser um texto' };
    levels.push(level);
  }
  let minScore: number | undefined;
  if (raw.minScore !== undefined) {
    const max = levels.length - 1;
    if (typeof raw.minScore !== 'number' || !Number.isFinite(raw.minScore) || raw.minScore < 0 || raw.minScore > max) {
      return { ok: false, message: `minScore precisa estar em 0..${max}` };
    }
    minScore = raw.minScore;
  }
  return { ok: true, question: { kind: 'score', instructions: String(raw.instructions), levels, minScore } };
}

export function parseInput(raw: unknown): ParseResult {
  if (!isRecord(raw)) return fail('entrada precisa ser um objeto');
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) return fail('targets precisa ter ao menos um caminho');
  const targets: string[] = [];
  for (const target of raw.targets) {
    if (!nonEmptyString(target)) return fail('cada alvo precisa ser um caminho em texto');
    targets.push(target.trim());
  }
  if (!isRecord(raw.question)) return fail('question precisa ser um objeto');
  if (!nonEmptyString(raw.question.instructions)) return fail('question.instructions precisa ser um texto');
  const kind = raw.question.kind;
  let parsed: { ok: true; question: ParsedQuestion } | { ok: false; message: string };
  if (kind === 'bool') parsed = parseBool(raw.question);
  else if (kind === 'choice') parsed = parseChoice(raw.question);
  else if (kind === 'score') parsed = parseScore(raw.question);
  else return fail('question.kind precisa ser bool, choice ou score');
  if (!parsed.ok) return fail(parsed.message);

  let pick = false;
  if (raw.pick !== undefined) {
    if (typeof raw.pick !== 'boolean') return fail('pick precisa ser booleano');
    pick = raw.pick;
  }
  let threshold = DEFAULT_THRESHOLD;
  if (raw.threshold !== undefined) {
    if (!isFinite01(raw.threshold)) return fail('threshold precisa estar em 0..1');
    threshold = raw.threshold;
  }
  if (pick && parsed.question.kind === 'score' && parsed.question.minScore === undefined) {
    return fail('pick com score exige minScore');
  }
  return { ok: true, input: { targets, question: parsed.question, pick, threshold } };
}

export function toPrimitive(question: ParsedQuestion): JevQuestion {
  switch (question.kind) {
    case 'bool': {
      const noul: JevNoulQuestion = { type: 'noul', instructions: question.instructions };
      if (question.criteria) noul.criteria = question.criteria;
      return noul;
    }
    case 'choice': {
      const choice: JevChoiceQuestion = {
        type: 'choice',
        instructions: question.instructions,
        criteria: { ...question.options, [CHOICE_UNKNOWN_ID]: CHOICE_UNKNOWN_DESCRIPTION },
      };
      return choice;
    }
    case 'score': {
      const score: JevScoreQuestion = { type: 'score', instructions: question.instructions, criteria: question.levels };
      return score;
    }
  }
}

function mostLikelyLevel(answer: JevScoreAnswer, levelCount: number): number {
  let best = -1;
  let bestProb = -Infinity;
  for (let i = 0; i < levelCount; i++) {
    const p = answer.probabilities[String(i)];
    if (typeof p === 'number' && p > bestProb) {
      bestProb = p;
      best = i;
    }
  }
  if (best >= 0) return best;
  return Math.min(levelCount - 1, Math.max(0, Math.round(answer.score)));
}

export function toFileAnswer(
  filePath: string,
  question: ParsedQuestion,
  answer: JevAnswer,
  threshold: number,
): FileAnswer {
  switch (question.kind) {
    case 'bool': {
      const noul = (answer as JevNoulAnswer).noul;
      const verdict: boolean | 'unsure' = noul >= question.yesAt ? true : noul <= question.noAt ? false : 'unsure';
      return { path: filePath, kind: 'bool', answer: verdict, probability: noul, candidate: verdict === true };
    }
    case 'choice': {
      const choice = answer as JevChoiceAnswer;
      const candidate =
        choice.choice !== CHOICE_UNKNOWN_ID &&
        choice.choice !== question.negativeOption &&
        choice.confidence >= threshold;
      return {
        path: filePath,
        kind: 'choice',
        answer: choice.choice,
        confidence: choice.confidence,
        probabilities: choice.probabilities,
        candidate,
      };
    }
    case 'score': {
      const score = answer as JevScoreAnswer;
      const candidate =
        (question.minScore === undefined || score.score >= question.minScore) && score.confidence >= threshold;
      return {
        path: filePath,
        kind: 'score',
        answer: mostLikelyLevel(score, question.levels.length),
        score: score.score,
        confidence: score.confidence,
        probabilities: score.probabilities,
        legend: score.legend,
        candidate,
      };
    }
  }
}

export function candidateMeasure(answer: FileAnswer): number {
  if (answer.kind === 'bool') return answer.probability ?? 0;
  return answer.confidence ?? 0;
}

export function sortMeasure(answer: FileAnswer): number {
  if (answer.kind === 'bool') return answer.probability ?? 0;
  if (answer.kind === 'score') return answer.score ?? 0;
  return answer.confidence ?? 0;
}
