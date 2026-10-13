import { ipcMain } from 'electron';
import type {
  ArchmapBuildRequest,
  ArchmapCancelResponse,
  ArchmapErrorPayload,
  ArchmapEstimateRequest,
  ArchmapEstimateResponse,
  ArchmapFileRequest,
  ArchmapFileResponse,
  ArchmapFreshness,
  ArchmapMetaResponse,
  ArchmapRunInfo,
  ArchmapRuntimeCapability,
  ArchmapStatusEvent,
  ArchmapStatusResponse,
  ArchmapUpdateRequest,
} from '../../../src/types/archmap';
import { getAppVersion } from '../app-version';
import { getLocalRepository, getSetting } from '../db';
import { createLogger } from '../logger';
import { createArchmapEngine, type ArchmapEngine } from '../archmap/engine';
import { ArchmapConfirmFullError, ArchmapError } from '../archmap/errors';
import { getArchmapRepository } from '../archmap/repository';
import { listArchmapRuntimeCapabilities } from '../archmap/runtime-capabilities';
import { parseArchmapSelection, parseOptionalArchmapSelection } from '../archmap/selection';
import type { IpcContext } from './context';

const logger = createLogger('ipc');

let engineSingleton: ArchmapEngine | null = null;
let statusEmitter: ((event: ArchmapStatusEvent) => void) | null = null;

export function getArchmapEngine(): ArchmapEngine {
  if (!engineSingleton) {
    engineSingleton = createArchmapEngine({
      repository: getArchmapRepository(),
      getLocalRepository,
      getSetting,
      emit: (event) => statusEmitter?.(event),
      lionClawVersion: getAppVersion(),
    });
    void engineSingleton.reconcileBoot().catch((err: unknown) => {
      logger.warn({ err }, 'archmap: reconciliacao de boot falhou');
    });
  }
  return engineSingleton;
}

export async function shutdownArchmapEngine(deadlineMs = 10_000): Promise<void> {
  if (!engineSingleton) return;
  await engineSingleton.shutdown(deadlineMs);
}

function errorPayload(err: unknown): ArchmapErrorPayload {
  const code = err instanceof ArchmapError ? err.code : undefined;
  const details = err instanceof ArchmapConfirmFullError ? err.details : undefined;
  return {
    error: err instanceof Error ? err.message : String(err),
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function requestRepositoryId(request: { repositoryId?: unknown } | null | undefined): string {
  return typeof request?.repositoryId === 'string' ? request.repositoryId : '';
}

export function registerArchmapHandlers(ctx: IpcContext): void {
  const engine = getArchmapEngine();

  statusEmitter = (event) => {
    try {
      ctx.getMainWindow()?.webContents.send('archmap:on-status', event);
    } catch (err) {
      logger.warn({ err }, 'archmap:on-status broadcast failed');
    }
  };

  ipcMain.handle(
    'archmap:status',
    async (_event, repositoryId: string): Promise<ArchmapStatusResponse | { error: string }> => {
      try {
        return await engine.status(repositoryId);
      } catch (err) {
        logger.error({ err, repositoryId }, 'archmap:status failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle(
    'archmap:estimate',
    async (_event, request: ArchmapEstimateRequest): Promise<ArchmapEstimateResponse | { error: string }> => {
      const repositoryId = requestRepositoryId(request);
      try {
        return await engine.estimate(
          repositoryId,
          parseOptionalArchmapSelection(request?.selection, 'estimar o mapa'),
          request?.mode === 'update' ? 'update' : 'build',
        );
      } catch (err) {
        logger.warn({ err, repositoryId }, 'archmap:estimate failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle(
    'archmap:build',
    async (_event, request: ArchmapBuildRequest): Promise<ArchmapRunInfo | { error: string }> => {
      const repositoryId = requestRepositoryId(request);
      try {
        return await engine.build(repositoryId, parseArchmapSelection(request?.selection, 'gerar o mapa'));
      } catch (err) {
        logger.warn({ err, repositoryId }, 'archmap:build failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle(
    'archmap:update',
    async (_event, request: ArchmapUpdateRequest): Promise<ArchmapRunInfo | { error: string }> => {
      const repositoryId = requestRepositoryId(request);
      try {
        return await engine.update(
          repositoryId,
          parseArchmapSelection(request?.selection, 'atualizar o mapa'),
          request?.confirmFull === true,
        );
      } catch (err) {
        logger.warn({ err, repositoryId }, 'archmap:update failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle('archmap:graph', async (_event, repositoryId: string): Promise<unknown | { error: string }> => {
    try {
      return await engine.graph(repositoryId);
    } catch (err) {
      logger.warn({ err, repositoryId }, 'archmap:graph failed');
      return errorPayload(err);
    }
  });

  ipcMain.handle(
    'archmap:meta',
    async (_event, repositoryId: string): Promise<ArchmapMetaResponse | { error: string }> => {
      try {
        return await engine.meta(repositoryId);
      } catch (err) {
        logger.warn({ err, repositoryId }, 'archmap:meta failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle(
    'archmap:file',
    async (_event, request: ArchmapFileRequest): Promise<ArchmapFileResponse | { error: string }> => {
      const repositoryId = requestRepositoryId(request);
      try {
        return await engine.file(repositoryId, request?.path);
      } catch (err) {
        logger.warn({ err, repositoryId }, 'archmap:file failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle(
    'archmap:freshness',
    async (_event, repositoryId: string): Promise<ArchmapFreshness | { error: string }> => {
      try {
        return await engine.freshness(repositoryId);
      } catch (err) {
        logger.warn({ err, repositoryId }, 'archmap:freshness failed');
        return errorPayload(err);
      }
    },
  );

  ipcMain.handle('archmap:runs', (_event, repositoryId: string): ArchmapRunInfo[] | { error: string } => {
    try {
      return engine.runs(repositoryId);
    } catch (err) {
      logger.warn({ err, repositoryId }, 'archmap:runs failed');
      return errorPayload(err);
    }
  });

  ipcMain.handle('archmap:cancel', (_event, repositoryId: string): ArchmapCancelResponse | { error: string } => {
    try {
      return engine.cancel(repositoryId);
    } catch (err) {
      logger.error({ err, repositoryId }, 'archmap:cancel failed');
      return errorPayload(err);
    }
  });

  ipcMain.handle('archmap:runtime-capabilities', (): ArchmapRuntimeCapability[] | { error: string } => {
    try {
      return listArchmapRuntimeCapabilities();
    } catch (err) {
      logger.error({ err }, 'archmap:runtime-capabilities failed');
      return errorPayload(err);
    }
  });
}
