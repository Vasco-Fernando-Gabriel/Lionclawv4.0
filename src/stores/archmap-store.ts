import { create } from 'zustand';
import type { SessionOrchestrator } from '@/types';
import type {
  ArchmapCancelResponse,
  ArchmapErrorPayload,
  ArchmapEstimateMode,
  ArchmapEstimateResponse,
  ArchmapFreshness,
  ArchmapGenerationChoice,
  ArchmapGuaranteeLabel,
  ArchmapProgress,
  ArchmapRunInfo,
  ArchmapRuntimeCapability,
  ArchmapRuntimeId,
  ArchmapStatusEvent,
  ArchmapStatusResponse,
  ArchmapUpdateAction,
  ArchmapUpdatePreview,
} from '@/types/archmap';
import { ARCHMAP_GUARANTEE_NAMES, ARCHMAP_PHASE_LABELS, archmapRuntimeForSelection } from '@/types/archmap';

export interface ArchmapRepoSlot {
  status: ArchmapStatusResponse | null;
  progress: ArchmapProgress | null;
  estimating: boolean;
  pending: boolean;
  error: string | null;
  choice: ArchmapGenerationChoice | null;
}

interface ArchmapStoreState {
  repos: Record<string, ArchmapRepoSlot>;
  capabilities: ArchmapRuntimeCapability[];
  openRepositoryId: string | null;
  openMap: (repositoryId: string) => void;
  closeMap: () => void;
  loadStatus: (repositoryId: string) => Promise<void>;
  loadCapabilities: () => Promise<ArchmapRuntimeCapability[]>;
  estimate: (
    repositoryId: string,
    selection: SessionOrchestrator | null,
    mode?: ArchmapEstimateMode,
  ) => Promise<ArchmapEstimateResponse | { error: string }>;
  cancel: (repositoryId: string) => Promise<ArchmapCancelResponse | { error: string }>;
  build: (repositoryId: string, selection: SessionOrchestrator) => Promise<ArchmapRunInfo | ArchmapErrorPayload>;
  update: (
    repositoryId: string,
    selection: SessionOrchestrator,
    confirmFull?: boolean,
  ) => Promise<ArchmapRunInfo | ArchmapErrorPayload>;
  runs: (repositoryId: string) => Promise<ArchmapRunInfo[] | { error: string }>;
  rememberChoice: (repositoryId: string, selection: SessionOrchestrator) => ArchmapGenerationChoice | null;
  clearError: (repositoryId: string) => void;
  applyEvent: (event: ArchmapStatusEvent) => void;
  init: () => () => void;
}

export function createArchmapSlot(over: Partial<ArchmapRepoSlot> = {}): ArchmapRepoSlot {
  return { status: null, progress: null, estimating: false, pending: false, error: null, choice: null, ...over };
}

export const EMPTY_ARCHMAP_SLOT: ArchmapRepoSlot = createArchmapSlot();

export const ARCHMAP_CANCEL_REFUSED = 'Cancelamento recusado: nenhuma rodada ou estimativa ativa neste repositorio.';

export function archmapCancelRefusedMessage(reason: string | undefined): string {
  return reason ? `Cancelamento recusado: ${reason}.` : ARCHMAP_CANCEL_REFUSED;
}

export const ARCHMAP_ACTION_LABELS: Record<ArchmapUpdateAction, string> = {
  SKIP: 'nada a reanalisar',
  PARTIAL_UPDATE: 'atualizacao parcial',
  ARCHITECTURE_UPDATE: 'atualizacao de arquitetura',
  FULL_UPDATE: 'regeneracao completa',
};

export const ARCHMAP_FULL_REASON_LABELS: Record<string, string> = {
  no_git: 'o repositorio nao tem git',
  meta_invalid: 'o meta.json do mapa esta ausente ou invalido',
  indexed_commit_missing: 'o commit indexado nao existe mais no repositorio',
  graph_invalid: 'o grafo do mapa esta ausente ou invalido',
  too_many_changes: 'mudanca estrutural em mais de 50% dos arquivos do grafo',
};

