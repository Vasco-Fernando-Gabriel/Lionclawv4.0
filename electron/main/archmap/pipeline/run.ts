import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ArchmapProgress, ArchmapStats, ArchmapUpdateAction } from '../../../../src/types/archmap';
import type { FileFingerprint } from '../core';
import type { ArchmapAgentExecutor } from '../agent-executor';
import { ArchmapCancelledError } from '../errors';
import type { GitRunner } from '../git';
import { writeGeneration, type ArchmapGeneration, type ArchmapGenerationMeta } from '../generation';
import { buildPromptContext } from '../prompts/context';
import { buildLayersPrompt } from '../prompts/layers';
import { buildNarrativePrompt } from '../prompts/narrative';
import { buildTourPrompt } from '../prompts/tour';
import { analyzeAgentBatch, batchAllowedPaths } from './agent-analysis';
import { reviewAssembly } from './assembly-review';
import {
  batchCheckpointInput,
  checkpointKey,
  pathsIdentity,
  type CheckpointArtifact,
  type CheckpointStore,
  type GenerationConfig,
} from './checkpoints';
import { findMissingSymbols, previousSymbolsByPath, requiredSymbols } from './incremental';
import { gitBlobSha1, gitTreeBlobs, writeJevSources, type JevSourceEntry } from './jev-sources';
import { KEPT_BATCH_INDEX, keptFileBatch } from './kept';
import { computeLayerStats, fileNodeSummaries, postProcessLayers } from './layers';
import { mergeBatches, type MergeBatchInput } from './merge';
import { SchemaGateError } from './normalize';
import { placeholderBatch, retainedPreviousBatch } from './partial';
import type { PrepareResult } from './prepare';
import { detectChangedDuringRun, readFrozenSource, sourceHash } from './snapshot';
import { computeTourTopology, postProcessTour, tourNodeIds, tourNodeIndex } from './tour';
import type {
  BatchInput,
  BatchOutput,
  BatchPlan,
  ExtractResult,
  LayerOutput,
  LayersInput,
  NarrativeInput,
  NarrativeOutput,
  PromptBuild,
  ScanResult,
  TourInput,
  TourStepOutput,
} from './types';
import type { PipelineWorker } from './worker-client';

export interface LlmTimeouts {
  narrative: number;
  batch: number;
  review: number;
  layers: number;
  tour: number;
}

export const LLM_TIMEOUTS_MS: LlmTimeouts = {
  narrative: 360_000,
  batch: 1_200_000,
  review: 1_200_000,
  layers: 600_000,
  tour: 600_000,
};

const README_MAX_BYTES = 12 * 1024;
const MANIFEST_MAX_BYTES = 8 * 1024;
const WARNING_PATHS_MAX = 20;
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
];

export class SymbolLossError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SymbolLossError';
  }
}

export class ArchmapAllBatchesFailedError extends Error {
  constructor(total: number, lastError: string | undefined) {
    super(`Nenhum dos ${total} lote(s) foi concluido${lastError ? ` (${lastError})` : ''}; nada publicado.`);
    this.name = 'ArchmapAllBatchesFailedError';
  }
}

export interface LlmCounters {
  calls: number;
  ms: number;
}

export interface RunCounters {
  succeeded: number;
  failed: number;
  reused: number;
}

export interface RunLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface IncrementalRunInput {
  plan: PrepareResult;
  keptPaths?: ReadonlySet<string>;
  jevKeptPaths?: ReadonlySet<string>;
}

export interface JevTriageRunInput {
  enabled: boolean;
}

export interface RunJobParams {
  repoRoot: string;
  runId: string;
  kind: 'build' | 'update';
  action?: ArchmapUpdateAction | null;
  scan: ScanResult;
  fingerprints: Record<string, FileFingerprint>;
  plan: BatchPlan;
  head0: string;
  scanStartedAt: string;
  generationConfig: GenerationConfig;
  lionClawVersion: string;
  worker: PipelineWorker;
  executor: ArchmapAgentExecutor;
  scratchDir: string;
  snapshotDir: string;
  checkpoints: CheckpointStore;
  previous: ArchmapGeneration | null;
  incremental?: IncrementalRunInput | null;
  jevTriage?: JevTriageRunInput | null;
  git?: GitRunner;
  review: boolean;
  signal: AbortSignal;
  logger: RunLogger;
  onProgress: (progress: ArchmapProgress) => void;
  warnings: string[];
  llmCounters: LlmCounters;
  llmTimeoutsMs?: Partial<LlmTimeouts>;
  batchParallelism: number;
}

