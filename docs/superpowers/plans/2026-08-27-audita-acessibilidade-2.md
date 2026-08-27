# Audita Acessibilidade 2.0 — plano de implementação

> **Execução:** seguir TDD estrito em cada tarefa, com revisão de especificação e qualidade antes de avançar. Não ampliar alegações normativas sem fonte e teste.

**Objetivo:** entregar uma extensão Chromium MV3 local, sem login, com motor híbrido Audita + axe-core, modelo multipágina, personas reversíveis, relatório interativo, CSV seguro, mapa visual de prévias de anúncio e base consumerista fixa por desconformidade.

**Arquitetura:** preservar o motor e o catálogo ABNT atuais como autoridade; executar axe-core 4.13.0 como fonte suplementar; normalizar tudo em um modelo canônico V2 com páginas, ocorrências, evidências e proveniência; manter simulações separadas de resultados normativos; gerar todos os artefatos localmente.

**Tecnologias:** JavaScript ESM, HTML, CSS, Chrome Extensions Manifest V3, Chrome DevTools Protocol, axe-core 4.13.0 empacotado, Node.js `node:test`, IndexedDB e Web Crypto.

---

## Task 1 — Corrigir o contrato coletor → normalizador → regras

**Arquivos:**

- Modificar: `src/collector/page-collector.js`
- Modificar: `src/core/normalize-snapshot.js`
- Modificar: `src/core/normalize-probes.js`
- Modificar: `src/background/chrome-adapter.js`
- Testar: `test/core/normalize-snapshot.test.js`
- Testar: `test/core/normalize-probes.test.js`
- Criar: `test/integration/collector-rule-contract.test.js`

**Passos:**

1. Escrever fixtures no formato realmente emitido pelo coletor para nome AX vazio, mídia, texto justificado, contraste e target size.
2. Executar `node --test test/integration/collector-rule-contract.test.js test/core/normalize-snapshot.test.js test/core/normalize-probes.test.js` e confirmar falhas específicas.
3. Coletar `text-align`, fontes, cores, geometria e campos de mídia necessários.
4. Preservar nome AX vazio como valor observado e distinguir ausência de observação.
5. Vincular probes por backend node ID quando disponível, com seletor/frame como fallback determinístico.
6. Derivar `textBlock`, `contrast`, `textAlign` e mídia no normalizador sem duplicar interpretações nas regras.
7. Executar os testes focados e depois `npm test`.
8. Commit: `fix: align collected page data with audit rules`.

## Task 2 — Introduzir catálogos Section 508 e jurídico

**Arquivos:**

- Criar: `src/core/normative/section508.js`
- Criar: `src/core/legal/consumer-basis.js`
- Modificar: `src/core/normative/validate-normative-data.js`
- Criar: `test/normative/section508.test.js`
- Criar: `test/legal/consumer-basis.test.js`

**Passos:**

1. Escrever testes que exijam o texto fixo exato, o ID imutável, a qualificação constante e a ressalva ao texto vigente.
2. Escrever testes que proíbam a tag antiga `section508` do axe e mantenham a correspondência estrangeira separada.
3. Executar os testes e confirmar RED.
4. Implementar o catálogo jurídico congelado e helpers que só retornem referência para `failed` conclusivo.
5. Implementar crosswalk Section 508 por critérios WCAG 2.0 A/AA aplicáveis.
6. Validar IDs únicos, fontes, versão e ausência de campos de conclusão jurídica.
7. Executar testes focados e `npm test`.
8. Commit: `feat: add fixed consumer basis and Section 508 crosswalk`.

## Task 3 — Evoluir o modelo canônico para V2

**Arquivos:**

- Modificar: `src/core/result.js`
- Modificar: `src/core/report/audit-model.js`
- Modificar: `src/core/report/enrich-audit.js`
- Modificar: `src/core/rules/aggregate-items.js`
- Modificar: `src/core/report/earl-json.js`
- Modificar: `fixtures/audits/sample-audit.js`
- Testar: `test/core/result.test.js`
- Testar: `test/report/enrich-audit.test.js`
- Testar: `test/report/earl-json.test.js`
- Criar: `test/report/audit-model-v2.test.js`

