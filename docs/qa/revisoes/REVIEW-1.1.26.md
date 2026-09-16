# Revisão adversarial independente — Audita Acessibilidade 1.1.26

- **Objeto:** `/private/tmp/audita-review-126` @ `46003ebb4485a825c828139d06f9c5be20c30b5d`, `git status --porcelain` vazio (0 linhas) antes e depois.
- **Delta:** `72c3919..46003eb` (16 arquivos, +171/−27).
- **Artefato:** `release/audita-acessibilidade-1.1.26.zip`.
- **Scratch:** `/private/tmp/adv126`. Nada foi escrito no checkout congelado.
- **Chrome:** `/private/tmp/audita-cft152-fixed/.../Google Chrome for Testing` (152.0.7977.64), um workload por vez, `TMPDIR` **padrão** (ver retratação R1).

---

## 1. Veredito

**A 1.1.26 NÃO deve substituir a 1.1.25 como candidata ainda. Há 1 bloqueante.**

| Severidade | Qtd | Item |
|---|---|---|
| **Critical** | 0 | — |
| **Important** | **1** | **O conserto do N2 introduziu uma regressão de privacidade**: o valor tarjado agora é limitado a 120 caracteres e termina em `;`, então **a cauda de valores longos vaza** — e vazava 0 na 1.1.25. Medido: JWT de 300 chars deixa **213 chars**; `senha:` de 160 chars deixa **40 chars**; `senha: p4ss;word-secreto` deixa **`;word-secreto`**. O mesmo texto na 1.1.25 deixava **0**. |
| Minor | 5 | M1 README cita o radical da 1.1.25 (recorrência do N4 no commit que fechou o N4); M2 o O3 nomeia "curto-circuito", que **não** é um dos seis (o sexto é `mandatory-journey-mv3`); M3 o trade-off declarado do `compass` **não é forçado** (`(?<!com)pass` exclui `compass` e mantém `myPass`/`userPass`/`newPassword`; `compass` não existe em lugar nenhum do produto); M4 a alegação "17 preservadas" é **16**; M5 a alegação "4.148 testes" é **4.193**. |
| Observação | 3 | O5 a varredura de rótulo sensível do artefato é **vacuamente verde** (0 oportunidades nos quatro formatos); O6 o radical nu `auth` do `SENSITIVE_KEY` casa toda a família `author*`/`authority*` (314 tokens do produto casam) — **pré-existente, fora do delta**; O7 a guarda "prefixo sem espaço" do N3 só conhece o espaço ASCII. |

**O bloqueante é uma linha.** Basta remover o teto de 120 do ramo não-aspiado (ou, mantendo o teto, falhar fechado e consumir a linha inteira quando o valor exceder o limite): `[^\n<;]{1,120}` → `[^\n<;]+`. Isso preserva o conserto do N2 (o valor inteiro é consumido, `cartão: 4111 1111 1111 1111` continua saindo `[redacted]`) e devolve o comportamento da 1.1.25 para valores longos. O `;` como terminador precisa da mesma decisão: hoje ele é um **ponto de vazamento dentro da credencial**, não uma fronteira.

**O que o delta acerta, e é o essencial:** contra a sua base imediata o delta é **estritamente monótono** — 24 grafias ganhas, **0 perdidas** (medido, 5.940 sondas). As oito grafias do N1 voltaram no JSON **e** na URL. O N3 está correto e mais largo que a alegação. A lição de método virou teste **não vacuoso** (provado por mutação). O artefato é reprodutível byte a byte. Sem o teto de 120, isto seria um veredito favorável.

---

## 2. Artefato

| Verificação | Comando | Medido |
|---|---|---|
| Digest entregue | `shasum -a 256 release/audita-acessibilidade-1.1.26.zip` | `5535fc8f976acc0b6207d64a0c24cab6e3a018f29654273de3c423b1df0382e3` — **igual ao esperado** |
| Entradas | `unzip -q … && find pkg -type f \| wc -l` | **199** arquivos, 27 diretórios — **reproduzido** |
| Manifesto interno | `pkg/manifest.json` | `manifest_version:3`, `version:1.1.26`, `version_name:1.1.26`, `minimum_chrome_version:116` |
| Pacote→árvore e árvore→pacote | `node cmp.mjs` (staging do `build-release.mjs`: `manifest.json` + `src/**` + `vendor/**` + 4 ícones) | `tree-staged: 199`, `pkg: 199`, `common: 199`; **ONLY IN TREE `[]`**; **ONLY IN PKG `[]`**; **CONTENT DIFFERS `[]`** — exato nos dois sentidos |
| Reconstrução | `node scripts/build-release.mjs --temporary-release-directory $TMPDIR/audita-release-test-abc123` + `cmp` | mesmo digest, **BYTE-IDENTICAL** |
| `release-package` + `extension-shell` + `release-assets` | `node --test test/release-package.test.js test/extension-shell.test.js test/release-assets.test.js` | **20 / 20**, 0 falham, 0 pulados — **reproduzido** |

