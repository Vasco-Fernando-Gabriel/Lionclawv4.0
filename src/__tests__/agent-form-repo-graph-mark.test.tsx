// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/types';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import {
  REPO_GRAPH_MARK,
  REPO_GRAPH_OFF_MARK,
  repoGraphMarkEnabled,
  repoGraphMarkOf,
  userMcpServersWithoutMarks,
  withRepoGraphMark,
} from '@/lib/swarm-repo-graph-mark';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installLionclaw(): void {
  Object.assign(window, {
    lionclaw: {
      codex: {
        status: async () => ({ installed: true, version: '0.156.0', authenticated: true }),
        listModelCapabilities: async () => ({ state: 'ready', capabilities: [] }),
        openLogin: async () => {},
        test: async () => ({ ok: true, message: 'ok' }),
      },
      kimi: {
        status: async () => ({
          installed: false,
          version: null,
          authenticated: false,
          authMode: 'none',
          managedProviderVerified: false,
          modelAvailable: false,
          availableModels: [],
          usable: false,
        }),
      },
      grok: { status: async () => ({ usable: false }) },
      provider: { check: async () => ({ error: 'nao configurado' }) },
      tools: { getEnabled: async () => ['Read', 'Grep', 'Glob', 'Write'] },
      mcp: {
        list: async () => [
          { id: 'repo-graph', name: 'Repo Graph', isActive: true },
          { id: 'knowledge-base', name: 'Knowledge Base', isActive: true },
        ],
      },
      skills: { list: async () => [] },
      vault: { check: async () => false },
      ollama: { listModels: async () => ({ models: [] }) },
    },
  });
}

function seed(runtime: AgentConfig['runtime'], mcpServers: string[]): AgentConfig {
  return {
    id: 'swarm-explorer',
    name: 'Swarm Explorer',
    description: 'Explorador de codigo generico do swarm',
    systemPrompt: '## Papel\nExplorador de codigo do swarm com briefing.',
    model: 'claude-opus-5-5',
    runtime,
    squad: 'swarm',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
    mcpServers,
    skills: [],
    isActive: true,
    sortOrder: 0,
    effort: 'high',
    thinking: 'adaptive',
    ...(runtime === 'local'
      ? { localConfig: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama4' } }
      : {}),
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
async function mount(agent: AgentConfig, onSave: (a: Omit<AgentConfig, 'sortOrder'>) => Promise<void>): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<AgentFormModal mode="edit" agent={agent} onSave={onSave} onClose={() => {}} />);
  });
  await flush();
}
function runtimeSelect(): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find((el) =>
    [...el.options].some((o) => o.value === 'codex'),
  );
  expect(select, 'select de runtime').toBeDefined();
  return select!;
}
async function setRuntime(value: string): Promise<void> {
  const select = runtimeSelect();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function save(): Promise<void> {
  const btn = button('Salvar');
  expect(btn.disabled, 'Salvar habilitado').toBe(false);
  await act(async () => {
    btn.click();
  });
  await flush();
}

beforeEach(() => {
  installLionclaw();
  container = document.createElement('div');
  document.body.append(container);
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

describe('PG-1: a tela de Agentes preserva a marca do repo-graph de um swarm agent em todo runtime', () => {
  it.each(['codex', 'local'] as const)(
    'trocar um swarm agent de cloud para %s e salvar mantem mcpServers = ["repo-graph"] e mostra a marca',
    async (runtime) => {
      const onSave = vi.fn<(a: Omit<AgentConfig, 'sortOrder'>) => Promise<void>>(async () => {});
      await mount(seed('cloud', [REPO_GRAPH_MARK]), onSave);
      await setRuntime(runtime);
      expect(container.querySelector('[data-testid="swarm-repo-graph-mark"]')?.textContent).toContain('marcado');
      await save();
      expect(onSave).toHaveBeenCalledTimes(1);
      const saved = onSave.mock.calls[0]![0] as unknown as Omit<AgentConfig, 'sortOrder'>;
      expect(saved.runtime).toBe(runtime);
      expect(saved.mcpServers).toEqual([REPO_GRAPH_MARK]);
      expect(saved.skills).toEqual([]);
    },
  );

  it('em codex o aviso de skills/KB ignorados nao dispara so pela marca do repo-graph', async () => {
    const onSave = vi.fn<(a: Omit<AgentConfig, 'sortOrder'>) => Promise<void>>(async () => {});
    await mount(seed('cloud', [REPO_GRAPH_MARK]), onSave);
    await setRuntime('codex');
    expect(container.textContent).not.toContain('Skills e Knowledge Base nao funcionam');
  });

  it('desmarcar o repo-graph num swarm agent grava a decisao explicita (repo-graph:off), que sobrevive a troca para codex', async () => {
    const onSave = vi.fn<(a: Omit<AgentConfig, 'sortOrder'>) => Promise<void>>(async () => {});
    await mount(seed('cloud', [REPO_GRAPH_MARK, 'knowledge-base']), onSave);
    await act(async () => {
      button('Repo Graph').click();
    });
    await flush();
    await setRuntime('codex');
    expect(container.querySelector('[data-testid="swarm-repo-graph-mark"]')?.textContent).toContain('desmarcado');
    await save();
    const saved = onSave.mock.calls[0]![0] as unknown as Omit<AgentConfig, 'sortOrder'>;
    expect(saved.mcpServers).toEqual([REPO_GRAPH_OFF_MARK]);
  });

  it('marcar de volta remove o repo-graph:off; outros MCPs seguem a regra antiga nos runtimes que os aceitam', async () => {
    const onSave = vi.fn<(a: Omit<AgentConfig, 'sortOrder'>) => Promise<void>>(async () => {});
    await mount(seed('cloud', [REPO_GRAPH_OFF_MARK, 'knowledge-base']), onSave);
    await act(async () => {
      button('Repo Graph').click();
    });
    await flush();
    await save();
    const saved = onSave.mock.calls[0]![0] as unknown as Omit<AgentConfig, 'sortOrder'>;
    expect(saved.mcpServers.sort()).toEqual(['knowledge-base', REPO_GRAPH_MARK].sort());
  });

  it('helpers da marca: ligado/desligado/sem marca, default do seed e MCPs do usuario sem as marcas', () => {
    expect(repoGraphMarkOf([REPO_GRAPH_MARK])).toBe('on');
    expect(repoGraphMarkOf([REPO_GRAPH_OFF_MARK])).toBe('off');
    expect(repoGraphMarkOf(['knowledge-base'])).toBe('unset');
    expect(repoGraphMarkEnabled([], true)).toBe(true);
    expect(repoGraphMarkEnabled([], false)).toBe(false);
    expect(repoGraphMarkEnabled([REPO_GRAPH_OFF_MARK], true)).toBe(false);
    expect(repoGraphMarkEnabled([REPO_GRAPH_MARK], false)).toBe(true);
    expect(withRepoGraphMark(['skills', REPO_GRAPH_MARK], false)).toEqual(['skills', REPO_GRAPH_OFF_MARK]);
    expect(withRepoGraphMark([REPO_GRAPH_OFF_MARK], true)).toEqual([REPO_GRAPH_MARK]);
    expect(userMcpServersWithoutMarks([REPO_GRAPH_MARK, 'skills', REPO_GRAPH_OFF_MARK])).toEqual(['skills']);
  });
});
