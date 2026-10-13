export const REPO_GRAPH_MCP_SERVER_ID = 'repo-graph';

export const REPO_GRAPH_READER_TOOLS: readonly string[] = [
  'repo_graph_status',
  'repo_graph_search',
  'repo_graph_minimal_context',
  'repo_graph_impact',
  'repo_graph_node',
  'repo_graph_callers',
  'repo_graph_callees',
].map((toolName) => `mcp__${REPO_GRAPH_MCP_SERVER_ID}__${toolName}`);

export function mergeRepoGraphAllowlist(allowedTools: string[]): string[] {
  const toolSet = new Set(allowedTools);
  for (const tool of REPO_GRAPH_READER_TOOLS) {
    toolSet.add(tool);
  }
  return [...toolSet];
}
