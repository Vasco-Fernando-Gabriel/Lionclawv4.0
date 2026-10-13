import { describe, expect, it, vi } from 'vitest';
vi.mock('../mcp-path-resolver', () => ({
  resolveMcpServerRuntime: () => ({ command: '/node', entryPath: '/swarm.js', env: {} }),
}));
import { resolveHelperTokenOwner } from '../helper-identity';
import { SWARM_CODEX_TOOL_TIMEOUT_SEC, createSwarmWorkerBridge, dispatchSwarmFindings } from '../swarm/worker-bridge';
import { createSwarmConductionCodexMcp } from '../swarm/conduction-mcp';
import { SWARM_WAIT_MAX_SLICE_MS } from '../swarm/runner';
import { SWARM_WAIT_TURN_POLL_MS } from '../local-ipc/jsonrpc-methods';
describe('Swarm worker capability', () => {
  it('vincula upload exclusivamente à tentativa e revoga imediatamente', async () => {
    const upload = vi.fn(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }));
    const first = createSwarmWorkerBridge(upload);
    const secondUpload = vi.fn(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }));
    const second = createSwarmWorkerBridge(secondUpload);
    const token = resolveHelperTokenOwner(first.spawnEnv.LIONCLAW_HELPER_TOKEN)!;
    expect(first.extraArgs.join(' ')).not.toContain(first.spawnEnv.LIONCLAW_HELPER_TOKEN);
    const operation = { operation: 'begin', uploadId: 'u' };
    await dispatchSwarmFindings(token, operation);
    expect(upload).toHaveBeenCalledWith(operation);
    expect(secondUpload).not.toHaveBeenCalled();
    first.dispose();
    await expect(dispatchSwarmFindings(token, operation)).rejects.toThrow('revogada');
    await expect(dispatchSwarmFindings('inventado', operation)).rejects.toThrow('revogada');
    second.dispose();
  });
  it('GB-4: o MCP do worker e o da conducao no Codex declaram tool_timeout_sec acima da fatia do swarm_wait, com margem medida', () => {
    const worker = createSwarmWorkerBridge(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }));
    const conduction = createSwarmConductionCodexMcp({ sessionId: 's' });
    try {
      for (const bridge of [worker, conduction]) {
        expect(bridge.extraArgs[0]).toBe('-c');
        expect(bridge.extraArgs[1]).toContain(`"tool_timeout_sec"=${SWARM_CODEX_TOOL_TIMEOUT_SEC}`);
      }
      expect(conduction.extraArgs[1]).toMatch(/^mcp_servers\.lionclaw-swarm=\{/);
      expect(worker.extraArgs[1]).toMatch(/^mcp_servers\.swarm-worker=\{/);
      const ipcClientTimeoutMs = 60_000;
      const marginOverSliceMs =
        SWARM_CODEX_TOOL_TIMEOUT_SEC * 1_000 - (SWARM_WAIT_MAX_SLICE_MS + SWARM_WAIT_TURN_POLL_MS);
      const marginOverIpcMs = SWARM_CODEX_TOOL_TIMEOUT_SEC * 1_000 - ipcClientTimeoutMs;
      expect(SWARM_CODEX_TOOL_TIMEOUT_SEC).toBeGreaterThanOrEqual(70);
      expect(marginOverSliceMs).toBe(69_000);
      expect(marginOverIpcMs).toBe(60_000);
    } finally {
      worker.dispose();
      conduction.dispose();
    }
  });
});
