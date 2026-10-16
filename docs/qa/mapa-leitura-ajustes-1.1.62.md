# Mapa de leitura — ajustes depois da integração (1.1.62)

Este documento registra a tarefa 20b: os quatro problemas que o orquestrador viu nas capturas da
tarefa 20 (feitas antes de a geometria fresca da tarefa 17 entrar) e o que foi feito em cada um, com a
medida antes/depois nos três sites reais e na página de teste.

Nada aqui é um esquema novo: o artefato continua `audita.annotation-map` na versão **1.3.0** — o
desenho com códigos `L1, L2…` sobre retângulos medidos no leiaute da imagem (ver
`mapa-leitura-1.1.62.md` e `mapa-teclado-caixas-1.1.62.md`). Auditorias guardadas nas versões 1.0.0 e
1.2.0 continuam abrindo com o desenho com que foram geradas.

## Resumo

| # | Problema | Situação depois deste trabalho |
|---|---|---|
| 1 | Mapa saiu sem caixa nenhuma em 2 de 3 sites | Já resolvido pela geometria fresca da tarefa 17, que chegou no merge; comprovado nos três sites e na página de teste |
| 2 | Caixas preenchidas de verde escureciam a página | Caixa é só contorno (2 px) com halo claro; o tom do semáforo ficou no traço e na etiqueta |
| 3 | Códigos empilhados no canto, longe dos seus elementos | Duas correções na regra única de posicionamento: a anticolisão passou a medir o retângulo de verdade e o código ganhou posições encostadas deslocadas um passo |
| 4 | "Mapas de anúncios" ainda no PDF e no índice | Título da seção, link do índice, tipo de evidência e anexo passaram a "Mapa de leitura da página"; o `h3` que repetia o título foi retirado |

## 1. O mapa saiu sem caixa nenhuma

