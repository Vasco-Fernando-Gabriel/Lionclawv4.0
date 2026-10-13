import { describe, expect, it } from "vitest";
import type {
  DashboardFreshnessReport,
  GraphFreshnessResult,
} from "../../freshness";
import { buildFreshnessBanner } from "../StalenessBanner";
import { getLocale, resolveLocaleKey } from "../../locales";

const fresh: GraphFreshnessResult = {
  status: "fresh",
  graphCommitHash: "a".repeat(40),
  headCommitHash: "a".repeat(40),
  changedFileCount: 0,
  changedFiles: [],
  commitsBehind: 0,
  commitsAhead: 0,
};

function report(
  knowledge: GraphFreshnessResult,
  domain?: GraphFreshnessResult,
): DashboardFreshnessReport {
  return { graphs: domain ? { knowledge, domain } : { knowledge } };
}

describe("buildFreshnessBanner", () => {
  it("uses the pt-BR locale sent by LionClaw for controls and freshness messages", () => {
    for (const language of ['pt-BR', 'pt_BR', 'pt', 'Portugues']) {
      expect(resolveLocaleKey(language)).toBe('pt-BR');
    }
    const locale = getLocale(resolveLocaleKey('pt-BR'));
    expect(locale.learnPanel.projectTour).toBe('Tour do projeto');
    expect(locale.search.placeholder).toBe('Buscar por nome, resumo ou marcadores...');
    const banner = buildFreshnessBanner(report({ status: 'unknown', reason: 'freshness-request-failed' }), 'pt-BR');
    expect(banner?.title).toBe('Nao foi possivel verificar a atualizacao do mapa');
    expect(banner?.summary).toContain('O mapa salvo continua disponivel');
    expect(banner?.action).toBe('Volte a esta janela para tentar a verificacao novamente.');
  });

  it("reports real changes in Portuguese even when only the first 200 paths are listed", () => {
    const banner = buildFreshnessBanner(report({ ...fresh, status: 'dirty', changedFileCount: 327,
      changedFiles: Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`),
    }), 'pt-BR');
    expect(banner?.title).toBe('Mapa de arquitetura com alteracoes locais');
    expect(banner?.summary).toContain('327 arquivos tem alteracoes locais');
    expect(banner?.changedFiles).toHaveLength(200);
  });

  it("returns no banner for fresh or missing freshness data", () => {
    expect(buildFreshnessBanner(null)).toBeNull();
    expect(buildFreshnessBanner(report(fresh))).toBeNull();
  });

  it("uses singular grammar for a graph one project commit behind", () => {
    const banner = buildFreshnessBanner(
      report({
        status: "stale",
        relation: "behind",
        graphCommitHash: "a".repeat(40),
        headCommitHash: "b".repeat(40),
        changedFileCount: 1,
        changedFiles: ["src/auth.ts"],
        commitsBehind: 1,
        commitsAhead: 0,
      }),
    );

    expect(banner).toEqual({
      title: "Knowledge graph may be stale",
      summary:
        "The knowledge graph is 1 project commit behind HEAD; 1 file has changed since analysis.",
      action:
        "Use \"Atualizar mapa\" in the LionClaw Repositories page to refresh it before relying on impact or onboarding answers.",
      changedFiles: ["src/auth.ts"],
    });
  });

  it("explains an ahead domain graph with the correct refresh command", () => {
    const banner = buildFreshnessBanner(
      report(fresh, {
        status: "stale",
        relation: "ahead",
        graphCommitHash: "b".repeat(40),
        headCommitHash: "a".repeat(40),
        changedFileCount: 2,
        changedFiles: ["domain/a.ts", "domain/b.ts"],
        commitsBehind: 0,
        commitsAhead: 1,
      }),
    );

    expect(banner).toMatchObject({
      title: "Domain graph may be stale",
      summary:
        "The domain graph comes from a newer project history than HEAD; 2 files have changed since analysis.",
      action:
        "Use \"Atualizar mapa\" in the LionClaw Repositories page to refresh it before relying on impact or onboarding answers.",
    });
  });

  it("explains divergent histories", () => {
    const banner = buildFreshnessBanner(
      report({
        status: "stale",
        relation: "diverged",
        graphCommitHash: "a".repeat(40),
        headCommitHash: "b".repeat(40),
        changedFileCount: 2,
        changedFiles: ["src/a.ts", "src/b.ts"],
        commitsBehind: 1,
        commitsAhead: 1,
      }),
    );

    expect(banner?.summary).toBe(
      "The knowledge graph and HEAD come from different project histories; 2 files have changed since analysis.",
    );
  });

  it("prioritizes stale over dirty and unknown graph results", () => {
    const banner = buildFreshnessBanner(
      report(
        {
          status: "dirty",
          graphCommitHash: "a".repeat(40),
          headCommitHash: "a".repeat(40),
          changedFileCount: 1,
          changedFiles: ["src/dirty.ts"],
          commitsBehind: 0,
          commitsAhead: 0,
        },
        {
          status: "stale",
          relation: "behind",
          graphCommitHash: "a".repeat(40),
          headCommitHash: "b".repeat(40),
          changedFileCount: 1,
          changedFiles: ["domain/stale.ts"],
          commitsBehind: 1,
          commitsAhead: 0,
        },
      ),
    );

    expect(banner?.title).toBe("Domain graph may be stale");
    expect(banner?.changedFiles).toEqual(["domain/stale.ts"]);
  });

  it("names both graphs when they share the highest dirty risk", () => {
    const dirtyKnowledge: GraphFreshnessResult = {
      status: "dirty",
      graphCommitHash: "a".repeat(40),
      headCommitHash: "a".repeat(40),
      changedFileCount: 1,
      changedFiles: ["src/shared.ts"],
      commitsBehind: 0,
      commitsAhead: 0,
    };
    const banner = buildFreshnessBanner(
      report(dirtyKnowledge, {
        ...dirtyKnowledge,
        changedFileCount: 2,
        changedFiles: ["src/shared.ts", "domain/model.ts"],
      }),
    );

    expect(banner?.title).toBe(
      "Knowledge and domain graphs have working-tree changes",
    );
    expect(banner?.changedFiles).toEqual([
      "domain/model.ts",
      "src/shared.ts",
    ]);
  });

  it("makes endpoint failures visible instead of treating them as fresh", () => {
    const banner = buildFreshnessBanner({
      graphs: {
        knowledge: {
          status: "unknown",
          reason: "freshness-request-failed",
        },
      },
    });

    expect(banner).toMatchObject({
      title: "Knowledge graph freshness could not be verified",
      summary: "The dashboard could not refresh graph freshness data.",
      changedFiles: [],
    });
  });
});
