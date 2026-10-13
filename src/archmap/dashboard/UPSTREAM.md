# UPSTREAM — @lioncode/archmap-dashboard

Fork mecânico do **dashboard** do Understand-Anything (UA), MIT (titulares
Yuxiang Lin; Infinite Universe, Inc.). O `LICENSE` ao lado é cópia literal do LICENSE do UA. O nome
"Understand Anything" não aparece na UI (marca não licenciada); a
funcionalidade chama-se **Mapa de arquitetura**.

## Origem

| Campo | Valor |
|---|---|
| Repositório | https://github.com/Egonex-AI/Understand-Anything |
| Commit | `5feed1f2ce4f9c368d860f4c0ebc36d98a4693fc` (2026-09-08) |
| Diretório de origem | `understand-anything-plugin/packages/dashboard` |

## Mapa de caminhos (UA → fork)

| Caminho no UA | Caminho no fork |
|---|---|
| `understand-anything-plugin/packages/dashboard/src/**` | `packages/archmap-dashboard/src/**` (menos os descartados abaixo) |
| `understand-anything-plugin/packages/dashboard/index.html` | `packages/archmap-dashboard/index.html` (alterado) |
| `understand-anything-plugin/packages/dashboard/tsconfig.json`, `tsconfig.app.json` | idem, sem alteração |
| `understand-anything-plugin/packages/dashboard/public/knowledge-graph.json` | `packages/archmap-dashboard/test/fixtures/knowledge-graph.example.json` |
| `understand-anything-plugin/packages/dashboard/vite.config.single.ts` | base do `packages/archmap-dashboard/vite.config.ts` (reescrito) |
| `LICENSE` (raiz do repo do UA) | `packages/archmap-dashboard/LICENSE` |

### Descartado (não copiado)

- Componentes: `KnowledgeGraphView`, `DomainGraphView`, `DomainClusterNode`,
  `FlowNode`, `StepNode`, `MobileLayout`, `MobileDrawer`, `MobileBottomNav`,
  `TokenGate`, `PersonaSelector`, `OnboardingOverlay`, `ExportMenu`.
- `src/utils/force-layout-client.ts`, `src/utils/force-layout.worker.ts`,
  `src/utils/force-layout.ts` (só o `KnowledgeGraphView` o usava; a dependência
  `d3-force` sai junto), `src/utils/layout.worker.ts` (sem consumidor),
  `src/hooks/useIsMobile.ts` (só o layout mobile o usava).
- Testes: `src/__tests__/vite-staleness.test.ts` (importava o
  `createDashboardDataMiddleware` do `vite.config.ts`),
  `src/utils/__tests__/force-layout.test.ts` e
  `src/utils/__tests__/force-layout-client.test.ts` (importavam módulos removidos).
- `public/` inteiro (favicons; o grafo de exemplo foi para `test/fixtures/`),
  `vite.config.demo.ts`, `vite.config.ts.bak`, `scripts/` (benchmarks).

Testes mantidos: 12 arquivos (`allNodeTypes`, `edgeCategories`, `freshness`
— reescrito, item 10 —, `store-navigation`, `StalenessBanner`,
`structuralVisibleTypes`, `containers`, `edgeAggregation`, `elk-layout`,
`filters`, `layerStats`, `smoke`) + os novos `test/build.test.ts`,
`src/__tests__/bridge.test.ts` e `src/__tests__/bridge-types.test.ts`.

## Alterações locais (arquivo:símbolo)

1. `package.json` — novo: `name: @lioncode/archmap-dashboard`, `version 0.1.0`,
   `private`; deps do UA SEM `@understand-anything/core` (vira o workspace
   `@lioncode/archmap-core`, necessário ao `tsc -b` pela condição `types` do
   `exports`) e sem `d3-force`/`@types/d3-force`; devDeps + `vite-plugin-singlefile`
   ^2.3.3 e `@types/node`; scripts `build` (`tsc -b && vite build`),
   `typecheck` (`tsc -b`), `test`.
2. `vite.config.ts` — reescrito a partir do `vite.config.single.ts` do UA:
   `react() + tailwindcss() + viteSingleFile()`, aliases
   `@lioncode/archmap-core/{schema,search,types}` → `../archmap-core/dist/*.js`,
   `outDir: dist`; sem `base`, sem `manualChunks`, sem
   `createDashboardDataMiddleware`/token, sem modo demo; `test.include` cobre
   `src/**/__tests__/**` e `test/**`.
3. `index.html` — sem `<link rel="icon">` e sem os `<link>` de Google Fonts
   (pilha de fontes do sistema); `<meta name="referrer" content="no-referrer">`;
   `<title>Mapa de arquitetura</title>`.
