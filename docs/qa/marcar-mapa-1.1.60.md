# Marcar no mapa do teclado o item que ficou sem caixa — 1.1.60

Data: 15/10/2026. Versão em trabalho: **1.1.60** (branch `wip160/marcar`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão e o `build:release` são o passo
de release). Chrome for Testing 152.0.7977.64, um Chrome por vez.

Escopo: o **item 5 do percurso guiado** — depois de "Sim, falta caixa em algum item" no item 5.1.13,
a pessoa já era obrigada a descrever o problema; agora ela **também pode apontar** o que viu, de duas
formas opcionais e complementares: marcando os itens laranja na lista do mapa e/ou desenhando até 5
áreas sobre a imagem do mapa. Este documento registra o que entrou, o que foi provado e o que ficou
de fora. Por regra do projeto, **nenhum nome de órgão, domínio de governo ou loja aparece aqui** — as
rodadas em páginas reais são descritas como "um portal público" e "duas lojas on-line".

> **Escopo negativo.** O mapa do teclado em si (modelo, compositor, artefato) é da tarefa 1.1.58 e não
> foi reaberto: aqui ele só é **consumido** (geometria e lista de suspeitos). `run-audit.js`,
> `chrome-adapter.js` e as regras de coleta não foram tocados.

## 1. O problema

A revisão guiada do 5.1.13 dizia *"Descreva qual item ficou sem caixa"* e parava aí. A descrição em
texto livre é necessária, mas não diz **onde** na tela nem **qual** dos itens laranja do mapa é o
problema — quem lê o relatório depois tinha que reencontrar a barreira por conta própria. O pedido:
manter a descrição obrigatória e oferecer, ao lado dela, dois caminhos opcionais de apontamento.

## 2. O que entrou

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Esquema fechado e versionado | `src/core/review/review-marks.js` (novo) | `marks = { version: 1, suspects: [números], areas: [{x,y,width,height}] }`. `canonicalReviewMarks` normaliza (suspeitos únicos, inteiros ≥ 1 e ≤ 60, em ordem; até 5 áreas, inteiros ≥ 0, largura/altura ≥ 1, dentro de `maxCoordinate`), devolve objeto congelado e `null` quando não há nada apontado. Decisão antiga sem `marks` continua válida: o campo simplesmente não existe |
| Geometria | `src/core/keyboard/keyboard-map-geometry.js` (novo) | Conversa entre **pixels CSS do documento auditado** e **pixels da imagem do trecho** (`documentRectToSegmentPixels`, `segmentPixelsToDocumentRect`, `intersectRects`, `segmentForDocumentPoint`, `clampDocumentRect`, `integerDocumentArea`). É a única fonte das contas; a mesma usada para pintar e para recortar |
| Interface da revisão | `src/review/review.js`, `review-state.js` | Bloco novo dentro do cartão, criado só no caminho "Sim, falta caixa": (a) lista de caixas de seleção com os itens laranja do mapa, com o motivo que a pessoa viu ("abre opções só quando o mouse passa por cima…"); (b) superfície de desenho sobre a imagem do mapa (clique e arraste) e a alternativa por teclado: **"Adicionar área"** cria o retângulo no centro visível, **setas** movem, **Shift + setas** redimensionam, **Delete** remove, com `aria-live` anunciando cada passo e botões "Remover área N" |
| Estilo da revisão | `src/review/review.css` | Estilos `.lay-marks*` (alvos de 44 px, foco visível, contraste em `forced-colors`) e as regras do recorte do relatório na tela: `.marks-crop` e `.marks-area-outline` |
| Decisão e trilha | `src/core/review/decisions.js` | `marks` entra na decisão canônica e **na trilha de revisões**: revisar só o apontamento (mesma resposta, mesma descrição) já é uma mudança que precisa ser gravada |
| Envelope | `src/background/worker-protocol.js`, `service-worker.js` | O lote fechado passa a exigir `marks` em cada entrada — `null` quando não houve apontamento — e o normaliza antes de gravar |
| Modelo | `src/core/report/audit-model.js`, `closed-schema.js` | `assertDecisionMarks` confere o apontamento **contra o mapa da própria página**: item 5.1.13, mapa presente, todo número precisa ser item suspeito daquele mapa, toda área precisa caber no documento observado, e área marcada exige imagem guardada. O esquema fechado ganhou o campo e o formato da área |
| Constatação e citação | `src/core/report/findings-board.js`, `review-marks-presentation.js` (novo) | O texto entregue e a citação citam `Itens apontados: …` (com o mesmo nome que a lista do mapa mostrou, incluindo "Nome omitido por privacidade") e `Áreas marcadas no mapa do teclado: N` |
| Relatório | `src/core/report/html.js`, `src/review/report-view.js`, `report.css.js` | Recorte visual da área marcada **sem gerar pixel novo**: a imagem do trecho que já está guardada na auditoria entra inteira num `<svg viewBox>` que faz o recorte, com um `<rect>` de contorno vermelho por cima. Mesmos atributos nas duas rotas (`marksCropParts`), sem `style` embutido — a meta de segurança do relatório não permite atributo de estilo |
| Histórico humano | `src/core/report/human-review-presentation.js` | A ficha da revisão ganha a linha "Apontamento no mapa do teclado" com o mesmo texto da citação |

