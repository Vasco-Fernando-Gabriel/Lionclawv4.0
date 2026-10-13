import type { CanUseTool, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

export const SWARM_AGGREGATION_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export const SWARM_MCP_SERVER_ID = 'lionclaw-swarm';
export const SWARM_CONDUCTION_TOOL_PREFIX = `mcp__${SWARM_MCP_SERVER_ID}__`;
export const SWARM_CONDUCTION_GATEWAY_TOOLS = ['mcp_call', 'mcp_schema'] as const;
export const SWARM_CONDUCTION_READ_ONLY_NOTICE =
  'Turno automatico do Swarm: use somente leitura (ler arquivos e relatorios) e as tools do swarm (mcp lionclaw-swarm: swarm_read, swarm_inspect, swarm_list, swarm_message, swarm_stop, swarm_redispatch, swarm_wait, swarm_catalog, swarm_start). Nao escreva nem edite arquivos, nao execute comandos, nao use outras ferramentas de controle neste turno.';
export function isSwarmAggregationTool(name: string): boolean {
  return (SWARM_AGGREGATION_TOOLS as readonly string[]).includes(name) || name.startsWith(SWARM_CONDUCTION_TOOL_PREFIX);
}
export function isSwarmConductionToolName(name: string): boolean {
  return name.startsWith(SWARM_CONDUCTION_TOOL_PREFIX);
}
export function isSwarmConductionGatewayTool(name: string): boolean {
  return (SWARM_CONDUCTION_GATEWAY_TOOLS as readonly string[]).includes(name);
}
export function isSwarmConductionGatewayCall(name: string, input: unknown): boolean {
  if (!isSwarmConductionGatewayTool(name)) return false;
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const server = name === 'mcp_call' ? value.server_id : value.server;
  return server === SWARM_MCP_SERVER_ID;
}
export function swarmConductionMcpConfig<T>(config: Record<string, T> | undefined): Record<string, T> | undefined {
  const swarm = config?.[SWARM_MCP_SERVER_ID];
  return swarm ? { [SWARM_MCP_SERVER_ID]: swarm } : undefined;
}
export const swarmAggregationGuard: CanUseTool = async (name, input) =>
  isSwarmAggregationTool(name)
    ? { behavior: 'allow', updatedInput: input }
    : {
        behavior: 'deny',
        message:
          'Agregação Swarm permite somente leitura, busca e as tools do swarm; ferramentas de controle e escrita estão bloqueadas.',
      };

const aggregationHooks: { PreToolUse: HookCallbackMatcher[] } = {
  PreToolUse: [
    {
      hooks: [
        async (event) => {
          if (event.hook_event_name !== 'PreToolUse') return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: isSwarmAggregationTool(event.tool_name) ? 'allow' : 'deny',
              permissionDecisionReason: 'Agregação Swarm permite somente Read/Grep/Glob e as tools do swarm.',
            },
          };
        },
      ],
    },
  ],
};

export function swarmAggregationSdkOptions<T>(swarmServer?: T) {
  return {
    tools: [...SWARM_AGGREGATION_TOOLS],
    allowedTools: [] as string[],
    settingSources: [] as [],
    mcpServers: (swarmServer ? { [SWARM_MCP_SERVER_ID]: swarmServer } : {}) as Record<string, NonNullable<T>>,
    agents: {},
    canUseTool: swarmAggregationGuard,
    hooks: aggregationHooks,
  };
}
