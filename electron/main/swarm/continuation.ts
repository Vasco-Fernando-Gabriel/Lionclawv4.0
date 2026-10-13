import { getContextWindow } from '../agent-runtime/model-context-windows';
import type { SwarmRuntime } from '../../../src/types/swarm';

export const SWARM_CONTEXT_DEFAULT_WINDOW_TOKENS = 128_000;
export const SWARM_CONTEXT_DEFAULT_LOCAL_WINDOW_TOKENS = 32_000;
export const SWARM_CONTEXT_MARGIN_TOKENS = 24_000;
export const SWARM_CONTEXT_CHARS_PER_TOKEN = 3;
const PROVIDER_BY_RUNTIME: Record<SwarmRuntime, string | undefined> = {
  cloud: 'anthropic',
  zai: 'zai',
  'minimax-tp': 'minimax',
  codex: 'codex',
  kimi: 'kimi',
  grok: 'grok',
  cursor: 'cursor',
  local: undefined,
  external: undefined,
};
export function swarmContextWindowTokens(runtime: SwarmRuntime, model: string, provider?: string): number {
  const known = getContextWindow(model, provider ?? PROVIDER_BY_RUNTIME[runtime]);
  if (known) return known;
  return runtime === 'local' ? SWARM_CONTEXT_DEFAULT_LOCAL_WINDOW_TOKENS : SWARM_CONTEXT_DEFAULT_WINDOW_TOKENS;
}
export function swarmContextBudgetChars(runtime: SwarmRuntime, model: string, provider?: string): number {
  const window = swarmContextWindowTokens(runtime, model, provider);
  const usable = Math.max(window - SWARM_CONTEXT_MARGIN_TOKENS, Math.floor(window / 2));
  return usable * SWARM_CONTEXT_CHARS_PER_TOKEN;
}
export interface SwarmPriorExecution {
  label: string;
  finalText: string | null;
  findings: string | null;
  findingsPath: string | null;
}
export interface SwarmPriorExchange {
  message: string;
  response: string | null;
}
export interface SwarmContinuationInput {
  briefing: string;
  executions: SwarmPriorExecution[];
  exchanges: SwarmPriorExchange[];
  newMessage: string;
  budgetChars: number;
}
export interface SwarmContinuationPrompt {
  prompt: string;
  size: number;
  budget: number;
  cuts: string[];
  overflow: boolean;
}
const RESUME_INSTRUCTION =
  'Continue de onde parou, nao repita o que ja entregou. Responda a mensagem nova do orquestrador e, se precisar atualizar o relatorio, grave o arquivo de achados completo de novo (o anterior foi publicado). Termine com o trailer obrigatorio.';
