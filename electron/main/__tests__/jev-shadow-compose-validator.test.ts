import { describe, it, expect, vi } from 'vitest';
import {
  buildShadowDraft,
  buildShadowQuestions,
  compareWithGate,
  composeShadowPlan,
  JEV_SHADOW_DEFAULT_THRESHOLDS,
  type ShadowLine,
  type ShadowNewFact,
} from '../jev-shadow-compose';
import type { JevChoiceAnswer } from '../jev-client';
import type { DreamingGateResult } from '../dreaming-gate';

const TODAY = '2026-10-03';

function L(id: string, date: string | null, file: 'memory' | 'user' = 'memory', section = 'workarounds'): ShadowLine {
  return { id, file, section, text: `${id}${date ? ` [${date}]` : ''}`, date };
}

function N(id: string, file: 'memory' | 'user' = 'memory'): ShadowNewFact {
  return { id, file, text: `texto ${id}`, sourceIndex: Number(id.slice(1)) - 1 };
}

function c(choice: string, confidence = 0.95): JevChoiceAnswer {
  return { choice, confidence, probabilities: {} };
}

function base(lines: ShadowLine[], facts: ShadowNewFact[]): Record<string, JevChoiceAnswer> {
  const out: Record<string, JevChoiceAnswer> = {};
  for (const l of lines) {
    out[`o_${l.id}`] = c('no');
    out[`s_${l.id}`] = c('none');
    out[`d_${l.id}`] = c('none');
  }
  for (const f of facts) {
    out[`n_${f.id}`] = c('keep_new');
    out[`a_${f.id}`] = c('none');
    out[`c_${f.id}`] = c(f.file === 'memory' ? 'workarounds' : 'preferencias');
  }
  return out;
}

function plan(lines: ShadowLine[], facts: ShadowNewFact[], overrides: Record<string, JevChoiceAnswer>) {
  return composeShadowPlan({ lines, newFacts: facts }, { ...base(lines, facts), ...overrides }, TODAY);
}

const dests = (p: ReturnType<typeof plan>, ids: string[]) => ids.map((id) => `${id}:${p.lines[id].dest}`).join(' ');
const newDests = (p: ReturnType<typeof plan>, ids: string[]) =>
  ids.map((id) => `${id}:${p.newFacts[id].dest}`).join(' ');

