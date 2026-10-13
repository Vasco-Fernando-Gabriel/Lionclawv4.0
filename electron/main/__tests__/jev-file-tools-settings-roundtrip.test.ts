import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const { store, getSetting, setSetting, setOrchestratorCompactionSelection, env } = vi.hoisted(() => {
  const s = new Map<string, string>();
  return {
    store: s,
    env: { home: '', lionclawHome: '' },
    getSetting: vi.fn((key: string): string | undefined => s.get(key)),
    setSetting: vi.fn((key: string, value: string): void => {
      s.set(key, value);
    }),
    setOrchestratorCompactionSelection: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, default: { ...original, homedir: () => env.home }, homedir: () => env.home };
});
vi.mock('../paths', () => ({ getLionClawHome: () => env.lionclawHome }));
vi.mock('../agent-sync', () => ({ syncAgentsToOrchestrator: vi.fn() }));
vi.mock('../seed-agents', () => ({ listSeedAgentIds: vi.fn(() => []) }));
vi.mock('../../../src/constants/transcription-models', () => ({
  DEFAULT_VOICE_TRANSCRIPTION_MODEL: 'whisper-1',
  isVoiceTranscriptionModel: vi.fn(() => true),
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting,
  setSetting,
  setOrchestratorCompactionSelection,
  getAuthRow: vi.fn(() => null),
  getDreamingTurnInterval: vi.fn(() => 20),
}));
vi.mock('../voice-engine', () => ({ DEFAULT_ELEVENLABS_VOICE_ID: 'default-voice' }));
vi.mock('../cartesia-engine', () => ({
  DEFAULT_CARTESIA_MODEL: 'sonic',
  DEFAULT_CARTESIA_SPEED: 1.0,
  DEFAULT_CARTESIA_VOICE_ID: 'cartesia-voice',
  DEFAULT_CARTESIA_LANGUAGE: 'pt',
}));
vi.mock('../ipc/_shared/chat-compaction', () => ({ compactActiveChatSession: vi.fn() }));
vi.mock('../provider-availability', () => ({ checkProvider: vi.fn() }));
const apply = vi.hoisted(() => ({ applyJevFileToolsChange: vi.fn(async () => undefined) }));
vi.mock('../jev-file-tools', () => ({ applyJevFileToolsChange: apply.applyJevFileToolsChange }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import os from 'os';
import { registerSettingsHandlers } from '../ipc/settings';
import {
  JEV_FILE_TOOLS_ENABLED_SETTING_KEY,
  JEV_FILE_TOOLS_ROOTS_SETTING_KEY,
  JEV_MODEL_SETTING_KEY,
} from '../jev-settings';
import type { AppSettings, SettingsUpdateResult } from '../../../src/types';

async function get(): Promise<AppSettings> {
  return (await handlers.get('settings:get')!()) as AppSettings;
}

async function update(patch: Partial<AppSettings>): Promise<SettingsUpdateResult> {
  return (await handlers.get('settings:update')!(undefined, patch)) as SettingsUpdateResult;
}

let tmp = '';
let dirA = '';
let dirB = '';

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join((os as unknown as { tmpdir(): string }).tmpdir(), 'jev-roots-')));
  env.home = path.join(tmp, 'home');
  env.lionclawHome = path.join(env.home, '.lionclaw');
  dirA = path.join(tmp, 'proj-a');
  dirB = path.join(tmp, 'proj-b');
  fs.mkdirSync(path.join(env.home, 'projetos'), { recursive: true });
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  store.clear();
  handlers.clear();
  store.set('orchestrator_runtime', 'claude-sdk');
  store.set('orchestrator_provider', 'anthropic');
  store.set('orchestrator_model', 'claude-sonnet-4');
  registerSettingsHandlers({ getMainWindow: () => null, getHarnessEngine: () => null } as never);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('settings do Jev para arquivos: round-trip', () => {
  it('sem valores gravados, a flag vem desligada e a raiz vem no default absoluto', async () => {
    const settings = await get();
    expect(settings.jevFileToolsEnabled).toBe(false);
    expect(settings.jevFileToolsRoots).toEqual([path.join(env.lionclawHome, 'workspaces')]);
  });

  it('ligar a flag e salvar raizes persiste, volta na leitura e aplica a mudanca', async () => {
    const result = await update({ jevFileToolsEnabled: true, jevFileToolsRoots: [dirA, dirB] });
    expect(result.success).toBe(true);
    expect(store.get(JEV_FILE_TOOLS_ENABLED_SETTING_KEY)).toBe('true');
    expect(JSON.parse(store.get(JEV_FILE_TOOLS_ROOTS_SETTING_KEY) ?? '[]')).toEqual([dirA, dirB]);
    const settings = await get();
    expect(settings.jevFileToolsEnabled).toBe(true);
    expect(settings.jevFileToolsRoots).toEqual([dirA, dirB]);
    expect(apply.applyJevFileToolsChange).toHaveBeenCalledTimes(1);
    expect(apply.applyJevFileToolsChange).toHaveBeenCalledWith('flag');
  });

  it('so raizes mudando aplica com roots; so modelo mudando aplica com model; nada mudando nao aplica', async () => {
    await update({ jevFileToolsRoots: [dirA] });
    expect(apply.applyJevFileToolsChange).toHaveBeenLastCalledWith('roots');
    await update({ jevModel: 'jev-1.14.0' });
    expect(apply.applyJevFileToolsChange).toHaveBeenLastCalledWith('model');
    expect(store.get(JEV_MODEL_SETTING_KEY)).toBe('jev-1.14.0');
    apply.applyJevFileToolsChange.mockClear();
    await update({ jevFileToolsRoots: [dirA], jevModel: 'jev-1.14.0', jevFileToolsEnabled: false });
    expect(apply.applyJevFileToolsChange).not.toHaveBeenCalled();
  });

  it('~ e expandido para o home e linhas vazias sao ignoradas', async () => {
    const result = await update({ jevFileToolsRoots: ['~/projetos', '  ', '~'] });
    expect(result.success).toBe(true);
    expect(JSON.parse(store.get(JEV_FILE_TOOLS_ROOTS_SETTING_KEY) ?? '[]')).toEqual([
      path.join(env.home, 'projetos'),
      env.home,
    ]);
  });

  it.runIf(process.platform === 'win32')('win32: a mesma pasta com maiusculas diferentes e duplicata', async () => {
    const result = await update({ jevFileToolsRoots: [dirA, dirA.toUpperCase()] });
    expect(result.error).toContain('repetida');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('valor invalido gravado por fora e lido como default', async () => {
    store.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, '["relativa", 3]');
    expect((await get()).jevFileToolsRoots).toEqual([path.join(env.lionclawHome, 'workspaces')]);
    store.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, 'nao e json');
    expect((await get()).jevFileToolsRoots).toEqual([path.join(env.lionclawHome, 'workspaces')]);
  });
});