**Passos:**

1. Testar `schemaVersion: 2`, `pages`, `pageId`, fonte, impacto, confiança, classificação, referências normativas e jurídicas.
2. Testar compatibilidade de entrada V1 por migração explícita, sem inferir dados inexistentes.
3. Testar que somente falhas conclusivas de requisito recebem a referência consumerista; recomendações usam rótulo próprio.
4. Remover validações rígidas que confundem 130 regras próprias com regras suplementares.
5. Implementar construtores e validadores V2.
6. Atualizar agregação e EARL sem perder 146 asserções ABNT.
7. Executar testes focados e `npm test`.
8. Commit: `feat: introduce canonical multipage audit model v2`.

## Task 4 — Empacotar axe-core e provar compatibilidade MV3/CSP

**Arquivos:**

- Modificar: `package.json`
- Criar: `package-lock.json`
- Criar: `vendor/axe/axe.min.js`
- Criar: `vendor/axe/LICENSE`
- Criar: `vendor/axe/LICENSE-3RD-PARTY.txt`
- Criar: `src/browser/axe-adapter.js`
- Modificar: `scripts/build-release.mjs`
- Modificar: `scripts/verify-project.mjs`
- Criar: `test/browser/axe-adapter.test.js`
- Modificar: `test/release-assets.test.js`
- Criar: `test/e2e/axe-mv3-csp.test.mjs`

**Passos:**

1. Adicionar dependência exata `axe-core@4.13.0` e lockfile.
2. Copiar somente os arquivos de runtime/licença verificados para `vendor/axe` e registrar SHA-256 esperado.
3. Escrever testes do adaptador para configuração, timeout, frame parcial, sanitização e normalização.
4. Implementar injeção local por `chrome.scripting.executeScript` em mundo isolado e chamada de `axe.run` sem código remoto.
5. Criar fixture CSP `script-src 'self'` e E2E que carregue a extensão real, execute axe e confirme ausência de erro/`unsafe-eval`.
6. Se a execução isolada falhar por `new Function`, investigar configuração suportada; não relaxar CSP. Manter feature gate desligado se não houver solução segura.
7. Atualizar build para incluir `vendor/axe` e licenças.
8. Executar teste unitário, E2E Chromium, `npm test` e `npm run verify`.
9. Commit: `feat: bundle axe core with MV3 CSP gate`.

## Task 5 — Integrar resultados axe ao motor híbrido

**Arquivos:**

- Criar: `src/core/normative/axe-nbr-crosswalk.js`
- Criar: `src/core/axe/normalize-axe-results.js`
- Criar: `src/core/axe/dedupe-findings.js`
- Modificar: `src/background/run-audit.js`
- Modificar: `src/core/audit.js`
- Criar: `test/axe/normalize-axe-results.test.js`
- Criar: `test/axe/dedupe-findings.test.js`
- Criar: `test/normative/axe-nbr-crosswalk.test.js`
- Modificar: `test/background/run-audit.test.js`

**Passos:**

1. Testar que `violations` mapeadas viram falhas com proveniência e que não mapeadas ficam suplementares.
2. Testar que `incomplete` vira `cantTell`, `passes` nunca aprova item ABNT e boas práticas não recebem base legal.
3. Testar sanitização de `html`, `target`, `failureSummary` e limites de tamanho.
4. Implementar crosswalk curado por ID com item ABNT, WCAG e racional.
5. Executar axe no estado pristino antes de probes e anexar erro parcial sem interromper o motor próprio.
6. Deduplicar apresentação por página/alvo/condição, preservando ambas as fontes no modelo.
7. Executar testes focados e `npm test`.
8. Commit: `feat: integrate supplemental axe findings`.

## Task 6 — Implementar regras complementares

**Arquivos:**

