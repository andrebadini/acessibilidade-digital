# REVISÃO INDEPENDENTE — Audita Acessibilidade 1.1.38

**Revisor:** agente independente (nenhum documento, comentário de código ou teste do autor foi aceito como prova; toda afirmação numérica abaixo tem comando próprio e saída bruta preservada em `/private/tmp/audita-review-138/evidence/`).

| Campo | Valor medido |
|---|---|
| Artefato | `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt/release/audita-acessibilidade-1.1.38.zip` — 199 arquivos, 4.333.348 bytes descomprimidos |
| SHA-256 medido | `c32281270b500e5e18618604d23fa903b10ccc885e273e174a46cf22c0aafb0d` — **idêntico ao declarado** |
| Commit do artefato | `733cd01` (`733cd0122b5575cc755a8e040253f6f514287277`, manifest 1.1.38) |
| `src/` do pacote × commit | `unzip -o` sobre clone e `git diff --stat 733cd01 -- src manifest.json assets vendor` → **vazio** (byte a byte) |
| Data/hora da revisão | 2026-09-17, 10:47Z–12:20Z (UTC) |
| Ambiente | macOS arm64; Node v26.5.0; Chrome for Testing 152.0.7977.64 (`/private/tmp/audita-cft152-fixed/...`), perfil temporário do harness, `--test-concurrency=1`; pypdf 6.10.0 |
| Raiz de medição (bytes empacotados) | `/private/tmp/audita-review-138/clone` — clone completo do worktree (`.git` + `release/`) com o zip sobreposto por `unzip -o` |
| Gerações de mutação | `682031e` (=`916c5e3`), `548025f`, `1ffef6c`, `55db44b`, `06e70fc`, `e03830a`, exportadas com `git archive` para `/private/tmp/audita-review-138/gen-<rev>` |
| Nada foi modificado no repositório | nenhum commit/push; nenhum arquivo criado em `docs/`; só HTTP para `https://www.google.com/` |

---

## 1. Veredito por alegação

