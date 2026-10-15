# Falsos "itens que parecem clicáveis e o Tab não alcança" no mapa do teclado — 1.1.60

Data: 15/10/2026. Versão em trabalho: **1.1.60** (branch `wip/suspeitos`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão é o passo de release).
Chrome for Testing 152.0.7977.64, um Chrome por vez.

Escopo: a lista de **itens que parecem clicáveis e o Tab não alcança** do item **5.1.13** (WCAG 2.1.1 —
teclado). O problema é de leitura: quando a lista enche de desenho que não é item de verdade, o achado
real se perde no meio dela e a extensão perde credibilidade justamente com quem não sabe inspecionar
página. Por regra do projeto, **nenhum nome de órgão ou de loja é registrado aqui** — as páginas reais
são descritas como "portal público" e "loja on-line A/B".

> **Fora de escopo.** Esquemas, catálogos, políticas e hashes são fechados e **não** foram tocados.
> O ajuste está inteiro no cálculo dos suspeitos (`src/core/keyboard/keyboard-map-model.js`), nos
> testes e na sonda de medição (`scripts/visual-qa.mjs`).

## 1. O problema

O mapa do teclado marca três motivos de suspeita: **ocorrência de regra** de teclado
(`keyboard-rule`), **papel interativo sem foco** (`interactive-role`) e **seta de clique**
(`cursor-pointer`). O terceiro é o mais frágil: `cursor: pointer` é um estilo, e a página usa a seta
em muito lugar que não é item — fotos de produto, ícones, selos, o contêiner inteiro de um carrossel.

O caso verdadeiro a preservar é conhecido e está coberto: quatro cartões de serviço que só abrem o
menu com o mouse (achados da regra `hover-only-interactive-content`, motivo `keyboard-rule`).

## 2. Medição antes (passo 1)

Comando exato da tarefa, com a sonda nova ligada:

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/suspeitos-antes \
  --url <portal público> --url <loja on-line A> --url <loja on-line B>
