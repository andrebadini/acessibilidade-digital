# Adendo ao parecer adversarial — verificação delta do conserto (commit `27a894a`)

## 0. Objeto, proveniência, ambiente e janelas

| | |
| --- | --- |
| Objeto | commit **`27a894a`** ("1.1.49: fecha os dois Important da revisão adversarial"), pai `2cf5a6b` (o commit do parecer anterior). Enquanto este adendo era escrito, o autor publicou **`75db4e5`** ("docs: registra o fecho da revisão"): **só documentação**, sem tocar `release/` — o digest do zip continua `a45a67b7…` e o produto medido aqui é o de `27a894a`. Os efeitos doc-only de `75db4e5` estão considerados em A-6 e foram conferidos por `git show`, não por medição |
| Diff | 18 arquivos, +677/−36; produto: `src/background/export-launch.js` (+19), `src/core/report/diagnostic-policy.js` (+9/−1), `src/panel/panel.js` (+7/−2) |
| Artefato | `release/audita-acessibilidade-1.1.49.zip` |
| Digest medido | `a45a67b7f11d7dfa5f4f0b29300bc1d6a4278625f54dd3e2f1970d0764512448` — **confere** com o declarado; **199** entradas; `version` = `version_name` = `1.1.49` |
| Reconstrução | `node scripts/build-release.mjs` no meu clone (`repo2`) devolve **exatamente** esse digest |
| Zip × árvore | `diff -r` **idêntico** em `manifest.json`, `src/`, `vendor/`, `assets/icons/`; fora, por desenho, `assets/icons/icon-1024.png` e `icon-source.svg` |
| Minhas árvores | `/private/tmp/adv1149/repo2` (clone em `27a894a`), `/private/tmp/adv1149/mut2` (worktree em `27a894a`, só para as mutações), `/private/tmp/adv1149/repo` (clone em `2cf5a6b`, para comparações) |
| Ambiente | macOS arm64, Node v26.5.0; Chrome for Testing **152.0.7977.64**, `--headless=new` (`AUDITA_E2E_CHROME=/private/tmp/adv169/chrome-cft-fresh`), sempre `--test-concurrency=1` |
| Serialização | cadeado `/private/tmp/audita-chrome-lock` **em minha posse** em todas as execuções de Chrome desta rodada (adquirido 02:06:50, liberado 02:17:05; readquirido 02:19:2x e liberado 02:19:44). Nenhum Chrome concorrente nessas janelas |
| Contaminação declarada | entre ~01:5x e 02:05 o **Chrome do autor** (escopo do pacote, `--load-extension=/private/tmp/adv1149-live/pkg149`) rodou em paralelo com duas passagens minhas da suíte não-Chrome (`load average` 6,07). Uma delas produziu o falso vermelho descrito em A-5; a outra foi repetida em janela quieta (§3.5) |

**Janelas de Chrome desta rodada:** `sidepanel-new` 02:06:50–02:12:38 · `cred-new` 02:12:38–02:13:57 · `reactive-mut-msg` 02:13:57–02:14:47 · `reactive-mut-noosc` 02:14:47–02:15:42 · `cred-120s` 02:15:42–02:17:00 · `resize-probe-new` 02:17:00–02:17:05 · `axe-mv3-csp` 02:19:2x–02:19:44. `load average` no início da primeira: 4,74 (decaindo do escopo do autor); nas demais, ~2–3.

## 1. Veredito em uma linha

**PODE ENTRAR, com condições** — os dois Important do parecer anterior estão **fechados por medição independente minha**: a janela de tolerância da exportação não abre buraco (10 cenários de sonda própria, 3 deles reprovando o código antigo) e some o modo de falha medida (`credential-shapes-mv3` **23/23** inclusive com o orçamento **antigo** de 120 s, que no produto anterior dava 6/23); a mensagem passiva é honesta e a suíte de página atual dá **10/10** (348 s) por medição minha; as condições que restam são de **prova e documentação** — em especial **A-1**, um Important de oráculo: o contador do teste reativo **não tem dentes** (passa com o efeito removido: 7 eventos do painel contra 253 do efeito real).

## 2. Achados

### A-1 (Important) — O contador do oráculo reativo não distingue o efeito da captura do redimensionamento que o próprio painel causa

O caso novo exige, no documento observado (`:1944-1945`):