| # | Alegação | Comando (resumo) | Resultado medido | Veredito |
|---|---|---|---|---|
| 1 | **C1 fechado** — caixa misturada no radical tarja e mantém a caixa | `node probes/c1.mjs`, `probes/case.mjs`, `probes/c1-model.mjs` (importa `src/core/privacy.js` e `normalize-napshot`) | 6/6 formas tarjadas com **caixa original preservada** (`"SeNhA: abc123" -> "SeNhA: [redacted]"`), também no caminho MODELO; 18/18 combinações (6 formas × `abc123`/`passarinho`/`flamingo`); 9/9 controles negativos tarjados nas 5 superfícies | **CONFIRMADO** |
| 2 | **C2 fechado** — prefixo arbitrário + valor fraco não chega a trecho/JSON/modelo/relatório | `probes/c2-model.mjs` (via `normalizeSnapshot`), `probes/hunt.mjs` | 7/7 formas da alegação (mais `data-minhasenhaforte`, `title="xsenhaforte: …"`) **fechadas na prosa, no trecho e no modelo** (vazavam em 682031e/548025f). Mas a **mesma classe continua aberta fora da prosa**: `sanitizeJsonData({'xsenha':'abc123'})` → `{"xsenha":"abc123"}` e `isSensitiveKeyName('data-xsenha')===false`; `{"chaveDeApi":"abc123"}` volta a vazar (era tarjado em 682031e) | **PARCIAL** |
| 3a | Preço do prefixo arbitrário: **39** palavras novas tarjadas no dicionário | `node probes/dict.mjs` (`/usr/share/dict/words`, minúsculas 3+ únicas) | **39** exatas (`archcupbearer…upbearer`), **0 tarjas perdidas**, 0 palavras portuguesas — reproduz o declarado | **CONFIRMADO** |
| 3b | Universo declarado **234.289** | `node -e` com 4 filtros | 210.626 (linha crua única) × **234.289** (após `trim`+`toLowerCase`+únicos). O número do autor só reproduz com case-folding antes do `Set` | **CONFIRMADO com ressalva de definição** |
| 3c | Custo do prefixo arbitrário em prosa | `probes/prose-fp.mjs`, `english-prose.txt` | 1/30 frases em pt-BR destruídas e **nova** vs 1.1.37 (`O pallbearer carregava o caixão…` → `O [redacted]`); em inglês **9/9** frases comuns com as 39 palavras viram `[redacted]` (todas novas) | **CONFIRMADO (resíduo declarado como "39 palavras"; o efeito em frase não estava declarado)** |
| 4 | Métrica da classe: `formas=92 fracos=72 combinações=543`, 0 vazamentos | `node --test test/core/credential-class-metric.test.js` | `ℹ formas=92 fracos=72 combinações=543`, `combinações=72 vazamentos=0`, 8/8 verdes. **Não vacuidade:** mesmo teste com `src` de 682031e → **2 testes reprovam**; trocando os 4 sentinelas por `qwerty1/borboleta/girassol/Plmoknijbuhv` → reprova 2 no `src` antigo e passa 8/8 no atual | **CONFIRMADO** |
| 5 | Dentes do E2E nas 4 formas novas | `AUDITA_E2E_CHROME=… node --test --test-concurrency=1 --test-name-pattern="caixa misturada\|prefixo arbitrário" test/e2e/credential-shapes-mv3.test.mjs` na árvore mutante `test@733cd01 + src@682031e` | **4/4 reprovam** (`mixed-case`, `mixed-case-phrase`, `arbitrary-prefix`, `arbitrary-prefix-tail`), vazando para *relatório, modelo e revisão guardados, artefato html, artefato json*; EXIT=1. No pacote, as mesmas 4 passam | **CONFIRMADO** |
| 5b | Robustez do E2E no pacote | arquivo completo (23 formas, Chrome real) | 22/23; a única falha é `data-userpin` com `DOWNLOAD_PROOF_TIMEOUT` (123 s) e **passa isolada em 3,1 s** | **PARCIAL (flake de orçamento de download, não vazamento)** |
| 6 | **D1** — limpeza só de abas próprias (reatestação viva antes de `removeTab`) | `node probes/d1.mjs`, `probes/d1b.mjs` (fakes próprios de `sessionArea`/`chromeAdapter`) | Reatestação existe, mas: (a) journal forjado com **`tabId` E `windowId` que casam** → `removeTab(99)` é chamado (V1 e V2); (b) `getTab` que **lança** → nada é fechado **e o registro vai para `removed`** (não `cleanup-pending`), com `clearAudit` devolvendo 1 | **REFUTADO (parcial)** |
| 7 | **D2** — sem pixels sem correlação durável, exceto lote | `node probes/d2.mjs` (`createPixelAttemptLifecycleV1`) | Guarda confirmada: 1 página + `dataUrl` + alça nula → `TERMINAL_COMMIT_DENIED`, 0 gravações. **Resíduo de lote confirmado**: modelo de 2 páginas com `dataUrl` (inclusive em `segments`) grava com `pixelAttemptCommit` **AUSENTE** | **CONFIRMADO (com o resíduo declarado medido)** |
| 8a | Fase paralela: 4.218 testes, 4.217 passam, 0 falham, 1 pulado, EXIT=0 | `node probes/run-parallel.mjs` (reusa `createTestPlan` do autor) no clone empacotado | `tests 4218 / pass 4217 / fail 0 / cancelled 0 / skipped 1`, `PARALLEL_EXIT=0` | **CONFIRMADO** |
| 8b | Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` GREEN | idem | `GREEN` com `130/146 (96/50), identidade neutra`, `VERIFY_EXIT=0` | **CONFIRMADO** |
| 8c | Fase serial de escopo: 63 testes, 56 passam, 7 falham (todas em `sidepanel-flow-mv3`) | `node --test --test-concurrency=1 credential-shapes-mv3 sidepanel-flow-mv3` | `tests 32 / pass 25 / fail 7`, EXIT=1; **as 7 falhas estão todas em `test/e2e/sidepanel-flow-mv3.test.mjs`** (linhas 120, 120, 1813, 1842, 1860, 1879 e a de `current-page`), causas `WAIT_TIMEOUT`×4, `CDP_COMMAND_TIMEOUT`, `FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED`. O total 63/56 não foi reproduzido porque a lista de arquivos do "escopo" não está no repositório | **PARCIAL** |
| 8d | Auditoria ao vivo no Google (pacote, `no-pixels`) | `live/live-google.test.mjs` (harness do próprio autor, `startUrl=https://www.google.com/`, artefatos preservados em `artifacts/`) | **0 falhas, 1 alerta, 3 suspeitas, 9 positivos, 109 no checklist, cobertura 28,5%, índice 9,0/10, 4 exportações `complete`, JSON com 146 assertions, HTML com 146/146 ids e títulos na matriz, PDF de 18 páginas com 146/146 ids (e 136/146 títulos por quebra de linha na extração), 0 `[redacted]` no HTML e no PDF** — todos os números declarados reproduzidos numa única execução (4,5 s) | **CONFIRMADO** |
| 9 | Critérios de conclusão | `node -e` sobre `NBR17225_ITEMS`, `scanNeutralIdentity`, `renderHtmlReport`, grep de `update_url`/`webstore` | 146 itens (96 requisitos + 50 recomendações, ids únicos), 130 regras, 0 erros de composição; identidade institucional: **0 achados**; nenhuma referência a Web Store/`update_url` no pacote; relatório separa `failed`/`alerts`/`humanReview`/`passed` + checklist que "não entra na contagem"; o texto nega explicitamente certificação ("não é nota, certificação ou declaração de conformidade") | **CONFIRMADO** |

