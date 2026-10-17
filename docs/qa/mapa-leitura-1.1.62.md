# Mapa de leitura 1.1.62 — código curto na caixa, texto ao lado, no relatório e na conferência

Data: 16/10/2026. Versão em trabalho: **1.1.62** (branch `wip162/mapa-leitura`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão e o `build:release` são o passo
de release). Chrome for Testing 152.0.7977.64, um Chrome por vez.

Escopo: os três pedidos do dono do produto que ainda estavam abertos.

1. O mapa de leitura (com as caixas) precisa entrar no relatório HTML e no PDF **sem depender** de
   alguém clicar em "Conferir leitura por Tab".
2. As caixas do mapa **não caíam** sobre os elementos correspondentes.
3. Dentro das caixas deve ficar **só o código curto** (L1, L2…) do texto que seria ouvido, e ao lado
   do mapa uma **coluna** com os textos daqueles códigos.

Por regra do projeto, **nenhum nome de órgão, domínio de governo ou loja é registrado aqui**. Os
ensaios em página real são descritos como **portal público**, **loja on-line** e **mercado on-line**.

> **Escopo negativo.** A captura integral, o aquecimento da página e a geometria de origem
> (`run-audit.js`, `map-source-geometry.js`, `keyboard-map.js`) são de uma tarefa paralela, e a parte
> de `annotation-map.js` que recebe `bounds`/`sourceAligned` também. Aqui foi feito o **desenho** e a
> **apresentação**: o que a caixa mostra, onde ela cai e como o texto acompanha cada código.

## 1. O defeito

**1.1 Caixas fora do lugar na conferência por Tab (pedido 2).** O mapa da página
`src/reader/index.html` era um `<img>` com a captura integral e um `<svg>` por cima, e a medida do
`viewBox` saía **dos próprios elementos anotados**, não da captura: em `report-model.js` (versão
anterior) o código fazia

```js
width  = Math.max(...rows.map(entry => entry.bounds.x + entry.bounds.width), 800);
```

isto é, a maior caixa mandava no tamanho do desenho. Como o `<img>` era exibido com `width:100%`
(escala do navegador) e o SVG usava o retângulo em **px CSS do documento** sem nenhuma conversão, a
captura em tela de alta densidade (PNG com o dobro dos px CSS) deslocava todas as caixas: as caixas
apareciam na metade da posição, e quanto mais fundo na página, pior. O mesmo erro atingia as
miniaturas: `cropElementImage` recortava `bounds` (px CSS) direto no PNG (px da imagem), então a
miniatura de um elemento no fim de uma página longa saía de outro lugar da página.

**1.2 Números dentro da imagem e sem texto ao lado (pedidos 1 e 3).** O mapa do relatório
(`src/browser/annotation-map.js`) desenhava **círculos numerados** e compunha a legenda **dentro do
PNG** (`wrapLegend`, `LEGEND_*`), com a linha `1 — rótulo — prévia do anúncio`. Duas consequências:
a caixa do número não dizia o que seria ouvido (a pessoa tinha de achar o número na legenda raster,
que amplia mal no PDF), e a legenda ocupava a largura da imagem — em página longa ela ficava
ilegível, e no PDF os números grandes ficavam fora do recorte da folha.

**1.3 Presença dependia do clique (pedido 1).** O mapa de leitura com os códigos curtos (**L1, L2…**
com o texto do anúncio) só existia na página de conferência por Tab, que só abre clicando em
"Conferir leitura por Tab". O relatório, o HTML entregue e o PDF traziam o mapa antigo (círculos +
legenda raster). Quem exportava o relatório sem fazer a conferência nunca via o mapa de leitura.

**1.4 Título.** A seção do relatório se chamava "Mapas de anúncios" e não tinha cabeçalho próprio
para o mapa (o `h3` "Mapa de leitura da página" existia só na página de conferência), então a
navegação por cabeçalhos do leitor de tela não encontrava o mapa no relatório.

## 2. A correção

### 2.1 Uma só regra de desenho da etiqueta

`src/core/evidence/annotation-marker-layout.js` (novo) é a regra única de posicionamento, usada pelo
mapa do relatório **e** pelo mapa da conferência — é isso que faz os dois mapas serem lidos do mesmo
jeito:

