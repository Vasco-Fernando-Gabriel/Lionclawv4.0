import { describe, it, expect } from 'vitest';
import { buildSwarmSection, buildSwarmStub } from '../prompt-builder';
import {
  SWARM_START_DESCRIPTION,
  SWARM_MODE_GUIDANCE,
  SWARM_TARGET_GUIDANCE,
  SWARM_COMITE_EXAMPLE,
  SWARM_FANOUT_EXAMPLE,
  SWARM_STAGES_EXAMPLE,
  SWARM_USE_CASES,
  SWARM_WAIT_DESCRIPTION,
} from '../../../mcp-servers/_shared/swarm-guidance';
import { SWARM_GENERIC_ROLE_IDS } from '../swarm/generic-roles';

const FIVE_CASES = [
  /documentacao repartida/,
  /SPEC contra codigo/,
  /permissoes de acesso a repositorios e pastas por runtime/,
  /validacao de bug/,
  /falhas de seguranca/,
];
const BRIEFING_MOLDE = [
  'MISSAO',
  'ALVO',
  'LENTE',
  'PERGUNTAS',
  'CRITERIO DE EVIDENCIA',
  'NAO FACA',
  'CONTEXTO CONHECIDO',
  'FORMATO',
];
const BRIEFING_FIELDS = [
  'objective',
  'target',
  'lens',
  'questions',
  'evidenceRule',
  'avoid',
  'knownContext',
  'deliverableHint',
];

