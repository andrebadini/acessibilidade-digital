# Recorte com contorno para todos os elementos, sem captura de tela por elemento — 1.1.62

Data: 16/10/2026. Versão em trabalho: **1.1.62** (branch `wip162/recortes`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão e o `build:release` são o passo de
release). Chrome for Testing 152.0.7977.64, um Chrome por vez.

Por regra do projeto, **nenhum nome de órgão público, domínio institucional ou loja é registrado aqui**. Os ensaios
em página real são descritos como **portal público**, **mercado on-line** e **loja on-line**.

O pedido do produto tinha seis partes, todas em cima da mesma pergunta: *por que o relatório deixa
elementos sem imagem, e por que a auditoria fica lenta numa página de loja?*

1. O artefato da evidência de elemento guarda **onde ele estava na captura da página inteira**
   (`fullPageRect`, com os fragmentos de linha em `fullPageParts`) e **de qual captura** isso se refere
   (`fullPageEvidenceId`) — em esquema fechado, projetado no modelo do relatório e dentro do hash
   canônico; auditorias antigas continuam abrindo.
2. O recorte obedece a uma ordem fixa: **miniatura própria → recorte da integral pela posição gravada →
   recorte pela geometria dos mapas** (auditorias anteriores) **→ texto** do elemento.
3. **Desempenho:** elemento dentro da integral **não** pede captura de tela nem medição por elemento; só
   o que está fora dela (página truncada pelo teto de segurança, `iframe`) continua sendo capturado.
   Os trechos de código (`DOM.getOuterHTML`) passaram a ser pedidos em lotes de 8.
4. Onde a miniatura aparecia hoje — relatório HTML/PDF, "Abrir relatório completo", revisão guiada,
   ficha de evidência — aparece o **recorte da integral** quando não há miniatura própria. A integral é
   embutida **uma vez** e os recortes apontam para ela por `<use>`/`viewBox`, sem duplicar bytes.
5. **Privacidade:** as mesmas regras de hoje (campos privados mascarados, marcação de privacidade)
   valem para o recorte, com teste.
6. **Ficha de evidência:** o elemento sem miniatura própria mostra o recorte e diz **"recorte da captura
   integral `<ID>`"**, com o **SHA-256 do PNG da integral** e link para o registro dela.

Mais um ajuste herdado da tarefa 19: no **Anexo de evidências**, o item derivado do mapa não pode mais
dizer "Imagem segura: PNG local não disponível." nem "SHA-256 do arquivo de imagem (PNG): não se
aplica" — ele diz onde ver a imagem e aponta para a seção do mapa.

## 1. O defeito, medido

### 1.1 Cada elemento custava uma captura de tela

Até a 1.1.61, todo elemento citado por uma ocorrência virava uma chamada `Page.captureScreenshot` com
recorte — uma por elemento, em fila, com uma remedição (`DOM.getContentQuads` + `Page.getLayoutMetrics`)
antes de cada uma. Medido nas três páginas reais (mediana de 2 execuções, medidor `scripts/perf-audit.mjs`):

| página | `Page.captureScreenshot` antes | ms somados |
| --- | ---: | ---: |
| fixture local | 70 chamadas | 1 985 |
| portal público | 111 chamadas | 7 517 |
| loja on-line | 101 chamadas | 6 673 |

Numa página grande o orçamento de miniaturas acabava antes da lista: a loja on-line fechava a fase com
`orcamentoAtingido=true` e **150 miniaturas** — as ocorrências depois da 150ª ficavam sem imagem
nenhuma, para sempre.

### 1.2 A imagem da página inteira já estava guardada, e não era usada

A captura integral (`full-page`) sempre foi feita, guardada e desenhada nos mapas. O que faltava era o
**endereço do elemento dentro dela**: a auditoria media o retângulo do elemento (`DOMSnapshot`) e
guardava o retângulo do *documento*, mas nunca dizia "este elemento está nesta região da imagem que eu
já tenho". Sem esse dado, a única forma de mostrar o elemento era tirar uma foto nova dele.

