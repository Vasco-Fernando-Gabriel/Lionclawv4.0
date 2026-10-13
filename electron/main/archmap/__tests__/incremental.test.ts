import { describe, expect, it } from 'vitest';
import { findMissingSymbols, requiredSymbols } from '../pipeline/incremental';
import type { ExtractedFile } from '../pipeline/types';

const P = 'apps/gateway/src/ports.ts';

function entry(functions: string[], classes: string[] = []): ExtractedFile {
  return {
    path: P,
    language: 'typescript',
    fileCategory: 'code',
    totalLines: 10,
    nonEmptyLines: 10,
    ...(functions.length > 0
      ? { functions: functions.map((name) => ({ name, startLine: 1, endLine: 2, params: [] })) }
      : {}),
    ...(classes.length > 0
      ? { classes: classes.map((name) => ({ name, startLine: 1, endLine: 2, methods: [], properties: [] })) }
      : {}),
    metrics: {},
  };
}

describe('SymbolLoss: simbolos exigidos sao os que o parser encontrou no snapshot', () => {
  it('arquivo extraido sem nenhum simbolo (versao anterior a classe) nao exige os simbolos do grafo antigo', () => {
    const required = requiredSymbols({ [P]: ['HiggsfieldPortError'] }, [entry([])]);
    expect(required).toEqual({});
  });

  it('arquivo ausente da extracao continua exigindo tudo (conservador)', () => {
    const required = requiredSymbols({ [P]: ['HiggsfieldPortError'] }, []);
    expect(required).toEqual({ [P]: ['HiggsfieldPortError'] });
    expect(findMissingSymbols(required, [])).toEqual({ [P]: ['HiggsfieldPortError'] });
  });

  it('simbolo presente na extracao e ausente da saida e perda; presente nos dois nao e', () => {
    const required = requiredSymbols({ [P]: ['HiggsfieldPortError', 'Sumiu'] }, [entry([], ['HiggsfieldPortError'])]);
    expect(required).toEqual({ [P]: ['HiggsfieldPortError'] });
    const nodes = [{ id: `class:${P}:HiggsfieldPortError`, type: 'class', name: 'HiggsfieldPortError', filePath: P }];
    expect(findMissingSymbols(required, nodes)).toEqual({});
    expect(findMissingSymbols(required, [])).toEqual({ [P]: ['HiggsfieldPortError'] });
  });
});
