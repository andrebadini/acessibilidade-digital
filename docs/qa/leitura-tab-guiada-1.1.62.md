# Leitura por Tab na verificação guiada — 1.1.62

Data: 16/10/2026. Versão em trabalho: **1.1.62** (branch `wip162/leitura-tab`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão e o `build:release` são o passo de
release). Chrome for Testing 152.0.7977.64, um Chrome por vez.

Por regra do projeto, **nenhum nome de órgão, domínio de governo ou loja é registrado aqui**. Os ensaios
em página real são descritos como **portal público**, **mercado on-line** e **loja on-line**.

O pedido tinha cinco partes:

1. Uma regra do motor que gera **um ponto de revisão humana por parada de Tab**, na ordem do teclado,
   presa ao item normativo da ABNT, com destino (`nodeId`) e evidência de elemento para o recorte,
   respeitando o teto do mapa do teclado e a privacidade.
2. Uma **seção própria** na verificação guiada — *"Leitura por Tab — o que o leitor de tela fala"* — com
   a explicação de uma frase, o andamento, a tabela (recorte com contorno | ordem/elemento | nome e
   função | anúncio estimado com **"Ouvir"** | pergunta), botões **Sim / Não / Não sei**, campo
   "O que deveria dizer?" no "Não", gravação imediata, cor por estado, foco no próximo ponto pendente,
   frases de ajuda, blocos de ~20 linhas com "Mostrar mais", filtro "Só pendentes" e a marcação em bloco
   com confirmação; sem referências cruzadas e sem perguntas duplicadas nos cartões comuns.
3. **Uma constatação só** para todos os "Não", com **um texto** que nomeia todos os pontos
   (incluindo o que deveria ser dito) e a evidência citada **uma vez**.
4. Na página de leitura isolada, a mesma pergunta **sem botões**, com o aviso de onde responder.
5. Textos simples, sem jargão, contraste e navegação por teclado da própria seção.

## 1. Qual item normativo, e por quê 5.13.10

A regra ficou presa ao item **5.13.10 — Componentes com nome acessível** (requisito; WCAG 4.1.2), e não
ao **5.13.12**.

O 5.13.12 trata da ordem/sequência de foco; a pergunta desta seção não é *"a ordem faz sentido?"* e sim
*"o que o leitor de tela anuncia corresponde a este elemento (o que ele é e o que faz)?"* — que é
exatamente o objeto do 5.13.10: o nome acessível e a função do componente. O item 5.13.10 passou a
declarar **duas** regras: a automática `accessible-component-name` (nome acessível ausente) e a nova
`tab-reading-announcement` (o anúncio conferido à mão, parada por parada). A segunda é **sempre
`cantTell`**: um anúncio só é incorreto depois que a pessoa responde "Não" — o motor nunca conclui
sozinho. A ordem de Tab entra como **contexto** (a sequência é o eixo da seção, e o mapa do teclado já
responde pelo 5.13.12).

## 2. Como a seção funciona

### 2.1 Uma parada de Tab, um ponto

`src/core/rules/tab-reading.js` cria um alvo por parada de
`selectKeyboardMapStops(snapshot, {})`, na ordem em que o teclado percorre a página, com o mesmo teto de
paradas do mapa do teclado (a regra não inventa uma segunda medição nem um laço novo de CDP). Cada alvo
leva o `nodeId` do elemento e a evidência de elemento já capturada — é dela que sai o recorte com
contorno na linha. Nome do elemento respeita a política de privacidade das capturas já existente.

### 2.2 A seção na verificação guiada

`src/review/review.js` monta `#lay-tab-reading` (título, explicação de uma frase, `N de M conferidos`,
barra de progresso, filtro "Só pendentes", tabela de cinco colunas, botão de marcação em bloco e
"Mostrar mais"). Cada linha traz:

- o **recorte** do elemento com contorno vermelho (clique amplia, como nos cartões de pergunta);
- a ordem e o seletor (`Tab 3 · botão`, `button#buscar`);
- o nome e a função (`“Buscar”` / `Sem nome acessível`; `botão “Buscar”`);
- o **anúncio estimado** em texto e o botão **"Ouvir"**;
- a pergunta e os três botões, com rótulo acessível que nomeia o elemento
  (*"Sim — Tab 3, botão Buscar"*).

A resposta grava **na hora**, pelo mesmo serviço da revisão humana; a linha ganha cor (verde/vermelho/
âmbar), o foco vai para o **próximo ponto pendente** e frases de ajuda dizem o que aconteceu. Em tela
estreita a tabela vira blocos com o nome da coluna à frente de cada célula.

