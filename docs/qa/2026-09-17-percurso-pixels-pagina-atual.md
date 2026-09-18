# Percurso da página atual em modo de pixel: a auditoria não começa (achado medido)

Data: 17/09/2026. Chrome for Testing **152.0.7977.64** (macOS arm64), extensão carregada sem
empacotamento a partir desta árvore (1.1.40) e dos **bytes empacotados** das gerações 1.1.39 e 1.1.38.
Fixture local servida pelo próprio arnês de teste (`http://127.0.0.1:<porta>/p`), painel lateral
aberto pelo botão da extensão.

## O achado, em uma frase

Com o modo de evidência **Somente elementos** (`element-only`) ou **Evidência completa**
(`full-evidence`) selecionado, clicar em **Auditar a página atual** deixa o painel parado na tela
inicial: nenhuma confirmação de captura aparece, **nenhum trabalho é criado** e a auditoria nunca
conclui. No modo **Sem pixels** (`no-pixels`) o mesmo clique conclui e o painel chega a `result`.

## Medição

| Versão | Modo | Tela após 24 s | Botão de consentimento | Trabalho ativo (`chrome.storage.session`) |
| --- | --- | --- | --- | --- |
| 1.1.40 (árvore) | `no-pixels` | `result` | não se aplica | concluído |
| 1.1.40 (árvore) | `element-only` | `initial` | **nunca aparece** | **nenhum** |
| 1.1.40 (árvore) | `full-evidence` | `initial` | **nunca aparece** | **nenhum** |
| 1.1.39 (pacote) | `element-only` | `initial` | **nunca aparece** | **nenhum** |
| 1.1.38 (pacote) | `element-only` | `initial` | **nunca aparece** | **nenhum** |

O mesmo resultado nas três gerações mostra que **não é regressão dos incrementos da classe de
credencial**: é um defeito **preexistente** do percurso da página atual com pixels.

### Linha do tempo do modo `element-only` (sondagem a cada 500 ms)

```
depois do clique no modo   tela=initial  marcado=[element-only]  aria-disabled=null  disabled=false
+500 ms                    tela=running  (o começo FOI aceito e a tela de progresso apareceu)
+1000 ms                   tela=initial  marcado=[full-evidence]  <-- o painel voltou ao neutro
+1500 ms … +4000 ms        tela=initial  marcado=[full-evidence]
```

O seletor de modo **volta ao padrão** (`full-evidence`) junto com a tela: o estado do painel foi
substituído por um estado inicial neutro, não apenas re-renderizado.

## Mecanismo, com as fronteiras de código

1. `src/panel/panel.js:583` (`startAttachedAudit`) transiciona `START_REQUESTED` e o reducer
   (`src/panel/panel-state.js:149`) leva a tela a **`running`** — medido em +500 ms.
2. A porta de sessão do painel pede o *bootstrap*
   (`src/panel/panel-session-port.js:538`, pacote `{"type":"bootstrap"}`).
3. O trabalhador atende em `src/background/panel-port.js:942` (`handleHello`). Ele lê o registro de
   bootstrap da janela (`readBootstrap`, linha 957); **nesse instante o registro ainda não existe**
   (a auditoria acabou de ser pedida), então responde
   `packet('initial', null, null, null)` — linha **960**.
4. `src/panel/panel.js:857` (`receiveBootstrap`, ramo `value?.state === 'initial'`) aplica
   `BOOTSTRAP_INITIAL`, que **recria o estado neutro**: tela `initial`, modo de volta ao padrão.
5. Quando o pacote de pausa por consentimento chega, `src/panel/panel-session-port.js:418-425` exige
   correlação (`ready && auditId !== null && sessionId !== null`). O bootstrap ocioso **zerou**
   `auditId`/`sessionId`, então a porta se declara indisponível (`unavailable(port, true)`) e a
   jornada para. A confirmação de captura pressupõe `screen === 'running'` e
   `sessionStatus === 'privacy-paused'` (`src/panel/panel.js:258`) — nenhum dos dois sobreviveu.

