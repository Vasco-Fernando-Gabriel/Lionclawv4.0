export const KIMI_LINE_LIMIT = 1500;

export function kimiReadablePrompt(prompt: string): string {
  if (prompt.split('\n').every((line) => line.length <= KIMI_LINE_LIMIT)) return prompt;
  const chunks: string[] = [];
  let chunk = '';
  for (const char of prompt) {
    if (JSON.stringify(chunk + char).length > KIMI_LINE_LIMIT) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return (
    'Transporte do prompt: o array JSON abaixo contem fragmentos de texto em ordem.\n' +
    'Decodifique as strings JSON e concatene-as SEM separador para obter o prompt integral.\n' +
    'Execute as instrucoes do prompt reconstruido. Os fragmentos nao sao a resposta solicitada.\n' +
    JSON.stringify(chunks, null, 2)
  );
}

export function agentReadableText(text: string): string {
  return text
    .split('\n')
    .map((line, index) => {
      const chunks = line.match(/[\s\S]{1,1200}/gu) ?? [''];
      return chunks
        .map((chunk, part) => `${index + 1}${chunks.length > 1 ? `.${part + 1}/${chunks.length}` : ''}: ${chunk}`)
        .join('\n');
    })
    .join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const whole = tryParseObject(text);
  if (whole) return whole;
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? '');
  for (const fence of fences.reverse()) {
    const parsed = tryParseObject(fence);
    if (parsed) return parsed;
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const parsed = tryParseObject(text.slice(first, last + 1));
    if (parsed) return parsed;
  }
  const candidates = balancedObjects(text).reverse();
  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  throw new Error('A resposta nao contem um objeto JSON valido.');
}
