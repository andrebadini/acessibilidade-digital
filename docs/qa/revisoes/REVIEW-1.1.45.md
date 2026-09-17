# Revisão integrada final — Audita Acessibilidade **1.1.45**

Revisor independente. Data: 17/09/2026. Chrome for Testing **152.0.7977.64** (macOS arm64), um Chrome por
vez, `--test-concurrency=1`.

| | |
| --- | --- |
| Artefato | `release/audita-acessibilidade-1.1.45.zip` (worktree `audita-mt`, branch `feature/audita-mt`, commit do artefato **`13c97d1`**, zip construído em **`358ed4a`**) |
| Digest medido | `9df21c059feade9b09a88283c11cac14ad07ea8d58d284e630359223548136a1` — **confere** com o declarado |
| Clone independente | `git clone --no-hardlinks --local <worktree> /private/tmp/audita-review-145/clone` (nunca `cp -R .git`) |
| Árvore de medição | `/private/tmp/audita-review-145/pkg` = zip + `test/ scripts/ fixtures/ node_modules`; `/private/tmp/audita-review-145/pkgf` = árvore do commit com o **zip sobreposto** (199/199 bytes idênticos, conferido com `diff -r`) |
| Evidência | `/private/tmp/audita-review-145/evidence/` (saída bruta de cada medição) |
| Sondas | `/private/tmp/audita-review-145/probes/` |
| Nada foi escrito no repositório do autor | confirmado (`git status` do worktree limpo quanto a arquivos meus; a única modificação é do próprio autor) |

**Veredito em uma linha: NÃO PRONTO.** Dois bloqueios medidos — um **Critical** de privacidade
*introduzido pela própria 1.1.45* (o conserto do Minor m-1) e um **Important** de percurso padrão
(auditoria da página atual nos modos de pixel **sem sinal sensível** é revogada em silêncio), cuja causa
declarada pelo autor **não confere com a medição**. Dos doze critérios, oito estão **atendidos** (1-7 e
12), dois estão atendidos **com ressalva** (9 tem um recurso parcial; 11 depende de o conserto do m-1 ser
fechado), um é **Parcial por decisão do usuário** (8) e **um não se sustenta** (10).

---

## 1. Veredito por critério

