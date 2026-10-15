# Texto único para citação por item da ABNT — 1.1.61

Versão alvo: 1.1.61 (branch `wip161/citacao`). O `manifest.json` ainda declara 1.1.60, porque a
subida de versão acontece no processo de release.
Data da validação: 2026-10-15. Chrome for Testing 152.0.7977.64.

Pedido do dono do produto (literal): *"quando as não conformidades são apresentadas, são elaborados
tantos textos para copiar a contestação quantos são os elementos irregulares, mesmo que as
irregularidades se refiram a apenas um item da ABNT. Quando um item da ABNT tiver mais de uma
constatação para um mesmo item, o texto para copiar deverá ser um só, mas mencionando todos os
elementos em que a irregularidade do item foi constatada. Mas, no relatório pdf, html, etc, podem
manter separados. Essa junção deve ocorrer apenas na página que se abre quando se clica no botão
'Abrir relatório completo'."*

---

## 1. Problema

Um requisito pode ser descumprido em vários elementos da mesma página. O quadro de constatações já
listava cada elemento com a sua constatação e, para **cada** elemento, oferecia um parágrafo pronto
para citação e um botão "Copiar texto para citação". Quem contesta precisava colar 4, 8, 23 textos
diferentes repetindo o mesmo item da norma — e reunir à mão o que a extensão já sabia.

O caso real do portal público usado na validação: o item **5.1.13 — Acessibilidade por teclado
parcial** apareceu com quatro tabelas (menu principal) sem caminho de teclado, gerando quatro textos
que diziam a mesma coisa sobre o mesmo item.

## 2. Solução

Só na página do botão **"Abrir relatório completo"**:

- **Um item com mais de uma constatação** continua mostrando a lista com cada elemento e a sua
  constatação, mas **sem** parágrafo de citação e **sem** botão por elemento. Depois da lista vem um
  bloco único: título curto `Texto para citação (abrange os N elementos acima)`, o parágrafo
  consolidado (`data-findings-citation` + `data-findings-citation-scope="item"`) e **um** botão
  "Copiar texto para citação".
- **Um item com uma constatação só**: nada muda — o texto continua sendo `citationParagraph`, dentro
  do item da lista, com o botão ao lado.

Regras do texto consolidado (`consolidatedCitationParagraph({ item, findings })`, função pura em
`src/core/report/findings-board.js`):

1. Mesma página e mesmo instante de observação → a localização abre o parágrafo **uma vez**:
   *"Em {instante}, na página {url}, foram constatadas N ocorrências em desacordo com o item {id}
   ({título}, requisito) da ABNT NBR 17225:2025: …"*. Páginas ou instantes diferentes → cada
   ocorrência leva o seu *"na página …, em …"* e o parágrafo começa por *"Foram constatadas N
   ocorrências…"*.
2. Ocorrências numeradas no próprio texto: `(1) …; (2) …; (3) ….`.
   - Automática: *"em relação {sujeito}, {constatação em minúscula, sem ponto final} (verificação
     automática da ferramenta Audita Acessibilidade)"*.
   - Revisão humana: *"em revisão humana registrada por {pessoa} em {data}, a constatação “{texto}”,
     no elemento {elemento}"* (sem "no elemento" quando não há elemento).
3. Automáticas com **exatamente o mesmo texto** no mesmo instante viram uma entrada só, nomeando os
   sujeitos de cada elemento: *"em relação {a}, {b} e {c}, {texto} (…)"*. A contagem N continua sendo
   a de elementos, e as evidências de cada um seguem listadas.
4. As evidências aparecem **uma vez só**, sem repetir referências iguais e preservando a ordem —
   a captura da página inteira costuma ser a mesma para todos os elementos.

Nada fora dessa tela mudou: HTML, PDF, CSV e JSON continuam com **uma citação por elemento**.

| Peça | Arquivo | Papel |
| --- | --- | --- |
| Texto consolidado | `src/core/report/findings-board.js` | `consolidatedCitationParagraph` (pura, exportada) |
| Tela do relatório | `src/review/report-view.js` | `appendFindingsBoard`: bloco único quando `entry.findings.length > 1` |
| Estilo | `src/review/review.css` | `.findings-item-citation` / `.findings-citation-title` alinhados ao recuo da lista |
| Unidade | `test/report/consolidated-citation.test.js` (novo) | Regras do texto |
| Tela | `test/review/report-view.test.js` | 4 constatações → 1 botão; 1 constatação → como antes; clique copia |

## 3. Testes

- Unitários: `node --test test/report/consolidated-citation.test.js test/review/report-view.test.js
  test/report/lay-review.test.js test/report/review-marks-report.test.js test/report/html.test.js
  test/export/report-export.test.js test/release-assets.test.js` → **172 testes, 172 passam**.
