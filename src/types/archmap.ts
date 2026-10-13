import type { OrchestratorProvider, OrchestratorRuntime, SessionOrchestrator } from './index';

export type ArchmapStatus = 'absent' | 'queued' | 'building' | 'ready' | 'stale' | 'partial' | 'error';

export type ArchmapRunKind = 'build' | 'update';

export type ArchmapRunStatus = 'running' | 'done' | 'error' | 'cancelled';

export type ArchmapUpdateAction = 'SKIP' | 'PARTIAL_UPDATE' | 'ARCHITECTURE_UPDATE' | 'FULL_UPDATE';

export type ArchmapFullReason =
  'indexed_commit_missing' | 'meta_invalid' | 'no_git' | 'graph_invalid' | 'too_many_changes';

export type ArchmapUpdateTrigger = 'structural_ratio' | 'top_directory' | 'manifest' | 'hub';

export interface ArchmapUpdatePreview {
  action: ArchmapUpdateAction;
  reason?: ArchmapFullReason;
  detail: string;
  totalFiles: number;
  structuralCount: number;
  structuralRatio: number;
  threshold: number;
  filesToReanalyze: number;
  newFiles: number;
  deletedFiles: number;
  cosmeticFiles: number;
  nonStructuralFiles: number;
  pendingFiles: number;
  manifestFiles: string[];
  hubFiles: string[];
  triggers: ArchmapUpdateTrigger[];
  rerunLayers: boolean;
  rerunTour: boolean;
  legacy: boolean;
}

export interface ArchmapConfirmFullPayload {
  action: 'FULL_UPDATE';
  reason: ArchmapFullReason;
  preview: ArchmapUpdatePreview;
  fileCount: number;
  batchCount: number;
  estimatedMinutes: number;
}

export type ArchmapFreshnessStatus = 'fresh' | 'dirty' | 'stale' | 'partial' | 'unknown';

export type ArchmapFreshnessLabel = 'pronto' | 'desatualizado' | 'parcial' | 'desconhecido';

export interface ArchmapFreshness {
  status: ArchmapFreshnessStatus;
  label: ArchmapFreshnessLabel;
  reason: string;
  graphCommitHash?: string;
  headCommitHash?: string;
  changedFileCount: number;
  changedFiles: string[];
  commitsBehind: number;
  commitsAhead: number;
  relation?: 'behind' | 'ahead' | 'diverged';
  localChanges: boolean;
  pendingFiles: number;
  lastAnalyzedAt?: string;
}

export type ArchmapPhase =
  'scan' | 'triage' | 'narrative' | 'extraction' | 'analysis' | 'merge' | 'review' | 'layers' | 'tour' | 'finalize';

export const ARCHMAP_PHASE_LABELS: Record<ArchmapPhase, string> = {
  scan: 'scan',
  triage: 'triagem Jev',
  narrative: 'narrativa',
  extraction: 'extracao',
  analysis: 'analise',
  merge: 'merge',
  review: 'revisao',
  layers: 'camadas',
  tour: 'tour',
  finalize: 'finalize',
};

export interface ArchmapProgress {
  phase: ArchmapPhase | string;
  detail?: string;
  succeeded?: number;
  failed?: number;
  reused?: number;
  lastError?: string;
  current?: number;
  total?: number;
}

export type ArchmapRuntimeId =
  'cloud' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | 'local' | 'external' | 'google-genai';

export const ARCHMAP_RUNTIME_IDS: readonly ArchmapRuntimeId[] = [
  'cloud',
  'codex',
  'zai',
  'minimax-tp',
  'kimi',
  'grok',
  'cursor',
  'local',
  'external',
  'google-genai',
];

export function archmapRuntimeForSelection(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): ArchmapRuntimeId | null {
  switch (`${runtime}|${provider}`) {
    case 'claude-sdk|anthropic':
      return 'cloud';
    case 'codex-sdk|codex':
    case 'codex-sdk|codex-official':
      return 'codex';
    case 'claude-compat-sdk|zai':
      return 'zai';
    case 'claude-compat-sdk|minimax':
      return 'minimax-tp';
    case 'kimi-sdk|kimi':
      return 'kimi';
    case 'grok-sdk|grok':
      return 'grok';
    case 'cursor-sdk|cursor':
      return 'cursor';
    case 'lion-sdk|ollama':
    case 'lion-sdk|lmstudio':
      return 'local';
    case 'lion-sdk|openai-compatible':
      return 'external';
    case 'lion-sdk|vertex-ai':
      return 'google-genai';
    default:
      return null;
  }
}

export interface ArchmapGenerationChoice {
  runtime: ArchmapRuntimeId;
  selection: SessionOrchestrator;
}

export interface ArchmapRunInfo {
  id: string;
  kind: ArchmapRunKind;
  status: ArchmapRunStatus;
  startedAt: string;
  runtime: string;
  provider: string;
  model: string;
  progress?: ArchmapProgress;
  llmCalls?: number;
  llmMs?: number;
  action?: ArchmapUpdateAction;
  reason?: ArchmapFullReason;
  error?: string | null;
  warnings?: string[];
  jevAsked?: number;
  jevDispensed?: number;
  jevCostUsd?: number;
  jevFallbackReason?: string;
}

