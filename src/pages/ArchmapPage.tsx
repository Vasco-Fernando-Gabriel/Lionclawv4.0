import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Hammer, Loader2, Map, RefreshCw, RotateCw, XCircle } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { useRepoGraphStore } from '@/stores/repo-graph-store';
import {
  archmapCancelRefusedMessage,
  archmapFallbackNotice,
  archmapJevNotice,
  archmapFreshnessReason,
  archmapHasMap,
  archmapLastRunError,
  archmapStatusLabel,
  selectArchmapSlot,
  useArchmapStore,
} from '@/stores/archmap-store';
import { ArchmapGenerateModal, type ArchmapGenerateMode } from '@/archmap/ArchmapGenerateModal';
import { ARCHMAP_BRIDGE_CONFIG, createLionClawArchmapBridge } from '@/archmap/bridge/lionclaw-bridge';
import { setBridge } from '@/archmap/dashboard/bridge';
import ArchmapDashboard from '@/archmap/dashboard/App';
import type { LocalRepositoryRecord } from '@/types/repo-graph';
import '@/archmap/dashboard/index.css';

const ARCHMAP_WARNINGS_SHOWN = 8;

function statusClass(label: string): string {
  if (label.startsWith('gerando') || label === 'na fila' || label === 'estimando')
    return 'bg-blue-500/15 text-blue-300';
  if (label.startsWith('pronto') && !label.includes('automatico')) return 'bg-emerald-500/15 text-emerald-300';
  if (label === 'erro') return 'bg-red-500/15 text-red-300';
  if (label === 'nao gerado') return 'bg-zinc-800 text-zinc-400';
  return 'bg-amber-500/15 text-amber-300';
}

function NoMapOpen({ onBack, missingRepositoryId }: { onBack: () => void; missingRepositoryId?: string }) {
  return (
    <div
      className="h-full flex items-center justify-center bg-zinc-950 text-zinc-100"
      data-testid={missingRepositoryId ? 'archmap-page-missing-repo' : 'archmap-page-empty'}
    >
      <div className="max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 text-center">
        <Map size={28} className="mx-auto text-amber-400" />
        <h1 className="mt-3 text-base font-semibold">
          {missingRepositoryId ? 'Repositorio nao encontrado' : 'Nenhum mapa aberto'}
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          {missingRepositoryId
            ? 'O repositorio deste mapa nao esta mais registrado em Repositorios. Volte e abra o mapa de outro repositorio.'
            : 'Abra o Mapa de arquitetura pelo botao "Abrir mapa" de um repositorio na tela Repositorios.'}
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-amber-600/20 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-600/30"
        >
          <ArrowLeft size={14} />
          Repositorios
        </button>
      </div>
    </div>
  );
}