```js
assert.match(after.counter ?? '', /^resizes=[1-9][0-9]* w=\d+ h=\d+$/u,
  'numa página que reage a `resize` o efeito declarado precisa estar MEDIDO, não suposto');
```

O contador da fixture conta **todos** os `resize` desde o carregamento da página — inclusive os que o **painel lateral** provoca ao abrir (o viewport sai de 1280 para 894). Mutei o produto na árvore `mut2` para eliminar o efeito (`src/browser/capture-evidence.js`: `captureBeyondViewport: !clipInsideViewports(...)` → `captureBeyondViewport: false`) e rodei o caso:

| Execução (02:13:57 e 02:14:47, cadeado meu, um Chrome) | Contador da página | Resultado do teste |
| --- | --- | --- |
| produto como está | `resizes=253 w=894 h=749` | **passa** (10/10 no arquivo) |
| produto mutado (sem oscilação da captura) | `resizes=7 w=894 h=749` | **passa** |

O `7` é o resíduo do redimensionamento do painel; a oscilação da captura vale **246** eventos. A asserção `[1-9][0-9]*` aceita os dois — ou seja, ela passa exatamente quando o efeito que diz medir não acontece. **A parte da mensagem tem dentes** (rodei a mutação simétrica, revertendo a frase para a versão antiga: o caso **reprova**, exit 1), mas a parte do efeito, não. O comentário do próprio teste ("MEDIDO, não suposto") não se sustenta com esta asserção.

Conserto (uma linha, no lugar certo): ler o contador no bloco de linha de base que o teste **já** monta depois de a geometria estabilizar e exigir um **delta** com piso proporcional às capturas — por exemplo `after.counter - baseline.counter >= 32` (o delta medido é 246; o resíduo do painel fica em 0 depois da estabilização). Alternativa mais forte: usar o `eventCounts.resize` do próprio `__auditaSourceInvariantV1`, que já é a prova de eventos da suíte, em vez do contador da fixture.

### A-2 (Minor) — O anúncio novo é uma afirmação absoluta que a própria medição N-1 desmente, e nada o fixa

`src/panel/panel.js:501` passou a anunciar `'A página observada não foi alterada.'`. É melhor que "A tela não foi alterada" (o N-6 do parecer), mas continua absoluto: numa página que reage a `resize`, o documento termina diferente do inicial — foi o que o autor passou a **declarar** no relatório e o que eu medi (247 eventos, 496 mutações). O que a ação faz é não tocar na página ao voltar ao seletor; a frase honesta seria do tipo "A página não foi alterada por esta ação." ou "Nenhuma nova auditoria foi iniciada.". Medi também que **nenhum teste fixa a string**: `grep -rn "página observada não foi alterada\|Escolha o modo" test/` só encontra o próprio `src/panel/panel.js`.

### A-3 (Minor) — O teto da oscilação tem duas fórmulas: proporcional em um ponto, fixo em três

`test/e2e/sidepanel-flow-mv3.test.mjs:705,728-729` exige `captureResizes <= maxCaptureResizes`, mas `maxCaptureResizes` só é passado em **uma** das quatro chamadas que perdoam `resize`:

| Chamada | Teto efetivo |
| --- | --- |
| `:1175` (`assertObservedTerminalAttempt`, com contagem de capturas) | `8 × capturas + 32` |
| `:227` (laço, janela ociosa), `:1267` (ficha do painel), `:1302` (relatório vivo) | padrão fixo **512** |

Não é buraco (512 é finito, e nessas três o valor medido é ~249), mas a alegação "o perdão ganhou teto `8 × capturas + 32`" vale para um ponto só. Conserto: derivar o teto também nas outras três (o `attempt.elements` está disponível em `:1267`/`:1302` via `readPrivateAttempt`, e em `:227` o alvo é conhecido).

### A-4 (Observação) — O oráculo trava o limite como comportamento esperado

Como A-1 exige `resizes >= 1` (e, com o conserto sugerido, um delta mínimo), o teste passa a **exigir que a oscilação aconteça**. Se um dia o produto evitar a oscilação (por exemplo capturando elementos a partir do raster de página inteira), o teste reprova e a mensagem passa a declarar um efeito inexistente — os dois têm de mudar juntos. Isso é inerente a declarar o limite; fica registrado para quem mexer depois.

### A-5 (Observação) — `test/browser/annotation-map.test.js:632` é flaky sob carga (falso vermelho possível na fase paralela)

