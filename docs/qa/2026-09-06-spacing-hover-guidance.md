# Orientações práticas — dicas temporárias e espaçamento de texto

Base: `469a3ac`, posterior à beta 1.1.6. Incremento exclusivamente textual no helper compartilhado pelo painel e pelos relatórios. Sem mudança de regras, classificação, catálogo normativo, armazenamento, permissões, capturas ou sinais na página.

## Lacuna e escopo

A reconciliação da meta identificou dois exemplos concretos de orientação genérica: 5.1.9 explicava apenas Tab, sem como dispensar conteúdo; 5.12.2 remetia a um ajuste indefinido e exemplificava uma sigla. Foram tratados junto com seus itens próximos, em sete perfis:

- **5.1.7:** recomendação de não depender somente do foco/passagem do ponteiro para obter informação; distinguir a recomendação ABNT de uma falha automática WCAG.
- **5.1.8:** observar permanência, registrar o tempo efetivamente observado e distinguir desaparecimento por prazo de saída do foco/ponteiro, dispensa ou informação que perdeu validade.
- **5.1.9:** verificar se é possível dispensar sem deslocamento, com Esc apenas como exemplo; preservar as alternativas de erro de entrada e de conteúdo que não oculta nem substitui outro conteúdo.
- **5.12.1–5.12.4:** distinguir linhas, parágrafos, letras e palavras, suas proporções e a alternativa de configuração sem perda; exemplos com fonte de 16 pixels e resultados de 24, 32, 1,92 e 2,56 pixels respectivamente.

As instruções explicam quando a pessoa consegue observar o comportamento e quando precisa de uma medição com apoio técnico. Não mandam estimar medidas pela fotografia, nem preencher dados reais para o teste. Observações originais, conclusões pendentes, exemplos hipotéticos e resultados positivos mantêm sua semântica.

## Fontes efetivamente lidas

- PDF ABNT fornecido pelo usuário: `ABNT-NBR-17225-Acessibilidade-Digital.pdf`, SHA-256 `1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc`. Páginas do arquivo 21, 37 e 38, correspondentes às páginas impressas 11, 27 e 28. Texto consultado diretamente, não inferido do checklist.
- [W3C — Text Spacing, WCAG 1.4.12](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html), consultado em 06/09/2026: adaptação aos quatro espaçamentos simultaneamente, sem exigir botão próprio nem esses valores como padrão; limites da medição e aplicabilidade ao idioma.
- [W3C — Content on Hover or Focus, WCAG 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html), consultado em 06/09/2026, como explicação complementar. O texto dos itens ABNT continua sendo a referência principal; o guia não cria novos mapeamentos ou regras automáticas.

## Verificação

RED antes de implementar: `node --test test/report/plain-language-guidance.test.js` — 28 testes, 21 aprovados, sete falhas correspondentes aos sete perfis ausentes. Uma asserção nova foi ajustada para aceitar a capitalização de “Ajuda”, sem alterar seu requisito.

GREEN focado:

```sh
node --test test/report/plain-language-guidance.test.js test/panel/panel-detail.test.js test/report/report-interactions.test.js test/report/report-view-interactions.test.js test/review/report-view.test.js test/export/report-export.test.js
```

135/135 aprovados, sem falhas ou skips.

Regressões dos demais consumidores:

```sh
node --test test/report/html.test.js test/panel/panel-result-bundle.test.js test/panel/panel-view.test.js
```

87/87 aprovados, sem falhas ou skips. Total sem sobreposição: **222 testes**. `git diff --check` aprovado.

Não houve suíte ampla, E2E nativo ou empacotamento neste incremento. A beta 1.1.6 entregue não foi alterada: estes textos ainda não estão naquele ZIP. Os demais itens que usam fallback por família não passam a ter orientação individual completa por causa desta alteração.

Revisão independente do diff congelado: **aprovada, C=0/I=0/M=0**. O revisor leu diretamente as páginas indicadas do PDF e as duas explicações W3C, reexecutou 28/28 testes de orientação e `git diff --check`. Confirmou os sete perfis, os cálculos, as exceções e a preservação de resultados/evidências; não reexecutou os demais 194 testes. Não foi necessária rodada de correção.
