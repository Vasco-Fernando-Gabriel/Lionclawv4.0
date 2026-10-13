import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SwarmArtifacts, normalizeFindingsFormat, parseSwarmTrailer } from '../swarm/artifacts';
import { normalizedItems, parseSwarmInput, validateSwarmSettings } from '../swarm/validation';
import { DEFAULT_SWARM_SETTINGS, type SwarmRun } from '../../../src/types/swarm';

const runId = 'swarm-20260913_120000-aabbcc';
const member = { kind: 'registered' as const, agentId: 'swarm-code-explorer' };
let root: string;
let store: SwarmArtifacts;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-artifacts-'));
  store = new SwarmArtifacts(path.join(root, 'runs'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('Swarm artifacts and admission', () => {
  it('assembles ordered multipart data, acknowledges replay and rejects conflicting chunks', () => {
    store.upload(runId, 'audit', 'attempt-1', { operation: 'begin', uploadId: 'upload' });
    const op = { operation: 'chunk' as const, uploadId: 'upload', seq: 0, content: 'Parte A\n' };
    expect(store.upload(runId, 'audit', 'attempt-1', op)).toEqual(store.upload(runId, 'audit', 'attempt-1', op));
    expect(() => store.upload(runId, 'audit', 'attempt-1', { ...op, content: 'Outro conteúdo' })).toThrow(/diferente/);
    expect(() => store.upload(runId, 'audit', 'attempt-1', { ...op, seq: 2 })).toThrow(/Sequência/);
    const ack = store.upload(runId, 'audit', 'attempt-1', { ...op, seq: 1, content: 'Parte B' });
    const finalize = { operation: 'finalize' as const, uploadId: 'upload', chunkCount: 2, sha256: ack.sha256 };
    const finalAck = store.upload(runId, 'audit', 'attempt-1', finalize);
    expect(store.upload(runId, 'audit', 'attempt-1', finalize)).toEqual(finalAck);
    expect(store.read(`${runId}/_attempts/audit/attempt-1/findings.md`)).toBe('Parte A\nParte B');
    expect(() => store.upload(runId, 'audit', 'attempt-1', { ...op, seq: 2 })).toThrow(/finalizado/);
  });
  it('recovers upload acknowledgements from disk without duplicating parts', () => {
    store.upload(runId, 'audit', 'attempt-1', { operation: 'begin', uploadId: 'x' });
    const op = { operation: 'chunk' as const, uploadId: 'x', seq: 0, content: 'x'.repeat(32 * 1024) };
    const ack = store.upload(runId, 'audit', 'attempt-1', op);
    const restarted = new SwarmArtifacts(store.root);
    expect(restarted.upload(runId, 'audit', 'attempt-1', op)).toEqual(ack);
    const next = restarted.upload(runId, 'audit', 'attempt-1', { ...op, seq: 1 });
    restarted.upload(runId, 'audit', 'attempt-1', {
      operation: 'finalize',
      uploadId: 'x',
      chunkCount: 2,
      sha256: next.sha256,
    });
    expect(restarted.read(`${runId}/_attempts/audit/attempt-1/findings.md`)).toHaveLength(64 * 1024);
  });
  it('rejects a symlink in a findings path without changing its target', () => {
    const target = path.join(root, 'outside');
    fs.writeFileSync(target, 'preservar');
    const findings = store.attemptPath(runId, 'audit', 'attempt-1');
    fs.symlinkSync(target, findings);
    expect(() => store.writeAttempt(runId, 'audit', 'attempt-1', 'violação')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('preservar');
    expect(() => store.attemptPath(runId, '../escape', 'attempt-1')).toThrow();
  });
  it('real case (Codex): trailer glued to the previous message on the same line is accepted', () => {
    const glued =
      'Analise concluida. Vou finalizar a entrega pelo MCP.---\nSTATUS: ok\nSUMMARY: 55 afirmacoes.\nFINDINGS: audit.md';
    expect(parseSwarmTrailer(glued, 'audit')).toEqual({ status: 'ok', summary: '55 afirmacoes.', question: null });
    const withEarlierRule = 'Tabela\n---\ncorpo\nFim.---\nSTATUS: ok\nSUMMARY: s\nFINDINGS: audit.md';
    expect(parseSwarmTrailer(withEarlierRule, 'audit').status).toBe('ok');
    expect(() => parseSwarmTrailer('corpo sem trailer. ---', 'audit')).toThrow(/Trailer/);
  });

  it('does not call a malformed or missing report successful', () => {
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow(/ausente/);
    store.writeAttempt(runId, 'audit', 'attempt-1', '# Incompleto');
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow(/estrutura/);
    expect(() => parseSwarmTrailer('---\nSTATUS: ok\nSUMMARY: ok\nFINDINGS: ../other.md', 'audit')).toThrow();
    expect(
      parseSwarmTrailer('body\r\n---\r\nSTATUS: failed\r\nSUMMARY: ambíguo\r\nFINDINGS: audit.md\r\n', 'audit'),
    ).toEqual({ status: 'failed', summary: 'ambíguo', question: null });
    expect(
      parseSwarmTrailer(
        '---\nSTATUS: needs-input\nQUESTION: Qual branch?\nSUMMARY: preciso do alvo\nFINDINGS: audit.md',
        'audit',
      ),
    ).toEqual({ status: 'needs-input', summary: 'preciso do alvo', question: 'Qual branch?' });
    expect(() =>
      parseSwarmTrailer('---\nSTATUS: needs-input\nSUMMARY: sem pergunta\nFINDINGS: audit.md', 'audit'),
    ).toThrow(/QUESTION/);
  });
  it('validates strict schemas, cwd, limits, templates and input paths', () => {
    const input = {
      requestId: 'req',
      cwd: root,
      objective: 'auditar',
      mode: 'fanout',
      promptTemplate: '{{item}}',
      member,
      items: [{ target: 'runs' }],
    };
    expect(parseSwarmInput(input, [root]).cwd).toBe(fs.realpathSync(root));
    expect(() => parseSwarmInput({ ...input, unknown: true }, [root])).toThrow(/inválido/);
    expect(() => parseSwarmInput({ ...input, promptTemplate: 'sem placeholder' }, [root])).toThrow();
    expect(() => parseSwarmInput({ ...input, items: [] }, [root])).toThrow();
    expect(() =>
      parseSwarmInput({ ...input, items: Array.from({ length: 101 }, () => ({ target: 'runs' })) }, [root]),
    ).toThrow();
    expect(() => parseSwarmInput({ ...input, knownContext: 'x'.repeat(64 * 1024) }, [root])).toThrow(/64 KiB/);
    expect(() => parseSwarmInput({ ...input, cwd: os.tmpdir() }, [root])).toThrow(/fora/);
    expect(() => parseSwarmInput({ ...input, items: [{ target: '../outside-does-not-exist' }] }, [root])).toThrow(
      /inexistente/,
    );
    expect(() => validateSwarmSettings({ ...DEFAULT_SWARM_SETTINGS, concurrencyCap: 0 })).toThrow();
  });
  it('rejects incomplete manifests and terminal status inconsistent with revision', () => {
    const run: SwarmRun = {
      schemaVersion: 1,
      revision: 1,
      terminalRevision: null,
      runId,
      chatSessionId: 's1',
      requestId: 'req',
      requestHash: 'a'.repeat(64),
      mode: 'comite',
      cwd: root,
      objective: 'Auditar',
      parentRunId: null,
      stage: null,
      status: 'queued',
      createdAt: '2026-09-13T12:00:00Z',
      startedAt: null,
      finishedAt: null,
      openedAt: null,
      deliveredSignatures: null,
      deliveryError: null,
      settings: { ...DEFAULT_SWARM_SETTINGS },
      items: [
        {
          slug: 'audit',
          target: 'runs',
          prompt: 'Audite',
          member,
          runtime: 'cloud',
          model: 'test',
          resolvedConfigFile: '_attempts/audit/config.json',
          status: 'pending',
          currentAttemptId: null,
          nextAttemptAt: null,
          attempts: [],
          executions: [],
          generation: 1,
          autoRetries: 0,
          question: null,
          session: null,
          sessionLostReason: null,
          repoGraph: 'off',
          targetWarning: null,
          inbox: [],
          launch: null,
          findingsFile: null,
          summary: null,
          lastSignalAt: null,
          error: null,
        },
      ],
    };
    store.create(run);
    expect(store.load(runId)).toEqual(run);
    for (const invalid of [
      { ...run, cwd: undefined },
      { ...run, settings: {} },
      { ...run, status: 'done' },
      { ...run, items: [{ ...run.items[0], attempts: [{ id: 'attempt-1' }] }] },
    ]) {
      store.atomic(`${runId}/_run.json`, JSON.stringify(invalid));
      expect(() => store.load(runId)).toThrow(/inválido/);
    }
  });
  it('requires real report bodies and detects changes after canonical publication', () => {
    store.writeAttempt(
      runId,
      'audit',
      'attempt-1',
      '# Auditoria\n## Resumo\n## Achados\n## Fora de escopo / não verificado',
    );
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow();
    const content =
      '# Auditoria\n## Resumo\nCódigo conferido.\n## Achados\nNenhum achado.\n## Fora de escopo / não verificado\nNão executei o app.';
    store.writeAttempt(runId, 'audit', 'attempt-1', content);
    const validated = store.validateFindings(runId, 'audit', 'attempt-1');
    store.publish(runId, 'audit', 'attempt-1', validated.sha256);
    expect(store.verifiedFindingsPath(runId, 'audit', validated.sha256)).toBe(path.join(store.root, runId, 'audit.md'));
    store.atomic(`${runId}/audit.md`, content + ' alterado');
    expect(() => store.verifiedFindingsPath(runId, 'audit', validated.sha256)).toThrow(/alterado/);
  });
  it('accepts field bodies written as nested lists on the following lines', () => {
    const nested =
      '# Auditoria\n## Resumo\nUm achado.\n## Achados\n### [ALTA] Credencial embutida\n- **Evidência:**\n  - `src/auth.ts:122` hash master\n  - `AGENTS.md:35` senha em claro\n- **Por que importa:** Acesso admin.\n- **Recomendação:**\n  Remover o hash do código.\n## Fora de escopo / não verificado\nHistórico git.';
    store.writeAttempt(runId, 'audit', 'attempt-1', nested);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toBe(nested);
    const emptyEvidence = nested.replace('  - `src/auth.ts:122` hash master\n  - `AGENTS.md:35` senha em claro\n', '');
    store.writeAttempt(runId, 'audit', 'attempt-1', emptyEvidence);
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow('Evidência');
  });
  it('accepts label qualifiers, colon outside bold, and INFO blocks without the three fields', () => {
    const qualified =
      '# Auditoria\n## Resumo\nOk.\n## Achados\n### [BAIXA] CORS\n- **Evidência (amostra):** server.ts:30\n- **Por que importa (e limites):** origem aberta.\n- **Recomendação**: allowlist.\n## Fora de escopo / não verificado\nNada.';
    store.writeAttempt(runId, 'audit', 'attempt-1', qualified);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toBe(qualified);
    const info =
      '# Auditoria\n## Resumo\nOk.\n## Achados\n### [INFO] Controles verificados\n- CSRF ausente por design.\n## Fora de escopo / não verificado\nNada.';
    store.writeAttempt(runId, 'audit', 'attempt-1', info);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toBe(info);
    const emptyInfo =
      '# Auditoria\n## Resumo\nOk.\n## Achados\n### [INFO] Controles verificados\n## Fora de escopo / não verificado\nNada.';
    store.writeAttempt(runId, 'audit', 'attempt-1', emptyInfo);
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow('INFO');
  });
  it('real case: field labels without accents or with different case are accepted', () => {
    const content =
      '# Auditoria\n## Resumo\nUm achado.\n## Achados\n### [MEDIA] Rotulo sem acento\n- **Evidencia:** src/a.ts:1\n- **por que importa:** Impacto.\n- **RECOMENDACAO**: Corrigir.\n## Fora de escopo / não verificado\nNada.';
    store.writeAttempt(runId, 'audit', 'attempt-1', content);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toBe(content);
    const emptyEvidence = content.replace('- **Evidencia:** src/a.ts:1', '- **Evidencia:**');
    store.writeAttempt(runId, 'audit', 'attempt-1', emptyEvidence);
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow('Evidência');
  });
  it('requires evidence, impact and recommendation for each finding', () => {
    const content =
      '# Auditoria\n## Resumo\nDois achados.\n## Achados\n### [ALTA] Falha\n- **Evidência:** src/auth.ts:12\n- **Por que importa:** Acesso indevido.\n- **Recomendação:** Validar a sessão.\n## Fora de escopo / não verificado\nRuntime não executado.';
    store.writeAttempt(runId, 'audit', 'attempt-1', content);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toBe(content);
    for (const field of ['Evidência', 'Por que importa', 'Recomendação']) {
      const invalid = content
        .split('\n')
        .filter((line) => !line.startsWith(`- **${field}:`))
        .join('\n');
      store.writeAttempt(runId, 'audit', 'attempt-1', invalid);
      expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow(field);
    }
  });
  it('normalizes collisions and unsafe slugs deterministically', () => {
    const input = parseSwarmInput(
      {
        requestId: 'req',
        cwd: root,
        objective: 'auditar',
        mode: 'comite',
        target: 'runs',
        members: ['../../', 'A', 'a', ''].map((slug) => ({ slug, objective: 'analisar', member })),
      },
      [root],
    );
    const slugs = normalizedItems(input).map((i) => i.slug);
    expect(slugs).toEqual(['item-01', 'a', 'a-2', 'item-04']);
  });
});
describe('Swarm report format tolerance', () => {
  const fields = '- **Evidência:** src/a.ts:1\n- **Por que importa:** Impacto.\n- **Recomendação:** Corrigir.\n';
  it('accepts every severity heading variant and publishes the canonical ### [NIVEL] form', () => {
    const variants: Array<[string, string]> = [
      ['### [ALTA] Credencial exposta', '### [ALTA] Credencial exposta'],
      ['### ALTA Credencial exposta', '### [ALTA] Credencial exposta'],
      ['### [alta] Credencial exposta', '### [ALTA] Credencial exposta'],
      ['### Alta: Credencial exposta', '### [ALTA] Credencial exposta'],
      ['###  média - Validação de sessão', '### [MEDIA] Validação de sessão'],
      ['### [Baixa]: Configuração ambígua', '### [BAIXA] Configuração ambígua'],
    ];
    for (const [heading, canonical] of variants) {
      const content = `# Auditoria\n## Resumo\nUm achado.\n## Achados\n${heading}\n${fields}## Fora de escopo / não verificado\nNada.\n`;
      store.writeAttempt(runId, 'audit', 'attempt-1', content);
      const validated = store.validateFindings(runId, 'audit', 'attempt-1');
      expect(validated.content).toContain(`\n${canonical}\n`);
      if (heading !== canonical) expect(validated.content).not.toContain(`\n${heading}\n`);
      store.publish(runId, 'audit', 'attempt-1', validated.sha256);
      expect(store.read(`${runId}/audit.md`)).toBe(validated.content);
      expect(store.read(`${runId}/_attempts/audit/attempt-1/findings.md`)).toBe(content);
    }
    const info = `# Auditoria\n## Resumo\nOk.\n## Achados\n### info Observação com acentuação\n- Nota.\n## Fora de escopo / não verificado\nNada.\n`;
    store.writeAttempt(runId, 'audit', 'attempt-1', info);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toContain(
      '### [INFO] Observação com acentuação',
    );
  });
  it('accepts section headings with one to three hashes, trailing colon and no accent', () => {
    const content = `# Auditoria\n# Resumo\nOk.\n### Achados:\nNenhum achado.\n## Fora de escopo / nao verificado:\nNada.\n`;
    store.writeAttempt(runId, 'audit', 'attempt-1', content);
    expect(store.validateFindings(runId, 'audit', 'attempt-1').content).toBe(
      `# Auditoria\n## Resumo\nOk.\n## Achados\nNenhum achado.\n## Fora de escopo / não verificado\nNada.\n`,
    );
    expect(normalizeFindingsFormat('## Tabela\n### [ALTA] fora dos achados\n')).toBe(
      '## Tabela\n### [ALTA] fora dos achados\n',
    );
  });
  it('real case: INFO findings written without brackets under a free table section are accepted and normalized', () => {
    const content = [
      '# Conversas paralelas: README vs código',
      '',
      '## Resumo',
      'Todas as afirmações conferem; três notas de nomenclatura.',
      '',
      '## Tabela de veredito',
      '',
      '### Seção "Novidades" — README.md:81',
      '| Afirmação | Veredito |',
      '',
      '## Achados',
      '',
      '### INFO Estados de UI do changelog são subconjunto dos estados reais',
      '- Evidência: store.ts:10',
      '',
      '### INFO "Volta para ela depois de um Clear" = rebind para a conversa nova',
      '- Evidência: page.tsx:20',
      '',
      '## Fora de escopo / não verificado',
      'Não executei o app.',
      '',
    ].join('\n');
    store.writeAttempt(runId, 'audit', 'attempt-1', content);
    const validated = store.validateFindings(runId, 'audit', 'attempt-1');
    expect(validated.content).toContain('### [INFO] Estados de UI do changelog são subconjunto dos estados reais');
    expect(validated.content).toContain('### [INFO] "Volta para ela depois de um Clear" = rebind para a conversa nova');
    expect(validated.content).toContain('### Seção "Novidades" — README.md:81');
    const still = `# Auditoria\n## Resumo\nOk.\n## Achados\nTudo certo, nada a reportar aqui.\n## Fora de escopo / não verificado\nNada.\n`;
    store.writeAttempt(runId, 'audit', 'attempt-1', still);
    expect(() => store.validateFindings(runId, 'audit', 'attempt-1')).toThrow(/Declare os achados/);
  });
  it('real case: trailer with an empty QUESTION line, surrounding spaces and blank lines is accepted', () => {
    expect(
      parseSwarmTrailer(
        'corpo final.\n\n---\nSTATUS: ok\nQUESTION:\nSUMMARY: 18 afirmacoes validadas: 16 conferem, 2 divergem\nFINDINGS: audit.md',
        'audit',
      ),
    ).toEqual({ status: 'ok', summary: '18 afirmacoes validadas: 16 conferem, 2 divergem', question: null });
    expect(
      parseSwarmTrailer('--- \n  STATUS :  ok  \n\nSUMMARY:   resumo  \n\n  FINDINGS: audit.md  \n\n', 'audit'),
    ).toEqual({ status: 'ok', summary: 'resumo', question: null });
    expect(
      parseSwarmTrailer(
        '---\nSTATUS: needs-input\nSUMMARY: falta o alvo\nQUESTION: Qual branch?\nFINDINGS: audit.md',
        'audit',
      ),
    ).toEqual({ status: 'needs-input', summary: 'falta o alvo', question: 'Qual branch?' });
    expect(() =>
      parseSwarmTrailer('---\nSTATUS: needs-input\nQUESTION:\nSUMMARY: falta o alvo\nFINDINGS: audit.md', 'audit'),
    ).toThrow(/QUESTION/);
    expect(() => parseSwarmTrailer('---\nSTATUS: ok\nSUMMARY: ok\nNOTA: x\nFINDINGS: audit.md', 'audit')).toThrow(
      /Trailer/,
    );
    expect(() =>
      parseSwarmTrailer('---\nSTATUS: ok\nSTATUS: failed\nSUMMARY: ok\nFINDINGS: audit.md', 'audit'),
    ).toThrow(/Trailer/);
    expect(() => parseSwarmTrailer('---\nSTATUS: ok\nSUMMARY:\nFINDINGS: audit.md', 'audit')).toThrow(/Trailer/);
    expect(() => parseSwarmTrailer('---\nSTATUS: ok\nSUMMARY: ok\nFINDINGS: audit.md\ntexto depois', 'audit')).toThrow(
      /Trailer/,
    );
  });
});
