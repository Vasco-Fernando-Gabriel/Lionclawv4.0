import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KEY_A = 'ts_SECRET_FILE_TOOLS_A';
const KEY_B = 'ts_SECRET_FILE_TOOLS_B';

const state = vi.hoisted(() => ({
  home: '',
  settings: new Map<string, string>(),
  secret: { status: 'absent' } as
    | { status: 'absent' }
    | { status: 'found'; value: string }
    | { status: 'error'; code: 'VAULT-CORRUPT'; reason: string; backupPath: string | null },
  rows: [] as Array<{ id: string; isActive: boolean }>,
  logs: [] as Array<[string, unknown[]]>,
  harnessProjects: [] as Array<{ projectPath: string }>,
  workflowDefinitions: [] as Array<{ projectPath: string }>,
  projectListeners: new Set<() => void>(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn((...args: unknown[]) => state.logs.push(['info', args])),
    warn: vi.fn((...args: unknown[]) => state.logs.push(['warn', args])),
    error: vi.fn((...args: unknown[]) => state.logs.push(['error', args])),
    debug: vi.fn(),
  }),
}));
vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => state.settings.get(key)),
  listHarnessProjects: vi.fn(() => state.harnessProjects),
  listDynamicWorkflowDefinitions: vi.fn(() => state.workflowDefinitions),
  onProjectPathsChanged: vi.fn((listener: () => void) => {
    state.projectListeners.add(listener);
    return () => state.projectListeners.delete(listener);
  }),
}));
vi.mock('../secrets-vault', () => ({ getSecretNonInteractive: vi.fn(async () => state.secret) }));
vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));

const mcp = vi.hoisted(() => ({
  updateMCPServer: vi.fn(),
  startServer: vi.fn(async () => undefined),
  stopServer: vi.fn(),
  restartServer: vi.fn(async () => undefined),
  discoverAndSaveMCPTools: vi.fn(async () => ['ask_jev_files']),
}));
vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => state.rows,
  updateMCPServer: mcp.updateMCPServer,
  startServer: mcp.startServer,
  stopServer: mcp.stopServer,
  restartServer: mcp.restartServer,
  discoverAndSaveMCPTools: mcp.discoverAndSaveMCPTools,
}));
const codex = vi.hoisted(() => ({ syncCodexMcpConfig: vi.fn(async () => undefined) }));
vi.mock('../codex-sdk/mcp-config-sync', () => ({ syncCodexMcpConfig: codex.syncCodexMcpConfig }));

import {
  JEV_FILES_STATS_TAIL_BYTES,
  applyJevFileToolsChange,
  collectJevFileToolsProjectRoots,
  readJevFileToolsStats,
  refreshJevFileToolsProjectRoots,
  resolveJevFileToolsRegistration,
  resolveJevFileToolsRoots,
  resolveJevFilesConfigPath,
  watchJevFileToolsProjectRoots,
  writeJevFilesConfig,
} from '../jev-file-tools';
import { fingerprintFor, parseJevFilesConfig } from '../../../mcp-servers/_shared/jev-files-config';
import { JEV_FILE_TOOLS_ENABLED_SETTING_KEY, JEV_FILE_TOOLS_ROOTS_SETTING_KEY } from '../jev-settings';
import { getSecretNonInteractive } from '../secrets-vault';

