# REVIEW-1.1.44 — revisão independente e adversarial do artefato Audita Acessibilidade 1.1.44

Revisor independente e adversarial. **Nenhuma afirmação do autor vale como prova**: toda medida abaixo foi
produzida por comando próprio, com a saída bruta em `/private/tmp/audita-review-144/evidence/`.
**Nada foi escrito dentro do repositório do autor** — nem no worktree, nem no `.git` (conferido:
`git status --porcelain` no worktree só mostra a modificação que já existia antes desta revisão,
`test/e2e/sidepanel-flow-mv3.test.mjs`, e nenhum arquivo meu). Todas as sondas novas estão em
`/private/tmp/audita-review-144/probes/` (prefixo `v144`).

## 0. Ambiente de medição

| Item | Valor |
| --- | --- |
| Worktree do autor (somente leitura) | `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`, branch `feature/audita-mt` |
| Commit do artefato | **`3f6e38b`** (`3f6e38b8ca4ba51584fd831b02fc7bce54e80dc8`) — era o `HEAD` no início da revisão |
| Clone independente (regra 1) | `git -C <worktree> clone --no-hardlinks --local … /private/tmp/audita-review-144/clone` — **sem `cp -R .git`** |
| Raiz de medição (regra 2) | `/private/tmp/audita-review-144/root` = `git archive 3f6e38b` **com o zip sobreposto** (`unzip -o`), mais `node_modules` (axe-core 4.13.0) |
| Gerações de comparação (construídas do meu clone) | 1.1.43 = `719fe13` (`mut-143`), 1.1.42 = `1f0abb6` (`mut-142`), 1.1.41 = `4df8c8c` (`mut-141`), 1.1.40 = `c9d7dd4` (`mut-140`), 1.1.39 = `746a696`, 1.1.38 = `733cd01` |
| Chrome (regra 3) | `Google Chrome for Testing 152.0.7977.64`, **um Chrome por vez**, `--test-concurrency=1` |
| Node | v26.5.0 |

> **Nota de estado do worktree.** Ao terminar a revisão o `HEAD` do worktree já era `f735e93` (avanço do
> autor). Os dois commits posteriores a `3f6e38b` (`e8ad6f8`, `f735e93`) tocam **apenas `docs/qa/*.md`** —
> `src/`, `test/` e `scripts/` são idênticos (`git diff --stat 3f6e38b..f735e93`). O zip continua com o
> digest `b466cc3d…0755` e **nenhum arquivo do repositório do autor foi escrito por mim**.

## 1. Integridade do pacote

| Medida | Comando próprio | Resultado |
| --- | --- | --- |
| SHA-256 do zip | `shasum -a 256 release/audita-acessibilidade-1.1.44.zip` | `b466cc3de3cb4195e0987432e54aacbebb1fe5b7f18306f90136539f3b340755` — **igual ao declarado** |
| Arquivos no zip | `unzip -Z1 \| wc -l` | **199** |
| Nada no zip fora do commit | `comm -23 zip-filelist commit-filelist` | **0** (`evidence/zip-only.txt` vazio) |
| Byte a byte vs `git archive 3f6e38b` | `cmp` nos 199 arquivos | **0 divergências** (`evidence/byte-diff.txt` vazio) |
| Sobreposição na raiz de medição | `cmp` após `unzip -o` | **0 divergências** (`evidence/overlay-diff.txt` vazio) |
| Versão no artefato | `manifest.json` empacotado | `1.1.44` |

O incremento toca exatamente `src/core/privacy.js`, `src/core/evidence/snippet.js`,
`src/core/normalize-snapshot.js` (+ README, docs, manifest e os testes de contagem) — `git diff --stat
719fe13..3f6e38b`. Confirmado por leitura: `looksLikeFieldValue` **saiu do código** (única ocorrência
remanescente é um comentário em `privacy.js:556`) e `ownTextSignal`/`credentialContext` têm **0 ocorrências**
em `src/`.

## 2. Veredito por alegação

### 2.1 O que o autor declara fechado (2 Critical, 1 Important e os Minor da revisão da 1.1.43)

