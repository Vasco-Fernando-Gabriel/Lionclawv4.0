import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  briefingOf,
  buildSwarmAgentPrompt,
  normalizedItems,
  parseSwarmInput,
  swarmRoleLabel,
  swarmStartSchema,
  SWARM_BRIEFING_LIMITS,
  SWARM_PROMPT_HEADERS,
} from '../swarm/validation';
import { SwarmArtifacts } from '../swarm/artifacts';
import {
  SWARM_BRIEFING_LIMITS as SHARED_LIMITS,
  SWARM_BRIEFING_KEYS,
  SWARM_BRIEFING_DESCRIPTIONS,
} from '../../../mcp-servers/_shared/swarm-briefing';
import type { SwarmStartInput } from '../../../src/types/swarm';

const registered = { kind: 'registered' as const, agentId: 'swarm-auditor' };
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-briefing-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const HEADER_ORDER = [
  SWARM_PROMPT_HEADERS.runObjective,
  SWARM_PROMPT_HEADERS.role,
  SWARM_PROMPT_HEADERS.mission,
  SWARM_PROMPT_HEADERS.target,
  SWARM_PROMPT_HEADERS.lens,
  SWARM_PROMPT_HEADERS.questions,
  SWARM_PROMPT_HEADERS.evidenceRule,
  SWARM_PROMPT_HEADERS.avoid,
  SWARM_PROMPT_HEADERS.knownContext,
  SWARM_PROMPT_HEADERS.deliverableHint,
];
function headersOf(prompt: string): string[] {
  return prompt
    .split('\n')
    .map((line) => /^([A-Z ]+):/.exec(line)?.[1])
    .filter((header): header is string => header !== undefined);
}

