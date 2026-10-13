export const UNIFIED_DIFF_CONTEXT = 3;
export const UNIFIED_DIFF_MAX_EDITS = 2_000;

export type DiffOp = { kind: ' ' | '-' | '+'; line: string };

export function splitDiffLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], depth: number, offset: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', line: b[prevY]! });
      else ops.push({ kind: '-', line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export function diffLines(a: string[], b: string[], maxEdits = UNIFIED_DIFF_MAX_EDITS): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const size = 2 * max + 3;
  const v = new Int32Array(size);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function hunksOf(ops: DiffOp[], context: number): Hunk[] {
  const changeIndexes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== ' ') changeIndexes.push(index);
  });
  if (changeIndexes.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const hunks: Hunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let cursor = 0;
  for (const [start, end] of ranges) {
    while (cursor < start) {
      const op = ops[cursor]!;
      if (op.kind !== '+') oldLine += 1;
      if (op.kind !== '-') newLine += 1;
      cursor += 1;
    }
    const hunk: Hunk = { oldStart: oldLine + 1, oldCount: 0, newStart: newLine + 1, newCount: 0, lines: [] };
    while (cursor <= end) {
      const op = ops[cursor]!;
      if (op.kind !== '+') {
        oldLine += 1;
        hunk.oldCount += 1;
      }
      if (op.kind !== '-') {
        newLine += 1;
        hunk.newCount += 1;
      }
      hunk.lines.push(`${op.kind}${op.line}`);
      cursor += 1;
    }
    if (hunk.oldCount === 0) hunk.oldStart -= 1;
    if (hunk.newCount === 0) hunk.newStart -= 1;
    hunks.push(hunk);
  }
  return hunks;
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

export interface UnifiedDiffOptions {
  context?: number;
  maxEdits?: number;
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
  options: UnifiedDiffOptions = {},
): string | null {
  if (oldText === newText) return '';
  const a = splitDiffLines(oldText);
  const b = splitDiffLines(newText);
  const ops = diffLines(a, b, options.maxEdits ?? UNIFIED_DIFF_MAX_EDITS);
  if (ops === null) return null;
  const hunks = hunksOf(ops, options.context ?? UNIFIED_DIFF_CONTEXT);
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    out.push(`@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`);
    out.push(...hunk.lines);
  }
  return `${out.join('\n')}\n`;
}
