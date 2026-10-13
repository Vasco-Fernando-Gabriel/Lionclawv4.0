// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorProvider, OrchestratorRuntime, ProviderStatusEntry } from '@/types';
import type { ArchmapRuntimeCapability, ArchmapUpdatePreview } from '@/types/archmap';
import { ARCHMAP_RUNTIME_IDS } from '@/types/archmap';
import { PROVIDER_LABELS } from '@/components/chat/composer/model-picker.logic';
import { ARCHMAP_CONFIRM_FULL_NOTICE, ArchmapGenerateModal } from '@/archmap/ArchmapGenerateModal';
import { useArchmapStore } from '@/stores/archmap-store';
import { useOrchestratorPickerStore } from '@/stores/orchestrator-picker-store';
import type { LocalRepositoryRecord } from '@/types/repo-graph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
  modelId: string,
  available: boolean,
  reason?: string,
): ProviderStatusEntry {
  return {
    runtime,
    provider,
    connected: available,
    available,
    ...(reason ? { reason } : {}),
    models: [
      {
        id: modelId,
        displayName: modelId,
        label: modelId,
        reasoningOptions: ['low', 'high'],
        defaultReasoning: 'high',
      },
    ],
  };
}

const ENTRIES: ProviderStatusEntry[] = [
  entry('claude-sdk', 'anthropic', 'claude-opus-5-5', true),
  entry('codex-sdk', 'codex', 'gpt-6-sol', true),
  entry('claude-compat-sdk', 'zai', 'glm-5.2', true),
  entry('claude-compat-sdk', 'minimax', 'minimax-m3', false, 'MiniMax sem chave no Vault'),
  entry('kimi-sdk', 'kimi', 'kimi-k3', true),
  entry('grok-sdk', 'grok', 'grok-4.6', false, 'Grok CLI nao autenticado'),
  entry('cursor-sdk', 'cursor', 'cursor-auto', false, 'Cursor sidecar ausente'),
  entry('lion-sdk', 'ollama', 'llama4', true),
  entry('lion-sdk', 'lmstudio', 'lmstudio-x', false, 'LM Studio desligado'),
  entry('lion-sdk', 'openai-compatible', 'compat-1', true),
  entry('lion-sdk', 'vertex-ai', 'gemini-3', true),
];

const CAPABILITIES: ArchmapRuntimeCapability[] = ARCHMAP_RUNTIME_IDS.map((runtime) => {
  const proved = { state: 'provado' as const, reason: 'perfil do mapa' };
  const pending = { state: 'nao_provado' as const, reason: 'mecanismo do app-server a identificar na S2 (F42)' };
  return {
    runtime,
    mechanism: `mecanismo ${runtime}`,
    guarantees:
      runtime === 'codex'
        ? { write: proved, shell: pending, network: pending, webTools: pending }
        : { write: proved, shell: proved, network: proved, webTools: proved },
    read: runtime === 'codex' ? 'free' : 'confined',
    readLabel: runtime === 'codex' ? 'leitura livre' : 'leitura confinada',
  };
});

const REPO: LocalRepositoryRecord = {
  id: 'repo-1',
  name: 'repositorio real',
  rootPath: 'C:\\repos\\repositorio real',
  canonicalRootPath: 'C:\\repos\\repositorio real',
  gitRoot: null,
  provider: 'codegraph',
  graphPath: null,
  status: 'absent',
  indexedCommit: null,
  indexedWorktreeHash: null,
  lastIndexedAt: null,
  statsJson: null,
  graphPromptSuppressedGlobal: false,
  settingsJson: '{}',
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
};

