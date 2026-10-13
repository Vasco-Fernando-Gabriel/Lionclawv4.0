import { describe, expect, it, vi } from 'vitest';
import {
  archmapGuaranteeFor,
  archmapHasMap,
  archmapPhaseLabel,
  archmapReadLabelFor,
  archmapStatusLabel,
  createArchmapSlot,
  useArchmapStore,
} from '@/stores/archmap-store';
import { ARCHMAP_RUNTIME_IDS, archmapRuntimeForSelection, type ArchmapUpdateTrigger } from '@/types/archmap';

describe('rotulos de status do mapa na tela Repositorios', () => {
  it('mapeia cada status para o texto em pt-BR sem acentos', () => {
    const base = (status: string) =>
      createArchmapSlot({
        status: { status: status as never, indexedCommit: null, lastIndexedAt: null },
      });
    expect(archmapStatusLabel(createArchmapSlot())).toBe('nao gerado');
    expect(archmapStatusLabel(base('absent'))).toBe('nao gerado');
    expect(archmapStatusLabel(base('queued'))).toBe('na fila');
    expect(archmapStatusLabel(base('building'))).toBe('gerando');
    expect(archmapStatusLabel(base('ready'))).toBe('pronto');
    expect(archmapStatusLabel(base('stale'))).toBe('desatualizado');
    expect(archmapStatusLabel(base('partial'))).toBe('parcial');
    expect(archmapStatusLabel(base('error'))).toBe('erro');
    expect(archmapStatusLabel(createArchmapSlot({ estimating: true }))).toBe('estimando');
  });

  it('gerando mostra a fase e o contador', () => {
    const slot = createArchmapSlot({
      status: { status: 'building', indexedCommit: null, lastIndexedAt: null },
      progress: { phase: 'analysis', current: 3, total: 10 },
    });
    expect(archmapStatusLabel(slot)).toBe('gerando: analise 3/10');
    expect(archmapPhaseLabel({ phase: 'scan' })).toBe('scan');
    expect(archmapPhaseLabel({ phase: 'layers' })).toBe('camadas');
    expect(archmapPhaseLabel(null)).toBeNull();
  });
});

describe('runtime do mapa a partir da escolha do picker', () => {
  it('cobre todos os pares runtime/provider do composer', () => {
    expect(archmapRuntimeForSelection('claude-sdk', 'anthropic')).toBe('cloud');
    expect(archmapRuntimeForSelection('codex-sdk', 'codex')).toBe('codex');
    expect(archmapRuntimeForSelection('claude-compat-sdk', 'zai')).toBe('zai');
    expect(archmapRuntimeForSelection('claude-compat-sdk', 'minimax')).toBe('minimax-tp');
    expect(archmapRuntimeForSelection('kimi-sdk', 'kimi')).toBe('kimi');
    expect(archmapRuntimeForSelection('grok-sdk', 'grok')).toBe('grok');
    expect(archmapRuntimeForSelection('cursor-sdk', 'cursor')).toBe('cursor');
    expect(archmapRuntimeForSelection('lion-sdk', 'ollama')).toBe('local');
    expect(archmapRuntimeForSelection('lion-sdk', 'lmstudio')).toBe('local');
    expect(archmapRuntimeForSelection('lion-sdk', 'openai-compatible')).toBe('external');
    expect(archmapRuntimeForSelection('lion-sdk', 'vertex-ai')).toBe('google-genai');
    expect(archmapRuntimeForSelection('claude-sdk', 'codex')).toBeNull();
  });

  it('rotulo de leitura vem da tabela de capacidades', () => {
    const proved = { state: 'provado' as const, reason: 'perfil' };
    const pending = { state: 'nao_provado' as const, reason: 'F42' };
    const capabilities = ARCHMAP_RUNTIME_IDS.map((runtime) => ({
      runtime,
      mechanism: 'x',
      guarantees:
        runtime === 'codex'
          ? { write: proved, shell: proved, network: pending, webTools: pending }
          : { write: proved, shell: proved, network: proved, webTools: proved },
      read: runtime === 'codex' ? ('free' as const) : ('confined' as const),
      readLabel: runtime === 'codex' ? ('leitura livre' as const) : ('leitura confinada' as const),
    }));
    expect(archmapReadLabelFor(capabilities, 'cloud')).toBe('leitura confinada');
    expect(archmapReadLabelFor(capabilities, 'codex')).toBe('leitura livre');
    expect(archmapReadLabelFor(capabilities, null)).toBe('runtime fora do mapa');
    expect(archmapReadLabelFor([], 'grok')).toBe('leitura confinada');
    expect(archmapGuaranteeFor(capabilities, 'cloud')).toEqual({ label: 'garantia provada', reasons: [] });
    expect(archmapGuaranteeFor(capabilities, 'codex')?.label).toBe('garantia pendente');
    expect(archmapGuaranteeFor(capabilities, 'codex')?.reasons).toEqual(['network: F42', 'webTools: F42']);
    expect(archmapGuaranteeFor(capabilities, null)).toBeNull();
  });
});

