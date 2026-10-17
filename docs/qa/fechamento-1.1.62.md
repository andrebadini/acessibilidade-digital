# Fechamento da versão 1.1.62 — polimento, conferência e o que a versão entrega

Data: 16/10/2026. Versão em trabalho: **1.1.62** (worktree `w162-polimento`, **sem commit**; o orquestrador
revisa e commita). Chrome for Testing 152.0.7977.64, Node 26.5.0, macOS (Apple Silicon), **um Chrome por vez**.

Por regra do projeto, **nenhum nome de órgão, domínio de governo ou loja é registrado aqui**. As páginas reais
são descritas como **portal público**, **mercado on-line** e **loja on-line**.

Esta tarefa teve quatro partes: (1) polir a seção "Leitura por Tab" da verificação guiada, (2) revisar a jornada
inteira como quem não é especialista — abrindo as imagens e corrigindo defeitos pequenos —, (3) apurar a falha
do teste de ponta a ponta do painel, e (4) fechar a versão. O que segue é o registro de cada uma.

---

## 1. Leitura por Tab na verificação guiada — as quatro correções pedidas

### 1.1 A caixa da resposta seguia o clique, não a resposta

**O defeito.** A resposta registrada aparecia numa caixa **verde** mesmo quando a pessoa tinha respondido
"Não"; o texto era o rótulo jurídico do quadro de constatações ("Não conforme (não atende ao item)"), que
obriga quem respondeu a traduzir o próprio clique para saber o que ficou gravado.

**A correção.** A caixa passou a seguir a resposta, pela cor e pela frase, com o texto de quem respondeu:

| resposta | frase | cor da caixa |
|---|---|---|
| Sim | "Sua resposta: Sim — corresponde." | verde discreto |
| Não | "Sua resposta: Não — o que o leitor de tela fala não corresponde a este elemento." | vermelho discreto |
| Não sei | "Sua resposta: Não sei." | cinza |

Quem respondeu e quando vêm **abaixo**, em letra menor, porque são registro e não resposta.

**Onde.** `src/core/report/tab-reading-text.js` ganhou `TAB_READING_ANSWER_TEXT` — a frase mora no módulo que
as duas superfícies já compartilham, para a caixa da verificação e a linha do arquivo entregue nunca
divergirem. Em `src/review/review.js`, o quadro passou a usar `data-lay-answer` (a **mesma** chave dos cartões
comuns da revisão; antes era um atributo próprio, e por isso o CSS não colorava nada), e a assinatura virou uma
linha separada (`lay-answered-meta`). `src/review/review.css` ganhou a cor do "Não sei" e o tipo menor da
assinatura. `src/core/report/html.js` deixou de escrever `Resposta:` + rótulo técnico e passou a imprimir a
mesma frase.

**Prova.** Capturas `15-leitura-tab-resposta-nao.png` (fixture) e `17-leitura-tab-no-arquivo.png` (portal
público): a caixa está vermelha, com a frase inteira e a assinatura em letra menor. No arquivo entregue,
`test/review/tab-reading-report.test.js` fixa as três frases e proíbe o rótulo técnico dentro da seção
(o rótulo continua valendo nas fichas de revisão humana, que é outro lugar do relatório).

### 1.2 A legenda da imagem não cabia na coluna estreita

**O defeito.** A legenda completa (contorno + contexto + origem do recorte) empurrava a imagem para fora da
coluna da esquerda.

**A correção.** Na seção Leitura por Tab a legenda é curta: **"Contorno vermelho: este elemento."** e, abaixo,
**"Clique para ampliar."**. A explicação longa continua onde há espaço: no recorte ampliado, no cartão da
verificação guiada, no HTML entregue e no PDF. O caso em que a imagem **não** tem contorno continua com a
legenda própria (`EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND`), porque a frase curta diria que o elemento está
contornado quando não está.

**Onde.** `cropBlock(media, card, { shortLegend: true })` em `src/review/review.js`; a chamada é só da célula
de imagem da leitura por Tab.

### 1.3 O seletor CSS aparecia em evidência

