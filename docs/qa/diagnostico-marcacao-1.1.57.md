# Diagnóstico — marcação na página e precisão das caixas nas capturas

Versão analisada: 1.1.56 (branch `fix/marcacao-precisa-1.1.57`).
Relato: (a) os sinais numerados e o destaque individual não marcam muitos elementos e a marcação não fica visualmente colada ao elemento; (b) as caixas nas capturas de elemento (relatório HTML, revisão e mapa anotado) não são precisas e às vezes contornam vários elementos.

Escopo deste documento: leitura de código, sem execução de navegador nesta tarefa. Todas as afirmações abaixo citam arquivo:linha. Não houve alteração de código.

---

## 1. Por que um achado com elemento NÃO recebe sinal na página

### 1.1 O caminho do dado

1. A ocorrência carrega `nodeId` do snapshot (`src/core/rules/snapshot.js:152-155`; axe correlaciona o alvo por seletor estrutural em `src/core/axe/normalize-axe-results.js:261-265`).
2. A evidência de elemento guarda `selector.css` produzido por `buildStableSelector` (`src/background/run-audit.js:1084`, `src/core/evidence/selector.js:168-204`) e o `snippet` do elemento.
3. Na projeção, `locatorFor` reconstrói o "match" a partir do `snippet` + `selector.css` (`src/background/page-marker-projection.js:77-109`).
4. O overlay resolve o match no DOM vivo (`src/browser/page-markers-overlay.js:251-279`).

Só passam adiante os alvos que sobrevivem a **todas** as etapas. Cada etapa tem um motivo de descarte próprio.

### 1.2 O que `buildStableSelector` emite (só três formas)

`src/core/evidence/selector.js:177-187`:

- id único e não sensível → `tag#id` (`confidence: 'high'`);
- sem id, **com** atributo `class` → `css` fica vazio e cai em `nthPath` (linhas 184-186 + 143-161);
- sem id e **sem** `class` → `semanticSelector`, isto é `tag[name="..."]`, `tag[title="..."]`, `tag[alt="..."]`, `tag[aria-label="..."]`, `tag[data-testid="..."]`, `tag[role="..."]` (`:105-114`), e se nenhum atributo semântico for único → `nthPath`.

Observação importante: **quando o elemento tem `class`, o seletor emitido nunca usa as classes** — ele é sempre o caminho estrutural `tag > tag:nth-of-type(n) > ...`.

### 1.3 Causas de descarte, em ordem da cadeia

**A. `unsupported-selector` — seletor semântico não pertence à gramática fechada.**
`parseCssSelectorV1` só aceita `[role="…"]`/`[type="…"]` com valores de listas fechadas (`src/background/highlight-locator.js:22`, `:25-34`, `:70-75`). Logo `input[name="email"]`, `img[alt="…"]`, `a[title="…"]`, `div[data-testid="…"]` fazem `parseCssSelectorV1` lançar, e `locatorFor` devolve `unsupported-selector` (`src/background/page-marker-projection.js:84-90`).
→ **Estimativa: muito frequente.** Todo elemento sem `class` cujo único traço estável é `name`/`alt`/`title`/`aria-label`/`data-testid` cai aqui (campos de formulário, imagens, links de ícone).

**B. `unsupported-selector` — id/token com 4 dígitos seguidos ou 8 hexadecimais.**
`isSensitiveSelectorToken` rejeita `/[0-9]{4}/` e `/[0-9a-f]{8}/iu` (`src/background/highlight-locator.js:19-20`, `:182-185`), aplicado a todo `#id`/`.classe` pelo `scanCompleteRawTokens` (`:54`, `:187-192`). Um `id="section-2024"`, `id="tab-1234"`, `id="player-abcdef12"` faz o parse lançar → `unsupported-selector`.
→ **Estimativa: frequente** em CMS/blogs/lojas com ids datados ou sequenciais.