### 2.1 Por que SVG e por que `viewBox`

O relatório entregue roda com `default-src 'none'; img-src data:; style-src 'sha256-…'` e **sem**
`'unsafe-inline'`. Qualquer `style="…"` seria bloqueado. O recorte, então, é apresentacional: o
`<image href="data:…">` recebe a imagem do trecho **inteira** e o `viewBox` do `<svg>` (com folga de
12%, no mínimo 24 px de imagem) faz o papel da tesoura. Nenhum canvas, nenhum encode novo: os bytes
entregues são exatamente os da evidência que já estava no relatório.

### 2.2 Coordenadas

Tudo é guardado em **pixels CSS do documento auditado** — o mesmo espaço do `geometry` do mapa — e
convertido na hora de pintar ou recortar. O teste de ida e volta (`documento → imagem → documento`)
está em `test/review/review-marks.test.js`.

## 3. Testes

| Conjunto | Arquivo | O que cobre |
| --- | --- | --- |
| Esquema e geometria (7) | `test/review/review-marks.test.js` (novo) | Normalização, limites (60 suspeitos, 5 áreas, área dentro do documento), `null` para "nada apontado", recusa de objeto forjado (protótipo trocado, campos herdados, acessores — nenhum acessor é chamado), decisão com marcas, revisão preservando as marcas anteriores na trilha, decisão antiga sem o campo, ida e volta das coordenadas |
| Interface da revisão (10) | `test/review/review-keyboard-map.test.js` | Lista de suspeitos e carga canônica, resposta "conforme" nunca leva marcas, teclado: adicionar/mover/redimensionar/Delete e a mensagem do limite de 5 áreas, mouse: arraste desenha e área pequena demais é recusada, marcas restauradas de uma resposta anterior |
| Relatório e citação (6) | `test/report/review-marks-report.test.js` (novo) | Texto copiável e citação do quadro de constatações, decisão sem marcação inalterada, rótulos de privacidade/sem nome, recorte reusando o PNG guardado, HTML entregue com `<svg class="marks-crop">` + `<rect class="marks-area-outline">` e **sem** `style`, mapa sem imagem não inventa recorte, e o modelo recusando número inexistente, área fora do documento, item sem mapa e área sem imagem |
| Rota da tela (1 nova) | `test/review/report-view.test.js` | Tela (`renderReportView`) e HTML entregue (`renderHtmlReport`, com e sem `forPrint`): texto do apontamento, recorte, contorno, `viewBox`, imagem da evidência e nenhum `style` embutido |
| Envelope (1 estendida) | `test/background/worker-protocol.test.js` | `marks` obrigatório no lote fechado, normalização (ordem e congelação) e recusa de versão 2, item 0, área de tamanho zero, campo extra, área sem `width`, objeto vazio, lista, texto e campo ausente |

Resultados: `node --test test/review/*.test.js test/report/*.test.js` → **473 passam, 0 falham**.
Fase paralela completa do `scripts/run-tests.mjs` (4.527 testes, sem os E2E de Chrome real) → **4.523
passam, 3 falham**: `test/release-package.test.js` (hash do ZIP fixado — falha esperada enquanto o
fonte muda, é o passo de release) e dois testes sensíveis a tempo de `test/background/run-batch.test.js`
(`reviewUrl accessor`, "handoff method and result reflection") que **passam isolados** e só caem sob
carga (83/83 no arquivo sozinho) — mesma flakiness de `test/browser/annotation-map.test.js` vista numa
rodada anterior. Nenhum deles toca o apontamento.

### 3.1 Percurso real de Chrome

`test/e2e/keyboard-map-mv3.test.mjs` (estendido, um arquivo por vez) faz a auditoria do fixture local
com CSP estrita, abre o relatório, responde "Sim, falta caixa" no 5.1.13, marca o primeiro item
laranja na lista, cria uma área por teclado, **move com a seta direita (x + 8), remove com Delete e
cria de novo**, preenche a descrição obrigatória e registra. Depois confere:

- no JSON entregue: `marks.version = 1`, 1 suspeito existente no mapa, 1 área dentro de
  `geometry.sourceCssSize`;
- no HTML entregue: `Itens apontados: <nome do item>`, `Áreas marcadas no mapa do teclado: 1.`, um
  `<svg class="marks-crop" data-marks-crop="1">` com `<rect class="marks-area-outline">`, **sem**
  `style`, e com o `href` da imagem **idêntico** a um `dataUrl` de trecho já guardado (prova de que
  nenhum pixel novo foi gerado);
- na tela: o contorno computado é `fill: none` e `stroke: rgb(176, 0, 32)`;
- zero violações de CSP e nenhum vazamento do marcador privado do fixture em JSON, HTML e relatórios.

Tempo do arquivo: ~8 s. Passa também com as capturas de percurso ligadas
(`AUDITA_E2E_ARTIFACT_ROOT`).

## 4. Validação visual

Capturas abertas e conferidas uma a uma:

| Captura | O que mostra |
| --- | --- |
| `qa-out/marcar-e2e/review-keyboard-map-marks.png` | A lista de itens laranja com caixas de seleção, o nome e o motivo de cada um, e o retângulo azul da área escolhida desenhado sobre a imagem do mapa |
| `qa-out/marcar-e2e/review-keyboard-map-marks-area.png` | "Adicionar área", "Remover área 1", "Área 1: 176 × 98 pixels, a partir de (498, 249). (área escolhida)" e o anúncio "Área marcada. Use as setas para mover, Shift com as setas para redimensionar e Delete para remover." |
| `qa-out/marcar-e2e/report-keyboard-map-marks.png` | A ficha do histórico humano com "Apontamento no mapa do teclado: Itens apontados: Consultar processo. Áreas marcadas no mapa do teclado: 1.", o recorte com **contorno vermelho** sobre a área marcada e a legenda com as coordenadas |
| `qa-out/marcar-e2e/exportado-recorte.png` | O recorte **do HTML exportado**, renderizado com a folha de estilo entregue: mesmo contorno vermelho |
| `qa-out/marcar-fixture/**` e `qa-out/marcar-reais/**` | `scripts/visual-qa.mjs` na página de teste e em três páginas reais (um portal público e duas lojas on-line): relatório, mapa do teclado e evidências sem regressão de estilo |

**Antes/depois (achado da validação visual).** A primeira captura do recorte mostrou um **retângulo
preto** cobrindo a área marcada: `.marks-area-outline` tinha `fill: none` só na folha do relatório
entregue (`report.css.js`), e a tela do relatório usa `review.css`. Corrigido acrescentando as regras
`.marks-crop`/`.marks-area-outline` (e a entrada do contorno no bloco `forced-colors`) à `review.css`.
Para que isso não volte a passar despercebido, o E2E agora **lê o estilo computado** do contorno e
exige `fill: none` / `stroke: rgb(176, 0, 32)`, além de exigir a regra `.marks-area-outline{fill:none…}`
e a de impressão (`.marks-area-outline{stroke:#b00020;print-color-adjust:exact}`) dentro do HTML
entregue.

## 5. Limites e o que ficou de fora

- **Só o item 5.1.13 e só com mapa na mesma página**: sem mapa do teclado na página da ocorrência, o
  bloco não aparece e o modelo recusa marcas (não há a que se referir).
- **Limites duros e declarados**: até 5 áreas e até 60 itens por resposta; área menor que 8 × 8 px do
  documento é recusada com aviso, e o limite de áreas é anunciado quando atingido.
- **Recorte de área que cruza dois trechos**: o recorte sai no trecho que contém o centro da área; a
  parte que ficar fora é cortada pelo próprio `viewBox`. A área continua correta no documento — o
  recorte é só ilustração.
- **Arraste com o mouse**: coberto por teste unitário no DOM falso e conferido por captura na
  navegação por teclado; o E2E real exercita o caminho de teclado (é o que roda sem depender de
  eventos de ponteiro sintéticos).
- **PDF**: as páginas do PDF exportado não foram abertas nesta máquina (sem `poppler`/`pdftoppm`).
  A rota de impressão está provada por testes — o `forPrint: true` entrega o mesmo recorte e a mesma
  regra de contorno, com `print-color-adjust: exact` — e o HTML entregue foi conferido em render real.
- **Sem commit**: por regra do projeto, o orquestrador revisa e comita. A subida para 1.1.60, o
  `build:release` e a atualização do hash fixado do ZIP são o passo de release.