---

## 2. Achados por severidade

### CRITICAL

Nenhum achado Critical **com entrega demonstrada** ao relatório/artefato. O achado de maior impacto (abaixo) fica em Important precisamente porque eu não consegui levá-lo a uma superfície entregue.

### IMPORTANT

#### I-1. Regressão de recall no vocabulário de CHAVE: `isSensitiveKeyName` perdeu o conector `de/da/do` (e prefixos arbitrários) — 30.550 formas, 23/28 nomes realistas

**Causa-raiz medida.** `markCamelBoundaries` decide *token a token* se a marca de camelCase fica: se a leitura contígua já é palavra do vocabulário de PROSA (`CONTIGUOUS_CREDENTIAL_WORD`), a marca é **removida** (`src/core/privacy.js:231-235`). Só que `SENSITIVE_KEY_NAME` (o vocabulário de CHAVE, `ID_NAME_SOURCE`, linha 359) usa **listas fechadas** e **não tem a regra do conector** que existe em `WORD_RADICAL_SOURCE` (linha 167). Resultado:

```
chaveDeApi   marked="chaveDeApi"  SENSITIVE_KEY_NAME.test=false  SENSITIVE_KEY.test=true   isSensitiveKeyName=false
senhaAtual   marked="senhaAtual"  SENSITIVE_KEY_NAME.test=true   SENSITIVE_KEY.test=true   isSensitiveKeyName=true
```

**Reprodução mínima (pacote 1.1.38):**
```bash
node probes/url.mjs /private/tmp/audita-review-138/clone
# LEAK https://exemplo.test/p?chaveDeApi=abc123  -> "https://exemplo.test/p?chaveDeApi=abc123"
# LEAK #chaveDeApi=abc123                        -> "https://exemplo.test/#chaveDeApi=abc123"
node probes/json-keys.mjs   # {"chaveDeApi":"abc123"} e {"senhaDeApi":"abc123"} sem tarja
node probes/selector.mjs    # div#chaveDeApi (confidence=high) e div[title="chaveDeApi"]
```
**É regressão desta geração, não resíduo antigo** (`probes/regression-pin.txt`):

| | 06e70fc (1.1.33) | 1ffef6c (1.1.36) | 682031e/548025f (1.1.37) | **e03830a/733cd01 (1.1.38)** |
|---|---|---|---|---|
| `sanitizeEvidenceUrl('…?chaveDeApi=…')` | tarja | tarja | **tarja** | **PASSA** |
| `sanitizeJsonData({chaveDeApi})` | tarja | tarja | **tarja** | **PASSA** |
| `buildStableSelector` com `id="chaveDeApi"` | — | — | **descarta** | **`div#chaveDeApi`** |

**Tamanho da classe** (`probes/class-delta.mjs`, produto cartesiano de radicais × conectores × caudas × prefixos):

```
UNIVERSO_TESTADO=341164  COBERTURA_PERDIDA=30550  COBERTURA_GANHA=0  PERDIDAS_COM_URL_AFETADA=30550
```

