# Mostrar os sinais depois de a página recarregar — 1.1.60

Versão analisada: 1.1.59 (worktree `wip160/recarga-sinais`).
Público: quem audita a página e continua lendo o resultado no painel — sem saber programar.

---

## 1. O problema

A pessoa audita uma página, os sinais aparecem sobre os elementos e, sem sair do endereço, a página
recarrega (o próprio site recarrega, ou ela usa o botão de recarregar do navegador). O resultado da
auditoria continua guardado e continua valendo, mas os sinais que estavam desenhados morreram junto
com o documento antigo.

Até a 1.1.59 o painel tratava esse caso como "a página mudou" e respondia com a mensagem de falha: não
havia como voltar a ver os sinais na versão de agora, mesmo com o endereço idêntico e a auditoria
inteira guardada. O mesmo valia para o destaque individual: "Destacar elemento" só sabia falar do
documento auditado.

O pedido desta tarefa tem quatro partes:

1. mesma aba, mesmo endereço, documento novo: o painel **convida** em vez de errar;
2. o convite aceito **recoloca** os sinais, e só desenha o que a evidência registrada confirmar;
3. o **destaque individual** segue exatamente a mesma lógica;
4. endereço **diferente** tem resposta própria: refazer a auditoria.

---

## 2. O que a pessoa vê

### 2.1 O convite, no lugar do erro

Depois da recarga, o cartão dos sinais passa a mostrar o aviso e um botão:

> A página foi recarregada depois da auditoria. Mostrar os sinais na versão atual?
> **[ Mostrar sinais na versão atual ]**

