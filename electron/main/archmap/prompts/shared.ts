import type { PromptContext } from '../pipeline/types';

export const LANGUAGE_DIRECTIVE =
  'Idioma: escreva TODO texto descritivo (summary, description, languageNotes, ' +
  'languageLesson, name de camadas, title de passos) em portugues do Brasil, com ' +
  'fraseado natural. Nomes de arquivos, ids, nomes de funcoes/classes e tags ficam ' +
  'exatamente como no codigo (tags em ingles minusculo com hifens). Termos tecnicos ' +
  'sem traducao consagrada permanecem em ingles.';

export const OUTPUT_DIRECTIVE =
  'Responda SOMENTE com um objeto JSON valido conforme o schema indicado — sem ' +
  'cercas de codigo, sem comentarios, sem texto antes ou depois. Verifique que ' +
  'todos os arrays e objetos estao fechados e que nao ha virgulas sobrando.';

export function formatContext(context: PromptContext): string {
  const parts: string[] = [];
  for (const entry of context.languages) {
    parts.push(`### Contexto da linguagem \`${entry.id}\`\n\n${entry.text.trim()}`);
  }
  for (const entry of context.frameworks) {
    parts.push(`### Contexto do framework \`${entry.id}\`\n\n${entry.text.trim()}`);
  }
  if (parts.length === 0) return '';
  return `## Contexto de linguagens e frameworks\n\n${parts.join('\n\n')}\n`;
}

export const EDGE_TYPES = [
  'imports',
  'exports',
  'contains',
  'inherits',
  'implements',
  'calls',
  'depends_on',
  'tested_by',
  'configures',
  'documents',
  'deploys',
  'migrates',
  'triggers',
  'defines_schema',
  'serves',
  'provisions',
  'routes',
  'related',
] as const;

export function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
