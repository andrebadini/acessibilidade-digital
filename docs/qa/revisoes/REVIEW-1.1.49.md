# Parecer adversarial independente — incremento 1.1.49 ("Audita Acessibilidade", MV3)

## 0. Objeto, proveniência e ambiente

| | |
| --- | --- |
| Repositório do autor | `/Volumes/SSD1/acessibilidade-digital` (branch `main`, HEAD `2cf5a6b`) — **nada foi escrito ali**; todo o trabalho foi feito em cópias minhas |
| Incremento sob revisão | commit `2cf5a6b` (pai `df4bd2d`); 20 arquivos no diff |
| Artefato | `release/audita-acessibilidade-1.1.49.zip` |
| Digest medido | `92945a8db8df341f04a42e7b2606f06e6e3b5d07d31e5531b334fc965ece5fa9` — **confere** com o declarado |
| Manifesto | `version` = `version_name` = `1.1.49`, `manifest_version` 3 |
| Arquivos | **199** entradas, todas arquivos regulares |
| Reconstrução | `node scripts/build-release.mjs` no meu clone devolve **exatamente** o mesmo digest |
| Zip × árvore do commit | `diff -r` **idêntico** em `manifest.json`, `src/`, `vendor/`, `assets/icons/`; ficam de fora, por desenho do empacotador, `assets/icons/icon-1024.png` e `assets/icons/icon-source.svg` |
| Minhas árvores | `/private/tmp/adv1149/repo` (clone em `2cf5a6b`), `/private/tmp/adv1149/mut` (clone mutado), `/private/tmp/adv1149/parent` (worktree em `df4bd2d`), `/private/tmp/adv1149/pkg149` (zip 1.1.49 + `test/ scripts/ package.json fixtures/` do commit) |
| Ambiente | macOS arm64, Node v26.5.0; Chrome for Testing **152.0.7977.64** (versão lida do bundle), `--headless=new` pelo shim `AUDITA_E2E_CHROME=/private/tmp/adv169/chrome-cft-fresh`; todas as execuções com `node --test --test-concurrency=1` |
| Serialização | **um Chrome por vez**, por cadeado combinado com o agente coordenador (`/private/tmp/audita-chrome-lock`, adquirido atomicamente por mim às 23:52:07 e liberado no fim do lote). A bateria do autor ocupou a máquina até 23:37; **nenhuma** execução minha com navegador começou antes disso |

**Janelas e concorrência (declarado, como pedido).** A bateria do autor terminou sem a linha `EXIT=` (confirmado por `ps`: zero processos; `mtime` congelado às 23:37) e com **6 falhas**. Meu primeiro lote rodou 23:41:16–23:48:54; o passo `credential-shapes` dele (23:46:25–23:48:54) foi **interrompido por mim** ao ver o cadeado e está marcado como **INVÁLIDO** neste parecer. O lote final rodou 23:52:07–00:19:30 com o cadeado em minha posse, sem nenhum outro Chrome (verificado por `ps` em cada checagem). A máquina **não** estava ociosa nesse intervalo: `load averages` ≈ 2, 24 processos `node` e o pipeline `osascript … CAPES_PORT=8101` de outro projeto no ar há 11 dias (8,4% de CPU numa das amostras).

**Precisão sobre as árvores.** Todas as medições de código foram feitas no **meu** clone em `2cf5a6b`, cujo `git status` só tem arquivos **novos não rastreados** (as minhas sondas) — nenhum arquivo rastreado foi alterado, logo cada número deste parecer descreve o commit sob revisão. No momento em que este parecer foi escrito, a árvore de trabalho do autor tinha alterações **não commitadas** em `test/e2e/credential-shapes-mv3.test.mjs` (+32 linhas, instrumentação) e em três documentos de entrega; elas **não** fazem parte do commit nem do zip revisados e não foram medidas por mim.

## 1. Veredito em uma linha

**NÃO PODE ENTRAR** — o conserto N-1 está correto e com testes que têm dentes, o pacote é reconstruível e byte-idêntico à árvore, e a migração E2E passa 9/9 (reproduzido por mim); mas dois Important medidos bloqueiam a versão: (i) a prova de entrega das quatro exportações falhou **6 de 23 vezes numa janela com um único Chrome** — a corrente medida é concessão de exportação `revoked` → nenhum recibo → `DOWNLOAD_PROOF_TIMEOUT`, com a rota da revogação ainda não isolada; e (ii) a mensagem "A página foi observada sem alterar foco, rolagem ou layout" é **falsa para páginas que reagem a `resize`** — o próprio oráculo do autor reprova esse caso (496 mutações de DOM medidas, viewport indo a `1x1` 247 vezes). Some-se a isso o fechamento documental (a 1.1.49 está declarada "produção" com a bateria da versão aberta, vermelha e com quatro linhas "preenchido pela bateria final").