- **Etiqueta encostada no alvo.** As primeiras posições candidatas são à esquerda, acima, à direita e
  abaixo da caixa do elemento, com 2 px de folga (`ANNOTATION_BADGE_GAP_PX`); só depois o algoritmo
  abre um anel limitado (`BADGE_RING_LIMIT`, `MAX_BADGE_CANDIDATES`) em volta.
- **Anticolisão com custo explícito.** Custo = colisão com outra etiqueta (peso 100, dominante) +
  cobrir a caixa de **outro** elemento (5) + cobrir a **própria** caixa (2) + distância até a
  candidata de encaixe. A primeira candidata de custo zero vence (o trabalho fica baixo numa página
  com centenas de anotações); quando nenhuma zera, fica a de menor custo e a limitação de
  sobreposição é declarada (`overlapped`, `unresolved`).
- **Linha-guia curta.** `annotationLeaderPoint` traça da etiqueta até a **borda** do contorno mais
  próxima, nunca pelo centro do elemento (a linha pelo centro riscaria o conteúdo na diagonal); se a
  etiqueta já encosta, nenhuma linha é traçada.
- **Tamanho legível e regular.** A altura da etiqueta vem da largura da imagem
  (`ANNOTATION_MAP_BADGE_LIMITS`: `clamp(round(cssWidth / 44), 13, 48)`) e a fonte é
  `max(9, round(altura * 0.62))`, então a etiqueta mantém a mesma proporção na captura do relatório e
  na da conferência. Fundo `#8b1e1e` com texto branco (contraste AA), e `#6b4e00` quando a etiqueta
  ficou sobreposta.

### 2.2 Nova versão do artefato, sem quebrar o que já estava guardado

O esquema é fechado, então o artefato foi versionado em vez de alterado no lugar
(`src/core/evidence/annotation-map-artifact.js`):

- `ANNOTATION_MAP_VERSION = '1.3.0'`, com a marca `x y width height leaderX leaderY` (caixa do
  código) no lugar do círculo `x y size leaderX leaderY`;
- `annotationMapReadRules(version)`: `1.0.0` e `1.2.0` seguem com `markerKeys`, `badge:false`,
  `imageRole:'image-and-legend'` e `continuationRole:'legend-continuation'`; `1.3.0` responde
  `badge:true`, `imageRole:'image'` e `continuationRole:null`;
- `ANNOTATION_MAP_READABLE_VERSIONS` mantém as três versões;
- `src/core/report/closed-schema.js` escolhe o conjunto exato de chaves **pela versão declarada**
  (`annotationMapUsesBadge`), então uma auditoria antiga continua abrindo com o conjunto dela.

### 2.3 Sem legenda dentro da imagem e com coluna à direita (pedido 3)

- O compositor do mapa (`src/browser/annotation-map.js`) deixou de compor texto na imagem: saíram
  `wrapLegend`, `LEGEND_LINE_HEIGHT`, `LEGEND_FONT` e o segmento de continuação da legenda. A imagem
  do trecho carrega só o contorno e a etiqueta com o código.
- `src/core/report/html.js` passa a emitir, por trecho, um `<figure class="reader-map-segment">` com
  `<div class="reader-map-columns">`: a **imagem à esquerda** e, à direita, uma lista ordenada com
  `<li value="7" data-map-marker="7"><span class="reader-map-code">L7</span> <bdi>texto que seria
  ouvido</bdi></li>` — o mesmo texto estimado do anúncio, com o papel junto ("Buscar, botão"), e
  "(Tab 8)" quando o elemento recebe foco por Tab. Trecho sem código nenhum mostra
  "Nenhum código neste trecho.".
- `src/core/report/report.css.js` (e `src/review/review.css`, para o relatório aberto no painel)
  definem a grade `minmax(0,3fr) minmax(0,2fr)`; **no meio de impressão** a grade é mantida com fonte
  de 8 pt e `break-inside:avoid` por trecho, e em tela estreita (`max-width:40rem`) a coluna **passa
  para baixo** da imagem, em uma coluna só.

