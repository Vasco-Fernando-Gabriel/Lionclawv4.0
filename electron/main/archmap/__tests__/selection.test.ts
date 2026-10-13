import { describe, expect, it } from 'vitest';
import { ARCHMAP_SELECTION_FIELD_MAX_LENGTH, parseArchmapSelection, parseOptionalArchmapSelection } from '../selection';

const valid = { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5-5' };

describe('GB-11: selecao de modelo validada na borda do IPC', () => {
  it('aceita runtime, provider e model como texto e effort opcional', () => {
    expect(parseArchmapSelection(valid, 'gerar o mapa')).toEqual(valid);
    expect(parseArchmapSelection({ ...valid, effort: 'high' }, 'gerar o mapa')).toEqual({ ...valid, effort: 'high' });
    expect(parseArchmapSelection({ ...valid, effort: null }, 'gerar o mapa')).toEqual(valid);
    expect(parseArchmapSelection({ ...valid, extra: 1 }, 'gerar o mapa')).toEqual(valid);
  });

  it('recusa selecao ausente ou que nao e objeto com a mensagem da acao', () => {
    for (const value of [undefined, null, 'x', 7, [valid]]) {
      expect(() => parseArchmapSelection(value, 'atualizar o mapa')).toThrow(
        'Selecao de modelo obrigatoria para atualizar o mapa.',
      );
    }
  });

  it('recusa model, provider, runtime ou effort que nao sejam texto nao vazio', () => {
    expect(() => parseArchmapSelection({ ...valid, model: { toString: () => 'x' } }, 'gerar o mapa')).toThrow(
      'model deve ser texto nao vazio',
    );
    expect(() => parseArchmapSelection({ ...valid, model: '' }, 'gerar o mapa')).toThrow('model deve ser texto');
    expect(() => parseArchmapSelection({ ...valid, model: undefined }, 'gerar o mapa')).toThrow('model obrigatorio');
    expect(() => parseArchmapSelection({ ...valid, provider: 3 }, 'gerar o mapa')).toThrow('provider deve ser texto');
    expect(() => parseArchmapSelection({ ...valid, runtime: [] }, 'gerar o mapa')).toThrow('runtime deve ser texto');
    expect(() => parseArchmapSelection({ ...valid, effort: 1 }, 'gerar o mapa')).toThrow('effort deve ser texto');
  });

  it(`recusa campos acima de ${ARCHMAP_SELECTION_FIELD_MAX_LENGTH} caracteres`, () => {
    const long = 'm'.repeat(ARCHMAP_SELECTION_FIELD_MAX_LENGTH + 1);
    expect(
      parseArchmapSelection({ ...valid, model: 'm'.repeat(ARCHMAP_SELECTION_FIELD_MAX_LENGTH) }, 'x').model,
    ).toHaveLength(ARCHMAP_SELECTION_FIELD_MAX_LENGTH);
    expect(() => parseArchmapSelection({ ...valid, model: long }, 'gerar o mapa')).toThrow('model acima de 200');
    expect(() => parseArchmapSelection({ ...valid, effort: long }, 'gerar o mapa')).toThrow('effort acima de 200');
  });

  it('estimativa: selecao opcional vira null quando ausente e e validada quando presente', () => {
    expect(parseOptionalArchmapSelection(undefined, 'estimar o mapa')).toBeNull();
    expect(parseOptionalArchmapSelection(null, 'estimar o mapa')).toBeNull();
    expect(parseOptionalArchmapSelection(valid, 'estimar o mapa')).toEqual(valid);
    expect(() => parseOptionalArchmapSelection({ ...valid, model: 9 }, 'estimar o mapa')).toThrow(
      'model deve ser texto',
    );
  });
});