### 2.3 Sem pergunta duplicada

`buildLayReviewPlan` (`src/core/report/lay-review.js`) **exclui** as ocorrências desta regra dos cartões
comuns. Sem isso, a mesma parada de Tab seria perguntada duas vezes: uma no cartão, outra na seção — e o
cartão, sozinho, não mostra a sequência nem o anúncio estimado ao lado.

### 2.4 Uma constatação só (exceção deliberada)

As respostas "Não" viram **uma única constatação** do item 5.13.10, com **um texto** que nomeia todos os
pontos — `tabReadingEntryFinding` em `src/core/report/findings-board.js`, usando `consolidatedCitation-
Paragraph` para a citação. É uma **exceção documentada** à regra de 1.1.61 (uma citação por elemento):
aqui a pergunta é literalmente a mesma em cada parada de Tab, e repetir o mesmo item da norma a cada
parada inflaria o quadro sem informar nada. A exceção vale **só para este tema**: as constatações dos
outros motores para o mesmo item (por exemplo, o controle sem nome detectado automaticamente) continuam
sendo constatações próprias, e a decisão de impacto da regra é `critical`.

### 2.5 A página de leitura isolada

`src/reader/reader.js` e `src/reader/report-model.js` trocaram a frase "Confira se o anúncio representa o
elemento." pela **mesma pergunta** da seção guiada, **sem botões**, mais o aviso *"Para registrar as
respostas no relatório, use a seção 'Leitura por Tab' da verificação guiada."* — **uma vez por tabela**,
não em cada linha (repetir a mesma frase 40 vezes atrapalharia quem lê a lista com leitor de tela).

## 3. Testes

Unidade e integração (fase paralela de `node scripts/run-tests.mjs`): **4760 testes, 4758 passam, 1 falha,
1 pulado**. A única falha é `test/release-package.test.js` — o hash do ZIP muda porque o fonte mudou; é a
falha esperada enquanto o pacote não é reconstruído (o release recalcula).

Novos, deste tema:

| Arquivo | Cobre |
| --- | --- |
| `test/rules/tab-reading.test.js` | uma ocorrência por parada de Tab, sempre `cantTell`, `nodeId` e evidência, teto de paradas, privacidade |
| `test/report/tab-reading-plan.test.js` | o plano das linhas (ordem, nome, anúncio, recorte), o progresso e a janela de blocos |
| `test/review/tab-reading-section.test.js` | a seção na verificação guiada: linhas, botões, rótulos acessíveis, filtro, marcação em bloco, foco seguinte |
| `test/review/tab-reading-report.test.js` | a seção e a **constatação única** no HTML entregue, e a auditoria antiga sem elas |
| `test/e2e/tab-reading-guided-mv3.test.mjs` | a jornada real no Chrome: auditoria, seção, quatro respostas, exportação e o texto único no HTML entregue |
| `test/e2e/tab-reading-mv3.test.mjs` (ampliado) | a página de leitura isolada: pergunta sem botões e aviso de onde responder |

Ponta a ponta em Chrome real (reexecutados depois das mudanças de folha de estilo):
`test/e2e/tab-reading-guided-mv3.test.mjs` (1 de 1, 5,4 s) e `test/e2e/tab-reading-mv3.test.mjs`
(3 de 3, 15,7 s). O novo arquivo foi registrado em `REAL_CHROME_E2E` (`scripts/run-tests.mjs`); sem o
registro, o plano de testes recusa a execução inteira com `TEST_PLAN_UNCLASSIFIED_E2E`.

`AUDITA_VERIFY_SKIP_TESTS=1 node scripts/verify-project.mjs` fecha GREEN com **132/146 (96/50)** —
inventário, identidade neutra, HTML/JSON/PDF, fixtures e privacidade. Sem a variável, o script falha
apenas no passo que roda `npm test`, pela mesma falha de hash do ZIP registrada abaixo.

### 3.1 Expectativas de teste que mudaram, e por quê

