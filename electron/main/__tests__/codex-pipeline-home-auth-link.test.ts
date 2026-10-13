import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensurePipelineAuthLink } from '../codex-pipeline-config';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { real: string; link: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-link-'));
  dirs.push(root);
  const real = path.join(root, 'codex', 'auth.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{"token":"a"}');
  const home = path.join(root, 'pipeline-home');
  fs.mkdirSync(home, { recursive: true });
  return { real, link: path.join(home, 'auth.json') };
}

function eperm(): Error {
  return Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
}

describe('auth.json do CODEX_HOME dedicado', () => {
  it('sem symlink (Windows sem modo desenvolvedor) cai para hardlink e o conteudo e o mesmo', () => {
    const f = fixture();
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw eperm();
    });
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('hardlink');
    expect(fs.readFileSync(f.link, 'utf-8')).toBe('{"token":"a"}');
    expect(fs.lstatSync(f.link).isSymbolicLink()).toBe(false);
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('hardlink');
  });

  it('sem symlink nem hardlink copia o arquivo e recopia quando o auth real muda', () => {
    const f = fixture();
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw eperm();
    });
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw eperm();
    });
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('copy');
    expect(fs.readFileSync(f.link, 'utf-8')).toBe('{"token":"a"}');
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('copy');
    fs.writeFileSync(f.real, '{"token":"refreshed"}');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(f.real, future, future);
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('copy');
    expect(fs.readFileSync(f.link, 'utf-8')).toBe('{"token":"refreshed"}');
  });

  it('com symlink disponivel continua usando symlink para o auth real', () => {
    const f = fixture();
    const symlink = vi.spyOn(fs, 'symlinkSync').mockImplementation((target, p) => {
      fs.writeFileSync(p, fs.readFileSync(target));
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation((p) => {
      const stat = fs.statSync(p);
      if (String(p) === f.link) Object.defineProperty(stat, 'isSymbolicLink', { value: () => true });
      return stat;
    });
    vi.spyOn(fs, 'readlinkSync').mockReturnValue(f.real);
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('symlink');
    expect(symlink).toHaveBeenCalledWith(f.real, f.link);
    expect(ensurePipelineAuthLink(f.real, f.link)).toBe('symlink');
    expect(symlink).toHaveBeenCalledTimes(1);
  });
});
