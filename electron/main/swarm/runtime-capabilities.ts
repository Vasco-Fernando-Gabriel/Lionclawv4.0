import {
  SWARM_RUNTIMES,
  type SwarmContinuationMode,
  type SwarmGuaranteeState,
  type SwarmReadConfinement,
  type SwarmRuntime,
  type SwarmRuntimeCapability,
} from '../../../src/types/swarm';
import { swarmSessionRuntime } from './continuation';

export const SWARM_CAPABILITY_TEST = 'swarm-executor-capabilities.test.ts';
const PROFILE =
  'perfil do swarm (createSwarmPermission) entregue ao executor real: Write so no arquivo de achados pelo host, Read/Glob/Grep confinados ao cwd da run, Bash/Edit negados';
const DISPATCH =
  'dispatcher do swarm (createSwarmToolDispatch) entregue ao executor real: Write so no arquivo de achados pelo host, Read/Glob/Grep confinados ao cwd da run, qualquer outra tool negada';
const WEB_FAMILY: ReadonlySet<SwarmRuntime> = new Set(['cloud', 'zai', 'minimax-tp']);

function capability(
  runtime: SwarmRuntime,
  read: SwarmReadConfinement,
  mechanism: string,
  provedBy: string,
  overrides: Partial<Pick<SwarmRuntimeCapability, 'write' | 'shell' | 'web'>> = {},
): SwarmRuntimeCapability {
  const continuation: SwarmContinuationMode = swarmSessionRuntime(runtime) ? 'session' : 'replay';
  const web: SwarmGuaranteeState = WEB_FAMILY.has(runtime) ? 'permitida' : 'negada';
  return {
    runtime,
    read,
    readLabel: read === 'confined' ? 'leitura confinada' : 'leitura livre',
    write: 'negada',
    shell: 'negada',
    web,
    continuation,
    continuationLabel: continuation === 'session' ? 'retomada de sessao' : 'reenvio de historico',
    mechanism,
    provedBy: `${provedBy}, provado em ${SWARM_CAPABILITY_TEST}`,
    ...overrides,
  };
}

export const SWARM_RUNTIME_CAPABILITIES: Readonly<Record<SwarmRuntime, SwarmRuntimeCapability>> = {
  cloud: capability(
    'cloud',
    'confined',
    'canUseTool e hook PreToolUse do Agent SDK com o perfil do swarm; web so no papel pesquisador',
    PROFILE,
  ),
  zai: capability(
    'zai',
    'confined',
    'canUseTool e hook PreToolUse do Agent SDK com o perfil do swarm; web so no papel pesquisador',
    PROFILE,
  ),
  'minimax-tp': capability(
    'minimax-tp',
    'confined',
    'canUseTool e hook PreToolUse do Agent SDK com o perfil do swarm; web so no papel pesquisador',
    PROFILE,
  ),
  kimi: capability(
    'kimi',
    'confined',
    'ferramentas de arquivo pelo dispatcher do swarm na bridge ACP e perfil do swarm consultado pelo driver a cada pedido',
    DISPATCH,
  ),
  grok: capability(
    'grok',
    'confined',
    'workspace grant com sessionCwd e readRoots = cwd da run e writeRoots vazio, sandbox base read-only, perfil do swarm consultado pelo driver ACP, busca web desligada (--disable-web-search)',
    PROFILE,
  ),
  cursor: capability(
    'cursor',
    'confined',
    'perfil do swarm sem bypass obriga o conjunto guardado lion_* do sidecar; lion_write so no arquivo de achados pelo host, lion_edit e lion_shell negados',
    PROFILE,
  ),
  local: capability('local', 'confined', 'dispatcher do swarm (Read/Glob/Grep sobre o cwd da run)', DISPATCH),
  external: capability('external', 'confined', 'dispatcher do swarm (Read/Glob/Grep sobre o cwd da run)', DISPATCH),
  codex: capability(
    'codex',
    'free',
    'sandbox read-only do app-server com cwd da run, MCP global isolado, achados pelo MCP swarm-worker, web_search desligada por -c',
    'sandbox read-only forcado pelo codex-executor (executionAgent) e -c web_search="disabled"',
    { write: 'sandbox', shell: 'sandbox' },
  ),
};

export function listSwarmRuntimeCapabilities(): SwarmRuntimeCapability[] {
  return SWARM_RUNTIMES.map((runtime) => SWARM_RUNTIME_CAPABILITIES[runtime]);
}

export function swarmRuntimeCapabilitiesFor(runtimes: Iterable<SwarmRuntime>): SwarmRuntimeCapability[] {
  const wanted = new Set(runtimes);
  return listSwarmRuntimeCapabilities().filter((entry) => wanted.has(entry.runtime));
}
