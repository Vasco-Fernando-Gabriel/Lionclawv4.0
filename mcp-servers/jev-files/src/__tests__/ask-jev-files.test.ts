import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fingerprintFor } from '../../../_shared/jev-files-config';
import { JEV_SYSTEM_ONE_URL } from '../../../_shared/jev-transport';
import { MAX_FILE_BYTES } from '../budget';
import { EXTENDED_PREFIX_MESSAGE } from '../contain';
import { MAX_WALK_ENTRIES } from '../expand';
import { PICK_NONE_ID } from '../pick';
import { handleAskJevFiles, type AskJevFilesDeps, type AskJevFilesResponse } from '../ask-jev-files';

const KEY_A = 'ts_SECRET_KEY_A_1234567890';
const KEY_B = 'ts_SECRET_KEY_B_0987654321';
const SALT = 'f'.repeat(64);
const SALT_2 = 'e'.repeat(64);
const MODEL = 'jev-1.13.0';
const FIXED_UUID = '11111111-2222-4333-8444-555555555555';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIN32 = process.platform === 'win32';

type FetchInit = { headers: Record<string, string>; body: string; signal: AbortSignal };
type FetchResponse = { ok: boolean; status: number; text: () => Promise<string> };
type FetchHandler = (url: string, init: FetchInit) => Promise<FetchResponse>;
type Body = {
  model: string;
  state: { path?: string; content?: string; question?: unknown; candidates?: unknown[] };
  questions: Record<string, Record<string, unknown>>;
};

let tmp = '';
let home = '';
let root = '';

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-files-tool-')));
  home = path.join(tmp, 'lionclaw-home');
  root = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(overrides: Record<string, unknown> = {}): void {
  const config = {
    version: 1,
    enabled: true,
    model: MODEL,
    roots: [root],
    credentialSalt: SALT,
    credentialFingerprint: fingerprintFor(SALT, KEY_A),
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(home, 'data', 'jev-files.json'), JSON.stringify(config));
}

function writeFile(rel: string, content: string | Buffer = 'export function alpha() { return 1; }\n'): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function response(status: number, text: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function bodyOf(init: FetchInit): Body {
  return JSON.parse(init.body) as Body;
}

function okAnswer(id: string, answer: Record<string, unknown>, usage: number | null = 500): FetchResponse {
  return response(
    200,
    JSON.stringify({
      model: MODEL,
      answers: { [id]: answer },
      ...(usage === null ? {} : { usage: { input_tokens: usage } }),
    }),
  );
}

function answering(answer: Record<string, unknown>, usage: number | null = 500) {
  return vi.fn<FetchHandler>(async () => okAnswer('q', answer, usage));
}

function router(handlers: {
  file: (filePath: string, body: Body, init: FetchInit) => Promise<FetchResponse> | FetchResponse;
  pick?: (body: Body, init: FetchInit) => Promise<FetchResponse> | FetchResponse;
}) {
  return vi.fn<FetchHandler>(async (_url, init) => {
    const body = bodyOf(init);
    if ('pick' in body.questions) {
      if (!handlers.pick) throw new Error('pick inesperado');
      return handlers.pick(body, init);
    }
    return handlers.file(body.state.path ?? '', body, init);
  });
}

function hanging(init: FetchInit): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal.aborted) fail();
    else init.signal.addEventListener('abort', fail, { once: true });
  });
}

interface Clock {
  t: number;
  now: () => number;
}

function clock(start = 1_000): Clock {
  const c: Clock = { t: start, now: () => c.t };
  return c;
}

interface DepsOptions {
  key?: string | null;
  fetchImpl?: FetchHandler;
  fsImpl?: AskJevFilesDeps['fs'];
  now?: () => number;
  parallel?: number;
  requestTimeoutMs?: number;
  callDeadlineMs?: number;
  env?: Record<string, string>;
  randomUUID?: () => string;
}

function makeDeps(opts: DepsOptions = {}): AskJevFilesDeps {
  const key = opts.key === undefined ? KEY_A : opts.key;
  const env = { LIONCLAW_HOME: home, ...(key === null ? {} : { TYPESAFE_JEV_API_KEY: key }), ...(opts.env ?? {}) };
  let tick = 1_000;
  const fetchImpl = opts.fetchImpl ?? vi.fn<FetchHandler>(async () => response(500, 'nao era para chamar'));
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: opts.now ?? (() => (tick += 7)),
    homeDir: path.join(tmp, 'unused-home'),
    env,
    fs: opts.fsImpl ?? fs,
    apiKey: key,
    randomUUID: opts.randomUUID ?? (() => FIXED_UUID),
    stderr: vi.fn(),
    parallel: opts.parallel,
    requestTimeoutMs: opts.requestTimeoutMs,
    callDeadlineMs: opts.callDeadlineMs,
  };
}

const boolQuestion = { kind: 'bool', instructions: 'o arquivo exporta a funcao alpha?' };

async function ask(deps: AskJevFilesDeps, input: unknown): Promise<AskJevFilesResponse> {
  return handleAskJevFiles(input, deps);
}

function fetchMock(deps: AskJevFilesDeps): ReturnType<typeof vi.fn<FetchHandler>> {
  return deps.fetchImpl as unknown as ReturnType<typeof vi.fn<FetchHandler>>;
}

function fetchCalls(deps: AskJevFilesDeps): number {
  return fetchMock(deps).mock.calls.length;
}

function readLog(): Array<Record<string, unknown>> {
  const file = path.join(home, 'workspaces', 'lionclaw', 'jev-files.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function skippedOf(result: AskJevFilesResponse): Record<string, string> {
  return Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));
}

