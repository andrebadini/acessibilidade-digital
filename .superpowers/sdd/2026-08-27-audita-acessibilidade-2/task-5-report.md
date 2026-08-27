# Task 5 report — integração suplementar axe

## Resultado

O pipeline de página agora chama `runAxeInTab` após a captura original e antes da coleta/probes, normaliza o resultado em uma fronteira hostil e o agrega ao motor próprio sem transferir autoridade normativa ao axe. O gate de produção e `target-size` permanecem desativados. Nesse estado, `AXE_FEATURE_DISABLED` vira limitação explícita e limitada, sem sondagem e sem interromper o motor Audita.

Foram adicionados:

- crosswalk curado de 35 IDs de regra axe para item ABNT/WCAG, sempre com confirmação de aplicabilidade obrigatória;
- normalização limitada por página/frame, versão/config/proveniência exatas e descarte integral de `html`, `failureSummary`, mensagens de checks e tags recebidas do axe;
- `violations` confirmadas como `failed`, `incomplete` como `cantTell`, violações sem confirmação como `cantTell` e achados sem mapeamento como suplementares sem ABNT/lei;
- resumo técnico de `passes`/`inapplicable` sem criar resultados aprovados;
- referências Section 508 somente pelo catálogo revisado separado, derivadas dos critérios WCAG curados;
- agregação conservadora dos itens ABNT e base consumerista fixa somente em falha conclusiva confirmada;
- deduplicação apenas de apresentação, por chave de condição e alvo canônicos, mantendo todas as ocorrências e fontes;
- preservação de seletor, impacto, confiança e alvo axe na migração V1→V2;
- contenção de accessors hostis, arrays esparsos gigantes, limites de frames/grupos/nós/ocorrências e diagnósticos parciais.

## Aplicabilidade e deduplicação

O normalizador não aceita `confirmed: true` fornecido por um chamador como prova. A confirmação é derivada internamente do Snapshot e exige regra Audita autoritativa do mesmo item e versão `1.0.0`. Nesta tarefa, apenas as condições documentais inequívocas `html-has-lang`/`page-language` e `document-title`/`page-title` recebem confirmação automática. Regras ambíguas, como `image-alt`, permanecem `cantTell` até existir prova contextual vinculada ao alvo.

As equivalências entre motores são explícitas no catálogo. O runner atribui uma identidade compartilhada de documento ou, para elementos, promove um seletor ao node ID somente quando a evidência Audita resolve esse seletor de forma única. O teste de integração demonstra um grupo visual com as fontes `audita-core` e `axe-core`, enquanto as duas ocorrências continuam armazenadas.

## Evidência TDD

RED observado:

- três suítes iniciais falharam com `ERR_MODULE_NOT_FOUND` para crosswalk, normalizador e deduplicador;
- `test/core/audit.test.js` falhou porque `mergeAxeSupplementalResults` ainda não era exportado;
- integração de background falhou com `model.axe` ausente, 130 em vez de 131 regras e estado incorretamente completo após exceção axe;
- teste de Section 508 falhou porque o achado confirmado ainda tinha `foreignBenchmarkRefs: []`;
- teste de deduplicação falhou ao colapsar duas condições ARIA distintas do mesmo item/alvo;
- teste de privacidade falhou porque texto bruto axe ainda era persistido;
- teste de accessor hostil falhou executando o getter durante `Array.slice`;
- teste de integração real falhou mantendo core e axe em grupos visuais separados.

GREEN final:

- focados axe/crosswalk/dedupe: 15/15;
- focados runner/core/model/enriquecimento: 45/45;
- `npm test`: 443 aprovados, 0 falhas, 1 skip explícito do E2E MV3/CSP;
- `npm run verify`: exit 0, 443 aprovados, 0 falhas, 1 skip explícito; verificador confirmou manifesto/CSP, vendor axe 4.13.0 gated, 130 regras próprias, 146 itens, identidade neutra, artefatos e privacidade.

## Arquivos principais

- `src/core/normative/axe-nbr-crosswalk.js`
- `src/core/axe/normalize-axe-results.js`
- `src/core/axe/dedupe-findings.js`
- `src/core/audit.js`
- `src/background/run-audit.js`
- `src/core/report/audit-model.js`
- testes correspondentes em `test/axe`, `test/normative`, `test/core` e `test/background`.

## Segurança, release e estado externo

- `AXE_MV3_CSP_GATE.enabled === false` e `targetSizeEnabled === false` permanecem inalterados.
- Nenhuma CDN, rede de aplicação, telemetria, login, backend, `unsafe-eval` ou código remoto foi introduzido.
- Nenhuma ação foi executada na Chrome Web Store.
- O ZIP rastreado `release/audita-acessibilidade-1.0.1.zip` foi restaurado após os testes; SHA-256 final: `987acb65524093d0cae4b263277786ab7718d375e53112b4e63bbf0687a56e9a`.

## Limitação intencional

A execução axe de produção continua desativada até um E2E Chromium MV3/CSP conclusivo. A integração está pronta e testada com resultados sintéticos sanitizados, mas não altera esse gate. Mapeamentos sem prova contextual vinculada não produzem falha ABNT nem base legal.

## Fix round 1 — integridade do suplemento axe

O limite de confiança foi centralizado em `validateNormalizedAxeSupplemental`, usado tanto pela agregação do motor quanto pela migração/validação do relatório. O contrato exige a proveniência, versão e configuração exatas do pacote; identidade `axe.<engineRuleId>`; crosswalk curado; item, WCAG e classificação exatos; e, para uma falha normativa, prova Audita autoritativa vinculada à condição, página, frame e alvo. A base jurídica fixa só é aceita nessa falha conclusiva. Clusters inconsistentes são rejeitados integralmente, inclusive `cantTell` forjado, regra falsa, versão/configuração divergente, texto privado adicional e coleções acima dos limites.

