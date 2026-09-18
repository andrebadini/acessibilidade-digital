# Parecer adversarial — **Conserto A** ("tentativa direta") nos bytes da **1.1.48**

Revisor independente. Data: 17/09/2026. Chrome for Testing **152.0.7977.64** (macOS arm64), um Chrome por
vez; a partir da coordenação do autor, em **headless** (`AUDITA_E2E_CHROME=/private/tmp/adv169/chrome-quiet`).
Nada foi escrito dentro do repositório do autor; `authorized-audit-starter.js` foi lido e medido, nunca
editado por mim.

## 0. Objeto sob revisão e proveniência

| | |
| --- | --- |
| Artefato | `release/audita-acessibilidade-1.1.48.zip` — **199 arquivos**, manifesto **1.1.48** |
| Digest medido | `c519a33be4136eed1d5df8a2e04d1d31407f5be4585722743536648d73482ba4` — **confere** |
| Commit do artefato | **`9ef2221`** (o zip commitado tem o mesmo digest; `833281e` e `fea1c38` depois dele não tocam `src/` nem o zip) |
| Reprodutibilidade (meu O-1) | **FECHADO** — reconstruí num clone meu: `node scripts/build-release.mjs` a partir de `9ef2221` devolve o digest `c519a33b…` e o arquivo é **byte a byte igual** ao entregue; `git status -- release/audita-acessibilidade-1.1.48.zip` no clone ficou **limpo** |
| Árvore de medição | `/private/tmp/audita-review-148/pkg148` = zip 1.1.48 + harness/testes do worktree (copiados por mim) |
| Evidência | `/private/tmp/audita-review-148/evidence/` · Sondas: `…/probes/` |

---

## 1. Veredito em uma linha

**NÃO PODE ENTRAR como está.** O conserto A está correto no desenho e a guarda D2 está intacta, mas **a
aposentadoria da tentativa direta não funciona no caminho do portão** (assinatura trocada entre o
_starter_ e o ciclo de vida): no cenário que o A-1 descreve, a 1.1.48 **revoga a auditoria sem oferecer a
pausa de consentimento** e deixa um marcador residual — regressão contra a 1.1.47, que no mesmo cenário
pausa, consente e conclui. É **uma linha** de conserto mais um teste que cruze a fiação real.

---

## 2. Achado bloqueante

### A-2 — **Important (bloqueia a entrada)** — `retireDirect` é chamado com objeto e implementado para string; o gancho do portão sempre falha

**Código:** `src/background/authorized-audit-starter.js:2352` chama
`pixelAttemptLifecycle.retireDirect({ auditId: args.auditId })`; o ciclo de vida define
`service-worker.js:558` `async function retireDirectAttempt(auditId)` e usa
`input.attemptAuthority.digestDirectAttempt({ auditId })`. Com o objeto, o digesto recebe
`{ auditId: { auditId } }`, a validação de registro exato falha e a autoridade rejeita com
`PIXEL_DIRECT_ATTEMPT_DIGEST_INVALID`.

**Prova unitária (módulos reais: ciclo de vida + autoridade + correlação + store em memória)** —
`probes/p148-retire.test.mjs` e `scratch/prova-assinatura.mjs`:

```
retireDirect({auditId}) — como o starter chama: THROW PIXEL_DIRECT_ATTEMPT_DIGEST_INVALID
retireDirect("A1")      — string crua: OK   (marcador removido)
```

O único caminho que funciona é a **rede de segurança** do `prepareResume`
(`retireDirectAttempt(request.auditId)`, string crua — `service-worker.js:581`).

**Consequência medida no produto (Chrome, sonda determinística
`probes/p148-deterministico.test.mjs`, gatilho pelo aparecimento do marcador direto):**

