# Base de pesquisa — Audita MT

Data de acesso e síntese: 26 de agosto de 2026  
Uso: fundamentação interna do produto e da especificação

## Resposta executiva

Uma página HTML comum não consegue auditar e capturar qualquer URL por causa da política de mesma origem. A solução adequada é uma extensão Chromium Manifest V3, inteiramente local, que use injeção autorizada e Chrome DevTools Protocol durante auditorias iniciadas pelo usuário.

A ABNT NBR 17225:2025 possui 146 itens no checklist: 96 requisitos e 50 recomendações. A Seção 5 deve ser usada como referência principal e o Anexo C como auxílio informativo. O documento contém divergências editoriais internas; elas precisam ser preservadas e explicadas, não corrigidas silenciosamente.

Automação pode confirmar diversas falhas, mas não pode declarar sozinha conformidade integral WCAG. O produto deve usar resultados automáticos, semiautomáticos e manuais, com os estados `passed`, `failed`, `cantTell`, `inapplicable` e `untested` quando exportar dados técnicos.

Nome e descrição acessíveis são propriedades computadas e expostas pelas APIs de acessibilidade. A frase final falada não é padronizada: depende de navegador, sistema, leitor de telas, modo e preferências. Por isso o produto mostrará uma prévia de anúncio explicitamente rotulada como simulação.

## Escopo e fontes locais

- `ABNT-NBR-17225-Acessibilidade-Digital.pdf`: edição 2025, 79 páginas do arquivo, fonte primária fornecida pelo usuário.
- `resultado AMAWeb _ Avaliador.pdf`: relatório de exemplo baseado em WCAG 2.1.
- `detalhe-elemento-AMAWeb _ Avaliador.pdf`: exemplo de detalhes de imagens com `alt` vazio.
- `exibir-codigo-fonte-AMAWeb _ Avaliador.pdf`: exemplo de detalhes de contraste.

Os relatórios AMAWeb demonstram a experiência atual, mas não cobrem WCAG 2.2, evidência visual integral, nome acessível, correlação completa com a NBR ou cadeia de integridade.

## Achados normativos

- A Seção 4 define conformidade regular como atendimento de todos os requisitos e conformidade plena como requisitos mais recomendações, com justificativa razoável para recomendações não atendidas.
- O Anexo C contém 146 itens em 16 grupos.
- A extração e contagem foram verificadas programaticamente: 96 registros classificados como “Requisito” e 50 como “Recomendação”.
- Todos os critérios WCAG citados existem na WCAG 2.2; foi localizada uma divergência de nível: 5.9.4 imprime 2.4.6 como A, enquanto a WCAG classifica 2.4.6 como AA.
- A comparação da Seção 5 com o Anexo C encontrou divergências adicionais em 5.9.1, 5.9.2, na numeração de 5.12.1 e na referência cruzada de 5.9.17.

## Limites consequenciais

1. “Sem falhas automáticas” não significa “conforme”. A WCAG 2.2 exige nível completo, páginas completas, processos completos, tecnologias com suporte de acessibilidade e não interferência.
2. Amostra de páginas não sustenta declaração de conformidade de site inteiro.
3. ACT Rules são informativas e parciais; falha conclusiva pode demonstrar não conformidade do alvo, mas aprovação de uma regra isolada exige testes adicionais do critério.
4. DOM e CSS não equivalem necessariamente à árvore de acessibilidade. Quando possível, a árvore AX do navegador deve ser coletada.
5. Hash SHA-256 demonstra integridade, não autoria, momento certificado ou validade jurídica autônoma.
6. O relógio local deve ser descrito como tal.

## Ledger de alegações e fontes

| Alegação | Fonte primária | Publicação/atualização | URL | Confiança e observação |
| --- | --- | --- | --- | --- |
| WCAG 2.2 define cinco requisitos cumulativos de conformidade | W3C, WCAG 2.2 | Recomendação de 12 dez. 2024 | https://www.w3.org/TR/WCAG22/ | Alta |
| Avaliação deve definir escopo, explorar, selecionar amostra, avaliar e relatar | W3C, WCAG-EM 2.0 | Note de 23 jul. 2026 | https://www.w3.org/TR/wcag-em-2/ | Alta; metodologia informativa |
| A maior parte das verificações não é totalmente automatizável | W3C, WCAG-EM 2.0 | 23 jul. 2026 | https://www.w3.org/TR/wcag-em-2/ | Alta |
| ACT cobre regras automáticas, semiautomáticas e manuais | W3C, ACT Rules Format 1.1 | Recomendação de 5 fev. 2026 | https://www.w3.org/TR/act-rules-format/ | Alta |
| ACT Rules não são a base normativa da conformidade | W3C, About ACT Rules | acesso em 26 ago. 2026 | https://www.w3.org/WAI/standards-guidelines/act/rules/about/ | Alta |
| Nome acessível é uma string computada a partir do DOM e da semântica | W3C, AccName 1.1 | Recomendação de 18 dez. 2018 | https://www.w3.org/TR/accname-1.1/ | Alta e estável |
| AccName 1.2 acrescenta/ajusta descrição e está em evolução | W3C, AccName 1.2 | Working Draft de 29 mai. 2026 | https://www.w3.org/TR/accname-1.2/ | Média-alta; não tratar como Recommendation |
| Anúncio final varia conforme mapeamentos e tecnologia assistiva | W3C, Core-AAM 1.2 e WAI-ARIA 1.2 | versões acessadas em 26 ago. 2026 | https://www.w3.org/TR/core-aam-1.2/ ; https://www.w3.org/TR/wai-aria-1.2/ | Alta |
| Política de mesma origem impede leitura cross-origin comum | MDN, Same-origin policy | modificado em 2025 | https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy | Alta |
| `chrome.scripting` injeta código autorizado em abas/frames | Chrome for Developers | atualizado em 2026 | https://developer.chrome.com/docs/extensions/reference/api/scripting | Alta |
| `chrome.debugger` expõe domínios CDP permitidos | Chrome for Developers | atualizado em 2025 | https://developer.chrome.com/docs/extensions/reference/api/debugger | Alta |
| CDP oferece DOMSnapshot, árvore AX, screenshot e PDF | Chromium DevTools Protocol | tip-of-tree de ago. 2026 | https://chromedevtools.github.io/devtools-protocol/tot/ | Alta para existência; APIs experimentais exigem feature detection |
| EARL define modos e resultados interoperáveis | W3C, EARL 1.0 Schema | Working Group Note de 2 fev. 2017 | https://www.w3.org/TR/EARL10-Schema/ | Alta para vocabulário; não é Recommendation |
| Web Crypto calcula SHA-256 localmente | Web Cryptography API / MDN | acesso em 26 ago. 2026 | https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest | Alta |
| Acessibilidade em sites é obrigatória nas condições do art. 63 | Lei 13.146/2015 | texto vigente acessado em 26 ago. 2026 | Referência legal consultada; URL omitida do pacote | Alta; o relatório não substitui análise jurídica |

## Critério de parada da pesquisa

A pesquisa foi encerrada porque as decisões consequenciais possuem suporte primário: arquitetura, conformance, limites da automação, algoritmo de nome, variabilidade da fala, modelo de resultados, APIs de evidência, integridade e base legal. Novas buscas genéricas tenderiam a repetir fontes; questões restantes são de implementação e teste contra o navegador-alvo.