| Mudança | Motivo |
| --- | --- |
| `131` → `132` (`METHODOLOGY.ruleCount`, `EXPECTED_RULE_COUNT`, `aggregate-audits.js`, `verify-project.mjs`, `fixtures/audits/sample-audit.js` e os testes que conferem contagem) | entrou uma regra nova no inventário fechado. Auditorias gravadas antes continuam abrindo: `PREVIOUS_CORE_RULE_IDS` (o inventário de 1.1.61, sem a regra nova) foi acrescentado aos inventários aceitos, ao lado do legado |
| `test/review/report-view.test.js` — lista de chaves | a lista de chaves do modelo passou a incluir a leitura por Tab |
| `REPORT_CSS_CSP_HASH` | duas folhas de estilo novas no relatório: a marca `evidence-highlight--target` (contorno do recorte) e, agora, a largura fixa das cinco colunas da tabela. Sem o hash novo o navegador bloquearia o `<style>` embutido e o relatório sairia **sem estilo, em silêncio** |
| `evidence-highlight--target` (CSS novo) | o contorno do recorte na pergunta |
| guarda `cantTell` em `remediation-policy.js` | o alvo da leitura por Tab pede conferência; um `failed` ali seria afirmação do motor sobre algo que só a pessoa pode ouvir |
| ponto final no texto da constatação | o texto único termina com a frase do que deveria ser dito, que já termina em ponto; a concatenação sem ponto colava as frases |
| `EVIDENCE_CROP_PAGE_ORIGIN_ARIA` / `EVIDENCE_CROP_ELEMENT_ORIGIN_ARIA` (novas constantes em `evidence-crop.js`) | a página de conferência e o HTML entregue mostram a MESMA imagem e passaram a dizer a mesma frase no texto alternativo; duas cópias divergiriam |
| `metadata.highlightBox` no fixture de teste (`test/report/helpers.js`) | o recorte com contorno precisa da caixa do destaque no fixture |
| `test/review/tab-reading-report.test.js` — "sem nenhuma resposta a seção não aparece" | a asserção procurava a string `data-report-tab-reading` no documento inteiro; a folha de estilo agora traz o seletor `[data-report-tab-reading]` em **toda** auditoria, então a asserção passou a procurar a **seção** (`<section data-report-tab-reading>`). O que o teste quer garantir não mudou: sem resposta, não há seção |

### 3.2 Falhas conhecidas, não causadas por este trabalho

- `test/release-package.test.js`: hash do ZIP (o pacote só é reconstruído no release). Esperada.
- 5 falhas de `test/e2e/sidepanel-flow-mv3.test.mjs` no ambiente desta máquina: idênticas na revisão-base
  `a1fbee5`, já registradas em `docs/qa/cartao-recorte-hash-1.1.62.md` §7.2.

## 4. Ensaio em página real

Roteiro: `scripts/visual-qa.mjs`, que passou a ter o passo da leitura por Tab.

- **(l) na verificação guiada** — `captureTabReading`: lê o estado da seção (andamento, colunas, recorte
  e contorno das primeiras linhas, rótulos acessíveis dos botões), recorta a seção (início), **registra
  uma resposta "Não" de verdade** na primeira linha pendente, recorta a linha respondida e, se houver,
  abre o bloco seguinte e recorta a seção outra vez.
- **no arquivo entregue** — `captureTabReadingArtifact`: abre o HTML exportado, mede a seção da leitura
  por Tab (respostas, recortes com contorno, texto único, citações dentro da seção), recorta a seção, o
  parágrafo da constatação e a mesma seção em **meio de impressão na largura de A4**.

A resposta registrada pelo roteiro é o gesto que a pessoa faria: sem ela, a linha não ganha estado e a
constatação única não nasce no arquivo entregue — não haveria o que conferir.

### 4.1 Defeito de enquadramento encontrado pelo roteiro (e corrigido)

As primeiras capturas saíram com o **título da seção cortado ao meio** e, na linha respondida, com a
primeira faixa ("Tab 1 · link" e o topo do recorte) escondida. Não era a seção: a barra de estado do
relatório fica **colada no topo** da página e cobre a primeira faixa do elemento que se recorta.
`captureElementClip` ganhou a opção `topOffset` (padrão 12 px, o de sempre) e a seção da leitura por Tab
usa 84 px — a altura da barra mais a folga.

### 4.2 Defeito de leitura no arquivo entregue (e corrigido)

No HTML entregue, a tabela da seção não declarava largura de coluna. O navegador entregava quase toda a
largura à coluna da imagem e os títulos das outras quatro quebravam **no meio da palavra**
("Ordem / elemen|to", "Anúnci|o estima|do") — no arquivo que a pessoa assina. `report.css.js` passou a
fixar a divisão das cinco colunas (30% / 14% / 14% / 13% / 29%), que cabe igual na tela e na folha A4.

### 4.3 Resultado na fixture local

