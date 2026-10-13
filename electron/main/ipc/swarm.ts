import { ipcMain, shell } from 'electron';
import type { IpcContext } from './context';
import {
  getSession,
  getDesktopActiveSessionById,
  getChatFeatureToggles,
  getSessionActiveRepository,
  getLocalRepository,
} from '../db';
import { getAgentCwd } from '../paths';
import { getSwarmService } from '../swarm';
import { createLogger } from '../logger';
import type { SwarmStartInput, SwarmSettings } from '../../../src/types/swarm';
const logger = createLogger('ipc-swarm');
export function registerSwarmHandlers(ctx: IpcContext): void {
  function guarded(action: (...args: unknown[]) => unknown) {
    return async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== ctx.getMainWindow()?.webContents) {
        return { error: 'Sessão autenticada do desktop necessária.', code: 'auth-required' };
      }
      try {
        return await action(...args);
      } catch (error) {
        logger.warn({ error }, 'Falha no Swarm');
        return {
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string })?.code ?? 'swarm-error',
        };
      }
    };
  }
  function session(value: unknown): string {
    if (typeof value !== 'string' || !getSession(value)) throw new Error('Sessão não encontrada.');
    return value;
  }
  ipcMain.handle(
    'swarm:start',
    guarded((id, input) => {
      const sessionId = session(id);
      if (!getDesktopActiveSessionById(sessionId)) throw new Error('Swarm exige sessão desktop ativa.');
      const repo = getSessionActiveRepository(sessionId);
      return getSwarmService().start(
        {
          sessionId,
          swarmEnabled: getChatFeatureToggles(sessionId)?.swarm === true,
          readRoots: [(repo ? getLocalRepository(repo.repositoryId)?.rootPath : undefined) ?? getAgentCwd(false)],
        },
        input as SwarmStartInput,
      );
    }),
  );
  ipcMain.handle(
    'swarm:open-findings',
    guarded(async (id, runId, slug) => {
      const findingsPath = await getSwarmService().getFindingsPath(session(id), String(runId), String(slug));
      const error = await shell.openPath(findingsPath);
      if (error) throw new Error(error);
      return { opened: true };
    }),
  );
  ipcMain.handle(
    'swarm:abort',
    guarded((id, runId) => getSwarmService().abort(session(id), String(runId))),
  );
  ipcMain.handle(
    'swarm:stop-agent',
    guarded((id, runId, slug) => getSwarmService().stop(session(id), String(runId), String(slug), 'user')),
  );
  ipcMain.handle(
    'swarm:get-messages',
    guarded((id, runId, slug) => getSwarmService().getMessages(session(id), String(runId), String(slug))),
  );
  ipcMain.handle(
    'swarm:get-run-state',
    guarded((id, runId) => getSwarmService().getRunState(session(id), String(runId))),
  );
  ipcMain.handle(
    'swarm:list-runs',
    guarded((id, cursor, limit) =>
      getSwarmService().listRuns(session(id), cursor as string | undefined, limit as number | undefined),
    ),
  );
  ipcMain.handle(
    'swarm:get-catalog',
    guarded((id) => {
      const sessionId = session(id);
      return getSwarmService().getCatalog(sessionId, getChatFeatureToggles(sessionId)?.swarm === true);
    }),
  );
  ipcMain.handle(
    'swarm:get-settings',
    guarded(() => getSwarmService().getSettings()),
  );
  ipcMain.handle(
    'swarm:set-settings',
    guarded((settings) => getSwarmService().setSettings(settings as SwarmSettings)),
  );
  getSwarmService().subscribe((event) => {
    const window = ctx.getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('swarm:stream', event);
  });
}