Nota de método: o `build-release.mjs` exige que o diretório temporário esteja sob o `realpath(os.tmpdir())`; em macOS isso é `/var/folders/...`, não `/private/tmp`. A primeira tentativa falhou com `Diretório temporário de release inseguro.` — é a guarda do produto funcionando, não defeito.

---

## 3. Cada item declarado

### Item 1 — N1: as oito grafias voltaram, "nenhuma outra foi perdida" → **PARCIAL**

Comando: `node n1counts.mjs` (universo de **5.940** sondas: `pass` + separador `['',-',_',' ']` + até 2 chars de `[a-z0-9-_]`, mais as caudas enumeradas, mais grafias multi-idioma/leet/compostas), com as três gerações do radical extraídas por `git show`:

```
f6f09ec  (1.1.23, idêntico a 72c3919^ = 1.1.24)
72c3919  (1.1.25)
46003eb  (1.1.26)
```

| Medida | Número |
|---|---|
| Casadas pela 1.1.24 | **5.890** / 5.940 (indiscriminado) |
| Casadas pela 1.1.25 | 1.918 |
| Casadas pela 1.1.26 | **1.942** |
| **Perdidas vs 1.1.25** | **0** |
| **Ganhas vs 1.1.25** | **24** |
| Perdidas vs 1.1.24 | 3.955 — das quais **27 credencial-formes** |

- **As oito voltaram: REPRODUZIDO.** `sanitizeJsonData({motdepasse:'x'}).motdepasse === '[redacted]'` para as oito; e `sanitizeEvidenceUrl('https://exemplo.test/p?palavra-passe=S3GR3D0&id=7')` devolve `https://exemplo.test/p?id=7` — **o furo do N1 na URL está fechado**, testei as oito: `leak=NO` em todas.
- **"Nenhuma outra foi perdida" vs a base imediata: REPRODUZIDO** (0 perdidas, 24 ganhas → 1.1.26 ⊃ 1.1.25). Isto é o mais importante do item e está certo.
- **"Nenhuma outra foi perdida" vs a 1.1.24: REFUTADO no sentido literal.** Das 3.955 diferenças, 3.928 são a preservação intencional de palavra inocente (`passa`, `passar`, `passage`, `passport`, `passo`, `passim`, `compassion`, `passRate`, …) — perda desejada. Restam **27 formas credencial-shaped que a 1.1.24 tarjava e a 1.1.26 não tarja**: `passkod`, `passkode`, `passfrase`, `passsatz`, `passpasse` (e as variantes com `-` e `_`), mais os truncamentos `passc`, `passk`, `passp`, `passw`, `pass-c`, `pass-k`, `pass-p`, `pass-w`, `pass_c`, `pass_k`, `pass_p`, `pass_w`. `passkod`/`passkode` são "código de senha" em dinamarquês/norueguês e `passsatz`/`passfrase` são a forma alemã/composta de *passphrase* — são credenciais reais, não ruído. **Minor, não bloqueante** (nenhuma é alcançável pelo vocabulário do produto nem por página brasileira provável), mas a frase do comentário e do README é mais larga que a medição.
- **Falso positivo em chave inocente: nenhum novo neste delta.** Como 1.1.26 ⊃ 1.1.25, nada que a 1.1.25 preservava passou a ser tarjado. Ver M3 para o `compass`.

### Item 2 — N2: o valor é consumido por inteiro → **PARCIAL** (é o bloqueante)

