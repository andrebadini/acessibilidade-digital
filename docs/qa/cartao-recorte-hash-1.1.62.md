# Cartão com recorte, ficha de evidência e SHA-256 do arquivo — 1.1.62

Data: 16/10/2026. Versão em trabalho: **1.1.62** (branch `wip162/cartao-hash`, **sem commit**; o
`manifest.json` ainda declara a versão anterior — a subida de versão e o `build:release` são o passo de
release). Chrome for Testing 152.0.7977.64, um Chrome por vez.

Por regra do projeto, **nenhum nome de órgão, domínio de governo ou loja é registrado aqui**. Os ensaios
em página real são descritos como **portal público**, **mercado on-line** e **loja on-line**.

O pedido do produto tinha três partes, todas sobre a mesma pergunta de quem usa a extensão: *"onde está
o elemento de que este relatório fala, e como eu confiro que a imagem guardada é mesmo aquela?"*

1. Na verificação guiada, além de **"Mostrar na página"**, o próprio cartão da pergunta mostra o
   **recorte da imagem do elemento com o contorno**.
2. Quando não há local registrado, **nunca** mandar procurar "a captura registrada no cartão": mostrar
   o que ajuda a localizar o elemento — recorte tirado da captura da página inteira, com contorno,
   quando a geometria dos mapas permite; senão o texto/nome e o tipo do elemento com a dica de usar
   "Mostrar na página"; e, sem nada disso, a frase honesta **"Esta auditoria não guardou imagem deste
   elemento."**
3. No relatório, cada evidência citada vira **link para uma ficha** com a imagem contornada, o ID, o
   SHA-256 do registro e o **SHA-256 do arquivo PNG** (inteiros e em linguagem simples, com download dos
   bytes exatos); no HTML exportado e no PDF, cada evidência aparece **uma vez** num **"Anexo de
   evidências"**, e as citações apontam para lá.

## 1. O defeito, medido

### 1.1 O hash do arquivo não existia no que foi guardado

A ficha de evidência precisa afirmar duas coisas diferentes:

- o **hash do registro** (`hash`), que identifica a evidência no modelo e no manifesto de integridade;
- o **hash do arquivo de imagem**, que é o SHA-256 dos bytes do PNG guardado — o número que a pessoa
  recalcula no arquivo baixado para conferir que ele não mudou.

O segundo número não existia em auditoria nenhuma. A captura gravava a miniatura do elemento e o hash
do artefato, mas o SHA-256 dos bytes só era calculado **dentro** de `hashEvidenceArtifact`, que usa o
valor para compor o hash do registro e o descarta em seguida (`content.binarySha256` entra no JSON
canônico e o `dataUrl` sai; o resultado devolvido era só o hash final). Guardar de novo o valor exigia
uma decisão: ele **não pode** mudar nenhum hash já calculado, senão toda auditoria existente deixaria
de verificar.

Durante a depuração, o campo foi gravado corretamente pelo capturador e mesmo assim não chegava ao
relatório. A causa estava longe da captura: a auditoria guardada em esquema V1 passa por
`projectV1Evidence` (`src/core/report/audit-model.js`), uma projeção por **lista explícita de chaves**
na migração V1→V2. `binarySha256` não estava na lista, então era apagado em silêncio — com os pixels no
lugar, o hash do arquivo sumia no caminho entre o armazenamento e a tela, e a ficha dizia "não
registrado". Um teste de regressão em `test/background/run-audit.test.js` fixa que **toda** miniatura
guardada leva o campo.

### 1.2 O anexo mostrava um hash só

O "Anexo de evidências" do HTML entregue e do PDF trazia o hash do registro, e nada mais. Sem o SHA-256
do arquivo, a imagem no anexo não era verificável por quem recebe o relatório — que é exatamente o que
um laudo precisa permitir.

### 1.3 O cartão da pergunta não mostrava o elemento

Na verificação guiada, o cartão só oferecia o botão **"Mostrar na página"**. Quem revisava tinha de sair
do cartão, achar o destaque ao vivo na página e voltar — e quando a página não estava disponível (ou o
elemento não era localizável ali), a orientação dizia "consulte a captura registrada no cartão" **sem
que houvesse captura nenhuma no cartão**. A frase mandava procurar o que não existia.

## 2. A solução

### 2.1 O SHA-256 do arquivo, gravado sem mexer em hash algum