let container: HTMLDivElement;
let root: Root;
const listStatuses = vi.fn();
const settingsGet = vi.fn();
const estimate = vi.fn();
const cancel = vi.fn();
const build = vi.fn();
const update = vi.fn();
const runtimeCapabilities = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderModal(onClose = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<ArchmapGenerateModal open repo={REPO} mode="build" onClose={onClose} />);
  });
  await flush();
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  listStatuses.mockResolvedValue(ENTRIES);
  settingsGet.mockResolvedValue({
    orchestratorRuntime: 'claude-sdk',
    orchestratorProvider: 'anthropic',
    orchestratorModel: 'claude-opus-5-5',
    orchestratorEffort: 'high',
  });
  estimate.mockResolvedValue({
    fileCount: 1228,
    batchCount: 61,
    estimatedMinutes: 33,
    filteredByIgnore: 1859,
    warnings: ['scan: x'],
    runtime: null,
    provider: null,
    model: null,
    elapsedMs: 4200,
  });
  cancel.mockResolvedValue({ cancelled: true });
  build.mockResolvedValue({
    id: 'run-1',
    kind: 'build',
    status: 'running',
    startedAt: '2026-10-08T00:00:00Z',
    runtime: 'cloud',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  });
  update.mockResolvedValue({
    id: 'run-2',
    kind: 'update',
    status: 'running',
    startedAt: '2026-10-08T00:00:00Z',
    runtime: 'cloud',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  });
  runtimeCapabilities.mockResolvedValue(CAPABILITIES);
  (window as unknown as { lionclaw: unknown }).lionclaw = {
    provider: { listStatuses },
    settings: { get: settingsGet },
    archmap: { estimate, cancel, build, update, runtimeCapabilities, status: vi.fn(), onStatus: vi.fn(() => () => {}) },
  };
  useOrchestratorPickerStore.setState({ phase: 'idle', entries: [], error: null, loadedAt: null });
  useArchmapStore.setState({ repos: {}, capabilities: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function pickerTrigger(): HTMLButtonElement {
  const button = container.querySelector('button[aria-haspopup="listbox"]');
  if (!button) throw new Error('picker nao renderizado');
  return button as HTMLButtonElement;
}

describe('modal Gerar mapa (AC-1 + estimativa + confirmar inicia a rodada)', () => {
  it('lista todos os runtimes do composer e marca os indisponiveis com o motivo', async () => {
    await renderModal();
    await act(async () => {
      pickerTrigger().click();
    });
    await flush();
    const nav = container.querySelector('nav[aria-label="Providers"]');
    expect(nav).not.toBeNull();
    const tabs = [...nav!.querySelectorAll('button')];
    const labels = tabs.map((tab) => tab.textContent ?? '');
    for (const e of ENTRIES) expect(labels.some((label) => label.includes(PROVIDER_LABELS[e.provider]))).toBe(true);
    expect(tabs).toHaveLength(ENTRIES.length);
    const unavailable = ENTRIES.filter((e) => !e.available);
    const offTabs = tabs.filter((tab) => (tab.textContent ?? '').endsWith('off'));
    expect(offTabs).toHaveLength(unavailable.length);
    for (const e of unavailable) {
      expect(tabs.some((tab) => tab.getAttribute('title') === e.reason)).toBe(true);
    }
  });

  it('mostra a estimativa (arquivos, lotes, minutos, modelo) vinda de archmap:estimate, uma vez por abertura', async () => {
    await renderModal();
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(estimate).toHaveBeenCalledWith({ repositoryId: 'repo-1', selection: null });
    const values = container.querySelector('[data-testid="archmap-estimate-values"]');
    expect(values?.textContent).toContain('1228');
    expect(values?.textContent).toContain('61');
    expect(values?.textContent).toContain('~33');
    expect(values?.textContent).toContain('claude-opus-5-5');
    expect(container.textContent).toContain('1 aviso(s) do scan');
    expect(container.querySelector('[data-testid="archmap-read-label"]')?.textContent).toBe('leitura confinada');
  });

  it('confirmar inicia a rodada por archmap:build com a escolha do picker e fecha o modal', async () => {
    const onClose = vi.fn();
    await renderModal(onClose);
    const confirm = container.querySelector('[data-testid="archmap-confirm"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
    });
    await flush();
    expect(build).toHaveBeenCalledWith({
      repositoryId: 'repo-1',
      selection: expect.objectContaining({ runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5-5' }),
    });
    expect(update).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    const slot = useArchmapStore.getState().repos['repo-1'];
    expect(slot?.choice?.runtime).toBe('cloud');
    expect(slot?.status?.status).toBe('building');
    expect(slot?.status?.run?.id).toBe('run-1');
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it('no modo Atualizar o confirmar chama archmap:update', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<ArchmapGenerateModal open repo={REPO} mode="update" onClose={onClose} />);
    });
    await flush();
    await flush();
    await act(async () => {
      (container.querySelector('[data-testid="archmap-confirm"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(update).toHaveBeenCalledWith({ repositoryId: 'repo-1', selection: expect.anything() });
    expect(build).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('erro ao iniciar a rodada aparece no modal e o modal fica aberto', async () => {
    build.mockResolvedValueOnce({ error: 'Ja existe uma rodada em andamento para repo-1.' });
    const onClose = vi.fn();
    await renderModal(onClose);
    await act(async () => {
      (container.querySelector('[data-testid="archmap-confirm"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(container.querySelector('[data-testid="archmap-notice"]')?.textContent).toContain('rodada em andamento');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('trocar para o Codex muda o tooltip do runtime para leitura livre', async () => {
    await renderModal();
    await act(async () => {
      pickerTrigger().click();
    });
    await flush();
    const codexTab = [...container.querySelectorAll('nav[aria-label="Providers"] button')].find((tab) =>
      (tab.textContent ?? '').includes(PROVIDER_LABELS.codex),
    ) as HTMLButtonElement;
    await act(async () => {
      codexTab.click();
    });
    const option = container.querySelector('[role="option"][data-model-id="gpt-6-sol"]') as HTMLElement;
    await act(async () => {
      option.click();
    });
    const label = container.querySelector('[data-testid="archmap-read-label"]');
    expect(label?.textContent).toBe('leitura livre');
    expect(label?.getAttribute('title')).toBe('mecanismo codex');
    const guarantee = container.querySelector('[data-testid="archmap-guarantee-label"]');
    expect(guarantee?.textContent).toBe('garantia pendente');
    expect(guarantee?.getAttribute('title')).toContain('F42');
  });

  it('runtime com garantias provadas nao mostra o selo de garantia pendente', async () => {
    await renderModal();
    expect(container.querySelector('[data-testid="archmap-guarantee-label"]')).toBeNull();
  });

  it('fechar o modal com a estimativa em andamento cancela a estimativa', async () => {
    const pending: { resolve: ((value: unknown) => void) | null } = { resolve: null };
    estimate.mockImplementationOnce(() => new Promise((resolve) => (pending.resolve = resolve)));
    await renderModal();
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<ArchmapGenerateModal open={false} repo={REPO} mode="build" onClose={vi.fn()} />);
    });
    expect(cancel).toHaveBeenCalledWith('repo-1');
    pending.resolve?.({ error: 'Operacao cancelada.' });
    await flush();
  });

  it('estimativa concluida antes de fechar nao dispara cancelamento', async () => {
    await renderModal();
    await act(async () => {
      root.render(<ArchmapGenerateModal open={false} repo={REPO} mode="build" onClose={vi.fn()} />);
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('erro da estimativa aparece no modal e desabilita o confirmar', async () => {
    estimate.mockResolvedValueOnce({ error: 'Repositorio com 3200 arquivos apos os filtros, acima do teto de 3000.' });
    await renderModal();
    expect(container.querySelector('[data-testid="archmap-estimate-error"]')?.textContent).toContain('3000');
    expect((container.querySelector('[data-testid="archmap-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('S2-V9: cancelar durante o scan nao vira erro: o modal mostra rodada cancelada', async () => {
    build.mockResolvedValueOnce({ error: 'Operacao cancelada.', code: 'cancelled' });
    const onClose = vi.fn();
    await renderModal(onClose);
    await act(async () => {
      (container.querySelector('[data-testid="archmap-confirm"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(container.querySelector('[data-testid="archmap-notice"]')?.textContent).toBe(
      'Rodada cancelada antes de comecar.',
    );
    expect(useArchmapStore.getState().repos['repo-1']?.error ?? null).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('S2-V3: erro da ultima rodada aparece no modal', async () => {
    useArchmapStore.setState({
      repos: {
        'repo-1': {
          status: {
            status: 'error',
            indexedCommit: null,
            lastIndexedAt: null,
            lastRun: {
              id: 'r',
              kind: 'build',
              status: 'error',
              startedAt: 'x',
              runtime: 'cloud',
              provider: 'anthropic',
              model: 'm',
              error: 'Nenhum dos 10 lote(s) foi concluido',
            },
          },
          progress: null,
          estimating: false,
          pending: false,
          error: null,
          choice: null,
        },
      },
      capabilities: [],
    });
    await renderModal();
    expect(container.querySelector('[data-testid="archmap-last-run-error"]')?.textContent).toContain('Nenhum dos 10');
  });
});

function previewOf(over: Partial<ArchmapUpdatePreview> = {}): ArchmapUpdatePreview {
  return {
    action: 'PARTIAL_UPDATE',
    detail: 'detalhe',
    totalFiles: 1228,
    structuralCount: 3,
    structuralRatio: 0.002,
    threshold: 614,
    filesToReanalyze: 12,
    newFiles: 2,
    deletedFiles: 1,
    cosmeticFiles: 4,
    nonStructuralFiles: 5,
    pendingFiles: 0,
    manifestFiles: [],
    hubFiles: [],
    triggers: [],
    rerunLayers: false,
    rerunTour: false,
    legacy: false,
    ...over,
  };
}

async function renderUpdateModal(onClose = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<ArchmapGenerateModal open repo={REPO} mode="update" onClose={onClose} />);
  });
  await flush();
  await flush();
}

function confirmButton(): HTMLButtonElement {
  return container.querySelector('[data-testid="archmap-confirm"]') as HTMLButtonElement;
}

describe('S3: modal de atualizacao mostra a classificacao e so pede regeneracao completa em FULL', () => {
  it('PARTIAL: pede a estimativa em modo update e mostra acao, arquivos relidos e camadas/tour mantidos', async () => {
    estimate.mockResolvedValueOnce({
      fileCount: 1228,
      batchCount: 1,
      estimatedMinutes: 3,
      filteredByIgnore: 0,
      warnings: [],
      runtime: null,
      provider: null,
      model: null,
      elapsedMs: 10,
      update: previewOf(),
    });
    const onClose = vi.fn();
    await renderUpdateModal(onClose);
    expect(estimate).toHaveBeenCalledWith({ repositoryId: 'repo-1', selection: null, mode: 'update' });
    expect(container.querySelector('[data-testid="archmap-update-action"]')?.textContent).toBe('atualizacao parcial');
    const lines = container.querySelector('[data-testid="archmap-update-lines"]')?.textContent ?? '';
    expect(lines).toContain('12 arquivo(s) serao relido(s)');
    expect(lines).toContain('2 novo(s)');
    expect(lines).toContain('4 so cosmetico(s), mantido(s)');
    expect(lines).toContain('camadas e tour mantidos');
    expect(confirmButton().textContent).toBe('Atualizar mapa');
    await act(async () => {
      confirmButton().click();
    });
    await flush();
    expect(update).toHaveBeenCalledWith({ repositoryId: 'repo-1', selection: expect.anything() });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  const S5_BASE = {
    fileCount: 1228,
    batchCount: 1,
    estimatedMinutes: 3,
    filteredByIgnore: 0,
    warnings: [],
    runtime: null,
    provider: null,
    model: null,
    elapsedMs: 10,
  };

  it('S5 (SPEC 4.5): com a triagem Jev ligada o modal avisa que o numero aparece no fim da rodada', async () => {
    estimate.mockResolvedValueOnce({ ...S5_BASE, update: previewOf(), jevTriageEnabled: true });
    await renderUpdateModal();
    expect(container.querySelector('[data-testid="archmap-update-jev"]')?.textContent).toContain(
      'triagem Jev ligada: o numero de arquivos dispensados aparece no fim da rodada',
    );
  });

  it('S5 (SPEC 4.5): com a flag desligada o aviso da triagem nao aparece', async () => {
    estimate.mockResolvedValueOnce({ ...S5_BASE, update: previewOf(), jevTriageEnabled: false });
    await renderUpdateModal();
    expect(container.querySelector('[data-testid="archmap-update-action"]')?.textContent).toBe('atualizacao parcial');
    expect(container.querySelector('[data-testid="archmap-update-jev"]')).toBeNull();
  });

  it('S5 (SPEC 4.5): em FULL o aviso da triagem nao aparece mesmo com a flag ligada', async () => {
    estimate.mockResolvedValueOnce({
      ...S5_BASE,
      update: previewOf({ action: 'FULL_UPDATE', reason: 'too_many_changes', structuralCount: 700 }),
      jevTriageEnabled: true,
    });
    await renderUpdateModal();
    expect(container.querySelector('[data-testid="archmap-update-action"]')?.textContent).toBe('regeneracao completa');
    expect(container.querySelector('[data-testid="archmap-update-jev"]')).toBeNull();
  });

  it('ARCHITECTURE por manifest mostra o gatilho e camadas/tour refeitos', async () => {
    estimate.mockResolvedValueOnce({
      fileCount: 1228,
      batchCount: 1,
      estimatedMinutes: 3,
      filteredByIgnore: 0,
      warnings: [],
      runtime: null,
      provider: null,
      model: null,
      elapsedMs: 10,
      update: previewOf({
        action: 'ARCHITECTURE_UPDATE',
        triggers: ['manifest', 'hub'],
        manifestFiles: ['package.json'],
        hubFiles: ['src/core.ts'],
        rerunLayers: true,
        rerunTour: true,
        filesToReanalyze: 2,
      }),
    });
    await renderUpdateModal();
    expect(container.querySelector('[data-testid="archmap-update-action"]')?.textContent).toBe(
      'atualizacao de arquitetura',
    );
    const lines = container.querySelector('[data-testid="archmap-update-lines"]')?.textContent ?? '';
    expect(lines).toContain('camadas e tour refeitos');
    expect(lines).toContain('manifest alterado: package.json');
    expect(lines).toContain('arquivo hub alterado: src/core.ts');
    expect(confirmButton().textContent).toBe('Atualizar mapa');
  });

  it('FULL: mostra o motivo com contagem e limite, o botao vira "Regerar tudo" e o update vai com confirmFull', async () => {
    estimate.mockResolvedValueOnce({
      fileCount: 1228,
      batchCount: 61,
      estimatedMinutes: 33,
      filteredByIgnore: 0,
      warnings: [],
      runtime: null,
      provider: null,
      model: null,
      elapsedMs: 10,
      update: previewOf({
        action: 'FULL_UPDATE',
        reason: 'too_many_changes',
        structuralCount: 700,
        structuralRatio: 0.57,
        rerunLayers: true,
        rerunTour: true,
      }),
    });
    const onClose = vi.fn();
    await renderUpdateModal(onClose);
    expect(container.querySelector('[data-testid="archmap-update-action"]')?.textContent).toBe('regeneracao completa');
    const lines = container.querySelector('[data-testid="archmap-update-lines"]')?.textContent ?? '';
    expect(lines).toContain('mais de 50%');
    expect(lines).toContain('700 de 1228');
    expect(lines).toContain('limite 614');
    expect(confirmButton().textContent).toBe('Regerar tudo');
    await act(async () => {
      confirmButton().click();
    });
    await flush();
    expect(update).toHaveBeenCalledWith({ repositoryId: 'repo-1', selection: expect.anything(), confirmFull: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('update recusado com confirm_full: o modal mostra o motivo e o segundo confirmar reenvia com confirmFull', async () => {
    estimate.mockResolvedValueOnce({
      fileCount: 1228,
      batchCount: 1,
      estimatedMinutes: 3,
      filteredByIgnore: 0,
      warnings: [],
      runtime: null,
      provider: null,
      model: null,
      elapsedMs: 10,
      update: previewOf(),
    });
    update.mockResolvedValueOnce({
      error: 'A atualizacao exige regeneracao completa do mapa; confirme com confirmFull.',
      code: 'confirm_full',
      details: {
        action: 'FULL_UPDATE',
        reason: 'indexed_commit_missing',
        preview: previewOf({
          action: 'FULL_UPDATE',
          reason: 'indexed_commit_missing',
          rerunLayers: true,
          rerunTour: true,
        }),
        fileCount: 1228,
        batchCount: 61,
        estimatedMinutes: 33,
      },
    });
    const onClose = vi.fn();
    await renderUpdateModal(onClose);
    await act(async () => {
      confirmButton().click();
    });
    await flush();
    expect(update).toHaveBeenLastCalledWith({ repositoryId: 'repo-1', selection: expect.anything() });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="archmap-notice"]')?.textContent).toBe(ARCHMAP_CONFIRM_FULL_NOTICE);
    expect(container.querySelector('[data-testid="archmap-update-action"]')?.textContent).toBe('regeneracao completa');
    expect(container.querySelector('[data-testid="archmap-update-lines"]')?.textContent).toContain(
      'commit indexado nao existe mais',
    );
    expect(confirmButton().textContent).toBe('Regerar tudo');
    expect(useArchmapStore.getState().repos['repo-1']?.error ?? null).toBeNull();
    await act(async () => {
      confirmButton().click();
    });
    await flush();
    expect(update).toHaveBeenLastCalledWith({
      repositoryId: 'repo-1',
      selection: expect.anything(),
      confirmFull: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('modo Gerar nao mostra o painel de atualizacao nem pede o modo update', async () => {
    await renderModal();
    expect(estimate).toHaveBeenCalledWith({ repositoryId: 'repo-1', selection: null });
    expect(container.querySelector('[data-testid="archmap-update-preview"]')).toBeNull();
  });
});