**C. `insufficient-correspondence` — elemento sem `class` utilizável.**
`locatorFor` exige, para o ramo estrutural, `identity.classes.length > 0` (`src/background/page-marker-projection.js:96-100`), onde `identity.classes` são as classes **do snippet** filtradas por `classifySelectorToken` (`:73`). Se o elemento não tem atributo `class` (ou só tem classes filtradas, ex. `class="md:text-lg"`, `class="a1b2c3d4"`), a lista fica vazia → `insufficient-correspondence`.
→ **Estimativa: a causa mais frequente em números absolutos.** Elemento sem `class` e sem id estável **nunca** recebe sinal: ou vira `semanticSelector` (cai em A) ou vira `nthPath` (cai aqui).

**D. `insufficient-correspondence` — id presente no snippet, mas seletor estrutural.**
Quando o id existe e **não** é único no snapshot, ou é sensível, `buildStableSelector` ignora o id e emite `nthPath` (`src/core/evidence/selector.js:177-186`), mas `rootIdentity` ainda lê o `id` do snippet (`src/background/page-marker-projection.js:72`). A checagem `last.id !== identity.id` (`:92`) falha → `insufficient-correspondence`.
→ **Estimativa: frequente** em HTML com ids duplicados (widgets repetidos, templates).

**E. `unsupported-selector` — caminho estrutural profundo demais.**
`nthPath` não tem limite de segmentos (`src/core/evidence/selector.js:143-161`), mas `parseCssSelectorV1` limita a 16 segmentos e complexidade 64 (`src/background/highlight-locator.js:4-5`, `:56-58`, `:85-86`). DOMs de framework com 16+ níveis estouram antes de chegar ao match.
→ **Estimativa: moderada**, sobe bastante em páginas de aplicação.

**F. `unsupported-context` — iframe e shadow DOM.**
`framePath` não vazio ou `' >>> '` no seletor → `unsupported-context` (`src/background/page-marker-projection.js:78-79`). Também `context !== 'top-document'` na projeção (`:179-180`) e `getRootNode() !== document` no overlay (`src/browser/page-markers-overlay.js:239`).
→ **Frequente e por desenho**: nenhum conteúdo de iframe (banners, players, mapas, áreas de pagamento) recebe sinal.

**G. `missing-evidence` / `conflicting-evidence`.**
Sem artefato de evidência para o mesmo `nodeId`/`pageId` (`:121`) ou artefatos divergentes para o mesmo nó (`:126`). Também `occurrence.nodeId === null` (`:182`), o que inclui **toda ocorrência do axe em subframe** (`src/core/axe/normalize-axe-results.js:262`).

**H. `not-displayed` / `page-or-process` → "geral".**
Classificação nula ou alvo de documento viram "questão geral", sem sinal (`:175-178`).

**I. `ambiguous` / `not-found` no overlay (DOM vivo).**
`resolveTarget` exige **exatamente 1** correspondência de `tag#id` ou `tag.c1.c2` (`src/browser/page-markers-overlay.js:254-260`) e, no ramo de classes, que o caminho estrutural resolva para o **mesmo** elemento (`:267-273`).
→ **Estimativa: alta** em sites com classes utilitárias genéricas (Tailwind/Bootstrap): `identity.classes.slice(0, 2)` (`src/background/page-marker-projection.js:103`) tende a produzir combinações como `div.absolute.flex`, que casam com dezenas de elementos → `ambiguous`.

**J. `not-rendered`.**
`renderedReason` descarta elemento com `display:none`, `visibility:hidden/collapse` ou rect de área zero (`src/browser/page-markers-overlay.js:241-244`) — inclui itens em abas/accordions/carrosséis fechados. Elementos apenas fora da viewport **não** são descartados (a checagem não olha a viewport).

**K. Limite de 64.**
`captureBundle` corta `details.slice(0, 64)` (`src/background/page-markers-controller.js:304`) e a leitura de ordinais vai até 63 (`:66-68`, `:85-86`); o overlay também limita a 64 alvos e 64 sinais (`src/browser/page-markers-overlay.js:95`, `:118`, `:128`).
→ **Estrutural e determinístico**: em qualquer página com mais de 64 achados, tudo além do 64º fica sem sinal. O painel informa o total em "ocorrências omitidas" (`src/panel/panel-view.js:756-758`), mas **não** informa o motivo por ocorrência — `buildPlan` não propaga `projection.public.unlocated[].reason` (`src/background/page-markers-controller.js:309-340`), então `insufficient-correspondence`/`ambiguous`/`unsupported-selector` nunca chegam à interface.

