# Task 7 — relatório de implementação

Data: 2026-08-30

Base aprovada: `ebb8b6a` (com ledger posterior `a3e1504`)

Commit previsto: `feat: authorize complete visual reports`

## Resultado

A Task 7 passa a produzir uma única projeção imutável `ReportViewV1`, usada pela revisão visual e pelos artefatos HTML/PDF, preservando a mesma revisão canônica para CSV/JSON. O fluxo de relatório e exportação agora é autorizado pelo worker, não recebe modelo, bytes, formatos ou poderes pela URL/DOM e remove a via legada de exportação.

O relatório vivo contém exatamente sete `h2`, na ordem definida pelo brief. Os filtros só alternam `hidden` no DOM existente e não alteram a projeção nem os artefatos. A base consumerista mantém a fórmula fixa e sua qualificação imediatamente adjacente por ocorrência elegível, com exatamente duas fontes oficiais da Câmara dos Deputados; o catálogo normativo técnico permanece separado.

## TDD — RED

Comando inicial:

```text
node --test test/review/report-view.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/legal/consumer-basis.test.js
```

Resultado genuíno: `0/4` arquivos passaram. As falhas eram as ausências esperadas de `report-view.js`, `report-launch.js`, `export-launch.js` e dos novos contratos consumeristas/exportados. Nenhum código de produção da Task 7 existia quando esse RED foi registrado.

## Implementação e GREEN focado

- `ReportViewV1` valida e copia o modelo canônico, exige hash/revisão correlatos, congela recursivamente os datasets e expõe a matriz fixa de 146 critérios.
- A revisão renderiza exatamente sete seções `h2`; HTML/PDF recebem a mesma projeção. O HTML legado permanece somente como fronteira de compatibilidade dos testes antigos e não é fonte paralela no fluxo autorizado.
- `EXPORT_FORMATS_V1` vive em um módulo-folha sem dependências, é congelado e importado/reexportado pelas superfícies; a única ordem é `html,pdf,csv,json`, sem ciclo ESM.
- `REPORT_CONNECT`, `REPORT_REQUEST_EXPORT`, `EXPORT_CONNECT` e `EXPORT_COMPLETE` passam pelo único protocolo/router/listener/lifecycle. A URL de exportação contém somente o `auditId` canônico.
- O consumidor reconstrói a revisão persistida, verifica integridade, inventário e correlação antes de gerar. Os recibos usam os bytes exatos entregues ao `Blob`, com MIME, tamanho, SHA-256, download ID e estado por formato.
- A reserva e a transição `running -> delivering` são CAS no store compartilhado, inclusive entre instâncias IndexedDB. Tentativa é string decimal canônica; reentrada, recarga e primeira conexão ficam correlatas ao documento/sessão.
- A conclusão relê o recibo terminal persistido e aceita uma única terminalização autenticada; falhas parciais nunca satisfazem o recibo completo nem liberam a conclusão.

GREEN focado final do brief, sequencial:

```text
214/214 passaram — 16 arquivos — 22,996 s
```

Após o ajuste final da fronteira de conclusão do worker:

```text
19/19 passaram — service-worker + export-launch
```

Evidência específica adicional: projeção/legal `8/8`; report launch `3/3`; export launch `2/2`; lifecycle `3/3`; export page `1/1`; bytes/hash/download `33/33`; receipt/store `1/1`; worker/protocol `29/29`; router/export page `16/16`.

## Compatibilidade e gate não legado

Compatibilidade relevante, sequencial:

```text
163/163 passaram
```

Cobriu protocolo de compatibilidade retido, store, decisões de revisão, estado/sessão/bundle do painel e política de relatório. Shell/release/identity: `14/14` passaram.

O gate não legado foi executado uma única vez, conforme o brief:

```text
1441/1444 passaram
```

As três falhas eram assertions/fixtures antigas, não falhas do runtime: uma regex ainda exigia a qualificação jurídica anterior e duas fixtures positivas de `audit-model-v2` usavam a ordem parcial antiga `html,json,csv`. As fixtures foram alinhadas à subsequência canônica `html,csv,json` e a asserção legal passou a comparar a fórmula fixa integral. Reprodução isolada pós-correção: `3/3` passaram. O gate completo não foi repetido, por instrução explícita do controlador; portanto este relatório não representa a reprodução isolada como um segundo full verde.

## Evidência visual, responsiva e de acessibilidade