| # | Alegação | Comando próprio | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | `v143-shapes` **0/18 em todas as formas de valor** | `node probes/v143-shapes.mjs` | **0/18 em todas as 17 formas**, nas 7 seções (trecho id/classe, prosa, JSON, URL, modelo colunar, descendente) — `evidence/v144-shapes.out` | **CONFIRMADO (exato)** |
| 2 | `v143-recall-198k` **`VAZA=6.707` em todas** e **0 reabertos** vs 1.1.41 e 1.1.42 (id e classe) | `node probes/v143-recall-198k.mjs` | id e classe, 4 formas de valor: `44=6707/198360` nas oito células; `REABERTOS_vs_41=0 vs_42=0`. 1.1.43 reabria 198.360 com valor de 5 palavras, ponto final e 65 chars | **CONFIRMADO (exato, e agora invariante à forma do valor)** |
| 3 | `v143-context-stack` **tarja em todos** os casos estruturais (profundidades 1–10) | `node probes/v143-context-stack.mjs` | `1.1.44=tarja` em **todos** os 7 casos de pilha, nos 5 de rótulo+valor e nas **12** profundidades (estendi até 12); 1.1.43 vazava em 8 deles | **CONFIRMADO (exato, estendido)** |
| 4 | E2E `v143-gate`/`v143-gate2` **`vazou_em=(nenhuma)`** | `bash probes/chain-144.sh` (Chrome 152) | `v144-gate-e2e-44.txt`: os 8 casos de vazamento (6 palavras, 5, 4, ponto final, 68 chars, 1 palavra, aninhado 1 palavra, aninhado 70 chars) → **`(nenhuma)` 0/6**; `v144-gate2-e2e-44.txt`: **7/7 `(nenhuma)`**. 1.1.43 vazava 3/6 em v5, v6 e aninhado-70 | **CONFIRMADO (exato)** |
| 5 | E2E herdados de ataque (19 casos) e de reabertos (13 casos): todos selados | idem | `v144-e2e-attack.txt` 19/19: b01–b06 `(nenhuma)`, c01–c05 evidência 0/6, d01–d03 `(nenhuma)`, e01–e04 0/6; `v144-e2e-reabertos.txt` 13/13 `(nenhuma)` (f01–f10, g01–g03) | **CONFIRMADO (exato)** |
| 6 | Precisão declarada: **20 de 25** ids PT-BR e **99** palavras do dicionário (1.1.41: 93); **15 dos 20** são rótulo de credencial de verdade | `node probes/v143-precision.mjs` + `v144d-dict-delta.mjs` | 20/25 nas **11** formas de texto. Dicionário `/usr/share/dict/words` (210.626 palavras minúsculas de 3+ letras): **99** destruídas pela 1.1.44 contra **93** da 1.1.41 — **números exatos**; delta 6 = `secretarial, secretarian, secretariat, secretariate, secretary, secretaryship`, **todas inglesas**, como declarado. (Uma variante minha que dobra as entradas maiúsculas para minúsculas, 234.289 palavras, dá 100/94 — mesmo delta 6, mesmas palavras.) Contei os 20 ids: **15** são rótulo de credencial, **5** são da língua | **CONFIRMADO (exato; a diferença 99−93 é mesmo de palavras inglesas)** |
| 7 | Métrica da classe **11/11** (não vacuidade) | `node --test test/core/credential-class-metric.test.js` | `tests 11 / pass 11 / fail 0` | **CONFIRMADO** |
| 8 | E2E novo `identifier-credential-mv3` **6/6** | `node --test test/e2e/identifier-credential-mv3.test.mjs` | `tests 6 / pass 6 / fail 0` (3 identificadores + 3 controles negativos) | **CONFIRMADO** |
| 9 | `key-axis` **1/1** | `bash chain-144.sh` §6 | `pass 1 / fail 0`; **seis** `VAZA_EM=(nenhuma)`; rótulo presente em `modelo,html,json` em 4 dos 6 | **CONFIRMADO** |
| 10 | Caçador **0/1.728** e **0/13.824** | `node probes/hunter-141.mjs` | 1.1.44 = **0/1728** e **0/13824** (1.1.40 = 336 e 1.830); as formas naturais (`senhapixtoken`, `chavePixToken`, …) = tarja; `chaveiro`, `pintura.png`, `secretaria-saude`, `data-chaveiro` = preservados | **CONFIRMADO (exato)** |
| 11 | Morfologia PT **0/39** | `node probes/morfologia-141.mjs` | `PT_FRASES=39 1.1.44_FP=0` (1.1.40 = 20) | **CONFIRMADO** |
| 12 | Chaves inocentes **3/55** | sonda própria com o corpus de 55 | **3/55** = `cupbearer pallbearer chipping`, idêntico em 1.1.40→1.1.44 | **CONFIRMADO (exato)** |
| 13 | Prosa `NOVOS vs 1.1.40` **10** e id `REABERTOS vs 1.1.41` **0** | `node probes/p06-guard-delta.mjs` | prosa `1.1.44 vaza=13 \| NOVOS vs 1.1.40=10` (exatamente `pix-chaveir…pix-tokeniz`); id `1.1.44 vaza=5783 \| NOVOS=0 \| REABERTOS vs 1.1.41=0` | **CONFIRMADO (exato)** |
| 14 | 0 reabertos nas seis superfícies do corpus de 64.064 | `node probes/p03-diff-141-142.mjs` | `REABERTOS=0` nas 8 superfícies; `FECHADOS` = **19.139** (prosa), **6.412** (json-chave, url-param, trecho-id, trecho-classe), **14.653** (aria-label) | **CONFIRMADO (exato)** |
| 15 | 198.360 com valor fraco e forte, id e classe | `node probes/p02-id-differential.mjs` | `VAZA=6707/198360` nas 4 células; `REABERTOS=0`; `REABERTOS_PLAUSIVEIS=0`; 1.1.40 = 198.360 | **CONFIRMADO** |
| 16 | 880 formas realistas: 0 em prosa/modelo | `node probes/realistas-141.mjs` | `{chave:108, url:108, id:108}` — **prosa e modelo ausentes do mapa** (= 0); o resíduo 108/108/108 é o declarado de radicais curtos; estendidas 7040 → `{chave:582,url:582,id:582}` | **CONFIRMADO** |
| 17 | Caminho colunar × simplificado | `node probes/v143-gate-shape.mjs` | recall: `VAZAM_simp_ou_col=0/17` nas 14 formas. Precisão: **os dois caminhos destroem igual** (`simp:DESTRUIU/col:DESTRUIU` em 17/17 nos 7 textos) — o **M-1 da revisão da 1.1.43 está resolvido**: não há mais divergência entre os caminhos | **CONFIRMADO (divergência fechada)** |
| 18 | Suíte **4.180/4.178/1** (a única falha é o `release-package`) | `node probes/run-parallel-noe2e-141.mjs` na raiz empacotada | `tests 4180 / pass 4178 / fail 1 / skipped 1` — **agregado exato**; mas a falha é **`normative ESM exports remain byte-identical to the 78ba813 baseline`** (`preview-runtime-parity`), que passa **5/5** no meu clone com `.git` (`v144-preview-parity-clone.txt`) e falha na raiz sem `.git` (`fatal: not a git repository`); o **`release-package` passou** | **PARCIAL — agregado confirmado; o nome declarado não reproduz** (ver M-2) |
| 19 | Escopo serial no pacote **56/58** (duas flakes de harness) | `bash probes/serialfase-144.sh` | `tests 58 / pass 57 / fail 1` — **uma** vermelha: `runs pinned local axe in every isolated frame under real MV3 and strict page CSP` (`cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]`), que passa **1/1 isolado** (`v144-axe-csp-isolado.txt`). Não houve `CONTEXT_PROOF_DENIED` | **PARCIAL — mediu melhor que o declarado (57/58, uma flake); a flake nomeada existe e passa isolada** (ver M-3) |
| 20 | Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` → GREEN | idem | `VERIFY_EXIT=0`; `130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN` | **CONFIRMADO** |
| 21 | Auditoria ao vivo no Google: 0 falhas, 9 positivos, 109 no checklist, 28,5%, 9,0/10, versão 1.1.44, quatro exportações `complete` | `node probes/live-google-141.test.mjs` + extração própria | Painel: `0 Falhas confirmadas`, `1 Recomendações e alertas (1 ocorrência)`, `3 Suspeitas a confirmar (4 ocorrências)`, `9 Resultados positivos`, `109 verificações ainda sem conclusão`; HTML/PDF: `Cobertura automática: 28,5%`, `9,0 / 10`; JSON `audit.versions.extension="1.1.44"`, **146 assertions**; `downloads=complete/complete/complete/complete` | **CONFIRMADO** |
| 22 | Integridade **146 itens (96+50)**, 146/146 ids e títulos no HTML **e no PDF**, notas 5/5, 0 palavras partidas, 0 `[redacted]` | `node probes/integrity-141.mjs`, `node probes/integrity-pdf-141.mjs` (pypdf 6.19.0, venv próprio) | HTML: `ITENS=146 REQUISITOS=96 RECOMENDACOES=50`, `ids_ausentes=0`, `titulos_ausentes=0`, `notas=5/5`, `[redacted]=0`, `partidas=0`. PDF (18 páginas): `ids_ausentes=[]`, `titulos_ausentes=[]`, `redacted=0`, 24 pares hífen+quebra, todos legítimos | **CONFIRMADO (exato)** |
| 23 | Cobertura: `COBERTURA_PERDIDA=0` | `node probes/coverage-141.mjs` | `PERDIDA=0` em U1 (1.063.290), U2 (1.088.992) e U3 (9.754.688); `GANHA=5764` em U2 e 152.578 em U3 (o autor declara 5.661 nos universos dele — divergência já declarada) | **CONFIRMADO na declaração** |
| 24 | Resíduos declarados (`name`/`aria-label`/`autocomplete`/`title`/`data-*`, irmãos, `puk…`, `codigo*`/`conta*`, `api.key`, `private_key`, `chave·de·api`) | `node probes/residuos-141.mjs`, `v144b-residual-shape.mjs`, `positions-141.mjs`, `v143-gate-e2e-44.txt` | Abertos como declarado, **idênticos à 1.1.40** — exceto **`title`**, que a 1.1.44 passou a cobrir no entregue (`margarida` → `(nenhuma)`). A descrição dos 6.707, porém, está **incompleta** — ver M-1 | **CONFIRMADO com ressalva (M-1)** |

### 2.2 Precisão no que a página realmente usaria (o que o mandato pediu)

`node probes/v144c-precision-real.mjs` — colunas 1.1.44 / 1.1.43 / 1.1.42 / 1.1.41 / 1.1.40,
`fica` = o texto sobrevive no modelo colunar:

| identificador | 1.1.44 | 1.1.43 | 1.1.42 | 1.1.41 | 1.1.40 |
| --- | --- | --- | --- | --- | --- |
| `chaveiro`, `chaveiros`, `chaveta`, `chaveamento`, `pintura`, `pinturas`, `pintor`, `pincel`, `pingente`, `pinguim`, `secretaria`, `secretaria-saude`, `secreto`, `secretos`, `tokenizacao`, `tokenização`, `obsessao`, `possessao`, `pintura.png`, `pinheiro`, `pinha`, `pinto`, `pinga` | **fica** | fica | fica | fica | fica |
| `sessao`, `sessoes`, `sessão`, `sessões`, `chavear`, `chavena`, `secretas`, `sessao-do-cinema` | **CAI** | fica | fica | **CAI** | fica |
| **`secretario`, `secretarios`** | **CAI** | fica | fica | **fica** | **fica** |
| **`secretariaDeSaude`** | **CAI** | fica | fica | **fica** | **fica** |
| **`tokenizacaoDeTexto`** | **CAI** | fica | fica | **fica** | **fica** |
| **`chaveiroDeLatão`** | **CAI** | fica | fica | **fica** | **fica** |
| `secretaria_de_saude`, `tokenizacao_de_texto`, `pinturaDoQuadro`, `obsessaoPorLimpeza` | fica | fica | fica | fica | fica |

- **`data-<palavra>` legítimo no trecho:** `data-chaveiro`, `data-pintura`, `data-secretaria`,
  `data-tokenizacao` **sobrevivem** na 1.1.44 (a 1.1.40 os apagava); `data-sessao`, `data-pinheiro`,
  `data-chave`, `data-senha`, `data-chavepix`, `data-senhaassinatura` caem — **idêntico em todas as cinco
  gerações** (pré-existente, não é regressão). No modelo, `data-<radical>` tem o **valor** tarjado
  (`data-senhaassinatura="[redacted]"`) e `data-chaveiro`/`data-pinheiro` preservam o valor.
- **`input`/`select`/`textarea` legítimos:** `<textarea id="mensagem">Conteudo publico</textarea>` cai no
  trecho **e** no modelo em **todas as cinco gerações** (política pré-existente para campo editável);
  `<select>`/`<option>` e `input value` (no modelo) sobrevivem em todas. **Não é regressão.**
- **Elemento que carrega nome** (`button`, `a`, `label`, `legend`, `summary`, `option`) com `id` de
  credencial: o texto sobrevive nas cinco gerações, como o autor declara.

## 3. Achados por severidade

### CRITICAL

**Nenhum.** O eixo da classe de credencial — valor saindo em qualquer superfície entregue — está **fechado
em todas as tentativas desta rodada**: 17 formas de valor × 7 seções, 198.360 identificadores × id/classe ×
4 formas, 64.064 × 8 superfícies, 1.728 + 13.824 do caçador, 880 + 7.040 realistas, 3.240 do ataque de
família, 31 casos estruturais meus (mesmo nome, 30 níveis, `svg`/`math`/`slot`/`template`/`iframe`/
`noscript`/`dialog`/elemento customizado, comentários, entidades, valor partido por `<b>`, tabela, tags
vazias) e o percurso E2E completo em Chrome 152 (painel → relatório → guardado → 4 exportações). **Três
resíduos** apareceram na minha varredura estrutural — `id="sen&#104;a"` e `id="sen\nha"` (formas **literais**
que o `DOM.getOuterHTML` do produto decodifica/normaliza antes do sanitizador, portanto inalcançáveis) e
`id="sen%68a"` (não é a palavra) — todos **idênticos à 1.1.41** (`v144` varredura, 3/31 contra 3/31).

### IMPORTANT

**Nenhum bloqueante.** O achado I-1 abaixo é perda de evidência, nunca vazamento, e cai na categoria que o
próprio artefato declara como preço aceito da decisão ("perda de texto em identificadores ambíguos").

### MINOR

#### m-1 — A lista fechada de flexões da família da língua não tem `io`/`ios`, e a marca de camelCase engole a flexão: `secretario`, `secretarios`, `secretariaDeSaude`, `tokenizacaoDeTexto` e `chaveiroDeLatão` perdem o texto — regressão contra 1.1.40, 1.1.41 e 1.1.42

**Causa raiz medida.** `languageFamilyExemption` (`privacy.js:444`) só poupa quando a flexão está em
`LANGUAGE_INFLECTIONS` (`privacy.js:426`). A lista tem `ia`, `ias`, `iado`, `ário`, `ários`, `aria`, `arias`,
`ura`, `or`, `ores`, `izacao` — e **não tem `io` nem `ios`**.

```
secretaria  -> família "secretar" + flexão "ia"  (na lista)  => poupada  => texto FICA
secretario  -> família "secretar" + flexão "io"  (FORA)      => tarjada  => texto CAI
secretário  -> família "secretári" + flexão "o"  (na lista)  => poupada  => texto FICA
```

E a marca de camelCase (`\u0001`) é removida **antes** da guarda, então a flexão vira "o resto todo":

```
secretariaDeSaude  -> plain "secretariadesaude" -> flexão "iadesaude" (fora)  => texto CAI
secretaria-saude   -> flexão "ia", resto "-saude"                            => texto FICA
```

**Reprodução mínima (1 comando).**

```
$ node probes/v144c-precision-real.mjs        # evidence/v144c-precision-real.out, §A
secretario             false  true   true   true   true     (1.1.44 CAI; 1.1.40/41/42 ficam)
secretarios            false  true   true   true   true
secretariaDeSaude      false  true   true   true   true
tokenizacaoDeTexto     false  true   true   true   true
chaveiroDeLatão        false  true   true   true   true
```

**Impacto.** Perda de evidência (nunca vazamento) em identificadores que a página usaria de verdade:
`<section id="secretariaDeSaude">` ou `<div class="secretario">` têm o texto — e o de toda a subárvore —
substituído por tarja nos trechos entregues. É **regressão contra a 1.1.40, a 1.1.41 e a 1.1.42** (que
preservam as cinco formas) e contra a 1.1.43 para texto com forma de prosa. O artefato **não declara** essas
formas: os 20 ids e as 99 palavras declarados são de outros corpora. O remédio é de uma linha — acrescentar
`io`/`ios` a `LANGUAGE_INFLECTIONS` e conferir a flexão depois de repor a marca de camelCase — e não toca a
decisão de privacidade.

*(Nota de contexto: o commit `e8ad6f8`, posterior ao artefato, publica uma "decisão de produto" que declara a
categoria "perda de evidência em identificador ambíguo" e prescreve exatamente "ampliar a lista de famílias
da língua" como resposta. O documento **não está no commit `3f6e38b` nem no zip**, mas registra a posição do
autor e é o motivo de eu não graduar este achado como Important.)*

#### m-2 — A descrição do resíduo de 6.707 está incompleta: 6.623 das formas têm prefixo da própria lista do autor e 6.515 têm cauda da própria lista

O autor descreve o resíduo como "radicais curtos sem cobertura de chave composta (`puk…`)". Medido
(`node probes/v144b-residual-shape.mjs`, `evidence/v144b-residual-shape.out`):

```
RESIDUO=6707
  com PREFIXO da lista (nova, meu, primeira, ...) = 6623
  com CAUDA   da lista (pix, assinatura, forte, ...) = 6515
  sem prefixo nem cauda da lista = 0
