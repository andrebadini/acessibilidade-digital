# REVIEW-1.1.43 — revisão independente e adversarial do artefato Audita Acessibilidade 1.1.43

Revisor independente e adversarial. **Nenhuma afirmação do autor vale como prova**: toda medida abaixo foi
produzida por comando próprio, com a saída bruta em `/private/tmp/audita-review-143/evidence/`.
**Nada foi escrito dentro do repositório do autor** — nem no worktree, nem no `.git`. Todas as sondas e
testes novos estão em `/private/tmp/audita-review-143/probes/` (prefixo `v143-`).

## Ambiente de medição

| Item | Valor |
| --- | --- |
| Worktree do autor (somente leitura) | `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`, branch `feature/audita-mt` |
| Commit do artefato | `719fe13` (`5e22e46` é posterior e toca **só** `docs/qa/2026-09-16-estado-dos-criterios-1.1.19.md`) |
| Clone independente (regra 1) | `git -C <worktree> clone --no-hardlinks --local … /private/tmp/audita-review-143/clone` — **sem `cp -R .git`** |
| Raiz de medição (regra 2) | `/private/tmp/audita-review-143/root` = `git archive 719fe13` **com o zip sobreposto** (`unzip -o`), mais `test/`, `scripts/` e `fixtures/` do commit e `node_modules` (axe-core 4.13.0) |
| Gerações de comparação | 1.1.42 = `1f0abb6` (`mut-142`), 1.1.41 = `4df8c8c` (`mut-141`), 1.1.40 = `c9d7dd4` (`mut-140`), 1.1.39 = `746a696`, 1.1.38 = `733cd01` |
| Chrome (regra 3) | `Google Chrome for Testing 152.0.7977.64`, **um Chrome por vez**, `--test-concurrency=1` |
| Node | v26.5.0 |

> **Nota de estado do worktree.** Quando esta revisão começou, o `HEAD` do worktree estava em `5e22e46`;
> ao terminar, já era `f0146dd` (avanço do próprio autor). O `.git` do worktree continua sendo o
> arquivo-ponteiro (`gitdir: /Volumes/SSD1/acessibilidade-digital/.git/worktrees/audita-mt`) e **não foi
> tocado**; todo comando `git` de medição rodou com `git -C` na minha cópia, o zip do autor continua com o
> digest `da5889de…ec2c`, e **nenhum arquivo do repositório do autor foi escrito por mim**. Os quatro commits
> posteriores a `719fe13` tocam **apenas** `docs/qa/*.md` — `src/`, `test/` e `scripts/` são idênticos, de modo
> que todas as medidas deste relatório valem para o commit `719fe13` e para os bytes do zip empacotado.

## 0. Integridade do pacote

| Medida | Comando próprio | Resultado |
| --- | --- | --- |
| SHA-256 do zip | `shasum -a 256 release/audita-acessibilidade-1.1.43.zip` | `da5889de54193150c1c08242806c0fb79406c40f00ca8873db2283e333f2ec2c` — **igual ao declarado** |
| Arquivos no zip | `unzip -Z1 \| wc -l` | **199** |
| Nada no zip fora do commit | `comm -23 zip-filelist commit-filelist` | **0** (`evidence/zip-only.txt` vazio) |
| Byte a byte vs `git archive 719fe13` | `cmp` nos 199 arquivos | **0 divergências** (`evidence/byte-diff.txt` vazio) |
| Sobreposição na raiz de medição | `cmp` após `unzip -o` | **0 divergências** (`evidence/overlay-diff.txt` vazio) |
| Versão no artefato | `manifest.json` empacotado | `1.1.43` |
| Commit que reproduz os bytes | `git log -1 -- release/audita-acessibilidade-1.1.43.zip` | **`719fe13`** |

O código tocado pelo incremento é exatamente `src/core/privacy.js`, `src/core/evidence/snippet.js`,
`src/core/normalize-snapshot.js` (+ testes e documentos) — `evidence/src-diff-142-143.txt`.

## 1. Veredito por alegação

### 1.1 Integridade e empacotamento

| # | Alegação | Comando próprio | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | SHA-256 `da5889de…ec2c` | `shasum -a 256` | idêntico | **CONFIRMADO** |
| 2 | 199 arquivos, nada fora do commit, bytes idênticos | `comm` + `cmp` | 199 / 0 / 0 | **CONFIRMADO** |

### 1.2 O que o autor declara fechado (Critical e 4 Minors da revisão da 1.1.42)