export function archmapUpdatePreviewLines(preview: ArchmapUpdatePreview): string[] {
  const lines: string[] = [];
  if (preview.action === 'FULL_UPDATE') {
    const reason = ARCHMAP_FULL_REASON_LABELS[preview.reason ?? ''] ?? preview.reason ?? 'motivo desconhecido';
    lines.push(
      preview.reason === 'too_many_changes'
        ? `${reason}: ${preview.structuralCount} de ${preview.totalFiles} arquivo(s), limite ${preview.threshold}`
        : reason,
    );
    lines.push('todos os arquivos serao relidos; camadas e tour refeitos');
    return lines;
  }
  if (preview.action === 'SKIP') {
    lines.push(
      preview.cosmeticFiles > 0
        ? `${preview.cosmeticFiles} arquivo(s) com mudanca so cosmetica; nenhum sera relido`
        : 'nenhuma mudanca detectada; so o commit do mapa e atualizado',
    );
    lines.push('camadas e tour mantidos');
    return lines;
  }
  const parts = [
    preview.newFiles > 0 ? `${preview.newFiles} novo(s)` : null,
    preview.deletedFiles > 0 ? `${preview.deletedFiles} removido(s)` : null,
    preview.pendingFiles > 0 ? `${preview.pendingFiles} pendente(s)` : null,
    preview.nonStructuralFiles > 0 ? `${preview.nonStructuralFiles} sem gramatica` : null,
    preview.cosmeticFiles > 0 ? `${preview.cosmeticFiles} so cosmetico(s), mantido(s)` : null,
  ].filter(Boolean);
  lines.push(
    `${preview.filesToReanalyze} arquivo(s) serao relido(s)${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`,
  );
  lines.push(preview.rerunLayers || preview.rerunTour ? 'camadas e tour refeitos' : 'camadas e tour mantidos');
  if (preview.triggers.includes('manifest')) lines.push(`manifest alterado: ${preview.manifestFiles.join(', ')}`);
  if (preview.triggers.includes('hub')) lines.push(`arquivo hub alterado: ${preview.hubFiles.join(', ')}`);
  if (preview.triggers.includes('top_directory')) lines.push('diretorio de topo criado ou removido');
  if (preview.triggers.includes('structural_ratio')) {
    lines.push(`${preview.structuralCount} de ${preview.totalFiles} arquivo(s) com mudanca estrutural (acima de 25%)`);
  }
  if (preview.legacy) lines.push('mapa legado do LionCode: sera migrado para .lionclaw/archmap nesta atualizacao');
  return lines;
}

export function archmapHasMap(status: ArchmapStatusResponse | null): boolean {
  if (!status) return false;
  return Boolean(status.generation || status.stats || status.legacy);
}

export function archmapFreshnessReason(status: ArchmapStatusResponse | null): string | null {
  const freshness: ArchmapFreshness | undefined = status?.freshness;
  if (!freshness || freshness.status === 'fresh' || freshness.status === 'unknown') return null;
  return freshness.reason;
}

export function archmapFallbackNotice(status: ArchmapStatusResponse | null): string | null {
  if (!status || (!status.layersStale && !status.tourStale)) return null;
  const reason = status.fallback && status.fallback.length > 0 ? status.fallback.join('; ') : 'rodada interrompida';
  return `camadas e tour gerados sem LLM: ${reason}`;
}

export function archmapLastRunError(status: ArchmapStatusResponse | null): string | null {
  const run = status?.lastRun;
  if (!run || run.status !== 'error') return null;
  return `ultima rodada com erro: ${run.error ?? 'sem detalhe'}`;
}

export function archmapJevNotice(status: ArchmapStatusResponse | null): string | null {
  const run = status?.lastRun;
  if (!run) return null;
  if (run.jevFallbackReason) return `triagem Jev indisponivel: ${run.jevFallbackReason}`;
  const asked = run.jevAsked ?? 0;
  if (asked <= 0) return null;
  const cost = (run.jevCostUsd ?? 0).toFixed(run.jevCostUsd && run.jevCostUsd >= 0.01 ? 2 : 4);
  return `Jev dispensou ${run.jevDispensed ?? 0} de ${asked} arquivo(s) (US$ ${cost})`;
}

