import { useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import type {
  DashboardFreshnessReport,
  GraphFreshnessResult,
  GraphFreshnessUnknownReason,
} from "../freshness";

interface StalenessBannerProps {
  freshness: DashboardFreshnessReport | null;
}

interface FreshnessBannerContent {
  title: string;
  summary: string;
  action: string;
  changedFiles: string[];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

type GraphName = "knowledge" | "domain";
type GraphEntry = { name: GraphName; result: GraphFreshnessResult };

const RISK_RANK: Record<GraphFreshnessResult["status"], number> = {
  fresh: 0,
  unknown: 1,
  dirty: 2,
  stale: 3,
};

const unknownSummary: Record<GraphFreshnessUnknownReason, string> = {
  "graph-missing": "has not been generated yet",
  "meta-missing": "does not include analysis metadata",
  "missing-graph-commit": "does not include a Git commit hash to compare with HEAD",
  "git-head-unavailable": "could not be compared because the dashboard could not read Git HEAD",
  "graph-commit-unavailable": "references a commit that is not available in this checkout",
  "git-command-timeout": "could not be checked because Git freshness commands timed out",
  "freshness-request-failed": "could not be refreshed because the freshness request failed",
};

function graphLabel(name: GraphName, pt = false): string {
  if (pt) return name === "knowledge" ? "mapa de arquitetura" : "mapa de dominio";
  return `${name} graph`;
}

function titleSubject(entries: GraphEntry[], pt = false): string {
  if (pt) return entries.length === 2 ? "Mapas de arquitetura e dominio" : entries[0].name === "knowledge" ? "Mapa de arquitetura" : "Mapa de dominio";
  if (entries.length === 2) return "Knowledge and domain graphs";
  return entries[0].name === "knowledge" ? "Knowledge graph" : "Domain graph";
}

function changedFilesSentence(count: number, pt = false): string {
  if (pt) return `${plural(count, "arquivo")} ${count === 1 ? "mudou" : "mudaram"} desde a analise.`;
  return `${plural(count, "file")} ${count === 1 ? "has" : "have"} changed since analysis.`;
}

function staleSummary(entry: GraphEntry, pt = false): string {
  if (entry.result.status !== "stale") return "";
  if (pt) {
    const subject = `O ${graphLabel(entry.name, true)}`;
    const files = changedFilesSentence(entry.result.changedFileCount, true);
    if (entry.result.relation === "behind") return `${subject} esta ${plural(entry.result.commitsBehind, "commit")} atras da versao atual; ${files}`;
    if (entry.result.relation === "ahead") return `${subject} foi gerado em uma versao posterior a atual; ${files}`;
    return `${subject} e o projeto atual tem historicos diferentes; ${files}`;
  }
  const subject = `The ${graphLabel(entry.name)}`;
  const fileSummary = changedFilesSentence(entry.result.changedFileCount);

  if (entry.result.relation === "behind") {
    return `${subject} is ${plural(
      entry.result.commitsBehind,
      "project commit",
    )} behind HEAD; ${fileSummary}`;
  }
  if (entry.result.relation === "ahead") {
    return `${subject} comes from a newer project history than HEAD; ${fileSummary}`;
  }
  return `${subject} and HEAD come from different project histories; ${fileSummary}`;
}

function dirtySummary(entry: GraphEntry, pt = false): string {
  if (entry.result.status !== "dirty") return "";
  const fileCount = entry.result.changedFileCount;
  if (pt) return `${plural(fileCount, "arquivo")} ${fileCount === 1 ? "tem alteracoes locais nao representadas" : "tem alteracoes locais nao representadas"} pelo commit do ${graphLabel(entry.name, true)}.`;
  return `${plural(fileCount, "working-tree file")} ${
    fileCount === 1 ? "has" : "have"
  } changed and ${fileCount === 1 ? "is" : "are"} not represented by the ${graphLabel(
    entry.name,
  )}'s commit metadata.`;
}

function unknownEntrySummary(entry: GraphEntry, pt = false): string {
  if (entry.result.status !== "unknown") return "";
  if (pt) {
    const reasons: Record<GraphFreshnessUnknownReason, string> = {
      "graph-missing": "O mapa ainda nao foi gerado.",
      "meta-missing": "Os dados da analise do mapa estao ausentes.",
      "missing-graph-commit": "O mapa nao registra o commit usado na analise.",
      "git-head-unavailable": "Nao foi possivel consultar a versao atual do projeto no Git.",
      "graph-commit-unavailable": "O commit usado na analise nao esta disponivel neste projeto.",
      "git-command-timeout": "A consulta ao Git excedeu o tempo limite.",
      "freshness-request-failed": "Nao foi possivel consultar se o mapa esta atualizado. O mapa salvo continua disponivel.",
    };
    return reasons[entry.result.reason];
  }
  if (entry.result.reason === "freshness-request-failed") {
    return "The dashboard could not refresh graph freshness data.";
  }
  return `The ${graphLabel(entry.name)} ${unknownSummary[entry.result.reason]}.`;
}

function refreshAction(entries: GraphEntry[], pt = false): string {
  if (pt) return 'Use "Atualizar mapa" na tela Repositorios do LionClaw para incorporar as alteracoes do projeto.';
  return `Use "Atualizar mapa" in the LionClaw Repositories page to refresh ${entries.length === 1 ? "it" : "them"} before relying on impact or onboarding answers.`;
}

export function buildFreshnessBanner(
  freshness: DashboardFreshnessReport | null,
  language = "en",
): FreshnessBannerContent | null {
  if (!freshness) return null;
  const pt = language === "pt-BR";
  const entries: GraphEntry[] = [
    { name: "knowledge", result: freshness.graphs.knowledge },
  ];
  if (freshness.graphs.domain) {
    entries.push({ name: "domain", result: freshness.graphs.domain });
  }

  const highestRisk = Math.max(
    ...entries.map((entry) => RISK_RANK[entry.result.status]),
  );
  if (highestRisk === RISK_RANK.fresh) return null;

  const affected = entries.filter(
    (entry) => RISK_RANK[entry.result.status] === highestRisk,
  );
  const status = affected[0].result.status;
  const changedFiles = [
    ...new Set(
      affected.flatMap((entry) =>
        "changedFiles" in entry.result ? entry.result.changedFiles : [],
      ),
    ),
  ].sort();

  if (status === "stale") {
    return {
      title: pt ? `${titleSubject(affected, true)} ${affected.length === 1 ? "pode estar desatualizado" : "podem estar desatualizados"}` : `${titleSubject(affected)} may be stale`,
      summary: affected.map(entry => staleSummary(entry, pt)).join(" "),
      action: refreshAction(affected, pt),
      changedFiles,
    };
  }

  if (status === "dirty") {
    return {
      title: pt ? `${titleSubject(affected, true)} com alteracoes locais` : `${titleSubject(affected)} ${
        affected.length === 1 ? "has" : "have"
      } working-tree changes`,
      summary: affected.map(entry => dirtySummary(entry, pt)).join(" "),
      action: refreshAction(affected, pt),
      changedFiles,
    };
  }

  const requestFailed = affected.some(
    (entry) =>
      entry.result.status === "unknown" &&
      entry.result.reason === "freshness-request-failed",
  );

  return {
    title: pt ? "Nao foi possivel verificar a atualizacao do mapa" : `${titleSubject(affected)} freshness could not be verified`,
    summary: [...new Set(affected.map(entry => unknownEntrySummary(entry, pt)))].join(" "),
    action: requestFailed
      ? (pt ? "Volte a esta janela para tentar a verificacao novamente." : "Refocus the window to retry the freshness check.")
      : refreshAction(affected, pt),
    changedFiles: [],
  };
}

export default function StalenessBanner({ freshness }: StalenessBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const { localeKey } = useI18n();
  const pt = localeKey === "pt-BR";
  const content = buildFreshnessBanner(freshness, localeKey);

  if (!content) return null;

  const hasFiles = content.changedFiles.length > 0;
  const visibleFiles = content.changedFiles.slice(0, 8);
  const hiddenFileCount = content.changedFiles.length - visibleFiles.length;

  return (
    <div className="bg-amber-950/30 border-b border-amber-700 text-amber-100 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-start gap-3 px-5 py-3 text-left hover:bg-amber-900/10 transition-colors"
      >
        <svg
          className="w-4 h-4 shrink-0 mt-0.5 text-amber-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          />
        </svg>
        <span className="flex-1 min-w-0">
          <span className="block font-semibold">{content.title}</span>
          <span className="block text-amber-100/80">{content.summary}</span>
          <span className="block text-amber-100/70">{content.action}</span>
        </span>
        {hasFiles && (
          <span className="text-xs text-amber-300/70 shrink-0">
            {pt ? (expanded ? "ocultar arquivos" : "mostrar arquivos") : (expanded ? "hide files" : "show files")}
          </span>
        )}
      </button>

      {expanded && hasFiles && (
        <div className="px-5 pb-3">
          <div className="border-t border-amber-700/40 pt-2 flex flex-wrap gap-1.5">
            {visibleFiles.map((file) => (
              <code
                key={file}
                className="px-1.5 py-0.5 rounded bg-amber-900/30 text-[11px] text-amber-100"
              >
                {file}
              </code>
            ))}
            {hiddenFileCount > 0 && (
              <span className="text-xs text-amber-200/60">
                +{hiddenFileCount} {pt ? "arquivos" : "more"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
