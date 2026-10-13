// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ArchmapJevTriageSettings,
  normalizeArchmapJevKeepThreshold,
  resetArchmapJevCheckCache,
  type ArchmapJevTriageCheck,
} from '@/components/settings/ArchmapJevTriageSettings';
import { JEV_KEY_CHANGED_EVENT } from '@/constants/jev';
import type { AppSettings } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSettings(patch?: Partial<AppSettings>): AppSettings {
  return { archmapJevTriageEnabled: false, archmapJevKeepThreshold: 0.8, ...patch } as AppSettings;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetArchmapJevCheckCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  settings: AppSettings,
  check: () => Promise<ArchmapJevTriageCheck>,
  onUpdate: (patch: Partial<AppSettings>) => void = () => {},
): Promise<void> {
  await act(async () => {
    root.render(<ArchmapJevTriageSettings settings={settings} onUpdate={onUpdate} check={check} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function section(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="archmap-jev-triage-settings"]');
}

describe('ArchmapJevTriageSettings (aba Orquestrador, abaixo da secao do Jev)', () => {
  it('so aparece quando checkJev responde ok', async () => {
    const check = vi.fn(async () => ({ ok: true, model: 'jev-1.13.0' }));
    await render(makeSettings(), check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(section()).not.toBeNull();
    expect(section()!.textContent).toContain('triagem do Mapa de arquitetura');
    expect(section()!.textContent).toContain('dispensa a releitura por LLM de arquivos cujo resumo ainda vale');
    expect(section()!.textContent).toContain('modelo jev-1.13.0');
    expect(container.querySelector('[data-testid="archmap-jev-triage-state"]')!.textContent).toContain(
      'inativo: desligado',
    );
  });

  it('fica oculta quando o Jev nao responde ou a chamada falha', async () => {
    await render(makeSettings(), async () => ({ ok: false, error: 'Chave do Jev nao configurada no Vault.' }));
    expect(section()).toBeNull();
    await render(makeSettings(), async () => {
      throw new Error('rede');
    });
    expect(section()).toBeNull();
  });

  it('o interruptor grava archmapJevTriageEnabled e o estado muda para ativo', async () => {
    const onUpdate = vi.fn();
    await render(makeSettings(), async () => ({ ok: true }), onUpdate);
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => toggle.click());
    expect(onUpdate).toHaveBeenCalledWith({ archmapJevTriageEnabled: true });
    await render(makeSettings({ archmapJevTriageEnabled: true }), async () => ({ ok: true }), onUpdate);
    expect(container.querySelector('[data-testid="archmap-jev-triage-state"]')!.textContent).toContain('ativo');
  });

  it('o limiar aceita 0.5..1, grava ao sair do campo e recusa valor fora da faixa', async () => {
    const onUpdate = vi.fn();
    await render(makeSettings(), async () => ({ ok: true }), onUpdate);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Confianca minima da triagem Jev"]')!;
    expect(input.value).toBe('0.8');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, '0,9');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onUpdate).toHaveBeenCalledWith({ archmapJevKeepThreshold: 0.9 });
    act(() => {
      setter.call(input, '1.5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(section()!.textContent).toContain('Informe um numero entre 0.5 e 1');
  });

  it('S5-V9: o resultado do check fica em cache por 60 s entre montagens da aba', async () => {
    const check = vi.fn(async () => ({ ok: true, model: 'jev-1.13.0' }));
    await render(makeSettings(), check);
    expect(section()).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await render(makeSettings(), check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(section()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(JEV_KEY_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('reconsulta o Jev quando a chave muda', async () => {
    const answers: ArchmapJevTriageCheck[] = [{ ok: false, error: 'sem chave' }, { ok: true }];
    const check = vi.fn(async () => answers.shift() ?? { ok: true });
    await render(makeSettings(), check);
    expect(section()).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(JEV_KEY_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(section()).not.toBeNull();
  });
});

describe('normalizeArchmapJevKeepThreshold', () => {
  it('aceita ponto ou virgula, arredonda a duas casas e recusa fora de 0.5..1', () => {
    expect(normalizeArchmapJevKeepThreshold('0,85')).toBe(0.85);
    expect(normalizeArchmapJevKeepThreshold(0.8)).toBe(0.8);
    expect(normalizeArchmapJevKeepThreshold('0.999')).toBe(1);
    expect(normalizeArchmapJevKeepThreshold('0.4')).toBeNull();
    expect(normalizeArchmapJevKeepThreshold('1.01')).toBeNull();
    expect(normalizeArchmapJevKeepThreshold('abc')).toBeNull();
    expect(normalizeArchmapJevKeepThreshold(undefined)).toBeNull();
  });
});
