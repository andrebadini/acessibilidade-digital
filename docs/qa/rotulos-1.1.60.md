# Etiquetas dos sinais não podem cobrir o texto da página

Versão analisada: 1.1.59 (branch `wip160/rotulos`, worktree isolado) → correção preparada para a 1.1.60.
Relato: na página de teste, a etiqueta do link **"Leia mais"** pousava em cima da última linha do título da notícia e cobria palavras. O mesmo acontecia em sites reais: a etiqueta de um sinal caía sobre o texto **de outro elemento** e escondia parte da frase.

Escopo: correção do posicionamento das etiquetas em `src/browser/page-markers-overlay.js`, medição nova no roteiro de QA visual (`scripts/visual-qa.mjs`) e um caso de teste de cartão de notícia na fixture. Nomes e domínios institucionais e de lojas foram omitidos de propósito: as páginas aparecem como "portal público", "loja A" e "loja B".

> **Ferramenta de QA**: `node scripts/visual-qa.mjs --out qa-out/<nome> --url <portal> --url <loja A> --url <loja B>` (fixture local incluída por padrão). O número que interessa aqui é o `etiquetas sobre TEXTO de outro elemento` impresso no fim de cada página, guardado em `summary.json` como `signals.labelsOverText` / `signals.textLinesCovered` / `signals.textLinesInViewport`.

---

## 1. O problema

O posicionamento da etiqueta escolhe entre posições candidatas (colada acima/abaixo do contorno, centralizada, linhas destacadas com linha de ligação, dentro do contorno) somando custos. Antes desta correção o custo conhecia: outras etiquetas (área × 1000), obstáculos pequenos (× 40, botões e ícones), o contorno do próprio elemento (× 40), o interior do contorno (+ 20 × área) e os lados cortados pela borda da tela ou por cabeçalho fixo (+ 5000). **O texto da página não entrava nessa conta**, e por isso a posição "colada acima do contorno" — que é a mais barata e a preferida — caía sobre a linha de texto que estivesse logo acima.

Nas capturas da execução de base (`qa-out/antes-fixture/…/02-sinais-topo.png` e `qa-out/antes/…/02-sinais-topo.png`) isso é visível: a etiqueta `1 ? (4)` fica no meio da terceira linha do título ("…todos os **1 ? (4)** …s da cidade") e as etiquetas `18 × (3)`, `19 × (3)` e `20 × (3)` ficam em cima do aviso de cookies, cortando a frase.

## 2. A solução

Tudo em `src/browser/page-markers-overlay.js`, dentro da sessão de instalação do overlay:

1. **Varredura do texto visível** (`collectTextLines`): percorre a subárvore de `body` com pilha, podando o que está inteiramente fora da viewport. Para cada nó de texto não vazio usa **um único `Range` reaproveitado** (`selectNodeContents` + `getClientRects`) e guarda uma linha por fragmento, já filtrada pela viewport.
2. **Limites de custo**: no máximo 2 000 elementos visitados, 1 500 linhas guardadas e 12 ms de varredura (`MAX_TEXT_ELEMENTS`, `MAX_TEXT_LINES`, `TEXT_SCAN_BUDGET_MS`). A varredura é preguiçosa e **por passada** (`scan = { lines: null, index: null }`): uma página sem sinais visíveis não paga nada.
3. **Índice espacial** (`indexTextLine` / `textLinesNear`): cada linha entra em um balde de 200 px (`TEXT_BUCKET`, chave `coluna:linha`). Na hora de posicionar, só as linhas perto da zona onde a etiqueta pode cair são examinadas — nada de comparar com todas as linhas da página por candidato.
4. **Custo do texto** em `placeLabel`: área coberta × **600** (`TEXT_COST`) e, quando a etiqueta cobre uma linha inteira, mais **1 × 10⁹** (`TEXT_COVER_COST`). O custo continua finito: sempre existe uma posição escolhida, mesmo quando não há nenhum lugar livre.
5. **Exceção para o texto do próprio elemento marcado**: as linhas cujo nó está dentro do elemento (`ownsText`, via `contains`) saem da lista de obstáculos. O texto do alvo pode ser coberto como último recurso, e só ele.
6. **Zona de busca**: `placeGroupLabel` mede o texto em torno do contorno com alcance de quatro larguras/alturas de etiqueta mais o passo das linhas destacadas — exatamente a região que os candidatos alcançam.
7. **Garantias mantidas**: continuar dentro da tela, nunca sobre outra etiqueta, nunca sob cabeçalho fixo/banner e continuar presa ao contorno (colada, ou destacada com linha de ligação curta).

