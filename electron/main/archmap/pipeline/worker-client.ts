import { Worker } from 'node:worker_threads';
import type { ScanOutput } from './scan';
import type { MergeBatchInput, MergeResult } from './merge';
import type { ArchmapBatch, BatchPlan, ExtractResult } from './types';
import type { ArchmapWorkerData, WorkerRequest, WorkerResponse } from './worker';
import { electronAppPath, resolveArchmapGrammarsDirForHost, resolveArchmapWorkerEntry } from './worker-entry';

export const ARCHMAP_WORKER_MAX_OLD_GEN_MB = 2048;

export interface ScanCallResult {
  scan: ScanOutput['scan'];
  fingerprints: ScanOutput['fingerprints'];
  exportsByPath: Record<string, string[]>;
}

export interface PipelineWorker {
  scan(
    payload: { projectPath: string; scanStartedAt: string; maxFileBytes?: number; snapshotDir?: string },
    onProgress?: (current: number, total: number) => void,
  ): Promise<ScanCallResult>;
  batches(payload: { scan: ScanOutput['scan']; exportsByPath: Record<string, string[]> }): Promise<BatchPlan>;
  extract(payload: {
    projectPath: string;
    batch: Pick<ArchmapBatch, 'batchIndex' | 'files' | 'batchImportData'>;
  }): Promise<ExtractResult>;
  merge(payload: {
    batches: MergeBatchInput[];
    importMap: Record<string, string[]>;
    preserveReviewedEdges?: boolean;
  }): Promise<MergeResult>;
  terminate(): Promise<void>;
  readonly dead: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (current: number, total: number) => void;
}

export interface CreatePipelineWorkerOptions {
  entry?: string;
  grammarsDir?: string | null;
  maxOldGenerationSizeMb?: number;
}

export function defaultArchmapWorkerEntry(): string {
  return resolveArchmapWorkerEntry(__dirname, electronAppPath());
}

export function createPipelineWorker(options: CreatePipelineWorkerOptions = {}): PipelineWorker {
  const entry = options.entry ?? defaultArchmapWorkerEntry();
  const workerData: ArchmapWorkerData = {
    grammarsDir: options.grammarsDir ?? resolveArchmapGrammarsDirForHost(electronAppPath()),
  };
  const worker = new Worker(entry, {
    workerData,
    resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? ARCHMAP_WORKER_MAX_OLD_GEN_MB },
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let dead = false;
  let deathReason: string | null = null;

  function failAll(reason: string): void {
    dead = true;
    deathReason = reason;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  worker.on('message', (message: WorkerResponse) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress?.(message.current, message.total);
      return;
    }
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  });
  worker.on('error', (error: unknown) =>
    failAll(`worker encerrou (erro: ${error instanceof Error ? error.message : String(error)})`),
  );
  worker.on('messageerror', (error: Error) => failAll(`worker encerrou (messageerror: ${error.message})`));
  worker.on('exit', (code) => {
    if (code !== 0) failAll(`worker encerrou (${code})`);
    else if (!dead) failAll('worker encerrou (0)');
    dead = true;
  });
  worker.unref();

  function call<T>(op: WorkerRequest['op'], payload: unknown, onProgress?: Pending['onProgress']): Promise<T> {
    if (dead) return Promise.reject(new Error(deathReason ?? 'worker encerrou'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      worker.ref();
      try {
        worker.postMessage({ id, op, payload } as WorkerRequest);
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => {
      if (pending.size === 0) worker.unref();
    });
  }

  return {
    get dead() {
      return dead;
    },
    scan: (payload, onProgress) => call<ScanCallResult>('scan', payload, onProgress),
    batches: (payload) => call<BatchPlan>('batches', payload),
    extract: (payload) => call<ExtractResult>('extract', payload),
    merge: (payload) => call<MergeResult>('merge', payload),
    async terminate() {
      if (dead) return;
      failAll('worker encerrou (cancelado)');
      await worker.terminate().catch(() => {});
    },
  };
}

export function createInProcessPipelineWorker(
  handle: (
    request: WorkerRequest,
    onProgress?: (id: number, current: number, total: number) => void,
  ) => Promise<unknown>,
): PipelineWorker {
  let dead = false;
  let nextId = 1;
  const call = async <T>(
    op: WorkerRequest['op'],
    payload: unknown,
    onProgress?: (current: number, total: number) => void,
  ): Promise<T> => {
    if (dead) throw new Error('worker encerrou (cancelado)');
    const id = nextId++;
    const result = await handle({ id, op, payload } as WorkerRequest, (_id, current, total) => {
      if (!dead) onProgress?.(current, total);
    });
    if (dead) throw new Error('worker encerrou (cancelado)');
    return result as T;
  };
  return {
    get dead() {
      return dead;
    },
    scan: (payload, onProgress) => call<ScanCallResult>('scan', payload, onProgress),
    batches: (payload) => call<BatchPlan>('batches', payload),
    extract: (payload) => call<ExtractResult>('extract', payload),
    merge: (payload) => call<MergeResult>('merge', payload),
    async terminate() {
      dead = true;
    },
  };
}
