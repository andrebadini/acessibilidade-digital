# Comparação documental — Google, AMAWeb e beta 1.1.9

Análise em 08/09/2026. Não foi feita nova coleta nesta rodada. Comparação entre estados e datas diferentes, não benchmark controlado nem demonstração de superioridade de um motor.

## Fontes preservadas

- AMAWeb: `/Users/andrebadini/Downloads/relatorio_https___www_google_c_2026-09-06 (1).pdf`, 13 páginas, avaliação de 06/09/2026 às 09:08. WCAG 2.1, 29 práticas, 483 elementos, nota 8,0, 5 erros, 3 revisões e 21 aceitos.
- Audita: `entregas/teste-google-com-1.1.9/google-com-1.1.9.json` e PDF correspondente, na raiz principal do projeto. Coleta de 08/09/2026, 21 páginas, 0 falhas de requisitos confirmadas, 1 recomendação, 0 suspeitas no contador, 11 resultados positivos e 106 perguntas agrupadas no checklist. Índice 9,2: proporção 11/12 do motor próprio; não comparável à nota AMAWeb.

## Concordâncias e diferenças

1. Ambos apontam contraste aprimorado no texto Fazer login. AMAWeb coloca em revisão AAA (p. 8); Audita registra 6,386:1, abaixo de 7:1, em recomendação ABNT 5.11.2. Essa medição supera 4,5:1 para aquele texto comum, mas não aprova todos os textos nem estados da página.
2. AMAWeb aceita contraste mínimo (p. 9). Audita deixa ABNT 5.11.3 `cantTell`. Não apresentar a beta como tendo aprovado o mínimo da página.
3. Idioma: AMAWeb pede confirmar pt-BR. Audita deixa 5.13.2 pendente, no checklist.
4. Salto de blocos: AMAWeb aponta o primeiro link Gmail como ponto de revisão. Audita tem revisão genérica 5.7.11, sem observação equivalente do primeiro link.
5. Erros AMAWeb: falta de cabeçalho, dois elementos center, dois cabeçalhos de nível 1, ID duplicado e lista com estrutura suspeita. O mesmo documento diz faltar cabeçalho e identifica dois `div[role=heading][aria-level=1]`; requer reconciliar a semântica HTML/ARIA e os estados visíveis, não escolher automaticamente uma conclusão.
6. Audita registra os testes de cabeçalhos e listas como não aplicáveis ao estado observado. As coletas não permitem determinar se a diferença vem de conteúdo oculto, variante do Google, instante observado ou cobertura da extensão. É necessário comparar o mesmo estado renderizado antes de concluir falso positivo ou falso negativo.
7. O erro de ID duplicado AMAWeb cita WCAG 4.1.1, removido na WCAG 2.2. Isso não dispensa verificar associações ARIA/rótulos quebradas sob critérios ainda aplicáveis. Fonte: https://www.w3.org/WAI/WCAG22/Understanding/parsing.html.

## Lacuna importante identificada na beta

O JSON contém seis registros suplementares axe-core, todos com `selector: [target-unavailable]`, `nodeId: null` e sem evidências individuais: dois `engineResultType: violations` (color-contrast e image-alt) e quatro `incomplete` (aria-valid-attr-value e três color-contrast). Foram preservados como cantTell e encaminhados ao checklist pela apresentação atual.

Esses sinais não equivalem a seis barreiras comprovadas, nem a seis elementos distintos. Porém, também não são apenas perguntas gerais sem observação do motor. O contador zero de suspeitas não comunica essa distinção. Prioridade de próxima correção: investigar a perda/indisponibilidade de alvos e tornar visíveis sinais do motor ainda sem correlação, separados do checklist genérico, sem inventar evidência ou promovê-los a infrações confirmadas. Não atribuir causa raiz sem RED focado. Esta rodada não altera integração axe, classificação, evidências ou resultados armazenados.

## Complemento didático implementado no código, ainda fora do ZIP 1.1.9

- Mantém literalmente observação, correção e orientações existentes; acrescenta interpretação de requisito/recomendação ao roteiro de revisão.
- Contraste aprimorado recebe comparação 5.11.2/5.11.3, limites para texto comum/grande, exceções, exemplo explicitamente hipotético de 6,39:1 e limite da conclusão por elemento.
- Base: ABNT NBR 17225:2025 fornecida pelo usuário, seção 4 (p. 9–10), itens 5.11.2/5.11.3 (p. 26–27). Complemento: https://todosnaweb.ceweb.br/publicacoes/wcag-2-2-abnt-17225.
- RED observado para ausência de explicação; após ajuste, 110/110 testes focados (plain-language-guidance, html, report-view); diff-check aprovado. Sem novo pacote, alteração do Chrome instalado ou nova execução E2E nesta rodada.

## Cautela jurídica

O descumprimento de recomendação, isoladamente, não demonstra descumprimento da conformidade regular. A hipótese de multa exige enquadramento concreto pela autoridade competente; a aplicação dos arts. 39, VIII, do CDC e 12, IX, a, do Decreto 2.181 não deve apagar a distinção interna da norma. Obrigações específicas, oferta vinculante ou barreira com fundamento legal próprio exigem análise separada. Não foi pesquisado precedente específico que decida exatamente a hipótese do contraste 6,39:1/7:1; não apresentar esta interpretação como jurisprudência pacificada ou imunidade à fiscalização.
