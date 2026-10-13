import { describe, it, expect } from 'vitest';
import {
  buildShadowDraft,
  buildShadowQuestions,
  buildShadowState,
  compareWithGate,
  composeShadowPlan,
  JEV_SHADOW_DEFAULT_THRESHOLDS,
  type ShadowDraft,
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

function plan(lines: ShadowLine[], facts: ShadowNewFact[], overrides: Record<string, JevChoiceAnswer>, today = TODAY) {
  return composeShadowPlan({ lines, newFacts: facts }, { ...base(lines, facts), ...overrides }, today);
}

const dests = (p: ReturnType<typeof plan>, ids: string[]) => ids.map((id) => `${id}:${p.lines[id].dest}`).join(' ');
const newDests = (p: ReturnType<typeof plan>, ids: string[]) =>
  ids.map((id) => `${id}:${p.newFacts[id].dest}`).join(' ');

describe('composeShadowPlan: fatos novos (6.3 passo 1)', () => {
  it('destino nao confiante ou unknown vai para quarentena', () => {
    const facts = [N('N1'), N('N2')];
    const p = plan([], facts, { n_N1: c('keep_new', 0.49), n_N2: c('unknown', 0.99) });
    expect(newDests(p, ['N1', 'N2'])).toBe('N1:quarentena N2:quarentena');
  });

  it('conflict vai para quarentena', () => {
    const p = plan([], [N('N1')], { n_N1: c('conflict') });
    expect(p.newFacts.N1.dest).toBe('quarentena');
    expect(p.newFacts.N1.why).toBe('conflito');
  });

  it('junk descarta no corte do arquivo: 0,50 memoria, 0,90 usuario', () => {
    const facts = [N('N1'), N('N2', 'user'), N('N3', 'user')];
    const p = plan([], facts, { n_N1: c('junk', 0.5), n_N2: c('junk', 0.89), n_N3: c('junk', 0.9) });
    expect(newDests(p, ['N1', 'N2', 'N3'])).toBe('N1:descarta N2:quarentena N3:descarta');
  });

  it('redundant exige ancora no mesmo arquivo e confianca no corte', () => {
    const lines = [L('M1', '2026-01-01'), L('U1', '2026-01-01', 'user', 'preferencias')];
    const facts = [N('N1'), N('N2'), N('N3'), N('N4', 'user')];
    const p = plan(lines, facts, {
      n_N1: c('redundant'),
      a_N1: c('M1'),
      n_N2: c('redundant'),
      a_N2: c('none'),
      n_N3: c('redundant'),
      a_N3: c('U1'),
      n_N4: c('redundant', 0.85),
      a_N4: c('U1'),
    });
    expect(newDests(p, ['N1', 'N2', 'N3', 'N4'])).toBe('N1:descarta N2:quarentena N3:quarentena N4:quarentena');
    expect(p.newFacts.N1.why).toBe('redundante com M1');
    expect(p.lines.M1.dest).toBe('fica');
    expect(p.lines.U1.dest).toBe('fica');
  });

  it('replaces_existing com ancora no mesmo arquivo troca a linha; em outro arquivo ou sem ancora vai para quarentena', () => {
    const lines = [L('M1', '2026-01-01'), L('U1', '2026-01-01', 'user', 'preferencias')];
    const facts = [N('N1'), N('N2'), N('N3')];
    const p = plan(lines, facts, {
      n_N1: c('replaces_existing'),
      a_N1: c('M1'),
      s_M1: c('N1'),
      n_N2: c('replaces_existing'),
      a_N2: c('U1'),
      n_N3: c('replaces_existing'),
      a_N3: c('none'),
    });
    expect(newDests(p, ['N1', 'N2', 'N3'])).toBe('N1:entra N2:quarentena N3:quarentena');
    expect(p.newFacts.N1.replaces).toBe('M1');
    expect(p.lines.M1).toMatchObject({ dest: 'sai', replacedBy: 'N1' });
    expect(p.lines.U1.dest).toBe('fica');
  });

  it('keep_new com ancora (respostas contraditorias) vai para quarentena', () => {
    const p = plan([L('M1', null)], [N('N1')], { n_N1: c('keep_new'), a_N1: c('M1') });
    expect(p.newFacts.N1.dest).toBe('quarentena');
    expect(p.lines.M1.why).toBe('ancora de fato novo');
  });

  it('quem entra precisa de secao confiante', () => {
    const p = plan([], [N('N1'), N('N2')], { c_N1: c('workarounds', 0.4), c_N2: c('unknown') });
    expect(newDests(p, ['N1', 'N2'])).toBe('N1:quarentena N2:quarentena');
  });

  it('fato que entra leva a secao escolhida', () => {
    const p = plan([], [N('N1')], { c_N1: c('referencias_externas') });
    expect(p.newFacts.N1).toMatchObject({ dest: 'entra', section: 'referencias_externas' });
  });
});

describe('composeShadowPlan: conflitos de troca (6.3 passo 2)', () => {
  it('dois fatos novos trocando a mesma linha => os dois em quarentena e a linha fica', () => {
    const lines = [L('M1', '2026-01-01')];
    const facts = [N('N1'), N('N2')];
    const p = plan(lines, facts, {
      n_N1: c('replaces_existing'),
      a_N1: c('M1'),
      n_N2: c('replaces_existing'),
      a_N2: c('M1'),
    });
    expect(`${dests(p, ['M1'])} ${newDests(p, ['N1', 'N2'])}`).toBe('M1:fica N1:quarentena N2:quarentena');
  });

  it('lado antigo confiante discordando da troca => quarentena e a linha fica; nao confiante => troca vale', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-01-01')];
    const facts = [N('N1'), N('N2')];
    const p = plan(lines, facts, {
      n_N1: c('replaces_existing'),
      a_N1: c('M1'),
      s_M1: c('none'),
      n_N2: c('replaces_existing'),
      a_N2: c('M2'),
      s_M2: c('none', 0.3),
    });
    expect(`${dests(p, ['M1', 'M2'])} ${newDests(p, ['N1', 'N2'])}`).toBe('M1:fica M2:sai N1:quarentena N2:entra');
  });

  it('redundante cuja ancora e trocada volta para quarentena; junk continua descartado como junk', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-01-01')];
    const facts = [N('N1'), N('N2'), N('N3'), N('N4')];
    const p = plan(lines, facts, {
      n_N1: c('redundant'),
      a_N1: c('M1'),
      n_N2: c('replaces_existing'),
      a_N2: c('M1'),
      s_M1: c('N2'),
      n_N3: c('junk'),
      a_N3: c('M2'),
      n_N4: c('replaces_existing'),
      a_N4: c('M2'),
      s_M2: c('N4'),
    });
    expect(`${dests(p, ['M1', 'M2'])} ${newDests(p, ['N1', 'N2', 'N3', 'N4'])}`).toBe(
      'M1:sai M2:sai N1:quarentena N2:entra N3:descarta N4:entra',
    );
    expect(p.newFacts.N1.why).toBe('redundante com M1, que sera trocada por N2');
    expect(p.newFacts.N3.why).toBe('junk');
  });

  it('fato em quarentena ancorado em M1 e outro fato trocando M1 com o lado antigo concordando => M1 sai', () => {
    const lines = [L('M1', '2026-01-01')];
    const facts = [N('N1'), N('N2')];
    const p = plan(lines, facts, {
      n_N1: c('conflict'),
      a_N1: c('M1'),
      n_N2: c('replaces_existing'),
      a_N2: c('M1'),
      s_M1: c('N2'),
    });
    expect(`${dests(p, ['M1'])} ${newDests(p, ['N1', 'N2'])}`).toBe('M1:sai N1:quarentena N2:entra');
  });

  it('"superada" dita so pelo lado antigo nao remove nada e vira nota', () => {
    const lines = [L('M1', '2026-01-01')];
    const facts = [N('N1')];
    const p = plan(lines, facts, { s_M1: c('N1') });
    expect(p.lines.M1.dest).toBe('fica');
    expect(p.newFacts.N1.dest).toBe('entra');
    expect(p.notes.some((n) => n.id === 'M1' && n.note.includes('superada por N1'))).toBe(true);
  });
});