---

## 2. Por que os sinais SOMEM depois de aparecer

**2.1 Um único alvo ou descendente que muda derruba TODOS os sinais.**
`MutationObserver` observa o documento inteiro com `subtree:true, childList:true, attributes:true, characterData:true` (`src/browser/page-markers-overlay.js:585`). Para cada registro ele sobe a partir do nó alterado; se encontrar um elemento marcado, chama `dispose(true)` (`:566-583`), o que remove host, listeners e envia `AUDITA_PAGE_MARKERS_CLEARED` (`:327-353`).

Consequência: **qualquer** troca de `class`/`style`/`src` ou **qualquer** mudança de texto dentro de um elemento marcado apaga a marcação inteira. Casos reais: contadores ao vivo, carrossel, `hover` que alterna classes (o `hover` num ancestral do alvo não derruba, mas no próprio alvo ou em descendente derruba), lazy-load de imagem dentro do alvo, atualização de região `aria-live`.

**2.2 Um único alvo que deixa de ser exato derruba TODOS.**
`verifyAndPosition` usa `groups.some(group => !stillExact(group) || !positionGroup(group))` → `dispose(true)` (`:374-379`). Ou seja:

- um elemento que passa a casar com mais de um nó (`ambiguous`) ou deixa de casar (`not-found`) apaga tudo (`:369-372`);
- um elemento que fica `display:none`/área zero pela mesma checagem `renderedReason` apaga tudo (`:356-358`).

Isso transforma qualquer transformação local (accordion que fecha, aba que troca, slide que sai) em "todos os sinais desapareceram".

**2.3 Selecionar um sinal pode apagar os sinais.**
`op: 'select'` faz `scrollIntoView` e agenda `scheduleVerification` (`:449-456`); se o scroll/lazy-load mudar um alvo, o passo 2.2 apaga tudo.

**2.4 Navegação: qualquer âncora.**
`popstate` e `hashchange` chamam `dispose(true)` (`:557-560`). Clicar num link âncora da própria página (`#secao`) remove todos os sinais — comportamento muito visível na revisão.
(O destaque individual **não** tem `popstate`; ele sobrevive a `hashchange`, `src/browser/highlight-overlay.js:817-825`. Inconsistência entre as duas funções.)

**2.5 TTL.**
`ttlMs = min(1_800_000, expiresAt - startedAt)` (`src/background/page-markers-controller.js:412`) e o overlay dispara `dispose(true)` no fim do prazo (`src/browser/page-markers-overlay.js:586`); a sessão tem TTL de 30 min (`src/background/target-capabilities.js:378`). Se a validade da origem/sessão for menor, os sinais somem sem ação do usuário e sem explicação na página.

**2.6 `pagehide`.**
`pagehide` apaga (`:558`), inclusive em navegações que voltam (bfcache).

---

## 3. Problemas visuais da marcação na página

**3.1 O botão numerado não tem vínculo visual com o elemento.**
Ele é posicionado em `left = rect.left`, `top = max(0, rect.top - 22)` (`src/browser/page-markers-overlay.js:364-365`), medindo 30 px de altura e no mínimo 38 px de largura (`:503-504`). Não há seta, linha-guia nem caixa. O elemento marcado normalmente aparece **abaixo** de alguma coisa, então o número "flutua" sobre o conteúdo vizinho.

**3.2 O anel só existe no sinal selecionado.**
`updateGroup` só põe `ring.style.display = 'block'` quando `selectedId` corresponde a um sinal do grupo e ele está visível (`:410-411`). Sem seleção, não há **nenhuma** indicação do retângulo do elemento — só o número solto. É exatamente o "não fica visualmente unido".

**3.3 Sobreposição entre botões.**
Não existe verificação de colisão. Elementos empilhados com menos de ~30 px de intervalo (itens de menu, ícones, links de lista) produzem botões que se sobrepõem, escondendo uns aos outros e cobrindo os elementos de cima.

**3.4 `clamp` só no topo.**
`Math.max(0, rect.top - 22)` (`:365`) evita que o botão saia pelo topo, mas com `rect.top < 22` o botão fica **em cima** do elemento. Não há tratamento para `rect.left < 0` nem para `rect.left + largura > viewport`: o botão simplesmente renderiza fora da tela.