describe('ask_jev_files: configuracao e credencial', () => {
  it('jev-files.json ausente => disabled sem request, com callId', async () => {
    const deps = makeDeps();
    const result = await ask(deps, { targets: [writeFile('a.ts')], question: boolQuestion });
    expect(result.error).toBe('disabled');
    expect(result.answers).toEqual([]);
    expect(result.picked).toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.stats.callId).toBe(FIXED_UUID);
    expect(fetchCalls(deps)).toBe(0);
  });

  it('jev-files.json invalido => config_invalid sem request', async () => {
    fs.writeFileSync(path.join(home, 'data', 'jev-files.json'), '{"version":1');
    const deps = makeDeps();
    const result = await ask(deps, { targets: [writeFile('a.ts')], question: boolQuestion });
    expect(result.error).toBe('config_invalid');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('enabled:false => disabled sem request, mesmo com chave e fingerprint certos', async () => {
    writeConfig({ enabled: false });
    const deps = makeDeps();
    expect((await ask(deps, { targets: [writeFile('a.ts')], question: boolQuestion })).error).toBe('disabled');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('sem chave no env => no_key', async () => {
    writeConfig();
    const deps = makeDeps({ key: null });
    expect((await ask(deps, { targets: [writeFile('a.ts')], question: boolQuestion })).error).toBe('no_key');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('fingerprint null ou de outra chave => stale_process mesmo com enabled:true', async () => {
    const file = writeFile('a.ts');
    writeConfig({ credentialFingerprint: null });
    const deps = makeDeps();
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBe('stale_process');
    writeConfig({ credentialFingerprint: fingerprintFor(SALT, KEY_B) });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBe('stale_process');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('troca da chave entre chamadas com o processo vivo: ok, stale_process, ok de novo ao recadastrar', async () => {
    writeConfig();
    const file = writeFile('a.ts');
    const deps = makeDeps({ fetchImpl: answering({ noul: 0.95 }) });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBeUndefined();
    writeConfig({ credentialFingerprint: fingerprintFor(SALT, KEY_B) });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBe('stale_process');
    writeConfig({ credentialFingerprint: null });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBe('stale_process');
    writeConfig();
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBeUndefined();
    expect(fetchCalls(deps)).toBe(2);
  });

  it('salt regenerado com a mesma chave continua valido: a impressao e recalculada a cada chamada', async () => {
    writeConfig();
    const file = writeFile('a.ts');
    const deps = makeDeps({ fetchImpl: answering({ noul: 0.95 }) });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBeUndefined();
    writeConfig({ credentialSalt: SALT_2, credentialFingerprint: fingerprintFor(SALT_2, KEY_A) });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBeUndefined();
    writeConfig({ credentialSalt: SALT_2, credentialFingerprint: fingerprintFor(SALT, KEY_A) });
    expect((await ask(deps, { targets: [file], question: boolQuestion })).error).toBe('stale_process');
  });

  it('processo que nasceu com a chave antiga e le o arquivo ja trocado => stale_process', async () => {
    writeConfig({ credentialFingerprint: fingerprintFor(SALT, KEY_B) });
    const deps = makeDeps({ key: KEY_A });
    expect((await ask(deps, { targets: [writeFile('a.ts')], question: boolQuestion })).error).toBe('stale_process');
  });

  it('a resposta nunca carrega a chave', async () => {
    writeConfig();
    const deps = makeDeps({
      fetchImpl: vi.fn<FetchHandler>(async () => {
        throw new Error(`rede caiu com ${KEY_A}`);
      }),
    });
    const result = await ask(deps, { targets: [writeFile('a.ts')], question: boolQuestion });
    expect(result.error).toBe('jev_http');
    expect(JSON.stringify(result)).not.toContain(KEY_A);
    expect(result.message).toContain('[chave]');
  });
});

describe('ask_jev_files: validacao da pergunta', () => {
  beforeEach(() => writeConfig());

  it.each<[string, unknown]>([
    ['entrada nao objeto', 'x'],
    ['sem targets', { targets: [], question: boolQuestion }],
    ['target vazio', { targets: ['  '], question: boolQuestion }],
    ['kind desconhecido', { targets: ['/x'], question: { kind: 'maybe', instructions: 'x' } }],
    ['sem instructions', { targets: ['/x'], question: { kind: 'bool' } }],
    ['noAt >= yesAt', { targets: ['/x'], question: { ...boolQuestion, thresholds: { yesAt: 0.5, noAt: 0.5 } } }],
    ['yesAt > 1', { targets: ['/x'], question: { ...boolQuestion, thresholds: { yesAt: 1.1 } } }],
    ['noAt < 0', { targets: ['/x'], question: { ...boolQuestion, thresholds: { noAt: -0.1 } } }],
    ['criteria incompleto', { targets: ['/x'], question: { ...boolQuestion, criteria: { true: 'sim' } } }],
    ['choice com 1 opcao', { targets: ['/x'], question: { kind: 'choice', instructions: 'x', options: { a: 'a' } } }],
    [
      'choice com 21 opcoes',
      {
        targets: ['/x'],
        question: {
          kind: 'choice',
          instructions: 'x',
          options: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, 'd'])),
        },
      },
    ],
    [
      'choice com unknown',
      { targets: ['/x'], question: { kind: 'choice', instructions: 'x', options: { a: 'a', unknown: 'u' } } },
    ],
    [
      'choice com none',
      { targets: ['/x'], question: { kind: 'choice', instructions: 'x', options: { a: 'a', none: 'n' } } },
    ],
    [
      'choice com id invalido',
      { targets: ['/x'], question: { kind: 'choice', instructions: 'x', options: { a: 'a', 'B-c': 'b' } } },
    ],
    [
      'choice com descricao vazia',
      { targets: ['/x'], question: { kind: 'choice', instructions: 'x', options: { a: 'a', b: '' } } },
    ],
    [
      'negativeOption fora das opcoes',
      {
        targets: ['/x'],
        question: { kind: 'choice', instructions: 'x', options: { a: 'a', b: 'b' }, negativeOption: 'c' },
      },
    ],
    ['score com 1 nivel', { targets: ['/x'], question: { kind: 'score', instructions: 'x', levels: ['so'] } }],
    [
      'score com 11 niveis',
      {
        targets: ['/x'],
        question: { kind: 'score', instructions: 'x', levels: Array.from({ length: 11 }, (_, i) => `n${i}`) },
      },
    ],
    [
      'minScore fora de 0..n-1',
      { targets: ['/x'], question: { kind: 'score', instructions: 'x', levels: ['a', 'b', 'c'], minScore: 3 } },
    ],
    [
      'pick com score sem minScore',
      { targets: ['/x'], question: { kind: 'score', instructions: 'x', levels: ['a', 'b'] }, pick: true },
    ],
    ['threshold fora de 0..1', { targets: ['/x'], question: boolQuestion, threshold: 1.5 }],
    ['threshold texto', { targets: ['/x'], question: boolQuestion, threshold: '0.5' }],
    ['pick nao booleano', { targets: ['/x'], question: boolQuestion, pick: 'sim' }],
  ])('%s => invalid_question sem request, com callId', async (_label, input) => {
    const deps = makeDeps();
    const result = await ask(deps, input);
    expect(result.error).toBe('invalid_question');
    expect(typeof result.message).toBe('string');
    expect(result.stats.callId).toBe(FIXED_UUID);
    expect(fetchCalls(deps)).toBe(0);
  });
});

describe('ask_jev_files: contencao e orcamento (skipped)', () => {
  beforeEach(() => writeConfig());

  async function expectSkipped(input: unknown, reason: string): Promise<AskJevFilesResponse> {
    const deps = makeDeps();
    const result = await ask(deps, input);
    expect(result.error).toBeUndefined();
    expect(result.answers).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe(reason);
    expect(result.stats.requests).toBe(0);
    expect(result.stats.charsRead).toBe(0);
    expect(fetchCalls(deps)).toBe(0);
    return result;
  }

  it('relativo => relative_path', async () => {
    const result = await expectSkipped({ targets: ['src/a.ts'], question: boolQuestion }, 'relative_path');
    expect(result.message).toContain('absoluto');
  });

  it('prefixo estendido => unreadable com mensagem propria, sem virar glob', async () => {
    writeFile('a.ts');
    const result = await expectSkipped({ targets: [`\\\\?\\${root}\\a.ts`], question: boolQuestion }, 'unreadable');
    expect(result.message).toBe(EXTENDED_PREFIX_MESSAGE);
    const dot = await expectSkipped({ targets: [`\\\\.\\${root}\\*.ts`], question: boolQuestion }, 'unreadable');
    expect(dot.message).toBe(EXTENDED_PREFIX_MESSAGE);
  });

  it.runIf(WIN32)('win32: fluxo alternativo .env::$DATA => sensitive', async () => {
    writeFile('.env', 'A=1');
    await expectSkipped({ targets: [`${path.join(root, '.env')}::$DATA`], question: boolQuestion }, 'sensitive');
  });

  it('fora das raizes => outside_roots', async () => {
    const outside = path.join(tmp, 'fora.ts');
    fs.writeFileSync(outside, 'x');
    await expectSkipped({ targets: [outside], question: boolQuestion }, 'outside_roots');
  });

  it('link para fora => outside_roots', async () => {
    const outsideDir = path.join(tmp, 'fora');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'x.ts'), 'x');
    fs.symlinkSync(outsideDir, path.join(root, 'link'), 'junction');
    await expectSkipped({ targets: [path.join(root, 'link', 'x.ts')], question: boolQuestion }, 'outside_roots');
  });

  it('sensivel pelo nome pedido e pelo real', async () => {
    await expectSkipped({ targets: [writeFile('.env', 'A=1')], question: boolQuestion }, 'sensitive');
    await expectSkipped({ targets: [writeFile('.envrc', 'x')], question: boolQuestion }, 'sensitive');
    await expectSkipped({ targets: [writeFile('node_modules/x.js')], question: boolQuestion }, 'sensitive');
    writeFile('.aws/config', '[default]');
    fs.symlinkSync(path.join(root, '.aws'), path.join(root, 'limpo'), 'junction');
    await expectSkipped({ targets: [path.join(root, 'limpo', 'config')], question: boolQuestion }, 'sensitive');
  });

  it('binario por extensao, byte nulo e bytes de controle', async () => {
    await expectSkipped({ targets: [writeFile('logo.png', 'texto')], question: boolQuestion }, 'binary');
    await expectSkipped(
      { targets: [writeFile('nulo.txt', Buffer.from([0x61, 0x00, 0x62]))], question: boolQuestion },
      'binary',
    );
    const controls = Buffer.concat([Buffer.alloc(20, 0x02), Buffer.from('x'.repeat(80))]);
    await expectSkipped({ targets: [writeFile('ctrl.txt', controls)], question: boolQuestion }, 'binary');
  });

  it('vazio => empty', async () => {
    await expectSkipped({ targets: [writeFile('vazio.ts', '')], question: boolQuestion }, 'empty');
  });

  it('acima de 110.000 bytes => too_large sem abrir o arquivo', async () => {
    const file = writeFile('grande.ts', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    const open = vi.fn(fs.promises.open);
    const readFile = vi.fn(fs.promises.readFile);
    const fsImpl: AskJevFilesDeps['fs'] = { readFileSync: fs.readFileSync, promises: { ...fs.promises, open } };
    const deps = makeDeps({ fsImpl });
    const result = await ask(deps, { targets: [file], question: boolQuestion });
    expect(result.skipped).toEqual([{ path: file, reason: 'too_large' }]);
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchCalls(deps)).toBe(0);
  });

  it('payload completo acima de 28.000 tokens (arquivo + pergunta) => too_large sem request', async () => {
    const file = writeFile('quase.ts', 'a'.repeat(MAX_FILE_BYTES));
    await expectSkipped({ targets: [file], question: { kind: 'bool', instructions: 'p'.repeat(3_000) } }, 'too_large');
  });

  it('inexistente => unreadable com mensagem do sistema', async () => {
    const result = await expectSkipped({ targets: [path.join(root, 'nao.ts')], question: boolQuestion }, 'unreadable');
    expect(result.message).toMatch(/ENOENT/);
  });
});

describe('ask_jev_files: expansao de alvos', () => {
  beforeEach(() => writeConfig());

  function countingFetch() {
    return router({ file: () => okAnswer('q', { noul: 0.9 }, 10) });
  }

  it('lista de arquivos => uma resposta por arquivo, um request cada, stats.files = enviados e eligible', async () => {
    const files = [writeFile('a.ts'), writeFile('b.ts'), writeFile('c.ts')];
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: files, question: boolQuestion });
    expect(result.answers.map((a) => a.path).sort()).toEqual([...files].sort());
    expect(result.stats.files).toBe(3);
    expect(result.stats.eligible).toBe(3);
    expect(result.stats.requests).toBe(3);
    expect(result.stats.inputTokens).toBe(30);
    expect(fetchCalls(deps)).toBe(3);
  });

  it('o mesmo arquivo pedido duas vezes ou por grafias diferentes conta uma vez (dedupe pelo caminho real)', async () => {
    const file = writeFile('a.ts');
    const spelled = path.join(root, '.', 'sub', '..', 'a.ts');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [file, file, spelled], question: boolQuestion });
    expect(result.answers).toHaveLength(1);
    expect(result.stats.files).toBe(1);
    expect(fetchCalls(deps)).toBe(1);
  });

  it.runIf(WIN32)('win32: grafia com maiusculas diferentes e o mesmo arquivo', async () => {
    const file = writeFile('a.ts');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [file, file.toUpperCase()], question: boolQuestion });
    expect(result.answers).toHaveLength(1);
  });

  it('glob ** desce em subpastas; glob de um nivel nao desce', async () => {
    const a = writeFile('src/a.ts');
    const b = writeFile('src/deep/b.ts');
    writeFile('src/c.md');
    writeFile('src/node_modules/d.ts');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const all = await ask(deps, { targets: [path.join(root, 'src', '**', '*.ts')], question: boolQuestion });
    expect(all.answers.map((x) => x.path).sort()).toEqual([a, b].sort());
    expect(all.skipped).toEqual([]);
    const flat = await ask(deps, { targets: [path.join(root, 'src', '*.ts')], question: boolQuestion });
    expect(flat.answers.map((x) => x.path)).toEqual([a]);
  });

  it('glob com base fora da raiz => outside_roots; base relativa => relative_path; base que e arquivo => unreadable', async () => {
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const outside = await ask(deps, { targets: [path.join(tmp, '**', '*.ts')], question: boolQuestion });
    expect(outside.skipped).toEqual([{ path: path.join(tmp, '**', '*.ts'), reason: 'outside_roots' }]);
    const relative = await ask(deps, { targets: ['src/**/*.ts'], question: boolQuestion });
    expect(relative.skipped[0].reason).toBe('relative_path');
    const file = writeFile('a.ts');
    const asBase = await ask(deps, { targets: [path.join(file, '*.ts')], question: boolQuestion });
    expect(asBase.skipped[0].reason).toBe('unreadable');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('pasta e percorrida recursivamente; pastas da politica nao sao visitadas; arquivos recusados voltam em skipped', async () => {
    const a = writeFile('proj/a.ts');
    const b = writeFile('proj/sub/b.ts');
    writeFile('proj/node_modules/x.js');
    writeFile('proj/.git/config');
    const env = writeFile('proj/.env', 'A=1');
    const png = writeFile('proj/logo.png', 'x');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [path.join(root, 'proj')], question: boolQuestion });
    expect(result.answers.map((x) => x.path).sort()).toEqual([a, b].sort());
    expect(skippedOf(result)).toEqual({ [env]: 'sensitive', [png]: 'binary' });
    expect(result.stats.truncated).toBe(false);
  });

  it('pasta cujo nome e da politica e recusada como sensitive', async () => {
    writeFile('dist/a.ts');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [path.join(root, 'dist')], question: boolQuestion });
    expect(result.skipped).toEqual([{ path: path.join(root, 'dist'), reason: 'sensitive' }]);
    expect(fetchCalls(deps)).toBe(0);
  });

  it('profundidade acima de 12 => depth_limit por pasta truncada e stats.truncated', async () => {
    const segments = Array.from({ length: 14 }, (_, i) => `d${i}`);
    const deepFile = writeFile(path.join(...segments, 'deep.ts'));
    const shallow = writeFile('d0/shallow.ts');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [root], question: boolQuestion });
    expect(result.answers.map((x) => x.path)).toEqual([shallow]);
    expect(result.answers.map((x) => x.path)).not.toContain(deepFile);
    expect(result.skipped).toEqual([{ path: path.join(root, ...segments.slice(0, 13)), reason: 'depth_limit' }]);
    expect(result.stats.truncated).toBe(true);
  });

  it('acima de 5.000 entradas visitadas => too_many_entries para a chamada inteira', async () => {
    const dirent = (name: string) => ({
      name,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    });
    const many = Array.from({ length: MAX_WALK_ENTRIES + 1 }, (_, i) => dirent(`f${i}.ts`));
    const fsImpl = {
      readFileSync: fs.readFileSync,
      promises: { ...fs.promises, readdir: async () => many },
    } as unknown as AskJevFilesDeps['fs'];
    const deps = makeDeps({ fsImpl, fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [root], question: boolQuestion });
    expect(result.error).toBe('too_many_entries');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('acima de 100 arquivos elegiveis => too_many_files sem request', async () => {
    for (let i = 0; i < 101; i++) writeFile(`many/f${i}.ts`);
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [path.join(root, 'many')], question: boolQuestion });
    expect(result.error).toBe('too_many_files');
    expect(result.message).toContain('101');
    expect(fetchCalls(deps)).toBe(0);
  });

  it('exatamente 100 arquivos passam', async () => {
    for (let i = 0; i < 100; i++) writeFile(`cem/f${i}.ts`);
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [path.join(root, 'cem')], question: boolQuestion });
    expect(result.error).toBeUndefined();
    expect(result.answers).toHaveLength(100);
  });
});

