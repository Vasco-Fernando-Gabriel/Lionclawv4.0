import { swarmExplorer } from './swarm-explorer';
export { swarmExplorer } from './swarm-explorer';
import { swarmAuditor } from './swarm-auditor';
export { swarmAuditor } from './swarm-auditor';
import { swarmDocValidator } from './swarm-doc-validator';
export { swarmDocValidator } from './swarm-doc-validator';
import { swarmResearcher } from './swarm-researcher';
export { swarmResearcher } from './swarm-researcher';
import { swarmSecretsScanner } from './swarm-secrets-scanner';
export { swarmSecretsScanner } from './swarm-secrets-scanner';
import { swarmAuthAuditor } from './swarm-auth-auditor';
export { swarmAuthAuditor } from './swarm-auth-auditor';
import { swarmOwaspScanner } from './swarm-owasp-scanner';
export { swarmOwaspScanner } from './swarm-owasp-scanner';
import { swarmIsolationInspector } from './swarm-isolation-inspector';
export { swarmIsolationInspector } from './swarm-isolation-inspector';
import { swarmSpecCoverageValidator } from './swarm-spec-coverage-validator';
export { swarmSpecCoverageValidator } from './swarm-spec-coverage-validator';
import { swarmDocDriftDetector } from './swarm-doc-drift-detector';
export { swarmDocDriftDetector } from './swarm-doc-drift-detector';
import { swarmContractChecker } from './swarm-contract-checker';
export { swarmContractChecker } from './swarm-contract-checker';
import { swarmTestCoverageAnalyst } from './swarm-test-coverage-analyst';
export { swarmTestCoverageAnalyst } from './swarm-test-coverage-analyst';
import { swarmWebResearcher } from './swarm-web-researcher';
export { swarmWebResearcher } from './swarm-web-researcher';
import { swarmCodeExplorer } from './swarm-code-explorer';
export { swarmCodeExplorer } from './swarm-code-explorer';
import { swarmBugHypothesisHunter } from './swarm-bug-hypothesis-hunter';
export { swarmBugHypothesisHunter } from './swarm-bug-hypothesis-hunter';

export const SWARM_GENERIC_SEED_AGENTS = [swarmExplorer, swarmAuditor, swarmDocValidator, swarmResearcher] as const;
export const SWARM_SPECIALIZED_SEED_AGENTS = [
  swarmSecretsScanner,
  swarmAuthAuditor,
  swarmOwaspScanner,
  swarmIsolationInspector,
  swarmSpecCoverageValidator,
  swarmDocDriftDetector,
  swarmContractChecker,
  swarmTestCoverageAnalyst,
  swarmWebResearcher,
  swarmCodeExplorer,
  swarmBugHypothesisHunter,
] as const;
export const SWARM_SEED_AGENTS = [...SWARM_GENERIC_SEED_AGENTS, ...SWARM_SPECIALIZED_SEED_AGENTS] as const;
export const SWARM_AGENT_IDS = SWARM_SEED_AGENTS.map((seed) => seed.id);
export const SWARM_GENERIC_AGENT_IDS = SWARM_GENERIC_SEED_AGENTS.map((seed) => seed.id);
export const SWARM_SPECIALIZED_AGENT_IDS = SWARM_SPECIALIZED_SEED_AGENTS.map((seed) => seed.id);
