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
de outros percursos). **Reconciliação de números (N-7 da revisão da 1.1.49):** o **7** é o arquivo da versão
anterior rodando contra o produto ATUAL — medido pelo revisor, `df4bd2d:test/e2e/sidepanel-flow-mv3.test.mjs`
contra os bytes de hoje dá 7 falhas / 2 passes. O **9** que aparece no dossiê (§1, critério 12) é o total de
falhas da fase serial da bateria da **1.1.48**, que também incluía as flakiness de carga daquele momento. São
bases diferentes: 9 falhas na fase serial de 113 testes em 18/09, 7 falhas no arquivo isolado contra o produto
atual. O caso migrado cobre os quatro subtestes: cancelamento na pausa, sem pixels, somente
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
| Suíte paralela (não-Chrome) | **4.235 testes, 4.234 passam, 0 falham, 1 pulado** (1.1.48: 4.231/4.230/0) |
| Suíte do painel | **263/263** |
| `test/e2e/sidepanel-flow-mv3.test.mjs` | **10/10 verdes** com o caso reativo novo (o arquivo tinha 9 entradas) |
| Fase serial completa (45 arquivos de Chrome real) | **114 testes, 113 passam, 1 falha** — a única é `axe-mv3-csp`, erro no hook `after` (`cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]`), a flake de limpeza já declarada; **passa 1/1 isolada**, medido pelo autor e pelo revisor |
| `credential-shapes-mv3` (a classe de credencial) | **23/23** depois do conserto da exportação (antes: 17/23 na mesma máquina) |
| `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` | **GREEN** |
| Auditoria ao vivo do pacote (Google, sem pixels, headless) | versão **1.1.49** declarada; **0 falhas confirmadas** (0 ocorrências); 2 sob revisão humana (2 ocorrências); 9 positivos; **108** no checklist; cobertura **29,2 %**; índice **9,0/10**; 12 grupos de achados; **0** frases de "Inconformidade ao item"; quatro exportações `complete` (HTML 327.391 B, PDF 970.029 B, CSV 82.886 B, JSON 359.397 B) |
| Integridade dos quatro artefatos (instrumento `artcheck`) | **146 itens, 146 ids únicos, 146 títulos**; 0 ids e 0 títulos ausentes no HTML e no PDF; notas editoriais **5/5** nos dois; **0 palavras partidas**; **0 `[redacted]`**; 8 snippets (4.853 caracteres); a mensagem passiva corrigida presente no HTML entregue |
| Vigência da mensagem corrigida | a frase antiga ("sem alterar foco, rolagem ou layout") **não** aparece no relatório entregue; a nova declara o efeito da captura |

### 4.1 Como as seis falhas da primeira passagem serial foram triadas

A primeira passagem completa da fase serial (23:05–23:42) rodou **em paralelo com a bateria de Chrome do revisor
independente** — exatamente a condição que o projeto documenta como produtora de estouros por tempo limite. As seis
falhas:

| Falha | Assinatura | Triagem medida |
| --- | --- | --- |
| `axe-mv3-csp` (1) | erro no hook `after`: `cleanup axe limitado falhou: [{stage:'profile',code:'failed'}]` | **passa 1/1 isolado** (medido duas vezes, pelo autor e pelo revisor) — flake de limpeza já declarada desde a 1.1.28 |
| `credential-shapes-mv3` (5) | `DOWNLOAD_PROOF_TIMEOUT` em ~121 s na linha 105 (`waitForFourDownloads`), sem nenhuma asserção de sanitização falhando | **23/23 em 77 s** isolado, com a máquina exclusiva (cadeado de coordenação com o revisor) |

Nenhuma das seis é asserção de produto. O revisor **interrompeu** a própria execução concorrente desse arquivo e
declarou o resultado parcial dele inválido, o que confirma a leitura de contenção.

## 5. Ambiente — o Chrome for Testing quebrado e o binário novo (medido)

A bateria anterior usava o cópia em `/private/tmp/audita-cft152-fixed`. Nesta máquina, esse bundle **não inicia
mais**: processos auxiliares morrem com `SIGTRAP` ("GPU process isn't usable. Goodbye.") porque a assinatura do
app ficou inconsistente ("code has no resources but signature indicates they must be present"). A conferência é
`codesign -v --deep --strict` — o mesmo aviso aparece no bundle recém-baixado da CfT, mas só o primeiro falha ao
executar. O binário foi **baixado de novo** do canal oficial
(`chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip`) e a bateria passou a rodar com ele
(mesma versão declarada: `Google Chrome for Testing 152.0.7977.64`). A regressão era do ambiente, não do produto:
com o binário novo, o caso passivo que antes estourava `CDP_CLOSED`/`CDP_COMMAND_TIMEOUT` fecha em ~3 s.