| # | Alegação | Comando próprio | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 3 | **0 reabertos** no corpus de 198.360 (id e classe) com `VAZA=6.707`, idêntico à 1.1.41 | `node probes/p02-id-differential.mjs` | id **6.707/198.360**, classe **6.707**, 1.1.41 = 6.707, 1.1.40 = 198.360; `REABERTOS=0`; plausíveis = 0 | **CONFIRMADO — mas só para o valor de 1 palavra do corpus; ver C-1** |
| 4 | **0 reabertos** nas seis superfícies do corpus de 64.064: 19.139 fechados em prosa, 6.412 em chave JSON/URL/trecho, 14.653 em `aria-label` | `node probes/p03-diff-141-142.mjs` | `prosa-fraca FECHADOS=19139`, `json-chave=6412`, `url-param=6412`, `trecho-id=6412`, `trecho-classe=6412`, `aria-label=14653`; **REABERTOS=0** em todas | **CONFIRMADO (exato, seis números)** |
| 5 | **0** texto destruído no dicionário (a 1.1.41 destruía 93) | `node probes/p04-precision.mjs` | com o texto do teste (`'Conteudo publico da secao.'`, 4 palavras **com ponto final**): 1.1.43 = **0**, 1.1.41 = 93, 1.1.40 = 0 | **PARCIAL — o 0 é artefato da forma do texto de teste; ver I-1** |
| 6 | Corpus PT-BR de 70 palavras com `NOVOS=[]` | `node probes/fp-ptbr-141.mjs` | `data NOVOS=[] CORRIGIDOS=30`; `id NOVOS=[]`; `classe NOVOS=[]`; `prosa NOVOS=[] CORRIGIDOS=15` | **CONFIRMADO** |
| 7 | Prosa `NOVOS vs 1.1.40` = 10 (rótulos artificiais `pix-<família>`) | `node probes/p06-guard-delta.mjs` + `p06b-142-baseline.mjs` | 1.1.43: `NOVOS=10` exatos (`pix-chaveir`, `pix-chaveament`, `pix-pintur`, `pix-pincé`, `pix-pingent`, `pix-pingu`, `pix-secretar`, `pix-secretári`, `pix-secretos`, `pix-tokeniz`); 1.1.42 (baseline) = **2.038** | **CONFIRMADO (2.038 → 10)** |
| 8 | `id` de **4.797 → 0** reabertos contra a 1.1.41 | idem | 1.1.42 `REABERTOS vs 1.1.41 = 4.797`; 1.1.43 = **0**; `NOVOS vs 1.1.40 = 0` | **CONFIRMADO** |
| 9 | E2E do revisor `attack-e2e-141` **19/19** com `vazou_em=(nenhuma)` nos 6 identificadores e nos 3 de prosa | `bash probes/chain-143.sh` | `tests 19 / pass 19 / fail 0`; b01–b06 `(nenhuma)`; d01–d03 `(nenhuma)`; c01–c05 evidência 3/6; e01/e03/e04 3/6 e e02 2/6 | **CONFIRMADO (exato)** |
| 10 | E2E do revisor `reabertos-e2e-142` **13/13**, `vazou_em=(nenhuma)` nos dez reabertos | idem | `tests 13 / pass 13 / fail 0`; f01–f10 `(nenhuma)`; g01–g03 `(nenhuma)` | **CONFIRMADO (exato)** |
| 11 | Caçador **0/1.728** e **0/13.824** | `node probes/hunter-141.mjs` | 1.1.43 = **0/1728** e **0/13824** (1.1.40 = 336 e 1.830); as formas naturais de credencial (`senhapixtoken`, `senhapixpin`, `senhaDoPixToken`, `chavePixToken`, …) = tarja nas quatro superfícies, e as palavras da língua (`chaveiro`, `pintura.png`, `secretaria-saude`, `data-chaveiro`) = preservadas | **CONFIRMADO** |
| 12 | 880 formas realistas com **0** vazamento em prosa/modelo | `node probes/realistas-141.mjs` | 1.1.43: 880 formas → `{chave:108, url:108, id:108}` — **prosa e modelo ausentes do mapa** (= 0); 1.1.42 tinha `id:178`; 1.1.40 tinha 2.032 vazamentos | **CONFIRMADO** (o resíduo 108/108/108 é o declarado de radicais curtos) |
| 13 | Morfologia PT **0/39** | `node probes/morfologia-141.mjs` | 1.1.43 = **0/39**; 1.1.40 = 20/39 | **CONFIRMADO** |
| 14 | Chaves inocentes **3/55** (`cupbearer`, `pallbearer`, `chipping`) | corpus de 55 do revisor + `sanitizeJsonData` | 1.1.43 = **3/55**, conjunto exato `cupbearer pallbearer chipping`; **1.1.42 e 1.1.40 = o mesmo conjunto** | **CONFIRMADO** |
| 15 | Métrica da classe **11/11** (com não vacuidade) | `node --test test/core/credential-class-metric.test.js` | **11/11** (diagnóstico `resíduo de chave com radical curto: 387 de 690`); o MESMO teste sobre 1.1.42 = 10/11, 1.1.41 = 10/11, 1.1.40 = 8/11 | **CONFIRMADO (não vazio)** |
| 16 | E2E novo `identifier-credential-mv3` **6/6** | `node --test test/e2e/identifier-credential-mv3.test.mjs` | 3 casos de identificador + 3 controles negativos **✔**, `tests 6 / pass 6 / fail 0` | **CONFIRMADO** |
| 17 | `key-axis` **1/1** com `VAZA_EM=(nenhuma)` nos seis casos | `bash probes/chain-143.sh` | `tests 1 / pass 1 / fail 0`; **seis** `VAZA_EM=(nenhuma)`; rótulo presente no modelo/HTML/JSON | **CONFIRMADO** |
| 18 | Suíte **4.180/4.178/1** (a única falha é o `release-package`) | `node probes/run-parallel-noe2e-141.mjs` | `tests 4180 / pass 4178 / fail 1 / skipped 1` — **agregado exato**; mas a falha é `preview-runtime-parity` (“normative ESM exports remain byte-identical to the 78ba813 baseline”, `fatal: not a git repository`) e o **`release-package` passou**; o teste que falha passa **5/5** no clone com `.git` | **PARCIAL — agregado confirmado, nome da falha não reproduz** |
| 19 | Escopo serial de 12 arquivos nos bytes empacotados: **57/58**, única vermelha no flake do `axe-mv3-csp` | `bash probes/serial-scope-141.sh` | `tests 58 / pass 58 / fail 0`, `SERIAL_EXIT=0` — **nenhuma vermelha** | **PARCIAL — o número declarado não reproduz; mediu melhor (58/58)** |
| 20 | Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` → GREEN | idem, na raiz empacotada | `VERIFY_EXIT=0`; `130/146 (96/50)`, identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN | **CONFIRMADO** |
| 21 | Auditoria ao vivo no Google: 0 falhas, 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, versão 1.1.43, quatro exportações `complete` | `bash probes/chrome-live-142.sh` + extração própria | Painel: `0 Falhas confirmadas (0 ocorrências)`, `1 Recomendações e alertas (1 ocorrência)`, `3 Suspeitas a confirmar (4 ocorrências)`, `9 Resultados positivos`, `109 verificações ainda sem conclusão`; HTML: `Cobertura automática: 28,5%`, `9,0 / 10`; JSON `audit.versions.extension="1.1.43"`, 146 assertions (`cantTell 109`, `inapplicable 27`, `failed 1`, `passed 9` — o `failed` é a **Recomendação** 5.3.3 “Cabeçalho principal”, contada no painel como recomendação/alerta, não como falha confirmada); `downloads=complete/complete/complete/complete` | **CONFIRMADO** |
| 22 | Integridade **146 itens (96+50)**, 146/146 ids e títulos no HTML **e no PDF**, notas 5/5, 0 palavras partidas, 0 `[redacted]` | `node probes/integrity-141.mjs`, `node probes/integrity-pdf-141.mjs` | HTML: `ITENS=146 REQUISITOS=96 RECOMENDACOES=50`, `ids_ausentes=0`, `titulos_ausentes=0`, `notas=5/5`, `[redacted]=0`, `partidas=0`. PDF (18 páginas): `ids_ausentes=[]`, `titulos_ausentes=[]`, `[redacted]=0`, 24 pares hífen+quebra, **todos com correspondência no HTML** (amostra verificada: `aria-controls`, `data-ved`, `NBR-17225`, `lei-8078`, …) | **CONFIRMADO** |
| 23 | Resíduos declarados abertos | `node probes/residuos-141.mjs` + `v143-shapes`/`realistas` | `api.key`, `private_key`, `privatekey`, `codigoacesso`, `codigo-verificacao`, `codigoseguranca`, `contaacesso`, `conta-pix`, `chave·de·api` (prosa/modelo/trecho) → **ABERTOS**, idênticos à 1.1.40; rótulo+valor em nós irmãos → **ABERTO**; radicais curtos (`puk`…) → 108/880 em chave/URL/id | **CONFIRMADO (declaração honesta)** |
| 24 | Discrepância declarada: escopo serial 57/58 aqui × 55/58 no revisor; `COBERTURA_GANHA` 5.661 nos universos do autor × 5.764 nos do revisor | `serial-scope` + `node probes/coverage-141.mjs` | Serial **58/58** (não 57/58); `COBERTURA_PERDIDA=0` em U1 (1.063.290), U2 (1.088.992) e U3 (9.754.688), `GANHA=5.764` em U2 e 152.578 em U3; vocabulário de prosa/modelo: `PERDIDA=0`, `GANHA=0` | **CONFIRMADO na declaração** (o 5.661 não reproduz nos meus universos, como o autor já declara; o serial mediu **melhor** que o declarado) |
| 25 | “as formas de credencial seguem seladas” / “0 texto destruído” / par com o vocabulário inteiro | sondas próprias `v143-*` | **REFUTADO** — ver **C-1**, **C-2** e **I-1** | **REFUTADO** |

## 2. Achados por severidade

### CRITICAL

#### C-1 — O portão `looksLikeFieldValue` reabre o par identificador→valor para toda credencial que não seja “1 a 4 palavras sem pontuação final e com ≤64 caracteres”: valor volta ao modelo guardado e aos artefatos HTML/JSON

**Causa raiz.** O par identificador→valor deixou de decidir pelo identificador e passou a decidir pela **forma
do conteúdo** (`src/core/privacy.js:562`):

```js
export function looksLikeFieldValue(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text === '' || text.length > 64) return false;   // > 64 caracteres  => NÃO é valor
  if (/[.!?;:]\s*$/u.test(text)) return false;         // termina em . ! ? ; :  => NÃO é valor
  return text.split(' ').length <= 4;                  // 5+ palavras       => NÃO é valor
}
```

Quem não é “valor” não é selado: no trecho (`snippet.js:264`), o fragmento segue para o fluxo normal e sai
íntegro; no modelo (`normalize-snapshot.js:206`), o elemento deixa de ser raiz de texto privado.

**Reprodução mínima (unidade, 1 comando).**

```
$ node probes/v143-shapes.mjs        # evidence/v143-shapes.out
trecho <div id="senha">VALOR</div>       43        42        41
1_palavra  ('borboleta')                 0/18      16/18     0/18
4_palavras ('um dois tres quatro')       0/18      16/18     0/18
5_palavras ('cinco seis sete oito nove') 18/18     16/18     0/18   <-- reabre
6_palavras ('correto cavalo … extra')    18/18     16/18     0/18   <-- reabre
ponto_final ('Zqwkvbrtnmx9.')            18/18     16/18     0/18   <-- reabre
exclamacao / interrogacao / ':' / ';'    18/18     16/18     0/18   <-- reabre
65_chars ('A'×65)                        18/18     16/18     0/18   <-- reabre
200_chars (JWT)                          18/18     16/18     0/18   <-- reabre
64_chars ('A'×64)                        0/18      16/18     0/18
virgula_final ('Zqwkvbrtnmx9,')          0/18      16/18     0/18
```

O mesmo vale para `class` e para o **modelo colunar** (`v143-shapes.out`, §§B e F: 18/18 em todas as formas
longas, com pontuação final ou acima de 64 caracteres).

**Extensão ao corpus do próprio autor (198.360 identificadores de `p02`), agora com a dimensão de forma do
valor** (`node probes/v143-recall-198k.mjs`, `evidence/v143-recall-198k.out`):

| valor | 1.1.43 | 1.1.42 | 1.1.41 | reabertos vs 1.1.41 | reabertos vs 1.1.42 |
| --- | --- | --- | --- | --- | --- |
| `borboleta` (1 palavra — o valor do corpus do autor) | **6.707** | 167.104 | 6.707 | **0** | 0 |
| 5 palavras | **198.360 / 198.360** | 167.104 | 6.707 | **191.653** | **31.256** |
| `borboleta.` (ponto final) | **198.360 / 198.360** | 167.104 | 6.707 | **191.653** | **31.256** |
| `'A'×65` | **198.360 / 198.360** | 167.104 | 6.707 | **191.653** | **31.256** |

id e classe dão o mesmo número. Ou seja: a prova “0 reabertos / VAZA=6.707” é **vacuidade em relação ao
portão novo** — o corpus varia 198.360 identificadores e **um único valor de 1 palavra**, exatamente a forma
que `looksLikeFieldValue` classifica como valor.

**Reprodução mínima (artefatos entregues, Chrome real).** `probes/v143-gate-e2e.test.mjs` — mesmo percurso do
autor (painel → relatório → modelo/revisão guardados → quatro exportações), A/B por `AUDITA_EXT_PATH`:

| caso (fixture) | 1.1.43 | 1.1.42 | 1.1.41 |
| --- | --- | --- | --- |
| `<div id="senhaassinatura">correto cavalo bateria grampo extra</div>` | **VAZOU 3/6** (`guardado`, `artefato html`, `artefato json`) | 0/6 | 0/6 |
| `<div class="chavepix">cinco seis sete oito nove</div>` | **VAZOU 3/6** | 0/6 | 0/6 |
| `<div id="password">Zqwkvbrtnmx9.</div>` | **VAZOU 3/6** | 3/6 | 0/6 |
| `<div id="apikey">sk-live-QQQ…(68 chars)</div>` | **VAZOU 3/6** | 3/6 | 0/6 |
| `<div id="token"><span>TTT…(70 chars)</span></div>` | **VAZOU 3/6** | 3/6 | 0/6 |
| `<div id="senha">um dois tres quatro</div>` | 0/6 | 3/6 | 0/6 |
| `<div id="senha">borboleta</div>` (controle do Critical da 1.1.42) | 0/6 | 3/6 | 0/6 |

As fixtures são diretamente comparáveis às do autor: o valor `borboleta` é o mesmo que
`test/e2e/identifier-credential-mv3.test.mjs` usa como segredo; trocando o valor por um de 6 palavras ou por
uma chave de 68 caracteres, **o mesmo elemento que o E2E do autor declara selado entrega o texto**.

**Superfícies adicionais.** No modelo colunar, o valor de 6 palavras também sai em `axValue`,
`accessibleDescription` e `accessibleName` (`node probes/v143-interacao.mjs`, §A): 1.1.43 = `VAZOU`, 1.1.42 e
1.1.41 = `tarja` para `senhaassinatura`/`chavepix`.

**Impacto.** É a própria classe sob revisão — credencial da página chegando ao modelo guardado e aos
artefatos HTML/JSON entregues — e o E2E prova 3 das 6 superfícies, exatamente as que o E2E do autor usa como
veredito. Os valores atingidos são realistas: **chave de API/JWT acima de 64 caracteres**, **senha terminando
em ponto/exclamação**, **frase-senha de 5+ palavras**. Contra a 1.1.41 (6.707 → 198.360 no corpus do autor) e
contra a 1.1.42 nos identificadores colados (`senhaassinatura`, `chavepix`).

---

#### C-2 — Dois desvios estruturais entregues (e um latente): a pilha do trecho é fechada por nome de tag e o sinal do modelo para na profundidade 8 — valor de **1 palavra** volta às superfícies que a 1.1.42 selava

**(a) `credentialContext` sem profundidade (`snippet.js:330`).**

```js
if (parsed.closing && credentialContext.length > 0 && credentialContext.at(-1) === parsed.name) {
  credentialContext.pop();
}
```

A pilha guarda só o **nome** da tag. Qualquer filho com o mesmo nome fecha o quadro do elemento credencial
antes do fim: o texto seguinte deixa de estar em contexto de credencial e sai íntegro.

```
$ node probes/v143-context-stack.mjs      # evidence/v143-context-stack.out
<div id="senha"><div>Rótulo do campo</div>borboleta</div>
   1.1.43 = "<div><div>[redacted]</div>borboleta</div>"   VAZOU
   1.1.42 = VAZOU (o `senha` não era par na 1.1.42)   1.1.41 = tarja
