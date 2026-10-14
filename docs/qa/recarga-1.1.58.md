# Recarga da página durante a auditoria — medição, congelamento de navegação e sinais depois da recarga

Versão analisada: 1.1.57 (worktree `wip/recarga`).
Relato: páginas que se recarregam ou navegam sozinhas (portal de notícias com atualização automática,
`<meta http-equiv="refresh">`, `location.reload()` por temporizador, redirecionamento por script depois do
aviso de cookies) atrapalham a auditoria da página atual: a auditoria termina interrompida ou, no fim, os
sinais na página deixam de existir com a mensagem "Esta página não tem mais um canal ativo da extensão",
porque o documento auditado deixou de existir.

Escopo: medição em navegador real (Fase 1), congelamento de navegação durante a auditoria (Fase 2) e
avaliação — não implementada — de mostrar os sinais na versão recarregada (Fase 3). O documento registra
também os testes executados e o desvio de uma exigência do pedido que não cabia no catálogo fechado de
diagnósticos.

---

## 1. Fase 1 — o que de fato troca o documento

Sonda descartável `scripts/probe-navigation.mjs` (fora de `src/`, apagada ao fim desta tarefa), que abre o
navegador de teste por `--remote-debugging-pipe` pelo mesmo transporte dos e2e
(`test/e2e/support/real-chrome.mjs`, `createCdpPipeTransport`), cria uma aba, habilita `Page.enable` e
`Page.setLifecycleEventsEnabled`, lê o frame principal com `Page.getFrameTree` e registra, só do frame
principal:

- `Page.frameRequestedNavigation` (motivo e disposição);
- `Page.frameNavigated` (troca de documento) e `Page.navigatedWithinDocument` (navegação dentro do
  documento, que NÃO troca o documento);
- `Page.lifecycleEvent`, `Page.frameStartedLoading` e `Page.frameStoppedLoading`;
- a cada 5 s, um instantâneo de `location.href`, `document.readyState` e `document.title` para correlacionar
  com os eventos.

Duas rodadas, sem e com mudança de largura da viewport (980×800) no meio, imitando a abertura do painel
lateral — o gatilho de recarga relatado numa loja na 1.1.56 (`src/panel/panel-port.js`, comentário da
1.1.56).

| alvo | duração | largura mudada | eventos `frameNavigated` do topo | `frameRequestedNavigation` | leituras de estado distintas |
| --- | --- | --- | --- | --- | --- |
| portal de notícias (home) | 240 s | não | 1 (a navegação inicial) | nenhum | 1 href, 1 título |
| loja (home) | 120 s | não | 1 (a navegação inicial) | nenhum | 1 href, 1 título |
| portal de notícias (home) | 100 s | sim, aos 25 s | 1 (a navegação inicial) | nenhum | 1 href, 1 título |
| loja (home) | 100 s | sim, aos 25 s | 1 (a navegação inicial) | nenhum | 1 href, 1 título |

Conclusão honesta da medição: **nas quatro janelas observadas as duas homes não se recarregaram sozinhas**,
nem depois da mudança de largura, e `Page.frameRequestedNavigation` nunca disparou. As 48 e 24 leituras de
estado de cada rodada deram sempre o mesmo `href` e o mesmo `title`, com `readyState` `complete` (e
`interactive` na primeira leitura do portal). Ou seja: a home não é onde o problema aparece.

O relato continua sendo real e o caminho que o produz está identificado pelo próprio desenho do produto:
qualquer pedido de documento que a própria página faça depois que a auditoria começa troca o `documentId`
do alvo, e o produto trata isso como prova quebrada (`TARGET_CHANGED`, revogação da capacidade,
`PAGE_MARKERS_DOCUMENT_CHANGED` nos sinais). Os gatilhos que produzem esse pedido — `meta refresh`,
temporizador, redirecionamento depois do consentimento de cookies, e a própria mudança de largura em
páginas que reagem a ela — foram reproduzidos em fixtures locais na Fase 2 e é sobre eles que a correção
foi provada.

---

## 2. Fase 2 — congelamento de navegação

### 2.1 Desenho

Novo módulo `src/background/navigation-freeze.js`. Enquanto a auditoria da página atual roda com o
depurador anexado, o frame principal da aba auditada para de aceitar troca de documento:

- `start()` lê o frame principal (`Page.getFrameTree`), registra o ouvinte de `chrome.debugger.onEvent` e
  habilita `Fetch.enable` com **um único padrão**, `resourceType: 'Document'`, `requestStage: 'Request'`.
  Nenhum outro tipo de recurso é interceptado — imagens, scripts, folhas de estilo, XHR e iframes seguem
  absolutamente normais.
- Em `Fetch.requestPaused`, o pedido de documento que veio do frame principal é respondido com
  `Fetch.failRequest` e `errorReason: 'Aborted'`: o documento atual permanece, sem tela de erro. Se o
  pedido não é do frame principal (iframe), ou o `frameId` não é atribuível, a resposta é
  `Fetch.continueRequest` — o congelamento nunca inventa erro numa página por não saber de quem é o pedido.
- `stop()` chama `Fetch.disable` antes de remover o ouvinte e é idempotente.

O congelamento é **melhor esforço**: se qualquer passo falhar (frame principal não identificável,
`Fetch.enable` recusado), `start()` falha, o ouvinte é removido e a auditoria segue sem ele. Ele nunca
transforma uma falha de congelamento em falha de auditoria.

`meta refresh` e `location.reload()` estão cobertos porque os dois geram requisição de documento. Navegação
dentro do documento (`pushState`, mudança de fragmento) não troca o documento e continua livre, sem
interceptação nenhuma — o que já era o comportamento correto.

### 2.2 Onde entrou

Ponto único de entrada e saída, em `src/background/run-audit.js` (`runLegacyAudit`):

- depois de `connectCdp` e do guarda de sessão, `beginNavigationFreeze(cdp, tab.id)` dentro de `try/catch`
  que reduz qualquer falha a "segue sem congelamento";
- no `finally` único, **antes** de `cdp.disconnect()` e de fechar a aba: `Fetch.disable` e remoção do
  ouvinte, e só então, se algo foi segurado, o diagnóstico.

Esse ponto cobre os três modos (aba do usuário, URL em aba descartável e lote) porque tanto a navegação que
a extensão faz (`chrome.tabs.create`/`chrome.tabs.update`) quanto a do observador acontecem **estritamente
antes** de `connectCdp`. A extensão nunca navega a aba auditada por CDP — não existe `Page.navigate` nem
`Page.reload` em `src/background/` —, então nada que a extensão faça é segurado.

O método novo entrou na superfície privilegiada capturada: `beginNavigationFreeze` está na lista fechada de
`captureLegacyEffects` (`src/background/run-audit.js:1893-1900`) e o adapter `src/background/chrome-adapter.js`
passou a expor `onEvent` no objeto congelado de `chrome.debugger` (`captureChromeDebugger`), com a mesma
leitura dupla das outras funções. `createObservedLegacyAdapter` repassa o método adiante pelo espalhamento
do adaptador capturado, então o congelamento vale também no caminho observado.

### 2.3 Diagnóstico e o desvio do contador

Diagnóstico novo no catálogo fechado (`src/core/report/diagnostic-policy.js`):

- código `PAGE_NAVIGATION_HELD`;
- mensagem literal: "A página tentou recarregar ou navegar sozinha durante a auditoria; a navegação foi
  segurada até o fim para que o resultado corresponda à página analisada.";
- `recoverable: true`, `causePartial: false`, `fact: 'page-navigation-held'`, em todos os estados terminais
  (completa, parcial, falha e cancelada) e nos dois modos (página única e lote).

**Desvio declarado:** o pedido sugeria a mensagem com o número de vezes ("... N vez(es) ..."). O catálogo de
diagnósticos é fechado e casa **código + mensagem exata** (`SYSTEM_DIAGNOSTIC_POLICY`), e o campo `details`
só admite as formas `none`/`occurrence`. Uma mensagem com contador variável seria recusada pelo próprio
catálogo — e um teste novo prova isso: a mesma frase com " (3 vezes)" no fim é REJEITADA
(`test/report/diagnostic-policy.test.js`). A contagem é medida e mantida em memória
(`freeze.blocked()`), mas a mensagem ficou fixa. A frase simples foi escolhida de propósito: o fato não é
uma limitação (nada foi perdido) e por isso o texto não entra em `deriveSystemLimitations` — o que NÃO
significa ficar invisível: a seção "Limitações e diagnósticos" do relatório monta a lista com as limitações
derivadas mais todos os diagnósticos da sessão no formato `CÓDIGO: mensagem`
(`src/core/report/html.js:745-759`), de modo que a pessoa lê a frase em linguagem simples ali, com o código
ao lado, sem que o fato seja contado como perda técnica. No modelo, o diagnóstico aparece em
`session.diagnostics` e nos diagnósticos da página.

