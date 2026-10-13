import type { KnowledgeGraph, Layer } from "../types.js";

export interface LLMLayerResponse {
  name: string;
  description: string;
  filePatterns: string[];
}

const LAYER_PATTERNS: Array<{ patterns: string[]; layerName: string; description: string }> = [
  {
    patterns: ["routes", "controller", "handler", "endpoint", "api"],
    layerName: "API Layer",
    description: "HTTP endpoints, route handlers, and API controllers",
  },
  {
    patterns: ["service", "usecase", "use-case", "business"],
    layerName: "Service Layer",
    description: "Business logic and application services",
  },
  {
    patterns: ["model", "entity", "schema", "database", "db", "migration", "repository", "repo"],
    layerName: "Data Layer",
    description: "Data models, database access, and persistence",
  },
  {
    patterns: ["component", "view", "page", "screen", "layout", "widget", "ui"],
    layerName: "UI Layer",
    description: "User interface components and views",
  },
  {
    patterns: ["middleware", "interceptor", "guard", "filter", "pipe"],
    layerName: "Middleware Layer",
    description: "Request/response middleware and interceptors",
  },
  {
    patterns: ["client", "integration", "external", "sdk", "vendor", "adapter"],
    layerName: "External Services",
    description: "External service integrations, SDKs, and third-party adapters",
  },
  {
    patterns: ["worker", "job", "queue", "cron", "consumer", "processor", "scheduler", "background"],
    layerName: "Background Tasks",
    description: "Background workers, job processors, and scheduled tasks",
  },
  {
    patterns: ["util", "helper", "lib", "common", "shared"],
    layerName: "Utility Layer",
    description: "Shared utilities, helpers, and common libraries",
  },
  {
    patterns: ["test", "spec", "__test__", "__spec__", "__tests__", "__specs__"],
    layerName: "Test Layer",
    description: "Test files and test utilities",
  },
  {
    patterns: ["config", "setting", "env"],
    layerName: "Configuration Layer",
    description: "Application configuration and environment settings",
  },
];

function toLayerId(name: string): string {
  return `layer:${name.toLowerCase().replace(/\s+/g, "-")}`;
}

function matchFileToLayer(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalizedPath.split("/");

  for (const { patterns, layerName } of LAYER_PATTERNS) {
    for (const segment of segments) {
      for (const pattern of patterns) {
        if (segment === pattern || segment === pattern + "s") {
          return layerName;
        }
      }
    }
  }

  return null;
}

export function detectLayers(graph: KnowledgeGraph): Layer[] {
  const layerMap = new Map<string, string[]>();
  const corePathless: string[] = [];

  for (const node of graph.nodes) {
    if (node.type !== "file") continue;
    if (!node.filePath) {
      corePathless.push(node.id);
      continue;
    }

    const layerName = matchFileToLayer(node.filePath) ?? "Core";
    const existing = layerMap.get(layerName) ?? [];
    existing.push(node.id);
    layerMap.set(layerName, existing);
  }

  if (corePathless.length > 0) {
    const existing = layerMap.get("Core") ?? [];
    for (const id of corePathless) existing.push(id);
    layerMap.set("Core", existing);
  }

  const layers: Layer[] = [];
  for (const [name, nodeIds] of layerMap) {
    const description =
      name === "Core"
        ? "Core application files"
        : LAYER_PATTERNS.find((p) => p.layerName === name)?.description ?? "";

    layers.push({
      id: toLayerId(name),
      name,
      description,
      nodeIds,
    });
  }

  return layers;
}

export function buildLayerDetectionPrompt(graph: KnowledgeGraph): string {
  const filePaths = graph.nodes
    .filter((n) => n.type === "file" && n.filePath)
    .map((n) => n.filePath!);

  const fileListStr = filePaths.map((f) => `  - ${f}`).join("\n");

  return `You are a software architecture analyst. Given the following list of file paths from a codebase, identify the logical architectural layers.

File paths:
${fileListStr}

Return a JSON array of 3-7 layers. Each layer object must have:
- "name": A short layer name (e.g., "API", "Data", "UI")
- "description": What this layer is responsible for (1 sentence)
- "filePatterns": An array of path prefixes that belong to this layer (e.g., ["src/routes/", "src/controllers/"])

Every file should belong to exactly one layer. Use the most specific pattern possible.

Respond ONLY with the JSON array, no additional text.`;
}

export function parseLayerDetectionResponse(
  response: string,
): LLMLayerResponse[] | null {
  if (!response || response.trim().length === 0) {
    return null;
  }

  try {
    const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();

    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      return null;
    }

    const parsed = JSON.parse(arrayMatch[0]);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }

    const layers: LLMLayerResponse[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      if (typeof item.name !== "string") continue;

      layers.push({
        name: item.name,
        description: typeof item.description === "string" ? item.description : "",
        filePatterns: Array.isArray(item.filePatterns)
          ? item.filePatterns.filter((p: unknown) => typeof p === "string")
          : [],
      });
    }

    return layers.length > 0 ? layers : null;
  } catch {
    return null;
  }
}

export function applyLLMLayers(
  graph: KnowledgeGraph,
  llmLayers: LLMLayerResponse[],
): Layer[] {
  const layerMap = new Map<string, string[]>();

  for (const llmLayer of llmLayers) {
    layerMap.set(llmLayer.name, []);
  }

  for (const node of graph.nodes) {
    if (node.type !== "file") continue;

    if (!node.filePath) {
      const other = layerMap.get("Other") ?? [];
      other.push(node.id);
      layerMap.set("Other", other);
      continue;
    }

    const normalizedPath = node.filePath.replace(/\\/g, "/");
    let assigned = false;

    for (const llmLayer of llmLayers) {
      for (const pattern of llmLayer.filePatterns) {
        if (normalizedPath.startsWith(pattern) || normalizedPath.includes("/" + pattern)) {
          const existing = layerMap.get(llmLayer.name)!;
          existing.push(node.id);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }

    if (!assigned) {
      const other = layerMap.get("Other") ?? [];
      other.push(node.id);
      layerMap.set("Other", other);
    }
  }

  const layers: Layer[] = [];
  for (const [name, nodeIds] of layerMap) {
    if (nodeIds.length === 0) continue;

    const llmLayer = llmLayers.find((l) => l.name === name);
    layers.push({
      id: toLayerId(name),
      name,
      description: llmLayer?.description ?? "Uncategorized files",
      nodeIds,
    });
  }

  return layers;
}
