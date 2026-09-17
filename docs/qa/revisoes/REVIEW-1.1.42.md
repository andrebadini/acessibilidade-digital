# REVIEW-1.1.42 — revisão independente e adversarial do artefato Audita Acessibilidade 1.1.42

Revisor independente e adversarial. **Nenhuma afirmação do autor foi aceita como prova**: toda medida
abaixo foi produzida por comando próprio e a saída bruta está em `/private/tmp/audita-review-142/evidence/`.
**Nada foi escrito dentro do repositório do autor** — nem no worktree, nem no `.git`.

## Ambiente de medição

| Item | Valor |
| --- | --- |
| Worktree do autor (somente leitura) | `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`, branch `feature/audita-mt` |
| Commit do artefato | `1f0abb6` (o zip é adicionado nesse commit; `fb5b824` é o conserto de código) |
| Clone independente (regra 1) | `git -C <worktree> clone --no-hardlinks --local … /private/tmp/audita-review-142/clone` — **sem `cp -R .git`** |
| Raiz de medição (regra 2) | `/private/tmp/audita-review-142/root` = `git archive 1f0abb6` **com o zip sobreposto** (`unzip -o`), mais `test/`, `scripts/`, `fixtures/` e `node_modules` (axe-core 4.13.0). Os 198 arquivos de `src/`+`assets/`+`manifest.json` foram reconferidos com `cmp` depois da sobreposição: **0 divergências** |
| Gerações de comparação | 1.1.41 = `4df8c8c` (`mut-141`, conferido byte a byte contra `release/audita-acessibilidade-1.1.41.zip`: 199/199), 1.1.40 = `c9d7dd4` (`mut-140`, idem 199/199), 1.1.39 = `746a696` (`mut-139`) |
| Chrome (regra 3) | `Google Chrome for Testing 152.0.7977.64`, **um Chrome por vez**, `--test-concurrency=1` |
| Node | v26.5.0 |

## 0. Integridade do pacote

| Medida | Comando próprio | Resultado |
| --- | --- | --- |
| SHA-256 do zip | `shasum -a 256 release/audita-acessibilidade-1.1.42.zip` | `4d960106535fa52a2ccb9e00e2b13e9303ffb2c0b9f9d5e55f5d035b8ade787e` — **igual ao declarado** |
| Arquivos no zip | `unzip -Z1` | **199** |
| Nada no zip fora do commit | `cmp` arquivo a arquivo contra `git archive 1f0abb6` | **0 arquivos só no zip**, **0 divergências de bytes** |
| O que o commit tem e o zip não | `find` no `git archive` restrito a `src/ assets/ vendor/ manifest.json` | **2**: `assets/icons/icon-1024.png` e `assets/icons/icon-source.svg` — exclusão **deliberada** do empacotador (`scripts/build-release.mjs` copia só `manifest.json`, `src/`, `vendor/` e `icon-{16,32,48,128}.png`) |
| Versão no artefato | `manifest.json` empacotado | `1.1.42` |
| Commit que reproduz os bytes | `git log -- release/audita-acessibilidade-1.1.42.zip` | **`1f0abb6`**; os dois commits posteriores (`e7ba47c`, `979693a`) tocam **apenas** `README.md` e `docs/qa/*.md` — `src/`, `test/` e `scripts/` são idênticos |

Evidência: `evidence/integridade-142.txt`, `cmp-diff.txt` (0 linhas), `cmp-missing-archive.txt` (0 linhas),
`cmp-extra-zip.txt` (2 linhas), `zipvsarchive.out`, `ziplist.txt`.

> **Nota de estado do worktree.** Quando esta revisão começou, o `HEAD` do worktree estava em `979693a`
> (dois commits de documentação depois do artefato) com `M test/e2e/sidepanel-flow-mv3.test.mjs` no diretório
> de trabalho; ao terminar, o `HEAD` do worktree já era `956c126` (avanço do próprio autor para a geração
> seguinte). O `.git` do worktree continua sendo o arquivo-ponteiro
> (`gitdir: /Volumes/SSD1/acessibilidade-digital/.git/worktrees/audita-mt`) e **não foi tocado**; todo comando
> `git` de medição rodou com `git -C` na minha cópia, o zip do autor continua com o digest
> `4d960106…787e`, e **nenhum arquivo do repositório do autor foi escrito por mim**. Todas as medidas deste
> relatório se referem ao commit `1f0abb6` e aos bytes desse zip.

## 1. Veredito por alegação

