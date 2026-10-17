# Caixas na 1.1.63: precisão medida contra a imagem

Data: 17 de outubro de 2026.

Tarefa 26 (retomada): parte dos elementos aparecia com a caixa deslocada no mapa do teclado, no mapa de
leitura, nos recortes do cartão e na conferência por Tab. Esta rodada fechou três causas independentes e
passou a medir a posição da caixa contra os **pixels da imagem capturada**, e não apenas contra o
retângulo registrado no artefato.

Meta da rodada: zero caixa desenhada fora do elemento. Elemento cuja posição não pode ser confirmada fica
**sem caixa** e é contado como omissão — nunca recebe uma caixa no lugar errado.

## O que estava errado

### 1. Zoom do navegador (80 % a 200 %)

O `DOMSnapshot` mede os retângulos num espaço que não acompanha o zoom da página: com o navegador em
125 %, um elemento em `x=1012..1265` px CSS aparece no instantâneo em `x=1265..1581`. O produto já
dividia pelo zoom em uma parte do caminho, mas a captura integral e a miniatura ainda pediam ao Chrome um
recorte em px CSS **sem** multiplicar pelo zoom. O resultado era uma imagem truncada (só `1/zoom` do
documento) e caixas deslocadas; o erro crescia com a distância até a origem, o que explica “muitas caixas
certas e muitas erradas” na mesma página.

### 2. Densidade da tela (1,25× e 2×)

O instantâneo mede em **px de dispositivo**, isto é, `px CSS × zoom × densidade`. A conversão anterior
dividia apenas pelo zoom. Numa tela 2×, toda caixa era desenhada no dobro da posição. A mesma densidade
inflava o PNG da captura integral além do limite de 8.192 px que os dois mapas aceitam como fonte: em
tela 2× os mapas eram omitidos por tamanho, mesmo com a página correta.

### 3. Leiaute da conferência por Tab e itens fora da área

A conferência por Tab inspecionava a página **antes** de abrir a sessão de captura. A captura integral usa
`captureBeyondViewport`, que remove a barra de rolagem clássica e alarga o leiaute durante a imagem; quem é
ancorado à direita ou ao centro caía deslocado no mapa, e o recorte do cartão pegava o vizinho. Além
disso, item de teclado totalmente fora da área capturada era **encaixado na borda** como um retângulo de
1 px — uma caixa visível num lugar onde o elemento não está. Agora esse item fica sem caixa e entra na
contagem de “sem posição medida”.

## Correções