export const SWARM_SESSION_RUNTIMES: ReadonlySet<string> = new Set(['cloud', 'zai', 'minimax-tp', 'codex', 'cursor']);
export function swarmSessionRuntime(runtime: string): boolean {
  return SWARM_SESSION_RUNTIMES.has(runtime);
}
export function buildSessionContinuationPrompt(newMessage: string): string {
  return [
    'MENSAGEM NOVA DO ORQUESTRADOR:',
    newMessage,
    `Esta e a continuacao da sua sessao anterior neste swarm: o briefing, o historico e os achados ja estao no seu contexto. ${RESUME_INSTRUCTION}`,
  ].join('\n\n');
}
function summarySection(findings: string): string {
  const match = /^## Resumo\s*$/m.exec(findings);
  if (!match) return findings.split('\n').slice(0, 20).join('\n');
  const body = findings.slice(match.index + match[0].length).split(/\n## /)[0];
  return `## Resumo${body}`.trimEnd();
}
function findingsWithoutEvidence(findings: string): string {
  const resumo = summarySection(findings);
  const achados = /^## Achados\s*$/m.exec(findings);
  if (!achados) return resumo;
  const body = findings.slice(achados.index + achados[0].length).split(/\n## /)[0];
  const headings = body
    .split('\n')
    .filter((line) => /^###\s+\[(ALTA|MEDIA|BAIXA|INFO)\]/.test(line))
    .join('\n');
  return `${resumo}\n## Achados (so titulos)\n${headings}`.trimEnd();
}
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
interface Rendering {
  finalTexts: boolean[];
  findingsMode: Array<'full' | 'summary' | 'headings'>;
  exchangesSummarized: boolean;
}
function render(input: SwarmContinuationInput, r: Rendering, cuts: string[]): string {
  const parts: string[] = ['BRIEFING ORIGINAL:', input.briefing];
  input.executions.forEach((execution, i) => {
    parts.push(`EXECUCAO ANTERIOR ${i + 1} (${execution.label}):`);
    if (execution.finalText && r.finalTexts[i]) parts.push(`Texto final:\n${execution.finalText}`);
    else if (execution.finalText) parts.push('Texto final: (cortado por limite de contexto)');
    if (execution.findings) {
      const mode = r.findingsMode[i];
      const path = execution.findingsPath ? ` (arquivo publicado: ${execution.findingsPath})` : '';
      if (mode === 'full') parts.push(`Achados publicados${path}:\n${execution.findings}`);
      else if (mode === 'summary')
        parts.push(`Achados publicados, so o Resumo${path}:\n${summarySection(execution.findings)}`);
      else
        parts.push(
          `Achados publicados, sem o corpo das evidencias${path}:\n${findingsWithoutEvidence(execution.findings)}`,
        );
    }
  });
  if (input.exchanges.length) {
    parts.push('MENSAGENS ANTERIORES DO ORQUESTRADOR E RESPOSTAS:');
    input.exchanges.forEach((exchange, i) => {
      if (r.exchangesSummarized)
        parts.push(
          `${i + 1}. Orquestrador: ${oneLine(exchange.message)} | Resposta: ${exchange.response ? oneLine(exchange.response) : '(sem resposta)'}`,
        );
      else
        parts.push(`${i + 1}. Orquestrador:\n${exchange.message}\nResposta:\n${exchange.response ?? '(sem resposta)'}`);
    });
  }
  parts.push('MENSAGEM NOVA DO ORQUESTRADOR:', input.newMessage);
  if (cuts.length) parts.push(`CORTES POR LIMITE DE CONTEXTO: ${cuts.join('; ')}.`);
  parts.push(RESUME_INSTRUCTION);
  return parts.join('\n\n');
}
export function buildContinuationPrompt(input: SwarmContinuationInput): SwarmContinuationPrompt {
  const n = input.executions.length;
  const rendering: Rendering = {
    finalTexts: Array.from({ length: n }, () => true),
    findingsMode: Array.from({ length: n }, () => 'full' as const),
    exchangesSummarized: false,
  };
  const cuts: string[] = [];
  const fits = () => render(input, rendering, cuts).length <= input.budgetChars;
  const steps: Array<() => boolean> = [];
  for (let i = 0; i < n - 1; i++)
    steps.push(() => {
      if (!input.executions[i].finalText || !rendering.finalTexts[i]) return false;
      rendering.finalTexts[i] = false;
      cuts.push(`texto final da execucao ${i + 1} removido`);
      return true;
    });
  for (let i = 0; i < n - 1; i++)
    steps.push(() => {
      if (!input.executions[i].findings || rendering.findingsMode[i] !== 'full') return false;
      rendering.findingsMode[i] = 'summary';
      cuts.push(`achados da execucao ${i + 1} reduzidos ao Resumo`);
      return true;
    });
  if (n)
    steps.push(() => {
      if (!input.executions[n - 1].findings || rendering.findingsMode[n - 1] !== 'full') return false;
      rendering.findingsMode[n - 1] = 'headings';
      cuts.push(`achados da execucao ${n} sem o corpo das evidencias`);
      return true;
    });
  steps.push(() => {
    if (!input.exchanges.length || rendering.exchangesSummarized) return false;
    rendering.exchangesSummarized = true;
    cuts.push('mensagens antigas resumidas em uma linha');
    return true;
  });
  for (const step of steps) {
    if (fits()) break;
    step();
  }
  const prompt = render(input, rendering, cuts);
  return { prompt, size: prompt.length, budget: input.budgetChars, cuts, overflow: prompt.length > input.budgetChars };
}
export type SwarmRepairReason = 'bad-trailer' | 'invalid-findings';
const REPAIR_REASONS: Record<SwarmRepairReason, string> = {
  'bad-trailer': 'o trailer final STATUS/SUMMARY/FINDINGS estava ausente ou fora do formato exato',
  'invalid-findings': 'o arquivo de achados nao segue a estrutura obrigatoria',
};
const REPAIR_INSTRUCTION = (slug: string) =>
  `Nao refaca a analise e nao mude o conteudo. Regrave o arquivo de achados COMPLETO com a estrutura obrigatoria (# titulo, ## Resumo, ## Achados com cada achado como "### [ALTA|MEDIA|BAIXA|INFO] titulo" e, fora de INFO, as linhas "- **Evidência:**", "- **Por que importa:**" e "- **Recomendação:**", ## Fora de escopo / não verificado) e termine a resposta com o trailer exato: uma linha "---", depois STATUS: ok, SUMMARY: <uma linha>, FINDINGS: ${slug}.md; a linha QUESTION so existe com STATUS: needs-input.`;
export function swarmRepairMessage(reason: SwarmRepairReason, detail: string, slug: string): string {
  return `Seu relatorio foi rejeitado pelo motivo: ${REPAIR_REASONS[reason]} (${detail}). Corrija SO o formato preservando o conteudo. ${REPAIR_INSTRUCTION(slug)}`;
}
export function buildSessionRepairPrompt(reason: SwarmRepairReason, detail: string, slug: string): string {
  return [
    'MENSAGEM NOVA DO ORQUESTRADOR:',
    swarmRepairMessage(reason, detail, slug),
    'Esta e a continuacao da sua sessao anterior neste swarm: o briefing, a analise e o arquivo de achados rejeitado ja estao no seu contexto.',
  ].join('\n\n');
}
export interface SwarmRepairInput {
  briefing: string;
  finalText: string | null;
  findings: string | null;
  reason: SwarmRepairReason;
  detail: string;
  slug: string;
  budgetChars: number;
}
export function buildRepairPrompt(input: SwarmRepairInput): SwarmContinuationPrompt {
  const cuts: string[] = [];
  const renderRepair = (withFinalText: boolean): string => {
    const parts = ['BRIEFING ORIGINAL:', input.briefing, `EXECUCAO ANTERIOR (rejeitada por formato: ${input.reason}):`];
    if (input.finalText)
      parts.push(withFinalText ? `Texto final:\n${input.finalText}` : 'Texto final: (cortado por limite de contexto)');
    parts.push(
      input.findings
        ? `Arquivo de achados gravado e rejeitado:\n${input.findings}`
        : 'Arquivo de achados: nao foi gravado; reconstrua a partir do texto final.',
    );
    parts.push('MENSAGEM NOVA DO ORQUESTRADOR:', swarmRepairMessage(input.reason, input.detail, input.slug));
    if (cuts.length) parts.push(`CORTES POR LIMITE DE CONTEXTO: ${cuts.join('; ')}.`);
    return parts.join('\n\n');
  };
  let prompt = renderRepair(true);
  if (prompt.length > input.budgetChars && input.finalText) {
    cuts.push('texto final da execucao rejeitada removido');
    prompt = renderRepair(false);
  }
  return { prompt, size: prompt.length, budget: input.budgetChars, cuts, overflow: prompt.length > input.budgetChars };
}