### 1.1 O que o autor declara fechado (C1 e I-1 da revisão da 1.1.41)

| # | Alegação do autor | Comando próprio | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | Caçador do revisor (96 rótulos × 3 valores × 6 superfícies) **0/1.728** | `node probes/hunter-141.mjs` | 1.1.42 = **0/1728**; 1.1.40 = 336/1728 (`json_chave` 168 + `url` 168) | **CONFIRMADO** |
| 2 | Caçador estendido com a dimensão de família **0/13.824** (1.1.41: 7.302; 1.1.40: 1.830) | idem, §C2 | 1.1.42 = **0/13824**; 1.1.40 = 1.830/13824; `REGREDIRAM_NA_PROSA=0`; as 12 formas naturais do §C3 (`senhaassinaturatoken`, `senhapixpin`, `senhacadastrotoken`, …) = tarja em prosa/chave/id | **CONFIRMADO** |
| 3 | E2E do revisor em Chrome real **19/19**, `vazou_em=(nenhuma)` nos 6 casos de identificador e nos 3 de prosa, evidência legítima em 2–3 de 6 superfícies | `bash probes/chrome-142.sh` (`attack-e2e-141.test.mjs`, `AUDITA_EXT_PATH=root`) | `tests 19 / pass 19 / fail 0`; **b01–b06** `vazou_em=(nenhuma)`; **d01–d03** `vazou_em=(nenhuma) (0/6)`; **c01–c05** `com_evidencia=3/6`; **e01/e03/e04** 3/6 e **e02** 2/6 | **CONFIRMADO (exato)** |
| 4 | Corpus PT-BR de falsos positivos: **NOVOS=6 → NOVOS=[]**, 30 correções em `data`, 15 em prosa | `node probes/fp-ptbr-141.mjs` | `data: NOVOS=[] CORRIGIDOS=30`; `id: NOVOS=[] CORRIGIDOS=0`; `classe: NOVOS=[]`; `prosa: NOVOS=[] CORRIGIDOS=15` | **CONFIRMADO (exato)** |
| 5 | 880 formas realistas: **0 vazamento em prosa/modelo** | `node probes/realistas-141.mjs` | 1.1.42: 880 formas → vazamentos `{id:178, chave:108, url:108}` — **`prosa` e `modelo` ausentes do mapa** (= 0); 1.1.40: `{chave:576,url:576,id:880}` | **CONFIRMADO** (o resíduo de `id`/`chave`/`url` é o declarado de radicais curtos) |
| 6 | `COBERTURA_PERDIDA=0` em 516.235 formas | `node probes/coverage-141.mjs` (U1=1.063.290, U2=1.088.992, U3=9.754.688) | **PERDIDA=0** em U1/U2/U3 no vocabulário de CHAVE **e** em U1/U2/amostra-U3 no de PROSA/MODELO; GANHA = 5.764 em U2 e 152.578 em U3 | **CONFIRMADO na perda / número de GANHO não reproduz** (o corpus de 516.235 do autor não está disponível; nos meus universos o ganho é 5.764, não 5.661) |
| 7 | Dicionário **360 → 537** (era 563 na 1.1.40) | filtro exato do revisor da 1.1.40 (`dict-author-141.mjs`: 234.291 palavras) | 1.1.42 = **537**; 1.1.41 = **360**; 1.1.40 = **563**; vs 1.1.40 `PERDEU=26 GANHOU=0` | **CONFIRMADO (exato, os três números)** |
| 8 | Morfologia PT **0/39** | `node probes/morfologia-141.mjs` | 1.1.42 = **0/39**; 1.1.40 = 20/39 | **CONFIRMADO** |
| 9 | Chaves inocentes **3/55** (`cupbearer`, `pallbearer`, `chipping`) | `probes/coverage-141.mjs` | 1.1.42 = **3/55**, conjunto exato `cupbearer pallbearer chipping`; 1.1.40 = **3/55**, mesmo conjunto | **CONFIRMADO** |
| 10 | `node --test test/core/credential-class-metric.test.js` → **11/11** | idem, na raiz empacotada | `tests 11 / pass 11 / fail 0` (diagnóstico: `resíduo de chave com radical curto: 387 de 690`, teto 550) | **CONFIRMADO** |
| 11 | E2E novo `test/e2e/identifier-credential-mv3.test.mjs` → **6/6** | dentro do escopo serial | 3 casos `rótulo no identificador…` **✔** + 3 controles negativos **✔** | **CONFIRMADO** |
| 12 | Escopo serial de 12 arquivos nos bytes empacotados: **57/58**, única vermelha no flake de limpeza do `axe-mv3-csp` | `bash probes/serial-scope-141.sh` | `tests 58 / pass 55 / fail 3` — **duas** vermelhas: `axe-mv3-csp` (flake de cleanup, **1/1 isolado**) **e** `url-pixel-consent-mv3` › “cancel while paused removes only the owned tab…” (`EVALUATION_FAILED`, **10/10 isolado**) | **PARCIAL — o número declarado não reproduz** (55/58 em vez de 57/58; a vermelha extra é flake e passa isolada) |
| 13 | Fase paralela (sem `test/e2e/`): **4.180 / 4.178 / 1 falha** | `node probes/run-parallel-noe2e-141.mjs` | `tests 4180 / pass 4178 / fail 1 / skipped 1` — **agregado exato**. Mas a falha **não** é o `release-package` (que passou, com o digest reconstruído): sem `.git` na raiz falha `preview-runtime-parity` e com `.git` falha `annotation-map` (“times out a stalled bitmap allocation”), que passa **26/26 isolado** | **PARCIAL — agregado confirmado, nome da falha não reproduz** |
| 14 | Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` → GREEN | idem, na raiz empacotada | `VERIFY_EXIT=0`; `130/146 (96/50)`, identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN | **CONFIRMADO** |
| 15 | Auditoria ao vivo no Google: 0 falhas, 3 sob revisão humana (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, versão 1.1.42, 4 exportações `complete` | `bash probes/chrome-live-142.sh` | Painel: `0 Falhas confirmadas (0 ocorrências)`, `1 Recomendações e alertas (1 ocorrência)`, `3 Suspeitas a confirmar (4 ocorrências)`, `9 Resultados positivos`, `Checklist separado — 109 verificações ainda sem conclusão`; HTML: `Cobertura automática: 28,5%`, `Índice técnico automático — motor próprio 9,0 / 10`; JSON `audit.versions.extension="1.1.42"`; `downloads=complete/complete/complete/complete` | **CONFIRMADO** |
| 16 | Integridade **146 itens (96+50)**, 146/146 ids e títulos no HTML **e no PDF**, notas 5/5, 0 palavras partidas, 0 `[redacted]` | `node probes/integrity-141.mjs`, `node probes/integrity-pdf-141.mjs`, `venv/bin/python probes/_pdf2.py` | HTML: `ITENS=146 REQUISITOS=96 RECOMENDACOES=50`, `ids_ausentes=0`, `titulos_ausentes=0`, `notas=5/5`, `[redacted]=0`, `partidas=0`. PDF (18 páginas): `ids_ausentes=[]`, `titulos_ausentes=[]`, `[redacted]=0`, 23 pares hífen+quebra com **0 sem correspondência no HTML** | **CONFIRMADO** |
| 17 | Eixo de chave do revisor: 1/1 com `VAZA_EM=(nenhuma)` nos seis casos | `node --test probes/key-axis-141.test.mjs` | `tests 1 / pass 1 / fail 0`; **seis** `VAZA_EM=(nenhuma)` | **CONFIRMADO** |
| 18 | “as formas de credencial seguem seladas” (registro de achados, I-1) | `probes/p02`, `p03`, `p07`, E2E `reabertos-e2e-142.test.mjs` | **REFUTADO** — ver **C1** | **REFUTADO** |

### 1.2 O que a 1.1.42 fez de fato com a fronteira (medição própria, sem depender das sondas do autor)

| Medida | 1.1.42 | 1.1.41 | 1.1.40 |
| --- | --- | --- | --- |
| Prosa/modelo/JSON-chave/URL/`aria-label` — formas **reabertas** (1.1.41 tarjava, 1.1.42 entrega), corpus de 64.064 rótulos | **0** | — | — |
| Prosa — formas **fechadas** pela 1.1.42 contra a 1.1.41 | — | — | **19.137** |
| JSON-chave / URL — fechadas | — | — | **6.412** cada |
| `trecho-id` / `trecho-classe` — formas **reabertas** pela 1.1.42 contra a 1.1.41 | **22.215** (de 10.286 → 26.089) | 10.286 | 64.064 |
| `id`/`classe` no meu corpus de 198.360 formas — valor entregue | **167.104** | 6.707 | 198.360 |
| Dicionário do sistema: palavras que o par (`isPairedCredentialIdentity`) marca | **16** | 93 | 71 (o par não existe; medido com `isSensitiveKeyName`) |

**Isto é o retrato da troca**: a família de sufixo foi fechada de verdade (19.137 formas de prosa, 6.412 de
JSON-chave e 6.412 de URL recuperadas contra a 1.1.41, **0 reabertas** nesses caminhos), mas o par
identificador→valor foi
**estreitado para muito além** do que a revisão da 1.1.41 pediu, e é nesse caminho que a classe reabre.

## 2. Achados por severidade

### CRITICAL

#### C1 — O par identificador→valor deixou de valer para os identificadores que o PRÓPRIO vocabulário do produto conhece: o valor volta ao modelo guardado e aos artefatos HTML/JSON

**Causa raiz (isolada, diff mínimo).** O único conserto de código é a troca de predicado nos dois sítios do par
(`git diff 4df8c8c 1f0abb6 -- src/core/evidence/snippet.js src/core/normalize-snapshot.js`):

```diff
-      if (value.split(/\s+/u).some(token => token.length > 0 && isSensitiveKeyName(token))) return true;
+      if (value.split(/\s+/u).some(token => token.length > 0 && isPairedCredentialIdentity(token))) return true;
-    if (isSensitiveKeyName(value)) return true;
+    if (isPairedCredentialIdentity(value)) return true;
```

`isSensitiveKeyName` (o vocabulário FECHADO, que o autor mantém e cujo teste continua afirmando `true` para
`senhaforte`, `tokenacesso`, `pinnumber`, `pinpad`, `pincode`, `authToken`, `secretKey`) deixou de decidir o
par. Quem decide agora é `isPairedCredentialIdentity` = `[\p{L}\p{N}]{0,3}` + **radical de 5+ letras** +
`[\p{L}\p{N}]{3,24}` + não-família. Toda raiz que não caiba nessa forma — inclusive `senha`, `password`,
`token`, `secret`, `chave`, `credencial`, `segredo`, `session`, `cookie`, `pin`, `seed`, `puk`, `sessao`,
`apikey` (radical curto), `sessionid` (2 caracteres depois do radical), `minhasenha`/`novasenha` (prefixo de
4+ letras) e `senha-pix`/`senha_assinatura`/`data-senha` (separador) — deixa de autorizar o descarte do
conteúdo do elemento.

**Ordem de grandeza.** Chamada `isSensitiveKeyName` continua dizendo **credencial**; chamada
`isPairedCredentialIdentity` diz **não**: no dicionário do sistema isso acontece com **78 palavras**
(`password`, `pin`, `pass`, `passkey`, `secret`, `session`, `sessions`, `seed`, `bearer`, `credential`,
`authentication`, `authorization`, …) e **todas as 78 entregam o texto**.

**Reprodução mínima (unidade, 1 comando).** Nos dois sítios do par, com a lista de fixtures do **próprio
teste do autor** (`test/core/credential-class-metric.test.js:634-635`):

```
$ node -e "…importa privacy.js e snippet.js dos bytes empacotados e da 1.1.41…"   # evidence/p07-author-fixtures.txt
senhaassinatura    keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
senhaassinatura2   keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
chavepix           keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
data-chavepix      keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
xchavepix          keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
senhaforte         keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
tokenacesso        keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
secretKey          keyName=true paired=true  | 1.1.42=tarja | 1.1.41=tarja
pinnumber          keyName=true paired=false | 1.1.42=VAZA  | 1.1.41=tarja   <-- fixture do teste do autor
pinpad             keyName=true paired=false | 1.1.42=VAZA  | 1.1.41=tarja   <-- idem
pincode            keyName=true paired=false | 1.1.42=VAZA  | 1.1.41=tarja   <-- idem
authToken          keyName=true paired=false | 1.1.42=VAZA  | 1.1.41=tarja   <-- idem
```

**Extensão do dano (números próprios).**

- `probes/p03-diff-141-142.mjs` (corpus de **64.064** rótulos, o mesmo do revisor da 1.1.41):
  `trecho-id` e `trecho-classe` → **22.215 formas reabertas** pela 1.1.42 (1.1.41: 10.286 → 1.1.42: 26.089);
  em todas, `isSensitiveKeyName` continua `true` na 1.1.42. Nas superfícies de prosa/modelo/JSON-chave/URL/
  `aria-label` o mesmo teste dá **0 reabertas** e 19.137/6.412/14.651 fechadas — o conserto do C1 da 1.1.41
  é real e sólido.
- `probes/p02-id-differential.mjs` (198.360 formas `prefixo × radical × cauda`, id **e** classe, valor fraco
  **e** forte): valor entregue em **167.104** na 1.1.42 contra **6.707** na 1.1.41 e 198.360 na 1.1.40 →
  **160.397 formas reabertas**; 227 delas são identificadores plausíveis de página
  (`senha`, `minhasenha`, `novasenha`, `xsenha`, `senhas`, `chave`, `token`, `secret`, `password`, `session`,
  `cookie`, `credencial`, `segredo`, `pin`, `puk`, `seed`, `auth`, `bearer`, `pwd`, `cartao`, `sessao`…).

**Reprodução mínima (artefatos entregues, Chrome real).** `probes/reabertos-e2e-142.test.mjs` — o MESMO
percurso do autor (painel → relatório → modelo/revisão guardados → quatro exportações), uma fixture por
página, valor conferido antes (não vacuidade) e depois; A/B pela variável `AUDITA_EXT_PATH`:

| caso | fixture | 1.1.42 (`root`) | 1.1.41 (`mut-141`) |
| --- | --- | --- | --- |
| f01 | `<div id="senha">borboleta</div>` | **VAZOU em `guardado`, `artefato html`, `artefato json` (3/6)** | `(nenhuma)` 0/6 |
| f02 | `<div class="password">Zqwkvbrtnmx9</div>` | **3/6** | 0/6 |
| f03 | `<div id="token">sk-live-9f3a2b7c1d</div>` | **3/6** | 0/6 |
| f04 | `<code id="apikey">AKIAIOSFODNN7EXAMPLE</code>` | **3/6** | 0/6 |
| f05 | `<div id="minhasenha">S3nhaSup3rS3creta</div>` | **3/6** | 0/6 |
| f06 | `<div id="chave">chave-secreta-do-servico</div>` | **3/6** | 0/6 |
| f07 | `<span class="secret">hunter2</span>` | **4/6 (também `relatorio`)** | 0/6 |
| f08 | `<div id="senha2">P4ssw0rdForte</div>` | **3/6** | 0/6 |
| f09 | `<div id="pin">4821</div>` | **4/6 (também `artefato csv`)** | 0/6 |
| f10 | `<div id="credencial">usuario:joao\|token:abc</div>` | **3/6** | 0/6 |
| g01 | `<div id="senhaassinatura">borboleta</div>` (controle) | 0/6 | 0/6 |
| g02 | `<div id="chavepix">borboleta</div>` (controle) | 0/6 | 0/6 |
| g03 | `<div id="senhaassinaturatoken">borboleta</div>` (controle) | 0/6 | **VAZOU 3/6** (o Critical da 1.1.41) |

A fixture é **diretamente comparável** à do autor: o valor é o mesmo `borboleta` que
`test/e2e/identifier-credential-mv3.test.mjs` usa como segredo, e o autor afirma lá
`assert.deepEqual(vazou, [])`. Trocando apenas o identificador (`senhaassinatura` → `senha`), o valor sai.

**Impacto.** É a própria classe sob revisão — “credencial da página chegando às superfícies entregues” — no
ponto exato que a geração anterior selava: o valor fica no **modelo guardado** (`getAuditSnapshot` /
`getReportRevision`) e nos **artefatos HTML/JSON exportados**, além do CSV quando o valor tem cara de número.
As formas são mais realistas do que as que o autor usou como prova (`pincode`, `authToken`, `apikey`,
`sessionid`, `senha`, `password` são identificadores de página comuns), e o predicado que o produto mantém
como “vocabulário de chave” continua dizendo `true` para todas elas — a divergência está dentro do produto.

**Ressalva honesta, declarada para o leitor pesar.** Contra a **1.1.40** isto **não** é regressão: a 1.1.40 não
tinha par nenhum e entregava o texto de **todas** as 198.360 formas; a 1.1.42 ainda fecha 31.256. A regressão é
contra a **1.1.41** (6.707 → 167.104). E há um trade-off real por baixo: o mesmo `id` que pode carregar a
credencial pode carregar prosa do autor, e a revisão da 1.1.41 pediu explicitamente que `password` voltasse a
ser evidência (`<div class="password">Instruções do formulário de contato.</div>`), o que **implica** abrir mão
de selar `<div class="password">Zqwkvbrtnmx9</div>` — não existe forma de conteúdo que separe os dois de modo
geral, e a revisão da 1.1.41 ofereceu a alternativa (“exigir que o identificador só torne o elemento raiz
privada quando o conteúdo tiver cara de valor”). O que **não** se sustenta, e é o núcleo deste achado, é o
**alcance** da escolha: `pincode`, `pinpad`, `pinnumber`, `authToken`, `apikey`, `sessionid`, `minhasenha`,
`novasenha` não são evidência legítima em nenhum corpus medido — são identificadores de credencial que o
próprio teste do autor afirma reconhecer (`test/core/credential-class-metric.test.js:634-635`) — e foram
abertos sem medição e sem declaração. O comentário do código declara que a palavra exata do vocabulário “fica
de fora”, mas **o custo nunca foi medido**: o teste do autor
(`test/core/credential-class-metric.test.js:657`) só exercita as formas coladas, e o E2E novo só usa
`senhaassinatura`/`chavepix`. O registro de achados resume a rodada como “as formas de credencial seguem
seladas” — o que é falso.

### MINOR

- **M-1 — A guarda simétrica da família de prefixo só olha para a FRENTE.** `isLanguageWordForm` casa a
  família e testa `SENSITIVE_KEY` apenas no `plain.slice(prefix.index + prefix[0].length)`; o que vem **antes**
  da família nunca é inspecionado. Consequência medida (`probes/p06-guard-delta.mjs`, 39.372 formas de
  `<família><desinência><radical><cauda>`, filtradas por `isSensitiveKey(x)===true`): **2.038 formas novas na
  prosa contra a 1.1.40** (`chaveirapix`, `chaveirpixassinatura`, `chaveiracpflogin`, `pinturapixforte`, …) e
  **4.797 formas reabertas no `trecho-id` contra a 1.1.41** (`chaveir-senha`, `chaveta-token`, …). As formas
  nomeadas pelo autor continuam fechadas (`chaveirotoken` e `pinturasenha` = **tarja na prosa**, `chaveirotoken`
  = tarja também no `id`) — o buraco exige que a sobra depois da família **não** feche radical no fim do token
  (`pix`, que o vocabulário deliberadamente não conhece, ou lixo alfabético depois do radical), e os
  identificadores que sobram (`chaveir-senha`) são pouco plausíveis numa página real. **Realismo baixo;
  fica como Minor e como eixo para a próxima rodada, não como bloqueio.**
- **M-2 — O par ainda apaga 16 palavras do dicionário** que a 1.1.40 preservava: `chavender`, `secretage`,
  `secretagogue`, `secretion`, `secretional`, `secretionary`, `secretitious`, `secretive`, `secretively`,
  `secretiveness`, `secretmonger`, `secretness`, `secretomotor`, `secretory`, `sessionary`, `tokenless`
  (`probes/p04-precision.mjs`, §D1/D2). É a melhora declarada (93 → 16 contra a 1.1.41 e 0 novos contra a
  1.1.41), mas `secretive`, `tokenless` e `sessionary` são identificadores plausíveis e a destruição do texto
  continua silenciosa. O corpus PT-BR do revisor (70 palavras) está **limpo**: 0/70 no `id` e na `classe`.
- **M-3 — `isLanguageWordHead` é export morto.** Exportado em `src/core/privacy.js:440`, não é importado por
  nenhum arquivo de `src/`, `test/` ou `scripts/` (herdado da 1.1.41; não existe na 1.1.40). Sem impacto de
  comportamento.
- **M-4 — Números declarados que não reproduzem (dito explicitamente).**
  (a) Escopo serial: declara **57/58**; medi **55/58**, com **duas** vermelhas — a do `axe-mv3-csp` (idêntica à
  declarada, `cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]`, **1/1 isolado**) **e**
  `url-pixel-consent-mv3` › “cancel while paused removes only the owned tab and produces no report”
  (`EVALUATION_FAILED`, **10/10 isolado**). As duas são flake de ambiente; a segunda não estava declarada.
  (b) Fase paralela: o agregado **4.180 / 4.178 / 1 falha / 1 pulado reproduz exatamente**, mas a falha
  declarada (`release-package`) **passou** na minha raiz (o pacote reconstruído dá o digest declarado) e
  quem falhou foi `annotation-map` (“times out a stalled bitmap allocation”, **26/26 isolado**).
  (c) `COBERTURA_PERDIDA=0` confirmado; **GANHA=5.661 não reproduz** nos meus universos (5.764 em U2).
  (d) “880 formas realistas: 0 vazamento em prosa/modelo” — confirmado, mas a 1.1.40 **já era 0** nesse
  caminho, então a prova é fraca (o resíduo de 108/880 em `chave`/`url`/`id` por radicais curtos é o mesmo
  da 1.1.40).

### Observações (sem severidade)

- Resíduo declarado **M-1 da 1.1.41** (`data-<palavra>` descartado) **persiste**: 21/70 palavras do corpus do
  revisor continuam com o atributo fora (`chavear`, `chavena`, `pintado`, `pinto`, `pingo`, `pinha`,
  `secretas`, `sessão`, `password`, …) — idêntico à 1.1.41 e não pior que a 1.1.40 (51). Não foi reivindicado
  como fechado.
- Falso positivo residual de prosa: “O pinguim comeu o pingo de chocolate.” continua alterado (1/10 frases
  longas; a 1.1.40 alterava 2/10).
- `pallbearer`/`cupbearer`/`chipping` seguem tarjados em prosa **e** chave, `seedling` só em prosa — a
  declaração corrigida do autor (que trocou `seedling` por `chipping`) confere.

## 3. O que tentei para refutar cada item declarado como fechado

| Item declarado fechado | Ataque feito | Resultado |
| --- | --- | --- |
| **C1 da 1.1.41 — família de SUFIXO** | Caçador 96×3×6 e estendido 768×3×6; corpus próprio de 64.064 rótulos nas 8 superfícies; 880 caudas realistas × 8 sufixos (7.040 formas); 39.372 formas de família × desinência × radical; camelCase, `_`/`.`/`-`, caixa mista, invisíveis | **Fechado**: 0/1.728, 0/13.824, **0 reabertas** em prosa/modelo/JSON-chave/URL/`aria-label` contra a 1.1.41 e 19.137/6.412 fechadas; `xsession`, `novaseed`, `getseed`, `xpin`, `senhaassinaturatoken`, `senhapixpin` = tarja. **Único resíduo**: M-1 (guarda só olha para a frente) |
| **I-1 da 1.1.41 — par apagando evidência legítima** | `fp-ptbr` (70 palavras × 4 superfícies), dicionário do sistema (210.626 palavras), prosa longa, `data-<palavra>`, `pintura.png`, `secretaria-saude`, `chaveirotoken`/`pinturasenha` | **Fechado na precisão**: NOVOS=[] nas quatro superfícies, 30+15 correções, 0/70 no `id`/`classe`, FP do par no dicionário 93 → 16. **Mas o conserto custou o outro lado**: ver **C1** |
| “as formas de credencial seguem seladas” | Lista de fixtures do teste do autor, 198.360 identificadores, 64.064 rótulos, E2E A/B em Chrome real | **REFUTADO (C1)**: 4 das 12 fixtures do próprio autor e 160.397 formas reabertas |
| “guardas simétricas nas famílias de prefixo” | 39.372 formas com o radical antes/depois da família, filtradas pelo próprio `isSensitiveKey` | **PARCIAL (M-1)**: a guarda é assimétrica — só inspeciona o que vem depois |
| `COBERTURA_PERDIDA=0` | U1/U2/U3 nos vocabulários de chave e de prosa/modelo | **Confirmado na perda** (0 em todos); ganho não reproduz (5.764 vs 5.661) |
| “880 formas realistas 0 vazamento em prosa/modelo” | as 880 × 8 sufixos × 6 superfícies, 1.1.42 vs 1.1.40 | Confirmado, **mas a 1.1.40 já era 0** nesse caminho |
| Dicionário 360 → 537 | filtro exato do revisor da 1.1.40, quatro gerações | **Confirmado exato** (537 / 360 / 563) |
| E2E do revisor 19/19 e E2E novo 6/6 | Chrome real, um por vez, nos bytes empacotados | **Confirmados** |
| Suíte, gate e escopo serial | fase paralela sem `test/e2e`, 12 arquivos seriais, `verify` | Agregado da paralela e gate **confirmados**; escopo serial **55/58** (duas flakes, ambas verdes isoladas) |
| Auditoria ao vivo e integridade 146/96/50 | Chrome real em `https://www.google.com/` + pypdf | **Todos os números confirmados**, inclusive 28,5%, 9,0/10, 109 no checklist, 4 exportações `complete`, 146/146 ids e títulos no HTML e no PDF, 5/5 notas, 0 palavras partidas, 0 `[redacted]` |
| Interação com 5.9.1/5.9.7/5.9.8, destaque, marcadores, exportações, axe | `git diff` do escopo real + os 12 arquivos seriais (`field-label-review`, `form-required-and-purpose`, `product-surface-axe`, `page-markers-signals`, `current-page-export`, `credential-shapes`, `credential-false-positives`, `axe-mv3-csp`) | **Sem colateral**: o único código tocado é `privacy.js` + os dois sítios do par; todos esses E2E passam (exceto as duas flakes de ambiente) |

