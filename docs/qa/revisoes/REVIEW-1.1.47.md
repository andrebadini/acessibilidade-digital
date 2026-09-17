# Revisão independente — Audita Acessibilidade **1.1.47** (fechamento do I-1 da 1.1.45)

Revisor independente. Data: 17/09/2026. Chrome for Testing **152.0.7977.64** (macOS arm64), **um Chrome por
vez**, `--test-concurrency=1`. Nada foi escrito dentro do repositório do autor; `authorized-audit-starter.js`
não foi editado (só lido e medido).

| | |
| --- | --- |
| Artefato | `release/audita-acessibilidade-1.1.47.zip`, 199 arquivos, versão `1.1.47` no manifesto |
| Digest medido | `2bb01b211cbf79d21fd9692f680931014d4762161d4731ab796298cade9347ac` — **confere** |
| Commit do artefato | **`ee9eb80`** (worktree `audita-mt`, branch `feature/audita-mt`) |
| Clone | `git clone --no-hardlinks --local <worktree> /private/tmp/audita-review-147/clone` |
| Árvore de medição | `/private/tmp/audita-review-147/pkg147` = zip extraído + `test/ scripts/ fixtures/ docs/ store-assets/ node_modules` (axe-core 4.13.0) |
| Evidência | `/private/tmp/audita-review-147/evidence/` |
| Sondas | `/private/tmp/audita-review-147/probes/` |

**Commit posterior conferido:** `5cab932` e `f4ca492` (HEAD) são **só documentação** —
`git diff --stat ee9eb80..HEAD -- src test scripts manifest.json release` está **vazio** e o digest do zip
não mudou. O artefato sob revisão continua sendo o de `ee9eb80`.

---

## Veredito: **I-1 ATENDIDO**

O I-1 pedia que o percurso da página atual em modo de imagem, quando não pode prosseguir, **ou** mostrasse a
confirmação de captura **ou** explicasse o que aconteceu — **nunca** o retorno silencioso ao neutro. Medi as
três pontas (oráculo binário próprio com controle de não vacuidade; cancelamento; classe de credencial) e o
requisito está cumprido nos bytes empacotados. Restam **1 Minor novo** (a mensagem não é acionável a partir da
própria tela que a mostra) e observações.

---

## 1. O oráculo binário (item 1 do pedido)

**Comando:** `AUDITA_EXT_PATH=/private/tmp/audita-review-147/pkg147 AUDITA_EXT_TAG=1.1.47 node --test --test-concurrency=1 probes/p147-oraculo.test.mjs`
(sonda minha, não o E2E do autor; fixture **sem** sinal sensível — nenhum campo de senha, nenhum marcador
privado; amostragem a cada 500 ms por 20 s; saída em `evidence/orac-147.txt`).

| bytes medidos | modo | trajetória observada | desfecho |
| --- | --- | --- | --- |
| **1.1.47 (zip)** | `full-evidence` | `running(92%)` → `reconnecting` → `unavailable` + mensagem, estável até 20 s | **MENSAGEM@1,5 s** |
| **1.1.47 (zip)** | `element-only` | `running` → `unavailable` + mensagem, estável até 20 s | **MENSAGEM@1,0 s** |
| 1.1.46 (`/private/tmp/adv162/run`, não vacuidade) | `full-evidence` | `running` → `reconnecting` → `initial` → … | **NEUTRO_SILENCIOSO@1,5 s** |
| 1.1.46 (não vacuidade) | `element-only` | `running` → `initial` → … | **NEUTRO_SILENCIOSO@1,0 s** |
| 1.1.45 (zip da revisão anterior, não vacuidade) | `full-evidence` | `running` → `reconnecting` → `initial` → … | **NEUTRO_SILENCIOSO@1,5 s** |
| 1.1.45 (não vacuidade) | `element-only` | `running` → `initial` → … | **NEUTRO_SILENCIOSO@1,0 s** |

Mensagem medida no estado final (literal, do DOM do painel):

```
A auditoria foi encerrada antes de concluir. Refaça a auditoria e, se o modo de imagem falhar de novo,
use o modo sem pixels.
```

A sonda tem dentes: contra a 1.1.46 e a 1.1.45 ela reproduz **exatamente** o defeito que eu havia medido na
revisão final da 1.1.45 (`running` → `[reconnecting]` → `initial`, sem mensagem). Contra a 1.1.47, os dois
modos terminam em mensagem explícita e **permanecem** nela.

**E2E do autor executado por mim** (`test/e2e/current-page-pixel-abort-mv3.test.mjs`, nos bytes empacotados):
**2/2 ✔** — `full-evidence` 4,41 s e `element-only` 2,09 s (`evidence/e2e-autor-abort-147.txt`).

## 2. O cancelamento continua correto (item 2)

**Comando:** `node --test --test-concurrency=1 test/e2e/url-pixel-consent-mv3.test.mjs` (pkg147).
**Resultado: `ℹ tests 10 · pass 10 · fail 0`** (35,0 s), incluindo os subtests que o autor disse terem sido
quebrados pela primeira versão da fronteira:

```
✔ full-evidence persists no raster before consent and rehydrates after worker restart (19,1 s)
✔ element-only omits the full page and explains the factual limitation (13,3 s)
✔ cancel while paused removes only the owned tab and produces no report (1,70 s)
✔ navigation A to B while paused denies consent, removes the owner and produces no report (0,80 s)
```

O caso "cancelar durante a pausa" volta ao neutro (`initial`), não à indisponibilidade — a fronteira por
**pedido do usuário** (`cancellationRequested`) funciona.

**O caminho que já funcionava não foi roubado pela fronteira nova** (mesma sonda, cenário A com fixture
**sensível**: `password` + `data-audita-private`, `element-only`, página atual):

```
PIX145 A-sensivel-element-only t=1s >>> CLICOU CONFIRMAR
PIX145 A-sensivel-element-only RESULTADO final=result confirmou=true
```

(`evidence/confronto-147.txt`.) Ou seja: com sinal sensível a pausa de consentimento continua chegando, o
botão de confirmação aparece em menos de 1 s, o clique confirma e a auditoria conclui — a mudança só afeta o
bootstrap **ocioso** durante uma auditoria em curso sem pedido de cancelamento.

## 3. A classe de credencial não regrediu (item 3)

* `git diff acd408b..ee9eb80 -- src/core` → **vazio** (0 linhas), conferido no clone; `src/` da 1.1.47 toca
  apenas `src/panel/panel.js` e `src/panel/panel-state.js`.
* Medição **nos bytes empacotados** (não por leitura), com as minhas sondas das rodadas anteriores:

| sonda | resultado na 1.1.47 | referência |
| --- | --- | --- |
| `p147-classe-flexao.mjs` (896 formas família+flexão) | **196 / 196 / 196** (trecho/modelo/JSON) | 1.1.44 aprovada: 196/196/196 · 1.1.45: 478/478/268 |
| `NOVOS vs 1.1.44` | **0 / 0 / 0** | — |
| `p147-residual-secretos.mjs` (`secreto*`+S, 182 formas) | **0** | 1.1.45: 14 |
| `p147-v143-shapes.mjs` (18 formas × superfícies) | **0/18** em todas, `REABERTOS=0` | 1.1.42: 16/18 |
| `p147-v143-context-stack.mjs` | **tarja em todos os casos** (trilha, modelo colunar, profundidades 1-12) | — |
| `p147-v143-recall-198k.mjs` (198.360 identificadores) | **`VAZA=6.707`** com `REABERTOS_vs_41=0` e `vs_42=0` | idêntico à 1.1.44/1.1.45 |
| `p147-v143-precision.mjs` (25 ids PT-BR) | **20/25** destroem texto (preço declarado) | declarado |

## 4. A mensagem satisfaz o I-1 (item 4)

* **Diz o que aconteceu:** "A auditoria foi encerrada antes de concluir." — sem jargão e sem código interno.
* **Diz o que fazer:** "Refaça a auditoria e, se o modo de imagem falhar de novo, use o modo sem pixels." —
  as duas ações existem no produto: `Tentar novamente` (`RETRY`) e `Iniciar nova auditoria`
  (`START_ATTACHED`) estão na tela; e o caminho sugerido foi medido ponta a ponta (ver abaixo).
* **Não promete o que não cumpre:** o modo sem pixels conclui — medi `no-pixels` → `result` depois da falha
  (`evidence/acao-novamente-147.txt`, auditId `6e2faa40-…`).
* **Não vaza dado:** varredura do DOM no estado de indisponibilidade:
  `{"vazaUrl":false,"vazaUuid":false,"vazaSegredo":false}` (nada de `127.0.0.1`/`http://`, nenhum UUID de
  auditoria, nenhum `capabilityId`/`consentId`/`hmac-sha256`/`navigationToken`) — `evidence/acionavel-147.txt`.
* **Acessibilidade da mensagem:** o motivo entra na `liveRegion` do painel e é o mesmo texto do parágrafo
  visível (contrato conferido no código: `renderUnavailable` usa `view.reason` nos dois lugares).

## 5. A causa raiz declarada e o alcance da mudança (item 5)

**A causa raiz declarada continua sem sustentação — e o autor já a retratou.** Medi:

1. `authorized-audit-starter.js` **não foi tocado**: `git diff --stat 13c97d1..ee9eb80 -- src/background/authorized-audit-starter.js` = **vazio** (e `acd408b..ee9eb80 -- src/background` = vazio). As chamadas
   `registerPendingBootstrap`/`publishRegisteredBootstrap` seguem nas mesmas linhas (1883/1913, 2077/2117,
   **2326/2356**), **antes** de `execute()` (2385) — a ordem que o documento declarava como causa está
   inalterada.
2. A **revogação continua acontecendo** na 1.1.47: despejo de `chrome.storage.session` na página sem sinal
   sensível (`probes/p147-revogacao.test.mjs`, `evidence/revog-147.txt`):
   `audita:audit-session-capability:v1:…` com `"state":"invalidated"`, e **sem** `audita:active-audit-job:v1`,
   **sem** `audita:panel-bootstrap:v1:*` e **sem** `audita:pixel-capture:v1:*` — o mesmo quadro da 1.1.45, em
   que a sessão terminava `revoked`.