```

(Os endereços reais não são registrados aqui por regra do projeto; a rodada foi feita com um portal
público e duas lojas on-line.)

A sonda (`scripts/visual-qa.mjs`) passou a ler o artefato `keyboard-map` da auditoria guardada
(`audit-store` → `getReportRevision`) e a gravar, no `summary.json`, a lista de suspeitos com
`tag`, `role`, `reason`, `ruleId`, `name`, `nameSource` e `bounds`; e, na página auditada ainda
aberta, uma segunda medição de contexto por suspeito (`mesmaCaixa`, `proprio`, `ancestralParada`,
`pais`) — é essa medição que separa item de verdade de desenho decorativo, porque o instantâneo não
carrega a árvore viva.

| Página | paradas do Tab | suspeitos | contagens de omissão |
| --- | ---: | ---: | --- |
| portal público (home) | 44 | **4** | 508 sem visibilidade, 7 sem retângulo, 1 cortado, 3 em quadro |
| loja on-line A (home) | 57 | **6** | 757 sem visibilidade, 38 sem retângulo, 99 cortados, 3 em quadro |
| loja on-line B (home) | 121 | **0** | 1092 sem visibilidade, 1 sem retângulo, 2 cortados |

Suspeitos do portal público (todos verdadeiros):

```
1. <div> papel=layouttable motivo=keyboard-rule regra=hover-only-interactive-content nome="CONSUMIDOR"
2. <div> papel=layouttable motivo=keyboard-rule regra=hover-only-interactive-content nome="FORNECEDOR"
3. <div> papel=layouttable motivo=keyboard-rule regra=hover-only-interactive-content nome="SERVIDOR"
4. <div> papel=layouttable motivo=keyboard-rule regra=hover-only-interactive-content nome="OUVIDORIA"
```

Suspeitos da loja on-line A (todos falsos, todos `<img>`):

```
1. <img> papel=image motivo=cursor-pointer nome="Bravecto® 1000mg …"
2. <img> papel=image motivo=cursor-pointer nome="Pack Ração Úmida …"
3. <img> papel=image motivo=cursor-pointer nome="Kädi Areia Biodegradavel …"
4. <img> papel=image motivo=cursor-pointer nome="Scalibor® 19g …"
5. <img> papel=image motivo=cursor-pointer nome="Echo Dot …"
6. <img> papel=image motivo=cursor-pointer nome="Kindle 16 GB …"
```

**Classificação manual, pela captura e pela sonda de contexto:**

- Portal público: **4 verdadeiros**. A sonda não achou nenhum link, botão ou `tabindex` na cadeia de
  ancestrais dos quatro cartões, e os ancestrais declaram `cursor: auto` — o cartão é um `<div>` com
  texto, seta de clique e nenhum foco. É exatamente o caso que a lista existe para mostrar, e o
  `09-mapa-teclado.png` mostra as quatro caixas laranja tracejadas sobre os quatro serviços.
- Loja on-line A: **6 falsos**. Cada uma das seis fotos está **dentro de um `<a href>` de produto**
  (cadeia `picture < div < a`), e clicar na foto segue o link do dono. Medição com o código anterior
  (para não depender do ajuste que ainda não existia) repetida duas vezes: 10 de 10 fotos suspeitas
  com `ancestralParada` = `<a href="/…/dp/…">`. O item de verdade é o **link**, que é parada do Tab.
- Loja on-line B: **0 suspeitos** já antes — página montada com foco nativo, nada a corrigir.

### 2.1 O que **não** se reproduziu

- Os números citados na tarefa (31 suspeitos numa página e teto de 60 em outra) **não** apareceram
  no estado das páginas de hoje: os portais e lojas mudam de conteúdo entre carregamentos (na loja
  on-line A, entre a medição antes e a depois, as paradas de Tab foram de 57 para 75 e os elegíveis de
  194 para 519 — blocos promocionais diferentes). O que se compara aqui é o **número de suspeitos e a
  natureza deles**, não os totais absolutos.
- O teto de 60 suspeitos **não** foi reproduzido em página real nem numa página de catálogo local
  sintética (99 fotos em 99 links): no instantâneo de uma página pequena e completa o pai da foto
  carrega a seta de clique, e a checagem de herança que já existia já dispensava a foto antes mesmo do
  ajuste. O cenário do teto virou **teste de unidade determinístico** (§4), que é onde ele pode ser
  medido sem depender do humor da página.

## 3. Correção (passo 2)

**Uma regra nova, no modelo:** o desenho apontado pela seta de clique que está **dentro** de uma
parada do Tab não entra na lista. O Tab alcança o dono (link, botão, campo, `[tabindex]`) e o clique
na imagem segue esse dono; a seta de clique, sozinha, não distingue esse desenho de um item.

```js
else if (cursor && !NATIVE_INTERACTIVE_TAGS.has(tag) && !COMPOSITE_REACHABLE_ROLES.has(role) &&
  !belongsToStop.has(String(candidate.node.nodeId)) && !insideStop.has(String(candidate.node.nodeId)) &&
  hasLabel) reason = 'cursor-pointer';