| Arquivo | Correção |
| --- | --- |
| `src/core/evidence/fresh-geometry.js` | `snapshotScaleOf` calcula o fator do instantâneo como `contentSize / cssContentSize` (zoom × densidade), com encaixe das densidades usuais para remover o arredondamento inteiro do CDP. `domSnapshotRects` divide cada retângulo por esse fator. |
| `src/background/run-audit.js` | A remedição fresca pós-captura usa `snapshotScaleOf(captureMetrics)`; o mesmo fator vale para a leitura estrutural. |
| `src/core/normalize-snapshot.js` | A normalização colunar aplica `snapshotScaleOf(raw.layoutMetricsAtSnapshot)` aos retângulos do instantâneo. |
| `src/browser/capture-evidence.js` | `captureFullPage` multiplica o recorte pelo zoom e reduz o raster pela densidade para caber no limite de 8.192 px dos mapas; `captureElement` pede ao Chrome `clip × zoom` com escala `pixelScale / (zoom × densidade)`, mantendo o contrato “PNG = metadados × `pixelScale`”. |
| `src/reader/visual-capture.js` | A sessão de captura abre **antes** da inspeção (`openReadingVisualSession` + `establishWidenedLayout`) e fecha depois, devolvendo a área de renderização; as métricas completas de `Page.getLayoutMetrics` (incluindo o zoom) passam para `captureFullPage`. |
| `src/reader/controller.js` | Usa a sessão aberta durante a inspeção e a fecha em `finally`. |
| `src/browser/keyboard-map.js` | Item fora da área capturada deixa de ser encaixado na borda: sai das caixas, entra em `omittedNoRect` e a lista continua completa. Sem leiaute confirmado, nenhuma caixa é desenhada (a lista e a imagem continuam no relatório). |
| `src/core/keyboard/keyboard-map-artifact.js` | Algoritmo do mapa do teclado em `1.2.0`; versões `1.0.0` e `1.1.0` continuam legíveis. Novo limite declarado `stops-outside-source-omitted`. |
| `src/core/keyboard/keyboard-map-model.js`, `src/core/report/keyboard-map-presentation.js` | Catálogo e texto em linguagem simples para a nova omissão. |
| `scripts/run-tests.mjs` | O novo teste e2e do mapa de leitura entra no plano de testes reais de Chrome. |
| `test/e2e/support/real-chrome.mjs` | Opção `deviceScaleFactor` (lança o Chrome com `--force-device-scale-factor`, validado entre 0,5× e 4×) e `AUDITA_EXPECT_CHROME_PRODUCT`, para rodar a mesma bateria em 152 e 155 sem afrouxar a comparação exata. |
| `test/e2e/tab-reading-map-mv3.test.mjs` | Novo teste: mapa da conferência por Tab com **zoom real de 125 %** (`chrome.tabs.setZoom`), comparando as quatro caixas com o leiaute medido durante a captura. |

## Como a precisão foi medida

Script objetivo: `scripts/measure-box-precision.mjs` (reaproveita `test/e2e/support/real-chrome.mjs`).

1. Para cada combinação site × viewport × zoom × densidade, a auditoria real roda no Chrome for Testing
   (155), em janela visível (headed), e os artefatos são lidos como o relatório lê.
2. **Verdade do leiaute**: um amostrador na própria página registra, a cada 400 ms, `getBoundingClientRect`
   + rolagem + `clientWidth`/`innerWidth`/altura do documento. Só vale amostra estável entre quadros
   consecutivos; página que não para não é declarada alinhada.
3. **Comparação em lote**: `Runtime.evaluate` lê `getBoundingClientRect` + rolagem de todos os nós
   desenhados imediatamente antes e depois da captura integral, em uma única chamada — nunca uma ida por
   elemento. O retângulo gravado é comparado com esse valor e com a amostra estável.
4. **Verdade da imagem**: o PNG integral é recortado no retângulo gravado e no retângulo atual; o mesmo
   elemento é levado à viewport, capturado em tela cheia e recortado em Node. As três imagens são
   comparadas por erro absoluto médio numa grade de 28×28, com busca de deslocamento de até 2 px de
   raster para absorver meio pixel de ampliação, e um guarda de detalhe (conteúdo com pouca variação não
   decide sozinho). Amostra com diferença só de subpixel não é contada como erro.
5. **Elementos sem caixa**: nós desenhados que não puderam ser resolvidos/medidos na hora não entram como
   “certos”; ficam fora da contagem verificada. A omissão de mapa por tamanho de fonte é declarada.
6. Tolerância geométrica: 1,5 px CSS (o meio pixel de arredondamento do recorte). Pixel: nenhuma amostra
   pode apontar conteúdo diferente.

Combinações cobertas: zooms 80 %, 90 %, 100 %, 110 %, 125 %, 150 % e 200 %; densidades 1×, 1,25× e 2×;
zoom 125 % + densidade 2×; viewports 1280×900, 1920×1080 e 2560×1300; página local de marcação, três
portais públicos (um deles uma universidade pública) e duas lojas on-line. Todos os números abaixo são de
execuções com o Chrome 155 em janela visível.

## Antes e depois — página local de marcação (1280×900)

