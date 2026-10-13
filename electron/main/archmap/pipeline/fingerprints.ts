import {
  contentHash,
  extractFileFingerprint,
  type FileFingerprint,
  type FingerprintStore,
  type StructuralAnalysis,
} from '../core';
import { ARCHMAP_SCHEMA_VERSION } from './types';

export interface ArchmapFingerprintFile extends FingerprintStore {
  schemaVersion: number;
}

export function makeFileFingerprint(
  filePath: string,
  content: string,
  analysis: StructuralAnalysis | null,
  structural: boolean,
): FileFingerprint {
  if (analysis && structural) {
    return extractFileFingerprint(filePath, content, analysis);
  }
  return {
    filePath,
    contentHash: contentHash(content),
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    totalLines: content.split('\n').length,
    hasStructuralAnalysis: false,
  };
}

export function makeFingerprintFile(
  files: Record<string, FileFingerprint>,
  gitCommitHash: string,
  generatedAt: string,
): ArchmapFingerprintFile {
  return {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    version: '1.0.0',
    gitCommitHash,
    generatedAt,
    files,
  };
}

export function parseFingerprintFile(raw: unknown): ArchmapFingerprintFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== ARCHMAP_SCHEMA_VERSION) return null;
  if (typeof value.files !== 'object' || value.files === null) return null;
  if (typeof value.gitCommitHash !== 'string') return null;
  return {
    schemaVersion: ARCHMAP_SCHEMA_VERSION,
    version: '1.0.0',
    gitCommitHash: value.gitCommitHash,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    files: value.files as Record<string, FileFingerprint>,
  };
}