### 2.4 Presença sem clique (pedido 1)

`src/core/report/reader-map-presentation.js` concentra a apresentação: `READER_MAP_TITLE`
("Mapa de leitura da página") e a explicação leiga, usadas pelo relatório do painel, pelo HTML
entregue e pelo PDF — o mapa deixou de depender de a conferência ter sido feita. O texto antigo
(`READER_MAP_LEGACY_INTRO`, "Mapa visual da prévia de anúncios…") só aparece nos mapas guardados
antes da 1.3.0, que continuam abrindo exatamente como foram gerados (`data-map-format` =
`numbered-preview`). O `h3` com o título entra antes da explicação em todos os formatos.

### 2.5 Conferência por Tab na mesma régua (pedido 2, do lado do leitor)

- `src/reader/visual-capture.js`: a captura integral passou a devolver `pageMapGeometry`
  (`pixelWidth`/`pixelHeight` do PNG + `cssWidth`/`cssHeight` medidos), e `cropElementImage` converte
  a medida do documento para pixel da imagem com `scaleX`/`scaleY`. Sem medida coerente a captura
  declara `page-map-geometry-unavailable` e nenhum recorte é inventado.
- `src/reader/reading-map-plan.js` (novo): monta o plano do mapa. O `viewBox` é **o tamanho em pixel
  do PNG** (não a maior caixa), cada retângulo é convertido pela escala (`validPageMapGeometry`
  recusa medida incoerente em vez de desenhar com escala inventada), a caixa é recortada na borda da
  imagem, e `annotationMarkerLayout` posiciona a etiqueta — a **mesma** regra do relatório.
- Numeração: **uma só sequência L1, L2… em ordem de leitura** (primeiro quem recebe Tab, depois o
  conteúdo estrutural), sem repetir código, com o limite congelado de 200 elementos e nota dizendo
  quantos ficaram nas tabelas.
- `src/reader/report-model.js` e `src/reader/index.html`/`reader.css` desenham o mapa na mesma
  apresentação do relatório: imagem à esquerda, **só o código** em cima da caixa e a coluna da
  direita com o texto que seria ouvido e o "(Tab n)". Na página da conferência e no **HTML que ela
  exporta** o desenho é um SVG por cima da captura (mesma origem dos dois, uma só conversão de
  escala), em vez de trechos de imagem; é a diferença de meio, não de formato: quem lê vê a caixa com
  o código e o texto ao lado, nos dois lugares.
- O resto da página de conferência (anúncios por elemento, tabelas, exportações, impressão) ficou
  como estava.

## 3. Testes

### 3.1 Unitários (um arquivo por vez, todos verdes)

| arquivo | testes |
| --- | --- |
| `test/reader/reading-map-plan.test.js` (novo) | 6 |
| `test/report/html.test.js` | 36 |
| `test/reader/report.test.js` | 18 |
| `test/review/report-view.test.js` | 66 |
| `test/evidence/annotation-map-artifact.test.js` | 15 |
| `test/browser/annotation-map.test.js` | 35 |
| `test/background/run-audit.test.js` | 174 |
| `test/report/review-marks-report.test.js` | 6 |

O que os testes novos garantem:

- **código único e ordenado**: `plan.markers.map(m => m.code)` é `['L1','L2','L3']` e
  `new Set(...).size === 3`; a ordem é a de leitura observada, sem reordenar por conta própria;
- **caixa na escala da captura**: captura de 1000×500 CSS que virou PNG de 2000×1000 → a caixa CSS
  (10,20,60×24) vira (20,40,120×48) na imagem, e o `viewBox` é o tamanho do PNG;
- **etiquetas que não se sobrepõem**: com lugar livre, nenhum par de etiquetas se cruza e a limitação
  de sobreposição **não** é declarada; no caso apertado (40 elementos no mesmo pixel) a sobreposição
  não resolvida fica marcada e a limitação é declarada;
