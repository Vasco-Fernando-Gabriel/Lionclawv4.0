import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ts_SECRET_PIPELINE_KEY';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  lionHome: '',
  secret: { status: 'absent' } as { status: 'absent' } | { status: 'found'; value: string },
  fetchCalls: 0,
}));

const compactionJson = JSON.stringify({
  executive_summary: 'Resumo local',
  decisions: [],
  tasks_created: [],
  facts: [],
  semantic_chunks: [],
  user_profile_updates: [{ action: 'add', section: 'Preferencias', fact: 'Prefere respostas curtas' }],
  working_memory_updates: {
    add: ['Decisao de usar Vitest no projeto', 'GPU livre agora'],
    remove: [],
  },
});

const gateJson = JSON.stringify({
  apply: {
    add: [{ section: 'decisoes_ativas', text: 'Decisao de usar Vitest no projeto' }],
    remove: [],
    userAdd: [{ section: 'preferencias', text: 'Prefere respostas curtas' }],
    userRemove: [],
    userAccounting: [{ candidateId: 'c1', destination: 'userAdd' }],
  },
  quarantine: [],
  discarded: [{ text: 'GPU livre agora', reason: 'efemero' }],
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => state.lionHome,
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('FROM messages')) {
          return [
            {
              role: 'user',
              content: 'decidimos usar Vitest no projeto e prefiro respostas curtas',
              created_at: '2026-10-08T10:00:00.000Z',
              session_title: 'Teste',
            },
          ];
        }
        return [];
      }),
      run: vi.fn(),
      get: vi.fn(() => undefined),
    })),
  })),
  getSessionMessages: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn((key: string) => state.settings[key]),
  setSetting: vi.fn(),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(),
  searchVector: vi.fn(),
  setLastGateRunAt: vi.fn(),
}));

vi.mock('../provider-availability', () => ({ listProviderStatuses: async () => [] }));
vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn(async () => null) }));
vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));

vi.mock('../secrets-vault', () => ({
  getApiKey: vi.fn(async () => {
    throw new Error('Anthropic nao deve ser chamado');
  }),
  getSecret: vi.fn(async () => 'compat-key'),
  getSecretNonInteractive: vi.fn(async () => state.secret),
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn(() => ({ messages: { create: vi.fn() } })) }));

function adapter(name: string) {
  return vi.fn(() => ({
    name,
    async *streamCompletion(req: unknown) {
      const text = JSON.stringify(req).includes('GATE_INSTRUCTIONS') ? gateJson : compactionJson;
      yield { type: 'text' as const, delta: text };
      yield { type: 'done' as const };
    },
  }));
}
vi.mock('../lion-sdk/adapters/ollama', () => ({ createOllamaAdapter: adapter('ollama') }));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: adapter('lmstudio') }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: adapter('openai-compatible'),
}));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: adapter('vertex-ai') }));

import { getSecretNonInteractive } from '../secrets-vault';
import { runCompaction } from '../memory-pipeline';
import { JEV_SHADOW_JSONL_FILE } from '../jev-shadow';

type FetchInit = { body: string; signal: AbortSignal };

function jevFetch(delayMs: number) {
  return vi.fn(
    (_url: string, init: FetchInit) =>
      new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve, reject) => {
        state.fetchCalls++;
        const questions = (JSON.parse(init.body) as { questions: Record<string, { criteria: Record<string, string> }> })
          .questions;
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(questions)) {
          const prefix = id.slice(0, 2);
          const choice =
            prefix === 'o_'
              ? 'no'
              : prefix === 's_' || prefix === 'd_' || prefix === 'a_'
                ? 'none'
                : prefix === 'n_'
                  ? 'keep_new'
                  : Object.keys(q.criteria)[0];
          answers[id] = { choice, confidence: 0.9, probabilities: {} };
        }
        const timer = setTimeout(
          () =>
            resolve({
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10 } }),
            }),
          delayMs,
        );
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
  );
}

interface Outcome {
  memoryMd: string;
  userMd: string;
  warnings: unknown;
  reports: string[];
  fetchCallsAtReturn: number;
  jevSecretReadAtReturn: boolean;
  fetchCallsAfterFlush: number;
}