- Modificar: `src/core/rules/interactive.js`
- Modificar: `src/core/rules/visual.js`
- Criar: `src/core/rules/editorial.js`
- Criar: `src/core/detection/accessibility-widgets.js`
- Modificar: `src/core/audit.js`
- Modificar: `src/core/rules/registry.js`
- Modificar: `test/rules/interactive.test.js`
- Modificar: `test/rules/visual.test.js`
- Criar: `test/rules/editorial.test.js`
- Criar: `test/detection/accessibility-widgets.test.js`

**Passos:**

1. Testar link genérico com/sem contexto suficiente.
2. Testar nova aba com/sem aviso acessível e ligação ao item 5.7.6.
3. Testar texto justificado usando o contrato real corrigido.
4. Testar lorem ipsum como alerta editorial sem ABNT/lei.
5. Testar detecção local de VLibras/Hand Talk como inventário, sem inferência de conformidade.
6. Implementar regras e detectores com listas versionadas e saídas conservadoras.
7. Atualizar composição sem alterar a contagem das 130 regras normativas próprias indevidamente; regras editoriais ficam em registro separado.
8. Executar testes focados e `npm test`.
9. Commit: `feat: add contextual and editorial accessibility checks`.

## Task 7 — Adicionar CSV seguro

**Arquivos:**

- Criar: `src/core/report/csv.js`
- Modificar: `src/browser/download-artifacts.js`
- Modificar: `src/export/export-controller.js`
- Modificar: `src/export/report-export.js`
- Criar: `test/report/csv.test.js`
- Modificar: `test/browser/download-artifacts.test.js`
- Modificar: `test/export/export-controller.test.js`

**Passos:**

1. Testar uma linha por ocorrência, colunas estáveis, CRLF, aspas RFC 4180 e BOM UTF-8.
2. Testar neutralização de `=`, `+`, `-`, `@`, tab e CR sem alterar o JSON original.
3. Testar correlação de IDs entre CSV, HTML e JSON.
4. Implementar serializer puro e integração de download.
5. Atualizar recibo/estado da exportação para quatro artefatos.
6. Executar testes focados e `npm test`.
7. Commit: `feat: export safe occurrence CSV`.

## Task 8 — Redesenhar o relatório HTML interativo e jurídico

**Arquivos:**

- Modificar: `src/core/report/html.js`
- Modificar: `src/core/report/report.css.js`
- Criar: `src/core/report/report.js.js`
- Modificar: `test/report/html.test.js`
- Criar: `test/report/report-interactions.test.js`
- Modificar: `test/report/identity.test.js`

**Passos:**

1. Testar ordem: resumo → filtros → ocorrências → mapa/revisão → matriz → metodologia.
2. Testar filtros por impacto, nível, resultado, classificação, página, motor e item ABNT.
3. Testar fallback sem JS: todas as ocorrências presentes e controles explicados.
4. Testar que PDF/print mostra o conjunto completo mesmo com filtro ativo.
5. Testar o bloco consumerista fixo em cada falha aplicável, com item ABNT variável e qualificação constante.
6. Implementar cards compactos com `details`, títulos humanos, evidência agrupada e status em português.
7. Implementar JavaScript autocontido e CSP compatível, sem rede.
8. Executar testes, gerar amostra, revisar visualmente no navegador escolhido e corrigir desktop/impressão.
9. Commit: `feat: prioritize and filter interactive audit report`.

## Task 9 — Criar mapa visual de prévias de anúncio

**Arquivos:**

- Criar: `src/browser/annotation-map.js`
- Modificar: `src/background/run-audit.js`
- Modificar: `src/core/report/html.js`
- Modificar: `src/core/report/report.css.js`
- Criar: `test/browser/annotation-map.test.js`
- Modificar: `test/background/run-audit.test.js`
- Modificar: `test/report/html.test.js`

**Passos:**