## 2. Achados

### N-1 (Important) — A auditoria da página atual altera o DOM de páginas que reagem a `resize`, e a mensagem do produto nega isso

**Medida, no produto real** (`test/e2e/adv-resize-reactive.test.mjs`, sonda minha: mesma fixture do autor + um `addEventListener('resize')` comum, que escreve no DOM):

```
ℹ ADV-RESIZE {"eventCounts":{... "resize":247 ...},"resizeSamples":["t=20596 1x1/1x1/1x1","t=20607 894x749/894x749/894x749", ...],
 "viewportBefore":{"innerWidth":894,"innerHeight":749,...},"viewportAfter":{"innerWidth":894,"innerHeight":749,...},
 "dom":false,"mutationTotal":496,"scroll":true,"style":true,"overlays":0,"reactive":{"text":"resizes=253 w=894 h=749","resizes":253}}
✖ element-only confirms once and keeps the full-page capture omitted (47726.530375ms)
ℹ tests 5 / ℹ pass 2 / ℹ fail 3
```

O próprio oráculo do autor (`dom: true` e `mutationTotal: 0` em `test/e2e/sidepanel-flow-mv3.test.mjs:704-708`) **reprova** a página: o documento observado termina diferente do que começou (496 registros de mutação; o componente reativo passou a `resizes=253`). Com a fixture benigna do autor, o mesmo oráculo passa (`dom: true`, `mutationTotal: 0`) e a mensagem fica verdadeira — logo o "sem mutação de DOM" é propriedade da **fixture**, não do produto.

A causa está isolada por sonda própria (`test/e2e/adv-resize-probe.test.mjs`, 5 experimentos com o mesmo par CDP de `src/browser/capture-evidence.js`), janela 00:05:10–00:05:14, exit 0:

| Experimento | `resize` | mutações | amostras de geometria | geometria final igual? |
| --- | --- | --- | --- | --- |
| E1 controle: recorte dentro da viewport, `captureBeyondViewport: false` | **0** | 0 | — | sim |
| E2 **só a flag** `captureBeyondViewport: true`, recorte **dentro** da viewport | **2** | 6 | `1x1/1x1` → `1280x757/1280x757` | sim |
| E3 recorte **fora** da viewport, `true` (o caso do produto) | **2** | 6 | `1x1/1x1` → volta | sim |
| E4 captura em **outro alvo** (página do arnês), `true` | **0** | 0 | — | sim |
| E5 página inteira (`captureFullPage`), `true` | **2** | 6 | `1x1/1x1` → volta | sim |

Conclusões medidas: (a) a oscilação é causada pela **flag** `captureBeyondViewport: true`, não pela posição do recorte (E2 já oscila com recorte dentro); (b) não há efeito cruzado entre alvos (E4 = 0), portanto a atribuição do autor ao par CDP do produto está correta; (c) a geometria final volta idêntica (todas as linhas); (d) o handler de `resize` da página **roda** e o `IntersectionObserver` vê elementos saírem e voltarem (`out:reactive`, `out:unnamed-one`, depois `in:`), ou seja, a página é informada de que seu viewport mudou para `1x1`.

**Por que isso é Important e não Observação.** A mensagem exibida em **toda** auditoria da página atual é `DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE` = "A página foi observada sem alterar foco, rolagem ou layout. Testes interativos de teclado, redimensionamento e movimento não foram executados; revise esses aspectos manualmente." (`src/core/report/diagnostic-policy.js:8-9`, emitida por `:85-86`). Ela é entregue ao usuário no relatório e nas quatro exportações (o E2E a exige na superfície do relatório em `sidepanel-flow-mv3.test.mjs:1200` e no HTML em `:1539`). O limite até aqui declarado — no dossiê `docs/qa/2026-09-17-prontidao-para-producao.md:118-119` e no incremento §3.1 — é "capturar elemento fora da viewport oscila a geometria **transitoriamente**, com restauração exata e **zero mutações/rolagem/foco/estilo**". A parte "zero mutações" é **falsa** numa página que reaja a `resize`; e um componente responsivo real (menu, carrossel, carregamento preguiçoso) pode terminar em estado diferente do inicial — o que o oráculo do autor, corretamente, reprova.

