import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDefaultDeps, handleAskJevFiles } from './ask-jev-files.js';

export const TOOL_NAME = 'ask_jev_files';

export const TOOL_DESCRIPTION = `Responde uma pergunta fechada sobre o conteudo de um ou varios arquivos SEM trazer os arquivos para o seu contexto. O servidor le cada arquivo, pergunta ao Jev (modelo pequeno da TypeSafe) e devolve so a resposta tipada por arquivo.

QUANDO USAR:
- confirmar um fato sobre um arquivo (ex.: "este modulo exporta uma funcao chamada X?", "este teste cobre o caso Y?");
- localizar em qual arquivo algo esta, perguntando a mesma coisa para uma lista, um glob ou uma pasta e usando pick para o servidor apontar o melhor candidato;
- filtrar candidatos antes de abrir (kind: choice para classificar, kind: score para medir o quanto cada arquivo atende a um criterio).

QUANDO NAO USAR:
- voce ja sabe a palavra exata que procura: use grep/busca;
- voce vai editar ou citar o arquivo: leia o arquivo do jeito normal;
- arquivos binarios, sensiveis (.env, chaves, credenciais), fora das pastas permitidas, vazios ou acima de 110 KB: sao recusados e voltam em skipped com o motivo.

Alvos (targets): caminhos ABSOLUTOS de arquivos, globs com base absoluta (ex.: C:/proj/src/**/*.ts; suporta *, **, ? e {a,b}) ou pastas (percorridas ate 12 niveis e 5.000 entradas; node_modules, .git, dist, build e afins nao sao visitados). Ate 100 arquivos por chamada; acima disso a chamada e recusada com too_many_files.

Tipos de pergunta (question.kind):
- bool: pergunta de sim/nao; responde answer true | false | 'unsure' e probability (0..1). Cortes opcionais em thresholds { yesAt, noAt } (padrao 0.8 / 0.2).
- choice: options { id: descricao } (2 a 20, ids [a-z0-9_]{1,40}); o servidor acrescenta 'unknown' sempre; responde answer (id), confidence e probabilities. negativeOption marca a opcao que significa "nao se aplica".
- score: levels [...] ORDENADOS do mais baixo ao mais alto (2 a 10); responde score (0..n-1, pode ficar entre niveis), answer (indice do nivel mais provavel), confidence, probabilities e legend. minScore (0..n-1) define o nivel minimo para candidato.

pick: true (so faz sentido com mais de um arquivo): o servidor marca candidatos (bool true; choice fora de unknown/negativeOption com confidence >= threshold; score >= minScore com confidence >= threshold) e, havendo dois ou mais, faz um unico desempate com base nas respostas da triagem, sem reler os arquivos. Resultado em picked { path, confidence } e pickReason (no_candidates | single | chosen | none | low_confidence | deadline | context | error). answers vem ordenado: candidatos primeiro, depois por medida decrescente.

Limites: 8 arquivos em paralelo, 15 s por request, 45 s por chamada; ao estourar, o que terminou volta em answers, o resto em skipped com deadline e stats.partial = true. Falhas nunca derrubam a sessao: error so aparece quando nenhum arquivo foi respondido; o resto volta em skipped/pickReason com message. Nesse caso leia os arquivos do jeito normal. stats.eligible conta os arquivos que passaram pela contencao; stats.files conta os efetivamente enviados ao Jev; stats.callId identifica a chamada no registro de uso.`;

export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    targets: {
      type: 'array',
      items: { type: 'string' },
      description: 'Caminhos absolutos de arquivos, globs com base absoluta ou pastas (1 ou mais).',
    },
    question: {
      type: 'object',
      description:
        'Pergunta fechada: { kind: bool | choice | score, instructions, criteria? | thresholds? | options? | negativeOption? | levels? | minScore? }.',
      properties: {
        kind: { type: 'string', enum: ['bool', 'choice', 'score'] },
        instructions: { type: 'string' },
        criteria: {
          type: 'object',
          properties: { true: { type: 'string' }, false: { type: 'string' } },
          description: 'bool: descricao do que conta como sim e como nao.',
        },
        thresholds: {
          type: 'object',
          properties: { yesAt: { type: 'number' }, noAt: { type: 'number' } },
          description: 'bool: cortes para true (>= yesAt) e false (<= noAt); entre os dois vira unsure.',
        },
        options: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'choice: id -> descricao (2 a 20 opcoes).',
        },
        negativeOption: { type: 'string', description: 'choice: id da opcao que significa "nao se aplica".' },
        levels: {
          type: 'array',
          items: { type: 'string' },
          description: 'score: niveis ordenados do mais baixo ao mais alto (2 a 10).',
        },
        minScore: { type: 'number', description: 'score: nivel minimo (0..n-1) para o arquivo contar como candidato.' },
      },
    },
    pick: { type: 'boolean', description: 'true para o servidor apontar o melhor arquivo entre varios.' },
    threshold: {
      type: 'number',
      description: 'Confianca minima (0..1, padrao 0.5) para candidatos choice/score e para o pick.',
    },
  },
} as const;

const server = new Server({ name: 'jev-files', version: '1.0.0' }, { capabilities: { tools: {} } });

const deps = createDefaultDeps();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL_NAME) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ error: `ferramenta desconhecida: ${request.params.name}` }) },
      ],
      isError: true,
    };
  }
  const result = await handleAskJevFiles(request.params.arguments ?? {}, deps);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: result.error !== undefined };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`jev-files MCP failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
