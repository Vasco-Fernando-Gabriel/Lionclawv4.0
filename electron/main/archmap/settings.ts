export const ARCHMAP_ENABLED_SETTING_KEY = 'archmap_enabled';
export const ARCHMAP_MAX_PARALLEL_REPOS_SETTING_KEY = 'archmap_max_parallel_repos';
export const ARCHMAP_BATCH_PARALLELISM_SETTING_KEY = 'archmap_batch_parallelism';
export const ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY = 'archmap_jev_triage_enabled';
export const ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY = 'archmap_jev_keep_threshold';

export const ARCHMAP_DEFAULT_MAX_PARALLEL_REPOS = 2;
export const ARCHMAP_DEFAULT_BATCH_PARALLELISM = 5;
export const ARCHMAP_DEFAULT_JEV_KEEP_THRESHOLD = 0.8;
export const ARCHMAP_JEV_KEEP_THRESHOLD_MIN = 0.5;
export const ARCHMAP_JEV_KEEP_THRESHOLD_MAX = 1;

export const ARCHMAP_SETTING_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  [ARCHMAP_ENABLED_SETTING_KEY, 'true'],
  [ARCHMAP_MAX_PARALLEL_REPOS_SETTING_KEY, String(ARCHMAP_DEFAULT_MAX_PARALLEL_REPOS)],
  [ARCHMAP_BATCH_PARALLELISM_SETTING_KEY, String(ARCHMAP_DEFAULT_BATCH_PARALLELISM)],
];

export const ARCHMAP_JEV_TRIAGE_SETTING_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  [ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY, 'false'],
  [ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY, String(ARCHMAP_DEFAULT_JEV_KEEP_THRESHOLD)],
];

export function parseArchmapEnabled(raw: string | undefined | null): boolean {
  return raw !== 'false';
}

export function parseArchmapJevTriageEnabled(raw: string | undefined | null): boolean {
  return raw === 'true';
}

function clampInt(raw: string | undefined | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseArchmapMaxParallelRepos(raw: string | undefined | null): number {
  return clampInt(raw, ARCHMAP_DEFAULT_MAX_PARALLEL_REPOS, 1, 4);
}

export function parseArchmapBatchParallelism(raw: string | undefined | null): number {
  return clampInt(raw, ARCHMAP_DEFAULT_BATCH_PARALLELISM, 1, 10);
}

export function parseArchmapJevKeepThreshold(raw: string | number | undefined | null): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return ARCHMAP_DEFAULT_JEV_KEEP_THRESHOLD;
  const clamped = Math.min(ARCHMAP_JEV_KEEP_THRESHOLD_MAX, Math.max(ARCHMAP_JEV_KEEP_THRESHOLD_MIN, parsed));
  return Math.round(clamped * 100) / 100;
}

export interface ArchmapSettings {
  enabled: boolean;
  maxParallelRepos: number;
  batchParallelism: number;
  jevTriageEnabled: boolean;
  jevKeepThreshold: number;
}

export function readArchmapSettings(getSetting: (key: string) => string | undefined): ArchmapSettings {
  return {
    enabled: parseArchmapEnabled(getSetting(ARCHMAP_ENABLED_SETTING_KEY)),
    maxParallelRepos: parseArchmapMaxParallelRepos(getSetting(ARCHMAP_MAX_PARALLEL_REPOS_SETTING_KEY)),
    batchParallelism: parseArchmapBatchParallelism(getSetting(ARCHMAP_BATCH_PARALLELISM_SETTING_KEY)),
    jevTriageEnabled: parseArchmapJevTriageEnabled(getSetting(ARCHMAP_JEV_TRIAGE_ENABLED_SETTING_KEY)),
    jevKeepThreshold: parseArchmapJevKeepThreshold(getSetting(ARCHMAP_JEV_KEEP_THRESHOLD_SETTING_KEY)),
  };
}