describe('ask_jev_files: achados do validador da sprint 2', () => {
  beforeEach(() => writeConfig());

  function countingFetch() {
    return router({ file: () => okAnswer('q', { noul: 0.9 }, 10) });
  }

  it('arquivo com {, }, * ou ? no nome e lido como alvo direto e dentro de pasta, nunca some da resposta', async () => {
    const names = WIN32 ? ['a{1}.ts', 'b{x,y}.ts'] : ['a{1}.ts', 'b*.ts', 'c?.ts'];
    const files = names.map((name) => writeFile(`estranhos/${name}`));
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const direct = await ask(deps, { targets: files, question: boolQuestion });
    expect(direct.answers.map((x) => x.path).sort()).toEqual([...files].sort());
    expect(direct.skipped).toEqual([]);
    const folder = await ask(deps, { targets: [path.join(root, 'estranhos')], question: boolQuestion });
    expect(folder.answers.map((x) => x.path).sort()).toEqual([...files].sort());
    expect(folder.skipped).toEqual([]);
    const missing = path.join(root, 'estranhos', 'z{2}.ts');
    const gone = await ask(deps, { targets: [missing], question: boolQuestion });
    expect(gone.answers).toEqual([]);
    expect(gone.skipped).toEqual([{ path: missing, reason: 'unreadable' }]);
    expect(gone.message).toContain('nenhum arquivo casou');
  });

  it('link de pasta em loop nao e percorrido de novo: sem skipped poluido, sem truncated, sem too_many_entries', async () => {
    const a = writeFile('loop/a.ts');
    fs.symlinkSync(path.join(root, 'loop'), path.join(root, 'loop', 'volta'), 'junction');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [path.join(root, 'loop')], question: boolQuestion });
    expect(result.error).toBeUndefined();
    expect(result.answers.map((x) => x.path)).toEqual([a]);
    expect(result.skipped).toEqual([]);
    expect(result.stats.truncated).toBe(false);
  });

  it('dois globs sobre a mesma base funcionam, com dedupe so por arquivo', async () => {
    const ts = writeFile('dup/a.ts');
    const md = writeFile('dup/b.md');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, {
      targets: [path.join(root, 'dup', '*.ts'), path.join(root, 'dup', '*.md'), path.join(root, 'dup', '*')],
      question: boolQuestion,
    });
    expect(result.answers.map((x) => x.path).sort()).toEqual([ts, md].sort());
    expect(fetchCalls(deps)).toBe(2);
  });

  it('.lionclaw/data nao e visitada no percurso; .lionclaw/workspaces e', async () => {
    const ws = writeFile('.lionclaw/workspaces/a.ts');
    writeFile('.lionclaw/data/segredo.json', '{}');
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [path.join(root, '.lionclaw')], question: boolQuestion });
    expect(result.answers.map((x) => x.path)).toEqual([ws]);
    expect(result.skipped).toEqual([]);
  });

  it('raiz cujo nome e da politica (build) pode ser alvo como pasta', async () => {
    const buildRoot = path.join(tmp, 'build');
    fs.mkdirSync(buildRoot);
    fs.writeFileSync(path.join(buildRoot, 'a.ts'), 'x');
    writeConfig({ roots: [buildRoot] });
    const deps = makeDeps({ fetchImpl: countingFetch() });
    const result = await ask(deps, { targets: [buildRoot], question: boolQuestion });
    expect(result.answers.map((x) => x.path)).toEqual([path.join(buildRoot, 'a.ts')]);
    const nested = await ask(deps, { targets: [path.join(buildRoot, 'a.ts')], question: boolQuestion });
    expect(nested.answers).toHaveLength(1);
  });

  it('message de topo vem da falha que gerou error, nao do primeiro skipped', async () => {
    const env = writeFile('.env', 'A=1');
    const b = writeFile('b.ts');
    const fetchImpl = router({ file: () => response(503, 'down') });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [env, b], question: boolQuestion });
    expect(result.error).toBe('jev_http');
    expect(result.message).toContain('503');
    expect(result.message).not.toContain('sensiveis');
    expect(skippedOf(result)).toEqual({ [env]: 'sensitive', [b]: 'jev_error' });
  });

  it('now() hostil no meio da chamada nao derruba nem gera wallMs negativo', async () => {
    const file = writeFile('a.ts');
    let calls = 0;
    const now = () => {
      calls++;
      if (calls > 2) throw new Error('relogio quebrou');
      return 1_000;
    };
    const result = await ask(makeDeps({ fetchImpl: answering({ noul: 0.9 }), now }), {
      targets: [file],
      question: boolQuestion,
    });
    expect(result.error).toBeUndefined();
    expect(result.answers).toHaveLength(1);
    expect(result.stats.wallMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ask_jev_files: correcoes do gate', () => {
  beforeEach(() => writeConfig());

  const contextResponse = () => response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }));

  it('todos os elegiveis em context e nenhuma resposta => error jev_context com a mensagem do Jev', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const result = await ask(makeDeps({ fetchImpl: router({ file: () => contextResponse() }) }), {
      targets: [a, b],
      question: boolQuestion,
    });
    expect(result.error).toBe('jev_context');
    expect(result.message).toContain('max_tokens_exceeded');
    expect(skippedOf(result)).toEqual({ [a]: 'context', [b]: 'context' });
    expect(result.stats.files).toBe(2);
    expect(result.stats.eligible).toBe(2);
  });

  it('mistura de context com outro erro do Jev sem resposta mantem o primeiro erro de Jev', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const fetchImpl = router({ file: (p) => (p === a ? contextResponse() : response(503, 'down')) });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion });
    expect(result.error).toBe('jev_http');
    expect(skippedOf(result)).toEqual({ [a]: 'context', [b]: 'jev_error' });
  });

  it('context em um arquivo com outro respondido nao e error', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const fetchImpl = router({ file: (p) => (p === a ? contextResponse() : okAnswer('q', { noul: 0.9 })) });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion });
    expect(result.error).toBeUndefined();
    expect(result.stats.files).toBe(2);
  });

  it('stats.files conta so enviados ao Jev; stats.eligible conta os que passaram pela contencao', async () => {
    const answered = writeFile('ok.ts');
    const large = writeFile('grande.ts', 'a'.repeat(MAX_FILE_BYTES + 1));
    const env = writeFile('.env', 'A=1');
    const empty = writeFile('vazio.ts', '');
    const result = await ask(makeDeps({ fetchImpl: router({ file: () => okAnswer('q', { noul: 0.9 }) }) }), {
      targets: [answered, large, env, empty],
      question: boolQuestion,
    });
    expect(result.answers).toHaveLength(1);
    expect(result.stats.files).toBe(1);
    expect(result.stats.eligible).toBe(3);
    expect(skippedOf(result)).toEqual({ [large]: 'too_large', [env]: 'sensitive', [empty]: 'empty' });
    const line = readLog()[0];
    expect(line.files).toBe(1);
    expect(line.eligible).toBe(3);
  });

  it('prazo total: deadline conta como enviado; nao iniciado nao conta', async () => {
    const files = [writeFile('t/a.ts'), writeFile('t/b.ts')];
    const c = clock(0);
    const fetchImpl = router({
      file: () => {
        c.t += 50_000;
        return okAnswer('q', { noul: 0.9 });
      },
    });
    const result = await ask(makeDeps({ fetchImpl, now: c.now, parallel: 1 }), {
      targets: files,
      question: boolQuestion,
    });
    expect(result.answers).toHaveLength(1);
    expect(result.stats.eligible).toBe(2);
    expect(result.stats.files).toBe(2);
  });

  it('pick usa ids opacos f1..fn: caminho com espaco e unicode volta exato em picked', async () => {
    const weird = writeFile('pasta com espaco/arquivo-acao-cafe.ts');
    const plain = writeFile('plain.ts');
    let pickCriteria: Record<string, string> | null = null;
    const fetchImpl = router({
      file: (p) => okAnswer('q', { noul: p === weird ? 0.95 : 0.9 }),
      pick: (body) => {
        pickCriteria = body.questions.pick.criteria as Record<string, string>;
        return okAnswer('pick', { choice: 'f1', confidence: 0.9, probabilities: { f1: 0.9, f2: 0.1 } });
      },
    });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [plain, weird], question: boolQuestion, pick: true });
    expect(Object.keys(pickCriteria as unknown as Record<string, string>)).toEqual(['f1', 'f2', PICK_NONE_ID]);
    expect(result.picked).toEqual({ path: weird, confidence: 0.9 });
    expect(result.pickReason).toBe('chosen');
  });

  it('pick que devolve id fora do conjunto => pickReason error, nunca um caminho inventado', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const fetchImpl = router({
      file: () => okAnswer('q', { noul: 0.9 }),
      pick: () => okAnswer('pick', { choice: 'f9', confidence: 0.99, probabilities: {} }),
    });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion, pick: true });
    expect(result.picked).toBeNull();
    expect(result.pickReason).toBe('error');
    expect(result.error).toBeUndefined();
    expect(result.answers).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('f9');
  });
});

