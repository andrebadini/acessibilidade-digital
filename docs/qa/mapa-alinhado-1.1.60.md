# Mapa alinhado 1.1.60 — caixa na posição da imagem, ou nenhuma caixa

Data: 15/10/2026. Versão em trabalho: **1.1.60** (branch `wip160/mapa-alinhado`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão e o `build:release` são o passo
de release). Chrome for Testing 152.0.7977.64, um Chrome por vez.

Escopo: os **dois mapas derivados** da captura integral — o mapa de anúncios e o mapa do teclado. O
defeito de origem é o que uma pessoa leiga vê primeiro: **caixa azul no lugar errado**. No relatório
de uma página real, o mapa declarava *"As escalas horizontal e vertical da captura não são uniformes"*
e *"Itens fora da área capturada foram encaixados na borda da imagem"*, e as caixas do rodapé não
correspondiam aos textos dos links. Para quem não programa, uma caixa no lugar errado é pior do que
caixa nenhuma: ela ensina a olhar o lugar errado.

Esta rodada fecha a **pendência 1 da 1.1.59**: as páginas que crescem sozinhas (loja on-line, mercado
on-line) voltam a ter caixas — **alinhadas** — pela via do **aquecimento** da §4, sem nunca desenhar
caixa desalinhada. Onde a página não para dentro do teto, continua valendo a regra da §2: nenhuma
caixa, lista inteira e a explicação em linguagem simples.

Por regra do projeto, **nenhum nome de órgão, domínio de governo ou loja é registrado aqui**. Os três
ensaios em página real são descritos como **portal público**, **loja on-line** (a mesma do defeito
original) e **mercado on-line**.

> **Escopo negativo.** `page-markers-*`, `highlight-*`, o painel lateral e a revisão guiada são de
> tarefas paralelas. Aqui eles não foram tocados. As mudanças fora do mapa estão listadas na §3.1 e
> são de uma linha cada.

## 1. O defeito, medido

O mapa desenha retângulos lidos do instantâneo estrutural (DOMSnapshot + árvore de acessibilidade)
sobre um PNG da página inteira. Até a 1.1.59 essas duas coisas vinham de **momentos diferentes**: a
captura saía logo depois da navegação estabilizar e a estrutura era lida segundos depois, no fim do
axe. Numa página que se monta sozinha, o PNG ficava de um estado e os retângulos de outro.

| Medida (diagnóstico desta branch) | Como foi medida | Resultado |
| --- | --- | --- |
| Deriva do defeito original | Altura do documento no instante da captura **vs** no da leitura | **757 px → 3.121 px** (PNG de 4.760 bytes, praticamente vazio na captura): deriva de **2.364 px** |
| Efeito dessa deriva no mapa | Escala derivada das métricas da coleta sobre esse PNG | `scaleX` 1 e `scaleY` **0,2426** — as duas escalas discordam, todas as caixas caem nos 24 % de cima da imagem, e a limitação de escala não uniforme é impressa |
| Deriva da **ordem antiga** hoje (captura logo após a navegação → leitura 3,5 s depois) | Altura do documento nos dois instantes, aba oculta | portal público: 4.463 px → 4.463 px (**0 px**); loja on-line: 4.402 px → 4.402 px (**0 px**); mercado on-line: 1.727 px → 3.064 px (**+1.337 px**) |
| Deriva da **janela da coleta** (métricas → instantâneo → árvore AX → métricas), ordem nova | Três leituras de `Page.getLayoutMetrics` em volta da leitura estrutural | **0 px** de largura e **0 px** de altura nos três sites, em 38–72 ms |
| Deriva da **própria captura** (métricas → captura integral → métricas) | `Page.captureScreenshot` com `captureBeyondViewport` e o recorte da página inteira | portal público: 4.463 px → 4.463 px (**0 px**, 367 ms); mercado on-line: 2.970 px → 2.970 px (**0 px**, 292 ms); loja on-line: 4.271 px → 4.402 px (**+131 px**, 374 ms) |
| O que essa deriva de 131 px faria com as caixas | 479 âncoras (links, botões, títulos, imagens) medidas antes e depois da captura na loja on-line | **254 âncoras deslocadas** mais de 2 px, **maior deslocamento 130 px** (conteúdo que se expande quando a captura o expõe) — a caixa do rodapé cairia 130 px fora do texto |
| Por que a captura mexe no leiaute **só na aba oculta** | Mesma medição na loja on-line com a aba visível | 0 px: a auditoria abre a aba com `active: false`; é a exposição da captura integral nessa aba que faz o conteúdo preguiçoso se montar |
| O que a aba oculta **não** congela | Contador de `setInterval`, `requestAnimationFrame`, animação CSS e cadeia de `fetch` por 2 s | temporizador, animação e quadro: **0 tiques**; rede (`fetch`): **sem limite** — foi essa medição que definiu a fixture da §5 |

