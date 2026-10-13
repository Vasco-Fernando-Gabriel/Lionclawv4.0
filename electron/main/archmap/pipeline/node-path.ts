import { FILE_LEVEL_TYPES } from '../node-types';

export function normalizeRelativePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

export function nodePath(
  node: { id?: unknown; type?: unknown; filePath?: unknown },
  knownPaths?: ReadonlySet<string>,
): string | null {
  if (typeof node.filePath === 'string' && node.filePath.trim().length > 0) {
    return normalizeRelativePath(node.filePath.trim());
  }
  if (typeof node.id !== 'string' || typeof node.type !== 'string') return null;
  const prefix = `${node.type}:`;
  if (!node.id.startsWith(prefix)) return null;
  const rest = node.id.slice(prefix.length);
  if (rest.length === 0) return null;
  if (FILE_LEVEL_TYPES.has(node.type)) {
    if (knownPaths && !knownPaths.has(normalizeRelativePath(rest))) {
      const cut = rest.lastIndexOf(':');
      if (cut > 0 && knownPaths.has(normalizeRelativePath(rest.slice(0, cut)))) {
        return normalizeRelativePath(rest.slice(0, cut));
      }
    }
    return normalizeRelativePath(rest);
  }
  if (knownPaths?.has(normalizeRelativePath(rest))) return normalizeRelativePath(rest);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0) return knownPaths ? null : normalizeRelativePath(rest);
  return normalizeRelativePath(rest.slice(0, cut));
}