- **legenda por trecho**: cada código tem o texto do anúncio e o `(Tab n)` de quem recebe foco;
- **medida incoerente é recusada** em vez de desenhar com escala inventada;
- **a conferência exportada** (`renderReadingHtml`): `viewBox="0 0 2400 1200"` (o PNG), a caixa CSS
  (10,20,80×24) virando (20,40,160×48) na escala 2, cada código uma vez em ordem e a coluna com
  `<span class="reader-map-code">L1</span> <bdi>Ir para o conteúdo</bdi> <span
  class="reader-map-tab">(Tab 1)</span>`;
- **apresentação**: HTML entregue com duas colunas por trecho, `h3` com "Mapa de leitura da página",
  `data-map-format="reading-codes"` no mapa novo e `numbered-preview` no mapa guardado antes da
  1.3.0 (que continua com os dois PNGs de imagem + continuação da legenda e sem nenhuma classe
  `reader-map-*`).

### 3.2 Expectativas de teste que mudaram de propósito

- `test/review/report-view.test.js`: as asserções passaram a exigir o `h3` com o título, a
  explicação leiga, `data-map-format`, a imagem dentro de `.reader-map-image`/`.reader-map-columns` e
  o `<span class="reader-map-code">L1</span>`; saiu a asserção de que o `li` dizia "segmento 1" (o
  "Segmento 1 de 1: códigos L1" passou para o texto alternativo da imagem, que é o que a legenda
  precisa dizer a quem não vê a imagem). O comportamento mudou de propósito: o trecho do mapa agora é
  só imagem, e a legenda vive na coluna.
- `test/background/run-audit.test.js`: a captura pristine dos cenários que derivam mapa passou a ser
  a captura de 160×100 dos fixtures (`MAP_PNG`) em vez do PNG de 1×1. O artefato declara o hash da
  captura de origem, então a origem precisa ser exatamente a captura que o navegador devolveu — com
  1×1 o mapa derivado seria recusado na conferência de integridade.
- `test/report/keyboard-map-fixture.js`: `sourceCssSize`/`sourcePixelSize`/`sourceCssClip` passaram a
  usar `TEST_PAGE_CSS`/`TEST_PAGE_PIXELS` (160×100), pelo mesmo motivo.

### 3.3 Ponta a ponta (um arquivo por vez, todos verdes)

| arquivo | testes | o que cobre |
| --- | --- | --- |
| `test/e2e/tab-reading-mv3.test.mjs` | 3 | a conferência por Tab abre, anda e para a página |
| `test/e2e/keyboard-map-mv3.test.mjs` | 3 | o mapa do teclado (vizinho de geometria; não podia regredir) |
| `test/e2e/report-print-layout.test.mjs` | 1 | a folha do relatório |
| `test/e2e/report-executive-print.test.mjs` | 1 | a folha do relatório executivo |
| `test/e2e/report-print-breaks.test.mjs` | 1 | as quebras de página da impressão |
| `test/e2e/current-page-export-mv3.test.mjs` | 1 | a exportação (HTML, PDF, CSV, JSON) |
| `test/e2e/mandatory-journey-mv3.test.mjs` | 1 | a jornada inteira da página atual |
| `test/e2e/report-version-provenance.test.mjs` | 1 | a origem declarada do relatório |

**14 testes, 14 verdes, um arquivo por vez.** `test/release-package.test.js` (hash do ZIP) foi
ignorado, como combinado, porque o fonte está mudando.

Não existe teste de ponta a ponta que olhe o mapa de anúncios (nenhum arquivo de `test/e2e` cita
`annotation-map`, `readerMap` ou `reader-map`): o mapa é coberto pelos unitários acima e pela rodada
visual da §3.4, que é onde ele de fato aparece montado.

### 3.4 Visual (`scripts/visual-qa.mjs`)

Um Chrome por vez, Chrome for Testing 152.0.7977.64:

1. **fixture local, depois** — a página de marcação do projeto (`test/e2e/fixtures/visual-qa/marcacao.html`),
   em `qa-out/ml-fixture5`;
2. **fixture local, antes** — a mesma página com o fonte em `HEAD`, em
   `/tmp/audita-head-qa/qa-out/fixture-head`;
3. **páginas reais, antes** — as três páginas com o fonte em `HEAD` (`git archive HEAD` extraído em
   `/tmp/audita-head-qa`), em `qa-out/ml-head`;
