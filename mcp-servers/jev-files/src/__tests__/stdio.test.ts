import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fingerprintFor } from '../../../_shared/jev-files-config';

const KEY = 'ts_STDIO_TEST_KEY_123';
const SALT = 'd'.repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BANNER = "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);";

let tmp = '';
let home = '';
let bundlePath = '';
let client: Client | null = null;

interface ToolText {
  error?: string;
  message?: string;
  stats: { callId: string };
  answers: unknown[];
  skipped: unknown[];
}

function parseTool(result: unknown): { isError: boolean; body: ToolText } {
  const r = result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) as ToolText };
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-files-stdio-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'data', 'jev-files.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      model: 'jev-1.13.0',
      roots: [tmp],
      credentialSalt: SALT,
      credentialFingerprint: fingerprintFor(SALT, KEY),
      updatedAt: new Date().toISOString(),
    }),
  );
  const esbuild = await import('esbuild');
  bundlePath = path.join(tmp, 'index.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
    banner: { js: BANNER },
    external: ['supports-color'],
    logLevel: 'silent',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath],
    env: { ...(process.env as Record<string, string>), LIONCLAW_HOME: home, TYPESAFE_JEV_API_KEY: KEY },
    stderr: 'pipe',
  });
  client = new Client({ name: 'jev-files-test', version: '0.0.0' });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ask_jev_files por stdio', () => {
  it('lista a ferramenta com o schema da secao 6', async () => {
    const tools = await client!.listTools();
    const tool = tools.tools.find((t) => t.name === 'ask_jev_files');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('QUANDO NAO USAR');
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(['targets', 'question', 'pick', 'threshold']);
  });

  it('chamada sem argumentos, targets em texto, targets com numero e question ausente voltam no contrato', async () => {
    const inputs: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { targets: 'x', question: { kind: 'bool', instructions: 'x' } },
      { targets: [1], question: { kind: 'bool', instructions: 'x' } },
      { targets: [path.join(tmp, 'a.ts')] },
      { targets: [path.join(tmp, 'a.ts')], question: { kind: 'bool', instructions: 'x' }, pick: 'sim' },
    ];
    for (const args of inputs) {
      const result = await client!.callTool({ name: 'ask_jev_files', arguments: args });
      const parsed = parseTool(result);
      expect(parsed.isError, JSON.stringify(args)).toBe(true);
      expect(parsed.body.error, JSON.stringify(args)).toBe('invalid_question');
      expect(parsed.body.stats.callId).toMatch(UUID_RE);
      expect(typeof parsed.body.message).toBe('string');
      expect(parsed.body.answers).toEqual([]);
      expect(parsed.body.skipped).toEqual([]);
    }
    const log = fs.readFileSync(path.join(home, 'workspaces', 'lionclaw', 'jev-files.jsonl'), 'utf8');
    const lines = log.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(inputs.length);
    expect(log).not.toContain(KEY);
  });

  it('alvo inexistente passa pela validacao e volta em skipped sem error de topo', async () => {
    const missing = path.join(tmp, 'nao-existe.ts');
    const result = parseTool(
      await client!.callTool({
        name: 'ask_jev_files',
        arguments: { targets: [missing], question: { kind: 'bool', instructions: 'x' } },
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.body.error).toBeUndefined();
    expect(result.body.skipped).toEqual([{ path: missing, reason: 'unreadable' }]);
  });

  it('ferramenta desconhecida responde erro legivel sem derrubar o servidor', async () => {
    const result = await client!.callTool({ name: 'outra', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const again = await client!.listTools();
    expect(again.tools).toHaveLength(1);
  });
});
