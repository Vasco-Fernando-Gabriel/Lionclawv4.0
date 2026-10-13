import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
}));

vi.mock('../tool-script/tool-script-availability', () => ({
  resolveToolScriptRegistration: vi.fn(() => ({ register: false, available: false, enabled: false })),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  getSetting: vi.fn((key: string) => state.settings.get(key)),
  getCompletedDocsCount: vi.fn(() => 0),
  listKanbanBoards: vi.fn(() => []),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));

vi.mock('../skills', () => ({
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => '/nonexistent-lionclaw-home-for-tests',
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { JEV_FILE_TOOLS_SECTION_HEADER, buildJevFileToolsSection, buildSystemPrompt } from '../prompt-builder';
import { resolveJevFileToolsRegistration, setJevFileToolsRegistration } from '../jev-settings';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
  state.settings = new Map();
  setJevFileToolsRegistration({ isActive: false, reason: 'desligado nas Settings' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('secao do Jev no prompt do orquestrador', () => {
  it('por padrao (flag desligada) o prompt nao menciona o Jev', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain(JEV_FILE_TOOLS_SECTION_HEADER);
    expect(prompt).not.toContain('ask_jev_files');
    expect(resolveJevFileToolsRegistration().isActive).toBe(false);
  });

  it('com o jev-files ativo (flag + chave) a secao entra; o UNICO delta vs o prompt sem Jev e a secao', () => {
    const without = buildSystemPrompt();
    setJevFileToolsRegistration({ isActive: true });
    const withJev = buildSystemPrompt();
    expect(withJev).toContain(JEV_FILE_TOOLS_SECTION_HEADER);
    expect(withJev.replace(`\n\n---\n\n${buildJevFileToolsSection()}`, '')).toBe(without);
  });

  it('desligar de novo tira a secao sem reiniciar', () => {
    setJevFileToolsRegistration({ isActive: true });
    expect(buildSystemPrompt()).toContain(JEV_FILE_TOOLS_SECTION_HEADER);
    setJevFileToolsRegistration({ isActive: false, reason: 'chave do Jev ausente no Vault' });
    expect(buildSystemPrompt()).not.toContain('ask_jev_files');
  });

  it('a secao cobre quando usar, quando nao usar e como ler a confianca', () => {
    const section = buildJevFileToolsSection();
    for (const needle of [
      'pick: true ANTES de abrir',
      'NAO use para ANALISE',
      'read_file',
      'outside_roots',
      'corte de 0,8/0,2',
      'yesAt: 0.9',
      'abaixo de 0,7',
      'unsure, low_confidence, none',
      '"nao esta neste arquivo"',
      'segundo o Jev (0,96)',
    ]) {
      expect(section).toContain(needle);
    }
    expect(section).not.toMatch(/[áéíóúâêôãõç]/);
  });

  it('a secao nao entra no prompt minimo de agente', () => {
    setJevFileToolsRegistration({ isActive: true });
    const prompt = buildSystemPrompt('agente-x', { mode: 'minimal' });
    expect(prompt).not.toContain(JEV_FILE_TOOLS_SECTION_HEADER);
  });
});