### 1.3 O relatório entregue citava a imagem sem poder mostrar

No HTML/PDF entregue, a ficha do elemento sem miniatura dizia que a imagem não estava disponível, e o
item do mapa no anexo repetia "não se aplica" para o hash do arquivo. Eram dois becos sem saída: o
leitor via a citação e não tinha para onde ir.

## 2. A solução

### 2.1 A posição na captura integral, em esquema fechado

`src/core/evidence/fresh-geometry.js` ganhou `integralCaptureRect(rect, imageSize)`: recebe o retângulo
fresco do elemento (o mesmo que autoriza o mapa a desenhar caixa) e o tamanho declarado da captura
integral, e devolve o retângulo **em px CSS da imagem**, aparado nas bordas, ou `null` quando não há
pixel guardado ali. A tolerância (`INTEGRAL_RECT_TOLERANCE_PX = 1`) só absorve arredondamento de meio
pixel: um elemento colado na borda pode ficar meio pixel fora sem que nada esteja errado.

O artefato de elemento passou a guardar dois campos, ambos **opcionais**:

- `fullPageRect` — a caixa do elemento na imagem;
- `fullPageParts` — os fragmentos de linha (no máximo 8, o mesmo teto da marcação desenhada), quando o
  inline multilinha tem mais de uma linha;
- `fullPageEvidenceId` — **obrigatório** quando um dos dois existe: uma posição solta não teria de onde
  ser recortada nem como ser conferida depois.

No `closed-schema.js` os dois nomes entraram na lista de chaves aceitas da evidência de elemento e a
validação exige retângulo exato (`x`, `y`, `width`, `height`, largura e altura positivas). No
`audit-model.js` entraram na lista de projeção — sem isso o recorte sumia do relatório em silêncio,
mesmo com a captura integral guardada.

**Nenhum hash antigo muda:** o JSON canônico do artefato é recalculado a partir do que está guardado, e
uma auditoria sem os campos continua com o hash que tinha. Isso está fixado por teste
(`a auditoria anterior, sem a posição, mantém o hash e o caminho antigo`) e pela abertura da fixture de
1.1.56 no teste de compatibilidade.

### 2.2 O recorte, na ordem do produto

`src/core/report/evidence-crop.js` já respondia "onde está este elemento nas imagens guardadas?" pela
geometria dos mapas. Agora a **primeira** resposta é a posição gravada (`elementCropSource`, com
`elementEvidence`), e a geometria dos mapas continua sendo a segunda — é ela que atende as auditorias
anteriores à 1.1.62, que não têm o campo. Sem nenhuma das duas, `null`: quem chama mostra o **texto** do
elemento, nunca uma caixa adivinhada.

O recorte **não gera pixel novo**: a imagem guardada entra inteira no SVG e a janela é o `viewBox` — o
mesmo desenho de `evidenceMediaParts`, com a caixa, o escurecimento e o contorno de
`evidence-highlight.js`. O teto de bytes decodificados da integral é
`EVIDENCE_CROP_MAX_INTEGRAL_DECODED_BYTES = 64 MB` (dezesseis vezes o teto dos recortes de mapa), porque
recortar a integral não acrescenta byte nenhum ao documento.

### 2.3 Nenhuma captura por elemento dentro da integral

Em `src/background/run-audit.js`, antes de montar os trabalhos de evidência:

```js
const integralUsable = Boolean(state.fullPage) && mapSource?.aligned === true &&
  freshRects instanceof Map && freshRects.size > 0 && integralImageSize !== null;
const integralPosition = node => {
  if (!integralUsable) return null;
  if (Array.isArray(node.framePath) && node.framePath.length > 0) return null;
  return integralCaptureRect(freshRects.get(node.backendNodeId), integralImageSize);
};
```