describe('Swarm v2 S1: briefing estruturado (SPEC 5.2)', () => {
  it('AC-3 comite: o prompt do swarm agent tem os cabecalhos fixos na ordem e so os campos informados', () => {
    const plan = parseSwarmInput(
      {
        requestId: 'briefing-01',
        cwd: root,
        objective: 'Auditar permissoes por runtime',
        knownContext: 'O confinamento do Codex e sandbox read-only.',
        mode: 'comite',
        target: 'alvo.ts',
        members: [
          {
            slug: 'codex',
            objective: 'Auditar o confinamento do runtime Codex',
            lens: 'permissoes do runtime Codex: que pastas le, onde escreve',
            questions: ['Onde o Codex confina a leitura?', 'Que escrita fora do workspace e possivel?'],
            evidenceRule: 'arquivo:linha da checagem',
            avoid: 'nao compare com outros runtimes',
            deliverableHint: 'tabela regra x status',
            member: registered,
          },
          { slug: 'minimo', objective: 'So a missao', member: registered },
        ],
      },
      [root],
    );
    const [full, minimal] = normalizedItems(plan);
    expect(headersOf(full.prompt)).toEqual(HEADER_ORDER);
    expect(full.prompt).toBe(
      [
        'OBJETIVO DA RUN: Auditar permissoes por runtime',
        'PAPEL: swarm-auditor',
        'MISSAO: Auditar o confinamento do runtime Codex',
        'ALVO: alvo.ts',
        'LENTE: permissoes do runtime Codex: que pastas le, onde escreve',
        'PERGUNTAS:',
        '1. Onde o Codex confina a leitura?',
        '2. Que escrita fora do workspace e possivel?',
        'CRITERIO DE EVIDENCIA: arquivo:linha da checagem',
        'NAO FACA: nao compare com outros runtimes',
        'CONTEXTO CONHECIDO: O confinamento do Codex e sandbox read-only.',
        'FORMATO: tabela regra x status',
      ].join('\n'),
    );
    expect(full.mission).toBe('Auditar o confinamento do runtime Codex');
    expect(full.briefing).toEqual({
      lens: 'permissoes do runtime Codex: que pastas le, onde escreve',
      questions: ['Onde o Codex confina a leitura?', 'Que escrita fora do workspace e possivel?'],
      evidenceRule: 'arquivo:linha da checagem',
      avoid: 'nao compare com outros runtimes',
      deliverableHint: 'tabela regra x status',
    });
    expect(headersOf(minimal.prompt)).toEqual([
      SWARM_PROMPT_HEADERS.runObjective,
      SWARM_PROMPT_HEADERS.role,
      SWARM_PROMPT_HEADERS.mission,
      SWARM_PROMPT_HEADERS.target,
      SWARM_PROMPT_HEADERS.knownContext,
    ]);
    for (const header of ['LENTE', 'PERGUNTAS', 'CRITERIO DE EVIDENCIA', 'NAO FACA', 'FORMATO'])
      expect(minimal.prompt).not.toContain(header);
  });

  it('S1-V5: PAPEL e o papel do swarm agent (nome: descricao, ou agentId; efemero = primeira linha do rolePrompt)', () => {
    expect(swarmRoleLabel(registered)).toBe('swarm-auditor');
    expect(swarmRoleLabel(registered, { name: 'Swarm Auditor', description: 'Auditor generico.' })).toBe(
      'Swarm Auditor: Auditor generico.',
    );
    expect(swarmRoleLabel(registered, { name: 'Swarm Auditor', description: '' })).toBe('Swarm Auditor');
    expect(swarmRoleLabel(registered, { name: '  ', description: '' })).toBe('swarm-auditor');
    expect(
      swarmRoleLabel({
        kind: 'ephemeral',
        runtime: 'cloud',
        model: 'm',
        rolePrompt: '\n\n## Papel\nRevisor de contratos.\nSegunda linha ignorada.',
        allowedTools: [],
      }),
    ).toBe('## Papel');
    expect(swarmRoleLabel(registered, { name: 'x'.repeat(300), description: 'y' }).length).toBe(200);
  });

  it('campo ausente = cabecalho ausente: sem knownContext nao ha CONTEXTO CONHECIDO nem texto inventado', () => {
    const prompt = buildSwarmAgentPrompt({ objective: 'o', role: 'p', mission: 'm', target: 't', briefing: {} });
    expect(prompt).toBe('OBJETIVO DA RUN: o\nPAPEL: p\nMISSAO: m\nALVO: t');
    expect(prompt).not.toMatch(/informado/i);
    expect(
      buildSwarmAgentPrompt({ objective: 'o', role: 'p', mission: 'm', target: 't', briefing: {}, knownContext: '  ' }),
    ).toBe('OBJETIVO DA RUN: o\nPAPEL: p\nMISSAO: m\nALVO: t');
  });

  it('AC-3 fanout: {{item}} e substituido em todos os campos do molde, item a item', () => {
    const plan = parseSwarmInput(
      {
        requestId: 'fanout-01',
        cwd: root,
        objective: 'Validar o README',
        mode: 'fanout',
        promptTemplate: 'Valide a secao {{item}} contra o codigo',
        lens: 'fidelidade de {{item}} ao codigo',
        questions: ['Cada afirmacao de {{item}} tem prova?', 'O que {{item}} promete e nao existe?'],
        evidenceRule: 'arquivo:linha para {{item}}',
        avoid: 'nao reescreva {{item}}',
        deliverableHint: 'tabela de {{item}}',
        member: registered,
        items: [{ target: 'Instalacao.md' }, { target: 'Swarm.md' }],
      },
      [root],
    );
    const items = normalizedItems(plan);
    expect(items.map((item) => item.slug)).toEqual(['instalacao', 'swarm']);
    expect(items[1].prompt).toBe(
      [
        'OBJETIVO DA RUN: Validar o README',
        'PAPEL: swarm-auditor',
        'MISSAO: Valide a secao Swarm.md contra o codigo',
        'ALVO: Swarm.md',
        'LENTE: fidelidade de Swarm.md ao codigo',
        'PERGUNTAS:',
        '1. Cada afirmacao de Swarm.md tem prova?',
        '2. O que Swarm.md promete e nao existe?',
        'CRITERIO DE EVIDENCIA: arquivo:linha para Swarm.md',
        'NAO FACA: nao reescreva Swarm.md',
        'FORMATO: tabela de Swarm.md',
      ].join('\n'),
    );
    expect(items[0].prompt).toContain('LENTE: fidelidade de Instalacao.md ao codigo');
    expect(items.every((item) => !item.prompt.includes('{{item}}'))).toBe(true);
    expect(briefingOf({ lens: 'a {{item}} b', questions: ['{{item}}'] })).toEqual({
      lens: 'a {{item}} b',
      questions: ['{{item}}'],
    });
  });

  it('schema estrito: campos desconhecidos, vazios ou acima do limite sao recusados', () => {
    const base = {
      requestId: 'estrito-01',
      cwd: root,
      objective: 'o',
      mode: 'comite' as const,
      target: 'alvo.ts',
      members: [{ slug: 's', objective: 'o', member: registered }],
    };
    const withMember = (extra: Record<string, unknown>) => ({
      ...base,
      members: [{ ...base.members[0], ...extra }],
    });
    expect(swarmStartSchema.safeParse(withMember({ lens: 'x' })).success).toBe(true);
    expect(swarmStartSchema.safeParse(withMember({ lente: 'x' })).success).toBe(false);
    expect(swarmStartSchema.safeParse(withMember({ lens: '   ' })).success).toBe(false);
    expect(swarmStartSchema.safeParse(withMember({ questions: [] })).success).toBe(false);
    expect(swarmStartSchema.safeParse(withMember({ questions: ['q', ''] })).success).toBe(false);
    expect(
      swarmStartSchema.safeParse(withMember({ questions: Array(SWARM_BRIEFING_LIMITS.questions + 1).fill('q') }))
        .success,
    ).toBe(false);
    expect(swarmStartSchema.safeParse(withMember({ lens: 'x'.repeat(SWARM_BRIEFING_LIMITS.lens + 1) })).success).toBe(
      false,
    );
    expect(
      swarmStartSchema.safeParse(withMember({ evidenceRule: 'x'.repeat(SWARM_BRIEFING_LIMITS.evidenceRule) })).success,
    ).toBe(true);
    expect(swarmStartSchema.safeParse({ ...base, lens: 'so no fanout' }).success).toBe(false);
    const fanout = {
      requestId: 'f',
      cwd: root,
      objective: 'o',
      mode: 'fanout' as const,
      promptTemplate: '{{item}}',
      member: registered,
      items: [{ target: 'a.ts' }],
    };
    expect(swarmStartSchema.safeParse({ ...fanout, deliverableHint: 'tabela' }).success).toBe(true);
    expect(swarmStartSchema.safeParse({ ...fanout, deliverableHint: '' }).success).toBe(false);
    expect(swarmStartSchema.safeParse({ ...fanout, items: [{ target: 'a.ts', lens: 'nao e por item' }] }).success).toBe(
      false,
    );
    expect(() => parseSwarmInput(withMember({ lens: 'x' }), [root])).not.toThrow();
    expect(() => parseSwarmInput(withMember({ foco: 'x' }), [root])).toThrow(/Plano Swarm inválido/);
  });

  it('S1-V3: o MCP espelha os limites do host a partir do mesmo modulo compartilhado', async () => {
    const mcpSchemaModule = ['..', '..', '..', 'mcp-servers', 'lionclaw-swarm', 'src', 'schema'].join('/');
    const { swarmStartSchema: mcpSwarmStartSchema } = await import(mcpSchemaModule);
    expect(SWARM_BRIEFING_LIMITS).toBe(SHARED_LIMITS);
    expect(Object.keys(SWARM_BRIEFING_DESCRIPTIONS)).toEqual([...SWARM_BRIEFING_KEYS]);
    const member = { slug: 's', objective: 'o', member: registered };
    const comite = (extra: Record<string, unknown>) => ({
      requestId: 'x',
      cwd: '/tmp/x',
      objective: 'o',
      mode: 'comite',
      target: 'alvo.ts',
      members: [{ ...member, ...extra }],
    });
    const fanout = (extra: Record<string, unknown>) => ({
      requestId: 'x',
      cwd: '/tmp/x',
      objective: 'o',
      mode: 'fanout',
      promptTemplate: '{{item}}',
      member: registered,
      items: [{ target: 'a.ts' }],
      ...extra,
    });
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ lens: 'x'.repeat(SHARED_LIMITS.lens) }, true],
      [{ lens: 'x'.repeat(SHARED_LIMITS.lens + 1) }, false],
      [{ lens: '  ' }, false],
      [{ questions: Array(SHARED_LIMITS.questions).fill('q') }, true],
      [{ questions: Array(SHARED_LIMITS.questions + 1).fill('q') }, false],
      [{ questions: [] }, false],
      [{ questions: ['x'.repeat(SHARED_LIMITS.question + 1)] }, false],
      [{ evidenceRule: 'x'.repeat(SHARED_LIMITS.evidenceRule + 1) }, false],
      [{ avoid: 'x'.repeat(SHARED_LIMITS.avoid + 1) }, false],
      [{ deliverableHint: 'x'.repeat(SHARED_LIMITS.deliverableHint) }, true],
      [{ deliverableHint: 'x'.repeat(SHARED_LIMITS.deliverableHint + 1) }, false],
      [{ foco: 'x' }, false],
    ];
    for (const [extra, ok] of cases) {
      expect(
        mcpSwarmStartSchema.safeParse(comite(extra)).success,
        `mcp comite ${JSON.stringify(extra).slice(0, 40)}`,
      ).toBe(ok);
      expect(
        swarmStartSchema.safeParse(comite(extra)).success,
        `host comite ${JSON.stringify(extra).slice(0, 40)}`,
      ).toBe(ok);
      expect(
        mcpSwarmStartSchema.safeParse(fanout(extra)).success,
        `mcp fanout ${JSON.stringify(extra).slice(0, 40)}`,
      ).toBe(ok);
      expect(
        swarmStartSchema.safeParse(fanout(extra)).success,
        `host fanout ${JSON.stringify(extra).slice(0, 40)}`,
      ).toBe(ok);
    }
    expect(mcpSwarmStartSchema.safeParse(comite({})).success).toBe(true);
    expect(mcpSwarmStartSchema.safeParse(fanout({})).success).toBe(true);
    const modeDescription = mcpSwarmStartSchema.shape.mode.description ?? '';
    expect(modeDescription).toMatch(/comite:.*briefing dentro de cada item de members/);
    expect(modeDescription).toMatch(/fanout:.*briefing no topo/);
    expect(mcpSwarmStartSchema.shape.lens.description).toBe(SWARM_BRIEFING_DESCRIPTIONS.lens);
  });

  it('o briefing entra no plano validado e, portanto, no requestHash e no manifesto', () => {
    const plan: SwarmStartInput = parseSwarmInput(
      {
        requestId: 'hash-01',
        cwd: root,
        objective: 'o',
        mode: 'comite',
        target: 'alvo.ts',
        members: [{ slug: 's', objective: 'o', lens: 'minha lente', member: registered }],
      },
      [root],
    );
    expect(plan.mode === 'comite' && plan.members[0].lens).toBe('minha lente');
  });
});