**Conserto possível (uma linha de produto ou uma de texto):** ou capturar elementos a partir do raster de página inteira já existente (evitando a flag para recortes que caibam no raster), ou declarar o efeito com honestidade na mensagem (por exemplo: "durante a captura de elementos fora da área visível o viewport é redimensionado por um instante; páginas que reagem a `resize` podem se alterar"). Qualquer uma das duas precisa de teste: o oráculo de fonte intocada deve passar a rodar também sobre uma fixture que reaja a `resize`, senão o limite continua medido só no caso benigno.

### N-2 (Important) — A prova das quatro exportações falha de forma intermitente **sem** um segundo Chrome: 6 de 23

**Comando (cadeado em minha posse, nenhum outro Chrome, `ps` conferido):**

```
cd /private/tmp/adv1149/repo && AUDITA_E2E_CHROME=/private/tmp/adv169/chrome-cft-fresh \
  node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs
```

**Saída:** `ℹ tests 23 / ℹ pass 17 / ℹ fail 6 / ℹ skipped 0`, exit 1, janela 23:52:07–00:05:10. As 6 falhas são todas `DOWNLOAD_PROOF_TIMEOUT`, ~121,3 a 122,0 s:

| Forma | Duração |
| --- | --- |
| linha digitável do boleto | 121966 ms |
| PIN em composto maiúsculo | 121311 ms |
| PIN em nome de atributo | 121624 ms |
| radical no meio do token | 121406 ms |
| separador ponto | 121506 ms |
| prefixo arbitrário sem dígito | 121489 ms |

A espera que estoura é `waitForFourDownloads(extension, { auditId, timeoutMs: 120_000 })` em `test/e2e/credential-shapes-mv3.test.mjs:105`. A taxa medida bate com a da bateria do autor (5/23 ≈ 22%, mesmo modo de falha); a passagem 23/23 em 77 s relatada pelo agente coordenador existe, mas é o caso bom — logo **a variável não é "dois Chromes"**, é o estado de carga da máquina (na minha janela: `load averages` 2,08/1,96/2,36, 24 processos `node`, pipeline de outro projeto a 8,4% de CPU). Isto contraria a hipótese de contenção por concorrência de Chrome registrada no fechamento.

**A causa tem nome, e apareceu na execução a partir do PACOTE.** Na mesma janela, `sidepanel-flow-mv3.test.mjs` rodando da raiz extraída (`/private/tmp/adv1149/pkg149`, 00:09:46–00:16:14) deu **8/9** — a falha é o mesmo modo, e desta vez com o diagnóstico que o `exportFourFormats` monta (`:1506-1515`):

```
✖ original-page ABNT markers remain usable across idle and preserve the report (185690 ms)
  Error: PAGE_MARKERS_REPORT_AND_EXPORT_FAILED
    [cause]: EXPORT_DELIVERY_SNAPSHOT:{"receipt":null,"completed":[],"exportState":null,"exportLaunchStates":["revoked"]}
      [cause]: DOWNLOAD_PROOF_TIMEOUT
```

Ou seja: **a concessão de exportação terminou em `revoked`**, nenhum recibo foi gravado e os quatro downloads nunca fecharam. No produto, `src/background/export-launch.js:186-230` (a função que cria a concessão) marca a concessão como `revoked` no `catch` de qualquer falha da sequência de abertura da aba de exportação — `tabs.create`/`tabs.update`, a confirmação em `sessionArea`, ou a checagem de que a concessão continua `allocated`; o TTL de `:18` é de 15 min, muito acima dos 120 s do teste, então **não** é expiração. A outra rota para `revoked` é `revoke()` em `:337-350`, chamada quando a aba ou a janela da exportação some. **Qual das duas dispara sob carga eu não isolei** — o diagnóstico não distingue. O que está medido é a cadeia: carga → concessão de exportação `revoked` → `receipt: null` → `DOWNLOAD_PROOF_TIMEOUT`.

**O que não medi:** se os quatro downloads chegam **depois** dos 120 s (a sonda prova só que não fecham na janela) e qual das duas rotas de `revoked` dispara.

**Conserto:** instrumentar o caminho de falha do `credential-shapes` com o mesmo `EXPORT_DELIVERY_SNAPSHOT` e registrar o erro engolido pelo `catch` de `src/background/export-launch.js:222-228` (hoje ele não deixa rastro do motivo do `EXPORT_OPEN_FAILED`), para separar "a aba de exportação não abriu" de "a aba foi fechada durante a exportação". Enquanto isso, a bateria da versão não pode ser declarada verde.