“Desenhadas / verificadas / desalinhadas”: caixas que o artefato mandou desenhar, quantas puderam ser
medidas de forma estável e quantas estavam fora do elemento. “Pixel”: amostras de imagem alinhadas /
erradas / inconclusivas.

| Cenário | Antes (des./verif./desal.) | Depois (des./verif./desal.) | Pixel depois |
| --- | --- | --- | --- |
| 100 % (controle) | 180 / 180 / 0 | 180 / 180 / 0 | 0 erradas |
| 80 % | 180 / 180 / **180** | 180 / 180 / **0** | 27 / 0 / 9 |
| 90 % | 180 / 180 / **180** | 180 / 180 / **0** | 25 / 0 / 11 |
| 110 % | 150 / 145 / **145** | 185 / 185 / **0** | 23 / 0 / 13 |
| 125 % | 143 / 139 / **139** | 185 / 185 / **0** | 24 / 0 / 11 |
| 150 % | 115 / 111 / **111** | 172 / 172 / **0** | 20 / 0 / 16 |
| 200 % | 88 / 88 / **88** | 165 / 165 / **0** | 26 / 0 / 8 |
| Tela 1,25× (zoom 100 %) | 140 / 140 / **140** | 185 / 185 / **0** | 23 / 0 / 13 |
| Tela 2× (zoom 100 %) | 15 / 15 / **15**, mapas omitidos | 185 / 185 / **0**, mapas desenhados (PNG 1396×8192) | 18 / 1 / 16 |
| Zoom 125 % + tela 2× | 10 / 9 / **9** | 185 / 185 / **0** (PNG 1046×8190) | 17 / 0 / 18 |

O único “1” na coluna de pixel da tela 2× é um título cuja largura mudou 5 px entre a captura e a
amostragem de tela (barra de rolagem voltando); o retângulo gravado e o medido na hora são idênticos
(distância 0) e a caixa não está deslocada. É limitação do comparador de pixel, não da caixa.

## Antes e depois — viewports grandes (zoom 125 %)

| Viewport | Antes | Depois | Pixel depois |
| --- | --- | --- | --- |
| 1920×1080 | 140 / 140 / **140** | 180 / 180 / **0** | 34 / 0 / 2 |
| 2560×1300 | 142 / 142 / **142** | 180 / 180 / **0** | 33 / 0 / 3 |

## Antes e depois — sites reais (zoom 125 %)

Nomes neutros, conforme a regra do projeto.

| Site | Viewport | Antes | Depois | Pixel depois |
| --- | --- | --- | --- | --- |
| Portal público A (página inicial) | 1280×900 | 169 / 131 / **131** | 244 / 204 / **0** | 2 / 0 / 34 |
| Portal público A | 1920×1080 | 205 / 175 / **175** | 313 / 279 / **0** | 3 / 0 / 33 |
| Portal público A | 2560×1300 | 208 / 176 / **176** | 313 / 279 / **0** | 2 / 0 / 34 |
| Portal público B (universidade) | 1280×900 | 57 / 57 / **57** | 142 / 142 / **0** | 6 / 0 / 5 |
| Portal público C | 1280×900 | não medido (página cresce durante a captura) | mapas omitidos (PNG 715×9002, acima do limite de 8192); 0 caixas verificadas | sem amostra |
| Loja on-line A | 1280×900 | 188 / 180 / **180** | 290 / 290 / **0** | 25 / 0 / 10 |
| Loja on-line B | 1280×900 | não medido (conteúdo muda durante a auditoria) | 110 / 73 / **0**; 37 sem medida estável | 3 / 0 / 9 |

Um terceiro portal público não abriu no harness (respondeu 200, mas a avaliação foi recusada); foi
substituído pelo Portal público B. O caso ficou registrado e não entra nos números.

## Elementos sem caixa (contagem honesta)

- Página local em 125 %: 2 elementos sem retângulo dentro da captura; 1 item de teclado fora da área
  capturada (`keyboardOmittedNoRect = 1`).
