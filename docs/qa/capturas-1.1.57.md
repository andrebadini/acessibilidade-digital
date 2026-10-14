# Capturas 1.1.57 — medição fresca do alvo, contorno por fora e mapa com alvo contornado

Data: 14/10/2026. Versão em trabalho: **1.1.57** (branch `fix/marcacao-precisa-1.1.57`, sem commit, sem ZIP
reconstruído). Chrome for Testing 152.0.7977.64, um Chrome por vez.
Base do diagnóstico: `docs/qa/diagnostico-marcacao-1.1.57.md`, itens **P3** (precisão das capturas) e **P4**
(mapa anotado).

> **Escopo.** Este documento cobre só o lado **capturas/relatório/mapa** do diagnóstico. Os itens **P0–P2**
> (sinais numerados na página: cobertura, estabilidade e vínculo visual) são de outra tarefa paralela, que
> mexe em `page-markers-*.js`, `page-marker-projection.js`, `highlight-overlay.js`, `highlight-locator.js` e
> `panel/*` — nenhum desses arquivos foi tocado aqui.

## 1. P3 — o alvo é remedido no instante da captura

O `rect` do snapshot é medido muito antes da fase de evidências (a página rola, carrega imagens e troca de
layout) e, para um inline, é a caixa envolvente de todos os fragmentos de linha. Agora existe
`src/browser/measure-element.js`:

| Peça | O que faz |
| --- | --- |
| `measureElementTarget(cdp, node)` | remede pelo `backendNodeId` com `DOM.getContentQuads` (um quadrilátero **por fragmento de linha**); sem quadriláteros utilizáveis, cai para `DOM.getBoxModel` (borda) |
| `quadToRect` | converte o quadrilátero do CDP no retângulo alinhado aos eixos que o contém |
| `viewportOrigin` | lê `cssVisualViewport.pageX/pageY` de `Page.getLayoutMetrics` **no mesmo instante** e soma ao quadrilátero (confirmado contra o Chrome 152: com `scrollY = 800`, um elemento em `y = 1200` volta em `y = 400`) |
| `rectExceedsBounds` | declara o recorte nas bordas da página, com tolerância de subpixel (0,5 px) |
| `frame-context` | nó com `framePath` não vazio não é capturado com coordenadas do documento de topo |

`captureElement` (`src/browser/capture-evidence.js`) passa a aceitar `metrics.measuredRects`: quando a
medição fresca existe, ela manda e o `rect` do snapshot fica só como reserva. O que a captura grava:

- `metadata.highlightParts` — até 8 partes, cada uma em `capture-css-px` (o sistema do próprio recorte);
- `metadata.highlightBox` — a **união**, mantida para quem lê auditorias anteriores à 1.1.57;
- `metadata.highlightClipped: true` — só quando o alvo não cabe inteiro na captura (o campo é declarativo: o
  esquema recusa `false` explícito);
- `metadata.annotationMargin` — a margem de contexto usada.

**Margem adaptativa.** O valor fixo de 24 px dominava a imagem de um botão de 16 px e desaparecia ao redor de
um bloco grande: agora é `max(40, min(160, round(0,35 × lado maior)))`.

**Falhas declaradas, não escondidas** (`src/core/report/diagnostic-policy.js`): `ELEMENT_MEASUREMENT_FALLBACK`
(quando a remedição não foi possível e o snapshot foi usado) e `ELEMENT_CAPTURE_FRAME_CONTEXT` (elemento em
iframe sem miniatura própria). Nenhum dos dois marca a auditoria como parcial.

**Esquema fechado.** `highlightParts` (1 a 8 retângulos finitos) e `highlightClipped` entraram em
`assertEvidenceMetadata` (`src/core/report/closed-schema.js`) e na projeção de metadados
(`src/core/report/audit-model.js`): qualquer outra chave continua sendo recusada.

## 2. P3/P14/P17/P24 — uma só geometria de desenho, contorno **por fora**

`src/core/report/evidence-highlight.js` é agora o único lugar que calcula e descreve a marcação, usado pelo
relatório HTML (`html.js`) e pela página de revisão (`report-view.js`). O desenho de 7 px centralizado na borda
do elemento — que invadia o conteúdo e cobria o vizinho — foi substituído por:

- **spotlight**: a imagem inteira escurecida a 38 % com um furo por parte do alvo (`fill-rule="evenodd"`), de
  modo que o elemento contornado continua nítido;