1. Testar seleção de elementos significativos e numeração estável por página.
2. Testar posicionamento de marcadores dentro dos limites e legenda sem truncamento silencioso.
3. Testar páginas longas, sobreposição, elementos sem retângulo e limites declarados.
4. Implementar composição Canvas/OffscreenCanvas ou CDP local sem dependência externa.
5. Preservar captura original e gerar artefato derivado com hash e relação de proveniência.
6. Incluir figura e legenda no HTML/PDF com rótulo “Mapa visual da prévia de anúncios”.
7. Executar testes e revisão visual com fixture real.
8. Commit: `feat: add annotated accessible announcement map`.

## Task 10 — Implementar personas reversíveis

**Arquivos:**

- Criar: `src/personas/content.js`
- Criar: `src/personas/screen-reader-module.js`
- Criar: `src/personas/personas.css`
- Criar: `src/background/persona-controller.js`
- Modificar: `src/background/service-worker.js`
- Modificar: `src/panel/index.html`
- Modificar: `src/panel/panel.js`
- Modificar: `src/panel/panel-state.js`
- Modificar: `src/panel/panel.css`
- Criar: `test/personas/persona-controller.test.js`
- Criar: `test/personas/content.test.js`
- Criar: `test/personas/screen-reader-module.test.js`
- Modificar: `test/panel/panel-state.test.js`

**Passos:**

1. Testar máquina de estados por aba, exclusividade/combinação definida e limpeza em navegação/fechamento.
2. Testar o módulo Leitura simulada: fila determinística, foco e prévia, iniciar, pausar/continuar, parar, repetir, anterior/próximo, cancelamento de fala anterior, legenda sincronizada, voz/velocidade locais, indisponibilidade de `speechSynthesis` e exclusão de valores sensíveis.
3. Testar acromatopsia: classe/filtro reversível e ausência de resultado normativo.
4. Testar modo motor: bloqueio de pointer/mouse/touch/wheel, preservação do teclado e saída por três `Escape`.
5. Implementar conteúdo injetado localmente e controlador no service worker.
6. Adicionar painel simples com três modos e, para Leitura simulada, controles de reprodução/navegação, voz, velocidade, instrução, legenda e estado ativo.
7. Executar testes e E2E manual/automatizado na aba de fixture.
8. Commit: `feat: add reversible accessibility persona previews`.

## Task 11 — Adicionar menu de contexto

**Arquivos:**

- Modificar: `manifest.json`
- Modificar: `src/background/service-worker.js`
- Modificar: `src/panel/panel-state.js`
- Modificar: `src/panel/panel.js`
- Modificar: `test/background/service-worker.test.js`
- Modificar: `test/panel/panel-state.test.js`
- Modificar: `test/extension-shell.test.js`

**Passos:**

1. Testar criação idempotente dos dois itens de contexto.
2. Testar filtragem para HTTP/HTTPS e preenchimento de página/link.
3. Implementar permissão `contextMenus`, `onInstalled` e `onClicked`.
4. Reutilizar o painel e a validação existentes, sem duplicar runner.
5. Executar testes focados, `npm test` e inspeção do manifesto.
6. Commit: `feat: start audits from the context menu`.

## Task 12 — Implementar lote explícito multipáginas

**Arquivos:**

- Criar: `src/core/batch/normalize-url-list.js`
- Criar: `src/background/run-batch.js`
- Modificar: `src/background/service-worker.js`
- Modificar: `src/background/session.js`
- Modificar: `src/panel/index.html`
- Modificar: `src/panel/panel.js`
- Modificar: `src/panel/panel-state.js`
- Modificar: `src/core/report/enrich-audit.js`
- Criar: `test/core/normalize-url-list.test.js`
- Criar: `test/background/run-batch.test.js`
- Modificar: `test/background/service-worker.test.js`
- Modificar: `test/report/enrich-audit.test.js`

**Passos:**