**(a) nenhum dígito sobra: REPRODUZIDO.** `node n2.mjs`, 14 formas, todas com `digitos restantes: 0`:
`cartão: 4111 1111 1111 1111`, `CPF: 123.456.789-00`, `senha: S3G R3D0`, `senha: "S3G R3D0"`, `senha: 'S3G R3D0'`, `chave: ABC 123 DEF 456`, `pwd: 99887766`, `passcode: 4455 6677`, `passphrase: uma frase secreta longa`, `pass: 1234`, `auth: token-abc-123`, `token: aaa bbb ccc`, `cartão = …`, `senha:4111 …`. O conserto do achado de 12-dos-16-dígitos está feito.

**(b) prosa legítima não é engolida: PARCIAL.** Prosa sem rótulo fica intacta (`A sessão de perguntas discutiu o cartão de crédito…` → byte a byte igual). Mas uma linha legítima **com** rótulo e dois-pontos perde até 120 caracteres:

```
"Andamento: a chave: cada item da matriz tem um identificador estável e o texto seguinte…"
   -> "Andamento: a chave: [redacted]"                      (perdeu 87 chars)
"Resumo: pass: 109, fail: 9, alertas: 27 — contagem do motor próprio nesta página."
   -> "Resumo: pass: [redacted]"                            (perdeu 57 chars)
```
Na 1.1.25 isso consumia **um token**; agora consome a linha. O rótulo `pass` e o rótulo `auth` são **novos neste delta** (O2), então a superfície de perda de conteúdo cresceu aqui. **MEDIÇÃO**, não inferência; **INFERÊNCIA**: o artefato entregue não exerce esse caminho (0 oportunidades, ver O5), então não há dano observado na entrega desta versão.

**(c) o teto de 120 não deixa vazar o começo: REPRODUZIDO como enunciado — e é justamente por isso que o enunciado é insuficiente.** O começo (primeiros 120 caracteres) é tarjado. **A cauda vaza**, e é o que o enunciado não cobre:

| Entrada | 1.1.26: chars após `[redacted]` | 1.1.25: chars após `[redacted]` |
|---|---|---|
| `token: ` + JWT 300 chars | **213** | 0 |
| `api_key: ` + 200 `A` | **80** | 0 |
| `senha: ` + `S3g`×67 (201 chars) | **81** | 0 |
| `authorization: ` + 200 `Z` | **80** | 0 |
| `senha: p4ss;word-secreto` | **`;word-secreto`** | 0 |
| `senha: abc;def;ghi` | **`;def;ghi`** | 0 |

Confirmado **pelo sanitizador empacotado** (`node n2b.mjs`, `sanitizeJsonData` sobre payload no formato de evidência):
```
attributes['data-note'] = "senha: [redacted]S3gredo!S3gredo!S3gredo!S3gredo!S3gredo!"
  leaked chars after [redacted]: 40
  1.1.25 leak: 0 chars   (1.1.26 leak: 40)
```
Agrava: o **próprio teste novo do autor cristaliza o vazamento** — `assert.ok(saida.includes('FIM-DA-LINHA'))` sobre `'senha: ' + 'conteúdo longo '.repeat(20) + 'FIM-DA-LINHA'` é exatamente a asserção de que 180+ caracteres do valor **sobrevivem**. O "controle negativo" prova o defeito.

### Item 3 — N3: a deduplicação aceita qualquer espaço depois dos dois pontos → **REPRODUZIDO** (e mais largo que a alegação)

Comando: `node n3.mjs` contra `pkg/src/core/report/text-policy.js`.

- **10 separadores deduplicam**, não 4: `' '`, `'\t'`, `'\n'`, `'\u00a0'` **e também** `'\r'`, `'\r\n'`, `'\v'`, `'\f'`, `'\u2028'`, `'\u3000'`. Todos devolvem `["CODE:<sep>frase repetida."]` (1 entrada).
- **Sem separador continua fora**, como declarado: `listedLimitations(['CODE:frase colada.','frase colada.'])` → **2** entradas.
- **Nenhuma entrada legítima engolida** em 8 sondas: códigos diferentes com a mesma frase → 1 (correto); `'CODE  X: frase'` (código com espaço) → 2 (não deduplica); corpo com dois-pontos → preservado; rótulo acentuado → deduplica só o par certo; `['A: um','B: dois']` → 2.
- Entrada inválida continua falhando alto (`Limitações do relatório precisam ser lista.`).
- **Forma alcançável que escape: nenhuma.** O gerador emite o separador `': '` literal (`src/core/report/html.js:693` e `src/review/report-view.js:327`: `` `${entry.code}: ${entry.message}` ``), então a forma sem separador realmente não é produzida — a frase do teste está correta. A observação O7 fica registrada de graça.

