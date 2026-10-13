import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ArchmapCancelResponse,
  ArchmapEstimateMode,
  ArchmapEstimateResponse,
  ArchmapFileResponse,
  ArchmapFreshness,
  ArchmapFullReason,
  ArchmapMetaResponse,
  ArchmapProgress,
  ArchmapRunInfo,
  ArchmapRunKind,
  ArchmapRunStatus,
  ArchmapStats,
  ArchmapStatus,
  ArchmapStatusEvent,
  ArchmapStatusResponse,
  ArchmapUpdateAction,
} from '../../../src/types/archmap';
import { archmapRuntimeForSelection } from '../../../src/types/archmap';
import type { SessionOrchestrator } from '../../../src/types';
import type { LocalRepositoryRecord } from '../../../src/types/repo-graph';
import { createLogger } from '../logger';
import { getLionClawHome } from '../paths';
import type { askJev } from '../jev-client';
import { JEV_API_KEY_VAULT_KEY, JEV_MODEL_SETTING_KEY, resolveJevModel } from '../jev-settings';
import type { getSecretNonInteractive } from '../secrets-vault';
import type { ArchmapAgentCall, ArchmapAgentExecutor } from './agent-executor';
import {
  ArchmapAbsentError,
  ArchmapBusyError,
  ArchmapCancelledError,
  ArchmapConfirmFullError,
  ArchmapDisabledError,
  ArchmapEmptyError,
  ArchmapFileError,
  ArchmapGitTimeoutError,
  ArchmapGraphTooLargeError,
  ArchmapRepositoryNotFoundError,
  ArchmapRunCreateError,
  ArchmapTimeoutError,
  ArchmapTooLargeError,
} from './errors';
import { detectFileLanguage } from './file-language';
import { createArchmapFreshnessService, type ArchmapFreshnessService } from './freshness';
import { preflightArchmapDir, readGeneration, type ArchmapGeneration, type PreflightResult } from './generation';
import { GitTimeoutError, gitCommitExists, gitHead, runGit, type GitRunner } from './git';
import { ensureArchmapGitignore } from './gitignore';
import { migrateLegacyArchmap, readBaselineDir, reconstructBaseline } from './legacy';
import { hubPaths, prepareUpdate, previewOf, tsconfigManifestPaths, type PrepareResult } from './pipeline/prepare';
import type { ArchmapRepository, ArchmapRunRecord } from './repository';
import { readArchmapSettings, type ArchmapSettings } from './settings';
import {
  createCheckpointStore,
  pathsIdentity,
  type CheckpointStore,
  type GenerationConfig,
} from './pipeline/checkpoints';
import {
  startRun,
  type IncrementalRunInput,
  type LlmCounters,
  type LlmTimeouts,
  type RunHandle,
  type RunJobResult,
} from './pipeline/run';
import {
  applyJevTriageToPlan,
  describeJevTriage,
  jevTriageApplies,
  jevTriageCandidates,
  runJevTriage,
  type JevTriageResult,
} from './pipeline/jev-triage';
import { readGitBlob, readJevSource } from './pipeline/jev-sources';
import { normalizeRelativePath } from './pipeline/node-path';
import { createPipelineWorker, type PipelineWorker } from './pipeline/worker-client';
import { ARCHMAP_SCHEMA_VERSION, type BatchPlan, type ScanResult } from './pipeline/types';
import type { FileFingerprint } from './core';
import {
  ARCHMAP_GRAPH_MAX_BYTES,
  archmapDirPath,
  createArchmapStateReader,
  type ArchmapDiskState,
  type ArchmapStateReader,
} from './state';

const logger = createLogger('archmap');

export const ARCHMAP_MAX_FILES = 3000;
export const ARCHMAP_REQUEST_TIMEOUT_MS = 180_000;
export const ARCHMAP_EMIT_THROTTLE_MS = 2000;
export const ARCHMAP_SCRATCH_DIR_NAME = 'archmap-scratch';
export const ARCHMAP_JOB_MIN_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const ARCHMAP_JOB_PER_BATCH_MS = 480_000;
export const ARCHMAP_WARNINGS_CAP = 100;
export const ARCHMAP_FILE_MAX_BYTES = 1024 * 1024;
export const ARCHMAP_BATCH_SIZE_ESTIMATE = 35;
const BINARY_PROBE_BYTES = 8 * 1024;

const SECURITY_EXCLUDED = [
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_rsa[^/]*$/,
  /(^|\/)id_ed25519[^/]*$/,
  /(^|\/)\.(npmrc|pypirc|netrc)$/,
  /credentials[^/]*\.json$/i,
  /(^|\/)\.(aws|ssh)\//,
];

export function isSecurityExcludedPath(relPath: string): boolean {
  return SECURITY_EXCLUDED.some((pattern) => pattern.test(relPath));
}

export function archmapScratchRoot(home: string = getLionClawHome()): string {
  return join(home, ARCHMAP_SCRATCH_DIR_NAME);
}

export function estimateMinutes(batchCount: number, batchParallelism: number): number {
  const parallel = Math.max(1, batchParallelism);
  return Math.ceil((batchCount * 2.5) / parallel) + 2;
}

export function jobTimeoutMs(
  batchCount: number,
  batchParallelism: number,
  minMs = ARCHMAP_JOB_MIN_TIMEOUT_MS,
  perBatchMs = ARCHMAP_JOB_PER_BATCH_MS,
): number {
  return Math.max(minMs, Math.ceil((batchCount * perBatchMs) / Math.max(1, batchParallelism)));
}

export function capWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= ARCHMAP_WARNINGS_CAP) return [...warnings];
  return [...warnings.slice(0, ARCHMAP_WARNINGS_CAP), `e mais ${warnings.length - ARCHMAP_WARNINGS_CAP}`];
}

export interface ArchmapEngineTimeouts {
  requestMs?: number;
  jobMinMs?: number;
  jobPerBatchMs?: number;
  llm?: Partial<LlmTimeouts>;
}

export type ArchmapExecutorFactory = (
  selection: SessionOrchestrator,
  onCall: (call: ArchmapAgentCall) => void,
) => ArchmapAgentExecutor | Promise<ArchmapAgentExecutor>;

export interface ArchmapJevTriageDeps {
  ask: typeof askJev;
  readApiKey: () => ReturnType<typeof getSecretNonInteractive>;
  readModel: () => string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  deadlineMs?: number;
  parallel?: number;
  retryDelayMs?: (attempt: number) => number;
}

export interface ArchmapJevOutcome {
  asked: number;
  dispensed: number;
  costUsd: number;
  fallbackReason: string | null;
}

export interface ArchmapEngineDeps {
  repository: ArchmapRepository;
  getLocalRepository: (id: string) => LocalRepositoryRecord | null;
  getSetting: (key: string) => string | undefined;
  emit?: (event: ArchmapStatusEvent) => void;
  createWorker?: () => PipelineWorker;
  createExecutor?: ArchmapExecutorFactory;
  createCheckpoints?: (archmapDir: string) => CheckpointStore;
  stateReader?: ArchmapStateReader;
  freshness?: ArchmapFreshnessService;
  requestTimeoutMs?: number;
  emitThrottleMs?: number;
  git?: GitRunner;
  scratchRoot?: string;
  lionClawVersion?: string;
  timeouts?: ArchmapEngineTimeouts;
  jevTriage?: Partial<ArchmapJevTriageDeps>;
}

