import type { OrchestratorProvider, OrchestratorRuntime, SessionOrchestrator } from '../../../src/types';

export const ARCHMAP_SELECTION_FIELD_MAX_LENGTH = 200;

function selectionField(source: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = source[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Selecao de modelo invalida: ${name} obrigatorio.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Selecao de modelo invalida: ${name} deve ser texto nao vazio.`);
  }
  if (value.length > ARCHMAP_SELECTION_FIELD_MAX_LENGTH) {
    throw new Error(`Selecao de modelo invalida: ${name} acima de ${ARCHMAP_SELECTION_FIELD_MAX_LENGTH} caracteres.`);
  }
  return value;
}

export function parseArchmapSelection(value: unknown, purpose: string): SessionOrchestrator {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Selecao de modelo obrigatoria para ${purpose}.`);
  }
  const source = value as Record<string, unknown>;
  const runtime = selectionField(source, 'runtime', true) as OrchestratorRuntime;
  const provider = selectionField(source, 'provider', true) as OrchestratorProvider;
  const model = selectionField(source, 'model', true)!;
  const effort = selectionField(source, 'effort', false);
  return effort === undefined ? { runtime, provider, model } : { runtime, provider, model, effort };
}

export function parseOptionalArchmapSelection(value: unknown, purpose: string): SessionOrchestrator | null {
  if (value === undefined || value === null) return null;
  return parseArchmapSelection(value, purpose);
}
