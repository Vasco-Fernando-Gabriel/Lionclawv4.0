import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSwarmToolDispatch, createSwarmPermission, swarmEffectiveTools } from '../swarm-policy';
import { createWatchdog } from '../watchdog';
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-policy-'));
  dirs.push(cwd);
  const abort = new AbortController();
  const writer = vi.fn(async (_s: string) => {});
  const opts = {
    cwd,
    findingsPath: path.join(cwd, 'findings.md'),
    allowedTools: swarmEffectiveTools(['Read', 'Glob', 'Grep', 'Write', 'Bash', 'Edit', 'Agent', 'mcp__evil__write']),
    signal: abort.signal,
    writeFindings: writer,
  };
  return { ...opts, abort, writer, dispatch: createSwarmToolDispatch(opts) };
}
describe('Swarm effective policy', () => {
  it('blocks shell, editing, delegation, unknown MCP and other attempts while writing through host', async () => {
    const f = await fixture();
    for (const name of ['Bash', 'Edit', 'Agent', 'mcp__evil__write'])
      expect((await f.dispatch(name, { command: 'touch victim' })).isError).toBe(true);
    expect((await f.dispatch('Write', { file_path: path.join(f.cwd, 'other.md'), content: 'attack' })).isError).toBe(
      true,
    );
    expect(f.writer).not.toHaveBeenCalled();
    expect((await f.dispatch('Write', { file_path: f.findingsPath, content: 'evidence' })).isError).toBe(false);
    expect(f.writer).toHaveBeenCalledExactlyOnceWith('evidence');
  });
  it('rejects symlink read escapes and revoked writes', async () => {
    const f = await fixture();
    await fs.symlink(os.tmpdir(), path.join(f.cwd, 'escape'));
    expect((await f.dispatch('Read', { file_path: path.join(f.cwd, 'escape', 'outside') })).isError).toBe(true);
    f.abort.abort();
    await expect(f.dispatch('Write', { file_path: f.findingsPath, content: 'late' })).rejects.toThrow();
    expect(f.writer).not.toHaveBeenCalled();
  });
  it('o findings da propria tentativa fora do cwd e legivel (reparo de formato); qualquer outro arquivo de fora continua negado', async () => {
    const f = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-attempt-'));
    dirs.push(outside);
    const findingsPath = path.join(outside, 'findings.md');
    await fs.writeFile(findingsPath, '# Auditoria\n');
    await fs.writeFile(path.join(outside, 'other.md'), 'x');
    const dispatch = createSwarmToolDispatch({ ...f, findingsPath });
    expect((await dispatch('Read', { file_path: findingsPath })).result).toBe('# Auditoria\n');
    expect((await dispatch('Read', { file_path: path.join(outside, 'other.md') })).isError).toBe(true);
    const permission = createSwarmPermission({ ...f, findingsPath, dispatch });
    const meta = { signal: f.signal, toolUseID: 't', requestId: 'test-t' };
    expect((await permission.canUseTool!('Read', { file_path: findingsPath }, meta))?.behavior).toBe('allow');
    expect((await permission.canUseTool!('Read', { file_path: path.join(outside, 'other.md') }, meta))?.behavior).toBe(
      'deny',
    );
    expect((await permission.canUseTool!('Grep', { pattern: 'x', path: outside }, meta))?.behavior).toBe('deny');
  });
  it('Claude cannot get native Write approval, even to its findings', async () => {
    const f = await fixture();
    const permission = createSwarmPermission(f);
    const response = await permission.canUseTool!(
      'Write',
      { file_path: f.findingsPath, content: 'report' },
      { signal: f.signal, toolUseID: 't', requestId: 'test-t' },
    );
    expect(response?.behavior).toBe('deny');
    expect(f.writer).toHaveBeenCalledWith('report');
  });
  it('reads and searches real fixture without shell', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, 'code.ts'), 'const needle = 1;');
    expect((await f.dispatch('Grep', { pattern: 'needle|absent' })).result).toContain('code.ts:1:const needle');
    expect((await f.dispatch('Read', { file_path: 'code.ts' })).result).toBe('const needle = 1;');
    expect((await f.dispatch('Glob', { pattern: '**/*.ts' })).result).toContain('code.ts');
    expect((await f.dispatch('Grep', { pattern: '[' })).isError).toBe(true);
  });
});
describe('Swarm watchdog lifecycle primitive', () => {
  it('activity extends idle but never hard timeout; stop removes timers', () => {
    vi.useFakeTimers();
    const idle = vi.fn();
    const hard = vi.fn();
    const w = createWatchdog(100, idle, { limitMs: 250, onHardTimeout: hard });
    vi.advanceTimersByTime(90);
    w.reset();
    vi.advanceTimersByTime(90);
    w.reset();
    vi.advanceTimersByTime(70);
    expect(idle).not.toHaveBeenCalled();
    expect(hard).toHaveBeenCalledTimes(1);
    w.stop();
    vi.advanceTimersByTime(500);
    expect(idle).not.toHaveBeenCalled();
  });
});
describe('Swarm: leitura por trecho e repo-graph no dispatcher e no canUseTool', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n');
  it('Read sem faixa devolve as primeiras 400 linhas com a nota do total; com faixa devolve a faixa; ate 400 linhas vem inteiro', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, 'grande.ts'), lines(1000));
    await fs.writeFile(path.join(f.cwd, 'pequeno.ts'), lines(400));
    const first = (await f.dispatch('Read', { file_path: 'grande.ts' })).result;
    expect(first.startsWith('linha 1\n')).toBe(true);
    expect(first).toContain('\nlinha 400\n');
    expect(first).not.toContain('linha 401');
    expect(
      first.endsWith(
        '[arquivo tem 1000 linhas; peca uma faixa (offset/limit) para ler o restante a partir da linha 400]',
      ),
    ).toBe(true);
    const range = (await f.dispatch('Read', { file_path: 'grande.ts', offset: 400, limit: 50 })).result;
    expect(range.startsWith('linha 401\n')).toBe(true);
    expect(range).toContain('linha 450');
    expect(range).not.toContain('linha 451');
    expect(range).toContain('[faixa 400-450 de 1000 linhas; restam 550 apos esta faixa]');
    const tail = (await f.dispatch('Read', { file_path: 'grande.ts', offset: 990, limit: 50 })).result;
    expect(tail).toBe(lines(1000).split('\n').slice(990).join('\n'));
    const whole = (await f.dispatch('Read', { file_path: 'pequeno.ts' })).result;
    expect(whole).toBe(lines(400));
    expect((await f.dispatch('Read', { file_path: 'grande.ts', limit: 5000 })).result.split('\n')).toHaveLength(1000);
  });
  it('canUseTool da familia Claude injeta limit 400 no Read sem faixa, preserva offset/limit explicitos e nao mexe no Grep', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, 'a.ts'), 'x');
    const permission = createSwarmPermission(f);
    const ctx = { signal: f.signal, toolUseID: 't', requestId: 'r' };
    const plain = await permission.canUseTool!('Read', { file_path: path.join(f.cwd, 'a.ts') }, ctx);
    expect(plain).toEqual({ behavior: 'allow', updatedInput: { file_path: path.join(f.cwd, 'a.ts'), limit: 400 } });
    const ranged = await permission.canUseTool!(
      'Read',
      { file_path: path.join(f.cwd, 'a.ts'), offset: 120, limit: 30 },
      ctx,
    );
    expect(ranged).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: path.join(f.cwd, 'a.ts'), offset: 120, limit: 30 },
    });
    const grep = await permission.canUseTool!('Grep', { pattern: 'x', path: f.cwd }, ctx);
    expect(grep).toEqual({ behavior: 'allow', updatedInput: { pattern: 'x', path: f.cwd } });
    const { swarmSdkHooks } = await import('../swarm-sdk-hooks');
    const hook = swarmSdkHooks({ permission } as never).PreToolUse[0]!.hooks[0]!;
    const out = (await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: path.join(f.cwd, 'a.ts') },
      } as never,
      'id',
      { signal: f.signal } as never,
    )) as { hookSpecificOutput: { permissionDecision: string; updatedInput?: Record<string, unknown> } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput).toEqual({ file_path: path.join(f.cwd, 'a.ts'), limit: 400 });
  });
  it('tools de leitura do repo-graph passam pelo dispatcher (so quando ha repositorio) e pelo canUseTool; build/update e qualquer outra MCP sao negadas', async () => {
    const f = await fixture();
    const invoke = vi.fn(async (tool: string, params: Record<string, unknown>) => ({ tool, params, symbols: [] }));
    const allowedTools = [
      ...f.allowedTools,
      'mcp__repo-graph__repo_graph_search',
      'mcp__repo-graph__repo_graph_callers',
      'mcp__repo-graph__repo_graph_build',
    ];
    const dispatch = createSwarmToolDispatch({ ...f, allowedTools, repoGraph: invoke });
    const search = await dispatch('mcp__repo-graph__repo_graph_search', { term: 'login' });
    expect(search.isError).toBe(false);
    expect(JSON.parse(search.result)).toEqual({
      tool: 'mcp__repo-graph__repo_graph_search',
      params: { term: 'login' },
      symbols: [],
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((await dispatch('mcp__repo-graph__repo_graph_build', {})).isError).toBe(true);
    expect((await dispatch('mcp__repo-graph__repo_graph_status', {})).isError).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const without = createSwarmToolDispatch({ ...f, allowedTools });
    const denied = await without('mcp__repo-graph__repo_graph_search', { term: 'login' });
    expect(denied.isError).toBe(true);
    expect(denied.result).toContain('sem repositorio registrado');
    const permission = createSwarmPermission({ ...f, allowedTools, dispatch });
    const ctx = { signal: f.signal, toolUseID: 't', requestId: 'r' };
    expect((await permission.canUseTool!('mcp__repo-graph__repo_graph_callers', { symbol: 'x' }, ctx))?.behavior).toBe(
      'allow',
    );
    expect((await permission.canUseTool!('mcp__repo-graph__repo_graph_build', {}, ctx))?.behavior).toBe('deny');
    expect((await permission.canUseTool!('mcp__repo-graph__repo_graph_status', {}, ctx))?.behavior).toBe('deny');
    expect((await permission.canUseTool!('mcp__other__repo_graph_search', {}, ctx))?.behavior).toBe('deny');
  });
});