**O defeito.** A coluna "Ordem / elemento" mostrava `html > body > main > section:nth-of-type(12) > div > ul >
li:nth-of-type(1)` — jargão em cima do que a pessoa precisa ler.

**A correção.** Em evidência fica **"Tab 3 · botão"** (ordem e tipo do elemento, em palavras); o seletor vai
para dentro de um **"Detalhe técnico"** fechado, na mesma célula. O CSS também deixou de partir palavras ao
meio ("Ordem / elemen/to", "Detalh/e técnic/o"): a quebra em qualquer ponto passou a valer só para o seletor,
que é o único texto que pode quebrar.

### 1.4 O documento da tarefa estava errado sobre o item normativo

`docs/qa/leitura-tab-guiada-1.1.62.md` afirmava que o **5.13.12** tratava da ordem de foco. No catálogo
(`src/core/normative/nbr17225.js`) o 5.13.12 é **"Semântica de componentes customizados"**. O documento foi
corrigido e a justificativa do 5.13.10 ficou explícita: a ordem de Tab entra como **contexto** — quem trata da
ordem é o **5.1.4 — Ordem de foco previsível** (WCAG 2.4.3) e quem sustenta o mapa do teclado é o **5.1.13 —
Acessibilidade por teclado parcial** (WCAG 2.1.1), nenhum dos dois afirmado ou alterado por esta regra.

---

## 2. Revisão leiga da jornada inteira (painel → verificação guiada → relatório → HTML e PDF)

Foram abertas **todas** as capturas das quatro páginas: a página de teste do projeto (com o carrossel, os
formulários, a tabela e os anúncios) e as três páginas reais. O percurso conferido é o de quem não é
especialista: painel → verificação guiada (cartão com recorte; Leitura por Tab) → "Abrir relatório completo"
(constatações, fichas de evidência, mapa de leitura, mapa do teclado) → HTML exportado e PDF.

### 2.1 Defeito corrigido nesta tarefa

**O anexo apontava para a seção pelo nome antigo.** O item do mapa no "Anexo de evidências" dizia *"As imagens
deste mapa estão na seção **Anúncios**, com o SHA-256 de cada trecho."* — mas a seção se chama **"Mapa de
leitura da página"** desde a tarefa do mapa de leitura, e o próprio rótulo do índice já dizia "Mapa de
leitura". O termo antigo sobreviveu em um lugar só (`src/core/report/html.js`), e a leitura ficava inconsistente
para quem abrisse o anexo: a pessoa procurava uma seção "Anúncios" que não existe mais.

- **Correção:** o link passou a dizer **"Mapa de leitura da página"**. O destino (`#report-section-5`) já estava
  certo — o que estava errado era o nome escrito.
- **Prova:** captura `12-anexo-impresso.png` do portal público, no anexo impresso, mostra o texto corrigido; a
  captura equivalente da página de teste, feita **antes** da correção, mostra o texto antigo.
- Nenhum teste fixava a frase antiga; nenhum texto de teste mudou por causa disso.

### 2.2 Conferido e **não** é defeito

- **O anel âmbar em volta do recorte** na primeira linha da Leitura por Tab é o **anel de foco** do botão de
  ampliar (`outline` de `:focus-visible`), não um contorno de elemento: ele desaparece assim que a linha é
  respondida — confirmado comparando `14-leitura-tab-inicio.png` com `15-leitura-tab-resposta-nao.png`.
- **A etiqueta do sinal ("4 × (4)")** é o número do sinal, o símbolo da classificação (× falha, ? suspeita) e,
  entre parênteses, quantas ocorrências o sinal reúne — a leitura por extenso está no `aria-label`
  ("Sinal 4: falha registrada na auditoria, 4 ocorrências. Abrir no painel.").
- **"0 elementos elegíveis sem caixa"**, "sem sobreposições não resolvidas" e as folgas medidas pelo próprio
  roteiro de QA seguem batendo nas quatro páginas.

### 2.3 Registrado, sem mudança — e por quê

**a) O código do mapa de leitura pode cobrir a primeira letra do próprio elemento.** Nas páginas reais — e de
forma visível na coluna da esquerda do portal público — a etiqueta do código (`L46`, `L62`…) fica **sobre** o
começo do texto do elemento que ela identifica: "**L46**erviços…", "**L13**bras do BRT…". Nas páginas densas
(listas de notícias, grades) o mesmo acontece em várias linhas seguidas.

