import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { createIgnoreFilter, type FileFingerprint } from '../core';
import { ARCHMAP_GIT_TIMEOUT_MS } from '../git';
import type { ArchmapRegistry } from './registry';
import { makeFileFingerprint } from './fingerprints';
import { ARCHMAP_SCHEMA_VERSION, type ArchmapFileCategory, type ScanFile, type ScanResult } from './types';

export const ARCHMAP_MAX_FILE_BYTES = 512 * 1024;

export interface RawImport {
  source: string;
  specifiers: string[];
}

export interface ScanOutput {
  scan: ScanResult;
  fingerprints: Record<string, FileFingerprint>;
  rawImports: Record<string, RawImport[]>;
  exportsByPath: Record<string, string[]>;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.sbt': 'scala',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.lua': 'lua',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.rst': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.toml': 'toml',
  '.xml': 'xml',
  '.xsl': 'xml',
  '.xsd': 'xml',
  '.plist': 'xml',
  '.cfg': 'config',
  '.ini': 'config',
  '.env': 'config',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.prisma': 'prisma',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.gradle': 'gradle',
  '.csproj': 'csproj',
  '.sln': 'sln',
  '.properties': 'properties',
  '.mod': 'mod',
  '.sum': 'sum',
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  makefile: 'makefile',
  Jenkinsfile: 'jenkinsfile',
  Procfile: 'procfile',
  Vagrantfile: 'vagrantfile',
};

const CATEGORY_BY_EXT: Record<string, ArchmapFileCategory> = {
  '.md': 'docs',
  '.mdx': 'docs',
  '.rst': 'docs',
  '.txt': 'docs',
  '.text': 'docs',
  '.yaml': 'config',
  '.yml': 'config',
  '.json': 'config',
  '.jsonc': 'config',
  '.toml': 'config',
  '.xml': 'config',
  '.xsl': 'config',
  '.xsd': 'config',
  '.plist': 'config',
  '.cfg': 'config',
  '.ini': 'config',
  '.env': 'config',
  '.properties': 'config',
  '.csproj': 'config',
  '.sln': 'config',
  '.mod': 'config',
  '.sum': 'config',
  '.gradle': 'config',
  '.sbt': 'config',
  '.tf': 'infra',
  '.tfvars': 'infra',
  '.sql': 'data',
  '.graphql': 'data',
  '.gql': 'data',
  '.proto': 'data',
  '.prisma': 'data',
  '.csv': 'data',
  '.tsv': 'data',
  '.sh': 'script',
  '.bash': 'script',
  '.zsh': 'script',
  '.ps1': 'script',
  '.psm1': 'script',
  '.psd1': 'script',
  '.bat': 'script',
  '.cmd': 'script',
  '.html': 'markup',
  '.htm': 'markup',
  '.css': 'markup',
  '.scss': 'markup',
  '.sass': 'markup',
  '.less': 'markup',
};

const INFRA_FILENAMES = new Set([
  'Dockerfile',
  '.dockerignore',
  'Makefile',
  'GNUmakefile',
  'makefile',
  'Jenkinsfile',
  'Procfile',
  'Vagrantfile',
  '.gitlab-ci.yml',
]);

function dotfileKey(base: string): string | null {
  if (!base.startsWith('.')) return null;
  const match = /^(\.[a-z0-9]+)/i.exec(base);
  return match ? match[1]!.toLowerCase() : null;
}

export function detectLanguage(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return 'dockerfile';
  const dotKey = dotfileKey(base);
  if (dotKey && LANGUAGE_BY_EXT[dotKey]) return LANGUAGE_BY_EXT[dotKey]!;
  if (ext) return LANGUAGE_BY_EXT[ext] ?? ext.slice(1);
  return LANGUAGE_BY_FILENAME[base] ?? 'unknown';
}

