// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateGraph } from '@/archmap/core/schema';
import type { GraphEdge, GraphNode, KnowledgeGraph, Layer, TourStep } from '@/archmap/core/types';
import { useDashboardStore } from '@/archmap/dashboard/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/archmap/dashboard/utils/elk-layout', async () => {
  const actual = await vi.importActual<typeof import('@/archmap/dashboard/utils/elk-layout')>(
    '@/archmap/dashboard/utils/elk-layout',
  );
  return {
    ...actual,
    applyElkLayout: async (input: {
      children?: Array<{ id: string; width?: number; height?: number; children?: unknown[] }>;
    }) => {
      const children = (input.children ?? []).map((child, index) => ({
        ...child,
        x: (index % 20) * 320,
        y: Math.floor(index / 20) * 160,
      }));
      return { positioned: { ...input, children }, issues: [] };
    },
  };
});

const NODE_COUNT = 5758;
const EDGE_COUNT = 9835;
const LAYER_COUNT = 10;
const TOUR_STEPS = 12;
const TYPE_MIX: Array<[GraphNode['type'], number]> = [
  ['file', 1019],
  ['function', 4129],
  ['class', 105],
  ['service', 5],
  ['schema', 41],
  ['table', 295],
  ['document', 75],
  ['config', 88],
  ['pipeline', 1],
];
const BUDGET_MS = 3000;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function buildSyntheticGraph(): KnowledgeGraph {
  const random = seeded(42);
  const nodes: GraphNode[] = [];
  const files: GraphNode[] = [];
  const dirs = [
    'apps/desktop/src',
    'apps/gateway/src',
    'packages/shared/src',
    'packages/core/src',
    'infra',
    'docs',
    'db/migrations',
  ];
  let fileIndex = 0;
  const makeFile = (ext: string, type: GraphNode['type']): GraphNode => {
    const dir = dirs[fileIndex % dirs.length];
    const path = `${dir}/mod${Math.floor(fileIndex / dirs.length)}/arquivo-${fileIndex}.${ext}`;
    fileIndex += 1;
    return {
      id: `${type}:${path}`,
      type,
      name: path.split('/').pop()!,
      filePath: path,
      summary: `Resumo sintetico do arquivo ${fileIndex} com handler de pedidos, fila e cache.`,
      tags: ['sintetico', fileIndex % 3 === 0 ? 'handler' : 'servico', `mod${fileIndex % 17}`],
      complexity: (['simple', 'moderate', 'complex'] as const)[fileIndex % 3],
    };
  };
  for (const [type, count] of TYPE_MIX) {
    if (type === 'file') {
      for (let i = 0; i < count; i += 1) {
        const node = makeFile('ts', 'file');
        nodes.push(node);
        files.push(node);
      }
      continue;
    }
    if (
      type === 'document' ||
      type === 'config' ||
      type === 'schema' ||
      type === 'table' ||
      type === 'service' ||
      type === 'pipeline'
    ) {
      for (let i = 0; i < count; i += 1) {
        const node = makeFile(type === 'document' ? 'md' : type === 'config' ? 'json' : 'sql', type);
        nodes.push(node);
      }
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      const owner = files[Math.floor(random() * files.length)];
      const symbol = `${type === 'class' ? 'Classe' : 'funcao'}${i}Handler`;
      nodes.push({
        id: `${type}:${owner.filePath}:${symbol}`,
        type,
        name: symbol,
        filePath: owner.filePath,
        lineRange: [1 + (i % 50), 10 + (i % 50)],
        summary: `Simbolo sintetico ${symbol} que processa pedidos e grava no banco.`,
        tags: ['sintetico', i % 2 === 0 ? 'handler' : 'util'],
        complexity: (['simple', 'moderate', 'complex'] as const)[i % 3],
      });
    }
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (source: string, target: string, type: GraphEdge['type']): void => {
    const key = `${source}|${target}|${type}`;
    if (source === target || seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, type, direction: 'forward', weight: 0.5 });
  };
  for (const node of nodes) {
    if (edges.length >= EDGE_COUNT) break;
    if ((node.type === 'function' || node.type === 'class') && node.filePath)
      push(`file:${node.filePath}`, node.id, 'contains');
  }
  while (edges.length < EDGE_COUNT) {
    const a = files[Math.floor(random() * files.length)];
    const b = files[Math.floor(random() * files.length)];
    push(a.id, b.id, random() < 0.7 ? 'imports' : 'depends_on');
  }
  const layers: Layer[] = Array.from({ length: LAYER_COUNT }, (_, i) => ({
    id: `layer-${i}`,
    name: `Camada ${i}`,
    description: `Camada sintetica ${i}`,
    nodeIds: [],
  }));
  nodes.forEach((node, index) => {
    if (node.type === 'function' || node.type === 'class') return;
    layers[index % LAYER_COUNT].nodeIds.push(node.id);
  });
  const tour: TourStep[] = Array.from({ length: TOUR_STEPS }, (_, i) => ({
    order: i + 1,
    title: `Passo ${i + 1}`,
    description: `Descricao do passo ${i + 1}`,
    nodeIds: [files[i].id],
  }));
  return {
    version: '1.0',
    project: {
      name: 'sintetico',
      languages: ['typescript', 'sql', 'markdown'],
      frameworks: ['Electron'],
      description: 'Grafo sintetico com os numeros de um repositorio real',
      analyzedAt: '2026-10-09T00:00:00Z',
      gitCommitHash: 'a'.repeat(40),
    },
    nodes,
    edges,
    layers,
    tour,
  };
}

function measure<T>(fn: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
}