| # | Critério | Comando / medição | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | Percurso principal sem instabilidade de painel | `AUDITA_E2E_CHROME=… node --test --test-concurrency=1 test/e2e/mandatory-journey-mv3.test.mjs` (pkgf) | `the mandatory journey runs end to end in one session` **1/1 ✔ 3,46 s**, incluindo a asserção `the side panel must not resize itself during the journey` (`mandatory-journey-mv3.test.mjs:184`); `current-page-export-mv3` → `current-page audit exports four verified artifacts` **✔ 4,37 s**; nenhum contexto `POPUP` (asserção do próprio E2E) | **Atendido** |
| 2 | Relatório e quatro exportações | `p145-artifacts-e2e.test.mjs` (fixture de falhas) + inspeção do PDF página 1 | Quatro formatos `complete` com recibo durável por formato (HTML 341.434 B, PDF 1.130.245 B, CSV 84.603 B, JSON 359.265 B; sha256 por formato); PDF página 1 renderizado e inspecionado: título, escopo, "Estado da auditoria", os quatro grupos, "Formatos desta entrega" e limitações — coerente; HTML com os **seis blocos didáticos** por ocorrência ("Impacto para a pessoa usuária", "O que foi observado", "Como corrigir/revisar…", "Nome acessível e anúncio estimado", "Fundamentação normativa", "Capturas registradas") | **Atendido** |
| 3 | Destaque no elemento e documento certos | `node --test --test-concurrency=1 test/e2e/highlight-marking-mv3.test.mjs` e `…page-markers-signals-mv3.test.mjs` (pkgf) | `the panel highlight draws a marked box over the audited element` **1/1 ✔ 1,27 s**; `the panel draws numbered signals over the audited page` **1/1 ✔ 1,73 s**; no lote serial também ✔ `showing an off-screen occurrence brings it into view and marks it, without animating` | **Atendido** |
| 4 | A inspeção não altera a página | `p145-c4-nonmutation.test.mjs` (geometria, rolagem, foco, 8 tipos de evento, MutationObserver antes/durante/depois) | `no-pixels`: `tela=result`, **0/1 amostra divergente** (a única diferença é o contador de eventos que foi zerado antes do clique), `client=[894,749]`, `scroll=[0,117]`, `foco="foco"`, `alvoRect=[40,2083,220,80]`, `mutacoes=0`, `mutacoesAtributo=0` — idênticos antes/depois; `element-only`: geometria/rolagem/foco idênticos, 0 mutações, apenas eventos `scroll`/`resize` do próprio reflow do painel (mesma assinatura da linha de base) | **Atendido** (limite declarado: captura de regiões fora da viewport, `captureBeyondViewport=false`) |
| 5 | Evidências e privacidade | suíte serial: `url-pixel-consent-mv3` ✔ `URL pixel modes pause, survive worker restart, remain one-shot and clean owned tabs` (33,6 s); `batch-pixel-consent-mv3` ✔ `full-evidence batch resumes after restart, separately confirms both sensitive hidden pages, and exports their report` (15,1 s); varredura própria dos quatro artefatos + painel + relatório | Nenhuma ocorrência, nos artefatos entregues, de `consentId`, `capabilityId`, `eventNonce`, `navigationToken`, `ownershipId`, `sessionCapabilityId`, `hmac-sha256`, `panel-bootstrap` ou `pixel-capture` (busca literal); consentimento one-shot, prova de documento antes do raster e limpeza só do que é da auditoria são asserções dos dois E2E acima | **Atendido** |
| 6 | Contagens separadas e sem multiplicação por elemento | JSON/CSV/HTML entregues da fixture de falhas + auditoria ao vivo | `audit.itemResults` = **146** (8 `failed`, 98 `cantTell`, 4 `passed`, 36 `inapplicable`); `audit.manualReview` = **104 perguntas únicas** (102 itens; 2 itens com 2 perguntas por terem **2 ocorrências distintas** — não é multiplicação por elemento); `occurrences`=6 e `evidence`=7 separados; painel: 7 falhas / 1 alerta / 6 revisões / 4 positivos; CSV = 113 ocorrências (uma linha por ocorrência); **auditoria ao vivo no Google reproduz o dossiê: 0 / 1 / 3 / 9** | **Atendido** |
| 7 | Conclusões ABNT (146 = 96 + 50) e linguagem por classificação | verificação independente contra o PDF da norma (79 pp., `pypdf`) + cruzamento HTML × JSON | **146 itens = 96 requisitos + 50 recomendações** confirmado por **três marcações independentes do PDF** (cabeçalho de subseção, Sumário pp. 3-6, Anexo C pp. 53-78), amostra de 16 itens em 11 subseções (incluindo 5.9.1, 5.1.3, 5.9.7, 5.9.8, 5.1.5, 5.9.11) **16/16** com número, classificação e título corretos; produto-sem-PDF = 0, PDF-sem-produto = 0; as 5 notas editoriais do produto conferem contra o PDF; **linguagem coerente**: as 7 frases "Inconformidade ao item" do HTML entregue pertencem **todas** a itens `failed` **do tipo requisito** (0 suspeitas impressas como inconformidade) e o item de **recomendação** reprovado (5.11.2) sai como "Não atendido neste teste"; 5.9.7 sem produtor automático de `failed` (só dois `cantTell` + `inapplicable`) | **Atendido** (1 Minor de numeração: ver M-1) |
| 8 | Clareza para leigos | leitura do relatório entregue (PDF p. 1 + HTML) como leitor não técnico | **Parcial por decisão do usuário** (sem teste com pessoa de fora — não bloqueia, conforme instrução). Confusões registradas em M-3 | **Parcial (por decisão)** |
| 9 | Recursos obrigatórios | rastreabilidade recurso a recurso no código empacotado (medição própria + `evidence/c9-recursos.md`) | **14 atendidos, 1 parcial, 0 ausentes**: o único parcial é "validações brasileiras" — o rótulo não existe em README/COMO-USAR e **não há validador de CPF/CNPJ**; o que existe é a camada brasileira do produto (NBR 17225 com 146 itens, Libras 5.14.6, detecção VLibras/Hand Talk, base legal CDC, pt-BR/linguagem simples) e CPF/CNPJ apenas como vocabulário tarjado. Detalhe em §5 | **Atendido com 1 parcial** |
| 10 | Sem Critical/Important conhecido (produto inteiro) | caça própria em todas as superfícies + corpora das revisões anteriores contra os bytes empacotados | **Falha**: 1 **Critical** novo (C-1, regressão da 1.1.45) + 1 **Important** (I-1, percurso padrão silencioso com diagnóstico declarado refutado). Resíduos declarados conferidos e **confirmados como declarados** (20/25 ids PT-BR; `puk` coberto no JSON; `codigo*`/`conta*`, `api.key`, `private_key`, `name`/`autocomplete` e nós irmãos entregam valor; `chave·de·api` sanitizado na URL; prosa `pix-<família>`) | **Não atendido** |
| 11 | Achados menores documentados | `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md` × medição | As seis entradas m-1…m-6 da 1.1.45 conferem **com uma ressalva**: o m-1 fecha as formas que prometeu (verifiquei as cinco preservadas e as quatro seladas) mas o conserto **abre uma forma nova** (`secreto*`, §2/C-2) não registrada; m-2 (6.623/6.515) está escrito no documento de decisão e `VAZA=6.707/198.360` reproduz exatamente; m-3 (`preview-runtime-parity` sem `.git`) reproduz; m-4/m-5 (números de suíte/escopo) não reproduzem literalmente — ver M-2 | **Atendido com ressalva** |
| 12 | Versão empacotada testada | zip × `git archive 358ed4a`; `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify`; fase paralela e fase serial completas no zip; auditoria ao vivo no Google; integridade dos artefatos | Zip: **199/199 arquivos byte a byte idênticos**, nada fora da árvore, as duas exclusões esperadas de `assets/icons/` (`icon-1024.png`, `icon-source.svg`); gate **exit 0** ("130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN"); fase paralela **4.180 testes / 4.177 passam / 2 falham / 1 pulado** (as duas falhas são de ambiente e passam isoladas: `preview-runtime-parity` **5/5** numa árvore com `.git`; bitmap de `annotation-map` **26/26**); fase serial **106 / 98 / 8** (as 8 explicadas e re-medidas: `axe-mv3-csp` **1/1 isolado** — flake de limpeza; 7 em `sidepanel-flow-mv3`, o arquivo do incremento paralelo, 4 delas por contrato de posse que o produto anexado não implementa); auditoria **ao vivo no Google concluída** (4 downloads `complete`); integridade no HTML e no PDF entregues: **146/146 ids, 146/146 títulos, 5/5 notas editoriais, 0 `[redacted]`**, 112 "Verificar o item" / 0 "Inconformidade" (Google), PDF de **18 páginas** | **Atendido** |

