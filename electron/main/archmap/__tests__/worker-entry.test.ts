import { describe, expect, it } from 'vitest';
import { join, resolve, sep } from 'node:path';
import {
  ARCHMAP_WORKER_ENTRY_BASENAME,
  resolveArchmapGrammarsDirForHost,
  resolveArchmapWorkerEntry,
  unpackedPath,
} from '../pipeline/worker-entry';
import { resolveArchmapGrammarsDir } from '../core/plugins/tree-sitter-plugin';

describe('resolucao do worker do mapa (dev e empacotado)', () => {
  it('em dev usa o arquivo ao lado do bundle principal', () => {
    const dir = resolve('/repo/dist/main');
    const expected = join(dir, ARCHMAP_WORKER_ENTRY_BASENAME);
    expect(resolveArchmapWorkerEntry(dir, undefined, (p) => p === expected, false)).toBe(expected);
    expect(resolveArchmapWorkerEntry(dir, resolve('/repo'), () => false, false)).toBe(expected);
  });

  it('GB-2: empacotado com asar troca app.asar por app.asar.unpacked e nunca aponta para dentro do asar', () => {
    const dir = resolve('/apps/LionClaw/resources/app.asar/dist/main');
    const unpacked = join(dir.replace('app.asar', 'app.asar.unpacked'), ARCHMAP_WORKER_ENTRY_BASENAME);
    const seen: string[] = [];
    const resolved = resolveArchmapWorkerEntry(
      dir,
      resolve('/apps/LionClaw/resources/app.asar'),
      (p) => {
        seen.push(p);
        return p === unpacked;
      },
      true,
    );
    expect(resolved).toBe(unpacked);
    expect(seen.some((p) => p.includes('app.asar.unpacked'))).toBe(true);
    expect(seen.some((p) => p.includes(`app.asar${sep}dist`))).toBe(false);
    expect(resolveArchmapWorkerEntry(dir, undefined, () => false, true)).toBe(unpacked);
  });

  it('GB-2: empacotado com asar: false usa resources/app/dist/main sem reescrever o caminho', () => {
    const dir = resolve('/apps/LionClaw/resources/app/dist/main');
    const expected = join(dir, ARCHMAP_WORKER_ENTRY_BASENAME);
    expect(resolveArchmapWorkerEntry(dir, resolve('/apps/LionClaw/resources/app'), (p) => p === expected, true)).toBe(
      expected,
    );
    expect(unpackedPath(expected)).toBe(expected);
  });

  it('cai para dist/main do appPath e, sem nada no disco, devolve o primeiro candidato', () => {
    const dir = resolve('/x/y');
    const appPath = resolve('/apps/LionClaw/resources/app.asar');
    const expected = join(
      appPath.replace('app.asar', 'app.asar.unpacked'),
      'dist',
      'main',
      ARCHMAP_WORKER_ENTRY_BASENAME,
    );
    expect(resolveArchmapWorkerEntry(dir, appPath, (p) => p === expected, true)).toBe(expected);
    expect(resolveArchmapWorkerEntry(dir, appPath, () => false, true)).toBe(join(dir, ARCHMAP_WORKER_ENTRY_BASENAME));
  });

  it('gramaticas vendoradas: pasta do app (unpacked primeiro) ou null sem appPath', () => {
    const appPath = resolve('/apps/LionClaw/resources/app.asar');
    const unpacked = join(
      appPath.replace('app.asar', 'app.asar.unpacked'),
      'electron',
      'main',
      'archmap',
      'core',
      'grammars',
    );
    expect(resolveArchmapGrammarsDirForHost(appPath, (p) => p === unpacked)).toBe(unpacked);
    expect(resolveArchmapGrammarsDirForHost(undefined)).toBeNull();
    expect(resolveArchmapGrammarsDir()).toBe(resolve(__dirname, '..', 'core', 'grammars'));
  });
});