async function runCombo(flag: boolean, key: boolean): Promise<Outcome> {
  state.lionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-jev-shadow-'));
  await fs.mkdir(path.join(state.lionHome, 'skills', 'dreaming'), { recursive: true });
  await fs.writeFile(
    path.join(state.lionHome, 'skills', 'dreaming', 'SKILL.md'),
    '# Skill: Dreaming\n\n## Regras de Auto-Apply\n- ADD com secao\n\n## Regras de Seguranca\n- nada\n',
    'utf-8',
  );
  state.settings = {
    orchestrator_runtime: 'lion-sdk',
    orchestrator_provider: 'lmstudio',
    orchestrator_model: 'qwen/qwen3.6-27b',
    orchestrator_lmstudio_base_url: 'http://localhost:1234',
    orchestrator_compaction_provider: '',
    orchestrator_compaction_model: '',
    mgraph_mode: 'false',
    user_md_sanitized_v1: 'true',
    jev_shadow_enabled: flag ? 'true' : 'false',
    jev_model: 'jev-1.13.0',
  };
  state.secret = key ? { status: 'found', value: KEY } : { status: 'absent' };
  state.fetchCalls = 0;
  vi.mocked(getSecretNonInteractive).mockClear();

  const result = await runCompaction(
    new Date('2026-10-08T00:00:00.000Z'),
    new Date('2026-10-08T10:30:00.000Z'),
    'session-1',
  );
  const fetchCallsAtReturn = state.fetchCalls;
  const jevSecretReadAtReturn = vi
    .mocked(getSecretNonInteractive)
    .mock.calls.some(([k]) => k === 'TYPESAFE_JEV_API_KEY');

  const jsonlPath = path.join(state.lionHome, 'workspaces', 'lionclaw', 'dreaming-reports', JEV_SHADOW_JSONL_FILE);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 25));
    if (!(flag && key) || fsSync.existsSync(jsonlPath)) break;
  }
  await new Promise((r) => setTimeout(r, 50));

  const reportsDir = path.join(state.lionHome, 'workspaces', 'lionclaw', 'dreaming-reports');
  const reports = fsSync.existsSync(reportsDir) ? fsSync.readdirSync(reportsDir).sort() : [];
  return {
    memoryMd: await fs.readFile(path.join(state.lionHome, 'MEMORY.md'), 'utf-8'),
    userMd: await fs.readFile(path.join(state.lionHome, 'USER.md'), 'utf-8'),
    warnings: result?.warnings,
    reports,
    fetchCallsAtReturn,
    jevSecretReadAtReturn,
    fetchCallsAfterFlush: state.fetchCalls,
  };
}

const homes: string[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', jevFetch(20));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

describe('Clear com o modo sombra do Jev: matriz flag x chave (A1, A2, S2)', () => {
  it('a memoria e identica nas quatro combinacoes; so flag+chave chama o Jev e grava a sombra, sem segurar o Clear', async () => {
    const outcomes: Record<string, Outcome> = {};
    for (const [label, flag, key] of [
      ['off/sem', false, false],
      ['off/com', false, true],
      ['on/sem', true, false],
      ['on/com', true, true],
    ] as const) {
      outcomes[label] = await runCombo(flag, key);
      homes.push(state.lionHome);
    }
    const strip = (s: string) => s.replace(/\[\d{4}-\d{2}-\d{2}\]/g, '[data]');
    const reference = outcomes['off/sem'];
    expect(reference.memoryMd).toContain('Decisao de usar Vitest no projeto');
    expect(reference.userMd).toContain('Prefere respostas curtas');
    for (const label of ['off/com', 'on/sem', 'on/com']) {
      expect(strip(outcomes[label].memoryMd)).toBe(strip(reference.memoryMd));
      expect(strip(outcomes[label].userMd)).toBe(strip(reference.userMd));
      expect(outcomes[label].warnings).toEqual(reference.warnings);
    }
    for (const label of ['off/sem', 'off/com', 'on/sem']) {
      expect(outcomes[label].fetchCallsAfterFlush).toBe(0);
      expect(outcomes[label].reports.some((f) => f.includes('jev-shadow'))).toBe(false);
      expect(outcomes[label].reports.some((f) => f.endsWith('compaction-dreaming-report.md'))).toBe(true);
    }
    const active = outcomes['on/com'];
    expect(active.fetchCallsAtReturn).toBe(0);
    expect(active.jevSecretReadAtReturn).toBe(false);
    expect(active.fetchCallsAfterFlush).toBeGreaterThan(0);
    expect(active.reports.some((f) => f.endsWith('compaction-dreaming-report.md'))).toBe(true);
    expect(active.reports.some((f) => f.endsWith('_jev-shadow-report.md'))).toBe(true);
    expect(active.reports).toContain(JEV_SHADOW_JSONL_FILE);
    const jsonl = fsSync.readFileSync(
      path.join(state.lionHome, 'workspaces', 'lionclaw', 'dreaming-reports', JEV_SHADOW_JSONL_FILE),
      'utf-8',
    );
    const record = JSON.parse(jsonl.trim().split('\n')[0]) as {
      status: string;
      gateModelLabel: string;
      gate: Array<{ file: string; match: string }>;
      gateReportFile: string;
    };
    expect(record.status).toBe('success');
    expect(record.gateModelLabel).toBe('lion-sdk/lmstudio/qwen/qwen3.6-27b');
    expect(record.gateReportFile).toMatch(/compaction-dreaming-report\.md$/);
    expect(record.gate.find((g) => g.file === 'user')?.match).toBe('accounting');
    expect(jsonl).not.toContain(KEY);
  });

  it('com o Jev fora do ar o Clear termina normal e a sombra registra failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        state.fetchCalls++;
        return { ok: false, status: 503, text: async () => 'down' };
      }),
    );
    const outcome = await runCombo(true, true);
    homes.push(state.lionHome);
    expect(outcome.memoryMd).toContain('Decisao de usar Vitest no projeto');
    const jsonl = fsSync.readFileSync(
      path.join(state.lionHome, 'workspaces', 'lionclaw', 'dreaming-reports', JEV_SHADOW_JSONL_FILE),
      'utf-8',
    );
    expect(JSON.parse(jsonl.trim())).toMatchObject({ status: 'failed', failure: { reason: 'http' } });
    expect(outcome.reports.some((f) => f.endsWith('_jev-shadow-report.md'))).toBe(false);
  });
});
