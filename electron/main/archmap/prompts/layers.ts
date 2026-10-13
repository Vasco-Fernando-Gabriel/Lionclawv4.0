import type { LayersInput, PromptBuild } from '../pipeline/types';
import { LANGUAGE_DIRECTIVE, OUTPUT_DIRECTIVE, formatContext, jsonBlock } from './shared';

const LAYER_HINTS = [
  '| Padrao | Camada sugerida |',
  '|---|---|',
  '| Dockerfile, docker-compose.*, manifests K8s, Terraform | `layer:infrastructure` |',
  '| .github/workflows/*, .gitlab-ci.yml, Jenkinsfile | `layer:ci-cd` (ou dentro de infrastructure) |',
  '| README.md, docs/*.md, CONTRIBUTING.md | `layer:documentation` (ou na camada de codigo relacionada) |',
  '| *.sql, migrations/*.sql | `layer:data` |',
  '| *.graphql, *.proto, *.prisma | `layer:data` ou `layer:types` |',
  '| package.json, tsconfig.json, *.toml, configs yaml | `layer:config` (ou na camada de codigo relacionada) |',
].join('\n');

export function buildLayersPrompt(input: LayersInput): PromptBuild {
  const total = input.fileNodes.length;
  const sections: string[] = [
    'Voce e um arquiteto de software especialista. Sua tarefa e identificar as ' +
      'camadas arquiteturais logicas deste projeto e atribuir CADA no de nivel de ' +
      'arquivo a exatamente uma camada. A analise estrutural deterministica ' +
      '(grupos por diretorio, matriz de imports entre grupos, densidade interna, ' +
      'direcao de dependencia, topologia de deploy, padroes de diretorio) ja foi ' +
      'computada e esta abaixo — confie nela; nao ha mais nada a consultar.',
    '',
    `Projeto: \`${input.projectName}\``,
    input.description ? `Descricao: ${input.description}` : '',
    `Total de nos de nivel de arquivo: ${total}`,
    '',
    '## Nos de nivel de arquivo (id, tipo, nome, path, summary, tags)',
    '',
    jsonBlock(input.fileNodes),
    '',
    '## Analise estrutural',
    '',
    jsonBlock(input.stats),
  ];

  const context = formatContext(input.context);
  if (context.length > 0) sections.push('', context);

  sections.push(
    '',
    '## Como decidir',
    '',
    '1. Cada grupo de diretorio e um candidato a camada: `patternMatches` da o ' +
      'sinal semantico (api, service, data, ui, middleware, utility, config, test, ' +
      'types, hooks, state, assets, entry, documentation, infrastructure, ci-cd); ' +
      'densidade interna alta (> 0.3) sugere camada propria; grupos muito importados ' +
      'que importam pouco sao fundacionais (utility, types, data).',
    '2. `dependencyDirection` revela a hierarquia: camadas de topo (API, UI) dependem ' +
      'das do meio (Service, State), que dependem das de base (Data, Utility, Types). ' +
      'Ordene as camadas nessa direcao.',
    '3. Camadas nao-codigo: Infrastructure se ha Dockerfiles/Terraform/K8s (nos ' +
      '`service`/`resource`); CI/CD se ha pipelines (`pipeline`; pode fundir com ' +
      'Infrastructure); Documentation se ha 3+ docs (`document`); Data se ha ' +
      'SQL/GraphQL/Protobuf (`table`/`schema`/`endpoint`); Configuration se ha 3+ ' +
      'configs alem do package.json (`config`). Projetos pequenos: funda-as numa ' +
      'unica camada de suporte em vez de varias camadas de 1 arquivo.',
    '4. Diretorio plano/ambiguo: use summary e tags para inferir a responsabilidade.',
    '5. Escolha entre 3 e 10 camadas (3 bastam para projetos com menos de 10 ' +
      'arquivos; ate 10 para 100+). Prefira poucas camadas bem definidas a muitas ' +
      'granulares; funda grupos pequenos com proposito comum.',
    '6. Atribua TODO no: use `directoryGroups` como mecanismo principal (arquivos do ' +
      'mesmo grupo normalmente ficam juntos); nos sem encaixe claro vao para a camada ' +
      'mais relacionada ou para uma camada "Shared"/"Utility". Nenhum no fica de fora.',
    '',
    LAYER_HINTS,
    '',
    '## Formato',
    '',
    '- `id`: `layer:<kebab-case>` (ex.: `layer:api`, `layer:service`, `layer:data`, ' +
      '`layer:ui`, `layer:infrastructure`, `layer:documentation`, `layer:ci-cd`).',
    '- `name`: nome legivel em pt-BR (ex.: "Camada de API", "Infraestrutura").',
    '- `description`: 1 frase em pt-BR especifica DESTE projeto (nao generica).',
    '- `nodeIds`: array NAO vazio de ids de nos de nivel de arquivo do input.',
    '',
    '## Restricoes',
    '',
    `- A soma dos tamanhos de todos os \`nodeIds\` DEVE ser ${total} (cada no em exatamente uma camada).`,
    '- Nunca inclua ids que nao estejam no input; nunca camada vazia.',
    '- Entre 3 e 10 camadas — conte antes de responder.',
    '',
    LANGUAGE_DIRECTIVE,
    '',
    OUTPUT_DIRECTIVE,
    '',
    'Formato: `{ "layers": [ { "id", "name", "description", "nodeIds" }… ] }`.',
  );

  if (input.schemaError) {
    sections.push(
      '',
      '## ATENCAO — a tentativa anterior foi rejeitada',
      '',
      `Motivo: ${input.schemaError}`,
      '',
      'Corrija e devolva a lista COMPLETA de camadas novamente.',
    );
  }

  return {
    prompt: sections.join('\n'),
    outputSchema: {
      type: 'object',
      properties: {
        layers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              nodeIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'name', 'description', 'nodeIds'],
            additionalProperties: false,
          },
        },
      },
      required: ['layers'],
      additionalProperties: false,
    },
  };
}