- **Medido:** na página de teste as reproduções são as mesmas que a tarefa do mapa de leitura já media
  (1.1.62, 123 caixas, folga média 1 px, maior folga 4,5 px, zero etiquetas sobrepostas); o roteiro de QA mede
  "códigos encostados" e "etiquetas sobrepostas", e nenhuma das duas medidas vê o texto por baixo.
- **Causa:** a posição da etiqueta é escolhida por custo (`src/core/evidence/annotation-marker-layout.js`):
  encostar na própria caixa custa **3**, cobrir a caixa de outro elemento custa **1** e colidir com outra
  etiqueta custa **100**. Numa coluna apertada, quando todos os lugares encostados já estão tomados, **cobrir o
  próprio elemento é a opção mais barata** — e é exatamente o que a tarefa anterior ajustou para o código não
  fugir do alvo (a alternativa seria o anel, dezenas de px de distância).
- **Por que não foi mudado nesta tarefa:** a posição calculada **entra no hash do artefato**
  (`hashAnnotationMapGeometry`, versão **1.3.0**). Mudar a regra de posicionamento é mudar um artefato de
  esquema fechado: exige **versão nova do algoritmo** e leitura das versões anteriores (1.0.0, 1.2.0, 1.3.0),
  que é uma tarefa própria — não um polimento, e não caberia nesta janela sem re-verificar as quatro páginas e
  as auditorias guardadas. **Recomendação para a próxima versão:** artefato 1.4.0 com uma regra que prefira
  qualquer posição encostada que **não** cubra o próprio elemento (mesmo que mais distante), declarando a
  limitação quando não houver nenhuma.
- **Não é regressão desta versão:** o mapa com códigos nasceu na própria 1.1.62 (tarefa do mapa de leitura).

**b) "Ir ao elemento do sinal N" não faz nada quando a própria página esconde o alvo.** Na página de teste, o
sinal 78 aponta para uma imagem que vive dentro de um carrossel: a cada 2 s o carrossel esconde um slide
(`display: none`) e mostra outro. Se o clique cair no instante em que aquele slide está inativo, o elemento
**não tem caixa**, o navegador não tem como rolar até ele e a extensão não desenha contorno de caixa que não
existe — o clique é aceito, nada se move e o painel **não diz nem explica** o que houve. A pessoa só vê que
"não aconteceu nada".

- **Como foi apurado:** o roteiro de QA ganhou um diagnóstico (estado do painel, região viva, detalhe aberto,
  rolagem antes e depois do clique, e uma varredura do documento inteiro procurando onde o alvo chega a ser
  desenhado) e uma instrumentação temporária no worker provou que a ordem **chega e é aceita**
  (`select-called … response {ok:true}`). A conclusão é do produto, não do teste: o alvo existe, o produto
  aceita o gesto, e o navegador não rola até uma caixa inexistente.
- **O que o roteiro passou a fazer:** insistir no **mesmo** gesto, na **mesma** ocorrência, até a página poder
  mostrar o alvo — como uma pessoa faria —, registrando quantos gestos foram precisos (teto
  `GO_TO_GESTURE_LIMIT = 12`). A exigência **não** mudou: se o anel não aparecer em nenhuma tentativa, o passo
  falha como antes.
- **Resultado:** sinal 78 passou a exigir **2 gestos**; os sinais 51 e 52 (imagens estáticas) exigem 1. Sem
  retentativa o passo falhava em toda execução da página de teste; com ela, a jornada inteira fecha.
- **Recomendação (produto):** quando o alvo de "Ir ao elemento" não tem caixa no instante do clique, o painel
  deveria dizer isso em palavras ("este elemento está escondido pela página neste momento") em vez de aceitar
  o gesto em silêncio. Ficou **registrado**, não corrigido: é mudança de comportamento do painel, fora do
  escopo de polimento desta tarefa.

### 2.4 O roteiro de QA

