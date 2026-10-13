import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const INDEX_SRC = path.join(__dirname, '..', 'index.ts');

const GOLDEN_BUILTIN_IDS = [
  'memory-search',
  'jev-files',
  'excalidraw',
  'elevenlabs',
  'nano-banana',
  'shopify',
  'google-gmail',
  'google-drive',
  'google-sheets',
  'youtube',
  'google-calendar',
  'local-llm',
  'knowledge-base',
  'skills',
  'graph-search',
];

function builtinBlock(src: string): string {
  const start = src.indexOf('const builtinServers = [');
  const end = src.indexOf('];', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('lista de built-ins do boot', () => {
  const src = fs.readFileSync(INDEX_SRC, 'utf8');
  const block = builtinBlock(src);

  it('ids identicos ao golden (jev-files e a unica entrada nova, logo apos memory-search)', () => {
    const ids = [...block.matchAll(/^\s*id: '([^']+)',/gm)].map((m) => m[1]);
    expect(ids).toEqual(GOLDEN_BUILTIN_IDS);
  });

  it('jev-files recebe so a chave do Jev por env e isActive vem da decisao do arquivo de configuracao', () => {
    const entryStart = block.indexOf("id: 'jev-files'");
    const entry = block.slice(entryStart, block.indexOf('},', entryStart));
    expect(entry).toContain("envKeys: ['TYPESAFE_JEV_API_KEY']");
    expect(entry).toContain('isActive: resolveJevFileToolsRegistration().isActive');
    expect(entry).toContain('forceActive: true');
    expect(entry).toContain("dir: 'jev-files'");
  });

  it('nenhum outro built-in usa forceActive (a flag desligada mantem o comportamento de hoje para eles)', () => {
    expect(block.match(/forceActive: true/g)).toHaveLength(1);
  });

  it('jev-files.json e escrito antes do registro dos built-ins no boot', () => {
    const bootBody = src.slice(src.indexOf('initDatabase();'));
    const write = bootBody.indexOf('await writeJevFilesConfig()');
    const ensure = bootBody.indexOf('ensureBuiltinMCPServers()');
    expect(write).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(write);
  });
});