describe('contadores da analise na linha do repo', () => {
  it('monta concluidos, reaproveitados e com erro so na fase de analise', async () => {
    const { archmapCountersLabel } = await import('@/stores/archmap-store');
    expect(archmapCountersLabel(null)).toBeNull();
    expect(archmapCountersLabel({ phase: 'scan', current: 1, total: 2 })).toBeNull();
    expect(archmapCountersLabel({ phase: 'analysis', current: 4, total: 10, succeeded: 3, reused: 1, failed: 1 })).toBe(
      '3 concluido(s), 1 reaproveitado(s), 1 com erro',
    );
    expect(archmapCountersLabel({ phase: 'analysis' })).toBe('0 concluido(s), 0 reaproveitado(s), 0 com erro');
  });
});

describe('S2-V3: fallback visivel e erro da ultima rodada', () => {
  it('pronto (automatico) quando camadas/tour nao vieram do LLM, com o motivo; erro da ultima rodada na linha', async () => {
    const { archmapFallbackNotice, archmapLastRunError, archmapStatusLabel, createArchmapSlot } =
      await import('@/stores/archmap-store');
    const ready = createArchmapSlot({ status: { status: 'ready', indexedCommit: 'a', lastIndexedAt: 'x' } });
    expect(archmapStatusLabel(ready)).toBe('pronto');
    const auto = createArchmapSlot({
      status: {
        status: 'ready',
        indexedCommit: 'a',
        lastIndexedAt: 'x',
        layersStale: true,
        tourStale: true,
        fallback: ['camadas: lote rejeitado', 'tour: LLM-TIMEOUT'],
      },
    });
    expect(archmapStatusLabel(auto)).toBe('pronto (automatico)');
    expect(archmapFallbackNotice(auto.status)).toBe(
      'camadas e tour gerados sem LLM: camadas: lote rejeitado; tour: LLM-TIMEOUT',
    );
    expect(archmapFallbackNotice(ready.status)).toBeNull();
    const errored = createArchmapSlot({
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
          error: 'Nenhum dos 10 lote(s) foi concluido',
        },
      },
    });
    expect(archmapLastRunError(errored.status)).toBe('ultima rodada com erro: Nenhum dos 10 lote(s) foi concluido');
    expect(archmapLastRunError(ready.status)).toBeNull();
  });
});