Seção com **37 pontos** de Tab (20 no primeiro bloco), 5 colunas, recorte com contorno nas 3 linhas
medidas, resposta registrada ("1 de 37 conferidos"), foco no próximo ponto pendente, "Mostrar mais"
abrindo o bloco seguinte (20 → 37 linhas, 17 escondidas). No arquivo entregue: 1 seção, 1 resposta
(`não conforme`), 1 recorte com contorno, 1 constatação única e **0 citações normativas dentro da seção**
(a fundamentação fica no quadro de constatações, como decidido).

Capturas abertas e conferidas: `14-leitura-tab-inicio.png`, `15-leitura-tab-resposta-nao.png`,
`16-leitura-tab-bloco-seguinte.png`, `17-leitura-tab-no-arquivo.png`,
`18-leitura-tab-constatacao-unica.png`, `19-leitura-tab-impressao.png`.

### 4.4 Páginas reais

Roteiro: `node scripts/visual-qa.mjs --no-fixture --out qa-out/leitura-tab-guiada-real --url …`, um Chrome
por vez, três páginas reais (portal público, mercado on-line e loja on-line). **As três abriram, foram
auditadas e exportaram os quatro arquivos** — nenhuma bloqueada ou indisponível.

| Página | Pontos de Tab | Bloco (escondidos) | Resposta do roteiro | No arquivo entregue |
| --- | --- | --- | --- | --- |
| portal público | 53 | 20 (33) | "1 de 53 conferidos", foco no próximo pendente | 1 seção, 1 resposta, 1 recorte com contorno, 1 constatação, 0 citações dentro da seção |
| mercado on-line | 121 | 20 (101) | "1 de 121 conferidos" | idem |
| loja on-line | 98 | 20 (78) | "1 de 98 conferidos" | idem |

Nas três, a seção apareceu com as cinco colunas, o recorte com contorno sobre o elemento da pergunta e
o anúncio estimado; em todas, a primeira parada da sequência é um link de "pular para o conteúdo", cujo
anúncio — no portal e na loja — repete a instrução de navegação do site inteira ("…, link, Para se mover
entre os produtos, use as setas…"), que é exatamente o tipo de descompasso que a seção existe para
mostrar. O botão "Mostrar mais" abriu o bloco seguinte nas três (20 → 40 linhas).

**Antes/depois do roteiro** (as três páginas reais foram medidas com o roteiro já corrigido; o "antes" é
o primeiro ensaio, na fixture):

| | Antes (1º ensaio) | Depois |
| --- | --- | --- |
| Seção na verificação guiada | título da seção cortado ao meio pela barra de estado fixa; na linha respondida, a primeira faixa ("Tab 1 · link" e o topo do recorte) escondida | seção inteira, título e barra de estado legíveis (opção `topOffset` = 84 px) |
| Tabela no HTML/PDF entregue | títulos quebrando no meio da palavra ("Ordem / elemen|to") | cinco colunas com largura fixa; cabeçalhos legíveis na tela e na folha A4 |

Capturas abertas e conferidas nas três páginas: `14-leitura-tab-inicio.png`,
`15-leitura-tab-resposta-nao.png`, `16-leitura-tab-bloco-seguinte.png`,
`17-leitura-tab-no-arquivo.png`, `18-leitura-tab-constatacao-unica.png` e
`19-leitura-tab-impressao.png` (esta última em meio de impressão, na largura de A4).

## 5. Limitações

- O **anúncio estimado** é a melhor aproximação que a extensão pode fazer sem um leitor de tela de
  verdade (nome acessível + papel + estado, na ordem em que o NVDA/JAWS costuma falar). Ele **não
  substitui** ouvir: por isso a regra é sempre `cantTell` e a pergunta é da pessoa.
- A seção depende do **mapa do teclado** já existente: se a página não tem paradas mapeadas, não há
  seção (e nada é afirmado no lugar dela).
- Só as paradas dentro do **teto do mapa do teclado** viram pontos: uma página com centenas de paradas
  não é percorrida inteira.
- A "Não" de uma parada **não** é conclusão automática do motor em nenhum outro lugar do relatório: sem
  resposta humana, o item continua inconclusivo.
- O roteiro de QA registra **uma** resposta por página auditada (a primeira linha pendente). As demais
  linhas são conferidas em teste de unidade e no teste de ponta a ponta, que respondem quatro pontos
  com os quatro caminhos (botão, teclado, campo de texto e "Não sei").
- O `visual-qa.mjs` grava a captura da seção **até 1 600 px de altura**: numa página com muitas linhas a
  imagem mostra o começo do bloco, não as 20 linhas inteiras.