export function detectCategory(filePath: string): ArchmapFileCategory {
  const base = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const posix = filePath.split(sep).join('/');
  if (base === 'LICENSE') return 'code';
  if (INFRA_FILENAMES.has(base)) return 'infra';
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return 'infra';
  if (base.startsWith('docker-compose.')) return 'infra';
  if (base === 'compose.yml' || base === 'compose.yaml') return 'infra';
  if (posix.startsWith('.github/workflows/')) return 'infra';
  if (posix.startsWith('.circleci/')) return 'infra';
  if (/(^|\/)(k8s|kubernetes)\//.test(posix)) return 'infra';
  if (/\.k8s\.(ya?ml)$/i.test(base)) return 'infra';
  if (ext && CATEGORY_BY_EXT[ext]) return CATEGORY_BY_EXT[ext]!;
  const dotKey = dotfileKey(base);
  if (dotKey && CATEGORY_BY_EXT[dotKey]) return CATEGORY_BY_EXT[dotKey]!;
  return 'code';
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function enumerateViaGit(projectPath: string, warnings: string[]): string[] | null {
  const result = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: projectPath,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: ARCHMAP_GIT_TIMEOUT_MS,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    warnings.push(
      `scan: git nao respondeu em ${ARCHMAP_GIT_TIMEOUT_MS / 1000} s (git ls-files) — enumeracao pelo disco`,
    );
    return null;
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split('\0').filter(Boolean).map(toPosix);
}

const HARD_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__']);

function enumerateViaWalk(projectPath: string, warnings: string[]): string[] {
  const out: string[] = [];
  const walk = (absDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      warnings.push(
        `scan: ${toPosix(relative(projectPath, absDir)) || '.'} — leitura do diretorio falhou (${error instanceof Error ? error.message : String(error)}) — subarvore ignorada`,
      );
      return;
    }
    entries.sort((a, b) => comparePaths(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (HARD_SKIP_DIRS.has(entry.name)) continue;
        walk(join(absDir, entry.name));
      } else if (entry.isFile()) {
        const rel = toPosix(relative(projectPath, join(absDir, entry.name)));
        if (rel) out.push(rel);
      }
    }
  };
  walk(projectPath);
  return out;
}

const CONTENT_DIGEST_DOMAIN = Buffer.from('lionclaw:archmap:scan-content:v1\0', 'utf8');

function updateDigest(hash: ReturnType<typeof createHash>, posixPath: string, bytes: Buffer): void {
  const pathBytes = Buffer.from(posixPath, 'utf8');
  const lengths = Buffer.allocUnsafe(12);
  lengths.writeUInt32BE(pathBytes.length, 0);
  lengths.writeBigUInt64BE(BigInt(bytes.length), 4);
  hash.update(lengths);
  hash.update(pathBytes);
  hash.update(bytes);
}

export interface ScanOptions {
  scanStartedAt: string;
  maxFileBytes?: number;
  snapshotDir?: string;
  onProgress?: (current: number, total: number) => void;
}

export function scanProject(projectPath: string, archmap: ArchmapRegistry, options: ScanOptions): ScanOutput {
  const warnings: string[] = [];
  const maxBytes = options.maxFileBytes ?? ARCHMAP_MAX_FILE_BYTES;
  const fromGit = enumerateViaGit(projectPath, warnings);
  const candidates = fromGit ?? enumerateViaWalk(projectPath, warnings);

  const filter = createIgnoreFilter(projectPath);
  const kept: string[] = [];
  let filteredByIgnore = 0;
  for (const rel of candidates) {
    if (rel.length === 0) continue;
    if (filter.isIgnored(rel)) {
      filteredByIgnore += 1;
      continue;
    }
    kept.push(rel);
  }
  kept.sort(comparePaths);

  const digest = createHash('sha256');
  digest.update(CONTENT_DIGEST_DOMAIN);
  const files: ScanFile[] = [];
  const fingerprints: Record<string, FileFingerprint> = {};
  const rawImports: Record<string, RawImport[]> = {};
  const exportsByPath: Record<string, string[]> = {};
  const { registry, structuralLanguages } = archmap;

  let index = 0;
  for (const rel of kept) {
    index += 1;
    if (options.onProgress && (index % 50 === 0 || index === kept.length)) {
      options.onProgress(index, kept.length);
    }
    const abs = join(projectPath, rel);
    let bytes: Buffer;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        warnings.push(`scan: ${rel} — link simbolico ignorado`);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > maxBytes) {
        warnings.push(`scan: ${rel} — ${st.size} bytes acima do cap de ${maxBytes} bytes — fora do mapa`);
        continue;
      }
      bytes = readFileSync(abs);
    } catch (error) {
      warnings.push(
        `scan: ${rel} — leitura falhou (${error instanceof Error ? error.message : String(error)}) — fora do mapa`,
      );
      continue;
    }
    if (options.snapshotDir) {
      const target = join(options.snapshotDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    updateDigest(digest, rel, bytes);
    let sizeLines = 0;
    for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a) sizeLines += 1;
    const language = detectLanguage(rel);
    const fileCategory = detectCategory(rel);
    files.push({ path: rel, language, sizeLines, sizeBytes: bytes.length, fileCategory });

    const content = bytes.toString('utf8');
    let analysis = null;
    try {
      analysis = registry.analyzeFile(rel, content);
    } catch (error) {
      warnings.push(
        `scan: ${rel} — analise estrutural falhou (${error instanceof Error ? error.message : String(error)}) — fingerprint so por conteudo`,
      );
    }
    const registryLanguage = registry.getLanguageForFile(rel);
    const structural = registryLanguage !== null && structuralLanguages.has(registryLanguage);
    fingerprints[rel] = makeFileFingerprint(rel, content, analysis, structural);
    if (analysis) {
      if (analysis.imports.length > 0) {
        rawImports[rel] = analysis.imports.map((imp) => ({
          source: imp.source,
          specifiers: [...imp.specifiers],
        }));
      }
      const names = analysis.exports.map((e) => e.name).filter((n) => n.length > 0);
      if (names.length > 0) exportsByPath[rel] = names;
    }
  }

  const byCategory: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const f of files) {
    byCategory[f.fileCategory] = (byCategory[f.fileCategory] ?? 0) + 1;
    byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;
  }

  const scan: ScanResult = {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    scanStartedAt: options.scanStartedAt,
    contentDigest: digest.digest('hex'),
    files,
    totalFiles: files.length,
    filteredByIgnore,
    importMap: {},
    stats: { byCategory, byLanguage },
    warnings,
  };
  return { scan, fingerprints, rawImports, exportsByPath };
}

