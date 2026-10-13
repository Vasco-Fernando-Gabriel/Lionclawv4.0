import {
  ARCHMAP_GUARANTEE_NAMES,
  ARCHMAP_RUNTIME_IDS,
  type ArchmapGuarantee,
  type ArchmapGuaranteeLabel,
  type ArchmapGuaranteeName,
  type ArchmapGuaranteeState,
  type ArchmapReadConfinement,
  type ArchmapRuntimeCapability,
  type ArchmapRuntimeId,
} from '../../../src/types/archmap';

const PROVED_BY_POLICY =
  'negado pelo perfil do mapa (archmap-policy) entregue ao executor real, provado em executor-capabilities.test.ts';
const PROVED_BY_DISPATCH =
  'negado pelo dispatcher do mapa (archmap-tool-dispatch) entregue ao executor real, provado em executor-capabilities.test.ts';
const PROVED_BY_CURSOR =
  'negado pelo conjunto guardado do executor Cursor consultando o perfil do mapa, provado em executor-capabilities.test.ts';
const PROVED_BY_GROK =
  'negado pelo perfil do mapa consultado pelo driver ACP e pela politica nativa (--disable-web-search), provado em executor-capabilities.test.ts';
const CODEX_SANDBOX = 'sandbox read-only forcado pelo codex-executor quando ha executionAgent (F32)';
const CODEX_WEB =
  'argumentos -c web_search="disabled" e features desligadas enviados e testados (executor-capabilities.test.ts); efeito no binario nao provado sem rodada real';
const CODEX_NETWORK =
  'argumentos -c web_search="disabled" e features desligadas enviados e testados; rede do shell depende do sandbox read-only do Codex; efeito no binario nao provado sem rodada real';
const CODEX_SHELL =
  'o Codex le os artefatos pelo shell dentro do sandbox read-only; um bloqueio total do shell (features.shell_tool=false) deixaria o agente sem leitura, por isso o shell nao e negado e a garantia fica nao provada';

function proved(reason: string): ArchmapGuarantee {
  return { state: 'provado', reason };
}

function unproved(reason: string): ArchmapGuarantee {
  return { state: 'nao_provado', reason };
}

function allProved(reason: string): Record<ArchmapGuaranteeName, ArchmapGuarantee> {
  return { write: proved(reason), shell: proved(reason), network: proved(reason), webTools: proved(reason) };
}

function capability(
  runtime: ArchmapRuntimeId,
  read: ArchmapReadConfinement,
  mechanism: string,
  guarantees: Record<ArchmapGuaranteeName, ArchmapGuarantee>,
): ArchmapRuntimeCapability {
  return {
    runtime,
    mechanism,
    guarantees,
    read,
    readLabel: read === 'confined' ? 'leitura confinada' : 'leitura livre',
  };
}

export const ARCHMAP_RUNTIME_CAPABILITIES: Readonly<Record<ArchmapRuntimeId, ArchmapRuntimeCapability>> = {
  cloud: capability(
    'cloud',
    'confined',
    'perfil do mapa via canUseTool e hook PreToolUse do Agent SDK (archmap-policy)',
    allProved(PROVED_BY_POLICY),
  ),
  zai: capability(
    'zai',
    'confined',
    'perfil do mapa via canUseTool e hook PreToolUse do Agent SDK (archmap-policy)',
    allProved(PROVED_BY_POLICY),
  ),
  'minimax-tp': capability(
    'minimax-tp',
    'confined',
    'perfil do mapa via canUseTool e hook PreToolUse do Agent SDK (archmap-policy)',
    allProved(PROVED_BY_POLICY),
  ),
  kimi: capability(
    'kimi',
    'confined',
    'perfil do mapa via canUseTool consultado pelo driver ACP a cada pedido (archmap-policy)',
    allProved(PROVED_BY_POLICY),
  ),
  cursor: capability(
    'cursor',
    'confined',
    'perfil do mapa sem bypass; o executor monta o conjunto guardado lion_* sobre o rascunho (archmap-policy)',
    allProved(PROVED_BY_CURSOR),
  ),
  local: capability(
    'local',
    'confined',
    'dispatcher do mapa Read/Glob/Grep sobre o rascunho (archmap-tool-dispatch)',
    allProved(PROVED_BY_DISPATCH),
  ),
  external: capability(
    'external',
    'confined',
    'dispatcher do mapa Read/Glob/Grep sobre o rascunho (archmap-tool-dispatch)',
    allProved(PROVED_BY_DISPATCH),
  ),
  'google-genai': capability(
    'google-genai',
    'confined',
    'runtime external com protocolo google-genai; dispatcher do mapa Read/Glob/Grep sobre o rascunho (archmap-tool-dispatch)',
    allProved(PROVED_BY_DISPATCH),
  ),
  grok: capability(
    'grok',
    'confined',
    'workspace grant com sessionCwd e readRoots = rascunho; perfil do mapa no driver ACP',
    allProved(PROVED_BY_GROK),
  ),
  codex: capability(
    'codex',
    'free',
    'sandbox read-only do app-server com cwd = rascunho (F32) e ferramentas web desligadas por -c web_search="disabled" (F42)',
    {
      write: proved(CODEX_SANDBOX),
      shell: unproved(CODEX_SHELL),
      network: unproved(CODEX_NETWORK),
      webTools: unproved(CODEX_WEB),
    },
  ),
};

export function listArchmapRuntimeCapabilities(): ArchmapRuntimeCapability[] {
  return ARCHMAP_RUNTIME_IDS.map((runtime) => ARCHMAP_RUNTIME_CAPABILITIES[runtime]);
}

export function archmapReadLabel(runtime: ArchmapRuntimeId | null): string {
  if (!runtime) return 'runtime fora do mapa';
  return ARCHMAP_RUNTIME_CAPABILITIES[runtime].readLabel;
}

export function archmapGuaranteeLabel(state: ArchmapGuaranteeState): ArchmapGuaranteeLabel {
  switch (state) {
    case 'provado':
      return 'garantia provada';
    case 'nao_provado':
      return 'garantia pendente';
    case 'negado':
      return 'garantia negada';
  }
}

export function archmapPendingGuarantees(capability: ArchmapRuntimeCapability): ArchmapGuaranteeName[] {
  return ARCHMAP_GUARANTEE_NAMES.filter((name) => capability.guarantees[name].state !== 'provado');
}

export function archmapOverallGuaranteeLabel(capability: ArchmapRuntimeCapability): ArchmapGuaranteeLabel {
  const states = ARCHMAP_GUARANTEE_NAMES.map((name) => capability.guarantees[name].state);
  if (states.includes('negado')) return 'garantia negada';
  if (states.includes('nao_provado')) return 'garantia pendente';
  return 'garantia provada';
}