describe('ask_jev_files: paralelismo e prazos', () => {
  beforeEach(() => writeConfig());

  it('ate 8 requests em voo ao mesmo tempo', async () => {
    const files = Array.from({ length: 20 }, (_, i) => writeFile(`p/f${i}.ts`));
    let active = 0;
    let peak = 0;
    const fetchImpl = router({
      file: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return okAnswer('q', { noul: 0.9 });
      },
    });
    const deps = makeDeps({ fetchImpl });
    const result = await ask(deps, { targets: files, question: boolQuestion });
    expect(result.answers).toHaveLength(20);
    expect(peak).toBe(8);
  });

  it('prazo por request vira jev_error + error jev_timeout, sem partial', async () => {
    const file = writeFile('a.ts');
    const deps = makeDeps({ fetchImpl: router({ file: (_p, _b, init) => hanging(init) }), requestTimeoutMs: 20 });
    const result = await ask(deps, { targets: [file], question: boolQuestion });
    expect(result.error).toBe('jev_timeout');
    expect(result.skipped).toEqual([{ path: file, reason: 'jev_error' }]);
    expect(result.stats.partial).toBe(false);
    expect(result.stats.requests).toBe(1);
  });

  it('prazo total ja vencido na entrada aborta sincronamente: zero fetch, deadline, partial', async () => {
    const file = writeFile('a.ts');
    const c = clock(0);
    let calls = 0;
    c.now = () => (++calls <= 1 ? 0 : 60_000);
    const deps = makeDeps({ fetchImpl: router({ file: () => okAnswer('q', { noul: 0.9 }) }), now: c.now });
    const result = await ask(deps, { targets: [file], question: boolQuestion });
    expect(fetchCalls(deps)).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.skipped).toEqual([{ path: file, reason: 'deadline' }]);
    expect(result.stats.partial).toBe(true);
    expect(result.stats.requests).toBe(0);
  });

  it('prazo total no meio da fila: concluidos em answers, nao iniciados em deadline, partial true', async () => {
    const files = [writeFile('q/a.ts'), writeFile('q/b.ts'), writeFile('q/c.ts')];
    const c = clock(0);
    const fetchImpl = router({
      file: () => {
        c.t += 50_000;
        return okAnswer('q', { noul: 0.9 });
      },
    });
    const deps = makeDeps({ fetchImpl, now: c.now, parallel: 1 });
    const result = await ask(deps, { targets: files, question: boolQuestion });
    expect(result.answers).toHaveLength(1);
    expect(result.skipped.map((s) => s.reason)).toEqual(['deadline', 'deadline']);
    expect(result.stats.partial).toBe(true);
    expect(result.stats.requests).toBe(1);
    expect(fetchCalls(deps)).toBe(1);
  });

  it('prazo total cancela request em voo via AbortController compartilhado', async () => {
    const a = writeFile('r/a.ts');
    const b = writeFile('r/b.ts');
    const c = clock(0);
    let slowSignal: AbortSignal | null = null;
    const fetchImpl = router({
      file: (p, _b, init) => {
        if (p === b) {
          slowSignal = init.signal;
          return hanging(init);
        }
        return new Promise((resolve) =>
          setTimeout(() => {
            c.t += 50_000;
            resolve(okAnswer('q', { noul: 0.9 }));
          }, 5),
        );
      },
    });
    const deps = makeDeps({ fetchImpl, now: c.now, parallel: 2, callDeadlineMs: 45_000 });
    const result = await ask(deps, { targets: [a, b, writeFile('r/c.ts')], question: boolQuestion });
    expect(result.answers.map((x) => x.path)).toEqual([a]);
    expect(skippedOf(result)).toEqual({ [b]: 'deadline', [path.join(root, 'r', 'c.ts')]: 'deadline' });
    expect(result.stats.partial).toBe(true);
    expect(slowSignal).not.toBeNull();
    expect((slowSignal as unknown as AbortSignal).aborted).toBe(true);
  });
});