Quatro condições, todas com motivo: a captura integral existir; a **geometria fresca** ter sido aceita
(`aligned` — a mesma decisão que autoriza o mapa a desenhar caixa); o elemento ter retângulo medido
**nesse** leiaute; e o retângulo cair **dentro** da área que a imagem cobre — a página truncada pelo
teto de segurança deixa o resto fora, e `iframe` fica fora porque o retângulo de um nó de frame está no
sistema de coordenadas do frame.

No laço de captura, um elemento com posição gravada **não chama `captureElement` nem `measureElementTarget`**:
ele só incrementa o contador `integral` e segue. Quem fica de fora continua sendo capturado como antes.

### 2.4 Os trechos de código em lotes

`DOM.getOuterHTML` era uma chamada por elemento, uma depois da outra. Agora vai em lotes de
`EVIDENCE_SNIPPET_CONCURRENCY = 8` em voo (`Promise.all` por lote), com o **mesmo** sanitizador por
elemento (privacidade do texto e dos valores) e a conferência do orçamento da fase **entre lotes**.

**Cuidado de leitura da tabela:** o medidor soma a latência de **cada chamada**, não o tempo de parede.
Com 8 chamadas em voo, a soma de `DOM.getOuterHTML` pode passar o tempo de parede da fase inteira — na
fixture, 468 ms somados contra 181 ms de fase `evidencias`. A soma **não** é tempo de relógio; quem mede
o ganho é a coluna de fase.

### 2.5 Onde a miniatura aparecia

| lugar | antes | depois |
| --- | --- | --- |
| HTML/PDF entregue (`src/core/report/html.js`) | miniatura ou "imagem não disponível" | miniatura própria, senão o recorte da integral, senão o texto |
| "Abrir relatório completo" (`src/core/report/audit-model.js`) | idem | idem |
| relatório aberto no painel (`src/review/report-view.js`) | idem | idem |
| revisão guiada (`src/review/review.js`) | recorte só pela geometria dos mapas | recorte pela posição gravada |
| CSV | não cita imagem | não cita imagem (nada a fazer) |

No HTML e no relatório do painel, a captura integral é embutida **uma vez** e cada recorte é um
`<svg viewBox="…"><use href="#evidence-image-0"/></svg>`: o `data:image/png;base64` da integral aparece
**uma** vez no documento inteiro, não uma vez por elemento. Conferido por contagem nos testes e no
arquivo entregue (portal público: 15 data-URLs = 1 integral + 14 trechos de mapa, contra 119 `<use>`).

### 2.6 Privacidade

O recorte não inventa caminho novo de pixel: ele recorta os **bytes da captura integral que já estão
guardados** — a mesma imagem que o relatório já desenha nos mapas e na ficha da captura. Tudo o que o
portão de privacidade mascara na captura está mascarado no recorte, porque é o mesmo PNG; nada é
recapturado. O que a mudança poderia estragar é o sanitizador dos trechos, que passou a rodar em lotes:
ele continua sendo aplicado **por elemento** (`privateTextDescendant`, valores e atributos privados), e
os testes de privacidade fecham em 58 de 58 (`test/background/pixel-privacy-gate.test.js` +
`test/evidence/snippet.test.js`). O caso degenerado — posição gravada sem os pixels da captura — está
fixado em `a posição na captura integral não sobrevive à falta dos pixels dela`: o relatório mostra o
texto do elemento, nunca uma caixa adivinhada.

### 2.7 Ajuste do anexo derivado do mapa (tarefa 19)

O item de mapa que não tem PNG próprio deixou de dizer "Imagem segura: PNG local não disponível." e
"SHA-256 do arquivo de imagem (PNG): não se aplica". No lugar, uma frase com link: *"As imagens deste
mapa estão na seção Mapa …, com o SHA-256 de cada trecho."* Teste:
`o item do mapa no anexo manda ver as imagens na seção do mapa`.

## 3. Arquivos tocados