## 4. O que NÃO foi medido

- **O corpus de 516.235 formas do autor**: não existe no repositório; reproduzi os universos do revisor da
  1.1.40 (1,06 M / 1,09 M / 9,75 M) e um corpus próprio de 198.360 identificadores. Onde o número não
  reproduz, está dito.
- **O corpus de colisão “67 radicais × 55 caudas = 540” e a “bateria de 39 rótulos”** citados na trilha: medi
  o teste que os contém (11/11, com o diagnóstico `387 de 690` no teto de 550), não a planilha declarada.
- **Importação real da extensão na Chrome Web Store / assinatura do pacote**: não medi política de loja,
  revisão da Store nem `update_url`.
- **Frames, iframes cross-origin e shadow DOM**: a classe de credencial nessas fronteiras não foi medida
  (o escopo declarado do autor também não as cobre).
- **Pixel path com página pesada**: medi a auditoria ao vivo no Google em modo `no-pixels`; não reexecutei
  `element-only`/`full-evidence` nesta rodada (o achado de percurso de pixel da 1.1.41 não foi re-testado).
- **Ambientes além de macOS / Chrome for Testing 152.0.7977.64 / Node 26.5.0**.
- **Gerações anteriores à 1.1.38**: não desci mais na linhagem.
- **`data-<palavra>` do lado do modelo/JSON** (só medi o atributo no trecho).
- **Desempenho**: não medi o custo de CPU do `isPairedCredentialIdentity` novo nem o do `SENSITIVE_KEY` a
  mais dentro da guarda de família.