Duas conclusões saem da tabela. A primeira: a ordem antiga estava errada **de forma intermitente** —
nos três sites de hoje ela só cobrou o preço no mercado on-line, que ainda estava se montando; é por
isso que o defeito aparecia numa página e não em outra. A segunda: mover a captura para colar na
leitura resolve a maior parte, mas **não** resolve a página que cresce durante a própria captura, e
sobre esse crescimento o programa não pode mentir — não existe estado medido que descreva aquele PNG.
É exatamente esse caso que a **§4** ataca: em vez de escolher entre mentir e não marcar, fazer a
página parar **antes** de ler.

## 2. A regra

> Se a captura e a leitura não descrevem o mesmo leiaute, **o mapa não marca**. A lista de texto
> continua inteira; o que sai é a caixa.

Isso é o requisito do produto dito em uma frase. Ele é implementado em três partes: aproximar a
captura da leitura, medir a concordância e recusar a marca quando ela não existe.

## 3. O que entrou

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Captura colada na leitura | `src/background/run-audit.js` | A captura integral saiu de logo depois da navegação para **imediatamente depois da coleta estrutural** (`capturePristineFullPage`). Entre as duas não há passo interativo: o axe e o ambiente vêm antes, as verificações dinâmicas depois. As métricas do recorte são lidas **no mesmo instante** da captura |
| Geometria do instantâneo | `src/browser/collect-page.js` | Nova leitura de `Page.getLayoutMetrics` **colada antes** do `DOMSnapshot.captureSnapshot`, devolvida como `layoutMetricsAtSnapshot`. Os retângulos do mapa vêm desse instantâneo, não do fim da coleta: numa página que cresce sozinha o fim da coleta já é outro leiaute |
| Acordo de leiaute | `src/core/evidence/map-source-geometry.js` (**novo**) | `mapSourceGeometry({ captureMetrics, captureMetricsAfter, observedMetrics, capturedHeight, deviceScaleFactor })` responde *"a captura e a leitura descrevem o mesmo leiaute?"* e monta as métricas que os mapas usam. Tolerâncias: **8 px de altura** (menor que a menor caixa desenhada, e some sob o traço com halo) e **1 px de largura** (uma barra de rolagem aparece e some, e isso muda dezenas de px). Motivos registrados: `aligned`, `measured`, `capture-moved-layout`, `capture-size-unavailable`, `size-unavailable` |
| Duas perguntas, não uma | idem | (a) captura e leitura concordam em tamanho? (b) **a própria captura** deixou o leiaute onde estava? A segunda existe porque `captureBeyondViewport` redimensiona a área de captura, e uma página que reage a isso deixa a imagem sem correspondência com nenhum estado observável |
| Recusa no mapa do teclado | `src/browser/keyboard-map.js` | Sem acordo, `drawBoxes` é falso: a imagem vai sem caixa e sem etiqueta, a **lista de lugares do Tab continua completa**, e a limitação `source-layout-changed` entra no artefato |
| Recusa no mapa de anúncios | `src/browser/annotation-map.js` | Sem acordo, nenhum retângulo é considerado confiável: todos os elegíveis saem por falta de posição medida (`counts.omittedNoRect`), `annotated` fica 0 e o mapa fica **sem segmento e sem legenda** — aqui a legenda *é* o número desenhado, e sem número não há o que legendar |
| Esquemas fechados | `src/core/keyboard/keyboard-map-artifact.js`, `src/core/evidence/annotation-map-artifact.js`, `keyboard-map-model.js` | `source-layout-changed` entra **no fim** das listas fechadas de limitações e no `materiallyPartial`. Ordem canônica preservada: auditoria antiga continua válida; `non-atomic-source-geometry` continua limitação obrigatória do mapa de anúncios |
| Textos para leigos | `src/core/report/keyboard-map-presentation.js`, `src/core/report/reader-map-presentation.js`, `src/core/report/html.js` | Sem marcas, o resumo e a cobertura dizem o que aconteceu em vez de prometer uma imagem marcada. Os textos das limitações foram reescritos para descrever o comportamento novo: *"A captura e a geometria são lidas em passos separados. A diferença entre elas é medida, e o mapa não marca quando passa da tolerância."* |
| Fixture de crescimento | `test/e2e/fixtures/keyboard-map-lazy.html`, `.js` (**novos**) | Página que **cresce depois da coleta**: pede blocos por `fetch` em cadeia, cada bloco ~150 px de altura. É por rede, e não por temporizador, porque a aba oculta congela temporizador (§1). A fixture tem dois modos: `?modo=captura` (cresce no primeiro `resize` e para) e o padrão `sem-fim` (cresce em **todo** `resize`) |
| Aquecimento descartável | `src/background/full-page-warm-up.js` (**novo**) e `run-audit.js` | Dispara a montagem preguiçosa **antes** da coleta com uma captura barata e descartável e espera a altura parar. Detalhes, medições e gating na **§4** |

