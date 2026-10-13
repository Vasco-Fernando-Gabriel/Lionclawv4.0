import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import type { AppSettings } from '@/types';
import {
  JEV_API_KEY_VAULT_KEY,
  JEV_DEFAULT_MODEL,
  JEV_KEY_CHANGED_EVENT,
  JEV_MODEL_MAX_LENGTH,
  describeJevShadowState,
  normalizeJevModel,
} from '@/constants/jev';

function announceKeyChange(): void {
  window.dispatchEvent(new CustomEvent(JEV_KEY_CHANGED_EVENT));
}

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

interface KeyStatus {
  configured: boolean;
  error: string | null;
}

export function JevShadowSettings({ settings, onUpdate }: Props) {
  const enabled = settings.jevShadowEnabled === true;
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [model, setModel] = useState(settings.jevModel ?? JEV_DEFAULT_MODEL);
  const [modelError, setModelError] = useState<string | null>(null);
  const testSeq = useRef(0);

  const loadKeyStatus = useCallback(async () => {
    try {
      const entries = await window.lionclaw.vault.list();
      const entry = entries.find((e) => e.key === JEV_API_KEY_VAULT_KEY);
      setKeyStatus({ configured: entry?.configured === true, error: entry?.error ?? null });
    } catch (err) {
      setKeyStatus({ configured: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void loadKeyStatus();
  }, [loadKeyStatus]);

  useEffect(() => {
    setModel(settings.jevModel ?? JEV_DEFAULT_MODEL);
  }, [settings.jevModel]);

  const save = async () => {
    const value = apiKey.trim();
    if (!value) return;
    setBusy('save');
    try {
      await window.lionclaw.vault.set(JEV_API_KEY_VAULT_KEY, value);
      setApiKey('');
      setTestMsg(null);
      await loadKeyStatus();
      announceKeyChange();
    } catch (err) {
      setTestMsg({
        ok: false,
        text: `Nao foi possivel salvar a chave: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const seq = ++testSeq.current;
    setBusy('test');
    setTestMsg(null);
    try {
      const result = await window.lionclaw.jev.check();
      if (seq !== testSeq.current) return;
      setTestMsg(
        result.ok
          ? { ok: true, text: `Jev respondeu: modelo ${result.model ?? '?'} em ${result.latencyMs ?? '?'} ms.` }
          : { ok: false, text: result.error ?? 'Falha ao testar o Jev.' },
      );
    } catch (err) {
      if (seq !== testSeq.current) return;
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      if (seq === testSeq.current) setBusy(null);
    }
  };

  const disconnect = async () => {
    testSeq.current++;
    setBusy('delete');
    setTestMsg(null);
    try {
      await window.lionclaw.vault.delete(JEV_API_KEY_VAULT_KEY);
      await loadKeyStatus();
      announceKeyChange();
    } catch (err) {
      setTestMsg({
        ok: false,
        text: `Nao foi possivel remover a chave: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const commitModel = () => {
    const normalized = normalizeJevModel(model);
    if (normalized === null) {
      setModelError(`Informe um nome nao vazio com ate ${JEV_MODEL_MAX_LENGTH} caracteres.`);
      return;
    }
    setModelError(null);
    setModel(normalized);
    if (normalized !== (settings.jevModel ?? JEV_DEFAULT_MODEL)) onUpdate({ jevModel: normalized });
  };

  const configured = keyStatus?.configured === true;
  const state = describeJevShadowState({ enabled, keyConfigured: configured, keyError: keyStatus?.error ?? null });

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Eye size={16} className="text-amber-500" />
        Jev (TypeSafe): modo sombra
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-zinc-400">Observar a revisao de memoria com o Jev (nao altera nada)</label>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => onUpdate({ jevShadowEnabled: !enabled })}
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
            Com isto ligado, a cada Clear o conteudo da memoria, do perfil e um trecho da conversa sao enviados a API da
            TypeSafe. O resultado fica so nos relatorios de dreaming; a memoria nao e alterada.
          </p>
          <p className="text-xs text-zinc-300" data-testid="jev-shadow-state">
            Estado: <span className={state === 'ativo' ? 'text-green-400' : 'text-zinc-400'}>{state}</span>
          </p>
          {keyStatus?.error && <p className="text-[10px] text-red-400">{keyStatus.error}</p>}
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={configured ? '*** chave armazenada no Vault ***' : 'chave do console TypeSafe'}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50"
          />
          {apiKey.trim().length > 0 && configured && (
            <p className="text-[10px] text-zinc-500">O teste usa a chave ja salva; salve a nova antes de testar.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={busy !== null || !apiKey.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
          >
            {busy === 'save' ? 'Salvando...' : 'Salvar'}
          </button>
          <button
            onClick={() => void test()}
            disabled={busy !== null || !configured}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
          >
            {busy === 'test' ? 'Testando...' : 'Testar'}
          </button>
          {(configured || keyStatus?.error) && (
            <button
              onClick={() => void disconnect()}
              disabled={busy !== null}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
            >
              Desconectar
            </button>
          )}
        </div>

        {(configured || keyStatus?.error) && (
          <p className="text-[10px] text-zinc-600">
            Ao salvar ou desconectar a chave, processos de runtimes ja abertos so recebem a chave nova quando
            reiniciarem; ate la respondem que a chave mudou.
          </p>
        )}

        {testMsg && <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>{testMsg.text}</p>}

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">Modelo</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={commitModel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitModel();
            }}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          />
          {modelError ? (
            <p className="text-[10px] text-red-400">{modelError}</p>
          ) : (
            <p className="text-[10px] text-zinc-600">Versao explicita do Jev; nao use jev-latest.</p>
          )}
        </div>
      </div>
    </section>
  );
}