4. Todos os `.ts`/`.tsx` em `src/` — imports `@understand-anything/core/*` →
   `@lioncode/archmap-core/*`.
5. `src/App.tsx` — removidos `DEMO_MODE`, `resolveInitialToken`,
   `SESSION_TOKEN_KEY`, `shouldShowOnboarding`/`ONBOARDING_DISMISSED_KEY`
   (único `localStorage` do arquivo), `TokenGate`, `OnboardingOverlay`,
   `PersonaSelector`, `MobileLayout`/`useIsMobile`, `ExportMenu` (e o atalho
   `e` + o ramo `exportMenuOpen` do `Escape`), o seletor domain/structural, o
   modo `knowledge` (`KnowledgeGraphView`, `isKnowledgeGraph`,
   `setViewMode("knowledge")`), `DomainGraphView`; `accessToken` deixa de
   existir (`Dashboard()`/`DashboardContent()` sem prop); o freshness sempre
   inicia. **Bridge**: `dataUrl` removido; todo
   `fetch(dataUrl(...))` virou `getBridge().fetch(resource)` —
   `knowledge-graph.json` → `graph` (o `json()` devolve o objeto recebido por
   structured clone, sem `JSON.parse`), `meta.json` → `meta` (só `theme`),
   `config.json` → `config`, `diff-overlay.json` → `diff-overlay`,
   `domain-graph.json` → `domain-graph`, `staleness.json` → `staleness` via
   `requestFreshnessReport(bridge, signal)`. O `archmap:init` alimenta
   `outputLanguage` (I18nProvider; o `config` ainda pode sobrescrever) e
   `projectName` (novo prop de `DashboardContent`, fallback do `<h1>` enquanto
   o grafo não chegou: `graph?.project.name ?? projectName ?? appName`).
6. `src/store.ts` — `ViewMode` sem `"knowledge"`; removidos `isKnowledgeGraph`/
   `setIsKnowledgeGraph`, `exportMenuOpen`/`toggleExportMenu` (e o reset em
   `toggleFilterPanel`).
7. `src/components/CodeViewer.tsx` — prop `accessToken` removida; sem o ramo
   `__demo__`; `fileContentUrl` removido: `fetch(fileContentUrl(...))` →
   `getBridge().fetch('file', { path }, { signal })`. Novo
   `toSourceFile(body, path)`: a resposta do renderer é
   `{ path, content, language }` (`ArchmapFileResponse` do shared), sem
   `sizeBytes`/`lineCount` — derivados localmente (`TextEncoder` e contagem de
   `\n`) quando ausentes. Links de markdown (`components.a`) viram
   `<span className="text-accent">` (sem `href`/`target="_blank"`).
8. `test/build.test.ts` — novo (teste de build): `dist/` contém só
   `index.html`; sem `<script src=`, `href="http`, `href="/`,
   `force-layout.worker`; `elk-layout.ts` sem `workerUrl`.
9. `src/bridge/` — novo:
   - `types.ts`: réplica byte a byte da seção "Bridge iframe (dashboard) <->
     renderer" de `shared/src/archmap.ts` (`ArchmapBridgeResource`,
     `ARCHMAP_BRIDGE_RESOURCES`, `ArchmapBridgeRequest`, `ArchmapBridgeResponse`);
     o dashboard NÃO importa `@lioncode/shared` (bundle isolado). O teste
     `src/__tests__/bridge-types.test.ts` compara os dois arquivos.
   - `bridge.ts`: `createArchmapBridge({ parent, self })` — `postMessage` para
     `window.parent` com `targetOrigin '*'`; `archmap:ready` (requestId único)
     imediato e a cada 500ms até o `archmap:init`; `fetch(resource, params?,
     { signal }?)` enfileira até o init e devolve `{ ok, status, json(), text() }`;
     adota SEMPRE o `viewSessionId` do init mais recente e reenvia as pendências
     com ele (requestId NOVO a cada envio, para não cair no dedupe `seen` do
     renderer); ignora mensagens sem `protocolVersion: 1`, com `viewSessionId`
     diferente do atual ou com `event.source` ≠ parent (source `null` aceito —
     eventos sintéticos); timeout de 60s por requisição contado a partir da
     chamada (fila inclusa) ⇒ rejeita com `TimeoutError`; `signal` abortado ⇒
     `AbortError`; sem `sessionStorage`/`localStorage`; `onInit`/`getInit`/
     `dispose`.
   - `index.ts`: singleton `getBridge()` (criado no primeiro uso, no mount do
     `App`; lança fora do browser).