`scripts/visual-qa.mjs` ganhou o diagnóstico descrito acima (`diagnoseSelection`, `watchScroll`), o teto de
gestos e a linha de resumo que imprime, para cada sinal sem anel, o estado do painel, a rolagem antes e depois
do clique e em que posição do documento o alvo chega a ser desenhado. Nada foi afrouxado: as mesmas garantias
continuam sendo exigidas, e as novas informações só explicam a falha quando ela acontece.

### 2.5 O que o roteiro mediu nas quatro páginas

A jornada completa (painel → verificação guiada → relatório aberto pelo painel → HTML e PDF exportados) rodou
sem erro nas quatro páginas: `qa-out/fechamento-fixture7` (página de teste, com carrossel, formulários, tabela
e anúncios) e `qa-out/fechamento-reais1` (portal público, mercado on-line e loja on-line). "Todas as páginas
concluíram a auditoria e geraram as capturas", saída 0, zero erros de console.

| medida do roteiro | página de teste | portal público | mercado on-line | loja on-line |
|---|---|---|---|---|
| anéis colados ao elemento | — | **8 de 8** | **19 de 19** | **8 de 17** |
| etiquetas sobre texto de **outro** elemento | 0 | 0 | 0 | **4** |
| caixas do mapa de leitura na medida do elemento | — | 115 de 115 | 200 de 200 | 200 de 200 |
| elementos elegíveis **sem caixa** | — | 41 | 188 | 190 |
| elementos recortados na borda da imagem | — | 0 | 25 | **270** |
| códigos do mapa encostados (folga ≤ 4 px) | 123 de 123 | 110 de 115 | 189 de 200 | 195 de 200 |

O que estes números dizem, e o que **não** dizem:

- **A loja on-line é a página que muda embaixo da auditoria.** É a única com anéis sem correspondência
  (8 de 17), etiquetas sobre o texto de outro elemento (4) e 270 recortes encostando na borda da imagem. As
  três seleções foram conferidas em imagem (`04-selecionado-1.png`, `-2.png` e `-3.png`): nas três o contorno
  aparece **colado** no elemento no instante da seleção — em `-3.png` o contorno envolve o texto
  "Compra e ganhe…" com a seta apontando para ele. A leitura, então, é de **geometria envelhecida**: o roteiro
  mede o anel contra a página *no fim da execução*, e essa página recarrega vitrines, imagens e carrosséis
  depois que as marcas foram desenhadas. É a mesma limitação que o produto já declara no relatório ("páginas
  dinâmicas podem mudar depois da observação"), e o portal e o mercado, que não se mexem, medem 100%.
- **As quatro etiquetas sobre texto da loja são a mesma coisa que a §2.3a registra**: na página de teste, no
  portal e no mercado o roteiro não encontra **nenhuma**; na loja, os sinais 15, 16, 20 e 76 pousam sobre o
  começo do título de um cartão de produto ("Bundle Nintendo Switch OLED", "Smartphone Moto g35",
  "Salgadinho Batata Frita…", "Música") — a mesma causa (custo de encostar na própria caixa) e a mesma
  recomendação: artefato novo com regra que prefira posição livre, não um ajuste nesta janela.
- **"Elementos elegíveis sem caixa" não é falha**: são os itens que a própria página mantém sem caixa
  (`display:none`, fora do fluxo, ainda não renderizados) nos 513 lidos pela ordem de leitura; o mapa desenha
  os 200 primeiros que têm caixa, e diz quantos ficaram nas tabelas ao lado. Também não é falha o recorte
  encostar na borda quando o elemento é de largura total — o que o roteiro sinaliza ali é o quanto o recorte
  depende de a página ter mantido a mesma largura entre a captura e a medição.

Nada disso foi convertido em mudança de código: são medições do **roteiro**, com interpretação, e o critério
foi o de sempre — só corrigir o que se prova defeito. O que se prova defeito está na §2.1.

---

## 3. Testes

### 3.1 Unitários

`node scripts/run-tests.mjs` — resultado em §3.5.

### 3.2 Fechamento da versão

- `manifest.json` → `1.1.62` (versão e nome).
- `README.md`: entrada da 1.1.62 no histórico, no estilo das anteriores.
- `docs/releases/1.1.62.md`: notas da versão.
- `store-assets/`: título de `STORE-LISTING.md`, `TEST-INSTRUCTIONS.md` e `PUBLICACAO-LOJA.md` para 1.1.62;
  o conteúdo de distribuição ganhou três itens sobre o que esta versão entrega.
- `test/extension-shell.test.js`: versão esperada 1.1.62.
- `test/release-package.test.js`: nome do pacote e digest do artefato entregue.
- `npm run build:release` → `release/audita-acessibilidade-1.1.62.zip`, **245 arquivos**, SHA-256
  `4c4dcc15…f202` (o pacote foi reconstruído depois da correção da §3.4a, que acrescenta um arquivo a `src/`).

### 3.3 Conferências de projeto

- `node scripts/verify-project.mjs` — verificações próprias **GREEN**; termina com saída 1 apenas porque o
  script exige `npm test` com saída 0 e a suíte carrega as duas falhas antigas de `hover-script-menu-mv3`
  (§3.4e, §3.5). Detalhe na §3.5.
- `node scripts/verify-neutral-identity.mjs` — sem saída e saída 0 (nenhum nome de órgão, domínio de governo
  ou loja em arquivo versionado).

### 3.4 Ponta a ponta, um arquivo por vez

Cada arquivo rodou **sozinho**, com `AUDITA_E2E_CHROME` apontando para o Chrome for Testing 152.0.7977.64 e
nenhum outro Chrome aberto. Resultados na §3.5. Dois arquivos precisaram de correção, e as duas correções
estão explicadas aqui.

**a) `tab-reading-guided-mv3` — defeito do produto, corrigido.** O teste exige que a captura entre **uma vez**
no documento (`definitions === 1`) e falhou com 2. A investigação (impressão temporária dos dois nós, depois
removida) mostrou o mesmo PNG — 30 846 bytes, mesmo começo e mesmo fim — guardado **duas vezes**: uma na raiz
do relatório (`report-view.js`) e outra no corpo da página (`review.js`). As duas superfícies desenham no mesmo
documento e cada uma tinha o seu próprio registro de imagens; a promessa do código ("cada PNG entra uma vez") e
o teste que a protege estavam certos, e o produto é que estava duplicando os pixels — exatamente o que o
comentário do módulo diz evitar numa auditoria com centenas de elementos.