### Item 4 — O2: o tarjador de valores conhece `pwd`, `passcode`, `passphrase`, `pass` e `auth` → **REPRODUZIDO**

Os cinco estão no padrão (`src/core/privacy.js:168`) e funcionam: `pwd: 99887766` → `pwd: [redacted]`; `passcode: 4455 6677` → `[redacted]`; `passphrase: uma frase secreta longa` → `[redacted]`; `pass: 1234` → `[redacted]`; `auth: token-abc-123` → `[redacted]`. Nota: `passphrase: ` + 200 chars passou de **não tarjado nenhum** (1.1.25 não conhecia o rótulo) para **120 tarjados + 120 vazados** — é uma melhora, mas entra no M-bloqueante.

### Item 5 — O3/O4: os seis E2E nomeados no README e a exigência de `scripts/` na trilha → **PARCIAL**

- **O4: REPRODUZIDO.** `docs/qa/2026-09-13-continuity-and-e2e-triage.md`, "Rodada 60": *"é preciso copiar `test/`, `fixtures/` e `scripts/`"* e *"Sem esse detalhe, o resultado seria '2 arquivos com falha' e uma acusação falsa ao produto"*. Confirmei o mecanismo por ausência: `scripts/axe-e2e-decision.mjs` não está no pacote (199 entradas = `manifest.json` + `src/` + `vendor/` + 4 ícones).
- **O3: PARCIAL — 5 dos 6 nomes.** O README (linha 16) passou a nomear *"curto-circuito, exportação da página atual, impressão executiva, layout de impressão, quebras de impressão e proveniência de versão"*. Os **seis de escopo** estão fixados na evidência do próprio repositório (`docs/qa/revisoes/REVIEW-1.1.22.md:230`): `mandatory-journey-mv3`, `current-page-export-mv3`, `report-executive-print`, `report-print-layout`, `report-print-breaks`, `report-version-provenance`. **O primeiro é `mandatory-journey-mv3` (percurso obrigatório), não "curto-circuito"** — não existe E2E de curto-circuito entre os seis (o candidato óbvio, `axe-mv3-csp.test.mjs`, está fora do conjunto). O conserto do O3, portanto, **omite o teste mais importante do conjunto** e nomeia um que não pertence a ele. Mesma classe do achado que o O3 queria fechar.

### Item 6 — a lição de método virou teste, três conjuntos → **REPRODUZIDO, com uma correção numérica**

`node --input-type=module -e "…"` extraindo os literais de `test/core/privacy.test.js`:

| Conjunto | Declarado | **Medido** |
|---|---|---|
| Tarjadas (`perdidas` 8 + `ganhasNoA2` 5 + `originais` 12) | 25 | **25** ✓ |
| Preservadas (`inocentes`) | 17 | **16** ✗ (`passed passes bypass passive passing passo passage passport bypasses passer passable passepartout passim contato pixelRatio cargo`) |
| "que a versão anterior já tarjava" (`perdidas`) | 8 | **8** ✓ |

**Não vacuidade do conjunto de regressão — CONFIRMADO por mutação.** Copiei a árvore para `/private/tmp/adv126/mut`, troquei `SENSITIVE_KEY` pela regex **exata da 1.1.25** e rodei `node --test test/core/privacy.test.js`:

```
✖ o radical de senha não pode PERDER grafias que a versão anterior tarjava (achado N1 da 1.1.25)
    AssertionError: motdepasse precisa ser tarjado
ℹ tests 17   ℹ pass 16   ℹ fail 1
```

Ou seja: o teste **falha** se uma delas voltar a escapar. O conjunto é real, não decorativo. As 25 asserções de tarjamento e as 16 de preservação são todas `assert.equal`/`assert.notEqual` por item dentro do laço — nenhuma é vacuosa. `compass` **não** está na lista de preservadas (é o FP declarado), coerente com o comentário.

### Item 7 — Portões declarados → **PARCIAL** (três alegações numéricas caem)