**3.5 Elementos pequenos.**
O botão tem mínimo de 38×30 px (`:503-504`) e o anel tem `borderRadius: 4px` com `borderWidth: 3px` (`:493-495`). Para um ícone de 16×16 ou um link de uma palavra, o botão é maior que o próprio elemento e o anel arredondado "come" o elemento.

**3.6 Contraste.**
As cores são fixas: `#8b1e1e`, `#8a5a00`, `#6b4e00`, `#1f6f43` (`:282-286`). Sobre fundos escuros (tema noturno, cabeçalhos coloridos) o anel e a borda do botão praticamente somem. Não há `outline` branco/escuro de reforço nem `forced-colors` para os sinais (o único CSS do shadow é `.audita-marker:focus-visible`, `:475`).

**3.7 Recorte por ancestral — não ocorre.**
O host é `position:fixed` na raiz e os filhos também (`:465-513`), então `overflow` de ancestrais **não** recorta os sinais. O problema é o inverso: eles podem ficar soltos por cima de qualquer coisa, sem conter-se ao elemento.

**3.8 Atualização de posição.**
A reposição ocorre em `requestAnimationFrame` a partir de eventos `scroll`/`resize` (`:551-564`). Em rolagem contínua ou animação interna (acordeão abrindo) os sinais ficam deslocados até o próximo quadro — e qualquer mudança estrutural nesse meio-tempo cai em 2.1/2.2.

---

## 4. Origem e precisão do `rect` das capturas de elemento

### 4.1 De onde vem o `rect`

- `run-audit.js:1068-1071` chama `captureElement(cdp, node.rect, {...layoutMetrics})`.
- `node.rect` vem do snapshot: `DOMSnapshot.captureSnapshot` com `includeDOMRects: true` (`src/browser/collect-page.js:48-52`) → `document.layout.bounds[i]` → `{x,y,width,height}` (`src/core/normalize-snapshot.js:574-585`), em **CSS px no sistema de coordenadas do documento daquele frame**.
- Só se não houver `layout.rect` ele cai no `runtimeData.documentRect`, que é `getBoundingClientRect() + scroll` (`src/collector/page-collector.js:455-456`) — mesmo sistema de coordenadas.

Não há **nenhuma** remedição do elemento antes da captura (nem `DOM.getBoxModel`, nem `getBoundingClientRect`). Confirmei por busca: nenhum chamador usa outra fonte de rect.

### 4.2 Defasagem entre medição e captura (confirmada pela ordem do pipeline)

1. `run-audit.js:874-876` — screenshot da página inteira (T0), logo após `waitForStable`.
2. `run-audit.js:908` — axe.
3. `run-audit.js:950-953` — `collectPage` → `DOMSnapshot` (T1, de onde sai todo `rect`).
4. `run-audit.js:1027-1084` — fase de evidências, muito depois: `DOM.getOuterHTML` por elemento e depois `Page.captureScreenshot` com clip (T2).

Consequências:

- A imagem de página inteira (T0) é anterior à medição dos rects (T1): qualquer deslocamento (imagem que carrega, banner, fonte tardia, cabeçalho fixo) faz o rect apontar para outro ponto da imagem. O mapa anotado herda esse desalinhamento (`src/background/run-audit.js:1113-1130` combina snapshot de T1 com a imagem de T0).
- A miniatura do elemento usa o rect de T1 para recortar o estado de T2. **Como `clip` e `highlightBox` saem do mesmo rect** (`src/browser/capture-evidence.js:115-123`), a caixa fica sempre bem posicionada *dentro da miniatura*; o erro aparece quando o layout mudou entre T1 e T2 — a miniatura mostra outro conteúdo dentro de uma caixa correta. Ou seja, a caixa errada não vem de desalinhamento interno, e sim do rect em si (4.3) ou do conteúdo.

### 4.3 Quando o rect legitimamente contorna vários elementos

