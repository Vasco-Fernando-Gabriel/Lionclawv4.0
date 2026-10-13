export const FILE_LEVEL_TYPES: ReadonlySet<string> = new Set([
  'file',
  'config',
  'document',
  'service',
  'pipeline',
  'schema',
  'resource',
]);

export const SUB_NODE_TYPES: ReadonlySet<string> = new Set(['function', 'class', 'table', 'endpoint', 'step']);