## 6. A revisão adversarial independente da 1.1.49 e o que ela mudou

Parecer completo em `docs/qa/revisoes/REVIEW-1.1.49.md` (revisor independente, clone próprio, Chrome for
Testing 152.0.7977.64, um Chrome por vez por cadeado combinado). Veredito inicial: **NÃO PODE ENTRAR**, com dois
Important de produto. O revisor confirmou por medição própria o que estava certo — conserto N-1 com **dentes**
(263/263 sem mutação; 261/263 com o reducer revertido; 262/263 com cada um dos outros dois mutantes), pacote
reconstruível e byte-idêntico à árvore, migração E2E **9/9 em 306 s** reproduzida, e as seis provas centrais do
oráculo antigo preservadas (duas delas **mais fortes**: zero posse de aba e ocorrência conhecida resolvida no
documento vivo).

### 6.1 N-2 (Important): a exportação podia ser revogada durante a própria navegação

**Causa isolada com sonda própria do autor** (cópia de trabalho, marcas de estágio em `export-launch.js` e leitura
das concessões de sessão), nos casos que falhavam:

```
DEBUG-EXPORT-OPEN {"debug":[],"launches":[{"state":"revoked","attemptId":"1","hasTab":true,"documentId":null}],
 "sessions":[],"receipt":null,"journalCount":0}
DEBUG-REPORT-STATUS "Relatório atualizado na fila de geração."
```

O relatório **recebeu `ok`** (a concessão foi criada), a aba de exportação **nunca conectou** (`documentId: null`,
nenhuma sessão), a concessão terminou **`revoked`** e o `catch` de `requestExport` **nunca rodou**. A revogação
vinha de `handleTabUpdated`: durante a navegação que a própria autoridade inicia, o Chrome publica um estado
intermediário (`about:blank` sem `pendingUrl`) e, sob carga, o evento de `tabs.onUpdated` chega depois de a
concessão existir — quando `exactStagingTab` não reconhece esse estado, a exportação do usuário morria sem
produzir arquivo. **Era defeito de produto, não do teste.**

**Conserto:** `stagingNavigationPending` (complemento tolerante de `exactStagingTab`) com janela limitada
(`STAGING_GRACE_MS = 30 s`). Dentro da janela, o estado pendente da nossa própria navegação não revoga; uma
navegação confirmada para outro destino, a aba/janela ausente e a falta de prova fora da janela continuam
revogando. **Medição:** `credential-shapes-mv3` **23/23** depois do conserto (antes 17/23 na mesma máquina). O E2E
de credencial também ganhou `EXPORT_DELIVERY_SNAPSHOT` e orçamento de 300 s por tentativa, para que a próxima
falha venha diagnosticada em vez de anônima.

### 6.2 N-1 da revisão (Important): a mensagem de observação passiva negava um efeito medido

O revisor mediu, com uma fixture que tem um handler de `resize` comum (que escreve no DOM): **247 eventos**,
viewport amostrando `1x1`, **496 mutações de DOM** e o contador da página em `resizes=253` — o próprio oráculo do
autor reprovava o caso. A sonda de causalidade dele (5 experimentos) mostrou que a oscilação vem da flag
`captureBeyondViewport: true` (não da posição do recorte), sem efeito cruzado entre alvos, e que a geometria final
volta idêntica.

**Conserto:** a mensagem passou a **declarar** o efeito (não a negá-lo), com teste literal; e o oráculo ganhou o
caso `passive current-page declares the capture resize on a page that reacts to it`, que exige geometria final
idêntica, zero navegação/rolagem, o efeito **medido** no contador da página e a declaração no relatório — além de
proibir a frase antiga. A escolha do produto continua sendo capturar (perder a captura fora da área visível seria
perder evidência de elementos que existem na página); o que mudou foi a honestidade da afirmação.

### 6.3 Os cinco Minor e a observação

As quatro asserções de CSV removidas voltaram; o seletor da ficha do painel tem de resolver, no documento vivo, a
um elemento com o defeito (botão sem nome ou campo sem rótulo); `Anúncio esperado:` e a citação WCAG no HTML
voltaram; o perdão de `resize` ganhou teto (`8 × capturas + 32`), piso de `1x1` e amostragem obrigatória a partir
de 16 eventos; o anúncio do caminho novo virou "A página observada não foi alterada."; o caminho novo chama
`reviseNavigationEntry()` (simetria); e as cinco linhas de documentação vencidas foram corrigidas, com a
divergência 7 × 9 reconciliada por medição (7 = arquivo antigo contra o produto atual; 9 = fase serial da bateria
da 1.1.48).
