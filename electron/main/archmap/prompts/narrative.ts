import type { NarrativeInput, PromptBuild } from '../pipeline/types';
import { LANGUAGE_DIRECTIVE, OUTPUT_DIRECTIVE, jsonBlock } from './shared';

const KNOWN_FRAMEWORKS =
  'JS/TS: react, vue, svelte, @angular/core, express, fastify, koa, next, nuxt, ' +
  'vite, vitest, jest, mocha, tailwindcss, prisma, typeorm, sequelize, mongoose, ' +
  'redux, zustand, mobx, electron. Python: django, djangorestframework, fastapi, ' +
  'flask, sqlalchemy, alembic, celery, pydantic, uvicorn, gunicorn, aiohttp, ' +
  'tornado, starlette, pytest. Ruby: rails, sinatra, grape, rspec, sidekiq, ' +
  'activerecord, devise. Go: gin, echo, fiber, chi, gorm. Rust: actix-web, axum, ' +
  'rocket, diesel, tokio, serde, warp. JVM: spring-boot, spring-web, spring-data, ' +
  'quarkus, micronaut, hibernate, jakarta, junit, ktor. Infra: Docker, Docker ' +
  'Compose, Terraform, GitHub Actions, GitLab CI, Jenkins.';

export function buildNarrativePrompt(input: NarrativeInput): PromptBuild {
  const manifests =
    input.manifests.length === 0
      ? '(nenhum manifesto encontrado)'
      : input.manifests.map((m) => `### ${m.path}\n\n\`\`\`\n${m.content}\n\`\`\``).join('\n\n');

  const prompt = [
    'Voce e um especialista em inventario de projetos de software. A partir dos ' +
      'materiais abaixo (ja carregados para voce — nao existe nada a consultar alem ' +
      'deste texto), sintetize a narrativa do projeto.',
    '',
    `Diretorio do projeto: \`${input.projectDirName}\``,
    `Total de arquivos no inventario: ${input.fileCount}`,
    '',
    '## Contagem de arquivos por linguagem',
    '',
    jsonBlock(input.languageCounts),
    '',
    '## README (primeiros 12 KiB)',
    '',
    input.readme.trim().length > 0 ? input.readme : '(ausente)',
    '',
    '## Manifestos',
    '',
    manifests,
    '',
    '## O que produzir',
    '',
    '- `name`: em ordem de prioridade, o `name` do package.json, o `[package].name` ' +
      'do Cargo.toml, o ultimo segmento do modulo do go.mod, o `[project].name` ou ' +
      '`[tool.poetry].name` do pyproject.toml; senao o nome do diretorio do projeto.',
    '- `description`: 1–2 frases em pt-BR sobre o que o projeto e/faz, baseadas na ' +
      'descricao do manifesto ou no README (sem marketing). Sem base alguma, ' +
      'devolva a string vazia `""` — nunca invente.',
    `- \`frameworks\`: SO os confirmados nas dependencias/manifestos ou pela presenca ` +
      `de arquivos (lista de referencia: ${KNOWN_FRAMEWORKS}). Use o nome canonico ` +
      '(ex.: "React", "Next.js", "Express", "Django", "Docker"). Array vazio se nenhum.',
    '- `languages`: conjunto deduplicado e ordenado alfabeticamente das linguagens ' +
      'relevantes do projeto, cruzando os manifestos com a contagem por linguagem ' +
      '(ids minusculos como na contagem: typescript, python, markdown, yaml…). ' +
      'Ignore ids meramente tecnicos com 1–2 arquivos quando houver linguagens ' +
      'principais claras.',
    '',
    'Manifesto ausente ou malformado ⇒ deixe o campo vazio em vez de adivinhar.',
    '',
    LANGUAGE_DIRECTIVE,
    '',
    OUTPUT_DIRECTIVE,
  ];

  if (input.schemaError) {
    prompt.push(
      '',
      '## ATENCAO — a tentativa anterior foi rejeitada',
      '',
      `Motivo: ${input.schemaError}`,
      '',
      'Corrija o problema acima e devolva a narrativa COMPLETA novamente.',
    );
  }

  return {
    prompt: prompt.join('\n'),
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        frameworks: { type: 'array', items: { type: 'string' } },
        languages: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'description', 'frameworks', 'languages'],
      additionalProperties: false,
    },
  };
}
