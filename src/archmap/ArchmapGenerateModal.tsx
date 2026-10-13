import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Map, X } from 'lucide-react';
import type { SessionOrchestrator } from '@/types';
import type { ArchmapConfirmFullPayload, ArchmapEstimateResponse, ArchmapUpdatePreview } from '@/types/archmap';
import { archmapRuntimeForSelection } from '@/types/archmap';
import type { LocalRepositoryRecord } from '@/types/repo-graph';
import { useOrchestratorPickerStore } from '@/stores/orchestrator-picker-store';
import {
  useArchmapStore,
  ARCHMAP_ACTION_LABELS,
  archmapGuaranteeFor,
  archmapLastRunError,
  archmapReadLabelFor,
  archmapUpdatePreviewLines,
  selectArchmapSlot,
} from '@/stores/archmap-store';
import { ProviderModelPicker } from '@/components/chat/composer/ProviderModelPicker';
import { EffortPill } from '@/components/chat/composer/EffortPill';
import {
  buildRuntimePickerCatalog,
  defaultOrchestratorFromSettings,
  findPickerModel,
  selectionForEffort,
  selectionForModel,
  type PickerModel,
} from '@/components/chat/composer/model-picker.logic';

export type ArchmapGenerateMode = 'build' | 'update' | 'rebuild';

export interface ArchmapGenerateModalProps {
  open: boolean;
  repo: LocalRepositoryRecord | null;
  mode: ArchmapGenerateMode;
  onClose: () => void;
}

const MODE_TITLES: Record<ArchmapGenerateMode, string> = {
  build: 'Gerar mapa',
  update: 'Atualizar mapa',
  rebuild: 'Regerar mapa',
};

export const ARCHMAP_CONFIRM_FULL_NOTICE =
  'A atualizacao exige regeneracao completa do mapa. Confirme para regerar tudo.';

type EstimateState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ready'; data: ArchmapEstimateResponse }
  | { kind: 'error'; message: string };

function parseConfirmFull(details: unknown): ArchmapConfirmFullPayload | null {
  if (!details || typeof details !== 'object') return null;
  const value = details as Partial<ArchmapConfirmFullPayload>;
  if (value.action !== 'FULL_UPDATE' || !value.preview || typeof value.preview !== 'object') return null;
  return value as ArchmapConfirmFullPayload;
}