### N-3 (Minor) — Quatro asserções de CSV foram removidas do E2E sem substituto, e medi que elas ainda passariam

Em `df4bd2d` existiam, em `test/e2e/sidepanel-flow-mv3.test.mjs:1559-1562`:

```js
assert.equal(record.tested_wcag_refs, '');
assert.equal(record.wcag_refs, '');
assert.equal(record.section_508_refs, '');
assert.equal(record.consumer_basis_ref, '');
```

Não existem na versão nova (o bloco correspondente termina em `:1592-1593`). Medida: sonda própria (`/private/tmp/adv1149/csvprobe.mjs`, preservada; a cópia que rodou dentro do clone foi removida) que renderiza o CSV pelo próprio produto (`renderOccurrenceCsv` + `enrichAuditForReport` sobre `fixtures/audits/sample-audit.js`):

```
{"ruleId":"focus-order","outcome":"cantTell","nbr":"5.1.4","tested_wcag_refs":"","wcag_refs":"","section_508_refs":"","consumer_basis_ref":""}
{"ruleId":"manual:5.7.5","outcome":"cantTell","nbr":"5.7.5","tested_wcag_refs":"","wcag_refs":"","section_508_refs":"","consumer_basis_ref":""}
```

A ocorrência conhecida do E2E novo é `axe.button-name` com `outcome: 'cantTell'` (o próprio teste exige `record.outcome === knownOccurrence.outcome`, `:1592`), e no produto `testedWcagRefs` é `[]` fora de `failed` (`src/core/report/audit-model.js:280-283`), `foreignBenchmarkRefs` deriva dele (`:310`) e `legalAnalysis` é `null` fora de `failed` (`src/core/legal/consumer-basis.js:49-52`). As quatro asserções **continuariam passando**: a remoção não foi exigida pela troca de oráculo. `tested_wcag_refs`/`wcag_refs` para `cantTell` seguem cobertos na unidade (`test/report/csv.test.js:108-110`); `section_508_refs` e `consumer_basis_ref` para `cantTell` não são mais afirmados em lugar nenhum.

### N-4 (Minor) — Três asserções do painel e do HTML ficaram mais fracas do que as que substituíram

1. `:1167` — era `assert.equal(detail.selector, '#missing-label')` (`df4bd2d:1147`); agora só exige string não vazia. O seletor exibido na ficha do painel não é mais correlacionado com a ocorrência conhecida (a correlação forte que sobrou, `:1090-1098`, usa o modelo persistido, não a ficha).
2. `:1171` — era `assert.match(detail.accessibility, /Anúncio esperado:\s*\S/u)` (`df4bd2d:1150`); agora só exige comprimento > 0. A seção de anúncio da ficha pode estar vazia de conteúdo útil.
3. `:1536` — era `html.includes('1.1.1')` **e** `html.includes('5.2.1')` (`df4bd2d:1505-1506`); agora só `html.includes(knownOccurrence.abnt)` (`5.13.10`). O HTML entregue não tem mais nenhuma citação WCAG afirmada (JSON e CSV mantêm: `:1563`, `:1594`).

### N-5 (Minor) — O oráculo de "documento intocado" perdoa qualquer número de `resize` e **não julga** a geometria transitória

`test/e2e/sidepanel-flow-mv3.test.mjs:698-702` subtrai do total de eventos **todos** os `resize` quando `allowCaptureResize` está ligado, e as amostras de geometria (`:560-566`) são removidas do objeto comparado (`:694`) — servem só de mensagem de diagnóstico. O que sobra exigido é: eventos não-`resize` = 0, mutações = 0, rolagem/foco/seleção/entrada/estilo iguais e geometria **final** igual (`:704-708`). Uma oscilação que leve o viewport a qualquer tamanho e volte passa; o número de `resize` não tem teto. Com a sonda N-1 medi 249 `resize` na fixture benigna (o autor declarou 248) — o teto continua inexistente. Conferi também que o perdão é concedido **apenas** onde há captura: `:205`, `:1111`, `:1185`, `:1220` (capturam) contra `:1033`, `:1069`, `:1871`, `:1936` (não capturam, exigência estrita).

### N-6 (Minor) — O anúncio novo é ambíguo logo depois de o painel trocar de tela