## 3. Medição: métrica nova no roteiro visual

`scripts/visual-qa.mjs` ganhou a leitura `labelOnText` dentro de `OVERLAY_STATE`: coleta as linhas de texto da página (mesma ideia da varredura do produto: `Range`, só a viewport, tetos de 1 500 linhas e 2 000 elementos), descobre de quem é cada linha (o elemento marcado, pelo retângulo do contorno e pelo elemento mais fundo sob o centro do anel — `elementsFromPoint`) e marca a etiqueta que cobre texto **de outro elemento**. O resultado vira:

- por sinal: `labelOnTextCount`, `labelOnText` (até 3 linhas com o texto, o dono e a área coberta em px) e `labelOnTextLines`;
- agregado em `summary.json`: `signals.labelsOverText`, `signals.textLinesCovered`, `signals.textLinesInViewport`;
- na linha impressa: `etiquetas sobre TEXTO de outro elemento: N (X linha(s) de texto coberta(s) de Y medidas na viewport) — Sinal k cobre …`.

A fixture `test/e2e/fixtures/visual-qa/marcacao.html` ganhou o **CASO 13 — cartões de notícia** (três cartões com título de três linhas, imagem decorativa e link "Leia mais" de contraste baixo ~2:1 logo abaixo, sem folga). A seção `#noticias` fica logo depois do topo (hero), dentro da primeira viewport, para que a medição — que fotografa um instante — veja o caso.

## 4. Testes

| Teste | O que verifica | Resultado |
| --- | --- | --- |
| `test/highlight/page-markers-text-obstacles.test.js` (novo, 6 casos) | etiqueta abandona a posição colada quando há linha de texto embaixo; o texto do próprio alvo é isento; com texto em cima e embaixo a etiqueta vai para uma linha livre com linha de ligação; texto fora da viewport não conta e não empurra a etiqueta para fora da tela; 300 sinais numa grade densa; quatro cartões de notícia sem etiqueta sobre o título | 6/6 passam (no código antigo, 3 falham) |
| `test/e2e/page-markers-signals-mv3.test.mjs` (ampliado) | com o overlay real e a auditoria real: o sinal numerado pousa no link "Leia mais" (`ringOwner`), nenhuma etiqueta desenhada cobre as linhas do título (`overTitleText`), a etiqueta fica colada ao contorno ou com linha de ligação (distância ≤ 120 px) | passa (no código antigo falha: `1 ? (4)` cobrindo a 2ª linha do título) |
| `test/e2e/page-markers-label-perf-mv3.test.mjs` (novo) | overlay real injetado em página real com 300 sinais e 300 linhas de texto na mesma viewport: tempo de instalação e de cada passada, com controle sem as linhas de texto | passa com 26 etiquetas sobre texto (antes: 209) e nenhum travamento |
| `node scripts/run-tests.mjs` | suíte completa (unitária e Chrome real) | ver §7 |

O roteiro `createTestPlan` de `scripts/run-tests.mjs` classifica todo teste de `test/e2e/`: o arquivo novo foi registrado em `REAL_CHROME_E2E` (só ele usa Chrome real e precisa de `AUDITA_E2E_CHROME`).

## 5. Desempenho

O medo era a varredura de texto congelar a página quando há muitos sinais. O custo por passada é de leitura de layout, então foi medido em navegador real, não em DOM falso.

| Cenário (300 sinais, 300 linhas de texto) | Antes | Depois |
| --- | --- | --- |
| Instalação | 374 ms | 384 ms |
| Passadas (3) com texto | 325 / 311 / 299 ms | 215 / 197 / 186 ms |
| Passadas (3) sem texto (controle, mesma aba) | 373 / 208 / 200 ms | 405 / 207 / 204 ms (a primeira varia até ~630 ms: a página acaba de perder as 300 linhas de texto e o navegador refaz o layout) |
| Etiquetas sobre texto | **209 de 300** | **26 de 300** |

