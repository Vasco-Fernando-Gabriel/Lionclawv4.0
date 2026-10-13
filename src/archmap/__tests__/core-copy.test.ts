import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER_CORE = join(__dirname, '..', 'core');
const MAIN_CORE = join(__dirname, '..', '..', '..', 'electron', 'main', 'archmap', 'core');
const COPIED = ['schema.ts', 'search.ts', 'types.ts'];

function normalized(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('src/archmap/core e copia byte a byte do core do main', () => {
  it.each(COPIED)('%s identico a electron/main/archmap/core', (file) => {
    expect(normalized(join(RENDERER_CORE, file))).toBe(normalized(join(MAIN_CORE, file)));
  });

  it('os modulos copiados nao importam nada do node nem do main', () => {
    for (const file of COPIED) {
      const source = normalized(join(RENDERER_CORE, file));
      const imports = [...source.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} importa ${spec}`).not.toMatch(/^(node:|fs|path|os|child_process|electron|\.\.\/)/);
      }
    }
  });
});