function emptyStatus(): ArchmapStatusResponse {
  return { status: 'absent', indexedCommit: null, lastIndexedAt: null };
}

export function selectArchmapSlot(state: Pick<ArchmapStoreState, 'repos'>, repositoryId: string): ArchmapRepoSlot {
  return state.repos[repositoryId] ?? EMPTY_ARCHMAP_SLOT;
}

export function archmapPhaseLabel(progress: ArchmapProgress | null): string | null {
  if (!progress) return null;
  const phase = ARCHMAP_PHASE_LABELS[progress.phase as keyof typeof ARCHMAP_PHASE_LABELS] ?? progress.phase;
  if (typeof progress.current === 'number' && typeof progress.total === 'number' && progress.total > 0) {
    return `${phase} ${progress.current}/${progress.total}`;
  }
  return phase;
}

export function archmapCountersLabel(progress: ArchmapProgress | null): string | null {
  if (!progress || progress.phase !== 'analysis') return null;
  const parts = [
    `${progress.succeeded ?? 0} concluido(s)`,
    `${progress.reused ?? 0} reaproveitado(s)`,
    `${progress.failed ?? 0} com erro`,
  ];
  return parts.join(', ');
}

function withAutomatic(slot: ArchmapRepoSlot, label: string): string {
  return slot.status?.layersStale || slot.status?.tourStale ? `${label} (automatico)` : label;
}

export function archmapStatusLabel(slot: ArchmapRepoSlot): string {
  const status = slot.status?.status;
  if (slot.estimating) return 'estimando';
  if (!status) return 'nao gerado';
  switch (status) {
    case 'absent':
      return 'nao gerado';
    case 'queued':
      return 'na fila';
    case 'building': {
      const phase = archmapPhaseLabel(slot.progress ?? slot.status?.run?.progress ?? null);
      return phase ? `gerando: ${phase}` : 'gerando';
    }
    case 'ready':
      return withAutomatic(slot, 'pronto');
    case 'stale':
      return withAutomatic(slot, 'desatualizado');
    case 'partial':
      return withAutomatic(slot, 'parcial');
    case 'error':
      return 'erro';
    default:
      return status;
  }
}

export function archmapReadLabelFor(
  capabilities: readonly ArchmapRuntimeCapability[],
  runtime: ArchmapRuntimeId | null,
): string {
  if (!runtime) return 'runtime fora do mapa';
  return capabilities.find((entry) => entry.runtime === runtime)?.readLabel ?? 'leitura confinada';
}

export function archmapGuaranteeFor(
  capabilities: readonly ArchmapRuntimeCapability[],
  runtime: ArchmapRuntimeId | null,
): { label: ArchmapGuaranteeLabel; reasons: string[] } | null {
  const capability = runtime ? capabilities.find((entry) => entry.runtime === runtime) : undefined;
  if (!capability) return null;
  const pending = ARCHMAP_GUARANTEE_NAMES.filter((name) => capability.guarantees[name].state !== 'provado');
  if (pending.length === 0) return { label: 'garantia provada', reasons: [] };
  const denied = pending.some((name) => capability.guarantees[name].state === 'negado');
  return {
    label: denied ? 'garantia negada' : 'garantia pendente',
    reasons: pending.map((name) => `${name}: ${capability.guarantees[name].reason}`),
  };
}

