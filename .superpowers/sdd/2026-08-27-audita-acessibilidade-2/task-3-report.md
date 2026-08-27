# Task 3 — Evoluir o modelo canônico para V2

## Resultado

Implementado o modelo canônico de relatório V2, com migração explícita de entradas V1, páginas múltiplas, ocorrências com proveniência e referências por catálogo, evidências como lista raiz e EARL consolidado sem perder as 146 asserções ABNT.

## Implementação

- `createAuditModel` agora produz e valida somente a saída canônica `schemaVersion: 2`; entradas `schemaVersion: 1` passam por `migrateAuditV1ToV2`/`migrateV1Record` antes da validação V2.
- A raiz V2 contém `auditId`, `requestedScope`, `pages`, `occurrences`, `evidence`, `integrity` e `limitations`, preservando os metadados consolidados e aliases legados necessários aos consumidores atuais.
- `requestedScope.urls` e `pages[].requestedUrl` são sanitizados e devem corresponder exatamente, na mesma ordem. `pageId` é único; ocorrências e evidências só podem apontar para páginas existentes e uma ocorrência não pode usar evidência de outra página.
- Ocorrências validam `classification`, `impact`, `confidence`, `source`, `nbrItemRef`, `wcagRefs`, `foreignBenchmarkRefs`, `target`, `accessiblePreview`, `evidenceRefs` e `legalAnalysis`.
- Referências WCAG permanecem IDs do catálogo ABNT; referências Section 508 usam somente IDs/critério/nível do catálogo estrangeiro congelado; a análise jurídica guarda somente `{ basisRef }` para o catálogo consumerista.
- Toda ocorrência `failed` conclusiva ligada a item ABNT — requisito ou recomendação — recebe exatamente `br.consumer.accessibility.fixed.v1`. Recomendações permanecem classificadas como `recommendation`. `cantTell`, `untested`, `inapplicable`, boas práticas e editoriais não recebem análise jurídica.
- Campos automáticos de conclusão jurídica (`violatedLaw`, `illegal`, `liability`, `sanction`) são proibidos.
- `methodology.coreRuleCount` continua exatamente 130; `supplementalRuleCount` permite regras adicionais e `ruleCount` deve ser a soma. Os 146 itens ABNT e todos os seus metadados continuam validados exatamente.
- `createRuleResult` e a agregação preservam metadados V2 opcionais de proveniência, classificação, impacto e confiança sem alterar o contrato de resultados legados.
- O enriquecimento calcula o hash canônico sobre o V2 já normalizado, com `integrity.canonicalModelHash` omitido, inclui `pageId` no manifesto de evidências e preserva escopo de lote explícito.
- O EARL continua com exatamente 146 asserções `urn:abnt:nbr17225:*`. Em lote, elas usam um sujeito consolidado explícito com a lista de páginas; `pageId` permanece nos ponteiros. IDs jurídicos e estrangeiros ficam no modelo, não viram asserções normativas brasileiras.
- A fixture de auditoria passou a ser V2 nativa. HTML, revisão e testes consumidores foram adaptados de `evidence.artifacts` para `evidence[]`.

## TDD — RED observado

1. Contrato V2 inicial:

   `node --test test/core/result.test.js test/report/audit-model-v2.test.js test/report/enrich-audit.test.js test/report/earl-json.test.js`

   Saída: exit `1`; `2` passaram e `6` falharam. Falhas esperadas: exports `CLASSIFICATIONS`/`V1_MIGRATION_DEFAULTS` ausentes, EARL ainda em schema 1, `pageId` ausente e enriquecimento ainda retornando evidência V1.

2. Proveniência na agregação:

   `node --test test/rules/engine.test.js --test-name-pattern='preserves V2 provenance'`

   Saída: exit `1`; `38` passaram e `1` falhou, com `actual undefined` para `ruleResults[0].source`.

3. Integridade explícita e aliases V2:

   `node --test test/report/audit-model-v2.test.js`

   Saída: exit `1`; `3` passaram e `2` falharam: `integrity` V1 ausente e fila de revisão sem projeção de `itemId`.

