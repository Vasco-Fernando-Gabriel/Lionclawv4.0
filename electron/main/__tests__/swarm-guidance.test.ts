import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SWARM_COMITE_EXAMPLE,
  SWARM_FANOUT_EXAMPLE,
  SWARM_GENERIC_ROLE_IDS as GUIDANCE_GENERIC_ROLE_IDS,
  SWARM_START_DESCRIPTION,
} from '../../../mcp-servers/_shared/swarm-guidance';
import { normalizedItems, parseSwarmInput } from '../swarm/validation';
import { SWARM_GENERIC_ROLE_IDS, isSwarmGenericRole } from '../swarm/generic-roles';
import * as sharedRoles from '../../../mcp-servers/_shared/swarm-generic-roles';
import { SWARM_GENERIC_AGENT_IDS } from '../seed-agents/swarm-registry';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-guidance-'));
fs.mkdirSync(path.join(cwd, 'src', 'auth'), { recursive: true });
fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'docs', 'SPEC.md'), '# SPEC\n', 'utf8');
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('Swarm tool examples match the host contract', () => {
  it('comite example produces four generic auditors with distinct lenses on one concrete target in a single plan', () => {
    const plan = parseSwarmInput({ ...SWARM_COMITE_EXAMPLE, cwd }, [cwd]);
    const items = normalizedItems(plan);
    expect(items.map((item) => item.slug)).toEqual(['secrets', 'auth', 'owasp', 'isolation']);
    expect(items.every((item) => item.target === 'src/auth/')).toBe(true);
    expect(items.every((item) => item.member.kind === 'registered' && item.member.agentId === 'swarm-auditor')).toBe(
      true,
    );
    const lenses = items.map((item) => /^LENTE: (.+)$/m.exec(item.prompt)?.[1]);
    expect(new Set(lenses).size).toBe(4);
    expect(items.every((item) => item.prompt.includes('PERGUNTAS:\n1. '))).toBe(true);
    expect(items[0].prompt).toContain('PAPEL: swarm-auditor\nMISSAO: Auditar secrets');
  });
  it('fanout example repeats a single profile across its targets and fills {{item}} in the whole molde', () => {
    const plan = parseSwarmInput({ ...SWARM_FANOUT_EXAMPLE, cwd }, [cwd]);
    const items = normalizedItems(plan);
    expect(items).toHaveLength(2);
    expect(items[0].member).toEqual(items[1].member);
    expect(items.map((item) => item.target)).toEqual(['secao 5.1 de docs/SPEC.md', 'secao 5.2 de docs/SPEC.md']);
    expect(items.every((item) => !item.prompt.includes('{{item}}'))).toBe(true);
    expect(items[1].prompt).toContain('LENTE: fidelidade do texto de secao 5.2 de docs/SPEC.md');
    expect(items[1].prompt).toContain('1. Cada afirmacao de secao 5.2 de docs/SPEC.md tem codigo que a sustenta?');
  });
  it('S1-V8: generic role ids come from one shared module, re-exported by the host and matched by the seeds', () => {
    expect(GUIDANCE_GENERIC_ROLE_IDS).toBe(sharedRoles.SWARM_GENERIC_ROLE_IDS);
    expect(SWARM_GENERIC_ROLE_IDS).toBe(sharedRoles.SWARM_GENERIC_ROLE_IDS);
    expect(isSwarmGenericRole).toBe(sharedRoles.isSwarmGenericRole);
    expect(SWARM_GENERIC_AGENT_IDS).toEqual([...SWARM_GENERIC_ROLE_IDS]);
    for (const id of SWARM_GENERIC_ROLE_IDS) expect(SWARM_START_DESCRIPTION).toContain(id);
  });
  it('tool description teaches the briefing fields and points to the prompt section for the rest', () => {
    for (const field of ['lens', 'questions[]', 'evidenceRule', 'avoid', 'deliverableHint'])
      expect(SWARM_START_DESCRIPTION).toContain(field);
    expect(SWARM_START_DESCRIPTION).toContain('o briefing e o trabalho, o papel e o jeito');
    expect(SWARM_START_DESCRIPTION).toContain('secao "# Swarm" do prompt do sistema');
  });
});
