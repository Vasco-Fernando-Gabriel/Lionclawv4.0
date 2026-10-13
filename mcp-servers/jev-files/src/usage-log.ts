import path from 'path';
import { resolveLionclawHome, type EnvLike } from './config.js';

export const USAGE_LOG_RELATIVE_PATH: ReadonlyArray<string> = ['workspaces', 'lionclaw', 'jev-files.jsonl'];

export interface UsageLogFsLike {
  appendFile: (filePath: string, data: string, encoding: 'utf8') => Promise<void>;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<unknown>;
}

export interface UsageRecord {
  timestamp: string;
  callId: string;
  runtimeHint: string | null;
  targets: string[];
  files: number;
  eligible: number;
  charsRead: number;
  inputTokens: number | null;
  costUsd: number | null;
  wallMs: number;
  partial: boolean;
  question: { kind: string; instructions: string } | null;
  answers: Array<{ path: string; answer: boolean | 'unsure' | string | number }>;
  picked: { path: string; confidence: number } | null;
  pickReason: string | null;
  skipped: Array<{ path: string; reason: string }>;
  error: string | null;
}

export function resolveUsageLogPath(homeDir: string, env: EnvLike): string {
  return path.join(resolveLionclawHome(homeDir, env), ...USAGE_LOG_RELATIVE_PATH);
}

let queue: Promise<void> = Promise.resolve();

export function appendUsageRecord(
  filePath: string,
  record: UsageRecord,
  fsImpl: UsageLogFsLike,
  stderr: (text: string) => void,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  queue = queue
    .then(async () => {
      await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
      await fsImpl.appendFile(filePath, line, 'utf8');
    })
    .catch((err: unknown) => {
      stderr(`jev-files: falha ao gravar jev-files.jsonl: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  return queue;
}