---

## 2. Achados por severidade

### C-1 — **Critical (privacidade)** — o conserto do m-1 na 1.1.45 entrega o valor do elemento nos artefatos HTML e JSON

**Classe:** identificador `<família da língua><flexão><radical de credencial iniciado por S>`.
**Regressão:** a 1.1.41, 1.1.42, 1.1.43 e **1.1.44 (aprovada) selavam** estas formas; a 1.1.45 voltou a
entregá-las (a 1.1.40 também entregava — é reabertura de classe fechada, não forma pré-existente).

**Mecanismo medido** (`src/core/privacy.js`, `languageFamilyExemption`, linhas 445-459 da árvore
empacotada): a flexão era escolhida como a **maior** terminação medida que começa o resto e só o que
sobrava dela era conferido. Em `chaveiroSenha`, `plain = chaveirosenha` → família `chaveir` + flexão
`os` + resto `enha`; `enha` não é sinal → a exceção de palavra da língua é concedida e o valor sai. O
próprio produto reconhece `isSensitiveKeyName('chaveiroSenha') === true`, mas
`isLanguageWordForm('chaveiroSenha')` passou de `false` (1.1.44) para `true` (1.1.45).

**Medição nos bytes empacotados** (`probes/p145-classe-flexao.mjs`, corpus próprio de 896 formas =
28 palavras de família × 16 radicais iniciados por S × 2 caixas; `evidence/c10-classe-flexao.txt`):

| superfície | 1.1.45 (zip) | 1.1.44 | novas na 1.1.45 |
| --- | --- | --- | --- |
| trecho (`sanitizeHtmlSnippetSource`, `id`) | **478** vazam | 196 | **+282** |
| trecho (`class`) | **478** | 196 | **+282** |
| modelo colunar (`normalizeSnapshot`) | **478** | 196 | **+282** |
| chave JSON (`sanitizeJsonData`) | **268** | 196 | **+72** |

Em `probes/p145-flexao-hunter.mjs` (504 formas da família exata) são **18 formas novas** contra a 1.1.44:
`chaveiroSenha`, `chaveiroSegredo`, `chaveiroSecret`, `chaveiroSession`, `chaveiroSeed`,
`chaveirosenha`, `secretarioSenha`, `secretariaSenha`, `secretarioSegredo`, `secretariaSecret`,
`secretarioSession`, `secretarioSeed`, `secretariasenha`, `secretariosenha` (e as variantes de caixa).

**Prova ponta a ponta** (`probes/p145-leak-e2e.test.mjs`; fixture servida localmente, auditoria da
página atual em `no-pixels`, quatro exportações; `evidence/c10-leak-e2e-145.txt`):

```
LEAK145 [1.1.45] relatorio S1 texto=false html=true
LEAK145 [1.1.45] artefato …-….html  S1=true  S2=false S3=false redacted=4
LEAK145 [1.1.45] artefato …-….json  S1=true  S2=true  S3=true  redacted=3
LEAK145 [1.1.44] artefato …-….html  S1=false S2=false S3=false redacted=2
LEAK145 [1.1.44] artefato …-….json  S1=false S2=false S3=false redacted=1
```

Contexto bruto do JSON entregue (1.1.45):

```json
"<div id=\"chaveiroSenha\">AUDITA145SENTINELA7F3A9C</div>"
```