function WarningsBanner({ warnings }: { warnings: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;
  const shown = expanded ? warnings : warnings.slice(0, ARCHMAP_WARNINGS_SHOWN);
  const hidden = warnings.length - shown.length;
  return (
    <div
      className="border-b border-amber-800/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200"
      data-testid="archmap-page-warnings"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{warnings.length} aviso(s) da ultima rodada</span>
        {warnings.length > ARCHMAP_WARNINGS_SHOWN && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-amber-300/80 hover:text-amber-200"
          >
            {expanded ? 'mostrar menos' : `mostrar todos (${warnings.length})`}
          </button>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-amber-100/80">
        {shown.map((warning, index) => (
          <li key={`${index}-${warning.slice(0, 24)}`} className="truncate" title={warning}>
            {warning}
          </li>
        ))}
        {hidden > 0 && <li className="text-amber-300/60">+{hidden} aviso(s)</li>}
      </ul>
    </div>
  );
}

export function ArchmapPage() {
  const setPage = useAppStore((s) => s.setPage);
  const repositoryId = useArchmapStore((s) => s.openRepositoryId);
  const slot = useArchmapStore((s) => selectArchmapSlot(s, repositoryId ?? ''));
  const loadStatus = useArchmapStore((s) => s.loadStatus);
  const initArchmap = useArchmapStore((s) => s.init);
  const cancelArchmap = useArchmapStore((s) => s.cancel);
  const repositories = useRepoGraphStore((s) => s.repositories);
  const loadRepositories = useRepoGraphStore((s) => s.loadRepositories);
  const repo: LocalRepositoryRecord | null = repositories.find((r) => r.id === repositoryId) ?? null;

  const [bridgeFor, setBridgeFor] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [reposChecked, setReposChecked] = useState(repositories.length > 0);
  const lastGeneration = useRef<string | null>(null);
  const [modalMode, setModalMode] = useState<ArchmapGenerateMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const goBack = useCallback(() => setPage('repositories'), [setPage]);

  useEffect(() => {
    if (repositories.length > 0) {
      setReposChecked(true);
      return;
    }
    void loadRepositories().finally(() => setReposChecked(true));
  }, [repositories.length, loadRepositories]);

  useEffect(() => initArchmap(), [initArchmap]);

  useEffect(() => {
    if (!repositoryId) return;
    void loadStatus(repositoryId);
  }, [repositoryId, loadStatus]);

  const projectName = repo?.name ?? repositoryId ?? '';

  useEffect(() => {
    if (!repositoryId) {
      setBridgeFor(null);
      return;
    }
    const bridge = createLionClawArchmapBridge({
      repositoryId,
      projectName,
      outputLanguage: ARCHMAP_BRIDGE_CONFIG.outputLanguage,
    });
    setBridge(bridge);
    setBridgeFor(repositoryId);
    return () => {
      bridge.dispose();
      setBridge(null);
      setBridgeFor((current) => (current === repositoryId ? null : current));
    };
  }, [repositoryId, projectName]);

  const generation = slot.status?.generation ?? null;
  useEffect(() => {
    if (generation && lastGeneration.current && lastGeneration.current !== generation) {
      setReloadTick((tick) => tick + 1);
    }
    if (generation) lastGeneration.current = generation;
  }, [generation]);

  useEffect(() => {
    lastGeneration.current = null;
  }, [repositoryId]);

  const handleCancel = useCallback(async () => {
    if (!repositoryId) return;
    setActionError(null);
    const result = await cancelArchmap(repositoryId);
    if ('error' in result) setActionError(result.error);
    else if (!result.cancelled) setActionError(archmapCancelRefusedMessage(result.reason));
    void loadStatus(repositoryId);
  }, [repositoryId, cancelArchmap, loadStatus]);

  if (!repositoryId) return <NoMapOpen onBack={goBack} />;
  if (!repo && reposChecked) return <NoMapOpen onBack={goBack} missingRepositoryId={repositoryId} />;

  const status = slot.status?.status;
  const label = archmapStatusLabel(slot);
  const busy = slot.estimating || status === 'building' || status === 'queued';
  const hasMap = archmapHasMap(slot.status);
  const statusLoaded = slot.status !== null;
  const freshnessReason = busy ? null : archmapFreshnessReason(slot.status);
  const fallbackNotice = busy ? null : archmapFallbackNotice(slot.status);
  const lastRunError = busy ? null : archmapLastRunError(slot.status);
  const jevNotice = busy ? null : archmapJevNotice(slot.status);
  const pendingFiles = slot.status?.pendingFiles ?? 0;
  const warnings = slot.status?.lastRun?.warnings ?? [];
  const statusTitle = [freshnessReason, pendingFiles > 0 ? `${pendingFiles} arquivo(s) pendente(s)` : null]
    .filter(Boolean)
    .join('\n');
  const buttonBase =
    'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-50';

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100" data-testid="archmap-page">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900/80 shrink-0 flex-wrap">
        <button
          type="button"
          onClick={goBack}
          className={`${buttonBase} border border-zinc-700 text-zinc-300 hover:bg-zinc-800`}
          title="Voltar para Repositorios"
          data-testid="archmap-page-back"
        >
          <ArrowLeft size={12} />
          Repositorios
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <Map size={16} className="text-amber-400 shrink-0" />
          <h1 className="text-sm font-semibold truncate">Mapa de arquitetura</h1>
          <span className="text-sm text-zinc-400 truncate" title={repo?.rootPath ?? ''} data-testid="archmap-page-repo">
            {projectName}
          </span>
        </div>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${statusClass(label)}`}
          title={statusTitle || undefined}
          data-testid="archmap-page-status"
        >
          {busy && <Loader2 size={11} className="animate-spin" />}
          {label}
        </span>
        {pendingFiles > 0 && (
          <span className="text-[10px] text-amber-300" data-testid="archmap-page-pending">
            {pendingFiles} arquivo(s) pendente(s)
          </span>
        )}
        {slot.status?.stats && (
          <span className="text-[10px] text-zinc-500">
            {slot.status.stats.fileCount} arquivos / {slot.status.stats.nodeCount} nos / {slot.status.stats.layerCount}{' '}
            camadas
          </span>
        )}
        <span className="flex-1" />
        {busy ? (
          <button
            type="button"
            onClick={() => void handleCancel()}
            className={`${buttonBase} border border-zinc-700 text-zinc-400 hover:bg-zinc-800`}
            title="Cancelar a operacao do mapa em andamento"
          >
            <XCircle size={12} />
            Cancelar
          </button>
        ) : hasMap ? (
          <>
            <button
              type="button"
              onClick={() => setModalMode('update')}
              className={`${buttonBase} bg-amber-600/20 text-amber-300 hover:bg-amber-600/30`}
              title="Atualizar o mapa a partir do que mudou no repositorio"
            >
              <RefreshCw size={12} />
              Atualizar mapa
            </button>
            <button
              type="button"
              onClick={() => setModalMode('rebuild')}
              className={`${buttonBase} border border-zinc-700 text-zinc-400 hover:bg-zinc-800`}
              title="Regerar o mapa do zero"
            >
              <Hammer size={12} />
              Regerar
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setModalMode('build')}
            className={`${buttonBase} bg-amber-600/20 text-amber-300 hover:bg-amber-600/30`}
            title="Gerar o Mapa de arquitetura deste repositorio"
          >
            <Map size={12} />
            Gerar mapa
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setActionError(null);
            void loadStatus(repositoryId);
            setReloadTick((tick) => tick + 1);
          }}
          className={`${buttonBase} border border-zinc-800 text-zinc-500 hover:bg-zinc-800`}
          title="Recarregar o mapa do disco"
          data-testid="archmap-page-reload"
        >
          <RotateCw size={12} />
          Recarregar
        </button>
      </header>

      {(freshnessReason ||
        fallbackNotice ||
        lastRunError ||
        jevNotice ||
        slot.status?.error ||
        slot.error ||
        actionError) && (
        <div
          className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-1.5 text-[11px] space-y-0.5"
          data-testid="archmap-page-notices"
        >
          {freshnessReason && <div className="text-amber-300">{freshnessReason}</div>}
          {fallbackNotice && <div className="text-amber-300">{fallbackNotice}</div>}
          {lastRunError && <div className="text-red-400">{lastRunError}</div>}
          {jevNotice && (
            <div className="text-zinc-400" data-testid="archmap-page-jev">
              {jevNotice}
            </div>
          )}
          {slot.status?.error && <div className="text-red-400">{slot.status.error}</div>}
          {slot.error && <div className="text-red-400">{slot.error}</div>}
          {actionError && <div className="text-red-400">{actionError}</div>}
        </div>
      )}

      <WarningsBanner warnings={warnings} />

      <div className="flex-1 min-h-0 relative" data-testid="archmap-page-body">
        {bridgeFor === repositoryId && statusLoaded && hasMap ? (
          <ArchmapDashboard key={`${repositoryId}:${reloadTick}`} />
        ) : !statusLoaded ? (
          <div
            className="h-full flex items-center justify-center text-sm text-zinc-500"
            data-testid="archmap-page-loading"
          >
            <Loader2 size={14} className="animate-spin mr-2" />
            Carregando o estado do mapa...
          </div>
        ) : (
          <div className="h-full flex items-center justify-center" data-testid="archmap-page-absent">
            <div className="max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 text-center">
              {busy ? (
                <>
                  <p className="text-sm text-zinc-300">O Mapa de arquitetura esta sendo gerado pela primeira vez.</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    A tela abre sozinha quando a rodada terminar; acompanhe a fase no cabecalho.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-zinc-300">Este repositorio ainda nao tem Mapa de arquitetura.</p>
                  <p className="mt-1 text-xs text-zinc-500">Gere o mapa para abrir a tela com camadas, busca e tour.</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <ArchmapGenerateModal
        open={modalMode !== null}
        repo={repo}
        mode={modalMode ?? 'build'}
        onClose={() => setModalMode(null)}
      />
    </div>
  );
}

export default ArchmapPage;
