import { describe, expect, it, vi } from 'vitest';
import {
  ARCHMAP_BRIDGE_RESOURCES,
  archmapErrorStatus,
  createLionClawArchmapBridge,
  mapFreshnessToReport,
  type ArchmapBridgeApi,
} from '@/archmap/bridge/lionclaw-bridge';
import { isDashboardFreshnessReport, requestFreshnessReport } from '@/archmap/dashboard/freshness';
import type { ArchmapFreshness } from '@/types/archmap';

const GRAPH = { version: '1.0', project: { name: 'fixture' }, nodes: [], edges: [], layers: [] };

function freshness(over: Partial<ArchmapFreshness> = {}): ArchmapFreshness {
  return {
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
    ...over,
  };
}

function fakeApi(over: Partial<ArchmapBridgeApi> = {}): ArchmapBridgeApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    graph: vi.fn(async () => GRAPH),
    meta: vi.fn(async () => ({
      lastAnalyzedAt: '2026-10-09T00:00:00Z',
      gitCommitHash: 'abc',
      version: '1',
      analyzedFiles: 1,
    })),
    file: vi.fn(async (request: { repositoryId: string; path: string }) => ({
      path: request.path,
      content: 'export const a = 1;\n',
      language: 'typescript',
    })),
    freshness: vi.fn(async () => freshness()),
    ...over,
  } as ArchmapBridgeApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe('bridge em processo (window.lionclaw.archmap.*)', () => {
  it('serve os sete recursos do protocolo do dashboard sem postMessage', async () => {
    const api = fakeApi();
    const bridge = createLionClawArchmapBridge({ repositoryId: 'repo-1', projectName: 'fixture', api });
    expect(ARCHMAP_BRIDGE_RESOURCES).toEqual([
      'graph',
      'meta',
      'config',
      'staleness',
      'file',
      'diff-overlay',
      'domain-graph',
    ]);

    const graph = await bridge.fetch('graph');
    expect(graph.ok).toBe(true);
    expect(await graph.json()).toBe(GRAPH);
    expect(api.graph).toHaveBeenCalledWith('repo-1');

    const meta = await bridge.fetch('meta');
    expect(meta.ok).toBe(true);
    expect(await meta.json()).toMatchObject({ gitCommitHash: 'abc' });

    const config = await bridge.fetch('config');
    expect(await config.json()).toEqual({ autoUpdate: false, outputLanguage: 'pt-BR' });

    const staleness = await bridge.fetch('staleness');
    expect(staleness.ok).toBe(true);
    expect(isDashboardFreshnessReport(await staleness.json())).toBe(true);

    const file = await bridge.fetch('file', { path: 'src/a.ts' });
    expect(file.ok).toBe(true);
    expect(api.file).toHaveBeenCalledWith({ repositoryId: 'repo-1', path: 'src/a.ts' });
    expect(await file.json()).toMatchObject({ path: 'src/a.ts', language: 'typescript' });

    for (const resource of ['diff-overlay', 'domain-graph'] as const) {
      const res = await bridge.fetch(resource);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    }
  });

  it('entrega init imediato com o nome do projeto e o idioma', () => {
    const bridge = createLionClawArchmapBridge({ repositoryId: 'repo-1', projectName: 'fixture', api: fakeApi() });
    const listener = vi.fn();
    bridge.onInit(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ projectName: 'fixture', outputLanguage: 'pt-BR' });
    expect(bridge.getInit()?.viewSessionId).toBeTruthy();
  });

  it('propaga a recusa do IPC archmap:file (caminho fora do repo) como resposta nao-ok com o erro', async () => {
    const api = fakeApi({
      file: vi.fn(async () => ({ error: 'Arquivo do mapa indisponivel (outside): ../../etc/passwd', code: 'file' })),
    });
    const bridge = createLionClawArchmapBridge({ repositoryId: 'repo-1', projectName: 'fixture', api });
    const res = await bridge.fetch('file', { path: '../../etc/passwd' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('(outside)') });

    const missing = await bridge.fetch('file', { path: '' });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(400);
  });

  it('mapeia os codigos de erro do engine para status HTTP', () => {
    expect(archmapErrorStatus({ error: 'x', code: 'absent' })).toBe(404);
    expect(archmapErrorStatus({ error: 'x', code: 'repository_not_found' })).toBe(404);
    expect(archmapErrorStatus({ error: 'Arquivo do mapa indisponivel (not_in_graph): a', code: 'file' })).toBe(403);
    expect(archmapErrorStatus({ error: 'Arquivo do mapa indisponivel (missing): a', code: 'file' })).toBe(404);
    expect(archmapErrorStatus({ error: 'Arquivo do mapa indisponivel (binary): a', code: 'file' })).toBe(415);
    expect(archmapErrorStatus({ error: 'Arquivo do mapa indisponivel (too_large): a', code: 'file' })).toBe(413);
    expect(archmapErrorStatus({ error: 'x', code: 'graph_too_large' })).toBe(413);
    expect(archmapErrorStatus({ error: 'x' })).toBe(500);
  });

  it('erro de IPC (throw) vira resposta status 0; mapa ausente vira 404', async () => {
    const api = fakeApi({
      graph: vi.fn(async () => {
        throw new Error('ipc quebrado');
      }),
      meta: vi.fn(async () => ({ error: 'Metadados do mapa ausentes.', code: 'absent' })),
    });
    const bridge = createLionClawArchmapBridge({ repositoryId: 'repo-1', projectName: 'fixture', api });
    const graph = await bridge.fetch('graph');
    expect(graph.ok).toBe(false);
    expect(graph.status).toBe(0);
    expect(await graph.json()).toMatchObject({ error: 'ipc quebrado' });
    const meta = await bridge.fetch('meta');
    expect(meta.status).toBe(404);
  });

  it('respeita AbortSignal e dispose', async () => {
    const api = fakeApi({ graph: vi.fn(() => new Promise(() => {})) });
    const bridge = createLionClawArchmapBridge({ repositoryId: 'repo-1', projectName: 'fixture', api });
    const controller = new AbortController();
    const pending = bridge.fetch('graph', undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(bridge.fetch('meta', undefined, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    bridge.dispose();
    await expect(bridge.fetch('meta')).rejects.toThrow('Bridge disposed');
  });

  it('a freshness do dashboard aceita o relatorio mapeado (requestFreshnessReport)', async () => {
    const api = fakeApi({
      freshness: vi.fn(async () =>
        freshness({
          status: 'stale',
          label: 'desatualizado',
          reason: 'HEAD diferente',
          headCommitHash: 'b'.repeat(40),
          changedFileCount: 3,
          changedFiles: ['a.ts', 'b.ts', 'c.ts'],
          commitsBehind: 2,
          relation: 'behind',
        }),
      ),
    });
    const bridge = createLionClawArchmapBridge({ repositoryId: 'repo-1', projectName: 'fixture', api });
    const report = await requestFreshnessReport(bridge, new AbortController().signal);
    expect(report.graphs.knowledge).toMatchObject({
      status: 'stale',
      relation: 'behind',
      commitsBehind: 2,
      changedFileCount: 3,
    });
  });
});

describe('mapFreshnessToReport (ArchmapFreshness do LionClaw -> relatorio do dashboard)', () => {
  it('fresh, dirty e stale passam pelo validador do dashboard', () => {
    const fresh = mapFreshnessToReport(freshness());
    expect(fresh.graphs.knowledge.status).toBe('fresh');
    expect(isDashboardFreshnessReport(fresh)).toBe(true);

    const dirty = mapFreshnessToReport(
      freshness({
        status: 'dirty',
        label: 'desatualizado',
        changedFileCount: 2,
        changedFiles: ['a.ts', 'b.ts'],
        localChanges: true,
      }),
    );
    expect(dirty.graphs.knowledge).toMatchObject({
      status: 'dirty',
      changedFileCount: 2,
      commitsBehind: 0,
      commitsAhead: 0,
    });
    expect(isDashboardFreshnessReport(dirty)).toBe(true);

    const stale = mapFreshnessToReport(
      freshness({
        status: 'stale',
        headCommitHash: 'c'.repeat(40),
        commitsAhead: 1,
        relation: 'ahead',
        changedFileCount: 1,
        changedFiles: ['x'],
      }),
    );
    expect(stale.graphs.knowledge).toMatchObject({ status: 'stale', relation: 'ahead', commitsAhead: 1 });
    expect(isDashboardFreshnessReport(stale)).toBe(true);
  });

  it('partial vira stale com HEAD diferente, dirty com mudanca local e fresh sem nada', () => {
    const staleish = mapFreshnessToReport(
      freshness({
        status: 'partial',
        label: 'parcial',
        pendingFiles: 3,
        headCommitHash: 'd'.repeat(40),
        commitsBehind: 4,
      }),
    );
    expect(staleish.graphs.knowledge).toMatchObject({ status: 'stale', relation: 'behind', commitsBehind: 4 });
    expect(isDashboardFreshnessReport(staleish)).toBe(true);

    const dirtyish = mapFreshnessToReport(
      freshness({ status: 'partial', label: 'parcial', pendingFiles: 1, localChanges: true }),
    );
    expect(dirtyish.graphs.knowledge).toMatchObject({ status: 'dirty', changedFileCount: 1 });
    expect(isDashboardFreshnessReport(dirtyish)).toBe(true);

    const freshish = mapFreshnessToReport(freshness({ status: 'partial', label: 'parcial', pendingFiles: 2 }));
    expect(freshish.graphs.knowledge.status).toBe('fresh');
    expect(isDashboardFreshnessReport(freshish)).toBe(true);
  });

  it('unknown e hashes ausentes viram unknown com motivo conhecido pelo dashboard', () => {
    const unknown = mapFreshnessToReport(freshness({ status: 'unknown', label: 'desconhecido', reason: 'sem git' }));
    expect(unknown.graphs.knowledge).toMatchObject({ status: 'unknown', reason: 'git-head-unavailable' });
    expect(isDashboardFreshnessReport(unknown)).toBe(true);
    const noGraphHash = mapFreshnessToReport(freshness({ graphCommitHash: undefined }));
    expect(noGraphHash.graphs.knowledge).toMatchObject({ status: 'unknown', reason: 'missing-graph-commit' });
    expect(isDashboardFreshnessReport(noGraphHash)).toBe(true);
    const noHead = mapFreshnessToReport(freshness({ headCommitHash: '' }));
    expect(noHead.graphs.knowledge).toMatchObject({ status: 'unknown', reason: 'git-head-unavailable' });
  });
});