## 5. Veredito final

**REPROVADO** para o escopo declarado (fechamento do Critical e do Important da revisão da 1.1.41).

O Critical da 1.1.41 (família de sufixo) está **genuinamente fechado** e o Important (evidência legítima
destruída) está **genuinamente melhor** — os dois com números exatos, em Chrome real e nos bytes empacotados.
Mas o redesenho da fronteira do par identificador→valor **passou do ponto**: ao exigir “rótulo colado”
(radical de 5+ letras + 3+ caracteres), ele deixou de fora identificadores que o **próprio vocabulário do
produto** classifica como credencial, e o valor volta ao modelo guardado e aos artefatos HTML/JSON/CSV numa
regressão de **22.215 formas** contra a 1.1.41 no corpus de 64.064 rótulos e de **160.397** no meu corpus de
198.360 — inclusive em 4 das 12 fixtures do teste do próprio autor (`pinnumber`, `pinpad`, `pincode`,
`authToken`) e com o mesmo valor (`borboleta`) que o E2E do autor usa como segredo. A declaração “as formas de
credencial seguem seladas” **não corresponde ao medido**.

**Para reverter o veredito é suficiente**: devolver ao par os identificadores que o vocabulário FECHADO
reconhece e que **não** estão no corpus de evidência legítima que a revisão da 1.1.41 mediu — no mínimo
`pincode`, `pinpad`, `pinnumber`, `authToken`, `apikey`/`apiKey`, `sessionid`, `minhasenha`/`novasenha`,
`senha`, `token`, `secret`, `chave`, `credencial`, `segredo` — mantendo fora do par apenas
`chavear`, `chavena`, `secretas`, `sessao`, `password`, `cookie-banner`, `map-pin`, `session-info`,
`token-de-acesso` e as famílias da língua. Como o conteúdo pode ser prosa legítima
(`<div class="password">Instruções do formulário</div>`) **ou** credencial
(`<div class="password">Zqwkvbrtnmx9</div>`), e forma de conteúdo sozinha não separa os dois, a alternativa
é manter o par colado incondicional e, para o identificador de vocabulário, exigir sinal de valor
(`hasCredentialValueSignal`, já importado por `src/core/evidence/snippet.js`) — declarando o lado escolhido
e medindo os dois. Em qualquer das duas, fixar em teste, por caso e nos artefatos entregues, os dois
sentidos: `<div id="senha">borboleta</div>` e `<div id="pincode">4821</div>` (selados) **e**
`<div id="chaveiro">R$ 30,00</div>` / `<div class="pinturas">látex acrílico</div>` (evidência preservada).
Fechar M-1 (guarda que também olha o que vem antes da família) é o eixo seguinte, não o bloqueio.
