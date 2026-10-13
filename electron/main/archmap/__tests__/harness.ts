import { expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { SessionOrchestrator } from '../../../../src/types';
import type { ArchmapStatusEvent } from '../../../../src/types/archmap';
import type { AgentExecutionRequest, AgentExecutionResult } from '../../agent-runtime/types';
import { createArchmapAgentExecutor, type ArchmapAgentCall } from '../agent-executor';
import { createArchmapEngine, type ArchmapEngine, type ArchmapEngineDeps } from '../engine';
import type { GitRunner } from '../git';
import {
  decodeReadableText,
  fakeArchmapPatch,
  fakeGit,
  inProcessWorker,
  makeTempDir,
  memoryArchmapRepository,
  removeDir,
  repoRecord,
} from './helpers';

export const SELECTION: SessionOrchestrator = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  effort: 'high',
};

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export interface FakeAgentHooks {
  version: string;
  onNarrative?: (req: AgentExecutionRequest) => void | Promise<void>;
  onAnalysis?: (batchIndex: number, req: AgentExecutionRequest) => Promise<string | null> | string | null;
  afterAnalysis?: (batchIndex: number) => void | Promise<void>;
  edgesFor?: (requiredIds: string[]) => Array<Record<string, unknown>>;
}

export interface FakeAgent {
  executeAgent: (req: AgentExecutionRequest) => Promise<AgentExecutionResult>;
  calls: Array<{ phase: string; batchIndex: number | null; cwd: string }>;
}

export function reply(output: string): AgentExecutionResult {
  return {
    output,
    metrics: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 1,
      apiRequests: 1,
      costUsd: 0,
      durationMs: 1,
    },
    model: 'claude-opus-5-5',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

export function jsonBlocks(prompt: string): unknown[] {
  return [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!) as unknown);
}

export function phaseOf(cwd: string): { phase: string; batchIndex: number | null } {
  const parts = cwd.split(sep);
  const last = parts.at(-1) ?? '';
  if (last.startsWith('batch-')) return { phase: 'analysis', batchIndex: Number(last.slice(6)) };
  return { phase: last, batchIndex: null };
}

export function fakeAgent(hooks: FakeAgentHooks): FakeAgent {
  const calls: FakeAgent['calls'] = [];
  const executeAgent = async (req: AgentExecutionRequest): Promise<AgentExecutionResult> => {
    if (req.abortController.signal.aborted) throw new Error('aborted');
    const { phase, batchIndex } = phaseOf(req.cwd);
    calls.push({ phase, batchIndex, cwd: req.cwd });
    switch (phase) {
      case 'narrative': {
        await hooks.onNarrative?.(req);
        if (req.abortController.signal.aborted) throw new Error('aborted');
        return reply(
          JSON.stringify({
            name: 'fixture',
            description: 'Projeto de teste.',
            frameworks: [],
            languages: ['typescript'],
          }),
        );
      }
      case 'analysis': {
        const override = await hooks.onAnalysis?.(batchIndex!, req);
        if (req.abortController.signal.aborted) throw new Error('aborted');
        if (override !== null && override !== undefined) return reply(override);
        const manifest = JSON.parse(decodeReadableText(readFileSync(join(req.cwd, 'manifest.txt'), 'utf8'))) as {
          required: string[];
          files: Array<{ path: string; source: string; structure?: string }>;
        };
        const sources = new Map(
          manifest.files.map((file) => [
            file.path,
            decodeReadableText(readFileSync(join(req.cwd, file.source), 'utf8')),
          ]),
        );
        const annotations = manifest.required.map((id) => {
          const path = id.slice(id.indexOf(':') + 1);
          const marker = /marker = '([A-Z]+)'/.exec(sources.get(path) ?? '')?.[1] ?? 'sem-marcador';
          return {
            id,
            summary: `Resumo ${hooks.version} de ${path} (${marker})`,
            tags: ['teste'],
            complexity: 'simple',
          };
        });
        const output = reply(JSON.stringify({ annotations, edges: hooks.edgesFor?.(manifest.required) ?? [] }));
        await hooks.afterAnalysis?.(batchIndex!);
        return output;
      }
      case 'review':
        return reply(JSON.stringify({ summary: 'ok', nodeSummaries: [], edgePatches: [], findings: [] }));
      case 'layers': {
        const fileNodes = jsonBlocks(req.prompt)[0] as Array<{ id: string }>;
        return reply(
          JSON.stringify({
            layers: [
              { id: 'layer:nucleo', name: 'Nucleo', description: 'Tudo.', nodeIds: fileNodes.map((node) => node.id) },
            ],
          }),
        );
      }
      case 'tour': {
        const nodeIndex = jsonBlocks(req.prompt)[0] as Record<string, unknown>;
        const first = Object.keys(nodeIndex)[0]!;
        return reply(
          JSON.stringify({ steps: [{ order: 1, title: 'Inicio', description: 'Comece aqui.', nodeIds: [first] }] }),
        );
      }
      default:
        throw new Error(`fase desconhecida no fake: ${phase}`);
    }
  };
  return { executeAgent, calls };
}

