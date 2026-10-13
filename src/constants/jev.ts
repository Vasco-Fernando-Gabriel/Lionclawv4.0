export const JEV_API_KEY_VAULT_KEY = 'TYPESAFE_JEV_API_KEY';
export const JEV_DEFAULT_MODEL = 'jev-1.13.0';
export const JEV_MODEL_MAX_LENGTH = 64;

export function normalizeJevModel(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0 || trimmed.length > JEV_MODEL_MAX_LENGTH) return null;
  return trimmed;
}

export function resolveJevModel(raw: string | undefined | null): string {
  return normalizeJevModel(raw) ?? JEV_DEFAULT_MODEL;
}

export type JevShadowEffectiveState = 'ativo' | 'inativo: desligado' | 'inativo: sem chave' | 'erro: chave ilegivel';

export function describeJevShadowState(input: {
  enabled: boolean;
  keyConfigured: boolean;
  keyError?: string | null;
}): JevShadowEffectiveState {
  if (!input.enabled) return 'inativo: desligado';
  if (input.keyError) return 'erro: chave ilegivel';
  if (!input.keyConfigured) return 'inativo: sem chave';
  return 'ativo';
}

export type JevFileToolsEffectiveState =
  | 'ativo'
  | 'inativo: desligado'
  | 'inativo: sem chave'
  | 'erro: chave ilegivel'
  | `erro: servidor nao subiu (${string})`;

export type JevFileToolsServerStatus = 'running' | 'stopped' | 'error' | 'missing';

export const JEV_KEY_CHANGED_EVENT = 'lionclaw:jev-key-changed';

export function describeJevFileToolsState(input: {
  enabled: boolean;
  keyConfigured: boolean;
  keyError?: string | null;
  serverStatus: JevFileToolsServerStatus;
  serverError?: string | null;
}): JevFileToolsEffectiveState {
  if (!input.enabled) return 'inativo: desligado';
  if (input.keyError) return 'erro: chave ilegivel';
  if (!input.keyConfigured) return 'inativo: sem chave';
  if (input.serverStatus === 'running') return 'ativo';
  if (input.serverStatus === 'error') {
    return `erro: servidor nao subiu (${input.serverError || 'processo encerrou com erro'})`;
  }
  if (input.serverStatus === 'stopped') return 'erro: servidor nao subiu (processo parado)';
  return 'erro: servidor nao subiu (servidor nao registrado; rode npm run build:mcps e reinicie o app)';
}
