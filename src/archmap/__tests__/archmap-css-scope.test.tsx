// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchmapPage } from '@/pages/ArchmapPage';
import { useAppStore } from '@/stores/app-store';
import { useArchmapStore } from '@/stores/archmap-store';
import { useRepoGraphStore } from '@/stores/repo-graph-store';
import { useDashboardStore } from '@/archmap/dashboard/store';
import type { LocalRepositoryRecord } from '@/types/repo-graph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DASHBOARD_DIR = join(__dirname, '..', 'dashboard');
const ROOT_SCOPE = '.archmap-root';
const GLOBAL_SELECTOR = /^(html|body|:root|\*|:host)(\b|$)/;

interface CssRule {
  selector: string;
  context: string[];
}

export function extractCssRules(css: string): CssRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const walk = (text: string, context: string[]): void => {
    let i = 0;
    let prelude = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{') {
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth += 1;
          else if (text[j] === '}') depth -= 1;
          j += 1;
        }
        const body = text.slice(i + 1, j - 1);
        const head = prelude.trim();
        if (
          head.startsWith('@media') ||
          head.startsWith('@supports') ||
          head.startsWith('@layer') ||
          head.startsWith('@container')
        ) {
          walk(body, [...context, head]);
        } else if (!head.startsWith('@')) {
          for (const selector of head.split(',')) {
            const trimmed = selector.trim();
            if (trimmed) rules.push({ selector: trimmed, context });
          }
        }
        prelude = '';
        i = j;
        continue;
      }
      if (ch === ';') {
        prelude = '';
        i += 1;
        continue;
      }
      prelude += ch;
      i += 1;
    }
  };
  walk(source, []);
  return rules;
}

export function extractCssAtRules(css: string): Array<{ name: string; prelude: string }> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Array<{ name: string; prelude: string }> = [];
  const re = /@([a-zA-Z-]+)\s*([^{;]*)[{;]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    found.push({ name: match[1], prelude: match[2].trim() });
  }
  return found;
}

const BUNDLE_DIR = join(__dirname, '..', '..', '..', 'dist', 'renderer', 'assets');
const bundleCss = existsSync(BUNDLE_DIR) ? readdirSync(BUNDLE_DIR).filter((f) => f.endsWith('.css')) : [];
const APP_KEYFRAMES = new Set(['spin', 'pulse', 'ping', 'bounce', 'blink', 'dashdraw']);

