import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SessionOrchestrator } from '../../../../src/types';
import type { LocalRepositoryRecord } from '../../../../src/types/repo-graph';
import type { ArchmapAgentPatch } from '../agent-executor';
import type { ArchmapRepository, ArchmapRunRecord } from '../repository';
import type { GitOutcome, GitRunner } from '../git';
import { handleWorkerRequest } from '../pipeline/worker';
import { createInProcessPipelineWorker, type PipelineWorker } from '../pipeline/worker-client';

export function makeTempDir(prefix = 'lionclaw-archmap-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

export const SMALL_REPO_FILES: Record<string, string> = {
  'package.json': '{ "name": "fixture", "version": "1.0.0" }\n',
  'README.md': '# Fixture\n\nRepositorio de teste do mapa.\n',
  'src/index.ts':
    "import { add } from './math';\nimport { greet } from './greet';\nexport function main(): string { return greet(String(add(1, 2))); }\n",
  'src/math.ts':
    'export function add(a: number, b: number): number { return a + b; }\nexport function sub(a: number, b: number): number { return a - b; }\n',
  'src/greet.ts': 'export function greet(name: string): string { return `ola ${name}`; }\n',
  'src/util/strings.ts': 'export function upper(s: string): string { return s.toUpperCase(); }\n',
  'scripts/build.sh': '#!/bin/sh\necho build\n',
  'config/app.yaml': 'name: fixture\nport: 3000\n',
};

export function makeSmallRepo(): string {
  const root = makeTempDir();
  writeFiles(root, SMALL_REPO_FILES);
  return root;
}

export function makeLargeRepo(fileCount: number): string {
  const root = makeTempDir();
  const files: Record<string, string> = {};
  for (let i = 0; i < fileCount; i += 1) {
    const dir = `src/mod${Math.floor(i / 50)}`;
    const prev = i > 0 ? `import { f${i - 1} } from './f${i - 1}';\n` : '';
    files[`${dir}/f${i}.ts`] = `${prev}export function f${i}(): number { return ${i}; }\n`;
  }
  writeFiles(root, files);
  return root;
}

export function inProcessWorker(): PipelineWorker {
  return createInProcessPipelineWorker(handleWorkerRequest);
}

export function repoRecord(id: string, rootPath: string): LocalRepositoryRecord {
  return {
    id,
    name: id,
    rootPath,
    canonicalRootPath: resolve(rootPath),
    gitRoot: null,
    provider: 'codegraph',
    graphPath: null,
    status: 'absent',
    indexedCommit: null,
    indexedWorktreeHash: null,
    lastIndexedAt: null,
    statsJson: null,
    graphPromptSuppressedGlobal: false,
    settingsJson: '{}',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function memoryArchmapRepository(repositoryIds: string[]): ArchmapRepository & { runs: ArchmapRunRecord[] } {
  const states = new Map(
    repositoryIds.map((id) => [
      id,
      {
        repositoryId: id,
        indexedCommit: null as string | null,
        lastIndexedAt: null as string | null,
        statsJson: null as string | null,
      },
    ]),
  );
  const runs: ArchmapRunRecord[] = [];
  return {
    runs,
    getState: (id) => states.get(id) ?? null,
    setIndexed: (id, patch) => {
      const state = states.get(id);
      if (state) Object.assign(state, patch);
    },
    clearState: (id) => {
      const state = states.get(id);
      if (state) Object.assign(state, { indexedCommit: null, lastIndexedAt: null, statsJson: null });
    },
    createRun: (input) => {
      const run: ArchmapRunRecord = {
        id: input.id ?? `run-${runs.length + 1}`,
        repositoryId: input.repositoryId,
        kind: input.kind,
        status: 'running',
        runtime: input.runtime,
        provider: input.provider,
        model: input.model,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        action: null,
        reason: null,
        error: null,
        llmCalls: 0,
        llmMs: 0,
        jevAsked: 0,
        jevDispensed: 0,
        jevCostUsd: 0,
        jevFallbackReason: null,
        warnings: [],
        durationMs: null,
      };
      runs.push(run);
      return run;
    },
    finishRun: (id, patch) => {
      const run = runs.find((entry) => entry.id === id);
      if (!run) return;
      run.status = patch.status;
      run.error = patch.error ?? null;
      run.finishedAt = new Date().toISOString();
      run.action = patch.action ?? null;
      run.reason = patch.reason ?? null;
      run.llmCalls = patch.llmCalls ?? 0;
      run.llmMs = patch.llmMs ?? 0;
      run.jevAsked = patch.jevAsked ?? 0;
      run.jevDispensed = patch.jevDispensed ?? 0;
      run.jevCostUsd = patch.jevCostUsd ?? 0;
      run.jevFallbackReason = patch.jevFallbackReason ?? null;
      run.warnings = patch.warnings ? [...patch.warnings] : [];
      run.durationMs = patch.durationMs ?? null;
    },
    getRun: (id) => runs.find((entry) => entry.id === id) ?? null,
    getLast: (id) => [...runs].reverse().find((entry) => entry.repositoryId === id) ?? null,
    listByRepository: (id) => runs.filter((entry) => entry.repositoryId === id),
    listRunningRuns: () => runs.filter((entry) => entry.status === 'running'),
  };
}

export function fakeArchmapPatch(selection: SessionOrchestrator): ArchmapAgentPatch {
  switch (`${selection.runtime}|${selection.provider}`) {
    case 'claude-sdk|anthropic':
      return { runtime: 'cloud', model: selection.model, effort: 'high' };
    case 'codex-sdk|codex':
      return {
        runtime: 'codex',
        model: selection.model,
        codexConfig: { model: selection.model, sandbox: 'workspace-write', reasoningEffort: 'high' },
      };
    case 'claude-compat-sdk|zai':
      return { runtime: 'zai', model: selection.model };
    case 'claude-compat-sdk|minimax':
      return { runtime: 'minimax-tp', model: selection.model };
    case 'kimi-sdk|kimi':
      return { runtime: 'kimi', model: selection.model, effort: 'max' };
    case 'grok-sdk|grok':
      return { runtime: 'grok', model: selection.model, effort: 'medium' };
    case 'cursor-sdk|cursor':
      return { runtime: 'cursor', model: selection.model };
    case 'lion-sdk|ollama':
      return {
        runtime: 'local',
        model: selection.model,
        localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: selection.model },
        localMode: 'smart',
      };
    case 'lion-sdk|openai-compatible':
      return {
        runtime: 'external',
        model: selection.model,
        externalConfig: {
          provider: 'openai-compatible',
          protocol: 'openai-compatible',
          model: selection.model,
          baseUrl: 'https://fixture.invalid',
          apiKeyRef: 'vault-ref',
        },
      };
    case 'lion-sdk|vertex-ai':
      return {
        runtime: 'external',
        model: selection.model,
        externalConfig: {
          provider: 'gemini-agent-platform',
          protocol: 'google-genai',
          model: selection.model,
          apiKeyRef: 'vault-ref',
        },
      };
    default:
      throw new Error(`sem patch para ${selection.runtime}/${selection.provider}`);
  }
}

export function decodeReadableText(text: string): string {
  const lines = new Map<number, string>();
  for (const line of text.split('\n')) {
    const match = /^(\d+)(?:\.(\d+)\/(\d+))?: (.*)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    lines.set(index, (lines.get(index) ?? '') + match[4]);
  }
  return [...lines.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value)
    .join('\n');
}

export function makeClusteredRepo(marker = 'ORIGINAL'): { root: string; files: string[] } {
  const root = makeTempDir();
  const files: Record<string, string> = {};
  for (let c = 1; c <= 8; c += 1) {
    files[`src/c${c}/a.ts`] =
      `import { b${c} } from './b';\nimport { c${c} } from './c';\nimport { d${c} } from './d';\nexport function a${c}(): number { return b${c}() + c${c}() + d${c}(); }\n`;
    for (const name of ['b', 'c', 'd']) {
      files[`src/c${c}/${name}.ts`] = `export function ${name}${c}(): number { return ${c}; }\n`;
    }
  }
  const bigImports = Array.from(
    { length: 39 },
    (_, i) => `import { f${String(i + 1).padStart(2, '0')} } from './f${String(i + 1).padStart(2, '0')}';`,
  );
  files['src/big/f00.ts'] = `${bigImports.join('\n')}\nexport function f00(): number { return 0; }\n`;
  for (let i = 1; i < 40; i += 1) {
    const id = String(i).padStart(2, '0');
    files[`src/big/f${id}.ts`] = `export function f${id}(): number { return ${i}; }\n`;
  }
  for (const path of Object.keys(files)) files[path] = `${files[path]}export const marker = '${marker}';\n`;
  writeFiles(root, files);
  return { root, files: Object.keys(files).sort() };
}

export function fakeGit(head: string | null, options: { timeout?: boolean } = {}): GitRunner {
  return async (_projectPath, args): Promise<GitOutcome> => {
    if (options.timeout) return { ok: false, timeout: true, message: 'timeout' };
    if (args[0] === 'rev-parse') {
      return head ? { ok: true, stdout: `${head}\n` } : { ok: false, timeout: false, message: 'not a git repo' };
    }
    if (args[0] === 'cat-file') return { ok: true, stdout: '' };
    return { ok: true, stdout: '' };
  };
}

export function sampleGraph(gitCommitHash: string, nodePaths: string[]): Record<string, unknown> {
  return {
    version: '1.0.0',
    project: {
      name: 'fixture',
      languages: ['typescript'],
      frameworks: [],
      description: 'fixture',
      analyzedAt: new Date().toISOString(),
      gitCommitHash,
    },
    nodes: nodePaths.map((path) => ({
      id: `file:${path}`,
      type: 'file',
      name: path.split('/').at(-1),
      filePath: path,
      summary: `Arquivo ${path}`,
      tags: ['parser'],
      complexity: 'simple',
    })),
    edges: [],
    layers: [],
    tour: [],
  };
}