describe('Swarm v2 S1: secao Swarm do prompt do orquestrador (AC-4, AC-29 parte do prompt)', () => {
  const section = buildSwarmSection();
  const stub = buildSwarmStub();

  it('com o chip ligado a secao lista os cinco casos de uso do dono', () => {
    expect(section.startsWith('# Swarm\n')).toBe(true);
    expect(SWARM_USE_CASES).toHaveLength(5);
    for (const useCase of FIVE_CASES) expect(section).toMatch(useCase);
    expect(section).toMatch(/Nao use para desenvolver codigo; use Workflows/);
  });

  it('GA-4: a secao traz um exemplo de trabalho em etapas narrado (analise com 3, espera, decisao, validacao com 2, consolidacao) e explica cancelled e consumedBy', () => {
    expect(section).toContain(SWARM_STAGES_EXAMPLE);
    expect(section).toMatch(/Exemplo em etapas, narrado: "vou mandar 3 swarm agents/);
    expect(section).toMatch(/swarm_start \(comite, 3\) -> swarm_wait ate done -> "li:/);
    expect(section).toMatch(/swarm_start \(parentRunId, stage "validacao", 2\) -> swarm_wait ate done -> consolido/);
    expect(section).toMatch(
      /cancelled = turno interrompido: nao chame de novo, o resultado chega num turno automatico/,
    );
    expect(section).toMatch(/consumedBy:"delivery" = entrega antiga, siga/);
    expect(SWARM_WAIT_DESCRIPTION).toMatch(/cancelled \(turno interrompido/);
    expect(SWARM_WAIT_DESCRIPTION).toMatch(/consumedBy:"delivery"/);
  });

  it('S1-V7/S2: a secao com chip ligado cabe em 5.000 caracteres e a descricao da tool nao repete os modos', () => {
    expect(section.length).toBeLessThan(5000);
    expect(SWARM_START_DESCRIPTION).not.toContain(SWARM_MODE_GUIDANCE);
    expect(SWARM_START_DESCRIPTION).not.toMatch(/- comite: /);
    expect(SWARM_START_DESCRIPTION).toMatch(/siga a secao "# Swarm" do prompt do sistema/);
    expect(SWARM_START_DESCRIPTION.length).toBeLessThanOrEqual(3000);
  });

  it('ensina a escrever um briefing: o molde com os cabecalhos fixos, os campos, um exemplo completo e os outros casos em uma linha', () => {
    expect(section).toContain('## Como escrever um briefing');
    expect(section).toContain('O briefing e o trabalho; o papel e o jeito');
    for (const header of BRIEFING_MOLDE) expect(section).toContain(`(${header})`);
    for (const field of BRIEFING_FIELDS) expect(section).toMatch(new RegExp(`- ${field} \\(`));
    expect(section).toMatch(/O PAPEL vem do agente escolhido/);
    expect(section).toMatch(/Campo ausente nao vira cabecalho/);
    expect(section).toMatch(/Exemplo completo \(SPEC contra codigo/);
    for (const n of ['1. Documentacao repartida', '2. Permissoes por runtime', '3. Bug', '4. Seguranca'])
      expect(section).toContain(n);
    expect(section).toMatch(/\{\{item\}\}/);
  });

  it('manda preferir os genericos com briefing e usar especializados so com a lente exata', () => {
    expect(section).toContain('## Papeis');
    expect(section).toMatch(/Prefira os papeis genericos/);
    for (const id of SWARM_GENERIC_ROLE_IDS) expect(section).toContain(id);
    expect(section).toMatch(/especializado so quando a lente dele e exatamente a pedida/);
    expect(section).toMatch(/generic:true/);
    expect(section).toMatch(/recebe o mesmo contrato de saida, nao o repita/);
  });

  it('manda narrar antes de cada disparo e depois de cada leitura (D10) e mantem a RM5', () => {
    expect(section).toContain('## Narracao no chat');
    expect(section).toMatch(/antes de cada disparo, diga o que vai fazer e por que/);
    expect(section).toMatch(/depois de cada espera ou leitura de resultado, diga o que leu e o que decidiu/);
    expect(section).toMatch(/Nunca aborte uma run inteira sem pedido do usuario/);
    expect(section).toMatch(/nunca dispare um segundo swarm para a mesma pergunta antes de ler o primeiro/);
  });

  it('mantem comite x fanout, requestId estavel, varias runs por chat e a consolidacao com evidencias', () => {
    expect(section).toMatch(/- comite: /);
    expect(section).toMatch(/- fanout: /);
    expect(section).toContain('requestId');
    expect(section).not.toMatch(/uma run ativa por chat/i);
    expect(section).toMatch(/Varias runs por chat sao normais/);
    expect(section).toMatch(/Nunca aborte uma run inteira sem pedido do usuario/);
    expect(section).toMatch(/deduplique por evidencia, cite as evidencias e declare falhas e cobertura nao verificada/);
    expect(section).not.toMatch(/\bmembros\b/);
  });

  it('com o chip desligado so a instrucao de ligar, sem casos, molde, genericos ou narracao', () => {
    expect(stub).toBe(
      '# Swarm\nSwarm desligado. Para análise paralela via Swarm, peça para ligar o chip Swarm e reenviar.',
    );
    for (const useCase of FIVE_CASES) expect(stub).not.toMatch(useCase);
    for (const header of BRIEFING_MOLDE) expect(stub).not.toContain(header);
    for (const id of SWARM_GENERIC_ROLE_IDS) expect(stub).not.toContain(id);
    expect(stub).not.toMatch(/narr/i);
  });
});

describe('Swarm v2 pos-gate: alvo concreto e repo-graph antes de disparar', () => {
  const section = buildSwarmSection();
  it('a secao exige alvo em pasta/arquivo ou URL, recusa alvos genericos e manda consultar o repo-graph ou um swarm-explorer apertado antes; exemplos dos cinco casos com alvos em arquivos', () => {
    expect(section).toContain('## Alvo concreto');
    expect(section).toContain(SWARM_TARGET_GUIDANCE);
    expect(section).toMatch(/target_too_broad/);
    expect(section).toMatch(/"o repositorio", "o codigo", "todo o projeto" e "\." sao recusados/);
    expect(section).toMatch(/consulte o repo-graph \(repo_graph_search\/minimal_context\)/);
    expect(section).toMatch(/swarm-explorer de alvo apertado/);
    expect(section).toMatch(/items \["secao 5\.1 de docs\/SPEC\.md", "secao 5\.2 de docs\/SPEC\.md"\]/);
    expect(section).toMatch(/items \["docs\/README\.md", "docs\/guia\.md"\]/);
    expect(section).toMatch(/target "electron\/main\/agent-runtime\/"/);
    expect(section).toMatch(/target "src\/auth\/login\.ts"/);
    expect(section).toMatch(/target "electron\/main\/local-ipc\/"/);
    expect(section.length).toBeLessThan(5000);
    expect(SWARM_COMITE_EXAMPLE.target).toBe('src/auth/');
    expect(SWARM_FANOUT_EXAMPLE.items.every((item) => item.target.includes('docs/SPEC.md'))).toBe(true);
  });
});