O sentinela é o **conteúdo do elemento cujo `id` é rótulo de credencial** — exatamente o que a decisão de
produto (`docs/qa/2026-09-17-decisao-identificador-ambiguo.md`, §"Como tratar um achado futuro": "se o
achado for vazamento … é Critical e se conserta") manda tratar como Critical.

**Reprodução mínima:**

```bash
cd /private/tmp/audita-review-145
node probes/p145-classe-flexao.mjs          # 478/478/268 contra 196/196/196 da 1.1.44
node probes/p145-minors.test.mjs            # chaveiroSenha no zip: vazou=true (a coluna 1.1.44 da sonda acima dá tarja)
AUDITA_E2E_CHROME="…/Google Chrome for Testing" \
  AUDITA_EXT_PATH=/private/tmp/audita-review-145/pkgf AUDITA_EXT_TAG=1.1.45 \
  node --test --test-concurrency=1 probes/p145-leak-e2e.test.mjs
```

**Correção do autor (não empacotada) — verificada por mim, e ainda incompleta (C-2).**

### C-2 — **Critical (mesma classe, residual do conserto não empacotado)** — a correção de `languageFamilyExemption` fecha as 18 formas mas deixa 32 abertas

O autor alterou `languageFamilyExemption` na árvore de trabalho (não no pacote) para conferir o resto
**inteiro** depois da família, sem escolher flexão. Verifiquei com as minhas sondas apontadas para
`/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`:

* `probes/wt-p145-classe-flexao.mjs` → 228/228/198 (contra 478/478/268 do pacote), mas
  **`NOVOS vs 1.1.44 = 32 no trecho/modelo e 2 no JSON`** (`evidence/wt-classe-flexao.txt`);
* `probes/wt-p145-flexao-hunter.mjs` → `NOVAS_NA_145 = 0` (as 18 formas que eu apontei estão seladas);
* as formas que o m-1 protegia continuam preservadas (`secretario`, `secretarios`,
  `secretariaDeSaude`, `tokenizacaoDeTexto`, `chaveiroDeLatão`, `obsession`, `possession`) e
  `chaveir-senha`/`chaveirpix`/`pix-chaveir`/`token-de-acesso` seguem selados
  (`evidence/wt-minors.txt`).

As 32 formas residuais são todas da forma **`secreto` + radical iniciado por S**
(`probes/p145-residual-secretos.mjs`: 14/182 no corpus dirigido): `secretoSenha`, `secretoSegredo`,
`secretoSecret`, `secretoSession`, `secretoSeed`, `secretoSessao`, `secretoSessoes` (e minúsculas). O
mecanismo agora é a **lista de prefixos de família**: a alternação contém `secretos`, que casa em
`secretosenha` e **consome o `s` inicial de `senha`**, deixando `enha` — limpo. A correção precisa
considerar **todas** as alternativas de família (ou exigir que o resto seja limpo para cada uma), não só
a primeira que casa.

**Prova ponta a ponta na árvore do autor** (`probes/p145-leak-e2e-secreto.test.mjs`,
`evidence/wt-leak-e2e-secreto.txt`):

```
LEAK145 [arvore-autor] artefato …-….html S1=true  S2=false S3=false redacted=3
LEAK145 [arvore-autor] contexto html S1 :: … <div id="secretoSenha">AUDITA145SENTINELA7F3A9C</div>
                                            <div id="secretoSegredo">[redac…
LEAK145 [arvore-autor] artefato …-….json S1=true  S2=false S3=false redacted=2
```

Ou seja: **se a 1.1.46 for empacotada com o conserto como está, a classe continua aberta** (em menor
tamanho), e as duas formas ficam no artefato entregue. Reportei ao autor durante a revisão.

### I-1 — **Important (percurso padrão)** — a auditoria da página atual em modo de pixel é **revogada em silêncio** quando a página não tem sinal sensível; o diagnóstico declarado **não confere**

O autor declara (`docs/qa/2026-09-17-percurso-pixels-pagina-atual.md` e dossiê §2) que "o percurso da
página atual em modo de pixel **não começa**", que "a confirmação de captura **nunca aparece**", que
"nenhum trabalho é criado" e que a causa raiz é a ordem no starter (registro
`audita:panel-bootstrap:v1:<windowId>` publicado **depois** da suspensão por consentimento).

Medi as três superfícies que ele pede (tela do painel, pacotes da porta, `chrome.storage.session`) em
**dois fixtures**, e o resultado **depende do fixture**:

**(a) Página COM sinal sensível (`type="password"` + `data-audita-private`), `element-only`, página
atual** (`probes/p145-pixel-confronto.test.mjs`, `evidence/c15-pixel-confronto.txt`) — o percurso
**começa, pausa, confirma e conclui**:

```
t=1s  tela=running  confirmar=true  status="Auditoria pausada. Confirme a captura de imagens ou cancele a auditoria."
      storage={"job":"privacy-paused","session":"privacy-paused","bootstrap":"consumed",
               "pixel":{"state":"paused","cats":["password","private-marker"]}}
t=1s  >>> CLICOU CONFIRMAR
t=2s  tela=result  botoes=[OPEN_REPORT, NEW_AUDIT, SHOW_PAGE_MARKERS, SELECT_OCCURRENCE, HIGHLIGHT_PAGE_OCCURRENCE, …]
      storage={"session":"result","bootstrap":"consumed"}
```

Isso **refuta** a descrição declarada: a confirmação aparece, o trabalho é criado, o registro de
bootstrap existe (`state:"consumed"` com o `auditId` correto) **junto** com a suspensão
(`audita:pixel-capture:v1:<auditId>` `state:"paused"`, categorias `["password","private-marker"]`), e o
percurso chega a `result`. A "prova exigida" pelo autor (E2E que veja a confirmação aparecer, confirme e
chegue a `result`, reprovando contra os bytes atuais) **já passa contra os bytes atuais**.

**(b) Página SEM sinal sensível (a fixture do próprio autor: `img` sem alt + `button` sem nome),
`element-only` e `full-evidence`** — a auditoria é **revogada**, o painel volta ao neutro e **não há
mensagem de erro**:

```
t=1s  tela=reconnecting  status="Reconectando o painel à página atual."   storage={"session":"revoked"}
t=2s  tela=initial       status="Escolha como iniciar a auditoria."       storage={"session":"revoked"}
```

Despejo completo de `chrome.storage.session` (`probes/p145-revogacao.test.mjs`,
`evidence/c15-revogacao.txt`): a única chave é `audita:audit-session-capability:v1:…` com
`"state":"revoked"`, e `audita:target-capability:v1:…` com `"state":"invalidated"`. **Não existe**
`audita:active-audit-job:v1`, **nem** `audita:panel-bootstrap:v1:*`, **nem** `audita:pixel-capture:v1:*`
— ou seja, **nenhuma suspensão chega a ser criada** e o começo é compensado antes do registro. A causa
declarada ("a pausa é criada sem registro e não há como ser entregue") é, portanto, **refutada também
por medição**: não há pausa nenhuma.

**Consequência de produto:** o modo **padrão** do painel é `full-evidence` (medido:
`initial.modes = [{full-evidence, checked:true}, …]`). Numa página comum — sem campo de senha, sem
marcador privado — o usuário clica em "Auditar a página atual", vê "Reconectando…" e volta à tela
inicial, **sem explicação**. O percurso **funciona** em `no-pixels` e funciona nos modos de pixel quando
há sinal sensível e para "Outra URL"/lote.

**Classificação:** **Important**, não Critical (não há perda de dado nem vazamento; há caminho
alternativo). E **não é** uma "lacuna declarada e delimitada" no sentido em que foi declarada: o sintoma
foi descrito com alcance errado ("não começa" em ambos os modos, sempre), a causa raiz está errada, a
prova exigida já passa, e o defeito real (revogação silenciosa no caso comum) não está documentado.
**Reprodução mínima:** `node probes/p145-pixel-confronto.test.mjs` (cenários B e C) e
`node probes/p145-revogacao.test.mjs`.

### M-1 — Minor — `printedId` duplicado `5.1.12` no catálogo e no artefato entregue

`NBR17225_ITEMS` tem 146 entradas com **145 `printedId` únicos**: dois itens compartilham `5.1.12` —
"Acessibilidade por teclado total" (recomendação, §5.1.12) e "Espaçamento entre as linhas"
(requisito, que a Seção 5 numera **5.12.1** e o Anexo C do PDF imprime como 5.1.12). O produto tem nota
editorial para o caso (`itemId 5.12.1`, `field printedId`, normalizado para "5.12.1 conforme a Seção 5"),
mas o **identificador do item continua `5.1.12`**: no HTML entregue medi **17 ocorrências de "5.12.1"** e
apenas **2 itens com `printedId` 5.1.12**; um deles é o que a própria referência chama de 5.12.1. Efeito:
rastreabilidade ambígua num relatório cujo propósito é citar a norma item a item. **Não é vazamento nem
falso resultado** — é numeração. Reprodução: `node -e "…NBR17225_ITEMS.map(i=>i.printedId)…"` (evidência
em §1/12 e `evidence/c7-abnt.md`).

### M-2 — Minor — números do dossiê/registro que não reproduzem literalmente

| Declarado | Medido por mim | Onde |
| --- | --- | --- |
| suíte "4.180/4.178/1, a única falha é o teste de empacotamento" | **4.180 / 4.177 / 2 falhas / 1 pulado**, e as duas falhas **não** são o empacotamento: `preview-runtime-parity` (falta `.git`; **5/5** num clone com `.git`) e o bitmap de `annotation-map` (**26/26** isolado) | `evidence/c12-parallel-pkgf.txt`, `c12-full-suite.txt` |
| escopo serial "57/58" (e "56/58", "58/58" nas rodadas anteriores) | fase serial completa no zip: **106 testes / 98 passam / 8 falham**; as 8: `axe-mv3-csp` (**1/1 isolado**, flake de limpeza `stage:"profile"`) e 7 em `sidepanel-flow-mv3` (arquivo do incremento paralelo; 4 delas por contrato de posse em cópia inativa que o fluxo anexado não implementa) | `evidence/c12-full-suite.txt`, `c1-axe-csp-isolado.txt` |
| "99 palavras do dicionário" | **91** no corpus de 210.626 palavras dos revisores anteriores (1.1.41: 93; 1.1.40: 0) — o número depende do universo do dicionário, já registrado como fragilidade | `evidence/c10-precision-145.txt` |
| "0 palavras partidas" no PDF | **24** quebras em hífen (`aria-controls`, `data-ved`, `nth-of-type`, `element-<hash>`, `NBR-17225`, `access-board`), **todas em hífen legítimo, 0 no meio de palavra** — a diferença é o instrumento (a regex do revisor conta quebra em hífen) | `evidence/live-google-145/google-145.pdf` + script de integridade |

### M-3 — Minor (critério 8) — o que um leitor não técnico tropeça no relatório entregue

Lido como leitor leigo (PDF página 1 + HTML): (a) o cabeçalho diz **"Limitações registradas (6)"** e
abaixo há **5 marcadores** — a conta inclui as duas cláusulas do próprio título, e o leitor conta 5;
(b) os detalhes das limitações começam com **códigos internos em maiúsculas**
(`PIXEL_CAPTURE_OMITTED:`, `BROWSER_VERSION_UNAVAILABLE:`, `DYNAMIC_PROBES_OMITTED_PASSIVE:`) —
registro declara que é contrato testado; (c) a frase de cobertura mistura **termos em inglês**
("passed, failed ou inapplicable") num relatório pt-BR; (d) em um achado, "**Nome acessível: .**" sai
como um campo vazio seguido de ponto; (e) "A auditoria foi concluída parcialmente e contém limitações
técnicas registradas nos diagnósticos." não diz ao leitor o que fazer. O que funciona bem e deve ser
preservado: "Resultado pendente não é falha confirmada; aprovação neste teste não certifica a página
inteira", "Cobertura automática: 28,5% … não é nota, certificação ou declaração de conformidade" e o
aviso honesto do anúncio estimado.

### M-4 — Minor (critério 9) — "validações brasileiras" não existe com esse nome nem como validador

O rótulo do critério não aparece em `README.md` nem em `docs/COMO-USAR.md`, e não há validação de
CPF/CNPJ (grep 0 em `src/`). O que o produto tem é a **camada brasileira de conformidade**: catálogo ABNT
NBR 17225 (146 itens, conferido contra o PDF), Libras no item 5.14.6, detecção de widgets VLibras/Hand
Talk, base legal CDC (`src/core/legal/consumer-basis.js`) e pt-BR/linguagem simples; CPF/CNPJ existem
apenas como **vocabulário tarjado** de privacidade (`src/core/privacy.js`). Se o recurso obrigatório
significava validadores de documentos brasileiros, ele **não existe**; se significava conformidade com a
norma brasileira, ele existe e está medido. Fica registrado para o usuário decidir o que o critério
pedia — não bloqueia, porque o artefato já está reprovado por C-1.

### Observação — estado da árvore de trabalho

O worktree tem, além do conserto em `src/core/privacy.js`, uma modificação **não commitada** em
`test/e2e/sidepanel-flow-mv3.test.mjs` (arquivo do incremento paralelo, com 87 linhas novas sobre
preservação de viewport em screenshot nativo). Não faz parte do artefato 1.1.45 e não foi medida aqui;
fica registrada porque a árvore medida pelo autor para o "escopo serial" pode divergir da commitada.

---

## 3. Resposta ao ponto específico pedido (percurso de pixel da página atual)

**A descrição do autor não confere.** Medi as três superfícies que ele indica e:

1. **Com sinal sensível** (o caso em que o consentimento é exigível), em `element-only` e `full-evidence`
   na página atual: a suspensão é criada (`audita:pixel-capture:v1:<auditId>` `state:"paused"`), o
   registro de bootstrap existe e é entregue (`state:"consumed"`), o painel mostra
   `[data-intent="CONFIRM_PIXEL_CAPTURE"]` em **menos de 1 s**, o clique confirma e a auditoria chega a
   `result` com as quatro exportações. **A "prova exigida" pelo autor já passa contra os bytes atuais.**
2. **Sem sinal sensível** (a fixture do autor): a auditoria é **revogada** (`session:"revoked"`,
   `target-capability:"invalidated"`), sem `active-audit-job`, sem `panel-bootstrap` e **sem
   `pixel-capture`** — logo não é "pausa sem registro": **não há pausa**. O painel volta a `initial` sem
   mensagem.
3. O código confirma a leitura: em `beginAuthorizedAudit` o `registerPendingBootstrap` (linha 2326) e o
   `publishRegisteredBootstrap` (2356) rodam **antes** de `execute()` (2385), que é onde o portão de
   privacidade pausa — a ordem declarada como causa está invertida na própria árvore.

**Veredito sobre o item:** o que existe é um **Important de produto** (o modo padrão falha em silêncio em
páginas sem sinal sensível), **não** uma "lacuna declarada e delimitada" como descrita — o escopo está
errado (não é "nunca começa"), a causa raiz está errada e a prova exigida já é satisfeita. A parte
verdadeira da declaração (existe um defeito real no percurso de pixel da página atual) **não** isenta o
diagnóstico: quem for consertar precisa medir a revogação, não a ordem do bootstrap.

---

## 4. O que **não** foi medido (risco declarado)

* **Teste com pessoa leiga** (critério 8) — por decisão do usuário; minha leitura é de revisor, não de
  usuário real. Nenhum leitor de tela real foi usado.
* **Fase serial sob carga repetida**: medi uma execução completa (106 testes) mais as re-execuções
  isoladas das falhas; não medi a distribuição de flakiness em N rodadas.
* **`deviceScaleFactor ≠ 1`**, impressão física em papel, e o caminho de captura de regiões **fora da
  viewport** (limite declarado do produto).
* **Mapeamento WCAG 2.2 item a item** e os campos `evaluation`/`ruleIds` do catálogo (a amostra de 16
  itens conferiu número/classificação/título, não a matriz de critérios).
* **Auditoria ao vivo em páginas com credencial real** — a superfície de vazamento foi medida com
  fixture controlada e sentinelas, não em página pública.
* **A correção não empacotada do autor**: medi-a com as minhas sondas e um E2E na árvore de trabalho,
  mas ela não é o artefato 1.1.45 e não passou por suíte completa/gate.

---

## 5. Recursos obrigatórios (critério 9) — medição resumida

Medição própria no código empacotado (`grep`/`node`, comandos reproduzíveis a partir de
`/private/tmp/audita-review-145/pkgf`), nos artefatos entregues e no lote serial em Chrome 152 canônico;
rastreabilidade complementar com testes em `/private/tmp/audita-review-145/evidence/c9-recursos.md`
(essa sonda rodou numa cópia da árvore com **Chrome for Testing 149** e dois portões de ambiente
relaxados, com `src/`/`manifest.json` byte-idênticos — por isso trato os E2E dela como indício, e os
meus, em Chrome 152 sem alteração, como prova). Resultado: **14 atendidos, 1 parcial, 0 ausentes**.

| Recurso | Onde medi |
| --- | --- |
| 1. Campo de URL | `src/panel/panel-view.js` (`audit-url`, 12 ocorrências); E2E `url-audit-mv3` ✔ |
| 2. Auditoria da página aberta | `src/panel/panel-view.js` + `panel.js` (`START_ATTACHED`); `side-panel-intent-router.js` `startAttached`; `mandatory-journey-mv3` ✔ |
| 3. Refazer auditoria | `panel-view.js` ("Iniciar nova auditoria", intenção `NEW_AUDIT`) |
| 4. Progresso simples | `panel-view.js` (`<progress>` + `copyProgress`) e `panel.css` (`[data-phase-state]`); `assertObservedProgress` no E2E |
| 5. Relatório em aba própria | `src/review/index.html`, intenção `OPEN_REPORT`; `waitForReport` no E2E |
| 6. Filtros clicáveis | `src/core/report/report-view-script.js` e `src/review/report-view.js` (`data-report-filter`); **18** controles no DOM do relatório entregue |
| 7. Agrupamento expansível por item | `src/panel/panel-view.js` (`abnt-group`, `details/summary`) |
| 8. Destaques | `panel-view.js` (`highlight-occurrence`); `highlight-marking-mv3` **1/1 ✔** e `page-markers-signals-mv3` **1/1 ✔** |
| 9. Personas (leitor de tela/daltonismo/teclado) | `src/personas/` (4 módulos) + `PERSONA_SELECT`; E2E `personas-mv3-csp` ✔ |
| 10. Anúncios estimados com aviso honesto | `src/core/report/html.js` ("Anúncio estimado" + "Esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o leitor e as preferências") |
| 11. Menu de contexto como atalho | `src/background/context-menu.js` (`contextMenus`; `manifest.json` declara a permissão) |
| 12. Lote de URLs | `OPEN_BATCH_FORM` no painel; `src/background/run-batch.js`; E2E de lote ✔ |
| 13. Validações brasileiras | **Parcial**: o rótulo "validações brasileiras" não existe em `README.md`/`docs/COMO-USAR.md` e **não há validador de CPF/CNPJ** (grep 0). O que existe com outro nome: catálogo ABNT NBR 17225 (146 itens, conferido contra o PDF), Libras no item 5.14.6, detecção de VLibras/Hand Talk, base legal brasileira (`src/core/legal/consumer-basis.js`, CDC Lei 8.078/1990) e conteúdo pt-BR/linguagem simples; CPF/CNPJ aparecem apenas como vocabulário tarjado em `src/core/privacy.js` |
| 14. Quatro exportações | `src/export/export-formats.js` (`html`, `pdf`, `csv`, `json`) com recibo durável por formato; E2E entrega os quatro com sha256 ✔ |
| 15. Sem login | `manifest.json`: permissões `alarms, contextMenus, debugger, downloads, scripting, sidePanel, storage, tabs` — **sem** `identity`, **sem** `oauth2`; `connect-src 'self'`; nenhuma autenticação obrigatória |

---

## 6. Veredito final

# NÃO PRONTO

**O que falta, em ordem de bloqueio:**

1. **Fechar a classe do C-1 e do C-2** (vazamento de conteúdo de elemento em identificador
   `família+flexão+radical`, e o residual `secreto*` do conserto em curso). O conserto precisa conferir
   **todas** as alternativas de família — não só a primeira que casa — e a prova tem de ser um E2E que
   **reprove** contra os bytes da 1.1.45 e passe depois, nas quatro superfícies (trecho, modelo, chave
   JSON e artefatos HTML/JSON entregues), como o meu `p145-leak-e2e.test.mjs`.
2. **Reempacotar e refazer esta revisão sobre o novo zip** (nova versão, novo digest, 199/199 conferidos,
   suíte + gate + escopo serial + auditoria ao vivo). A 1.1.45 **não pode ir para produção com o C-1**:
   o valor do elemento sai no HTML e no JSON entregues ao usuário.
3. **Corrigir o diagnóstico e o escopo do percurso de pixel da página atual** (I-1): medir a **revogação**
   que ocorre quando a página não tem sinal sensível (o modo padrão é `full-evidence`), dar mensagem ao
   usuário em vez de voltar ao neutro, e reescrever
   `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md` e o dossiê — a causa raiz declarada
   (ordenação do bootstrap) e o alcance declarado ("não começa", "a confirmação nunca aparece") estão
   refutados por medição, e a prova exigida já passa nos bytes atuais para páginas com sinal sensível.
4. **Resolver ou declarar** o `printedId` duplicado `5.1.12` (M-1), alinhar os números de suíte/escopo do
   dossiê com a medição (M-2) e decidir o que o critério 9 pedia por "validações brasileiras" (M-4).

**O que já está sólido e não precisa ser refeito:** integridade do pacote (199/199 byte a byte, digest,
nada fora da árvore), gate `verify` GREEN, suíte unitária sem falha de produto (4.180 testes; as duas
falhas são de ambiente e passam isoladas), percurso principal e destaques em Chrome real, quatro
exportações com recibo durável, não-alteração da página observada em `no-pixels`, evidências e
consentimento one-shot, contagens separadas, catálogo ABNT 146 = 96 + 50 conferido contra o PDF com
linguagem coerente por classificação, auditoria ao vivo no Google com integridade 146/146 e 0
`[redacted]`, e os recursos obrigatórios 15/15.

---

## 7. Adendo — verificação da correção **1.1.46** (não empacotada), a pedido do autor

Durante a revisão o autor commitou `76ea651` e `799455c` na árvore de trabalho (1.1.46, **sem zip
construído**). Apontei **as minhas próprias sondas e os meus dois E2E** para essa árvore:

| Medição | 1.1.45 (zip) | 1.1.44 (aprovada) | árvore 1.1.46 |
| --- | --- | --- | --- |
| `p145-classe-flexao.mjs` (896 formas): trecho / modelo / JSON | 478 / 478 / 268 | 196 / 196 / 196 | **196 / 196 / 196** |
| `NOVOS vs 1.1.44` (trecho / modelo / JSON) | +282 / +282 / +72 | — | **0 / 0 / 0** |
| `p145-residual-secretos.mjs` (`secreto*` + S, 182 formas) | 14 vazam | 0 | **0** |
| inocentes do m-1 (`secretario`, `secretarios`, `secretariaDeSaude`, `tokenizacaoDeTexto`, `chaveiroDeLatão`, `obsession`, `possession`) | preservados | preservados | **preservados** |
| selados (`chaveir-senha`, `chaveirpix`, `pix-chaveir`, `token-de-acesso`, `chaveiroSenha`) | selados | selados | **selados** |
| E2E ponta a ponta A (`chaveiroSenha`, `secretarioSenha`, `pinturaSegredo`) nos 4 artefatos | **S1/S2/S3 no HTML e no JSON** | nenhum | **nenhum** |
| E2E ponta a ponta B (`secretoSenha`, `secretoSegredo`) nos 4 artefatos | S1 no HTML e no JSON | — | **nenhum** |

Evidência: `evidence/wt2-classe-flexao.txt`, `evidence/wt2-residual.txt`, `evidence/wt2-leak-e2e-A.txt`,
`evidence/wt2-leak-e2e-B.txt`. **As duas correções conferem com o que o autor declarou** e fecham C-1 e
C-2 nos meus instrumentos.

Isso **não altera o veredito da 1.1.45**: o artefato revisado continua com o Critical e continua
`NÃO PRONTO`. O que falta para a 1.1.46 é o ciclo normal — **construir o zip, refazer a suíte completa, o
gate, o escopo serial, a auditoria ao vivo e a integridade dos artefatos sobre os bytes novos**, mais a
correção do defeito do pixel (I-1), que segue aberto.