**Nomes realistas que perderam a tarja na URL (23/28):** `chaveDeApi`, `chaveDaApi`, `chaveDoBanco`, `chaveDeAcesso`, `chaveDeSeguranca`, `senhaDeAcesso`, `senhaDoUsuario`, `senhaDeUsuario`, `senhaDaConta`, `senhaDoBanco`, `tokenDeAcesso`, `tokenDeApi`, `tokenDeSessao`, `credencialDeAcesso`, `segredoDeApi`, `passwordDeApi`, `cpfDoTitular`, `pinDoCartao`, entre outros (`evidence/realistic-keys.txt`).

**Impacto.** `sanitizeEvidenceUrl` é a função que o produto usa para as URLs entregues (`chrome-adapter.js`, `panel-detail.js`, `collect-page.js`, `normalize-snapshot.sanitizeResourceUrl`) e o comentário do próprio módulo (linhas 23-27) declara que "a URL entregue é sanitizada". Além disso o **modelo normalizado** (entrada de todas as regras e das evidências) passa a carregar o segredo em `attributes.href`:

```bash
node evidence/href-path.txt   # {"id":"nav-0","href":"https://exemplo.test/pagina?chaveDeApi=LEAKAAA111"}
                              # {"id":"nav-2","href":"https://exemplo.test/pagina"}   <- ?senha= continua sendo removido
```

**Limite da minha medição (declarado).** Tentei 7 execuções de diagnóstico em Chrome real para levar o valor ao relatório/artefato (`attr-leak`, `diag-attr`, `diag2`–`diag7`): atributo em `<div>`/`<img>`/`<input>` com ocorrência, `href` de link vazio e de link "clique aqui", query da própria URL auditada, `id`/`title` semânticos. **Em todos, o valor não apareceu** nas 6 superfícies: o `snapshot` persistido não carrega o mapa de atributos (`{schemaVersion, retention, nodeCount, coverage, warnings}`) e os caminhos que copiam atributos para evidência são mais estreitos que o sanitizador. Ou seja: a promessa está quebrada na função e no modelo que alimenta as regras; **a entrega ao relatório não foi demonstrada por mim**. Se qualquer consumidor passar a ler `attributes.href` ou `SENSITIVE_KEY_NAME` diretamente (são APIs exportadas), o vazamento é imediato.

#### I-2. D1 não está fechado como declarado: journal forjado com janela casada fecha aba alheia; `getTab` que lança marca a aba como removida sem fechá-la

**Reprodução mínima** (`node probes/d1b.mjs`; fakes próprios, sem tocar no repositório):

```
A. baseline removeOwned (aba 5 viva)          retorno=obj  removeTab=[5]   journal=removed
B. getTab LANÇA                               retorno=obj  removeTab=[]    journal=removed      <-- nada fechado, registro descartado
C. getTab devolve null                        LANÇOU OWNERSHIP_DENIED/mismatch  removeTab=[]  journal=cleanup-pending
D. getTab devolve id diferente (99)           LANÇOU OWNERSHIP_DENIED/mismatch  removeTab=[]  journal=cleanup-pending
E. id reciclado na MESMA janela               retorno=obj  removeTab=[5]   journal=removed      <-- indistinguível
G. journal forjado p/ id 99 vivo na janela declarada   removeTab=[99]      journal=removed   <-- D1 aberto (V2)
I. V1 forjado p/ id 99 vivo na janela declarada        removeTab=[99]      journal=(apagado) <-- D1 aberto (V1)
J. V1 getTab LANÇA                            retorno=1    removeTab=[]    journal=(apagado)    <-- fail-open
```

**(a) Forja com janela casada.** `liveTabState` só compara `id` e `windowId`, e **os dois vêm do próprio registro** que o atacante escreve. O teste do autor (`owned-tabs.test.js:157`) cobre apenas a forja em que a aba 99 está em **outra** janela (`liveWindows.set(99, 4)` com journal em `windowId: 8`); escrevendo `windowId` igual ao da vítima, `removeTab(99)` acontece. O mesmo vale para **id reciclado na mesma janela** (E): uma aba diferente com o mesmo `id`/`windowId` é fechada.

