import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPromptContext, frameworkContextId, resolveArchmapPromptContextDir } from '../prompts/context';
import { buildLayersPrompt } from '../prompts/layers';
import { buildNarrativePrompt } from '../prompts/narrative';
import { buildTourPrompt } from '../prompts/tour';

describe('contexto de linguagens e frameworks como assets lidos em runtime', () => {
  it('resolve a pasta context em dev/vitest e carrega os .md copiados do LionCode', () => {
    const dir = resolveArchmapPromptContextDir();
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, 'languages', 'typescript.md'))).toBe(true);
    expect(existsSync(join(dir!, 'frameworks', 'react.md'))).toBe(true);
    const context = buildPromptContext(
      ['typescript', 'python', 'nao-existe', '../x'],
      ['React', 'Next.js', 'Desconhecido'],
    );
    expect(context.languages.map((entry) => entry.id)).toEqual(['typescript', 'python']);
    expect(context.frameworks.map((entry) => entry.id)).toEqual(['react', 'nextjs']);
    expect(context.languages[0]!.text).toContain('TypeScript');
    expect(frameworkContextId('Ruby on Rails')).toBe('rails');
  });

  it('resolve a pasta empacotada a partir de app.getAppPath() com variante app.asar.unpacked', () => {
    const seen: string[] = [];
    const dir = resolveArchmapPromptContextDir('/dist/main/chunks', '/app/resources/app.asar', (p) => {
      seen.push(p);
      return p.includes('app.asar.unpacked');
    });
    expect(dir).toContain('app.asar.unpacked');
    expect(seen.some((p) => p.endsWith(join('electron', 'main', 'archmap', 'prompts', 'context')))).toBe(true);
    expect(resolveArchmapPromptContextDir('/nada', undefined, () => false)).toBeNull();
  });

  it('prompts de narrativa, camadas e tour saem com schema e pedido de reparo', () => {
    const narrative = buildNarrativePrompt({
      projectDirName: 'fixture',
      readme: '# x',
      manifests: [],
      languageCounts: { typescript: 3 },
      fileCount: 3,
      schemaError: 'faltou name',
    });
    expect(narrative.prompt).toContain('faltou name');
    expect(narrative.outputSchema.required).toEqual(['name', 'description', 'frameworks', 'languages']);
    const layers = buildLayersPrompt({
      projectName: 'fixture',
      description: '',
      fileNodes: [{ id: 'file:a.ts', type: 'file', name: 'a.ts', filePath: 'a.ts', summary: 's', tags: [] }],
      stats: {
        directoryGroups: {},
        nodeTypeGroups: {},
        crossCategoryEdges: [],
        interGroupImports: [],
        intraGroupDensity: {},
        patternMatches: {},
        deploymentTopology: {
          hasDockerfile: false,
          hasCompose: false,
          hasK8s: false,
          hasTerraform: false,
          hasCI: false,
          infraFiles: [],
        },
        docCoverage: { groupsWithDocs: 0, totalGroups: 0, coverageRatio: 0, undocumentedGroups: [] },
        dependencyDirection: [],
        fileStats: { totalFileNodes: 1, filesPerGroup: {}, nodeTypeCounts: {} },
        fileFanIn: {},
        fileFanOut: {},
      },
      context: { languages: [], frameworks: [] },
    });
    expect(layers.prompt).toContain('file:a.ts');
    expect(layers.outputSchema.required).toEqual(['layers']);
    const tour = buildTourPrompt({
      projectName: 'fixture',
      description: '',
      nodeIndex: { 'file:a.ts': { name: 'a.ts', type: 'file', summary: 's' } },
      layers: [],
      topology: {
        entryPointCandidates: [],
        fanInRanking: [],
        fanOutRanking: [],
        bfsTraversal: { startNode: null, order: [], byDepth: {} },
        nonCodeFiles: { documentation: [], infrastructure: [], data: [], config: [] },
        clusters: [],
        totalNodes: 1,
        totalEdges: 0,
      },
    });
    expect(tour.outputSchema.required).toEqual(['steps']);
  });
});
