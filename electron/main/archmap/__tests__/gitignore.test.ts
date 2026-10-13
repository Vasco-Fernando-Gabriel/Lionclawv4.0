import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHMAP_GITIGNORE_LINE, ensureArchmapGitignore, normalizeGitignoreLine } from '../gitignore';
import { makeTempDir, removeDir } from './helpers';

let root: string;

beforeEach(() => {
  root = makeTempDir();
});

afterEach(() => {
  removeDir(root);
});

function lines(): string[] {
  return readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
}

describe('ensureArchmapGitignore (AC-3)', () => {
  it('cria o .gitignore com /.lionclaw/ quando o arquivo nao existe', async () => {
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    const result = await ensureArchmapGitignore(root);
    expect(result.changed).toBe(true);
    expect(lines()).toContain(ARCHMAP_GITIGNORE_LINE);
  });

  it('acrescenta a linha preservando o conteudo existente e e idempotente', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist', 'utf8');
    const first = await ensureArchmapGitignore(root);
    expect(first.changed).toBe(true);
    expect(lines()).toEqual(['node_modules/', 'dist', ARCHMAP_GITIGNORE_LINE, '']);
    const before = readFileSync(join(root, '.gitignore'), 'utf8');
    const second = await ensureArchmapGitignore(root);
    expect(second.changed).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(before);
  });

  it('se a linha for apagada, volta na chamada seguinte', async () => {
    await ensureArchmapGitignore(root);
    writeFileSync(join(root, '.gitignore'), 'dist/\n', 'utf8');
    const again = await ensureArchmapGitignore(root);
    expect(again.changed).toBe(true);
    expect(lines()).toContain(ARCHMAP_GITIGNORE_LINE);
  });

  it.each(['.lionclaw/', '/.lionclaw', '.lionclaw', '/.lionclaw/', '.lionclaw/**', '/.lionclaw/**'])(
    'aceita a variante ja presente %s sem duplicar',
    async (variant) => {
      writeFileSync(join(root, '.gitignore'), `dist/\n${variant}\n`, 'utf8');
      const result = await ensureArchmapGitignore(root);
      expect(result.changed).toBe(false);
      expect(lines().filter((line) => line.includes('.lionclaw'))).toHaveLength(1);
    },
  );

  it('normaliza a linha ignorando barra inicial, barra final e /**', () => {
    for (const variant of ['/.lionclaw', '.lionclaw/', '/.lionclaw/', '.lionclaw/**', '  .lionclaw  ']) {
      expect(normalizeGitignoreLine(variant)).toBe('.lionclaw');
    }
    expect(normalizeGitignoreLine('.lionclaw-outra')).toBe('.lionclaw-outra');
  });

  it('respeita CRLF do arquivo existente', async () => {
    writeFileSync(join(root, '.gitignore'), 'dist/\r\nbuild/\r\n', 'utf8');
    await ensureArchmapGitignore(root);
    const raw = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(raw).toBe(`dist/\r\nbuild/\r\n${ARCHMAP_GITIGNORE_LINE}\r\n`);
  });
});