describe('settings do Jev para arquivos: validacao das raizes antes de qualquer escrita', () => {
  it.each<[string, string[]]>([
    ['relativa', ['projetos/x']],
    ['inexistente', [path.join(tmp, 'nao-existe')]],
    ['arquivo em vez de pasta', ['__FILE__']],
    ['duplicada', ['__A__', '__A__']],
    ['duplicada por grafia', ['__A__', path.join('__A__', '.', 'sub', '..')]],
    ['basename sensivel .ssh', ['__SSH__']],
    ['basename sensivel node_modules', ['__NM__']],
    ['par sensivel .lionclaw/data', ['__LCDATA__']],
    ['lista vazia', []],
    ['mais de 20', Array.from({ length: 21 }, (_, i) => `__DIR${i}__`)],
  ])('%s => { error } e nenhum setSetting', async (_label, raw) => {
    const file = path.join(tmp, 'arquivo.txt');
    fs.writeFileSync(file, 'x');
    fs.mkdirSync(path.join(tmp, '.ssh'));
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.mkdirSync(path.join(tmp, '.lionclaw', 'data'), { recursive: true });
    const roots = raw.map((entry) => {
      if (entry === '__FILE__') return file;
      if (entry === '__A__') return dirA;
      if (entry === '__SSH__') return path.join(tmp, '.ssh');
      if (entry === '__NM__') return path.join(tmp, 'node_modules');
      if (entry === '__LCDATA__') return path.join(tmp, '.lionclaw', 'data');
      const many = entry.match(/^__DIR(\d+)__$/);
      if (many) {
        const dir = path.join(tmp, `d${many[1]}`);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
      return entry.replace('__A__', dirA);
    });
    const result = await update({ jevFileToolsEnabled: true, jevFileToolsRoots: roots, jevModel: 'jev-2' });
    expect(result.error).toBeTruthy();
    expect(result.success).toBeUndefined();
    expect(setSetting).not.toHaveBeenCalled();
    expect(apply.applyJevFileToolsChange).not.toHaveBeenCalled();
  });

  it('patch sem os campos do Jev para arquivos nao toca neles nem aplica', async () => {
    store.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    store.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, JSON.stringify([dirA]));
    await update({ jevShadowEnabled: true });
    expect(store.get(JEV_FILE_TOOLS_ENABLED_SETTING_KEY)).toBe('true');
    expect(store.get(JEV_FILE_TOOLS_ROOTS_SETTING_KEY)).toBe(JSON.stringify([dirA]));
    expect(apply.applyJevFileToolsChange).not.toHaveBeenCalled();
  });
});