- **Alvo é um contêiner.** `node.rect` é o border-box do próprio nó. Regras de núcleo e do axe apontam para o elemento que viola: `ul`/`ol` (listas), `table`, `label`/`form` (associação), `region`, `li` de item de lista, `div` de agrupamento. Nada aqui "recorta" o filho relevante.
- **Elemento inline em várias linhas.** O `bounds` do DOMSnapshot para um inline é a caixa envolvente de todos os fragmentos de linha (mesma semântica de `getBoundingClientRect`). Um `<a>` que quebra em 3 linhas gera uma caixa que atravessa o texto vizinho.
- **Recorte nas bordas do documento.** `normalizedClip` trunca nos limites da página: `targetRight = min(size.width, documentX + rect.width)` e `clipRight = min(size.width, …)` (`src/browser/capture-evidence.js:107-113`). Um elemento mais largo que a página capturada produz `highlightBox` indo de `x` até a largura total da imagem — literalmente "a caixa contorna vários elementos". O mesmo vale na vertical, e a altura usada é a do snapshot em T1, não a do screenshot.
- **Elemento dentro de iframe.** Nós de subframe estão em `snapshot.nodes` com `rect` no sistema do **próprio** documento e `framePath` preenchido (`src/core/normalize-snapshot.js:851`); a captura de elemento não filtra por `framePath` (`src/background/run-audit.js:1030-1039`). O clip é aplicado ao documento de topo → região arbitrária. Ocorrências com `nodeId` em iframe existem (regras de núcleo agrupam por `frameId`/`framePath`, ex. `src/core/rules/forms.js:165`) — o caminho do axe já devolve `null` para subframe (`src/core/axe/normalize-axe-results.js:262`).
- **Fora da área capturada.** Em página truncada pelo teto de 16.384 px (`src/browser/capture-evidence.js:65`), o que ficou abaixo devolve `cantTell` com `reason: 'invalid-or-outside-rect'` (`:140`), e a evidência fica sem imagem.

### 4.4 `devicePixelRatio`, zoom e escala

- `clip` usa `scale: 1` em CSS px (`src/browser/capture-evidence.js:115`); o retângulo é sempre em CSS px.
- Em tela com DPR > 1 o bitmap sai na resolução CSS (perde nitidez), mas as coordenadas permanecem coerentes, porque `metadata.width/height` são as do clip (`:143`) e é isso que alimenta o `viewBox` (`src/core/report/html.js:216-219`, `:877-882`; `src/review/report-view.js:544-545`).
- Risco real: quando `metadata.width` falta e o fallback é a largura do PNG decodificado (`finitePositive(...) || png.width`, `src/core/report/html.js:216-217`), uma imagem em escala de dispositivo mistura sistemas e desalinha a caixa.
- `clipInsideViewports` decide `captureBeyondViewport` com `cssVisualViewport/cssLayoutViewport` **do momento da coleta** (`:126-136`) — decisão tomada com métricas velhas.

### 4.5 A margem de 24 px

`ELEMENT_CONTEXT_MARGIN = 24` (`src/browser/capture-evidence.js:3`) é aplicada como contexto, e depois cortada nas bordas (`:110-113`). Para elemento colado à esquerda/topo, um dos lados perde o contexto; para elemento grande, 24 px de moldura é pouco para um leigo perceber o que está contornado; para elemento pequeno, a moldura domina a imagem.

### 4.6 O traço cobre o próprio conteúdo (confirmado)

`src/core/report/report.css.js:84-85`:

```
.evidence-highlight{fill:none;vector-effect:non-scaling-stroke;pointer-events:none;stroke-width:7}
```

- O `<rect>` é desenhado exatamente no border-box do alvo (`src/core/report/html.js:884-892`), sem recuo: o traço centralizado na borda invade ~3,5 px **para dentro** do elemento (padding/borda) e ~3,5 px para fora (conteúdo vizinho).
- `non-scaling-stroke` mantém 7 px de traço na **tela**, independentemente da redução do SVG. Com `.evidence-media{max-width:100%;height:auto}` (`:83`) e uma miniatura de, digamos, 1.400 px de viewBox exibida a 600 px, cada lado cobre ≈16 px de origem do elemento — em elementos de 30–40 px o contorno engole o próprio conteúdo. Este é, com alta probabilidade, o "não dá precisão" sentido pelo usuário.
- Nos tons `review` e `passed` há `stroke-dasharray` (`:85`), o que piora a leitura em elementos pequenos.