describe('composeShadowPlan: linhas existentes (6.3 passo 3)', () => {
  it('redundante descartado nao deixa a ancora sair por obsolescencia', () => {
    const p = plan([L('M1', '2026-01-01')], [N('N1')], { n_N1: c('redundant'), a_N1: c('M1'), o_M1: c('yes') });
    expect(`${dests(p, ['M1'])} ${newDests(p, ['N1'])}`).toBe('M1:fica N1:descarta');
  });

  it('obsoleta confiante sai; abaixo do corte fica', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-01-01')];
    const p = plan(lines, [], { o_M1: c('yes', 0.5), o_M2: c('yes', 0.49) });
    expect(dests(p, ['M1', 'M2'])).toBe('M1:sai M2:fica');
    expect(p.lines.M1.why).toBe('obsoleta');
  });

  it('protecao de 90 dias em Referencias e Decisoes: recente fica, sem data fica, antiga sai, outra secao sai', () => {
    const lines = [
      L('M1', '2026-09-01', 'memory', 'referencias_externas'),
      L('M2', null, 'memory', 'decisoes_ativas'),
      L('M3', '2026-05-01', 'memory', 'referencias_externas'),
      L('M4', '2026-09-30', 'memory', 'estado_de_projetos'),
      L('M5', '2026-07-05', 'memory', 'decisoes_ativas'),
      L('M6', '2026-07-06', 'memory', 'decisoes_ativas'),
    ];
    const p = plan(lines, [], {
      o_M1: c('yes'),
      o_M2: c('yes'),
      o_M3: c('yes'),
      o_M4: c('yes'),
      o_M5: c('yes'),
      o_M6: c('yes'),
    });
    expect(dests(p, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])).toBe('M1:fica M2:fica M3:sai M4:sai M5:sai M6:fica');
  });

  it('a protecao usa o today da foto, nao o relogio', () => {
    const lines = [L('M1', '2026-05-01', 'memory', 'referencias_externas')];
    const p = plan(lines, [], { o_M1: c('yes') }, '2026-06-01');
    expect(p.lines.M1.dest).toBe('fica');
  });

  it('linha de USER nunca entra na protecao de 90 dias', () => {
    const lines = [L('U1', '2026-10-01', 'user', 'preferencias')];
    const p = plan(lines, [], { o_U1: c('yes') });
    expect(p.lines.U1.dest).toBe('sai');
  });
});