- **Correção:** o registro passou a ser **um por documento** (`src/review/crop-image-registry.js`, novo), usado
  pela verificação guiada e pelo relatório. Quem desenha primeiro cria e pendura o nó; quem desenha depois
  aproveita o mesmo nó — e se a raiz do relatório for trocada numa nova renderização, o nó volta para o
  documento em vez de ficar preso numa raiz descartada.
- **Nenhuma expectativa de teste foi afrouxada:** a asserção que flagrou o defeito continua idêntica. O que
  mudou nos testes foi só o sandbox de dois arquivos de unidade (`review-card-crop.test.js` e
  `tab-reading-section.test.js`), que fatiam o `review.js` e agora recebem também o módulo novo — como já
  recebiam os outros que o módulo importa.
- **Prova:** `tab-reading-guided-mv3` passa (1 de 1) e os 568 testes de `test/review` + `test/report` seguem
  verdes.

**b) `sidepanel-flow-mv3` — cinco falhas da 1.1.61, todas a mesma, e nenhuma delas era defeito novo.** O log
da execução de 1.1.61 (`/tmp/e2e-sidepanel.log`) mostra as cinco falhas com **uma única** asserção:
"a geometria final tem de ser idêntica à inicial", com `clientWidth` 879 antes e 894 depois — os 15 px da barra
de rolagem que a captura remove e que a página não recebia de volta. Essa asserção continua **palavra por
palavra** no arquivo e passa hoje (9 de 9) com o trabalho de captura da 1.1.62 já fundido; nada foi relaxado
para ela.