describe('Swarm v2 S1: relatorio com secoes livres antes de Fora de escopo', () => {
  const runId = 'swarm-20260913_120000-aabbcc';
  const report = [
    '# Validacao da secao 3',
    '## Resumo',
    'Duas regras conferem, uma diverge.',
    '## Achados',
    '### [MEDIA] Regra 3.2 diverge do codigo',
    '- **Evidência:** src/a.ts:10',
    '- **Por que importa:** o texto promete X e o codigo faz Y',
    '- **Recomendação:** corrigir o texto',
    '## Regra x status',
    '| Regra | Status |',
    '|---|---|',
    '| 3.1 | confere |',
    '| 3.2 | diverge |',
    '| 3.3 | nao verificavel |',
    '## Perguntas respondidas',
    '1. Sim, com evidencia.',
    '## Fora de escopo / não verificado',
    'Comportamento em runtime.',
    '',
  ].join('\n');
  it('a validacao aceita secoes extras (ex.: tabela regra x status) e continua exigindo os cabecalhos de hoje', () => {
    const store = new SwarmArtifacts(path.join(root, 'runs'));
    store.writeAttempt(runId, 'doc', 'attempt-1', report);
    expect(store.validateFindings(runId, 'doc', 'attempt-1').content).toBe(report);
    store.writeAttempt(runId, 'doc', 'attempt-2', report.replace('## Fora de escopo / não verificado\n', ''));
    expect(() => store.validateFindings(runId, 'doc', 'attempt-2')).toThrow(/estrutura/);
    const emptyFindings = [
      '# Validacao',
      '## Resumo',
      'ok',
      '## Achados',
      '## Regra x status',
      '| 3.1 | confere |',
      '## Fora de escopo / não verificado',
      'nada',
      '',
    ].join('\n');
    store.writeAttempt(runId, 'doc', 'attempt-3', emptyFindings);
    expect(() => store.validateFindings(runId, 'doc', 'attempt-3')).toThrow(/Achados sem conteúdo/);
  });
  it('S1-V6: "Fora de escopo / nao verificado" vale com e sem acento, mas a secao continua obrigatoria e nao vazia', () => {
    const store = new SwarmArtifacts(path.join(root, 'runs'));
    const semAcento = report.replace('## Fora de escopo / não verificado', '## Fora de escopo / nao verificado');
    store.writeAttempt(runId, 'doc', 'attempt-4', semAcento);
    expect(store.validateFindings(runId, 'doc', 'attempt-4').content).toBe(semAcento);
    store.writeAttempt(runId, 'doc', 'attempt-5', semAcento.replace('Comportamento em runtime.\n', ''));
    expect(() => store.validateFindings(runId, 'doc', 'attempt-5')).toThrow(/sem conteúdo/);
    store.writeAttempt(runId, 'doc', 'attempt-6', report.replace('## Resumo\n', '## Resumo da tabela\n## Resumo\n'));
    expect(store.validateFindings(runId, 'doc', 'attempt-6').content).toContain('## Resumo da tabela');
  });
});