### 3.1 Mudanças fora do mapa (uma linha cada)

- `run-audit.js` monta `mapSource` uma vez e passa `layoutMetrics: mapSource.layoutMetrics` e
  `sourceAligned: mapSource.aligned` para as duas composições. A altura capturada substitui a
  observada quando a captura foi truncada pelo teto de segurança: o mapa passa a descrever a imagem
  que existe, e a truncagem continua declarada à parte.
- `keyboard-map-presentation.js`: a contagem de elementos não visíveis virou **frase própria**. Colada
  na contagem de itens que o Tab alcança, ela lia como *"465 lugares de Tab foram perdidos"* numa
  página que tinha 71 (número medido no portal público) — e os 465 são, na sua maioria, contêineres
  escondidos.

## 4. O aquecimento — a pendência 1, cumprida

A pendência 1 da 1.1.59 era: *"quando a captura mexe no leiaute, esperar a página parar e refazer a
coleta + captura, com teto de tempo"*. A 1.1.60 **não refaz a coleta** — ela faz a coleta acontecer
depois de a página parar. O caminho é aquecer a montagem preguiçosa **antes** de ler, em vez de tentar
de novo depois de ler.

### 4.1 O que é, e por que é assim

| Decisão | Detalhe |
| --- | --- |
| Estímulo | `Page.captureScreenshot` descartável: `captureBeyondViewport: true`, jpeg de qualidade 40, recorte da página inteira, `scale` **0,05** |
| Por que uma captura, e não um `resize` | É a própria captura integral que amplia a área de renderização e acorda o conteúdo (medido na §1: a loja on-line crescia **+131 px durante a captura**, com 254 de 479 âncoras deslocadas). Reproduzir esse estímulo por outro caminho mexeria no leiaute por fora, sem controle sobre o que a página faria |
| Os bytes | **Descartados no mesmo instante.** Nada é lido do resultado, guardado, hasheado, exportado ou transformado em artefato/evidência. Enquanto captura de evidência o aquecimento não existiria — ele não é evidência, é estímulo à página, e por isso não passa pelo limite de raster privado |
| Espera | `Page.getLayoutMetrics` a cada **150 ms**; a **mesma altura** tem de se sustentar por **1.000 ms**; teto total de **3.000 ms** |
| Onde entra na auditoria | Depois do axe e da leitura de ambiente, **imediatamente antes da coleta**: navegação → axe → ambiente → **aquecimento** → coleta (métricas do instantâneo + árvore AX) → captura integral colada |
| Quando **não** roda | `captureFullPageEnabled === false` — os modos `element-only` e `no-pixels` não têm imagem para alinhar, e nenhum resultado desses modos muda. Também não roda quando há pausa de privacidade pendente: nesse caso a auditoria nem chegou ali |
| A página do próprio usuário | Roda igual. O pedido de captura de quem audita a própria página (`START_ATTACHED`) é o mesmo do `full-evidence`, e é por esse caminho que passa o ensaio visual e o botão de auditar a página atual — a primeira versão excluía o caminho anexado e foi exatamente ali que a loja continuou sem caixa |
| Falha | Silenciosa. Qualquer erro que não seja cancelamento é engolido e a auditoria segue como na 1.1.59. Cancelamento (abort) atravessa — quem interrompeu precisa parar de verdade |
| Efeito no relatório | **Nenhum texto novo.** O aquecimento não entra no modelo nem no artefato: ele só muda o estado da página antes de ela ser lida. Os modos sem pixel continuam idênticos |