`src/panel/panel.js:498`: `announce('Escolha o modo e inicie uma nova auditoria. A tela não foi alterada.')` é emitido **depois** de o painel sair de `unavailable` e chegar a `initial`. No vocabulário do produto, "tela" é a tela do painel (o único uso voltado ao usuário é "leitores de tela", `src/panel/panel-view.js:1270`), não o documento observado; compare com o anúncio do caminho `result` (`:512`), que descreve o que de fato aconteceu ("O resultado anterior foi preservado"). Um usuário de leitor de tela ouve que a tela não foi alterada imediatamente após ela ter sido alterada.

### N-7 (Minor) — As três linhas consertadas não esgotam as linhas vencidas

| Onde | Linha vencida | Contradiz |
| --- | --- | --- |
| `docs/releases/1.1.48.md:1` | "# Audita Acessibilidade 1.1.48 — **versão candidata de produção**" | `README.md:20` ("1.1.48 — **fechada como produção** em 18/09/2026") e o §4 do dossiê |
| `docs/BETA-BACKLOG.md:13` e `:17` | sob "## Estado vigente — produção 1.1.49, 18/09" (`:5`), a prosa ainda é "a pausa histórica da **1.1.13**…" e "as instruções e README vigentes foram alinhados à **1.1.14** nesta entrega" | o título da própria seção e a versão vigente |
| `docs/qa/2026-09-17-prontidao-para-producao.md:25` (critério 10) | "Permanecem **declarados**: 1 Minor (**N-1**, §3) e os **9 testes** do incremento paralelo (outro desenho, **em andamento**)" | §4 do mesmo arquivo (18/09: N-1 corrigido, nove cenários migrados) e o registro do incremento |
| `docs/qa/2026-09-17-prontidao-para-producao.md:133-135` (§3) | N-1 ainda listado como resíduo aberto ("o achado fica no backlog de apresentação") | idem |
| `docs/qa/2026-09-18-incremento-1.1.49.md:50` vs dossiê `:27` | "antes: **7 falhas**" contra "fase serial 113 testes, 104 passam, **9 falham** — todas as 9 em `sidepanel-flow-mv3`" | mesma suíte, duas bases diferentes sem reconciliação. **Medi:** o arquivo antigo (`df4bd2d`) contra o produto atual dá **7 falhas / 2 passes** — o "7" do incremento é o número do produto atual; o "9" é da bateria da 1.1.48 (`docs/qa/2026-09-17-prontidao-para-producao.md:27`) |

### N-8 (Minor, fechamento) — A 1.1.49 está declarada "produção" com a bateria da versão aberta e vermelha

`README.md:7` ("**Versão 1.1.49 — produção.**") e `docs/releases/1.1.49.md:1` ("versão de produção") convivem com as linhas `docs/releases/1.1.49.md:38,39,41` e `docs/qa/2026-09-18-incremento-1.1.49.md:72-76` ainda "preenchido pela bateria final", e com o critério 12 do dossiê (`:27`) carregando os números da **1.1.48**. A bateria que estava rodando terminou com 6 falhas e **sem** resumo de fase serial e **sem** a linha `EXIT=`. Parte disso está explicada (a falha de `axe-mv3-csp` é flake de limpeza: não reproduziu, 1/1 verde isolado; o próprio dossiê `:27` já a registrava), mas o modo de falha de N-2 (concessão `revoked`) não tem causa isolada nem taxa declarada.

### N-9 (Observação) — O caminho novo é o único que volta a `initial` sem `reviseNavigationEntry()`; sondei e **não** consegui explorar

`src/panel/panel.js:492-499` não chama `reviseNavigationEntry()`, enquanto todos os outros caminhos para `initial` chamam (`:413`, `:435`, `:439`, `:447`, `:452`, `:509`, `:921`); o contador invalida continuações em voo de submissão de URL/lote (`:644`, `:659`, `:694`, `:710`). Sonda própria (`test/panel/adv-race-probe.test.js`, arquivo meu): submissão de URL em voo + queda para `unavailable` + `NEW_AUDIT` + resposta tardia da capacidade → **zero lançamentos de URL** em todos os cenários, incluindo quatro formas de bootstrap malformado. Duas barreiras explicam: a porta resolve e aposenta as pendências quando a sessão é aposentada (`src/panel/panel-session-port.js:299-306`) e trata resposta de requisição aposentada como violação de protocolo (`:477-479`, a tela `reconnecting` que a sonda mediu); e a guarda de `entryMode` (`:644`) aborta, porque `NEW_AUDIT_REQUESTED` devolve `entryMode: 'sources'` (`src/panel/panel-state.js:69`). Fica como assimetria de robustez (uma linha), não como defeito ativo.

## 3. O que se confirmou (com a medição)