describe('ask_jev_files: bool (Noul)', () => {
  beforeEach(() => writeConfig());

  it('monta o request no formato da API com o conteudo do arquivo e devolve true sem o conteudo', async () => {
    const file = writeFile('a.ts');
    const fetchImpl = vi.fn<FetchHandler>(async (url, init) => {
      expect(url).toBe(JEV_SYSTEM_ONE_URL);
      expect(init.headers.Authorization).toBe(`Bearer ${KEY_A}`);
      const body = bodyOf(init);
      expect(body.model).toBe(MODEL);
      expect(body.state).toEqual({ path: file, content: 'export function alpha() { return 1; }\n' });
      expect(body.questions).toEqual({
        q: { type: 'noul', instructions: 'o arquivo exporta a funcao alpha?', criteria: { true: 'sim', false: 'nao' } },
      });
      return okAnswer('q', { noul: 0.91 }, 120);
    });
    const deps = makeDeps({ fetchImpl });
    const result = await ask(deps, {
      targets: [file],
      question: { ...boolQuestion, criteria: { true: 'sim', false: 'nao' } },
    });
    expect(result.error).toBeUndefined();
    expect(result.answers).toEqual([{ path: file, kind: 'bool', answer: true, probability: 0.91, candidate: true }]);
    expect(result.picked).toBeNull();
    expect(result.pickReason).toBeUndefined();
    expect(result.stats).toEqual({
      callId: FIXED_UUID,
      files: 1,
      eligible: 1,
      charsRead: 'export function alpha() { return 1; }\n'.length,
      inputTokens: 120,
      costUsd: (120 * 0.042) / 1_000_000,
      wallMs: expect.any(Number),
      partial: false,
      truncated: false,
      requests: 1,
    });
    expect(JSON.stringify(result)).not.toContain('export function alpha');
  });

  it('cortes padrao: >= 0.8 true, <= 0.2 false, entre eles unsure; cortes por chamada', async () => {
    const file = writeFile('a.ts');
    for (const [noul, expected] of [
      [0.8, true],
      [0.2, false],
      [0.5, 'unsure'],
      [0.79, 'unsure'],
    ] as const) {
      const result = await ask(makeDeps({ fetchImpl: answering({ noul }) }), {
        targets: [file],
        question: boolQuestion,
      });
      expect(result.answers[0].answer).toBe(expected);
      expect(result.answers[0].candidate).toBe(expected === true);
    }
    const custom = await ask(makeDeps({ fetchImpl: answering({ noul: 0.6 }) }), {
      targets: [file],
      question: { ...boolQuestion, thresholds: { yesAt: 0.55, noAt: 0.1 } },
    });
    expect(custom.answers[0].answer).toBe(true);
  });

  it('uso ausente deixa inputTokens e costUsd null', async () => {
    const result = await ask(makeDeps({ fetchImpl: answering({ noul: 0.9 }, null) }), {
      targets: [writeFile('a.ts')],
      question: boolQuestion,
    });
    expect(result.stats.inputTokens).toBeNull();
    expect(result.stats.costUsd).toBeNull();
  });
});