- A única expectativa atualizada no arquivo é a da imagem do elemento, e ela mudou porque o comportamento
  mudou **de propósito** na 1.1.62: o elemento que está dentro da captura integral não gera mais PNG próprio.
  Antes: `{ minimumFullPage: 1, minimumElements: 1 }`. Agora: `{ minimumFullPage: 1, minimumElements: 0,
  minimumCroppedElements: 1 }` — e o novo contador só aceita o elemento cujo `fullPageEvidenceId` aponta para
  um artefato que **existe e tem PNG guardado**. A garantia é a mesma de antes ("toda ocorrência com elemento
  tem imagem desenhável"); o que mudou foi de onde os pixels vêm.

**c) `public-axe-map-mv3` — expectativa desatualizada, da mesma família.** O teste exigia `dataUrl` de PNG no
artefato de **elemento** e pelo menos um raster de elemento na auditoria completa. Com a 1.1.62, na evidência
completa o único raster guardado é a captura integral (medido na execução: `withDataUrl = ["full-page"]`). As
asserções passaram a exigir, no lugar: o artefato do elemento tem `fullPageRect`; o `fullPageEvidenceId` dele é
o da captura integral da mesma auditoria; o elemento **não** guarda PNG próprio; a captura integral apontada
tem PNG; e nenhum raster de elemento é guardado quando os pixels dele já estão na integral. A captura por
elemento continua coberta no modo "Somente elementos" (`current-page-pixel-direct-retire-mv3`).

**d) Duas expectativas da mesma família, encontradas na suíte completa.** `batch-pixel-consent-mv3`
(`P5B_PAGE_1_ELEMENT_EVIDENCE_MISSING`) e `url-pixel-consent-mv3` (`{"fullPage":1,"elements":0}`) exigiam, na
evidência **completa**, um PNG por elemento. Pela mesma razão da alínea c, a exigência passou a ser o recorte
da captura integral apontando para uma captura que existe e tem PNG guardado (`elementsCropped`), com o
diagnóstico impresso junto da falha para quem for investigar. As duas passaram a rodar verdes sozinhas
(`url-pixel-consent-mv3`: 8 de 8; `batch-pixel-consent-mv3`: 1 de 1). No modo "Somente elementos" a exigência
de PNG por elemento continua onde sempre esteve.

**e) `hover-script-menu-mv3` — falha antiga, reproduzida no commit-base, fora do escopo desta tarefa.** Este
arquivo **não** está na lista desta tarefa, e falha nos dois testes com "a sondagem não pode disparar evento de
ponteiro na página atual" (1 em vez de 0). Para não confundir causa, o mesmo arquivo foi rodado num worktree
descartável no commit-base `83d024e` (antes de qualquer mudança desta tarefa): falha **igual**. Instrumentando
o contador num worktree descartável (nunca na árvore entregue), o evento único é
`mouseover trusted=true target=HTML at=155,370 related=null` **19 ms depois de a página carregar** — o ponteiro
físico entrando na janela quando ela abre, e não a sondagem do produto. Fica **registrado como pendência**
(§5, item 6): o ajuste é do arquivo, e a correção certa é comparar antes/depois em vez de exigir zero absoluto.
Não foi tocado aqui.

### 3.5 Resultado dos comandos

**Suíte unitária completa** — `node scripts/run-tests.mjs` (fase paralela, sem Chrome):

```
ℹ tests 4786   ℹ pass 4785   ℹ fail 0   ℹ skipped 1   ℹ duration_ms 70,9 s
```

O único `skip` é o já conhecido e documentado da suíte; nenhuma falha. Inclui
`test/release-package.test.js` **verde**, com as duas provas que interessam ao fechamento:
`builds the public ZIP reproducibly in an isolated temporary directory` e
`every packaged byte is the byte in the reviewed working tree` — ou seja, o ZIP entregue é
byte a byte o que está na árvore revisada, e o hash esperado no teste acompanha o pacote final.

**Suíte completa** — `node scripts/run-tests.mjs` com a fase serial (Chrome real):

```
fase paralela: 4786 testes, 4785 passam, 1 pulado, 0 falham
fase serial:    143 testes,  141 passam, 2 falham
```

As **duas** falhas são `hover-script-menu-mv3` (§3.4e), arquivo fora da lista desta tarefa, com a mesma falha
reproduzida no commit-base `83d024e` e atribuída ao ponteiro físico que entra na janela — **não** a nenhuma
mudança desta tarefa. Todo o resto passa, incluindo `sidepanel-flow-mv3` (que na suíte de 1.1.61 falhava 5
vezes) e os dois arquivos de consentimento por pixel corrigidos em §3.4d.

