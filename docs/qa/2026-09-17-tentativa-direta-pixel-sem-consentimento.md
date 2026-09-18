# Tentativa direta — a captura de pixel que o portão autoriza SEM consentimento (1.1.48)

Data: 17/09/2026. Versão do conserto: **1.1.48**. Documento de decisão e de medição. O defeito que ele fecha
está descrito em `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md` e foi medido com sonda instrumentada numa
cópia isolada (`/private/tmp/adv165/root`; o repositório não foi tocado durante a medição).

## 1. A causa, medida ponta a ponta

Numa página **sem** sinal sensível, o percurso de pixel da página atual **não concluía**. A cadeia, na ordem em
que foi observada (rastro `audita:diag:v1` na cópia instrumentada):

1. O portão de privacidade **arma sem pausa**: `preflight` em `src/background/pixel-privacy-gate.js` recebe
   `consentId` nulo e **não** detecta sinal sensível, então devolve `{status:'armed'}` e a captura de pixel
   segue — como deve ser: sem nada sensível, não há o que autorizar.
2. A auditoria roda e monta o modelo, que **carrega raster** (é o modo de evidência completa/elementos).
3. No commit terminal, a guarda **D2** — `commitTerminal` em `src/background/service-worker.js`, criada na
   revisão da 1.1.37 — recusa gravar um modelo com raster quando não existe o **companheiro durável** da
   tentativa (`metadata === null`). Esse companheiro só era criado no caminho de **retomada
   pós-consentimento** (`prepareResume`, chamado depois de a pessoa confirmar a pausa).
4. O erro sobe mascarado: `TERMINAL_COMMIT_DENIED` (guarda) → `OBSERVED_RUNNER_DENIED`
   (`observed-tab-runner.js`) → `ATTACHED_AUDIT_EXECUTION_DENIED` (`run-audit.js`, porque a persistência
   terminal já tinha começado).
5. A recuperação encontra o trabalho em `finalizing` **sem suspensão de pixel** e **interrompe** a auditoria:
   sessão `revoked`, capacidade `invalidated`, sem `active-audit-job`, sem `panel-bootstrap` e sem
   `pixel-capture`. O painel volta ao neutro.

O último passo é o que o usuário via: **em silêncio** até a 1.1.47; **com a explicação** a partir dela.

**Prova de que a guarda era o único bloqueio:** numa passagem **só de diagnóstico**, a guarda foi desligada na
cópia isolada e o painel chegou a `result` em ~1 s nos dois modos; com a guarda religada e **sem** o conserto,
volta a morrer. O patch entregue **não** contém esse relaxamento.

## 2. O conserto: tentativa direta

A captura que o portão autoriza sem pausa passa a ter o **seu próprio** companheiro durável, criado **antes de
qualquer raster**:

| Arquivo | Mudança |
| --- | --- |
| `src/core/privacy/session-url-digest.js` | digesto da tentativa direta em **domínio próprio** (`audita:pixel-direct-attempt:v1`), derivado só do `auditId`; exposto em `digestDirectAttempt` na mesma autoridade da sessão |
| `src/background/pixel-attempt-correlation.js` | `prepare` aceita `consentId` **nulo** e, nesse caso, exige alvo **anexado** (`pageId` e `ownershipId` nulos) e usa o digesto direto; o marcador e a capacidade são os mesmos do caminho consentido |
| `src/background/service-worker.js` | `prepareDirect({auditId, expiresAt})` no ciclo de vida da tentativa, com a mesma validação e o mesmo marcador |
| `src/background/pixel-privacy-gate.js` | gancho **opcional** `onArmedDirect`, chamado só quando o portão arma com `consentId` nulo e sem sinal detectado |
| `src/background/authorized-audit-starter.js` | liga o gancho no caminho **anexado** e guarda a alça no registro da auditoria (é ela que o commit terminal lê) |

**O que NÃO mudou:** a guarda D2 continua exigindo companheiro para todo raster; o caminho consentido
(pausa → confirma → `result`) é o mesmo; nenhuma suspensão de pixel é criada para a tentativa direta; nada é
aceito para alvo de posse/página (URL, lote).

## 3. Medições (Chrome for Testing 152.0.7977.64, um Chrome por vez)

