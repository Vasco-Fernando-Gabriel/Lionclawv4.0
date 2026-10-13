import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JevChoiceAnswer } from '../../../../mcp-servers/_shared/jev-transport';

export interface JevSampleState {
  path: string;
  old_summary: string;
  old_tags: string[];
  old_complexity: string;
  diff: string;
}

export interface JevSampleEntry {
  id: string;
  path: string;
  state: JevSampleState;
  diff_chars: number;
  model: string;
  answers: { verdict: JevChoiceAnswer; summary_still_valid: { noul: number }; complexity_changed: { noul: number } };
  usage: { input_tokens: number; output_tokens: number };
}

export const JEV_SAMPLE_PATH = join(__dirname, 'fixtures', 'jev-changes.sample.json');

export function loadJevSample(): JevSampleEntry[] {
  return (JSON.parse(readFileSync(JEV_SAMPLE_PATH, 'utf8')) as { results: JevSampleEntry[] }).results;
}
