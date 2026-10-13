import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { GitRunner } from '../git';
import { normalizeRelativePath } from './node-path';
import { sourceHash } from './snapshot';

export const JEV_SOURCES_DIR = 'jev-sources';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

export function isGitCommitRef(commit: unknown): commit is string {
  return typeof commit === 'string' && COMMIT_PATTERN.test(commit);
}

export function jevSourcesDir(generationDir: string): string {
  return join(generationDir, JEV_SOURCES_DIR);
}

export function jevSourcePath(generationDir: string, hash: string): string {
  return join(jevSourcesDir(generationDir), `${hash}.gz`);
}

export interface JevSourceEntry {
  hash: string;
  content: string;
}

export async function writeJevSources(generationDir: string, entries: Iterable<JevSourceEntry>): Promise<number> {
  const dir = jevSourcesDir(generationDir);
  await mkdir(dir, { recursive: true });
  let written = 0;
  for (const entry of entries) {
    if (!HASH_PATTERN.test(entry.hash)) continue;
    await writeFile(jevSourcePath(generationDir, entry.hash), gzipSync(Buffer.from(entry.content, 'utf8')));
    written += 1;
  }
  return written;
}

export async function readJevSource(generationDir: string, hash: string): Promise<string | null> {
  if (!HASH_PATTERN.test(hash)) return null;
  let text: string;
  try {
    text = gunzipSync(await readFile(jevSourcePath(generationDir, hash))).toString('utf8');
  } catch {
    return null;
  }
  return sourceHash(text) === hash ? text : null;
}

export function gitBlobSha1(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export async function gitTreeBlobs(repoRoot: string, commit: string, git: GitRunner): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isGitCommitRef(commit)) return out;
  const result = await git(repoRoot, ['ls-tree', '-r', '-z', commit]);
  if (!result.ok) return out;
  for (const entry of result.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab <= 0) continue;
    const [, type, sha] = entry.slice(0, tab).split(' ');
    if (type !== 'blob' || !sha) continue;
    out.set(normalizeRelativePath(entry.slice(tab + 1)), sha);
  }
  return out;
}

export async function readGitBlob(
  repoRoot: string,
  commit: string,
  path: string,
  hash: string,
  git: GitRunner,
): Promise<string | null> {
  if (!isGitCommitRef(commit) || !HASH_PATTERN.test(hash)) return null;
  const normalized = normalizeRelativePath(path);
  if (normalized.length === 0 || normalized.split('/').some((segment) => segment === '..')) return null;
  const result = await git(repoRoot, ['show', `${commit}:${normalized}`]);
  if (!result.ok) return null;
  return sourceHash(result.stdout) === hash ? result.stdout : null;
}