describe('AC-17: grafo de 5.758 nos e 9.835 arestas', () => {
  it('o grafo sintetico tem os numeros de um repositorio real e valida pelo schema', () => {
    const graph = buildSyntheticGraph();
    expect(graph.nodes).toHaveLength(NODE_COUNT);
    expect(graph.edges).toHaveLength(EDGE_COUNT);
    expect(graph.layers).toHaveLength(LAYER_COUNT);
    expect(graph.tour).toHaveLength(TOUR_STEPS);
    const validation = measure(() => validateGraph(graph));
    expect(validation.result.success).toBe(true);
    expect(validation.result.issues.filter((i) => i.level === 'fatal')).toEqual([]);
  });

  it('o store carrega o grafo e a busca responde em menos de 3 s (jsdom)', () => {
    const graph = buildSyntheticGraph();
    const load = measure(() => useDashboardStore.getState().setGraph(graph));
    expect(useDashboardStore.getState().graph?.nodes).toHaveLength(NODE_COUNT);
    expect(useDashboardStore.getState().nodesById.size).toBe(NODE_COUNT);
    const search = measure(() => useDashboardStore.getState().setSearchQuery('handler'));
    const results = useDashboardStore.getState().searchResults;
    expect(results.length).toBeGreaterThan(0);
    const second = measure(() => useDashboardStore.getState().setSearchQuery('arquivo-123'));
    expect(useDashboardStore.getState().searchResults[0]?.nodeId).toContain('arquivo-123');
    const total = load.ms + search.ms + second.ms;
    expect(load.ms).toBeLessThan(BUDGET_MS);
    expect(search.ms).toBeLessThan(BUDGET_MS);
    expect(total).toBeLessThan(BUDGET_MS);
  });

  const realGraphPath = process.env.ARCHMAP_REAL_REPO
    ? join(process.env.ARCHMAP_REAL_REPO, '.lioncode', 'archmap', 'knowledge-graph.json')
    : null;

  it.skipIf(!realGraphPath || !existsSync(realGraphPath))(
    'grafo real de um repositorio real (somente leitura): carga e busca em menos de 3 s',
    () => {
      const raw = readFileSync(realGraphPath!, 'utf8');
      const parsed = measure(() => validateGraph(JSON.parse(raw)));
      expect(parsed.result.success).toBe(true);
      const graph = parsed.result.data!;
      const load = measure(() => useDashboardStore.getState().setGraph(graph));
      const search = measure(() => useDashboardStore.getState().setSearchQuery('index'));
      expect(graph.nodes.length).toBeGreaterThan(5000);
      expect(load.ms + search.ms).toBeLessThan(BUDGET_MS);
    },
  );
});

describe('AC-17: renderizar a visao geral do grafo grande (ELK mockado)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('a pagina monta as 10 camadas e responde a busca', async () => {
    const { ArchmapPage } = await import('@/pages/ArchmapPage');
    const { useAppStore } = await import('@/stores/app-store');
    const { useArchmapStore } = await import('@/stores/archmap-store');
    const { useRepoGraphStore } = await import('@/stores/repo-graph-store');
    const graph = buildSyntheticGraph();
    (window as unknown as { lionclaw: unknown }).lionclaw = {
      archmap: {
        status: vi.fn(async () => ({ status: 'ready', indexedCommit: 'a', lastIndexedAt: null, generation: 'gen-1' })),
        graph: vi.fn(async () => graph),
        meta: vi.fn(async () => ({
          lastAnalyzedAt: '2026-10-09T00:00:00Z',
          gitCommitHash: 'a',
          version: '1',
          analyzedFiles: 1,
        })),
        file: vi.fn(),
        freshness: vi.fn(async () => ({
          status: 'unknown',
          label: 'desconhecido',
          reason: '',
          changedFileCount: 0,
          changedFiles: [],
          commitsBehind: 0,
          commitsAhead: 0,
          localChanges: false,
          pendingFiles: 0,
        })),
        onStatus: vi.fn(() => () => {}),
        runtimeCapabilities: vi.fn(async () => []),
        estimate: vi.fn(),
        cancel: vi.fn(),
        build: vi.fn(),
        update: vi.fn(),
        runs: vi.fn(async () => []),
      },
      repoGraph: { list: vi.fn(async () => []) },
      provider: { listStatuses: vi.fn(async () => []) },
      settings: { get: vi.fn(async () => ({})) },
    };
    useAppStore.setState({ currentPage: 'archmap' });
    useRepoGraphStore.setState({
      repositories: [
        {
          id: 'repo-big',
          name: 'sintetico',
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
        },
      ],
    });
    useArchmapStore.setState({ repos: {}, capabilities: [], openRepositoryId: 'repo-big' });

    const started = performance.now();
    await act(async () => {
      root.render(<ArchmapPage />);
    });
    const text = () => container.textContent ?? '';
    while (
      !(useDashboardStore.getState().graph !== null && text().includes('Camada 9')) &&
      performance.now() - started < 30000
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const renderMs = performance.now() - started;
    expect(useDashboardStore.getState().graph?.nodes).toHaveLength(NODE_COUNT);
    for (let i = 0; i < LAYER_COUNT; i += 1) expect(text()).toContain(`Camada ${i}`);
    let search = { ms: 0 };
    await act(async () => {
      search = measure(() => useDashboardStore.getState().setSearchQuery('handler'));
    });
    expect(useDashboardStore.getState().searchResults.length).toBeGreaterThan(0);
    expect(renderMs).toBeLessThan(BUDGET_MS);
    expect(search.ms).toBeLessThan(BUDGET_MS);
  }, 60000);
});
