import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentPermissionProfile, ToolDecision } from '../agent-runtime/types';

export const ARCHMAP_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export type ArchmapAllowedTool = (typeof ARCHMAP_ALLOWED_TOOLS)[number];

export const ARCHMAP_DENIED_TOOL_SAMPLES = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'shell',
  'exec_command',
  'WebFetch',
  'WebSearch',
  'web_search',
  'Task',
  'mcp__lionclaw__anything',
] as const;

export function isArchmapAllowedTool(name: string): name is ArchmapAllowedTool {
  return (ARCHMAP_ALLOWED_TOOLS as readonly string[]).includes(name);
}

export async function canonicalReadPath(scratchDir: string, value: unknown): Promise<string> {
  if (value !== undefined && typeof value !== 'string') throw new Error('Path invalido');
  const root = await fs.realpath(scratchDir);
  const target = await fs.realpath(path.resolve(root, typeof value === 'string' ? value : '.'));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Leitura fora do rascunho do mapa');
  return target;
}

export function readPathArgument(name: ArchmapAllowedTool, input: Record<string, unknown>): unknown {
  return name === 'Read' ? input.file_path : input.path;
}

export function isEscapingPattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  if (path.isAbsolute(pattern) || /^[\\/]/.test(pattern) || /^[A-Za-z]:/.test(pattern)) return true;
  return pattern.split(/[\\/]/).some((segment) => segment === '..');
}

export interface ArchmapPermissionOptions {
  scratchDir: string;
  signal: AbortSignal;
}

export function createArchmapPermission(options: ArchmapPermissionOptions): AgentPermissionProfile {
  return {
    mode: 'default',
    dangerouslySkipPermissions: false,
    canUseTool: async (name, input): Promise<ToolDecision> => {
      if (options.signal.aborted) return { behavior: 'deny', message: 'Mapa: rodada encerrada' };
      if (!isArchmapAllowedTool(name)) {
        return {
          behavior: 'deny',
          message: `Mapa de arquitetura: ferramenta negada (${name}); use so Read, Glob e Grep no rascunho`,
        };
      }
      if (name === 'Glob' && isEscapingPattern(input.pattern)) {
        return { behavior: 'deny', message: 'Glob fora do rascunho do mapa (pattern absoluto ou com ..)' };
      }
      try {
        await canonicalReadPath(options.scratchDir, readPathArgument(name, input));
      } catch (error) {
        return { behavior: 'deny', message: error instanceof Error ? error.message : String(error) };
      }
      return { behavior: 'allow', updatedInput: input };
    },
  };
}