describe('S3: rotulos, motivo do badge, linhas da atualizacao e cancelamento recusado', () => {
  it('S2-R2: sufixo (automatico) tambem em desatualizado e parcial', async () => {
    const { archmapStatusLabel, createArchmapSlot } = await import('@/stores/archmap-store');
    const auto = (status: 'ready' | 'stale' | 'partial') =>
      createArchmapSlot({ status: { status, indexedCommit: 'a', lastIndexedAt: 'x', tourStale: true } });
    expect(archmapStatusLabel(auto('ready'))).toBe('pronto (automatico)');
    expect(archmapStatusLabel(auto('stale'))).toBe('desatualizado (automatico)');
    expect(archmapStatusLabel(auto('partial'))).toBe('parcial (automatico)');
  });

  it('AC-14: o motivo do badge vem da freshness so quando ha algo a dizer', async () => {
    const { archmapFreshnessReason } = await import('@/stores/archmap-store');
    const base = {
      changedFileCount: 0,
      changedFiles: [],
      commitsBehind: 0,
      commitsAhead: 0,
      localChanges: false,
      pendingFiles: 0,
    };
    const withFreshness = (freshness: Record<string, unknown>) =>
      ({ status: 'stale', indexedCommit: 'a', lastIndexedAt: 'x', freshness: { ...base, ...freshness } }) as never;
    expect(archmapFreshnessReason(withFreshness({ status: 'fresh', label: 'pronto', reason: 'ok' }))).toBeNull();
    expect(
      archmapFreshnessReason(
        withFreshness({
          status: 'stale',
          label: 'desatualizado',
          reason: 'HEAD diferente do commit do mapa (3 arquivo(s) alterado(s))',
        }),
      ),
    ).toContain('HEAD diferente');
    expect(
      archmapFreshnessReason(
        withFreshness({ status: 'dirty', label: 'desatualizado', reason: 'mudancas locais em 1 arquivo(s) do mapa' }),
      ),
    ).toBe('mudancas locais em 1 arquivo(s) do mapa');
    expect(
      archmapFreshnessReason(
        withFreshness({ status: 'partial', label: 'parcial', reason: '2 arquivo(s) pendente(s) de analise' }),
      ),
    ).toBe('2 arquivo(s) pendente(s) de analise');
    expect(archmapFreshnessReason(null)).toBeNull();
  });

  it('linhas do modal de atualizacao por acao', async () => {
    const { archmapUpdatePreviewLines } = await import('@/stores/archmap-store');
    const base = {
      detail: 'd',
      totalFiles: 100,
      structuralCount: 10,
      structuralRatio: 0.1,
      threshold: 50,
      filesToReanalyze: 12,
      newFiles: 0,
      deletedFiles: 0,
      cosmeticFiles: 0,
      nonStructuralFiles: 0,
      pendingFiles: 0,
      manifestFiles: [] as string[],
      hubFiles: [] as string[],
      triggers: [] as ArchmapUpdateTrigger[],
      rerunLayers: false,
      rerunTour: false,
      legacy: false,
    };
    expect(archmapUpdatePreviewLines({ ...base, action: 'PARTIAL_UPDATE' })).toEqual([
      '12 arquivo(s) serao relido(s)',
      'camadas e tour mantidos',
    ]);
    expect(
      archmapUpdatePreviewLines({
        ...base,
        action: 'ARCHITECTURE_UPDATE',
        triggers: ['structural_ratio', 'top_directory'],
        structuralCount: 30,
        rerunLayers: true,
        rerunTour: true,
        legacy: true,
      }),
    ).toEqual([
      '12 arquivo(s) serao relido(s)',
      'camadas e tour refeitos',
      'diretorio de topo criado ou removido',
      '30 de 100 arquivo(s) com mudanca estrutural (acima de 25%)',
      'mapa legado do LionCode: sera migrado para .lionclaw/archmap nesta atualizacao',
    ]);
    expect(
      archmapUpdatePreviewLines({ ...base, action: 'FULL_UPDATE', reason: 'too_many_changes', structuralCount: 60 }),
    ).toEqual([
      'mudanca estrutural em mais de 50% dos arquivos do grafo: 60 de 100 arquivo(s), limite 50',
      'todos os arquivos serao relidos; camadas e tour refeitos',
    ]);
    expect(archmapUpdatePreviewLines({ ...base, action: 'FULL_UPDATE', reason: 'no_git' })[0]).toBe(
      'o repositorio nao tem git',
    );
    expect(archmapUpdatePreviewLines({ ...base, action: 'SKIP', filesToReanalyze: 0, cosmeticFiles: 3 })).toEqual([
      '3 arquivo(s) com mudanca so cosmetica; nenhum sera relido',
      'camadas e tour mantidos',
    ]);
  });

  it('S2-R1: cancelamento recusado mostra o motivo do engine', async () => {
    const { archmapCancelRefusedMessage, ARCHMAP_CANCEL_REFUSED } = await import('@/stores/archmap-store');
    expect(archmapCancelRefusedMessage(undefined)).toBe(ARCHMAP_CANCEL_REFUSED);
    expect(archmapCancelRefusedMessage('gravando a geracao; a rodada termina em instantes')).toBe(
      'Cancelamento recusado: gravando a geracao; a rodada termina em instantes.',
    );
  });
});