export interface ArchmapStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  layerCount: number;
}

export interface ArchmapStatusResponse {
  status: ArchmapStatus;
  error?: string;
  queuePosition?: number;
  indexedCommit: string | null;
  lastIndexedAt: string | null;
  changedFileCount?: number;
  pendingFiles?: number;
  stats?: ArchmapStats;
  run?: ArchmapRunInfo;
  lastRun?: ArchmapRunInfo;
  generation?: string;
  layersStale?: boolean;
  tourStale?: boolean;
  fallback?: string[];
  freshness?: ArchmapFreshness;
  legacy?: boolean;
}

export interface ArchmapErrorPayload {
  error: string;
  code?: string;
  details?: unknown;
}

export type ArchmapEstimateMode = 'build' | 'update';

export interface ArchmapEstimateRequest {
  repositoryId: string;
  selection?: SessionOrchestrator | null;
  mode?: ArchmapEstimateMode;
}

export interface ArchmapEstimateResponse {
  fileCount: number;
  batchCount: number;
  estimatedMinutes: number;
  filteredByIgnore: number;
  warnings: string[];
  runtime: ArchmapRuntimeId | null;
  provider: string | null;
  model: string | null;
  elapsedMs: number;
  update?: ArchmapUpdatePreview;
  jevTriageEnabled?: boolean;
}

export interface ArchmapCancelResponse {
  cancelled: boolean;
  reason?: string;
}

export interface ArchmapBuildRequest {
  repositoryId: string;
  selection: SessionOrchestrator;
}

export interface ArchmapUpdateRequest extends ArchmapBuildRequest {
  confirmFull?: boolean;
}

export interface ArchmapFileRequest {
  repositoryId: string;
  path: string;
}

export interface ArchmapFileResponse {
  path: string;
  content: string;
  language: string;
}

export interface ArchmapMetaResponse {
  lastAnalyzedAt: string;
  gitCommitHash: string;
  version: string;
  analyzedFiles: number;
  runtime?: string;
  provider?: string;
  model?: string;
  lionClawVersion?: string;
  partial?: boolean;
  pendingFiles?: string[];
  changedDuringRun?: string[];
  layersStale?: boolean;
  tourStale?: boolean;
  fallback?: string[];
  migratedFrom?: string;
  action?: ArchmapUpdateAction;
}

export interface ArchmapStatusEvent {
  repositoryId: string;
  status?: ArchmapStatus;
  run?: { id?: string; kind: ArchmapRunKind; status: ArchmapRunStatus };
  progress?: ArchmapProgress;
}

export type ArchmapReadConfinement = 'confined' | 'free';

export type ArchmapGuaranteeState = 'provado' | 'nao_provado' | 'negado';

export type ArchmapGuaranteeName = 'write' | 'shell' | 'network' | 'webTools';

export const ARCHMAP_GUARANTEE_NAMES: readonly ArchmapGuaranteeName[] = ['write', 'shell', 'network', 'webTools'];

export interface ArchmapGuarantee {
  state: ArchmapGuaranteeState;
  reason: string;
}

export interface ArchmapRuntimeCapability {
  runtime: ArchmapRuntimeId;
  mechanism: string;
  guarantees: Record<ArchmapGuaranteeName, ArchmapGuarantee>;
  read: ArchmapReadConfinement;
  readLabel: 'leitura confinada' | 'leitura livre';
}

export type ArchmapGuaranteeLabel = 'garantia provada' | 'garantia pendente' | 'garantia negada';

export interface ArchmapAPI {
  status: (repositoryId: string) => Promise<ArchmapStatusResponse | { error: string }>;
  estimate: (request: ArchmapEstimateRequest) => Promise<ArchmapEstimateResponse | { error: string }>;
  cancel: (repositoryId: string) => Promise<ArchmapCancelResponse | { error: string }>;
  build: (request: ArchmapBuildRequest) => Promise<ArchmapRunInfo | ArchmapErrorPayload>;
  update: (request: ArchmapUpdateRequest) => Promise<ArchmapRunInfo | ArchmapErrorPayload>;
  graph: (repositoryId: string) => Promise<unknown | { error: string }>;
  meta: (repositoryId: string) => Promise<ArchmapMetaResponse | { error: string }>;
  file: (request: ArchmapFileRequest) => Promise<ArchmapFileResponse | { error: string }>;
  runs: (repositoryId: string) => Promise<ArchmapRunInfo[] | { error: string }>;
  freshness: (repositoryId: string) => Promise<ArchmapFreshness | { error: string }>;
  runtimeCapabilities: () => Promise<ArchmapRuntimeCapability[] | { error: string }>;
  onStatus: (cb: (event: ArchmapStatusEvent) => void) => () => void;
}

declare module './index' {
  interface LionClawAPI {
    archmap: ArchmapAPI;
  }
}