| Medida | 1.1.47 (antes) | 1.1.48 (com o conserto) |
| --- | --- | --- |
| Página limpa, `full-evidence`, página atual | `unavailable` (auditoria revogada) | **`result` em ~1 s** (`current-page-pixel-consent-free-mv3`) |
| Página limpa, `element-only`, página atual | `unavailable` | **`result` em ~1 s** (mesmo E2E) |
| Página **com** sinal sensível, `full-evidence` | pausa → confirma → `result` | **igual** (medido com sonda própria) |
| Duas auditorias seguidas na mesma sessão | — | **as duas em `result`**, sem marcador residual |
| Não vacuidade do E2E novo | — | **reprova** contra os bytes empacotados da 1.1.47 (as duas telas terminam em `unavailable`) |
| Escopo serial de 13 arquivos na raiz do pacote | 59/59 | **59/59** |

As sondas e os registros brutos estão em `/private/tmp/adv165/` (`conserto-A.patch`, `conserto-A.py`,
`LEIA-ME-conserto-A.md`, `limpo/`, `root/`, `probe-*.mjs`, `*.log`).

## 3.1 Achado A-1 da revisão adversarial do conserto (fechado antes de a versão sair)

A revisão independente do patch mediu, com os módulos reais, uma **colisão de marcadores**: se a página
**revelar sinal sensível depois** de o portão armar sem pausa (SPA que renderiza o formulário tarde, modal de
login), o caminho consentido cria o marcador dele **além** do direto — e `scanMarker` fica `blocked` com dois
marcadores no mesmo `auditId`, o que mataria a auditoria já consentida e deixaria resíduo até o fim da sessão
(a direção era segura — nenhum raster sem companheiro, nenhum consentimento burlado —, mas era regressão
funcional: a 1.1.47 conclui nesse cenário).

**Fechamento (desenho final, na 1.1.48):** a aposentadoria acontece **no instante em que a pausa vai ser
criada** — o portão ganhou o gancho opcional `onRetireDirect`, chamado no ramo do primeiro raster quando o
sinal aparece **depois** de o portão ter armado (é o único ponto de pausa posterior a um armar; no `preflight`
a pausa é imediata e não existe tentativa direta, então não há chamada). O ciclo de vida expõe `retireDirect`
(`retireDirectAttempt` em `service-worker.js`): digesto determinístico a partir do `auditId`, remoção
**confirmada** pela leitura de ausência e recusa da operação se a confirmação falhar, tocando **somente** o
marcador direto. O `prepareResume` continua aposentando a direta antes de criar a consentida, como **rede de
segurança** de ordenação.

**Variante A-1b (cancelamento), fechada pelo mesmo movimento:** sem a aposentadoria na pausa, cancelar nessa
pausa fazia a liquidação chamar `classify(consentId)`, encontrar o marcador **direto**, ficar `blocked`, falhar
e deixar o marcador residual até o fim da sessão. Com a aposentadoria na pausa, `classify` vê `absent`, a
liquidação conclui e não sobra resíduo.

**Prova com dentes:** `test/background/pixel-attempt-terminal-commit.test.js` reproduz a sequência exata
(direta → consentida no mesmo `auditId`) e verifica que fica **um** marcador — o consentido —, que a direta
aposentada não é mais legível (`markerMatches` falso), que o commit consentido conclui e que a limpeza
`post-finish` deixa **zero** marcadores. Com a aposentadoria desligada por mutação, o mesmo teste **reprova**.
`test/background/pixel-privacy-gate.test.js` mede o **ponto** da aposentadoria: com o sinal aparecendo entre o
armar e o primeiro raster, a sequência é `['armed', 'retired', 'pause']`; na pausa imediata do `preflight`, é
`['pause']` (sem armar não há direta a aposentar).

## 4. Limites declarados

- A tentativa direta **não** é consentimento: ela não cria suspensão, não marca a sessão como `privacy-paused`
  e não sobrevive ao fim da auditoria (o marcador é removido na limpeza; a fronteira é coberta por teste de
  unidade em `test/background/pixel-attempt-correlation.test.js`).
- O digesto direto é derivado **só** do `auditId` (domínio separado): ele não colide com o da tentativa
  consentida do mesmo `auditId` (coberto em `test/privacy/session-url-digest.test.js`).
- Os testes do incremento paralelo (`test/e2e/sidepanel-flow-mv3.test.mjs`) **não** mudam com este conserto: eles
  exercitam outro desenho (auditoria numa **cópia inativa**, com pausa esperada) e falham por expectativas
  próprias ainda em andamento — 3 passam e 9 falham antes e depois.