describe('composeShadowPlan: repeticao (6.3 passo 4)', () => {
  it('cadeia M1 -> M2 -> M3 com datas crescentes: sai so M1', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01'), L('M3', '2026-03-01')];
    const p = plan(lines, [], { d_M1: c('M2'), d_M2: c('M3') });
    expect(dests(p, ['M1', 'M2', 'M3'])).toBe('M1:sai M2:fica M3:fica');
    expect(p.lines.M1.survivor).toBe('M2');
    expect(p.notes.some((n) => n.id === 'M2' && n.note.includes('esta protegida'))).toBe(true);
  });

  it('datas diferentes: sai a mais antiga nos tres casos de quem afirma', () => {
    const variants: Array<Record<string, JevChoiceAnswer>> = [
      { d_M1: c('M2') },
      { d_M2: c('M1') },
      { d_M1: c('M2'), d_M2: c('M1') },
    ];
    for (const overrides of variants) {
      const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
      const p = plan(lines, [], overrides);
      expect(dests(p, ['M1', 'M2'])).toBe('M1:sai M2:fica');
      expect(p.lines.M1.survivor).toBe('M2');
    }
  });

  it('duas sem data que se apontam: so a de baixo sai; idem datas iguais', () => {
    for (const [a, b] of [
      [null, null],
      ['2026-01-01', '2026-01-01'],
    ] as const) {
      const lines = [L('M1', a), L('M2', b)];
      const p = plan(lines, [], { d_M1: c('M2'), d_M2: c('M1') });
      expect(dests(p, ['M1', 'M2'])).toBe('M1:fica M2:sai');
    }
  });

  it('repeticao abaixo de 0,80 ou entre arquivos nao remove nada', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01'), L('U1', '2026-01-01', 'user', 'preferencias')];
    const p = plan(lines, [], { d_M1: c('M2', 0.79), d_M2: c('U1') });
    expect(dests(p, ['M1', 'M2', 'U1'])).toBe('M1:fica M2:fica U1:fica');
    expect(p.notes.some((n) => n.id === 'M2' && n.note.includes('outro arquivo'))).toBe(true);
  });

  it('repeticao cuja sobrevivente ja sai por troca ou obsolescencia e cancelada', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
    const p1 = plan(lines, [], { d_M1: c('M2'), o_M2: c('yes') });
    expect(dests(p1, ['M1', 'M2'])).toBe('M1:fica M2:sai');
    const p2 = plan(lines, [N('N1')], { d_M1: c('M2'), n_N1: c('replaces_existing'), a_N1: c('M2'), s_M2: c('N1') });
    expect(dests(p2, ['M1', 'M2'])).toBe('M1:fica M2:sai');
  });

  it('perdedora protegida ou de Identidade: remocao cancelada', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
    const p1 = plan(lines, [N('N1')], { d_M1: c('M2'), n_N1: c('redundant'), a_N1: c('M1') });
    expect(dests(p1, ['M1', 'M2'])).toBe('M1:fica M2:fica');
    const users = [L('U1', '2026-01-01', 'user', 'identidade'), L('U2', '2026-02-01', 'user', 'preferencias')];
    const p2 = plan(users, [], { d_U2: c('U1') });
    expect(dests(p2, ['U1', 'U2'])).toBe('U1:fica U2:fica');
  });

  it('duas linhas que se apontam nunca saem juntas e toda remocao aponta sobrevivente no plano', () => {
    const lines = [L('M1', '2026-03-01'), L('M2', '2026-01-01'), L('M3', '2026-02-01')];
    const p = plan(lines, [], { d_M1: c('M2'), d_M2: c('M1'), d_M3: c('M2') });
    const leaving = Object.entries(p.lines).filter(([, d]) => d.dest === 'sai');
    for (const [, d] of leaving) {
      expect(d.survivor).not.toBeNull();
      expect(p.lines[d.survivor as string].dest).toBe('fica');
    }
  });

  it('corte de repeticao nos limites', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
    expect(plan(lines, [], { d_M1: c('M2', 0.8) }).lines.M1.dest).toBe('sai');
    expect(plan(lines, [], { d_M1: c('M2', 0.799) }).lines.M1.dest).toBe('fica');
  });
});