### 4.7 Duplicação de lógica

O mesmo cálculo de caixa existe em dois lugares, com o mesmo comportamento: `src/core/report/html.js:884-892` e `src/review/report-view.js:541-566` (mais o schema em `src/core/report/closed-schema.js:409-412` e o recorte em `src/core/report/audit-model.js:537`). Qualquer correção precisa ser feita nos dois.

### 4.8 Campo morto

`rectBucket` é validado com exigência de múltiplo de 16 px (`src/background/highlight-binding.js:149-160`), mas o adaptador sempre grava `rectBucket: null` (`src/background/chrome-adapter.js:1449`). O "bucket" previsto no esquema nunca é usado — não há checagem de posição na prova ao vivo.

---

## 5. Mapa anotado (`src/browser/annotation-map.js`)

**5.1 Não desenha caixas — desenha círculos com linha-guia.** `drawSegment` pinta apenas `arc` (marcador) e uma linha do marcador até `targetX/targetY` = centro do elemento (`:669-685`). Portanto "caixa que contorna vários elementos" no mapa, quando aparece, vem do **legenda/relatório** ou da leitura do marcador; o mecanismo próprio do mapa é outro: marcador longe do elemento.

**5.2 Quem entra no mapa.** `significant()` aceita por papel ou tag, incluindo contêineres: `region`, `list`, `listitem`, `table`, `li`, `details`, `summary`, `iframe` (`:24-29`, `:97-99`). Um `li` com link + texto, uma `table` ou uma `region` entram com o rect inteiro.

**5.3 Marcador longe do alvo.** `bounds` = `node.rect` (`:273-276`, `:296`). `markerCandidates` parte dos 8 pontos do perímetro e depois de uma espiral com espaçamento `MARKER_CLEARANCE = 32` px (`:38-39`, `:328-381`), e `placeMarkers` escolhe o candidato que **menos colide com marcadores já colocados** (`:387-401`) — sem qualquer custo por distância ao próprio elemento. Em áreas densas o número é empurrado para longe; a linha-guia é a única ligação, e num raster reduzido ela é difícil de seguir.

**5.4 Contêineres grandes.** Para um `region`/`table` de página inteira, o centro do alvo fica no meio do bloco e a linha cruza todo o conteúdo — o número parece pertencer a outro elemento.

**5.5 Recorte e omissões.** `clippedBounds` corta nos limites da captura (`:320-326`) e quem ficar fora entra em `omittedNoRect` (`:557-561`); limites de nós/legenda cortam o restante (`:281-288`). O artefato marca-se como `partial` e as limitações são declaradas (`:869-874`), mas o usuário vê apenas números faltando.

**5.6 Escala.** `scaleX`/`scaleY` vêm de `sourceMetadata` × `cssContentSize` (`:306-314`, `:544-551`); se `cssContentSize` vier truncado pelo teto de captura, `run-audit.js:1121-1126` ajusta a altura — sem esse ajuste a escala vertical distorceria todos os marcadores.

---

## 6. Correções recomendadas, priorizadas

### P0 — devolver cobertura de marcação (impacto direto no relato (a))

1. **Permitir match por caminho estrutural sem exigir classes no snippet.** `src/background/page-marker-projection.js:96-100`: hoje um elemento sem `class` nunca é localizado. Aceitar `match` só com `{tag, path}` e ajustar `src/browser/page-markers-overlay.js:109-113` (`validStructuralPath`) e `:267-273` (resolve) para aceitarem lista de classes vazia.
   Testes: `test/highlight/page-markers-overlay.test.js` ("idless unique classes locate…", "idless paths are closed structural selectors…"), `test/e2e/page-markers-signals-mv3.test.mjs`, `test/highlight/page-markers-fixture.js`.

2. **Suportar o ramo semântico (`tag[attr="value"]`) em `parseCssSelectorV1`** ou emitir um match dedicado `{tag, attribute:{name,value}}` em vez de um seletor CSS. Hoje `src/background/highlight-locator.js:22` fecha a gramática e `src/background/page-marker-projection.js:84-90` transforma todo `input[name=…]` em `unsupported-selector`.
   Testes: `test/highlight/highlight-locator.test.js`, `test/evidence/selector.test.js`, `test/e2e/highlight-marking-mv3.test.mjs`.