| Alegação | Comando | Medido | Veredito |
|---|---|---|---|
| Paralela **4.148** testes (4.147 passam, 1 pulado, 0 falham) | `node --test $(cat parallel-list.txt)` (179 arquivos do plano paralelo, 0 Chrome) | **tests 4193, pass 4192, fail 0, cancelled 0, skipped 1**, 40,9 s | **REFUTADO no número** — 4.193, não 4.148 (+45). A *forma* está certa (0 falham, 1 pulado) |
| `release-package` + `extension-shell` + `release-assets` 20/20 com digest fixado | `node --test` dos três | **20/20**, 0 falham | **REPRODUZIDO** |
| **16 testes de E2E de Chrome em sete arquivos** nos bytes empacotados | `node --test --test-concurrency=1` em `pkgbytes` para `url-pixel-consent-mv3` (10) + `mandatory-journey-mv3` + `current-page-export-mv3` + `report-executive-print` + `report-print-layout` + `report-print-breaks` + `report-version-provenance` (1 cada) | **tests 16, pass 16, fail 0, skipped 0**, exit 0 | **REPRODUZIDO exatamente** (`url-pixel-consent` sozinho: 10/10) |
| Auditoria real do Google declarando 1.1.26 (0 falhas, 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, quatro exportações) | não refiz o percurso ao vivo (ver §6); conferi os **artefatos entregues** em `/private/tmp/g126/artifacts-pkg/` | **28,5%** de cobertura no HTML e no PDF ✓; **146 assertions** no JSON ✓; **18 páginas** no PDF ✓; `1.1.26` presente em HTML, JSON e PDF ✓ | **PARCIAL** — as marcas que dependem de percurso ao vivo não foram refeitas por mim; as que estão nos bytes entregues batem |
| Notas 5/5 no PDF e no HTML, proveniência nos dois, 146/146 ids e títulos, 0 palavras partidas | `report-print-breaks` (E2E, verde) emite `matriz=0 quebras, cabeçalhos=0`; `assertions: 146` | **0 palavras partidas reproduzido**; **146 reproduzido**; "5/5" não aparece como literal nos formatos (a redação exata da alegação não foi identificada por mim) | **PARCIAL** |
| Nenhum rótulo sensível com valor não tarjado nos quatro formatos | `node scan2.mjs` — 38 rótulos (união do regex do produto + os 3 conjuntos do teste + `access_token`/`client_secret`/…), 4 formatos (PDF via `pypdf`) | **0 rótulos-com-valor em todos os quatro**; 0 tarjados; 0 não tarjados | **REPRODUZIDO mas VACUOSO** — ver O5 |

---

## 4. Achados novos

### A1 — Important, **bloqueante**: o teto de 120 caracteres e o terminador `;` vazam a cauda do valor
**Medição** (tabela do item 2c): 213 / 80 / 81 / 80 / `;word-secreto` / `;def;ghi` caracteres sobrevivem onde a 1.1.25 deixava 0, confirmado através do `sanitizeJsonData` empacotado. **Medição**: o teste do próprio delta (`assert.ok(saida.includes('FIM-DA-LINHA'))`) afirma que a cauda sobrevive. **Inferência**: qualquer página auditada cujo texto visível, trecho ou valor de atributo traga `token:`/`senha:`/`authorization:` seguido de um valor não-aspiado com mais de 120 caracteres ou contendo `;` (JWT com claims, chave de API, passphrase longa, `Set-Cookie`) entrega esses caracteres no relatório. **Não é o desenho do N2 que está errado — é o teto.** Consumir o valor inteiro era o pedido; o teto é que transforma "consumir" em "consumir 120 e deixar o resto".

### A2 — Minor: recorrência do N4 no commit que fechou o N4
`README.md`, seção "O radical de senha engolia dado do próprio produto", passou a citar como vigente
`pass[-_ ]?(?:word|wd|code|phrase|key)|(?<!by)pass(?![-_a-z])|pwd` — que é o radical da **1.1.25**. O código deste mesmo commit é `…(?:word|wd|wrd|w0rd|wort|code|phrase|key)|(?<!by)pass(?!ed|es|ive|ing|o|age|port|[-_a-z])|palavra[-_ ]?passe|frase[-_ ]?passe|mot[-_ ]?de[-_ ]?passe|pwd`. O achado N4 ("documentação citando radical obsoleto") reaparece, agora com um incremento de defasagem. **Medição**: `git diff 72c3919..46003eb -- README.md` + leitura da linha.