| arquivo | o que mudou |
| --- | --- |
| `src/core/evidence/fresh-geometry.js` | `integralCaptureRect` e `INTEGRAL_RECT_TOLERANCE_PX` |
| `src/core/report/closed-schema.js` | `fullPageRect`/`fullPageParts` nas chaves aceitas e validados |
| `src/core/report/audit-model.js` | os dois campos entram na projeção do modelo |
| `src/background/run-audit.js` | portão da integral, sem captura/medição dentro dela, trechos em lotes de 8 |
| `src/core/report/evidence-crop.js` | posição gravada como primeira escolha; teto da integral |
| `src/core/report/html.js` | recorte na ficha e no anexo, integral embutida uma vez, item de mapa da tarefa 19 |
| `src/review/report-view.js` | recorte na constatação, na prévia e na ficha do relatório aberto |
| `src/review/review.js` | 8 linhas: `elementEvidence` no `elementCropSource` do cartão |
| `scripts/perf-audit.mjs` | 1 linha: `waitForReport({auditId})` sem `timeoutMs` |
| `test/background/run-audit.test.js` | 3 testes novos |
| `test/report/element-full-page-crop.test.js` | **novo**, 14 testes |
| `test/review/report-view-evidence-fiche.test.js` | 2 testes novos |
| `test/e2e/keyboard-map-mv3.test.mjs` | expectativas ajustadas (abaixo) |

`review.js` foi tocado o mínimo possível (8 linhas) por causa da tarefa paralela da leitura por Tab.

## 4. Testes

| arquivo | resultado |
| --- | --- |
| `test/report/element-full-page-crop.test.js` | 14/14 |
| `test/review/report-view-evidence-fiche.test.js` | 8/8 |
| `test/background/run-audit.test.js` | passou |
| `test/report/legacy-1.1.56-compat.test.js` | passou (auditoria antiga continua abrindo) |
| suíte unitária completa (`node scripts/run-tests.mjs`, bloco unitário) | **4 731 testes, 4 729 passam**, 1 falha esperada |

Os três testes novos do `run-audit` são exatamente as três afirmações do pedido:

- `the element inside the pristine capture records its position instead of a screenshot` — **zero**
  `captureElement` para quem está dentro da integral;
- `the element below the captured area keeps asking for its own screenshot` — quem está fora continua
  sendo capturado;
- `snippet reads overlap with a bounded number of CDP calls in flight` — a concorrência dos trechos é
  limitada.

### 4.1 A única falha da suíte, e por que ela é esperada

`test/release-package.test.js` falha **de propósito** enquanto a árvore está modificada: ele confere o
hash do ZIP de release, que muda a cada alteração de fonte. A subida de versão e o `build:release` são o
passo de release, não desta tarefa.

### 4.2 A expectativa de E2E que mudou, e por quê

`test/e2e/keyboard-map-mv3.test.mjs` afirmava que a auditoria guarda o SHA-256 do arquivo **da miniatura
de elemento**. Nesta página estável os elementos caem **dentro** da captura integral e por isso não têm
mais captura própria — o arquivo que a ficha anuncia é o **PNG da integral** que sustenta o recorte. O
teste passou a recalcular o hash do arquivo que a evidência **realmente usa** (a miniatura quando
existe, a integral quando é ela que sustenta o recorte) e ganhou três afirmações novas:
`withOwnPixels === 0`, `positioned === elements` e o `fullPageEvidenceId` do primeiro elemento. A
verificação byte a byte continua a mesma.

### 4.3 E2E em Chrome real (um arquivo por vez)

| arquivo | resultado |
| --- | --- |
| `test/e2e/capture-visible-element.test.mjs` | 1/1 |
| `test/e2e/keyboard-map-mv3.test.mjs` | 3/3 |
| `test/e2e/current-page-export-mv3.test.mjs` | 1/1 |
| `test/e2e/report-print-layout.test.mjs` | 1/1 |
| `test/e2e/field-label-review.test.mjs` | 1/1 |
| `test/e2e/hostile-pages-mv3.test.mjs` | 15/15 |
| `test/e2e/mandatory-journey-mv3.test.mjs` | 1/1 |

