import ignore, { type Ignore } from "ignore";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_IGNORE_PATTERNS: string[] = [
  ".lionclaw/",
  ".lioncode/",
  ".codegraph/",

  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "*credentials*.json",
  "*credentials.json",
  "*.keystore",
  ".aws/",
  ".ssh/",

  "node_modules/",
  ".git/",
  "vendor/",
  "venv/",
  ".venv/",
  "__pycache__/",

  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".cache/",
  ".turbo/",
  "target/",
  "obj/",

  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",

  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.svg",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp3",
  "*.mp4",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",

  "*.min.js",
  "*.min.css",
  "*.map",
  "*.generated.*",

  ".idea/",
  ".vscode/",

  "LICENSE",
  ".gitignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc*",
  "*.log",
];

export interface IgnoreFilter {
  isIgnored(relativePath: string): boolean;
}

export const USER_IGNORE_FILE = join(".lionclaw", "archmap.ignore");

export function createIgnoreFilter(projectRoot: string, extraPatterns: string[] = []): IgnoreFilter {
  const ig: Ignore = ignore();

  ig.add(DEFAULT_IGNORE_PATTERNS);

  const rootIgnorePath = join(projectRoot, USER_IGNORE_FILE);
  if (existsSync(rootIgnorePath)) {
    const content = readFileSync(rootIgnorePath, "utf-8");
    ig.add(content);
  }

  if (extraPatterns.length > 0) {
    ig.add(extraPatterns);
  }

  return {
    isIgnored(relativePath: string): boolean {
      return ig.ignores(relativePath);
    },
  };
}