3. **Não descartar por id no snippet quando o seletor é estrutural.** `src/background/page-marker-projection.js:92` — trocar a exigência de igualdade de id por "ou o snippet não tem id, ou o id do último segmento é o mesmo".
   Testes: `test/highlight/page-markers-overlay.test.js:75` ("…never guesses among duplicates or an element with an ID").

4. **Elevar/expurgar o teto de 64 com limite por página e aviso por elemento.** `src/background/page-markers-controller.js:304`, `src/browser/page-markers-overlay.js:95/118/128`. No mínimo, propagar `projection.public.unlocated[].reason` até o painel (`src/panel/panel-view.js:803-820`) para o usuário ver *por que* falta sinal.
   Testes: `test/e2e/page-markers-signals-mv3.test.mjs`, `test/panel/*`.

### P1 — estabilidade dos sinais (relato (a), "somem")

5. **Não derrubar a instalação inteira.** `src/browser/page-markers-overlay.js:374-379`: remover apenas o grupo afetado (ou esconder) em vez de `dispose(true)`; reservar o descarte total para navegação/TTL/clear.
   Testes: `test/highlight/page-markers-overlay.test.js:400` ("target mutation… invalidate once"), `:425`, `:442`.

6. **Estreitar o MutationObserver.** `src/browser/page-markers-overlay.js:566-585`: não descartar por mutação **dentro** do alvo; aceitar mutações e apenas reposicionar; limitar a observação a `childList` no `documentElement` + `attributes` filtrado, ou verificar identidade em vez de destruir.
   Testes: `test/highlight/page-markers-overlay.test.js:442`.

7. **Remover `popstate`/`hashchange` do descarte** (ou revalidar em vez de descartar) — `src/browser/page-markers-overlay.js:557-560`.
   Testes: idem + `test/e2e/page-markers-signals-mv3.test.mjs`.

8. **Renovar o TTL e explicar o fim** (`src/background/page-markers-controller.js:412`, `src/browser/page-markers-overlay.js:586`).

### P2 — vínculo visual (relato (a), "não fica unido")

9. **Anel sempre visível** para todo grupo (não só o selecionado) e com variante de contraste: `src/browser/page-markers-overlay.js:410-411` e `:493-495`.
10. **Ligar botão ao elemento**: deslocar o botão para fora do rect (`rect.top - altura - folga`), com clamp nas quatro bordas e, quando não houver folga, uma linha-guia/`::after` até o canto — hoje só existe `Math.max(0, rect.top - 22)` (`:365`).
11. **Evitar colisão** entre botões (empurrar em espiral, como já existe em `annotation-map.js:328-357`) e reduzir o tamanho mínimo em elementos pequenos (`:503-504`).
12. **Contraste garantido**: contorno branco/preto no anel e no botão, e regra para `forced-colors` (hoje o shadow só tem `:focus-visible`, `:475`).

### P3 — precisão das capturas (relato (b))

13. **Remedir o rect imediatamente antes do clip.** Substituir `node.rect` por uma medição fresca do `backendNodeId` em `src/background/run-audit.js:1068` — via `DOM.getBoxModel` (quads) ou `DOM.getContentQuads`, que devolve os quads de linha de um inline em vez da caixa envolvente. Isso ataca simultaneamente a defasagem T1→T2 e o caso do inline multilinha. Ajustar `src/browser/capture-evidence.js:138-146` para aceitar quads.
    Testes: `test/e2e/capture-visible-element.test.mjs`, `test/evidence/capture-evidence.test.js`, `test/browser/annotation-map.test.js`.

14. **Recolorir o traço por dentro do alvo.** Em `src/core/report/report.css.js:84-85` e/ou no cálculo da caixa: recuar o `<rect>` (por exemplo 1 px) e reduzir o `stroke-width`, ou trocar por `stroke-linejoin` com offset; documentar que `non-scaling-stroke` faz o traço crescer em relação ao elemento em miniaturas reduzidas. Fazer nos **dois** pontos: `src/core/report/html.js:884-892` e `src/review/report-view.js:541-566`.
    Testes: `test/report/html.test.js`, `test/review/report-view.test.js`, `test/report/capture-receipt-presentation.test.js`, `test/report/evidence-provenance.test.js`.