- **contorno por fora**: cada parte é expandida em 3 px de imagem, com halo branco de 5 px **por baixo** do
  traço colorido de 2,5 px (`non-scaling-stroke`, `rx = 2`). Os halos de todas as partes são pintados antes de
  todos os traços, senão o halo de uma linha de um inline cobriria o traço da linha vizinha;
- **um contorno por fragmento de linha**, nunca a união;
- **nunca o tamanho do PNG decodificado**: o quadro vem de `metadata.width/height` ou, na falta, de
  `metadata.clip`. Sem nenhum dos dois a captura é apresentada **sem marcação**, com a legenda explícita
  “Captura sem marcação: o quadro do elemento não pôde ser posicionado com segurança.” (misturar os dois
  sistemas de coordenadas desalinharia a caixa em tela com escala de dispositivo);
- **legendas para leigos**, começando pela cor do contorno (`evidence-treatment.js`): “Contorno vermelho:
  elemento com falha.”, “Contorno âmbar tracejado: elemento que precisa de revisão humana.”, “Contorno âmbar
  sólido: recomendação não atendida; não é falha de requisito obrigatório.”, “Contorno azul: atendimento
  confirmado na revisão.” — sempre seguidas de “O restante da imagem aparece escurecido só como contexto.” e,
  quando cortado, “O elemento continua além desta captura.”. Nenhuma frase promete mais moldura sobre o
  conteúdo;
- **acessibilidade e impressão**: `<svg role="img" aria-label>` descreve o tratamento; em `forced-colors` o
  contorno vira `CanvasText` e o escurecimento é desligado (`fill:none`), sem perder a informação.

O CSS dos dois consumidores (`src/core/report/report.css.js` e `src/review/review.css`) carrega as mesmas
camadas; o hash de CSP do relatório estático foi atualizado junto.

## 3. P4 — mapa anotado com o alvo contornado

Em `src/browser/annotation-map.js`:

1. **Custo de distância em `placeMarkers`** — o custo de cada candidato é
   `colisões × 10⁶ + √(distância ao canto superior-esquerdo do próprio elemento)`. A anticolisão continua
   mandando (proximidade nunca vale mais que uma sobreposição), mas o número deixa de migrar para longe do
   alvo: as posições do perímetro, começando pelo canto superior-esquerdo, são as preferidas.
2. **Contêineres substituídos pelos descendentes anotados** — `li`, `table`, `details` e `role` `list`,
   `listitem`, `region`, `table` não entram quando já existe descendente anotado; a caixa de um contêiner
   englobaria vários elementos e o número deixaria de apontar para um alvo único. A substituição é declarada
   na limitação nova `container-replaced-by-annotated-descendant` (rótulo no relatório e na apresentação para
   leitor de tela).
3. **Contorno fino do alvo** — além da linha-guia, cada elemento anotado ganha um contorno de 2 px (escalado)
   com halo branco, na mesma cor do marcador (`#8b1e1e`, ou `#6b4e00` quando o marcador ficou sobreposto).
4. `ANNOTATION_MAP_VERSION` foi de `1.0.0` para **`1.1.0`** (a geometria desenhada mudou; o artefato derivado
   muda de hash).

## 4. Provas executadas

**Testes de unidade** (todos os diretórios fora de `test/e2e`, em blocos, um bloco por vez):

| Bloco | Resultado |
| --- | --- |
| `test/evidence` `test/browser` `test/report` `test/review` `test/core` `test/storage` `test/export` `test/legal` | **1185/1185**, 0 falhas |
| `test/background` `test/highlight` `test/panel` `test/integration` `test/accessibility` `test/axe` `test/detection` | **2626/2627**, 0 falhas (1 pulado) |
| `test/normative` `test/personas` `test/privacy` `test/reader` `test/rules` `test/ui` e arquivos da raiz | **512/513**, 1 falha esperada (ver §5) |

Arquivos novos: `test/browser/measure-element.test.js` (**9 testes**) e `test/report/evidence-highlight.test.js`
(**9 testes**). Atualizados: `test/browser/annotation-map.test.js` (29, +3), `test/evidence/capture-evidence.test.js`
(17, +7), `test/report/html.test.js` (34), `test/review/report-view.test.js` (57), `test/export/report-export.test.js`
(35) e `test/panel/normative-presentation.test.js` (1). Os testes de relatório/revisão passaram a injetar
`metadata` de quadro onde o objetivo é a marcação — e a afirmar a captura **sem marcação** onde não há quadro.

**E2E com `AUDITA_E2E_CHROME` = Chrome for Testing 152.0.7977.64**, um Chrome por vez (`--test-concurrency=1`):