describe('composeShadowPlan: cortes configuraveis e recomposicao', () => {
  it('thresholds diferentes mudam o plano de forma deterministica', () => {
    const lines = [L('M1', '2026-01-01'), L('M2', '2026-02-01')];
    const answers = { ...base(lines, []), d_M1: c('M2', 0.6) };
    const strict = composeShadowPlan({ lines, newFacts: [] }, answers, TODAY, JEV_SHADOW_DEFAULT_THRESHOLDS);
    const loose = composeShadowPlan({ lines, newFacts: [] }, answers, TODAY, {
      ...JEV_SHADOW_DEFAULT_THRESHOLDS,
      repeat: 0.5,
    });
    expect(strict.lines.M1.dest).toBe('fica');
    expect(loose.lines.M1.dest).toBe('sai');
    expect(composeShadowPlan({ lines, newFacts: [] }, answers, TODAY, JEV_SHADOW_DEFAULT_THRESHOLDS)).toEqual(strict);
  });

  it('resposta ausente para uma pergunta e tratada como nao confiante', () => {
    const lines = [L('M1', '2026-01-01')];
    const p = composeShadowPlan({ lines, newFacts: [N('N1')] }, {}, TODAY);
    expect(p.lines.M1.dest).toBe('fica');
    expect(p.newFacts.N1.dest).toBe('quarentena');
  });
});