export interface ArchmapPreflightOutcome extends PreflightResult {
  gitignoreChanged: boolean;
  gitignoreError: string | null;
  head0: string;
}

export interface ArchmapScanOutcome {
  scan: ScanResult;
  fingerprints: Record<string, FileFingerprint>;
  plan: BatchPlan;
  exportsByPath: Record<string, string[]>;
  scanStartedAt: string;
  warnings: string[];
  elapsedMs: number;
  planReused: boolean;
}

export interface ArchmapClassifiedUpdate {
  plan: PrepareResult;
  legacy: boolean;
  previousStats: ArchmapStats | null;
}

export interface ArchmapEngine {
  status(repositoryId: string): Promise<ArchmapStatusResponse>;
  freshness(repositoryId: string): Promise<ArchmapFreshness>;
  estimate(
    repositoryId: string,
    selection?: SessionOrchestrator | null,
    mode?: ArchmapEstimateMode,
  ): Promise<ArchmapEstimateResponse>;
  build(repositoryId: string, selection: SessionOrchestrator): Promise<ArchmapRunInfo>;
  update(repositoryId: string, selection: SessionOrchestrator, confirmFull?: boolean): Promise<ArchmapRunInfo>;
  graph(repositoryId: string): Promise<unknown>;
  meta(repositoryId: string): Promise<ArchmapMetaResponse>;
  file(repositoryId: string, rawPath: unknown): Promise<ArchmapFileResponse>;
  runs(repositoryId: string): ArchmapRunInfo[];
  cancel(repositoryId: string): ArchmapCancelResponse;
  hasActive(repositoryId: string): boolean;
  waitForJob(repositoryId: string): Promise<void>;
  preflight(repositoryId: string): Promise<ArchmapPreflightOutcome>;
  settings(): ArchmapSettings;
  reconcileBoot(): Promise<void>;
  shutdown(deadlineMs?: number): Promise<void>;
}

interface ActiveEstimate {
  kind: 'estimate';
  repositoryId: string;
  key: string;
  controller: AbortController;
  worker: PipelineWorker | null;
}

interface InternalJob {
  kind: ArchmapRunKind;
  runId: string;
  repositoryId: string;
  repoRoot: string;
  key: string;
  selection: SessionOrchestrator;
  config: GenerationConfig;
  status: 'preparing' | 'queued' | 'running';
  startedAt: string;
  startedAtMs: number;
  progress: ArchmapProgress | null;
  controller: AbortController;
  worker: PipelineWorker;
  executor: ArchmapAgentExecutor;
  scratchDir: string;
  scan: ScanResult;
  fingerprints: Record<string, FileFingerprint>;
  plan: BatchPlan;
  planReused: boolean;
  head0: string;
  scanStartedAt: string;
  warnings: string[];
  previous: ArchmapGeneration | null;
  action: ArchmapUpdateAction | null;
  reason: ArchmapFullReason | null;
  incremental: IncrementalRunInput | null;
  llmCounters: LlmCounters;
  callErrors: string[];
  jev: ArchmapJevOutcome | null;
  handle: RunHandle | null;
  timer: NodeJS.Timeout | null;
  timeoutReason: string | null;
  finalized: boolean;
  completion: Promise<void> | null;
  batchParallelism: number;
  jevTriageEnabled: boolean;
}

type Reservation = ActiveEstimate | InternalJob;

function runInfo(run: ArchmapRunRecord, withWarnings: boolean): ArchmapRunInfo {
  const info: ArchmapRunInfo = {
    id: run.id,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt,
    runtime: run.runtime,
    provider: run.provider,
    model: run.model,
  };
  if (run.llmCalls > 0) info.llmCalls = run.llmCalls;
  if (run.llmMs > 0) info.llmMs = run.llmMs;
  if (run.action) info.action = run.action;
  if (run.reason) info.reason = run.reason;
  if (run.error !== null) info.error = run.error;
  if (run.jevAsked > 0) info.jevAsked = run.jevAsked;
  if (run.jevDispensed > 0) info.jevDispensed = run.jevDispensed;
  if (run.jevCostUsd > 0) info.jevCostUsd = run.jevCostUsd;
  if (run.jevFallbackReason) info.jevFallbackReason = run.jevFallbackReason;
  if (withWarnings) info.warnings = run.warnings;
  return info;
}

function jobRunInfo(job: InternalJob): ArchmapRunInfo {
  const info: ArchmapRunInfo = {
    id: job.runId,
    kind: job.kind,
    status: 'running',
    startedAt: job.startedAt,
    runtime: job.config.runtime,
    provider: job.config.provider,
    model: job.config.model,
  };
  if (job.progress) info.progress = job.progress;
  if (job.action) info.action = job.action;
  if (job.reason) info.reason = job.reason;
  return info;
}

function isJob(entry: Reservation): entry is InternalJob {
  return entry.kind !== 'estimate';
}

