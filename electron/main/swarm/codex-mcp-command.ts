import path from 'node:path';
import { isPackagedDistributionRuntime } from '../distribution-runtime';

export const CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE = 'approve';

export function codexMcpCommand(runtimeCommand: string, packaged = isPackagedDistributionRuntime()): string {
  if (packaged) return runtimeCommand;
  return /^electron(\.exe)?$/i.test(path.basename(runtimeCommand)) ? 'node' : runtimeCommand;
}
