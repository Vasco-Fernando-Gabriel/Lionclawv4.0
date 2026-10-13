import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `dreaming-gate-accounting-cb-${process.pid}`);

vi.mock('../paths', () => ({
  getLionClawHome: () => TEST_TMP_DIR,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../memory-pipeline', () => ({
  runStructuredMemoryLlm: vi.fn().mockRejectedValue(new Error('nao deve ser chamado')),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(() => undefined),
  setSetting: vi.fn(),
}));

import { runDreamingGate, type DreamingGateInput, type UserAccountingTraceEntry } from '../dreaming-gate';

const skillDir = path.join(TEST_TMP_DIR, 'skills', 'dreaming');

const INPUT: DreamingGateInput = {
  candidates: [{ kind: 'add', text: '[2026-07-01] Decisao de usar Vitest' }],
  userCandidates: [
    { action: 'add', section: 'Stack tecnologico', fact: 'Usa TypeScript strict mode' },
    { action: 'add', section: 'Perfil', fact: 'Trabalha com Electron' },
  ],
  currentMemoryMd: '## Decisoes ativas\n',
  currentUserMd: '# Sobre o Usuario\n\n## Stack e ferramentas\n- Usa JavaScript [2026-01-01]\n',
  conversationExcerpt: 'conversa de exemplo',
};

const LLM_OUTPUT = {
  apply: {
    add: [],
    remove: [],
    userAdd: [{ section: 'stack_ferramentas', text: 'Programa com tipagem estrita habilitada no compilador' }],
    userRemove: [],
    userAccounting: [
      { candidateId: ' C1 ', destination: 'userAdd' },
      { candidateId: 'c2', destination: 'discarded' },
      { candidateId: 'c3', destination: 'nao-existe' },
      { candidateId: 7, destination: 'quarantine' },
      'lixo',
    ],
  },
  quarantine: [],
  discarded: [{ text: 'Trabalha com Electron', reason: 'derivavel' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '# Skill: Dreaming\n\n## Regras de Auto-Apply\n- ADD com secao\n',
    'utf-8',
  );
});

afterEach(() => {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

describe('runDreamingGate: opcao onUserAccounting (S15)', () => {
  it('entrega o rastro validado e o resultado e identico ao de sem callback', async () => {
    const invoker = vi.fn(async () => JSON.stringify(LLM_OUTPUT));
    let received: UserAccountingTraceEntry[] | null = null;

    const withCallback = await runDreamingGate(INPUT, {
      invoker,
      onUserAccounting: (trace) => {
        received = trace;
      },
    });
    const without = await runDreamingGate(INPUT, { invoker });

    expect(received).toEqual([
      { candidateId: 'C1', destination: 'userAdd' },
      { candidateId: 'c2', destination: 'discarded' },
    ]);
    expect(withCallback).toEqual(without);
    expect('userAccounting' in withCallback.apply).toBe(false);
  });

  it('callback que lanca nao afeta o resultado', async () => {
    const invoker = vi.fn(async () => JSON.stringify(LLM_OUTPUT));
    const result = await runDreamingGate(INPUT, {
      invoker,
      onUserAccounting: () => {
        throw new Error('boom');
      },
    });
    const reference = await runDreamingGate(INPUT, { invoker });
    expect(result).toEqual(reference);
    expect(result.failSafeTriggered).toBe(false);
  });

  it('sem candidatos de usuario o callback nao e chamado', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({ apply: { add: [], remove: [] }, quarantine: [], discarded: [] }),
    );
    const callback = vi.fn();
    await runDreamingGate({ ...INPUT, userCandidates: undefined }, { invoker, onUserAccounting: callback });
    expect(callback).not.toHaveBeenCalled();
  });

  it('em fail-safe o callback nao e chamado', async () => {
    const invoker = vi.fn(async () => 'isto nao e json');
    const callback = vi.fn();
    const result = await runDreamingGate(INPUT, { invoker, onUserAccounting: callback });
    expect(result.failSafeTriggered).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('modelo sem userAccounting entrega rastro vazio', async () => {
    const invoker = vi.fn(async () =>
      JSON.stringify({ ...LLM_OUTPUT, apply: { ...LLM_OUTPUT.apply, userAccounting: undefined } }),
    );
    const callback = vi.fn();
    await runDreamingGate(INPUT, { invoker, onUserAccounting: callback });
    expect(callback).toHaveBeenCalledWith([]);
  });
});