describe('buildShadowDraft', () => {
  const memoryMd = [
    '# Memoria',
    '',
    '## Decisoes ativas',
    'Decisao A [2026-01-01] revisada [2026-02-02]',
    '',
    '## Workarounds e bugs conhecidos',
    'Bug B',
    '',
    '## Secao desconhecida',
    'nao vira item',
    '',
    '## Referencias externas',
    'Ref C [2026-03-03]',
  ].join('\n');
  const userMd = [
    '# Sobre o Usuario',
    'orfao vira fatos_duraveis',
    '',
    '## Identidade',
    '- Nome: X',
    '',
    '## Preferencias',
    '- Prefere Y [2026-04-04]',
    '',
    '## Header estranho',
    '- dobrado',
  ].join('\n');

  it('reconhece so itens das secoes canonicas de MEMORY e dobra o resto do USER em fatos_duraveis, com a ultima data', () => {
    const draft = buildShadowDraft({ memoryMd, userMd, candidates: [], userCandidates: [] });
    expect(draft.lines.map((l) => `${l.id}:${l.section}:${l.date ?? '-'}`)).toEqual([
      'M1:decisoes_ativas:2026-02-02',
      'M2:workarounds:-',
      'M3:referencias_externas:2026-03-03',
      'U1:fatos_duraveis:-',
      'U2:identidade:-',
      'U3:preferencias:2026-04-04',
      'U4:fatos_duraveis:-',
    ]);
    expect(draft.lines[1].text).toBe('Bug B');
    expect(draft.lines[4].text).toBe('- Nome: X');
  });

  it('somente adicoes viram fato novo; remocoes dos dois arquivos vao para ignoredRemovals', () => {
    const draft = buildShadowDraft({
      memoryMd,
      userMd,
      candidates: [
        { kind: 'remove', text: 'tirar' },
        { kind: 'add', text: 'novo de memoria' },
      ],
      userCandidates: [
        { action: 'add', section: 'preferencias', fact: 'novo de usuario' },
        { action: 'remove', section: 'preferencias', fact: 'tirar do usuario' },
      ],
    });
    expect(draft.newFacts).toEqual([
      { id: 'N1', file: 'memory', text: 'novo de memoria', sourceIndex: 1 },
      { id: 'N2', file: 'user', text: 'novo de usuario', sourceIndex: 0 },
    ]);
    expect(draft.ignoredRemovals).toEqual([
      { file: 'memory', text: 'tirar', sourceIndex: 0 },
      { file: 'user', text: 'tirar do usuario', sourceIndex: 1 },
    ]);
  });

  it('arquivos vazios geram rascunho vazio', () => {
    const draft = buildShadowDraft({ memoryMd: '', userMd: '', candidates: [], userCandidates: [] });
    expect(draft.lines).toEqual([]);
    expect(draft.newFacts).toEqual([]);
  });
});