- `hashEvidenceArtifactDetailed(input, { sourceArtifact })` (`src/core/evidence/artifact-hash.js`)
  devolve `{ hash, binarySha256 }` na mesma passada. `hashEvidenceArtifact` continua igual, delegando
  para ela — nenhum chamador antigo mudou de contrato.
- Para o artefato de **elemento**, o `binarySha256` é o SHA-256 dos bytes decodificados do PNG, e o
  hash do registro continua sendo o hash do JSON canônico **sem** `dataUrl` e **com** esse valor dentro.
  Ou seja: **nenhum hash guardado muda**; o campo novo passa a ser persistido e é exatamente o valor que
  já entrava no cálculo. Para **página inteira**, o hash do registro *é* o SHA-256 dos bytes, então a
  ficha mostra o mesmo número duas vezes, dizendo isso em vez de repetir o rótulo.
- `verifyIntegrityLinks` (`src/core/report/integrity-chain.js`) passou a conferir também o campo: ele
  recalcula o hash do arquivo a partir dos pixels e **recusa** o valor que não bater. Sem isso, um valor
  trocado no armazenamento local passaria na verificação (o hash do registro é recalculado a partir dos
  pixels, não do campo) e o relatório afirmaria um hash falso.
- O esquema fechado aceita `binarySha256` em evidência de elemento **apenas junto de `dataUrl`** e
  **apenas com forma de SHA-256** (`src/core/report/closed-schema.js`); o orçamento de evidências apaga o
  campo quando apaga os pixels (`src/core/batch/evidence-budget.js`), porque sem os bytes não há arquivo
  a que o hash se refira.
- Versão anterior à 1.1.62, sem o campo, continua abrindo: a ficha diz **"não registrado"** e explica
  que a captura é de versão anterior. Fixture `fixtures/audits/legacy-1.1.56-full-evidence.json` segue
  verde.

### 2.2 A ficha de evidência no relatório aberto pelo painel

`src/core/report/evidence-hash-presentation.js` centraliza os rótulos e as respostas honestas:

- **"Impressão digital (SHA-256) do registro"** — o hash do artefato;
- **"SHA-256 do arquivo de imagem (PNG)"** — o hash dos bytes, com o texto que ensina a conferir
  ("baixe a imagem e recalcule o SHA-256 dela com uma ferramenta comum; o resultado tem de ser igual ao
  que está escrito aqui");
- quando não se aplica (mapas derivados: cada trecho tem o próprio hash), quando não está registrado, ou
  quando a auditoria é anterior ao campo, a ficha **diz qual é o caso** em vez de inventar número.

Cada citação de evidência no texto da constatação virou **link** (`data-report-consult-evidence`) para a
ficha, sem alterar o texto da citação. A ficha traz a imagem com contorno, o ID, os dois hashes inteiros,
a **data e hora da captura**, o botão **"Baixar imagem (PNG)"** — que grava `<ID>.png` com os **bytes
exatos** guardados — e a explicação em linguagem simples. O tratamento visual `EVIDENCE_FICHE_TREATMENT_V1`
(`src/core/report/evidence-treatment.js`) usa o tom `target`: uma ficha descreve o **registro**, não um
veredito, e a mesma evidência pode sustentar itens com desfechos diferentes. O contorno responde "onde
está o elemento desta evidência?" sem afirmar falha.

### 2.3 O anexo do HTML e do PDF

- O anexo ganhou o **segundo hash** em cada ficha e em cada linha da tabela do PDF, com os rótulos e as
  frases acima; as ocorrências apontam para o item certo (**"Ver Anexo de evidências, item N"**, link de
  verdade no HTML).
- A regra de 1.1.61 continua: **uma citação por elemento** e **cada PNG uma vez por documento**. Quando a
  imagem já apareceu na seção da ocorrência, a ficha do anexo **não repete** o PNG: ela mostra o ID e os
  dois hashes e aponta o lugar (**"A imagem não se repete aqui: Consultar captura … já apresentada"**). O
  PDF imprime as figuras das evidências cujo PNG ainda não foi apresentado e a tabela com os dois hashes
  de todas.
- O relatório autônomo também passou a nomear a seção **"Anexo de evidências"** (antes "Anexos de
  evidências") e a numeração do item entrou na legenda das figuras.

### 2.4 O cartão da verificação guiada

`src/core/report/evidence-crop.js` (novo) responde "onde está este elemento nas imagens guardadas?":

1. se existe **miniatura do elemento**, ela já traz o quadro em `metadata.highlightBox` — é o caso
   normal;
2. se **não existe** (teto de miniaturas por auditoria atingido, ou a captura daquele elemento falhou),
   a posição é lida da **geometria dos mapas**: as anotações do mapa de anúncios e as paradas/suspeitas
   do mapa do teclado guardam `nodeId` e o retângulo do documento, e cada segmento diz que faixa da
   página a sua imagem cobre. O alvo é convertido para pixels do trecho (`documentRectToSegmentPixels`)
   e recortado de lá;
3. **sem geometria confiável a resposta é `null`** — a posição **nunca é adivinhada**.

O recorte **não gera pixel novo**: a imagem guardada entra inteira no SVG e a janela é o `viewBox`, como
nos recortes das marcas da revisão guiada. O cálculo da caixa, do escurecimento e do contorno continua
sendo o de `evidence-highlight.js` — o mesmo do relatório — e `GUIDED_REVIEW_TREATMENT_V1` usa o tom
`target` com a legenda pedida pelo produto: *"Contorno vermelho: o elemento desta pergunta."* Elemento
que passa da borda do trecho é marcado como cortado (`highlightClipped`) com a legenda avisando, em vez
de desenhar um quadro menor sem explicação. Um teto de 8 MB de PNG decodificado evita que um trecho de
página muito alta pese na memória da aba.

Um índice `pageId + nodeId` é montado **uma vez por lista de evidências** (cache fraco por lista): sem
ele, cada cartão varreria todas as anotações e paradas de todos os mapas da auditoria.

As mensagens (`src/review/review.js`) foram reescritas para apontar para **"a imagem acima, neste mesmo
cartão"**, e nenhuma delas manda procurar captura no cartão quando não há imagem: o cartão diz o nome e o
tipo do elemento e indica o botão **"Mostrar na página"**. Quando não há nem geometria nem pixels, a
frase é a pedida: **"Esta auditoria não guardou imagem deste elemento."** A função de desenho já aceita um
artefato com quadro e pixels para **qualquer** evidência — a tarefa futura que garantir recorte para todos
os elementos só precisa alimentá-la.

## 3. Arquivos tocados

Novos: `src/core/report/evidence-crop.js`, `src/core/report/evidence-hash-presentation.js`,
`test/report/evidence-binary-hash.test.js`, `test/report/evidence-crop.test.js`,
`test/report/annex-evidence-hashes.test.js`, `test/review/report-view-evidence-fiche.test.js`,
`test/review/review-card-crop.test.js`.

Alterados: `src/core/evidence/artifact-hash.js`, `src/core/report/{audit-model,closed-schema,
integrity-chain,findings-board,evidence-treatment,html}.js`, `src/core/batch/evidence-budget.js`,
`src/background/run-audit.js` (uma linha: gravar `binarySha256: thumbnail.hash`), `src/review/{review.js,
report-view.js,review.css,index.html}`, testes de unidade, testes e2e do mapa do teclado e do fluxo do
painel, e `scripts/visual-qa.mjs`.

Fora do escopo desta tarefa, tocado só o mínimo: os mapas (geometria e captura) e o mapa de leitura
seguem intactos. **A geometria dos mapas foi apenas lida** por `evidence-crop.js`.

## 4. Testes

- Unidade (relatório, revisão e captura): `node --test test/report/*.test.js test/review/*.test.js
  test/background/run-audit.test.js` → **695 testes, 695 passam, 0 falham**.
- Suíte completa: ver §7.
- Compatibilidade: `test/report/legacy-1.1.56-compat.test.js` verde — auditoria antiga abre sem o campo e
  nenhum hash guardado mudou.
- E2E em Chrome real: `keyboard-map-mv3` (mapa, recorte, ficha, anexo, download do PNG),
  `sidepanel-flow-mv3`, `capture-visible-element-mv3`.
- Roteiro visual: `node scripts/visual-qa.mjs` ganhou quatro blocos novos — o recorte dentro do cartão da
  pergunta (10), o recorte ampliado (10b), a ficha de evidência (11) e a exportação/impressão (12 e 13).

## 5. Validação em página real (antes e depois)

Forma da chamada (as URLs não são registradas aqui por regra do projeto; a variável de ambiente aponta
para o Chrome for Testing 152.0.7977.64):

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/1.1.62-real \
  --url <portal público> --url <mercado on-line> --url <loja on-line>
```

As três páginas cobrem os casos que interessam: uma página institucional de órgão público, um mercado
on-line com anúncios repetidos e uma loja on-line com blocos grandes e imagens promocionais.

### 5.1 As três páginas reais — resultado da corrida

Todas as três concluíram a auditoria, abriram o relatório, entregaram os quatro arquivos
(HTML, PDF, CSV, JSON) e passaram pelo anexo impresso, **sem nenhum erro** no resumo.

| medida | portal público | mercado on-line | loja on-line |
| --- | --- | --- | --- |
| achados com elemento | 133 (todos localizados) | 73 (63 localizados, 10 sem localização) | 73 (63 localizados, 11 sem localização) |
| cartão com recorte (bloco 10) | presente, caixa [76, 12, 231, 70,8] | presente, caixa [37, 11,5, 19, 24] | presente, caixa [137, 57, 403, 45] |
| recorte ampliado (10b) | abre, modal, com contorno | abre, modal, com contorno | abre, modal, com contorno |
| cartões sem imagem (frase honesta) | 0 | **7** | **15** |
| ficha de evidência (11) | 109 fichas; 2 hashes; download | 194 fichas; 2 hashes; download | 134 fichas; 2 hashes; download |
| anexo no HTML entregue | 109 fichas, 48 imagens, 59 apontamentos, 2 rótulos de hash | 194 fichas, 84 imagens, 55 apontamentos | 134 fichas, 40 imagens, 48 apontamentos |
| PDF entregue (arquivo baixado) | 35,1 MB, **109 imagens** | 16,5 MB, **143 imagens** | 19,6 MB, **98 imagens** |
| PDF do anexo (bloco 12/13) | 2,0 MB, **6 imagens** | 2,8 MB, **6 imagens** | 4,0 MB, **6 imagens** |

Antes desta versão, nas mesmas páginas: o cartão da pergunta **não tinha imagem nenhuma** (só o botão
"Mostrar na página"), a ficha de evidência mostrava **um** hash (e o do arquivo não existia em auditoria
alguma) e o anexo não tinha o SHA-256 do PNG. As capturas 10/10b/11/12 desta corrida são a prova visual
do depois; o "antes" é o próprio código da 1.1.61.

O que foi conferido a olho nas imagens geradas:

- **10** — cartão da pergunta com o recorte e a legenda *"Contorno vermelho: o elemento desta pergunta. O
  restante da imagem aparece escurecido só como contexto."* e a dica de clicar para ampliar;
- **10b** — o recorte ampliado em caixa de diálogo, com o contorno colado ao elemento;
- **11** — a ficha de evidência com o elemento contornado, o ID, os **dois** SHA-256 inteiros e o botão
  de download;
- **12** — o anexo impresso com o rótulo *SHA-256 do arquivo de imagem (PNG)*, a frase que ensina a
  conferir e os itens numerados;
- as imagens **extraídas de dentro dos PDFs** (§5.3).

Os dois sites com cartões sem imagem mostram a frase honesta do pedido (contada no resumo, e afirmada
nos testes de Chrome real em `sidepanel-flow-mv3` e `keyboard-map-mv3`, que varrem todos os cartões e
recusam qualquer frase que mande procurar "a captura registrada no cartão").

### 5.2 Fixture local — o que o resumo automático mediu

`node scripts/visual-qa.mjs --out qa-out/1.1.62-fixture` (a fixture do roteiro, 145 capturas, 70
evidências no anexo):

| medida | resultado |
| --- | --- |
| cartão com recorte (bloco 10) | presente; legenda *"Contorno vermelho: o elemento desta pergunta…"*; `viewBox` 362,7×290; caixa [32, 82, 248,7, 126] |
| recorte ampliado (bloco 10b) | diálogo modal aberto, com contorno desenhado, mesma janela |
| cartões sem imagem | 0 de 80 (nesta fixture todo elemento tem imagem) |
| ficha de evidência (bloco 11) | 2 hashes inteiros, botão **Baixar imagem (PNG)**, contorno presente |
| anexo no HTML entregue | 70 fichas, 18 imagens, 50 apontamentos "a imagem não se repete aqui", os **dois** rótulos de hash presentes |
| PDF entregue (bloco k) | 5,46 MB, **73 imagens** embutidas |
| PDF só do anexo (bloco l) | 1,77 MB, **6 imagens** embutidas — o teto de 6 figuras no recorte impresso que cabe no quadro do CDP (§5.3) |
| imagens conferidas a olho | cartão (10), recorte ampliado (10b), ficha (11), anexo impresso (12) e as imagens extraídas de dentro dos dois PDFs |

### 5.3 Como as imagens foram conferidas **dentro do PDF**

O resumo conta os objetos `/Subtype /Image` do PDF — e a primeira versão do contador procurava a marca
apenas dentro dos fluxos descomprimidos, devolvendo `images: 0` para um PDF cheio de imagens. O Chrome
grava os dicionários no corpo do arquivo (sem `/ObjStm`), então a contagem passou a ler o arquivo
inteiro. Para não confiar só no número, as imagens foram **extraídas** do PDF (descompactadas e
recodificadas como PNG) e abertas: são os recortes de página e as miniaturas de elemento, com o texto da
página legível — ou seja, o que entrou no PDF é a captura guardada, não um retângulo vazio.

Limite encontrado no caminho: `Page.printToPDF` devolve o PDF inteiro num único quadro do CDP, e o
transporte usado pelos ensaios corta em 16 MB — um anexo de página real passa disso e a conexão inteira
cai com `CDP_FRAME_TOO_LARGE`. Por isso a impressão do anexo (bloco l) mantém no máximo **6 figuras**
(o resto da seção continua impresso, com ID e os dois hashes) e o PDF entregue é conferido no **arquivo
baixado**, lido do disco, sem passar por quadro nenhum.

## 6. Onde ficam as imagens, e o que entra em cada formato

- **Armazenamento.** As imagens são PNG em `data:` URL dentro do **próprio registro da auditoria**, no
  IndexedDB do navegador (mesma base do resto do modelo). Não há servidor, não há disco do sistema de
  arquivos: nada sai da máquina de quem audita.
- **Retenção.** `RETENTION_MS = 30 dias` (`src/storage/audit-retention.js`): passado o prazo, a limpeza
  apaga a auditoria inteira.
- **Exclusão.** Apagar a auditoria remove o registro com as imagens e grava o **atestado de exclusão**
  (tombstone). O que o usuário apaga deixa de existir; o atestado existe para provar que a auditoria
  existiu e foi apagada, e não guarda pixels.
- **HTML entregue.** Leva as imagens **dentro do arquivo** (base64, um `data:image/png;base64,` no ponto
  em que a imagem aparece). O `<defs>`/`<use>` existe no código, mas no arquivo exportado ele fica vazio
  — conferido na entrega da fixture: 97 imagens embutidas e **zero** referências `<use>`. A regra "cada
  captura uma vez por documento" é garantida por `firstPreviewByEvidence`: a **primeira** ocorrência
  desenha a imagem e as fichas seguintes do anexo apontam para ela. É um arquivo autossuficiente: abre
  sem a extensão e sem rede.
- **PDF.** Sai do mesmo HTML, impresso pelo próprio navegador: as imagens entram como objetos de imagem
  do PDF (conferido na §5.3).
- **CSV.** Mantido como está. A coluna fixa `evidence_hashes` já leva os hashes de **registro**, e o CSV
  é um formato de colunas fechadas com versão própria (`audita-occurrences-v3`): acrescentar um hash por
  evidência exigiria uma v4 e uma coluna nova por linha, sem ganho para quem lê a planilha. Quem precisa
  do hash do arquivo tem o JSON e o HTML.
- **JSON.** Leva o campo `binarySha256` dentro de `audit.model.evidence[]` (evidência de elemento, junto
  do `dataUrl`), porque o JSON é a cópia técnica integral do modelo. O campo é **opcional** no esquema
  fechado: auditoria antiga continua válida, e a ausência dele é lida como "não registrado", nunca como
  zero.
- **Hash do arquivo e hash do registro são coisas diferentes, e o relatório diz isso.** O primeiro muda
  se um pixel mudar; o segundo muda se qualquer campo do registro mudar (inclusive o próprio hash do
  arquivo). Os dois juntos respondem "a imagem é a mesma?" e "o registro é o mesmo?".

## 7. Testes finais

### 7.1 Suíte completa

`node scripts/run-tests.mjs` (fase de unidade em paralelo e, em seguida, a fase de Chrome real, um
arquivo por vez):

| etapa | resultado |
| --- | --- |
| fase de unidade (suíte inteira) | 4 684 testes: **4 682 passam**, 1 pulado e **1 falha esperada** (`release-package`: o hash do ZIP é recalculado no `build:release`) |
| unidade dirigida (relatório, revisão, captura) | 695 testes, **695 passam** |
| fase de Chrome real (todos os arquivos, um por vez) | 141 testes: **136 passam** e **5 falham** — as **mesmas 5** da revisão-base (§7.2) |
| `keyboard-map-mv3` (Chrome real) | 3 testes, **3 passam** |
| `sidepanel-flow-mv3` (Chrome real) | 9 testes, 4 passam e 5 falham — as **mesmas 5** da revisão-base (§7.2) |
| `capture-visible-element.test.mjs` (Chrome real) | 1 teste, **1 passa** |

### 7.2 Falhas de ambiente que **não** vêm desta mudança

Comparação feita num worktree separado da revisão-base (`/tmp/w162-base`, `a1fbee5`), com o mesmo Chrome:

| sintoma | revisão-base `a1fbee5` | esta revisão |
| --- | --- | --- |
| `selecionar-1` e `destacar-1` (`WAIT_TIMEOUT`) no roteiro da fixture | **os dois** | **os dois** |
| `sidepanel-flow-mv3`: 5 de 9 testes falham | **os mesmos 5** | **os mesmos 5** |
| … dos quais 4 por geometria da página observada (`clientWidth` 879 → 894: barra de rolagem) | 5 ocorrências | 5 ocorrências |
| … e 1 por `FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED` (`WAIT_TIMEOUT` no início da auditoria) | 1 | 1 |

Os dois `WAIT_TIMEOUT` do roteiro são o anel e o destaque ao vivo do *sinal* de mapa — código que esta
tarefa não tocou. As cinco falhas do `sidepanel-flow` são de ambiente: quatro comparam a geometria da
página observada antes e depois e veem a barra de rolagem desaparecer (879 → 894 px de largura útil), e
uma é o início da auditoria que não chega a tempo. Nos dois casos o resultado é **idêntico** na revisão
base, então nenhuma delas é regressão desta versão.

### 7.3 O que **é** desta versão

Nenhuma regressão: os testes de unidade dirigidos passam (695/695), `keyboard-map-mv3` passa 3/3 com a
varredura nova (78 cartões, 3 recortes, 3 contornados, nenhuma frase proibida), e `capture-visible-*`
passa. Os testes novos cobrem: hash do arquivo gravado e conferido, campo ausente em auditoria antiga,
recorte por geometria de mapa, ausência de geometria (nada é adivinhado), ficha com dois hashes e
download byte a byte, citação ligada à ficha e anexo com os dois hashes.

## 8. Limitações

- **Nem toda evidência tem imagem.** O teto de miniaturas por auditoria e falhas de captura deixam
  elementos sem PNG. Nesses casos o cartão mostra o recorte do trecho do mapa quando há geometria; sem
  geometria **não há caixa** — a escolha é dizer que não há imagem, não desenhar no lugar errado.
  Essa ramificação foi conferida **por contagem e por teste**, não por foto: o roteiro conta os
  `lay-locate-note` e as imagens de cada cartão nas três páginas reais e na fixture (7 e 15 cartões na
  ramificação honesta em dois sites), e os testes de unidade fixam a ausência de caixa inventada
  (`evidence-crop.test.js`) e a frase final (`report-view-evidence-fiche.test.js`).
- **O recorte do mapa depende da geometria guardada.** Mapas derivados de uma captura recusada ou sem
  segmentos não posicionam nada; o cartão cai no texto do elemento.
- **O PDF imprime o PNG sem contorno na figura do anexo.** O contorno é desenhado na tela (SVG); no PDF
  ele aparece nas figuras das ocorrências, que são tratadas como no relatório. As figuras do anexo levam
  a imagem crua, com o ID e os dois hashes na linha da tabela acima.
- **CSV sem o hash do arquivo** (ver §6), por decisão de não abrir uma v4 do formato nesta versão.
- **Página muito alta:** trecho acima de 8 MB decodificados não vira recorte.

## 9. Pendências

- A tarefa que garantir recorte para **todos** os elementos (não só quando há miniatura ou geometria de
  mapa) só precisa alimentar `evidenceMediaParts` — a apresentação já está pronta.
- `test/release-package.test.js` falha enquanto o hash do ZIP não é refeito; é o esperado durante o
  desenvolvimento e o `build:release` resolve.
