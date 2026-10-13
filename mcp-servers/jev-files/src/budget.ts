export const MAX_FILE_BYTES = 110_000;
export const MAX_PAYLOAD_TOKENS = 28_000;
export const CHARS_PER_TOKEN = 4;
export const REQUEST_TIMEOUT_MS = 15_000;
export const CALL_DEADLINE_MS = 45_000;
export const MAX_PARALLEL = 8;
export const MAX_FILES_PER_CALL = 100;

export type BoundedReadReason = 'too_large' | 'empty' | 'unreadable';

export type BoundedReadResult = { ok: true; bytes: Buffer } | { ok: false; reason: BoundedReadReason; message: string };

export interface BoundedReadHandle {
  stat(): Promise<{ size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface BoundedReadFsLike {
  stat: (p: string) => Promise<{ size: number }>;
  open: (p: string, flags: 'r') => Promise<BoundedReadHandle>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tooLarge(size: number): BoundedReadResult {
  return { ok: false, reason: 'too_large', message: `arquivo com ${size} bytes, acima do teto de ${MAX_FILE_BYTES}` };
}

export async function readBounded(filePath: string, fsImpl: BoundedReadFsLike): Promise<BoundedReadResult> {
  let size: number;
  try {
    size = (await fsImpl.stat(filePath)).size;
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: errorText(err) };
  }
  if (size > MAX_FILE_BYTES) return tooLarge(size);

  let handle: BoundedReadHandle;
  try {
    handle = await fsImpl.open(filePath, 'r');
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: errorText(err) };
  }
  try {
    const current = (await handle.stat()).size;
    if (current > MAX_FILE_BYTES) return tooLarge(current);
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) return tooLarge(total);
    if (total === 0) return { ok: false, reason: 'empty', message: 'arquivo vazio' };
    return { ok: true, bytes: buffer.subarray(0, total) };
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: errorText(err) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function estimateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / CHARS_PER_TOKEN);
}

export function payloadWithinBudget(payload: unknown): { ok: true; tokens: number } | { ok: false; tokens: number } {
  const tokens = estimateTokens(payload);
  return tokens <= MAX_PAYLOAD_TOKENS ? { ok: true, tokens } : { ok: false, tokens };
}