describe('ask_jev_files: choice e score', () => {
  beforeEach(() => writeConfig());

  const choice = {
    kind: 'choice',
    instructions: 'qual a camada deste arquivo?',
    options: { ui: 'componente de tela', db: 'acesso a banco', nao_relevante: 'nenhuma das anteriores' },
    negativeOption: 'nao_relevante',
  };

  const score = {
    kind: 'score',
    instructions: 'quanto este arquivo trata de autenticacao?',
    levels: ['nada', 'de passagem', 'central'],
  };

  it('choice: acrescenta unknown ao criteria e devolve id, confianca e probabilidades', async () => {
    const file = writeFile('a.ts');
    const fetchImpl = vi.fn<FetchHandler>(async (_url, init) => {
      const body = bodyOf(init);
      expect(body.questions.q.type).toBe('choice');
      expect(Object.keys(body.questions.q.criteria as Record<string, string>)).toEqual([
        'ui',
        'db',
        'nao_relevante',
        'unknown',
      ]);
      return okAnswer('q', {
        choice: 'db',
        confidence: 0.84,
        probabilities: { ui: 0.1, db: 0.84, nao_relevante: 0.03, unknown: 0.03 },
      });
    });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [file], question: choice });
    expect(result.answers).toEqual([
      {
        path: file,
        kind: 'choice',
        answer: 'db',
        confidence: 0.84,
        probabilities: { ui: 0.1, db: 0.84, nao_relevante: 0.03, unknown: 0.03 },
        candidate: true,
      },
    ]);
  });

  it('choice: unknown, negativeOption ou confianca abaixo do threshold nao sao candidatos', async () => {
    const file = writeFile('a.ts');
    const cases: Array<[Record<string, unknown>, number | undefined, boolean]> = [
      [{ choice: 'unknown', confidence: 0.99, probabilities: {} }, undefined, false],
      [{ choice: 'nao_relevante', confidence: 0.99, probabilities: {} }, undefined, false],
      [{ choice: 'ui', confidence: 0.4, probabilities: {} }, undefined, false],
      [{ choice: 'ui', confidence: 0.4, probabilities: {} }, 0.3, true],
      [{ choice: 'ui', confidence: 0.5, probabilities: {} }, undefined, true],
    ];
    for (const [answer, threshold, candidate] of cases) {
      const result = await ask(makeDeps({ fetchImpl: answering(answer) }), {
        targets: [file],
        question: choice,
        ...(threshold === undefined ? {} : { threshold }),
      });
      expect(result.answers[0].answer).toBe(answer.choice);
      expect(result.answers[0].candidate).toBe(candidate);
    }
  });

  it('score: envia levels como criteria, devolve score, answer = nivel mais provavel, legend', async () => {
    const file = writeFile('a.ts');
    const fetchImpl = vi.fn<FetchHandler>(async (_url, init) => {
      expect(bodyOf(init).questions.q).toEqual({
        type: 'score',
        instructions: score.instructions,
        criteria: score.levels,
      });
      return okAnswer('q', {
        score: 1.3,
        confidence: 0.7,
        probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 },
        legend: { '0': 'nada', '1': 'de passagem', '2': 'central' },
      });
    });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [file], question: score });
    expect(result.answers[0]).toEqual({
      path: file,
      kind: 'score',
      answer: 2,
      score: 1.3,
      confidence: 0.7,
      probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 },
      legend: { '0': 'nada', '1': 'de passagem', '2': 'central' },
      candidate: true,
    });
  });

  it('score: empate de probabilidade escolhe o menor indice; sem probabilities cai no nivel mais proximo', async () => {
    const file = writeFile('a.ts');
    const tie = await ask(
      makeDeps({
        fetchImpl: answering({
          score: 1.5,
          confidence: 0.9,
          probabilities: { '0': 0.1, '1': 0.45, '2': 0.45 },
          legend: {},
        }),
      }),
      { targets: [file], question: score },
    );
    expect(tie.answers[0].answer).toBe(1);
    const none = await ask(
      makeDeps({ fetchImpl: answering({ score: 1.6, confidence: 0.9, probabilities: {}, legend: {} }) }),
      {
        targets: [file],
        question: score,
      },
    );
    expect(none.answers[0].answer).toBe(2);
  });

  it('score: minScore e threshold definem candidato', async () => {
    const file = writeFile('a.ts');
    const cases: Array<[number, number, number | undefined, boolean]> = [
      [1.5, 0.9, 2, false],
      [2, 0.9, 2, true],
      [2, 0.3, 2, false],
      [0, 0.9, undefined, true],
    ];
    for (const [value, confidence, minScore, candidate] of cases) {
      const result = await ask(
        makeDeps({ fetchImpl: answering({ score: value, confidence, probabilities: {}, legend: {} }) }),
        {
          targets: [file],
          question: { ...score, ...(minScore === undefined ? {} : { minScore }) },
        },
      );
      expect(result.answers[0].candidate).toBe(candidate);
    }
  });
});