4. Vocabulários na API pública:

   `node --test test/core/result.test.js --test-name-pattern='public core boundary'`

   Saída: exit `1`; `9` passaram e `1` falhou porque `core.CLASSIFICATIONS` era `undefined`.

5. Hash V1 calculado sobre o contrato errado:

   `node --test test/report/enrich-audit.test.js --test-name-pattern='re-enriches native V2'`

   Saída: exit `1`; `3` passaram e `1` falhou; hash armazenado `29eae2...` diferiu do SHA-256 do V2 final `b905a7...`.

6. Correspondência entre escopo solicitado e páginas:

   `node --test test/report/audit-model-v2.test.js --test-name-pattern='accepts native multipage'`

   Saída: exit `1`; `4` passaram e `1` falhou com `Missing expected exception` para página não solicitada.

7. Escopo multipágina no enriquecimento:

   `node --test test/report/enrich-audit.test.js --test-name-pattern='preserves an explicit V2 batch scope'`

   Saída: exit `1`; `4` passaram e `1` falhou: recebido `single-page-observed-state`, esperado `explicit-url-batch`.

8. Sujeito EARL consolidado multipágina:

   `node --test test/report/earl-json.test.js --test-name-pattern='multipage EARL'`

   Saída: exit `1`; `3` passaram e `1` falhou porque as asserções ainda apontavam somente para a primeira URL.

## TDD — GREEN observado

- Foco inicial: mesmo comando dos quatro arquivos principais, exit `0`, `19/19`.
- Agregação: comando focado de engine, exit `0`, `39/39`.
- Consumidores de relatório/fixture: `node --test test/report/html.test.js test/report/identity.test.js test/export/report-export.test.js`, exit `0`, `25/25`.
- Conjunto integrado: `node --test test/core/result.test.js test/rules/engine.test.js test/report/audit-model-v2.test.js test/report/enrich-audit.test.js test/report/earl-json.test.js test/report/html.test.js test/report/identity.test.js test/export/report-export.test.js`, exit `0`, `86/86`.
- Cada RED adicional acima foi repetido com o mesmo comando após a correção e terminou em exit `0`.

## Suíte completa

- Baseline antes da implementação: `npm test` → exit `0`, `388/388`.
- Primeira integração completa: `npm test` → exit `1`, `389/395`; as seis falhas eram acessos de testes à antiga fixture `evidence.artifacts`.
- Verificação final fresca após todas as correções: `npm test` → exit `0`, `400/400`, `0` falhas, `0` ignorados, duração `3252.519042 ms`.
- `git diff --check` → exit `0`, sem erros de whitespace.

## Decisões de migração

- Uma entrada V1 vira uma única página estável `page-1`; URLs, timestamps, status e viewport são copiados/sanitizados dos fatos existentes.
- Impacto e confiança nunca existiram no V1. A migração usa defaults conservadores e públicos `impact: minor` e `confidence: low`; eles não são apresentados como observações originais.
- A fonte de regras V1 usa `engine: audita-core`, o `ruleId` existente e a versão real de `versions.rules`. Revisões manuais sem regra usam o namespace explícito `audita-manual-review` e um ID técnico determinístico; não é inventada versão de navegador ou motor externo.
- A ausência de integridade no V1 vira o marcador explícito `{ algorithm: 'unavailable', status: 'not-recorded-v1' }`, nunca um hash fabricado.
- Aliases legados (`requestedUrl`, `finalUrl`, `timestamps`, `environment.viewport` e campos antigos de ocorrência) são projeções determinísticas da primeira página e dos campos V2. `requestedScope`, `pages`, `target` e `evidenceRefs` são a autoridade canônica.

## Arquivos