const REPO: LocalRepositoryRecord = {
  id: 'repo-1',
  name: 'exemplo-mapa',
  rootPath: '/r',
  canonicalRootPath: '/r',
  gitRoot: null,
  provider: 'codegraph',
  graphPath: null,
  status: 'absent',
  indexedCommit: null,
  indexedWorktreeHash: null,
  lastIndexedAt: null,
  statsJson: null,
  graphPromptSuppressedGlobal: false,
  settingsJson: '{}',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('AC-16: CSS do dashboard escopado em .archmap-root', () => {
  it('index.css do fork nao tem regra global (body, :root, *, html) sem o prefixo', () => {
    const css = readFileSync(join(DASHBOARD_DIR, 'index.css'), 'utf8');
    const rules = extractCssRules(css);
    expect(rules.length).toBeGreaterThan(30);
    const unscoped = rules.filter((rule) => !rule.selector.startsWith(ROOT_SCOPE));
    expect(unscoped).toEqual([]);
    const globals = rules.filter((rule) => GLOBAL_SELECTOR.test(rule.selector));
    expect(globals).toEqual([]);
    expect(css).not.toMatch(/@import\s+["']tailwindcss/);
    expect(css).not.toMatch(/@theme\s*\{/);
  });

  it('S4-V6: at-rules do fork: sem @font-face, @import e @property; @keyframes so com prefixo archmap-', () => {
    for (const file of ['index.css', 'theme.css']) {
      const atRules = extractCssAtRules(readFileSync(join(DASHBOARD_DIR, file), 'utf8'));
      expect(
        atRules.filter((r) => ['font-face', 'import', 'property', 'charset', 'namespace'].includes(r.name)),
        file,
      ).toEqual([]);
      const keyframes = atRules.filter((r) => r.name === 'keyframes').map((r) => r.prelude);
      expect(
        keyframes.filter((name) => !name.startsWith('archmap-')),
        file,
      ).toEqual([]);
      for (const rule of atRules.filter((r) => r.name === 'media' || r.name === 'supports')) {
        expect(rule.prelude, file).not.toMatch(/^$/);
      }
    }
    const forkKeyframes = extractCssAtRules(readFileSync(join(DASHBOARD_DIR, 'index.css'), 'utf8'))
      .filter((r) => r.name === 'keyframes')
      .map((r) => r.prelude);
    expect(forkKeyframes.length).toBeGreaterThanOrEqual(5);
    const sources = readdirSync(DASHBOARD_DIR, { recursive: true })
      .map(String)
      .filter((f) => /\.(tsx?|css)$/.test(f));
    for (const file of sources) {
      const source = readFileSync(join(DASHBOARD_DIR, file), 'utf8');
      expect(source, file).not.toMatch(
        /animation(-name)?:\s*['"]?(fadeSlideIn|slideUp|accentPulse|architecture-current|architecture-breathe)\b/,
      );
      expect(source, file).not.toMatch(/@import\s+url\(|<link[^>]+stylesheet|fonts\.googleapis/);
    }
  });

  it.skipIf(bundleCss.length === 0)('S4-V6: CSS do bundle gerado (dist/renderer) nao vaza o tema do mapa', () => {
    const css = bundleCss.map((f) => readFileSync(join(BUNDLE_DIR, f), 'utf8')).join('\n');
    const rules = extractCssRules(css);
    const scoped = rules.filter((rule) => rule.selector.includes('.archmap-root'));
    expect(scoped.length).toBeGreaterThan(30);
    const themed = rules.filter((rule) => rule.selector.includes('[data-theme'));
    expect(themed.length).toBeGreaterThan(0);
    expect(themed.filter((rule) => !rule.selector.includes('.archmap-root'))).toEqual([]);
    const forkTokens =
      /--(color-root|color-surface|color-elevated|color-panel|color-accent|color-text-primary|color-node-[a-z]+|glass-bg|glow-accent|kbd-bg|font-heading)\s*:/;
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const globalBlocks = [...plain.matchAll(/(?:^|[\n{;])\s*((?::root|html|body|\*|:host)[^{}]*)\{([^{}]*)\}/g)];
    expect(globalBlocks.length).toBeGreaterThan(0);
    for (const block of globalBlocks) {
      if (block[1].includes('.archmap-root')) continue;
      expect(block[2], block[1].trim()).not.toMatch(forkTokens);
    }
    const atRules = extractCssAtRules(css);
    const keyframes = atRules.filter((r) => r.name === 'keyframes').map((r) => r.prelude);
    expect(keyframes.filter((name) => !name.startsWith('archmap-') && !APP_KEYFRAMES.has(name))).toEqual([]);
    expect(keyframes.filter((name) => name.startsWith('archmap-')).length).toBeGreaterThanOrEqual(5);
    for (const face of atRules.filter((r) => r.name === 'font-face')) expect(face.prelude).toBe('');
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces.filter((f) => /archmap|JetBrains|DM Serif|Inter\b/.test(f))).toEqual([]);
    expect(atRules.filter((r) => r.name === 'import')).toEqual([]);
    for (const prop of atRules.filter((r) => r.name === 'property')) {
      expect(prop.prelude).toMatch(/^--tw-/);
    }
  });

  it('theme.css so registra tokens por referencia (sem emitir variaveis em :root)', () => {
    const css = readFileSync(join(DASHBOARD_DIR, 'theme.css'), 'utf8');
    expect(css).toMatch(/@theme\s+reference\s*\{/);
    expect(extractCssRules(css)).toEqual([]);
    const appCss = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8');
    expect(appCss).toContain('@import "./archmap/dashboard/theme.css";');
  });

  it('o CSS do React Flow usado pelo dashboard nao define regra global', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', '..', 'node_modules', '@xyflow', 'react', 'dist', 'style.css'),
      'utf8',
    );
    const rules = extractCssRules(css);
    expect(rules.length).toBeGreaterThan(10);
    expect(rules.filter((rule) => GLOBAL_SELECTOR.test(rule.selector))).toEqual([]);
    expect(rules.filter((rule) => !rule.selector.includes('react-flow'))).toEqual([]);
  });

  it('nenhum componente do fork usa h-screen/w-screen nem mexe em document.documentElement/body', () => {
    const files = [
      'App.tsx',
      'themes/theme-engine.ts',
      'themes/ThemeContext.tsx',
      'components/GraphView.tsx',
      'components/CodeViewer.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(join(DASHBOARD_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/\b(h-screen|w-screen)\b/);
      expect(source, file).not.toMatch(/document\.(documentElement|body)\.(style|setAttribute|classList)/);
    }
  });
});

describe('AC-16: renderizar a pagina nao altera o tema do resto do app', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
    window.matchMedia =
      window.matchMedia ??
      ((query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList);
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'knowledge-graph.example.json'), 'utf8'),
    ) as unknown;
    (window as unknown as { lionclaw: unknown }).lionclaw = {
      archmap: {
        status: vi.fn(async () => ({ status: 'ready', indexedCommit: 'a', lastIndexedAt: null, generation: 'gen-1' })),
        graph: vi.fn(async () => fixture),
        meta: vi.fn(async () => ({
          lastAnalyzedAt: '2026-10-09T00:00:00Z',
          gitCommitHash: 'a',
          version: '1',
          analyzedFiles: 1,
        })),
        file: vi.fn(),
        freshness: vi.fn(async () => ({
          status: 'unknown',
          label: 'desconhecido',
          reason: '',
          changedFileCount: 0,
          changedFiles: [],
          commitsBehind: 0,
          commitsAhead: 0,
          localChanges: false,
          pendingFiles: 0,
        })),
        onStatus: vi.fn(() => () => {}),
        runtimeCapabilities: vi.fn(async () => []),
        estimate: vi.fn(),
        cancel: vi.fn(),
        build: vi.fn(),
        update: vi.fn(),
        runs: vi.fn(async () => []),
      },
      repoGraph: { list: vi.fn(async () => [REPO]) },
      provider: { listStatuses: vi.fn(async () => []) },
      settings: { get: vi.fn(async () => ({})) },
    };
    useAppStore.setState({ currentPage: 'archmap' });
    useRepoGraphStore.setState({ repositories: [REPO] });
    useArchmapStore.setState({ repos: {}, capabilities: [], openRepositoryId: 'repo-1' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    document.body.className = 'bg-zinc-950 text-zinc-100';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('aplica data-theme e as variaveis do tema no .archmap-root, nunca em html/body', async () => {
    await act(async () => {
      root.render(<ArchmapPage />);
    });
    const started = Date.now();
    while (useDashboardStore.getState().graph === null && Date.now() - started < 8000) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const archmapRoot = container.querySelector<HTMLElement>('.archmap-root');
    expect(archmapRoot).not.toBeNull();
    expect(archmapRoot!.getAttribute('data-theme')).toBe('dark');
    expect(archmapRoot!.style.getPropertyValue('--color-root')).not.toBe('');
    expect(archmapRoot!.style.getPropertyValue('--color-accent')).not.toBe('');

    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(document.documentElement.getAttribute('style')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--color-root')).toBe('');
    expect(document.body.getAttribute('style')).toBeNull();
    expect(document.body.className).toBe('bg-zinc-950 text-zinc-100');
    expect(document.querySelectorAll('[data-theme]')).toHaveLength(1);

    act(() => root.unmount());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(document.documentElement.getAttribute('style')).toBeNull();
  });
});