describe('ask_jev_files: falhas do Jev viram texto', () => {
  beforeEach(() => writeConfig());

  it('max_tokens_exceeded no unico arquivo => skipped context, sem retry, error jev_context, charsRead zero', async () => {
    const file = writeFile('a.ts');
    const fetchImpl = vi.fn<FetchHandler>(async () =>
      response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } })),
    );
    const deps = makeDeps({ fetchImpl });
    const result = await ask(deps, { targets: [file], question: boolQuestion });
    expect(result.error).toBe('jev_context');
    expect(result.skipped).toEqual([{ path: file, reason: 'context' }]);
    expect(result.stats.requests).toBe(1);
    expect(result.stats.charsRead).toBe(0);
    expect(result.stats.inputTokens).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('com varios arquivos, charsRead soma so os respondidos', async () => {
    const a = writeFile('a.ts', 'aaaa');
    const b = writeFile('b.ts', 'bbbbbbbb');
    const fetchImpl = router({
      file: (p) =>
        p === a
          ? response(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }))
          : okAnswer('q', { noul: 0.9 }, 7),
    });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion });
    expect(result.stats.charsRead).toBe(8);
    expect(result.stats.requests).toBe(2);
    expect(result.stats.inputTokens).toBe(7);
    expect(result.error).toBeUndefined();
  });

  it('HTTP 503 => skipped jev_error + error jev_http, requests conta a tentativa', async () => {
    const file = writeFile('a.ts');
    const result = await ask(makeDeps({ fetchImpl: vi.fn<FetchHandler>(async () => response(503, 'down')) }), {
      targets: [file],
      question: boolQuestion,
    });
    expect(result.error).toBe('jev_http');
    expect(result.message).toContain('503');
    expect(result.skipped).toEqual([{ path: file, reason: 'jev_error' }]);
    expect(result.stats.requests).toBe(1);
  });

  it('um arquivo com erro do Jev entre outros respondidos nao vira error da chamada', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const fetchImpl = router({ file: (p) => (p === a ? response(503, 'down') : okAnswer('q', { noul: 0.9 })) });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion });
    expect(result.error).toBeUndefined();
    expect(skippedOf(result)).toEqual({ [a]: 'jev_error' });
    expect(result.answers.map((x) => x.path)).toEqual([b]);
  });

  it('resposta fora do schema => error jev_schema', async () => {
    const result = await ask(makeDeps({ fetchImpl: vi.fn<FetchHandler>(async () => response(200, '<html>')) }), {
      targets: [writeFile('a.ts')],
      question: boolQuestion,
    });
    expect(result.error).toBe('jev_schema');
  });

  it('erro inesperado => error internal, nunca excecao', async () => {
    const broken = {
      readFileSync: fs.readFileSync,
      promises: { ...fs.promises, realpath: async () => 42 },
    } as unknown as AskJevFilesDeps['fs'];
    const result = await ask(makeDeps({ fsImpl: broken }), { targets: [writeFile('a.ts')], question: boolQuestion });
    expect(result.error).toBe('internal');
    expect(result.stats.callId).toBe(FIXED_UUID);
  });

  it('now() ou randomUUID() lancando nao derrubam o handler', async () => {
    const file = writeFile('a.ts');
    const badNow = await ask(
      makeDeps({
        now: () => {
          throw new Error('relogio quebrado');
        },
      }),
      { targets: [file], question: boolQuestion },
    );
    expect(badNow.error).not.toBe('internal');
    expect(badNow.stats.callId).toBe(FIXED_UUID);
    expect(badNow.stats.wallMs).toBeGreaterThanOrEqual(0);
    const badUuid = await ask(
      makeDeps({
        randomUUID: () => {
          throw new Error('uuid quebrado');
        },
      }),
      { targets: [file], question: boolQuestion },
    );
    expect(badUuid.error).toBe('internal');
    expect(badUuid.stats.callId).toMatch(UUID_RE);
  });
});

describe('ask_jev_files: pick (J3)', () => {
  beforeEach(() => writeConfig());

  function triage(
    answers: Record<string, Record<string, unknown>>,
    pickAnswer?: Record<string, unknown>,
    onPick?: () => void,
  ) {
    return router({
      file: (p) => okAnswer('q', answers[p] ?? { noul: 0.1 }, 10),
      pick: () => {
        onPick?.();
        return okAnswer('pick', pickAnswer ?? { choice: PICK_NONE_ID, confidence: 0.9, probabilities: {} }, 5);
      },
    });
  }

  it('sem candidato => picked null e no_candidates, sem segundo request', async () => {
    const files = [writeFile('a.ts'), writeFile('b.ts')];
    const deps = makeDeps({ fetchImpl: triage({}) });
    const result = await ask(deps, { targets: files, question: boolQuestion, pick: true });
    expect(result.picked).toBeNull();
    expect(result.pickReason).toBe('no_candidates');
    expect(fetchCalls(deps)).toBe(2);
  });

  it('um candidato => single com a medida propria, sem segundo request', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const deps = makeDeps({ fetchImpl: triage({ [a]: { noul: 0.9 } }) });
    const result = await ask(deps, { targets: [a, b], question: boolQuestion, pick: true });
    expect(result.picked).toEqual({ path: a, confidence: 0.9 });
    expect(result.pickReason).toBe('single');
    expect(fetchCalls(deps)).toBe(2);
    expect(result.stats.requests).toBe(2);
  });

  it('dois ou mais candidatos => um request Choice com a pergunta completa, as medidas e so caminhos reais + none', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const c = writeFile('c.ts');
    let pickBody: Body | null = null;
    const fetchImpl = router({
      file: (p) => okAnswer('q', { noul: p === a ? 0.95 : p === b ? 0.85 : 0.1 }, 10),
      pick: (body) => {
        pickBody = body;
        return okAnswer('pick', { choice: 'f1', confidence: 0.8, probabilities: { f1: 0.8, f2: 0.15, none: 0.05 } }, 5);
      },
    });
    const deps = makeDeps({ fetchImpl });
    const result = await ask(deps, {
      targets: [c, b, a],
      question: { ...boolQuestion, criteria: { true: 'sim', false: 'nao' } },
      pick: true,
    });
    expect(result.picked).toEqual({ path: a, confidence: 0.8 });
    expect(result.pickReason).toBe('chosen');
    expect(result.stats.requests).toBe(4);
    expect(result.stats.inputTokens).toBe(35);
    expect(pickBody).not.toBeNull();
    const body = pickBody as unknown as Body;
    expect(body.model).toBe(MODEL);
    const criteria = body.questions.pick.criteria as Record<string, string>;
    expect(Object.keys(criteria)).toEqual(['f1', 'f2', PICK_NONE_ID]);
    expect(criteria.f1).toContain(a);
    expect(criteria.f2).toContain(b);
    expect(body.questions.pick.type).toBe('choice');
    expect(body.state.question).toEqual({
      kind: 'bool',
      instructions: boolQuestion.instructions,
      criteria: { true: 'sim', false: 'nao' },
    });
    expect(body.state.candidates).toEqual([
      { id: 'f1', path: a, answer: true, probability: 0.95 },
      { id: 'f2', path: b, answer: true, probability: 0.85 },
    ]);
    expect(JSON.stringify(body)).not.toContain('export function alpha');
    expect(result.answers.map((x) => [x.path, x.candidate])).toEqual([
      [a, true],
      [b, true],
      [c, false],
    ]);
  });

  it('pick com choice e score leva options/levels e as medidas de cada tipo no state', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const bodies: Body[] = [];
    const fetchImpl = router({
      file: (_p, body) =>
        'levels' in (body.questions.q.criteria as object)
          ? okAnswer('q', { score: 2, confidence: 0.9, probabilities: { '2': 1 }, legend: {} })
          : okAnswer('q', { score: 2, confidence: 0.9, probabilities: { '2': 1 }, legend: {} }),
      pick: (body) => {
        bodies.push(body);
        return okAnswer('pick', { choice: PICK_NONE_ID, confidence: 0.9, probabilities: {} });
      },
    });
    const result = await ask(makeDeps({ fetchImpl }), {
      targets: [a, b],
      question: { kind: 'score', instructions: 's?', levels: ['x', 'y', 'z'], minScore: 1 },
      pick: true,
    });
    expect(result.pickReason).toBe('none');
    expect(bodies[0].state.question).toEqual({ kind: 'score', instructions: 's?', levels: ['x', 'y', 'z'] });
    expect(bodies[0].state.candidates).toEqual([
      { id: 'f1', path: a, answer: 2, confidence: 0.9, probabilities: { '2': 1 }, score: 2 },
      { id: 'f2', path: b, answer: 2, confidence: 0.9, probabilities: { '2': 1 }, score: 2 },
    ]);
  });

  it('none => pickReason none; confianca abaixo do threshold => low_confidence; candidatos seguem em answers', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const both = { [a]: { noul: 0.9 }, [b]: { noul: 0.85 } };
    const none = await ask(
      makeDeps({ fetchImpl: triage(both, { choice: PICK_NONE_ID, confidence: 0.9, probabilities: {} }) }),
      {
        targets: [a, b],
        question: boolQuestion,
        pick: true,
      },
    );
    expect(none.picked).toBeNull();
    expect(none.pickReason).toBe('none');
    expect(none.answers.filter((x) => x.candidate)).toHaveLength(2);
    const low = await ask(makeDeps({ fetchImpl: triage(both, { choice: 'f1', confidence: 0.4, probabilities: {} }) }), {
      targets: [a, b],
      question: boolQuestion,
      pick: true,
      threshold: 0.6,
    });
    expect(low.picked).toBeNull();
    expect(low.pickReason).toBe('low_confidence');
  });

  it('payload do pick acima do orcamento => pickReason context sem request de pick', async () => {
    const files = Array.from({ length: 40 }, (_, i) => writeFile(`k/${'longname'.repeat(8)}${i}.ts`));
    const answers = Object.fromEntries(files.map((f) => [f, { noul: 0.9 }]));
    const deps = makeDeps({ fetchImpl: triage(answers) });
    const result = await ask(deps, {
      targets: files,
      question: { kind: 'bool', instructions: 'p'.repeat(108_000) },
      pick: true,
    });
    expect(result.pickReason).toBe('context');
    expect(result.picked).toBeNull();
    expect(fetchCalls(deps)).toBe(40);
  });

  it('API responde max_tokens_exceeded no pick => pickReason context', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const fetchImpl = router({
      file: () => okAnswer('q', { noul: 0.9 }),
      pick: () => response(400, 'max_tokens_exceeded'),
    });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion, pick: true });
    expect(result.pickReason).toBe('context');
    expect(result.error).toBeUndefined();
    expect(result.stats.requests).toBe(3);
  });

  it('prazo total esgotado antes do pick => pickReason deadline e partial', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const c = clock(0);
    let answered = 0;
    const fetchImpl = router({
      file: () => {
        answered++;
        if (answered === 2) c.t += 50_000;
        return okAnswer('q', { noul: 0.9 });
      },
      pick: () => okAnswer('pick', { choice: 'f1', confidence: 0.9, probabilities: {} }),
    });
    const deps = makeDeps({ fetchImpl, now: c.now, parallel: 1 });
    const result = await ask(deps, { targets: [a, b], question: boolQuestion, pick: true });
    expect(result.answers).toHaveLength(2);
    expect(result.pickReason).toBe('deadline');
    expect(result.picked).toBeNull();
    expect(result.stats.partial).toBe(true);
    expect(fetchCalls(deps)).toBe(2);
  });

  it('erro HTTP no pick com respostas validas => pickReason error e message, sem error de topo', async () => {
    const a = writeFile('a.ts');
    const b = writeFile('b.ts');
    const fetchImpl = router({ file: () => okAnswer('q', { noul: 0.9 }), pick: () => response(503, 'down') });
    const result = await ask(makeDeps({ fetchImpl }), { targets: [a, b], question: boolQuestion, pick: true });
    expect(result.error).toBeUndefined();
    expect(result.picked).toBeNull();
    expect(result.pickReason).toBe('error');
    expect(result.message).toContain('503');
    expect(result.answers).toHaveLength(2);
    expect(result.stats.requests).toBe(3);
  });

  it('answers vem ordenado: candidatos primeiro, depois por medida decrescente', async () => {
    const files = { a: writeFile('a.ts'), b: writeFile('b.ts'), c: writeFile('c.ts'), d: writeFile('d.ts') };
    const measures = { [files.a]: 0.3, [files.b]: 0.95, [files.c]: 0.1, [files.d]: 0.85 };
    const fetchImpl = router({ file: (p) => okAnswer('q', { noul: measures[p] }) });
    const result = await ask(makeDeps({ fetchImpl }), {
      targets: [files.a, files.b, files.c, files.d],
      question: boolQuestion,
    });
    expect(result.answers.map((x) => x.path)).toEqual([files.b, files.d, files.a, files.c]);
  });
});