- Modelo e vocabulários: `src/core/report/audit-model.js`, `src/core/result.js`, `src/core/index.js`.
- Enriquecimento, agregação e EARL: `src/core/report/enrich-audit.js`, `src/core/rules/aggregate-items.js`, `src/core/report/earl-json.js`.
- Consumidores diretos da lista V2 de evidências: `src/core/report/html.js`, `src/review/review.js`.
- Fixture: `fixtures/audits/sample-audit.js`.
- Testes: `test/report/audit-model-v2.test.js`, `test/core/result.test.js`, `test/rules/engine.test.js`, `test/report/enrich-audit.test.js`, `test/report/earl-json.test.js`, `test/report/html.test.js`, `test/report/identity.test.js`, `test/export/report-export.test.js`.
- Artefato reproduzível regenerado pela suíte obrigatória: `release/audita-acessibilidade-1.0.1.zip`.

## Auto-revisão

- Confirmados 130 resultados core como contrato exato e 146 itens/asserções ABNT; regras suplementares não elevam aprovação ABNT por conta própria.
- Confirmadas imutabilidade profunda, clonagem sem mutar/congelar entrada e serialização canônica.
- Confirmados vínculos ocorrência→página→evidência e evidência derivada→captura integral.
- Confirmada sanitização de URL em escopo, páginas e aliases de compatibilidade.
- Confirmado que base legal e Section 508 são apenas referências a catálogos imutáveis, sem cópia de prosa ou criação de asserção ABNT adicional.
- Confirmado o ruling vinculante para requisitos e recomendações e a ausência de base legal em resultados inconclusivos/editoriais.
- Confirmado que o hash final realmente corresponde ao JSON V2 canônico sem `canonicalModelHash`.

## Preocupações e trabalho futuro

- Os aliases V1 permanecem para os renderizadores/revisão atuais; tarefas posteriores podem migrar integralmente a UI para os campos V2, mas removê-los agora quebraria consumidores existentes sem necessidade.
- O modelo e o enriquecimento já aceitam lote explícito; a execução/orquestração real de até 20 URLs continua pertencendo à Task 12.
- O ZIP de release foi regenerado pelo teste de entrega e inclui o runtime atual. A Task 14 ainda deverá atualizar versão, documentação e verificação final do pacote completo.

## Fix round 1

### Resultado

Corrigidas as quatro invariantes vinculantes apontadas na revisão e removido do escopo da Task 3 o artefato de release gerado pela suíte. Esta seção substitui a afirmação anterior de que o ZIP regenerado faria parte desta tarefa.

### Implementação

- Evidências V1, V2 nativas e enriquecidas agora atravessam `sanitizeEvidenceArtifactUrls`. A fronteira aplica o sanitizador de URL já existente recursivamente a campos nomeados como URL/URI e atributos URL conhecidos (`src`, `href`, `currentSrc`, `poster`, entre outros), inclusive metadados aninhados. Query params sensíveis, userinfo, hashes sensíveis e protocolos inseguros não sobrevivem; `dataUrl` de imagem continua sendo o conteúdo de evidência permitido pelo contrato.
- O enriquecimento calcula o hash de cada artefato somente após essa sanitização, impedindo divergência entre o conteúdo canônico persistido e seu hash.
- Uma regra `passed` só pode vincular um item ABNT quando seu `ruleId` pertence ao `item.ruleIds` autoritativo. Uma ocorrência ABNT `passed` também exige a mesma regra autoritativa com resultado `passed`; um item agregado `passed` exige resultado autoritativo correspondente ou revisão humana registrada.
- Na fronteira V1, uma alegação `passed` suplementar é migrada conservadoramente para `cantTell` na regra, ocorrência e item afetado, em vez de aprovar ou rejeitar todo o registro legado. Falhas e `cantTell` suplementares continuam aceitos.
- Evidência derivada e sua `fullPageEvidenceId` agora devem ter o mesmo `pageId`, além de o alvo existir e ser `full-page`.
- `integrity.evidenceManifestHash` passou a ser calculado depois da normalização/migração V2, usando os `pageId` finais e os artefatos já sanitizados. O hash canônico final é então calculado sobre esse modelo com o manifesto definitivo.
- A fixture V2 e o helper V1 foram corrigidos para que o único passe automático demonstrativo use IDs de regras autoritativas; a fixture mantém cobertura de todos os outcomes EARL sem passes suplementares.
- `release/audita-acessibilidade-1.0.1.zip` foi restaurado exatamente do blob de `c19a9dd`, em vez de manter a saída produzida pelo teste de release.

