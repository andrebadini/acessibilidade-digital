# Investigação dos dois vermelhos E2E da 1.1.50

Data: 19/09/2026. macOS arm64, Chrome for Testing **152.0.7977.64**, binário direto, uma instância por vez e `--test-concurrency=1`. Nenhuma automação CUA durante as medições. Esta nota registra a investigação isolada; não substitui o resultado da suíte completa.

## Retenção

A primeira suíte completa registrou `CONTEXT_PROOF_DENIED` em `waitForReport` após abrir o relatório no cenário `enforces retention and confirmed deletion through the native Side Panel and real MV3 IndexedDB`. A repetição isolada do teste **original, sem mudanças**, passou: **1/1, 30,97 s**. A falha não foi reproduzida e sua causa permanece indeterminada. Não se alteraram timeout, asserções ou runtime para esse cenário.

## Página reativa e captura

O teste original exigia pelo menos 32 eventos de `resize`, valor derivado da medição de 246 eventos documentada no [adendo A-1 da 1.1.49](REVIEW-1.1.49-adendo.md). A investigação encontrou:

| Produto e oráculo | Delta da fixture | Eventos do observador independente | Geometria amostrada | Resultado |
| --- | ---: | ---: | --- | --- |
| 1.1.50, piso original de 32 | 4 | 4 | 1×1 → 894×749 | Reprovado, reproduzido isoladamente |
| 1.1.49 pura, `95ae78f`, piso original de 32 | 4 | — | — | Reprovado em 13,16 s |
| 1.1.50, novo oráculo geométrico | 4 | 4 | 1×1 → 894×749 | **Aprovado em 15,27 s**, incluindo declaração no relatório |
| 1.1.49 com `captureBeyondViewport:false`, mesmo novo oráculo | 0 | 0 | Nenhuma amostra | **Reprovado em 13,77 s**, como esperado |

O baseline foi extraído com `git archive 95ae78f`, sem alterações de produção. O mutante foi aplicado somente em outra cópia temporária: substituição única de `captureBeyondViewport: !clipInsideViewports(clip, metrics)` por `captureBeyondViewport: false`. O teste final foi copiado integralmente para essa árvore. O runtime principal permaneceu inalterado nesta investigação.

A contagem histórica foi obtida com `--headless=new`, conforme o adendo anterior. As rodadas desta nota usaram o binário direto com a janela fora da tela prevista pelo harness. Essa diferença de ambiente está registrada; não se atribui a ela causalidade sem uma comparação controlada adicional.

O novo teste preserva a linha de base após a estabilização do painel e exige **ambos os contadores ≥2**, uma amostra **especificamente 1×1 seguida do tamanho inicial**, restauração final do viewport, URL e rolagem preservadas, e declaração explícita do efeito no relatório. A geometria específica impede que a animação de abertura do painel satisfaça a prova. O mutante continua reprovado, atendendo ao objetivo adversarial de A-1.

Foram encontrados 246 artefatos de elemento, dos quais **138 continham PNGs realmente decodificados por `createImageBitmap`**, todos com dimensões positivas. Tamanhos medidos: 1568×172, 408×172, 160×120, 160×136, 124×136, 52×136, 684×182, 1568×248 e 1632×2012. O teste final exige a decodificação de todos os PNGs encontrados; contar apenas entradas ou prefixos `data:` não basta.

Os diagnósticos observados foram `FULL_PAGE_CAPTURE_OMITTED` (1), `BROWSER_VERSION_UNAVAILABLE` (1), `DYNAMIC_PROBES_OMITTED_PASSIVE` (1), `AXE_EXECUTION_FAILED` (1, cobertura parcial) e `ELEMENT_CAPTURE_FAILED` (108). As mesmas quantidades e os mesmos 138 PNGs válidos ocorreram no mutante baseado na 1.1.49. Esses diagnósticos não foram removidos nem convertidos em sucesso; a análise não afirma que os 246 elementos receberam imagem nem que axe teve cobertura completa.

Comandos para reprodução, com `AUDITA_E2E_CHROME` apontando ao binário informado:

```sh
node --test --test-concurrency=1 --test-name-pattern='enforces retention and confirmed deletion' test/e2e/retention-indexeddb-mv3.test.mjs
node --test --test-concurrency=1 --test-name-pattern='declares the capture resize' test/e2e/sidepanel-flow-mv3.test.mjs
```