describe('S4-V1: "ha mapa" pela geracao corrente e status com campo error', () => {
  it('archmapHasMap olha generation, stats ou legacy, nunca o status da rodada', () => {
    expect(archmapHasMap(null)).toBe(false);
    expect(archmapHasMap({ status: 'ready', indexedCommit: null, lastIndexedAt: null })).toBe(false);
    expect(archmapHasMap({ status: 'error', indexedCommit: null, lastIndexedAt: null, generation: 'gen-1' })).toBe(
      true,
    );
    expect(
      archmapHasMap({
        status: 'building',
        indexedCommit: null,
        lastIndexedAt: null,
        stats: { nodeCount: 1, edgeCount: 0, fileCount: 1, layerCount: 1 },
      }),
    ).toBe(true);
    expect(archmapHasMap({ status: 'stale', indexedCommit: null, lastIndexedAt: null, legacy: true })).toBe(true);
    expect(archmapHasMap({ status: 'absent', indexedCommit: null, lastIndexedAt: null })).toBe(false);
  });

  it('loadStatus aceita a resposta com status error + error (git nao respondeu) como status, nao como falha de IPC', async () => {
    const status = vi.fn(async () => ({
      status: 'error',
      error: 'git nao respondeu',
      indexedCommit: 'a'.repeat(40),
      lastIndexedAt: null,
      generation: 'gen-1',
    }));
    (globalThis as unknown as { window: unknown }).window = { lionclaw: { archmap: { status } } };
    useArchmapStore.setState({ repos: {} });
    await useArchmapStore.getState().loadStatus('repo-x');
    const slot = useArchmapStore.getState().repos['repo-x'];
    expect(slot.status?.status).toBe('error');
    expect(slot.status?.error).toBe('git nao respondeu');
    expect(slot.status?.generation).toBe('gen-1');
    expect(slot.error).toBeNull();
    expect(archmapHasMap(slot.status)).toBe(true);

    status.mockResolvedValueOnce({ error: 'Repositorio nao encontrado: repo-x' } as never);
    await useArchmapStore.getState().loadStatus('repo-x');
    expect(useArchmapStore.getState().repos['repo-x'].error).toBe('Repositorio nao encontrado: repo-x');
  });
});

describe('S5: linha da triagem Jev na linha do repo e na tela do mapa', () => {
  it('mostra "Jev dispensou N de M arquivo(s) (US$ x)" ou o motivo da indisponibilidade; nada sem triagem', async () => {
    const { archmapJevNotice } = await import('@/stores/archmap-store');
    const base = {
      id: 'r',
      kind: 'update' as const,
      status: 'done' as const,
      startedAt: 'x',
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'm',
    };
    const status = (lastRun: Record<string, unknown>) => ({
      status: 'ready' as const,
      indexedCommit: 'a',
      lastIndexedAt: 'x',
      lastRun: { ...base, ...lastRun },
    });
    expect(archmapJevNotice(status({ jevAsked: 40, jevDispensed: 17, jevCostUsd: 0.0023 }))).toBe(
      'Jev dispensou 17 de 40 arquivo(s) (US$ 0.0023)',
    );
    expect(archmapJevNotice(status({ jevAsked: 690, jevDispensed: 234, jevCostUsd: 0.059 }))).toBe(
      'Jev dispensou 234 de 690 arquivo(s) (US$ 0.06)',
    );
    expect(archmapJevNotice(status({ jevAsked: 3 }))).toBe('Jev dispensou 0 de 3 arquivo(s) (US$ 0.0000)');
    expect(archmapJevNotice(status({ jevFallbackReason: 'timeout: request ao Jev estourou 20000 ms' }))).toBe(
      'triagem Jev indisponivel: timeout: request ao Jev estourou 20000 ms',
    );
    expect(archmapJevNotice(status({}))).toBeNull();
    expect(archmapJevNotice(status({ jevAsked: 0, jevDispensed: 0 }))).toBeNull();
    expect(archmapJevNotice({ status: 'ready', indexedCommit: 'a', lastIndexedAt: 'x' })).toBeNull();
    expect(archmapJevNotice(null)).toBeNull();
  });

  it('a fase triage tem rotulo em pt-BR', () => {
    expect(archmapPhaseLabel({ phase: 'triage', current: 12, total: 40 })).toBe('triagem Jev 12/40');
  });
});
