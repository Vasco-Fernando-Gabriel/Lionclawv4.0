import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ARCHMAP_GITIGNORE_LINE = '/.lionclaw/';

export function normalizeGitignoreLine(line: string): string {
  return line
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/+$/, '');
}

function hasLine(content: string): boolean {
  const wanted = normalizeGitignoreLine(ARCHMAP_GITIGNORE_LINE);
  return content.split(/\r?\n/).some((line) => normalizeGitignoreLine(line) === wanted);
}

export async function ensureArchmapGitignore(repoRoot: string): Promise<{ changed: boolean; path: string }> {
  const path = join(repoRoot, '.gitignore');
  let current: string | null = null;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current !== null && hasLine(current)) return { changed: false, path };
  const eol = current && current.includes('\r\n') ? '\r\n' : '\n';
  const base = current === null || current.length === 0 ? '' : current.endsWith('\n') ? current : `${current}${eol}`;
  await writeFile(path, `${base}${ARCHMAP_GITIGNORE_LINE}${eol}`, 'utf8');
  return { changed: true, path };
}