### A3 — Minor: o O3 nomeia um teste que não está no conjunto
Ver item 5. **Medição**: `README.md:16` contra `docs/qa/revisoes/REVIEW-1.1.22.md:230`. **Inferência**: o leitor que usar o README como índice para reproduzir o portão roda o conjunto errado e não roda o percurso obrigatório.

### A4 — Minor: o trade-off declarado do `compass` não é forçado
O comentário afirma que excluir `compass` "exigiria abrir mão de `myPass`/`userPass`". **Medição** (`node n1b.mjs`): o radical com um lookbehind a mais, `(?<!by)(?<!com)pass(?!…)`, dá `compass=0` (não tarjado) e **mantém** `myPass=1`, `userPass=1`, `newPassword=1` tarjados. Excluir `compass` custa **zero**. Além disso, **`compass` não aparece em lugar nenhum do produto** — `grep -rn compass src/ test/ fixtures/` devolve só a própria linha do comentário em `src/core/privacy.js:10`, então o FP é hoje puramente teórico. O FP declarado é honesto; a justificativa de que ele é inevitável é que não se sustenta.

### A5 — Minor: contagens de alegação
"17 preservadas" → **16** (item 6); "4.148 testes" → **4.193** (item 7). Nenhum efeito de produto; ambos são números medidos num relatório cuja única saída é a medição.

### A6 — Observação: a varredura de rótulo sensível do artefato é vacuamente verde
`node scan2.mjs` sobre os quatro formatos entregues (o `google-pkg126.mjs` do autor **não contém varredura de rótulo nenhum** — ele só extrai strings de versão/contagem; a varredura foi feita à parte e não ficou salva):
```
html  labels-with-value: 0   redacted: 0   NOT redacted: 0   (23 ocorrências cruas de algum rótulo)
json  labels-with-value: 0   redacted: 0   NOT redacted: 0   ( 7)
csv   labels-with-value: 0   redacted: 0   NOT redacted: 0   ( 2)
pdf   labels-with-value: 0   redacted: 0   NOT redacted: 0   ( 2)
```
**Zero oportunidades.** A homepage do Google não fornece nenhum par rótulo/valor sensível, então **qualquer** definição de "rótulo sensível" — inclusive uma lista vazia, inclusive uma que omita as oito grafias do N1 — devolveria verde neste artefato. O verde é verdadeiro e não carrega informação sobre a adequação da lista. Um teste com poder discriminante precisa de pelo menos uma credencial plantada; e está medido (A1) que, plantada uma, o código atual fica vermelho. *Isto responde diretamente à pergunta do autor: a definição está sendo generosa com ele.*
Nota de honestidade: a única marca de "16 dígitos" que minha varredura de forma encontrou (`6923076923076925`, 2×) é **falso positivo da minha varredura** — é `stroke-dasharray="7.6923076923076925 92.30769…"` no CSS do relatório. As 376 marcas de 64-hex no CSV são os hashes de evidência do próprio produto.

### A7 — Observação, **pré-existente e fora do delta**: o `auth` nu casa a família `author*`
`SENSITIVE_KEY` usa `auth(?:orization)?` sem fronteira, então `author`, `authority`, `authorized`, `authoritative`, `authorize*` casam. **Medição**: varrendo 14.749 tokens de `pkg/src/`, **314** casam o radical, e a lista inclui `authorityExpiresAt`, `authorizedAt`, `firstAuthorization`, `finalAuthorization`, `authorizationAt`, `author`, `authority`, `authorizeReport`… **Inferência (alcance não provado)**: `sanitizeJsonData` só tem 3 chamadas em `src/` (`normalize-probes.js:470`, `normalize-snapshot.js:477` e `:894`, todas sobre `coverage`/`actions`), e não consegui provar que um payload real chegue ali com uma chave `authority*`; se chegar, o campo é substituído por `[redacted]` e **some do relatório**. É a mesma classe do `compass`, é anterior a este delta (a 1.1.24 já tinha `auth(?:orization)?`) e **não** conta contra a 1.1.26 — fica registrado porque ninguém o declarou.

### A8 — Observação: a guarda "prefixo sem espaço" do N3 só conhece o espaço ASCII
`text-policy.js`, `if (rest.slice(0, separator).includes(' ')) break;` — um rótulo com tab antes dos dois pontos (`"CODE\tX: frase"`) passaria como código. **Medição**: reproduzido em leitura; **inferência**: inalcançável, o gerador emite `': '` e os códigos são identificadores sem espaço/tab.