export interface Harness {
  engine: ArchmapEngine;
  events: ArchmapStatusEvent[];
  repository: ReturnType<typeof memoryArchmapRepository>;
  agent: FakeAgent;
  llmCalls: ArchmapAgentCall[];
}

export function settingsOf(over: Record<string, string> = {}): (key: string) => string | undefined {
  const values: Record<string, string> = {
    archmap_enabled: 'true',
    archmap_max_parallel_repos: '2',
    archmap_batch_parallelism: '1',
    ...over,
  };
  return (key) => values[key];
}

export const temps: string[] = [];

export function cleanupTemps(): void {
  for (const dir of temps.splice(0)) removeDir(dir);
}

export interface HarnessOptions {
  realGit?: boolean;
  git?: GitRunner;
  settings?: Record<string, string>;
  deps?: Partial<ArchmapEngineDeps>;
}

export function makeHarness(
  repos: Record<string, string>,
  hooks: FakeAgentHooks,
  options: HarnessOptions = {},
): Harness {
  const records = Object.fromEntries(Object.entries(repos).map(([id, root]) => [id, repoRecord(id, root)]));
  const repository = memoryArchmapRepository(Object.keys(repos));
  const events: ArchmapStatusEvent[] = [];
  const agent = fakeAgent(hooks);
  const llmCalls: ArchmapAgentCall[] = [];
  const scratchRoot = makeTempDir('lionclaw-archmap-scratch-');
  temps.push(scratchRoot);
  const engine = createArchmapEngine({
    repository,
    getLocalRepository: (id) => records[id] ?? null,
    getSetting: settingsOf(options.settings),
    emit: (event) => events.push(event),
    createWorker: inProcessWorker,
    createExecutor: (selection, onCall) =>
      createArchmapAgentExecutor({
        selection,
        executeAgent: agent.executeAgent,
        patchFor: fakeArchmapPatch,
        onCall: (call) => {
          llmCalls.push(call);
          onCall(call);
        },
      }),
    ...(options.realGit ? {} : { git: options.git ?? fakeGit('0123456789abcdef0123456789abcdef01234567') }),
    scratchRoot,
    emitThrottleMs: 0,
    lionClawVersion: 'test',
    ...(options.deps ?? {}),
  });
  return { engine, events, repository, agent, llmCalls };
}

export async function runBuild(
  h: Harness,
  repositoryId: string,
  kind: 'build' | 'update' = 'build',
  confirmFull = false,
): Promise<void> {
  const info =
    kind === 'build'
      ? await h.engine.build(repositoryId, SELECTION)
      : await h.engine.update(repositoryId, SELECTION, confirmFull);
  expect(info.status).toBe('running');
  await h.engine.waitForJob(repositoryId);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function nodeSummaries(graph: Record<string, unknown>): Map<string, { summary: string; tags: string[] }> {
  const out = new Map<string, { summary: string; tags: string[] }>();
  for (const node of graph.nodes as Array<Record<string, unknown>>) {
    if (node.type === 'file')
      out.set(String(node.filePath), { summary: String(node.summary), tags: node.tags as string[] });
  }
  return out;
}

export function fileLevelSummaries(graph: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const node of graph.nodes as Array<Record<string, unknown>>) {
    if (typeof node.filePath !== 'string' || typeof node.id !== 'string') continue;
    if (node.id === `${String(node.type)}:${node.filePath}`) out.set(node.filePath, node);
  }
  return out;
}

export function gitIn(root: string): (...args: string[]) => string {
  return (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, USERPROFILE: root },
    }).trim();
}

export function gitInitCommit(root: string): { git: (...args: string[]) => string; head: string } {
  const git = gitIn(root);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { git, head: git('rev-parse', 'HEAD') };
}