```

`insideStop` é o espelho do `belongsToStop` que já existia: um cobre o que **contém** uma parada, o
outro o que **está dentro** dela. Um percurso em profundidade marca os descendentes de cada parada
candidata — sem ida extra ao navegador, tudo do instantâneo.

**Por que a dispensa vale só para `cursor-pointer`:** a ocorrência de regra e o papel interativo falam
do **próprio** item — quem declara `role="button"` ou é alvo da regra de conteúdo só com mouse precisa
ser alcançado por si, mesmo dentro de outra parada. O comentário no código diz isso; o teste
"item com ocorrência de regra continua apontado mesmo dentro de uma parada do Tab" prova.

### 3.1 Os exemplos de heurística da tarefa, um por um

| Exemplo pedido | Situação |
| --- | --- |
| Imagem/ícone dentro de link ou botão | **Novo.** Regra desta rodada (`insideStop`). Medido na loja on-line A. |
| `cursor: pointer` que contém um item alcançável | Já coberto antes por `belongsToStop` (contêiner de carrossel, cartão que envolve o link). |
| Seta herdada (contêiner grande com a seta do script) | Já coberto antes: a seta só conta quando o próprio elemento a declara diferente do pai; é a regra que impede o `<body>` inteiro de ser suspeito. |
| `<label>` associado a um campo | Já coberto antes: `label` está em `NATIVE_INTERACTIVE_TAGS`, então nunca entra pelo motivo `cursor-pointer`. |
| Itens escondidos de carrossel | Já coberto antes: `hidden`/`inert`/`aria-hidden`/`details` fechado e fora do retângulo visível saem em `omittedNotVisible` (757 na loja A, 1092 na loja B). |
| Elementos desabilitados | Já coberto antes: `isDisabledControl` (inclusive `fieldset[disabled]`) não entra na lista. |
| Elementos sem área útil | Já coberto antes: `usefulRect`/`visibleRect` mandam para `omittedNoRect`/`omittedClipped` (38 e 99 na loja A). |
| Banner de cookies com controle focável | Já coberto antes: o controle é parada do Tab e `belongsToStop` protege o contêiner. |
| Teto de 60 | Sem regra nova: medido em teste (§4), não em página real (§2.1). |

Nenhuma dessas linhas "já cobertas" foi tocada: elas foram conferidas uma a uma no código do modelo e
a medição em página real não mostrou falso positivo delas. O ajuste ficou no menor tamanho possível —
uma condição e um conjunto.

## 4. Testes (passo 3)

**Unidade** — `test/core/keyboard-map-model.test.js`, 17 testes, **17 passam**:

| Teste novo | O que fixa |
| --- | --- |
| `imagem ou ícone dentro de link ou botão não é item sem caixa` | Foto e ícone com seta dentro de link/botão saem da lista; o que está **solto** (fora de qualquer parada) continua entrando. O link do teste **não** declara a seta de propósito: com ela, a checagem de herança que já existia dispensaria a foto sozinha e o teste não provaria nada. |
| `item com ocorrência de regra continua apontado mesmo dentro de uma parada do Tab` | A dispensa não vale para `keyboard-rule` — o caso verdadeiro do cartão que só abre com o mouse. |
| `fotos dentro de links não enchem o teto e os itens de verdade continuam na lista` | 99 fotos em 99 links + 4 cartões reais: a lista traz exatamente os 4 cartões, sem `suspect-limit-reached` e com `omittedLimit = 0`. É o cenário do teto de 60, determinístico. |

Prova de cobertura: os dois primeiros e o do teto **falham** com a versão anterior do modelo
(15 passam, 2 falham no arquivo; o do teto é o que quebra o limite) e passam com o ajuste.

**Navegador** — `test/e2e/keyboard-map-mv3.test.mjs`, **1 teste, passa** (`stops=10`, `suspects=4`):

- Fixture acrescentada com os dois falsos positivos medidos em página real: duas fotos de catálogo com
  `cursor: pointer` dentro de `<a href>` e um ícone com seta dentro de `<button>`.
- Asserção ao vivo e no artefato: nenhum desses rótulos pode aparecer nos suspeitos, e o link que
  contém a foto precisa continuar **uma vez** entre as paradas do Tab (o nome do link vem do `alt` da
  foto, então o rótulo aparece legitimamente nas paradas — a asserção é sobre `suspects`, não sobre o
  JSON inteiro).
- Os quatro cartões que só abrem com o mouse continuam: cada um aparece **uma vez** na lista, com
  motivo `keyboard-rule` + `hover-only-interactive-content`, e **zero** vezes entre as paradas.

## 5. Medição depois (passo 4)

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/suspeitos-depois \
  --url <portal público> --url <loja on-line A> --url <loja on-line B>
```

| Página | suspeitos antes | suspeitos depois | paradas do Tab (antes → depois) | o que sobrou |
| --- | ---: | ---: | --- | --- |
| portal público | 4 | **4** | 44 → 44 | os 4 cartões de serviço (verdadeiros) |
| loja on-line A | 6 | **0** | 57 → 75 | nada — os 6 eram fotos dentro de links |
| loja on-line B | 0 | **0** | 121 → 121 | nada |

Conferência visual do `09-mapa-teclado.png` de cada página (`qa-out/suspeitos-antes/<site>/` e
`qa-out/suspeitos-depois/<site>/`):

- portal público: nos dois lados o mapa traz as **quatro caixas laranja tracejadas** sobre
  CONSUMIDOR / FORNECEDOR / SERVIDOR / OUVIDORIA, e a contagem da própria seção diz 4. Nada mudou
  para o caso verdadeiro.