---

## 5. Retratações

- **R1.** Minha primeira execução de `test/e2e/axe-mv3-csp.test.mjs` falhou (`cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]`) e eu ia registrar isso como causa **diferente** da documentada. Era **erro meu**: eu havia exportado `TMPDIR=/private/tmp/adv126/tmp`; a limpeza do perfil limitado depende do `TMPDIR` padrão. Repetido com `unset TMPDIR`: **1/1 passa**. Não há defeito de produto, e a causa documentada (O4) continua sendo a única que observei.
- **R2.** Cheguei a levantar que "16 testes em sete arquivos" não reproduzia, porque minha primeira montagem de sete arquivos deu `tests 7`. Minha montagem estava errada: `batch-pixel-consent-mv3` tem **1** `test(` declarado, e os 16 vêm de `url-pixel-consent-mv3` (**10**) + os seis de escopo (**6**). Com o conjunto certo: **16/16**. **A alegação do autor está correta e eu a tinha subestimado.**
- **R3.** O `passa`/`passar`/`passage` que apareceram como "perdidos vs 1.1.24" na minha primeira varredura **não** são regressões: são exatamente o vocabulário inocente que o produto decidiu preservar desde a 1.1.23. Só contam como perda as 27 formas credencial-shaped do item 1.
- **R4.** Não tratei como novidade nada da lista de "já conhecido": a fase serial (34/35, falhas em `sidepanel-flow-mv3`), o item 6 do oráculo de largura (PARCIAL por desenho), o A6 de `annotation-map.test.js:632`, o O1 (V6), o critério 8 e o trade-off do V6.

---

## 6. O que eu não medi / risco residual

1. **Auditoria real ao vivo do Google nos bytes empacotados da 1.1.26.** Não refiz o percurso (0 falhas, 9 positivos, 109 no checklist, 9,0/10, quatro exportações). Conferi os **bytes entregues** deixados em `/private/tmp/g126/artifacts-pkg/`: cobertura **28,5%**, **146 assertions**, **18 páginas**, `1.1.26` em HTML/JSON/PDF. Se aqueles artefatos não forem da 1.1.26, esta parte do portão cai — a versão aparece neles, mas eu não os vi nascer.
2. **A fase serial completa (35 arquivos de Chrome real).** Não rodei; a linha já a rodou (34/35) e o brief manda não tratar como novidade. Rodei **7 arquivos / 16 testes** do escopo + `url-pixel-consent` isolado, todos verdes, e `axe-mv3-csp` isolado (1/1). **`sidepanel-flow-mv3` não foi executado por mim.**
3. **Alcance real de A1 numa página viva.** Provei o vazamento no sanitizador empacotado com payload no formato de evidência, não num percurso de Chrome ponta a ponta com uma página que exiba `token: <JWT longo>`. É a medição que falta para graduar A1 entre Important e Critical. **Recomendo fazê-la antes de decidir o veredito.**
4. **Alcance real de A7** (`authority*` chegando a `sanitizeJsonData`) — não provado, declarado como inferência.
5. **As métricas históricas de 1.1.16–1.1.22** e o conteúdo de `store-assets/` (fora do delta; o delta toca `STORE-LISTING.md` e `TEST-INSTRUCTIONS.md` só na versão).
6. **"5/5" nos formatos**: não localizei a redação exata da alegação; não a confirmei nem a refutei.
7. **Isolamento do ambiente:** todo E2E rodou com **um** workload de Chrome por vez, `--password-store=basic`, `--use-mock-keychain`, perfil temporário, `TMPDIR` padrão. O checkout congelado terminou com `git status --porcelain` **vazio** e `HEAD` ainda `46003eb`.

**Risco residual que sobra depois do bloqueante:** o teto de 120 é uma escolha de compensação (não engolir prosa) que na prática escolheu **vazar** em vez de **engolir**. As duas alternativas honestas são consumir a linha inteira (engolir mais, vazar zero) ou reduzir o escopo do rótulo. O que não se sustenta é um limite que deixa resíduo do próprio valor tarjado — ele cria a única falha desta versão num produto cuja promessa central é não deixar resíduo.