| bytes | gatilho | pausa de consentimento? | desfecho | marcadores ao fim |
| --- | --- | --- | --- | --- |
| **1.1.48** | marcador (0,05 s) → senha injetada (0,15 s) | **NÃO aparece** (120 s) | `unavailable`, sessão `revoked`, sem suspensão | **1** (o direto fica) |
| **1.1.48** | idem, variante cancelar | **NÃO aparece** | nada a cancelar; sessão `revoked` | **1** |
| **1.1.48** | timer da própria página (1,2 s) | **NÃO aparece** | `unavailable@2,5 s`, `revoked` | **1** |
| protótipo v1 (sem aposentadoria) | marcador (0,05 s) → senha (0,14 s) | **sim, em 2,16 s** | consentiu → **travado em `running`** (155 s) | **2** |
| **1.1.47 congelada** | timer da própria página (1,2 s) | **sim, em 2,5 s** | consentiu → **`result@12,6 s`** | 1 (consentido, limpo depois) |

Evidência: `evidence/det-148-confirmar.txt`, `det-148-cancelar.txt`, `colisao-148.txt`,
`det-v1-confirmar.txt`, `colisao-147.txt`.

**Leitura:** o gancho do portão é o **primeiro** dos dois pontos de aposentadoria e é o que cobre o A-1 e o
A-1b (cancelamento). Como ele lança, o portão vai a `failed` e a execução é negada **antes** de criar a
pausa: o usuário perde o caminho de consentimento, a auditoria é revogada e o marcador direto fica para
trás (higiene). Nos bytes do protótipo (sem aposentadoria nenhuma) o mesmo cenário chega a pausar e trava
com **dois marcadores** — exatamente o A-1 que eu havia medido.

**Por que a bateria do autor não pegou:** nenhum teste cruza a fiação real no caminho do gancho —
`pixel-privacy-gate.test.js` usa **espiões** (`async onRetireDirect() { sequence.push('retired'); }`);
`authorized-audit-starter.test.js` **dubla** o ciclo de vida (`async retireDirect() { return true; }`);
`pixel-attempt-terminal-commit.test.js` exercita a colisão pela **rede de segurança** do `prepareResume`
(string crua). Confirmado por leitura dos três arquivos no zip.

**Conserto mínimo (uma linha), à escolha:**
1. No _starter_: `pixelAttemptLifecycle.retireDirect(args.auditId)` — alinha com a assinatura atual; **ou**
2. No ciclo de vida: aceitar o pedido como os demais pontos (`exact(raw, ['auditId'])`), mantendo a API
   uniforme (`prepareDirect`/`prepareResume` já recebem objeto).

**Teste que faltava (e que eu deixei pronto):** `probes/p148-retire.test.mjs` (assinatura, aposentadoria da
direta, consentida intacta) e `probes/p148-deterministico.test.mjs` (fiação real: starter → portão →
ciclo de vida, com o gatilho no marcador). Qualquer um dos dois reprova contra os bytes atuais.

---

## 3. O que está sólido (medido, não afirmado)

| Verificação | Resultado |
| --- | --- |
| **Guarda D2** | raster sem alça → `TERMINAL_COMMIT_DENIED`, armazenamento **não chamado**; alça de outra auditoria e 4 formas de alça forjada → recusadas; sem raster sem alça → aceito; raster com alça direta → aceito e `terminal`. `commitTerminal` **byte-idêntico** ao da 1.1.47 (`evidence/diff-commitTerminal-147-148.txt`, 0 linhas) |
| **Direta ≠ consentimento** | `classify` com `consentId` nulo = `prepared`; com qualquer `consentId` = `blocked`; `prepare` recusa consentId malformado e `pageId`/`ownershipId` não nulos; `prepareDirect` recusa chaves extras; sem contaminação cruzada (A=`prepared`, B=`absent`); idempotente |
| **Aposentadoria (quando chamada certo)** | `retireDirect('id')`: remove a direta, **não toca a consentida**, no-op sem marcador; colisão direto+consentido termina com 1 marcador, commit aceito, companheiro só o consentido, `cleanup` deixa **0** |
| **Jornada (1.1.48, headless)** | página **sem** sinal sensível: `full-evidence` **`result@2,0 s`**, `element-only` **`result@1,0 s`**, sem confirmação; página **com** sinal: pausa → confirma → **`result@2,0 s`**; sessão `result`, **0** chaves `pixel-capture`, exportação dos 4 formatos com recibo |
| **Artefatos** | varredura dos 4 formatos entregues: **0** ocorrências de `audita:pixel-attempt`, `pixel-direct-attempt`, `hmac-sha256`, `capabilityId`, `consentId` |
| **Higiene** | duas auditorias seguidas na mesma sessão: **2× `result`**, 0 marcadores ao fim de cada (`evidence/duas-auditorias-148.txt`) |
| **`url-pixel-consent-mv3`** | **10/10** nos bytes empacotados, incluindo `cancel while paused removes only the owned tab and produces no report` (1,2 s) e a retomada pós-reinício do trabalhador |
| **E2E novo do autor** (`current-page-pixel-consent-free-mv3`) | **2/2** nos bytes empacotados (2,48 s e 2,47 s) |
| **Testes novos do autor** | 224/224 nos quatro arquivos-chave; **com dentes**: desligar a aposentadoria por mutação reprova `pixel-attempt-terminal-commit.test.js`; remover o gancho do portão reprova `pixel-privacy-gate.test.js` |
| **Proveniência/O-1** | reconstrução byte a byte do zip a partir de `9ef2221` (acima) |

