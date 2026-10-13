import { describe, it, expect } from 'vitest';
import { globMaxDepth, globToRegExp, hasGlobChars, splitGlob } from '../glob';

describe('glob: divisao em base e padrao', () => {
  it('a base e a parte antes do primeiro * ? ou {, cortada no ultimo separador', () => {
    expect(splitGlob('C:\\proj\\src\\**\\*.ts')).toEqual({ baseDir: 'C:\\proj\\src\\', pattern: '**/*.ts' });
    expect(splitGlob('/proj/src/a*.ts')).toEqual({ baseDir: '/proj/src/', pattern: 'a*.ts' });
    expect(splitGlob('/proj/{a,b}/x.ts')).toEqual({ baseDir: '/proj/', pattern: '{a,b}/x.ts' });
    expect(splitGlob('/proj/src/a?.ts')).toEqual({ baseDir: '/proj/src/', pattern: 'a?.ts' });
    expect(splitGlob('*.ts')).toEqual({ baseDir: '', pattern: '*.ts' });
    expect(splitGlob('/proj/src/a.ts')).toBeNull();
    expect(hasGlobChars('/proj/src/a.ts')).toBe(false);
    expect(hasGlobChars('/proj/src/*.ts')).toBe(true);
  });
});

describe('glob: matcher proprio', () => {
  const m = (pattern: string, value: string, ci = false) => globToRegExp(pattern, ci).test(value);

  it('* nao cruza separador; ** cruza', () => {
    expect(m('*.ts', 'a.ts')).toBe(true);
    expect(m('*.ts', 'src/a.ts')).toBe(false);
    expect(m('**/*.ts', 'a.ts')).toBe(true);
    expect(m('**/*.ts', 'src/a.ts')).toBe(true);
    expect(m('**/*.ts', 'src/deep/er/a.ts')).toBe(true);
    expect(m('src/**', 'src/deep/a.ts')).toBe(true);
    expect(m('src/**', 'other/a.ts')).toBe(false);
    expect(m('src/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/x/a.ts')).toBe(false);
  });

  it('? e um caractere; {a,b} e alternativa, inclusive aninhada; chave sem par e literal', () => {
    expect(m('a?.ts', 'ab.ts')).toBe(true);
    expect(m('a?.ts', 'abc.ts')).toBe(false);
    expect(m('{a,b}.ts', 'a.ts')).toBe(true);
    expect(m('{a,b}.ts', 'c.ts')).toBe(false);
    expect(m('x.{ts,tsx}', 'x.tsx')).toBe(true);
    expect(m('{a,b{1,2}}.ts', 'b2.ts')).toBe(true);
    expect(m('{a.ts', '{a.ts')).toBe(true);
  });

  it('ponto e outros especiais sao literais; barra invertida vira barra', () => {
    expect(m('a.ts', 'axts')).toBe(false);
    expect(m('a+b.ts', 'a+b.ts')).toBe(true);
    expect(m('src\\*.ts', 'src/a.ts')).toBe(true);
  });

  it('maiusculas so com a flag de sistema sem distincao', () => {
    expect(m('*.TS', 'a.ts')).toBe(false);
    expect(m('*.TS', 'a.ts', true)).toBe(true);
  });

  it('profundidade maxima deriva do padrao', () => {
    expect(globMaxDepth('*.ts')).toBe(0);
    expect(globMaxDepth('src/*.ts')).toBe(1);
    expect(globMaxDepth('a/b/c/*.ts')).toBe(3);
    expect(globMaxDepth('**/*.ts')).toBe(Infinity);
  });
});
