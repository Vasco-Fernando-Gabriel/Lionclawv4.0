import type { PromptBuild, TourInput } from '../pipeline/types';
import { LANGUAGE_DIRECTIVE, OUTPUT_DIRECTIVE, jsonBlock } from './shared';

export function buildTourPrompt(input: TourInput): PromptBuild {
  const nodeCount = Object.keys(input.nodeIndex).length;
  const minSteps = Math.min(5, Math.max(1, nodeCount));
  const sections: string[] = [
    'Voce e um educador tecnico especialista em desenhar trilhas de aprendizado ' +
      'por bases de codigo. Sua tarefa e criar um tour guiado que ensine a ' +
      'arquitetura e os conceitos-chave deste projeto em ordem pedagogica: cada ' +
      'passo constroi sobre os anteriores, levando quem nunca viu o codigo de "o ' +
      'que e este projeto?" a "entendo como funciona". A topologia do grafo ' +
      '(candidatos a entry point, ranking de fan-in/fan-out, travessia BFS, ' +
      'clusters acoplados, inventario nao-codigo) ja foi computada e esta abaixo; ' +
      'confie nela — nao ha mais nada a consultar.',
    '',
    `Projeto: \`${input.projectName}\``,
    input.description ? `Descricao: ${input.description}` : '',
    '',
    '## Indice de nos (id → nome, tipo, summary) — os UNICOS ids permitidos',
    '',
    jsonBlock(input.nodeIndex),
    '',
    '## Camadas',
    '',
    jsonBlock(input.layers),
    '',
    '## Topologia',
    '',
    jsonBlock(input.topology),
    '',
    '## Como montar o tour',
    '',
    '1. Passo 1: visao geral. Se existe `document:README.md` (ou outro doc de raiz) ' +
      'nos candidatos, comece por ele; senao pelo entry point de codigo de maior ' +
      'pontuacao.',
    '2. Use `bfsTraversal.byDepth` como espinha dorsal: profundidade 0 → passos 1–2 ' +
      '(visao geral + entry point); 1 → passos 3–4 (tipos centrais, config, modulos ' +
      'principais); 2 → passos 5–7 (funcionalidades, servicos); 3+ → passos 8–10 ' +
      '(infra de suporte, utilitarios); nao-codigo → passos finais. Nao precisa ' +
      'cobrir todo no: escolha os mais importantes por `fanInRanking`.',
    '3. Integre paradas nao-codigo nos pontos certos: README no inicio; Dockerfile ' +
      '("como o app e containerizado") apos o entry point e modulos principais; ' +
      'docker-compose depois do Dockerfile; SQL/migrations perto do modelo de dados; ' +
      'GraphQL perto dos handlers de API; CI/CD como fecho; configs relevantes ' +
      'entrelacadas aos passos de codigo em vez de agrupadas.',
    '4. Nos de um mesmo `cluster` na mesma profundidade vao juntos num passo.',
    '5. Use as camadas para o arco narrativo: explique as fundacionais antes das ' + 'que dependem delas.',
    '6. `description` de cada passo (2–4 frases): o QUE esta area faz e POR QUE ' +
      'importa; conecte aos passos anteriores ("Com os tipos de User do passo 2, este ' +
      'servico…"); destaque decisoes de design; escreva para quem nunca viu o codigo. ' +
      'Ruim: "Este e o Dockerfile." Bom: "O Dockerfile define como a aplicacao vira ' +
      'uma imagem: build em dois estagios, o primeiro compila o TypeScript e o ' +
      'segundo copia so a saida para uma imagem Alpine minima…".',
    '7. `languageLesson` (opcional): so quando um padrao de linguagem/formato e ' +
      'genuinamente educativo (generics, hooks, goroutines, multi-stage builds, ' +
      'normalizacao SQL, field numbers de Protobuf, triggers/jobs de CI…).',
    '',
    '## Restricoes',
    '',
    `- Entre ${minSteps} e 15 passos; \`order\` sequencial a partir de 1, sem lacunas nem repeticoes.`,
    '- `title`: 2–5 palavras em pt-BR. `nodeIds`: 1–5 ids do indice acima, NUNCA vazio.',
    '- Nunca referencie um id que nao esteja no indice de nos.',
    '- Inclua ao menos 1–2 paradas nao-codigo quando o projeto tem docs, infra ou ' + 'schemas relevantes.',
    '- O tour conta uma historia, nao uma lista aleatoria de arquivos.',
    '',
    LANGUAGE_DIRECTIVE,
    '',
    OUTPUT_DIRECTIVE,
    '',
    'Formato: `{ "steps": [ { "order", "title", "description", "nodeIds", "languageLesson"? }… ] }`.',
  ];

  if (input.schemaError) {
    sections.push(
      '',
      '## ATENCAO — a tentativa anterior foi rejeitada',
      '',
      `Motivo: ${input.schemaError}`,
      '',
      'Corrija e devolva o tour COMPLETO novamente.',
    );
  }

  return {
    prompt: sections.join('\n'),
    outputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              order: { type: 'integer' },
              title: { type: 'string' },
              description: { type: 'string' },
              nodeIds: { type: 'array', items: { type: 'string' } },
              languageLesson: { type: 'string' },
            },
            required: ['order', 'title', 'description', 'nodeIds'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  };
}