23 testes, nenhuma falha (o `hostile-pages` sozinho leva ~3 min: são 15 páginas hostis, cada uma com
auditoria e captura reais).

## 5. Validação em página real (antes e depois)

Mediana de 2 execuções por página, `node scripts/perf-audit.mjs`, com o mesmo Chrome for Testing. O
"antes" é a cópia sem as mudanças; o "depois" é esta árvore. O fixture local entra como referência
controlada.

### 5.1 Tempo

| fase / etapa | fixture antes → depois | portal público antes → depois | loja on-line antes → depois |
| --- | --- | --- | --- |
| `evidencias` (fase) | 2 151 → **181** ms | 8 611 → **99** ms | 8 460 → **1 247** ms |
| `total` da auditoria | 4 488 → **2 605** ms | 20 497 → **12 014** ms | 15 182 → **7 227** ms |
| `auditoriaAteResultado` | 6 782 → **4 545** ms | 29 128 → **16 881** ms | 22 524 → **12 392** ms |
| `relatorioCompleto` | 509 → 530 ms | 2 883 → **919** ms | 1 965 → **914** ms |
| `verificacaoGuiada` | 513 → 531 ms | 2 885 → **920** ms | 1 967 → **916** ms |
| `exportacaoQuatroFormatos` | 3 913 → **3 101** ms | 12 973 → **5 776** ms | 8 930 → **6 045** ms |

| chamada CDP | fixture antes → depois | portal antes → depois | loja on-line antes → depois |
| --- | --- | --- | --- |
| `Page.captureScreenshot` | 1 985 ms / 70 → **219 ms / 5** | 7 517 ms / 111 → **351 ms / 3** | 6 673 ms / 101 → **736 ms / 8** |
| `DOM.getContentQuads` | 8 ms / 67 → **0 ms / 2** | 19 ms / 108 → **nenhuma** | 33 ms / 150 → 8 ms / 53 |
| `Page.getLayoutMetrics` | 22 ms / 83 → 8 ms / 18 | 33 ms / 123 → 8 ms / 15 | 178 ms / 171 → 92 ms / 74 |

O que sobra de `Page.captureScreenshot` depois são a integral e a captura da dobra — não mais uma por
elemento. Os 82 elementos da loja on-line que ainda pedem captura própria (na primeira execução) são os
que ficam **fora** da área coberta pela imagem, e a diferença entre as duas execuções (82 e 24) é o
próprio site mudando de altura entre uma e outra.

### 5.2 Cobertura

| página | miniaturas antes | recortes da integral depois | ainda capturados depois |
| --- | ---: | ---: | ---: |
| fixture local | 67 | **65** | 2 |
| portal público | 108 | **108** | 0 |
| loja on-line (1ª execução) | **150** (`orcamentoAtingido=true`) | 104 | 82 |
| loja on-line (2ª execução) | **150** (`orcamentoAtingido=true`) | 84 | 24 |

A loja on-line é o caso que mostra as duas metades: o orçamento **deixa de ser atingido**
(`orcamentoAtingido=false` nas duas execuções depois), e a página ganha imagem em elementos que antes
ficavam sem nenhuma.

### 5.3 Tamanho do que é entregue

| página | HTML antes → depois | PDF antes → depois | imagens no PDF antes → depois |
| --- | --- | --- | ---: |
| fixture local | 7 841 → **4 176** KB | 6 321 → **4 077** KB | 80 → 15 |
| portal público | 46 200 → **12 280** KB | 37 506 → **9 347** KB | 119 → 14 |
| mercado on-line | 37 701 → **8 528** KB | 26 059 → **7 158** KB | 139 → 17 |
| loja on-line | 18 356 → **11 415** KB | 15 791 → **9 133** KB | 83 → 16 |

