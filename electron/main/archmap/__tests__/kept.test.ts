import { describe, expect, it } from 'vitest';
import { validateGraph } from '../core/schema';
import { KEPT_BATCH_INDEX, keptFileBatch } from '../pipeline/kept';
import type { ExtractedFile, GraphRecord, ScanFile } from '../pipeline/types';

function fileNode(path: string, summary: string): GraphRecord {
  return {
    id: `file:${path}`,
    type: 'file',
    name: path.split('/').at(-1),
    filePath: path,
    summary,
    tags: ['semantic'],
    complexity: 'moderate',
  };
}

function fnNode(path: string, name: string, summary: string): GraphRecord {
  return {
    id: `function:${path}:${name}`,
    type: 'function',
    name,
    filePath: path,
    lineRange: [1, 2],
    summary,
    tags: ['semantic'],
    complexity: 'simple',
  };
}

const A = 'src/a.ts';
const B = 'src/b.ts';
const C = 'src/c.ts';

const previous = {
  nodes: [fileNode(A, 'A orquestra B'), fnNode(A, 'foo', 'foo chama bar'), fileNode(B, 'B'), fileNode(C, 'C')],
  edges: [
    { source: `file:${A}`, target: `function:${A}:foo`, type: 'contains', direction: 'forward', weight: 1 },
    { source: `file:${A}`, target: `file:${B}`, type: 'imports', direction: 'forward', weight: 0.8 },
    { source: `file:${A}`, target: `file:${B}`, type: 'calls', direction: 'forward', weight: 0.7 },
    { source: `file:${A}`, target: `file:${C}`, type: 'depends_on', direction: 'forward', weight: 0.6 },
    { source: `file:${A}`, target: 'file:src/zz.ts', type: 'related', direction: 'forward', weight: 0.4 },
    { source: `function:${A}:foo`, target: `function:${A}:foo`, type: 'calls', direction: 'forward', weight: 0.5 },
    { source: `file:${B}`, target: `file:${A}`, type: 'calls', direction: 'forward', weight: 0.5 },
  ],
};

const files: ScanFile[] = [{ path: A, language: 'typescript', sizeLines: 3, sizeBytes: 60, fileCategory: 'code' }];
const extraction: ExtractedFile[] = [
  {
    path: A,
    language: 'typescript',
    fileCategory: 'code',
    totalLines: 3,
    nonEmptyLines: 3,
    functions: [
      { name: 'foo', startLine: 1, endLine: 2, params: [] },
      { name: 'novo', startLine: 3, endLine: 3, params: [] },
    ],
    exports: [{ name: 'foo', line: 1, isDefault: false }],
    metrics: {},
  },
];

describe('AC-23 (encaixe): arquivo mantido pela triagem', () => {
  const result = keptFileBatch({
    projectName: 'fixture',
    runId: 'run-9',
    files,
    extraction,
    importMap: { [A]: [B], [C]: [A] },
    previous,
    knownIds: new Set([`file:${B}`, `file:${C}`]),
  });

  it('nos de arquivo e funcao refletem o snapshot novo com as anotacoes antigas', () => {
    expect(result.batch.batchIndex).toBe(KEPT_BATCH_INDEX);
    expect(result.batch.paths).toEqual([A]);
    const byId = new Map(result.batch.nodes.map((node) => [String(node.id), node]));
    expect(byId.get(`file:${A}`)?.summary).toBe('A orquestra B');
    expect(byId.get(`file:${A}`)?.tags).toEqual(['semantic']);
    expect(byId.get(`function:${A}:foo`)?.summary).toBe('foo chama bar');
    expect(byId.get(`function:${A}:foo`)?.lineRange).toEqual([1, 2]);
    expect(byId.get(`function:${A}:novo`)?.tags).toContain('parser');
    expect(result.unannotated).toEqual([`function:${A}:novo`]);
  });

  it('aresta semantica fica so com os dois extremos existentes e o import presente em qualquer direcao; as demais sao removidas', () => {
    const semantic = result.batch.edges.filter(
      (edge) => !['contains', 'imports', 'exports'].includes(String(edge.type)),
    );
    expect(semantic.map((edge) => `${edge.source}->${edge.target}:${edge.type}`).sort()).toEqual([
      `file:${A}->file:${B}:calls`,
      `file:${A}->file:${C}:depends_on`,
      `function:${A}:foo->function:${A}:foo:calls`,
    ]);
    expect(result.droppedEdges).toBe(1);
    expect(result.keptEdges).toBe(3);
    for (const edge of semantic) {
      expect((edge.metadata as Record<string, unknown>).unverifiedSince).toBe('run-9');
    }
    expect(result.batch.edges.some((edge) => edge.type === 'contains' && edge.target === `function:${A}:novo`)).toBe(
      true,
    );
  });

  it('F38: GraphEdgeSchema preserva metadata na validacao do grafo', () => {
    const graph = {
      version: '1.0.0',
      project: {
        name: 'x',
        languages: [],
        frameworks: [],
        description: '',
        analyzedAt: '2026-10-09T00:00:00.000Z',
        gitCommitHash: 'abc',
      },
      nodes: [fileNode(A, 'a'), fileNode(B, 'b')],
      edges: [
        {
          source: `file:${A}`,
          target: `file:${B}`,
          type: 'calls',
          direction: 'forward',
          weight: 0.7,
          metadata: { unverifiedSince: 'run-9' },
        },
      ],
      layers: [],
      tour: [],
    };
    const validated = validateGraph(graph);
    expect(validated.success).toBe(true);
    expect((validated.data!.edges[0] as { metadata?: unknown }).metadata).toEqual({ unverifiedSince: 'run-9' });
  });
});