let tmp = '';

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(resolveJevFilesConfigPath(), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-file-tools-')));
  state.home = path.join(tmp, 'home');
  fs.mkdirSync(state.home, { recursive: true });
  state.settings = new Map();
  state.secret = { status: 'absent' };
  state.rows = [];
  state.logs = [];
  state.harnessProjects = [];
  state.workflowDefinitions = [];
  state.projectListeners = new Set();
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('writeJevFilesConfig: matriz flag x chave', () => {
  it.each<[string, string | undefined, boolean, boolean]>([
    ['flag off, sem chave', undefined, false, false],
    ['flag off, com chave', 'false', true, false],
    ['flag on, sem chave', 'true', false, false],
    ['flag on, com chave', 'true', true, true],
  ])('%s => enabled %s', async (_label, flag, hasKey, expected) => {
    if (flag !== undefined) state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, flag);
    if (hasKey) state.secret = { status: 'found', value: KEY_A };
    const result = await writeJevFilesConfig();
    expect(result.enabled).toBe(expected);
    expect(result.written).toBe(true);
    expect(resolveJevFileToolsRegistration().isActive).toBe(expected);
    const config = readConfig();
    expect(config.enabled).toBe(expected);
    const flagOn = flag === 'true';
    expect(config.credentialFingerprint).toBe(
      flagOn && hasKey ? fingerprintFor(String(config.credentialSalt), KEY_A) : null,
    );
    expect(vi.mocked(getSecretNonInteractive)).toHaveBeenCalledTimes(flagOn ? 1 : 0);
    expect(JSON.stringify(config)).not.toContain(KEY_A);
    expect(parseJevFilesConfig(config).ok).toBe(true);
  });

  it('com a flag desligada nao toca o Vault nem com chave ilegivel, e nao gera keyError', async () => {
    state.secret = { status: 'error', code: 'VAULT-CORRUPT', reason: 'arquivo corrompido', backupPath: null };
    const result = await writeJevFilesConfig();
    expect(result.keyError).toBeNull();
    expect(result.enabled).toBe(false);
    expect(vi.mocked(getSecretNonInteractive)).not.toHaveBeenCalled();
    expect(resolveJevFileToolsRegistration().reason).toContain('desligado');
  });

  it('cria a raiz default (~/.lionclaw/workspaces) quando ela esta nas raizes; nao cria raizes digitadas', async () => {
    const defaultRoot = path.join(state.home, 'workspaces');
    expect(fs.existsSync(defaultRoot)).toBe(false);
    await writeJevFilesConfig();
    expect(fs.statSync(defaultRoot).isDirectory()).toBe(true);

    const typed = path.join(tmp, 'digitada');
    state.settings.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, JSON.stringify([typed]));
    const result = await writeJevFilesConfig();
    expect(result.roots).toEqual([typed]);
    expect(fs.existsSync(typed)).toBe(false);
  });

  it('usa o modelo e as raizes dos settings; raizes invalidas caem no default absoluto', async () => {
    state.settings.set('jev_model', 'jev-1.14.0');
    state.settings.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, JSON.stringify([tmp]));
    let result = await writeJevFilesConfig();
    expect(result.model).toBe('jev-1.14.0');
    expect(result.roots).toEqual([tmp]);
    expect(readConfig().roots).toEqual([tmp]);

    state.settings.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, '["relativa"]');
    result = await writeJevFilesConfig();
    expect(result.roots).toEqual([path.join(state.home, 'workspaces')]);
  });

  it('chave ilegivel no Vault => enabled false com motivo', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.secret = { status: 'error', code: 'VAULT-CORRUPT', reason: 'arquivo corrompido', backupPath: null };
    const result = await writeJevFilesConfig();
    expect(result.enabled).toBe(false);
    expect(result.keyError).toBe('arquivo corrompido');
    expect(resolveJevFileToolsRegistration().reason).toContain('arquivo corrompido');
  });
});

describe('writeJevFilesConfig: salt, fingerprint e escrita atomica', () => {
  it('o salt persiste entre escritas e e regenerado quando o arquivo tem salt invalido', async () => {
    await writeJevFilesConfig();
    const first = String(readConfig().credentialSalt);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await writeJevFilesConfig();
    expect(readConfig().credentialSalt).toBe(first);

    fs.writeFileSync(resolveJevFilesConfigPath(), JSON.stringify({ credentialSalt: 'curto' }));
    await writeJevFilesConfig();
    const regenerated = String(readConfig().credentialSalt);
    expect(regenerated).toMatch(/^[0-9a-f]{64}$/);
    expect(regenerated).not.toBe(first);
  });

  it('trocar a chave recalcula o fingerprint com o mesmo salt; remover grava null e enabled false', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.secret = { status: 'found', value: KEY_A };
    await writeJevFilesConfig();
    const salt = String(readConfig().credentialSalt);
    expect(readConfig().credentialFingerprint).toBe(fingerprintFor(salt, KEY_A));

    state.secret = { status: 'found', value: KEY_B };
    await applyJevFileToolsChange('key');
    expect(readConfig().credentialSalt).toBe(salt);
    expect(readConfig().credentialFingerprint).toBe(fingerprintFor(salt, KEY_B));

    state.secret = { status: 'absent' };
    await applyJevFileToolsChange('key');
    expect(readConfig().credentialFingerprint).toBeNull();
    expect(readConfig().enabled).toBe(false);
  });

  it('escreve por temp + rename e nao deixa temporario para tras', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');
    await writeJevFilesConfig();
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(String(from)).toMatch(/\.tmp$/);
    expect(String(to)).toBe(resolveJevFilesConfigPath());
    const leftovers = fs.readdirSync(path.dirname(resolveJevFilesConfigPath())).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    rename.mockRestore();
  });

  it('falha de escrita nao lanca: enabled vira false e a decisao de boot fica inativa', async () => {
    fs.writeFileSync(path.join(state.home, 'data'), 'nao e pasta');
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.secret = { status: 'found', value: KEY_A };
    const result = await writeJevFilesConfig();
    expect(result.written).toBe(false);
    expect(result.enabled).toBe(false);
    expect(resolveJevFileToolsRegistration()).toEqual({
      isActive: false,
      reason: 'jev-files.json nao pode ser escrito',
    });
  });
});