<div class="senhaassinatura"><div>Rótulo</div>Zqwkvbrtnmx9</div>
   1.1.43 = VAZOU      1.1.42 = tarja      1.1.41 = tarja   <-- regressão nova
<div id="apikey"><div>Chave</div>AKIAIOSFODNN7EXAMPLE</div>
   1.1.43 = VAZOU      1.1.42 = tarja      1.1.41 = tarja   <-- regressão nova
```

**E2E (Chrome real, `probes/v143-gate2-e2e.test.mjs`):** s02 (`class="senhaassinatura"`) e s03 (`id="apikey"`)
→ **1.1.43 VAZOU 3/6 (`guardado`, `artefato html`, `artefato json`)**; **1.1.42 = 0/6**. Um `<div>` de rótulo
dentro do contêiner de credencial é estrutura corriqueira.

**(b) `ownTextSignal` para na profundidade 8 (`normalize-snapshot.js:743`).**

```js
const ownTextSignal = (record, depth = 0) => {
  const parts = [record.rawText ?? ''];
  if (depth < 8) for (const child of childrenByRecord.get(record) || []) parts.push(ownTextSignal(child, depth + 1));
  return cleanText(parts.join(' '));
};
```

Com 8 níveis internos ou mais, o sinal chega vazio ao elemento credencial, `looksLikeFieldValue('')` é falso
e o elemento deixa de ser privado — **mesmo com valor de 1 palavra**:

```
$ node -e "…probes/v143-context-stack.mjs §C…"    # níveis internos × geração
níveis=7   1.1.43=tarja | 1.1.42=tarja | 1.1.41=tarja
níveis=8   1.1.43=VAZOU | 1.1.42=tarja | 1.1.41=tarja
níveis=10  1.1.43=VAZOU | 1.1.42=tarja | 1.1.41=tarja
níveis=12  1.1.43=VAZOU | 1.1.42=tarja | 1.1.41=tarja
```

**E2E isolado (`probes/v143-iso-e2e.test.mjs`, `<div id="senhaassinatura">` + 10 `<div>` + `hortelã-fresca`):**
1.1.43 → **PRESENTE em `guardado` e `artefato json` (2/6)**; 1.1.42 e 1.1.41 → **(nenhuma)**.

**(c) Latente — no modelo o portão julga o texto do CONJUNTO (rótulo + valor).** `privateTextElement` recebe
`ownTextSignal(record)`, que concatena o texto de todo o subárvore; um rótulo de 4+ palavras empurra o valor
para fora do portão:

```
<div id="senhaassinatura"><div>Informe a senha de assinatura digital</div>borboleta</div>
   modelo colunar: 1.1.43 = VAZOU | 1.1.42 = tarja | 1.1.41 = tarja