describe('buildShadowQuestions e buildShadowState', () => {
  const lines = [L('M1', null), L('U1', null, 'user', 'identidade'), L('U2', null, 'user', 'preferencias')];
  const facts = [N('N1'), N('N2', 'user')];
  const q = buildShadowQuestions({ lines, newFacts: facts });

  it('gera obsoleta/superada para toda linha e repete so fora de Identidade', () => {
    expect(Object.keys(q).filter((k) => k.startsWith('o_'))).toEqual(['o_M1', 'o_U1', 'o_U2']);
    expect(Object.keys(q).filter((k) => k.startsWith('s_'))).toEqual(['s_M1', 's_U1', 's_U2']);
    expect(Object.keys(q).filter((k) => k.startsWith('d_'))).toEqual(['d_M1', 'd_U2']);
  });

  it('criterios usam os ids certos e sempre incluem unknown', () => {
    expect(Object.keys(q.s_M1.criteria)).toEqual(['none', 'N1', 'N2', 'unknown']);
    expect(Object.keys(q.d_M1.criteria)).toEqual(['none', 'U1', 'U2', 'unknown']);
    expect(Object.keys(q.a_N1.criteria)).toEqual(['none', 'M1', 'U1', 'U2', 'unknown']);
    expect(Object.keys(q.n_N1.criteria)).toEqual([
      'keep_new',
      'replaces_existing',
      'redundant',
      'junk',
      'conflict',
      'unknown',
    ]);
    expect(Object.keys(q.c_N1.criteria)).toEqual([
      'decisoes_ativas',
      'workarounds',
      'estado_de_projetos',
      'referencias_externas',
      'unknown',
    ]);
    expect(Object.keys(q.c_N2.criteria)).toEqual([
      'identidade',
      'perfil_profissional',
      'negocios_projetos',
      'stack_ferramentas',
      'preferencias',
      'fatos_duraveis',
      'unknown',
    ]);
    for (const question of Object.values(q)) expect(question.type).toBe('choice');
  });

  it('o state leva today, conversa e as linhas sem a data interpretada', () => {
    const state = buildShadowState({ lines, newFacts: facts }, TODAY, 'conversa');
    expect(state).toEqual({
      today: TODAY,
      conversation: 'conversa',
      existing_lines: [
        { id: 'M1', file: 'memory', section: 'workarounds', text: 'M1' },
        { id: 'U1', file: 'user', section: 'identidade', text: 'U1' },
        { id: 'U2', file: 'user', section: 'preferencias', text: 'U2' },
      ],
      new_lines: [
        { id: 'N1', file: 'memory', text: 'texto N1' },
        { id: 'N2', file: 'user', text: 'texto N2' },
      ],
    });
  });
});

