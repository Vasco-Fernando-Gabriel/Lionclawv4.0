import { execFile } from 'node:child_process';

export const ARCHMAP_GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const LIONCLAW_DIR = '.lionclaw';

export class GitTimeoutError extends Error {
  constructor(args: readonly string[]) {
    super(`git nao respondeu em ${ARCHMAP_GIT_TIMEOUT_MS / 1000} s (git ${args.join(' ')})`);
    this.name = 'GitTimeoutError';
  }
}

export type GitOutcome = { ok: true; stdout: string } | { ok: false; timeout: boolean; message: string };

export interface GitRunner {
  (projectPath: string, args: string[], timeoutMs?: number): Promise<GitOutcome>;
}

export const runGit: GitRunner = (projectPath, args, timeoutMs = ARCHMAP_GIT_TIMEOUT_MS) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', '-C', projectPath, ...args],
      { timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (!error) {
          resolve({ ok: true, stdout: String(stdout) });
          return;
        }
        const timedOut = (error as { killed?: boolean }).killed === true;
        resolve({ ok: false, timeout: timedOut, message: error.message });
      },
    );
  });

export function isArchmapDirPath(path: string): boolean {
  return path === LIONCLAW_DIR || path === `${LIONCLAW_DIR}/` || path.startsWith(`${LIONCLAW_DIR}/`);
}

function failIfTimeout(outcome: GitOutcome, args: string[]): void {
  if (!outcome.ok && outcome.timeout) throw new GitTimeoutError(args);
}

export async function gitHead(projectPath: string, git: GitRunner = runGit): Promise<string | null> {
  const args = ['rev-parse', 'HEAD'];
  const out = await git(projectPath, args);
  failIfTimeout(out, args);
  if (!out.ok) return null;
  const head = out.stdout.trim();
  return head.length > 0 ? head : null;
}

export async function gitCommitExists(projectPath: string, sha: string, git: GitRunner = runGit): Promise<boolean> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  const args = ['cat-file', '-e', `${sha}^{commit}`];
  const out = await git(projectPath, args);
  failIfTimeout(out, args);
  return out.ok;
}

export function parsePorcelainZ(out: string): string[] {
  const records = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length > 0) paths.push(path);
    if (status.includes('R') || status.includes('C')) i += 1;
  }
  return paths;
}

export async function gitPorcelainPaths(projectPath: string, git: GitRunner = runGit): Promise<string[]> {
  const args = ['status', '--porcelain', '-z'];
  const out = await git(projectPath, args);
  failIfTimeout(out, args);
  if (!out.ok) return [];
  return parsePorcelainZ(out.stdout).filter((path) => !isArchmapDirPath(path));
}

export async function gitDiffNames(
  projectPath: string,
  from: string,
  to: string,
  git: GitRunner = runGit,
): Promise<string[]> {
  const args = ['diff', '--name-only', '-z', `${from}..${to}`];
  const out = await git(projectPath, args);
  failIfTimeout(out, args);
  if (!out.ok) return [];
  return out.stdout.split('\0').filter((path) => path.length > 0 && !isArchmapDirPath(path));
}

export async function gitRevListCounts(
  projectPath: string,
  indexed: string,
  head: string,
  git: GitRunner = runGit,
): Promise<{ ahead: number; behind: number } | null> {
  const args = ['rev-list', '--left-right', '--count', `${indexed}...${head}`];
  const out = await git(projectPath, args);
  failIfTimeout(out, args);
  if (!out.ok) return null;
  const match = /^(\d+)\s+(\d+)/.exec(out.stdout.trim());
  if (!match) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}