O diagnóstico é registrado uma única vez, no `finally`, pelo mesmo `appendDiagnosticOnce` que os demais
diagnósticos recuperáveis usam.

---

## 3. Fase 3 — mostrar os sinais na versão recarregada: NÃO implementado

Decisão: **não implementar**. O caminho proposto (um botão explícito no painel, "Mostrar sinais nesta versão
recarregada", com aviso visível, aceitando a mesma URL) contradiz invariantes de segurança documentados e
testados do produto:

1. A capacidade dos sinais é amarrada ao **documento**, não à URL. `src/background/page-markers-controller.js`
   grava a origem com `tabId`, `windowId`, `documentId` e `urlSessionDigest` (`validProof`/`sameProof`,
   linhas 96-104) e, na hora de instalar, relê a identidade viva do documento por `probeDocumentIdentity`
   duas vezes (linhas 434-436 e 450-454). Qualquer divergência devolve `PAGE_MARKERS_DOCUMENT_CHANGED`. Isso
   não é um detalhe de implementação: é o que garante que os sinais contornam os elementos que foram
   **auditados**, e não elementos de mesmo seletor num documento novo.
2. A fonte dos sinais é uma **cópia congelada do conteúdo auditado**
   (`snapshotAttachedCopySource`, linhas 437-446), e a URL dela precisa bater com a URL final da auditoria.
   Um documento recarregado é outro documento, com outro `documentId` e outro `urlSessionDigest`, mesmo com
   URL idêntica — inclusive porque o servidor pode ter respondido outra coisa (é exatamente o que um portal
   que se atualiza faz).
3. `src/background/report-launch.js` declara explicitamente que "só o próprio documento reaproveita a
   capacidade; as de um documento recarregado são revogadas", e a revogação por troca de documento é
   aplicada por `invalidateForTab` em `src/background/target-capabilities.js`.
4. O painel já comunica o desfecho correto: o aviso `page-reloaded` (auditoria interrompida porque a página
   recarregou) e a frase de indisponibilidade dos sinais
   (`src/panel/page-markers-session.js`, `UNAVAILABLE`), que apontam para o que continua valendo — as
   evidências e as capturas registradas no relatório.

Afrouxar o item 1 para "mesma URL" trocaria uma prova de documento por uma comparação de string de URL, e o
aviso do painel passaria a ser a única defesa contra apontar sinais para conteúdo que ninguém auditou. Se
algum dia isso for desejado, o caminho correto não é reaproveitar a capacidade antiga: seria uma **nova
coleta** com o mesmo processo estrito (prova de documento nova, captura nova, modelo novo, `auditId` novo) e
os sinais daí derivados — e não sinais "reposicionados" de uma auditoria anterior. Com o congelamento da
Fase 2, a versão recarregada durante a auditoria deixa de existir; uma recarga depois da auditoria é um
estado novo, e o produto já diz isso com clareza.

---

## 4. Testes

### 4.1 Unitários

- `test/background/navigation-freeze.test.js` (novo): habilita só `resourceType Document`; segura o frame
  principal com `Aborted` e conta; deixa iframes e pedidos sem frame atribuível passarem; ignora eventos de
  outra aba, outro método e pedidos repetidos; `stop` desabilita o Fetch **antes** de remover o ouvinte e é
  idempotente; falha no `enable` não deixa ouvinte e propaga; falha ao responder não derruba o ouvinte; sem
  frame principal identificável o congelamento não arma.
- `test/background/chrome-adapter.test.js` e `test/background/service-worker.test.js`: fixtures atualizadas
  para a nova superfície obrigatória de `chrome.debugger.onEvent`.
- `test/report/diagnostic-policy.test.js`: o diagnóstico informativo vale nos quatro estados terminais e no
  lote, não é limitação, e a mensagem com contador é recusada pelo catálogo fechado.
- Os quatro conjuntos pedidos juntos (`test/background`, `test/core`, `test/report`, `test/panel`):
  **2815 testes, 2814 passam, 0 falham, 1 pulado** (o pulado é anterior a esta tarefa).

### 4.2 E2E novo (navegador real)

`test/e2e/navigation-freeze-mv3.test.mjs`, com `test/e2e/support/real-chrome.mjs` e servidor de fixture
local. Duas fixtures, ambas com uma vitrine de 240 produtos e um contador de geração em `sessionStorage`
(que sobrevive à recarga, e por isso prova que o documento foi mesmo trocado):

- `/viva` com `<meta http-equiv="refresh" content="3">`;
- `/viva` com `setTimeout(() => location.reload(), 2500)` rearmado a cada ciclo — como um portal de verdade
  faz.

Cada cenário prova três coisas: a auditoria da página atual conclui com resultado (completa ou parcial, sem
código de falha); o diagnóstico `PAGE_NAVIGATION_HELD` aparece no modelo do relatório; e, depois da
auditoria, a recarga volta a funcionar (a geração aumenta — na fixture do temporizador sozinha, na do meta
refresh por recarga pedida explicitamente), o que prova que a interceptação foi removida.

Resultado: **2 de 2 passam**.

| gatilho | duração da auditoria | geração ao fim | desfecho | diagnóstico | recarga depois |
| --- | --- | --- | --- | --- | --- |
| meta refresh | 9,3 s | 1 | result / partial, sem falha | `PAGE_NAVIGATION_HELD` | 1 → 2 |
| recarga por temporizador | 15,9 s | 2 | result / partial, sem falha | `PAGE_NAVIGATION_HELD` | 2 → 3 |

O arquivo foi adicionado à lista `REAL_CHROME_E2E` de `scripts/run-tests.mjs`.

Observação de medição: na primeira execução as duas fixtures usavam uma página minúscula e a auditoria
terminou em 1,25 s — antes do primeiro pedido de recarga (2,5 s/3 s), e por isso não havia nada para segurar.
A fixture passou a ter o tamanho de uma vitrine real, e a auditoria passa a durar 9-16 s, o que cobre o
gatilho com folga. Esse é um limite honesto do congelamento: ele segura o que a página pedir **enquanto a
auditoria roda**.

### 4.3 E2E existentes

Executados com o Chrome de teste declarado, em série e **um de cada vez** (a primeira tentativa rodou junto
com outro `npm test` completo, e a disputa por CPU derrubou três cenários por tempo limite; repetidos
sozinhos, passam):

| suíte | resultado |
| --- | --- |
| `page-markers-signals-mv3` | 1 de 1 |
| `current-page-pixel-consent-mv3` | 2 de 2 |
| `url-audit-mv3` | 1 de 1 |
| `hostile-pages-mv3` | 16 de 16 |
| `sidepanel-flow-mv3` | 9 de 9 |
| `navigation-freeze-mv3` (novo) | 2 de 2 |

---

## 5. Arquivos

Novos:

- `src/background/navigation-freeze.js`;
- `test/background/navigation-freeze.test.js`;
- `test/e2e/navigation-freeze-mv3.test.mjs`;
- este documento.

Alterados:

- `src/background/run-audit.js` (entrada e saída do congelamento, diagnóstico, superfície capturada);
- `src/background/chrome-adapter.js` (`onEvent` na superfície de `chrome.debugger`, `beginNavigationFreeze`);
- `src/core/report/diagnostic-policy.js` (`PAGE_NAVIGATION_HELD`);
- `scripts/run-tests.mjs` (classificação do novo e2e);
- `test/background/chrome-adapter.test.js`, `test/background/service-worker.test.js`,
  `test/report/diagnostic-policy.test.js`.

Apagados: `scripts/probe-navigation.mjs` (sonda descartável da Fase 1, medida registrada na seção 1) e a
sonda da comparação antes/depois da seção 6.1. Nenhum dos dois fazia parte do produto.

---

## 6. Execução de QA

### 6.1 Comparação antes/depois na home de um portal grande

Para separar "o congelamento quebrou alguma coisa" de "a página é grande mesmo", a mesma auditoria da página
atual foi executada duas vezes com o **mesmo roteiro**: uma com a extensão como está em `HEAD` (exportada
para um diretório à parte, sem as mudanças desta tarefa) e outra com esta árvore de trabalho. A sonda
descartável usada aqui (apagada ao fim) abre o painel, escolhe "Evidência completa", inicia a auditoria da
página atual e imprime o texto do painel a cada 2 s, com o modelo final no fim.

| execução | duração até o resultado | desfecho | ocorrências | `PAGE_NAVIGATION_HELD` |
| --- | --- | --- | --- | --- |
| `HEAD` (sem congelamento) | 231,8 s | result / parcial, sem código de falha | 516 | não |
| esta árvore (com congelamento) | 196,3 s | result / parcial, sem código de falha | 450 | não |

As duas concluem com resultado na mesma faixa de tempo (a diferença é do conteúdo da home, que muda entre
execuções — os totais de ocorrências são 516 e 450). O `PAGE_NAVIGATION_HELD` **não** aparece em nenhuma das
duas, e isso é coerente com a medição da Fase 1: essa home não troca de documento sozinha. Nenhuma regressão
atribuível ao congelamento foi observada. As etapas do painel também não mudaram de ordem nem de duração
relativa (25% → 50% → 72% → 92% → resultado).

### 6.2 QA visual (`scripts/visual-qa.mjs`), duas passagens

Comando, como pedido, executado duas vezes (a primeira passagem foi preservada em `qa-out/recarga-run1`
antes de a segunda sobrescrever `qa-out/recarga`):

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/recarga --url https://<portal-de-notícias>/
```

| passagem | desfecho do roteiro | tela do painel ao fim | auditoria concluída? | sinais na página? |
| --- | --- | --- | --- | --- |
| 1ª | `auditoria-sem-resultado` (`tela=running`) | 92% — "Preparando o resultado" | não, dentro da janela do roteiro | não chegou lá |
| 2ª | `auditoria-sem-resultado` (`tela=running`) | 92% — "Preparando o resultado" | não, dentro da janela do roteiro | não chegou lá |

Leitura honesta: **a auditoria não concluiu dentro da janela do roteiro de QA visual (180 s)**, e por isso o
roteiro parou na captura do painel e nunca chegou a instalar os sinais — a resposta para "os sinais voltaram
a funcionar?" nessa página é "não foi medido, porque a auditoria ainda estava rodando". A captura
`01-painel.png` mostra as quatro etapas de coleta concluídas e a etapa final em andamento (92%), ou seja, o
painel estava trabalhando, não travado.

O motivo aparece na seção 6.1: essa home leva ~196-232 s para concluir, acima dos 180 s que o roteiro espera
— e o mesmo roteiro, rodado contra a extensão de `HEAD`, também estouraria a janela (231,8 s). Não é efeito
do congelamento; é o tamanho da página. Corrigir isso seria aumentar a espera do roteiro (ou registrar a
medição como "não concluída no prazo" em vez de erro), o que é decisão de QA, não do produto — e por isso
ficou registrado aqui, sem alterar o roteiro.

### 6.3 Verificações de projeto

- `node scripts/verify-project.mjs` faz `npm test` por dentro (todas as suítes, incluindo todos os e2e reais
  em série). A execução anterior foi contaminada por outro `npm test` em paralelo e falhou por contenção; os
  conjuntos relevantes foram repetidos um de cada vez (seções 4.1 a 4.3) e passam.
- Varredura de identidade neutra (`scripts/verify-neutral-identity.mjs`): **nenhum achado** — este documento
  e o restante da árvore não citam nome de órgão nem domínio de governo; os alvos reais aparecem apenas como
  "portal de notícias" e "loja".

### 6.4 Pendências assumidas

1. A auditoria de uma home grande não conclui dentro dos 180 s do roteiro de QA visual (comportamento
   anterior a esta tarefa; a medição está acima). Fica como ajuste de roteiro.
2. O contador de tentativas seguradas existe no runtime (`freeze.blocked()`), mas não aparece no texto do
   diagnóstico, porque o catálogo é fechado na mensagem exata. Se o número for desejado na tela, o caminho é
   abrir o catálogo (ou um campo de contagem validado no modelo), e não escrever texto livre.
3. Mostrar os sinais na versão recarregada continua fora do produto, pelos motivos da seção 3.
4. `npm test` completo (unitários + os ~50 e2e reais em série) não foi rodado de ponta a ponta sem
   concorrência nesta tarefa: foram rodados os conjuntos pedidos mais as suítes de unidade afetadas. Rodar o
   plano completo leva cerca de 15 minutos e é o próximo passo natural antes de publicar.
