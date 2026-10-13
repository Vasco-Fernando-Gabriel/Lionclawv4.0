export const SWARM_GENERIC_ROLE_IDS = [
  'swarm-explorer',
  'swarm-auditor',
  'swarm-doc-validator',
  'swarm-researcher',
] as const;
const GENERIC_ROLE_SET: ReadonlySet<string> = new Set(SWARM_GENERIC_ROLE_IDS);
export function isSwarmGenericRole(agentId: string): boolean {
  return GENERIC_ROLE_SET.has(agentId);
}
