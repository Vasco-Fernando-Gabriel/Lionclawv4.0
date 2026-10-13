import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARCHMAP_RUNTIME_IDS } from '../../../../src/types/archmap';
import {
  ARCHMAP_ALLOWED_TOOLS,
  ARCHMAP_DENIED_TOOL_SAMPLES,
  canonicalReadPath,
  createArchmapPermission,
  isEscapingPattern,
} from '../archmap-policy';
import { createArchmapToolDispatch } from '../archmap-tool-dispatch';
import type { ToolDecision } from '../../agent-runtime/types';
import {
  ARCHMAP_RUNTIME_CAPABILITIES,
  archmapGuaranteeLabel,
  archmapOverallGuaranteeLabel,
  archmapPendingGuarantees,
  archmapReadLabel,
  listArchmapRuntimeCapabilities,
} from '../runtime-capabilities';
import { ARCHMAP_GUARANTEE_NAMES } from '../../../../src/types/archmap';
import { makeTempDir, removeDir } from './helpers';

let base: string;
let scratch: string;
let outside: string;
let symlinkOut: string | null = null;
let symlinkIn: string | null = null;

beforeAll(() => {
  base = makeTempDir('lionclaw-archmap-policy-');
  scratch = join(base, 'scratch');
  outside = join(base, 'outside');
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(scratch, 'manifest.txt'), 'arquivo do rascunho\nsegunda linha\n', 'utf8');
  writeFileSync(join(outside, 'segredo.txt'), 'fora do rascunho\n', 'utf8');
  try {
    symlinkSync(join(outside, 'segredo.txt'), join(scratch, 'link-para-fora.txt'), 'file');
    symlinkOut = join(scratch, 'link-para-fora.txt');
  } catch {
    symlinkOut = null;
  }
  try {
    symlinkSync(join(scratch, 'manifest.txt'), join(scratch, 'link-interno.txt'), 'file');
    symlinkIn = join(scratch, 'link-interno.txt');
  } catch {
    symlinkIn = null;
  }
});

afterAll(() => {
  removeDir(base);
});

const canUse = async (name: string, input: Record<string, unknown>): Promise<ToolDecision> => {
  const permission = createArchmapPermission({ scratchDir: scratch, signal: new AbortController().signal });
  const decision = await permission.canUseTool!(name, input, { signal: new AbortController().signal } as never);
  return decision as ToolDecision;
};

describe('perfil do mapa (archmap-policy, AC-10 garantia)', () => {
  it('permite so Read, Glob e Grep', () => {
    expect([...ARCHMAP_ALLOWED_TOOLS]).toEqual(['Read', 'Glob', 'Grep']);
  });

  it.each([...ARCHMAP_DENIED_TOOL_SAMPLES])('nega a ferramenta %s', async (tool) => {
    const decision = await canUse(tool, { file_path: join(scratch, 'manifest.txt'), command: 'ls', url: 'https://x' });
    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' ? decision.message : '').toContain(tool);
  });

  it('nega escrita no rascunho, no repo e no home mesmo com caminho dentro do rascunho', async () => {
    for (const target of [join(scratch, 'result.json'), join(outside, 'x.txt'), resolve(base, '..', 'home.txt')]) {
      const write = await canUse('Write', { file_path: target, content: 'x' });
      const edit = await canUse('Edit', { file_path: target, old_string: 'a', new_string: 'b' });
      expect(write.behavior).toBe('deny');
      expect(edit.behavior).toBe('deny');
    }
  });

  it('permite Read dentro do rascunho (relativo e absoluto)', async () => {
    expect((await canUse('Read', { file_path: 'manifest.txt' })).behavior).toBe('allow');
    expect((await canUse('Read', { file_path: join(scratch, 'manifest.txt') })).behavior).toBe('allow');
    expect((await canUse('Glob', { pattern: '*.txt' })).behavior).toBe('allow');
    expect((await canUse('Grep', { pattern: 'rascunho', path: scratch })).behavior).toBe('allow');
  });

  it('nega leitura por caminho absoluto fora do rascunho e por ../ (AC-10 informacao: confinada)', async () => {
    const abs = await canUse('Read', { file_path: join(outside, 'segredo.txt') });
    expect(abs.behavior).toBe('deny');
    const rel = await canUse('Read', { file_path: '../outside/segredo.txt' });
    expect(rel.behavior).toBe('deny');
    const glob = await canUse('Glob', { pattern: '*', path: outside });
    expect(glob.behavior).toBe('deny');
    const grep = await canUse('Grep', { pattern: 'x', path: outside });
    expect(grep.behavior).toBe('deny');
  });

  it('nega Glob com pattern absoluto ou com ../ mesmo com path dentro do rascunho', async () => {
    for (const pattern of ['../outside/*', 'a/../../outside/*', join(outside, '*'), '/outside/*', 'C:/outside/*']) {
      const decision = await canUse('Glob', { pattern });
      expect(decision.behavior).toBe('deny');
    }
    expect((await canUse('Glob', { pattern: 'sub/../*.txt' })).behavior).toBe('deny');
    expect((await canUse('Glob', { pattern: '**/*.txt' })).behavior).toBe('allow');
    expect(isEscapingPattern('*.txt')).toBe(false);
    expect(isEscapingPattern('..\\x')).toBe(true);
  });

  it('nega link simbolico que aponta para fora do rascunho (quando o SO permite criar o link)', async () => {
    if (!symlinkOut) return;
    const decision = await canUse('Read', { file_path: symlinkOut });
    expect(decision.behavior).toBe('deny');
    await expect(canonicalReadPath(scratch, symlinkOut)).rejects.toThrow(/fora do rascunho/);
  });

  it('aceita link simbolico interno ao rascunho', async () => {
    if (!symlinkIn) return;
    expect((await canUse('Read', { file_path: symlinkIn })).behavior).toBe('allow');
  });

  it('nega tudo apos cancelamento', async () => {
    const controller = new AbortController();
    const permission = createArchmapPermission({ scratchDir: scratch, signal: controller.signal });
    controller.abort();
    const decision = (await permission.canUseTool!('Read', { file_path: 'manifest.txt' }, {
      signal: controller.signal,
    } as never)) as ToolDecision;
    expect(decision.behavior).toBe('deny');
  });
});