10. `src/freshness.ts` — `requestFreshnessReport(bridge: FreshnessBridge,
    signal)` chama `bridge.fetch('staleness', undefined, { signal })` no lugar
    de `fetcher(url, { signal, cache: 'no-store' })`; `shouldRequestFreshness`
    (gate do modo demo) removido; `startFreshnessRefresh` inalterado.
    `src/__tests__/freshness.test.ts` reescrito contra o bridge injetável
    (blocos `requestFreshnessReport` e `shouldRequestFreshness`); os blocos
    `isDashboardFreshnessReport` e `startFreshnessRefresh` são os do upstream.

Não alterado (já conforme): `src/themes/ThemeContext.tsx` — os acessos a
`localStorage` já estão em `try/catch` no upstream (tema em memória sem
storage); é o único uso de storage restante em `src/`.

Tudo o mais é cópia byte a byte do commit de origem.

## Procedimento de atualização

```bash
cd <clone-do-UA>
git diff --relative=understand-anything-plugin/packages/dashboard 5feed1f..<novo> -- . \
  | (cd <repo-lioncode> && git apply --3way --directory=packages/archmap-dashboard)
```

- Hunks sobre arquivos descartados (componentes/utils/testes/`public/`/
  `vite.config.demo.ts` acima) falham por "arquivo inexistente": ignorá-los.
- Hunks sobre os arquivos da lista "Alterações locais" caem em conflito de
  apply e são resolvidos à mão, preservando as alterações locais (em especial
  os imports `@lioncode/archmap-core/*` e o `vite.config.ts`).
- Depois: `corepack pnpm --filter @lioncode/archmap-core build && corepack pnpm
  --filter @lioncode/archmap-dashboard build && corepack pnpm --filter
  @lioncode/archmap-dashboard test`, atualizar o commit de origem acima e rodar
  `node scripts/gen-third-party-notices.mjs` se as dependências mudaram.

- Marca/comandos do UA removidos da UI: `StalenessBanner.refreshAction` aponta para o botão "Atualizar" do LionCode (não há slash command); `WarningBanner` sem link para o issue tracker do UA; `locales/*.ts` `appName` = "Mapa de arquitetura" e bloco `onboarding` REMOVIDO dos 6 locales (o `OnboardingOverlay` foi descartado; o `header` "UNDERSTAND-ANYTHING · GET STARTED" não pode ficar no bundle). `Locale = typeof en`: um hunk upstream que reintroduza `onboarding` num locale cai em conflito e é descartado.

## Fork no LionClaw

Este diretorio (`src/archmap/dashboard/`) e a copia do `packages/archmap-dashboard/src` do LionCode
(commit `8a4fce3`, repo `Projetos/lioncode`), montado como pagina do app (`src/pages/ArchmapPage.tsx`),
sem iframe, sem `postMessage` e sem build single-file. Os tres modulos do core que o dashboard consome
(`schema.ts`, `search.ts`, `types.ts`) sao copias byte a byte de `electron/main/archmap/core/` em
`src/archmap/core/` (teste `src/archmap/__tests__/core-copy.test.ts` garante a igualdade), porque o
`tsconfig` do renderer tem `rootDir: src` e nao pode importar do main. Os testes do upstream ficam
no lugar (`__tests__/`, `utils/__tests__/`, `components/__tests__/`) e entram no vitest pelo glob
`src/archmap/dashboard/**/__tests__/**/*.test.ts`. A pasta fica fora do Prettier (`.prettierignore`),
como `vendor/`; os comentarios do upstream sao mantidos.

### Nao copiado do LionCode

- `main.tsx`, `index.html`, `vite-env.d.ts`, `vite.config.ts`, `package.json`, `tsconfig*.json`,
  `test/build.test.ts` (so existiam por causa do app Vite single-file em iframe).
- `src/bridge/bridge.ts`, `src/bridge/types.ts` (bridge por postMessage) e os testes
  `src/__tests__/bridge.test.ts` e `src/__tests__/bridge-types.test.ts`.
- `locales/zh.ts`, `zh-TW.ts`, `ja.ts`, `ko.ts`, `ru.ts` (so `pt-BR` e `en`, SPEC 5.3).
- O grafo de exemplo `test/fixtures/knowledge-graph.example.json` foi para
  `src/archmap/__tests__/fixtures/` com `project.name` trocado para `exemplo-mapa`.

### Alteracoes locais (arquivo:simbolo)

1. Todos os `.ts`/`.tsx`: imports `@lioncode/archmap-core/{schema,search,types}` -> relativos
   `../core/*` (ou `../../core/*`, `../../../core/*`); extensoes `.ts`/`.tsx` removidas dos imports
   relativos (o renderer do LionClaw nao liga `allowImportingTsExtensions`).