```

No E2E essa forma **não** chegou às superfícies entregues (o trecho do ancestral é contaminado antes), mas o
`SnapshotV1` intermediário — que alimenta `hasPrivateTextAncestor` e os índices de evidência — já contém o
valor. Fica registrado como latente.

**Impacto.** C-2 é independente de C-1: não depende da forma do valor. As variantes (a) e (b) estão
**entregues** (guardado + HTML + JSON) e são regressões contra a 1.1.42 e a 1.1.41, nas mesmas superfícies
que o E2E do autor usa como prova.

---

### IMPORTANT

#### I-1 — “0 texto destruído no dicionário” é artefato do texto de teste; com texto de página curto o portão destrói 99 palavras do dicionário e 20 de 25 ids PT — regressão contra a 1.1.42

Toda a prova de precisão do autor (e a da revisão anterior) usa o MESMO texto de teste,
`'Conteudo publico da secao.'` (4 palavras **com ponto final**) — exatamente a forma que o portão classifica
como **não**-valor. Trocando só o texto, a destruição volta:

```
$ node probes/v143-precision.mjs        # evidence/v143-precision.out
ids de vocabulário/PT (25) × texto:         1.1.43  1.1.42  1.1.41  1.1.40
'Conteudo publico da secao.'  (autor)          0       0      20       0
'Conteudo publico da secao'   (sem ponto)     20       0      20       0
'Sessão das 19h' (título)                     20       0      20       0
'Avenida Paulista'                            20       0      20       0
'Coleção de xícaras'                          20       0      20       0
'R$ 47,90'                                    20       0      20       0
'Rua das Flores, 123'                         20       0      20       0
'Sessão das 19h no cinema' (5 palavras)        0       0      20       0
'Sessão das 19h no cinema do bairro.'          0       0      20       0
```

Os 20 ids que destroem texto curto incluem a lista que a revisão da 1.1.42 mandou preservar: `sessao`,
`sessões`, `password`, `cookie`, `pin`, `token`, `chave`, `senha`, `segredo`, `credencial`, `session`,
`secret`, `puk`, `seed`, `chavear`, `chavena`, `secretas`, `token-de-acesso`, `cookie-banner`, `map-pin`.

**Dicionário do sistema (210.626 palavras) como `id`:**

```
texto 'Conteudo publico da secao.'  -> 1.1.43 destrói 0   (o número declarado)
texto 'Avenida Paulista'            -> 1.1.43 destrói 99  | 1.1.42 = 16 | 1.1.41 = 93 | 1.1.40 = 0
                                       NOVOS vs 1.1.42 = 83
   (antipass, authentication, authorization, bearer, credential, pass, passkey, password, pin,
    possession, secret, secretary, session, seed, obsession, …)