describe('composicao: achados do validador da sprint 2', () => {
  it('linha que diz repetir a si mesma nao sai e vira nota', () => {
    const p = plan([L('M1', '2026-01-01')], [], { d_M1: c('M1') });
    expect(p.lines.M1.dest).toBe('fica');
    expect(p.notes.some((n) => n.id === 'M1' && n.note.includes('a si mesma'))).toBe(true);
  });

  it('perdedora que ja sai por outro motivo gera nota', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
    const p = plan(lines, [], { d_M1: c('M2'), o_M1: c('yes') });
    expect(p.lines.M1).toMatchObject({ dest: 'sai', why: 'obsoleta' });
    expect(p.notes.some((n) => n.id === 'M1' && n.note.includes('ja sai por outro motivo'))).toBe(true);
  });

  it('ciclo de tres linhas: toda remocao aponta sobrevivente que fica', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01'), L('M3', '2026-03-01')];
    const p = plan(lines, [], { d_M1: c('M2'), d_M2: c('M3'), d_M3: c('M1') });
    for (const d of Object.values(p.lines)) {
      if (d.dest === 'sai') expect(p.lines[d.survivor as string].dest).toBe('fica');
    }
    expect(Object.values(p.lines).filter((d) => d.dest === 'fica').length).toBeGreaterThanOrEqual(1);
  });

  it('trocas cruzadas com repeticao entre os dois alvos nao perdem informacao', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
    const facts = [N('N1'), N('N2')];
    const p = plan(lines, facts, {
      n_N1: c('replaces_existing'),
      a_N1: c('M1'),
      s_M1: c('N1'),
      n_N2: c('replaces_existing'),
      a_N2: c('M2'),
      s_M2: c('N2'),
      d_M1: c('M2'),
    });
    expect(`${dests(p, ['M1', 'M2'])} ${newDests(p, ['N1', 'N2'])}`).toBe('M1:sai M2:sai N1:entra N2:entra');
  });

  it('data calendario-invalida e tratada como sem data', () => {
    const line: ShadowLine = {
      id: 'M1',
      file: 'memory',
      section: 'referencias_externas',
      text: 'M1 [2026-13-45]',
      date: '2026-13-45',
    };
    expect(plan([line], [], { o_M1: c('yes') }).lines.M1.dest).toBe('fica');
    expect(plan([{ ...line, section: 'workarounds' }], [], { o_M1: c('yes') }).lines.M1.dest).toBe('sai');
  });

  it('redundante de usuario exatamente em 0,90 descarta; ancora e secao exatamente em 0,50 valem', () => {
    const lines = [L('U1', '2026-01-01', 'user', 'preferencias')];
    const facts = [N('N1', 'user'), N('N2', 'user')];
    const p = plan(lines, facts, { n_N1: c('redundant', 0.9), a_N1: c('U1', 0.5), c_N2: c('preferencias', 0.5) });
    expect(newDests(p, ['N1', 'N2'])).toBe('N1:descarta N2:entra');
  });

  it('protectDays e configuravel', () => {
    const lines = [L('M1', '2026-09-01', 'memory', 'referencias_externas')];
    const answers = { ...base(lines, []), o_M1: c('yes') };
    const strict = composeShadowPlan({ lines, newFacts: [] }, answers, TODAY, {
      ...JEV_SHADOW_DEFAULT_THRESHOLDS,
      protectDays: 10,
    });
    expect(strict.lines.M1.dest).toBe('sai');
  });

  it('o texto das perguntas e fixo', () => {
    const q = buildShadowQuestions({ lines: [L('M1', null)], newFacts: [N('N1')] });
    expect(q.o_M1.instructions).toBe(
      'Look at existing_lines entry "M1". Does the conversation show that this entry is now resolved, finished, obsolete or contradicted? Also answer yes if the entry itself is ephemeral session state, a code map citing file + line, or a countable fact derivable from a database. A topic merely being mentioned or confirmed is NOT evidence.',
    );
    expect(q.n_N1.instructions).toBe(
      'Look at new_lines entry "N1". This is a candidate line for the working memory. It deserves to stay only if it is a NEW decision with motivation, a NEW still-active workaround, a project state that CHANGED, a still-open task, or a NEW non-derivable reference (URL, id, path, measured result). It is junk if it is ephemeral session state, a finished session deliverable, a countable/derivable fact, or something already resolved in the conversation.',
    );
  });

  it('header de MEMORY com espaco final nao e reconhecido, igual ao pipeline', () => {
    const draft = buildShadowDraft({
      memoryMd: '## Decisoes ativas \nlinha\n',
      userMd: '',
      candidates: [],
      userCandidates: [],
    });
    expect(draft.lines).toEqual([]);
  });

  it('headers canonicos de USER batem com o modulo do perfil', async () => {
    vi.doMock('../db', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
    vi.doMock('../logger', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../paths', () => ({ getLionClawHome: () => '' }));
    const { USER_SECTION_HEADERS, USER_SECTION_ORDER } = await import('../memory-pipeline/user-profile');
    const { USER_SECTION_IDS } = await import('../jev-shadow-compose');
    expect(USER_SECTION_IDS).toEqual(USER_SECTION_ORDER);
    const draft = buildShadowDraft({
      memoryMd: '',
      userMd: USER_SECTION_ORDER.map((s) => `${USER_SECTION_HEADERS[s]}\n- linha ${s}\n`).join('\n'),
      candidates: [],
      userCandidates: [],
    });
    expect(draft.lines.map((l) => l.section)).toEqual(USER_SECTION_ORDER);
  });
});

