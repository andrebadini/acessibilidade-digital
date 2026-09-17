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