```

**E2E isolado (Chrome real, `probes/v143-iso-e2e.test.mjs`):**

| fixture | 1.1.43 | 1.1.42 | 1.1.41 |
| --- | --- | --- | --- |
| `<div id="sessao">Avenida Paulista</div>` | **DESTRUÍDO (0/6)** | preservado (3/6) | destruído (0/6) |
| `<div id="sessao">Sessão das 19h no cinema do bairro.</div>` | preservado (2/6) | preservado (2/6) | destruído (0/6) |
| `<div class="password">Instruções do formulário de contato.</div>` | preservado (3/6) | preservado (3/6) | destruído (0/6) |

**Impacto.** É o outro lado da troca do C-1 e é **real e medido**: a 1.1.43 melhorou de verdade contra a
1.1.41 (prosa com pontuação final preservada), mas regrediu contra a 1.1.42 para textos de página curtos, e a
declaração “0 texto destruído no dicionário / precisão com 0” **não se sustenta fora da forma de teste
escolhida**. Títulos, endereços, preços e legendas sem ponto final em elementos com `id`/`class` de
vocabulário perdem o texto em silêncio.

*(Observação ligada a C-1: quando um valor escapa do portão, o `compactStream` do trecho do ancestral é
contaminado e **destrói a prosa seguinte** que o portão preservaria — `<div id="chaveiro">R$ 47,90</div>`
aparece preservado quando sozinho na página e destruído quando convive com um vazamento. `evidence/`
`v143-precision.out` §D, `v143-gate-e2e-43.txt` e `v143-iso-e2e-1.1.43.txt`.)*

---

### MINOR

- **M-1 — Os dois caminhos do modelo não se comportam igual.** No caminho simplificado o texto é
  `` `${node.text} ${node.visibleText}` `` — o conteúdo aparece **duas vezes** quando os dois campos vêm
  preenchidos, e um valor de 4 palavras (8 na contagem) deixa de ser valor: `v143-gate-shape.out` §C mostra
  `simp:VAZOU / col:tarja` para 4 e 5 palavras e para 64 caracteres, com `1.1.41` selando nos dois. O formato
  `simplified-v1` **não é produzido pelo produto** (só `normalizeColumnar` é usado por `run-audit.js`; grep em
  `src/` só encontra o consumidor), então o impacto é latente — mas é divergência real entre caminhos, e é a
  demonstração de que “o portão também vale no modelo” depende do caminho.
- **M-2 — “55 qualificadores realistas” não corresponde ao código.** `CREDENTIAL_QUALIFIERS`
  (`privacy.js:434`) tem **53** entradas; o sinal efetivo soma `TAILS_ALTERNATION`. A afirmação do README e o
  comentário falam em 55.
- **M-3 — Números declarados que não reproduzem (declarados como tais, mas com desfecho diferente do
  previsto).** (a) Escopo serial: declarado **57/58** com a vermelha no `axe-mv3-csp`; medido **58/58, 0
  falhas** (nada isolado precisou ser reexecutado). (b) Fase paralela: agregado **4.180/4.178/1** exato, mas a
  falha é `preview-runtime-parity` (exige `.git`; passa **5/5** no clone com `.git`) e o `release-package`
  declarado **passou** — o autor já descreve esse comportamento (“a falha muda de arquivo”), e ele se
  confirma. (c) `COBERTURA_GANHA`: 5.764 nos meus universos (U2 = 1.088.992), não 5.661; `COBERTURA_PERDIDA=0`
  em U1/U2/U3 e no vocabulário de prosa/modelo. O autor declara a divergência — a declaração está correta.
- **M-4 — Dicionário permissivo: 1.1.43 = 562 (1.1.42 = 537, 1.1.40 = 563), `PERDEU=['pingue']`,
  `GANHOU=0`.** `node probes/dict-author-141.mjs` (filtro de 234.291 palavras). O número da 1.1.43 não está
  declarado nos documentos.
- **M-5 — O portão de pontuação é lista parcial.** `,` `…` `)` contam como “valor” (selam) enquanto `.` `!`
  `?` `;` `:` não; a fronteira é 64/65 caracteres. A documentação diz “sem pontuação de frase”, mas o
  implementado é o conjunto fechado `[.!?;:]` no fim.
- **M-6 — Resíduos declarados seguem abertos, como o autor diz.** `aria-label` entrega o valor em 3/6
  superfícies (`v143-gate-e2e-43.txt`, `cravo-branco`); `name`, `data-*` e nós irmãos idem; `api.key`,
  `private_key`, `codigo*`, `conta*`, `chave·de·api` idênticos à 1.1.40. A declaração é honesta — registro
  para que não seja lida como “fechado”.

## 3. O que tentei para refutar cada item declarado como fechado

| Item declarado fechado | Ataque feito | Resultado |
| --- | --- | --- |
| **C1 da 1.1.42 — par estreitado (vocabulário de chave)** | p02 (198.360, id e classe, valor fraco e forte), p03 (64.064 × 8 superfícies), E2E `reabertos-e2e-142` | **Fechado para valor de 1 palavra**: 6.707 = 1.1.41, 0 reabertos, 13/13 no E2E. **Reaberto para outras formas de valor** (C-1) |
| **M-1 da 1.1.42 — guarda assimétrica da família** | p06 com 26.112 formas `<família><desinência><radical><cauda>`; p06b para o baseline 1.1.42; caçador estendido; corpus PT-BR | **Fechado**: prosa 2.038 → 10 (só `pix-<família>`), id 4.797 → 0 reabertos, 0/13.824, 0/39 morfologia. Único preço: as 13 palavras inglesas declaradas no teste da métrica (`pallbearer`, `cupbearer`, `aniseed`, `chipping`, …) |
| **M-2 da 1.1.42 — dicionário apagado** | p04 (210.626 palavras), com 3 formas de texto | **Fechado só na forma de texto do teste** (0 com ponto final; 99 com texto curto) — ver I-1 |
| **M-3 da 1.1.42 — export morto** | `grep -rn isLanguageWordHead src/ test/` | **Fechado**: nenhuma ocorrência |
| **M-4 da 1.1.42 — números que não reproduzem** | serial, paralela, coverage | **Parcial**: agregados confirmados; serial mediu 58/58 e a falha da paralela é outra (ambas ambientais) |
| “as formas de credencial seguem seladas” | 198.360 formas × 4 formas de valor; E2E A/B em Chrome; desvios estruturais | **REFUTADO** (C-1 e C-2: 191.653 reabertos vs 1.1.41 e 31.256 vs 1.1.42; 1 palavra entregue por ninho/profundidade) |
| “0 texto destruído / precisão com 0” | dicionário e corpus PT com 11 formas de texto, E2E isolado | **REFUTADO fora da forma de teste** (I-1) |
| Caçador 0/1.728 e 0/13.824; 880 realistas 0 em prosa/modelo; morfologia 0/39; 3/55; métrica 11/11; E2E 19/19, 13/13 e 6/6; key-axis 1/1 | todos reexecutados nos bytes empacotados, Chrome 152 | **Confirmados exatamente** |
| Gate GREEN; auditoria ao vivo; 146/146; notas 5/5; 0 partidas; 0 `[redacted]` | `verify`, live Google, HTML + PDF (pypdf) | **Confirmados exatamente** (o `failed` do JSON é a Recomendação 5.3.3, exibida como alerta, não como falha) |

## 4. O que NÃO foi medido

- **O corpus de 516.235 formas do autor**: não existe no repositório; usei os universos do revisor da 1.1.40
  (1,06 M / 1,09 M / 9,75 M) e o corpus de 198.360. Onde o número diverge, está dito.
- **O portão em iframes, shadow DOM e frames cross-origin**: a classe de credencial nessas fronteiras não foi
  medida nesta rodada (nem o autor a cobre).
- **Percurso de pixel (`element-only`/`full-evidence`)**: a auditoria ao vivo rodou em `no-pixels`, como nas
  revisões anteriores.
- **Desempenho** do `isSensitiveKeyName` a mais no par e do `CREDENTIAL_QUALIFIER_SIGNAL` novo.
- **Filtros do relatório** como superfície de vazamento (busca/filtro por texto) e **evidência anexada** além
  das quatro exportações.
- **Produção real do formato `simplified-v1`** (M-1): confirmei por leitura que `src/` não o produz; não
  medi nenhum consumidor externo.
- **Ambientes além de macOS / Chrome for Testing 152.0.7977.64 / Node 26.5.0**; **gerações anteriores à
  1.1.38**; **política da Chrome Web Store / assinatura do pacote**.
- **`data-<palavra>` do lado do modelo/JSON**: medi o atributo no trecho.

## 5. Veredito final

**REPROVADO** para o escopo declarado (fechamento do Critical e dos quatro Minors da revisão da 1.1.42).

O que a 1.1.43 **realmente fez** está medido e é sólido no eixo que ela se propôs: devolveu ao par o
vocabulário de chave inteiro sem perder a precisão de prosa — 0 reabertos e `VAZA=6.707` (idêntico à 1.1.41)
no corpus de 198.360 com o valor de 1 palavra, 19.139/6.412/14.653 formas fechadas nos 64.064, guarda de
família simétrica (2.038 → 10 na prosa, 4.797 → 0 no id), dicionário PT limpo, morfologia 0/39, caçador 0,
E2E 19/19 e 13/13 e 6/6, gate GREEN, auditoria ao vivo e integridade 146/146 — tudo reproduzido por comando
próprio, nos bytes empacotados, em Chrome real.

Mas a fronteira nova **não é a do identificador, é a da forma do valor**, e ela é vazada por três caminhos
independentes, todos entregues nas superfícies que o próprio E2E do autor usa como veredito:

1. **C-1** — valor com 5+ palavras, pontuação final (`.` `!` `?` `;` `:`) ou mais de 64 caracteres:
   198.360/198.360 formas do corpus do autor reabrem (191.653 contra a 1.1.41; 31.256 contra a 1.1.42), com
   chave de API/JWT, senha com ponto e frase-senha entre os casos realistas, e também em `accessibleName`,
   `axValue` e `accessibleDescription`.
2. **C-2** — a pilha do trecho é fechada por nome de tag (um `<div>` de rótulo dentro do contêiner de
   credencial desarma o portão) e o sinal do modelo para na profundidade 8; as duas entregam **valor de 1
   palavra** em `guardado` + `artefato html/json`, selado na 1.1.42 e na 1.1.41.
3. **I-1** — a prova de precisão é artefato do texto de teste (sempre 4 palavras com ponto final): com texto
   de página curto, 99 palavras do dicionário e 20 de 25 ids PT perdem o texto, e
   `<div id="sessao">Avenida Paulista</div>` é destruído na 1.1.43 onde a 1.1.42 preservava.

O registro de achados resume a rodada como “0 reabertos nos corpora de 198.360 e 64.064” e “precisão com 0
texto destruído”: **as duas afirmações são verdadeiras apenas dentro da forma de valor/texto escolhida**, e
não sobrevivem à variação dessa dimensão. A declaração de resíduos, por outro lado, é honesta: os itens que o
autor nomeia (`pix-<família>`, radicais curtos, `name`/`aria-label`/`data-*`/irmãos, `codigo*`/`conta*`,
`api.key`, `private_key`, `chave·de·api`) continuam abertos exatamente como ele diz.

**Para reverter o veredito é suficiente**, no mínimo: (a) fazer o portão de forma **não ser a única**
autorização do par — manter o selo incondicional quando o identificador é do vocabulário fechado e usar a
forma apenas para decidir *entrega de prosa* no caminho da prosa, ou acrescentar ao selo os sinais de valor
que já existem (`hasCredentialValueSignal`, `isSensitiveValue`, comprimento/entropia); (b) contar a
profundidade na pilha (`{name, depth}`) e remover o teto de 8 do `ownTextSignal` (ou usar o mesmo
`descendantText` nos dois caminhos); (c) fixar em teste, por forma de valor, os dois sentidos — selado para
`<div id="senha">correct horse battery staple extra</div>`, `<div id="senha">Zqwkvbrtnmx9.</div>`,
`<div id="apikey">` com 68 caracteres e `<div id="apikey"><div>Chave</div>AKIA…</div>`, e preservado para
`<div id="sessao">Avenida Paulista</div>` e `<div id="chaveiro">R$ 47,90</div>`.
