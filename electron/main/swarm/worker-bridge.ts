import { randomBytes } from 'crypto';
import { mintHelperToken, revokeHelperToken, LIONCLAW_HELPER_TOKEN_ENV } from '../helper-identity';
import { resolveMcpServerRuntime } from '../mcp-path-resolver';
import { CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE, codexMcpCommand } from './codex-mcp-command';
import type { SwarmFindingsOperation, SwarmFindingsAck } from '../../../src/types/swarm';
import {
  registerSwarmRepoGraphScope,
  swarmRepoGraphCodexConfig,
  unregisterSwarmRepoGraphScope,
  type SwarmRepoGraphBinding,
} from './repo-graph';
const uploads = new Map<string, (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck> | SwarmFindingsAck>();
export const SWARM_WORKER_OWNER_PREFIX = 'swarm-findings-worker-';
export const SWARM_CODEX_TOOL_TIMEOUT_SEC = 120;
export function createSwarmWorkerBridge(
  upload: (operation: SwarmFindingsOperation) => Promise<SwarmFindingsAck> | SwarmFindingsAck,
  repoGraph: SwarmRepoGraphBinding | null = null,
): {
  extraArgs: string[];
  spawnEnv: Record<string, string>;
  repoGraphMounted: boolean;
  setRepoGraphActive: (active: boolean) => void;
  dispose: () => void;
} {
  const runtime = resolveMcpServerRuntime('lionclaw-swarm', 'dist/lionclaw-swarm/src/index.js');
  if (!runtime.command || !runtime.entryPath) throw new Error('MCP Swarm não instalado. Execute build:mcps.');
  const owner = `${SWARM_WORKER_OWNER_PREFIX}${randomBytes(32).toString('hex')}`;
  const helperToken = mintHelperToken(owner);
  uploads.set(owner, upload);
  const config = {
    command: codexMcpCommand(runtime.command),
    args: [runtime.entryPath],
    env: { LIONCLAW_SWARM_WORKER: '1' },
    env_vars: [LIONCLAW_HELPER_TOKEN_ENV],
    enabled: true,
    default_tools_approval_mode: CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE,
    tool_timeout_sec: SWARM_CODEX_TOOL_TIMEOUT_SEC,
  };
  const extraArgs = ['-c', `mcp_servers.swarm-worker=${toToml(config)}`];
  const repoGraphConfig = repoGraph ? swarmRepoGraphCodexConfig(SWARM_CODEX_TOOL_TIMEOUT_SEC) : null;
  if (repoGraph && repoGraphConfig) {
    registerSwarmRepoGraphScope(owner, repoGraph);
    extraArgs.push('-c', `mcp_servers.repo-graph=${toToml(repoGraphConfig)}`);
  }
  let disposed = false;
  return {
    extraArgs,
    spawnEnv: { [LIONCLAW_HELPER_TOKEN_ENV]: helperToken },
    repoGraphMounted: repoGraphConfig !== null,
    setRepoGraphActive: (active) => {
      if (disposed || !repoGraph || !repoGraphConfig) return;
      if (active) registerSwarmRepoGraphScope(owner, repoGraph);
      else unregisterSwarmRepoGraphScope(owner);
    },
    dispose: () => {
      disposed = true;
      uploads.delete(owner);
      unregisterSwarmRepoGraphScope(owner);
      revokeHelperToken(helperToken);
    },
  };
}
export function toToml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toToml).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${toToml(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function dispatchSwarmFindings(owner: string, operation: unknown): Promise<SwarmFindingsAck> {
  const upload = uploads.get(owner);
  if (!upload) throw new Error('Capability da tentativa ausente ou revogada.');
  return upload(operation as SwarmFindingsOperation);
}
