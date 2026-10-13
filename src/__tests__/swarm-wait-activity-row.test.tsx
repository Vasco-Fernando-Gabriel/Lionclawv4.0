// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActivityPanel } from '@/components/chat/ActivityPanel';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { createThreadState, upsertActivity, useChatStore } from '@/stores/chat-store';
import { useAppStore } from '@/stores/app-store';
import type { LiveActivity, LiveActivityEvent } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

function mount(): void {
  root = createRoot(container);
  act(() => {
    root?.render(<ActivityPanel />);
  });
}

function progressEvent(line: string): LiveActivityEvent {
  return {
    id: 'swarm-wait:swarm-20261011_100000-aaa',
    kind: 'tool',
    phase: 'update',
    label: 'Swarm',
    toolName: 'swarm_wait',
    description: line,
    summary: line,
    status: 'running',
    turnIndex: 1,
  };
}

function setActivities(activities: LiveActivity[]): void {
  useChatStore.setState({
    currentSessionId: 'sess-1',
    threads: { 'sess-1': createThreadState({ activities, messages: [], activitiesPanelOpen: true }) },
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = (() => {}) as Element['scrollTo'];
  }
  (window as unknown as Record<string, unknown>).lionclaw = {
    swarm: {
      listRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
      onStream: vi.fn().mockReturnValue(() => {}),
    },
    dynamicWorkflow: {
      listRuns: vi.fn().mockResolvedValue([]),
      getRun: vi.fn().mockResolvedValue(null),
      getNodes: vi.fn().mockResolvedValue([]),
      getEvents: vi.fn().mockResolvedValue([]),
      getArtifacts: vi.fn().mockResolvedValue([]),
      getSnapshot: vi.fn().mockResolvedValue(null),
      intervene: vi.fn().mockResolvedValue({ ok: true }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
  };
  useDynamicWorkflowStore.setState({ runs: [], selectedRun: null, selectedRunId: null });
  useAppStore.setState({ currentPage: 'chat' });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
});

describe('Progresso do swarm_wait no bloco de atividade do turno (SPEC 5.3.6, AC-29)', () => {
  it('a linha de progresso emitida por recordActivity (phase update, toolName swarm_wait) aparece no turno', () => {
    const first = upsertActivity(
      [],
      progressEvent('3 swarm agents rodando: auditor-ipc, explorador-db, validador-spec'),
    );
    setActivities(first);
    mount();
    const row = container.querySelector('[data-testid="swarm-wait-progress"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toBe('3 swarm agents rodando: auditor-ipc, explorador-db, validador-spec');
    expect(container.textContent).toContain('Swarm');
  });

  it('cada mudanca de estado substitui a linha (mesmo id), sem acumular entradas', () => {
    let activities = upsertActivity([], progressEvent('3 swarm agents rodando: a, b, c'));
    activities = upsertActivity(activities, progressEvent('2 swarm agents rodando: a, b; 1 concluido'));
    activities = upsertActivity(activities, progressEvent('0 swarm agents rodando; 3 concluidos'));
    setActivities(activities);
    mount();
    const rows = container.querySelectorAll('[data-testid="swarm-wait-progress"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('0 swarm agents rodando; 3 concluidos');
  });

  it('tools comuns continuam sem a linha de progresso', () => {
    setActivities(
      upsertActivity([], {
        id: 'tool-1',
        kind: 'tool',
        phase: 'start',
        label: 'Read',
        toolName: 'Read',
        description: 'descricao que nao deve virar linha de progresso',
        file: 'src/a.ts',
        turnIndex: 1,
      }),
    );
    mount();
    expect(container.querySelector('[data-testid="swarm-wait-progress"]')).toBeNull();
    expect(container.textContent).toContain('src/a.ts');
  });
});
