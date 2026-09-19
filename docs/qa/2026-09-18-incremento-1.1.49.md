# Incremento 1.1.49 — N-1 fechado e a suíte E2E da página atual migrada para o desenho passivo

Data: 18/09/2026. Versão: **1.1.49**. Pacote: `release/audita-acessibilidade-1.1.49.zip`, 199 arquivos, digest
`92945a8db8df341f04a42e7b2606f06e6e3b5d07d31e5531b334fc965ece5fa9`. Chrome for Testing 152.0.7977.64, um Chrome
por vez, bateria em **headless**.

## 1. O que este incremento fecha

| Item declarado | Onde estava | O que foi feito |
| --- | --- | --- |
| **N-1** (Minor da re-verificação independente da 1.1.47) | `docs/qa/revisoes/REVIEW-1.1.47.md`, dossiê §3 | A tela de indisponibilidade passa a oferecer **"Escolher outro modo"** (devolve a tela inicial com o seletor, preservando a preferência) e o **"Tentar novamente"** deixa de trocar o motivo específico pelo genérico |
| **9 cenários E2E** da página atual falhando | dossiê §1 critério 10 e §4; `test/e2e/sidepanel-flow-mv3.test.mjs` | Migrados para o desenho passivo: documento aberto, zero abas criadas, zero posse de aba, relatório vivo, exclusão que não fecha a aba do usuário |
| **3 linhas de documentação vencidas** | README ("candidata de produção"), dossiê §4, `docs/BETA-BACKLOG.md` | Corrigidas: a 1.1.48 foi fechada como produção em 18/09, a re-verificação adversarial do conserto **concluiu** ("pode entrar") e o backlog passou a declarar a versão vigente |

## 2. N-1 — o defeito, o conserto e a prova

**Defeito medido pela re-verificação independente:** na tela `unavailable`, o `RETRY` mantinha a tela e **trocava o
motivo específico pelo genérico**; "Iniciar nova auditoria" reiniciava com o **mesmo modo** (a tela não renderiza o
seletor de modo) → falhava de novo → mesma tela. A recuperação existia apenas reabrindo o painel pelo ícone.

**Conserto (3 arquivos de produto, 1 transição reutilizada):**

- `src/panel/panel-state.js` — `NEW_AUDIT_REQUESTED` passa a valer também a partir de `unavailable` (antes só de
  `result`), preservando `captureMode` e persona e limpando `reason`/`auditId`.
- `src/panel/panel.js` — o intent `NEW_AUDIT` ganha o caminho da tela indisponível (sem tocar em marcadores de
  resultado, que não existem ali) e `retryAudit` preserva `state.reason` quando a retomada é recusada.
- `src/panel/panel-view.js` — o botão secundário da tela indisponível passa a ser **"Escolher outro modo"**
  (`NEW_AUDIT`, `focusId` `new-audit`).

**Provas:** `test/panel/panel-state.test.js` (transição e recusas), `test/panel/panel-view.test.js` (a tela oferece
os dois caminhos e o rótulo exato), `test/panel/panel-runtime.test.js` (percurso real do painel: bootstrap ocioso
durante auditoria em curso → indisponibilidade com o motivo específico → retomada recusada **preserva o motivo** →
"Escolher outro modo" devolve a tela inicial com o seletor). Suíte do painel: **260 → 263 testes, 263 passam**.

## 3. A migração dos nove cenários E2E (incremento C do plano passivo)

O arquivo `test/e2e/sidepanel-flow-mv3.test.mjs` afirmava o desenho antigo. A migração troca o oráculo, não o
produto:

| Antes (cópia inativa) | Agora (documento observado) |
| --- | --- |
| `owned-tab:v2` com `retained-for-consent` e aba inativa | `owners: []` e **zero** registros de posse |
| `assertPausedCopyDocument` provava o conteúdo da cópia | prova o **documento original** intacto (`assertSourceUntouched`) e **zero abas criadas** |
| `ATTACHED_COPY_RELOADED` obrigatório no modelo | **proibido**; `DYNAMIC_PROBES_OMITTED_PASSIVE` obrigatório |
| relatório somente leitura, sem destaque, limitação de cópia | relatório **vivo**, com destaque no documento observado e a declaração de observação passiva; a limitação de cópia é proibida |
| exclusão remove a cópia e reabre o painel | exclusão apaga o registro local e **mantém a aba do usuário aberta** |
| ocorrência conhecida = imagem do servidor (a cópia recarregava) | ocorrência conhecida = **botão sem nome do documento vivo**, com evidência de elemento correlacionada por seletor qualificado (`button#missing-name` ou o caminho estrutural) |

**Medição:** `node --test --test-concurrency=1 test/e2e/sidepanel-flow-mv3.test.mjs` com Chrome for Testing
152.0.7977.64 → **9/9 verdes, 299 s, zero falhas**. Antes da migração, a mesma execução dava **7 falhas** (2 verdes
de outros percursos). O caso migrado cobre os quatro subtestes: cancelamento na pausa, sem pixels, somente
elementos e evidência completa com reinício do trabalhador e as quatro exportações.

### 3.1 Achado novo, declarado: a geometria oscila durante a captura fora da viewport

O oráculo de fonte intocada passou a medir o que antes não media, e a medição achou um efeito real: capturar um
elemento fora da viewport usa `captureBeyondViewport: true` e, no Chrome 152, isso **altera transitoriamente a
geometria do documento observado** — 248 eventos de `resize` num fixture de 240 controles, com o viewport
chegando a amostrar `1x1` e voltando. A geometria **final** é idêntica à inicial, e o teste exige, em todos os
modos: zero navegação, zero mutação de DOM, zero rolagem, zero mudança de foco/seleção/entrada/estilo e zero
sobreposição. O modo **sem pixels** continua exigindo **zero eventos**. A prova agora **amostra** a geometria em
cada `resize` (até 24 amostras no diagnóstico) em vez de só contar eventos.

Não é regressão: é o limite já declarado para regiões fora da viewport, agora com número. Nenhuma linha de
`src/` mudou por causa dele — o produto continua capturando fora da viewport (perder essa captura seria perder
evidência de elementos que existem na página).

## 4. Bateria da versão

| Medida | Resultado |
| --- | --- |
| Suíte paralela | preenchido pela bateria final |
| Fase serial (45 arquivos de Chrome real) | preenchido pela bateria final |
| `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` | GREEN |
| Auditoria ao vivo do pacote | preenchido pela bateria final |
| Integridade dos quatro artefatos | preenchido pela bateria final |

## 5. Ambiente — o Chrome for Testing quebrado e o binário novo (medido)

A bateria anterior usava o cópia em `/private/tmp/audita-cft152-fixed`. Nesta máquina, esse bundle **não inicia
mais**: processos auxiliares morrem com `SIGTRAP` ("GPU process isn't usable. Goodbye.") porque a assinatura do
app ficou inconsistente ("code has no resources but signature indicates they must be present"). A conferência é
`codesign -v --deep --strict` — o mesmo aviso aparece no bundle recém-baixado da CfT, mas só o primeiro falha ao
executar. O binário foi **baixado de novo** do canal oficial
(`chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip`) e a bateria passou a rodar com ele
(mesma versão declarada: `Google Chrome for Testing 152.0.7977.64`). A regressão era do ambiente, não do produto:
com o binário novo, o caso passivo que antes estourava `CDP_CLOSED`/`CDP_COMMAND_TIMEOUT` fecha em ~3 s.
