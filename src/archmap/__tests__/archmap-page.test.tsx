// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchmapPage } from '@/pages/ArchmapPage';
import { useAppStore } from '@/stores/app-store';
import { useArchmapStore } from '@/stores/archmap-store';
import { useRepoGraphStore } from '@/stores/repo-graph-store';
import { useDashboardStore } from '@/archmap/dashboard/store';
import type { ArchmapStatusResponse } from '@/types/archmap';
import type { LocalRepositoryRecord } from '@/types/repo-graph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'knowledge-graph.example.json'), 'utf8')) as {
  nodes: Array<{ id: string; type: string; filePath?: string; name: string }>;
  project: { name: string };
};

const REPO: LocalRepositoryRecord = {
  id: 'repo-1',
  name: 'exemplo-mapa',
  rootPath: '/r',
  canonicalRootPath: '/r',
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
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};

const STATUS: ArchmapStatusResponse = {
  status: 'ready',
  indexedCommit: 'a'.repeat(40),
  lastIndexedAt: '2026-10-09T00:00:00Z',
  stats: { nodeCount: 97, edgeCount: 183, fileCount: 20, layerCount: 7 },
  generation: 'gen-1',
  lastRun: {
    id: 'run-1',
    kind: 'build',
    status: 'done',
    startedAt: '2026-10-09T00:00:00Z',
    runtime: 'cloud',
    provider: 'anthropic',
    model: 'm',
    warnings: ['1 arquivo(s) pendente(s)', 'lote 2: resposta invalida'],
  },
  freshness: {
    status: 'fresh',
    label: 'pronto',
    reason: '',
    graphCommitHash: 'a'.repeat(40),
    headCommitHash: 'a'.repeat(40),
    changedFileCount: 0,
    changedFiles: [],
    commitsBehind: 0,
    commitsAhead: 0,
    localChanges: false,
    pendingFiles: 0,
  },
};

let container: HTMLDivElement;
let root: Root;
const status = vi.fn();
const graph = vi.fn();
const meta = vi.fn();
const file = vi.fn();
const freshness = vi.fn();
const onStatus = vi.fn(() => () => {});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: tempo esgotado');
    await flush(20);
  }
}

