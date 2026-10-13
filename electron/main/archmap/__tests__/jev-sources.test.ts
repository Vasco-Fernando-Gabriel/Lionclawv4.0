import { describe, expect, it, vi } from 'vitest';
import type { GitOutcome, GitRunner } from '../git';
import { gitTreeBlobs, isGitCommitRef, readGitBlob } from '../pipeline/jev-sources';
import { sourceHash } from '../pipeline/snapshot';

const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

function gitSpy(stdout: string): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git = vi.fn(async (_root: string, args: string[]): Promise<GitOutcome> => {
    calls.push(args);
    return { ok: true, stdout };
  }) as unknown as GitRunner;
  return { git, calls };
}

describe('GB-5: commit validado como hex antes de ir ao git', () => {
  it('aceita so hex minusculo de 7 a 40 caracteres', () => {
    expect(isGitCommitRef(COMMIT)).toBe(true);
    expect(isGitCommitRef('abcdef0')).toBe(true);
    expect(isGitCommitRef('abcdef')).toBe(false);
    expect(isGitCommitRef(`${COMMIT}0`)).toBe(false);
    expect(isGitCommitRef('--output=/tmp/x')).toBe(false);
    expect(isGitCommitRef('HEAD')).toBe(false);
    expect(isGitCommitRef('ABCDEF0')).toBe(false);
    expect(isGitCommitRef('')).toBe(false);
    expect(isGitCommitRef(undefined)).toBe(false);
    expect(isGitCommitRef(7)).toBe(false);
  });

  it('gitTreeBlobs e readGitBlob nao chamam o git com commit invalido', async () => {
    const { git, calls } = gitSpy('');
    for (const commit of ['--output=x', 'HEAD', 'abc', '']) {
      expect((await gitTreeBlobs('/repo', commit, git)).size).toBe(0);
      expect(await readGitBlob('/repo', commit, 'src/a.ts', sourceHash('x'), git)).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('com commit valido o git recebe so o hash e o caminho normalizado', async () => {
    const tree = gitSpy(`100644 blob 0123456789abcdef0123456789abcdef01234567\tsrc/a.ts\0`);
    const blobs = await gitTreeBlobs('/repo', COMMIT, tree.git);
    expect(blobs.get('src/a.ts')).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(tree.calls).toEqual([['ls-tree', '-r', '-z', COMMIT]]);

    const content = 'export const a = 1;\n';
    const show = gitSpy(content);
    expect(await readGitBlob('/repo', COMMIT, './src\\a.ts', sourceHash(content), show.git)).toBe(content);
    expect(show.calls).toEqual([['show', `${COMMIT}:src/a.ts`]]);
    expect(await readGitBlob('/repo', COMMIT, 'src/a.ts', sourceHash('outro'), show.git)).toBeNull();
  });
});
