import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexSpawnTarget } from '../binary';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-target-'));
  dirs.push(dir);
  return dir;
}

function plantExe(scope: string): string {
  const exe = path.join(scope, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'MZ');
  return exe;
}

describe('resolveCodexSpawnTarget', () => {
  it('fora do Windows ou sem shim: o binario e usado como esta, sem shell', () => {
    expect(resolveCodexSpawnTarget('/usr/local/bin/codex', 'linux')).toEqual({
      command: '/usr/local/bin/codex',
      useShell: false,
      resolvedFromShim: false,
    });
    expect(resolveCodexSpawnTarget('C:\\tools\\codex.exe', 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      useShell: false,
      resolvedFromShim: false,
    });
  });

  it('shim do npm global (AppData/npm/codex.cmd) resolve para o codex.exe do pacote de plataforma', () => {
    const npm = path.join(root(), 'npm');
    const shim = path.join(npm, 'codex.cmd');
    fs.mkdirSync(npm, { recursive: true });
    fs.writeFileSync(shim, '@echo off');
    const exe = plantExe(path.join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'));
    expect(resolveCodexSpawnTarget(shim, 'win32')).toEqual({ command: exe, useShell: false, resolvedFromShim: true });
  });

  it('shim do projeto (node_modules/.bin/codex.cmd) resolve para node_modules/@openai/codex-win32-*/vendor', () => {
    const nodeModules = path.join(root(), 'node_modules');
    const shim = path.join(nodeModules, '.bin', 'codex.cmd');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '@echo off');
    const exe = plantExe(path.join(nodeModules, '@openai'));
    expect(resolveCodexSpawnTarget(shim, 'win32')).toEqual({ command: exe, useShell: false, resolvedFromShim: true });
  });

  it('shim sem executavel por perto: mantem o shim e o shell (comportamento antigo)', () => {
    const shim = path.join(root(), 'codex.cmd');
    fs.writeFileSync(shim, '@echo off');
    expect(resolveCodexSpawnTarget(shim, 'win32')).toEqual({ command: shim, useShell: true, resolvedFromShim: false });
  });
});