export function createArchmapEngine(deps: ArchmapEngineDeps): ArchmapEngine {
  const reader = deps.stateReader ?? createArchmapStateReader();
  const createWorker = deps.createWorker ?? (() => createPipelineWorker());
  const createCheckpoints = deps.createCheckpoints ?? ((dir: string) => createCheckpointStore(dir));
  const jevDeps: ArchmapJevTriageDeps = {
    ask: async (state, questions, opts) => (await import('../jev-client')).askJev(state, questions, opts),
    readApiKey: async () => (await import('../secrets-vault')).getSecretNonInteractive(JEV_API_KEY_VAULT_KEY),
    readModel: () => resolveJevModel(deps.getSetting(JEV_MODEL_SETTING_KEY)),
    ...deps.jevTriage,
  };
  const createExecutor: ArchmapExecutorFactory =
    deps.createExecutor ??
    (async (selection, onCall) => {
      const { createDefaultArchmapExecutor } = await import('./executor-factory');
      return createDefaultArchmapExecutor(selection, onCall);
    });
  const requestTimeoutMs = deps.requestTimeoutMs ?? deps.timeouts?.requestMs ?? ARCHMAP_REQUEST_TIMEOUT_MS;
  const emitThrottleMs = deps.emitThrottleMs ?? ARCHMAP_EMIT_THROTTLE_MS;
  const git = deps.git ?? runGit;
  const freshnessService = deps.freshness ?? createArchmapFreshnessService({ git });
  const scratchRoot = deps.scratchRoot ?? archmapScratchRoot();
  const lionClawVersion = deps.lionClawVersion ?? '0.0.0';
  const reservations = new Map<string, Reservation>();
  const estimatesByRepository = new Map<string, ActiveEstimate>();
  const jobsByRepository = new Map<string, InternalJob>();
  const queue: InternalJob[] = [];
  const emitThrottle = new Map<
    string,
    { lastAt: number; pending: NodeJS.Timeout | null; lastEvent: ArchmapStatusEvent }
  >();
  let inFlight = 0;
  let shuttingDown = false;

  function settings(): ArchmapSettings {
    return readArchmapSettings(deps.getSetting);
  }

  function emitStatus(event: ArchmapStatusEvent, force: boolean): void {
    if (!deps.emit) return;
    const entry = emitThrottle.get(event.repositoryId) ?? { lastAt: 0, pending: null, lastEvent: event };
    entry.lastEvent = event;
    const now = Date.now();
    if (force || now - entry.lastAt >= emitThrottleMs) {
      if (entry.pending) {
        clearTimeout(entry.pending);
        entry.pending = null;
      }
      entry.lastAt = now;
      emitThrottle.set(event.repositoryId, entry);
      deps.emit(event);
      return;
    }
    if (!entry.pending) {
      entry.pending = setTimeout(
        () => {
          entry.pending = null;
          entry.lastAt = Date.now();
          deps.emit?.(entry.lastEvent);
        },
        emitThrottleMs - (now - entry.lastAt),
      );
      entry.pending.unref?.();
    }
    emitThrottle.set(event.repositoryId, entry);
  }

  function requireRepository(repositoryId: string): LocalRepositoryRecord {
    const repo = deps.getLocalRepository(repositoryId);
    if (!repo) throw new ArchmapRepositoryNotFoundError(repositoryId);
    return repo;
  }

  function repositoryKey(repo: LocalRepositoryRecord): string {
    try {
      return realpathSync(repo.canonicalRootPath || repo.rootPath);
    } catch {
      return repo.canonicalRootPath || repo.rootPath;
    }
  }

  function reserve(repo: LocalRepositoryRecord, entry: Reservation): void {
    const what = isJob(entry) ? 'job' : 'estimate';
    if (shuttingDown) throw new ArchmapBusyError(repo.id, what);
    const existing = reservations.get(entry.key);
    if (existing) {
      throw new ArchmapBusyError(
        repo.id,
        isJob(existing) ? (existing.status === 'queued' ? 'queued' : 'job') : 'estimate',
      );
    }
    if (jobsByRepository.has(repo.id)) throw new ArchmapBusyError(repo.id, 'job');
    if (estimatesByRepository.has(repo.id)) throw new ArchmapBusyError(repo.id, 'estimate');
    reservations.set(entry.key, entry);
    if (isJob(entry)) jobsByRepository.set(repo.id, entry);
    else estimatesByRepository.set(repo.id, entry);
  }

  function release(entry: Reservation): void {
    if (reservations.get(entry.key) === entry) reservations.delete(entry.key);
    if (isJob(entry)) {
      if (jobsByRepository.get(entry.repositoryId) === entry) jobsByRepository.delete(entry.repositoryId);
    } else if (estimatesByRepository.get(entry.repositoryId) === entry) {
      estimatesByRepository.delete(entry.repositoryId);
    }
  }

  function syncCache(
    repositoryId: string,
    next: { indexedCommit: string | null; lastIndexedAt: string | null; stats: ArchmapStats | null },
  ): void {
    const state = deps.repository.getState(repositoryId);
    if (!state) return;
    const statsJson = next.stats ? JSON.stringify(next.stats) : null;
    if (
      state.indexedCommit === next.indexedCommit &&
      state.lastIndexedAt === next.lastIndexedAt &&
      state.statsJson === statsJson
    ) {
      return;
    }
    try {
      if (next.indexedCommit === null && next.lastIndexedAt === null && statsJson === null) {
        deps.repository.clearState(repositoryId);
      } else {
        deps.repository.setIndexed(repositoryId, {
          indexedCommit: next.indexedCommit,
          lastIndexedAt: next.lastIndexedAt,
          statsJson,
        });
      }
    } catch (error) {
      logger.warn({ repositoryId, err: error }, 'archmap: falha ao regravar o cache do repositorio');
    }
  }

  async function withRequestTimeout<T>(
    worker: PipelineWorker,
    controller: AbortController,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ArchmapTimeoutError(operation, requestTimeoutMs));
        controller.abort();
        void worker.terminate();
      }, requestTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function scanRepository(
    repo: LocalRepositoryRecord,
    worker: PipelineWorker,
    controller: AbortController,
    operation: string,
    options: { snapshotDir?: string; checkpoints?: CheckpointStore; onProgress?: (p: ArchmapProgress) => void } = {},
  ): Promise<ArchmapScanOutcome> {
    const startedMs = Date.now();
    const scanStartedAt = new Date(startedMs).toISOString();
    const warnings: string[] = [];
    return withRequestTimeout(worker, controller, operation, async () => {
      const scanned = await worker.scan(
        { projectPath: repo.rootPath, scanStartedAt, snapshotDir: options.snapshotDir },
        (current, total) => {
          const progress: ArchmapProgress = { phase: 'scan', current, total };
          options.onProgress?.(progress);
          emitStatus({ repositoryId: repo.id, progress }, false);
        },
      );
      if (controller.signal.aborted) throw new ArchmapCancelledError();
      warnings.push(...scanned.scan.warnings);
      if (scanned.scan.files.length === 0) throw new ArchmapEmptyError();
      if (scanned.scan.files.length > ARCHMAP_MAX_FILES) {
        throw new ArchmapTooLargeError(scanned.scan.files.length, ARCHMAP_MAX_FILES);
      }
      let plan: BatchPlan | null = null;
      let planReused = false;
      const identity = pathsIdentity(scanned.scan.files.map((file) => file.path));
      if (options.checkpoints) {
        plan = await options.checkpoints.readBatchPlan(identity);
        if (plan) planReused = true;
      }
      if (!plan) {
        plan = await worker.batches({ scan: scanned.scan, exportsByPath: scanned.exportsByPath });
        if (options.checkpoints) {
          await options.checkpoints.writeBatchPlan(identity, plan).catch((error: unknown) => {
            logger.warn({ repositoryId: repo.id, err: error }, 'archmap: plano de lotes nao gravado');
          });
        }
      }
      if (controller.signal.aborted) throw new ArchmapCancelledError();
      warnings.push(...plan.warnings);
      return {
        scan: scanned.scan,
        fingerprints: scanned.fingerprints,
        plan,
        exportsByPath: scanned.exportsByPath,
        scanStartedAt,
        warnings,
        elapsedMs: Date.now() - startedMs,
        planReused,
      };
    });
  }

  async function readDisk(repo: LocalRepositoryRecord): Promise<ArchmapDiskState> {
    return reader.read(repo.id, repo.rootPath);
  }

  async function headOrNull(repoRoot: string): Promise<{ head: string | null; timedOut: boolean }> {
    try {
      return { head: await gitHead(repoRoot, git), timedOut: false };
    } catch (error) {
      if (error instanceof GitTimeoutError) return { head: null, timedOut: true };
      return { head: null, timedOut: false };
    }
  }

  async function runPreflight(repo: LocalRepositoryRecord): Promise<ArchmapPreflightOutcome> {
    let gitignoreChanged = false;
    let gitignoreError: string | null = null;
    try {
      gitignoreChanged = (await ensureArchmapGitignore(repo.rootPath)).changed;
    } catch (error) {
      gitignoreError = error instanceof Error ? error.message : String(error);
      logger.warn({ repositoryId: repo.id, err: error }, 'archmap: .gitignore nao garantido no pre-voo');
    }
    const result = await preflightArchmapDir(repo.rootPath);
    const { head, timedOut } = await headOrNull(repo.rootPath);
    if (timedOut) throw new ArchmapGitTimeoutError('rev-parse HEAD no pre-voo');
    reader.clear(repo.id);
    freshnessService.invalidate(repo.id);
    return { ...result, gitignoreChanged, gitignoreError, head0: head ?? '' };
  }

  async function incrementalBatches(
    worker: PipelineWorker,
    controller: AbortController,
    scanned: ArchmapScanOutcome,
    paths: readonly string[],
  ): Promise<BatchPlan> {
    const wanted = new Set(paths);
    const empty: BatchPlan = {
      schemaVersion: ARCHMAP_SCHEMA_VERSION,
      algorithm: 'louvain',
      totalFiles: scanned.scan.files.length,
      totalBatches: 0,
      exportsByPath: scanned.exportsByPath,
      batches: [],
      warnings: [],
    };
    if (wanted.size === 0) return empty;
    const subScan: ScanResult = {
      ...scanned.scan,
      files: scanned.scan.files.filter((file) => wanted.has(file.path)),
      importMap: Object.fromEntries(Object.entries(scanned.scan.importMap).filter(([source]) => wanted.has(source))),
      warnings: [],
    };
    subScan.totalFiles = subScan.files.length;
    return withRequestTimeout(worker, controller, 'update', async () => {
      const plan = await worker.batches({ scan: subScan, exportsByPath: scanned.exportsByPath });
      if (controller.signal.aborted) throw new ArchmapCancelledError();
      return { ...plan, totalFiles: scanned.scan.files.length, exportsByPath: scanned.exportsByPath };
    });
  }

  function readTextFrom(dirs: readonly string[]): (path: string) => string | null {
    return (path) => {
      for (const dir of dirs) {
        try {
          return readFileSync(join(dir, path), 'utf8');
        } catch {}
      }
      return null;
    };
  }

  async function classifyUpdate(
    repo: LocalRepositoryRecord,
    scanned: ArchmapScanOutcome,
    head0: string,
    options: { snapshotDir?: string } = {},
  ): Promise<ArchmapClassifiedUpdate> {
    const disk = await readDisk(repo);
    const meta = disk.graph?.valid && disk.meta?.valid ? disk.meta.meta : null;
    const graphValid = disk.graph?.valid === true;
    const hasGit = head0.length > 0;
    let indexedCommitExists: boolean | null = null;
    if (hasGit && meta && meta.gitCommitHash.length > 0) {
      try {
        indexedCommitExists = await gitCommitExists(repo.rootPath, meta.gitCommitHash, git);
      } catch (error) {
        if (error instanceof GitTimeoutError) throw new ArchmapGitTimeoutError('cat-file do commit indexado');
        throw error;
      }
    }
    const baseline = disk.generationDir && graphValid ? await readBaselineDir(disk.generationDir) : null;
    const recon = baseline
      ? reconstructBaseline({
          graphPaths: baseline.inspection.paths,
          fingerprints: baseline.fingerprints,
          previousScan: baseline.scan,
          currentScan: scanned.scan,
          scanStartedAt: baseline.meta.lastAnalyzedAt,
        })
      : null;
    const sources = options.snapshotDir ? [options.snapshotDir, repo.rootPath] : [repo.rootPath];
    const manifestPaths = tsconfigManifestPaths(
      new Set([...scanned.scan.files.map((file) => file.path), ...(recon?.paths ?? [])]),
      readTextFrom(sources),
    );
    const plan = prepareUpdate({
      hasGit,
      metaValid: meta !== null,
      graphValid: graphValid && recon !== null,
      indexedCommitExists,
      previousPaths: recon?.paths ?? [],
      previousFingerprints: recon?.fingerprints ?? null,
      previousImportMap: recon?.scan.importMap ?? {},
      previousPending: [...(meta?.pendingFiles ?? []), ...(recon?.pending ?? [])],
      currentScan: scanned.scan,
      currentFingerprints: scanned.fingerprints,
      manifestPaths,
      legacy: disk.legacy,
    });
    return { plan, legacy: disk.legacy, previousStats: disk.graph?.stats ?? null };
  }

  async function triageWithJev(
    job: InternalJob,
    plan: PrepareResult,
    currentFingerprints: Record<string, FileFingerprint>,
    threshold: number,
  ): Promise<JevTriageResult> {
    const previous = job.previous!;
    const candidates = jevTriageCandidates({
      plan,
      previousNodes: previous.graph.nodes as Record<string, unknown>[],
      previousFingerprints: previous.fingerprints.files,
      currentFingerprints,
      hubPaths: hubPaths(
        previous.scan.importMap,
        previous.scan.files.map((file) => file.path),
      ),
    });
    const empty: JevTriageResult = {
      candidates: candidates.length,
      asked: 0,
      dispensed: [],
      reanalyze: [],
      verdicts: [],
      inputTokens: 0,
      costUsd: 0,
      requests: 0,
      wallMs: 0,
      fallbackReason: null,
      model: null,
    };
    if (candidates.length === 0) return empty;
    let secret: Awaited<ReturnType<typeof getSecretNonInteractive>>;
    try {
      secret = await jevDeps.readApiKey();
    } catch (error) {
      return {
        ...empty,
        fallbackReason: `chave do Jev ilegivel: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (secret.status === 'absent' || (secret.status === 'found' && secret.value.trim().length === 0)) {
      return { ...empty, fallbackReason: 'chave do Jev nao configurada no Vault' };
    }
    if (secret.status === 'error') return { ...empty, fallbackReason: `chave do Jev ilegivel: ${secret.reason}` };
    const snapshotDir = join(job.scratchDir, 'snapshot');
    const previousDir = previous.dir;
    const previousCommit = previous.meta.gitCommitHash;
    const emitTriage = (): void =>
      emitStatus(
        {
          repositoryId: job.repositoryId,
          status: 'building',
          run: { id: job.runId, kind: job.kind, status: 'running' },
          ...(job.progress ? { progress: job.progress } : {}),
        },
        false,
      );
    try {
      return await runJevTriage(candidates, {
        ask: jevDeps.ask,
        apiKey: secret.value,
        model: jevDeps.readModel(),
        threshold,
        signal: job.controller.signal,
        readOldContent: async (path, hash) =>
          (await readJevSource(previousDir, hash)) ?? readGitBlob(job.repoRoot, previousCommit, path, hash, git),
        readNewContent: async (path) => {
          try {
            return await readFile(join(snapshotDir, path), 'utf8');
          } catch {
            return null;
          }
        },
        ...(jevDeps.fetchImpl ? { fetchImpl: jevDeps.fetchImpl } : {}),
        ...(jevDeps.requestTimeoutMs !== undefined ? { requestTimeoutMs: jevDeps.requestTimeoutMs } : {}),
        ...(jevDeps.deadlineMs !== undefined ? { deadlineMs: jevDeps.deadlineMs } : {}),
        ...(jevDeps.parallel !== undefined ? { parallel: jevDeps.parallel } : {}),
        ...(jevDeps.retryDelayMs ? { retryDelayMs: jevDeps.retryDelayMs } : {}),
        onProgress: (done, total) => {
          job.progress = { phase: 'triage', current: done, total };
          emitTriage();
        },
      });
    } catch (error) {
      if (error instanceof ArchmapCancelledError || job.controller.signal.aborted) throw new ArchmapCancelledError();
      logger.warn({ runId: job.runId, err: error }, 'archmap: triagem Jev falhou; atualizacao segue sem triagem');
      return {
        ...empty,
        fallbackReason: `falha inesperada: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function makeScratch(runId: string): Promise<string> {
    const dir = join(scratchRoot, runId);
    await mkdir(join(dir, 'snapshot'), { recursive: true, mode: 0o700 });
    return dir;
  }

  async function removeScratch(dir: string): Promise<void> {
    if (!dir) return;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  function enqueue(job: InternalJob): ArchmapRunInfo {
    const maxParallel = settings().maxParallelRepos;
    if (inFlight < maxParallel) {
      const started = startJob(job);
      if (!started.ok) throw new ArchmapRunCreateError(job.repositoryId, started.cause);
    } else {
      job.status = 'queued';
      queue.push(job);
      emitStatus({ repositoryId: job.repositoryId, status: 'queued' }, true);
    }
    return jobRunInfo(job);
  }

  function dequeueNext(): void {
    const maxParallel = settings().maxParallelRepos;
    while (inFlight < maxParallel && queue.length > 0) {
      const next = queue.shift()!;
      startJob(next);
    }
  }

  function startJob(job: InternalJob): { ok: true } | { ok: false; cause: string } {
    inFlight += 1;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.startedAtMs = Date.now();
    try {
      deps.repository.createRun({
        id: job.runId,
        repositoryId: job.repositoryId,
        kind: job.kind,
        runtime: job.config.runtime,
        provider: job.config.provider,
        model: job.config.model,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      inFlight -= 1;
      release(job);
      void job.worker.terminate();
      void removeScratch(job.scratchDir);
      logger.warn({ repositoryId: job.repositoryId, error: cause }, 'archmap: falha ao criar o run');
      emitStatus({ repositoryId: job.repositoryId }, true);
      dequeueNext();
      return { ok: false, cause };
    }
    const total = jobTimeoutMs(
      job.plan.batches.length,
      job.batchParallelism,
      deps.timeouts?.jobMinMs,
      deps.timeouts?.jobPerBatchMs,
    );
    job.timer = setTimeout(() => {
      if (job.finalized) return;
      job.timeoutReason = `Geracao abortada: excedeu o teto total de ${Math.round(total / 60000)} minutos.`;
      job.controller.abort();
    }, total);
    job.timer.unref?.();
    logger.info(
      { repositoryId: job.repositoryId, runId: job.runId, kind: job.kind, batches: job.plan.batches.length },
      'archmap: rodada iniciada',
    );
    emitStatus(
      {
        repositoryId: job.repositoryId,
        status: 'building',
        run: { id: job.runId, kind: job.kind, status: 'running' },
      },
      true,
    );
    job.handle = startRun({
      repoRoot: job.repoRoot,
      runId: job.runId,
      kind: job.kind,
      action: job.action,
      scan: job.scan,
      fingerprints: job.fingerprints,
      plan: job.plan,
      head0: job.head0,
      scanStartedAt: job.scanStartedAt,
      generationConfig: job.config,
      lionClawVersion,
      worker: job.worker,
      executor: job.executor,
      scratchDir: job.scratchDir,
      snapshotDir: join(job.scratchDir, 'snapshot'),
      checkpoints: createCheckpoints(archmapDirPath(job.repoRoot)),
      previous: job.previous,
      incremental: job.incremental,
      jevTriage: { enabled: job.jevTriageEnabled },
      git,
      review: true,
      signal: job.controller.signal,
      logger,
      warnings: job.warnings,
      llmCounters: job.llmCounters,
      llmTimeoutsMs: deps.timeouts?.llm,
      batchParallelism: job.batchParallelism,
      onProgress: (progress) => {
        const newPhase = progress.phase !== job.progress?.phase;
        job.progress = { ...progress };
        emitStatus(
          {
            repositoryId: job.repositoryId,
            status: 'building',
            run: { id: job.runId, kind: job.kind, status: 'running' },
            progress: job.progress,
          },
          newPhase,
        );
      },
    });
    job.completion = job.handle.promise
      .then(
        (result) => finalizeJob(job, { ok: true, result }),
        (error: unknown) => finalizeJob(job, { ok: false, error }),
      )
      .catch((error: unknown) => {
        logger.warn({ repositoryId: job.repositoryId, runId: job.runId, err: error }, 'archmap: falha ao finalizar');
      });
    return { ok: true };
  }

  async function finalizeJob(
    job: InternalJob,
    outcome: { ok: true; result: RunJobResult } | { ok: false; error: unknown },
  ): Promise<void> {
    if (job.finalized) return;
    job.finalized = true;
    if (job.timer) clearTimeout(job.timer);
    const durationMs = Date.now() - job.startedAtMs;
    let runStatus: ArchmapRunStatus;
    let errorMessage: string | null = null;
    let warnings: readonly string[] = job.handle?.warnings ?? job.warnings;
    const llmCalls = job.llmCounters.calls;
    const llmMs = job.llmCounters.ms;
    if (outcome.ok) {
      warnings = outcome.result.warnings;
      runStatus = outcome.result.cancelled ? 'cancelled' : 'done';
      if (job.timeoutReason) {
        runStatus = 'error';
        errorMessage = job.timeoutReason;
      }
    } else {
      const cancelled =
        outcome.error instanceof ArchmapCancelledError ||
        (job.controller.signal.aborted && job.timeoutReason === null && !shuttingDown);
      if (job.timeoutReason) {
        runStatus = 'error';
        errorMessage = job.timeoutReason;
      } else if (shuttingDown && job.controller.signal.aborted) {
        runStatus = 'error';
        errorMessage = 'interrompido por encerramento';
      } else if (cancelled) {
        runStatus = 'cancelled';
      } else {
        runStatus = 'error';
        errorMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      }
    }
    try {
      deps.repository.finishRun(job.runId, {
        status: runStatus,
        action: job.action,
        reason: job.reason,
        llmCalls,
        llmMs,
        jevAsked: job.jev?.asked ?? 0,
        jevDispensed: job.jev?.dispensed ?? 0,
        jevCostUsd: job.jev?.costUsd ?? 0,
        jevFallbackReason: job.jev?.fallbackReason ?? null,
        warnings: capWarnings([...warnings, ...job.callErrors]),
        error: errorMessage,
        durationMs,
      });
      reader.clear(job.repositoryId);
      freshnessService.invalidate(job.repositoryId);
      if (outcome.ok) {
        deps.repository.setIndexed(job.repositoryId, {
          indexedCommit: job.head0.length > 0 ? job.head0 : null,
          lastIndexedAt: job.scanStartedAt,
          statsJson: JSON.stringify(outcome.result.stats),
        });
      }
    } catch (error) {
      logger.warn({ runId: job.runId, err: error }, 'archmap: falha ao persistir o desfecho da rodada');
    }
    await job.worker.terminate();
    await removeScratch(job.scratchDir);
    inFlight -= 1;
    release(job);
    logger.info(
      {
        repositoryId: job.repositoryId,
        runId: job.runId,
        kind: job.kind,
        status: runStatus,
        durationMs,
        llmCalls,
        partial: outcome.ok ? outcome.result.partial : null,
      },
      'archmap: rodada concluida',
    );
    emitStatus({ repositoryId: job.repositoryId, run: { id: job.runId, kind: job.kind, status: runStatus } }, true);
    dequeueNext();
  }

  async function startGeneration(
    repositoryId: string,
    selection: SessionOrchestrator,
    kind: ArchmapRunKind,
    confirmFull = false,
  ): Promise<ArchmapRunInfo> {
    const repo = requireRepository(repositoryId);
    const current = settings();
    if (!current.enabled) throw new ArchmapDisabledError();
    const runtime = archmapRuntimeForSelection(selection.runtime, selection.provider);
    if (!runtime) throw new Error(`Runtime fora do mapa: ${selection.runtime}/${selection.provider}`);
    const runId = randomUUID();
    const controller = new AbortController();
    const llmCounters: LlmCounters = { calls: 0, ms: 0 };
    const callErrors: string[] = [];
    const executor = await createExecutor(selection, (call) => {
      llmCounters.calls += 1;
      llmCounters.ms += call.durationMs;
      if (call.error) callErrors.push(`llm ${call.label} (tentativa ${call.attempt + 1}): ${call.error}`);
    });
    const worker = createWorker();
    const job: InternalJob = {
      kind,
      runId,
      repositoryId: repo.id,
      repoRoot: repo.rootPath,
      key: repositoryKey(repo),
      selection,
      config: {
        runtime,
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort ?? null,
      },
      status: 'preparing',
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      progress: { phase: 'scan' },
      controller,
      worker,
      executor,
      scratchDir: '',
      scan: null as unknown as ScanResult,
      fingerprints: {},
      plan: null as unknown as BatchPlan,
      planReused: false,
      head0: '',
      scanStartedAt: '',
      warnings: [],
      previous: null,
      action: null,
      reason: null,
      incremental: null,
      llmCounters,
      callErrors,
      jev: null,
      handle: null,
      timer: null,
      timeoutReason: null,
      finalized: false,
      completion: null,
      batchParallelism: current.batchParallelism,
      jevTriageEnabled: current.jevTriageEnabled,
    };
    try {
      reserve(repo, job);
    } catch (error) {
      void worker.terminate();
      throw error;
    }
    try {
      emitStatus({ repositoryId: repo.id, status: 'building', run: { id: runId, kind, status: 'running' } }, true);
      const preflight = await runPreflight(repo);
      if (preflight.gitignoreError)
        job.warnings.push(`pre-voo: .gitignore nao garantido (${preflight.gitignoreError})`);
      job.head0 = preflight.head0;
      job.scratchDir = await makeScratch(runId);
      const checkpoints = createCheckpoints(archmapDirPath(repo.rootPath));
      const scanned = await scanRepository(repo, worker, controller, kind, {
        snapshotDir: join(job.scratchDir, 'snapshot'),
        checkpoints,
        onProgress: (progress) => {
          job.progress = progress;
        },
      });
      if (controller.signal.aborted) throw new ArchmapCancelledError();
      job.scan = scanned.scan;
      job.fingerprints = scanned.fingerprints;
      job.plan = scanned.plan;
      job.planReused = scanned.planReused;
      job.scanStartedAt = scanned.scanStartedAt;
      job.warnings.push(...scanned.warnings);
      if (scanned.planReused) job.warnings.push('plano de lotes reaproveitado da tentativa anterior');
      const migrated = await migrateLegacyArchmap({
        repoRoot: repo.rootPath,
        currentScan: scanned.scan,
        scanStartedAt: scanned.scanStartedAt,
        lionClawVersion,
      });
      if (migrated) {
        reader.clear(repo.id);
        job.warnings.push(
          `mapa legado (.lioncode/archmap) migrado para ${migrated.generation}: ${migrated.paths} arquivo(s), ${migrated.pending.length} pendente(s)${migrated.reconstructedScan ? ', scan-result recomposto' : ''}`,
        );
      }
      if (kind === 'update') {
        const classified = await classifyUpdate(repo, scanned, job.head0, {
          snapshotDir: join(job.scratchDir, 'snapshot'),
        });
        if (controller.signal.aborted) throw new ArchmapCancelledError();
        const { plan } = classified;
        job.action = plan.action;
        job.reason = plan.reason ?? null;
        if (plan.action === 'FULL_UPDATE' && !confirmFull) {
          throw new ArchmapConfirmFullError({
            action: 'FULL_UPDATE',
            reason: plan.reason ?? 'graph_invalid',
            preview: previewOf(plan),
            fileCount: scanned.scan.files.length,
            batchCount: scanned.plan.batches.length,
            estimatedMinutes: estimateMinutes(scanned.plan.batches.length, current.batchParallelism),
          });
        }
        if (plan.action !== 'FULL_UPDATE') {
          job.previous = await readGeneration(repo.rootPath);
          if (!job.previous) throw new Error('geracao anterior ilegivel para a atualizacao incremental; use Regerar');
          let effective = plan;
          let keptPaths = new Set(plan.cosmeticPaths);
          let jevKeptPaths = new Set<string>();
          if (current.jevTriageEnabled && jevTriageApplies(plan.action)) {
            job.progress = { phase: 'triage' };
            emitStatus(
              {
                repositoryId: repo.id,
                status: 'building',
                run: { id: runId, kind, status: 'running' },
                progress: job.progress,
              },
              true,
            );
            const triage = await triageWithJev(job, plan, scanned.fingerprints, current.jevKeepThreshold);
            job.jev = {
              asked: triage.asked,
              dispensed: triage.dispensed.length,
              costUsd: triage.costUsd,
              fallbackReason: triage.fallbackReason,
            };
            job.warnings.push(...describeJevTriage(triage));
            const adjusted = applyJevTriageToPlan(plan, triage);
            effective = adjusted.plan;
            keptPaths = adjusted.keptPaths;
            jevKeptPaths = adjusted.jevKeptPaths;
          }
          job.plan = await incrementalBatches(worker, controller, scanned, effective.filesToReanalyzeList);
          job.warnings.push(...job.plan.warnings);
          job.incremental = { plan: effective, keptPaths, jevKeptPaths };
        }
      }
      if (!job.previous) job.previous = await readGeneration(repo.rootPath);
      if (job.incremental && !job.previous) {
        throw new Error('geracao anterior ilegivel para a atualizacao incremental; use Regerar');
      }
    } catch (error) {
      release(job);
      await worker.terminate();
      await removeScratch(job.scratchDir);
      emitStatus({ repositoryId: repo.id }, true);
      if (error instanceof ArchmapTimeoutError) throw error;
      if (error instanceof ArchmapCancelledError || controller.signal.aborted) throw new ArchmapCancelledError();
      throw error;
    }
    if (shuttingDown || controller.signal.aborted) {
      release(job);
      await worker.terminate();
      await removeScratch(job.scratchDir);
      emitStatus({ repositoryId: repo.id }, true);
      throw new ArchmapCancelledError();
    }
    job.progress = null;
    try {
      return enqueue(job);
    } catch (error) {
      await worker.terminate();
      await removeScratch(job.scratchDir);
      throw error;
    }
  }

  function confinePath(repoRoot: string, rawPath: unknown): { relPath: string; realPath: string } {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw new ArchmapFileError('invalid', '');
    const normalized = normalizeRelativePath(rawPath.trim());
    if (isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath) || normalized.split('/').some((s) => s === '..')) {
      throw new ArchmapFileError('outside', rawPath);
    }
    let rootReal: string;
    try {
      rootReal = realpathSync(repoRoot);
    } catch {
      throw new ArchmapFileError('root_missing', rawPath);
    }
    let realPath: string;
    try {
      realPath = realpathSync(resolve(rootReal, normalized));
    } catch {
      throw new ArchmapFileError('missing', normalized);
    }
    if (realPath !== rootReal && !realPath.startsWith(rootReal + sep))
      throw new ArchmapFileError('outside', normalized);
    const relPath = normalizeRelativePath(relative(rootReal, realPath));
    if (relPath !== normalized) throw new ArchmapFileError('outside', normalized);
    return { relPath, realPath };
  }

  const engine: ArchmapEngine = {
    settings,

    async status(repositoryId) {
      const repo = requireRepository(repositoryId);
      const last = deps.repository.getLast(repo.id);
      let lastRun = last ? runInfo(last, true) : undefined;
      const job = jobsByRepository.get(repo.id);
      const disk = await readDisk(repo);

      if (job) {
        const meta = disk.graph?.valid && disk.meta?.valid ? disk.meta.meta : null;
        const response: ArchmapStatusResponse = {
          status: job.status === 'queued' ? 'queued' : 'building',
          indexedCommit: meta && meta.gitCommitHash.length > 0 ? meta.gitCommitHash : null,
          lastIndexedAt: meta ? meta.lastAnalyzedAt : null,
          run: jobRunInfo(job),
        };
        if (job.status === 'queued') response.queuePosition = queue.indexOf(job) + 1;
        if (disk.graph?.valid && disk.graph.stats) response.stats = disk.graph.stats;
        if (lastRun && lastRun.id !== job.runId) response.lastRun = lastRun;
        return response;
      }

      if (!disk.graph || !disk.graph.valid) {
        if (disk.graph && !disk.graph.valid && lastRun) {
          lastRun = {
            ...lastRun,
            status: 'error',
            error: `schema incompativel: ${disk.graph.invalidReason ?? 'grafo invalido'}`,
          };
        }
        syncCache(repo.id, { indexedCommit: null, lastIndexedAt: null, stats: null });
        const response: ArchmapStatusResponse = {
          status: lastRun?.status === 'error' ? 'error' : 'absent',
          indexedCommit: null,
          lastIndexedAt: null,
        };
        if (lastRun) response.lastRun = lastRun;
        return response;
      }

      const meta = disk.meta?.valid ? disk.meta.meta : null;
      const indexedCommit = meta && meta.gitCommitHash.length > 0 ? meta.gitCommitHash : null;
      const lastIndexedAt = meta ? meta.lastAnalyzedAt : null;
      const stats = disk.graph.stats;
      let status: ArchmapStatus;
      let gitError: string | null = null;
      let freshness: ArchmapFreshness | null = null;
      if (!meta) {
        status = 'stale';
      } else {
        try {
          freshness = await freshnessService.compute({
            repositoryId: repo.id,
            repoRoot: repo.rootPath,
            generation: disk.pointer?.generation ?? (disk.legacy ? 'legacy' : null),
            graphPresent: true,
            indexedCommit,
            lastAnalyzedAt: lastIndexedAt,
            pendingFiles: meta.pendingFiles ?? [],
            mapPaths: disk.graph.paths,
            changedDuringRun: meta.changedDuringRun ?? [],
          });
          status =
            freshness.status === 'partial'
              ? 'partial'
              : freshness.status === 'stale' || freshness.status === 'dirty'
                ? 'stale'
                : 'ready';
        } catch (error) {
          if (!(error instanceof GitTimeoutError)) throw error;
          status = 'error';
          gitError = 'git nao respondeu';
        }
      }
      syncCache(repo.id, { indexedCommit, lastIndexedAt, stats });

      const response: ArchmapStatusResponse = { status, indexedCommit, lastIndexedAt };
      if (gitError) response.error = gitError;
      if (freshness) {
        response.freshness = freshness;
        response.changedFileCount = freshness.changedFileCount;
      }
      if (disk.legacy) response.legacy = true;
      if (stats) response.stats = stats;
      if (meta?.pendingFiles && meta.pendingFiles.length > 0) response.pendingFiles = meta.pendingFiles.length;
      if (disk.pointer) response.generation = disk.pointer.generation;
      if (meta?.layersStale) response.layersStale = true;
      if (meta?.tourStale) response.tourStale = true;
      if (meta?.fallback && meta.fallback.length > 0) response.fallback = meta.fallback;
      if (lastRun) response.lastRun = lastRun;
      return response;
    },

    async freshness(repositoryId) {
      freshnessService.invalidate(repositoryId);
      const response = await engine.status(repositoryId);
      if (response.freshness) return response.freshness;
      return {
        status: 'unknown',
        label: 'desconhecido',
        reason: response.error ?? (response.status === 'absent' ? 'mapa ausente' : response.status),
        changedFileCount: 0,
        changedFiles: [],
        commitsBehind: 0,
        commitsAhead: 0,
        localChanges: false,
        pendingFiles: response.pendingFiles ?? 0,
      };
    },

    async estimate(repositoryId, selection, mode) {
      const repo = requireRepository(repositoryId);
      const current = settings();
      if (!current.enabled) throw new ArchmapDisabledError();
      const controller = new AbortController();
      const entry: ActiveEstimate = {
        kind: 'estimate',
        repositoryId: repo.id,
        key: repositoryKey(repo),
        controller,
        worker: null,
      };
      reserve(repo, entry);
      try {
        entry.worker = createWorker();
        const scanned = await scanRepository(repo, entry.worker, controller, 'estimate');
        if (controller.signal.aborted) throw new ArchmapCancelledError();
        const runtime = selection ? archmapRuntimeForSelection(selection.runtime, selection.provider) : null;
        const response: ArchmapEstimateResponse = {
          fileCount: scanned.scan.files.length,
          batchCount: scanned.plan.batches.length,
          estimatedMinutes: estimateMinutes(scanned.plan.batches.length, current.batchParallelism),
          filteredByIgnore: scanned.scan.filteredByIgnore,
          warnings: scanned.warnings,
          runtime,
          provider: selection?.provider ?? null,
          model: selection?.model ?? null,
          elapsedMs: scanned.elapsedMs,
        };
        if (mode === 'update') {
          const { head, timedOut } = await headOrNull(repo.rootPath);
          if (timedOut) throw new ArchmapGitTimeoutError('rev-parse HEAD na estimativa');
          const classified = await classifyUpdate(repo, scanned, head ?? '');
          if (controller.signal.aborted) throw new ArchmapCancelledError();
          response.update = previewOf(classified.plan);
          response.jevTriageEnabled = current.jevTriageEnabled;
          if (classified.plan.action !== 'FULL_UPDATE') {
            response.batchCount = Math.ceil(classified.plan.filesToReanalyze / ARCHMAP_BATCH_SIZE_ESTIMATE);
            response.estimatedMinutes = estimateMinutes(response.batchCount, current.batchParallelism);
          }
        }
        return response;
      } catch (error) {
        if (error instanceof ArchmapTimeoutError) throw error;
        if (error instanceof ArchmapCancelledError || controller.signal.aborted) throw new ArchmapCancelledError();
        throw error;
      } finally {
        release(entry);
        if (entry.worker) await entry.worker.terminate();
        emitStatus({ repositoryId: repo.id }, true);
      }
    },

    build(repositoryId, selection) {
      return startGeneration(repositoryId, selection, 'build');
    },

    update(repositoryId, selection, confirmFull = false) {
      return startGeneration(repositoryId, selection, 'update', confirmFull);
    },

    async graph(repositoryId) {
      const repo = requireRepository(repositoryId);
      const result = await reader.readGraph(repo.id, repo.rootPath);
      if (result.kind === 'too_large') throw new ArchmapGraphTooLargeError(result.size, ARCHMAP_GRAPH_MAX_BYTES);
      if (result.kind === 'absent') throw new ArchmapAbsentError('graph');
      return result.graph;
    },

    async meta(repositoryId) {
      const repo = requireRepository(repositoryId);
      const disk = await readDisk(repo);
      if (!disk.meta?.valid || !disk.meta.meta) throw new ArchmapAbsentError('meta');
      return disk.meta.meta;
    },

    async file(repositoryId, rawPath) {
      const repo = requireRepository(repositoryId);
      const { relPath, realPath } = confinePath(repo.rootPath, rawPath);
      const disk = await readDisk(repo);
      if (!disk.graph?.valid) throw new ArchmapFileError('graph_absent', relPath);
      if (isSecurityExcludedPath(relPath) || !disk.graph.paths.has(relPath)) {
        throw new ArchmapFileError('not_in_graph', relPath);
      }
      let size: number;
      try {
        const st = await stat(realPath);
        if (!st.isFile()) throw new ArchmapFileError('not_a_file', relPath);
        size = st.size;
      } catch (error) {
        if (error instanceof ArchmapFileError) throw error;
        throw new ArchmapFileError('missing', relPath);
      }
      if (size > ARCHMAP_FILE_MAX_BYTES) throw new ArchmapFileError('too_large', relPath);
      let buffer: Buffer;
      try {
        const handle = await open(realPath, 'r');
        try {
          buffer = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          buffer = buffer.subarray(0, offset);
        } finally {
          await handle.close();
        }
      } catch {
        throw new ArchmapFileError('missing', relPath);
      }
      if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) throw new ArchmapFileError('binary', relPath);
      const content = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      return { path: relPath, content, language: detectFileLanguage(relPath) };
    },

    runs(repositoryId) {
      const repo = requireRepository(repositoryId);
      return deps.repository.listByRepository(repo.id).map((run) => runInfo(run, true));
    },

    cancel(repositoryId) {
      const estimate = estimatesByRepository.get(repositoryId);
      if (estimate) {
        estimate.controller.abort();
        void estimate.worker?.terminate();
        return { cancelled: true };
      }
      const job = jobsByRepository.get(repositoryId);
      if (!job || job.finalized) return { cancelled: false };
      if (job.status === 'queued') {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        release(job);
        void job.worker.terminate();
        void removeScratch(job.scratchDir);
        emitStatus({ repositoryId, run: { id: job.runId, kind: job.kind, status: 'cancelled' } }, true);
        return { cancelled: true };
      }
      if (job.handle?.finalizing) {
        return { cancelled: false, reason: 'gravando a geracao; a rodada termina em instantes' };
      }
      job.controller.abort();
      if (!job.handle) void job.worker.terminate();
      return { cancelled: true };
    },

    hasActive(repositoryId) {
      return estimatesByRepository.has(repositoryId) || jobsByRepository.has(repositoryId);
    },

    async waitForJob(repositoryId) {
      const job = jobsByRepository.get(repositoryId);
      if (job?.completion) await job.completion;
    },

    async preflight(repositoryId) {
      return runPreflight(requireRepository(repositoryId));
    },

    async reconcileBoot() {
      for (const run of deps.repository.listRunningRuns()) {
        try {
          deps.repository.finishRun(run.id, {
            status: 'error',
            action: run.action,
            reason: run.reason,
            error: 'interrompido por reinicio',
          });
        } catch (error) {
          logger.warn({ runId: run.id, err: error }, 'archmap: falha ao reconciliar rodada orfa');
        }
      }
      try {
        for (const name of await readdir(scratchRoot)) {
          await rm(join(scratchRoot, name), { recursive: true, force: true }).catch(() => undefined);
        }
      } catch {}
    },

    async shutdown(deadlineMs = 10_000) {
      shuttingDown = true;
      for (const job of queue.splice(0)) {
        release(job);
        void job.worker.terminate();
        void removeScratch(job.scratchDir);
        try {
          deps.repository.finishRun(job.runId, { status: 'error', error: 'interrompido por encerramento' });
        } catch {}
      }
      for (const estimate of estimatesByRepository.values()) {
        estimate.controller.abort();
        void estimate.worker?.terminate();
      }
      const running = [...jobsByRepository.values()].filter((job) => !job.finalized);
      for (const job of running) {
        if (job.handle?.finalizing) continue;
        job.controller.abort();
        if (!job.handle) void job.worker.terminate();
      }
      const completions = running.map((job) => job.completion ?? Promise.resolve());
      let timer: NodeJS.Timeout | null = null;
      await Promise.race([
        Promise.allSettled(completions),
        new Promise<void>((resolveWait) => {
          timer = setTimeout(resolveWait, deadlineMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      for (const job of running) {
        if (job.finalized) continue;
        job.finalized = true;
        try {
          deps.repository.finishRun(job.runId, {
            status: 'error',
            warnings: capWarnings(job.handle?.warnings ?? job.warnings),
            error: 'interrompido por encerramento',
            durationMs: Date.now() - job.startedAtMs,
          });
        } catch {}
        void job.worker.terminate();
        void removeScratch(job.scratchDir);
        release(job);
      }
      for (const entry of emitThrottle.values()) {
        if (entry.pending) clearTimeout(entry.pending);
      }
      emitThrottle.clear();
    },
  };

  return engine;
}