### 4.2 A janela de confirmação — a medida que definiu o parâmetro

A primeira regra de espera era *"duas leituras seguidas dentro de 8 px"*. Ela está errada para esta
página, e o erro foi medido: a loja on-line cresce **em degraus**, com pausas de até ~750 ms entre
eles, e a regra saía justamente na pausa.

| Regra de espera, medida na loja on-line | Saída | Altura da página na saída | Deriva observação → captura | Resultado dos dois mapas |
| --- | --- | --- | --- | --- |
| Duas leituras seguidas (150 ms) | **385 ms** | **2.350 px** | **405–718 px** | **nenhuma caixa** — o crescimento continuava durante a coleta e a captura |
| Mesmo valor sustentado por **1.000 ms** | ~1,4 s | **2.970 px** (estado final) | **0 px** nas duas comparações | **com caixa**, alinhada |

Exigir que a mesma altura se sustente por uma janela maior que a pausa mede a mesma coisa que a regra
pedia (a altura parou), sem ser enganada pelo degrau seguinte. É por isso que `stableForMs` existe, e
o valor está comentado no código com esta medição.

### 4.3 Custo de tempo

O aquecimento é limitado dos dois lados: **no mínimo** a janela de confirmação (1,0 s) mais o custo da
captura descartável, **no máximo** o teto de 3,0 s mais essa captura. Numa página que já está parada,
ele gasta a janela inteira sem servir para nada — é o preço de não adivinhar. Numa página que cresce,
ele troca 1 a 3 segundos por caixas alinhadas em vez de nenhuma caixa.

### 4.4 O que foi conferido caixa por caixa

Conferência em **resolução cheia**, nos trechos de imagem exportados do próprio relatório (não nas
capturas de tela do ensaio, que são reduzidas):

- **Mapa de anúncios da loja on-line** — **marcadores 1 a 76** no primeiro trecho da imagem, cada
  contorno abraçando o seu elemento: a barra de navegação no alto (1–9), as faixas promocionais
  (11–41), os cartões de produto das três prateleiras seguintes (42–76). O número fica no canto do
  contorno e o contorno fecha no limite do elemento — nenhuma caixa deslocada, nenhum número solto.
- **Mapa do teclado da loja on-line** — **marcadores 1 a 50** no primeiro trecho, sobre os controles:
  o campo de busca, os links de entrada e conta, os itens da barra de navegação, as faixas e os links
  de cada cartão. Mais as **6 marcas de suspeito** para os itens que parecem clicáveis e o Tab não
  alcança — os mesmos 6 contados na lista do relatório.

### 4.5 O preço escondido: a navegação que chega no meio do relatório

O aquecimento custa ~1,15 s de auditoria (medido: a leitura de leiaute termina em **+1,53 s** com o
aquecimento e em **+0,40 s** sem ele, na mesma fixture). Esse deslocamento expôs uma corrida que já
existia: `test/e2e/navigation-freeze-mv3.test.mjs`, no caso *"página atual que se recarrega por
timer-reload"*, passou a falhar **4 de 4 rodadas** — a auditoria terminava **interrompida**
(`AUDIT_INTERRUPTED`, painel em "A página recarregou ou mudou durante a auditoria"), apesar de ter
lido e fotografado a página inteira.

**O que foi medido** (log interno temporário, instrumentação removida depois; a fixture é uma vitrine
de 240 cartões que se recarrega por temporizador a cada 2,5 s):

| Instante | O que aconteceu |
| --- | --- |
| +6,17 s | fim da leitura da página (`auditoria:fim`, estado `partial`; congelamento solto, 2 recargas seguradas) |
| +6,97 s | evento de carregamento da página (o mesmo instante em **todas** as rodadas, com e sem aquecimento: é a recarga da própria página) |
| +7,90 s | a tarefa durável só aí sai de `running` e entra em `finalizing` |
| +8,79 s / +9,77 s | gravação do resultado e confirmação |

Entre o fim da leitura e a gravação há **~1,7 s de trabalho legítimo** (enriquecimento do laudo,
regras do motor próprio, montagem do pacote do painel). O congelamento de 1.1.58 morria no fim da
leitura — e a auditoria, que já tinha lido tudo, ficava exposta: qualquer evento de carregamento
naquele intervalo liquidava um resultado já calculado. Sem o aquecimento a leitura terminava ~1,15 s
mais cedo e o evento caía depois de a tarefa entrar em `finalizing`; era **sorte de tempo**, não
proteção.