| Condição | Resultado medido |
| --- | --- |
| suíte não-Chrome completa, com o Chrome do autor rodando (`load average` 6,07) | **2 falhas em 2 passagens** (`closes 0 !== 1`) |
| suíte não-Chrome completa, janela quieta | **0 falhas** (4190/4191, 1 pulado, 43,6 s) |
| arquivo isolado, 3 passagens em cada commit (`27a894a` e `2cf5a6b`) | **3/3 passam nos dois** |

O teste usa `timeoutMs: 5` e depende de um tique de microtarefa (`await Promise.resolve(); assert.equal(closes, 1)`), então a carga muda o vencedor da corrida. Não é regressão do `27a894a`; é ruído possível na fase paralela de qualquer bateria concorrida. Conserto (barato): aguardar a condição (`waitFor`) em vez de um tique fixo.

### A-6 (Minor, documentação) — Restou uma linha vencida: o critério 12 do dossiê ainda traz os números da 1.1.48

Estado medido por leitura de `27a894a` **e** de `75db4e5` (o commit doc-only seguinte, `git show`, sem `release/`, zip idêntico):

| Onde | Estado em `27a894a` | Estado em `75db4e5` |
| --- | --- | --- |
| `docs/qa/2026-09-17-prontidao-para-producao.md:27` (critério 12) | números da **1.1.48** (4.231/4.230/0; serial 113/104/9) | **continua igual** — é a única linha que falta |
| `docs/qa/2026-09-18-incremento-1.1.49.md:79` ("9 cenários — 9/9") | vencida (o arquivo agora tem 10 entradas) | **corrigida**: "10/10 verdes com o caso reativo novo (o arquivo tinha 9 entradas)" |
| `docs/qa/2026-09-18-incremento-1.1.49.md:82-83` ("preenchido pela medição final") | duas linhas em aberto | **preenchidas** (não há mais "preenchido" no arquivo) |
| `docs/releases/1.1.49.md` | escopo do pacote ainda sem número | **ganhou a linha** "Escopo E2E a partir da raiz extraída do pacote: `sidepanel-flow-mv3` **10/10**" |

A menção a "nove cenários / 9/9 em 299 s" que permanece no `README.md:11-14` e na linha 49 da nota de versão é **medição histórica da migração** (no `2cf5a6b` o arquivo tinha 9 entradas e deu 9/9 — eu reproduzi em 306 s), não uma afirmação sobre o arquivo atual; o caso reativo novo aparece no mesmo README e na nota. Não a trato como linha vencida, mas vale a pena qualificar ("na migração") para quem ler só o número.

### A-7 (Observação) — A tolerância é avaliada por evento; sem evento novo, a concessão vive até o TTL

`stagingNavigationPending` só é consultado dentro de `handleTabUpdated`. Se a aba ficar em `about:blank` e **nenhum** outro evento de `tabs.onUpdated` chegar, a concessão permanece `awaiting-connection` até o TTL de 15 min (`TTL_MS`), como já acontecia antes do conserto — o que a janela acrescenta é tolerar os eventos que **chegam** nos primeiros 30 s, não criar uma varredura nova. Não medi nenhuma consequência prática disso (a conexão da página de exportação continua exigindo URL canônica, contexto confiável e origem ativa), e registro para não ser lido como garantia de limpeza em 30 s.

### A-8 (Observação) — O conserto de N-9 (`reviseNavigationEntry()`) é defesa em profundidade, sem teste, e não é o que barra a corrida

Medi a corrida com a minha sonda (`test/panel/adv-race-probe.test.js`): submissão de URL em voo → queda para `unavailable` → `NEW_AUDIT` → resposta tardia da capacidade. Para saber se o `reviseNavigationEntry()` acrescentado é o que barra, removi a **outra** guarda (`state.entryMode !== 'single-url'`) nas duas árvores e rodei:

| Árvore | Lançamentos de URL |
| --- | --- |
| `mut2` (`27a894a`, com `reviseNavigationEntry()`) | **0** |
| `repo` (`2cf5a6b`, sem `reviseNavigationEntry()`) | **0** |

Ou seja: quem barra é a camada de porta (que resolve e aposenta as requisições pendentes quando a sessão é aposentada), não o contador de revisão. O acréscimo é simetria correta com os outros caminhos, mas **não é load-bearing** nos interleavings que consegui construir, e nenhum teste o cobre (o diff não toca `test/panel/`). Registro como Observação, não como defeito.