**`node scripts/verify-project.mjs`** — as verificações próprias passam:

```
verify-project: manifest/CSP e axe 4.13.0 aprovados no Chrome for Testing 152.0.7977.64;
mapa numerado aprovado; 132/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN
```

O comando termina com **saída 1**, e o motivo é único e conhecido: a linha 106 do script exige que `npm test`
termine com 0, e a suíte carrega as duas falhas antigas de `hover-script-menu-mv3` (§3.4e). Com
`AUDITA_VERIFY_SKIP_TESTS=1` as verificações próprias terminam GREEN, sem falha. Nenhuma verificação do
produto é afetada; a saída 1 é consequência de uma falha preexistente, não desta tarefa.

**`node scripts/verify-neutral-identity.mjs`** — sem saída, saída **0**: nenhum nome de órgão, domínio de
governo ou loja em arquivo versionado.

**Ponta a ponta, um arquivo por vez** (`AUDITA_E2E_CHROME` = Chrome for Testing 152.0.7977.64, nenhum outro
Chrome aberto, um arquivo por execução):

| Arquivo | Testes | Passam | Falham |
| --- | --- | --- | --- |
| `sidepanel-flow-mv3` | 9 | 9 | 0 |
| `mandatory-journey-mv3` | 1 | 1 | 0 |
| `tab-reading-mv3` | 3 | 3 | 0 |
| `tab-reading-guided-mv3` | 1 | 1 | 0 |
| `keyboard-map-mv3` | 3 | 3 | 0 |
| `keyboard-map-cresce-mv3` | 1 | 1 | 0 |
| `public-axe-map-mv3` | 1 | 1 | 0 |
| `capture-visible-element` | 1 | 1 | 0 |
| `current-page-export-mv3` | 1 | 1 | 0 |
| `report-print-layout` | 1 | 1 | 0 |
| `report-executive-print` | 1 | 1 | 0 |
| `report-print-breaks` | 1 | 1 | 0 |
| `report-version-provenance` | 1 | 1 | 0 |
| `retention-indexeddb-mv3` | 11 | 11 | 0 |
| **Total** | **36** | **36** | **0** |

Todos os 14 arquivos da lista terminam com saída 0, sem falha e sem teste pulado. Os dois que aparecem no
meio das alíneas b a d (`sidepanel-flow-mv3`, `public-axe-map-mv3`) foram rodados de novo **depois** das
correções, sozinhos, e são os resultados da tabela que valem.

**Pacote** — `npm run build:release`:

```
release/audita-acessibilidade-1.1.62.zip — 245 arquivos
SHA-256 4c4dcc159fc05f2cd2dbf30733711bd530248d366068f816bb23adef8730f202
```

O mesmo hash está em `test/release-package.test.js` e em `docs/releases/1.1.62.md`; o teste
"every packaged byte is the byte in the reviewed working tree" é o que garante que os três continuam
coerentes depois de qualquer edição.

---

## 4. O que a 1.1.62 entrega, em linguagem simples

Para quem usa a extensão, a 1.1.62 muda seis coisas:

1. **Todo achado passa a ter imagem do elemento.** Quando a página já foi fotografada inteira, a extensão não
   tira uma foto nova de cada item: ela **recorta** o item daquela foto, com o contorno vermelho em volta e o
   resto escurecido. Antes, o item que já estava na foto da página inteira ficava sem imagem nenhuma, e quem
   lesse o laudo não tinha como conferir.
2. **A auditoria ficou bem mais rápida.** Cada evidência passa a ser conferida uma vez só, e as imagens são
   convertidas pelas funções do próprio navegador. Na página de teste, o tempo de montar o que o painel guarda
   caiu de 3,6 s para 0,11 s; num portal público, de 10,7 s para 0,30 s. Nada de cobertura, integridade ou
   privacidade foi reduzido para ganhar velocidade.