**O que mudou** (duas correções, nenhuma delas no mapa):

| Correção | Onde | Por quê |
| --- | --- | --- |
| O congelamento de navegação passa a viver enquanto a auditoria **depender da página** | `src/background/run-audit.js`: `runLegacyAudit` entrega a posse da sessão (congelamento + depurador) a quem chamou (`navigationHold`), e a execução anexada só a devolve quando o relatório está decidido — depois de `markFinalizing` | A auditoria prova a identidade do documento **no fim**, antes de gravar. Com o congelamento morrendo no fim da leitura, essa prova era uma aposta contra a recarga da própria página: se ela chegasse antes, a auditoria terminava `TARGET_CHANGED` com tudo já observado. A promessa do diagnóstico ("a navegação foi segurada até o fim") agora vale até o fim de verdade. Custa até ~2 s a mais de navegação segurada — o mesmo que a auditoria já fazia durante a leitura |
| Uma observação já concluída não é liquidada por uma navegação que chega depois | `src/background/authorized-audit-starter.js`: a execução anexada avisa quando termina de ler (`onObservationComplete`), e a invalidação por `tabs.onUpdated` deixa de derrubar essa auditoria — **sem consentimento de pixel pendente**; com consentimento, a navegação continua liquidando a suspensão como antes | Quem julga uma troca de documento é a própria auditoria, que prova a identidade antes de gravar e responde `TARGET_CHANGED`. Derrubar por um evento que chegou depois trocava um resultado pronto por "interrompida". O caminho do consentimento ficou intocado de propósito: ali a navegação tem de revogar a suspensão, e isso é provado pelos e2e de pixel |

**Provas das duas correções:**

- O arquivo `test/e2e/navigation-freeze-mv3.test.mjs` volta a **passar 2 de 2**, e a terceira
  afirmação do teste continua valendo: depois da auditoria a página se recarrega (geração 1 → 2), ou
  seja, nenhuma interceptação sobra.
- A mesma fixture **sem temporizador** (variante do diagnóstico, página que nunca se recarrega) tem
  **zero** eventos de carregamento durante a auditoria — o evento que derrubava a auditoria era mesmo
  a recarga da própria página, e não algo que a extensão faz. É o que mostra que segurar a navegação
  até o fim resolve, em vez de esconder.
- Os quatro e2e que interessam passam: mapa do teclado (3), navegação segurada (2), axe + mapa por URL
  (1) e lote com consentimento de pixel (1).

## 5. Provas

### 5.1 Unidade (sem navegador)

| Arquivo | O que prova |
| --- | --- |
| `test/evidence/map-source-geometry.test.js` (**novo**, 6 casos) | Concordância dentro e fora da tolerância, tamanho ausente de um dos lados, captura que mexe no leiaute e truncagem por teto |
| `test/browser/keyboard-map.test.js` | Plano recusado (`sourceAligned: false`) sai sem caixa, com `source-layout-changed`, **sem** a limitação de encaixe na borda (o encaixe não chegou à imagem, dizer que chegou confundiria quem lê), com `omittedNoRect` contado, e passa no validador fechado |
| `test/browser/annotation-map.test.js` | Sem acordo, nenhum anúncio é anotado e o texto diz exatamente isso |
| `test/background/run-audit.test.js` | *"a page that grows while it is read gets maps without boxes and the geometry of the capture instant"*; *"o aquecimento da captura integral só roda quando ela está permitida"* (nos três modos de pixel e na página do próprio usuário, **uma** vez, sempre **antes** da coleta, e a captura de evidência continua saindo); e a página muito alta, em que o recorte do aquecimento (`jpeg`, `scale ≤ 0,1`) não vira evidência nem substitui o recorte seguro da captura integral (16.384 px) |
| `test/background/full-page-warm-up.test.js` (**novo**, 9 casos) | O aquecimento roda uma vez e a captura é descartável; os bytes não são lidos; a espera tem teto; cancelamento no meio atravessa; falha que não é cancelamento é silenciosa; e uma **pausa curta no crescimento não engana a espera** (a janela de confirmação da §4.2) |
| `test/core/normalize-snapshot.test.js` | A coleta faz **duas** leituras de leiaute, na ordem certa, e devolve cada uma no seu campo |
| `test/report/html.test.js` | Texto novo da limitação de geometria não atômica |