A varredura de texto **não** é o gargalo: o que domina a passada é o posicionamento, que compara cada candidata com as etiquetas já colocadas (cresce com o quadrado do número de sinais). Na grade densa, o custo medido com texto ficou dentro da variação do controle sem texto. No teste com DOM falso (300 sinais): instalação 101 ms e passada de reposicionamento 55 ms.

## 6. Resultado em sites reais e na fixture

Execuções com Chrome for Testing 152 e o roteiro visual, antes (código de 1.1.59) e depois:

| Página | Etiquetas sobre texto — antes | depois | Linhas cobertas — antes → depois | Linhas medidas na viewport |
| --- | --- | --- | --- | --- |
| Fixture (cartões de notícia) | 3 | **0** | 6 → 0 | 24 |
| Portal público | 1 | **0** | 1 → 0 | 58 → 61 |
| Loja A | 7 | **1** | 9 → 1 | 73 |
| Loja B | 5 | **0** | 8 → 0 | 55 |

Capturas abertas e conferidas (`02-sinais-topo`, `03-sinais-rolagem-*`, `04-selecionado-*` dos dois lados):

- **Fixture**: antes, `1 ? (4)`, `2 ? (4)` e `3 ? (4)` cortavam a terceira linha dos três títulos; depois, as três etiquetas ficam **abaixo** do contorno do "Leia mais" e os títulos ficam inteiros de ponta a ponta.
- **Portal público**: antes, `14 × (2)` cobria o fim de uma das manchetes da lista de notícias (a métrica registrou a linha coberta); depois, a mesma etiqueta desceu para a faixa da imagem do banner e a manchete ficou legível por inteiro. Nas capturas de rolagem, as etiquetas que sobram ficam na coluna da esquerda, cada uma com sua linha de ligação até o contorno — legíveis e ligadas ao elemento.
- **Loja A**: antes, `18 × (3)`, `19 × (3)` e `20 × (3)` cortavam a frase do aviso de cookies; depois, as três desceram para a área dos botões do mesmo aviso, sem texto embaixo. `42 ?` e `44 × (3)` saíram de cima de "COMPRA GARANTIDA" e "LOJAS OFICIAIS".
- **Loja B**: antes, as etiquetas `8 ×` a `14 ×` cobriam os títulos das vitrines ("**8 ×**is Vendid…", "**9 ×**m Refis" — o texto cortado pela etiqueta); depois, os mesmos títulos aparecem inteiros ("Mais vendidos em Dispositivos…", "Favoritos dos Influenciadores", "Itens de Beleza…") com as etiquetas acima ou ao lado.

O que **não** mudou (garantias preservadas, medidas em `summary.json`): nenhuma etiqueta sobre outra etiqueta em nenhuma das páginas; todos os contornos continuam desenhados e colados ao elemento; nenhuma etiqueta fora da tela; a leitura da página (rolagem, foco, conteúdo) não é alterada.

## 7. Suíte completa

`node scripts/run-tests.mjs` (com `AUDITA_E2E_CHROME`), duas fases:

| Fase | Testes | Passam | Falham | Observação |
| --- | --- | --- | --- | --- |
| Paralela (unitária e de contrato) | 4 514 | 4 512 | 1 | só `test/release-package.test.js` (hash do ZIP de release, que muda enquanto o fonte muda — falha esperada nesta fase) |
| Serial (Chrome real, um arquivo por vez) | 135 | 128 | 7 | 6 falhas que **não se repetem** ao rodar cada arquivo sozinho + 1 falha pré-existente |

As 6 falhas que **não se repetem** ao rodar cada arquivo sozinho: `navigation-freeze-mv3` (recarga por timer), `personas-mv3-csp` e, em `sidepanel-flow-mv3`, os passos `no-pixels shows progress`, `element-only completes`, `full-evidence rehydrates` e o bloco `passive current-page audits complete in every mode` que agrupa os três. Rodando cada arquivo isolado, `navigation-freeze-mv3` e `personas-mv3-csp` passam inteiros, e `sidepanel-flow-mv3` deu 8 de 9 — só a falha abaixo. São asserções sensíveis a foco, redimensionamento da janela do Chrome e tempo; a execução da suíte inteira deixa a máquina carregada e elas oscilam (a primeira repetição isolada de `sidepanel-flow-mv3` ainda mostrou 4 dessas oscilações; a segunda, nenhuma).