2. `bridge/index.ts` — reescrito: ponto unico de injecao da bridge em processo. `setBridge(bridge)`
   e chamado pela `ArchmapPage` antes de montar o `App`; `getBridge()` lanca se nada foi instalado.
   Re-exporta os tipos (`ArchmapBridge`, `BridgeResponse`, `BridgeInit`, `BridgeFetchOptions`,
   `ArchmapBridgeResource`) de `src/archmap/bridge/lionclaw-bridge.ts`, que implementa a MESMA
   interface do `createArchmapBridge` do LionCode (`fetch(resource, params?, {signal}?)` ->
   `{ok, status, json(), text()}`, `getInit`, `onInit`, `dispose`) chamando
   `window.lionclaw.archmap.{graph,meta,file,freshness}` direto. `freshness.ts` importa o tipo de
   `./bridge` (antes `./bridge/bridge`); `__tests__/freshness.test.ts` idem.
3. `App.tsx` — raiz `h-screen w-screen` -> `h-full w-full` (a pagina do app e quem ocupa a janela);
   `ThemeProvider` recebe `className="h-full w-full relative overflow-hidden"`; o `title` dos botoes
   de categoria usa `t.nodeTypeFilter` em vez de "Hide/Show ... nodes".
4. `themes/theme-engine.ts:applyTheme(config, target)` — aplica as variaveis e o `data-theme` no
   elemento recebido, nunca em `document.documentElement`. `themes/ThemeContext.tsx:ThemeProvider`
   — renderiza o `<div class="archmap-root" data-theme=...>` com `ref` e aplica o tema nele em
   `useLayoutEffect`; `STORAGE_KEY` = `lionclaw-archmap-theme`.
5. `index.css` — reescrito: sem `@import "tailwindcss"`/`@source`/`@theme`; as variaveis do tema
   vivem em `.archmap-root { ... }`; TODA regra prefixada com `.archmap-root` (`body` e `html`
   viraram `.archmap-root`; `::-webkit-scrollbar`, `.react-flow__background`, `[data-theme=...]`
   idem); `.noise-overlay::before` passa de `position: fixed` para `absolute`; keyframes renomeados
   (`archmap-current`, `archmap-breathe`, `archmap-fade-slide-in`, `archmap-slide-up`,
   `archmap-accent-pulse`). Novo `theme.css` com `@theme reference { --color-* }` importado por
   `src/index.css` para o Tailwind do app gerar `bg-root`, `text-text-primary`, `bg-accent/15` etc.
   sem emitir variaveis em `:root`. Teste: `src/archmap/__tests__/archmap-css-scope.test.tsx`.
6. `locales/index.ts` — so `pt-BR` e `en`; `resolveLocaleKey` devolve `pt-BR` ou `en`.
   `locales/pt-BR.ts` — acentos removidos (padrao da UI do LionClaw) e chaves novas; `locales/en.ts`
   — chaves novas `warningBanner.*` (textos do banner), `graphView.*`, `layerCluster.explore`,
   `filterPanel.title`.
7. `components/WarningBanner.tsx` — textos fixos em ingles trocados por `t.warningBanner.*`.
   `components/GraphView.tsx` — "Showing neighborhood", "Leitura"/"Enquadrar tudo", o toggle de
   animacao e os avisos de layout usam `t.graphView.*` (`useI18n` em `GraphViewInner`).
   `components/FilterPanel.tsx` — `title={t.filterPanel.title}`. `components/LayerClusterNode.tsx` —
   `t.layerCluster.explore` no lugar do ternario `pt ? ... : ...`.
8. `components/StalenessBanner.tsx` — strings pt sem acentos; `refreshAction` aponta para
   "Atualizar mapa" na tela Repositorios do LionClaw (pt e en).
   `components/__tests__/StalenessBanner.test.ts` — expectativas ajustadas a esses textos.
9. `utils/edgeAggregation.ts` — o byte NUL cru da linha 155 virou o escape `\u0000` (mesma
   semantica; o git volta a tratar o arquivo como texto). Aplicado na correcao S4-V3.
10. Erros e PathFinder traduzidos (correcao S4-V5): `App.tsx` guarda `loadError` como
    `{kind: "invalid" | "failed", detail}` e o `DashboardContent` monta o texto com
    `t.errors.*`; `components/CodeViewer.tsx` usa `t.codeViewer.noFilePath` e
    `t.codeViewer.sourceUnavailable`; `components/GraphView.tsx` usa `t.common.noGraphLoaded`;
    `components/PathFinderModal.tsx` ganha `useI18n` e usa `t.pathFinder.heading/selectNode/noPath`.
    Chaves novas em `locales/{en,pt-BR}.ts`: `errors.*`, `codeViewer.noFilePath`,
    `pathFinder.heading/selectNode/noPath`.

Tudo o mais e copia byte a byte do LionCode `8a4fce3`.
