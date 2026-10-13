import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PromptContext } from '../pipeline/types';
import { electronAppPath } from '../pipeline/worker-entry';

export const ARCHMAP_PROMPT_CONTEXT_SUBDIR = join('electron', 'main', 'archmap', 'prompts', 'context');

const cache = new Map<string, string | null>();

function unpackedVariants(p: string): string[] {
  if (p.includes('app.asar/') || p.includes('app.asar\\') || p.endsWith('app.asar')) {
    return [p.replace('app.asar', 'app.asar.unpacked'), p];
  }
  return [p];
}

export function resolveArchmapPromptContextDir(
  dirName: string = __dirname,
  appPath: string | undefined = electronAppPath(),
  existsCheck: (p: string) => boolean = existsSync,
): string | null {
  const candidates: string[] = [
    join(dirName, 'context'),
    resolve(dirName, '..', 'prompts', 'context'),
    resolve(dirName, '..', '..', ARCHMAP_PROMPT_CONTEXT_SUBDIR),
    resolve(dirName, '..', '..', '..', ARCHMAP_PROMPT_CONTEXT_SUBDIR),
  ];
  if (typeof appPath === 'string' && appPath.length > 0) {
    candidates.push(...unpackedVariants(resolve(appPath, ARCHMAP_PROMPT_CONTEXT_SUBDIR)));
  }
  for (const candidate of candidates) {
    if (existsCheck(candidate)) return candidate;
  }
  return null;
}

function safeId(id: string): string | null {
  const normalized = id.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(normalized) ? normalized : null;
}

function readContext(kind: 'languages' | 'frameworks', id: string): string | null {
  const safe = safeId(id);
  if (!safe) return null;
  const key = `${kind}/${safe}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text: string | null;
  try {
    const dir = resolveArchmapPromptContextDir();
    text = dir ? readFileSync(join(dir, kind, `${safe}.md`), 'utf8') : null;
  } catch {
    text = null;
  }
  cache.set(key, text);
  return text;
}

export function loadLanguageContext(languageId: string): string | null {
  return readContext('languages', languageId);
}

export function frameworkContextId(framework: string): string | null {
  const key = framework
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (key.length === 0) return null;
  const table: Array<[RegExp, string]> = [
    [/^next(js)?$/, 'nextjs'],
    [/^react(dom)?$/, 'react'],
    [/^vue(js)?$/, 'vue'],
    [/^express(js)?$/, 'express'],
    [/^django(rest)?/, 'django'],
    [/^fastapi$/, 'fastapi'],
    [/^flask$/, 'flask'],
    [/^gin(gonic)?$/, 'gin'],
    [/^(ruby)?(on)?rails$/, 'rails'],
    [/^spring/, 'spring'],
  ];
  for (const [pattern, id] of table) {
    if (pattern.test(key)) return id;
  }
  return null;
}

export function buildPromptContext(languageIds: Iterable<string>, frameworks: Iterable<string>): PromptContext {
  const languages: PromptContext['languages'] = [];
  const seenLanguages = new Set<string>();
  for (const id of languageIds) {
    const safe = safeId(id);
    if (!safe || seenLanguages.has(safe)) continue;
    seenLanguages.add(safe);
    const text = loadLanguageContext(safe);
    if (text) languages.push({ id: safe, text });
  }
  const frameworksOut: PromptContext['frameworks'] = [];
  const seenFrameworks = new Set<string>();
  for (const name of frameworks) {
    const id = frameworkContextId(name);
    if (!id || seenFrameworks.has(id)) continue;
    seenFrameworks.add(id);
    const text = readContext('frameworks', id);
    if (text) frameworksOut.push({ id, text });
  }
  return { languages, frameworks: frameworksOut };
}