describe('applyJevFileToolsChange', () => {
  beforeEach(() => {
    state.secret = { status: 'found', value: KEY_A };
  });

  it('flag ligada com processo inativo: ativa, sobe e re-sincroniza o Codex', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.rows = [{ id: 'jev-files', isActive: false }];
    await applyJevFileToolsChange('flag');
    expect(mcp.updateMCPServer).toHaveBeenCalledWith('jev-files', { isActive: true });
    expect(mcp.startServer).toHaveBeenCalledWith('jev-files');
    expect(mcp.restartServer).not.toHaveBeenCalled();
    expect(mcp.discoverAndSaveMCPTools).toHaveBeenCalledWith('jev-files');
    expect(codex.syncCodexMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('reiniciar o processo re-indexa as tools no catalogo do gateway', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.rows = [{ id: 'jev-files', isActive: true }];
    await applyJevFileToolsChange('roots');
    expect(mcp.restartServer).toHaveBeenCalledWith('jev-files');
    expect(mcp.discoverAndSaveMCPTools).toHaveBeenCalledTimes(1);
  });

  it('falha na indexacao das tools nao lanca e vira warn', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.rows = [{ id: 'jev-files', isActive: false }];
    mcp.discoverAndSaveMCPTools.mockRejectedValueOnce(new Error('discovery falhou'));
    await expect(applyJevFileToolsChange('flag')).resolves.toBeUndefined();
    expect(state.logs.some(([level, ...rest]) => level === 'warn' && JSON.stringify(rest).includes('discovery'))).toBe(
      true,
    );
  });

  it('flag desligada: para, desativa e re-sincroniza o Codex', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'false');
    state.rows = [{ id: 'jev-files', isActive: true }];
    await applyJevFileToolsChange('flag');
    expect(mcp.stopServer).toHaveBeenCalledWith('jev-files');
    expect(mcp.updateMCPServer).toHaveBeenCalledWith('jev-files', { isActive: false });
    expect(mcp.startServer).not.toHaveBeenCalled();
    expect(mcp.discoverAndSaveMCPTools).not.toHaveBeenCalled();
    expect(codex.syncCodexMcpConfig).toHaveBeenCalledTimes(1);
    expect(readConfig().enabled).toBe(false);
  });

  it.each<'roots' | 'model' | 'key'>(['roots', 'model', 'key'])('%s com processo ativo reinicia', async (reason) => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.rows = [{ id: 'jev-files', isActive: true }];
    await applyJevFileToolsChange(reason);
    expect(mcp.restartServer).toHaveBeenCalledWith('jev-files');
    expect(mcp.updateMCPServer).not.toHaveBeenCalled();
    expect(codex.syncCodexMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('sem registro nos built-ins: so avisa, sem subir nem re-sincronizar', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    await applyJevFileToolsChange('flag');
    expect(mcp.startServer).not.toHaveBeenCalled();
    expect(mcp.updateMCPServer).not.toHaveBeenCalled();
    expect(codex.syncCodexMcpConfig).not.toHaveBeenCalled();
    expect(state.logs.some(([level, args]) => level === 'warn' && JSON.stringify(args).includes('reinicie'))).toBe(
      true,
    );
  });

  it('falha ao subir, ao reiniciar ou no re-sync nao lanca', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.rows = [{ id: 'jev-files', isActive: false }];
    mcp.startServer.mockRejectedValueOnce(new Error('spawn falhou'));
    codex.syncCodexMcpConfig.mockRejectedValueOnce(new Error('sync falhou'));
    await expect(applyJevFileToolsChange('flag')).resolves.toBeUndefined();
    state.rows = [{ id: 'jev-files', isActive: true }];
    mcp.restartServer.mockRejectedValueOnce(new Error('restart falhou'));
    await expect(applyJevFileToolsChange('roots')).resolves.toBeUndefined();
    expect(state.logs.filter(([level]) => level === 'warn').length).toBeGreaterThanOrEqual(3);
  });
});

