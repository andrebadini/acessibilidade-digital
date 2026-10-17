# Mapa do teclado com caixas alinhadas em página que cresce (1.1.62)

**Em uma linha:** quando a página muda de tamanho entre a leitura da estrutura e a captura, o mapa do teclado
(5.1.13) deixava de desenhar caixa nenhuma; desde a 1.1.62 os retângulos são medidos **no mesmo leiaute da
imagem**, numa única chamada em lote, e a caixa passa a cair exatamente sobre o elemento — sem abrir mão da
regra de nunca desenhar no lugar errado.

---

## 1. O problema

O dono do produto abriu o relatório de uma página que se monta aos poucos e viu a imagem do mapa **sem
marcação nenhuma**, com esta explicação:

> A imagem vai sem marcações porque a página mudou de tamanho durante a verificação. A lista abaixo continua
> completa: procure o item pelo nome.

> 5 lugares onde o Tab para e 0 itens que parecem clicáveis entraram na lista, mas **nenhum número foi
> desenhado na imagem**.

O mapa de anúncios da mesma auditoria dizia o mesmo ("5 elementos eram elegíveis, mas nenhum foi marcado: a
página mudou de tamanho durante a verificação"). As duas imagens do "antes" estão em
`qa-out/1.1.62-antes-1.1.61/127.0.0.1-keyboard-map-cresce.html/` (`09-mapa-teclado.png` e `08-mapa.png`),
geradas nesta máquina rodando a **regra da 1.1.61** contra a fixture desta tarefa (§5.2).

Nada estava "quebrado" no sentido literal: a auditoria preferia ficar sem caixa a desenhar no lugar errado.
O que faltava era uma saída honesta para o caso comum de a página se montar sozinha.

## 2. Causa

Duas coisas se somavam.

**(a) Os retângulos vinham da leitura estrutural, feita segundos antes.** A leitura da árvore DOM e de
acessibilidade leva segundos; a captura integral vem depois. Até a 1.1.61 o mapa comparava a altura do
documento **na leitura** com a altura **na captura** e, se as duas discordassem mais de 8 px, recusava o
**mapa inteiro** (`source-layout-changed`). Em página com carrossel, carga preguiçosa ou aviso que chega
depois, a resposta era "não" quase sempre.

**(b) A própria captura mexe no leiaute.** `captureBeyondViewport` amplia a área de renderização: a barra de
rolagem clássica deixa de existir e o conteúdo fica ~15 px mais largo. Medido nesta máquina, numa janela de
1.280 px: `window.innerWidth - documentElement.clientWidth` passava de **15 para 0** e a largura do conteúdo
de **1.265 para 1.280**. Qualquer coisa que dependa da largura (uma imagem `width: 100%`, por exemplo) muda
de altura por causa disso. Pior: o estado alargado é transitório — quando a página se rearranja de novo
(conteúdo que chega), a barra volta, e a captura alarga outra vez na hora de fotografar. Sem tratamento, a
comparação acusava a **página** por um rearranjo da **captura**.

| Medida (Chrome 152, janela de 1.280 px) | Valor |
| --- | --- |
| Largura do conteúdo antes da captura | 1.265 px |
| Largura do conteúdo no estado alargado (o que a imagem mostra) | 1.280 px |
| Barra de rolagem clássica (`innerWidth - clientWidth`) | 15 px → 0 px |
| Altura da fixture que cresce, na carga | 935 px |
| Altura da mesma página na leitura estrutural/captura | 1.532 px |
| Crescimento que chega **depois** da leitura | 597 px |

Um deslocamento de 597 px é ordens de grandeza acima da tolerância de 8 px: era recusa garantida.

## 3. A solução

### 3.1 Geometria fresca (uma chamada em lote, depois da captura)

Logo depois da captura integral, no leiaute que a imagem acabou de mostrar, os retângulos são medidos **de
novo** numa única chamada ao navegador:

```
DOMSnapshot.captureSnapshot({ computedStyles: [], includeDOMRects: true })
```

`computedStyles: []` mantém a chamada barata (sem estilos computados) e `includeDOMRects` traz a caixa de
cada nó. O resultado é casado com a leitura estrutural por `backendNodeId`, e quem sumiu simplesmente perde a
caixa — **nenhuma ida ao CDP por elemento, nenhum laço de medição na página**. O módulo novo é
`src/core/evidence/fresh-geometry.js` (`domSnapshotRects`, `withFreshRects`, `layoutAgreement`).

### 3.2 Fixar o estado alargado antes de medir o instante

`establishWidenedLayout` (`src/background/full-page-warm-up.js`) dá uma captura descartável em escala 0,05
**antes** de a auditoria ler as métricas do instante. Assim o estado alargado já vale quando as três leituras
acontecem (`captureMetrics` → captura → `captureMetricsAfter` → medição fresca → `measurementMetrics`) e
qualquer diferença entre elas é mesmo da página. Sem isso, a comparação acusava a página pelo rearranjo da
própria captura — foi o que a medição inicial desta tarefa mostrou (deriva de 15 px na largura e 8 px na
altura, apontando para `capture-moved-layout` no estado alargado).

### 3.3 Quem decide desenhar (e o que continua recusando)

`src/core/evidence/map-source-geometry.js` deixou de perguntar "a leitura estrutural e a captura descrevem o
mesmo leiaute?" e passou a perguntar "a geometria fresca existe e o leiaute ficou parado em volta dela?".
Duas comparações curtas, com motivos distintos:

- em volta da **captura** (`capture-size-unavailable`, `capture-moved-layout`);
- em volta da **medição fresca** (`measurement-size-unavailable`, `measurement-moved-layout`);
- `fresh-geometry-unavailable` quando a medição não devolveu nada;
- `aligned` — o único motivo que desenha.

Todas as recusas continuam aparecendo ao usuário com **a mesma chave** (`source-layout-changed`), em linguagem
simples, porque para quem lê o motivo técnico não muda a conduta. O que mudou é a frequência: agora é raro,
como mostra a §6 (nenhuma das três páginas reais recusou).

### 3.4 Os dois mapas

A mudança de geometria alimenta **os dois** mapas. No mapa de anúncios (`annotation-map`) mudou só a
**entrada** de geometria: o desenho (marcadores, linha-guia, legendas, sobreposição) ficou como estava.

### 3.5 Versões de algoritmo

Os esquemas e catálogos continuam fechados, e as auditorias guardadas continuam abrindo:

| Artefato | Versão que passa a ser escrita | Versões que continuam sendo lidas |
| --- | --- | --- |
| `audita.keyboard-map` | `1.1.0` | `1.0.0`, `1.1.0` |
| `audita.annotation-map` | `1.3.0` | `1.0.0`, `1.2.0`, `1.3.0` |

O esquema da geometria é **o mesmo** nas versões antigas e novas; o que mudou foi a **origem** do retângulo.
Por isso um mapa `1.0.0`/`1.2.0` é lido exatamente como foi escrito (mesmas regras de linha-guia e as mesmas
contagens), sem afrouxar nada.

## 4. Arquivos alterados

| Arquivo | O que mudou |
| --- | --- |
| `src/core/evidence/fresh-geometry.js` (**novo**) | Retângulos frescos por `backendNodeId`, troca no instantâneo, tolerâncias e comparação de leiaute |
| `src/background/full-page-warm-up.js` | `establishWidenedLayout` (captura descartável que fixa o estado alargado) e a captura do aquecimento extraída para uma função única |
| `src/background/run-audit.js` | Alargamento antes das métricas do instante; medição fresca depois da captura; instantâneo dos mapas recebe os retângulos frescos (o instantâneo da auditoria continua intacto) |
| `src/core/evidence/map-source-geometry.js` | Veredito de alinhamento pelas duas comparações novas; comentário sobre a largura |
| `src/core/keyboard/keyboard-map-artifact.js` | Versão `1.1.0`, leitura de `1.0.0` |
| `src/core/evidence/annotation-map-artifact.js` | Versão `1.3.0`, leitura de `1.0.0` e `1.2.0` (mesmas regras de desenho) |
| `scripts/visual-qa.mjs` | `--device-scale-factor <n>` (1 a 4), com `Emulation.setDeviceMetricsOverride`, conferência de `devicePixelRatio` e limpeza; aparece no resumo e no console |
| `scripts/run-tests.mjs` | A nova E2E entrou na lista de Chrome real (fase serial) |
| `test/...` | Testes novos e expectativas ajustadas (§5) |

## 5. Testes

### 5.1 Unitários novos

`test/evidence/fresh-geometry.test.js` (9 testes) — leitura dos retângulos por `backendNodeId`; caixa sem
tamanho descartada; escolha do documento principal pelo `frameId`; **página que cresceu entre a leitura e a
captura recebe as caixas do estado da imagem**; **nó que sumiu perde só a própria caixa**; nó de frame e nó
sem `backendNodeId` ficam como estavam; sem geometria fresca o instantâneo volta intacto; tolerâncias de
leiaute; **fator de escala 2 não muda a geometria** (os retângulos já vêm em px CSS).

`test/background/full-page-warm-up.test.js` (14 testes, 5 novos) — o alargamento usa a mesma captura
descartável (jpeg 0,05); sem tamanho de página não há captura; falha é silenciosa; cancelamento atravessa; sem
CDP/passo é pulado.

`test/background/run-audit.test.js` (175 testes) — o adaptador falso passou a separar as duas capturas
descartáveis: `warmUps` (aquecimento) e `widenings` (alargamento, **depois** da leitura da estrutura), com a
ordem verificada `collect < widen < full-page`. Nos modos `element-only` e `no-pixels` o alargamento é zero
(não há captura integral para alinhar).

### 5.2 E2E novo: a página que cresce sozinha

Fixture nova em `test/e2e/fixtures/` (`keyboard-map-cresce.html/.css/.js`): o aviso ilustrado é inserido no
primeiro `resize` (o da captura de aquecimento) e o servidor de teste segura a **resposta** da imagem
(`?atraso=`) — rede não é adiada em aba escondida, então o leiaute cresce sempre no mesmo ponto relativo à
auditoria, sem depender de JavaScript no instante do crescimento.

`test/e2e/keyboard-map-cresce-mv3.test.mjs` passa, com estes números medidos (execução de 2026-10-16):

| Medida | Valor |
| --- | --- |
| Altura de carga / altura no mapa (M0) / altura da captura | 935 px / 1.532 px / 1.532 px |
| Crescimento que chegou depois da leitura | 597 px |
| Marcos | pedido da imagem em +2.500 ms; captura em 3.696 ms; resposta em 3.966 ms |
| Caixas desenhadas | 5 de 5 controles, **desvio 0,0 px em x e em y**, altura igual à de carga |
| Pixels azuis na imagem | 8.257 |
| Contagens na tela | "5 lugares onde o Tab para; 0 itens que parecem clicáveis e o Tab não alcança." |
| Limitações | `tab-order-estimated-not-observed`, `top-document-open-shadow-only`, `ancestor-clipped-stops-omitted` — **sem** `source-layout-changed` |

O mesmo teste verifica a **folha de impressão**, que é o que o PDF entrega: o HTML exportado é publicado no
servidor da fixture, aberto numa aba de verdade, medido com a mídia trocada para `print` e impresso pelo
próprio navegador (`Page.printToPDF`, a mesma chamada da exportação). Resultado: cartão do mapa com 1.265 px,
1 trecho, paradas 1 a 5 com os **mesmos números** da lista e da imagem, trechos e paradas com
`break-inside: avoid`, imagens limitadas a `max-width: 100%`, e — no arquivo PDF — a imagem do trecho do mapa
com **1.210 × 1.532 px**, as mesmas dimensões do recorte desenhado.

### 5.3 E2E existentes (um arquivo por vez, com Chrome real)

| Arquivo | Resultado |
| --- | --- |
| `test/e2e/keyboard-map-mv3.test.mjs` | 3/3 — incluindo "uma página que cresce **sem parar** sai sem caixa nenhuma, com a lista inteira e a explicação" (a recusa honesta continua) e "uma página que cresce **por causa da própria captura** volta a ter caixas alinhadas" |
| `test/e2e/keyboard-map-cresce-mv3.test.mjs` | 1/1 (§5.2) |
| `test/e2e/public-axe-map-mv3.test.mjs` (mapa de anúncios) | 1/1 |

### 5.4 Suíte unitária

`node --test` sobre os 212 arquivos de unidade: **4.628 testes, 4.626 passam, 1 falha, 1 pulado**. A única
falha é `test/release-package.test.js`, que compara o hash do ZIP publicado — esperada enquanto o fonte muda.
Depois de reverter uma medição temporária (§6.1) os arquivos afetados foram rodados de novo: **240/240**.

### 5.5 Expectativas que mudaram (e por quê)

1. `test/background/run-audit.test.js`: o adaptador falso conta agora **duas** capturas descartáveis
   (`warmUps` e `widenings`), e o teste da página comprida espera **duas** capturas em escala ≤ 0,1 em vez de
   uma. É a mudança de comportamento, não um afrouxamento: a segunda captura existe para fixar o estado
   alargado antes das métricas.
2. `test/e2e/keyboard-map-cresce-mv3.test.mjs`: as limitações esperadas passaram a incluir
   `ancestor-clipped-stops-omitted` — o catálogo de 12.000 rótulos da fixture fica dentro de uma área com
   rolagem própria, e esses itens ficam fora da lista por regra que já existia. E `omittedNoRect` deixou de
   ser exigido como zero: há nós que honestamente não têm caixa utilizável (tag `script`, `title`, elemento de
   tamanho zero). A regra que continua valendo é a do produto — **nunca desenhar caixa no lugar errado** —, não
   "todo nó precisa de caixa". As contagens em linguagem simples são verificadas ao pé da letra.
3. `test/release-package.test.js` falha no hash do ZIP enquanto o fonte muda (esperado).

## 6. QA visual: antes e depois

Script: `node scripts/visual-qa.mjs` (as imagens ficam em `qa-out/`; o diretório de cada site leva o nome do
site). Todas as imagens citadas foram **abertas**, e os mapas do teclado foram conferidos também em **recorte
ampliado**, caixa por caixa.

### 6.1 A fixture que cresce (mesma página, mesmo servidor)

| | Antes (regra da 1.1.61) | Depois (1.1.62) |
| --- | --- | --- |
| Mapa do teclado | **0 caixas**; "nenhum número foi desenhado na imagem" | **5 caixas**, uma por controle |
| Mapa de anúncios | **0 marcadores** ("5 elementos eram elegíveis, mas nenhum foi marcado") | 5 de 5 elegíveis anotados, 0 sem geometria |
| Limitação declarada | `source-layout-changed` presente | ausente |
| Trechos da imagem | 2 | 5 |

O "antes" foi medido nesta máquina com uma alteração **temporária e revertida** em `run-audit.js` (a
comparação voltava a usar as métricas da leitura estrutural, como na 1.1.61); a árvore de trabalho foi
conferida depois da reversão. Ampliação do recorte dos três primeiros controles na versão de 1.1.62: as
caixas azuis numeradas 1, 2 e 3 ficam coladas em "Abrir protocolo", "Segunda via" e no seletor de período.

### 6.2 Três páginas reais (navegador de verdade, janela de 1.280 px)

| Página | Caixas no mapa do teclado | Outras contagens | `source-layout-changed` |
| --- | --- | --- | --- |
| portal público | **53 de 55** itens que o Tab alcança; 4 suspeitos | 1 sem posição medida, 1 escondido por rolagem interna, 3 em frames | ausente |
| loja on-line 1 | **123 de 142**; 0 suspeitos | 1 sem posição medida, 18 escondidos por rolagem interna, 136 em frames | ausente |
| loja on-line 2 | **98 de 520**; 0 suspeitos | 38 sem posição medida, 384 escondidos por rolagem interna, 1.192 não visíveis | ausente |

Mapa de anúncios das mesmas páginas: loja on-line 1 com **133 de 144** elementos elegíveis anotados e **0 sem
geometria**; loja on-line 2 com **130 de 194**; portal público com 14 trechos de imagem.

Para comparar com o que o dono do produto viu antes: no relatório da 1.1.60
(`docs/qa/mapa-alinhado-1.1.60.md`, §6.3) a loja on-line tinha **0 caixa nos dois mapas** — 123 lugares do Tab
listados, 162 elegíveis, nenhum marcado, porque a página crescia +131 px **durante a captura** e 254 de 479
âncoras se deslocavam até 130 px. A contagem de elegíveis de hoje (142) difere da de então (162) porque a
página muda entre visitas; o que interessa é que os mesmos 123 lugares do Tab que só apareciam na lista agora
têm caixa desenhada, e sobre o elemento certo (conferido em recorte ampliado no cabeçalho, nas categorias e
nos botões).

As duas páginas com status **parcial** continuam parciais por limitações que nada têm a ver com alinhamento:
ordem da lista estimada (não observada pressionando Tab), conteúdo de frames fora do mapa, itens escondidos
por rolagem interna e itens fora da área capturada encaixados na borda. Nenhuma dessas limitações foi
introduzida por esta tarefa.

### 6.3 Tela densa (`--device-scale-factor 2`)

Rodado com o parâmetro novo, na fixture que cresce e na loja on-line 1: `devicePixelRatio` medido **2** nas
duas, **5 caixas** na fixture (iguais às do fator 1) e **120 de 125** marcados na loja, **sem**
`source-layout-changed`. A imagem do mapa continua sendo desenhada em px CSS — o fator não muda a geometria,
só a nitidez; o recorte ampliado mostra os mesmos números legíveis e as caixas no mesmo lugar.

### 6.4 Legibilidade e contraste no mapa

Nas imagens ampliadas: número branco sobre azul escuro dentro do selo, contorno azul com halo claro sobre o
elemento, legenda ("Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números…") e as
contagens em linguagem simples logo acima da imagem. A lista "Onde o Tab para, na ordem" traz **os mesmos
números** do desenho — na fixture, 1 a 5; na loja on-line 1, 1 a 123.

## 7. Relatório (HTML e PDF) e cartão da revisão guiada (5.1.13)

- **HTML / "Abrir relatório completo":** o cartão do mapa do teclado foi aberto no relatório do navegador para
  as quatro auditorias (fixture e três páginas reais). Ele traz a legenda, as contagens, a lista numerada e a
  imagem com as caixas; nenhuma das quatro mostrou o texto "A página mudou de tamanho enquanto era
  verificada".
- **PDF:** o PDF não é impresso do relatório aberto no painel, e sim do **HTML exportado** impresso numa aba
  própria (`src/export/report-export.js` prepara o Blob e chama `Page.printToPDF`). A prova é feita nesse
  documento: a §5.2 mede a folha de impressão (cartão visível, trechos e paradas com `break-inside: avoid`,
  imagens dentro da largura do cartão) e encontra no arquivo PDF a imagem do trecho do mapa com as mesmas
  dimensões do recorte. A exportação das quatro peças (HTML, PDF, CSV, JSON) continua provada pelo recibo
  durável de bytes — o mesmo caminho que a E2E já exigia.
- **Cartão da revisão guiada do 5.1.13:** o bloco do mapa (pergunta, legenda, contagens, imagem e as listas
  "Onde o Tab para, na ordem" e "Itens que parecem clicáveis e o Tab não alcança") é o mesmo componente do
  relatório (`keyboardMapPresentation`), então os números são os mesmos por construção; `review-keyboard-map`
  cobre o cartão em 240 testes de unidade verdes e a E2E `keyboard-map-mv3` percorre o cartão de verdade
  (apontar áreas, marcar suspeitos, gravar a resposta).

## 8. Limitações do que foi entregue

1. **Página que nunca para de crescer continua sem caixa** — e com a lista completa e a explicação. É a regra
   do produto: melhor sem caixa do que com caixa no lugar errado.
2. **Custo:** uma chamada em lote (`DOMSnapshot.captureSnapshot`) e uma captura descartável a mais por
   auditoria (escala 0,05, jogada fora). Nenhuma chamada CDP por elemento em laço, nenhum trabalho síncrono
   pesado na página.
3. **`omittedNoRect`** conta os nós que existiam com caixa na leitura e não têm caixa utilizável depois
   (sumiram, ficaram escondidos ou têm tamanho zero): 9 na fixture, 38 numa das lojas. A caixa deles não é
   desenhada, e a contagem aparece em linguagem simples — "38 ficaram sem posição medida".
4. **Mapas parciais continuam parciais** nas páginas reais por causa de frames, conteúdo escondido por
   rolagem interna e ordem de lista estimada — limitações anteriores a esta tarefa.
5. **Escala densa no relatório da extensão:** o `--device-scale-factor` existe no script de QA visual; a
   auditoria da extensão continua usando o fator do próprio sistema, como antes.
6. **A prova do PDF é sobre a imagem e a folha de impressão**, não sobre o texto extraído do arquivo: não há
   extrator de PDF nesta máquina, e as dimensões das imagens dentro do PDF é o que se consegue medir sem
   depender de uma biblioteca de terceiros.

## 9. Pendências

- `test/release-package.test.js` segue vermelho no hash do ZIP enquanto houver mudança de fonte — esperado.
- Nada foi commitado: a revisão e o commit são do orquestrador.
- Áreas de tarefas paralelas (cartões de revisão guiada, hashes do relatório, desenho do mapa de anúncios)
  foram tocadas apenas onde a geometria entrava, de propósito e de forma mínima.
