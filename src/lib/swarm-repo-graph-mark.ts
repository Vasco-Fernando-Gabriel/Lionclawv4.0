export const REPO_GRAPH_MARK = 'repo-graph';
export const REPO_GRAPH_OFF_MARK = 'repo-graph:off';

export function isRepoGraphMark(id: string): boolean {
  return id === REPO_GRAPH_MARK || id === REPO_GRAPH_OFF_MARK;
}

export function withRepoGraphMark(mcpServers: readonly string[], enabled: boolean): string[] {
  const rest = mcpServers.filter((id) => !isRepoGraphMark(id));
  return enabled ? [...rest, REPO_GRAPH_MARK] : [...rest, REPO_GRAPH_OFF_MARK];
}

export function repoGraphMarkOf(mcpServers: readonly string[]): 'on' | 'off' | 'unset' {
  if (mcpServers.includes(REPO_GRAPH_OFF_MARK)) return 'off';
  if (mcpServers.includes(REPO_GRAPH_MARK)) return 'on';
  return 'unset';
}

export function repoGraphMarkEnabled(mcpServers: readonly string[], defaultOn: boolean): boolean {
  const mark = repoGraphMarkOf(mcpServers);
  return mark === 'unset' ? defaultOn : mark === 'on';
}

export function userMcpServersWithoutMarks(mcpServers: readonly string[]): string[] {
  return mcpServers.filter((id) => !isRepoGraphMark(id));
}
