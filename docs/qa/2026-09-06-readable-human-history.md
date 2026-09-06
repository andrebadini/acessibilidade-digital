# Conclusões humanas legíveis no relatório

Base: `a732893` (beta 1.1.3). Incremento de apresentação: modelo, validação, armazenamento, capturas e classificação normativa permanecem inalterados. Não há novo pacote nesta etapa.

## Implementação

- `ReportViewV1.reviewHistory` vem diretamente das decisões do modelo canônico, nunca da seleção limitada de cartões. Cópia congelada e ordenada por instante/ocorrência; cada decisão atualmente armazenada aparece uma única vez. Não representa um arquivo de versões anteriores de decisões.
- Um expansor reúne pessoa avaliadora (nome informado, sem autenticação de identidade), data/hora em UTC, conclusão, página, ocorrência, nota e links locais para as respectivas evidências.
- Histórico recolhido na tela, expandido na impressão completa e restaurado depois. O resumo executivo omite os detalhes e avisa expressamente. Sem decisões, há uma indicação curta; ausência não equivale a conformidade.
- Campos humanos são texto literal. A nota mantém quebras de linha e conteúdo integral. O histórico distingue conclusões humanas de falhas automáticas e não declara certificação.
- O caminho HTML legado também passou a preservar a nota. HTML/PDF baseados na view compartilham os mesmos metadados de apresentação.

## RED e GREEN

Cinco REDs antes da implementação: ausência do histórico, decisão além do limite do painel omitida, literais/links ausentes, nota longa e impressão indisponíveis, estado vazio ausente. GREEN inicial: 5/5.

Regressão relacionada: 117/119; o teste de CSP detectou hash CSS antigo e o teste de ordem dos títulos esperava somente revisões pendentes. Hash recalculado para o CSS novo e título atualizado. O teste nativo também detectou recorte horizontal enquanto a CSP impedia carregar o CSS; nenhum controle de segurança foi removido. GREEN final relacionado: **119/119**, sem skips, usando:

`node --test test/review/report-view.test.js test/report/html.test.js test/report/report-view-interactions.test.js test/review/review-refresh.test.js test/export/report-export.test.js`

Revisão independente somente leitura do diff congelado: **C=0/I=0/M=0**. O revisor conferiu código/testes, mas não executou testes nem Chrome. `git diff --check` passou.

## PDF real e inspeção

Chrome for Testing 152.0.7977.64 confirmado. Teste focado `test/e2e/report-executive-print.test.mjs`: **1/1 passou**. Duas decisões e nota de quase 4.000 caracteres na fixture:

| Apresentação | Completo | Resumo |
| --- | ---: | ---: |
| HTML baixado | 25 páginas | 8 páginas |
| Relatório vivo | 30 páginas | 8 páginas |

A matriz mantém os 146 itens. O teste verifica histórico visível na impressão completa, nota inteira sem recorte horizontal, literais sem nós executáveis, histórico ausente do resumo, aviso explícito e restauração do expansor. O diálogo do sistema é interceptado no teste; não se alega teste humano da opção Salvar como PDF.

Extração independente com pypdf confirmou nome, início/fim da nota longa e nota da segunda decisão nos dois PDFs completos, ausentes nos resumos. Inspecionadas as páginas 12 do PDF baixado e 16 do vivo: texto legível, bordas de classificação e continuação da nota sem perda. Artefatos: `/tmp/audita-history-qa-PpHGNj`. As primeiras screenshots de tela capturaram o início da página durante a rolagem suave; isso não foi considerado prova visual do histórico. O comando de QA foi ajustado para rolagem instantânea, sem mudar a extensão; artefatos finais em `/tmp/audita-history-final-FCDuxZ`.

Não foram executados suíte ampla, todos os E2E, `verify` ou ZIP durante este incremento. A beta 1.1.3 entregue permanece inalterada. Recuperação de registros antigos com hash pendente continua fora deste escopo e não foi declarada resolvida.

Reexecução final após o ajuste exclusivo de rolagem do teste: 1/1 passou em 2,16 segundos, mantendo 25/30 páginas completas e oito resumidas. Inspecionadas `downloaded-history.png` e `live-history.png` em `/tmp/audita-history-final-FCDuxZ`; ambas mostram o histórico, os rótulos e a classificação sem recorte horizontal. Essa última alteração de QA não modificou o código da extensão aprovado pelo revisor.
