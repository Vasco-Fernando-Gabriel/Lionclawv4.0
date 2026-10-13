export type SwarmCodexShield = 'none' | 'protected' | 'pinned';
export interface SwarmCodexScope {
  runId: string;
  slug: string;
  generation: number;
}
export const SWARM_CODEX_SESSION_CAP_EXTRA = 2;
export const SWARM_CODEX_DEFAULT_CONCURRENCY_CAP = 5;
const guarded = new Map<string, { pinned: boolean }>();
let sessionCap = SWARM_CODEX_DEFAULT_CONCURRENCY_CAP + SWARM_CODEX_SESSION_CAP_EXTRA;
export function swarmCodexOwnerId(scope: SwarmCodexScope): string {
  return `${scope.runId}/${scope.slug}/${scope.generation}`;
}
export function protectSwarmCodexScope(ownerId: string): void {
  if (!guarded.has(ownerId)) guarded.set(ownerId, { pinned: false });
}
export function pinSwarmCodexScope(ownerId: string, pinned: boolean): void {
  const entry = guarded.get(ownerId);
  if (entry) entry.pinned = pinned;
}
export function releaseSwarmCodexScope(ownerId: string): void {
  guarded.delete(ownerId);
}
export function swarmCodexShield(ownerId: string | undefined): SwarmCodexShield {
  const entry = ownerId ? guarded.get(ownerId) : undefined;
  if (!entry) return 'none';
  return entry.pinned ? 'pinned' : 'protected';
}
export function configureSwarmCodexSessionCap(concurrencyCap: number): number {
  const cap =
    Number.isInteger(concurrencyCap) && concurrencyCap >= 1 ? concurrencyCap : SWARM_CODEX_DEFAULT_CONCURRENCY_CAP;
  sessionCap = cap + SWARM_CODEX_SESSION_CAP_EXTRA;
  return sessionCap;
}
export function swarmCodexSessionCap(): number {
  return sessionCap;
}
export function __resetSwarmCodexGuardForTests(): void {
  guarded.clear();
  sessionCap = SWARM_CODEX_DEFAULT_CONCURRENCY_CAP + SWARM_CODEX_SESSION_CAP_EXTRA;
}