A topologia efetiva agora prevalece sobre o status declarado. Frames falhos, ausentes, duplicados, resultados ausentes, diagnósticos de timeout/falha e truncamento tornam a execução parcial com limitação explícita. O adaptador conserva apenas contagens limitadas de grupos, nós e checks (`original`, `retained`, `truncated`), sem reintroduzir texto da página. A leitura de targets aninhados e das coleções de validação usa descritores e contém accessors, arrays esparsos e proxies revogados.

A deduplicação visual deixou de confiar em `equivalenceKey`, `presentationTargetKey` ou seletor declarados. Ela exige o par Audita↔axe, versões, regra, item e condição do crosswalk. Equivalências documentais exigem alvo superior `html`; achados ambíguos, versões falsas, itens diferentes e condições ARIA distintas permanecem separados. Todas as ocorrências e fontes continuam armazenadas.

### Evidência TDD do fix round

RED observado:

- o novo teste do validador falhou inicialmente com `ERR_MODULE_NOT_FOUND`;
- cobertura/topologia falhou ao conservar `status: complete` diante de timeout, frames duplicados/falhos/ausentes e truncamento;
- target hostil executou getter aninhado e proxy revogado lançou `TypeError`;
- adaptador não expôs metadados de truncamento nos limites de 100 grupos/nós e 32 checks;
- relatório aceitou inicialmente summary/justificativa privados, item agregado divergente, regra axe falsa e prova com página/frame/alvo divergentes;
- deduplicação confiava nas chaves fornecidas e não comprovava o par curado.

GREEN final:

- focados (`axe`, adaptador, core e runner): 56/56;
- `npm test`: 452 aprovados, 0 falhas, 1 skip explícito (`AXE_MV3_CSP_E2E_UNAVAILABLE`), 453 testes;
- `npm run verify`: exit 0, mesmos 452 aprovados/1 skip; manifesto/CSP, vendor axe 4.13.0 gated, 130/146, identidade neutra, HTML/JSON/PDF e privacidade verificados;
- ZIP rastreado restaurado exatamente: SHA-256 `987acb65524093d0cae4b263277786ab7718d375e53112b4e63bbf0687a56e9a`.

O gate de produção e `target-size` permanecem desativados. Nenhuma Web Store, CDN, telemetria, login, backend, código remoto ou `unsafe-eval` foi alterado.

## Fix round 2 — fechamento do payload canônico

O normalizador passou a conter proxies revogados também nas coleções superiores (`frames`, `diagnostics`, grupos de resultado e `nodes`), na proveniência e no Snapshot usado para confirmar aplicabilidade. Todas as decisões sobre arrays usam leitura protegida; um payload bruto hostil é reduzido a um resultado canônico parcial antes de entrar no relatório.

O contrato `model.axe` agora é completo mesmo sem achados ou com o gate desativado: sete chaves superiores exatas, proveniência/configuração fixas, status, diagnósticos sem campos adicionais, limitações de catálogo, quatro contagens técnicas limitadas e coerentes, regras e ocorrências. Campos desconhecidos ou texto privado invalidam o cluster inteiro. O sanitizador estrutural e a lista nativa de tags do adaptador foram exportados e reutilizados pelo normalizador e pelo validador; seletores com tags inventadas, como `patient-hiv-positive`, não atravessam a fronteira.

Regras do relatório devem ser idênticas ao registro normalizado. Ocorrências permitem diferenças apenas nos vínculos de evidência e na expansão normativa V2 validada. A migração preserva o subconjunto WCAG curado do axe como origem e expande a ocorrência V2 para todas as referências WCAG do item ABNT, derivando Section 508 somente pelo catálogo revisado separado. Foram cobertos `input-image-alt`, `meta-viewport`, `aria-roles` e `frame-title`.

Uma ocorrência axe conclusiva com a base consumerista fixa deve referenciar uma captura integral `pristine` da mesma página quando ela existe. A ausência só é aceita com o diagnóstico fixo e limitado de falha da captura, ou com a limitação fixa prevista no contrato; códigos acompanhados de texto arbitrário não autorizam a ausência da evidência.

### Evidência TDD do fix round 2

RED observado:

- `Array.isArray` lançou `TypeError` em `frames` revogado antes da normalização;
- payload axe desativado com campo privado, diagnóstico adulterado, status/limitação divergentes ou resumo técnico forjado foi aceito;
- o validador aceitou `patient-hiv-positive` como seletor estrutural;
- regras/ocorrências do relatório aceitaram campos privados adicionais;
- a ocorrência jurídica continuou válida após remoção da captura integral original;
- os quatro mapeamentos incompletos com referências WCAG adicionais no item ABNT falharam na migração V2.

GREEN final:

- focados de axe, adaptador, core, runner e relatório: 86/86;
- `npm test`: 463 aprovados, 0 falhas e 1 skip explícito de E2E MV3/CSP, 464 testes no total;
- `npm run verify`: exit 0 com os mesmos 463 aprovados/1 skip e confirmação de manifesto/CSP, axe 4.13.0 gated, 130/146, identidade neutra, artefatos e privacidade;
- o repositório não contém `scripts/verify.sh`; o verificador disponível e autoritativo é `scripts/verify-project.mjs`, executado por `npm run verify`.

O gate axe e `target-size` continuam desativados, sem mutação da Web Store ou introdução de rede, telemetria, login, backend, código remoto ou `unsafe-eval`.