4. **páginas reais, depois** — as três páginas com o código desta rodada, em `qa-out/ml-final`;
5. **loja on-line, rodadas extras** (`qa-out/ml-loja-final`, `ml-loja-final2`, `ml-dois-final`,
   `ml-loja-final3`) — para a folha de impressão do mapa (§4.3). Só o roteiro de medição
   (`scripts/visual-qa.mjs`) é comum a todas: nas rodadas "antes" a extensão é a de `HEAD`, para que
   a diferença medida seja do produto e não do instrumento.

O roteiro foi ajustado nesta tarefa para poder medir o que o relatório e o PDF entregam
(`scripts/visual-qa.mjs`, +421 linhas): lê o JSON exportado pela conferência e compara a caixa
desenhada com a medida do elemento **na escala da captura** (recortando antes o que passa da borda da
imagem); conta os trechos de imagem, os blocos de duas colunas e os códigos da coluna da direita no
HTML entregue; procura o título próprio da seção; e imprime a página do mapa com o motor de PDF da
própria extensão, em duas versões (a seção inteira e só a figura do primeiro trecho), rasterizando a
primeira página de cada uma. Também passou a usar `downloadMode: 'profile'` (a API `chrome.downloads`
não respeita `Browser.setDownloadBehavior` em modo `cdp`) e a trazer a página auditada para a frente
antes de abrir a conferência — sem isso o botão "Conferir leitura por Tab" abre a conferência na aba
errada e a rodada morre em "leitor não abriu".

Todas as imagens citadas na §4 foram **abertas e ampliadas** (`sips` com recorte e reescala) antes de
virarem afirmação aqui.

## 4. Páginas reais — antes e depois

### 4.1 Os códigos e a coluna (pedidos 1 e 3)

HTML entregue pelo relatório, lido no arquivo que a extensão baixou (`11-relatorio.html`):

| | trechos de imagem | blocos de duas colunas | códigos na coluna da direita | título "Mapa de leitura da página" |
| --- | --- | --- | --- | --- |
| portal público, antes | 5 | 0 | 0 | **não** |
| loja on-line, antes | 11 | 0 | 0 | **não** |
| mercado on-line, antes | 4 | 0 | 0 | **não** |
| portal público, depois | 5 | 0 | 0 | **sim** |
| loja on-line, depois (`ml-final`) | 6 | **3** | **141** | **sim** |
| loja on-line, depois (`ml-loja-final3`) | 6 | **3** | **126** | **sim** |
| mercado on-line, depois | 4 | 0 | 0 | **sim** |

O mapa da conferência por Tab (`10-mapa-leitura.png`), que é o mesmo desenho aplicado à página ao
vivo:

| | caixas desenhadas | códigos L1… | linhas na coluna da direita |
| --- | --- | --- | --- |
| portal público, antes | 115 | 0 | 0 |
| loja on-line, antes | 510 | 0 | 0 |
| mercado on-line, antes | 419 | 0 | 0 |
| portal público, depois | 115 | 115 (L1…L115) | 115 |
| loja on-line, depois | 200 | 200 (L1…L200) | 200 |
| mercado on-line, depois | 200 | 200 (L1…L200) | 200 |

O texto da coluna é o anúncio estimado com o papel junto e, quando o elemento recebe foco por Tab, o
número do Tab — como se vê na captura da loja on-line: "L1 (nome do site), link (Tab 2)",
"L2 (nome do endereço de entrega com o CEP), botão (Tab 3)". No mapa do **relatório** o
"(Tab n)" não aparece, de propósito: a ordem daquele mapa é a ordem DOM/AX observada, não a ordem de
foco (é o que a própria explicação do mapa diz).

Na fixture local (página de marcação do projeto), o antes também não tinha código nem coluna —
123 caixas e nenhuma linha — e o depois tem **123 códigos L1…L123 com 123 linhas na coluna**, no
mesmo `viewBox`. É a demonstração limpa do pedido 3, sem página de terceiro no meio.

### 4.2 A precisão das caixas (pedido 2)

Medida direta do defeito, no JSON que a própria página exporta: o `viewBox` do desenho **não** vinha
da captura e a imagem era exibida em outra escala.