Em outras palavras: **um bootstrap ocioso atrasado derruba o começo em curso**, e a pausa de
consentimento perde a correlação. O caminho tem a máquina certa para o caso oposto
(`deliverPrivacyPaused`, `src/background/panel-port.js:831`, que serve a pausa quando o bootstrap já
existe) — o que falta é a corrida em que a porta chega **antes** do registro.

## Por que não consertei aqui

O incremento paralelo **"Página atual sem interação visível"**
(`docs/superpowers/plans/2026-09-12-observed-page-passive.md`) declara, na seção C, que
"modos com pixels, confirmação/restart, destaque ao vivo, quatro exportações" **ainda não foram
demonstrados** por aquele caso — este achado é exatamente essa lacuna. As sete falhas de
`test/e2e/sidepanel-flow-mv3.test.mjs` na fase serial (`FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED`,
`WAIT_TIMEOUT`) são **este defeito**, não um oráculo obsoleto do arquivo alheio.

O caminho de conserto toca `src/panel/*` e o atendimento de bootstrap em `src/background/panel-port.js`,
fora dos arquivos congelados daquele incremento (`run-audit.js`, `authorized-audit-starter.js`) e fora
dos meus. Editar por cima enquanto o outro incremento trabalha a mesma jornada violaria a regra de
**nunca editar os mesmos arquivos em paralelo**; por isso o achado fica medido e declarado, e a
decisão de fronteira é do usuário.

### Direção de conserto sugerida (não aplicada)

- **Preferida:** em `handleHello`, quando **não** há registro de bootstrap para a janela, verificar
  se existe auditoria em curso para aquela janela (início em voo ou sessão em `running`/
  `privacy-paused`) e servir **esse** estado, em vez de `initial` — ou aguardar brevemente o registro.
- Complementar: em `panel-session-port.receive`, quando chega um pacote `privacy-paused` e a porta
  **não tem** correlação (`auditId === null && sessionId === null`), **adotar** os identificadores do
  pacote em vez de se declarar indisponível.
- Defensiva: em `receiveBootstrap`, **ignorar** um bootstrap `state: 'initial'` enquanto houver começo
  em voo (`screen === 'running'` e `auditId === null`) — um pacote ocioso atrasado não pode desfazer o
  pedido do usuário.
- Prova exigida: um E2E em Chrome real que, na página atual e em `element-only`, veja o botão
  `[data-intent="CONFIRM_PIXEL_CAPTURE"]` aparecer, confirme e chegue a `result`; o teste deve
  **reprovar** contra esta geração (é o oráculo que falta, e o mesmo defeito já reprova o arquivo do
  outro incremento).

## Reprodução

```
# 1.1.40, direto da árvore (um Chrome por vez):
AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  node --test /private/tmp/adv143/pixel-aria.test.mjs      # linha do tempo: running -> initial
  node --test /private/tmp/adv143/pixel-consent.test.mjs   # 24 s sem consentimento e sem trabalho
  node --test /private/tmp/adv143/pixel-port.test.mjs      # pacotes da porta: bootstrap-result initial

# bytes empacotados (o pacote não traz o arnês; copie `test/` para dentro da raiz extraída):
unzip -q -o release/audita-acessibilidade-1.1.39.zip -d /private/tmp/adv143/pkg139
cp -R test /private/tmp/adv143/pkg139/test
AUDITA_EXT_DIR=/private/tmp/adv143/pkg139 AUDITA_ROTULO=1.1.39 \
  AUDITA_E2E_CHROME="…/Google Chrome for Testing" node --test /private/tmp/adv143/pixel-version.test.mjs
```

## Medição vizinha — critério 4 (a auditoria não altera a página) no modo que conclui

Sonda `/private/tmp/adv143/criterio4.test.mjs`, página com elemento **fora da dobra**, foco e rolagem
não triviais (`scrollY=120`, `activeElement=#foco`) antes da auditoria. Linha de base colhida **depois**
de a largura do painel assentar (o painel estreita a viewport — isso é do Chrome, não da auditoria);
contadores de evento instalados na página antes do clique e observador de mutações em
`documentElement` (subtree, childList, attributes, characterData):