### 3.1 N-1 corrigido no produto, com efeitos colaterais que procurei e não achei

- Reducer `src/panel/panel-state.js:476-483`: `NEW_AUDIT_REQUESTED` passa a valer de `unavailable`, devolvendo inicial com `captureMode` e persona preservados, `reason`/`auditId` limpos; a guarda `highlight.state === 'idle'` continua e `unavailablePanelState` sempre entra com `uncheckedHighlight()` (`:45-47`), cujo estado é `'idle'`.
- Handler `src/panel/panel.js:490-499`: o ramo de `unavailable` não tem `await` antes da transição → duplo clique não gera dupla transição (o segundo clique encontra `screen === 'initial'` e sai pela guarda de `:491`). `pageMarkers.reset()` é idempotente e seguro: `reset()` anula `context` e incrementa `generation`, e toda continuação de marcador confere `context !== captured || generation !== version` (`src/panel/page-markers-session.js:36-40,100-104,137-140`). `batchEntryDraft = ''` é o mesmo tratamento dos outros caminhos para `initial`.
- Motivo preservado: `src/panel/panel.js:854-870` captura `priorReason` antes do `RETRY_REQUESTED`; o reducer valida contra conjunto fechado (`PANEL_UNAVAILABLE_REASONS`, `src/panel/panel-state.js:23-31`, portão em `:301-303`); nenhum caminho escreve `state.reason` fora de `unavailablePanelState`; a renderização é `textContent` (`src/panel/panel-view.js:1215-1217`, `paragraph` em `:1330-1335`). **Não há vazamento de conteúdo nativo.**
- Rótulo: `src/panel/panel-view.js:1221` — "Escolher outro modo", intent `NEW_AUDIT`, `focusId` `new-audit`, o mesmo já usado na tela de resultado (`:615`); a tela de resultado segue com "Refazer auditoria".

**Dentes dos testes** (`node --test test/panel/*.test.js` na cópia mutada):

| Mutação | Resultado medido |
| --- | --- |
| (A) reducer volta a exigir `current.screen === 'result'` | **2 falhas** (263 testes, 261 passam) |
| (B) `reason: priorReason ?? genérico` → `reason: genérico` | **1 falha** (262 passam) |
| (D) guarda do handler volta a exigir `state.screen === 'result'` (reducer novo mantido) | **1 falha** (262 passam) |

Sem mutação: **263 testes, 263 passam, 0 falham** — e no worktree do pai (`df4bd2d`) o mesmo escopo dá **260 testes, 260 passam**, confirmando "260 → 263".

### 3.2 A migração E2E cobre o que o oráculo antigo cobria

Comparei asserção por asserção (32 hunks; 283 → 286 `assert.`). Os seis pontos provados antes continuam provados, por outro meio:

| Prova antiga | Prova nova | Veredito |
| --- | --- | --- |
| documento original intocado | `assertSourceUntouched` com identidade de alvo/frame/loader/URL | mantida |
| ausência de posse de aba (`assertCopyIsolation` exigia **1** aba criada e `owners.length===1`) | `assertNoCopyCreated`: `created` deepEqual `[]`, ativações/remoções 0, `ownedRecords` 0, posse de CDP estável | **mais forte** |
| pausa por privacidade no documento da cópia (`assertPausedCopyDocument`) | `assertPausedObservedAttempt`: `owners: []`, `auditPresent/modelPresent/reportPresent` falsos, `evidenceCount 0`, `sessionRasterDataUrls 0` + `assertNoCopyCreated` | equivalente no desenho novo |
| evidência correlacionada (`knownServerImageOccurrence`) | `knownLiveOccurrence` (ruleId + item + WCAG + `evidenceRefs` com `nodeId` e seletor) **e** resolução do seletor no documento vivo | **mais forte** |
| exclusão sem deixar a cópia | `isDurablyDeleted` exige `owners.length===0` **e** `ownedTabPresent===true` para a aba do usuário + `assertSourceUntouched` + `finalSurface.sourceOpen` | equivalente no desenho novo |
| quatro exportações | idem, com 4 formatos, mime, bytes, sha256, recibo cruzado e PDF `%PDF-`/`%%EOF` | mantida (com as perdas de N-4) |

As nove entradas do arquivo são 5 testes de topo + 4 subtestes do caso migrado; a migração tocou exatamente 7 entradas (2 do laço + 1 de topo + 4 subtestes) e deixou intactos os 2 testes que já eram passivos (conferido por `diff` do corpo do teste de memória: idêntico).