Foco (6 arquivos): **281 testes, 281 passam, 0 falham**. `test/report/*.test.js`: **318 passam**.

### 5.2 Navegador (Chrome real, um arquivo por vez)

| Arquivo | Teste | Resultado |
| --- | --- | --- |
| `test/e2e/keyboard-map-mv3.test.mjs` | "prova o mapa do teclado: cartões que só abrem com o mouse ficam sem caixa numerada" | ✔ 7,7 s (9.941 px azuis) |
| idem | "**uma página que cresce sem parar sai sem caixa nenhuma, com a lista inteira e a explicação**" (modo `sem-fim`) | ✔ 5,9 s (**10 px** azuis e **0** laranja, `stops=4`) |
| idem | "**uma página que cresce por causa da própria captura volta a ter caixas alinhadas**" (modo `?modo=captura`) | ✔ 7,1 s (**5.653** azuis + **4.715** laranja, `stops=6`) |
| `test/e2e/navigation-freeze-mv3.test.mjs` | "página atual que se recarrega por meta-refresh conclui com resultado e sem perder os sinais" | ✔ 21,5 s |
| idem | "**página atual que se recarrega por timer-reload** conclui com resultado e sem perder os sinais" | ✔ 13,1 s (era a única falha da rodada, ver §4.5) |
| `test/e2e/public-axe-map-mv3.test.mjs` | "proves axe/map only through action → Side Panel → public URL consent → worker → report → four downloads" | ✔ 6,4 s |
| `test/e2e/batch-pixel-consent-mv3.test.mjs` | "full-evidence batch completes sensitive pages without privacy pause and exports their report" | ✔ 10,2 s |

A fixture de crescimento agora tem **três** desfechos medidos, e é a diferença entre os dois últimos
que prova o aquecimento:

| Fixture | O que a página faz | Mapa do teclado |
| --- | --- | --- |
| Estável | nada | **7 caixas** desenhadas (9.669 pixels azuis, ~1.380 por caixa) |
| `sem-fim` | cresce em **todo** `resize` — inclusive no do aquecimento | **menos de 200 pixels azuis**: nenhuma caixa, lista inteira, `source-layout-changed` |
| `?modo=captura` | cresce **uma vez**, no primeiro `resize` (o do aquecimento), e para | **caixas alinhadas**: 5.653 pixels de contorno azul (paradas do Tab) e 4.713 de contorno laranja (itens que só o mouse alcança) — os dois acima dos 400 que o teste exige; status `complete`, "Protocolo 1/2/3" na lista e "Protocolo 3" entre as paradas marcadas |

O teto de 200 pixels do caso `sem-fim` é folgado de propósito, porque sobram alguns pixels de traço. A
`sem-fim` continua no lugar por um motivo de produto: ela é a página que **não** pode ser salva pelo
aquecimento, e a prova de que o caminho da recusa da §2 continua de pé. O `public-axe-map` passou a
exigir: escala horizontal e vertical que concordam (≤ 0,01), ausência de `non-uniform-pixel-scale` e
de `source-layout-changed`, `counts.annotated === legend.length`, legenda com número desenhado e
**nenhum** item fora da imagem por falta de posição medida.

### 5.3 Suíte completa

Rodada final, `node scripts/run-tests.mjs` com `AUDITA_E2E_CHROME`, nas duas fases do roteiro:

| Fase | Testes | Passam | Falham |
| --- | --- | --- | --- |
| Paralela | 4.517 | 4.515 | 1 (+1 pulado) |
| Chrome real (série, um arquivo por vez) | 135 | **135** | **0** |

A única falha é `builds the public ZIP reproducibly in an isolated temporary directory`, a falha
esperada enquanto há alteração de fonte: o ZIP da release é construído sobre a árvore versionada e o
hash muda; o passo de release recalcula o hash. Na fase de Chrome real passaram os dois testes do
mapa — inclusive *"uma página que cresce durante a verificação sai sem caixa nenhuma e com a lista
inteira"* (11,7 s) — o percurso do axe + mapa com consentimento público, o fluxo do painel lateral
inteiro (9 testes) e o percurso obrigatório.

Na rodada intermediária apareceram mais duas falhas, as duas investigadas:

1. `collectPage issues the minimal structural CDP commands…` — **causada por esta branch** (a leitura
   de leiaute a mais) e **corrigida**: o teste passou a exigir as duas leituras, na ordem, e a provar
   qual delas vira `layoutMetricsAtSnapshot` e qual vira `layoutMetrics`. Passa na rodada final.