Os testes determinísticos comprovam os sete títulos, filtros sem mutação, conteúdo legal adjacente, matriz 146, identidade dos quatro formatos e ausência de segredos/autoridade em URL e DOM. A folha da revisão preserva alvos de 44 px, foco visível, comportamento responsivo, forced-colors e reduced-motion já cobertos pela suíte do shell/revisão.

Não foi feita captura real do Chrome nesta execução. A comparação visual em navegador real, incluindo larguras 320/380/480–520/600 e zoom de 200%, permanece para a QA do controlador. Nenhuma captura sintética ou evidência visual foi inventada.

## Privacidade, segurança e autocrítica

- URL de relatório/export contém um único `auditId`; capability, owner, attempt, revision, URL auditada e tokens não são serializados nela.
- UI não fornece modelo, bytes, formatos ou decisão de exclusão ao worker.
- O worker relê recibo durável e valida a identidade dos quatro downloads antes de terminalizar.
- Hashes são calculados sobre os bytes exatos; nomes derivam de `auditId` e instante canônico, nunca de hostname/URL.
- O único risco de evidência remanescente é a ausência de comparação visual real nesta execução. A cobertura funcional e estrutural é determinística, mas não substitui a inspeção do Chrome real prevista para a próxima QA.

## Verificação de fechamento

- `git diff --check`: limpo.
- Arquivos de produção passam por `node --check` no fechamento.
- Staging é explícito apenas para arquivos Task 7 e este relatório.
- `node_modules/` permanece não rastreado e não será staged.

## Fechamento de revisão — 2026-08-30

Revisão independente do diff rastreado contra `1c0a648`, confrontada com o brief da Task 7: foi encontrado e corrigido um desvio real no limite de autoridade de conclusão. Após uma primeira `EXPORT_COMPLETE` autenticada, o estado terminal estava respondendo sucesso idempotente à mesma capability; o contrato exige uma única conclusão e negação explícita da repetição. O teste foi primeiro alterado para exigir `{ok:false,code:'EXPORT_COMPLETE_DENIED'}` na segunda chamada: RED genuíno (a implementação devolvia `{ok:true,auditId,state:'terminal'}`); a guarda de `connected`/`active` foi então mantida como condição exclusiva e o teste ficou GREEN.

Evidência final focada (sem Chrome real e sem suíte completa):

```text
node --test [16 arquivos focados da Task 7]
229/229 passaram — 15,138 s
git diff --check
limpo
node --check [13 módulos de produção alterados]
limpo
```

Autocrítica: a revisão cobriu o contrato de bytes/receipt, formato canônico, lease e transições de autoridade pelos testes determinísticos, mas não substitui a QA visual em Chrome real nem reexecuta o gate não legado completo; ambos foram deliberadamente excluídos deste fechamento. O staging posterior é explícito apenas dos 24 arquivos rastreados da Task 7 e deste relatório; `node_modules/` e os cinco itens não rastreados da Task 8 ficam intocados.

## Correções da revisão independente — rodada 1

- `REPORT_REQUEST_EXPORT` não devolve mais `attemptId`; a tentativa continua exclusivamente no registro privado até `EXPORT_CONNECT` provar o primeiro documento. O teste de envelope registrou RED (a resposta continha `attemptId`) e GREEN após removê-lo.
- A conclusão agora emite uma única mensagem saneada `EXPORT_COMPLETE` após a confirmação CAS terminal, com `auditId`, `deleted`, `status` e `exportRevision`; o teste de lifecycle registrou RED por ausência do evento e GREEN após a emissão através do adaptador do worker.
- A persistência distingue a revisão imutável normal (`review-ready`/`pending`) do modelo técnico já preparado: exige recibo integral nos quatro formatos, identidade de entrega, hashes exatos, JSON técnico correlato e atestado privado do gerador, mas não tenta impor retroativamente `preparedArtifactFormats` ao modelo armazenado.
- O arquivo-folha `src/export/export-formats.js` permanece uma expansão de escopo deliberada: evita ciclo ESM entre `report-export`, CSV/JSON/store/review e preserva uma única constante congelada; `report-export.js` a reexporta como fronteira pública. Isso é compatível com a exigência de ordem única, embora diverja da localização literal do brief.

Verificação desta rodada: `node --test test/background/export-launch.test.js test/background/service-worker.test.js test/export/export-controller.test.js test/export/export-page.test.js` — `66/66` passaram em `13,372 s`; `git diff --check` limpo. Chrome real e o gate completo continuam fora do escopo desta rodada.
