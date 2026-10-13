export const ARCHMAP_SCHEMA_VERSION = 1;

export type ArchmapFileCategory = 'code' | 'config' | 'docs' | 'infra' | 'data' | 'script' | 'markup';

export interface ScanFile {
  path: string;
  language: string;
  sizeLines: number;
  sizeBytes: number;
  fileCategory: ArchmapFileCategory;
}

export interface ScanResult {
  schemaVersion: number;
  scanStartedAt: string;
  contentDigest: string;
  files: ScanFile[];
  totalFiles: number;
  filteredByIgnore: number;
  importMap: Record<string, string[]>;
  stats: {
    byCategory: Record<string, number>;
    byLanguage: Record<string, number>;
  };
  warnings: string[];
}

export interface NeighborEntry {
  path: string;
  batchIndex: number;
  symbols: string[];
}

export interface ArchmapBatch {
  batchIndex: number;
  files: ScanFile[];
  batchImportData: Record<string, string[]>;
  neighborMap: Record<string, NeighborEntry[]>;
}

export interface BatchPlan {
  schemaVersion: number;
  algorithm: 'louvain' | 'count-fallback';
  totalFiles: number;
  totalBatches: number;
  exportsByPath: Record<string, string[]>;
  batches: ArchmapBatch[];
  warnings: string[];
}

export interface ExtractedFunction {
  name: string;
  startLine: number;
  endLine: number;
  params: string[];
}

export interface ExtractedClass {
  name: string;
  startLine: number;
  endLine: number;
  methods: string[];
  properties: string[];
}

export interface ExtractedExport {
  name: string;
  line: number;
  isDefault: boolean;
}

export interface ExtractedNamed {
  name: string;
  kind?: string;
  startLine: number;
  endLine: number;
  fields?: string[];
  method?: string;
  path?: string;
  image?: string;
  ports?: number[];
}

export interface ExtractedSection {
  heading: string;
  level: number;
  line: number;
}

export interface ExtractedFile {
  path: string;
  language: string;
  fileCategory: ArchmapFileCategory;
  totalLines: number;
  nonEmptyLines: number;
  functions?: ExtractedFunction[];
  classes?: ExtractedClass[];
  exports?: ExtractedExport[];
  sections?: ExtractedSection[];
  definitions?: ExtractedNamed[];
  services?: ExtractedNamed[];
  endpoints?: ExtractedNamed[];
  steps?: ExtractedNamed[];
  resources?: ExtractedNamed[];
  callGraph?: Array<{ caller: string; callee: string; lineNumber: number }>;
  metrics: Record<string, number>;
}

export interface ExtractResult {
  batchIndex: number;
  results: ExtractedFile[];
  filesSkipped: string[];
  missing: string[];
}

export interface PromptContext {
  languages: Array<{ id: string; text: string }>;
  frameworks: Array<{ id: string; text: string }>;
}

export interface BatchInput {
  projectName: string;
  batchIndex: number;
  part?: { index: number; total: number };
  files: ScanFile[];
  extraction: ExtractedFile[];
  batchImportData: Record<string, string[]>;
  neighborMap: Record<string, NeighborEntry[]>;
  sources: Record<string, string>;
  requiredSymbols?: Record<string, string[]>;
  previousSymbols?: Record<string, string[]>;
  missingSymbols?: Record<string, string[]>;
  context: PromptContext;
  schemaError?: string;
}

export interface BatchOutput {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export type GraphRecord = Record<string, unknown>;

export interface NarrativeInput {
  projectDirName: string;
  readme: string;
  manifests: Array<{ path: string; content: string }>;
  languageCounts: Record<string, number>;
  fileCount: number;
  schemaError?: string;
}

export interface NarrativeOutput {
  name: string;
  description: string;
  frameworks: string[];
  languages: string[];
}

export interface FileNodeSummary {
  id: string;
  type: string;
  name: string;
  filePath: string;
  summary: string;
  tags: string[];
}

export interface LayerStats {
  directoryGroups: Record<string, string[]>;
  nodeTypeGroups: Record<string, string[]>;
  crossCategoryEdges: Array<{ fromType: string; toType: string; edgeType: string; count: number }>;
  interGroupImports: Array<{ from: string; to: string; count: number }>;
  intraGroupDensity: Record<string, { internalEdges: number; totalEdges: number; density: number }>;
  patternMatches: Record<string, string>;
  deploymentTopology: {
    hasDockerfile: boolean;
    hasCompose: boolean;
    hasK8s: boolean;
    hasTerraform: boolean;
    hasCI: boolean;
    infraFiles: string[];
  };
  docCoverage: {
    groupsWithDocs: number;
    totalGroups: number;
    coverageRatio: number;
    undocumentedGroups: string[];
  };
  dependencyDirection: Array<{ dependent: string; dependsOn: string }>;
  fileStats: {
    totalFileNodes: number;
    filesPerGroup: Record<string, number>;
    nodeTypeCounts: Record<string, number>;
  };
  fileFanIn: Record<string, number>;
  fileFanOut: Record<string, number>;
}

export interface LayersInput {
  projectName: string;
  description: string;
  fileNodes: FileNodeSummary[];
  stats: LayerStats;
  context: PromptContext;
  schemaError?: string;
}

export interface LayerOutput {
  id: string;
  name: string;
  description: string;
  nodeIds: string[];
}

export interface TourTopology {
  entryPointCandidates: Array<{ id: string; score: number; name: string; summary: string }>;
  fanInRanking: Array<{ id: string; fanIn: number; name: string }>;
  fanOutRanking: Array<{ id: string; fanOut: number; name: string }>;
  bfsTraversal: {
    startNode: string | null;
    order: string[];
    byDepth: Record<string, string[]>;
  };
  nonCodeFiles: {
    documentation: Array<{ id: string; name: string; summary: string }>;
    infrastructure: Array<{ id: string; name: string; summary: string }>;
    data: Array<{ id: string; name: string; summary: string }>;
    config: Array<{ id: string; name: string; summary: string }>;
  };
  clusters: Array<{ nodes: string[]; edgeCount: number }>;
  totalNodes: number;
  totalEdges: number;
}

export interface TourInput {
  projectName: string;
  description: string;
  nodeIndex: Record<string, { name: string; type: string; summary: string }>;
  layers: Array<{ id: string; name: string; description: string; nodeIds: string[] }>;
  topology: TourTopology;
  schemaError?: string;
}

export interface TourStepOutput {
  order: number;
  title: string;
  description: string;
  nodeIds: string[];
  languageLesson?: string;
}

export interface StructuredOutputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

export interface PromptBuild {
  prompt: string;
  outputSchema: StructuredOutputSchema;
}