2. `original-page ABNT markers remain usable across idle and preserve the report` (flaky) — a prova
   exige **zero** evento de foco/blur na página original durante a espera ociosa, e naquela rodada
   mediu 6 (`focus` 2, `blur` 2, `focusin` 1, `focusout` 1) com `document.hasFocus()` e
   `activeElement` **inalterados**: havia outro Chrome abrindo e fechando no mesmo Mac, e ele roubou o
   foco. Rodando o arquivo sozinho (`test/e2e/sidepanel-flow-mv3.test.mjs`): **9 testes, 9 passam, 0
   falham**, incluindo esse. Não é regressão desta branch (o arquivo não está entre os alterados) e
   não voltou na rodada final.

## 6. Ensaio visual

### 6.1 Página de teste (`scripts/visual-qa.mjs`, sem `--no-fixture`)

`qa-out/mapa-fixture/127.0.0.1-marcacao.html/08-mapa.png` e `…/09-mapa-teclado.png`, abertos e
conferidos: o mapa de anúncios marca **65 de 75** elegíveis com contorno numerado colado em cada
elemento (cabeçalho, botões, cartões, campo, imagem); o mapa do teclado desenha as caixas azuis sobre
os controles certos (34 lugares do Tab; 19 ficaram fora por rolagem interna, 1 sem posição medida).

### 6.2 Portal público (rodada de 15/10/2026, código atual)

Mapa do teclado: **69 de 71** lugares do Tab marcados, 4 suspeitos. Mapa de anúncios: **93 de 93**
anúncios anotados. No terceiro trecho da imagem — o rodapé, exatamente o caso do defeito original —
as caixas 54 a 68 estão **coladas nos textos dos links** (contatos, telefones, ouvidoria,
transparência, endereço). Conferido em ampliação: a caixa abraça o texto do link, sem folga nem
deslocamento.

### 6.3 Loja on-line e mercado on-line — **antes** do aquecimento (rodada de 15/10/2026)

Os dois caíram no caminho da recusa e o relatório diz isso em linguagem simples, nos dois cartões:

- loja on-line — teclado: *"A imagem vai sem marcações porque a página mudou de tamanho durante a
  verificação. A lista abaixo continua completa: procure o item pelo nome."* (123 lugares do Tab e
  5 suspeitos na lista; cada item diz *"Sem marca na imagem; posição estimada no documento."*)
  Anúncios: *"162 elementos eram elegíveis, mas nenhum foi marcado: a página mudou de tamanho durante
  a verificação."*
- mercado on-line — teclado: 58 lugares e 8 suspeitos na lista, mesma explicação; anúncios: 108
  elegíveis, nenhum marcado.

O que era antes, na loja on-line, com as mesmas páginas: caixas azuis do rodapé **até 130 px fora do
link** (§1, medição de âncoras). O que é agora: nenhuma caixa, e a frase que explica por quê.
A imagem continua no cartão do teclado (trechos sem marca) porque ali a lista de texto é o produto e
a imagem é apoio; no cartão de anúncios não há trecho nenhum, porque sem número não há legenda.

### 6.4 Os três sites reais, com o aquecimento ligado (rodada de 15/10/2026)

| Página | Antes do aquecimento | Com o aquecimento |
| --- | --- | --- |
| portal público | teclado **69 de 71** marcados; anúncios **93 de 93** anotados — já marcava (§6.2) | teclado **53 de 55** marcados, 4 suspeitos; anúncios **76 de 76** anotados. **Não piorou**: os dois mapas continuam marcando, e as caixas continuam coladas (incluindo o rodapé, o caso do defeito original) |
| loja on-line | **0 caixa nos dois mapas**: 123 lugares do Tab na lista, 162 elegíveis, nenhum marcado (§6.3) | **marcou em 5 das 6 rodadas medidas**; a 6ª recusou e explicou (180 elegíveis, nenhum marcado). Nas rodadas que marcaram, o primeiro trecho do mapa de anúncios trouxe **59** e **76** marcadores numerados, contornos colados aos elementos (§4.4) |
| mercado on-line | **0 caixa nos dois mapas**: 58 lugares do Tab, 108 elegíveis, nenhum marcado (§6.3) | teclado **121 de 145** marcados, **0 suspeitos** (23 por rolagem interna, 136 em frames); anúncios **129 de 144** anotados, 32 contextos de frame fora |

