import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { AppSettings, JevFileToolsRoots, JevFileToolsStats } from '@/types';
import {
  JEV_API_KEY_VAULT_KEY,
  JEV_KEY_CHANGED_EVENT,
  describeJevFileToolsState,
  type JevFileToolsServerStatus,
} from '@/constants/jev';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  onPersisted: (patch: Partial<AppSettings>) => void;
}

interface KeyStatus {
  configured: boolean;
  error: string | null;
}

interface ServerState {
  status: JevFileToolsServerStatus;
  error: string | null;
}

const JEV_FILES_SERVER_ID = 'jev-files';
const STATS_REFRESH_MS = 30_000;
const ABSOLUTE_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~(?:[\\/]|$))/;

function splitRoots(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function JevFileToolsSettings({ settings, onUpdate, onPersisted }: Props) {
  const enabled = settings.jevFileToolsEnabled === true;
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [server, setServer] = useState<ServerState>({ status: 'missing', error: null });
  const [savedRoots, setSavedRoots] = useState<string[]>(settings.jevFileToolsRoots ?? []);
  const [rootsText, setRootsText] = useState((settings.jevFileToolsRoots ?? []).join('\n'));
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [stats, setStats] = useState<JevFileToolsStats | null>(null);
  const [projectRoots, setProjectRoots] = useState<string[] | null>(null);

  const loadProjectRoots = useCallback(async () => {
    try {
      const roots: JevFileToolsRoots = await window.lionclaw.jev.fileToolsRoots();
      setProjectRoots(roots.projects);
    } catch {
      setProjectRoots(null);
    }
  }, []);

  const loadKeyStatus = useCallback(async () => {
    try {
      const entries = await window.lionclaw.vault.list();
      const entry = entries.find((e) => e.key === JEV_API_KEY_VAULT_KEY);
      setKeyStatus({ configured: entry?.configured === true, error: entry?.error ?? null });
    } catch (err) {
      setKeyStatus({ configured: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const loadServerStatus = useCallback(async () => {
    try {
      const servers = await window.lionclaw.mcp.list();
      const row = servers.find((s) => s.id === JEV_FILES_SERVER_ID);
      if (!row) {
        setServer({ status: 'missing', error: null });
        return;
      }
      setServer({ status: row.status ?? 'stopped', error: row.error ?? null });
    } catch {
      setServer({ status: 'missing', error: null });
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      setStats(await window.lionclaw.jev.fileToolsStats());
    } catch {
      setStats(null);
    }
  }, []);

  const refreshAll = useCallback(() => {
    void loadKeyStatus();
    void loadServerStatus();
    void loadStats();
    void loadProjectRoots();
  }, [loadKeyStatus, loadServerStatus, loadStats, loadProjectRoots]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void loadStats(), STATS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, loadStats]);

  useEffect(() => {
    const unsubscribe = window.lionclaw.mcp.onStatusChanged((payload) => {
      if (payload.id !== JEV_FILES_SERVER_ID) return;
      setServer({ status: payload.status, error: payload.error ?? null });
      void loadKeyStatus();
      void loadStats();
    });
    return unsubscribe;
  }, [loadKeyStatus, loadStats]);

  useEffect(() => {
    const handler = () => refreshAll();
    window.addEventListener(JEV_KEY_CHANGED_EVENT, handler);
    return () => window.removeEventListener(JEV_KEY_CHANGED_EVENT, handler);
  }, [refreshAll]);

  useEffect(() => {
    const roots = settings.jevFileToolsRoots ?? [];
    setSavedRoots(roots);
    setRootsText(roots.join('\n'));
  }, [settings.jevFileToolsRoots]);

  const commitRoots = async () => {
    if (savingRef.current) return;
    const lines = splitRoots(rootsText);
    if (lines.length === 0) {
      setRootsError('Informe ao menos uma pasta.');
      return;
    }
    const invalid = lines.find((line) => !ABSOLUTE_RE.test(line));
    if (invalid !== undefined) {
      setRootsError(`"${invalid}" nao e um caminho absoluto.`);
      return;
    }
    if (sameRoots(lines, savedRoots)) {
      setRootsError(null);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await window.lionclaw.settings.update({ jevFileToolsRoots: lines });
      if (result.error) {
        setRootsError(result.error);
        return;
      }
      setRootsError(null);
      const refreshed = await window.lionclaw.settings.get();
      const persisted = refreshed.jevFileToolsRoots ?? lines;
      setSavedRoots(persisted);
      setRootsText(persisted.join('\n'));
      onPersisted({ jevFileToolsRoots: persisted });
      void loadServerStatus();
      void loadProjectRoots();
    } catch (err) {
      setRootsError(err instanceof Error ? err.message : String(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const configured = keyStatus?.configured === true;
  const state = describeJevFileToolsState({
    enabled,
    keyConfigured: configured,
    keyError: keyStatus?.error ?? null,
    serverStatus: server.status,
    serverError: server.error,
  });

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <FileSearch size={16} className="text-amber-500" />
        Jev (TypeSafe): perguntas sobre arquivos
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">
              Deixar o orquestrador perguntar ao Jev sobre arquivos sem ler
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => onUpdate({ jevFileToolsEnabled: !enabled })}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                enabled ? 'bg-amber-500' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-zinc-100 transition-transform ${
                  enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">
            Com isto ligado, o conteudo dos arquivos que o agente consultar por esta ferramenta e enviado a API da
            TypeSafe. O agente recebe so a resposta; o arquivo nao entra no contexto. Sessoes ja abertas em outros
            runtimes obedecem a mudanca na proxima chamada.
          </p>
          <p className="text-xs text-zinc-300" data-testid="jev-file-tools-state">
            Estado:{' '}
            <span
              className={
                state === 'ativo' ? 'text-green-400' : state.startsWith('erro') ? 'text-red-400' : 'text-zinc-400'
              }
            >
              {state}
            </span>
          </p>
          {keyStatus?.error && <p className="text-[10px] text-red-400">{keyStatus.error}</p>}
          <p className="text-[10px] text-zinc-600">A chave e a mesma do modo sombra, salva acima.</p>
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">Pastas permitidas (uma por linha)</label>
          <textarea
            value={rootsText}
            onChange={(e) => setRootsText(e.target.value)}
            onBlur={() => void commitRoots()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void commitRoots();
              }
            }}
            rows={Math.min(6, Math.max(2, splitRoots(rootsText).length + 1))}
            spellCheck={false}
            readOnly={saving}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 font-mono outline-none focus:border-amber-500/50 read-only:opacity-60"
          />
          {rootsError ? (
            <p className="text-[10px] text-red-400">{rootsError}</p>
          ) : (
            <p className="text-[10px] text-zinc-600">
              Caminhos absolutos de pastas existentes (ate 20). Salva ao sair do campo ou com Ctrl+Enter.
            </p>
          )}
        </div>

        <div className="space-y-1" data-testid="jev-file-tools-project-roots">
          <p className="text-xs text-zinc-400">Pastas dos projetos cadastrados (entram sozinhas)</p>
          {projectRoots === null ? (
            <p className="text-[10px] text-zinc-600">Lista indisponivel.</p>
          ) : projectRoots.length === 0 ? (
            <p className="text-[10px] text-zinc-600">
              Nenhum projeto cadastrado em pipelines ou workflows fora das pastas acima.
            </p>
          ) : (
            <ul className="text-[11px] text-zinc-300 font-mono space-y-0.5">
              {projectRoots.map((root) => (
                <li key={root} className="truncate" title={root}>
                  {root}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-zinc-600">
            Toda pasta de projeto usada em um pipeline ou workflow dinamico e liberada automaticamente, inclusive os
            criados depois. Pastas sensiveis, inexistentes ou ja listadas acima nao aparecem.
          </p>
        </div>

        <div className="text-[10px] text-zinc-500 space-y-0.5" data-testid="jev-file-tools-stats">
          {stats === null ? (
            <p>Contador indisponivel.</p>
          ) : (
            <>
              <p>
                {stats.calls} chamadas, {stats.files} arquivos enviados ao Jev, custo Jev estimado US${' '}
                {stats.costUsd.toFixed(4)}, desde o inicio do registro (ultimos 2 MB).
              </p>
              <p>
                Tokens evitados (estimativa): {stats.estimatedTokensAvoided.toLocaleString('pt-BR')}
                {stats.lastAt ? ` (ultima chamada em ${new Date(stats.lastAt).toLocaleString('pt-BR')})` : ''}.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