export interface RunJobResult {
  generation: string;
  stats: ArchmapStats;
  warnings: string[];
  llmCalls: number;
  llmMs: number;
  partial: boolean;
  cancelled: boolean;
  pendingFiles: string[];
  changedDuringRun: string[];
  counters: RunCounters;
  action: ArchmapUpdateAction | null;
}

export interface RunHandle {
  readonly finalizing: boolean;
  readonly promise: Promise<RunJobResult>;
  readonly warnings: readonly string[];
  readonly counters: RunCounters;
}

async function readCapped(path: string, cap: number): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.length > cap ? `${raw.slice(0, cap)}\n[truncado]` : raw;
  } catch {
    return null;
  }
}

async function readFirst(dirs: readonly string[], name: string, cap: number): Promise<string | null> {
  for (const dir of dirs) {
    const content = await readCapped(join(dir, name), cap);
    if (content !== null) return content;
  }
  return null;
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, WARNING_PATHS_MAX).join(', ');
  return paths.length > WARNING_PATHS_MAX ? `${shown} e mais ${paths.length - WARNING_PATHS_MAX}` : shown;
}

function formatMissing(missing: Record<string, string[]>): string {
  return Object.entries(missing)
    .map(([path, names]) => `${path}: ${names.join(', ')}`)
    .join('; ');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return error instanceof ArchmapCancelledError || signal.aborted;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

function narrativeFromPrevious(previous: ArchmapGeneration, projectDirName: string): NarrativeOutput {
  const project = (previous.graph.project ?? {}) as Record<string, unknown>;
  return {
    name: typeof project.name === 'string' && project.name.trim() ? project.name : projectDirName,
    description: typeof project.description === 'string' ? project.description : '',
    frameworks: strings(project.frameworks),
    languages: strings(project.languages),
  };
}

export function startRun(params: RunJobParams): RunHandle {
  const state = { finalizing: false };
  const warnings = [...params.warnings];
  const counters: RunCounters = { succeeded: 0, failed: 0, reused: 0 };
  const promise = runJob(params, state, warnings, counters);
  return {
    get finalizing() {
      return state.finalizing;
    },
    promise,
    warnings,
    counters,
  };
}

async function runJob(
  params: RunJobParams,
  state: { finalizing: boolean },
  warnings: string[],
  counters: RunCounters,
): Promise<RunJobResult> {
  const { signal, worker, executor, logger, checkpoints, previous } = params;
  const timeouts = { ...LLM_TIMEOUTS_MS, ...params.llmTimeoutsMs };
  const config = params.generationConfig;
  const scan = params.scan;
  const incremental = params.incremental ?? null;
  const action: ArchmapUpdateAction | null = incremental?.plan.action ?? params.action ?? null;
  if (incremental && !previous) throw new Error(`atualizacao ${incremental.plan.action} sem geracao anterior`);
  const keptPaths = new Set(incremental?.keptPaths ?? []);
  const jevKeptPaths = new Set(incremental?.jevKeptPaths ?? []);
  const intermediate = join(params.scratchDir, 'intermediate');
  await mkdir(intermediate, { recursive: true });
  const writeIntermediate = (name: string, value: unknown): Promise<void> =>
    writeFile(join(intermediate, name), JSON.stringify(value), 'utf8').catch(() => undefined);
  const checkCancel = (): void => {
    if (signal.aborted) throw new ArchmapCancelledError();
  };
  const projectDirName = basename(params.repoRoot);
  const hashes = new Map(Object.entries(params.fingerprints).map(([path, fp]) => [path, fp.contentHash]));
  const previousNodes = previous ? (previous.graph.nodes as Record<string, unknown>[]) : [];
  const previousEdges = previous ? (previous.graph.edges as Record<string, unknown>[]) : [];
  const previousLayers = previous ? (previous.graph.layers as LayerOutput[]) : [];
  const previousTour = previous ? (previous.graph.tour as TourStepOutput[]) : [];
  const previousPaths = new Set<string>();
  const fallback: string[] = [];
  for (const node of previousNodes) {
    if (typeof node.filePath === 'string') previousPaths.add(node.filePath);
  }

  if (incremental) {
    const plan = incremental.plan;
    await writeIntermediate('incremental-plan.json', plan);
    warnings.push(`incremental ${plan.action}: ${plan.detail}`);
    if (plan.deletedPaths.length > 0) {
      warnings.push(
        `incremental: ${plan.deletedPaths.length} arquivo(s) removido(s) — ${listPaths(plan.deletedPaths)}`,
      );
    }
    if (plan.filesToReanalyzeList.length > 0) {
      warnings.push(
        `incremental: ${plan.filesToReanalyzeList.length} arquivo(s) relido(s) — ${listPaths(plan.filesToReanalyzeList)}`,
      );
    }
    if (plan.cosmeticPaths.length > 0) {
      warnings.push(
        `incremental: ${plan.cosmeticPaths.length} arquivo(s) com mudanca so cosmetica (anotacao mantida; estrutura e fingerprint do snapshot)`,
      );
    }
    if (jevKeptPaths.size > 0) {
      warnings.push(
        `incremental: ${jevKeptPaths.size} arquivo(s) dispensado(s) pela triagem Jev — ${listPaths([...jevKeptPaths].sort())}`,
      );
    }
  }

  async function callTask<TIn, TOut>(
    phase: 'narrative' | 'layers' | 'tour',
    label: string,
    cwd: string,
    input: TIn,
    keyInput: unknown,
    artifacts: CheckpointArtifact[],
    rebuild: (input: TIn) => PromptBuild,
    validate: (raw: Record<string, unknown>) => TOut,
    timeoutMs: number,
  ): Promise<{ value: TOut; reused: boolean }> {
    const key = checkpointKey(phase, config, keyInput, artifacts);
    const saved = await checkpoints.readTask(phase, key);
    if (saved) {
      try {
        const value = validate(saved);
        params.onProgress({ phase, detail: 'reaproveitado do checkpoint' });
        return { value, reused: true };
      } catch {}
    }
    checkCancel();
    const build = rebuild(input);
    const value = await executor.execute<TOut>({
      phase,
      label,
      cwd,
      prompt: `${build.prompt}\nSchema do resultado JSON:\n${JSON.stringify(build.outputSchema, null, 2)}`,
      validate,
      signal,
      timeoutMs,
      context: { operation: `archmap:${phase}`, input },
      onProgress: (detail) => params.onProgress({ phase, detail }),
      onAccepted: (raw) => {
        void checkpoints.writeTask(phase, key, raw).catch((error: unknown) => {
          logger.warn({ phase, error: errorText(error) }, 'archmap: checkpoint de fase nao gravado');
        });
      },
    });
    return { value, reused: false };
  }

  params.onProgress({ phase: 'narrative' });
  const scanLanguages = Object.keys(scan.stats.byLanguage).sort();
  let narrative: NarrativeOutput;
  if (incremental?.plan.action === 'SKIP' && previous) {
    narrative = narrativeFromPrevious(previous, projectDirName);
    params.onProgress({ phase: 'narrative', detail: 'mantida da geracao anterior' });
  } else {
    const sourceDirs = [params.snapshotDir];
    const readme =
      (await readFirst(sourceDirs, 'README.md', README_MAX_BYTES)) ??
      (await readFirst(sourceDirs, 'README.rst', README_MAX_BYTES)) ??
      (await readFirst(sourceDirs, 'README', README_MAX_BYTES)) ??
      '(ausente)';
    const manifests: NarrativeInput['manifests'] = [];
    for (const name of MANIFESTS) {
      const content = await readFirst(sourceDirs, name, MANIFEST_MAX_BYTES);
      if (content !== null) manifests.push({ path: name, content });
    }
    const narrativeInput: NarrativeInput = {
      projectDirName,
      readme,
      manifests,
      languageCounts: scan.stats.byLanguage,
      fileCount: scan.files.length,
    };
    const topPaths = [...new Set(scan.files.map((file) => file.path.split('/')[0]!))].sort();
    const narrativeArtifacts: CheckpointArtifact[] = [
      { path: 'README', hash: sourceHash(readme) },
      ...manifests.map((manifest) => ({ path: manifest.path, hash: sourceHash(manifest.content) })),
    ];
    const narrativeValidate = (raw: Record<string, unknown>): NarrativeOutput => {
      if (
        typeof raw.name !== 'string' ||
        !raw.name.trim() ||
        typeof raw.description !== 'string' ||
        !Array.isArray(raw.frameworks) ||
        !raw.frameworks.every((value) => typeof value === 'string') ||
        !Array.isArray(raw.languages) ||
        !raw.languages.every((value) => typeof value === 'string')
      ) {
        throw new SchemaGateError('Narrativa exige name, description e arrays de strings frameworks e languages.');
      }
      return {
        name: raw.name.trim() || projectDirName,
        description: raw.description,
        frameworks: strings(raw.frameworks),
        languages: strings(raw.languages),
      };
    };
    try {
      narrative = (
        await callTask<NarrativeInput, NarrativeOutput>(
          'narrative',
          'narrativa',
          join(params.scratchDir, 'narrative'),
          narrativeInput,
          { topPaths },
          narrativeArtifacts,
          (input) => buildNarrativePrompt(input),
          narrativeValidate,
          timeouts.narrative,
        )
      ).value;
    } catch (error) {
      if (isCancellation(error, signal)) throw new ArchmapCancelledError();
      fallback.push(`narrativa: ${errorText(error)}`);
      warnings.push(`narrativa: ${errorText(error)} — usando nome do diretorio e linguagens do scan`);
      narrative =
        previous && incremental
          ? narrativeFromPrevious(previous, projectDirName)
          : { name: projectDirName, description: '', frameworks: [], languages: scanLanguages };
    }
  }
  await writeIntermediate('narrative.json', narrative);
  checkCancel();

  const context = buildPromptContext(scanLanguages, narrative.frameworks);
  const liveBatches = params.plan.batches.filter((batch) => batch.files.length > 0);
  const inventory = new Map(scan.files.map((file) => [file.path, file]));
  const extractions = new Map<number, ExtractResult>();
  for (const [index, batch] of liveBatches.entries()) {
    checkCancel();
    params.onProgress({ phase: 'extraction', current: index + 1, total: liveBatches.length });
    const result = await worker.extract({ projectPath: params.snapshotDir, batch });
    for (const path of result.missing) {
      warnings.push(`extracao: ${path} ausente no snapshot — removido do inventario`);
    }
    extractions.set(batch.batchIndex, result);
  }
  let keptBatch: MergeBatchInput | null = null;
  if (keptPaths.size > 0 && previous) {
    checkCancel();
    const keptFiles = [...keptPaths].map((path) => inventory.get(path)).filter((file) => file !== undefined);
    const extracted = await worker.extract({
      projectPath: params.snapshotDir,
      batch: {
        batchIndex: KEPT_BATCH_INDEX,
        files: keptFiles,
        batchImportData: Object.fromEntries(keptFiles.map((file) => [file.path, scan.importMap[file.path] ?? []])),
      },
    });
    const knownIds = new Set(previousNodes.map((node) => String(node.id)));
    const kept = keptFileBatch({
      projectName: narrative.name,
      runId: params.runId,
      files: keptFiles,
      extraction: extracted.results,
      importMap: scan.importMap,
      previous: { nodes: previousNodes, edges: previousEdges },
      knownIds,
      jevKeptPaths,
    });
    keptBatch = kept.batch;
    if (kept.droppedEdges > 0) {
      warnings.push(`mantidos: ${kept.droppedEdges} aresta(s) semantica(s) removida(s) de arquivo(s) mantido(s)`);
    }
    if (kept.unannotated.length > 0) {
      warnings.push(`mantidos: ${kept.unannotated.length} simbolo(s) novo(s) sem anotacao em arquivo(s) mantido(s)`);
    }
  }
  const extractedAll = [...extractions.values()].flatMap((entry) => entry.results);
  const previousSymbols = previous
    ? previousSymbolsByPath(
        previousNodes,
        scan.files.map((file) => file.path),
      )
    : null;

  const merged: MergeBatchInput[] = [];
  const succeededPaths = new Set<string>();
  const failedBatches = new Map<number, string>();
  let lastError: string | undefined;
  let aborted = false;
  const reportAnalysis = (detail?: string): void => {
    params.onProgress({
      phase: 'analysis',
      current: counters.succeeded + counters.reused + counters.failed,
      total: liveBatches.length,
      succeeded: counters.succeeded + counters.reused,
      failed: counters.failed,
      reused: counters.reused,
      ...(lastError !== undefined ? { lastError } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  };
  logger.info(
    {
      runId: params.runId,
      files: scan.files.length,
      batches: liveBatches.length,
      parallelism: params.batchParallelism,
      action,
    },
    'archmap: analise por lote',
  );
  reportAnalysis();
  const queue = [...liveBatches];
  const workers = Math.max(1, Math.min(params.batchParallelism, queue.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!signal.aborted) {
        const batch = queue.shift();
        if (!batch) return;
        const label = `lote ${batch.batchIndex}`;
        const paths = batch.files.map((file) => file.path);
        try {
          const input: BatchInput = {
            projectName: narrative.name,
            batchIndex: batch.batchIndex,
            files: batch.files,
            extraction: extractions.get(batch.batchIndex)?.results ?? [],
            batchImportData: Object.fromEntries(paths.map((path) => [path, scan.importMap[path] ?? []])),
            neighborMap: {},
            sources: {},
            context,
          };
          const consulted = batchAllowedPaths(input, inventory).filter((path) => !paths.includes(path));
          const artifacts: CheckpointArtifact[] = consulted.map((path) => ({ path, hash: hashes.get(path) ?? '' }));
          const key = checkpointKey('analysis', config, batchCheckpointInput(input, hashes), artifacts);
          const identity = pathsIdentity(paths);
          let output: BatchOutput | null = await checkpoints.readBatch(key, identity, input);
          let reused = false;
          if (output) {
            reused = true;
          } else {
            output = await analyzeAgentBatch({
              input,
              scan,
              snapshotDir: params.snapshotDir,
              hashes,
              cwd: join(params.scratchDir, 'analysis', `batch-${batch.batchIndex}`),
              executor,
              signal,
              timeoutMs: timeouts.batch,
              onProgress: (detail) => reportAnalysis(`${label} · ${detail}`),
            });
          }
          if (previousSymbols) {
            const required = requiredSymbols(
              Object.fromEntries(
                paths.map((path) => [
                  path,
                  params.fingerprints[path]?.hasStructuralAnalysis ? (previousSymbols[path] ?? []) : [],
                ]),
              ),
              input.extraction,
            );
            const missing = findMissingSymbols(required, output.nodes);
            if (Object.keys(missing).length) {
              throw new SymbolLossError(`extracao estrutural incompleta — lote pendente (${formatMissing(missing)})`);
            }
          }
          if (!reused) {
            await checkpoints.writeBatch(key, identity, output).catch((error: unknown) => {
              logger.warn({ label, error: errorText(error) }, 'archmap: checkpoint de lote nao gravado');
            });
          }
          merged.push({ batchIndex: batch.batchIndex, paths, nodes: output.nodes, edges: output.edges });
          for (const path of paths) succeededPaths.add(path);
          if (reused) counters.reused += 1;
          else counters.succeeded += 1;
          reportAnalysis(`${label} concluido`);
        } catch (error) {
          if (isCancellation(error, signal)) {
            aborted = true;
            return;
          }
          counters.failed += 1;
          lastError = `${label}: ${errorText(error)}`;
          failedBatches.set(batch.batchIndex, lastError);
          warnings.push(lastError);
          await writeIntermediate(`failure-${batch.batchIndex}.json`, { runId: params.runId, label, error: lastError });
          logger.warn({ runId: params.runId, error: lastError }, 'archmap: lote pendente');
          reportAnalysis();
        }
      }
      aborted = aborted || signal.aborted;
    }),
  );
  aborted = aborted || signal.aborted;

  if (merged.length === 0 && liveBatches.length > 0) {
    if (aborted) throw new ArchmapCancelledError();
    throw new ArchmapAllBatchesFailedError(liveBatches.length, lastError);
  }
  if (liveBatches.length === 0 && aborted) throw new ArchmapCancelledError();

  const currentPaths = new Set(scan.files.map((file) => file.path));
  const plannedPaths = new Set(liveBatches.flatMap((batch) => batch.files.map((file) => file.path)));
  const unplannedNew = [...currentPaths].filter(
    (path) => !plannedPaths.has(path) && !previousPaths.has(path) && !keptPaths.has(path),
  );
  const pendingFiles = [...new Set([...plannedPaths, ...unplannedNew])]
    .filter((path) => !succeededPaths.has(path))
    .sort();
  const retainPaths = new Set(
    [...previousPaths].filter((path) => currentPaths.has(path) && !succeededPaths.has(path) && !keptPaths.has(path)),
  );
  const pendingNew = pendingFiles.filter((path) => !previousPaths.has(path));
  if (aborted) warnings.push(`rodada cancelada com ${merged.length} de ${liveBatches.length} lote(s) concluido(s)`);
  if (pendingFiles.length > 0) {
    warnings.push(`${pendingFiles.length} arquivo(s) pendente(s) — ${listPaths(pendingFiles)}`);
  }

  params.onProgress({ phase: 'merge' });
  const mergeInputs: MergeBatchInput[] = [];
  if (retainPaths.size > 0) {
    mergeInputs.push(retainedPreviousBatch({ nodes: previousNodes, edges: previousEdges }, retainPaths));
  }
  if (pendingNew.length > 0) {
    mergeInputs.push(
      placeholderBatch(
        narrative.name,
        pendingNew.map((path) => inventory.get(path)!),
        extractedAll,
        scan.importMap,
      ),
    );
  }
  if (keptBatch) mergeInputs.push(keptBatch);
  mergeInputs.push(...merged);
  const assembled = mergeBatches(mergeInputs, scan.importMap, true);
  warnings.push(...assembled.warnings);
  let reviewReport: Record<string, unknown> = {
    version: 2,
    scope: aborted ? 'partial' : incremental ? 'incremental-deterministic' : 'deterministic',
    scopeDescription: aborted
      ? 'Geracao parcial: montagem deterministica; revisao nao roda em geracao parcial.'
      : incremental
        ? 'Atualizacao incremental: montagem deterministica; revisao so em regeneracao completa.'
        : 'Montagem deterministica sem revisao por agente.',
  };

  if (params.review && !aborted && !incremental) {
    params.onProgress({ phase: 'review', current: 0, total: 1, detail: 'Verificando a montagem do mapa' });
    const reviewInput = { ...assembled, importMap: scan.importMap };
    const reviewKey = checkpointKey('review', config, { nodes: assembled.nodes, edges: assembled.edges });
    try {
      const reviewed = await reviewAssembly({
        input: reviewInput,
        cwd: join(params.scratchDir, 'review'),
        executor: {
          execute: async (request) => {
            const saved = await checkpoints.readTask('review', reviewKey);
            if (saved) {
              try {
                const value = request.validate(saved);
                params.onProgress({ phase: 'review', detail: 'reaproveitado do checkpoint' });
                return value;
              } catch {}
            }
            return executor.execute({
              ...request,
              onAccepted: (raw) => {
                void checkpoints.writeTask('review', reviewKey, raw).catch(() => undefined);
              },
            });
          },
        },
        signal,
        timeoutMs: timeouts.review,
        onProgress: (detail) => params.onProgress({ phase: 'review', current: 0, total: 1, detail }),
      });
      assembled.nodes = reviewed.nodes;
      assembled.edges = reviewed.edges;
      reviewReport = { ...reviewed.report, runId: params.runId };
      warnings.push(...reviewed.warnings);
    } catch (error) {
      if (isCancellation(error, signal)) {
        aborted = true;
        warnings.push('revisao de montagem cancelada; geracao segue sem revisao');
      } else {
        fallback.push(`revisao: ${errorText(error)}`);
        warnings.push(`revisao de montagem: ${errorText(error)} — montagem mantida sem revisao`);
      }
    }
    params.onProgress({ phase: 'review', current: 1, total: 1 });
  }
  await writeIntermediate('assembly-review.json', reviewReport);

  const fileNodes = fileNodeSummaries(assembled);
  const rerunLayers = !incremental || incremental.plan.rerunLayers || previous?.meta.layersStale === true;
  const rerunTour = !incremental || incremental.plan.rerunTour || previous?.meta.tourStale === true;
  let layers: LayerOutput[];
  let layersStale = false;
  params.onProgress({ phase: 'layers' });
  if (!rerunLayers) {
    const post = postProcessLayers(previousLayers, fileNodes, 'camadas (incremental)');
    warnings.push(...post.warnings);
    layers = post.layers;
    params.onProgress({ phase: 'layers', detail: 'mantidas da geracao anterior' });
  } else if (aborted) {
    const post = postProcessLayers(previousLayers, fileNodes, 'camadas (parcial)');
    warnings.push(...post.warnings);
    layers = post.layers;
    layersStale = true;
  } else {
    const layersInput: LayersInput = {
      projectName: narrative.name,
      description: narrative.description,
      fileNodes,
      stats: computeLayerStats(fileNodes, assembled.edges),
      context,
    };
    try {
      layers = (
        await callTask<LayersInput, LayerOutput[]>(
          'layers',
          'camadas',
          join(params.scratchDir, 'layers'),
          layersInput,
          { fileNodes, stats: layersInput.stats },
          [],
          (input) => buildLayersPrompt(input),
          (raw) => {
            if (!Array.isArray(raw.layers)) throw new SchemaGateError('a resposta nao contem o array `layers`');
            const post = postProcessLayers(raw.layers, fileNodes);
            warnings.push(...post.warnings);
            return post.layers;
          },
          timeouts.layers,
        )
      ).value;
    } catch (error) {
      if (isCancellation(error, signal)) aborted = true;
      else {
        fallback.push(`camadas: ${errorText(error)}`);
        warnings.push(`camadas: ${errorText(error)} — camadas deterministicas`);
      }
      const post = postProcessLayers(previousLayers, fileNodes, 'camadas (fallback)');
      warnings.push(...post.warnings);
      layers = post.layers;
      layersStale = true;
    }
  }
  await writeIntermediate('layers.json', layers);

  const topology = computeTourTopology(fileNodes, assembled.edges);
  const validIds = tourNodeIds(assembled.nodes);
  let tour: TourStepOutput[];
  let tourStale = false;
  params.onProgress({ phase: 'tour' });
  if (!rerunTour) {
    const post = postProcessTour(previousTour, validIds, fileNodes, layers, topology, 'tour (incremental)');
    warnings.push(...post.warnings);
    tour = post.steps;
    params.onProgress({ phase: 'tour', detail: 'mantido da geracao anterior' });
  } else if (aborted) {
    const post = postProcessTour(previousTour, validIds, fileNodes, layers, topology, 'tour (parcial)');
    warnings.push(...post.warnings);
    tour = post.steps;
    tourStale = true;
  } else {
    const tourInput: TourInput = {
      projectName: narrative.name,
      description: narrative.description,
      nodeIndex: tourNodeIndex(assembled.nodes),
      layers,
      topology,
    };
    try {
      tour = (
        await callTask<TourInput, TourStepOutput[]>(
          'tour',
          'tour',
          join(params.scratchDir, 'tour'),
          tourInput,
          { nodeIndex: tourInput.nodeIndex, layers, topology },
          [],
          (input) => buildTourPrompt(input),
          (raw) => {
            if (!Array.isArray(raw.steps)) throw new SchemaGateError('a resposta nao contem o array `steps`');
            const post = postProcessTour(raw.steps, validIds, fileNodes, layers, topology);
            warnings.push(...post.warnings);
            return post.steps;
          },
          timeouts.tour,
        )
      ).value;
    } catch (error) {
      if (isCancellation(error, signal)) aborted = true;
      else {
        fallback.push(`tour: ${errorText(error)}`);
        warnings.push(`tour: ${errorText(error)} — tour deterministico`);
      }
      const post = postProcessTour(previousTour, validIds, fileNodes, layers, topology, 'tour (fallback)');
      warnings.push(...post.warnings);
      tour = post.steps;
      tourStale = true;
    }
  }
  await writeIntermediate('tour.json', tour);

  state.finalizing = true;
  params.onProgress({ phase: 'finalize' });
  if (aborted) fallback.push('rodada cancelada: camadas e tour da geracao anterior ou deterministicos');
  const changed = await detectChangedDuringRun(params.repoRoot, hashes);
  if (changed.changed.length > 0) {
    warnings.push(`${changed.changed.length} arquivo(s) mudaram durante a rodada — ${listPaths(changed.changed)}`);
  }
  const fingerprints: Record<string, FileFingerprint> = {};
  for (const path of succeededPaths) {
    const fp = params.fingerprints[path];
    if (fp) fingerprints[path] = fp;
  }
  for (const path of keptPaths) {
    const fp = params.fingerprints[path];
    if (fp) fingerprints[path] = fp;
  }
  for (const path of retainPaths) {
    const fp = previous?.fingerprints.files[path];
    if (fp) fingerprints[path] = fp;
  }
  const graph = {
    version: '1.0.0',
    kind: 'codebase',
    project: {
      name: narrative.name,
      languages: narrative.languages.length > 0 ? narrative.languages : scanLanguages,
      frameworks: narrative.frameworks,
      description: narrative.description,
      analyzedAt: params.scanStartedAt,
      gitCommitHash: params.head0,
    },
    nodes: assembled.nodes,
    edges: assembled.edges,
    layers,
    tour,
  };
  const meta: ArchmapGenerationMeta = {
    lastAnalyzedAt: params.scanStartedAt,
    gitCommitHash: params.head0,
    analyzedFiles: succeededPaths.size + retainPaths.size + keptPaths.size,
    runtime: config.runtime,
    provider: config.provider,
    model: config.model,
    lionClawVersion: params.lionClawVersion,
    ...(action ? { action } : {}),
    ...(pendingFiles.length > 0 ? { partial: true, pendingFiles } : {}),
    ...(changed.changed.length > 0 ? { changedDuringRun: changed.changed } : {}),
    ...(layersStale ? { layersStale: true } : {}),
    ...(tourStale ? { tourStale: true } : {}),
    ...(fallback.length > 0 ? { fallback } : {}),
  };
  const written = await writeGeneration({
    repoRoot: params.repoRoot,
    runId: params.runId,
    graph,
    fingerprints,
    scan,
    meta,
  });
  warnings.push(...written.dropped.map((message) => `finalize: ${message}`));
  if (params.jevTriage?.enabled) {
    const tracked = params.git
      ? await gitTreeBlobs(params.repoRoot, params.head0, params.git)
      : new Map<string, string>();
    const entries: JevSourceEntry[] = [];
    for (const [path, fp] of Object.entries(fingerprints)) {
      if (hashes.get(path) !== fp.contentHash) continue;
      try {
        const content = await readFrozenSource(params.snapshotDir, path, hashes);
        if (tracked.get(path) === gitBlobSha1(content)) continue;
        entries.push({ hash: fp.contentHash, content });
      } catch {}
    }
    try {
      const stored = await writeJevSources(written.dir, entries);
      if (stored > 0) {
        warnings.push(
          `triagem Jev: ${stored} arquivo(s) com conteudo diferente do commit ${params.head0.slice(0, 7) || '(sem git)'} guardado(s) para a proxima triagem`,
        );
      }
    } catch (error) {
      warnings.push(`triagem Jev: conteudos para a proxima triagem nao gravados (${errorText(error)})`);
    }
  }
  return {
    generation: written.generation,
    stats: written.stats,
    warnings,
    llmCalls: params.llmCounters.calls,
    llmMs: params.llmCounters.ms,
    partial: pendingFiles.length > 0,
    cancelled: aborted,
    pendingFiles,
    changedDuringRun: changed.changed,
    counters,
    action,
  };
}