## 3. O que se confirmou (com a medição)

### 3.1 N-2 — a janela de 30 s não abre buraco (sonda própria, 10 cenários)

`test/background/adv-export-grace.test.js` (arquivo meu), 10/10 no código novo e **3 falhas nos mesmos cenários no código antigo** (a sonda tem dentes):

| Cenário | `27a894a` | `2cf5a6b` |
| --- | --- | --- |
| `about:blank` sem `pendingUrl`, idades 0 / 1 / 15.000 / 29.999 / **30.000** ms | tolera (concessão viva, sem `release`/`remove`) | **revoga** (o defeito) |
| o mesmo estado com idade 30.001 ms | **revoga** | revoga |
| `pendingUrl` externo com a aba em `about:blank` (idade 0) | **revoga na hora** | revoga |
| URL confirmada para outro destino (idade 0) | **revoga na hora** | revoga |
| URL esperada com `pendingUrl` externo (idade 0) | **revoga na hora** | revoga |
| aba errada, janela errada, leitura de aba falhando | **revoga** | revoga |
| idade negativa (relógio para trás) | **revoga** | revoga |
| depois de tolerar, a página de exportação conecta | **conclui** (`connected`) | — (não chega lá) |
| janela renovada por eventos tolerados? | **não** (conta da emissão da concessão) | — |

### 3.2 N-2 — a taxa some, e o que opera é o conserto de produto, não o orçamento maior

O commit também subiu o orçamento do teste (`waitForFourDownloads` 120 s → 300 s e o timeout do caso 300 s → 480 s), o que poderia mascarar o defeito. Medi as duas pontas:

| Produto | Orçamento | Resultado | Janela |
| --- | --- | --- | --- |
| `2cf5a6b` | 120 s | **17/23 (6 falhas** `DOWNLOAD_PROOF_TIMEOUT`) | 23:52:07–00:05:10 de 18/09, cadeado meu, um Chrome |
| `27a894a` | 300 s (como commitado) | **23/23**, exit 0, 79 s | 02:12:38–02:13:57 |
| `27a894a` | **120 s** (cópia minha `adv-credential-120s.test.mjs`, só o orçamento antigo) | **23/23**, exit 0, 78 s | 02:15:42–02:17:00 |

Com o **mesmo orçamento** que produzia falhas no produto antigo, o produto novo passa 23/23. Ressalva de método: a passagem antiga rodou com outra composição de carga (24 processos `node`, pipeline de outro projeto), então a comparação isola o **orçamento**, não o estado da máquina; a direção do erro, porém, é conservadora (a passagem nova rodou com `load average` 4,74 decaindo de 6,07).

### 3.3 N-1 — mensagem honesta, arquivo 10/10, e a mutação da mensagem reprova

- `test/e2e/sidepanel-flow-mv3.test.mjs` completo: **10/10 passam, exit 0, 348 s** (02:06:50–02:12:38), com o diagnóstico do caso novo `Chrome152; página reativa; resizes=253 w=894 h=749; geometria final idêntica; efeito declarado no relatório`.
- Mutação da mensagem (frase antiga de volta, em `mut2`): o caso reativo **reprova** (exit 1, 50,4 s) — as asserções de texto têm dentes: exigem as duas frases novas e proíbem a antiga.
- Mutação do efeito (`captureBeyondViewport: false`): **passa** — é o achado A-1.
- A mensagem nova está no produto (`src/core/report/diagnostic-policy.js`) e a frase é literal em `test/report/diagnostic-policy.test.js`; a captura em si **não mudou** nesta versão, e meus 5 experimentos seguem idênticos aos do parecer (E1 0/0; E2 2 eventos/6 mutações; E3 2/6; E4 0/0; E5 2/6; amostra `1x1` e retorno; geometria final igual em todos).

### 3.4 N-3, N-4, N-5, N-6 — verificados no diff e na execução

- **N-3:** as quatro asserções de CSV voltaram (`:1682-1685`, com o comentário do achado) e continuam verdadeiras (eu já as havia medido como `''` para o `cantTell`).
- **N-4:** o seletor da ficha agora resolve, no documento vivo, a um elemento com o defeito (botão sem nome **ou** campo sem rótulo) — asserção em `:1236-1251`; `Anúncio esperado:` de volta em `:1253`; a citação WCAG voltou ao HTML em `:1621`. Todos exercitados na passagem 10/10.
- **N-5:** teto + piso de `1×1` + amostragem a partir de 16 eventos (`:699-745`), com a nuance de A-3.
- **N-6:** a frase trocou (com A-2); **N-9:** a chamada foi acrescentada (com A-8).