```

Formas que **vazam** e que uma página plausivelmente usaria: **`novaSenhaPix`, `novaChavePix`,
`novoTokenPix`, `novasenhapix`** (o simples `novaSenha` é tarjado, mas `novaSenha`+cauda não), e a família
`codigo*` (`codigoAcesso`, `codigoSeguranca`, `codigoVerificacao`, `codigoSms`, `codigoOtp`), `contaAcesso`,
`conta_acesso`, `fraseSecreta`, `perguntaSecreta`, `assinaturaDigital`, `numeroConta`,
`numeroCartaoCredito`. A metade `codigo*`/`conta*`/`api.key`/`private_key` o autor declara
(`README.md:147`); **as formas `<prefixo-da-lista><radical><cauda-da-lista>` e
`frase*`/`pergunta*`/`assinaturaDigital` não estão na declaração** — `grep -ril` por
`fraseSecreta`, `perguntaSecreta`, `assinaturaDigital`, `numeroConta`, `novaSenhaPix`, `novachavepix` e
`novoTokenPix` em `README.md` e `docs/qa/` devolve **0 arquivos**. Não é regressão (1.1.41 tem os mesmos
6.707 — `TRECHO_ENTREGA_O_VALOR_POR_GERACAO`), mas a declaração subestima o resíduo e omite as formas
compostas longas.

#### m-3 — O nome da falha da suíte não reproduz (`release-package` declarado; medido `preview-runtime-parity`)

Agregado **4.180/4.178/1** exato na raiz empacotada. A única vermelha é
`normative ESM exports remain byte-identical to the 78ba813 baseline`
(`test/personas/preview-runtime-parity.test.js`), que exige `.git`: **5/5 no clone com `.git`**
(`evidence/v144-preview-parity-clone.txt`), **4/5 na raiz sem `.git`** com `fatal: not a git repository`
(`v144-preview-parity-root.txt`). O `release-package` **passou** nesta medição. É o mesmo desfecho que a
revisão da 1.1.43 já tinha medido; a declaração continua citando o arquivo errado.

#### m-4 — Escopo serial: declarado 56/58, medido 57/58, com uma única flake (`axe-mv3-csp`), que passa isolada

`bash probes/serialfase-144.sh`: `tests 58 / pass 57 / fail 1`, vermelha
`runs pinned local axe in every isolated frame under real MV3 and strict page CSP` com
`cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]`. Rodado isolado:
`tests 1 / pass 1 / fail 0`. **Não apareceu** o `CONTEXT_PROOF_DENIED` que o autor declara. A declaração
(duas flakes) não reproduz; a flake nomeada existe e passa isolada, como o autor diz — a medição foi melhor
que a declarada, no mesmo sentido do Minor M-3 da revisão da 1.1.43.

#### m-5 — O registro de achados embaralha a partição 15/5 dos 20 ids

`docs/qa/2026-09-16-registro-de-achados-das-revisoes.md` (dentro do commit do artefato) diz "**os 5
restantes** (`chavear`, `chavena`, `secretas`, `token-de-acesso`, `cookie-banner`, `map-pin`)" — são **seis**
itens, e `token-de-acesso`/`cookie-banner`/`map-pin` são contados ali como **não**-credencial, enquanto o
README e a minha contagem os põem entre os **15** rótulos de credencial de verdade (os 5 da língua são
`sessao`, `sessões`, `chavear`, `chavena`, `secretas`). O README está certo; o registro não.

#### m-6 — `title` é declarado como resíduo aberto, mas está coberto no entregue

`GRUPO atributo_title` no E2E de gate: `vazou_em=(nenhuma)` na 1.1.44 (o sanitizador passou a descartar
`CREDENTIAL_VALUE_ATTRIBUTES`) — a declaração é pessimista, não errada. `aria-label` (3/6), `name`,
`data-*`-como-rótulo, nós irmãos e `th/td` continuam **abertos exatamente como declarado**
(`positions-141.mjs`, `v144-shapes.out`).

### Observação de integração (sem achado)

O parâmetro que os marcadores/destaque usam (`page-marker-projection.js:54`, `rootIdentity`) lê `id`/`class`
do **trecho já sanitizado**; como o elemento de credencial mantém `id`/`class` na abertura e só o conteúdo é
descartado, o localizador não se perde. Os E2E de marcadores, de axe do produto, de 5.9.1/5.9.7/5.9.8 e de
exportação passaram no escopo serial (57/58, a vermelha é a limpeza do `axe-mv3-csp`), e o E2E de cascata
que escrevi (`v144e-cascade-e2e.test.mjs`) mediu **resultado idêntico** entre 1.1.44 e 1.1.43 nas seis
superfícies para conteúdo dentro de `class="session"` e `id="sessao"` — não achei superfície coberta por
outro caminho que o par tenha aberto.

## 4. O que tentei para refutar cada item declarado como fechado

| Item declarado fechado | Ataque feito | Resultado |
| --- | --- | --- |
| **C-1 da 1.1.43 — portão por forma do valor** | 17 formas de valor (1/2/4/5/6 palavras, `.`/`!`/`?`/`:`/`;`/`,` final, 64/65/200 chars, JWT, CPF, cartão, e-mail, 80 chars base64) × 7 seções × 4 gerações; 198.360 identificadores × 4 formas × id/classe; E2E A/B nos bytes | **Fechado**: 0/18 em tudo, `VAZA=6.707` invariante, 0 reabertos, E2E `(nenhuma)` nos 8 casos que a 1.1.43 vazava |
| **C-2 da 1.1.43 — pilha por nome de tag** | `<div>`/`<span>`/`<p>` filhos, filhos de mesmo nome repetidos, 30 níveis, tag vazia no meio, `img`/`input` no meio, comentário, entidade, `<b>` partindo o valor, `template`/`svg`/`math`/`slot`/`dialog`/`noscript`/`canvas`/`video`/`object`/elemento customizado; E2E gate2 | **Fechado**: tarja em todos; `v143-gate2` 7/7 `(nenhuma)` |
| **C-2 da 1.1.43 — profundidade 8** | profundidades 1–12 no modelo colunar, `ownTextSignal` removido (0 ocorrências em `src/`) | **Fechado**: tarja em todas; 1.1.43 vazava de 8 para cima |
| **I-1 da 1.1.43 — "0 texto destruído" era artefato do texto de teste** | 11 formas de texto × 25 ids; dicionário de 234.289 palavras; contagem dos 15/5 | **Fechado como declaração honesta**: o número declarado (20/25 e 99) reproduz exatamente e a diferença 99−93 é mesmo de palavras inglesas. Mas a declaração não é exaustiva — ver **m-1** |
| "as formas de credencial seguem seladas" | 198.360 × 4 formas; 64.064 × 8 superfícies; 1.728 + 13.824; 880 + 7.040; 3.240; 31 casos estruturais meus; E2E de gate, gate2, iso, ataque, reabertos, key-axis | **CONFIRMADO — nenhum vazamento encontrado** |
| "0 texto destruído no dicionário" / precisão com 0 | substituído nesta geração por preço declarado; medi com texto de página e no entregue (iso E2E) | **Confirmado como declarado**; o preço é real e visível (`<div id="sessao">Sessão das 19h no cinema do bairro.</div>` e `<div class="password">Instruções do formulário de contato.</div>` = `(nenhuma)` na 1.1.44, presentes na 1.1.43) |
| Caçador 0/1.728 e 0/13.824; 880 realistas 0 em prosa/modelo; morfologia 0/39; 3/55; métrica 11/11; E2E 19/19, 13/13, 6/6; key-axis 1/1 | todos reexecutados nos bytes empacotados, Chrome 152 | **Confirmados exatamente** |
| Gate GREEN; auditoria ao vivo; 146/146 no HTML **e no PDF**; notas 5/5; 0 partidas; 0 `[redacted]` | `verify`, live Google, HTML + PDF (pypdf 6.19.0) | **Confirmados exatamente** |
| "0 reabertos" no corpus de 64.064 | p03 nas 8 superfícies | **Confirmado exatamente** (19.139/6.412/6.412/6.412/6.412/14.653 fechados) |
| colunar × simplificado | `v143-gate-shape` §C e §D | **Confirmado: os dois caminhos agora se comportam igual** (recall 0 em ambos; precisão destrutiva nos dois) |

## 5. O que NÃO foi medido

- **Iframes cross-origin, shadow DOM aberto/fechado e frames aninhados**: a classe nessas fronteiras não foi
  medida nesta rodada (nem o autor a cobre). Medi apenas `<iframe srcdoc>` no sanitizador de trecho.
- **O corpus de 516.235 formas do autor**: não existe no repositório; usei os universos do revisor
  (1,06 M / 1,09 M / 9,75 M) e o corpus de 198.360. Onde o número diverge, está dito.
- **Percurso de pixel (`element-only`/`full-evidence`)**: a auditoria ao vivo rodou em `no-pixels`, como nas
  revisões anteriores.
- **Desempenho** do `isPairedCredentialIdentity` a mais no caminho de captura.
- **Filtros do relatório** como superfície de vazamento e **evidência anexada** além das quatro exportações.
- **Produção real do formato `simplified-v1`**: confirmei por leitura que `src/` não o produz; medi só o
  comportamento do caminho por chamada direta.
- **Ambientes além de macOS / Chrome for Testing 152.0.7977.64 / Node 26.5.0**; gerações anteriores à 1.1.38;
  política da Chrome Web Store e assinatura do pacote.
- **Impacto do achado m-1 no veredito de critérios** (ex.: 5.9.1 virar falsa falha quando o rótulo do campo
  mora dentro de um contêiner com id da família): o E2E de cascata que escrevi não distingue "tarjado" de
  "não coletado" para texto sem ocorrência, e por isso **não** afirma esse impacto. A perda de evidência em
  si está medida no modelo colunar e no E2E isolado.

## 6. Veredito final

**APROVADO para o escopo** (fechamento dos 2 Critical, do Important e dos Minor da revisão da 1.1.43).

O que a 1.1.44 se propôs está medido e é sólido, e a **nona reprovação da classe fica efetivamente
fechada**: o portão por forma de conteúdo saiu do código (única ocorrência restante é comentário); a decisão
voltou ao identificador; e **não encontrei nenhum vazamento** em nenhuma das superfícies entregues, em
nenhuma das formas de valor, estruturas, profundidades, posições de rótulo ou gerações que ataquei — 0/18 em
17 formas, `VAZA=6.707` invariante em 198.360 × id/classe, 0 reabertos nos 64.064 × 8 superfícies, 0/1.728 e
0/13.824 no caçador, E2E de gate, gate2, iso, ataque (19), reabertos (13) e key-axis todos `(nenhuma)` em
Chrome 152 real, com o pacote íntegro (SHA declarado, 199 arquivos, 0 bytes divergentes) e o gate GREEN.

O preço declarado reproduz **exatamente** (20/25 ids e 99 palavras contra 93 da 1.1.41) e a partição 15/5
confere — inclusive a afirmação de que a diferença de 6 palavras é de inglês. Os Minors declarados estão
fechados ou declarados como o autor diz, com três desvios de número que registrei (nome da falha da suíte,
56/58 × 57/58, e a partição 15/5 embaralhada no registro).

Registro um **Minor** que o artefato não declara e que é regressão contra a 1.1.40, a 1.1.41 e a 1.1.42:
`secretario`, `secretarios`, `secretariaDeSaude`, `tokenizacaoDeTexto` e `chaveiroDeLatão` perdem o texto
porque a lista fechada de flexões da família da língua não tem `io`/`ios` e a marca de camelCase engole a
flexão (`secretaria` fica, `secretario` cai; `secretaria-saude` fica, `secretariaDeSaude` cai). É **perda de
evidência, nunca vazamento**, e o próprio autor publicou depois do artefato uma decisão de produto que
declara essa categoria e prescreve "ampliar a lista de famílias da língua" como resposta — motivo pelo qual
não graduo como Important nem bloqueio a entrega. Junto com **m-2** (o resíduo de 6.707 inclui 6.623 formas
com prefixo e 6.515 com cauda das próprias listas do autor — `novaSenhaPix`, `novaChavePix`,
`novoTokenPix`, além de `fraseSecreta`/`perguntaSecreta`/`assinaturaDigital`), são os dois incrementos
naturais da próxima geração; nenhum dos dois reabre a decisão de privacidade.