export const useArchmapStore = create<ArchmapStoreState>((set, get) => {
  const patch = (
    repositoryId: string,
    delta: Partial<ArchmapRepoSlot> | ((slot: ArchmapRepoSlot) => Partial<ArchmapRepoSlot>),
  ): void => {
    set((state) => {
      const current = state.repos[repositoryId] ?? createArchmapSlot();
      const next = typeof delta === 'function' ? delta(current) : delta;
      return { repos: { ...state.repos, [repositoryId]: { ...current, ...next } } };
    });
  };

  return {
    repos: {},
    capabilities: [],
    openRepositoryId: null,

    openMap: (repositoryId) => set({ openRepositoryId: repositoryId }),

    closeMap: () => set({ openRepositoryId: null }),

    loadStatus: async (repositoryId) => {
      try {
        const result = await window.lionclaw.archmap.status(repositoryId);
        if (!('status' in result)) {
          patch(repositoryId, { error: result.error });
          return;
        }
        patch(repositoryId, (slot) => ({
          status: result,
          progress: result.status === 'building' || result.status === 'queued' ? slot.progress : null,
        }));
      } catch (err) {
        patch(repositoryId, { error: err instanceof Error ? err.message : String(err) });
      }
    },

    loadCapabilities: async () => {
      try {
        const result = await window.lionclaw.archmap.runtimeCapabilities();
        if (Array.isArray(result)) {
          set({ capabilities: result });
          return result;
        }
        return get().capabilities;
      } catch {
        return get().capabilities;
      }
    },

    estimate: async (repositoryId, selection, mode) => {
      patch(repositoryId, { estimating: true, error: null, progress: null });
      try {
        const result = await window.lionclaw.archmap.estimate({
          repositoryId,
          selection,
          ...(mode ? { mode } : {}),
        });
        if ('error' in result) patch(repositoryId, { error: result.error });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch(repositoryId, { error: message });
        return { error: message };
      } finally {
        patch(repositoryId, { estimating: false, progress: null });
      }
    },

    cancel: async (repositoryId) => {
      try {
        const result = await window.lionclaw.archmap.cancel(repositoryId);
        if ('cancelled' in result && !result.cancelled) {
          patch(repositoryId, { error: archmapCancelRefusedMessage(result.reason) });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch(repositoryId, { error: message });
        return { error: message };
      }
    },

    build: async (repositoryId, selection) => {
      patch(repositoryId, { error: null, progress: { phase: 'scan' } });
      try {
        const result = await window.lionclaw.archmap.build({ repositoryId, selection });
        if (!('id' in result))
          patch(repositoryId, { error: result.code === 'cancelled' ? null : result.error, progress: null });
        else
          patch(repositoryId, (slot) => ({
            status: { ...(slot.status ?? emptyStatus()), status: 'building', run: result },
          }));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch(repositoryId, { error: message, progress: null });
        return { error: message };
      }
    },

    update: async (repositoryId, selection, confirmFull) => {
      patch(repositoryId, { error: null, progress: { phase: 'scan' } });
      try {
        const result = await window.lionclaw.archmap.update({
          repositoryId,
          selection,
          ...(confirmFull ? { confirmFull: true } : {}),
        });
        if (!('id' in result))
          patch(repositoryId, {
            error: result.code === 'cancelled' || result.code === 'confirm_full' ? null : result.error,
            progress: null,
          });
        else
          patch(repositoryId, (slot) => ({
            status: { ...(slot.status ?? emptyStatus()), status: 'building', run: result },
          }));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch(repositoryId, { error: message, progress: null });
        return { error: message };
      }
    },

    runs: async (repositoryId) => {
      try {
        return await window.lionclaw.archmap.runs(repositoryId);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    rememberChoice: (repositoryId, selection) => {
      const runtime = archmapRuntimeForSelection(selection.runtime, selection.provider);
      if (!runtime) return null;
      const choice: ArchmapGenerationChoice = { runtime, selection };
      patch(repositoryId, { choice });
      return choice;
    },

    clearError: (repositoryId) => patch(repositoryId, { error: null }),

    applyEvent: (event) => {
      const finished = event.run !== undefined && event.run.status !== 'running';
      patch(event.repositoryId, (slot) => {
        const next: Partial<ArchmapRepoSlot> = {};
        if (event.progress) next.progress = event.progress;
        if (finished) next.progress = null;
        if (event.status) next.status = { ...(slot.status ?? emptyStatus()), status: event.status };
        if (finished && event.run?.status === 'error') next.error = slot.error;
        return next;
      });
      if (!event.progress || finished) {
        void get().loadStatus(event.repositoryId);
      }
    },

    init: () => window.lionclaw.archmap.onStatus((event) => get().applyEvent(event)),
  };
});