3. **A ficha de evidência traz o "RG" do arquivo de imagem.** Cada evidência citada no relatório leva a uma
   ficha com a imagem contornada, o identificador da evidência, o hash do registro e o **SHA-256 do arquivo de
   imagem**, com o download dos bytes exatos — é o número que qualquer pessoa recalcula para conferir que a
   imagem não mudou. No HTML exportado e no PDF, as evidências ficam reunidas num anexo, cada uma uma vez só.
4. **Mapa de leitura da página.** O mapa ganhou códigos curtos (L1, L2…) em cada elemento, na ordem em que um
   leitor de tela os leria, e uma coluna ao lado com o que o leitor de tela falaria em cada ponto. Ele entra no
   HTML e no PDF sem depender de ninguém clicar em "Conferir leitura por Tab".
5. **Leitura por Tab dentro da verificação guiada.** A extensão percorre a página na ordem da tecla Tab e faz
   uma pergunta por parada: "o que o leitor de tela fala corresponde a este elemento?" — **Sim**, **Não** ou
   **Não sei**. A resposta fica guardada com quem respondeu e quando; a caixa mostra a resposta com as palavras
   de quem respondeu e na cor dela (verde no sim, vermelho no não, cinza no não sei), e os "Não" do conjunto
   fecham **uma** constatação do item 5.13.10, citando os pontos pelo nome que se vê na tela ("Tab 3, botão") e
   dizendo o que o anúncio deveria dizer.
6. **Mapa do teclado alinhado em páginas que ainda estão carregando.** Em página que continua se montando
   depois de abrir, o mapa podia sair sem marcação nenhuma; agora os retângulos são medidos no mesmo leiaute da
   imagem e a caixa cai exatamente sobre o elemento.

E, no acabamento desta tarefa: o anexo de evidências passou a citar a seção pelo nome certo ("Mapa de leitura
da página", e não "Anúncios"); a legenda da imagem na coluna estreita da Leitura por Tab ficou curta
("Contorno vermelho: este elemento. Clique para ampliar."), com a explicação longa no recorte ampliado; o
seletor técnico saiu da coluna em evidência e foi para um "Detalhe técnico" fechado, atrás de "Tab 3 · botão";
e a captura passou a entrar **uma vez** no documento, mesmo com a verificação guiada e o relatório desenhando
na mesma página (a correção da §3.4a).

---

## 5. Pendências

Todas registradas, nenhuma corrigida nesta janela — e cada uma com o motivo:

1. **Artefato 1.4.0 do mapa de leitura** (§2.3a): preferir uma posição encostada que **não** cubra o próprio
   elemento, ainda que mais distante, declarando a limitação quando não houver nenhuma. É mudança de artefato
   de esquema fechado: exige versão nova do algoritmo e leitura de 1.0.0, 1.2.0 e 1.3.0.
2. **"Ir ao elemento" quando a página esconde o alvo** (§2.3b): o painel aceita o gesto em silêncio quando o
   elemento não tem caixa naquele instante. O certo é dizer em palavras que o elemento está escondido pela
   página neste momento — mudança de comportamento do painel, não polimento.
3. **Etiquetas sobre texto na loja on-line** (§2.5): mesma família da pendência 1, medidas 4 vezes naquela
   página e zero nas outras três.
4. **Roteiro de QA**: a precisão dos anéis é medida no fim da execução, contra uma página que continua mudando.
   Medir logo depois de cada seleção — e também no fim — daria um número mais justo sem afrouxar nada. É
   melhoria do roteiro, não do produto.
5. **Reconferir as quatro páginas** depois de qualquer mudança no posicionamento de etiquetas ou de códigos,
   porque as posições entram no hash do artefato.
6. **`hover-script-menu-mv3` não passa por causa do ambiente, não do produto** (§3.4e): o teste exige zero
   eventos de ponteiro de origem física durante a sondagem, e o ponteiro na janela produz um `mouseover`
   confiável logo depois do carregamento. Reproduzido **igual** no commit-base `83d024e`, fora desta tarefa e
   fora da lista de arquivos desta tarefa. O ajuste é do arquivo — comparar antes/depois em vez de exigir zero
   absoluto — e não foi feito aqui para não mexer em área de outra tarefa.