**(b) `getTab` que lança é fail-open.** `liveTabState` converte exceção em `'absent'`; `cleanupV2` pula o `removeTab` e chama `updateState(..., 'removed')`. O adaptador real é `chrome.tabs.get` cru (`chrome-adapter.js:1770`), que **rejeita** tanto para "aba não existe" quanto para erro transitório — o código não distingue os dois. Efeito: a aba pode continuar aberta e o registro é dado como limpo (nenhuma retentativa futura a fecha). Isto **contradiz o comportamento declarado na revisão** ("nada é fechado e o registro fica `cleanup-pending`"): o registro vai para `removed` e `clearAudit` devolve 1. `removeTab` que lança, ao contrário, é tratado corretamente (volta a `cleanup-pending`, cenário F).

#### I-3. C2 continua aberto nas superfícies de CHAVE (prefixo arbitrário e cauda concatenada fora de lista)

`probes/json-keys.mjs` + `probes/model-hunt.mjs` + `probes/split-nodes.mjs` (pacote 1.1.38):

```
{"xsenha":"abc123"}  {"absenha":"abc123"}  {"chavedapi":"abc123"}  {"data-xsenha":"abc123"}   -> valor preservado
{"chaveDeApi": …}  {"chaveDaApi": …}  {"senhaDeApi": …}  {"data-chavedeapi": …}                -> valor preservado
normalizeSnapshot({'data-xsenha':'abc123'})  ->  attributes {"data-xsenha":"abc123"}   (682031e/1ffef6c: tarjado)
```
A correção do C2 foi feita no vocabulário de PROSA (`SENSITIVE_WORD_SOURCE`/`VALUE_LABEL_SOURCE`), que é o que o E2E exercita (`<p>xsenha: …</p>`). O vocabulário de CHAVE (`isSensitiveKeyName`, usado por `sanitizeJsonData`, `sanitizeHtmlSnippetSource` e `buildStableSelector`) não recebeu a mesma regra. `data-xsenha` funcionava até a 1.1.36 e regrediu na 1.1.37; `chaveDeApi` regrediu na 1.1.38 (I-1).

**Cauda NÃO enumerada (regressão de 1.1.36 → 1.1.37, não corrigida na 1.1.38)** — `probes/tails.mjs`, 559 combinações radicais×caudas realistas em minúsculas:

```
COMBINACOES=559  VAZAM_NA_1.1.38=383  DESTAS, ERAM_TARJADAS_NA_1.1.36=297
exemplos: senhavelha, senhaemail, senharede, senhawifi, senharoteador, senhaadministrador,
          senhapessoal, senhatrabalho, senhaempresa, senhainternet, senhamestre, senhafilho,
          senhaescola, senhagoverno, senhaservidor, senhateste, senhaproducao, chavevelha, chaveemail
```
No caminho MODELO, `senhavelha: abc123` sai intacto em `text`/`visibleText` (`probes/model-detail.txt`). **Não medi entrega** ao relatório/artefato (fixtures `diag3` negativas — o texto de um `<p>` não flagado não entra em evidência).

**Rótulo partido em nós (pré-existente em todas as gerações medidas):** `<p>senha</p><p>abc123</p>` e `<th>senha:</th><td>abc123</td>` deixam o valor em `text`/`visibleText` do nó do valor (`probes/split-nodes.txt`). É estrutural: cada nó é tarjado isoladamente; o encadeamento de nós só existe no sanitizador de trecho.

#### I-4. A métrica e o E2E do autor não cobrem a superfície de CHAVE (vacuidade parcial por construção)

- `test/e2e/credential-shapes-mv3.test.mjs` põe toda credencial em **texto** (`<p>`, `title` de `<input>`); nenhuma forma é uma **chave JSON** ou um **nome de atributo** arbitrário.
- A forma `data-userpin` (linha 31) **passa com o `src` de 682031e** — medi `--test-name-pattern="nome de atributo"` na árvore mutante: `pass 1 / fail 0`. Ou seja, ela não tem dentes para esta mutação (o autor não a inclui entre as 4 novas, mas ela é vendida como prova da classe de atributo).
- A asserção de `resource-url-privacy.test.mjs` usa `?token=` (radical de palavra inteira), que continua funcionando — o conector `de/da/do` não é exercitado em nenhum lugar da suíte.

### MINOR

