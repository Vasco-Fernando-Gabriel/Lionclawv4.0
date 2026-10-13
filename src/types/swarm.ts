export type SwarmRuntime = 'cloud' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | 'local' | 'external';
export const SWARM_RUNTIMES: readonly SwarmRuntime[] = [
  'cloud',
  'codex',
  'zai',
  'minimax-tp',
  'kimi',
  'grok',
  'cursor',
  'local',
  'external',
];
export type SwarmReadConfinement = 'confined' | 'free';
export type SwarmGuaranteeState = 'negada' | 'permitida' | 'sandbox';
export interface SwarmRuntimeCapability {
  runtime: SwarmRuntime;
  read: SwarmReadConfinement;
  readLabel: 'leitura confinada' | 'leitura livre';
  write: SwarmGuaranteeState;
  shell: SwarmGuaranteeState;
  web: SwarmGuaranteeState;
  continuation: SwarmContinuationMode;
  continuationLabel: 'retomada de sessao' | 'reenvio de historico';
  mechanism: string;
  provedBy: string;
}
export type SwarmMember =
  | { kind: 'registered'; agentId: string }
  | {
      kind: 'ephemeral';
      runtime: SwarmRuntime;
      model: string;
      rolePrompt: string;
      allowedTools: string[];
      providerProfileId?: string;
    };
export interface SwarmBriefing {
  lens?: string;
  questions?: string[];
  evidenceRule?: string;
  avoid?: string;
  deliverableHint?: string;
}
export type SwarmStartInput = {
  requestId: string;
  cwd: string;
  objective: string;
  knownContext?: string;
  parentRunId?: string;
  stage?: string;
} & (
  | ({ mode: 'fanout'; promptTemplate: string; member: SwarmMember; items: Array<{ target: string }> } & SwarmBriefing)
  | {
      mode: 'comite';
      target: string;
      members: Array<{ slug: string; objective: string; member: SwarmMember } & SwarmBriefing>;
    }
);
export type SwarmRedispatchBriefing = { objective: string; knownContext?: string } & SwarmBriefing;
export interface SwarmSettings {
  concurrencyCap: number;
  maxAttempts: number;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  openWindowMs: number;
}
export const DEFAULT_SWARM_SETTINGS: Readonly<SwarmSettings> = {
  concurrencyCap: 5,
  maxAttempts: 2,
  idleTimeoutMs: 20 * 60_000,
  hardTimeoutMs: 2 * 60 * 60_000,
  openWindowMs: 30 * 60_000,
};
export type SwarmRunStatus = 'queued' | 'running' | 'open' | 'aborting' | 'done' | 'partial' | 'failed' | 'aborted';
export type SwarmItemStatus =
  'pending' | 'running' | 'stopping' | 'waiting' | 'retrying' | 'ok' | 'failed' | 'cancelled';
export type SwarmOutcome =
  | 'ok'
  | 'needs-input'
  | 'timeout-idle'
  | 'timeout-hard'
  | 'provider-error'
  | 'crash'
  | 'bad-trailer'
  | 'invalid-findings'
  | 'task-failed'
  | 'context-overflow'
  | 'cancelled'
  | 'interrupted'
  | 'auth-required'
  | 'unsupported-capability';
