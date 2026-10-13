// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SwarmSettings } from '@/components/swarm/SwarmSettings';
import { DEFAULT_SWARM_SETTINGS } from '@/types/swarm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function field(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
  expect(found, label).toBeDefined();
  return found!.querySelector('input')!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
});

describe('SwarmSettings (SPEC 5.6)', () => {
  it('mostra a janela de conducao em minutos, valida no main e grava em milissegundos', async () => {
    const setSettings = vi.fn(async (value: typeof DEFAULT_SWARM_SETTINGS) =>
      value.openWindowMs < 60_000 ? { error: 'Settings Swarm inválidos', code: 'invalid-settings' } : value,
    );
    Object.assign(window, {
      lionclaw: { swarm: { getSettings: vi.fn(async () => ({ ...DEFAULT_SWARM_SETTINGS })), setSettings } },
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(<SwarmSettings />);
    });
    await flush();
    const input = field('Janela de conducao apos o fim (minutos)');
    expect(input.value).toBe('30');
    expect(input.min).toBe('1');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '45');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Salvar Swarm'))!;
    await act(async () => {
      save.click();
    });
    await flush();
    expect(setSettings).toHaveBeenCalledWith({ ...DEFAULT_SWARM_SETTINGS, openWindowMs: 45 * 60_000 });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      setter.call(input, '0');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      save.click();
    });
    await flush();
    expect(setSettings).toHaveBeenLastCalledWith({ ...DEFAULT_SWARM_SETTINGS, openWindowMs: 0 });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Settings Swarm inválidos');
  });
});
