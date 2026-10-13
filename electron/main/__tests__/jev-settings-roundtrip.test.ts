import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, getSetting, setSetting, setOrchestratorCompactionSelection } = vi.hoisted(() => {
  const s = new Map<string, string>();
  return {
    store: s,
    getSetting: vi.fn((key: string): string | undefined => s.get(key)),
    setSetting: vi.fn((key: string, value: string): void => {
      s.set(key, value);
    }),
    setOrchestratorCompactionSelection: vi.fn(),
  };
});

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
vi.mock('../jev-file-tools', () => ({ applyJevFileToolsChange: vi.fn(async () => undefined) }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import { registerSettingsHandlers } from '../ipc/settings';
import { JEV_DEFAULT_MODEL, JEV_MODEL_SETTING_KEY, JEV_SHADOW_ENABLED_SETTING_KEY } from '../jev-settings';
import {
  ARCHMAP_DEFAULT_JEV_KEEP_THRESHOLD,
  ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY,
  ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY,
} from '../archmap/settings';
import type { AppSettings, SettingsUpdateResult } from '../../../src/types';

async function get(): Promise<AppSettings> {
  return (await handlers.get('settings:get')!()) as AppSettings;
}

async function update(patch: Partial<AppSettings>): Promise<SettingsUpdateResult> {
  return (await handlers.get('settings:update')!(undefined, patch)) as SettingsUpdateResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  handlers.clear();
  store.set('orchestrator_runtime', 'claude-sdk');
  store.set('orchestrator_provider', 'anthropic');
  store.set('orchestrator_model', 'claude-sonnet-4');
  registerSettingsHandlers({ getMainWindow: () => null, getHarnessEngine: () => null } as never);
});

describe('settings do modo sombra do Jev: round-trip', () => {
  it('sem valores gravados, a flag vem desligada e o modelo vem no default', async () => {
    const settings = await get();
    expect(settings.jevShadowEnabled).toBe(false);
    expect(settings.jevModel).toBe(JEV_DEFAULT_MODEL);
  });

  it('ligar a flag e trocar o modelo persiste e volta na leitura', async () => {
    const result = await update({ jevShadowEnabled: true, jevModel: '  jev-1.14.0 ' });
    expect(result.success).toBe(true);
    expect(store.get(JEV_SHADOW_ENABLED_SETTING_KEY)).toBe('true');
    expect(store.get(JEV_MODEL_SETTING_KEY)).toBe('jev-1.14.0');

    const settings = await get();
    expect(settings.jevShadowEnabled).toBe(true);
    expect(settings.jevModel).toBe('jev-1.14.0');
  });

  it('desligar a flag persiste "false"', async () => {
    store.set(JEV_SHADOW_ENABLED_SETTING_KEY, 'true');
    await update({ jevShadowEnabled: false });
    expect(store.get(JEV_SHADOW_ENABLED_SETTING_KEY)).toBe('false');
  });

  it('modelo vazio ou acima de 64 caracteres e rejeitado sem gravar', async () => {
    for (const bad of ['', '   ', 'x'.repeat(65)]) {
      const result = await update({ jevModel: bad });
      expect(result.success).toBeFalsy();
      expect(result.error).toContain('Modelo do Jev invalido');
    }
    expect(store.has(JEV_MODEL_SETTING_KEY)).toBe(false);
  });

  it('valor invalido gravado por fora e lido como default', async () => {
    store.set(JEV_MODEL_SETTING_KEY, '   ');
    const settings = await get();
    expect(settings.jevModel).toBe(JEV_DEFAULT_MODEL);
  });

  it('patch sem os campos do Jev nao toca neles', async () => {
    store.set(JEV_SHADOW_ENABLED_SETTING_KEY, 'true');
    store.set(JEV_MODEL_SETTING_KEY, 'jev-1.13.0');
    await update({ dreamingTurnBasedModel: 'x' });
    expect(store.get(JEV_SHADOW_ENABLED_SETTING_KEY)).toBe('true');
    expect(store.get(JEV_MODEL_SETTING_KEY)).toBe('jev-1.13.0');
  });
});

describe('settings do modo sombra do Jev: validacao antes de qualquer escrita', () => {
  it('patch com modelo invalido e flag valida nao grava nada', async () => {
    const result = await update({ jevShadowEnabled: true, jevModel: '' });
    expect(result.success).toBeFalsy();
    expect(result.error).toContain('Modelo do Jev invalido');
    expect(store.has(JEV_SHADOW_ENABLED_SETTING_KEY)).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
  });
});

describe('settings da triagem Jev do Mapa de arquitetura: round-trip', () => {
  it('sem valores gravados, a triagem vem desligada e o limiar vem em 0.8', async () => {
    const settings = await get();
    expect(settings.archmapJevTriageEnabled).toBe(false);
    expect(settings.archmapJevKeepThreshold).toBe(ARCHMAP_DEFAULT_JEV_KEEP_THRESHOLD);
  });

  it('ligar a triagem e trocar o limiar persiste e volta na leitura', async () => {
    const result = await update({ archmapJevTriageEnabled: true, archmapJevKeepThreshold: 0.9 });
    expect(result.success).toBe(true);
    expect(store.get(ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY)).toBe('true');
    expect(store.get(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY)).toBe('0.9');
    const settings = await get();
    expect(settings.archmapJevTriageEnabled).toBe(true);
    expect(settings.archmapJevKeepThreshold).toBe(0.9);
  });

  it('limiar fora de 0.5..1 e trazido para dentro da faixa; invalido vira o default', async () => {
    await update({ archmapJevKeepThreshold: 1.7 });
    expect(store.get(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY)).toBe('1');
    await update({ archmapJevKeepThreshold: 0.1 });
    expect(store.get(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY)).toBe('0.5');
    store.set(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY, 'abc');
    expect((await get()).archmapJevKeepThreshold).toBe(ARCHMAP_DEFAULT_JEV_KEEP_THRESHOLD);
  });

  it('desligar a triagem persiste "false" e patch sem os campos nao toca neles', async () => {
    store.set(ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY, 'true');
    store.set(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY, '0.85');
    await update({ dreamingTurnBasedModel: 'x' });
    expect(store.get(ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY)).toBe('true');
    expect(store.get(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY)).toBe('0.85');
    await update({ archmapJevTriageEnabled: false });
    expect(store.get(ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY)).toBe('false');
  });
});