| | PNG da captura | `viewBox` desenhado | razão |
| --- | --- | --- | --- |
| portal público, antes | 882×4674 | 1065×**4674** | 1,21× na largura |
| loja on-line, antes | 1000×4060 | 2908×**4030** | 2,91× na largura |
| mercado on-line, antes | 879×6529 | 2616×**6529** | 2,98× na largura |
| portal público, depois | 882×4674 | **882×4674** | 1,00× |
| loja on-line, depois | 1000×5014 | **1000×5014** | 1,00× |
| mercado on-line, depois | 879×6529 | **879×6529** | 1,00× |

Um dos retângulos do antes, na loja on-line, estava em **x = −9847** (elemento fora da viewport) e
outro em −6100 no mercado on-line: era esse tipo de valor que virava o tamanho do desenho. Como o SVG
é esticado para caber na moldura da imagem com o `preserveAspectRatio` padrão (ajustar e **centrar**),
um `viewBox` 2,9× mais largo que a captura encolhe o desenho inteiro para ~39% e o desloca para o meio
da imagem; no portal, com 1,21×, a escala ficava ~1,07 e o desenho descia uma faixa de centragem.
É exatamente o que as capturas do antes mostram: no portal público, etiquetas como "L62, cabeç…" e
"Buscar no site, botão" desenhadas sobre a foto de abertura, centenas de pixels abaixo do cabeçalho
onde os elementos estão; na loja on-line, nenhuma caixa visível no topo da imagem, todas espremidas na
faixa central.

Depois, a comparação da caixa desenhada com a medida do elemento, na mesma escala da captura
(`precisão`, lida do JSON exportado):

| | caixas conferidas | dentro da medida (folga ≤ 1 px CSS + borda) | fora | recortadas na borda da imagem |
| --- | --- | --- | --- | --- |
| portal público | 115 | **115** | 0 | 0 |
| loja on-line | 200 | **200** | 0 | 148 |
| mercado on-line | 200 | **200** | 0 | 24 |

O antes não tem essa medida no mesmo formato (a página antiga exportava outro JSON, sem os
retângulos), então o antes se prova pelo `viewBox`, pelo PNG e pelas capturas.

A fixture local é o caso de controle: a captura dela sai na **mesma escala** em px CSS e px de imagem
(a razão medida é 1× / 1×), então ali o `viewBox` já coincidia com a imagem e as caixas **não**
mudaram de lugar — antes e depois, as mesmas 123 caixas com as mesmas coordenadas nas cinco amostras
(por exemplo 579,9 / 6,9 com 83,7 px de largura, e a última em 20 / 5167,9 com 839 px). A correção não
mexe no que já estava no lugar: ela converte pela escala **quando a escala existe**. O que mudou na
fixture foi o que faltava — os códigos e a coluna.

### 4.3 A folha do PDF (pedidos 1 e 3 no PDF)

O PDF entregue saiu com o mapa nos dois lados:

| | páginas do PDF | páginas do mapa no motor de PDF | folha só da figura (imagem + coluna) |
| --- | --- | --- | --- |
| portal público, antes | 135 | 2 | — |
| loja on-line, antes | 191 | 28 | — |
| mercado on-line, antes | 139 | 1 | — |
| portal público, depois | 139 | 2 | — |
| loja on-line, depois (`ml-final`) | 157 | 12 | — |
| loja on-line, depois (`ml-loja-final3`) | 170 | 11 | **4 páginas, com a figura desde a 1ª** |
| mercado on-line, depois | 139 | 1 | — |

A queda de 28 para 12 (e 11 na segunda rodada) páginas do mapa na loja on-line é a legenda raster que
saiu da imagem: cada trecho agora é a faixa da página com as caixas, e o texto vai na coluna, na
mesma folha. As duas rodadas "depois" da loja on-line auditaram a mesma página em momentos
diferentes; a diferença de páginas do PDF (157 / 170) é do conteúdo do relatório, não do mapa.