### TDD — RED observado

1. Quatro regressões da revisão:

   `node --test test/report/audit-model-v2.test.js test/report/enrich-audit.test.js`

   Saída: exit `1`, `10/14` passaram e `4/14` falharam. Falhas observadas: `mediaUrl` ainda continha `token=TOPSECRET`; a regra/ocorrência suplementar `passed` não lançou exceção; a evidência derivada entre páginas não lançou exceção; o manifesto armazenado `c39baa...` diferiu do manifesto do V2 final `a40a18...`.

2. Compatibilidade V1 conservadora para passe suplementar:

   `node --test --test-name-pattern='conservatively downgrades' test/report/audit-model-v2.test.js`

   Saída: exit `1`, `0/1`; a ocorrência migrada falhou com `possui vínculo de item incoerente` em vez de ser aceita como `cantTell`.

### TDD — GREEN observado

- Regressões focadas: `node --test test/report/audit-model-v2.test.js test/report/enrich-audit.test.js` → exit `0`, `15/15`.
- Cobertura integrada de relatório, revisão e fixtures: `node --test test/report/*.test.js test/review/decisions.test.js test/integration/audit-fixtures.test.js` → exit `0`, `59/59`.
- `git diff --check` → exit `0`, sem erros.

### Suíte completa

- Execução única após os GREENs focados: `npm test` → exit `0`, `405/405`, `0` falhas, `0` ignorados, duração `3197.209333 ms`.
- A suíte regenerou o ZIP como esperado. Depois dela, `git checkout c19a9dd -- release/audita-acessibilidade-1.0.1.zip` restaurou o binário autorizado.
- Verificação de blob: `git hash-object release/audita-acessibilidade-1.0.1.zip` e `git rev-parse c19a9dd:release/audita-acessibilidade-1.0.1.zip` retornaram ambos `091a60566be173834d1fbeaa3042151601469598`.

### Arquivos do fix

- Produção: `src/core/report/audit-model.js`, `src/core/report/enrich-audit.js`.
- Fixture/helper: `fixtures/audits/sample-audit.js`, `test/report/helpers.js`.
- Regressões: `test/report/audit-model-v2.test.js`, `test/report/enrich-audit.test.js`.
- Restauração exata: `release/audita-acessibilidade-1.0.1.zip`.

### Auto-revisão e decisões de migração

- O sanitizador é aplicado na fronteira canônica V2 e antes do hash no enriquecimento; a operação é idempotente, não muta a entrada e continua sujeita ao deep freeze final.
- Campos terminados em `dataUrl` foram deliberadamente tratados como bytes incorporados de evidência, não como navegação. URLs de recurso em `mediaUrl`, `resourceUrl`, `src`, `currentSrc`, `href`, `poster` e equivalentes continuam sanitizadas pelo comportamento de privacidade existente.
- O downgrade V1 para `cantTell` é a escolha de compatibilidade mais estreita: conserva o registro legado e sua proveniência sem transformar uma regra suplementar em autoridade normativa.
- Regras suplementares continuam livres para relatar `failed`/`cantTell` e ocorrências editoriais; somente a elevação automática a `passed` ABNT foi bloqueada.
- A validação 130→146, as 146 asserções EARL, a base consumerista fixa para falhas conclusivas, referências Section 508 separadas, imutabilidade, serialização canônica e o grafo ocorrência→evidência permaneceram cobertos pela suíte.

### Preocupações

- O reconhecimento de campos URL-bearing é estrutural por nomes canônicos/convencionais. Novos campos de evidência com nomes opacos deverão ser incluídos explicitamente no contrato ou normalizados antes dessa fronteira.
- O teste de release continuará regenerando o ZIP durante suítes futuras; tarefas que não sejam de release devem restaurar/verificar o blob deliberadamente antes do commit.
