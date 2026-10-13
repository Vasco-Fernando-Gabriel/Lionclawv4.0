import { describe, expect, it } from 'vitest';
import { codexMcpCommand } from '../swarm/codex-mcp-command';

describe('codexMcpCommand', () => {
  it('em dev troca o electron.exe por node (o Codex nao propaga ELECTRON_RUN_AS_NODE ao MCP)', () => {
    expect(codexMcpCommand('C:\\proj\\node_modules\\electron\\dist\\electron.exe', false)).toBe('node');
    expect(codexMcpCommand('/proj/node_modules/electron/dist/electron', false)).toBe('node');
  });

  it('em dev mantem um node de verdade; empacotado mantem o binario interno', () => {
    expect(codexMcpCommand('/node', false)).toBe('/node');
    expect(codexMcpCommand('C:\\app\\resources\\runtime\\node.exe', true)).toBe(
      'C:\\app\\resources\\runtime\\node.exe',
    );
    expect(codexMcpCommand('C:\\proj\\node_modules\\electron\\dist\\electron.exe', true)).toBe(
      'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
    );
  });
});