describe('compareWithGate (S16)', () => {
  const gateOk = (over: Partial<DreamingGateResult> = {}): DreamingGateResult => ({
    apply: { add: [], remove: [], userAdd: [], userRemove: [] },
    quarantine: [],
    discarded: [],
    report: '',
    failSafeTriggered: false,
    ...over,
  });

  function run(
    input: Parameters<typeof buildShadowDraft>[0],
    gate: DreamingGateResult,
    accounting: Array<{ candidateId: string; destination: string }> | null,
    jevDest: Record<string, 'keep_new' | 'junk' | 'conflict'> = {},
  ) {
    const draft: ShadowDraft = buildShadowDraft(input);
    const overrides: Record<string, JevChoiceAnswer> = {};
    for (const [id, choice] of Object.entries(jevDest)) overrides[`n_${id}`] = c(choice);
    const p = composeShadowPlan(draft, { ...base(draft.lines, draft.newFacts), ...overrides }, TODAY);
    return { draft, p, cmp: compareWithGate(input, p, draft, gate, accounting) };
  }

  it('usuario: pelo rastro de accounting; sem rastro vira sem_rastro', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [],
      userCandidates: [
        { action: 'add' as const, section: 'preferencias', fact: 'fato A' },
        { action: 'add' as const, section: 'preferencias', fact: 'fato B' },
        { action: 'add' as const, section: 'preferencias', fact: 'fato C' },
      ],
    };
    const { cmp } = run(input, gateOk(), [
      { candidateId: 'c1', destination: 'userAdd' },
      { candidateId: 'C3', destination: 'discarded' },
    ]);
    expect(cmp.candidates.map((v) => `${v.sourceIndex}:${v.dest ?? '-'}:${v.match}`)).toEqual([
      '0:apply:accounting',
      '1:-:sem_rastro',
      '2:descarta:accounting',
    ]);
    expect(cmp.counts).toMatchObject({ compared: 2, agree: 1, disagree: 1, semRastro: 1 });
  });

  it('memoria: texto igual apos normalizacao casa como exact; semelhanca unica casa como similar', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [
        { kind: 'add' as const, text: 'Decisao usar Vitest no projeto' },
        { kind: 'add' as const, text: 'Workaround do bug X com passo Y e Z' },
      ],
      userCandidates: [],
    };
    const gate = gateOk({
      apply: { add: [{ section: 'decisoes_ativas', text: 'Decisão usar Vitest no projeto [2026-10-03]' }], remove: [] },
      discarded: [{ text: 'workaround do bug X com passo Y', reason: 'efemero' }],
    });
    const { cmp } = run(input, gate, null);
    expect(cmp.candidates.map((v) => `${v.dest}:${v.match}`)).toEqual(['apply:exact', 'descarta:similar']);
    expect(cmp.counts).toMatchObject({ compared: 2, agree: 1, disagree: 1, gateAppliedJevDiscards: 0 });
  });

  it('memoria: par disputado ou mais de um par vira sem_rastro e fica fora das contagens', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [
        { kind: 'add' as const, text: 'bug X passo Y ativo' },
        { kind: 'add' as const, text: 'bug X passo Y resolvido' },
        { kind: 'add' as const, text: 'fato unico Q' },
      ],
      userCandidates: [],
    };
    const gate = gateOk({
      discarded: [
        { text: 'bug X passo Y', reason: 'r' },
        { text: 'fato unico Q', reason: 'r' },
        { text: 'fato unico Q', reason: 'r2' },
      ],
    });
    const { cmp } = run(input, gate, null);
    expect(cmp.candidates.map((v) => v.match)).toEqual(['sem_rastro', 'sem_rastro', 'sem_rastro']);
    expect(cmp.counts.compared).toBe(0);
    expect(cmp.counts.semRastro).toBe(3);
  });

  it('gate gravou e Jev descartaria conta em gateAppliedJevDiscards', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [{ kind: 'add' as const, text: 'fato F' }],
      userCandidates: [],
    };
    const gate = gateOk({ apply: { add: [{ section: 'workarounds', text: 'fato F' }], remove: [] } });
    const { cmp } = run(input, gate, null, { N1: 'junk' });
    expect(cmp.counts).toMatchObject({ compared: 1, agree: 0, disagree: 1, gateAppliedJevDiscards: 1 });
  });

  it('gate em fail-safe: todos os candidatos em quarentena com forma failsafe, sem sem_rastro, fora das contagens', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [
        { kind: 'add' as const, text: 'a' },
        { kind: 'remove' as const, text: 'b' },
      ],
      userCandidates: [{ action: 'add' as const, section: 'preferencias', fact: 'c' }],
    };
    const gate = gateOk({
      failSafeTriggered: true,
      failSafeReason: 'timeout',
      quarantine: [{ text: 'a', reason: 'gate_failed' }],
    });
    const { cmp } = run(input, gate, null);
    expect(cmp.candidates.map((v) => `${v.file}:${v.kind}:${v.dest}:${v.match}`)).toEqual([
      'memory:add:quarentena:failsafe',
      'memory:remove:quarentena:failsafe',
      'user:add:quarentena:failsafe',
    ]);
    expect(cmp.counts).toMatchObject({ compared: 0, agree: 0, disagree: 0, semRastro: 0 });
  });

  it('propostas de remocao tambem recebem destino do gate, mas nao entram nas contagens', () => {
    const input = {
      memoryMd: '',
      userMd: '',
      candidates: [{ kind: 'remove' as const, text: 'linha velha' }],
      userCandidates: [],
    };
    const gate = gateOk({ apply: { add: [], remove: ['linha velha'] } });
    const { cmp } = run(input, gate, null);
    expect(cmp.candidates[0]).toMatchObject({ kind: 'remove', dest: 'apply', op: 'remove', match: 'exact' });
    expect(cmp.counts.compared).toBe(0);
  });
});