| Arquivo | Resultado |
| --- | --- |
| `capture-visible-element` | 1/1 |
| `lazy-iframe-current-page-mv3` | 1/1 |
| `public-axe-map-mv3` | 1/1 (mapa: 5 recibos de captura, 7 guias práticos, pacote de 4 downloads) |
| `report-print-layout` | 1/1 (A4, 12 blocos, 2 páginas) |
| `report-print-breaks` | 1/1 |
| `report-executive-print` | 1/1 (28 páginas no PDF completo baixado, 15 no resumo, 146 itens ABNT) |
| `report-version-provenance` | 1/1 |
| `current-page-export-mv3` | 1/1 (4 artefatos verificados) |
| `current-page-pixel-consent` + `-free` + `-abort` + `direct-retire`, `batch-pixel-consent`, `url-pixel-consent` | **16/16** — a porta de privacidade de pixel e o consentimento continuam valendo com a medição nova |

**QA visual** — `node scripts/visual-qa.mjs --out qa-out/capturas-v1` (fixture local, modo evidência completa):
21 capturas em `qa-out/capturas-v1/127.0.0.1-marcacao.html/` (11 do painel/página + 4 do relatório, 6 de cada
miniatura isolada e 1 do mapa). Do `summary.json`: 64 achados com elemento, **6 miniaturas de elemento
capturadas**, 130 figuras de evidência no relatório, mapa anotado `complete` com 7 segmentos e **75 de 75**
elementos elegíveis anotados, 0 sem geometria, 0 omitidos por limite, 0 sobreposições não resolvidas; os três
sinais da página mediram **exatamente 1 elemento** no retângulo resolvido (3 de 3) e persistiram após 6 s com
rolagem e ponteiro mexido. Zero erros registrados pelo roteiro.

Leitura das imagens pedidas (06/07/08): cada miniatura de elemento contorna **só o elemento** — o botão “I” com
o botão “✕” ao lado fora do contorno, o `<select>` “Dúvida” sem o resto do formulário —, o conteúdo do alvo
aparece nítido e o resto escurecido, e a captura integral aparece **sem marcação** com a legenda de contexto.
No mapa, cada número fica colado ao canto do seu elemento, com o contorno fino correspondente, e a legenda
declara “Contêineres com elementos internos anotados aparecem representados por esses elementos internos.”.

**Verify do projeto** — `AUDITA_VERIFY_SKIP_TESTS=1 node scripts/verify-project.mjs` (a fase de suíte é a que
já foi rodada bloco a bloco acima): manifesto/CSP, axe 4.13.0 e seus hashes, identidade neutra, HTML/JSON/PDF
da amostra, fixtures e varreduras de privacidade — **GREEN**.

## 5. Limitações declaradas e pendências

1. **ZIP de release não reconstruído (única falha da bateria).** `test/release-package.test.js` compara o
   pacote construído a partir desta árvore com o arquivo entregue em `release/`. O fonte mudou nesta branch e
   o ZIP ainda é o da 1.1.56 (`31c0c4…` × `7a7187…`). É o passo de release (subir a versão, rodar
   `npm run build:release` e registrar o digest novo) — deliberadamente **não** feito aqui, e também não faria
   sentido antes de a tarefa paralela dos sinais fechar.
2. **Teto de 8 partes desenhadas.** Um inline com mais de 8 fragmentos de linha desenha os 8 primeiros; o
   recorte continua cobrindo **todos** os fragmentos medidos, então a caixa nunca corta o elemento.
3. **Elementos em iframes não recebem miniatura própria** (`cantTell`, `reason: 'frame-context'`): o clip do
   documento de topo recortaria a região errada. O achado permanece com seletor, descrição e captura integral,
   e a limitação é declarada.
4. **Mapa:** o número pode encostar no primeiro caractere do elemento (é o preço de ficar colado ao alvo).
   O contorno fino e a linha-guia existem justamente para o vínculo não depender disso.
5. **Capturas antigas sem `metadata` de quadro** aparecem sem marcação, com a legenda própria — antes elas
   ganhavam uma caixa derivada do tamanho do PNG decodificado, que podia estar deslocada em tela com escala de
   dispositivo.
6. **Fora deste escopo:** P0–P2 (cobertura, estabilidade e vínculo visual dos sinais na página) seguem com a
   tarefa paralela; o `ring`/anel do sinal individual ainda mede 0×0 no QA visual desta rodada
   (`ringVisible: false` no `summary.json`), o que é esperado enquanto aquela tarefa não fechar.
