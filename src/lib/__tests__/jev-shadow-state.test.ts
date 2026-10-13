import { describe, it, expect } from 'vitest';
import {
  describeJevFileToolsState,
  describeJevShadowState,
  JEV_API_KEY_VAULT_KEY,
  JEV_DEFAULT_MODEL,
  normalizeJevModel,
  resolveJevModel,
} from '../../constants/jev';

describe('describeJevFileToolsState', () => {
  it('flag desligada manda em tudo', () => {
    expect(
      describeJevFileToolsState({ enabled: false, keyConfigured: true, serverStatus: 'error', serverError: 'x' }),
    ).toBe('inativo: desligado');
  });

  it('flag ligada sem chave ou com chave ilegivel', () => {
    expect(describeJevFileToolsState({ enabled: true, keyConfigured: false, serverStatus: 'running' })).toBe(
      'inativo: sem chave',
    );
    expect(
      describeJevFileToolsState({
        enabled: true,
        keyConfigured: false,
        keyError: 'VAULT-CORRUPT',
        serverStatus: 'running',
      }),
    ).toBe('erro: chave ilegivel');
  });

  it('so processo rodando e ativo', () => {
    expect(describeJevFileToolsState({ enabled: true, keyConfigured: true, serverStatus: 'running' })).toBe('ativo');
  });

  it('processo com erro mostra o motivo; parado ou ausente mostram motivo proprio', () => {
    expect(
      describeJevFileToolsState({
        enabled: true,
        keyConfigured: true,
        serverStatus: 'error',
        serverError: 'MCP-EXIT: codigo 1',
      }),
    ).toBe('erro: servidor nao subiu (MCP-EXIT: codigo 1)');
    expect(describeJevFileToolsState({ enabled: true, keyConfigured: true, serverStatus: 'error' })).toBe(
      'erro: servidor nao subiu (processo encerrou com erro)',
    );
    expect(describeJevFileToolsState({ enabled: true, keyConfigured: true, serverStatus: 'stopped' })).toBe(
      'erro: servidor nao subiu (processo parado)',
    );
    expect(describeJevFileToolsState({ enabled: true, keyConfigured: true, serverStatus: 'missing' })).toBe(
      'erro: servidor nao subiu (servidor nao registrado; rode npm run build:mcps e reinicie o app)',
    );
  });
});

describe('describeJevShadowState', () => {
  it('flag desligada manda em tudo', () => {
    expect(describeJevShadowState({ enabled: false, keyConfigured: true })).toBe('inativo: desligado');
    expect(describeJevShadowState({ enabled: false, keyConfigured: false, keyError: 'x' })).toBe('inativo: desligado');
  });

  it('flag ligada sem chave', () => {
    expect(describeJevShadowState({ enabled: true, keyConfigured: false })).toBe('inativo: sem chave');
  });

  it('flag ligada com chave ilegivel', () => {
    expect(describeJevShadowState({ enabled: true, keyConfigured: false, keyError: 'VAULT-CORRUPT' })).toBe(
      'erro: chave ilegivel',
    );
  });

  it('flag ligada com chave e ativo', () => {
    expect(describeJevShadowState({ enabled: true, keyConfigured: true, keyError: null })).toBe('ativo');
  });
});

describe('constantes e validacao do modelo', () => {
  it('chave do Vault e modelo default sao os da SPEC', () => {
    expect(JEV_API_KEY_VAULT_KEY).toBe('TYPESAFE_JEV_API_KEY');
    expect(JEV_DEFAULT_MODEL).toBe('jev-1.13.0');
  });

  it('normalizeJevModel apara e rejeita vazio ou acima de 64', () => {
    expect(normalizeJevModel('  jev-1.14.0 ')).toBe('jev-1.14.0');
    expect(normalizeJevModel('')).toBeNull();
    expect(normalizeJevModel('   ')).toBeNull();
    expect(normalizeJevModel('x'.repeat(65))).toBeNull();
    expect(normalizeJevModel('x'.repeat(64))).toBe('x'.repeat(64));
    expect(resolveJevModel(undefined)).toBe(JEV_DEFAULT_MODEL);
  });
});