#### M-1. Preço do prefixo arbitrário: 39 palavras, mas frases inteiras em inglês são destruídas
`39` confirmado (0 portuguesas, 0 tarjas perdidas). O efeito em **frases comuns** não estava declarado: 9/9 frases inglesas testadas viram `[redacted]` a partir da palavra (`"She has possession of the documents." -> "She has [redacted]"`), todas novas vs 1.1.37 (`evidence/english-prose.txt`). Em pt-BR, 1/30 (`pallbearer`, frase fabricada). O custo é limitado ao inglês e o produto é pt-BR, mas a auditoria ao vivo é em `google.com` (inglês) — nesta instância não houve destruição (0 `[redacted]`).

#### M-2. `data-userpin` estoura o orçamento de download sob carga
Na passagem do arquivo completo (23 formas), `data-userpin` falhou com `DOWNLOAD_PROOF_TIMEOUT` (123 s) e passou isolada em 3,1 s (`evidence/e2e-data-userpin-rerun.txt`). É o mesmo modo de falha que o próprio `run-tests.mjs` descreve; nenhuma relação com credencial.

#### M-3. JSON textual de página com chave legítima é destruído no fim
`redactSensitiveText('{"chaveiro":{"material":"latão","preco":30.0},"unidades":12}')` → `{"chaveiro":[redacted]` (idem `{"tokenizacao":…}`, `{"contaCorrente":…}`) — **pré-existente nas três gerações medidas**, não é regressão da 1.1.38. Os controles de prosa que o autor cita (`Chaveiro: R$ 30,00`, `A loja vende chaveiros personalizados.`, `Secretaria de Saúde: 12 unidades`, `tokenizador`, `chaveamento`) **estão preservados** — confirmei um a um.

#### M-4. Universo do dicionário depende da definição
O número 234.289 do autor só sai com `trim` + `toLowerCase` + `Set` (210.626 com a linha crua). O resultado substantivo (39) não muda. Registrar a definição do filtro no QA evita a reincidência do "denominador do dicionário" (M1 da revisão anterior).

### OBSERVAÇÕES (sem severidade)

- **O-1.** `withCamelMarks('chaveDeApi')` **remove** a marca de camelCase (linha 234) porque a leitura contígua casa o vocabulário de prosa; o efeito colateral em `SENSITIVE_KEY_NAME` é o I-1. Uma correção de uma linha é possível: manter a marca quando `SENSITIVE_KEY_NAME` não casaria a forma contígua, ou acrescentar `(?:d|de|da|do)?` ao `ID_NAME_SOURCE`.
- **O-2.** `sanitizeHtmlSnippetSource` preserva `id`/`name`/`autocomplete` de propósito e o `id="chaveDeApi"` aparece em relatório/modelo/artefatos (medido, `diag6`) — é identificador do autor, não valor de credencial; registro para não ser confundido com vazamento.
- **O-3.** O comentário em `src/core/privacy.js:924-927` afirma que a caixa misturada "continua ABERTA". **É comentário morto**: a medição mostra C1 fechado (6/6, caixa preservada, 18/18). Comentário obsoleto em arquivo de privacidade é risco de manutenção.
- **O-4.** A fase paralela roda 181 arquivos e **não inclui nenhum E2E de Chrome**; os números de suíte (4.218) não dizem nada sobre as formas de credencial, que vivem na fase serial (37 arquivos).

---

## 3. O que eu NÃO medi

1. **Entrega ao relatório/artefato do I-1 e do I-3.** Sete execuções de diagnóstico em Chrome real (`attr-leak`, `diag-attr`, `diag2`–`diag7`) não levaram nenhum dos valores residuais às 6 superfícies; os resultados negativos estão preservados. O que está medido é o sanitizador, o vocabulário de chave, o seletor e o modelo normalizado.
2. **Fase serial completa (37 arquivos).** Rodei os dois arquivos implicados pela alegação (32 testes, 25/7). O total "63 testes / 56 passam" não foi reproduzido porque a lista de arquivos do "escopo" não está versionada; as 7 falhas em `sidepanel-flow-mv3` estão confirmadas.
3. **"0 palavras partidas" no PDF.** Medi 23 linhas terminando em hífen no texto extraído por pypdf, **todas em fragmentos de HTML/URL de evidência** quebrados por largura (`aria-`, `data-`, `https://www2.camara.leg.br/...`), nenhuma em palavra de prosa. Não reproduzi o medidor exato do autor.
4. **Durabilidade do substituto de correlação no lote (D2).** Medi que o companheiro durável está ausente; não medi se o marcador por página em `chrome.storage.session` (memória, volátil na reinicialização do navegador) basta para a promessa "captura do documento B nunca atribuída à auditoria de A" em todos os percursos de lote.
5. **`isSensitiveKeyName` em outros consumidores** (`contentEditableRootAttributes`, `safeIdRefs`, `sanitizeWarning`) — o mesmo vocabulário regredido é usado ali; não medi o efeito de cada um.
6. **Variação de instância da auditoria ao vivo.** Uma execução; os números bateram 100% com o declarado, mas a instância do Google varia (o próprio QA do autor registra 17 vs 18 páginas para os mesmos bytes em 1.1.33).