---

## 4. Outros achados

* **O-1 — fechado.** O zip 1.1.48 deixa de ser órfão de commit: `9ef2221` contém o fecho do A-1 e o pacote,
  e a reconstrução reproduz o digest. (Na fotografia anterior, 3 arquivos de `src/` estavam fora do
  commit e o artefato não era reconstruível — registrado e agora resolvido.)
* **Observação (higiene) — marcador residual quando a aposentadoria falha.** No caminho quebrado do A-2, o
  marcador direto fica em `chrome.storage.session` (bounded: morre com a sessão do navegador e é por
  `auditId`). Consertado o A-2, o resíduo desaparece (medido: 0 nas duas auditorias seguidas e no
  `cleanup`).
* **Observação (coordenação) — flake por concorrência.** Durante a revisão houve janelas com dois Chromes
  (o meu e o do autor) e o próprio autor relatou três E2E de credencial estourando por tempo limite nessa
  condição; as minhas medições foram refeitas com exclusividade (headless) e as que sustentam o veredito
  estão listadas acima. A suíte completa/escopo nos bytes 1.1.48 é do autor; eu não a repeti.

---

## 5. O que **não** foi medido

* A **suíte completa** e o **escopo serial** nos bytes 1.1.48 (rodei os arquivos que sustentam o parecer:
  jornada, colisão/A-1, A-1b, duas auditorias, `url-pixel-consent-mv3` e o E2E novo do autor).
* **Auditoria ao vivo no Google** nos bytes 1.1.48 e o gate `verify` (o autor declarou; não re-executei).
* O **cancelamento logo após a aposentadoria bem-sucedida** (com o A-2 corrigido) — o caminho atual nem
  chega a aposentar pelo gancho; depois do conserto, a variante cancelar da minha sonda determinística é a
  medida que falta.
* Regiões fora da viewport, `deviceScaleFactor ≠ 1`, impressão física e teste com pessoa leiga.

---

## 6. Veredito final

**O conserto A pode entrar no produto? SIM**, nos bytes `7da8b3f0…` (commit `39c86c0`, reconstruível).

O que sustentava o "não" anterior — A-2 — está fechado e verificado por medição própria nos três níveis
(unidade, fiação real em Chrome e o E2E do autor com não vacuidade), e o defeito de processo que apareceu
nesta rodada (A-3, o E2E fora do plano de testes, que abortava `npm test`/`verify`) também está fechado e
reconferido. A guarda D2 segue intacta (byte-idêntica à 1.1.47 e provada nos seis casos), a tentativa
direta não vira consentimento em nenhuma fronteira, a jornada conclui com foto nas páginas sem sinal
sensível, o cancelamento durante a pausa que nasce depois do armar liquida sem resíduo, e `url-pixel-consent`
segue 10/10.

Ficam registradas duas observações sem efeito de bloqueio (assimetria de assinatura do `retireDirect` e a
janela assíncrona de limpeza do marcador) e a única coisa que **não** medi nesta rodada: a suíte completa, o
escopo de 16 arquivos no pacote, o gate `verify` e a auditoria ao vivo sobre estes bytes novos — o autor
roda isso na janela dele, agora com exclusividade.