### 3.5 Suíte não-Chrome e `axe` em janela quieta

- Não-Chrome (meu recorte, excluindo `test/e2e/`): **4191 testes, 4190 passam, 0 falham, 1 pulado**, exit 0, **43,6 s** em janela quieta (o autor declara 4.235/4.234/0; a diferença de 44 é o conjunto de testes de apoio sob `test/e2e/`, que o meu recorte exclui — somando `test/e2e/support/real-chrome.test.mjs`, 39 testes, chego a 4.230; a diferença residual de 5 testes não foi perseguida).
- Escopo do painel + `export-launch` + `diagnostic-policy` + `release-package` no commit novo: **195 testes, 195 passam**.
- `test/e2e/axe-mv3-csp.test.mjs` no commit novo, isolado e com cadeado: **1/1 passa** — a falha da fase serial é a flake de limpeza já declarada.

## 4. O que não foi medido

- **A fase serial completa (45 arquivos) do commit novo.** Medi os arquivos citados (o de página atual 10/10, credenciais 23/23, `axe` 1/1) e o pacote por digest/rebuild/zip×árvore; **não** reexecutei os 45 arquivos.
- **O escopo do pacote com Chrome nesta rodada.** O autor mediu **10/10 em ~5 min** a partir de `/private/tmp/adv1149-live/pkg149`; eu não reproduzi essa execução (rodei o arquivo a partir do meu clone e conferi o pacote byte a byte).
- **A variância da taxa de `credential-shapes`.** Tenho uma passagem com falhas (produto antigo, 6/23) e duas sem (produto novo, 23/23 e 23/23); não caracterizei a distribuição (n=1 por configuração).
- **A causa raiz do `annotation-map.test.js:632`** — caracterizei a sensibilidade a carga, não a corrida interna.
- **Se a tolerância de 30 s é suficiente em produção** (fora do laboratório): não medi redes lentas, disco lento nem perfis com muitos dados, que são o que estica a janela entre `tabs.create` e `tabs.update`.
- **Leitor de tela real, páginas reais de produção, `deviceScaleFactor ≠ 1`, impressão física e iframes de terceiros** — herdado do parecer anterior, continua não medido.

## 5. Veredito e condições

**PODE ENTRAR.** Os dois Important que sustentavam o "NÃO PODE ENTRAR" anterior estão fechados **por medição minha, não por relato**: a exportação deixou de ser revogada no estado intermediário da própria navegação (sonda de 10 cenários, sem buraco: navegação para fora, `pendingUrl` externo, aba/janela erradas, leitura falha e relógio para trás continuam revogando na hora, e a janela não se renova), e a taxa do arquivo de credenciais foi a 23/23 **inclusive com o orçamento antigo de 120 s**; a mensagem passiva passou a declarar o efeito, e a suíte de página atual dá 10/10 com a geometria final idêntica. As condições de fechamento, nenhuma delas de produto:

1. **A-1 (Important de prova):** dar dentes ao contador do caso reativo (delta contra a linha de base, não `>= 1`) — hoje ele passa com o efeito removido (7 vs 253). Enquanto isso não for feito, a prova do efeito declarado continua sendo a minha sonda e as medições do parecer, **não** o teste novo.
2. **A-2 (Minor):** ajustar a frase do anúncio (`src/panel/panel.js:501`) para não afirmar que a página não foi alterada, e fixá-la em teste.
3. **A-3 (Minor):** levar o teto proporcional às outras três chamadas que perdoam `resize`.
4. **A-6 (Minor, documentação):** atualizar o **critério 12** do dossiê com os números da 1.1.49 — as outras duas linhas que eu havia apontado foram fechadas em `75db4e5`, e as menções a "nove cenários / 9/9" que restam são o registro histórico da migração (qualificar com "na migração").
5. **A-5/A-7/A-8 (Observação):** registrar a flake do `annotation-map` como ruído conhecido da fase paralela, e as duas notas de desenho (tolerância por evento; `reviseNavigationEntry` como defesa em profundidade).
