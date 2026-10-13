# UPSTREAM — @lioncode/archmap-core

Fork seletivo do **core** do Understand-Anything (UA), MIT (titulares Yuxiang
Lin; Infinite Universe, Inc.).
O `LICENSE` ao lado é cópia literal do LICENSE do UA. O nome "Understand
Anything" não aparece na UI do LionCode (marca não licenciada); a
funcionalidade chama-se **Mapa de arquitetura**.

## Origem

| Campo | Valor |
|---|---|
| Repositório | https://github.com/Egonex-AI/Understand-Anything |
| Commit | `5feed1f2ce4f9c368d860f4c0ebc36d98a4693fc` (2026-09-08) |
| Diretório de origem | `understand-anything-plugin/packages/core` |

## Mapa de caminhos (UA → fork)

| Caminho no UA | Caminho no fork |
|---|---|
| `understand-anything-plugin/packages/core/src/**` | `packages/archmap-core/src/**` (menos os descartados abaixo) |
| `understand-anything-plugin/packages/tree-sitter-dart-wasm/tree-sitter-dart.wasm` | `packages/archmap-core/grammars/tree-sitter-dart.wasm` |
| `understand-anything-plugin/packages/tree-sitter-swift-wasm/tree-sitter-swift.wasm` | `packages/archmap-core/grammars/tree-sitter-swift.wasm` |
| `understand-anything-plugin/packages/tree-sitter-swift-wasm/LICENSE` | `packages/archmap-core/grammars/tree-sitter-swift.LICENSE` |
| `LICENSE` (raiz do repo do UA) | `packages/archmap-core/LICENSE` |
| `understand-anything-plugin/packages/core/{package.json,tsconfig.json,vitest.config.ts}` | reescritos (ver abaixo) |

### Descartado (não copiado)

- `src/figma/**` (inclui `src/figma/__tests__/*` — 5 testes)
- `src/embedding-search.ts` + `src/__tests__/embedding-search.test.ts`
- `src/analyzer/llm-analyzer.ts` + `src/analyzer/llm-analyzer.test.ts`
- `src/analyzer/language-lesson.ts` + `src/__tests__/language-lesson.test.ts`

Testes mantidos: 39 dos 47 arquivos do UA (os 8 acima saem com seus módulos).

## Alterações locais (arquivo:símbolo)

1. `package.json` — novo: `name: @lioncode/archmap-core`, `version 0.1.0`,
   `private`, `exports` `.`, `./schema`, `./types`, `./search`, `./languages`
   (`{ types, default }`) e `./grammars/*` → `./grammars/*`; sem `./figma`;
   sem as dependências de workspace `@understand-anything/tree-sitter-{dart,swift}-wasm`
   (os `.wasm` são vendorados em `grammars/`); scripts `build`/`typecheck`/`test`.
2. `tsconfig.json` — estende `../../tsconfig.base.json` do LionCode com
   `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` e
   `noImplicitReturns` DESLIGADOS (o código do UA não compila com eles);
   testes fora do `dist`. `tsconfig.test.json` (typecheck com testes) e
   `vitest.config.ts` (`src/**/*.test.ts`) são próprios.
3. `grammars/tree-sitter-dart.LICENSE` — escrito localmente (texto MIT padrão,
   titular "UserNobody14 and others, 2020-2023"; o pacote do UA só declara
   `"license": "MIT"` sem arquivo).
4. `src/index.ts` — removidos os re-exports de `analyzer/llm-analyzer.js`,
   `analyzer/language-lesson.js` e `embedding-search.js`.
5. `src/persistence/index.ts:resolveUaDirName/resolveUaDir` — devolvem
   `<root>/.lioncode/archmap`; `.ua/` e `.understand-anything/` não são
   reconhecidos (constante `LEGACY_UA_DIR` removida).
6. `src/ignore-filter.ts:DEFAULT_IGNORE_PATTERNS` — ganha `.lioncode/`,
   `.codegraph/` e as exclusões de segurança (`.env`, `.env.*`,
   `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`,
   `.pypirc`, `.netrc`, `*credentials*.json` + `*credentials.json`
   (contorno de `ignore@7`, que não casa `*credentials*.json` com
   `gcp-credentials.json`), `*.keystore`, `.aws/`, `.ssh/`); perde
   `.understandignore`. `USER_IGNORE_FILE` (novo) = `.lioncode/archmap.ignore`;
   `createIgnoreFilter` lê SÓ esse arquivo (camadas `<ua-dir>/.understandignore`
   e `.understandignore` na raiz removidas; import de `resolveUaDir` removido).