O HTML encolhe porque para de carregar uma cópia base64 de cada miniatura; o PDF encolhe pelo mesmo
motivo. O JSON entregue carrega a posição (números) em vez dos bytes de 150 PNGs.

## 6. Conferência visual dos recortes

`node scripts/visual-qa.mjs` com fixture + três páginas reais, imagens abertas uma a uma
(`qa-out/recortes-1.1.62/<página>/*.png`, diretório não versionado) e ampliadas quando a caixa era
pequena. O que as imagens mostram:

| imagem | o que se vê |
| --- | --- |
| `10-revisao-cartao.png` (mercado on-line) | o cartão da pergunta mostra o **recorte da integral** com o contorno vermelho **colado na lupa** (o elemento da pergunta) e a legenda "Recorte tirado da captura da página inteira desta auditoria." |
| `10-revisao-cartao.png` (fixture) | o mesmo, no elemento do carrossel: contorno na imagem e legenda do recorte |
| `10b-recorte-ampliado.png` (portal público) | o recorte ampliado sai **nítido** e o contorno vermelho fecha exatamente na borda da imagem do elemento — nenhum deslocamento de meio pixel |
| `07-evidencia-3.png` (loja on-line) | constatação com falha: contorno vermelho exatamente no carrossel de produtos e a frase "A imagem original é a captura integral full-page-1dedff5b." |
| `11-ficha-evidencia.png` (portal público) | ficha completa: imagem recortada e contornada, "Este elemento não tem arquivo de imagem próprio: a imagem acima é um recorte da captura integral full-page-ba807252. Consultar a ficha dessa captura, com o arquivo e o SHA-256 dele.", o ID, o SHA-256 do registro e o **SHA-256 do arquivo PNG** |
| `12-anexo-impresso.png` | o item de mapa do anexo com a frase que manda ver as imagens na seção do mapa (tarefa 19), sem "PNG local não disponível" |

Elementos que **antes ficavam sem imagem nenhuma** aparecem contornados nessas telas: são justamente os
que estouravam o orçamento de 150 miniaturas na loja on-line.

### 6.1 A fixture reprovou em um passo, e não é desta mudança

A corrida completa terminou com "1 de 4 página(s) com problema: 127.0.0.1-marcacao.html", no passo
`selecionar-1` (o anel do primeiro sinal selecionado não apareceu na página). O que foi apurado:

- **É reproduzível nesta árvore e não é do recorte.** Desligando só o portão da captura por elemento
  (`integralPosition` sempre `null`, todo o resto igual), o passo passa 2 de 2; mantendo o portão e
  reduzindo a concorrência dos trechos para 1, continua falhando 2 de 2. Ou seja, quem desloca o passo é
  a auditoria ficar ~2,3 s mais curta, não o recorte nem os trechos em lote.
- **A 1.1.61 sem nenhuma mudança também reprova nesse passo.** Em 4 corridas da fixture na cópia intacta,
  1 falhou com o mesmo `WAIT_TIMEOUT` (e o sinal que falha muda: 50, 68, 69).
- **A causa é a própria fixture.** O `marcacao.js` da página de teste tem o "CASO 10": um carrossel que
  troca o slide ativo a cada 2 s, e `marcacao.css` deixa os demais slides com área zero. Quando o
  primeiro sinal escolhido pertence a um slide que **não** está no ar naquele instante, a marcação da
  página não tem caixa para desenhar: medido na falha, o grupo existe (`found: true`), mas o anel fica
  `display: none`, sem geometria, e `Ir ao elemento` não rola a página (o `scrollIntoView` não tem o que
  centralizar); os outros 48 grupos estavam desenhados no mesmo instante. A leitura mais provável para a
  diferença de frequência é a fase do carrossel: como todos os passos do roteiro têm duração fixa, o
  instante da primeira seleção em relação ao ciclo de 2 s depende do tempo da auditoria — a mais curta cai
  sempre na mesma fase (7 de 7 aqui), a mais longa cai em fases variadas (1 de 4 lá).
