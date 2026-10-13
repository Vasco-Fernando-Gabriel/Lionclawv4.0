import { describe, expect, it } from 'vitest';
import {
  SWARM_MCP_SERVER_ID,
  isSwarmAggregationTool,
  isSwarmConductionGatewayCall,
  isSwarmConductionToolName,
  swarmAggregationGuard,
  swarmAggregationSdkOptions,
  swarmConductionMcpConfig,
} from '../swarm/aggregation-policy';

const context = () => ({ signal: new AbortController().signal, toolUseID: 'test', requestId: 'test' });
describe('Swarm aggregator cannot execute instructions embedded in findings', () => {
  it('allows only native read and search, denying writes, shell, delegation, other MCPs and unknown names', async () => {
    for (const name of ['Read', 'Grep', 'Glob']) {
      expect(isSwarmAggregationTool(name)).toBe(true);
      expect(await swarmAggregationGuard(name, { file_path: '/tmp/report' }, context())).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/tmp/report' },
      });
    }
    for (const name of [
      'Write',
      'Edit',
      'Bash',
      'Agent',
      'Task',
      'WebFetch',
      'mcp__gateway__mcp_invoke',
      'mcp__swarm__start',
      'mcp__lionclaw-pipeline-control__pipeline_create',
      'unknown',
    ]) {
      expect(isSwarmAggregationTool(name)).toBe(false);
      expect(await swarmAggregationGuard(name, {}, context())).toMatchObject({ behavior: 'deny' });
    }
    expect(swarmAggregationSdkOptions()).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: [],
      mcpServers: {},
      agents: {},
      settingSources: [],
    });
  });
  it('S2 5.3.1: the conduction turn exposes ONLY the swarm MCP and lets mcp__lionclaw-swarm__* through while Write stays denied (AC-19, AC-28)', async () => {
    for (const tool of ['swarm_start', 'swarm_wait', 'swarm_read', 'swarm_message', 'swarm_redispatch', 'swarm_stop'])
      expect(await swarmAggregationGuard(`mcp__${SWARM_MCP_SERVER_ID}__${tool}`, { runId: 'r' }, context())).toEqual({
        behavior: 'allow',
        updatedInput: { runId: 'r' },
      });
    expect(await swarmAggregationGuard('Write', { file_path: 'x' }, context())).toMatchObject({ behavior: 'deny' });
    const swarm = { command: 'node', args: ['swarm.js'], env: { LIONCLAW_HELPER_TOKEN: 't' } };
    const options = swarmAggregationSdkOptions(swarm);
    expect(options.mcpServers).toEqual({ [SWARM_MCP_SERVER_ID]: swarm });
    expect(Object.keys(options.mcpServers)).toEqual([SWARM_MCP_SERVER_ID]);
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const decision = async (tool_name: string) =>
      (
        (await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name,
            tool_input: {},
            session_id: 's',
            transcript_path: '',
            cwd: '',
          } as never,
          undefined,
          { signal: new AbortController().signal },
        )) as { hookSpecificOutput: { permissionDecision: string } }
      ).hookSpecificOutput.permissionDecision;
    expect(await decision(`mcp__${SWARM_MCP_SERVER_ID}__swarm_start`)).toBe('allow');
    expect(await decision('Bash')).toBe('deny');
    expect(await decision('Edit')).toBe('deny');
  });
  it('S2-V2: helpers de conducao por runtime (nome de tool Kimi, gateway mcp_call/mcp_schema do lion-sdk, config so com o swarm)', () => {
    expect(isSwarmConductionToolName('mcp__lionclaw-swarm__swarm_wait')).toBe(true);
    expect(isSwarmConductionToolName('mcp__google-drive__list_files')).toBe(false);
    expect(isSwarmConductionToolName('mcp_invoke')).toBe(false);
    expect(isSwarmConductionGatewayCall('mcp_call', { server_id: 'lionclaw-swarm', tool: 'swarm_start' })).toBe(true);
    expect(isSwarmConductionGatewayCall('mcp_schema', { server: 'lionclaw-swarm', tool: 'swarm_start' })).toBe(true);
    expect(isSwarmConductionGatewayCall('mcp_call', { server_id: 'google-drive', tool: 'list_files' })).toBe(false);
    expect(isSwarmConductionGatewayCall('mcp_call', null)).toBe(false);
    expect(isSwarmConductionGatewayCall('Read', { server_id: 'lionclaw-swarm' })).toBe(false);
    const swarm = { command: 'node', args: ['swarm.js'] };
    expect(swarmConductionMcpConfig({ 'google-drive': swarm, [SWARM_MCP_SERVER_ID]: swarm })).toEqual({
      [SWARM_MCP_SERVER_ID]: swarm,
    });
    expect(swarmConductionMcpConfig({ 'google-drive': swarm })).toBeUndefined();
    expect(swarmConductionMcpConfig(undefined)).toBeUndefined();
  });
});