1. Testar normalização, deduplicação, ordem, máximo 20 e erros por linha.
2. Testar scheduler sequencial, continuação após falha, cancelamento e estado parcial.
3. Testar IDs estáveis de página e consolidação de ocorrências/evidências.
4. Implementar runner que reutiliza `runAudit` por URL e agrega sem misturar evidências.
5. Atualizar painel para modo página única/lista, progresso `n de total` e resumo de falhas.
6. Persistir estado explicativo mínimo; não prometer retomada completa após suspensão.
7. Executar testes focados, `npm test` e integração com três fixtures.
8. Commit: `feat: audit explicit URL batches sequentially`.

## Task 13 — Implementar retenção e exclusão

**Arquivos:**

- Modificar: `src/storage/audit-store.js`
- Modificar: `src/export/index.html`
- Modificar: `src/export/index.js`
- Modificar: `src/export/export.css`
- Modificar: `src/core/privacy.js`
- Modificar: `docs/POLITICA-DE-PRIVACIDADE.md`
- Modificar: `test/storage/audit-store.test.js`
- Modificar: `test/export/export-page.test.js`

**Passos:**

1. Testar metadados de retenção, limpeza após 30 dias, exclusão individual e exclusão total.
2. Testar opção “não reter após exportar” e confirmação das ações destrutivas.
3. Implementar índices/migração IndexedDB e limpeza incremental segura.
4. Adicionar controles simples de exclusão e texto claro sobre pixels/URLs locais.
5. Atualizar política de privacidade e verificar coerência com o comportamento.
6. Executar testes focados e `npm test`.
7. Commit: `feat: limit local audit retention and add deletion controls`.

## Task 14 — Atualizar versão, documentação, E2E e pacote

**Arquivos:**

- Modificar: `manifest.json`
- Modificar: `README.md`
- Modificar: `docs/USO-FISCAL.md`
- Modificar: `scripts/verify-project.mjs`
- Criar: `scripts/e2e-chromium.mjs`
- Modificar: `test/integration/project-delivery.test.js`
- Modificar: `test/release-package.test.js`
- Modificar: `test/release-assets.test.js`

**Passos:**

1. Mover o E2E Chromium para caminho versionado e substituir toda referência obsoleta de identidade.
2. Atualizar versão para `2.0.0` e documentar instalação, uso, lote, personas, limites e exportações.
3. Atualizar verificador para modelo V2, axe/licenças, HTML/PDF/JSON/CSV, CSP e neutralidade.
4. Executar `npm test`.
5. Executar `npm run verify`.
6. Executar o E2E Chromium real em fixtures representativas.
7. Executar `npm run build:release` duas vezes e comparar SHA-256 para reprodutibilidade.
8. Inspecionar conteúdo do ZIP e ausência de código remoto/arquivos indevidos.
9. Commit: `release: prepare Audita Acessibilidade 2.0.0`.

## Task 15 — Revisão independente e correções finais

**Arquivos:** todos os alterados acima.

**Passos:**

1. Solicitar revisão independente de conformidade com esta especificação.
2. Corrigir qualquer lacuna confirmada com TDD e executar testes relevantes.
3. Solicitar revisão independente de qualidade, segurança, privacidade e alegações.
4. Corrigir achados confirmados e repetir a suíte completa.
5. Fazer QA visual no navegador escolhido: painel, filtros, cards, mapa, personas e impressão/PDF.
6. Confirmar `git status`, commit final e registrar SHA-256 do pacote.
7. Não enviar nova versão à Chrome Web Store até a confirmação final exigida imediatamente antes da ação pública.

## Comandos finais de verificação

```sh
npm test
npm run verify
node scripts/e2e-chromium.mjs
npm run build:release
shasum -a 256 release/audita-acessibilidade-2.0.0.zip
git status --short
```

## Resultado esperado

Um ZIP MV3 reproduzível da versão 2.0.0, totalmente local e sem login, com artefatos HTML/PDF/JSON-LD/CSV, motor híbrido rastreável, lista multipáginas limitada, três simulações reversíveis, mapa visual de prévias, retenção controlável e bloco jurídico constante apenas nas desconformidades técnicas aplicáveis.
