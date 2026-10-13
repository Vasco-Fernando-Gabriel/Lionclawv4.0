import { useCallback, useEffect, useRef, useState } from 'react';
import { Map } from 'lucide-react';
import type { AppSettings } from '@/types';
import { JEV_KEY_CHANGED_EVENT } from '@/constants/jev';

export const ARCHMAP_JEV_KEEP_THRESHOLD_DEFAULT = 0.8;
export const ARCHMAP_JEV_KEEP_THRESHOLD_MIN = 0.5;
export const ARCHMAP_JEV_KEEP_THRESHOLD_MAX = 1;

export function normalizeArchmapJevKeepThreshold(raw: string | number | undefined | null): number | null {
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < ARCHMAP_JEV_KEEP_THRESHOLD_MIN || parsed > ARCHMAP_JEV_KEEP_THRESHOLD_MAX) return null;
  return Math.round(parsed * 100) / 100;
}

export type ArchmapJevTriageAvailability = 'checking' | 'available' | 'unavailable';

export interface ArchmapJevTriageCheck {
  ok: boolean;
  model?: string;
  error?: string;
}

export const ARCHMAP_JEV_CHECK_CACHE_MS = 60_000;

let checkCache: { at: number; result: ArchmapJevTriageCheck } | null = null;

export function resetArchmapJevCheckCache(): void {
  checkCache = null;
}

async function cachedCheck(
  run: () => Promise<ArchmapJevTriageCheck>,
  force: boolean,
  now: number,
): Promise<ArchmapJevTriageCheck> {
  if (!force && checkCache && now - checkCache.at < ARCHMAP_JEV_CHECK_CACHE_MS) return checkCache.result;
  const result = await run();
  checkCache = { at: now, result };
  return result;
}

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  check?: () => Promise<ArchmapJevTriageCheck>;
}

function defaultCheck(): Promise<ArchmapJevTriageCheck> {
  return window.lionclaw.jev.check();
}

export function ArchmapJevTriageSettings({ settings, onUpdate, check }: Props) {
  const enabled = settings.archmapJevTriageEnabled === true;
  const threshold = settings.archmapJevKeepThreshold ?? ARCHMAP_JEV_KEEP_THRESHOLD_DEFAULT;
  const [availability, setAvailability] = useState<ArchmapJevTriageAvailability>('checking');
  const [model, setModel] = useState<string | null>(null);
  const [draft, setDraft] = useState(String(threshold));
  const [draftError, setDraftError] = useState<string | null>(null);
  const seq = useRef(0);
  const runCheck = check ?? defaultCheck;

  const probe = useCallback(
    async (force = false) => {
      const current = ++seq.current;
      setAvailability('checking');
      try {
        const result = await cachedCheck(runCheck, force, Date.now());
        if (current !== seq.current) return;
        setModel(result.ok ? (result.model ?? null) : null);
        setAvailability(result.ok ? 'available' : 'unavailable');
      } catch {
        if (current !== seq.current) return;
        setAvailability('unavailable');
      }
    },
    [runCheck],
  );

  useEffect(() => {
    void probe();
    const onKeyChange = () => void probe(true);
    window.addEventListener(JEV_KEY_CHANGED_EVENT, onKeyChange);
    return () => window.removeEventListener(JEV_KEY_CHANGED_EVENT, onKeyChange);
  }, [probe]);

  useEffect(() => {
    setDraft(String(threshold));
  }, [threshold]);

  const commitThreshold = () => {
    const normalized = normalizeArchmapJevKeepThreshold(draft);
    if (normalized === null) {
      setDraftError(
        `Informe um numero entre ${ARCHMAP_JEV_KEEP_THRESHOLD_MIN} e ${ARCHMAP_JEV_KEEP_THRESHOLD_MAX} (ex.: 0.8).`,
      );
      return;
    }
    setDraftError(null);
    setDraft(String(normalized));
    if (normalized !== threshold) onUpdate({ archmapJevKeepThreshold: normalized });
  };

  if (availability !== 'available') return null;

  return (
    <section className="space-y-2" data-testid="archmap-jev-triage-settings">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Map size={16} className="text-amber-500" />
        Jev (TypeSafe): triagem do Mapa de arquitetura
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">
              Perguntar ao Jev se o resumo antigo ainda vale antes de reler um arquivo alterado
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Alternar triagem Jev do mapa"
              onClick={() => onUpdate({ archmapJevTriageEnabled: !enabled })}
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
            Ao atualizar o mapa, dispensa a releitura por LLM de arquivos cujo resumo ainda vale: o Jev recebe o resumo
            antigo e a diferenca do arquivo e responde se o resumo continua certo. Arquivos novos, com simbolo, import
            ou assinatura alterados, hubs e manifests vao sempre ao LLM. O Jev nunca escreve resumo. Se o Jev nao
            responder, a atualizacao segue sem a triagem.
          </p>
          <p className="text-xs text-zinc-300" data-testid="archmap-jev-triage-state">
            Estado:{' '}
            <span className={enabled ? 'text-green-400' : 'text-zinc-400'}>
              {enabled ? 'ativo' : 'inativo: desligado'}
            </span>
            {model ? <span className="text-zinc-500"> (modelo {model})</span> : null}
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">Confianca minima para dispensar a releitura</label>
          <input
            type="text"
            inputMode="decimal"
            value={draft}
            aria-label="Confianca minima da triagem Jev"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitThreshold}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitThreshold();
            }}
            className="w-32 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          />
          {draftError ? (
            <p className="text-[10px] text-red-400">{draftError}</p>
          ) : (
            <p className="text-[10px] text-zinc-600">
              Entre 0.5 e 1. Com 0.8, so arquivos em que o Jev tem 80% ou mais de certeza ficam sem releitura; abaixo
              disso o arquivo vai ao LLM. Um arquivo nao fica mais de 3 atualizacoes seguidas sem releitura.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
