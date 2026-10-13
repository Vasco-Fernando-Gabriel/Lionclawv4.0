import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStructuralGraph } from './hybrid-structure';
import { normalizeBatchOutput } from './normalize';
import type { BatchInput, BatchOutput, BatchPlan } from './types';

export const ARCHMAP_CHECKPOINT_PROTOCOL = 3;
export const ARCHMAP_CORE_VERSION = 'archmap-core-5feed1f';
export const ARCHMAP_CHECKPOINTS_KEPT = 3;
export const ARCHMAP_AGENT_CACHE_DIR = 'agent-cache';
export const ARCHMAP_TASK_CACHE_DIR = 'agent-task-cache';
const CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;

export type ArchmapLlmPhase = 'narrative' | 'analysis' | 'review' | 'layers' | 'tour';

export const ARCHMAP_PROMPT_VERSIONS: Readonly<Record<ArchmapLlmPhase, number>> = {
  narrative: 1,
  analysis: 1,
  review: 1,
  layers: 1,
  tour: 1,
};

export interface GenerationConfig {
  runtime: string;
  provider: string;
  model: string;
  effort: string | null;
}

export interface CheckpointArtifact {
  path: string;
  hash: string;
}

export function sha256Of(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function checkpointKey(
  phase: ArchmapLlmPhase,
  config: GenerationConfig,
  input: unknown,
  artifacts: readonly CheckpointArtifact[] = [],
): string {
  return sha256Of({
    protocol: ARCHMAP_CHECKPOINT_PROTOCOL,
    phase,
    config: {
      runtime: config.runtime,
      provider: config.provider,
      model: config.model,
      effort: config.effort ?? null,
      promptVersion: ARCHMAP_PROMPT_VERSIONS[phase],
      coreVersion: ARCHMAP_CORE_VERSION,
    },
    input,
    artifacts: [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

export function pathsIdentity(paths: readonly string[]): string {
  return sha256Of([...paths].sort());
}

export function batchCheckpointInput(input: BatchInput, hashes: ReadonlyMap<string, string>): unknown {
  const extraction = new Map(input.extraction.map((entry) => [entry.path, entry]));
  return {
    projectName: input.projectName,
    files: input.files.map((file) => ({
      path: file.path,
      hash: hashes.get(file.path) ?? null,
      language: file.language,
      category: file.fileCategory,
      extraction: extraction.get(file.path) ?? null,
    })),
    imports: input.batchImportData,
    context: {
      languages: input.context.languages.map((entry) => entry.id),
      frameworks: input.context.frameworks.map((entry) => entry.id),
    },
  };
}

export interface CheckpointStore {
  readBatch(key: string, identity: string, input: BatchInput): Promise<BatchOutput | null>;
  writeBatch(key: string, identity: string, output: BatchOutput): Promise<void>;
  readTask(phase: ArchmapLlmPhase, key: string): Promise<Record<string, unknown> | null>;
  writeTask(phase: ArchmapLlmPhase, key: string, raw: Record<string, unknown>): Promise<void>;
  readBatchPlan(identity: string): Promise<BatchPlan | null>;
  writeBatchPlan(identity: string, plan: BatchPlan): Promise<void>;
}

interface StoredBatch {
  protocol: number;
  key: string;
  identity: string;
  output: BatchOutput;
}

interface StoredTask {
  protocol: number;
  phase: ArchmapLlmPhase;
  key: string;
  raw: Record<string, unknown>;
}

interface StoredPlan {
  protocol: number;
  identity: string;
  plan: BatchPlan;
}

async function readJsonCapped(path: string): Promise<unknown | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > CHECKPOINT_MAX_BYTES) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, join(dir, name));
  } finally {
    await rm(temp, { force: true });
  }
}

async function pruneByPrefix(dir: string, prefix: string, keep: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    try {
      const st = await stat(join(dir, name));
      entries.push({ name, mtimeMs: st.mtimeMs });
    } catch {}
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  const removed: string[] = [];
  for (const entry of entries.slice(keep)) {
    await rm(join(dir, entry.name), { force: true }).catch(() => {});
    removed.push(entry.name);
  }
  return removed;
}

function batchFileName(identity: string, key: string): string {
  return `batch-${identity.slice(0, 24)}-${key}.json`;
}

export function createCheckpointStore(archmapDir: string, keep: number = ARCHMAP_CHECKPOINTS_KEPT): CheckpointStore {
  const batchDir = join(archmapDir, ARCHMAP_AGENT_CACHE_DIR);
  const taskDir = join(archmapDir, ARCHMAP_TASK_CACHE_DIR);
  return {
    async readBatch(key, identity, input) {
      const raw = (await readJsonCapped(join(batchDir, batchFileName(identity, key)))) as StoredBatch | null;
      if (!raw || raw.protocol !== ARCHMAP_CHECKPOINT_PROTOCOL || raw.key !== key || raw.identity !== identity) {
        return null;
      }
      try {
        const paths = input.files.map((file) => file.path);
        const normalized = normalizeBatchOutput(raw.output, paths, 'checkpoint');
        if (normalized.warnings.length > 0) return null;
        const expected = buildStructuralGraph(input);
        const saved = new Map(normalized.nodes.map((node) => [String(node.id), node]));
        if (saved.size !== expected.nodes.length) return null;
        for (const node of expected.nodes) {
          const cached = saved.get(String(node.id));
          if (!cached) return null;
          for (const field of ['type', 'name', 'filePath', 'lineRange'] as const) {
            if (JSON.stringify(cached[field]) !== JSON.stringify(node[field])) return null;
          }
        }
        return { nodes: normalized.nodes, edges: normalized.edges };
      } catch {
        return null;
      }
    },
    async writeBatch(key, identity, output) {
      const stored: StoredBatch = { protocol: ARCHMAP_CHECKPOINT_PROTOCOL, key, identity, output };
      await writeJsonAtomic(batchDir, batchFileName(identity, key), stored);
      await pruneByPrefix(batchDir, `batch-${identity.slice(0, 24)}-`, keep);
    },
    async readTask(phase, key) {
      const raw = (await readJsonCapped(join(taskDir, `${phase}-${key}.json`))) as StoredTask | null;
      if (!raw || raw.protocol !== ARCHMAP_CHECKPOINT_PROTOCOL || raw.phase !== phase || raw.key !== key) return null;
      if (typeof raw.raw !== 'object' || raw.raw === null || Array.isArray(raw.raw)) return null;
      return raw.raw;
    },
    async writeTask(phase, key, raw) {
      const stored: StoredTask = { protocol: ARCHMAP_CHECKPOINT_PROTOCOL, phase, key, raw };
      await writeJsonAtomic(taskDir, `${phase}-${key}.json`, stored);
      await pruneByPrefix(taskDir, `${phase}-`, keep);
    },
    async readBatchPlan(identity) {
      const raw = (await readJsonCapped(join(batchDir, `plan-${identity}.json`))) as StoredPlan | null;
      if (!raw || raw.protocol !== ARCHMAP_CHECKPOINT_PROTOCOL || raw.identity !== identity) return null;
      if (!raw.plan || !Array.isArray(raw.plan.batches)) return null;
      return raw.plan;
    },
    async writeBatchPlan(identity, plan) {
      const stored: StoredPlan = { protocol: ARCHMAP_CHECKPOINT_PROTOCOL, identity, plan };
      await writeJsonAtomic(batchDir, `plan-${identity}.json`, stored);
      await pruneByPrefix(batchDir, 'plan-', keep);
    },
  };
}