7. `src/ignore-generator.ts:HEADER` e doc de `generateStarterIgnoreFile` —
   citam `.lioncode/archmap.ignore`.
8. `src/staleness.ts:PROJECT_PATHSPEC` — exclui `.lioncode` e `.lioncode/**`
   no lugar de `.understand-anything`/`.ua`.
9. `src/languages/configs/dart.ts` e `swift.ts:treeSitter.wasmPackage` —
   `@lioncode/archmap-core/grammars` (autorreferência pelo subpath
   `./grammars/*` do `exports`; `tree-sitter-plugin.ts` continua fazendo
   `require.resolve(\`${wasmPackage}/${wasmFile}\`)` sem alteração).
10. Testes ajustados às alterações acima: `src/__tests__/ignore-filter.test.ts`
    (arquivo do usuário em `.lioncode/archmap.ignore`; novos casos para as
    exclusões locais; `.understandignore` na raiz passa a NÃO ser lido),
    `src/__tests__/ignore-generator.test.ts` (exemplo `.env` → `scratch-data`,
    pois `.env` virou default; header), `src/persistence/persistence.test.ts`
    (`.ua` → `.lioncode/archmap`; bloco "legacy" vira teste do diretório fixo),
    `src/__tests__/domain-persistence.test.ts` (idem),
    `src/__tests__/graph-freshness.integration.test.ts` (`it.each` com
    `.lioncode/archmap` e `.lioncode`), `src/__tests__/language-registry.test.ts`
    e `src/plugins/extractors/__tests__/{dart,swift}-extractor.test.ts`
    (`wasmPackage`/`require.resolve` novos).

Tudo o mais é cópia byte a byte do commit de origem.

Resíduos do upstream mantidos de propósito: `TODO` em
`languages/configs/{kubernetes,json-schema}.ts:3` (comentários do UA sobre
detecção de manifests/schemas; não editar, para o diff contra o upstream
continuar limpo).

## Procedimento de atualização

No clone do UA (raiz do repositório, onde `understand-anything-plugin/` é um
subdiretório), gere o diff do core entre o commit de origem e o novo e
aplique-o com 3-way no fork:

```bash
cd <clone-do-UA>
git diff --relative=understand-anything-plugin/packages/core 5feed1f..<novo> -- . \
  | (cd <repo-lioncode> && git apply --3way --directory=packages/archmap-core)
```

- Hunks que tocam arquivos descartados (`src/figma/**`, `embedding-search.ts`,
  `llm-analyzer.ts`, `language-lesson.ts`) falham por "arquivo inexistente":
  ignorá-los (`--exclude` no `git apply` ou remover do patch).
- Hunks sobre os arquivos da lista "Alterações locais" caem em conflito de
  apply e são resolvidos à mão, preservando as alterações locais.
- Depois: `corepack pnpm --filter @lioncode/archmap-core build && corepack pnpm
  --filter @lioncode/archmap-core typecheck && corepack pnpm --filter
  @lioncode/archmap-core test`, atualizar o commit de origem acima e rodar
  `node scripts/gen-third-party-notices.mjs` se as dependências mudaram.

## Fork no LionClaw (`electron/main/archmap/core/`)

No LionClaw este fork vive em `electron/main/archmap/core/` (copia de
`packages/archmap-core/src` do LionCode `8a4fce3`, mais `grammars/`, `LICENSE`
e este arquivo), compilado junto com o processo main do Electron (electron-vite,
`moduleResolution: bundler`); nao e mais um pacote npm separado. Os testes do
upstream ficam em `electron/main/archmap/__tests__/core/` com os imports
apontados para esta pasta. O nome na UI continua "Mapa de arquitetura".

### Alteracoes locais do LionClaw (sobre o fork do LionCode)

1. `persistence/index.ts:UA_DIR` — `.lionclaw/archmap` no lugar de
   `.lioncode/archmap`.
2. `ignore-filter.ts:DEFAULT_IGNORE_PATTERNS` — ganha `.lionclaw/` (mantem
   `.lioncode/` e `.codegraph/`); `USER_IGNORE_FILE` = `.lionclaw/archmap.ignore`.
3. `ignore-generator.ts:HEADER` — cita `.lionclaw/archmap.ignore`.
4. `staleness.ts:PROJECT_PATHSPEC` — exclui tambem `.lionclaw` e `.lionclaw/**`.
5. `languages/configs/dart.ts` e `swift.ts:treeSitter.wasmPackage` —
   `lionclaw-archmap-grammars` (sentinela) no lugar da autorreferencia
   `@lioncode/archmap-core/grammars`, que nao existe fora do monorepo.
