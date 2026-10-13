import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import which from 'which';
import { getSetting } from '../db';
import { DETACH_FOR_TREE_KILL, killProcessTree } from '../kill-process-tree';

const PROBE_TIMEOUT_MS = 8_000;

export interface CodexBinaryStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  appServerSupported: boolean;
  binaryPath?: string;
  error?: string;
}

interface StableCapability {
  binaryPath: string;
  version: string | null;
  appServerSupported: boolean;
  error?: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const capabilityCache = new Map<string, StableCapability>();
const capabilityFlights = new Map<string, Promise<StableCapability>>();

function isAuthenticated(): boolean {
  return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
}

export async function resolveCodexBinary(): Promise<string | null> {
  try {
    const configured = getSetting('codex_binary_path');
    if (configured && fs.existsSync(configured)) return configured;
  } catch {}

  try {
    return await which('codex');
  } catch {
    if (process.platform !== 'win32') return null;
    const appData = process.env['APPDATA'];
    const userProfile = process.env['USERPROFILE'] ?? os.homedir();
    const candidates = [
      ...(appData
        ? [
            path.join(appData, 'npm', 'codex.cmd'),
            path.join(appData, 'npm', 'codex.exe'),
            path.join(appData, 'npm', 'codex'),
          ]
        : []),
      path.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      path.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex.exe'),
      path.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }
}

export interface CodexSpawnTarget {
  command: string;
  useShell: boolean;
  resolvedFromShim: boolean;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function findCodexExeUnderScope(scopeDir: string): string | null {
  for (const pkg of listDirs(scopeDir)) {
    if (!path.basename(pkg).startsWith('codex-win32-')) continue;
    for (const target of listDirs(path.join(pkg, 'vendor'))) {
      const exe = path.join(target, 'bin', 'codex.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

export function resolveCodexSpawnTarget(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): CodexSpawnTarget {
  const isShim = platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
  if (!isShim) return { command: binary, useShell: false, resolvedFromShim: false };
  const dir = path.dirname(binary);
  const scopes = [
    path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
    path.join(dir, 'node_modules', '@openai'),
    path.join(dir, '..', '@openai'),
  ];
  for (const scope of scopes) {
    const exe = findCodexExeUnderScope(scope);
    if (exe) return { command: exe, useShell: false, resolvedFromShim: true };
  }
  return { command: binary, useShell: true, resolvedFromShim: false };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('error', finish);
  });
}

async function runBounded(binary: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd');
    const child = spawn(binary, args, {
      detached: DETACH_FOR_TREE_KILL,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = async (code: number | null, spawnError?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) await waitForExit(child, 2_000);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut, spawnError });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('close', (code) => {
      void finish(code);
    });
    child.once('error', (error) => {
      void finish(null, error.message);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGKILL');
      void finish(null);
    }, PROBE_TIMEOUT_MS);
  });
}

function stableKey(binary: string): string {
  const real = fs.realpathSync(binary);
  return `${real}:${fs.statSync(real).mtimeMs}`;
}

async function probeStableCapability(binary: string): Promise<StableCapability> {
  let key: string;
  try {
    key = stableKey(binary);
  } catch (error) {
    return {
      binaryPath: binary,
      version: null,
      appServerSupported: false,
      error: `Nao foi possivel inspecionar o binario Codex: ${(error as Error).message}`,
    };
  }

  const cached = capabilityCache.get(key);
  if (cached) return cached;
  const active = capabilityFlights.get(key);
  if (active) return active;

  const flight = (async (): Promise<StableCapability> => {
    const [versionResult, appServerResult] = await Promise.all([
      runBounded(binary, ['--version']),
      runBounded(binary, ['app-server', '--help']),
    ]);
    const version = versionResult.code === 0 ? versionResult.stdout || null : null;
    const appServerSupported = appServerResult.code === 0 && !appServerResult.timedOut;
    const detail =
      appServerResult.spawnError ??
      (appServerResult.timedOut ? 'probe de app-server excedeu o timeout' : undefined) ??
      (appServerSupported
        ? undefined
        : appServerResult.stderr || appServerResult.stdout || `exit ${String(appServerResult.code)}`);
    const result: StableCapability = {
      binaryPath: binary,
      version,
      appServerSupported,
      ...(detail ? { error: `Codex CLI sem App Server utilizavel: ${detail}` } : {}),
    };
    capabilityCache.set(key, result);
    return result;
  })().finally(() => capabilityFlights.delete(key));

  capabilityFlights.set(key, flight);
  return flight;
}

export function invalidateCodexBinaryProbe(): void {
  capabilityCache.clear();
  capabilityFlights.clear();
}

export async function getCodexBinaryStatus(): Promise<CodexBinaryStatus> {
  const binary = await resolveCodexBinary();
  if (!binary) {
    return {
      installed: false,
      version: null,
      authenticated: false,
      appServerSupported: false,
      error: 'Codex CLI nao encontrado',
    };
  }
  const stable = await probeStableCapability(binary);
  return {
    installed: true,
    version: stable.version,
    authenticated: isAuthenticated(),
    appServerSupported: stable.appServerSupported,
    binaryPath: stable.binaryPath,
    ...(stable.error ? { error: stable.error } : {}),
  };
}

export const isCodexAvailable = getCodexBinaryStatus;
