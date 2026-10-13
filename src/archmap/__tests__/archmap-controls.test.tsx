// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchmapControls } from '@/pages/RepositoriesPage';
import { createArchmapSlot, type ArchmapRepoSlot } from '@/stores/archmap-store';
import type { ArchmapStatus } from '@/types/archmap';
import type { LocalRepositoryRecord } from '@/types/repo-graph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO: LocalRepositoryRecord = {
  id: 'repo-1',
  name: 'fixture',
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
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
};

let container: HTMLDivElement;
let root: Root;
const onGenerate = vi.fn();
const onCancel = vi.fn();

const WITH_MAP: readonly ArchmapStatus[] = ['ready', 'stale', 'partial'];

function slotFor(status: ArchmapStatus, over: Partial<ArchmapRepoSlot> = {}): ArchmapRepoSlot {
  const generation = WITH_MAP.includes(status) ? { generation: 'gen-1' } : {};
  return createArchmapSlot({ status: { status, indexedCommit: null, lastIndexedAt: null, ...generation }, ...over });
}

function slotWithMap(status: ArchmapStatus, over: Partial<ArchmapRepoSlot> = {}): ArchmapRepoSlot {
  return createArchmapSlot({
    status: {
      status,
      indexedCommit: 'a'.repeat(40),
      lastIndexedAt: '2026-10-09T00:00:00Z',
      generation: 'gen-1',
      stats: { nodeCount: 10, edgeCount: 5, fileCount: 3, layerCount: 2 },
    },
    ...over,
  });
}

async function render(slot: ArchmapRepoSlot): Promise<void> {
  await act(async () => {
    root.render(<ArchmapControls repo={REPO} slot={slot} onGenerate={onGenerate} onCancel={onCancel} />);
  });
}

function buttons(): string[] {
  return [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('linha do repositorio: status e botoes do Mapa de arquitetura', () => {
  it('sem mapa: "nao gerado" e botao Gerar mapa (AC-1)', async () => {
    await render(slotFor('absent'));
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe('nao gerado');
    expect(buttons()).toEqual(['Gerar mapa', 'Abrir mapa']);
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
    });
    expect(onGenerate).toHaveBeenCalledWith(REPO, 'build');
  });

  it.each([
    ['ready', 'pronto'],
    ['stale', 'desatualizado'],
    ['partial', 'parcial'],
  ] as const)('com mapa (%s): rotulo "%s", Atualizar mapa e Regerar', async (status, label) => {
    await render(slotFor(status));
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe(label);
    expect(buttons()).toEqual(['Atualizar mapa', 'Regerar', 'Abrir mapa']);
    const [update, rebuild] = [...container.querySelectorAll('button')];
    await act(async () => {
      update.click();
      rebuild.click();
    });
    expect(onGenerate).toHaveBeenNthCalledWith(1, REPO, 'update');
    expect(onGenerate).toHaveBeenNthCalledWith(2, REPO, 'rebuild');
  });

  it('gerando: mostra a fase e so o botao Cancelar', async () => {
    await render(slotFor('building', { progress: { phase: 'scan', current: 120, total: 1228 } }));
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe(
      'gerando: scan 120/1228',
    );
    expect(buttons()).toEqual(['Cancelar', 'Abrir mapa']);
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
    });
    expect(onCancel).toHaveBeenCalledWith(REPO);
  });

  it('na fila e erro tem rotulos proprios', async () => {
    await render(slotFor('queued'));
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe('na fila');
    await render(slotFor('error', { error: 'boom' }));
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe('erro');
    expect(container.querySelector('[data-testid="archmap-error-repo-1"]')?.textContent).toBe('boom');
  });

  it('Abrir mapa abre a tela do mapa com o repositorio (S4) e fica desabilitado sem mapa', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <ArchmapControls
          repo={REPO}
          slot={slotFor('ready')}
          onGenerate={onGenerate}
          onCancel={onCancel}
          onOpen={onOpen}
        />,
      );
    });
    const open = container.querySelector('[data-testid="archmap-open-repo-1"]') as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect(open.getAttribute('title')).toBe('Abrir o Mapa de arquitetura deste repositorio');
    await act(async () => {
      open.click();
    });
    expect(onOpen).toHaveBeenCalledWith(REPO);

    for (const status of ['absent', 'building'] as const) {
      await act(async () => {
        root.render(
          <ArchmapControls
            repo={REPO}
            slot={slotFor(status)}
            onGenerate={onGenerate}
            onCancel={onCancel}
            onOpen={onOpen}
          />,
        );
      });
      const disabled = container.querySelector('[data-testid="archmap-open-repo-1"]') as HTMLButtonElement;
      expect(disabled.disabled).toBe(true);
      expect(disabled.getAttribute('title')).toBe('gere o mapa antes de abrir');
    }

    await render(slotFor('ready'));
    expect((container.querySelector('[data-testid="archmap-open-repo-1"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('S4-V1: "ha mapa" vem da geracao corrente, nao do status da rodada', async () => {
    const onOpen = vi.fn();
    const renderWith = (slot: ArchmapRepoSlot) =>
      act(async () => {
        root.render(
          <ArchmapControls repo={REPO} slot={slot} onGenerate={onGenerate} onCancel={onCancel} onOpen={onOpen} />,
        );
      });
    const open = () => container.querySelector('[data-testid="archmap-open-repo-1"]') as HTMLButtonElement;

    await renderWith(slotWithMap('error'));
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe('erro');
    expect(buttons()).toEqual(['Atualizar mapa', 'Regerar', 'Abrir mapa']);
    expect(open().disabled).toBe(false);
    await act(async () => {
      open().click();
    });
    expect(onOpen).toHaveBeenCalledWith(REPO);

    await renderWith(slotWithMap('building', { progress: { phase: 'analysis', current: 2, total: 9 } }));
    expect(buttons()).toEqual(['Cancelar', 'Abrir mapa']);
    expect(open().disabled).toBe(false);
    expect(open().getAttribute('title')).toBe('Abrir o Mapa de arquitetura deste repositorio');

    await renderWith(slotFor('building', { progress: { phase: 'scan' } }));
    expect(buttons()).toEqual(['Cancelar', 'Abrir mapa']);
    expect(open().disabled).toBe(true);

    await renderWith(slotFor('error'));
    expect(buttons()).toEqual(['Gerar mapa', 'Abrir mapa']);
    expect(open().disabled).toBe(true);
  });
});

