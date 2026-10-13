import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IGNORE_PATTERNS } from "./ignore-filter.js";

const HEADER = `# .lionclaw/archmap.ignore — patterns for files/dirs to exclude from analysis
# Syntax: same as .gitignore (globs, # comments, ! negation, trailing / for dirs)
# Lines below are suggestions — uncomment to activate.
# Use ! prefix to force-include something excluded by defaults.
#
# Built-in defaults (always excluded unless negated):
#   node_modules/, .git/, dist/, build/, obj/, *.lock, *.min.js, etc.
#
`;

const EXACT_DIR_NAMES = [
  "__tests__",
  "test",
  "tests",
  "fixtures",
  "testdata",
  "docs",
  "examples",
  "scripts",
  "migrations",
  ".storybook",
  "unittests",
  "unittest",
  "integrationtests",
  "bench",
  "benchmark",
  "benchmarks",
  "benches",
  "spec",
];

const SUFFIX_DIR_GLOBS = [
  "tests",
  "specs",
];

const TEST_PATTERN_GROUPS: Array<{ label: string; patterns: string[] }> = [
  {
    label: "JS / TS",
    patterns: ["*.test.*", "*.spec.*", "*.snap"],
  },
  {
    label: "C# / .NET",
    patterns: [
      "**/*Tests.cs",
      "**/*Test.cs",
      "**/*Fixture.cs",
      "**/*.Tests.csproj",
    ],
  },
  {
    label: "Java / Kotlin",
    patterns: [
      "**/src/test/**",
      "**/*Test.java",
      "**/*IT.java",
      "**/*Spec.kt",
    ],
  },
  {
    label: "Go",
    patterns: ["**/*_test.go"],
  },
  {
    label: "C++",
    patterns: [
      "**/*_test.cc",
      "**/*_test.cpp",
      "**/*_test.cxx",
      "**/*Test.cc",
      "**/*Test.cpp",
      "**/*_unittest.cc",
      "**/*_unittest.cpp",
      "**/*_browsertest.cc",
      "**/*_benchmark.cc",
      "**/*Benchmark.cpp",
    ],
  },
  {
    label: "Python",
    patterns: [
      "**/test_*.py",
      "**/*_test.py",
      "**/tests.py",
      "**/conftest.py",
    ],
  },
  {
    label: "Rust",
    patterns: [
      "**/tests.rs",
      "**/test_*.rs",
      "**/*_test.rs",
      "**/bench_*.rs",
      "**/*_bench.rs",
    ],
  },
  {
    label: "Ruby",
    patterns: [
      "**/*_spec.rb",
      "**/*_test.rb",
      "**/test_*.rb",
      "**/spec_helper.rb",
      "**/test_helper.rb",
      "**/rails_helper.rb",
    ],
  },
  {
    label: "Swift",
    patterns: [
      "**/Tests/**/*.swift",
      "**/Specs/**/*.swift",
    ],
  },
];

function parseGitignorePatterns(gitignorePath: string): string[] {
  if (!existsSync(gitignorePath)) return [];
  const content = readFileSync(gitignorePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isCoveredByDefaults(pattern: string): boolean {
  const normalize = (p: string) => p.replace(/\/+$/, "");
  const normalized = normalize(pattern);
  return DEFAULT_IGNORE_PATTERNS.some((d) => normalize(d) === normalized);
}

function detectDirectories(projectRoot: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    if (EXACT_DIR_NAMES.includes(lower)) {
      matches.push(`${entry.name}/`);
      continue;
    }
    if (SUFFIX_DIR_GLOBS.some((suffix) => lower.endsWith(suffix))) {
      matches.push(`${entry.name}/`);
    }
  }
  return matches;
}

export function generateStarterIgnoreFile(projectRoot: string): string {
  const sections: string[] = [HEADER];

  const gitignorePath = join(projectRoot, ".gitignore");
  const gitignorePatterns = parseGitignorePatterns(gitignorePath).filter(
    (p) => !isCoveredByDefaults(p),
  );

  if (gitignorePatterns.length > 0) {
    sections.push("# --- From .gitignore (uncomment to exclude) ---\n");
    for (const pattern of gitignorePatterns) {
      sections.push(`# ${pattern}`);
    }
    sections.push("");
  }

  const detected = detectDirectories(projectRoot);
  if (detected.length > 0) {
    sections.push("# --- Detected directories (uncomment to exclude) ---\n");
    for (const pattern of detected) {
      sections.push(`# ${pattern}`);
    }
    sections.push("");
  }

  sections.push("# --- Test file patterns (uncomment to exclude) ---\n");
  for (const group of TEST_PATTERN_GROUPS) {
    sections.push(`# ${group.label}`);
    for (const pattern of group.patterns) {
      sections.push(`# ${pattern}`);
    }
  }
  sections.push("");

  return sections.join("\n");
}