describe('applyJevFileToolsChange: re-sync do Codex so quando a ativacao muda ou o processo (re)inicia', () => {
  it('trocar modelo ou chave com a flag desligada e processo inativo nao reinicia nem re-sincroniza', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'false');
    state.secret = { status: 'found', value: KEY_A };
    state.rows = [{ id: 'jev-files', isActive: false }];
    await applyJevFileToolsChange('model');
    await applyJevFileToolsChange('key');
    expect(mcp.restartServer).not.toHaveBeenCalled();
    expect(mcp.startServer).not.toHaveBeenCalled();
    expect(mcp.stopServer).not.toHaveBeenCalled();
    expect(mcp.updateMCPServer).not.toHaveBeenCalled();
    expect(codex.syncCodexMcpConfig).not.toHaveBeenCalled();
    expect(readConfig().enabled).toBe(false);
  });

  it('desligar com processo ja inativo nao re-sincroniza; desligar com processo ativo re-sincroniza uma vez', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'false');
    state.rows = [{ id: 'jev-files', isActive: false }];
    await applyJevFileToolsChange('flag');
    expect(codex.syncCodexMcpConfig).not.toHaveBeenCalled();
    state.rows = [{ id: 'jev-files', isActive: true }];
    await applyJevFileToolsChange('flag');
    expect(codex.syncCodexMcpConfig).toHaveBeenCalledTimes(1);
  });
});

describe('pastas dos projetos cadastrados entram sozinhas nas raizes', () => {
  function mkProject(name: string): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('junta pipelines e workflows dinamicos as raizes manuais, sem repetir, e ignora o que nao serve', async () => {
    const manual = mkProject('manual');
    const pipeline = mkProject('pipeline-a');
    const workflow = mkProject('workflow-b');
    const sensitive = mkProject('build');
    const missing = path.join(tmp, 'nao-existe');
    const file = path.join(tmp, 'arquivo.txt');
    fs.writeFileSync(file, 'x');
    state.settings.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, JSON.stringify([manual]));
    state.harnessProjects = [
      { projectPath: pipeline },
      { projectPath: manual.toUpperCase() },
      { projectPath: sensitive },
      { projectPath: missing },
      { projectPath: file },
      { projectPath: 'relativo/projeto' },
      { projectPath: '   ' },
    ];
    state.workflowDefinitions = [{ projectPath: workflow }, { projectPath: pipeline }];
    const result = await writeJevFilesConfig();
    expect(result.manualRoots).toEqual([manual]);
    expect(result.projectRoots).toEqual([pipeline, workflow]);
    expect(result.roots).toEqual([manual, pipeline, workflow]);
    expect(readConfig().roots).toEqual([manual, pipeline, workflow]);
    const roots = resolveJevFileToolsRoots();
    expect(roots.manual).toEqual([manual]);
    expect(roots.projects).toEqual([pipeline, workflow]);
  });

  it('sem projetos cadastrados as raizes sao so as manuais', async () => {
    const result = await writeJevFilesConfig();
    expect(result.projectRoots).toEqual([]);
    expect(result.roots).toEqual([path.join(state.home, 'workspaces')]);
  });

  it('falha ao listar projetos nao derruba a escrita', async () => {
    const { listHarnessProjects } = await import('../db');
    vi.mocked(listHarnessProjects).mockImplementationOnce(() => {
      throw new Error('db fechado');
    });
    expect(collectJevFileToolsProjectRoots()).toEqual([]);
    const result = await writeJevFilesConfig();
    expect(result.written).toBe(true);
    expect(state.logs.some(([level, ...rest]) => level === 'warn' && JSON.stringify(rest).includes('projetos'))).toBe(
      true,
    );
  });

  it('cadastrar um projeto reescreve o arquivo sem reiniciar o processo; sem mudanca nao reescreve', async () => {
    state.settings.set(JEV_FILE_TOOLS_ENABLED_SETTING_KEY, 'true');
    state.secret = { status: 'found', value: KEY_A };
    state.rows = [{ id: 'jev-files', isActive: true }];
    await writeJevFilesConfig();
    const unsubscribe = watchJevFileToolsProjectRoots();
    expect(state.projectListeners.size).toBe(1);
    const before = fs.readFileSync(resolveJevFilesConfigPath(), 'utf8');

    for (const listener of state.projectListeners) listener();
    await refreshJevFileToolsProjectRoots();
    expect(fs.readFileSync(resolveJevFilesConfigPath(), 'utf8')).toBe(before);

    const project = mkProject('novo-projeto');
    state.harnessProjects = [{ projectPath: project }];
    for (const listener of state.projectListeners) listener();
    await refreshJevFileToolsProjectRoots();
    expect(readConfig().roots).toEqual([path.join(state.home, 'workspaces'), project]);
    expect(mcp.restartServer).not.toHaveBeenCalled();
    expect(mcp.stopServer).not.toHaveBeenCalled();
    expect(codex.syncCodexMcpConfig).not.toHaveBeenCalled();

    unsubscribe();
    expect(state.projectListeners.size).toBe(0);
  });

  it('salvar as raizes manuais mantem as pastas dos projetos no arquivo', async () => {
    const project = mkProject('projeto-x');
    const manual = mkProject('manual-y');
    state.harnessProjects = [{ projectPath: project }];
    state.settings.set(JEV_FILE_TOOLS_ROOTS_SETTING_KEY, JSON.stringify([manual]));
    state.rows = [{ id: 'jev-files', isActive: false }];
    await applyJevFileToolsChange('roots');
    expect(readConfig().roots).toEqual([manual, project]);
  });
});