```
C4 tela=result amostras=5 divergentes=0
   eventos={"scroll":0,"focusin":0,"focusout":0,"resize":0,"keydown":0,"click":0,
            "mutacoes":0,"mutacoesAtributo":0}
   antes  {"clientWidth":894,"clientHeight":749,"scroll":[0,120],"foco":"foco","alvoRect":[40,2480,222,82]}
   depois {"clientWidth":894,"clientHeight":749,"scroll":[0,120],"foco":"foco","alvoRect":[40,2480,222,82]}
```

Ou seja: **na página atual e no modo sem pixels, a auditoria não rola, não move foco, não
redimensiona, não dispara eventos e não muta o documento** — a página observada fica como estava.
(Os modos com pixels não podem ser medidos nesta geração por não começarem: é o achado acima.)

## Tentativa de conserto de 17/09/2026 (rodada 147): dois consertos pontuais NÃO bastaram, e a causa raiz é de ordenação no STARTER

**O que foi tentado, com RED real observado antes de cada mudança:**

1. `src/panel/panel-session-port.js` — adotar a correlação (`auditId`/`sessionCapabilityId`) quando um pacote
   `privacy-paused` chega e a porta ainda **não tem** correlação (o atendimento respondeu ocioso antes de o
   registro existir).
2. `src/panel/panel.js` — ignorar um bootstrap OCIOSO durante uma auditoria **em curso**, porque ele recria o
   estado neutro e cancela a auditoria.

**Medições com as duas mudanças aplicadas** (Chrome 152, fixture local, sonda de linha do tempo a cada 500 ms):

```
depois do modo   tela=initial  marcado=[element-only]
+500 ms          tela=running  (começo aceito)
+1000 ms         tela=initial  marcado=[full-evidence]   <-- ainda cancelado
```

e o rastreamento da porta, com o painel já corrigido, mostra que **a pausa de consentimento nunca chega**:

```
S {"type":"bootstrap"}
R {"type":"bootstrap-result","state":"initial","auditId":null,"sessionCapabilityId":null,"result":null}
(nenhum pacote privacy-paused em 6 s; tela final = reconnecting)
chaves de sessão: audit-session-capability, panel-launch:index, panel-launch:record,
                  session-hmac-key, target-capability   <-- SEM `panel-bootstrap`
```

**Causa raiz medida:** o registro de bootstrap da janela (`audita:panel-bootstrap:v1:<windowId>`) — que é a
**pré-condição** para o trabalhador entregar a pausa ao painel (`deliverPrivacyPaused` exige
`readBootstrap`/`readSuspension` correlacionados) — **não existe** no momento da suspensão por consentimento.
Em `src/background/authorized-audit-starter.js`, a sequência é: a auditoria suspende por consentimento **antes**
de `registerPendingBootstrap` (linha 2326) e `publishRegisteredBootstrap` (linha 2356), que só rodam quando a
execução realmente começa. Logo, no modo de pixel da página atual a pausa é criada **sem registro** e não há
como ser entregue: a porta recebe `initial`, o painel não tem o que confirmar, e a auditoria nunca começa.

**Por que não consertei:** a correção é de **ordenação no starter** — registrar/publicar o bootstrap pendente
**antes** de qualquer suspensão por consentimento — e `authorized-audit-starter.js` está nos **arquivos
congelados** do incremento paralelo ("Página atual sem interação visível", incrementos A/B). Editar por cima
violaria a regra de nunca editar os mesmos arquivos em paralelo, e as duas mudanças que fiz no painel/porta,
embora corretas em si, **não fecham o percurso** — foram **revertidas** para não entregar meio conserto sem
prova. O achado fica com o incremento dono do arquivo, agora com causa raiz e rastro de pacotes medidos.

