import type { LanguageConfig } from "../types.js";

export const jsonSchemaConfig = {
  id: "json-schema",
  displayName: "JSON Schema",
  extensions: [],
  concepts: ["types", "properties", "required fields", "$ref", "$defs", "allOf/anyOf/oneOf", "patterns", "validation"],
  filePatterns: {
    entryPoints: [],
    barrels: [],
    tests: [],
    config: [],
  },
} satisfies LanguageConfig;