export type SwarmExecutionKind = 'initial' | 'retry' | 'continuation' | 'redispatch' | 'repair';
export type SwarmContinuationMechanism = 'resend' | 'session';
export type SwarmContinuationMode = 'session' | 'replay';
export interface SwarmSessionRef {
  runtime: SwarmRuntime;
  id: string;
  attemptId: string;
  generation: number;
}
export interface SwarmError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface SwarmMetrics {
  costUsd: number | null;
  costStatus: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  durationMs?: number;
  costStatusReasons?: readonly string[];
}
export type SwarmRepoGraphState = 'ready' | 'stale' | 'no-repository' | 'off';
export interface SwarmLiveMetrics {
  attemptId: string;
  turns: number;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface SwarmAttempt {
  id: string;
  n: number;
  startedAt: string;
  endedAt: string | null;
  outcome: SwarmOutcome | null;
  error: SwarmError | null;
  terminationConfirmedAt: string | null;
  outputFile: string;
  findingsFile: string;
  validatedContentHash: string | null;
  metrics: SwarmMetrics;
  repoGraph?: boolean;
}
export interface SwarmExecution {
  attemptId: string;
  kind: SwarmExecutionKind;
  generation: number;
  mechanism: SwarmContinuationMechanism | null;
  continuationMode: SwarmContinuationMode | null;
  continuationReason: string | null;
  messageId: string | null;
  reason: string | null;
  question: string | null;
  questionRevision: number | null;
}
export interface SwarmQueuedMessage {
  id: string;
  message: string;
  attemptId: string | null;
  createdAt: string;
}
export interface SwarmLaunchPlan {
  kind: 'continuation' | 'redispatch' | 'repair';
  messageId: string | null;
  promptFile: string | null;
  mode: SwarmContinuationMode | null;
  fallbackPromptFile: string | null;
  reason: string | null;
}
export interface SwarmMessageRecord {
  id: string;
  kind: 'message' | 'answer' | 'redispatch' | 'response' | 'discarded';
  attemptId: string | null;
  at: string;
  text: string;
  mechanism?: SwarmContinuationMechanism;
  costUsd?: number | null;
  cuts?: string[];
}
export interface SwarmItem {
  slug: string;
  target: string;
  prompt: string;
  member: SwarmMember;
  runtime: SwarmRuntime;
  model: string;
  resolvedConfigFile: string;
  status: SwarmItemStatus;
  currentAttemptId: string | null;
  nextAttemptAt: string | null;
  attempts: SwarmAttempt[];
  executions: SwarmExecution[];
  generation: number;
  autoRetries: number;
  question: string | null;
  inbox: SwarmQueuedMessage[];
  launch: SwarmLaunchPlan | null;
  session: SwarmSessionRef | null;
  sessionLostReason: string | null;
  repoGraph?: SwarmRepoGraphState;
  targetWarning?: string | null;
  live?: SwarmLiveMetrics;
  findingsFile: string | null;
  summary: string | null;
  lastSignalAt: string | null;
  error: SwarmError | null;
}
export type SwarmDeliveryKind = 'terminal' | 'question';
export type SwarmDeliveryState =
  'pending' | 'reserved-by-wait' | 'claimed' | 'consumed-by-turn' | 'delivered' | 'undeliverable';
export interface SwarmDeliveryRef {
  runId: string;
  kind: SwarmDeliveryKind;
  revision: number;
  slug?: string;
  attemptId?: string;
  claimId: string;
}
export interface SwarmDeliveryError {
  kind: SwarmDeliveryKind;
  revision: number;
  message: string;
  at: string;
}
export interface SwarmRun {
  delivery?: { status: SwarmDeliveryState | 'delivery-error'; error?: string | null };
  runtimeCapabilities?: SwarmRuntimeCapability[];
  schemaVersion: 1 | 2;
  revision: number;
  terminalRevision: number | null;
  runId: string;
  chatSessionId: string;
  requestId: string;
  requestHash: string;
  mode: 'fanout' | 'comite';
  cwd: string;
  objective: string;
  parentRunId: string | null;
  stage: string | null;
  status: SwarmRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  openedAt: string | null;
  deliveredSignatures: Record<string, string> | null;
  deliveryError?: SwarmDeliveryError | null;
  settings: SwarmSettings;
  items: SwarmItem[];
}
export interface SwarmRunSummary {
  runId: string;
  chatSessionId: string;
  revision: number;
  mode: 'fanout' | 'comite';
  status: SwarmRunStatus;
  itemCount: number;
  createdAt: string;
  finishedAt: string | null;
  costUsd: number | null;
  parentRunId?: string | null;
  stage?: string | null;
}
export interface SwarmCatalog {
  members: Array<{
    agentId: string;
    name: string;
    description: string;
    runtime: SwarmRuntime;
    model: string;
    generic: boolean;
    available: boolean;
    reason?: string;
  }>;
  profiles: Array<{ id: string; runtime: SwarmRuntime; model: string; available: boolean; reason?: string }>;
  runtimes: SwarmRuntimeCapability[];
}
export interface SwarmReadResult {
  runId: string;
  runStatus: SwarmRunStatus;
  slug: string;
  status: SwarmItemStatus;
  generation: number;
  attemptId: string | null;
  summary: string | null;
  question: string | null;
  partial: string | null;
  finalText: string | null;
  findings: string | null;
  findingsPath: string | null;
  truncated: boolean;
  continuation: { mode: SwarmContinuationMode; reason: string | null } | null;
  messages: SwarmMessageRecord[];
  error: SwarmError | null;
}
export interface SwarmWaitAgentResult {
  slug: string;
  status: SwarmItemStatus;
  summary: string | null;
  findingsPath: string | null;
  findings: string | null;
  truncated: boolean;
  error: SwarmError | null;
}
export type SwarmWaitResult =
  | {
      status: 'done';
      runId: string;
      runStatus: SwarmRunStatus;
      revision: number | null;
      deliveryScheduled: boolean;
      consumedBy: 'turn' | 'delivery' | null;
      results: SwarmWaitAgentResult[];
      progress: string;
    }
  | {
      status: 'question';
      runId: string;
      runStatus: SwarmRunStatus;
      slug: string;
      attemptId: string;
      question: string;
      progress: string;
    }
  | {
      status: 'pending';
      runId: string;
      runStatus: SwarmRunStatus;
      progress: string;
      running: string[];
      finished: string[];
    }
  | { status: 'cancelled'; runId: string; runStatus: SwarmRunStatus; progress: string; reason: string };
export type SwarmFindingsOperation =
  | { operation: 'begin'; uploadId: string }
  | { operation: 'chunk'; uploadId: string; seq: number; content: string }
  | { operation: 'finalize'; uploadId: string; chunkCount: number; sha256: string };
export interface SwarmFindingsAck {
  uploadId: string;
  nextSeq: number;
  sha256: string;
  findingsFile?: string;
}
export type SwarmResult<T> = T | { error: string; code: string };
export interface SwarmAPI {
  openFindings: (sessionId: string, runId: string, slug: string) => Promise<SwarmResult<{ opened: true }>>;
  start: (sessionId: string, input: SwarmStartInput) => Promise<SwarmResult<{ runId: string; status: SwarmRunStatus }>>;
  abort: (sessionId: string, runId: string) => Promise<SwarmResult<SwarmRun>>;
  stopAgent: (
    sessionId: string,
    runId: string,
    slug: string,
  ) => Promise<SwarmResult<{ changed: boolean; status: SwarmItemStatus }>>;
  getMessages: (
    sessionId: string,
    runId: string,
    slug: string,
  ) => Promise<SwarmResult<{ runId: string; slug: string; messages: SwarmMessageRecord[] }>>;
  getRunState: (sessionId: string, runId: string) => Promise<SwarmResult<SwarmRun>>;
  listRuns: (
    sessionId: string,
    cursor?: string,
    limit?: number,
  ) => Promise<SwarmResult<{ runs: SwarmRunSummary[]; nextCursor: string | null }>>;
  getCatalog: (sessionId: string) => Promise<SwarmResult<SwarmCatalog>>;
  getSettings: () => Promise<SwarmResult<SwarmSettings>>;
  setSettings: (settings: SwarmSettings) => Promise<SwarmResult<SwarmSettings>>;
  onStream: (callback: (event: { runId: string; chatSessionId: string; revision: number }) => void) => () => void;
}