15. **Não truncar silenciosamente a caixa nas bordas.** `src/browser/capture-evidence.js:107-113`: quando o alvo exceder a página capturada, declarar a limitação (metadado) em vez de produzir uma caixa que vai de ponta a ponta. Considerar margem adaptativa (mín. 24 px, até 15% do lado maior do alvo).

16. **Tratar nós de subframe**: pular a captura de elemento (ou capturar no frame correto via `documentIds`) quando `node.framePath` não for vazio — `src/background/run-audit.js:1030-1039` hoje monta o clip no documento de topo com coordenadas do frame.
    Testes: `test/e2e/lazy-iframe-current-page-mv3.test.mjs`, `test/browser/collect-page.test.js`.

17. **Consistência de escala**: sempre preferir `metadata.width/height` do clip; se ausentes, derivar de `clip` (não do PNG decodificado) — `src/core/report/html.js:216-217`, `src/review/report-view.js:544-552`.

### P4 — mapa anotado

18. **Penalizar distância no `placeMarkers`** (`src/browser/annotation-map.js:392-395`): hoje o score só conta colisão com outros marcadores; somar um custo proporcional à distância ao alvo, com teto, para o número não migrar para longe.
19. **Excluir contêineres não semânticos** ou restringir `region`/`table`/`list` no `significant` (`:97-99`, `:24-29`) quando existirem descendentes significativos; hoje um `li`/`table` inteiro vira uma anotação só.
20. **Declarar no relatório os motivos de omissão por elemento** (contagens já existem: `omittedNoRect`, `omittedFrame`, `omittedLimit`, `unresolvedOverlap`, `:247`, `:561-562`) para o leitor saber que faltam números.

### P5 — coerência e limpeza

21. **Unificar a numeração.** O destaque individual usa `index + 1` sobre `model.occurrences` (`src/background/highlight-controller.js:135`, `:141`), enquanto o sinal numerado usa o ordinal do marcador na página (`src/background/page-marker-projection.js:199-204`). O mesmo achado aparece com números diferentes nas duas funções.
    Testes: `test/highlight/highlight-controller.test.js`, `test/e2e/highlight-marking-mv3.test.mjs`.
22. **Preencher ou remover `rectBucket`** (`src/background/chrome-adapter.js:1449`, `src/background/highlight-binding.js:149-160`).
23. **Alinhar o comportamento de navegação** entre os dois overlays (`src/browser/page-markers-overlay.js:551-564` × `src/browser/highlight-overlay.js:817-825`).
24. **Unificar o cálculo da caixa** num único módulo compartilhado por `src/core/report/html.js` e `src/review/report-view.js`.

---

## 7. Resumo executivo das causas mais prováveis

| # | Sintoma | Causa principal (arquivo:linha) |
|---|---|---|
| 1 | Muitos elementos sem sinal | Todo elemento sem `class` utilizável é recusado (`page-marker-projection.js:96-100`); seletores semânticos são recusados pela gramática (`highlight-locator.js:22`) |
| 2 | Muitos elementos sem sinal | Limite rígido de 64 achados por exibição (`page-markers-controller.js:304`) |
| 3 | Marcação não colada ao elemento | Botão a 22 px acima, sem anel fora do selecionado e sem linha-guia (`page-markers-overlay.js:364-365`, `:410-411`) |
| 4 | Sinais somem sozinhos | Um alvo/descendente mutado apaga tudo (`page-markers-overlay.js:566-585`); um alvo inexato apaga tudo (`:374-379`) |
| 5 | Caixa contorna vários elementos | Rect do contêiner/inline multilinha/iframe ou truncado nas bordas (`capture-evidence.js:107-113`; `normalize-snapshot.js:574-585`) |
| 6 | Caixa imprecisa visualmente | `stroke-width: 7` com `non-scaling-stroke` sobre o border-box exato do alvo (`report.css.js:84-85`) |

Nenhum arquivo de código foi alterado nesta tarefa.