---

## 4. Veredito final

# REPROVADO — para o escopo desta revisão

Motivos objetivos:

1. **Regressão de privacidade introduzida por esta geração (I-1).** O commit `e03830a` (o conserto do C1) fez `isSensitiveKeyName` **perder 30.550 formas** e **0 ganhar**, incluindo 23 de 28 nomes realistas (`chaveDeApi`, `chaveDeAcesso`, `cpfDoTitular`, `tokenDeAcesso`…). O `sanitizeEvidenceUrl` — a função que o produto declara usar para sanitizar a URL entregue — voltou a deixar passar credencial em consulta e em fragmento, o `sanitizeJsonData` voltou a deixar passar valor sob chave de credencial e o `buildStableSelector` passou a emitir `div#chaveDeApi` (era descartado em 682031e). Nenhuma dessas três perdas está declarada, nenhum teste do autor cobre o conector `de/da/do` no vocabulário de chave, e a métrica da classe (92/72/543) não a vê.
2. **D1 não está fechado como declarado (I-2).** A reatestação compara apenas `id` + `windowId`, ambos vindos do registro que o atacante escreve: journal forjado com a janela casada fecha a aba de terceiro (medido em V1 e V2), e `getTab` que lança marca a aba como `removed` sem fechá-la, ao contrário do comportamento declarado.
3. **C2 é PARCIAL (I-3):** fechado na prosa, aberto nas chaves/atributos, com 383/559 caudas realistas vazando no caminho de modelo e 297 delas tarjadas ainda na 1.1.36.

O que **está confirmado e é bom**: o C1 (18/18, caixa preservada, inclusive no modelo), o C2 em prosa, o preço declarado do prefixo arbitrário (39/0), a métrica da classe com dentes reais (reprova com o `src` anterior, mesmo trocando os sentinelas), o E2E das 4 formas novas (4/4 reprovam na mutação), a guarda do D2, a fase paralela (4.218/4.217/0/1, EXIT=0), o gate `verify` GREEN, os 146 itens normativos, a identidade neutra, a ausência de Web Store e — notavelmente — **todos os números da auditoria ao vivo no Google**, que reproduzi integralmente.

**Uma revisão de escopo não é aprovação do produto.** Este parecer cobre os bytes `c32281…fb0d` do commit `733cd01` e as alegações listadas na seção 1; ele não certifica o produto, não cobre a fase serial completa, não cobre a suíte de 37 arquivos de Chrome real, nem afirma que a classe "credencial da página chegando ao entregável" esteja fechada — pelo contrário: medi que ela continua aberta em superfícies que a suíte não exercita.

---

### Anexo — inventário de evidências (todas em `/private/tmp/audita-review-138/`)

- Probes: `probes/{c1,case,c1-model,c1-surfaces-negative,surfaces,compare,rootcause,chavedeapi,json-keys,json-text,url,selector,final-boundary,hunt,c2-model,model-hunt,model-detail,tails,dict,prose-fp,class-delta,realistic,metric*,d1,d1b,d2,split-nodes,model-path,run-parallel}.mjs`
- Saídas brutas: `evidence/*.txt` (65 arquivos, incluindo as execuções de Chrome `e2e-mutant.txt`, `e2e-packed-shapes.txt`, `serial-scope.txt`, `live-google2.txt`, `parallel-phase.txt`, `verify-gate.txt`, `diag*.txt`)
- Artefatos da auditoria ao vivo: `artifacts/google-1.1.38.{html,json,csv,pdf}` (PDF `6ad14e76…614b`, 18 páginas)
- Árvores de mutação: `mut-e2e/` (`test@733cd01` + `src@682031e`), `mut/old`, `mut/new`, `gen-<rev>/`