**"9/9 em 299 s"**: confirmado por mim (`test/e2e/sidepanel-flow-mv3.test.mjs`, 23:41:16–23:46:22, **9/9 passam, exit 0**, 306 s) e pela bateria do autor (log `:4626-4720`, tudo ✔, soma 297,6 s).

### 3.3 O pacote

Digest, 199 arquivos, versão, reconstrução, conteúdo × árvore: §0. `test/release-package.test.js:20` fixa o digest do **arquivo entregue** e `:142-146` confere as duas pontas (arquivo em `release/` e build fresco), além da conferência byte a byte do pacote contra a árvore (`:190-215`). `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` → exit 0, "manifest/CSP e axe 4.13.0 aprovados no Chrome for Testing 152.0.7977.64; … GREEN".

### 3.4 Documentação — o que o autor consertou é verdade

`docs/qa/revisoes/REVIEW-1.1.48.md` §6 diz literalmente "**O conserto A pode entrar no produto? SIM**" — a afirmação nova do dossiê §4 é verdadeira, inclusive com a ressalva de método que o próprio parecer declara. A URL de privacidade declarada como publicada responde **HTTP 200** e serve a política "versão 1.5, 8 de setembro de 2026".

### 3.5 Reprodução com Chrome — janelas, resultados e o que é inválido

| Janela | Arquivo | Resultado |
| --- | --- | --- |
| 23:41:16–23:46:22 (306 s) | `sidepanel-flow-mv3.test.mjs` (clone) | **9/9 passam, exit 0** |
| 23:46:22–23:46:24 | `adv-resize-probe.test.mjs` (1ª versão) | exit 1 por erro de montagem da sonda; sem resultado de produto (corrigida depois) |
| 23:46:24–23:46:25 | `axe-mv3-csp.test.mjs` | **1/1 passa, exit 0** — a falha do hook `after` da bateria **não reproduz** isolada (flake de limpeza já declarada) |
| 23:46:25–23:48:54 | `credential-shapes-mv3.test.mjs` | **INVÁLIDO** — interrompido por mim ao ver o cadeado; rodou concorrente com outro Chrome |
| 23:52:07–00:05:10 | `credential-shapes-mv3.test.mjs` (cadeado meu, um Chrome) | **23 testes, 17 passam, 6 falham**, exit 1 — N-2 |
| 00:05:10–00:05:14 | `adv-resize-probe.test.mjs` (5 experimentos) | **1/1 passa, exit 0** — tabela de N-1 |
| 00:05:14–00:06:51 | `adv-resize-reactive.test.mjs` (fixture reativa) | 5 testes, 2 passam, 3 falham — a reprovação **é** o resultado (N-1) |
| 00:06:51–00:09:46 | `adv-resize-count.test.mjs` (fixture do autor) | **5/5 passam, exit 0**; `resizeTotal: 249`, primeira amostra `1x1/1x1/1x1`, geometria final idêntica, `dom: true`, `mutationTotal: 0` |
| 00:09:46–00:16:14 | `sidepanel-flow-mv3.test.mjs` a partir de `/private/tmp/adv1149/pkg149` | **9 testes, 8 passam, 1 falha** — `original-page ABNT markers…` (185,7 s) com `EXPORT_DELIVERY_SNAPSHOT:{"receipt":null,"completed":[],"exportState":null,"exportLaunchStates":["revoked"]}` → N-2 |
| 00:16:14–00:19:30 | `adv-old-sidepanel.test.mjs` (arquivo de `df4bd2d`, produto atual) | **9 testes, 2 passam, 7 falham** — confirma "antes: 7 falhas (2 verdes de outros percursos)" |

### 3.6 Reconciliação do baseline e da suíte não-Chrome

- **Baseline pré-migração:** o arquivo antigo rodando contra o produto atual dá exatamente **7 falhas / 2 passes**, e os 2 passes são os testes que a migração **não** tocou (navegação por barra de endereços e observação de elementos só em memória). A alegação "antes: 7 falhas" está confirmada; o "9 falham" do dossiê `:27` é um número de outra bateria (1.1.48) e não descreve o produto atual — as duas frases precisam ser reconciliadas na documentação (N-7, última linha).
- **Suíte não-Chrome** (meu recorte, excluindo `test/e2e/`, rodada às 00:2x sem Chrome): **4190 testes, 4189 passam, 0 falham, 1 pulado**, exit 0, 43,9 s. Somando o teste de unidade do arnês em `test/e2e/support/real-chrome.test.mjs` (**39 testes, 39 passam**, medido à parte), chego a **4229**; o autor declara **4234** para a fase paralela (diferença de 5 testes, 0,1%, sem efeito sobre qualquer conclusão deste parecer). O `skipped` é o mesmo (1).