describe('ask_jev_files: registro de uso (jsonl)', () => {
  beforeEach(() => writeConfig());

  it('grava uma linha por chamada com o mesmo callId, sem conteudo e sem chave', async () => {
    const a = writeFile('a.ts', 'export const SEGREDO_DO_ARQUIVO = 1;\n');
    const b = writeFile('b.ts');
    const deps = makeDeps({
      fetchImpl: router({
        file: () => okAnswer('q', { noul: 0.9 }, 10),
        pick: () => okAnswer('pick', { choice: 'f1', confidence: 0.9, probabilities: {} }, 5),
      }),
      env: { LIONCLAW_RUNTIME: 'codex' },
    });
    const result = await ask(deps, { targets: [a, b], question: boolQuestion, pick: true });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.callId).toBe(result.stats.callId);
    expect(line.runtimeHint).toBe('codex');
    expect(line.targets).toEqual([a, b]);
    expect(line.files).toBe(2);
    expect(line.eligible).toBe(2);
    expect(line.charsRead).toBe(result.stats.charsRead);
    expect(line.inputTokens).toBe(25);
    expect(line.costUsd).toBe((25 * 0.042) / 1_000_000);
    expect(line.partial).toBe(false);
    expect(line.question).toEqual({ kind: 'bool', instructions: boolQuestion.instructions });
    expect(line.answers).toEqual([
      { path: a, answer: true },
      { path: b, answer: true },
    ]);
    expect(line.picked).toEqual({ path: a, confidence: 0.9 });
    expect(line.pickReason).toBe('chosen');
    expect(line.skipped).toEqual([]);
    expect(line.error).toBeNull();
    expect(typeof line.timestamp).toBe('string');
    const raw = fs.readFileSync(path.join(home, 'workspaces', 'lionclaw', 'jev-files.jsonl'), 'utf8');
    expect(raw).not.toContain('SEGREDO_DO_ARQUIVO');
    expect(raw).not.toContain(KEY_A);
  });

  it('chamadas recusadas tambem geram linha, com error e runtimeHint null', async () => {
    writeConfig({ enabled: false });
    const deps = makeDeps();
    await ask(deps, { targets: ['/x'], question: boolQuestion });
    await ask(deps, { targets: ['/y'], question: boolQuestion });
    const lines = readLog();
    expect(lines).toHaveLength(2);
    expect(lines[0].error).toBe('disabled');
    expect(lines[0].runtimeHint).toBeNull();
    expect(lines[1].targets).toEqual(['/y']);
  });

  it('falha ao gravar o jsonl vai para stderr e nao muda a resposta', async () => {
    const file = writeFile('a.ts');
    const fsImpl = {
      readFileSync: fs.readFileSync,
      promises: {
        ...fs.promises,
        appendFile: async () => {
          throw new Error('disco cheio');
        },
      },
    } as unknown as AskJevFilesDeps['fs'];
    const deps = makeDeps({ fsImpl, fetchImpl: answering({ noul: 0.9 }) });
    const result = await ask(deps, { targets: [file], question: boolQuestion });
    expect(result.error).toBeUndefined();
    expect(result.answers).toHaveLength(1);
    expect(deps.stderr).toHaveBeenCalledTimes(1);
    expect(String((deps.stderr as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('disco cheio');
    expect(readLog()).toEqual([]);
  });
});