describe('readJevFileToolsStats: leitura limitada ao fim do arquivo', () => {
  it('acima de 2 MB le so a cauda e descarta a primeira linha parcial', async () => {
    const file = path.join(tmp, 'grande.jsonl');
    const line = `${JSON.stringify({ timestamp: '2026-10-08T12:00:00.000Z', files: 1, charsRead: 100, costUsd: 0 })}\n`;
    const lineBytes = Buffer.byteLength(line);
    const total = Math.ceil((JEV_FILES_STATS_TAIL_BYTES * 1.5) / lineBytes);
    fs.writeFileSync(file, line.repeat(total));
    const stats = await readJevFileToolsStats(file);
    const expected = Math.floor(JEV_FILES_STATS_TAIL_BYTES / lineBytes);
    expect(stats.calls).toBeGreaterThanOrEqual(expected - 1);
    expect(stats.calls).toBeLessThanOrEqual(expected);
    expect(stats.calls).toBeLessThan(total);
    expect(stats.files).toBe(stats.calls);
    expect(stats.lastAt).toBe('2026-10-08T12:00:00.000Z');
  });
});

describe('readJevFileToolsStats', () => {
  it('jsonl ausente => zeros', async () => {
    expect(await readJevFileToolsStats(path.join(tmp, 'nao.jsonl'))).toEqual({
      calls: 0,
      files: 0,
      charsRead: 0,
      costUsd: 0,
      estimatedTokensAvoided: 0,
      lastAt: null,
    });
  });

  it('soma as linhas validas, ignora linha corrompida e guarda o ultimo timestamp', async () => {
    const file = path.join(tmp, 'jev-files.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-10-08T10:00:00.000Z', files: 2, charsRead: 400, costUsd: 0.001 }),
        '{ corrompida',
        JSON.stringify({ timestamp: '2026-10-08T11:00:00.000Z', files: 1, charsRead: 100, costUsd: null }),
        '',
      ].join('\n'),
    );
    expect(await readJevFileToolsStats(file)).toEqual({
      calls: 2,
      files: 3,
      charsRead: 500,
      costUsd: 0.001,
      estimatedTokensAvoided: 125,
      lastAt: '2026-10-08T11:00:00.000Z',
    });
  });
});
