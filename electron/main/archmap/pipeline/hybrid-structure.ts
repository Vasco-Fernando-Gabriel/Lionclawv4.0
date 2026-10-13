import type { BatchInput, BatchOutput, ScanFile } from './types';
import { structuralEdges } from './structural';

export function structuralFileType(file: ScanFile): string {
  switch (file.fileCategory) {
    case 'docs':
      return 'document';
    case 'config':
      return 'config';
    case 'infra':
      if (/(^|\/)\.github\/workflows\/|\.gitlab-ci|Jenkinsfile|\.circleci\//.test(file.path)) return 'pipeline';
      return /\.tf(vars)?$|cloudformation|Vagrantfile/i.test(file.path) ? 'resource' : 'service';
    case 'data':
      return 'schema';
    default:
      return 'file';
  }
}

export function buildStructuralGraph(input: BatchInput): BatchOutput {
  const nodes: BatchOutput['nodes'] = [];
  const edges: BatchOutput['edges'] = [];
  const byPath = new Map(input.extraction.map((entry) => [entry.path, entry]));
  for (const file of input.files) {
    const type = structuralFileType(file);
    const owner = `${type}:${file.path}`;
    const entry = byPath.get(file.path);
    nodes.push({
      id: owner,
      type,
      name: file.path.split('/').at(-1),
      filePath: file.path,
      summary: `Arquivo ${file.language}; estrutura extraída automaticamente. Interpretação pendente.`,
      tags: ['parser', file.fileCategory],
      complexity: 'moderate',
    });
    const exported = new Set(entry?.exports?.map((item) => item.name));
    const seen = new Set<string>();
    const add = (kind: string, name: string, start: number, end: number) => {
      const base = `${kind}:${file.path}:${name}`;
      const id = seen.has(base) ? `${base}@${start}` : base;
      if (seen.has(id)) return;
      seen.add(id);
      nodes.push({
        id,
        type: kind,
        name,
        filePath: file.path,
        lineRange: [Math.max(1, start), Math.max(1, start, end)],
        summary: `${kind} ${name}, declarado em ${file.path}. Estrutura extraída pelo parser.`,
        tags: ['parser', ...(exported.has(name) ? ['exported'] : [])],
        complexity: 'moderate',
      });
      edges.push({ source: owner, target: id, type: 'contains', direction: 'forward', weight: 1 });
    };
    for (const fn of entry?.functions ?? []) add('function', fn.name, fn.startLine, fn.endLine);
    for (const cls of entry?.classes ?? []) add('class', cls.name, cls.startLine, cls.endLine);
    for (const def of entry?.definitions ?? [])
      add(/\.sql$/i.test(file.path) ? 'table' : 'schema', def.name, def.startLine, def.endLine);
    for (const service of entry?.services ?? []) add('service', service.name, service.startLine, service.endLine);
    for (const endpoint of entry?.endpoints ?? []) add('endpoint', endpoint.name, endpoint.startLine, endpoint.endLine);
    for (const resource of entry?.resources ?? []) add('resource', resource.name, resource.startLine, resource.endLine);
  }
  return { nodes, edges: structuralEdges(input, nodes, edges) };
}