function click(element: Element): Promise<void> {
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function text(): string {
  return container.textContent ?? '';
}

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<ArchmapPage />);
  });
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  window.matchMedia =
    window.matchMedia ??
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList);
  status.mockResolvedValue(STATUS);
  graph.mockResolvedValue(FIXTURE);
  meta.mockResolvedValue({
    lastAnalyzedAt: '2026-10-09T00:00:00Z',
    gitCommitHash: 'a'.repeat(40),
    version: '1',
    analyzedFiles: 20,
  });
  freshness.mockResolvedValue(STATUS.freshness);
  file.mockImplementation(async (request: { repositoryId: string; path: string }) => {
    if (request.path.startsWith('..') || request.path.startsWith('/')) {
      return { error: `Arquivo do mapa indisponivel (outside): ${request.path}`, code: 'file' };
    }
    return { path: request.path, content: `export const fromRepo = '${request.path}';\n`, language: 'typescript' };
  });
  (window as unknown as { lionclaw: unknown }).lionclaw = {
    archmap: {
      status,
      graph,
      meta,
      file,
      freshness,
      onStatus,
      runtimeCapabilities: vi.fn(async () => []),
      estimate: vi.fn(),
      cancel: vi.fn(async () => ({ cancelled: true })),
      build: vi.fn(),
      update: vi.fn(),
      runs: vi.fn(async () => []),
    },
    repoGraph: { list: vi.fn(async () => [REPO]) },
    provider: { listStatuses: vi.fn(async () => []) },
    settings: { get: vi.fn(async () => ({})) },
  };
  useAppStore.setState({ currentPage: 'archmap' });
  useRepoGraphStore.setState({ repositories: [REPO] });
  useArchmapStore.setState({ repos: {}, capabilities: [], openRepositoryId: 'repo-1' });
  useDashboardStore.setState({
    graph: null,
    selectedNodeId: null,
    searchQuery: '',
    searchResults: [],
    tourActive: false,
    navigationLevel: 'overview',
    activeLayerId: null,
    codeViewerOpen: false,
    codeViewerNodeId: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('ArchmapPage (AC-15: tela do mapa aberta a partir de Repositorios)', () => {
  it('sem repositorio aberto mostra o aviso e volta para Repositorios', async () => {
    useArchmapStore.setState({ openRepositoryId: null });
    await renderPage();
    expect(container.querySelector('[data-testid="archmap-page-empty"]')).not.toBeNull();
    await click(container.querySelector('button')!);
    expect(useAppStore.getState().currentPage).toBe('repositories');
  });

  it('abre o grafo pela bridge em processo, mostra camadas, busca, painel do no, codigo via archmap:file e tour', async () => {
    await renderPage();
    await waitFor(() => graph.mock.calls.length > 0 && useDashboardStore.getState().graph !== null);
    expect(graph).toHaveBeenCalledWith('repo-1');
    expect(status).toHaveBeenCalledWith('repo-1');
    expect(freshness).toHaveBeenCalledWith('repo-1');

    expect(container.querySelector('[data-testid="archmap-page"]')).not.toBeNull();
    expect(text()).toContain('Mapa de arquitetura');
    expect(container.querySelector('[data-testid="archmap-page-repo"]')?.textContent).toBe('exemplo-mapa');
    expect(container.querySelector('[data-testid="archmap-page-status"]')?.textContent).toContain('pronto');
    expect(container.querySelector('[data-testid="archmap-page-warnings"]')?.textContent).toContain(
      '2 aviso(s) da ultima rodada',
    );
    expect(text()).toContain('lote 2: resposta invalida');

    const dashboardRoot = container.querySelector('.archmap-root');
    expect(dashboardRoot).not.toBeNull();
    const loaded = useDashboardStore.getState().graph!;
    expect(loaded.nodes).toHaveLength(FIXTURE.nodes.length);
    expect(loaded.layers.length).toBeGreaterThan(0);
    await waitFor(() => text().includes(loaded.project.name));
    for (const layer of loaded.layers) {
      await waitFor(() => text().includes(layer.name), 15000);
    }
    expect(useDashboardStore.getState().navigationLevel).toBe('overview');

    const search = container.querySelector<HTMLInputElement>('[data-testid="search-input"]');
    expect(search).not.toBeNull();
    const fileNode = FIXTURE.nodes.find((n) => n.type === 'file' && n.filePath)!;
    await typeInto(search!, fileNode.name);
    await waitFor(() => useDashboardStore.getState().searchResults.length > 0);
    expect(useDashboardStore.getState().searchResults[0]?.nodeId).toBeTruthy();
    const resultButtons = [...container.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes(fileNode.name),
    );
    expect(resultButtons.length).toBeGreaterThan(0);
    await click(resultButtons[0]);
    await waitFor(() => useDashboardStore.getState().selectedNodeId !== null);
    const selectedId = useDashboardStore.getState().selectedNodeId!;
    const selected = loaded.nodes.find((n) => n.id === selectedId)!;
    expect(selected.filePath).toBeTruthy();
    await waitFor(() => text().includes(selected.summary.slice(0, 40)));
    expect(useDashboardStore.getState().navigationLevel).toBe('layer-detail');

    const openCode = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Abrir codigo');
    expect(openCode).toBeDefined();
    await click(openCode!);
    await waitFor(() => file.mock.calls.length > 0);
    expect(file).toHaveBeenCalledWith({ repositoryId: 'repo-1', path: selected.filePath });
    await waitFor(() => text().includes(`fromRepo = '${selected.filePath}'`));
    expect(text()).toContain('Arquivo completo');

    const graphNode = container.querySelector<HTMLElement>('.react-flow__node[data-id]');
    if (graphNode) {
      await click(graphNode);
      await flush(20);
      expect(useDashboardStore.getState().selectedNodeId ?? useDashboardStore.getState().activeLayerId).toBeTruthy();
    }

    await act(async () => {
      useDashboardStore.getState().closeCodeViewer();
      useDashboardStore.getState().navigateToOverview();
    });
    await waitFor(() => useDashboardStore.getState().selectedNodeId === null);
    const tourButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Iniciar tour'));
    expect(tourButton).toBeDefined();
    await click(tourButton!);
    await waitFor(() => useDashboardStore.getState().tourActive);
    const firstStep = [...(loaded.tour ?? [])].sort((a, b) => a.order - b.order)[0];
    await waitFor(() => text().includes('Sair do tour') && text().includes(firstStep.title));
    expect(useDashboardStore.getState().currentTourStep).toBe(0);
    expect(useDashboardStore.getState().tourHighlightedNodeIds).toEqual(firstStep.nodeIds);

    await click(container.querySelector('[data-testid="archmap-page-back"]')!);
    expect(useAppStore.getState().currentPage).toBe('repositories');
  });

  it('caminho fora do repo: a recusa do IPC archmap:file chega ao viewer de codigo como erro', async () => {
    const outside = {
      ...FIXTURE,
      nodes: [
        ...FIXTURE.nodes,
        {
          id: 'file:../../etc/passwd',
          type: 'file',
          name: 'passwd',
          filePath: '../../etc/passwd',
          summary: 'no fora do repo',
          tags: ['fora'],
          complexity: 'simple',
        },
      ],
    };
    graph.mockResolvedValue(outside);
    await renderPage();
    await waitFor(() => useDashboardStore.getState().graph !== null);
    await act(async () => {
      useDashboardStore.getState().selectNode('file:../../etc/passwd');
      useDashboardStore.getState().openCodeViewer('file:../../etc/passwd');
    });
    await waitFor(() => file.mock.calls.length > 0);
    expect(file).toHaveBeenCalledWith({ repositoryId: 'repo-1', path: '../../etc/passwd' });
    await waitFor(() => text().includes('Codigo indisponivel'));
    expect(text()).toContain('Arquivo do mapa indisponivel (outside)');
    expect(text()).not.toContain('fromRepo');
  });

  it('S4-V2: carga unica ao abrir (graph, meta e freshness 1x) e remontagem so quando a geracao muda', async () => {
    status.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(STATUS), 30)));
    await renderPage();
    expect(container.querySelector('[data-testid="archmap-page-loading"]')).not.toBeNull();
    expect(container.querySelector('.archmap-root')).toBeNull();
    await waitFor(() => useDashboardStore.getState().graph !== null);
    await flush(100);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(freshness).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      useArchmapStore
        .getState()
        .applyEvent({ repositoryId: 'repo-1', progress: { phase: 'analysis', current: 1, total: 2 } });
    });
    await flush(50);
    expect(graph).toHaveBeenCalledTimes(1);

    status.mockResolvedValue({ ...STATUS, generation: 'gen-2' });
    await act(async () => {
      useArchmapStore.getState().applyEvent({
        repositoryId: 'repo-1',
        status: 'ready',
        run: { id: 'run-2', kind: 'update', status: 'done' },
      });
    });
    await waitFor(() => graph.mock.calls.length === 2);
    await flush(100);
    expect(graph).toHaveBeenCalledTimes(2);
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it('S4-V1: status error com geracao corrente mantem o dashboard e oferece Atualizar/Regerar', async () => {
    status.mockResolvedValue({ ...STATUS, status: 'error', error: 'git nao respondeu', freshness: undefined });
    await renderPage();
    await waitFor(() => useDashboardStore.getState().graph !== null);
    expect(container.querySelector('.archmap-root')).not.toBeNull();
    expect(container.querySelector('[data-testid="archmap-page-absent"]')).toBeNull();
    expect(container.querySelector('[data-testid="archmap-page-status"]')?.textContent).toContain('erro');
    expect(container.querySelector('[data-testid="archmap-page-notices"]')?.textContent).toContain('git nao respondeu');
    const labels = [...container.querySelectorAll('header button')].map((b) => (b.textContent ?? '').trim());
    expect(labels).toContain('Atualizar mapa');
    expect(labels).toContain('Regerar');
    expect(labels).not.toContain('Gerar mapa');
  });

  it('S4-V4: rodada em andamento sem geracao mostra o aviso em pt-BR e nunca monta o dashboard', async () => {
    status.mockResolvedValue({
      status: 'building',
      indexedCommit: null,
      lastIndexedAt: null,
      run: {
        id: 'run-1',
        kind: 'build',
        status: 'running',
        startedAt: '2026-10-09T00:00:00Z',
        runtime: 'cloud',
        provider: 'a',
        model: 'm',
        progress: { phase: 'scan' },
      },
    });
    graph.mockResolvedValue({ error: 'Mapa de arquitetura ausente.', code: 'absent' });
    await renderPage();
    await waitFor(() => container.querySelector('[data-testid="archmap-page-absent"]') !== null);
    await flush(50);
    expect(container.querySelector('.archmap-root')).toBeNull();
    expect(graph).not.toHaveBeenCalled();
    expect(text()).toContain('O Mapa de arquitetura esta sendo gerado pela primeira vez.');
    expect(text()).not.toContain('Failed to load');
    expect(container.querySelector('[data-testid="archmap-page-status"]')?.textContent).toContain('gerando');
  });

  it('S4-V8: repositorio removido mostra "Repositorio nao encontrado" e o botao de voltar', async () => {
    useRepoGraphStore.setState({ repositories: [{ ...REPO, id: 'outro' }] });
    await renderPage();
    await flush(20);
    const missing = container.querySelector('[data-testid="archmap-page-missing-repo"]');
    expect(missing).not.toBeNull();
    expect(missing?.textContent).toContain('Repositorio nao encontrado');
    expect(container.querySelector('.archmap-root')).toBeNull();
    expect(graph).not.toHaveBeenCalled();
    await click(missing!.querySelector('button')!);
    expect(useAppStore.getState().currentPage).toBe('repositories');
  });

  it('sem mapa (absent) mostra o convite para gerar e nao monta o dashboard', async () => {
    status.mockResolvedValue({ status: 'absent', indexedCommit: null, lastIndexedAt: null });
    graph.mockResolvedValue({ error: 'Mapa de arquitetura ausente.', code: 'absent' });
    await renderPage();
    await waitFor(() => status.mock.calls.length > 0);
    await flush(20);
    expect(container.querySelector('[data-testid="archmap-page-absent"]')).not.toBeNull();
    expect(container.querySelector('.archmap-root')).toBeNull();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Gerar mapa'))).toBe(true);
  });

  it('badge de freshness e pendentes aparecem na tela do mapa', async () => {
    status.mockResolvedValue({
      ...STATUS,
      status: 'partial',
      pendingFiles: 3,
      freshness: {
        ...STATUS.freshness!,
        status: 'partial',
        label: 'parcial',
        reason: '3 arquivo(s) pendente(s); HEAD diferente',
        pendingFiles: 3,
      },
    });
    await renderPage();
    await waitFor(() => container.querySelector('[data-testid="archmap-page-pending"]') !== null);
    expect(container.querySelector('[data-testid="archmap-page-status"]')?.textContent).toContain('parcial');
    expect(container.querySelector('[data-testid="archmap-page-notices"]')?.textContent).toContain('HEAD diferente');
  });

  it('S5: a tela do mapa mostra a linha da triagem Jev da ultima rodada', async () => {
    status.mockResolvedValue({
      ...STATUS,
      lastRun: { ...STATUS.lastRun!, kind: 'update', jevAsked: 40, jevDispensed: 17, jevCostUsd: 0.0023 },
    });
    await renderPage();
    await waitFor(() => container.querySelector('[data-testid="archmap-page-jev"]') !== null);
    expect(container.querySelector('[data-testid="archmap-page-jev"]')?.textContent).toBe(
      'Jev dispensou 17 de 40 arquivo(s) (US$ 0.0023)',
    );
  });

  it('S5: a tela do mapa mostra o motivo quando a triagem Jev ficou indisponivel', async () => {
    status.mockResolvedValue({
      ...STATUS,
      lastRun: { ...STATUS.lastRun!, kind: 'update', jevFallbackReason: 'http: Jev respondeu HTTP 503' },
    });
    await renderPage();
    await waitFor(
      () => container.querySelector('[data-testid="archmap-page-jev"]')?.textContent?.includes('indisponivel') === true,
    );
    expect(container.querySelector('[data-testid="archmap-page-jev"]')?.textContent).toBe(
      'triagem Jev indisponivel: http: Jev respondeu HTTP 503',
    );
  });
});
