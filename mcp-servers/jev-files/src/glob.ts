import path from 'path';

const GLOB_CHARS_RE = /[*?{]/;

export function hasGlobChars(target: string): boolean {
  return GLOB_CHARS_RE.test(target);
}

export interface SplitGlob {
  baseDir: string;
  pattern: string;
}

export function splitGlob(target: string): SplitGlob | null {
  const match = GLOB_CHARS_RE.exec(target);
  if (!match) return null;
  const prefix = target.slice(0, match.index);
  const lastSep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  if (lastSep < 0) return { baseDir: '', pattern: target.replace(/\\/g, '/') };
  return {
    baseDir: prefix.slice(0, lastSep + 1),
    pattern: target.slice(lastSep + 1).replace(/\\/g, '/'),
  };
}

function escapeRegExp(char: string): string {
  return /[.+^$()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function findClosingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function convert(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      if (j - i >= 2) {
        if (pattern[j] === '/') {
          out += '(?:[^/]*/)*';
          i = j + 1;
        } else {
          out += '.*';
          i = j;
        }
      } else {
        out += '[^/]*';
        i = j;
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (char === '{') {
      const close = findClosingBrace(pattern, i);
      if (close < 0) {
        out += '\\{';
        i++;
        continue;
      }
      const alternatives = splitAlternatives(pattern.slice(i + 1, close));
      out += `(?:${alternatives.map(convert).join('|')})`;
      i = close + 1;
      continue;
    }
    out += escapeRegExp(char);
    i++;
  }
  return out;
}

export function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  return new RegExp(`^${convert(pattern.replace(/\\/g, '/'))}$`, caseInsensitive ? 'i' : '');
}

export function globMaxDepth(pattern: string): number {
  if (pattern.includes('**')) return Infinity;
  return pattern.split('/').filter((s) => s.length > 0).length - 1;
}

export function toGlobRelative(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, '/');
}