A folha `ml-final` não foi rasterizada: nessa rodada a impressão do recorte ainda pegava o cabeçalho
da seção na página 1 (defeito do roteiro, não do produto), o que só foi corrigido depois de isolar
a figura — é por isso que a prova abaixo vem da rodada `ml-loja-final3`, em que o mapa do momento da
auditoria saiu com códigos.

A prova visual da folha são três arquivos da rodada `ml-final`: `12-mapa-impressao-a4.png` (a
primeira dobra do trecho, no meio de impressão, com largura de A4), `12-mapa-do-pdf.pdf` e o seu
rastro `12-mapa-do-pdf.png` (a página do mapa como ela sai no PDF entregue). A primeira página do
PDF impresso só com a figura é `12-mapa-impressao-folha.png`, da rodada `ml-loja-final3`.
Ampliadas, as capturas mostram o que o dono do produto pediu: a caixa com **só o código** — L41, L42,
L43… encostados no canto superior esquerdo de cada produto, com o contorno colado no cartão — e, na
coluna da direita: L1 com o nome da loja seguido de "link", L7 com o rótulo do menu de categorias
seguido de "botão, recolhido", L12 com o nome de um produto seguido de "link" (o nome do produto e o
do menu são o que está escrito na página; os nomes de loja e de produto não são repetidos aqui).
A folha `ml-loja-final3` repete os mesmos dois ítens no topo da coluna — L1, o nome da loja com
"link", e L2, o rótulo do endereço de entrega com o CEP e "botão" — e segue até L20, com a caixa do
código encostada no canto superior esquerdo de cada alvo.

### 4.4 As etiquetas encostadas no alvo (pedidos 2 e 7, medidos)

Distância entre a caixa do código e a caixa do elemento a que ele pertence, medida no JSON exportado
pela conferência (px da imagem):

| | códigos | encostados (≤ 4 px) | com folga maior | sobre o próprio alvo | folga média | maior folga | pares de códigos sobrepostos |
| --- | --- | --- | --- | --- | --- | --- | --- |
| portal público | 115 | 65 | 9 | 41 | 4,0 px | 42 px | 1 |
| loja on-line | 200 | 147 | 22 | 31 | 5,8 px | 108 px | 7 |
| mercado on-line | 200 | 140 | 29 | 31 | 4,3 px | 44 px | 7 |

"Encostado" quer dizer que a etiqueta respeita a folga de 2 px e o contorno: encosta na borda da caixa
e é ali que a pessoa lê. "Sobre o próprio alvo" acontece quando o lugar em volta está todo ocupado por
caixas vizinhas: a regra prefere cobrir **o próprio** alvo (peso 2) a cobrir o alvo de outro elemento
(peso 5), e mesmo assim declara a limitação de sobreposição. "Maior folga" é a etiqueta que precisou
andar mais para achar lugar livre — a linha-guia curta liga o código ao alvo, e na loja on-line o pior
caso foram 108 px numa página de 5014 px de altura.

### 4.5 O que variou por conta da própria página (e não da mudança)

Nas três páginas reais, o mapa **da auditoria** (o que vai no relatório e no PDF) depende de a captura
integral e a leitura estrutural descreverem o mesmo leiaute. Numa página que cresce sozinha entre os
dois passos, a extensão se recusa a marcar (`source-layout-changed`) e diz por quê. Isso **não** é
desta tarefa (é da geometria de origem, tarefa paralela) e apareceu de forma irregular entre as
rodadas: o portal público recusou o mapa no antes **e** no depois (a seção saiu com título, explicação
e origem, sem código desenhado) e o mercado on-line recusou nas duas rodadas; a loja on-line marcou
nas duas (133 de 220 no antes, 141 de 215 no depois). O número de elementos elegíveis também muda de
rodada para rodada (215–220 na loja on-line), porque são páginas de loja, com prateleiras que se
montam sozinhas.

Por isso a comparação dos pedidos 1 e 3 se apoia na loja on-line (marcada nas duas rodadas) e a do
pedido 2 no mapa da conferência, que é montado sobre a página ao vivo e não depende dessa recusa.

Duas notas sobre o instrumento, para quem for repetir a medição:

- **A métrica de precisão do roteiro foi corrigida** (só `scripts/visual-qa.mjs`, nada do produto).
  Ela casava cada caixa desenhada com o primeiro elemento de caixa igual, o que fazia páginas com
  contornos aninhados idênticos aparecerem com "199 de 200 alvos repetidos". Agora a caixa é medida
  contra o conjunto de medidas, com tolerância de 2 px na posição e 3 px no tamanho, e o roteiro
  imprime "elementos elegíveis sem caixa" e "caixas fora da medida". Na loja on-line isso aparece
  honestamente: 200 de 200 caixas batem com a medida e 212 elementos elegíveis não receberam caixa —
  é o teto de 200 do artefato, não falta de medida.
- **Uma rodada extra da fixture morreu em "selecionar-1: WAIT_TIMEOUT"** (o passo de destaque ao vivo
  do roteiro, que não é do mapa). A rodada foi repetida e passou; o mesmo passo passou no antes e no
  depois. Fica registrado como intermitência do roteiro, não como defeito desta mudança.

## 5. Limitações

- **Mapa sem códigos quando a página muda de tamanho.** Se a captura integral e a leitura estrutural
  descrevem leiautes diferentes, a auditoria se recusa a marcar e explica isso no relatório
  ("nenhum código foi desenhado nesta imagem"), mantendo a captura de origem e a proveniência. A
  decisão é da geometria de origem (tarefa paralela); aqui só se apresentou o texto dela com a palavra
  "código" no lugar de "número". Aconteceu no portal público e no mercado on-line nesta rodada.
- **A conferência por Tab marca os 200 primeiros elementos** da ordem de leitura e diz quantos
  ficaram fora ("Os outros 394 estão nas tabelas abaixo"). Antes dela, todas as entradas ganhavam
  caixa (510 na loja on-line), sem código nenhum: era mais caixa e menos informação. O limite de 200 é
  o mesmo já congelado do artefato do mapa.
- **Código sobre o próprio alvo.** Quando o lugar em volta está todo ocupado, a etiqueta fica sobre a
  borda do próprio elemento (41, 31 e 31 casos nas três páginas), e nas páginas mais densas alguns
  códigos ficam sobrepostos entre si (1, 7 e 7 pares). Os dois casos são declarados no relatório
  ("Alguns códigos ficaram muito próximos e podem aparecer sobrepostos. Use a tabela do elemento para
  confirmar.") e o mapa nunca é a única via: cada linha da coluna e cada tabela abaixo diz o elemento.
- **Etiqueta longe do alvo.** Na loja on-line, 22 códigos precisaram de folga maior que 4 px e o pior
  ficou a 108 px do alvo, ligado pela linha-guia. É o preço de não cobrir o conteúdo do vizinho.
- **O mapa do relatório não tem "(Tab n)".** A ordem daquele mapa é a ordem DOM/AX observada, não a
  ordem de foco. O "(Tab n)" aparece onde ele é observado de verdade: na conferência por Tab.
- **Elemento que passa da borda da imagem** é marcado só na parte visível (148 caixas na loja on-line,
  24 no mercado on-line) e a tabela do elemento continua com a medida inteira.
- **Mapa guardado antes da 1.3.0 abre como foi gerado**: números dentro da imagem, legenda raster e
  continuação da legenda, sem nenhuma classe `reader-map-*` e sem coluna. É de propósito: auditoria
  antiga é prova do que foi observado.
- **Custo do desenho.** A colocação das etiquetas é O(anotações × candidatas × anotações) no pior
  caso. Medido no módulo real, em Node: 200 elementos no mesmo pixel → 104 ms; 200 elementos em coluna
  apertada → 51 ms. Nas páginas reais da rodada o plano não apareceu em nenhum estouro de tempo, e
  nada aqui faz chamada CDP por elemento.
- **Teto de textura e de trechos** continua o do artefato (64 segmentos, 64 MiB derivados, 262 144
  pontos de código de legenda): uma página enorme pode ficar com parte dos códigos fora do mapa.
- **Nenhum teste de ponta a ponta olha o mapa.** A prova de ponta é a rodada visual, que é
  inspeção humana dirigida por medidas — não um teste que roda sozinho em integração contínua.