describe('compareWithGate: achados do validador da sprint 2', () => {
  const gateOk = (over: Partial<DreamingGateResult> = {}): DreamingGateResult => ({
    apply: { add: [], remove: [], userAdd: [], userRemove: [] },
    quarantine: [],
    discarded: [],
    report: '',
    failSafeTriggered: false,
    ...over,
  });
  const run = (
    input: Parameters<typeof buildShadowDraft>[0],
    gate: DreamingGateResult,
    accounting: Array<{ candidateId: string; destination: string }> | null,
    quarantineAll = false,
  ) => {
    const draft = buildShadowDraft(input);
    const overrides: Record<string, JevChoiceAnswer> = {};
    if (quarantineAll) for (const f of draft.newFacts) overrides[`n_${f.id}`] = c('conflict');
    const p = composeShadowPlan(draft, { ...base(draft.lines, draft.newFacts), ...overrides }, TODAY);
    return compareWithGate(input, p, draft, gate, accounting);
  };

  it('jevQuarantine conta so entre os comparados; jevQuarantineTotal conta todos', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [
        { kind: 'add' as const, text: 'fato com par' },
        { kind: 'add' as const, text: 'fato sem par nenhum' },
      ],
      userCandidates: [],
    };
    const cmp = run(input, gateOk({ discarded: [{ text: 'fato com par', reason: 'r' }] }), null, true);
    expect(cmp.counts).toMatchObject({ compared: 1, jevQuarantine: 1, jevQuarantineTotal: 2, semRastro: 1 });
  });

  it('empate no melhor par conta como disputa, independente da ordem da saida do gate', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [
        { kind: 'add' as const, text: 'p q r s v' },
        { kind: 'add' as const, text: 'p q' },
      ],
      userCandidates: [],
    };
    for (const order of [
      ['p q r s', 'p q t u'],
      ['p q t u', 'p q r s'],
    ]) {
      const gate = gateOk({
        apply: { add: order.map((text) => ({ section: 'workarounds' as const, text })), remove: [] },
      });
      expect(run(input, gate, null).candidates[0].match).toBe('sem_rastro');
    }
  });

  it('id repetido no rastro de usuario vira sem_rastro', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [],
      userCandidates: [{ action: 'add' as const, section: 'preferencias', fact: 'f' }],
    };
    const cmp = run(input, gateOk(), [
      { candidateId: 'c1', destination: 'userAdd' },
      { candidateId: 'C1', destination: 'discarded' },
    ]);
    expect(cmp.candidates[0].match).toBe('sem_rastro');
  });

  it('destino invalido no rastro vira sem_rastro', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [],
      userCandidates: [{ action: 'add' as const, section: 'preferencias', fact: 'f' }],
    };
    const cmp = run(input, gateOk(), [{ candidateId: 'c1', destination: 'bogus' }]);
    expect(cmp.candidates[0].match).toBe('sem_rastro');
  });

  it('candidato com texto vazio vira sem_rastro', () => {
    const input = { memoryMd: '', userMd: '', candidates: [{ kind: 'add' as const, text: '   ' }], userCandidates: [] };
    const cmp = run(input, gateOk({ discarded: [{ text: 'x', reason: 'r' }] }), null);
    expect(cmp.candidates[0].match).toBe('sem_rastro');
  });

  it('adicao nao casa com linha removida pelo gate, e remocao nao casa com adicao', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [
        { kind: 'add' as const, text: 'linha velha do memory' },
        { kind: 'remove' as const, text: 'fato novo gravado' },
      ],
      userCandidates: [],
    };
    const gate = gateOk({
      apply: { add: [{ section: 'workarounds', text: 'fato novo gravado' }], remove: ['linha velha do memory'] },
    });
    expect(run(input, gate, null).candidates.map((v) => v.match)).toEqual(['sem_rastro', 'sem_rastro']);
  });
});