Como os totais de itens elegíveis mudam de rodada para rodada (login, promoção do dia, blocos que
carregam ou não), o que se compara aqui é **marcar ou não marcar** — e, quando marca, se a caixa está
no lugar. Os números entre parênteses são os que o próprio relatório imprime no cartão.

O que continua valendo para a loja on-line, sem maquiagem: ela é a página mais agressiva das três.
Depois do aquecimento ela marca na maior parte das vezes, mas **não sempre** — a rodada que recusou
media 180 elementos elegíveis e nenhum marcado, com a explicação em linguagem simples no cartão. Essa
é a regra da §2 funcionando, não uma falha do aquecimento.

## 7. Decisões declaradas e limites

- **Recusar é a resposta, não a exceção.** Se `mapSource.aligned` é falso, nenhum dos dois mapas
  desenha. Não existe "desenhar aproximado": a única alternativa honesta seria refazer a coleta
  inteira (instantâneo + captura) até os dois concordarem, e isso custa segundos de página real por
  tentativa — foi o que o **aquecimento da §4** veio resolver por outro caminho: em vez de refazer a
  coleta até dar acordo, fazer a coleta depois de a página parar. O que continua fora do programa é a
  página que **não para** dentro do teto de 3 s (§8).
- **A lista nunca encolhe por causa da recusa.** Lugares do Tab, suspeitos e anúncios elegíveis
  continuam contados e listados; o que sai é a marca na imagem.
- **O encaixe na borda não é mais declarado quando não houve desenho.** Enquanto a limitação
  `stops-outside-source-clamped` aparecia junto de "nenhuma caixa foi desenhada", o relatório dizia
  que itens foram encaixados na borda de uma imagem sem caixa nenhuma.
- **Esquemas continuam fechados.** O código novo entrou no fim das listas canônicas; auditoria
  antiga (inclusive a fixture de 1.1.56) continua abrindo, e `non-atomic-source-geometry` continua
  limitação obrigatória do mapa de anúncios — ela agora descreve o comportamento medido, não um
  aviso genérico.
- **O aquecimento é estímulo, não evidência.** A captura descartável não é lida, guardada, hasheada
  nem exportada — por isso ela não passa pelo limite de raster privado, que existe para captura de
  evidência. Se um dia o aquecimento precisar guardar bytes para diagnóstico, ele deixa de poder
  rodar onde roda hoje.
- **Limite declarado:** a extensão mede o leiaute em vários instantes — a cada 150 ms durante a
  espera do aquecimento, no instantâneo estrutural, antes da captura e depois da captura. Uma página
  que cresce **entre** duas dessas leituras e volta ao tamanho anterior não é detectada; o que a
  medição garante é que, quando o tamanho discorda, o mapa não marca.

## 8. Pendências

- **Página que não para dentro do teto.** O aquecimento espera até 3 s. A loja on-line, nas medições
  de hoje, às vezes ainda está crescendo depois disso: foi o caso da rodada que recusou (§6.4). Não é
  falha do aquecimento, é o limite dele. As saídas possíveis — teto maior, ou uma segunda rodada de
  aquecimento — custam tempo em **toda** auditoria de página que cresce, e por isso ficaram de fora
  desta versão.
- **O aquecimento não roda nos modos sem pixel.** `element-only` e `no-pixels` não têm imagem para
  alinhar, e nenhum resultado desses modos mudou (é o que o teste de unidade prende). Se alguma
  frente futura passar a desenhar marca nesses modos, a conversa volta.
- **A página do próprio usuário também é aquecida.** Quem audita a página atual vê a captura
  descartável acontecer antes da coleta — a página pode se montar na frente da pessoa, como já
  acontecia logo depois, na captura de evidência. Os bytes não são guardados e o relatório não muda,
  mas é um estímulo que não existia na 1.1.59 e vale observar se alguém relatar "a página pulou".
- **Números vivos das páginas reais:** as três páginas são ensaios do dia 15/10/2026, não promessas.
  A loja on-line é a mais instável: marcou na maioria das rodadas com o aquecimento e recusou em uma
  delas; o mercado on-line depende do momento em que a auditoria o encontra.
- **Revisão guiada do mapa** (pergunta sobre item sem caixa) é de outra frente e não foi tocada; com
  a recusa, a pergunta *"algum item ficou sem caixa azul?"* passa a ter uma resposta nova legítima
  ("a imagem não tem caixa nenhuma nesta página"), que vale conferir quando aquela frente voltar.