- **Nas três páginas reais esse passo passa inteiro** — as três seleções com anel em cada uma, nas duas
  corridas.

Não houve, portanto, mudança de roteiro: o passo continua medindo o que media, e a reprovação é do
carrossel da página de teste. Fica registrado aqui como está no resumo da corrida.

## 7. Limitações e o que fica registrado

- **Página truncada pelo teto de segurança.** Acima de `FULL_PAGE_CAPTURE_LIMITS` (16 384 px de altura
  ou 40 milhões de pixels) a captura integral não cobre a página inteira: os elementos abaixo do que
  foi capturado continuam pedindo captura própria, e a auditoria fica `partial` com o diagnóstico
  `FULL_PAGE_CAPTURE_TRUNCATED`. É o comportamento desejado — recortar de uma imagem que não contém o
  elemento daria uma caixa errada.
- **`iframe`.** O retângulo de um nó dentro de frame está no sistema de coordenadas do frame; ele não é
  posicionado na integral e continua sendo capturado como antes.
- **`fullPageParts` vem do instantâneo.** Quando o inline multilinha aparece na captura com mais linhas
  do que o instantâneo registrou, o recorte usa a caixa envolvente. O contorno continua correto; o que
  pode ficar menos justo é a janela.
- **A soma de `DOM.getOuterHTML` não é tempo de parede.** Com 8 chamadas em voo, o medidor soma cada
  latência e o total passa o tempo da fase. Quem mede o ganho é a coluna de fase.
- **Instabilidade de arranque.** A primeira campanha "antes" morreu em `CDP_EVENT_TIMEOUT` numa segunda
  execução do portal público, com outro Chrome rodando em paralelo (outra tarefa desta mesma versão).
  A corrida foi refeita só com as duas páginas que faltavam; a fixture veio da execução anterior.
- **Mercado on-line indisponível no medidor.** Nas duas campanhas de tempo a página respondeu
  `unavailable` (o medidor navega do zero, sem sessão); os números de tamanho de exportação dele vêm da
  corrida de QA visual, não do medidor de tempo.
- **`scripts/perf-audit.mjs` levou 1 linha de conserto.** `waitForReport` recusa argumento a mais e
  passar `timeoutMs` fazia a medição da jornada morrer em `REPORT_CONTEXT_DENIED` antes de medir
  qualquer coisa. A mesma linha existe na cópia "antes", para que a comparação seja entre iguais.

## 8. Testes finais

| bloco | resultado |
| --- | --- |
| suíte unitária (`node scripts/run-tests.mjs`) | 4 731 testes, **4 729 passam**, 1 falha esperada (`test/release-package.test.js`, hash do ZIP), 1 pulado |
| E2E em Chrome real, um arquivo por vez | 7 arquivos, **todos passam** |
| `node scripts/verify-neutral-identity.mjs` (identidade neutra) | passa (exit 0) |
| `node scripts/visual-qa.mjs` (fixture + 3 páginas reais) | **3 das 4 páginas sem nenhum erro**; a fixture reprova só no passo do anel da primeira seleção, pelo carrossel da própria página de teste (seção 6.1) — a mesma reprovação aparece, mais rara, na 1.1.61 intacta |

A suíte completa da tarefa, medida de novo no fim (unidade, os cinco arquivos de teste da mudança e os
sete de E2E), fecha sem nenhuma falha além da esperada do ZIP.

O `run-tests.mjs` roda também um segundo bloco, o dos E2E de Chrome real embutidos na suíte: ele exige
`AUDITA_E2E_CHROME`/`CHROME_BIN` no ambiente e, sem a variável, reprova em bloco com
`AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para este E2E real` — é por isso que os E2E desta tarefa
foram rodados um arquivo por vez, com a variável exportada, como a linha de cima registra.