**Prova exigida do conserto:** E2E em Chrome real que, na página atual e em `element-only` **e**
`full-evidence`, veja `[data-action="confirm-pixel-capture"]` aparecer, confirme e chegue a `result`; ele deve
**reprovar** contra os bytes atuais (o oráculo que falta).


## CORREÇÃO DE 17/09/2026 (rodada 92) — o diagnóstico declarado acima estava ERRADO, e a revisão final mediu o comportamento real

**Retratação, para quem lê o documento de cima para baixo:** a causa declarada acima ("ordem do bootstrap",
com o registro publicado depois da suspensão) também **não** confere — a própria revisão leu a árvore e mediu
que as duas chamadas rodam **antes** de `execute()`. O que existe é uma **revogação**, sem pausa alguma, e a
causa dela **continua não medida** (detalhes na última seção deste documento). O trecho acima fica como está,
como registro do erro.

A revisão final integrada (subagente `ad8456dd`) mediu as três superfícies que este documento pede — tela do
painel, pacotes da porta e `chrome.storage.session` — em **dois fixtures**, e o percurso **depende do
fixture**. O que este documento afirmava ("não começa", "a confirmação nunca aparece", "a pausa é criada sem
registro") **não confere**:

**(a) Página COM sinal sensível** (`type="password"` + `data-audita-private`), `element-only`, página atual —
**o percurso começa, pausa, confirma e conclui**:

```
t=1s  tela=running  confirmar=true  status="Auditoria pausada. Confirme a captura de imagens ou cancele a auditoria."
      storage={job:"privacy-paused", session:"privacy-paused", bootstrap:"consumed",
               pixel:{state:"paused", cats:["password","private-marker"]}}
t=1s  >>> CONFIRMOU
t=2s  tela=result  botões=[OPEN_REPORT, NEW_AUDIT, SHOW_PAGE_MARKERS, SELECT_OCCURRENCE, HIGHLIGHT_PAGE_OCCURRENCE, …]
      storage={session:"result", bootstrap:"consumed"}
```

O registro de bootstrap **existe** (`state:"consumed"` com o `auditId` correto) junto com a suspensão
(`audita:pixel-capture:v1:<auditId>`, `state:"paused"`, categorias `["password","private-marker"]`).

**(b) Página SEM sinal sensível** (a fixture que este documento usava: `img` sem alt + `button` sem nome),
em `element-only` e `full-evidence` — a auditoria é **REVOGADA EM SILÊNCIO**:

```
t=1s  tela=reconnecting  status="Reconectando o painel à página atual."   storage={session:"revoked"}
t=2s  tela=initial       status="Escolha como iniciar a auditoria."       storage={session:"revoked"}
```

O despejo de `chrome.storage.session` mostra a sessão em `"revoked"` e a capacidade de alvo em
`"invalidated"`, e **não existe** `audita:active-audit-job`, `audita:panel-bootstrap` nem
`audita:pixel-capture` — nenhuma suspensão chega a ser criada, e **o usuário não recebe mensagem alguma**.

**Classificação corrigida do item:** o defeito remanescente não é "o percurso não começa", é **revogação
silenciosa, sem mensagem, quando a página não tem sinal sensível** — um Important de produto (falha silenciosa
no percurso principal de um modo oferecido na interface), na fronteira do incremento paralelo
(`authorized-audit-starter.js`, arquivo congelado por ele). O que **este** incremento fez: corrigiu o Critical
da classe de credencial introduzido na 1.1.45 (a fresta da flexão, na 1.1.46), registrou a medição do revisor
e **não** reivindica o conserto do starter.

**Prova exigida do conserto (inalterada e agora com oráculo do revisor):** E2E em Chrome real, na página atual,
em `element-only` **e** `full-evidence`, com uma fixture **sem** sinal sensível, exigindo ou a confirmação de
captura, ou uma mensagem explícita de por que a auditoria não prossegue — nunca o retorno silencioso ao neutro.


## CONSERTO DE 17/09/2026 (rodada 93, versão 1.1.47) — a revogação deixa de ser silenciosa: o painel explica, e a prova tem dentes

O oráculo que o revisor exigiu passou a existir, e o produto passou a cumpri-lo. O conserto é **do lado do
painel** (nenhum arquivo do incremento paralelo foi tocado):

- `src/panel/panel.js`: em `receiveBootstrap`, um bootstrap **ocioso** (`state:"initial"`) que chega com o painel
  em `running` **e sem pedido de cancelamento do usuário** significa que a tentativa não existe mais. Antes
  isso recriava o estado neutro **sem nada dizer**; agora o painel transita para `AUDIT_UNAVAILABLE` com a
  frase `A auditoria foi encerrada antes de concluir. Refaça a auditoria e, se o modo de imagem falhar de
  novo, use o modo sem pixels.`
- `src/panel/panel-state.js`: a mesma frase entra em `PANEL_UNAVAILABLE_REASONS` (o redutor recusa motivo que não
  esteja nessa lista). A frase é local nos dois módulos — o contrato de exportação do `panel-state.js` continua
  sendo só `createInitialPanelState`/`reducePanelState` — e o teste de unidade
  `aceita o motivo de auditoria encerrada e o projeta como indisponibilidade explícita` **reprova se as duas
  cópias divergirem**.
- `test/e2e/current-page-pixel-abort-mv3.test.mjs` (novo, em `REAL_CHROME_E2E` no plano de testes): fixture
  **sem** sinal sensível, `element-only` **e** `full-evidence`, aceitando a confirmação de captura, o
  `result` ou a tela `unavailable` com o motivo.

**A fronteira da mensagem, medida — e uma regressão que ela causou e que foi fechada na mesma versão.** A
primeira versão do conserto disparava a mensagem para **qualquer** bootstrap ocioso com o painel em `running`.
A suíte completa reprovou por causa disso: em `url-pixel-consent-mv3`, **cancelar durante a pausa** deixou de
voltar ao neutro e caiu na indisponibilidade (`cancel while paused removes only the owned tab and produces no
report`, `WAIT_TIMEOUT` de 31 s). O desfecho de quem **pede** para parar é o neutro, não uma falha a explicar.

A segunda tentativa estreitou a fronteira para `shouldShowPanelStartFailure` (o predicado de `running` **sem**
`auditId` correlacionado) e **também** reprovou — agora do outro lado: o E2E novo deixou de ver a mensagem. A
causa foi medida com uma **cópia instrumentada** da extensão (`/private/tmp/adv164/dbgext`; o repositório não
foi tocado): no caso da revogação o bootstrap ocioso chega com o painel em `running` **e `auditId` JÁ
PREENCHIDO** pelos pacotes de progresso —

```
[{screen:"initial", auditId:null, cargas:1},                                    ← bootstrap de entrada do painel
 {screen:"running", auditId:"c08060c6-…", hasReceivedBootstrap:true, cargas:2}]  ← o ocioso da revogação
```

—, de modo que "nenhuma auditoria correlacionada" **não** separa os dois casos. O que separa é o **pedido do
usuário**: `cancellationRequested` sobe antes de o painel enviar `PANEL_CANCEL_AUDIT` (antes do pedido, porque
o `bind` para ocioso precede o `intent-result` no caminho de aposentadoria da porta), é consumido no primeiro
bootstrap ocioso e é limpo a cada novo início de auditoria. Com essa fronteira os dois lados ficam verdes: a
mensagem aparece na revogação e o cancelamento volta ao neutro.

**Medição (Chrome for Testing 152.0.7977.64).** Contra esta árvore e contra a **raiz extraída do próprio pacote
1.1.47** (zip + `test/`), os dois modos passam em ~2 s:

```
✔ full-evidence  desfecho=unavailable (2883ms árvore / 2303ms pacote)
✔ element-only   desfecho=unavailable (2025ms árvore / 1996ms pacote)
```

E o caminho do cancelamento, medido no mesmo dia: `url-pixel-consent-mv3` **10/10**, com
`cancel while paused removes only the owned tab and produces no report` passando em **1,3 s** (era
`WAIT_TIMEOUT` de 31 s com a fronteira larga).

Contra os **bytes empacotados da 1.1.46** (não vacuidade), os dois reprovam e a falha **imprime a trajetória
observada** — é a mesma revogação silenciosa que a revisão descreveu, agora com nome:

```
telas observadas: [{"tela":"running"…},{"tela":"reconnecting"…},{"tela":"initial"…}]
```

**O que continua fora deste incremento — e a causa que a revisão REFUTOU.** A **causa raiz da revogação
continua não medida**. A hipótese que este documento declarava (a "ordem do bootstrap", com
`registerPendingBootstrap`/`publishRegisteredBootstrap` publicando o registro **depois** da suspensão) foi
**refutada pela revisão final da 1.1.45**, que leu a árvore: em `beginAuthorizedAudit` as duas chamadas (linhas
2326 e 2356) rodam **antes** de `execute()` (2385), que é onde o portão de privacidade pausa — a ordem estava
invertida. O que a revisão mediu no lugar: sem sinal sensível a auditoria é **revogada**
(`session:"revoked"`, `target-capability:"invalidated"`), **sem** `active-audit-job`, **sem**
`panel-bootstrap` e **sem** `pixel-capture` — não é "pausa sem registro", **não há pausa alguma**. Quem for
consertar precisa medir a **revogação**, não a ordem do bootstrap. O arquivo é do incremento paralelo. O que a
1.1.47 mudou é a consequência visível: uma página sem sinal sensível em modo de pixel já **não** volta ao neutro
em silêncio — o painel diz o que aconteceu e aponta o modo sem pixels.


## CONSERTO DEFINITIVO DE 17/09/2026 (versão 1.1.48) — a causa foi medida e o percurso de pixel CONCLUI em página sem sinal sensível

A 1.1.47 fechou o **silêncio** (a tela passou a explicar). Faltava a **cura**: numa página sem sinal sensível a
auditoria continuava sendo revogada. A causa foi medida ponta a ponta numa cópia isolada instrumentada
(`/private/tmp/adv165/root`; o repositório não foi tocado): o portão de privacidade **arma sem pausa**
(`preflight` em `src/background/pixel-privacy-gate.js`, `consentId` nulo e sem sinal detectado), a captura de
pixel acontece, e no commit terminal a guarda **D2** (`commitTerminal` em `src/background/service-worker.js`)
recusa o modelo que carrega raster porque o **companheiro durável da tentativa** não existe — ele só era criado
no caminho de retomada pós-consentimento (`prepareResume`). O erro subia mascarado
(`TERMINAL_COMMIT_DENIED` → `OBSERVED_RUNNER_DENIED` → `ATTACHED_AUDIT_EXECUTION_DENIED`) e a recuperação
interrompia a auditoria inteira.

**O conserto (1.1.48):** a captura autorizada sem pausa ganha o seu **próprio** companheiro durável — a
**tentativa direta**, com digesto em domínio separado (`audita:pixel-direct-attempt:v1`, derivado só do
`auditId`), criada quando o portão arma sem pausa e **antes de qualquer raster**. A guarda D2 continua
**intacta**: nenhum raster entra sem companheiro. Decisão e medições completas em
`docs/qa/2026-09-17-tentativa-direta-pixel-sem-consentimento.md`.

**Medições (Chrome for Testing 152.0.7977.64):** numa página sem sinal sensível, `full-evidence` e
`element-only` chegam a **`result` em ~1 s** (antes: `unavailable`); o caminho **com** sinal sensível continua
pausando, confirmando e concluindo; duas auditorias seguidas na mesma sessão concluem sem marcador residual; o
oráculo novo (`test/e2e/current-page-pixel-consent-free-mv3.test.mjs`) **reprova contra os bytes da 1.1.47** e
passa nesta árvore; o escopo serial de 13 arquivos segue **59/59**.
