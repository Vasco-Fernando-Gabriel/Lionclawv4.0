import { mintHelperToken, revokeHelperToken, LIONCLAW_HELPER_TOKEN_ENV } from '../helper-identity';
import { resolveMcpServerRuntime } from '../mcp-path-resolver';
import { CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE, codexMcpCommand } from './codex-mcp-command';
import { SWARM_CODEX_TOOL_TIMEOUT_SEC, toToml } from './worker-bridge';
import { SWARM_MCP_SERVER_ID } from './aggregation-policy';
import type { SwarmDeliveryRef } from '../../../src/types/swarm';

export const SWARM_CONDUCTION_RUNTIMES: ReadonlySet<string> = new Set([
  'claude-sdk',
  'claude-compat-sdk',
  'codex-sdk',
  'kimi-sdk',
  'lion-sdk',
  'grok-sdk',
  'cursor-sdk',
]);
export const SWARM_CONDUCTION_UNGUARDED_LOG = 'consolidacao sem trava por codigo';
export const SWARM_CONDUCTION_UNMOUNTED_LOG =
  '; sem as tools do swarm neste turno (chip desligado ou MCP lionclaw-swarm ausente): o turno so consolida';
export function swarmConductionUnsupportedReason(runtime: string | undefined | null): string | null {
  const id = (runtime ?? '').trim();
  if (!id) return null;
  if (SWARM_CONDUCTION_RUNTIMES.has(id)) return null;
  return `Orquestrador sem conducao neste runtime (${id}): o turno automatico nao consegue montar as tools do swarm, entao a pergunta do swarm agent nao pode ser respondida. Troque o orquestrador da sessao ou redispare o swarm agent com briefing completo.`;
}
export function swarmConductionUnmountedReason(runtime: string, detail: string): string {
  return `Orquestrador em ${runtime} sem as tools do swarm no turno automatico (${detail}): a entrega nao pode ser conduzida. Confira o chip Swarm da conversa e o MCP lionclaw-swarm, ou troque o orquestrador da sessao.`;
}
export class SwarmConductionMountError extends Error {
  readonly code = 'swarm-conduction-unmounted';
  readonly runtime: string;
  constructor(runtime: string, detail: string) {
    super(swarmConductionUnmountedReason(runtime, detail));
    this.name = 'SwarmConductionMountError';
    this.runtime = runtime;
  }
}
export function isSwarmConductionMounted(input: { serverIds: readonly string[]; toolCount: number }): boolean {
  return input.serverIds.includes(SWARM_MCP_SERVER_ID) && input.toolCount > 0;
}
export function assertSwarmConductionMounted(input: {
  runtime: string;
  serverIds: readonly string[];
  toolCount: number;
}): void {
  if (!input.serverIds.includes(SWARM_MCP_SERVER_ID))
    throw new SwarmConductionMountError(input.runtime, `servidor ${SWARM_MCP_SERVER_ID} fora do catalogo do turno`);
  if (input.toolCount <= 0)
    throw new SwarmConductionMountError(input.runtime, `servidor ${SWARM_MCP_SERVER_ID} sem tools registradas`);
}
export async function failSwarmConductionDelivery(input: {
  delivery: SwarmDeliveryRef;
  reason: string;
}): Promise<void> {
  const { delivery, reason } = input;
  const { completeSwarmDelivery } = await import('../db');
  if (delivery.kind === 'question' && delivery.slug && delivery.attemptId) {
    const { getSwarmService } = await import('./index');
    await getSwarmService().failWaiting(delivery.runId, delivery.slug, delivery.attemptId, reason);
  }
  completeSwarmDelivery(delivery.runId, delivery.kind, delivery.revision, delivery.claimId, 'undeliverable', reason);
}
export const SWARM_CONDUCTION_MCP_ENTRY = 'dist/lionclaw-swarm/src/index.js';
export function createSwarmConductionCodexMcp(input: { sessionId: string }): {
  extraArgs: string[];
  spawnEnv: Record<string, string>;
  dispose: () => void;
} {
  const runtime = resolveMcpServerRuntime(SWARM_MCP_SERVER_ID, SWARM_CONDUCTION_MCP_ENTRY);
  if (!runtime.command || !runtime.entryPath) throw new Error('MCP Swarm não instalado. Execute build:mcps.');
  const config = {
    command: codexMcpCommand(runtime.command),
    args: [runtime.entryPath],
    env: { LIONCLAW_MCP_LANE: 'desktop', LIONCLAW_MCP_SESSION_ID: input.sessionId },
    env_vars: [LIONCLAW_HELPER_TOKEN_ENV],
    enabled: true,
    default_tools_approval_mode: CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE,
    tool_timeout_sec: SWARM_CODEX_TOOL_TIMEOUT_SEC,
  };
  const token = mintHelperToken(SWARM_MCP_SERVER_ID);
  let revoked = false;
  return {
    extraArgs: ['-c', `mcp_servers.${SWARM_MCP_SERVER_ID}=${toToml(config)}`],
    spawnEnv: { [LIONCLAW_HELPER_TOKEN_ENV]: token },
    dispose: () => {
      if (revoked) return;
      revoked = true;
      revokeHelperToken(token);
    },
  };
}
