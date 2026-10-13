import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { computeBatches } from './batches';
import { extractBatch } from './extract';
import { resolveImportMap } from './import-map';
import { mergeBatches, type MergeBatchInput } from './merge';
import { configureArchmapGrammarsDir, getArchmapRegistry } from './registry';
import { scanProject, type ScanOutput } from './scan';
import type { ArchmapBatch } from './types';

export type WorkerRequest =
  | {
      id: number;
      op: 'scan';
      payload: { projectPath: string; scanStartedAt: string; maxFileBytes?: number; snapshotDir?: string };
    }
  | { id: number; op: 'batches'; payload: { scan: ScanOutput['scan']; exportsByPath: Record<string, string[]> } }
  | {
      id: number;
      op: 'extract';
      payload: { projectPath: string; batch: Pick<ArchmapBatch, 'batchIndex' | 'files' | 'batchImportData'> };
    }
  | {
      id: number;
      op: 'merge';
      payload: { batches: MergeBatchInput[]; importMap: Record<string, string[]>; preserveReviewedEdges?: boolean };
    }
  | { id: number; op: 'ping'; payload: Record<string, never> };

export type WorkerResponse =
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'progress'; id: number; current: number; total: number };

export interface ArchmapWorkerData {
  grammarsDir?: string | null;
}

function readOptional(projectPath: string, name: string): string | null {
  try {
    return readFileSync(join(projectPath, name), 'utf8');
  } catch {
    return null;
  }
}

export async function handleWorkerRequest(request: WorkerRequest, onProgress?: WorkerProgress): Promise<unknown> {
  switch (request.op) {
    case 'ping':
      return { ok: true };
    case 'scan': {
      const registry = await getArchmapRegistry();
      const { projectPath, scanStartedAt, maxFileBytes, snapshotDir } = request.payload;
      const output = scanProject(projectPath, registry, {
        scanStartedAt,
        maxFileBytes,
        snapshotDir,
        onProgress: (current, total) => onProgress?.(request.id, current, total),
      });
      output.scan.importMap = resolveImportMap(output.scan.files, output.rawImports, {
        tsconfigText: readOptional(projectPath, 'tsconfig.json'),
        goModText: readOptional(projectPath, 'go.mod'),
      });
      return { scan: output.scan, fingerprints: output.fingerprints, exportsByPath: output.exportsByPath };
    }
    case 'batches':
      return computeBatches(request.payload.scan, request.payload.exportsByPath);
    case 'extract': {
      const registry = await getArchmapRegistry();
      return extractBatch(request.payload.projectPath, request.payload.batch, registry);
    }
    case 'merge':
      return mergeBatches(request.payload.batches, request.payload.importMap, request.payload.preserveReviewedEdges);
    default:
      throw new Error(`operacao desconhecida: ${String((request as { op: unknown }).op)}`);
  }
}

export type WorkerProgress = (id: number, current: number, total: number) => void;

if (parentPort) {
  const data = (workerData ?? {}) as ArchmapWorkerData;
  if (data.grammarsDir) configureArchmapGrammarsDir(data.grammarsDir);
  const port = parentPort;
  port.on('message', (request: WorkerRequest) => {
    void handleWorkerRequest(request, (id, current, total) => {
      port.postMessage({ type: 'progress', id, current, total } satisfies WorkerResponse);
    })
      .then((result) => {
        port.postMessage({ type: 'result', id: request.id, ok: true, result } satisfies WorkerResponse);
      })
      .catch((error: unknown) => {
        port.postMessage({
          type: 'result',
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkerResponse);
      });
  });
}