A falha que **se repete também na árvore de base** (código de 1.1.59, sem esta mudança, em `/tmp` — 8 de 9, mesmo teste): `sidepanel-flow-mv3` › "original-page ABNT markers remain usable across idle and preserve the report". O passo que falha é `IDLE_BEFORE_SHOW`, que exige que o documento observado não receba evento nenhum (`resize`, `focus`, `blur`) enquanto o painel fica parado; o que aparece registrado é a própria janela do Chrome sendo criada e ajustada ao tamanho da viewport (`1x1` → `894x749`) no começo do teste. Passou nos passos de sinais (`SHOW`, `PAGE_TO_ABNT`, `PANEL_TO_PAGE_AND_KEYBOARD`) com o código novo. Fica registrado como falha de ambiente anterior a este trabalho.

## 8. Limitações

- **Grade sem folga nenhuma**: quando a página é um campo contínuo de linhas de texto (a grade de 300 sinais do teste de desempenho) *toda* posição candidata cobre alguma linha. O custo passa a escolher a posição que cobre menos, não a posição livre — por isso os 26 casos restantes ali. É um caso extremo, não o de uma página comum.
- **Um caso residual na loja A**: a etiqueta `142 ?` continua cobrindo o fim de "Confira produtos com preços baixos" dentro de um carrossel de cartões colados. Não há espaço livre alcançável pelos candidatos naquela faixa; cobrir um pedaço pequeno da linha foi a posição mais barata entre as disponíveis.
- **Etiqueta sobre o contorno de outro elemento marcado** (métrica `etiquetas sobre outro elemento marcado`): 0 → 2 na loja A e 0 → 1 na loja B. Acontece porque o texto passou a custar 600 por px² e o contorno de outro elemento custa 0,05 por px²: quando as duas coisas colidem, o produto prefere cobrir o contorno (que é uma moldura vazia) a cobrir palavras. A etiqueta continua legível e presa ao próprio contorno; a prioridade escolhida é a do relato. Não é garantia declarada, mas fica registrado.
- **A métrica olha um instante**: `labelsOverText` mede o que está na viewport e desenhado no momento da leitura. Página que gira conteúdo (carrossel, banner, aviso de cookies) pode mostrar números diferentes entre execuções — daí a diferença de "sinais desenhados" entre a execução de base e a de depois no portal e na loja B.
- **Achado pré-existente na fixture**: o passo `selecionar-1` do roteiro estoura o tempo esperando o anel de um sinal (`Sinal 50`, uma ocorrência de texto alternativo) **nos dois lados da comparação** — reproduz igual com o código antigo (execução de base) e com o código novo, e se repetiu em três execuções seguidas. Não tem relação com esta mudança: é o alvo daquela ocorrência que não recebe contorno desenhável. Aparece como erro da página da fixture tanto no "antes" quanto no "depois", então não contamina a comparação.
- **Texto em `canvas`, imagens e SVG**: não existem nós de texto para medir. A etiqueta pode continuar caindo sobre um desenho (é o que acontece de propósito no portal público, onde a etiqueta desceu para a faixa do banner), o que não atrapalha a leitura de palavras.

## 9. Arquivos alterados

- `src/browser/page-markers-overlay.js` — varredura do texto visível, índice espacial, custo de texto no posicionamento e isenção do texto do próprio alvo.
- `scripts/visual-qa.mjs` — métrica `labelOnText` por sinal, agregados no `summary.json` e linha nova no resumo impresso.
- `test/e2e/fixtures/visual-qa/marcacao.html`, `marcacao.css` — CASO 13 (cartões de notícia) no topo da página de teste.
- `test/highlight/page-markers-fixture.js` — nós de texto e `Range` no DOM falso, para os testes unitários conseguirem medir linhas.
- `test/highlight/page-markers-text-obstacles.test.js` (novo) — 6 casos de posicionamento, incluindo o de 300 sinais.
- `test/e2e/page-markers-signals-mv3.test.mjs` — cartão de notícia na página auditada e verificações de "dono do contorno" e "etiqueta sobre o título".
- `test/e2e/page-markers-label-perf-mv3.test.mjs` (novo) — 300 sinais com texto em Chrome real, com controle sem texto.
- `scripts/run-tests.mjs` — registra o teste de densidade em `REAL_CHROME_E2E`.