6. `plugins/tree-sitter-plugin.ts` — novos `LIONCLAW_GRAMMARS_PACKAGE`,
   `setArchmapGrammarsDir`, `archmapGrammarsDirCandidates`,
   `resolveArchmapGrammarsDir` e `resolveGrammarWasm`. Candidatos, nesta ordem:
   pasta fixada pelo host (`setArchmapGrammarsDir`, que o worker recebe de
   `app.getAppPath()`), `grammars/` ao lado deste codigo (fonte e vitest),
   `electron/main/archmap/core/grammars` dois e tres niveis acima do bundle
   (`dist/main` e `dist/main/chunks`), e `process.resourcesPath` +
   `app.asar.unpacked/...` ou `app/...`; toda variante `app.asar` ganha a
   irma `app.asar.unpacked`. Nenhum candidato existente ou wasm ausente =
   erro com a lista procurada; a gramatica que nao carrega derruba o `init()`
   (o upstream degradava em silencio com `console.debug`). O ramo sem configs
   (ts/tsx/js) tambem usa a sentinela; `require.resolve` so resta para um
   `wasmPackage` de npm, que nenhuma config usa mais.
7. Testes ajustados: `.lioncode` -> `.lionclaw` em `persistence.test.ts`,
   `domain-persistence.test.ts`, `graph-freshness.integration.test.ts`,
   `ignore-filter.test.ts`; `dart`/`swift-extractor.test.ts` carregam o wasm por
   `resolveArchmapGrammarsDir()`; `language-registry.test.ts` espera a sentinela.

8. Typecheck do LionClaw (`noUnusedLocals`/`noUnusedParameters` ligados):
   `plugins/extractors/csharp-extractor.ts` e `java-extractor.ts:extractInterface`
   renomeiam o parametro nao usado `functions` para `_functions`; `search.ts:SearchEngine`
   perde o campo privado `nodes` (so era escrito, nunca lido).
9. `languages/configs/*.ts:treeSitter.wasmPackage` — TODAS as gramaticas usam a
   sentinela `lionclaw-archmap-grammars`: os `.wasm` sao vendorados em
   `grammars/` com o LICENSE de cada pacote ao lado (decisao do orquestrador
   na validacao da S1: nao empacotar os pacotes npm `tree-sitter-*`, 354 MB
   com addons nativos, quando so os 26 MB de wasm sao usados). Origem de cada
   wasm (pacote npm e versao instalada em 2026-10-08):

   | wasm | pacote | versao |
   |---|---|---|
   | `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` | `tree-sitter-typescript` | 0.23.2 |
   | `tree-sitter-javascript.wasm` | `tree-sitter-javascript` | 0.25.0 |
   | `tree-sitter-python.wasm` | `tree-sitter-python` | 0.25.0 |
   | `tree-sitter-go.wasm` | `tree-sitter-go` | 0.25.0 |
   | `tree-sitter-rust.wasm` | `tree-sitter-rust` | 0.24.0 |
   | `tree-sitter-java.wasm` | `tree-sitter-java` | 0.23.5 |
   | `tree-sitter-c_sharp.wasm` | `tree-sitter-c-sharp` | 0.23.5 |
   | `tree-sitter-cpp.wasm` (c e cpp) | `tree-sitter-cpp` | 0.23.4 |
   | `tree-sitter-php.wasm` | `tree-sitter-php` | 0.23.12 |
   | `tree-sitter-ruby.wasm` | `tree-sitter-ruby` | 0.23.1 |
   | `tree-sitter-scala.wasm` | `tree-sitter-scala` | 0.24.0 |
   | `tree-sitter-kotlin.wasm` | `@tree-sitter-grammars/tree-sitter-kotlin` | 1.1.0 |
   | `tree-sitter-dart.wasm`, `tree-sitter-swift.wasm` | vendorados pelo LionCode (tabela de origem acima) | - |

   Testes dos extractors e `symbol-scopes.test.ts` carregam o wasm por
   `join(resolveArchmapGrammarsDir(), <arquivo>)` em vez de `require.resolve`.
10. `__tests__/graph-freshness.integration.test.ts` — dois nomes de teste
    "Understand Anything output files" viram "archmap output files" (RM1).
11. `schema.ts:GraphEdgeSchema` — ganha `metadata: z.record(z.string(), z.unknown()).optional()`
    (SPEC 7.5, F38): o schema de aresta nao tinha `.passthrough()` e descartava
    campos extras; a triagem Jev grava `metadata.unverifiedSince = runId` nas
    arestas semanticas de arquivo mantido (`pipeline/kept.ts`).

Tudo o mais e copia byte a byte do fork do LionCode.