- Portal público A em 1280: 17 itens da leitura e 24 do teclado fora da área capturada; 12 elementos sem
  retângulo na imagem. Em 1920/2560: 14 e 17 fora da área; 11/10 sem retângulo.
- Loja on-line A: 8 e 2 fora da área; 22 sem retângulo.
- Loja on-line B: 264 elementos sem retângulo na imagem (página que se remonta); nenhum deles recebeu
  caixa.
- Portal público C e Portal público B (universidade) com mapas omitidos por altura da fonte: os itens
  continuam nas listas e a omissão é declarada no relatório.

Nenhuma dessas omissões foi convertida em caixa na borda: quem não tem posição confirmada não recebe
desenho.

## Testes

### Unitários

`node scripts/run-tests.mjs` (parte unitária, sem Chrome): **4796 testes, 4794 passam, 1 falha esperada,
1 ignorado**. A única falha é `test/release-package.test.js` (hash do ZIP público), esperada enquanto o
fonte muda e o pacote não é reconstruído.

Cobertura nova, por causa:

- `test/evidence/fresh-geometry.test.js`: fator do instantâneo com densidade 2×, zoom 125 % + tela 2×,
  arredondamento inteiro do CDP (894/715) e densidade fracionária 1,25×.
- `test/evidence/capture-evidence.test.js`: captura integral em tela 2× (PNG = metadados × escala, dentro
  de 8192), zoom 125 % + tela 2× e miniatura com contrato “PNG = metadados × `pixelScale`”.
- `test/evidence/keyboard-map-artifact.test.js`: versão 1.2.0, leitura de 1.0.0/1.1.0 e novo limite.
- `test/browser/keyboard-map.test.js`: item fora da área fica sem caixa; leiaute reprovado não desenha.
- `test/background/run-audit.test.js` e `test/core/normalize-snapshot.test.js`: o fator do instantâneo
  chega à remedição e à normalização.
- `test/e2e/support/real-chrome.test.mjs`: opção de densidade e produto esperado por variável de
  ambiente.

### E2E no Chrome real (um arquivo por vez)

| Arquivo | Chrome 155 | Chrome 152 |
| --- | --- | --- |
| `tab-reading-map-mv3` (novo, zoom 125 %) | 1/1 | 1/1 |
| `keyboard-map-mv3` | 3/3 | 3/3 |
| `keyboard-map-cresce-mv3` | 1/1 | 1/1 |
| `public-axe-map-mv3` | 1/1 | 1/1 |
| `capture-visible-element` | 1/1 | 1/1 |
| `tab-reading-guided-mv3` | 1/1 | 1/1 |
| `sidepanel-flow-mv3` | 9/9 | 9/9 |

Nas primeiras tentativas do `sidepanel-flow-mv3`, outra sessão de testes Chrome rodava na mesma máquina:
uma janela ociosa de 45 s registrou eventos de foco externos (14 de foco e 14 de desfoque, com geometria
e foco final idênticos) e houve `WAIT_TIMEOUT` sob a carga. Repetido com a máquina livre, o arquivo
passou 9/9 nas duas versões. A falha era de foco do sistema operacional, não de caixa.

## Imagens de exemplo (pasta `qa-out/precisao-final3/exemplos/`)

- `antes-zoom125-tela.png`, `antes-zoom125-atual.png`, `antes-zoom125-gravado.png`: em 125 %, o recorte do
  retângulo gravado mostra “mais detalhes” enquanto a tela e a medição atual mostram o texto seguinte —
  a caixa apontava para outro elemento.
- `depois-zoom125-tela.png`, `depois-zoom125-atual.png`, `depois-zoom125-gravado.png`: os três recortes
  mostram o mesmo “mais detalhes”.
- `depois-tela2x-elemento-tela/atual/gravado.png`: miniatura em tela 2× com os três recortes idênticos.
- `depois-portal-2560-teclado-atual.png` e `-tela.png`: caixa do mapa do teclado em viewport 2560×1300
  com zoom 125 % sobre o mesmo ícone.

