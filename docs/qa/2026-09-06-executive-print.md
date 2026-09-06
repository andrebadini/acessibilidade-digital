# Impressão executiva — incremento após a beta 1.1.1

Base: `fd66372`. Escopo: apresentação do relatório vivo e HTML baixado, seus estilos e testes. Nenhuma mudança em modelo, captura, autorização, armazenamento ou interpretação normativa.

## Resultado e limites

- Ação explícita **Imprimir resumo / salvar PDF** nas duas apresentações. A pessoa escolhe Salvar como PDF no diálogo do navegador.
- O resumo mantém totais, escopo, limitações, matriz ABNT completa, metodologia, auditoria, revisão e hash. Fichas, capturas, mapas e anexo individual são omitidos somente nessa impressão e continuam disponíveis no relatório completo.
- Aviso expresso: resumo executivo não substitui o relatório completo. Título do PDF identifica o resumo.
- Ctrl+P normal e exportação automática de HTML, PDF, CSV e JSON permanecem completos. A ação resumida não cria comprovante de download nem autoriza exclusão local.
- Filtros, expansores, título e atributo de apresentação são restaurados, inclusive após erro de impressão. Erros nativos não são expostos.
- Esta mudança ainda não integra o ZIP 1.1.1 entregue.

## Verificação

REDs reproduziram ausência da ação, falta de identificação do resumo e seleção incorreta das seções do relatório vivo. Correções mínimas mantiveram o comportamento de impressão completa. Testes focados cobrem restauração após sucesso/erro, repetição, modelo inalterado, matriz completa e HTML de impressão sem controles interativos.

Comando lógico: `node --test test/review/report-view.test.js test/report/report-view-interactions.test.js test/report/html.test.js test/export/report-export.test.js`. Resultado final: 109/109 passaram, zero falhas ou skips. `git diff --check` passou.

Teste nativo: `test/e2e/report-executive-print.test.mjs`, Chrome for Testing 152.0.7977.64. As duas apresentações usam o modelo real da fixture e o motor PDF do Chrome:

| Apresentação da fixture | Completo | Resumo |
| --- | ---: | ---: |
| HTML baixado | 22 páginas | 8 páginas |
| Relatório vivo | 29 páginas | 8 páginas |

Os 146 itens da matriz permanecem na ordem original. Esses números são da fixture, não uma previsão para qualquer auditoria. O teste intercepta o diálogo do sistema para obter a apresentação selecionada e gera PDF via Chrome; **não comprova interação humana com o diálogo Salvar como PDF** nem substitui o E2E de autoridade da extensão.

`pdfinfo` confirmou PDF A4 marcado, oito páginas e título executivo. Extração de texto dos dois resumos confirmou 146 itens únicos e o aviso de resumo. Inspeção visual da capa baixada e última página viva confirmou leitura sem recorte nos trechos inspecionados; números longos de itens ABNT não quebram entre linhas.

Revisão independente somente leitura, seguida de validação da correção agrupada: C=0/I=0. O revisor não executou o navegador; os testes nativos foram executados pelo implementador. Não foram repetidos suíte ampla, verify, todos os E2E ou empacotamento neste incremento.

## Artefatos

Diretório local: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-executive-qa-EyBOY0`.

- `downloaded-full.pdf`, `downloaded-summary.pdf`
- `live-full.pdf`, `live-summary.pdf`
- `summary-cover.png`, `summary-live-last.png`

Refinamento não bloqueante: melhorar a quebra de página entre início da matriz e sua primeira linha; matriz completa preservada. PDFs técnicos grandes continuam extensos por manterem todas as evidências.