## 4. O que não foi medido

- **A fase serial completa (45 arquivos).** Medi o gate estático (exit 0), a suíte não-Chrome (4190/4189/0/1 + 39 do arnês), o escopo do painel (263/263; 260 no pai) e, com Chrome, oito execuções de arquivo listadas em §3.5. Não reexecutei a bateria inteira.
- **Se os quatro downloads chegam depois dos 120 s** nas 6 falhas de N-2, e **qual das duas rotas** marca a concessão de exportação como `revoked` (o diagnóstico não distingue; o `catch` de `src/background/export-launch.js:222-228` engole o motivo).
- **A auditoria ao vivo no Google, a contagem de páginas do PDF e a integridade dos quatro artefatos fora do que o E2E afirma.**
- **A oscilação numa página real de produção** (biblioteca responsiva, `deviceScaleFactor ≠ 1`, impressão física, iframes de terceiros). Minhas sondas cobrem o par CDP isolado e duas fixtures.
- **Leitor de tela real e teste com pessoa leiga.**
- **Rotas raras de marcadores** (por exemplo `OPEN_REPORT` falhando com marcadores visíveis): analisei o código, não medi com Chrome.
- **O efeito de `captureBeyondViewport` quando as métricas chegam malformadas** (o produto passa a usar a flag para *todo* recorte, como a própria unidade exige em `test/evidence/capture-evidence.test.js:108-117`): não medi esse caminho no navegador — se ele acontecer, a oscilação atinge até capturas dentro da viewport.

## 5. Veredito e condições

**NÃO PODE ENTRAR** como versão de produção. O desenho do incremento está aprovado por medição — N-1 correto e com testes que morrem sob mutação, pacote reconstruível e byte-idêntico, migração E2E 9/9, nenhum dos consertos enfraqueceu as seis provas centrais (as perdas de N-3/N-4 são reais mas menores). O que bloqueia é o que a própria versão declara e não sustenta:

1. **N-2 (Important):** a prova das quatro exportações falhou **6/23** com um único Chrome (e 1/9 na execução a partir do pacote), sempre com a concessão de exportação em `revoked`, `receipt: null` e `DOWNLOAD_PROOF_TIMEOUT`. Condição: registrar o motivo engolido em `src/background/export-launch.js:222-228`, instrumentar o `credential-shapes` com o `EXPORT_DELIVERY_SNAPSHOT`, medir a taxa numa janela controlada e declarar a causa; se a exportação do usuário puder não abrir sob carga, é defeito de produto.
2. **N-1 (Important):** a mensagem "A página foi observada sem alterar foco, rolagem ou layout" é falsa para páginas que reagem a `resize` (247 eventos, viewport a `1x1`, 496 mutações de DOM medidas; o oráculo do autor reprova esse caso). Condição: ou evitar a oscilação na captura de elementos (usar o raster de página inteira já existente), ou declarar o efeito na mensagem — e cobrir o caso reativo no oráculo de fonte intocada.
3. **N-8 (fechamento):** fechar a bateria da versão com a máquina controlada, preencher as seis linhas "preenchido pela bateria final" (`docs/releases/1.1.49.md:38-41`, `docs/qa/2026-09-18-incremento-1.1.49.md:72-76`) e atualizar o critério 12 do dossiê com os números da 1.1.49 antes de manter a palavra "produção" no README.
4. **N-7 (higiene):** corrigir as cinco linhas ainda vencidas (título da nota da 1.1.48, prosa 1.1.13/1.1.14 do backlog sob o título da 1.1.49, critério 10 e §3 do dossiê ainda listando N-1 e os nove testes como abertos, e a divergência 7 × 9 — agora resolvida por medição: **7 é o número do produto atual**).
5. **N-3/N-4/N-5/N-6 (menores):** repor as asserções removidas, devolver o teto à oscilação de `resize` (afirmando a geometria transitória, não só registrando-a), e ajustar o anúncio de `src/panel/panel.js:498`.

Os itens 1 e 2 são de **produto**; 3 e 4 são de **fechamento documental**; 5 é polimento de oráculo. As três linhas de produto do incremento (N-1 do autor) estão corretas e não precisam de nova revisão de desenho — o que não pode entrar é a versão declarada "produção" com a entrega das quatro exportações falhando de forma intermitente e com uma afirmação de não-alteração que a medição desmente em páginas reativas.