describe('linha do repositorio durante a rodada (S2)', () => {
  it('mostra fase, contadores e ultimo erro enquanto gera e so o botao Cancelar', async () => {
    await render(
      slotFor('building', {
        progress: {
          phase: 'analysis',
          current: 4,
          total: 10,
          succeeded: 3,
          reused: 1,
          failed: 1,
          lastError: 'lote 2: resposta rejeitada apos 3 tentativa(s)',
        },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe('gerando: analise 4/10');
    expect(container.querySelector('[data-testid="archmap-counters-repo-1"]')?.textContent).toBe(
      '3 concluido(s), 1 reaproveitado(s), 1 com erro',
    );
    expect(container.querySelector('[data-testid="archmap-last-error-repo-1"]')?.textContent).toContain('lote 2');
    expect(buttons()).toEqual(['Cancelar', 'Abrir mapa']);
  });

  it('ao terminar mostra pronto, parcial (com tooltip de pendentes) ou erro', async () => {
    await render(
      slotFor('ready', {
        status: {
          status: 'ready',
          indexedCommit: 'abc',
          lastIndexedAt: 'x',
          stats: { nodeCount: 5, edgeCount: 2, fileCount: 3, layerCount: 1 },
        },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe('pronto');
    expect(container.textContent).toContain('3 arquivos / 5 nos');
    expect(container.querySelector('[data-testid="archmap-counters-repo-1"]')).toBeNull();
    await render(
      slotFor('partial', { status: { status: 'partial', indexedCommit: 'abc', lastIndexedAt: 'x', pendingFiles: 4 } }),
    );
    const status = container.querySelector('[data-testid="archmap-status-repo-1"]');
    expect(status?.textContent).toBe('parcial');
    expect(status?.getAttribute('title')).toBe('4 arquivo(s) pendente(s)');
    await render(slotFor('error', { error: 'Nenhum dos 10 lote(s) foi concluido' }));
    expect(container.querySelector('[data-testid="archmap-error-repo-1"]')?.textContent).toContain('Nenhum dos 10');
  });
});

describe('S2-V3: avisos visiveis na linha do repo', () => {
  it('mostra o motivo do fallback, o erro da ultima rodada e os avisos no tooltip', async () => {
    await render(
      slotFor('ready', {
        status: {
          status: 'ready',
          indexedCommit: 'a',
          lastIndexedAt: 'x',
          layersStale: true,
          tourStale: true,
          fallback: ['camadas: LLM-TIMEOUT'],
          lastRun: {
            id: 'r',
            kind: 'build',
            status: 'done',
            startedAt: 'x',
            runtime: 'cloud',
            provider: 'anthropic',
            model: 'm',
            warnings: ['camadas: LLM-TIMEOUT — camadas deterministicas', 'lote 3: pendente'],
          },
        },
      }),
    );
    const status = container.querySelector('[data-testid="archmap-status-repo-1"]');
    expect(status?.textContent).toBe('pronto (automatico)');
    expect(status?.getAttribute('title')).toContain('2 aviso(s) da ultima rodada');
    expect(status?.getAttribute('title')).toContain('lote 3: pendente');
    expect(container.querySelector('[data-testid="archmap-fallback-repo-1"]')?.textContent).toBe(
      'camadas e tour gerados sem LLM: camadas: LLM-TIMEOUT',
    );
    await render(
      slotFor('ready', {
        status: {
          status: 'ready',
          indexedCommit: 'a',
          lastIndexedAt: 'x',
          lastRun: {
            id: 'r',
            kind: 'build',
            status: 'error',
            startedAt: 'x',
            runtime: 'cloud',
            provider: 'anthropic',
            model: 'm',
            error: 'Geracao abortada: excedeu o teto total',
          },
        },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-run-error-repo-1"]')?.textContent).toContain(
      'excedeu o teto total',
    );
    await render(
      slotFor('error', {
        status: { status: 'error', indexedCommit: null, lastIndexedAt: null, error: 'git nao respondeu' },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-status-error-repo-1"]')?.textContent).toBe(
      'git nao respondeu',
    );
  });
});

describe('AC-14: badge com o motivo da freshness no tooltip', () => {
  const freshness = (status: string, label: string, reason: string) => ({
    status,
    label,
    reason,
    changedFileCount: 0,
    changedFiles: [],
    commitsBehind: 0,
    commitsAhead: 0,
    localChanges: status === 'dirty',
    pendingFiles: status === 'partial' ? 2 : 0,
  });

  it.each([
    [
      'stale',
      'desatualizado',
      freshness('stale', 'desatualizado', 'HEAD diferente do commit do mapa (3 arquivo(s) alterado(s))'),
    ],
    ['stale', 'desatualizado', freshness('dirty', 'desatualizado', 'mudancas locais em 1 arquivo(s) do mapa')],
    ['partial', 'parcial', freshness('partial', 'parcial', '2 arquivo(s) pendente(s) de analise')],
  ] as const)('%s mostra "%s" com o motivo no tooltip', async (status, label, fresh) => {
    await render(
      createArchmapSlot({
        status: { status, indexedCommit: 'a', lastIndexedAt: 'x', freshness: fresh as never },
      }),
    );
    const badge = container.querySelector('[data-testid="archmap-status-repo-1"]');
    expect(badge?.textContent).toBe(label);
    expect(badge?.getAttribute('title')).toContain(fresh.reason);
  });

  it('S5: mostra a linha da triagem Jev da ultima rodada e o motivo quando ela ficou indisponivel', async () => {
    const lastRun = {
      id: 'r',
      kind: 'update' as const,
      status: 'done' as const,
      startedAt: 'x',
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'm',
    };
    await render(
      slotWithMap('ready', {
        status: {
          status: 'ready',
          indexedCommit: 'a',
          lastIndexedAt: 'x',
          generation: 'gen-2',
          lastRun: { ...lastRun, jevAsked: 12, jevDispensed: 5, jevCostUsd: 0.0012 },
        },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-jev-repo-1"]')?.textContent).toBe(
      'Jev dispensou 5 de 12 arquivo(s) (US$ 0.0012)',
    );
    await render(
      slotWithMap('ready', {
        status: {
          status: 'ready',
          indexedCommit: 'a',
          lastIndexedAt: 'x',
          generation: 'gen-2',
          lastRun: { ...lastRun, jevFallbackReason: 'chave do Jev nao configurada no Vault' },
        },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-jev-repo-1"]')?.textContent).toBe(
      'triagem Jev indisponivel: chave do Jev nao configurada no Vault',
    );
    expect(container.querySelector('[data-testid="archmap-run-error-repo-1"]')).toBeNull();
    await render(
      slotWithMap('ready', { status: { status: 'ready', indexedCommit: 'a', lastIndexedAt: 'x', lastRun } }),
    );
    expect(container.querySelector('[data-testid="archmap-jev-repo-1"]')).toBeNull();
    await render(
      slotWithMap('building', {
        status: {
          status: 'building',
          indexedCommit: 'a',
          lastIndexedAt: 'x',
          run: { ...lastRun, status: 'running', progress: { phase: 'triage', current: 3, total: 12 } },
          lastRun: { ...lastRun, jevAsked: 12, jevDispensed: 5 },
        },
      }),
    );
    expect(container.querySelector('[data-testid="archmap-status-repo-1"]')?.textContent).toBe(
      'gerando: triagem Jev 3/12',
    );
    expect(container.querySelector('[data-testid="archmap-jev-repo-1"]')).toBeNull();
  });

  it('pronto nao mostra motivo', async () => {
    await render(
      createArchmapSlot({
        status: {
          status: 'ready',
          indexedCommit: 'a',
          lastIndexedAt: 'x',
          freshness: freshness('fresh', 'pronto', 'mapa no mesmo commit do HEAD, sem mudancas locais') as never,
        },
      }),
    );
    const badge = container.querySelector('[data-testid="archmap-status-repo-1"]');
    expect(badge?.textContent).toBe('pronto');
    expect(badge?.getAttribute('title')).toBeNull();
  });
});
