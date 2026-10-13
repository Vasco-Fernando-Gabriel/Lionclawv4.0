import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_FILE_BYTES,
  MAX_PAYLOAD_TOKENS,
  estimateTokens,
  payloadWithinBudget,
  readBounded,
  type BoundedReadFsLike,
  type BoundedReadHandle,
} from '../budget';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-files-budget-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fileOf(name: string, bytes: number, fill = 'x'): string {
  const full = path.join(tmp, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, fill));
  return full;
}

describe('readBounded', () => {
  it('stat acima do teto recusa sem abrir nem ler o arquivo', async () => {
    const file = fileOf('grande.txt', MAX_FILE_BYTES + 1);
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const open = vi.fn(fs.promises.open);
    const fsImpl: BoundedReadFsLike = { stat: fs.promises.stat, open };
    const result = await readBounded(file, fsImpl);
    expect(result).toEqual({ ok: false, reason: 'too_large', message: expect.stringContaining('acima do teto') });
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('arquivo exatamente no teto e lido inteiro; um byte a mais e recusado', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const exact = await readBounded(fileOf('exato.txt', MAX_FILE_BYTES), fs.promises);
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.bytes.length).toBe(MAX_FILE_BYTES);
    const over = await readBounded(fileOf('maior.txt', MAX_FILE_BYTES + 1), fs.promises);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('too_large');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('arquivo vazio => empty', async () => {
    const result = await readBounded(fileOf('vazio.txt', 0), fs.promises);
    expect(result).toEqual({ ok: false, reason: 'empty', message: 'arquivo vazio' });
  });

  it('inexistente => unreadable', async () => {
    const result = await readBounded(path.join(tmp, 'nao.txt'), fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreadable');
  });

  it('arquivo que cresceu entre o stat e o fstat e recusado', async () => {
    const file = fileOf('cresce.txt', 10);
    const fsImpl: BoundedReadFsLike = {
      stat: fs.promises.stat,
      open: async (p, flags) => {
        const handle = await fs.promises.open(p, flags);
        return {
          stat: async () => ({ size: MAX_FILE_BYTES + 5 }),
          read: (b, o, l, pos) => handle.read(b, o, l, pos),
          close: () => handle.close(),
        };
      },
    };
    const result = await readBounded(file, fsImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
  });

  it('arquivo que cresceu entre o fstat e a leitura e recusado, nunca enviado como prefixo', async () => {
    const file = fileOf('cresce2.txt', 10);
    let closed = false;
    const fsImpl: BoundedReadFsLike = {
      stat: fs.promises.stat,
      open: async () => {
        const handle: BoundedReadHandle = {
          stat: async () => ({ size: 10 }),
          read: async (buffer, offset, length) => {
            buffer.fill(0x61, offset, offset + length);
            return { bytesRead: length };
          },
          close: async () => {
            closed = true;
          },
        };
        return handle;
      },
    };
    const result = await readBounded(file, fsImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
    expect(closed).toBe(true);
  });

  it('erro na leitura => unreadable e o descritor e fechado', async () => {
    const file = fileOf('erro.txt', 10);
    let closed = false;
    const fsImpl: BoundedReadFsLike = {
      stat: fs.promises.stat,
      open: async () => ({
        stat: async () => ({ size: 10 }),
        read: async () => {
          throw new Error('EIO leitura falhou');
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    const result = await readBounded(file, fsImpl);
    expect(result).toEqual({ ok: false, reason: 'unreadable', message: 'EIO leitura falhou' });
    expect(closed).toBe(true);
  });
});

describe('orcamento do payload', () => {
  it('estima caracteres / 4 sobre o JSON completo', () => {
    const payload = { model: 'jev-1.13.0', state: { path: 'a', content: 'abcd' }, questions: {} };
    expect(estimateTokens(payload)).toBe(Math.ceil(JSON.stringify(payload).length / 4));
  });

  it('aceita ate 28.000 tokens e recusa acima', () => {
    const within = payloadWithinBudget({ c: 'x'.repeat(MAX_PAYLOAD_TOKENS * 4 - 20) });
    expect(within.ok).toBe(true);
    const over = payloadWithinBudget({ c: 'x'.repeat(MAX_PAYLOAD_TOKENS * 4) });
    expect(over.ok).toBe(false);
    expect(over.tokens).toBeGreaterThan(MAX_PAYLOAD_TOKENS);
  });
});
