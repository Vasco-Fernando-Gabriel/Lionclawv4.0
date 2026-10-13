import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  JEV_FILES_SALT_HEX_LENGTH,
  fingerprintFor,
  generateSalt,
  parseJevFilesConfig,
} from '../../../_shared/jev-files-config';
import {
  readApiKeyFromEnv,
  readJevFilesConfig,
  readRuntimeHint,
  resolveConfigPath,
  resolveLionclawHome,
} from '../config';

const SALT = 'a'.repeat(64);
const KEY = 'ts_SECRET_CONFIG_KEY_42';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-files-config-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    model: 'jev-1.13.0',
    roots: [tmp],
    credentialSalt: SALT,
    credentialFingerprint: fingerprintFor(SALT, KEY),
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('config: caminho do arquivo', () => {
  it('usa LIONCLAW_HOME do env quando presente, senao ~/.lionclaw', () => {
    expect(resolveLionclawHome('/home/u', { LIONCLAW_HOME: '/custom/home' })).toBe(path.resolve('/custom/home'));
    expect(resolveLionclawHome('/home/u', { LIONCLAW_HOME: '   ' })).toBe(path.join('/home/u', '.lionclaw'));
    expect(resolveLionclawHome('/home/u', {})).toBe(path.join('/home/u', '.lionclaw'));
    expect(resolveConfigPath('/home/u', {})).toBe(path.join('/home/u', '.lionclaw', 'data', 'jev-files.json'));
  });

  it('chave e runtimeHint vem do env, sem espacos; vazio vira null', () => {
    expect(readApiKeyFromEnv({ TYPESAFE_JEV_API_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(readApiKeyFromEnv({ TYPESAFE_JEV_API_KEY: '  ' })).toBeNull();
    expect(readApiKeyFromEnv({})).toBeNull();
    expect(readRuntimeHint({ LIONCLAW_RUNTIME: 'codex' })).toBe('codex');
    expect(readRuntimeHint({})).toBeNull();
  });
});

describe('config compartilhada (_shared/jev-files-config): validacao', () => {
  it('aceita o formato escrito pelo app', () => {
    const result = parseJevFilesConfig(validConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({
        version: 1,
        enabled: true,
        model: 'jev-1.13.0',
        roots: [tmp],
        credentialSalt: SALT,
        credentialFingerprint: fingerprintFor(SALT, KEY),
        updatedAt: '2026-10-08T00:00:00.000Z',
      });
    }
  });

  it('aceita credentialFingerprint null e updatedAt ausente', () => {
    const result = parseJevFilesConfig(validConfig({ credentialFingerprint: null, updatedAt: undefined }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.credentialFingerprint).toBeNull();
      expect(result.config.updatedAt).toBeNull();
    }
  });

  it('recusa formas invalidas, inclusive salt que nao tem 64 hex', () => {
    const cases: Array<[string, unknown]> = [
      ['nao objeto', 'x'],
      ['lista', []],
      ['version errada', validConfig({ version: 2 })],
      ['enabled texto', validConfig({ enabled: 'true' })],
      ['model vazio', validConfig({ model: '' })],
      ['roots ausente', validConfig({ roots: undefined })],
      ['raiz relativa', validConfig({ roots: ['workspaces'] })],
      ['raiz nao texto', validConfig({ roots: [1] })],
      ['salt de 32 hex', validConfig({ credentialSalt: 'a'.repeat(32) })],
      ['salt de 66 hex', validConfig({ credentialSalt: 'a'.repeat(66) })],
      ['salt nao hex', validConfig({ credentialSalt: 'z'.repeat(64) })],
      ['fingerprint nao hex', validConfig({ credentialFingerprint: 'g'.repeat(64) })],
      ['fingerprint curto', validConfig({ credentialFingerprint: 'ab' })],
    ];
    for (const [label, raw] of cases) {
      expect(parseJevFilesConfig(raw).ok, label).toBe(false);
    }
  });
});

describe('config: leitura do arquivo', () => {
  it('arquivo ausente => absent', () => {
    expect(readJevFilesConfig(path.join(tmp, 'nao-existe.json'), fs)).toEqual({ status: 'absent' });
  });

  it('JSON invalido => invalid com mensagem', () => {
    const file = path.join(tmp, 'jev-files.json');
    fs.writeFileSync(file, '{ nao e json');
    expect(readJevFilesConfig(file, fs).status).toBe('invalid');
  });

  it('arquivo valido => ok', () => {
    const file = path.join(tmp, 'jev-files.json');
    fs.writeFileSync(file, JSON.stringify(validConfig()));
    expect(readJevFilesConfig(file, fs).status).toBe('ok');
  });

  it('erro de leitura que nao e ENOENT => invalid', () => {
    const result = readJevFilesConfig('x', {
      readFileSync: () => {
        throw Object.assign(new Error('acesso negado'), { code: 'EACCES' });
      },
    });
    expect(result).toEqual({ status: 'invalid', message: 'jev-files.json ilegivel: acesso negado' });
  });
});

describe('config compartilhada: impressao da chave e salt', () => {
  it('fingerprintFor e HMAC-SHA256 em hex, deterministica, e muda com a chave ou com o salt', () => {
    const a = fingerprintFor(SALT, KEY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintFor(SALT, KEY)).toBe(a);
    expect(fingerprintFor(SALT, `${KEY}x`)).not.toBe(a);
    expect(fingerprintFor('b'.repeat(64), KEY)).not.toBe(a);
    expect(a).not.toContain(KEY);
    expect(Buffer.from(a, 'hex').toString('utf8')).not.toContain(KEY);
  });

  it('generateSalt devolve 32 bytes em 64 hex, diferentes a cada chamada', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).toMatch(new RegExp(`^[0-9a-f]{${JEV_FILES_SALT_HEX_LENGTH}}$`));
    expect(a).not.toBe(b);
    expect(
      parseJevFilesConfig(validConfig({ credentialSalt: a, credentialFingerprint: fingerprintFor(a, KEY) })).ok,
    ).toBe(true);
  });
});