- Suíte unitária completa: `node scripts/run-tests.mjs` → 4653 testes, 4651 passam; a única falha é
  `test/release-package.test.js` (hash do ZIP muda enquanto o fonte muda — esperada, conforme a
  tarefa). Sem `AUDITA_E2E_CHROME`, a parte E2E do mesmo roteiro falha por ausência de Chrome, como
  sempre.
- E2E em Chrome real, um arquivo por vez: `test/e2e/sidepanel-flow-mv3.test.mjs` (9/9),
  `test/e2e/report-executive-print.test.mjs` (1/1), `test/e2e/report-print-layout.test.mjs` (1/1),
  `test/e2e/current-page-export-mv3.test.mjs` (1/1 — exporta os quatro artefatos).
- Exportação sem mudança de expectativa: o teste novo
  *"a exportação entregue mantém uma citação por elemento, sem o texto consolidado"* confere, em
  HTML interativo e impresso, 4 `data-findings-occurrence`, 4 `data-findings-citation`, nenhum
  `data-findings-citation-scope` e nenhum texto consolidado.

## 4. Resultado em páginas reais

Roteiro visual (`node scripts/visual-qa.mjs`), com a fixture local e um **portal público**, Chrome
for Testing 152, e uma captura adicional do quadro de constatações (script de QA em `qa-out/`, não
versionado). A fixture local audita uma página de marcação com muitos botões sem nome; o portal
público é uma página inicial de atendimento ao consumidor.

| Página | Requisitos não atendidos | Constatações | Blocos únicos | Botões de copiar |
| --- | --- | --- | --- | --- |
| Fixture local | 4 | 74 | 4 | 4 |
| Portal público | 6 | 15 | 4 | 6 |

No portal público, o item do menu sem caminho de teclado passou a ter **um** texto para as quatro
tabelas (antes seriam quatro), e os dois itens com uma constatação só ficaram exatamente como antes
(2 dos 6 botões continuam por elemento).

**Antes** (captura de loja da versão publicada): item com quatro cartões, quatro parágrafos
"Em …, na página …, constatou-se, em relação ao bloco …, que …" e quatro botões "Copiar texto para
citação", um por cartão.

**Depois** (mesma região, captura crua de QA): a lista mostra os quatro elementos
(Saúde, Educação, Tributos, Ouvidoria) com a sua constatação e, abaixo dela, **um** bloco
"Texto para citação (abrange os 4 elementos acima)" com **um** parágrafo e **um** botão. Exemplo do
texto gerado na página fictícia:

> Em 15/10/2026, 13:14:54 (America/Cuiaba, UTC−04:00), na página `http://www.vila-aurora.example/`,
> foram constatadas 4 ocorrências em desacordo com o item 5.1.13 (Acessibilidade por teclado
> parcial, requisito) da ABNT NBR 17225:2025: (1) em relação ao bloco com o texto "Saúde Consultas e
> vacinas", ao bloco com o texto "Educação Matrículas e escolas", ao bloco com o texto "Tributos IPTU
> e certidões" e ao bloco com o texto "Ouvidoria Reclamações e sugestões", a verificação automática
> registrou falha neste requisito (verificação automática da ferramenta Audita Acessibilidade).
> Evidências: full-page-2b07c1f6 (SHA-256 24d69243a1bdd799…); element-8a7121f4 (…);
> element-80711236 (…); element-026e0d45 (…); element-006e0a1f (…).

No portal público, o mesmo item gerou: *"(1) em relação à tabela com o texto “CONSUMIDOR”, à tabela
com o texto “FORNECEDOR”, à tabela com o texto “SERVIDOR” e à tabela com o texto “OUVIDORIA”, a
verificação automática registrou falha neste requisito (…)"* — as quatro tabelas num texto só.

## 5. Limitações

- A consolidação vale **só** para a página do "Abrir relatório completo". O HTML/PDF/CSV/JSON
  exportados mantêm uma citação por elemento, de propósito (pedido do produto).
- Elementos com **nomes idênticos** (por exemplo, 23 botões "sem nome") aparecem com a quantidade:
  "ao botão sem nome (23 elementos)". Assim todos continuam mencionados sem repetir 23 vezes a mesma
  expressão; as 23 evidências seguem listadas e a lista acima do bloco mostra cada um.
- Quando todos os elementos têm a mesma constatação, o texto não numera "(1)": a frase cita os
  elementos em sequência. A numeração "(1) …; (2) …" só aparece quando há constatações diferentes.
- O parágrafo não substitui a lista: quem contesta confere na lista qual elemento é qual. O título do
  bloco diz "(abrange os N elementos acima)" justamente para amarrar os dois.
- O texto consolidado é derivado em tempo de renderização (não entra no modelo canônico nem nos
  hashes): auditorias guardadas continuam abrindo e nenhum esquema fechado mudou.
