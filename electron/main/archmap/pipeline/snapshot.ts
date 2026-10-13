import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCHMAP_MAX_FILE_BYTES } from './scan';

export function sourceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function readFrozenSource(
  snapshotDir: string,
  path: string,
  hashes: ReadonlyMap<string, string>,
): Promise<string> {
  const expected = hashes.get(path);
  if (!expected) throw new Error(`Consulta fora do inventario: ${path}`);
  if (path.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`Consulta recusada: ${path}`);
  }
  const bytes = await readFile(join(snapshotDir, path));
  if (bytes.length > ARCHMAP_MAX_FILE_BYTES) throw new Error(`Arquivo fora do limite de leitura: ${path}`);
  const text = bytes.toString('utf8');
  if (sourceHash(text) !== expected) throw new Error(`Snapshot corrompido para ${path}; gere novamente.`);
  return text;
}

export interface ChangedDuringRunResult {
  changed: string[];
  removed: string[];
}

export async function detectChangedDuringRun(
  repoRoot: string,
  hashes: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<ChangedDuringRunResult> {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, expected] of hashes) {
    if (signal?.aborted) break;
    try {
      const bytes = await readFile(join(repoRoot, path));
      if (sourceHash(bytes.toString('utf8')) !== expected) changed.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') removed.push(path);
      else changed.push(path);
    }
  }
  return { changed: changed.sort(), removed: removed.sort() };
}
