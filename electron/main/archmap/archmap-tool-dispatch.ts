import { join } from 'node:path';
import { createSwarmToolDispatch } from '../agent-runtime/swarm-policy';
import { ARCHMAP_ALLOWED_TOOLS, isArchmapAllowedTool } from './archmap-policy';

export type ArchmapToolDispatch = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ result: string; isError: boolean }>;

export interface ArchmapToolDispatchOptions {
  scratchDir: string;
  signal: AbortSignal;
}

export function createArchmapToolDispatch(options: ArchmapToolDispatchOptions): ArchmapToolDispatch {
  const inner = createSwarmToolDispatch({
    cwd: options.scratchDir,
    findingsPath: join(options.scratchDir, '.archmap-no-findings'),
    allowedTools: ARCHMAP_ALLOWED_TOOLS,
    signal: options.signal,
    writeFindings: async () => {
      throw new Error('Mapa de arquitetura: escrita negada');
    },
  });
  return async (name, input) => {
    if (!isArchmapAllowedTool(name)) {
      options.signal.throwIfAborted();
      return {
        result: `Mapa de arquitetura: ferramenta negada (${name}); use so Read, Glob e Grep no rascunho`,
        isError: true,
      };
    }
    return inner(name, input);
  };
}
