import { describe, expect, it } from 'vitest';
import { PIPELINE_WINDOWS_SANDBOX_MODE, pipelineCodexHomeConfigToml } from '../codex-pipeline-config';

describe('config.toml do CODEX_HOME dedicado', () => {
  it('no Windows declara o sandbox sem elevacao (read-only sem a secao recusa todo comando)', () => {
    const win = pipelineCodexHomeConfigToml('win32');
    expect(PIPELINE_WINDOWS_SANDBOX_MODE).toBe('unelevated');
    expect(win).toContain('[windows]');
    expect(win).toContain(`sandbox = "${PIPELINE_WINDOWS_SANDBOX_MODE}"`);
    expect(win.split('\n').some((line) => line.startsWith('[mcp_servers'))).toBe(false);
    expect(win.endsWith('\n')).toBe(true);
  });

  it('fora do Windows nao tem secao [windows] e continua sem nenhum MCP', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const toml = pipelineCodexHomeConfigToml(platform);
      expect(toml).not.toContain('[windows]');
      expect(toml.split('\n').some((line) => line.startsWith('[mcp_servers'))).toBe(false);
    }
  });
});