## Superfícies conferidas

| Superfície | O que foi feito |
| --- | --- |
| Mapa do teclado | Linhas `keyboard-map` da matriz de precisão em todos os zooms, densidades e viewports; e2e `keyboard-map-mv3` e `keyboard-map-cresce-mv3`. |
| Mapa de leitura / “Conferir leitura por Tab” | e2e novo com zoom real de 125 %, comparando as quatro caixas com o leiaute medido durante a captura. |
| Recortes do cartão e da conferência | Linhas `element` da matriz (incluindo tela 2× e zoom + tela 2×); contrato “PNG = metadados × `pixelScale`” nos testes unitários; recortes de pixel conferidos visualmente. |
| Fichas de evidência e anexos | Usam os mesmos artefatos e hashes; não há conversão de coordenadas própria. O caminho de exportação não foi alterado nesta rodada. |
| Marcadores ao vivo | Posicionados pelo `getBoundingClientRect` atual em px CSS, não pelo `DOMSnapshot`; o zoom desloca elemento e marcador juntos. Cobertos pelos testes de marcadores do `sidepanel-flow-mv3` (9/9 nas duas versões). |

## Limitações

- Os mapas derivados recusam fonte com lado maior que 8.192 px (limite congelado do formato). Página muito
  alta tem o mapa omitido mesmo com a captura integral disponível; a lista e a explicação continuam no
  relatório. Isso vale para o Portal público C e para o Portal público B (universidade) nesta rodada.
- Página que cresce continuamente ou se remonta durante a auditoria não permite confirmar posição. Nesses
  casos a caixa não é desenhada; os itens continuam listados e a contagem de sem posição é declarada.
- O comparador de pixel usa até 2 px de deslocamento para absorver arredondamento de raster; amostra com
  diferença apenas de subpixel é inconclusiva, não erro. Um título na tela 2× ficou inconclusivo por
  variação de largura de 5 px entre captura e amostragem.
- A densidade de tela agora é testável no harness por `--force-device-scale-factor`; a emulação do CDP
  não serve para esse caso porque a auditoria limpa a emulação antes de medir.
- O harness recusou um portal público (HTTP 200, avaliação falhou). O caso foi registrado e a matriz
  seguiu com outro portal.

## Conferência independente da revisão (portal estadual de defesa do consumidor)

Rodada feita na revisão, fora da tarefa, com `scripts/measure-box-precision.mjs` e `--save-full-image`,
Chrome for Testing 155 em janela visível, 1280×900, contra o código da 1.1.62 (`65829e0`) e o da 1.1.63:

| Cenário | 1.1.62 | 1.1.63 |
| --- | --- | --- |
| Zoom 125 % | captura integral truncada em `1/zoom` (a margem direita e o fim da página ficam fora da imagem); retângulos gravados × 1,25 (ex.: campo de busca gravado em `447,239 268×38`, real `358,191 220×30`); 57 caixas do teclado, 43 do mapa de leitura e 23 elementos não confirmáveis | 268 caixas conferidas, 0 desalinhadas; teclado 57/57, mapa de leitura 76/76, elementos 135/135 |
| Tela 2× (zoom 100 %) | mapas omitidos; só 15 elementos com caixa, e os recortes apontam para o lugar errado (7 de 15 reprovados pelos pixels, o resto inconclusivo) | 265 caixas conferidas, 0 desalinhadas; PNG 1566×8192; teclado 57/57, mapa de leitura 76/76, elementos 132/132 |

As imagens com as caixas desenhadas sobre a captura integral foram abertas e conferidas a olho: na 1.1.63 as
caixas cobrem o banner, os cartões de notícia, os títulos e os botões; na 1.1.62 em tela 2× a caixa do
banner cai sobre os cartões.