export function parseScanResult(raw: unknown): ScanResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== ARCHMAP_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.files)) return null;
  if (typeof value.importMap !== 'object' || value.importMap === null) return null;
  const files: ScanFile[] = [];
  for (const entry of value.files as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const f = entry as Record<string, unknown>;
    if (typeof f.path !== 'string') return null;
    files.push({
      path: f.path,
      language: typeof f.language === 'string' ? f.language : 'unknown',
      sizeLines: typeof f.sizeLines === 'number' ? f.sizeLines : 0,
      sizeBytes: typeof f.sizeBytes === 'number' ? f.sizeBytes : 0,
      fileCategory: (typeof f.fileCategory === 'string' ? f.fileCategory : 'code') as ArchmapFileCategory,
    });
  }
  return {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    scanStartedAt: typeof value.scanStartedAt === 'string' ? value.scanStartedAt : '',
    contentDigest: typeof value.contentDigest === 'string' ? value.contentDigest : '',
    files,
    totalFiles: files.length,
    filteredByIgnore: typeof value.filteredByIgnore === 'number' ? value.filteredByIgnore : 0,
    importMap: value.importMap as Record<string, string[]>,
    stats:
      typeof value.stats === 'object' && value.stats !== null
        ? (value.stats as ScanResult['stats'])
        : { byCategory: {}, byLanguage: {} },
    warnings: Array.isArray(value.warnings) ? (value.warnings as string[]) : [],
  };
}