- loja on-line A: antes o mapa trazia as seis caixas laranja sobre fotos de produto e a seção dizia
  "6 itens que parecem clicáveis"; depois a seção diz "0 itens que parecem clicáveis" e as caixas
  laranja desapareceram, com as caixas azuis numeradas dos links de produto no lugar.
- loja on-line B: "0 itens que parecem clicáveis" nos dois lados.

Página de teste (fixture local, com `--no-fixture` omitido): 0 suspeitos e a nova foto de catálogo
entre as paradas do Tab — o caso falso da fixture não vira item da lista.

## 6. Limitações

- **A medição é de um estado da página.** Página de portal e de loja muda entre carregamentos (na loja
  on-line A as paradas foram de 57 para 75 entre as duas rodadas). O que a tabela compara é a
  natureza dos suspeitos; os números absolutos não são reproduzíveis byte a byte.
- **O teto de 60 não foi visto em página real.** O cenário está coberto por teste de unidade; se
  aparecer numa página real, a lista já não o alimenta com foto dentro de link, que era o que o
  enchia.
- **Uma foto que tenha clique próprio dentro de um link** (abre modal em vez de seguir o link) sai da
  lista por esta regra. É o preço da dispensa; o caso não apareceu na amostra, e a leitura guiada do
  5.1.13 continua pedindo que a pessoa confira o mapa contra a página.
- **A razão exata pela qual a checagem de herança que já existia não pegou as fotos na loja A não foi
  determinada** (a sonda no DOM vivo achou a seta nos pais, o instantâneo da auditoria não a levou
  para todos os nós). A regra nova não depende disso: ela olha a árvore — o ancestral é parada do Tab
  ou não é — e por isso funciona mesmo quando o estilo não foi coletado para o pai.
- **Nada foi acrescentado aos exemplos de heurística que a medição não mostrou** (§3.1). Ampliar a
  lista de dispensas sem falso positivo medido é o caminho para apagar o achado de verdade.

## 7. Arquivos alterados

| Arquivo | Mudança |
| --- | --- |
| `src/core/keyboard/keyboard-map-model.js` | `insideStop` (descendentes de parada do Tab) e a condição nova em `cursor-pointer`, com o comentário do porquê |
| `test/core/keyboard-map-model.test.js` | 3 testes novos (foto/ícone dentro de parada, ocorrência de regra dentro de parada, teto de 60 com 99 fotos) |
| `test/e2e/fixtures/keyboard-map.html`, `keyboard-map.css` | Fotos de catálogo dentro de `<a href>` e ícone com seta dentro de `<button>` |
| `test/e2e/keyboard-map-mv3.test.mjs` | Asserções dos falsos positivos ao vivo e no artefato |
| `scripts/visual-qa.mjs` | Lista de suspeitos do mapa no `summary.json` e sonda de contexto/ancestralidade na página auditada |

## 8. Rodada completa de testes

`node scripts/run-tests.mjs` (as duas fases), com o Chrome for Testing da casa:

| Fase | Resultado |
| --- | --- |
| Unidade (4511 testes) | 4509 passam, **1 falha** — `test/release-package.test.js`: hash do ZIP, esperado enquanto o fonte muda —, 1 pulado |
| Navegador real (134 testes) | 132 passam, **2 falhas** que **passam quando rodadas sozinhas** |

As duas falhas da fase de navegador não têm relação com este ajuste e são de contenção (vários Chrome
ao mesmo tempo na máquina):

- `test/e2e/personas-mv3-csp.test.mjs` — `PERSONA_READER_NEXT_TIMEOUT`; sozinho: **passa** (1,9 s
  contra 11,2 s na rodada cheia).
- `test/e2e/sidepanel-flow-mv3.test.mjs` — `PAGE_MARKERS_IDLE_BEFORE_SHOW_FAILED` com `eventTotal: 6`
  (7 `resize`, 2 `focus`, 2 `blur` da própria janela do Chrome subindo, `mutationTotal: 0` e nenhuma
  mudança de DOM, URL, título ou rolagem); sozinho: **passa**.

O teste do mapa do teclado passa nas duas fases (`stops=10`, `suspects=4`, os quatro cartões
verdadeiros e nenhum falso positivo da fixture).

## 9. Pendências

- Nada foi commitado: a revisão e o commit são do orquestrador.