export function ArchmapGenerateModal({ open, repo, mode, onClose }: ArchmapGenerateModalProps) {
  const [selection, setSelection] = useState<SessionOrchestrator | null>(null);
  const [estimate, setEstimate] = useState<EstimateState>({ kind: 'idle' });
  const [preview, setPreview] = useState<ArchmapUpdatePreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pickerEntries = useOrchestratorPickerStore((s) => s.entries);
  const pickerPhase = useOrchestratorPickerStore((s) => s.phase);
  const pickerError = useOrchestratorPickerStore((s) => s.error);
  const loadPickerStatuses = useOrchestratorPickerStore((s) => s.load);
  const refreshPickerStatuses = useOrchestratorPickerStore((s) => s.refresh);
  const capabilities = useArchmapStore((s) => s.capabilities);
  const loadCapabilities = useArchmapStore((s) => s.loadCapabilities);
  const runEstimate = useArchmapStore((s) => s.estimate);
  const cancelEstimate = useArchmapStore((s) => s.cancel);
  const rememberChoice = useArchmapStore((s) => s.rememberChoice);
  const startBuild = useArchmapStore((s) => s.build);
  const startUpdate = useArchmapStore((s) => s.update);
  const [starting, setStarting] = useState(false);
  const slot = useArchmapStore((s) => (repo ? selectArchmapSlot(s, repo.id) : null));

  const repositoryId = repo?.id ?? null;
  const lastRunError = archmapLastRunError(slot?.status ?? null);
  const isUpdate = mode === 'update';

  useEffect(() => {
    if (!open || !repositoryId) return;
    setSelection(null);
    setEstimate({ kind: 'idle' });
    setPreview(null);
    setNotice(null);
    let cancelled = false;
    void loadPickerStatuses();
    void loadCapabilities();
    window.lionclaw.settings
      .get()
      .then((settings) => {
        if (cancelled) return;
        setSelection(defaultOrchestratorFromSettings(settings));
      })
      .catch(() => {});
    setEstimate({ kind: 'running' });
    let estimateDone = false;
    void runEstimate(repositoryId, null, isUpdate ? 'update' : undefined).then((result) => {
      estimateDone = true;
      if (cancelled) return;
      if ('error' in result) setEstimate({ kind: 'error', message: result.error });
      else {
        setEstimate({ kind: 'ready', data: result });
        setPreview(result.update ?? null);
      }
    });
    return () => {
      cancelled = true;
      if (!estimateDone) void cancelEstimate(repositoryId);
    };
  }, [open, repositoryId, isUpdate, loadPickerStatuses, loadCapabilities, runEstimate, cancelEstimate]);

  const selectedModel = useMemo(
    () => findPickerModel(buildRuntimePickerCatalog(pickerEntries).models, selection),
    [pickerEntries, selection],
  );
  const runtime = selection ? archmapRuntimeForSelection(selection.runtime, selection.provider) : null;
  const readLabel = archmapReadLabelFor(capabilities, runtime);
  const mechanism = capabilities.find((entry) => entry.runtime === runtime)?.mechanism ?? '';
  const guarantee = archmapGuaranteeFor(capabilities, runtime);
  const fullRequired = isUpdate && preview?.action === 'FULL_UPDATE';

  const handleModelSelect = useCallback((model: PickerModel) => {
    setSelection((current) => selectionForModel(current, model));
    setNotice(null);
  }, []);
  const handleEffortChange = useCallback((effort: string) => {
    setSelection((current) => (current ? selectionForEffort(current, effort) : current));
  }, []);

  const handleCancelEstimate = useCallback(async () => {
    if (!repositoryId) return;
    await cancelEstimate(repositoryId);
  }, [cancelEstimate, repositoryId]);

  const handleConfirm = useCallback(async () => {
    if (!repositoryId || !selection || !runtime || starting) return;
    const choice = rememberChoice(repositoryId, selection);
    if (!choice) return;
    setStarting(true);
    setNotice(null);
    try {
      const result = isUpdate
        ? await startUpdate(repositoryId, selection, fullRequired)
        : await startBuild(repositoryId, selection);
      if (!('id' in result)) {
        if (result.code === 'confirm_full') {
          const payload = parseConfirmFull(result.details);
          if (payload) setPreview(payload.preview);
          setNotice(ARCHMAP_CONFIRM_FULL_NOTICE);
          return;
        }
        setNotice(result.code === 'cancelled' ? 'Rodada cancelada antes de comecar.' : result.error);
        return;
      }
      onClose();
    } finally {
      setStarting(false);
    }
  }, [
    repositoryId,
    selection,
    runtime,
    starting,
    isUpdate,
    fullRequired,
    rememberChoice,
    startBuild,
    startUpdate,
    onClose,
  ]);

  if (!open || !repo) return null;

  const estimating = estimate.kind === 'running';
  const modelUnavailable = selectedModel ? !selectedModel.available : false;
  const canConfirm = Boolean(
    selection && runtime && !estimating && !starting && estimate.kind === 'ready' && !modelUnavailable,
  );
  const localRuntime = runtime === 'local';
  const confirmLabel = starting ? 'Iniciando...' : fullRequired ? 'Regerar tudo' : MODE_TITLES[mode];
  const previewLines = preview ? archmapUpdatePreviewLines(preview) : [];

  return (
    <div className="fixed inset-0 bg-zinc-950/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        className="w-full max-w-2xl mx-4 max-h-[90vh] rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col"
        data-testid="archmap-generate-modal"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Map size={18} className="text-amber-500" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-amber-500">{MODE_TITLES[mode]}</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Mapa de arquitetura de {repo.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4" data-testid="archmap-selection-panel">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Modelo do mapa</h3>
            <div className="flex flex-wrap items-center gap-2">
              <ProviderModelPicker
                selection={selection}
                entries={pickerEntries}
                phase={pickerPhase}
                error={pickerError}
                align="left"
                placement="bottom"
                onOpen={loadPickerStatuses}
                onRefresh={refreshPickerStatuses}
                onSelect={handleModelSelect}
              />
              <EffortPill
                effort={selection?.effort}
                options={selectedModel?.reasoningOptions ?? []}
                defaultReasoning={selectedModel?.defaultReasoning ?? null}
                contextWindow={selectedModel?.contextWindow}
                placement="bottom"
                onChange={handleEffortChange}
              />
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
                title={mechanism || 'Runtime fora do mapa'}
                data-testid="archmap-read-label"
              >
                {readLabel}
              </span>
              {guarantee && guarantee.label !== 'garantia provada' && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300"
                  title={guarantee.reasons.join('\n')}
                  data-testid="archmap-guarantee-label"
                >
                  {guarantee.label}
                </span>
              )}
            </div>
            <p className="text-[10px] text-zinc-600 mt-2">
              Todos os runtimes do composer podem gerar o mapa; os indisponiveis aparecem desabilitados com o motivo. O
              agente nunca escreve fora do rascunho nem usa rede.
            </p>
            {localRuntime && (
              <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
                <AlertTriangle size={11} />
                Modelos locais pequenos produzem resumos pobres.
              </p>
            )}
            {modelUnavailable && selectedModel?.unavailableReason && (
              <p className="text-[10px] text-red-400 mt-1" data-testid="archmap-unavailable-reason">
                {selectedModel.unavailableReason}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4" data-testid="archmap-estimate-panel">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Estimativa</h3>
            {estimate.kind === 'running' && (
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 size={12} className="animate-spin" />
                <span>
                  Lendo o repositorio
                  {slot?.progress?.current !== undefined && slot?.progress?.total
                    ? ` (${slot.progress.current}/${slot.progress.total})`
                    : ''}
                  ...
                </span>
                <button
                  onClick={handleCancelEstimate}
                  className="ml-auto px-2 py-0.5 rounded border border-zinc-700 text-[11px] text-zinc-400 hover:bg-zinc-800"
                >
                  Cancelar
                </button>
              </div>
            )}
            {estimate.kind === 'error' && (
              <p className="text-xs text-red-400" data-testid="archmap-estimate-error">
                {estimate.message}
              </p>
            )}
            {estimate.kind === 'ready' && (
              <div className="grid grid-cols-4 gap-3" data-testid="archmap-estimate-values">
                <div>
                  <p className="text-lg font-semibold text-zinc-200 tabular-nums">{estimate.data.fileCount}</p>
                  <p className="text-[10px] text-zinc-500">arquivos</p>
                </div>
                <div>
                  <p className="text-lg font-semibold text-zinc-200 tabular-nums">{estimate.data.batchCount}</p>
                  <p className="text-[10px] text-zinc-500">lotes</p>
                </div>
                <div>
                  <p className="text-lg font-semibold text-zinc-200 tabular-nums">~{estimate.data.estimatedMinutes}</p>
                  <p className="text-[10px] text-zinc-500">minutos</p>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-200 truncate" title={selection?.model ?? ''}>
                    {selection?.model ?? '-'}
                  </p>
                  <p className="text-[10px] text-zinc-500">modelo</p>
                </div>
              </div>
            )}
            {estimate.kind === 'ready' && estimate.data.warnings.length > 0 && (
              <p className="text-[10px] text-zinc-500 mt-2">
                {estimate.data.warnings.length} aviso(s) do scan; {estimate.data.filteredByIgnore} arquivo(s)
                ignorado(s) pelos filtros.
              </p>
            )}
          </div>

          {isUpdate && preview && (
            <div
              className={`rounded-lg border p-4 ${fullRequired ? 'border-amber-800/60 bg-amber-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}
              data-testid="archmap-update-preview"
            >
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Atualizacao</h3>
              <p
                className={`text-sm font-semibold ${fullRequired ? 'text-amber-300' : 'text-zinc-200'}`}
                data-testid="archmap-update-action"
              >
                {ARCHMAP_ACTION_LABELS[preview.action]}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-400" data-testid="archmap-update-lines">
                {previewLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {fullRequired && (
                <p className="text-[10px] text-amber-400 mt-2 flex items-center gap-1">
                  <AlertTriangle size={11} />
                  Regeneracao completa: todos os lotes voltam ao modelo.
                </p>
              )}
              {!fullRequired && estimate.kind === 'ready' && estimate.data.jevTriageEnabled && (
                <p className="text-[10px] text-zinc-500 mt-2" data-testid="archmap-update-jev">
                  triagem Jev ligada: o numero de arquivos dispensados aparece no fim da rodada, na linha do repositorio
                  e na tela do mapa.
                </p>
              )}
            </div>
          )}

          {lastRunError && !notice && (
            <div
              className="rounded-md border border-red-900/60 bg-red-500/10 px-3 py-2 text-xs text-red-300"
              data-testid="archmap-last-run-error"
            >
              {lastRunError}
            </div>
          )}
          {notice && (
            <div
              className="rounded-md border border-amber-900/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
              data-testid="archmap-notice"
            >
              {notice}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Fechar
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            data-testid="archmap-confirm"
            className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