Com a geometria fresca integrada (tarefa 17), o mapa de leitura passou a marcar em todas as páginas
conferidas. Nas capturas finais, o `viewBox` do mapa de leitura é exatamente o tamanho em pixel do PNG
exportado, e nenhuma página traz a nota `source-layout-changed` ("a página mudou de tamanho enquanto
era verificada"):

| página | caixas desenhadas | códigos na coluna da direita | viewBox = PNG |
|---|---|---|---|
| página de teste (fixture) | 123 | 123 | 879×5293 |
| portal público | 115 | 115 | 882×4674 |
| marketplace on-line | 200 | 200 | 879×6531 |
| loja on-line | 200 | 200 | 1000×3584 |

As duas páginas reais que antes saíam vazias aparecem marcadas, e a conferência por Tab mostrou 100%
das caixas batendo com a medida do elemento na escala da captura (115 de 115, 200 de 200 e 200 de 200;
na fixture, 123 de 123). As únicas notas declaradas são as de sempre: limite de 200 elementos por
mapa nas duas páginas grandes e, numa delas, "alguns códigos ficaram muito próximos".

## 2. As caixas escureciam a página

**Causa.** A caixa (`rect.map-box`) era desenhada com preenchimento no tom do semáforo — verde, âmbar
ou vermelho — com opacidade. Em contêiner grande (o carrossel, o cabeçalho, o rodapé) o preenchimento
cobria a página inteira; onde um contêiner e o que está dentro dele eram marcados ao mesmo tempo, as
duas áreas somavam opacidade e o conteúdo sumia.

**Correção.** A caixa é **só contorno**: `fill:none`, traço de 2 px e o halo claro (`stroke-linejoin`
e a cor clara por baixo) para dar contraste com qualquer fundo. O tom do semáforo ficou onde não cobre
conteúdo: no traço e na etiqueta do código. Vale para os dois desenhos da regra única — o mapa raster
do relatório (que já era só contorno) e o mapa da conferência por Tab:

- `src/reader/reader.css` — `.map-box` e os quatro tons (`tone-problem`, `tone-review`, `tone-ok`,
  `tone-info`) sem preenchimento;
- `src/reader/report-model.js` — as mesmas regras no CSS do HTML entregue (e do PDF), para o arquivo
  exportado não voltar ao desenho com área preenchida.

Na comparação lado a lado da conferência por Tab (portal público, `10-mapa-leitura.png`), a página
antes aparecia lavada de verde e agora aparece legível, com os contornos marcando cada elemento.

## 3. Códigos longe dos seus elementos

**Causa.** A regra de anticolisão comparava a **distância entre os centros** das etiquetas com o
tamanho da etiqueta. Duas etiquetas empilhadas, encostadas e sem nenhuma sobreposição real, eram
tratadas como colisão — e o código era empurrado para o anel seguinte, dezenas de px longe do próprio
alvo. O defeito só aparece com código de três caracteres (`L62`, `L133`): a etiqueta fica mais larga,
e a folga entre centros passa a ser sempre menor que a largura. É exatamente a forma da coluna
apertada — menu, lista de resultados, tabela, grade de cartões.

Medida num caso sintético (110 itens empilhados de 25 em 25 px, códigos até `L110`):

| regra | códigos encostados | folga média | maior folga |
|---|---|---|---|
| anterior (distância entre centros) | 74 de 110 | 6,9 px | 27,0 px |
| atual | 110 de 110 | 0,0 px | 0,0 px |

**Correção 1 — a colisão é do retângulo de verdade.** `badgesConflict` compara os retângulos com a
folga de 2 px, e o custo passou a somar, além da colisão (peso dominante), cobrir a **própria** caixa
(peso 3) e cobrir a caixa de outro elemento (peso 1). Como as caixas agora são só contorno, encostar na
linha de um vizinho atrapalha muito menos do que sair de perto do próprio alvo.

**Correção 2 — posições encostadas deslocadas um passo.** Numa página densa, o lugar encostado já está
tomado pela etiqueta do vizinho. Antes, o código pulava direto para o anel (passo de uma etiqueta +
folga, para cima de 47 px); agora ele tem, antes do anel, oito posições na mesma borda da caixa,
deslocadas uma altura de etiqueta nas laterais e uma largura em cima e embaixo. O código desvia do
vizinho **andando um passo**, e não mudando de rua.

**O que mudou nas capturas.** A tabela abaixo usa a **mesma geometria exportada** das capturas feitas
antes das correções (mesma lista de retângulos, mesma ordem), então compara regra com regra, e não
página com página — página real muda de conteúdo entre uma execução e outra:

| página | caixas | códigos encostados | acima de 40 px | folga média | maior folga | etiquetas sobrepostas |
|---|---|---|---|---|---|---|
| página de teste | 123 | 120 → 122 | 0 → 0 | 1,3 → 1,0 px | 20 → 4,5 px | 0 → 0 |
| portal público | 115 | 106 → 109 | 2 → 0 | 4,0 → 2,0 px | 42 → 34 px | 1 → 0 |
| marketplace on-line | 200 | 170 → 189 | 3 → 0 | 4,3 → 2,1 px | 43,7 → 32 px | 0 → 0 |
| loja on-line | 200 | 169 → 190 | 17 → 8 | 7,7 → 4,3 px | 102 → 71 px | 8 → 6 |

O caso mais apertado (a grade de produtos da loja on-line) continua com alguns códigos a mais de 40 px
da própria caixa: ali as etiquetas vizinhas ocupam todos os lugares livres num raio maior. Nesses
poucos casos o desenho mantém a **linha-guia curta** entre a etiqueta e a caixa, que é o recurso
previsto para quando o código não cabe encostado.

## 4. "Mapas de anúncios" no PDF e no índice

O título antigo vivia em quatro lugares. Todos passaram a "Mapa de leitura da página", mantendo os
identificadores internos (`announcement-map`, `data-announcement-map-page`, `#mapas`) como estão:

| onde | antes | depois |
|---|---|---|
| título da seção no relatório (HTML, PDF e painel) | Mapas de anúncios | Mapa de leitura da página |
| link do índice e da navegação de seções | Anúncios | Mapa de leitura |
| seção do relatório completo (`#mapas`) | Mapa visual da prévia de anúncios | Mapa de leitura da página |
| tipo de evidência no anexo | Mapa de anúncios | Mapa de leitura |
| texto alternativo da imagem derivada | Mapa visual derivado da prévia de anúncios | Mapa de leitura da página: imagem derivada, com as caixas dos elementos marcados |
| mapa guardado de revisão anterior (1.0.0/1.2.0) | Mapa visual da prévia de anúncios: os números ligam… | Mapa guardado de uma revisão anterior: os números ligam… |

Junto com isso saiu uma repetição: a seção já se chama "Mapa de leitura da página" no `h2` (é o nome
do índice), e o mapa abria com um `h3` com o **mesmo texto** logo abaixo. O relatório dizia duas vezes
seguidas a mesma coisa, em tela e na navegação por cabeçalhos. O `h3` foi retirado: a seção abre direto
na explicação leiga ("Cada caixa marca um elemento da página…"), e cada página do mapa continua com o
seu próprio `h3` ("Página 1 — …"). O HTML entregue e o PDF passaram a ter um título só.

## 5. Coerência da versão 1.3.0

O merge juntou duas mudanças que se chamavam 1.3.0: o desenho com códigos (tarefa 20) e os retângulos
medidos no leiaute da imagem (tarefa 17). Como nenhuma das duas foi publicada, 1.3.0 ficou valendo
pelas duas coisas — "desenho com códigos sobre retângulos frescos" — e o comentário do artefato passou a
registrar as duas (`src/core/evidence/annotation-map-artifact.js`): o desenho com código curto e a
medida do retângulo tirada do leiaute no momento da captura, com a limitação `source-layout-changed`
declarada quando o leiaute discorda da imagem. As regras de leitura por
versão continuam as mesmas: 1.0.0 e 1.2.0 leem `markerKeys` (círculo com número dentro da imagem),
1.3.0 lê `badgeKeys` (retângulo da etiqueta), e a auditoria guardada da 1.1.56 abre inteira
(`test/report/legacy-1.1.56-compat.test.js`).

## 6. Testes

- **Unidade (suíte inteira, parte de unidade):** 4723 testes, 4721 passam, 1 falha esperada
  (`test/release-package.test.js`, hash do ZIP enquanto o código-fonte muda), 1 pulado. Os arquivos
  afetados passam: `test/evidence/annotation-map-artifact.test.js`,
  `test/browser/annotation-map.test.js`, `test/reader/reading-map-plan.test.js`,
  `test/report/html.test.js`, `test/reader/report.test.js`, `test/review/report-view.test.js`,
  `test/export/report-export.test.js`, `test/report/legacy-1.1.56-compat.test.js`.
- **E2E em Chrome real**, um arquivo por vez, todos passando: `report-print-layout`,
  `report-executive-print`, `report-print-breaks`, `tab-reading-mv3`, `keyboard-map-mv3`,
  `keyboard-map-cresce-mv3`, `public-axe-map-mv3`.
- **Teste de regressão novo:** "numa coluna apertada o código continua encostado na própria caixa"
  (110 itens empilhados de 25 em 25 px, códigos até `L110`): toda etiqueta a ≤ 4 px da própria caixa e
  nenhuma declarada sobreposta. Ele reprova com a regra anterior (maior folga 27 px).
- **Identidade neutra:** `node scripts/verify-neutral-identity.mjs` passa.

## 7. Conferência visual nos sites reais

`node scripts/visual-qa.mjs` na página de teste e em três sites reais. Imagens abertas e conferidas
(`08-mapa.png`, `09-mapa-teclado.png`, `10-mapa-leitura.png`, `11-mapa-impressao.png`,
`12-mapa-do-pdf.png`, com recortes ampliados para conferir o encaixe das caixas):

| página | mapa de leitura: caixas | mapa do teclado: lugares onde o Tab para | itens que o Tab não alcança | códigos encostados | acima de 40 px |
|---|---|---|---|---|---|
| página de teste | 123 | 36 | 0 | 122 de 123 | 0 |
| portal público | 115 | 53 | 4 | 109 de 115 | 0 |
| marketplace on-line | 200 | 123 | 0 | 189 de 200 | 0 |
| loja on-line | 200 | 93 | 0 | 189 de 200 | 7 |

Nas capturas: as caixas saem só de contorno e o conteúdo continua legível; os códigos aparecem
encostados nos seus elementos (antes havia pilhas de `L6x`/`L1xx` no canto superior esquerdo do portal
público e códigos a mais de 100 px da caixa na grade da loja on-line); a primeira página do mapa no PDF
abre com "Mapa de leitura da página" uma única vez, seguida da explicação e de "Página 1 — …".

## 8. Limitações

- **Uma página real não renderiza a página do mapa no motor de PDF.** No portal público o passo
  `pdf:pagina-do-mapa` termina em `CDP_COMMAND_INVALID` e a captura `12-mapa-do-pdf.png` não sai. Isso
  já acontecia **antes** destas mudanças (mesmo erro na linha de base), com um PDF de 37 MB e 143
  páginas; nos outros dois sites o mesmo passo funciona. Não é regressão desta tarefa.
- **Página real muda entre execuções.** As contagens de caixas e de lugares onde o Tab para acompanham
  o estado da página no momento da captura; por isso a comparação antes/depois do item 3 usa a mesma
  geometria exportada, e não duas execuções diferentes.
- **Códigos muito próximos continuam possíveis.** Numa grade densa, alguns códigos ficam a mais de
  40 px da própria caixa e são ligados por linha-guia; quando isso acontece em cima de outro código, o
  mapa declara "alguns códigos ficaram muito próximos e podem aparecer sobrepostos" e a tabela do
  elemento continua sendo a leitura de referência.
- **A etiqueta continua com o fundo escuro fixo** (vermelho da marca, `#8b1e1e`, e `#6b4e00` quando
  sobreposta), e não com o tom do semáforo. É o que mantém o contraste AA do texto branco e o mesmo
  desenho nos dois mapas; a cor do semáforo fica no traço da caixa e no próprio conteúdo da etiqueta.
- **O desenho é o mesmo no relatório e na conferência.** Qualquer ajuste fino futuro vale para os dois:
  a regra é uma só (`annotationMarkerLayout`).

## 9. Expectativas de teste alteradas

| arquivo | o que mudou | por quê |
|---|---|---|
| `test/report/html.test.js` | dois títulos esperados passaram de "Mapa visual da prévia de anúncios" para "Mapa de leitura da página" | o título da seção mudou de propósito (item 4) |
| `test/review/report-view.test.js` | título e rótulo de navegação da seção; o teste do mapa guardado deixou de esperar "Códigos e textos deste mapa" | o nome da seção mudou; o mapa antigo continua abrindo com o desenho antigo, e o DOM do teste é um esboço sem seletor de classe |
| `test/review/report-view.test.js` | o mapa não abre mais com um `h3` repetindo o título da seção | o `h3` duplicado foi retirado de propósito (item 4) |
| `test/export/report-export.test.js` | rótulo de navegação "Anúncios" → "Mapa de leitura" | mesmo motivo |

## 10. Como reproduzir

```bash
export AUDITA_E2E_CHROME="$HOME/.cache/audita-cft/chrome/mac_arm-<versão>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

# página de teste (fixture local, servida pelo próprio script)
node scripts/visual-qa.mjs --out qa-out/aj-final-fixture

# sites reais (um Chrome por vez)
node scripts/visual-qa.mjs --no-fixture --out qa-out/aj-final-reais \
  --url https://www.<portal-publico>/ --url https://www.<marketplace>/ --url https://www.<loja>

# um arquivo de E2E por vez
node --test test/e2e/report-print-layout.test.mjs
```

O resumo de cada execução fica em `qa-out/<nome>/summary.json`; a linha "códigos no próprio elemento"
mostra as folgas entre etiqueta e caixa (encostados, acima de 40 px, média, mediana, p90 e maior).
