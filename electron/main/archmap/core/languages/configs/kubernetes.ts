import type { LanguageConfig } from "../types.js";

export const kubernetesConfig = {
  id: "kubernetes",
  displayName: "Kubernetes",
  extensions: [],
  concepts: ["deployments", "services", "pods", "configmaps", "secrets", "ingress", "volumes", "namespaces"],
  filePatterns: {
    entryPoints: [],
    barrels: [],
    tests: [],
    config: ["k8s/*.yaml", "kubernetes/*.yaml"],
  },
} satisfies LanguageConfig;
