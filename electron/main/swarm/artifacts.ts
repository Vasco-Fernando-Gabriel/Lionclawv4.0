import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type {
  SwarmFindingsAck,
  SwarmFindingsOperation,
  SwarmItem,
  SwarmMessageRecord,
  SwarmRun,
} from '../../../src/types/swarm';
import { SwarmDomainError, isWithin, swarmMemberSchema, validateSwarmSettings } from './validation';

const runPattern = /^swarm-\d{8}_\d{6}-[a-f0-9]{6}$/;
const segmentPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const uploadStateSchema = z
  .object({
    uploadId: z.string().regex(segmentPattern),
    hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    finalized: z.boolean(),
  })
  .strict();
type UploadState = z.infer<typeof uploadStateSchema>;
const ACCENT_CLASSES: Record<string, string> = {
  a: '[aáàâã]',
  c: '[cç]',
  e: '[eéê]',
  i: '[ií]',
  o: '[oóôõ]',
  u: '[uú]',
};
function accentInsensitive(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split('')
    .map((char) => ACCENT_CLASSES[char.toLowerCase()] ?? char)
    .join('');
}
function findingField(finding: string, field: string): string {
  const label = new RegExp(`^- \\*\\*${accentInsensitive(field)}(?:\\s*\\([^)]*\\))?\\s*(?::\\*\\*|\\*\\*:)`, 'i');
  const lines = finding.split(/\r?\n/);
  const start = lines.findIndex((line) => label.test(line));
  if (start === -1) return '';
  const body = [lines[start].replace(label, '')];
  for (const line of lines.slice(start + 1)) {
    if (/^(- \*\*|#)/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}
function fail(message: string): never {
  throw new SwarmDomainError('artifact-error', message);
}
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const nullableDate = z.string().datetime().nullable();
const errorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().nullable();
const attemptSchema = z
  .object({
    id: z.string().regex(segmentPattern),
    n: z.number().int().positive(),
    startedAt: z.string().datetime(),
    endedAt: nullableDate,
    terminationConfirmedAt: nullableDate,
    outcome: z
      .enum([
        'ok',
        'needs-input',
        'context-overflow',
        'timeout-idle',
        'timeout-hard',
        'provider-error',
        'crash',
        'bad-trailer',
        'invalid-findings',
        'task-failed',
        'cancelled',
        'interrupted',
        'auth-required',
        'unsupported-capability',
      ])
      .nullable(),
    error: errorSchema,
    outputFile: z.string(),
    findingsFile: z.string(),
    validatedContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    metrics: z
      .object({
        costUsd: z.number().finite().nonnegative().nullable(),
        costStatus: z.enum(['known', 'unknown', 'estimated-partial']),
        tokenStatus: z.enum(['reported', 'not_reported']).optional(),
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        turns: z.number().int().nonnegative().optional(),
        durationMs: z.number().nonnegative().optional(),
        costStatusReasons: z.array(z.string()).optional(),
      })
      .strict(),
    repoGraph: z.boolean().optional(),
  })
  .strict();
const executionSchema = z
  .object({
    attemptId: z.string().regex(segmentPattern),
    kind: z.enum(['initial', 'retry', 'continuation', 'redispatch', 'repair']),
    generation: z.number().int().positive(),
    mechanism: z.enum(['resend', 'session']).nullable(),
    continuationMode: z.enum(['session', 'replay']).nullable().optional(),
    continuationReason: z.string().nullable().optional(),
    messageId: z.string().nullable(),
    reason: z.string().nullable(),
    question: z.string().nullable(),
    questionRevision: z.number().int().positive().nullable(),
  })
  .strict();
const sessionRefSchema = z
  .object({
    runtime: z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok', 'cursor', 'local', 'external']),
    id: z.string().min(1),
    attemptId: z.string().regex(segmentPattern),
    generation: z.number().int().positive(),
  })
  .strict();
const queuedMessageSchema = z
  .object({
    id: z.string().regex(segmentPattern),
    message: z.string(),
    attemptId: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
const launchSchema = z
  .object({
    kind: z.enum(['continuation', 'redispatch', 'repair']),
    messageId: z.string().nullable(),
    promptFile: z.string().nullable(),
    mode: z.enum(['session', 'replay']).nullable().optional(),
    fallbackPromptFile: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .strict()
  .nullable();
const itemSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
    target: z.string(),
    prompt: z.string(),
    member: swarmMemberSchema,
    runtime: z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok', 'cursor', 'local', 'external']),
    model: z.string().min(1),
    resolvedConfigFile: z.string(),
    status: z.enum(['pending', 'running', 'stopping', 'waiting', 'retrying', 'ok', 'failed', 'cancelled']),
    currentAttemptId: z.string().nullable(),
    nextAttemptAt: nullableDate,
    attempts: z.array(attemptSchema),
    executions: z.array(executionSchema).optional(),
    generation: z.number().int().positive().optional(),
    autoRetries: z.number().int().nonnegative().optional(),
    question: z.string().nullable().optional(),
    inbox: z.array(queuedMessageSchema).optional(),
    launch: launchSchema.optional(),
    session: sessionRefSchema.nullable().optional(),
    sessionLostReason: z.string().nullable().optional(),
    repoGraph: z.enum(['ready', 'stale', 'no-repository', 'off']).optional(),
    targetWarning: z.string().nullable().optional(),
    findingsFile: z.string().nullable(),
    summary: z.string().nullable(),
    lastSignalAt: nullableDate,
    error: errorSchema,
  })
  .strict();
const runSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    revision: z.number().int().positive(),
    terminalRevision: z.number().int().positive().nullable(),
    runId: z.string().regex(runPattern),
    chatSessionId: z.string().min(1),
    requestId: z.string().regex(segmentPattern),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['fanout', 'comite']),
    cwd: z.string().refine(path.isAbsolute),
    objective: z.string().min(1),
    parentRunId: z.string().regex(runPattern).nullable().optional(),
    stage: z.string().nullable().optional(),
    status: z.enum(['queued', 'running', 'open', 'aborting', 'done', 'partial', 'failed', 'aborted']),
    createdAt: z.string().datetime(),
    startedAt: nullableDate,
    finishedAt: nullableDate,
    openedAt: nullableDate.optional(),
    deliveredSignatures: z.record(z.string(), z.string()).nullable().optional(),
    deliveryError: z
      .object({
        kind: z.enum(['terminal', 'question']),
        revision: z.number().int().nonnegative(),
        message: z.string(),
        at: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    settings: z
      .object({
        concurrencyCap: z.number(),
        maxAttempts: z.number(),
        idleTimeoutMs: z.number(),
        hardTimeoutMs: z.number(),
        openWindowMs: z.number().optional(),
      })
      .strict(),
    items: z.array(itemSchema).min(1).max(100),
  })
  .strict();
type ParsedRun = z.infer<typeof runSchema>;
type ParsedItem = z.infer<typeof itemSchema>;
export const SWARM_MANIFEST_VERSION = 2;
const DEFAULT_OPEN_WINDOW_MS = 30 * 60_000;
export function deriveExecutions(item: Pick<ParsedItem, 'attempts'>): SwarmItem['executions'] {
  return item.attempts.map((attempt, i) => ({
    attemptId: attempt.id,
    kind: i === 0 ? 'initial' : 'retry',
    generation: 1,
    mechanism: null,
    continuationMode: null,
    continuationReason: null,
    messageId: null,
    reason: null,
    question: null,
    questionRevision: null,
  }));
}
type ParsedExecution = NonNullable<ParsedItem['executions']>[number];
function normalizeExecution(execution: ParsedExecution): SwarmItem['executions'][number] {
  const continuationMode =
    execution.continuationMode ??
    (execution.mechanism === 'resend' ? 'replay' : execution.mechanism === 'session' ? 'session' : null);
  return { ...execution, continuationMode, continuationReason: execution.continuationReason ?? null };
}
function normalizeItem(item: ParsedItem): SwarmItem {
  const executions = item.executions ? item.executions.map(normalizeExecution) : deriveExecutions(item);
  const generation = item.generation ?? Math.max(1, ...executions.map((e) => e.generation));
  const launch: SwarmItem['launch'] = item.launch
    ? {
        ...item.launch,
        mode: item.launch.mode ?? (item.launch.kind === 'continuation' ? 'replay' : null),
        fallbackPromptFile: item.launch.fallbackPromptFile ?? null,
        reason: item.launch.reason ?? null,
      }
    : null;
  return {
    ...item,
    executions,
    generation,
    autoRetries:
      item.autoRetries ??
      executions.filter((e) => (e.kind === 'retry' || e.kind === 'repair') && e.generation === generation).length,
    question: item.question ?? null,
    inbox: item.inbox ?? [],
    launch,
    session: item.session ?? null,
    sessionLostReason: item.sessionLostReason ?? null,
    repoGraph: item.repoGraph ?? 'off',
    targetWarning: item.targetWarning ?? null,
  };
}
export function normalizeRun(run: ParsedRun): SwarmRun {
  const { openWindowMs, ...settings } = run.settings;
  return {
    ...run,
    parentRunId: run.parentRunId ?? null,
    stage: run.stage ?? null,
    openedAt: run.openedAt ?? null,
    deliveredSignatures: run.deliveredSignatures ?? null,
    deliveryError: run.deliveryError ?? null,
    settings: { ...settings, openWindowMs: openWindowMs ?? DEFAULT_OPEN_WINDOW_MS },
    items: run.items.map(normalizeItem),
  };
}
const TERMINAL_RUN = ['done', 'partial', 'failed', 'aborted'];
const TERMINAL_ITEM = ['ok', 'failed', 'cancelled'];
function validRun(value: unknown, runId: string): SwarmRun | null {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success || parsed.data.runId !== runId) return null;
  const r = normalizeRun(parsed.data);
  try {
    validateSwarmSettings(r.settings);
  } catch {
    return null;
  }
  if (new Set(r.items.map((i) => i.slug)).size !== r.items.length) return null;
  const terminal = TERMINAL_RUN.includes(r.status);
  if ((r.terminalRevision ?? 0) > r.revision) return null;
  if (terminal && (r.terminalRevision === null || r.finishedAt === null)) return null;
  if (r.status === 'open' && (r.terminalRevision === null || r.openedAt === null)) return null;
  if (!terminal && r.finishedAt !== null) return null;
  if (!terminal && r.status !== 'open' && r.openedAt !== null) return null;
  if (r.status === 'queued' && r.terminalRevision !== null) return null;
  const consistent = r.items.every((item) => {
    if (item.resolvedConfigFile !== `_attempts/${item.slug}/config.json`) return false;
    if ((terminal || r.status === 'open') && !TERMINAL_ITEM.includes(item.status)) return false;
    if (item.status === 'retrying' && !item.nextAttemptAt) return false;
    if (
      ['running', 'stopping', 'waiting'].includes(item.status) &&
      (!item.attempts.length || item.currentAttemptId !== item.attempts.at(-1)?.id)
    )
      return false;
    if (item.status === 'waiting' && (item.question === null || item.attempts.at(-1)?.outcome !== 'needs-input'))
      return false;
    if (item.findingsFile !== null && item.findingsFile !== `${item.slug}.md`) return false;
    if (item.status === 'ok' && !item.findingsFile) return false;
    if (item.executions.length !== item.attempts.length) return false;
    if (item.executions.some((e, i) => e.attemptId !== item.attempts[i].id)) return false;
    return item.attempts.every(
      (a, i) =>
        a.n === i + 1 &&
        a.outputFile === `_attempts/${item.slug}/${a.id}/output.txt` &&
        a.findingsFile === `_attempts/${item.slug}/${a.id}/findings.md` &&
        (a.outcome === null || (a.endedAt !== null && a.terminationConfirmedAt !== null)),
    );
  });
  return consistent ? r : null;
}

const SEVERITIES: Record<string, string> = {
  ALTA: 'ALTA',
  MEDIA: 'MEDIA',
  MÉDIA: 'MEDIA',
  BAIXA: 'BAIXA',
  INFO: 'INFO',
};
const FINDING_HEADING = /^###\s*\[?\s*(alta|m[eé]dia|baixa|info)\s*\]?\s*:?\s*(?:[-–—]\s*)?(\S.*?)\s*$/i;
const SECTION_HEADINGS: ReadonlyArray<{ canonical: string; pattern: RegExp }> = [
  { canonical: '## Resumo', pattern: /^#{1,3}\s*Resumo\s*:?\s*$/i },
  { canonical: '## Achados', pattern: /^#{1,3}\s*Achados\s*:?\s*$/i },
  {
    canonical: '## Fora de escopo / não verificado',
    pattern: /^#{1,3}\s*Fora de escopo\s*\/\s*n[aã]o verificado\s*:?\s*$/i,
  },
];
export function normalizeFindingsFormat(content: string): string {
  const lines = content.split(/\r?\n/);
  let inFindings = false;
  return lines
    .map((line) => {
      const section = SECTION_HEADINGS.find(({ pattern }) => pattern.test(line));
      if (section) {
        inFindings = section.canonical === '## Achados';
        return section.canonical;
      }
      if (/^##\s/.test(line)) inFindings = false;
      if (!inFindings) return line;
      const finding = FINDING_HEADING.exec(line);
      if (!finding) return line;
      return `### [${SEVERITIES[finding[1].toUpperCase()]}] ${finding[2]}`;
    })
    .join('\n');
}
export const OUT_OF_SCOPE_HEADING = /^## Fora de escopo \/ não verificado\s*$/m;
const REQUIRED_SECTIONS: ReadonlyArray<{ heading: string; pattern: RegExp }> = [
  { heading: 'Resumo', pattern: /^## Resumo\s*$/m },
  { heading: 'Achados', pattern: /^## Achados\s*$/m },
  { heading: 'Fora de escopo / não verificado', pattern: OUT_OF_SCOPE_HEADING },
];
export class SwarmArtifacts {
  readonly root: string;
  constructor(root: string) {
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) fail('Diretório Swarm não pode ser symlink.');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
  }
  private directory(relative: string, create = false): string {
    const parts = relative.split('/').filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') fail('Path de artifact inválido.');
      current = path.join(current, part);
      if (!fs.existsSync(current)) {
        if (!create) fail('Diretório de artifact ausente.');
        fs.mkdirSync(current, { mode: 0o700 });
        syncDirectory(path.dirname(current));
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(this.root, fs.realpathSync(current)))
        fail('Diretório de artifact inválido ou symlink.');
    }
    return current;
  }
  private file(relative: string, createParent = false): string {
    if (relative.includes('\\') || path.isAbsolute(relative)) fail('Path relativo inválido.');
    const parts = relative.split('/');
    const base = parts.pop();
    if (!base || !/^[a-zA-Z0-9_.-]+$/.test(base) || base === '.' || base === '..') fail('Nome de artifact inválido.');
    const parent = this.directory(parts.join('/'), createParent);
    const target = path.join(parent, base);
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) fail('Artifact precisa ser arquivo regular.');
    try {
      if (fs.lstatSync(target).isSymbolicLink()) fail('Artifact não pode ser symlink.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return target;
  }
  private assertRun(runId: string): void {
    if (!runPattern.test(runId)) fail('runId inválido.');
  }
  private assertAttempt(slug: string, attemptId: string): void {
    if (!/^[a-z0-9-]{1,80}$/.test(slug) || !segmentPattern.test(attemptId)) fail('Identidade de tentativa inválida.');
  }
  atomic(relative: string, content: string | Buffer): void {
    const target = this.file(relative, true);
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, target);
      syncDirectory(path.dirname(target));
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  read(relative: string): string {
    const file = this.file(relative);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) fail('Artifact precisa ser arquivo regular.');
      return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  }
  create(run: SwarmRun): void {
    this.assertRun(run.runId);
    const dir = path.join(this.root, run.runId);
    fs.mkdirSync(dir, { mode: 0o700 });
    this.save(run);
  }
  save(run: SwarmRun): void {
    this.assertRun(run.runId);
    this.atomic(`${run.runId}/_run.json`, JSON.stringify(run, null, 2));
  }
  load(runId: string): SwarmRun {
    this.assertRun(runId);
    let value: unknown;
    try {
      value = JSON.parse(this.read(`${runId}/_run.json`));
    } catch (error) {
      throw new SwarmDomainError(
        'manifest-unavailable',
        `Manifest indisponível: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const run = validRun(value, runId);
    if (!run) throw new SwarmDomainError('invalid-manifest', `Manifest inválido/incompatível: ${runId}`);
    return run;
  }
  exists(relative: string): boolean {
    try {
      return fs.existsSync(this.file(relative));
    } catch {
      return false;
    }
  }
  readOptional(relative: string): string | null {
    try {
      return this.exists(relative) ? this.read(relative) : null;
    } catch {
      return null;
    }
  }
  appendMessage(runId: string, slug: string, record: SwarmMessageRecord): void {
    this.assertRun(runId);
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) fail('Slug inválido.');
    const file = this.file(`${runId}/_attempts/${slug}/messages.jsonl`, true);
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  readMessages(runId: string, slug: string): SwarmMessageRecord[] {
    this.assertRun(runId);
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) fail('Slug inválido.');
    const content = this.readOptional(`${runId}/_attempts/${slug}/messages.jsonl`);
    if (!content) return [];
    const records: SwarmMessageRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as SwarmMessageRecord);
      } catch {
        continue;
      }
    }
    return records;
  }
  list(): string[] {
    return fs
      .readdirSync(this.root)
      .filter((id) => runPattern.test(id))
      .sort();
  }
  attemptPath(runId: string, slug: string, attemptId: string): string {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    return path.join(this.directory(`${runId}/_attempts/${slug}/${attemptId}`, true), 'findings.md');
  }
  appendOutput(runId: string, slug: string, attemptId: string, content: string): void {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    const file = this.file(`${runId}/_attempts/${slug}/${attemptId}/output.txt`, true);
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  writeAttempt(runId: string, slug: string, attemptId: string, content: string): void {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    this.atomic(`${runId}/_attempts/${slug}/${attemptId}/findings.md`, content);
  }
  validateFindings(runId: string, slug: string, attemptId: string): { content: string; sha256: string } {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    let content: string;
    try {
      content = normalizeFindingsFormat(this.read(`${runId}/_attempts/${slug}/${attemptId}/findings.md`));
    } catch {
      throw new SwarmDomainError('invalid-findings', 'Findings ausente, ilegível ou path inválido.');
    }
    if (!content.trim() || !/^#\s+\S/m.test(content) || REQUIRED_SECTIONS.some(({ pattern }) => !pattern.test(content)))
      throw new SwarmDomainError('invalid-findings', 'Findings não segue a estrutura obrigatória.');
    for (const { heading, pattern } of REQUIRED_SECTIONS) {
      const match = pattern.exec(content);
      const body = match
        ? content
            .slice(match.index + match[0].length)
            .split(/\n## /)[0]
            ?.trim()
        : '';
      if (!body) throw new SwarmDomainError('invalid-findings', `Seção ${heading} sem conteúdo.`);
      if (
        heading === 'Achados' &&
        !/^###\s+\[(ALTA|MEDIA|BAIXA|INFO)\]/m.test(body) &&
        !/nenhum(?:a)?\s+(?:achado|problema|falha|divergência)|não\s+(?:foram?\s+)?(?:encontrad[oa]s?|identificad[oa]s?)\s+achados|sem\s+achados/i.test(
          body,
        )
      )
        throw new SwarmDomainError('invalid-findings', 'Declare os achados ou sua ausência explicitamente.');
    }
    const findingsBody = content.split('## Achados')[1]?.split(/\n## /)[0] ?? '';
    const findings = findingsBody.split(/\n(?=### )/).filter((block) => /^### /m.test(block));
    for (const finding of findings) {
      const severity = /^###\s+\[(ALTA|MEDIA|BAIXA|INFO)\]\s+\S/m.exec(finding)?.[1];
      if (!severity) throw new SwarmDomainError('invalid-findings', 'Achado sem severidade ou título válido.');
      if (severity === 'INFO') {
        if (!finding.split(/\r?\n/).slice(1).join('\n').trim())
          throw new SwarmDomainError('invalid-findings', 'Achado INFO sem conteúdo.');
        continue;
      }
      for (const field of ['Evidência', 'Por que importa', 'Recomendação']) {
        if (!findingField(finding, field).trim())
          throw new SwarmDomainError('invalid-findings', `Achado sem ${field} preenchida.`);
      }
    }
    return { content, sha256: hash(content) };
  }
  publish(runId: string, slug: string, attemptId: string, expectedHash: string): void {
    const { content, sha256 } = this.validateFindings(runId, slug, attemptId);
    if (sha256 !== expectedHash) throw new SwarmDomainError('invalid-findings', 'Findings mudou após validação.');
    this.atomic(`${runId}/${slug}.md`, content);
  }
  verifiedFindingsPath(runId: string, slug: string, expectedHash: string): string {
    this.assertRun(runId);
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) fail('Slug inválido.');
    const relative = `${runId}/${slug}.md`;
    if (hash(this.read(relative)) !== expectedHash)
      throw new SwarmDomainError('findings-changed', 'Relatório foi alterado depois da publicação.');
    return this.file(relative);
  }
  upload(runId: string, slug: string, attemptId: string, op: SwarmFindingsOperation): SwarmFindingsAck {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    if (!op || !segmentPattern.test(op.uploadId)) fail('uploadId inválido.');
    const prefix = `${runId}/_attempts/${slug}/${attemptId}`;
    const manifestPath = `${prefix}/upload.json`;
    let state: UploadState | null = null;
    try {
      state = uploadStateSchema.parse(JSON.parse(this.read(manifestPath)));
    } catch (error) {
      if (fs.existsSync(path.join(this.root, manifestPath))) throw error;
    }
    if (state && state.uploadId !== op.uploadId)
      throw new SwarmDomainError('upload-conflict', 'Tentativa já possui outro upload.');
    if (op.operation === 'begin') {
      if (!state) {
        state = { uploadId: op.uploadId, hashes: [], sha256: hash(''), finalized: false };
        this.atomic(manifestPath, JSON.stringify(state));
      }
    } else {
      if (!state) throw new SwarmDomainError('upload-not-started', 'Envie begin antes de gravar.');
      if (op.operation === 'chunk') {
        if (
          !Number.isSafeInteger(op.seq) ||
          op.seq < 0 ||
          typeof op.content !== 'string' ||
          Buffer.byteLength(op.content) > 32 * 1024
        )
          fail('Parte inválida; limite por chamada 32 KiB.');
        const digest = hash(op.content);
        if (op.seq < state.hashes.length) {
          if (state.hashes[op.seq] !== digest)
            throw new SwarmDomainError('upload-conflict', 'Conteúdo diferente para sequência já recebida.');
        } else {
          if (state.finalized || op.seq !== state.hashes.length)
            throw new SwarmDomainError('upload-conflict', 'Sequência inválida ou upload finalizado.');
          this.atomic(`${prefix}/chunk-${op.seq}.txt`, op.content);
          state.hashes.push(digest);
          const aggregate = createHash('sha256');
          for (let i = 0; i < state.hashes.length; i++) aggregate.update(this.read(`${prefix}/chunk-${i}.txt`));
          state.sha256 = aggregate.digest('hex');
          this.atomic(manifestPath, JSON.stringify(state));
        }
      } else if (op.operation === 'finalize') {
        if (op.chunkCount !== state.hashes.length || op.sha256 !== state.sha256)
          throw new SwarmDomainError('upload-conflict', 'Contagem/hash de finalize diverge do conteúdo persistido.');
        if (!state.finalized) {
          const parts = state.hashes.map((digest, i) => {
            const content = this.read(`${prefix}/chunk-${i}.txt`);
            if (hash(content) !== digest) fail('Parte de upload alterada no disco.');
            return content;
          });
          this.writeAttempt(runId, slug, attemptId, parts.join(''));
          state.finalized = true;
          this.atomic(manifestPath, JSON.stringify(state));
        }
      } else fail('Operação de upload inválida.');
    }
    return {
      uploadId: state.uploadId,
      nextSeq: state.hashes.length,
      sha256: state.sha256,
      ...(state.finalized ? { findingsFile: `${slug}.md` } : {}),
    };
  }
}

export interface SwarmTrailer {
  status: 'ok' | 'failed' | 'needs-input';
  summary: string;
  question: string | null;
}
const TRAILER_KEYS = new Set(['STATUS', 'QUESTION', 'SUMMARY', 'FINDINGS']);
export function parseSwarmTrailer(output: string, slug: string): SwarmTrailer {
  const lines = output.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const trimmed = lines.map((line) => line.trim());
  let separator = -1;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    if (trimmed[i] === '---' || (trimmed[i].endsWith('---') && !trimmed[i].startsWith('-'))) {
      separator = i;
      break;
    }
  }
  const invalid = () => new SwarmDomainError('bad-trailer', 'Trailer STATUS/SUMMARY/FINDINGS ausente ou inválido.');
  if (separator === -1) throw invalid();
  const fields: Array<[string, string]> = [];
  for (const raw of lines.slice(separator + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([A-Z]+)\s*:\s*(.*)$/.exec(line);
    if (!match || !TRAILER_KEYS.has(match[1])) throw invalid();
    fields.push([match[1], match[2].trim()]);
  }
  const keys = fields.map(([key]) => key);
  const count = (key: string) => keys.filter((k) => k === key).length;
  if (
    keys[0] !== 'STATUS' ||
    keys.at(-1) !== 'FINDINGS' ||
    count('STATUS') !== 1 ||
    count('FINDINGS') !== 1 ||
    count('SUMMARY') !== 1 ||
    count('QUESTION') > 1
  )
    throw invalid();
  const value = (key: string) => fields.find(([k]) => k === key)?.[1] ?? '';
  const status = value('STATUS');
  if (
    (status !== 'ok' && status !== 'failed' && status !== 'needs-input') ||
    value('FINDINGS') !== `${slug}.md` ||
    !value('SUMMARY')
  )
    throw invalid();
  const question = value('QUESTION') || null;
  if (status === 'needs-input' && !question)
    throw new SwarmDomainError('bad-trailer', 'STATUS: needs-input exige a linha QUESTION: no trailer.');
  return { status, summary: value('SUMMARY'), question: status === 'needs-input' ? question : null };
}
