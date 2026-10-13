import { JevError, type JevChoiceAnswer, type JevChoiceQuestion } from '../../_shared/jev-transport.js';
import { candidateMeasure, sortMeasure, type FileAnswer, type ParsedQuestion } from './questions.js';

export const PICK_NONE_ID = 'none';
export const PICK_QUESTION_ID = 'pick';
export const PICK_INSTRUCTIONS =
  'The state holds one closed question and the triage results of several files that were judged as candidates for it. ' +
  'Each candidate has an id (f1, f2, ...) and a path. Using ONLY these triage results (answers, probabilities, confidences and scores), ' +
  'choose the id of the candidate whose result best satisfies the question. ' +
  'Answer none when the results do not allow you to tell one candidate apart from the others.';

export interface PickCandidate {
  id: string;
  path: string;
  answer: FileAnswer['answer'];
  probability?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  score?: number;
}

export interface PickState {
  question: {
    kind: ParsedQuestion['kind'];
    instructions: string;
    criteria?: { true: string; false: string };
    options?: Record<string, string>;
    levels?: string[];
  };
  candidates: PickCandidate[];
}

export interface PickRequest {
  state: PickState;
  questions: Record<typeof PICK_QUESTION_ID, JevChoiceQuestion>;
  pathById: Record<string, string>;
}

export type PickOutcome =
  | { picked: { path: string; confidence: number }; pickReason: 'chosen' }
  | { picked: null; pickReason: 'none' | 'low_confidence' };

export function selectCandidates(answers: FileAnswer[]): FileAnswer[] {
  return answers.filter((a) => a.candidate);
}

export function sortAnswers(answers: FileAnswer[]): FileAnswer[] {
  return [...answers].sort((a, b) => {
    if (a.candidate !== b.candidate) return a.candidate ? -1 : 1;
    return sortMeasure(b) - sortMeasure(a);
  });
}

function describeQuestion(question: ParsedQuestion): PickState['question'] {
  switch (question.kind) {
    case 'bool':
      return question.criteria
        ? { kind: 'bool', instructions: question.instructions, criteria: question.criteria }
        : { kind: 'bool', instructions: question.instructions };
    case 'choice':
      return { kind: 'choice', instructions: question.instructions, options: question.options };
    case 'score':
      return { kind: 'score', instructions: question.instructions, levels: question.levels };
  }
}

export function pickCandidateId(index: number): string {
  return `f${index + 1}`;
}

function describeCandidate(id: string, answer: FileAnswer): PickCandidate {
  const candidate: PickCandidate = { id, path: answer.path, answer: answer.answer };
  if (answer.probability !== undefined) candidate.probability = answer.probability;
  if (answer.confidence !== undefined) candidate.confidence = answer.confidence;
  if (answer.probabilities !== undefined) candidate.probabilities = answer.probabilities;
  if (answer.score !== undefined) candidate.score = answer.score;
  return candidate;
}

export function buildPickRequest(question: ParsedQuestion, candidates: FileAnswer[]): PickRequest {
  const criteria: Record<string, string> = {};
  const pathById: Record<string, string> = {};
  const described: PickCandidate[] = [];
  candidates.forEach((candidate, index) => {
    const id = pickCandidateId(index);
    criteria[id] = `the file at ${candidate.path}`;
    pathById[id] = candidate.path;
    described.push(describeCandidate(id, candidate));
  });
  criteria[PICK_NONE_ID] = 'no single candidate is clearly better than the others based on the triage results';
  return {
    state: { question: describeQuestion(question), candidates: described },
    questions: { [PICK_QUESTION_ID]: { type: 'choice', instructions: PICK_INSTRUCTIONS, criteria } },
    pathById,
  };
}

export function resolvePick(answer: JevChoiceAnswer, threshold: number, request: PickRequest): PickOutcome {
  if (answer.choice === PICK_NONE_ID) return { picked: null, pickReason: 'none' };
  const path = Object.prototype.hasOwnProperty.call(request.pathById, answer.choice)
    ? request.pathById[answer.choice]
    : undefined;
  if (path === undefined) throw new JevError('schema', `pick devolveu um id fora do conjunto: ${answer.choice}`);
  if (answer.confidence < threshold) return { picked: null, pickReason: 'low_confidence' };
  return { picked: { path, confidence: answer.confidence }, pickReason: 'chosen' };
}

export function singlePick(candidate: FileAnswer): { path: string; confidence: number } {
  return { path: candidate.path, confidence: candidateMeasure(candidate) };
}