3. Ou seja: **a 1.1.47 mudou a consequência visível, não a revogação**. Era exatamente o que o I-1 pedia
   (nunca o silêncio); a cura do percurso de pixel segue em aberto.
4. O commit `f4ca492` (só `docs/qa/*.md`) retrata a hipótese da ordem do bootstrap e passa a declarar a causa
   raiz como **não medida**, citando a minha medição — conferido: nenhum byte de produto/artefato mudou.

---

## 6. Achados novos

### N-1 — **Minor** — a mensagem não é acionável a partir da tela que a mostra

**Medição** (`probes/p147-acionavel.test.mjs`, `evidence/acionavel-147.txt`; bytes empacotados):

```
1. após a falha:              tela=unavailable  motivo="A auditoria foi encerrada antes de concluir… use o modo sem pixels."  seletorModo=false
2. depois de RETRY (+4 s):    tela=unavailable  motivo="Não foi possível concluir a operação local."                          seletorModo=false
3. depois de "Iniciar nova auditoria" (+4 s):
                              tela=unavailable  motivo="A auditoria foi encerrada antes de concluir… use o modo sem pixels."  seletorModo=false
```

* `Tentar novamente` mantém a tela e **troca o motivo específico pelo genérico** ("Não foi possível concluir
  a operação local."): o usuário perde justamente a instrução do modo sem pixels na primeira tentativa de
  retomar.
* `Iniciar nova auditoria` reinicia com o **mesmo modo** (`full-evidence`, porque a tela de indisponibilidade
  não renderiza o seletor de modo) → falha de novo → mesma tela. É um laço.
* **Caminho de recuperação medido** (existe, mas não está na tela): clicar de novo no ícone da extensão
  devolve `initial` **com o seletor de modo** (`seletorModo=true`) e, escolhendo `no-pixels`, a auditoria
  **conclui** (`result`, auditId `6e2faa40-e686-4481-8766-b4ca6f4d381d`) — `evidence/acao-novamente-147.txt`.

**Por que Minor e não Important:** o requisito do I-1 (nunca em silêncio) está cumprido; não há perda de dado
nem promessa falsa (o caminho sugerido funciona); e há recuperação em um clique no ícone. O defeito é de
affordance: a tela que dá o conselho não oferece o botão para segui-lo. **Sugestão mínima:** na tela
`unavailable`, um terceiro caminho "Escolher outro modo"/voltar a `initial` (ou preservar o motivo
específico no `RETRY`).

### N-2 — Observação — documentação e escopo

* A retratação da causa raiz (`f4ca492`) e o registro da revisão da 1.1.45 (`8ad96ef`) estão coerentes com a
  minha medição; a afirmação de que `src/`, `test/`, `scripts/`, `manifest.json` e o zip não mudaram depois de
  `ee9eb80` **confere**.
* O worktree tem `test/e2e/sidepanel-flow-mv3.test.mjs` modificado e **fora** do commit (arquivo do incremento
  paralelo). Não faz parte do zip (199/199 conferidos) e não foi medido por mim; se ele for commitado depois,
  não altera este artefato.

---

## 7. O que **não** foi medido

* A suíte completa e o escopo serial da 1.1.47 (medi o arquivo que o pedido destacou — `url-pixel-consent-mv3`
  10/10 —, o E2E novo do autor 2/2, o gate `verify` GREEN e as sondas de credencial; não repeti os 4.180
  unitários nem os 41 arquivos de Chrome).
* O caminho de fechar o painel pelo "X" do Chrome e reabrir (simulei a recuperação pelo clique no ícone da
  extensão, que é o caminho que o usuário tem à mão e que **funciona**).
* Regiões fora da viewport, `deviceScaleFactor ≠ 1`, impressão física e teste com pessoa leiga (inalterados
  desde a revisão da 1.1.45).
* A causa raiz da revogação continua **não medida por mim** — o que medi é que ela **não é** a ordem do
  registro de bootstrap (starter intocado, sem pausa criada, sessão invalidada).

---

## 8. Veredito final

**I-1 ATENDIDO.** A 1.1.47 pode substituir a 1.1.46 no que diz respeito a este item: nos bytes empacotados,
nos dois modos de imagem e numa página sem sinal sensível, o painel **sempre** explica o encerramento
(nunca volta ao neutro em silêncio), o cancelamento pedido pelo usuário continua voltando ao neutro
(`url-pixel-consent-mv3` 10/10), a classe de credencial está idêntica à 1.1.44 aprovada nas minhas sondas
(896 formas: 0 novas; `secreto*`: 0; 198.360: 6.707 com 0 reabertos), o gate segue GREEN e o pacote confere
byte a byte com o commit. Fica **um Minor novo (N-1)** — a mensagem não é acionável a partir da própria tela
de indisponibilidade — que **não bloqueia** o fechamento do I-1, mas deve entrar no registro de achados.
A revogação em si (a causa) continua em aberto e agora está declarada como não medida.