O convite sozinho **não desenha nada** (medido: `drawnAfterOffer: 0`): quem mostra a versão de agora é
o clique. O botão tem `aria-label` próprio ("Mostrar sinais na versão atual: a página foi recarregada
depois da auditoria") para quem navega por leitor de tela.

### 2.2 Depois de aceitar

Os sinais voltam numerados, sobre os elementos reencontrados, e a legenda do cartão passa a dizer:

> Sinais reencontrados na versão recarregada — confira se correspondem ao que foi auditado.

O aviso acompanha o estado enquanto os sinais estiverem visíveis, e o que não foi reencontrado entra na
lista de sempre ("não foi reencontrado nesta versão da página"), com as evidências registradas ainda
disponíveis.

### 2.3 O destaque individual, no mesmo modo

"Destacar elemento" na página recarregada **não** erra: o botão vira

> **[ Destacar na versão atual ]**

e só o clique seguinte desenha a caixa (medido: convite aceito e nada desenhado). Depois de desenhar, o
painel conta a mesma história que a página:

> Destaque reencontrado na versão recarregada — confira se corresponde ao que foi auditado.

com os botões "Ir ao elemento do sinal N" e "Limpar destaque" — o destaque recolocado se desfaz pelo
mesmo caminho de sempre.

### 2.4 Endereço diferente

Se o endereço mudou, recolocar seria mostrar sinais de outra página. A resposta é a saída honesta:

> O endereço da página mudou depois da auditoria. Para ver os sinais na página de agora, refaça a
> auditoria.
> **[ Refazer auditoria ]**

e nada é desenhado na página nova.

---

## 3. Como foi feito

### 3.1 Provar o documento, não adivinhar

`probeDocumentIdentity(tabId)` devolve `{ tabId, windowId, documentId, urlSessionDigest }`. Recarregar
troca o `documentId` e **mantém** o digest de sessão (origem, caminho e consulta). Daí a classificação
em um lugar só, usada pelos dois controladores:

| relação | quando | resposta |
| --- | --- | --- |
| `same` | mesmo documento auditado | caminho de sempre |
| `reloaded` | mesma aba, mesma janela, mesmo digest, documento novo | convite |
| `changed` | outra aba, outra janela ou outro endereço | "refaça a auditoria" |
| `absent` | não há como provar o documento | "refaça a auditoria" |

### 3.2 A oferta de recolocação não é autorização

`src/background/page-relocation-offer.js` (novo) guarda apenas a lembrança de que uma tentativa feita
**por gesto do usuário** encontrou "mesmo endereço, documento novo":

- chave `auditId + tabId + windowId + escopo` (escopos `page-markers` e `highlight`);
- só os cinco campos de identidade que já vivem no cache de origem (nada de URL bruta, nada de
  conteúdo de página), em registro de chaves fechadas e congelado;
- validade de 300 s e teto de 64 registros; relógio que só anda para a frente;
- **nunca é consumida**: repetir a tentativa continua possível enquanto valer;
- sem oferta (ou com a oferta vencida), a tentativa seguinte volta a oferecer — nunca recoloca sozinha.

A autorização de verdade continua acontecendo depois, e duas vezes: o painel confere a sessão e o
worker confere de novo, **contra o documento vivo**, antes de desenhar. A oferta sozinha não desenha
nada.

### 3.3 Só desenha o que a evidência confirma

Na recolocação o `documentId` auditado não serve mais como prova (o documento é outro). O critério
passa a ser o **localizador estrito** de sempre — o mesmo seletor e a mesma estrutura — mais uma
corroboração semântica nova, extraída da evidência já guardada (`src/core/evidence/locator-corroboration.js`,
novo): o nome acessível e o texto visível registrados, normalizados, com corte de tamanho e recusa de
caracteres de controle. O que não sobrar simplesmente não vira corroboração — aí o localizador estrito
continua sendo o critério único, exatamente como antes.

A conferência é repetida **dentro da página**, no overlay, que recebe o mesmo par de campos e compara
com o que o DOM expõe (atributos que nomeiam o controle e texto renderizado). Nada de árvore de
acessibilidade nova, nada de captura nova. Elemento que não confere não é desenhado e entra na lista
"não reencontrado nesta versão da página".

No destaque, a assinatura estrutural foi feita contra o documento **auditado**, então o comando de
instalação ganhou o campo opcional `signedDocumentId` (o id auditado) e a verificação dentro da página
passa a comparar a assinatura contra esse id. Sem o campo — ou seja, em todo o caminho normal — o
comando continua com exatamente as mesmas chaves de antes.

### 3.4 A leitura do resultado pode destacar, e só isso

Depois de uma navegação a aba já não serve à auditoria, e o painel volta como **leitura** do resultado
(sessão `view-only`). Era justamente aí que o destaque precisava funcionar, e a sessão de leitura não
tinha `highlight` na tabela de intenções dela.

A decisão: o que autoriza desenhar **não é o estado da sessão**, é a ligação durável registrada na
auditoria somada à prova do documento vivo — a mesma página auditada ou a versão recarregada do mesmo
endereço, sempre reconferida contra a estrutura registrada. A leitura ganhou `highlight`; "cancelar
auditoria" e "confirmar pixels" continuam fora da tabela dela.

### 3.5 Catálogo fechado: a tabela antiga virou constante

A tabela de intenções é parte de sessões **gravadas**: uma sessão de uma versão anterior precisa
continuar abrindo. Em vez de afrouxar a leitura, o formato anterior foi preservado como constante
(`PRE_RELOCATION_INTENTS`), ao lado de `PRE_MARKERS_INTENTS`, no mesmo padrão já usado no arquivo.
`parseIntents` aceita os três formatos conhecidos, e nenhum outro: qualquer tabela fora deles continua
sendo sessão negada.

### 3.6 O defeito que apareceu na validação em página real

Antes desta correção o desfecho visível era incoerente. Numa sonda descartável na fixture local, com o
painel e o worker instrumentados, a caixa do destaque aparecia na página em ~257 ms e o painel
respondia

> Não foi possível destacar este item na página. Consulte as evidências coletadas.

sem botão de limpar. A instrumentação temporária (removida ao fim) localizou o ponto exato:

```
disconnect {state: "bound-session", native: false}
  at publishHighlightState (panel-port.js:1651)
  at highlightIntent (side-panel-intent-router.js:920)
```

A Port do painel era derrubada pelo próprio worker logo depois de despachar o pedido, e a resposta do
destaque nunca voltava.

A causa: `authorizedHighlightPublication` — que confere cada anúncio de destaque antes de entregá-lo ao
painel — exigia `session.state === 'result'` e a lista de intenções do estado `result`. Uma sessão de
leitura tem estado `view-only` e **lista própria**, e as duas coisas estavam escritas à mão. A correção
usa a lista do **estado da própria sessão** (como já faz `authorizeSession`) e reconhece o formato do
alvo da leitura (`{ kind: 'view-only' }`), mantendo todas as demais conferências: janela, auditoria,
consumidor, documento da extensão que fala, janela do painel e validade.

Um segundo ajuste, achado no mesmo caminho: o anúncio do worker (`HIGHLIGHT_STATE_CHANGED`) chega
**antes** da resposta ao pedido do painel e não sabe em que modo o destaque foi pedido, então o aviso de
conferência nunca aparecia. Agora o próprio estado — que ainda carrega o convite da versão recarregada —
decide a frase.

---

## 4. Testes

### 4.1 Unidade

`node scripts/run-tests.mjs` (parte de unidade, 203 arquivos):

| | |
| --- | --- |
| testes | 4561 |
| aprovados | 4559 |
| falhas | 1 |
| ignorados | 1 |

A única falha é `test/release-package.test.js` (hash do ZIP público), esperada enquanto o fonte está
alterado e o artefato não foi reconstruído.

Casos novos acrescentados pela tarefa — 56 no total (44 em arquivos de teste existentes, 10 no arquivo
novo do store de ofertas e 2 no e2e novo):

- `test/background/page-relocation-offer.test.js` (novo, 10 casos): chaves fechadas e registro
  hostil, escopos, validade, teto, relógio que não anda para trás, limpeza por auditoria e por aba,
  oferta que não se consome;
- `test/e2e/page-markers-reload-mv3.test.mjs` (novo, 2 casos, Chrome real);
- destaque: `highlight-controller` (convite x erro, recolocação só com oferta, documento vivo,
  estrutura assinada no documento auditado), `highlight-binding-store` (registro recolocado, id
  assinado), `highlight-action` (rótulo e pedido próprios), `panel-state` (convite, aviso de
  conferência, anúncio que chega antes da resposta);
- sinais: `page-markers-controller` (mesma classificação de relação, recolocação por gesto, limpeza do
  registro ausente), `page-markers-overlay` (corroboração dentro da página, elemento que não confere
  não é desenhado), `page-markers-session` e `panel-view` (convite, legenda, "refazer auditoria");
- fronteiras: `panel-port` (a publicação do destaque passa a valer para a sessão de leitura e continua
  caindo para documento forjado), `target-capabilities` (tabela nova e tabela antiga), `worker-protocol`
  e `side-panel-intent-router` (envelopes fechados, o relatório não recoloca).

Cada caso novo foi conferido nos dois sentidos: ele falha sem a correção correspondente e passa com
ela (verificado por reversão temporária em `panel-port.js` e `panel-state.js`).

### 4.2 e2e em Chrome real

`node --test test/e2e/page-markers-reload-mv3.test.mjs` — 2 casos, 2 aprovados. O primeiro audita uma
página local, mostra os sinais, **recarrega a aba**, confere que o convite aparece (e que nada foi
desenhado), aceita, e verifica: sinais reencontrados sobre elementos reais, aviso na legenda, e o
destaque individual convidando, desenhando a caixa e oferecendo "Limpar destaque" — e limpando de
verdade. O segundo navega para outro endereço e exige "Refazer auditoria" com a página limpa.

### 4.3 O passo `--reload-check` no roteiro de QA

`scripts/visual-qa.mjs` ganhou o passo opcional `--reload-check`, que reproduz os mesmos gestos da
pessoa e guarda, por página: endereço antes e depois, se a camada antiga sumiu, o convite (estado,
mensagem, ações), o texto do botão, o que foi desenhado antes e depois de aceitar, os sinais
reencontrados, e — por sinal tentado — o convite, o texto do botão, a caixa, as ações do painel e as
regiões vivas. As capturas `05b`–`05e` são o convite no painel, os sinais recolocados, o convite do
destaque e a caixa desenhada. Duas correções de medição entraram junto: a leitura do painel espera o
painel decidir (a caixa aparece na página antes de a resposta chegar) e a rolagem do painel passou a ser
feita no contêiner que de fato rola (`#panel-root`), senão a imagem não mostrava o que o nome promete.

---

## 5. Validação

### 5.1 Fixture local (`test/e2e/fixtures/visual-qa/marcacao.html`)

`node scripts/visual-qa.mjs --reload-check --out qa-out/recarga-fixture-8`

| medida | valor |
| --- | --- |
| convite | `reload-offer`, "A página foi recarregada depois da auditoria. Mostrar os sinais na versão atual?" |
| botão | "Mostrar sinais na versão atual" |
| desenhado só com o convite | 0 |
| sinais recolocados | 8 de 46 grupos (8 na moldura, 6 precisos) |
| legenda | "Sinais reencontrados na versão recarregada — confira se correspondem ao que foi auditado." |
| destaque: primeira tentativa | `highlight-occurrence` → convite |
| desenhado só com o convite do destaque | 0 |
| botão do convite | "Destacar na versão atual" |
| caixa desenhada | 1 (Sinal 45) |
| aviso do painel | "Destaque reencontrado na versão recarregada — confira se corresponde ao que foi auditado." |
| ações do painel | "Ir ao elemento do sinal 45", "Limpar destaque" |
| limpar | caixa removida, sem erro |

A página terminou sem nenhuma linha de erro no roteiro.

### 5.2 Páginas reais

Passo `--reload-check` em três páginas reais: um **portal público**, uma **loja on-line 1** e uma **loja
on-line 2**.

Resultado depois da correção da seção 3.6 (rodada final, `qa-out/recarga-sites-4`):

| | portal público | loja on-line 1 | loja on-line 2 |
| --- | --- | --- | --- |
| convite | `reload-offer` | `reload-offer` | `reload-offer` |
| texto do convite | o pedido, na íntegra | o pedido, na íntegra | o pedido, na íntegra |
| botão do convite | "Mostrar sinais na versão atual" | idem | idem |
| desenhado só com o convite | 0 | 0 | 0 |
| sinais recolocados na leitura | 12 | 17 | 2 |
| precisos / na moldura | 12 / 12 | 17 / 17 | 0 / 2 |
| legenda de conferência | presente | presente | presente |
| destaque: primeira tentativa | convite | convite | convite |
| desenhado só com o convite do destaque | 0 | 0 | 0 |
| botão do convite do destaque | "Destacar na versão atual" | idem | idem |
| caixa desenhada | sim (sinal 21) | sim (sinal 2) | sim (sinal 120) |
| aviso do painel sobre o destaque | o pedido, na íntegra | o pedido, na íntegra | o pedido, na íntegra |
| ações depois do destaque | ir ao sinal + limpar | idem | idem |
| erros no roteiro | nenhum | nenhum | nenhum |

A coluna "na leitura" da loja on-line 2 é uma medida de instante, não o total final: a leitura acontece
assim que o painel anuncia a recolocação, e a captura `05c` tirada um segundo depois já mostra mais
argolas na mesma página (a mais dinâmica das três, que monta vitrines conforme a rolagem). Nas duas
outras páginas a leitura e a captura batem.

Antes da correção da seção 3.6, nas mesmas três páginas (rodada `qa-out/recarga-sites-1`): os sinais
recolocavam e a caixa do destaque era desenhada, mas o painel ficava sem o botão de limpar — o roteiro
registrava `CLICK_DENIED` nessa etapa nas três páginas, e a Port do painel caía também na abertura do
relatório (`CONTEXT_PROOF_DENIED`, uma ou duas vezes em cada página). Depois da correção, nenhuma das
três tem linha de erro.

As capturas `05b`–`05e` da rodada final foram abertas e conferidas. No portal público: `05b` mostra o
cartão do convite com o texto pedido e o botão "Mostrar sinais na versão atual"; `05c` mostra as
argolas reencontradas (82, 83, 84) sobre elementos reais da versão nova; `05d` mostra o detalhe com
"Ir ao elemento do sinal 21" e "Destacar na versão atual" (o convite, e nada desenhado); `05e` mostra a
caixa do destaque colada ao cartão do serviço que ela nomeia, com as argolas 21, 22 e 23 nas colunas de
serviços. Na loja on-line 1, `05b` mostra o mesmo cartão de convite, `05c` mostra as argolas reencontradas (2, 130,
28, 4, 3, 38, 40, 42, 44, 46, 17, 18, 19, 20, 21) sobre os elementos nomeados — a faixa de frete grátis,
os cartões de benefício, os botões — e `05e` mostra a caixa do destaque envolvendo exatamente a faixa
"Frete grátis e rápido na sua primeira compra", com a argola 130 logo acima dela. Na loja on-line 2, `05c` e `05e` mostram os sinais reencontrados no cabeçalho e nos cartões
(7, 117, 118, 119, 120, 122) e a caixa do destaque sobre o cartão "Máxima proteção e cobertura
aveludada", nomeando o achado. Nenhuma captura mostra sinal desenhado em área vazia.

---

## 6. Limitações

- **A contagem de sinais recolocados numa página real varia entre rodadas e dentro da mesma rodada.** É
  o próprio site que muda (a loja on-line 2 serviu páginas bem diferentes entre duas rodadas — 78
  achados com elemento numa, 21 na outra) e é o instante da leitura: numa página que monta vitrines
  conforme a rolagem, a leitura feita quando o painel anuncia a recolocação é menor que a captura
  tirada um segundo depois. O número da tabela é o da rodada registrada, não uma constante da página.
- **A recolocação é do quadro principal.** A estrutura do alvo só pode ser reconferida sem captura nova
  no quadro cujo documento o worker prova por identidade; achados dentro de iframe não são recolocados
  e entram em "não reencontrado nesta versão da página".
- **A oferta vive no worker.** Vence em 300 s e some se o worker for reiniciado (memória, não
  armazenamento). Nesse caso o painel volta a oferecer na tentativa seguinte — nunca recoloca sozinho.
- **Uma instabilidade foi observada e não se repetiu**: numa rodada da fixture (`recarga-fixture-7`), o
  primeiro destaque da parte normal (sem recarga) estourou o tempo de espera da caixa
  (`destacar-1: WAIT_TIMEOUT`). A rodada seguinte, sozinha e com o mesmo código, passou inteira; a
  máquina compartilha o navegador de teste com outras tarefas. Fica registrado como instabilidade de
  medição, não como defeito reproduzido.
- **A lista de intenções da sessão de leitura agora inclui `highlight`.** É uma ampliação de poder
  deliberada e restrita: a leitura continua sem "cancelar auditoria" e sem "confirmar pixels", e o
  destaque só acontece contra a ligação durável registrada e o documento vivo provado.
- O hash do pacote público (`test/release-package.test.js`) continua desatualizado enquanto o fonte
  muda; a reconstrução e a atualização do hash são do fechamento da versão.

---

## 7. Arquivos alterados

Produção: `src/background/page-relocation-offer.js` (novo), `src/core/evidence/locator-corroboration.js`
(novo), `page-markers-controller.js`, `highlight-controller.js`, `highlight-binding-store.js`,
`page-marker-projection.js`, `panel-port.js`, `service-worker.js`, `side-panel-intent-router.js`,
`target-capabilities.js`, `worker-protocol.js`, `chrome-adapter.js`, `src/browser/page-markers-overlay.js`,
`src/browser/highlight-overlay.js`, `src/panel/page-markers-session.js`, `panel-state.js`, `panel-view.js`,
`panel.js`, `highlight-action.js`, `panel-session-port.js`.

Roteiro e testes: `scripts/visual-qa.mjs` (passo `--reload-check`), `scripts/run-tests.mjs` (o e2e novo
entra na lista de Chrome real), 13 arquivos de teste existentes e 2 novos
(`test/background/page-relocation-offer.test.js`, `test/e2e/page-markers-reload-mv3.test.mjs`).