describe('dispatcher do mapa (archmap-tool-dispatch, local/external/Google GenAI)', () => {
  const dispatch = () => createArchmapToolDispatch({ scratchDir: scratch, signal: new AbortController().signal });

  it('le, lista e pesquisa dentro do rascunho', async () => {
    const read = await dispatch()('Read', { file_path: 'manifest.txt' });
    expect(read.isError).toBe(false);
    expect(read.result).toContain('arquivo do rascunho');
    const glob = await dispatch()('Glob', { pattern: '*.txt' });
    expect(glob.isError).toBe(false);
    expect(glob.result).toContain('manifest.txt');
    const grep = await dispatch()('Grep', { pattern: 'segunda', path: '.' });
    expect(grep.isError).toBe(false);
    expect(grep.result).toContain('manifest.txt');
  });

  it('responde erro para leitura fora do rascunho e para links que saem dele', async () => {
    const abs = await dispatch()('Read', { file_path: join(outside, 'segredo.txt') });
    expect(abs.isError).toBe(true);
    expect(abs.result).not.toContain('fora do rascunho\n');
    const glob = await dispatch()('Glob', { pattern: '*', path: outside });
    expect(glob.isError).toBe(true);
    if (symlinkOut) {
      const link = await dispatch()('Read', { file_path: symlinkOut });
      expect(link.isError).toBe(true);
    }
  });

  it.each([...ARCHMAP_DENIED_TOOL_SAMPLES])('responde erro para %s', async (tool) => {
    const result = await dispatch()(tool, { file_path: join(scratch, 'x.txt'), content: 'x', command: 'ls' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain(tool);
  });
});

describe('tabela de capacidades por runtime (runtime-capabilities)', () => {
  it('cobre todos os runtimes do mapa com as quatro garantias e um estado explicito em cada', () => {
    const list = listArchmapRuntimeCapabilities();
    expect(list.map((entry) => entry.runtime)).toEqual([...ARCHMAP_RUNTIME_IDS]);
    for (const entry of list) {
      expect(entry.mechanism.length).toBeGreaterThan(10);
      for (const name of ARCHMAP_GUARANTEE_NAMES) {
        expect(['provado', 'nao_provado', 'negado']).toContain(entry.guarantees[name].state);
        expect(entry.guarantees[name].reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('runtimes pelo perfil ou dispatcher tem as garantias provadas; codex prova so a escrita e deixa shell, rede e web pendentes ate a rodada real', () => {
    for (const runtime of ARCHMAP_RUNTIME_IDS) {
      const entry = ARCHMAP_RUNTIME_CAPABILITIES[runtime];
      if (runtime === 'codex') continue;
      expect(archmapPendingGuarantees(entry)).toEqual([]);
      expect(archmapOverallGuaranteeLabel(entry)).toBe('garantia provada');
    }
    const codex = ARCHMAP_RUNTIME_CAPABILITIES.codex;
    expect(codex.guarantees.write.state).toBe('provado');
    expect(codex.guarantees.network.state).toBe('nao_provado');
    expect(codex.guarantees.webTools.state).toBe('nao_provado');
    expect(codex.guarantees.webTools.reason).toContain('web_search="disabled"');
    expect(codex.guarantees.webTools.reason).toContain('nao provado sem rodada real');
    expect(codex.guarantees.shell.state).toBe('nao_provado');
    expect(codex.guarantees.shell.reason).toContain('shell');
    expect(archmapPendingGuarantees(codex)).toEqual(['shell', 'network', 'webTools']);
    expect(archmapOverallGuaranteeLabel(codex)).toBe('garantia pendente');
  });

  it('os tres estados de garantia tem rotulo proprio e negado prevalece sobre pendente', () => {
    expect(archmapGuaranteeLabel('provado')).toBe('garantia provada');
    expect(archmapGuaranteeLabel('nao_provado')).toBe('garantia pendente');
    expect(archmapGuaranteeLabel('negado')).toBe('garantia negada');
    const denied = {
      ...ARCHMAP_RUNTIME_CAPABILITIES.codex,
      guarantees: {
        ...ARCHMAP_RUNTIME_CAPABILITIES.codex.guarantees,
        shell: { state: 'negado' as const, reason: 'runtime nao bloqueia shell' },
      },
    };
    expect(archmapOverallGuaranteeLabel(denied)).toBe('garantia negada');
    expect(archmapPendingGuarantees(denied)).toContain('shell');
  });

  it('leitura confinada em todos menos codex (D8)', () => {
    for (const runtime of ARCHMAP_RUNTIME_IDS) {
      const expected = runtime === 'codex' ? 'free' : 'confined';
      expect(ARCHMAP_RUNTIME_CAPABILITIES[runtime].read).toBe(expected);
    }
    expect(archmapReadLabel('cloud')).toBe('leitura confinada');
    expect(archmapReadLabel('codex')).toBe('leitura livre');
    expect(archmapReadLabel(null)).toBe('runtime fora do mapa');
  });
});
