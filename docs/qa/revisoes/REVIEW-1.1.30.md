# Revisão adversarial independente — Audita Acessibilidade 1.1.30

- **Checkout congelado:** `/private/tmp/audita-review-130`, `HEAD 3c571f41f6325da2a6a4feab961714692dc95293`
  (não editado; §13). `git status --porcelain` **vazio** (o brief esperava `?? release/…zip`; o zip está
  **rastreado no próprio commit** — ver §2, O1).
- **Artefato medido:** `release/audita-acessibilidade-1.1.30.zip`,
  SHA-256 `0c690ba3a18f8e528729537bfaf79fa5aa3fc82c0aa7377c869208c14d4f6ae2` (**= o esperado**), 199 entradas,
  4.278.629 bytes descompactados.
- **Produto medido a partir dos bytes empacotados:** extraído em `/private/tmp/adv130/pkg` (pristino) e
  `/private/tmp/adv130/work` (com `test/`, `fixtures/` e `scripts/` copiados para dentro). Gerações
  anteriores: `pkg129` (zip da 1.1.29), `work129`, `work-mutant` (1.1.30 com `privacy.js`,
  `evidence/snippet.js` e `accessibility/accessible-name.js` de `ab615d5`), `clone` (clone do checkout
  congelado em `3c571f4`, para os gates), `rebuild` (pacote extraído + `scripts/`, para a reconstrução).
- **Chrome:** Chrome for Testing 152.0.7977.64 em `/private/tmp/audita-cft152-fixed` (perfil temporário
  isolado, **um Chrome por vez**). Nada foi publicado; a única navegação externa foi a auditoria de
  `https://www.google.com/` que os números declarados exigem (leitura, perfil descartável).
- **Instrumentos próprios (nenhum caso do autor):** `harness/matrix.mjs` (305 formas × 4 caminhos),
  `harness/cost.mjs` (páginas realistas), `harness/idem.mjs` (idempotência),
  `harness/adv130-page.mjs` + `harness/adv130-sentinel-mv3.test.mjs` (63 formas com sentinela própria,
  ordem verificada por monotonicidade **antes** de rodar Chrome), `harness/frozen-audit-mv3.test.mjs`
  (A/B na mesma página), `harness/google-adv130.mjs`, `serial130.sh`, `harness/artcheck130.py`.
  Artefatos e logs em `/private/tmp/adv130/{artifacts,google-artifacts,frozen-artifacts,logs}`.

---

## 1. Veredito

**A 1.1.30 NÃO substitui a 1.1.29/1.1.28 como candidata aprovada — e deve substituí-las como linha de base
de trabalho.** O mecanismo mudou de verdade (a decisão agora é por conteúdo, antes de emitir, e não há
mais espera para consumir), e isso fechou **17 formas** que a 1.1.29 entregava; mas a classe do C1
continua aberta nos bytes empacotados — **24 formas** medidas ponta a ponta, **78 pares forma×superfície**
— e o incremento **perdeu proteção que a 1.1.29 tinha** em 4 formas (regressão), porque a regra de cauda
foi estreitada.

| | Contagem |
|---|---|
| **Critical** | **1** — a classe do C1 continua aberta: 24 formas, **78 pares forma×superfície** (15 formas em 4 superfícies, 9 em 2; inclui um número de cartão de crédito inteiro em 4 superfícies) |
| **Important** | **3** — (I1) a regra de cauda foi enfraquecida e 4 formas que a 1.1.29 tarjava passaram a vazar; (I2) "sufixo de rótulo separado por espaço" só vale para ASCII, e é o mecanismo do C1; (I3) o sinal acende em prosa legítima e apaga o resto do trecho |
| **Minor** | **5** |
| **Observações** | **5** |

O que a 1.1.30 de fato fez, medido por mim nos bytes empacotados:

- **o mecanismo é outro, não um remendo:** não existe mais `pendingValueRedaction`/`pendingValueTail`; o
  `emitText` calcula o acumulado decodificado **antes** de escolher a saída (`snippet.js:214-243`).
  Medido: `<p>senha<!-- nota -->: ADV130C05CMT</p>` → `<p>senha[redacted]</p>` (a 1.1.29 entregava o
  valor), `<p>senha: <img alt="i">X</p>`, `<span></span>`, `<svg></svg>`, `<th>senha:</th><td></td><td>X</td>`,
  `<wbr>` e o `<![CDATA[…]]>` (que o navegador serializa como comentário) — **todos fechados**;
- **as 31 formas de controle da minha página foram tarjadas** (nenhuma sobreviveu), incluindo as 15 do C1
  da 1.1.29: a página não é vácuo e o mecanismo está ligado;
- **`{"code"}` e `{"assertion"}` em JSON de página fecharam** (a 1.1.29 entregava os dois; a O1 da revisão
  anterior está resolvida) — medido no sanitizador empacotado;
- **as chaves de URL percent-encoded do tarjador de texto fecharam** (`?code=`, `?co%64e=`, `?%43ODE=`);
- **custo zero na página declarada, confirmado com A/B na MESMA página:** auditando o DOM congelado do
  Google (mesmos bytes) as duas gerações entregam **11 snippets, 50.739 caracteres, 0 `[redacted]`**, e os
  conjuntos de snippets são idênticos exceto pelo **porta efêmera** do servidor de fixture — a afirmação
  "snippets idênticos" se sustenta;
- **todos os números de suíte, gates e integridade conferem** (§8): 4.160/4.159/1 pulado/0 falham; gate
  20/20 com o digest fixado; fase serial 34/35 com o único vermelho reprodutível em `sidepanel-flow-mv3`;
  digest, 199 entradas, pacote↔árvore idênticos e reconstrução reproduzindo o digest byte a byte.

O que impede a substituição é que a **decisão por conteúdo é construída sobre um vocabulário que não
aceita palavra acentuada**: `VALUE_LABEL_SOURCE` (`privacy.js:76`) tem `(?:[\s]+[A-Za-z0-9]{1,24}){0,2}`,
então `Senha atual:` e `Chave da API:` acendem o sinal, mas `Cartão de crédito:`,
`senha do usuário:`, `Chave de segurança:`, `Senha provisória:` e `Palavra-passe do usuário:`
**não acendem** — e o valor inteiro segue para relatório, modelo/revisão, artefato HTML e artefato JSON.
Um número de cartão de crédito completo (4 superfícies) está entre eles. E a mesma troca de mecanismo
**estreitou** `VALUE_LIKE_TAIL_SOURCE` (`privacy.js:57`): a alternativa `\S{12,}` e a classe
`[^\p{L}\s]` da 1.1.29 sumiram, então `placeholder="senha ZQXJKVBWPMTLRNHSPH"` e
`placeholder="senha Segredo!Gama"` — tarjados na 1.1.29 — agora chegam ao modelo e ao JSON.

---

## 2. Integridade do artefato (item 6) — tudo reproduzido

```
$ shasum -a 256 release/audita-acessibilidade-1.1.30.zip
0c690ba3a18f8e528729537bfaf79fa5aa3fc82c0aa7377c869208c14d4f6ae2   (= esperado)

$ unzip -l release/audita-acessibilidade-1.1.30.zip | tail -2
  4278629                     199 files

$ python3 (sha256 por entrada, dois sentidos, contra a árvore congelada)
entradas no zip: 199
so no zip: []
conteudo diferente: []
so na arvore: ['.git', 'README.md', 'assets/icons/icon-1024.png', 'design-qa.md', 'docs/…', 'fixtures/…',
               'package.json', 'release/…zip', 'scripts/…', 'store-assets/…', 'test/…']   (documentação,
               testes e ferramentas: nenhum arquivo de runtime)
pkg extraido: entradas 199  identico ao zip: True

$ git -C /private/tmp/audita-review-130 ls-files --error-unmatch release/audita-acessibilidade-1.1.30.zip
release/audita-acessibilidade-1.1.30.zip                       # RASTREADO
$ git cat-file -e 3c571f4:release/audita-acessibilidade-1.1.30.zip && echo SIM
SIM, rastreado no commit 3c571f4   (1060718 bytes)

$ cd rebuild && node scripts/build-release.mjs --temporary-release-directory $TMPDIR/audita-release-test-Ad130x
audita-acessibilidade-1.1.30.zip
SHA-256 0c690ba3a18f8e528729537bfaf79fa5aa3fc82c0aa7377c869208c14d4f6ae2   (= o entregue)
$ cmp "$TMPDIR/audita-release-test-Ad130x/audita-acessibilidade-1.1.30.zip" \
      /private/tmp/audita-review-130/release/audita-acessibilidade-1.1.30.zip
BYTE A BYTE IDENTICO
```

Os 199 arquivos de runtime são byte a byte os da árvore congelada; a árvore tem 200+ arquivos que não
entram no pacote (documentação, testes, `scripts/`, `store-assets/`, os zips anteriores) e **nenhuma**
diferença de conteúdo nos 199. O gate `release-package` confirma o mesmo por dentro:
`pacote conferido byte a byte: 199 arquivos idênticos à árvore revisada`.

**O1 (observação):** o brief esperava `?? release/audita-acessibilidade-1.1.30.zip` em
`git status --porcelain`. A árvore está **limpa** e o zip está **rastreado no commit** — é o estado
desejável (a reconstrução reproduz o digest), não um desvio. Mesma nota O4 da revisão da 1.1.29.

---

## 3. C1 (Critical) — a classe continua aberta: 24 formas, 78 pares forma×superfície

### 3.1 Medição ponta a ponta (bytes empacotados, Chrome real)

Página de sentinelas própria (`test/e2e/adv130-sentinel-mv3.test.mjs` + `adv130-page.mjs`), 63 formas com
sentinela distinta por forma, **ordem verificada antes de rodar Chrome** (as formas que não acendem o
sinal vêm primeiro, a prosa depois, os controles por último), varredura sobre as superfícies entregues
reais. Mesma página rodada nos bytes empacotados da 1.1.29 para atribuir geração:

```
$ AUDITA_E2E_CHROME="…/Google Chrome for Testing" ADV_TAG=130d \
  node --test --test-concurrency=1 test/e2e/adv130-sentinel-mv3.test.mjs
✔ sentinelas adv130 nas superficies entregues
formas=63  na pagina fonte=62  vazando 1.1.30=24   1.1.29=37
pares forma×superficie:  1.1.30=78   1.1.29=130
```

| forma (sentinela) | 1.1.30 | 1.1.29 | geração |
|---|---|---|---|
| `f01` `<p>Cartão de crédito: 4111 2222 3333 4444</p>` | relatório, modelo/revisão, html, json | idem | **pré-existente** |
| `f02` `<p>senha do usuário: ADV130F02PWX</p>` | 4 superfícies | idem | pré-existente |
| `f03` `<p>Chave de segurança: ADV130F03CHV</p>` | 4 | idem | pré-existente |
| `f04` `<p>Senha provisória: ADV130F04PRV</p>` | 4 | idem | pré-existente |
| `f05` `<p>Palavra-passe do usuário: ADV130F05PPP</p>` | 4 | idem | pré-existente |
| `f06` `<p>cartão de crédito ADV130F06TAIL</p>` | 4 | idem | pré-existente |
| `f10` `<p>senha - ADV130F10DASH</p>` | 4 | idem | pré-existente |
| `f11` `<a href="/current#/authorize/co%64e=ADV130F11ROUTE">` | 4 | idem | pré-existente |
| `f12` `<a href="/current?code%3DADV130F12SEP">` | 4 | idem | pré-existente |
| `f13` `<a href="/current?%2563ode=ADV130F13DBL">` | 4 | idem | pré-existente |
| `f14` `<p>senha%3a ADV130F14PCT</p>` | 4 | idem | pré-existente |
| `f15` `<p>Número do cartão de crédito: 4111 8888 9999 0000</p>` | 4 | idem | pré-existente |
| `f16` `<th>Cartão de crédito:</th><td>4111 5555 6666 7777</td>` | 4 | idem | pré-existente |
| `f17` `<p>Dados do cartão de crédito ADV130F17CARD</p>` | 4 | idem | pré-existente |
| `a01` `<input title="senha ZQXJKVBWPMTLRNHS">` | 4 | 4 | pré-existente |
| `a05` `<input title="senha do usuário: ADV130A05ACNT">` | modelo, json | idem | pré-existente |
| `a13` `<input title="senha Segredo!Alfa">` | modelo, json | idem | pré-existente |
| `a14` `<input title="chave Segredo.Beta">` | modelo, json | idem | pré-existente |
| `a15` `<input title="senha correcthorsebattery">` | modelo, json | idem | pré-existente |
| `a18` `<input title="senha Segredo?Epsilon">` | modelo, json | idem | pré-existente |
| **`a06`** `<input placeholder="senha ZQXJKVBWPMTLRNHSPH">` | **modelo, json** | **0** | **REGRESSÃO** |
| **`a07`** `<input aria-label="senha ZQXJKVBWPMTLRNHSAL">` | **modelo, json** | **0** | **REGRESSÃO** |
| **`a12`** `<img alt="token ZQXJKVBWPMTLRNHSALT">` | **modelo, json** | **0** | **REGRESSÃO** |
| **`a16`** `<input placeholder="senha Segredo!Gama">` | **modelo, json** | **0** | **REGRESSÃO** |

Fechados nesta mesma página (vazavam na 1.1.29, limpos na 1.1.30): `c02` `&nbsp;`, `c04` `<b>senha</b>:`,
`c05` comentário, `c06` `<img>`, `c07` `<span></span>`, `c10` `?co%64e=`, `c13` `title`, `c15` `token …`,
`c16` `<th>/<td>` vazio, `c18` `Chave da API:`, `c23` `\u003a`, `c24` `<wbr>`, `c28` prosa de sessão,
`c29` CDATA, `a02`/`a03`/`a04` (title com cauda com dígito). **Todos os 31 controles foram tarjados nas
duas gerações do meu percurso.**

Superfícies: `painel`, `csv`, `armazenamento durável` e **PDF** não carregaram nenhum sentinela nas duas
gerações (`pypdf`, 27 páginas, 0/63). As superfícies da classe são **relatório, modelo/revisão guardados,
artefato HTML e artefato JSON**.

### 3.2 Saída crua do que ficou gravado (artefato JSON entregue, 1.1.30)

```
$ python3 (walk no JSON entregue)   # campo snippet da evidência full-page
/audit/evidence[24]/snippet =
 "<main><h1>Página de sentinelas adv130</h1> <p id=\"adv130-f01\">Cartão de crédito: 4111 2222 3333 4444</p>
  <p id=\"adv130-f02\">senha do usuário: ADV130F02PWX</p> <p id=\"adv130-f03\">Chave de segurança: ADV130F03CHV</p>
  <p id=\"adv130-f04\">Senha provisória: ADV130F04PRV</p> <p id=\"adv130-f05\">Palavra-passe do usuário: ADV130F05PPP</p>
  <p id=\"adv130-f06\">cartão de crédito ADV130F06TAIL</p> …"
/audit/evidence[24]/accessibility/visibleText = "Página de sentinelas adv130 Cartão de crédito: 4111 2222 3333 4444
  senha do usuário: ADV130F02PWX Chave de segurança: ADV130F03CHV Senha provisória: ADV130F04PRV
  Palavra-passe do usuário: ADV130F05PPP cartão de crédito ADV130F06TAIL …"

# relatório (HTML da aba de revisão), mesmo conteúdo escapado:
"&lt;p id=\"adv130-f01\"&gt;Cartão de crédito: 4111 2222 3333 4444&lt;/p&gt; &lt;p id=\"adv130-f02\"&gt;senha do usuário:
 ADV130F02PWX&lt;/p&gt; &lt;p id=\"adv130-f03\"&gt;Chave de segurança: ADV130F03CHV&lt;…"

# artefato HTML entregue:
Cartão de crédito: 4111 2222 3333 4444
senha do usuário: ADV130F02PWX
```

### 3.3 Causa no código empacotado

`src/core/privacy.js:76` — `VALUE_LABEL_SOURCE` aceita sufixo de até dois tokens **ASCII**:

```
(?:…|${SENSITIVE_WORD_SOURCE})[A-Za-z0-9]{0,24}(?:[\s]+[A-Za-z0-9]{1,24}){0,2}
```

Medido (só o sanitizador empacotado, sem browser):

```
$ node --input-type=module -e "import('/…/pkg/src/core/privacy.js').then(P=>…)"
hasCredentialValueSignal('Cartão de crédito: 4111 2222 3333 4444')   -> false
hasCredentialValueSignal('senha do usuário: p4ssw0rdX')              -> false
hasCredentialValueSignal('Chave de segurança: 99887766')             -> false
hasCredentialValueSignal('Senha provisória: p4ssw0rdX')              -> false
hasCredentialValueSignal('Palavra-passe do usuário: p4ssw0rdX')      -> false
hasCredentialValueSignal('Número do cartão: 4111 1111 1111 1111')    -> true    (ASCII)
hasCredentialValueSignal('Chave da API: sk-abc123')                  -> true    (ASCII)
hasCredentialValueSignal('cartão 4111 1111 1111 1111')               -> true    (cauda com dígito)
sanitizeHtmlSnippetSource('<p>Cartão de crédito: 4111 2222 3333 4444</p>')
  -> '<p>Cartão de crédito: 4111 2222 3333 4444</p>'      (1.1.29: idêntico)
sanitizeHtmlSnippetSource('<p>senha do usuário: p4ssw0rdX</p>')
  -> '<p>senha do usuário: p4ssw0rdX</p>'                 (1.1.29: idêntico)
```

O `[A-Za-z0-9]{1,24}` de cada token de sufixo para na primeira letra acentuada (`usuário` → `usu`,
`segurança` → `seguran`, `crédito` → `cr`), o separador então não está onde o motor procura, e **o sinal
nunca acende**. Não é regressão: a 1.1.29 também entregava. É a mesma classe do C1 das revisões da
1.1.27/1.1.28/1.1.29, com a forma mais natural do português (e um cartão de crédito inteiro).

---

## 4. Important

### I1 (Important) — a regra de cauda foi **enfraquecida**: 4 formas que a 1.1.29 tarjava passaram a vazar

`src/core/privacy.js:57` trocou:

```
1.1.29: const VALUE_LIKE_TAIL_SOURCE = \S*(?:\d|[^\p{L}\s]|\S{12,})\S*
1.1.30: const VALUE_LIKE_TAIL_SOURCE = \S*(?:\d|(?=[^\s]*[\p{L}\p{N}])[-_=@/+*#$%&|~^<>])\S*
```

Saíram a alternativa de **comprimento** (`\S{12,}`) e a classe **qualquer não-letra** (`[^\p{L}\s]`);
entrou uma lista fechada de símbolos fortes que não inclui `!`, `.`, `?`, `,`, `:`, `;`, `(`, `)`, `%`…

Medição direta (`redactCredentialLabelTail`, exportado pelo pacote):

```
$ node --input-type=module -e "…redactCredentialLabelTail(…)"
'chave ZQXJKVBWPMTLRNHS'     1.1.29 -> 'chave [redacted]'       1.1.30 -> 'chave ZQXJKVBWPMTLRNHS'
'senha ZQXJKVBWPMTLRNHS'     1.1.29 -> 'senha [redacted]'       1.1.30 -> 'senha ZQXJKVBWPMTLRNHS'
'senha AbCdEfGhIjKlMnOpQrSt' 1.1.29 -> 'senha [redacted]'       1.1.30 -> 'senha AbCdEfGhIjKlMnOpQrSt'
'senha Segredo!Forte'        1.1.29 -> 'senha [redacted]'       1.1.30 -> 'senha Segredo!Forte'
'senha Segredo.Forte'        1.1.29 -> 'senha [redacted]'       1.1.30 -> 'senha Segredo.Forte'
'senha 5f4dcc3b5aa765d61d8327deb882cf99'  1.1.29 -> 'senha [redacted]'   1.1.30 -> 'senha [redacted]'  (tem dígito)
```

Entregue (mesma página, bytes empacotados) — o campo `accessibility.name` do modelo/revisão e o artefato
JSON, que na 1.1.29 estavam limpos:

```
1.1.30  /audit/evidence[9]/accessibility/name  = "senha ZQXJKVBWPMTLRNHSPH"          (a06, placeholder)
1.1.30  /audit/evidence[9]/accessibility/announcementPreview = "senha ZQXJKVBWPMTLRNHSPH, campo de texto"
1.1.30  /audit/evidence[13]/accessibility/name = "senha Segredo!Gama"                (a16, placeholder)
1.1.30  /audit/evidence[20]/accessibility/name = "token ZQXJKVBWPMTLRNHSALT"         (a12, alt)
1.1.30  /audit/evidence[?]/accessibility/name  = "senha ZQXJKVBWPMTLRNHSAL"          (a07, aria-label)
1.1.29  os quatro: 0 campos com o sentinela em todo o modelo
```

**É regressão** (limpo na 1.1.29, vaza na 1.1.30), em `modelo/revisão` e `artefato json`. A causa é a
mesma regra que sustenta o conserto do (f) — `computeAccessibleText` aplica
`redactCredentialLabelTail` na saída (`accessible-name.js:234-237`) — e por isso o estreitamento atinge
todos os chamadores (nome acessível, `projectAccessibleText` do normalizador e o caminho JSON com
marcação). Uma senha só de letras com 12+ caracteres (`correcthorsebattery`) ou com `!`/`.`/`?` é uma
senha real; a 1.1.29 a tarjava, a 1.1.30 não.

### I2 (Important) — a afirmação "(c) sufixo de rótulo separado por espaço" só vale para ASCII

Falsificada na forma exata que o incremento descreve ("rótulo com sufixo colado ou separado por espaço").
Medido: `Senha atual:` (fechado), `Chave da API:` (fechado), `Chave de acesso:` (fechado, unitário) —
`Cartão de crédito:`, `senha do usuário:`, `Chave de segurança:`, `Senha provisória:`,
`Palavra-passe do usuário:` (todos abertos, 4 superfícies cada). A fruta mais baixa é o par
"rótulo + `de`/`do`/`da` + palavra acentuada", que é a forma natural em português. É o mecanismo do C1
(não soma formas ao total de §3).

### I3 (Important) — o sinal acende em prosa legítima e **apaga o resto do trecho** (texto e atributos)

O preço da marcação monotônica está declarado pelo autor, mas **não** estes falsos positivos: sentenças
comuns de página acendem o sinal pelo mesmo `VALUE_LIKE_TAIL_SOURCE` (rótulo + até 2 palavras + número).

```
$ node harness/cost.mjs /private/tmp/adv130/pkg
### login-com-aviso      (1.1.30: 6 tarjas e 200 chars | 1.1.29: 0 tarjas e 271 chars)
  in : <main><h1>Entrar</h1><p>A senha deve ter 8 caracteres</p><form><label for="u">Usuário</label>
       <input id="u" type="text"><label for="p">Senha</label><input id="p" type="password">
       <button>Entrar</button></form><p>Não tem conta? <a href="/cadastro">Cadastre-se</a></p></main>
  out: <main><h1>Entrar</h1><p>A senha deve ter [redacted]</p><form><label>[redacted]</label><input>
       <label>[redacted]</label><input><button>[redacted]</button></form><p>[redacted]<a>[redacted]</a></p></main>
### docs-sessao           (1.1.30: 6 tarjas e 187 chars | 1.1.29: 1 tarja e 235 chars)
  in : …<p>Sua sessão expira em 30 minutos.</p><h2>Autenticação</h2><pre>Authorization: Bearer abc</pre>
       <p>Use o cabeçalho acima em todas as chamadas.</p><nav><a href="/docs/a">A</a>…</nav>…
  out: …<p>Sua sessão expira em [redacted]</p><h2>[redacted]</h2><pre>Authorization: [redacted]</pre>
       <p>[redacted]</p><nav><a>[redacted]</a><a>[redacted]</a></nav>…
### conta-prosa           (1.1.30: 4 tarjas | 1.1.29: 0)
  in : …<p>Senha da conta: alterada em 12/03</p><p>Chave da API: gere uma nova</p><nav><a href="/perfil">Perfil</a>…</nav>
  out: …<p>Senha da conta: [redacted]</p><p>Chave da API: [redacted]</p><nav><a>[redacted]</a><a>[redacted]</a></nav>
```

E na mesma página de sentinelas: o trecho do `<main>` entregue tem **3.521 caracteres na 1.1.29 e 2.741
na 1.1.30** (15 → 34 tarjas), e depois do sinal todos os `id`/atributos dos elementos seguintes
desaparecem (`<img id="missing-alt">` → `<img>`, `<a href=…>` → `<a>`). A prosa legítima que o autor cita
como controle negativo (`cartão de crédito`, `chave do problema`, `Senha da conta`) **não** acende — isso
confere; mas `A senha deve ter 8 caracteres` e `Sua sessão expira em 30 minutos` acendem, e essas frases
são o oposto de raras em página brasileira de login. O autor chegou a **fixar a perda em teste**:
`test/evidence/snippet.test.js` trocou `assert.match(trecho, /texto público/)` por
`assert.doesNotMatch(trecho, /texto público/)` e `test/panel/panel-detail.test.js` trocou a asserção de
que o parágrafo público sobrevive por uma asserção de que ele **não** sobrevive (com o comentário "preço
declarado"). É transparência, mas o preço passa a ser exigido pela suíte.

---

## 5. Os sete Important da 1.1.29, um a um (item 4)

| # | Afirmação/falha da 1.1.29 | Situação medida na 1.1.30 | Evidência |
|---|---|---|---|
| a | decisão **antes** de emitir | **FECHADO no mecanismo** (não há mais emissão antes da decisão: `emitText` lê o acumulado antes de escolher a saída) — mas a decisão **não dispara** quando o rótulo é acentuado, e é aí que a classe sobrevive | `senha<!-- nota -->: X` → `senha[redacted]`; `Cartão de crédito: X` → intacto |
| b | espera **não** consumida por estrutura | **FECHADO** — não existe mais espera; comentário, `<img>`, `<span></span>`, `<svg></svg>`, `<wbr>`, `<td></td>`, CDATA e `<template>` não interrompem mais nada | c05, c06, c07, c16, c24, c29 fechados no E2E; `<template></template>`, `<svg></svg>`, `<svg><title></title></svg>`, `<noscript>`, `<object></object>`, `<script>` e `<style>` fechados no instrumento unitário (`A-template-empty`, `A-svg-empty`, `A-svg-title`, `A-noscript`, `A-object`, `A-script`, `A-style` — todos vazavam na 1.1.29) |
| c | sufixo de rótulo **com espaço** | **PARCIAL** — ASCII fechado, acentuado aberto | `Chave da API:`/`Senha atual:` fechados; `senha do usuário:`, `Chave de segurança:`, `Senha provisória:`, `Palavra-passe do usuário:`, `Cartão de crédito:` abertos (§3.3) |
| d | decodificador multi-passagem cobrindo separador e letras | **FECHADO no que a 1.1.29 mediu** — 3 passagens, `&#104;`, `&#58;`, `&#x3a;`, `&colon;`, `&nbsp;`, `&#160;`, `&amp;quot;`, `\u003a`, `\x3a`, `&Tab;`, `&emsp;` (os dois últimos porque o parser entrega o caractere literal) | c02, c03, c23, c25, c30, c31 fechados; unitário `{&amp;quot;senha&amp;quot;: …}` fechado |
| e | tarja de cauda **no caminho do trecho** | **NÃO FECHADO** — o ramo não taintado continua `redactSensitiveText` (exige separador); o ramo taintado usa a regra de cauda, mas a regra ficou estreita (I1) | `sanitizeHtmlSnippetSource('<p>senha correcthorsebattery</p>')` → intacto; `<p><b>senha</b> ZQXJKVBWPMTLRNHS</p>` → intacto; `<p><b>senha</b> S3GR3D0XYZQ</p>` → `<b>senha</b>[redacted]` (este fechou) |
| f | nome acessível pelo **fallback de DOM** | **PARCIAL + REGRESSÃO** — o caso medido na 1.1.29 (`title` → `description`) fechou, mas 4 formas com cauda só de letras/`!` regrediram | a02/a03/a04 fechados; a06/a07/a12/a16 vazam (§4 I1) |
| g | chave de URL **percent-encoded** | **FECHADO no tarjador de texto** (`credentialKey` decodifica a chave antes do teste) — **aberto** no `sanitizeEvidenceUrl` (latente) e no **segmento de rota** percent-encoded | c09/c10 fechados; `#/authorize/co%64e=` e `?code%3D` e `?%2563ode` continuam entregues (f11/f12/f13) |

---

## 6. Não vacuidade e mutação (item 3) — reproduzidas

Mutação feita por mim, em cópia, restaurando os **três** arquivos de `ab615d5` (1.1.29) e deixando o resto
da 1.1.30 intacto (hashes conferidos um a um contra `git show ab615d5:`):

```
$ shasum -a 256 work-mutant/src/core/{privacy.js,evidence/snippet.js,accessibility/accessible-name.js}
7ba382dc…  privacy.js            33ad6b43…  evidence/snippet.js       025ae9dc…  accessible-name.js
(iguais aos blobs de ab615d5)

# bytes empacotados (work), código atual
✔ current-page audit exports four verified artifacts (3640ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0

# bytes empacotados com os três arquivos da 1.1.29 (work-mutant)
✖ current-page audit exports four verified artifacts (3579ms)
  AssertionError [ERR_ASSERTION]: credencial da página chegou ao entregável em:
  relatório, modelo e revisão guardados, artefato html, artefato json
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

- o diff de `test/e2e/current-page-export-mv3.test.mjs` entre as gerações **só acrescenta 14 linhas à
  fixture** (`adv-a1`…`adv-a13`, `credential-encoded`, `credential-title`); **nenhuma asserção foi
  removida ou afrouxada** — as provas de não vacuidade (`collected.secrets.length > 0`,
  `highlightNonces > 0`, `candidates.length > 0`, `deliveredHtml/Json.length > 0`) continuam lá e são
  satisfeitas na execução (`segredos varridos=3; superfícies=9`);
- a fixture contém credencial de verdade (`rawPage.includes(CREDENTIAL) && rawPage.includes('4111 1111 1111 1111')`);
- o meu próprio instrumento separa as gerações (78 × 130 pares) e tem 31 controles que precisam ser
  tarjados — nenhum deles passa por vacuidade.

---

## 7. Custo do mecanismo (item 2) — medido, e a afirmação "custo zero no Google" confere

Além do §4 I3 (falsos positivos em prosa), a comparação na **mesma página** mostra o preço:

```
$ python3 (walk no modelo entregue, mesma página de sentinelas)
1.1.29  snippet do <main>: 3.521 chars, 15 [redacted], ids e atributos preservados
1.1.30  snippet do <main>: 2.741 chars, 34 [redacted], <img id=…>/<a href=…> viram <img>/<a>

$ node harness/cost.mjs (login-simples)   # formulário de login comum, com <label>Senha:</label>
1.1.29 out: <main><h1>Entrar</h1><form>…<label for="p">Senha:</label><input><button type="submit">Entrar</button>
            </form><p><a href="/recuperar">Esqueci minha senha</a></p><p>Não tem conta?
            <a href="/cadastro">Cadastre-se</a></p></main>            (317 chars, 0 tarjas)
1.1.30 out: <main><h1>Entrar</h1><form>…<label for="p">Senha:</label><input><button>[redacted]</button>
            </form><p><a>[redacted]</a></p><p>[redacted]<a>[redacted]</a></p></main>   (257 chars, 4 tarjas)
```

O rótulo `Senha:` de um formulário de login comum — que é conteúdo legítimo, não credencial — apaga o
resto do trecho e, com ele, a prova de que o campo é `type="password"`/`autocomplete="current-password"`
(os atributos do `<input>` caem). Custo **declarado** e agora fixado em teste pelo autor (§4 I3).

**Google, A/B na mesma página (DOM congelado, mesmos bytes):**

```
$ ADV_PKG=…/work  node harness/frozen-audit-mv3.test.mjs   -> 1.1.30: 11 snippets, 50.739 chars, 0 [redacted]
$ ADV_PKG=…/work129 node harness/frozen-audit-mv3.test.mjs -> 1.1.29: 11 snippets, 50.739 chars, 0 [redacted]
unica diferenca entre os conjuntos de snippets: a PORTA efêmera do servidor de fixture
  130: <link href="http://127.0.0.1:58043/xjs/…">      129: <link href="http://127.0.0.1:58065/xjs/…">
```

Ou seja: **na mesma página o autor tem razão** — "zero `[redacted]`" e snippets idênticos entre gerações
(a ressalva é que a comparação é com a 1.1.29; a 1.1.29 já era idêntica à 1.1.28 nos números da revisão
anterior). A rota inocente `/code/1234` e o cupom `?code=BR10` continuam tarjados nas duas gerações
(custo herdado, declarado).

---

## 8. Números declarados (item 5)

| Alegação | Meu comando | Medido | Veredito |
|---|---|---|---|
| Suíte sem `test/e2e/`: **4.160** testes, **4.159** passam, 1 pulado, 0 falham | `node --test --test-concurrency=4 $(find test \( -name '*.test.js' -o -name '*.test.mjs' \) \| grep -v '^test/e2e/' \| sort)` (177 arquivos, no clone em `3c571f4`) | `tests 4160, pass 4159, fail 0, skipped 1, todo 0` (51,9 s) | **REPRODUZIDO** (o "4.158" da 1.1.29 virou 4.159) |
| Gate `release-package`+`extension-shell`+`release-assets` **20/20** com o digest fixado | `node --test --test-concurrency=1` dos três, no clone | **20/20** + `pacote conferido byte a byte: 199 arquivos idênticos à árvore revisada` | **REPRODUZIDO** |
| Fase serial de 35 arquivos: **34 verdes**, único vermelho `sidepanel-flow-mv3` | `serial130.sh` (lista `REAL_CHROME_E2E` do `scripts/run-tests.mjs` + 1 arquivo `PROCESS_SAFE` por engano meu), um Chrome por vez | **34 verdes / 2 vermelhos de 36**: `sidepanel-flow-mv3` (`tests 9, pass 2, fail 7`, blocos de ~32 s e ~121 s — assinatura idêntica à da revisão da 1.1.29) e `axe-mv3-csp.test.mjs`, que **passa isolado** (1/1 em 1,1 s: `cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]` era flake de perfil) | **REPRODUZIDO**: 34/35 com o vermelho reprodutível sendo `sidepanel-flow-mv3`; `url-audit-mv3` (22 s, 2/2) e `retention-indexeddb-mv3` (25 s, 11/11) passaram nesta passagem |
| Google real: 0 falhas, 1 alerta (1 ocorrência), 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações `complete`, versão 1.1.30 | `node harness/google-adv130.mjs` nos bytes empacotados (e o mesmo script na 1.1.29 minutos depois) | **1.1.30:** 0 falhas, **1 alerta/1 ocorrência**, **2 suspeitas/2 ocorrências**, 9 positivos, **108 no checklist**, **29,2%**, 9,0/10, **PDF 17 páginas**, 4 `complete` (2,0 s), versão 1.1.30, 0 frases legais. **1.1.29:** 0, 1/1, **3/4**, 9, **109**, **28,5%**, 9,0/10, **18 páginas**, 4 `complete`, versão 1.1.29 | **PARCIAL** — os números de suíte/gates passam; 3 suspeitas, 109, 28,5% e 18 páginas **não** se reproduzem na 1.1.30, mas **a página do Google não era a mesma** (as duas auditorias veem DOMs diferentes: `div:nth-of-type(6)` × `div:nth-of-type(4)` no formulário, 118 × 114 ocorrências), e no A/B congelado as duas gerações dão resultados idênticos — é variação de instância da página, não do código. O conjunto declarado é exatamente o da instância que a 1.1.29 viu |
| Artefato entregue: **146/146 ids e títulos**, 0 palavras partidas, notas **5/5** nos dois formatos | `harness/artcheck130.py google-artifacts/130` (pypdf) | `itemResults: 146 unique ids: 146 with title: 146`; HTML ids/títulos ausentes **0/0**; PDF **0/0**; títulos não contíguos no PDF **0**; `editorialNotes: 5 presentes HTML 5/5 PDF 5/5`; hashes de proveniência presentes nos dois | **REPRODUZIDO** (o CSV é recorte de achados: 35 ids/37 títulos ausentes, como nas versões anteriores) |
| "custo zero": snippets idênticos e zero `[redacted]` no Google | §7 (A/B congelado) + artefatos do Google | `[redacted]` em json/html/csv: **0/0/0**; snippets idênticos entre gerações exceto a porta efêmera | **REPRODUZIDO** |
| Métrica de aceitação com **125 combinações** e zero segredos sobreviventes | `grep -rn "125" test/ scripts/ src/` | nenhuma ocorrência de métrica (só `perdidasNa125`, que é a versão 1.1.25, e uma coordenada); os arquivos de teste da classe têm 13+24+12 blocos `test()` e **nenhum** percorre os quatro caminhos; o meu instrumento equivalente (305 formas × 4 caminhos) mede **73 vazamentos na 1.1.30** | **NÃO REPRODUZÍVEL como declarado** (reincidência do M4 da 1.1.29) → M4 |

---

## 9. Minor e observações

### 9.1 Minor (5)

- **M1 — `sanitizeEvidenceUrl` continua sem conhecer `code`/`assertion`, percent-encoded ou não.**
  Medido: `sanitizeEvidenceUrl('https://h.test/p?code=SEGREDO')` → `'https://h.test/p?code=SEGREDO'`;
  `sanitizeJsonData({href:'https://h.test/p?co%64e=SEGREDO'})` → valor preservado (as duas gerações).
  É o caminho `URL_ATTRIBUTE_KEYS` do `sanitizeJsonData` (`privacy.js:339`). **Não medi superfície
  entregue que receba objeto com chave de URL** — no modelo entregue não existe nenhuma chave
  `href`/`src`/`action`/… (varredura no modelo da 1.1.30: lista vazia). Fica latente, como a O2 da
  1.1.29.
- **M2 — codificações residuais no caminho do trecho.** Entregues nas duas gerações:
  `#/authorize/co%64e=` (f11), `?code%3D` (f12), `?%2563ode` (f13) e `senha%3a` (f14) — 4 superfícies
  cada. Unitários e não entregues no meu percurso: `senha\0: X` (o decodificador não trata `\0`).
  O `URL_CREDENTIAL_SEGMENT` (`privacy.js:74`) casa o segmento **literal** e o `credentialKey` só
  decodifica **chave de parâmetro**.
- **M3 — o sanitizador não é idempotente para atributo com `&`, e o painel o aplica duas vezes.**
  `sanitizeHtmlSnippetSource` roda de novo sobre o trecho **já sanitizado** no detalhe do painel
  (`panel-detail.js:178-181`, que lê `artifact.snippet` do modelo):
  `href="/p?a=1&b=2"` → `a=1&amp;b=2` → `a=1&amp;amp;b=2` → `a=1&amp;amp;amp;b=2` (3 passagens medidas);
  o trecho entregue da minha página (2.741 chars) re-sanitizado vira 2.694 chars na 1.1.30 (na 1.1.29 era
  no-op). Pré-existente na causa (o `escapeAttribute` não mudou), mas a 1.1.30 acrescenta a perda de
  conteúdo na segunda passagem. **Não medi divergência painel × relatório ponta a ponta** (a página que
  usei não levou o snippet do `<main>` ao painel).
- **M4 — a métrica de "125 combinações" não tem comando nem artefato reproduzível** (§8). Mesma falha da
  M4 da 1.1.29, agora com outro número.
- **M5 — os números do Google declarados não se reproduzem na 1.1.30** (2 suspeitas, 108, 29,2%, 17
  páginas), ainda que a causa aparente seja a instância da página (§8). Os números declarados batem
  exatamente com a instância que a **1.1.29** viu na minha sessão, e o A/B congelado mostra as duas
  gerações idênticas — o que resta é a inconsistência de declarar como "do pacote" um instantâneo de
  página.

### 9.2 Observações (5)

- **O1 — `git status --porcelain` vazio** (§2); o zip está rastreado no commit `3c571f4`.
- **O2 — uma das 14 formas novas da fixture do autor é vácuo.** `<div id="credential-title" title="chave X">`
  não gera nome nem descrição no CFT 152 (R4 da revisão da 1.1.29): medido 0 vazamentos nas duas gerações
  na minha forma equivalente (`a09-div-title`). A forma não exercita o caminho para o qual foi adicionada;
  `title` só é não-vácuo em elemento cujo nome acessível vem dele (input, iframe, botão).
- **O3 — o autor fixou a perda de evidência em teste** (§4 I3): `test/evidence/snippet.test.js` e
  `test/panel/panel-detail.test.js` trocaram asserções de **preservação** de texto público por asserções
  de **tarjamento**; em `panel-detail.test.js` a mesma asserção `assert.doesNotMatch` aparece duas vezes
  seguidas (resíduo da edição).
- **O4 — o PDF não foi superfície da classe neste percurso** (0/63 sentinelas em 27 páginas, nas duas
  gerações) — o que não afirma que esteja limpo em todos os percursos.
- **O5 — `{"code": "X"}` e `{"assertion": "X"}` fecharam** (a O1 da 1.1.29), porque `URL_CREDENTIAL_KEY_SOURCE`
  entrou no `VALUE_LABEL_SOURCE`; e `{"access_token": "X"}` continua fechado. Crédito ao incremento.

---

## 10. Retratações — o que a minha própria medição não sustentou

- **R1 — o meu instrumento unitário disse "0 regressões" e estava errado por agregação.** No
  `harness/matrix.mjs` eu comparava o campo `tailrule` como uma superfície só (o texto concatenado de
  `redactCredentialLabelTail` **e** `redactSensitiveText`), então a regressão da cauda ficou escondida: a
  1.1.29 tarjava no primeiro e não no segundo; a 1.1.30 não tarja em nenhum, e o vazamento "permaneceu"
  aos olhos do agregado. A regressão só apareceu na medição direta por função (§4 I1) e no E2E. Corrigi o
  instrumento para comparar por saída.
- **R2 — a primeira página de sentinelas deu "fechado" para f10–f14 e eu quase reportei isso.** A causa
  era a ordem: `senha<![CDATA[:]]>: X` acende o sinal no navegador (o parser transforma o CDATA em
  comentário, que o sanitizador pula, e o `:` passa a fechar o rótulo), e o taint monotônico apagou tudo o
  que vinha depois — inclusive as candidatas que eu queria medir. Movi as formas que acendem para o fim da
  página e refiz a medição; o pré-cheque de ordem agora é parte do instrumento.
- **R3 — o `<![CDATA[…]]>`, o `&Tab;` e o `&emsp;` crus são buracos unitários, não vazamentos.** No
  sanitizador isolado `<p>senha<![CDATA[:]]>: X</p>` mantém o valor (o `parseTag` recusa o token e o texto
  acumulado não vê o separador), mas o produto captura por `DOM.getOuterHTML`: o navegador serializa o
  CDATA como comentário (que é pulado, deixando rótulo e separador se encontrarem) e as entidades de
  espaço como o caractere literal (que o `\s` do separador aceita). Medido: **0 superfícies** para as três
  formas. Ficam como buracos latentes do sanitizador exportado.
- **R4 — os vazamentos do `sanitizeEvidenceUrl` não são entregues no que eu medi.** `?code=`/`?co%64e=`
  sobrevivem nessa função nas duas gerações, mas o modelo entregue não tem chave de URL nenhuma
  (§9.1 M1). Não afirmo vazamento ponta a ponta por esse caminho.
- **R5 — eu esperava que o `div title` do autor vazasse e não vaza** — é vácuo (O2), como a R4 da revisão
  anterior já tinha medido.
- **R6 — a minha primeira comparação do Google ao vivo sugeria regressão de custo** (11 snippets/5.228
  chars na 1.1.29 × 8/4.853 na 1.1.30) e o A/B congelado a refutou: as duas auditorias ao vivo viram DOMs
  diferentes (seletores `nth-of-type` distintos), e na mesma página as gerações são idênticas (§7).
- **R7 — eu esperava que o `title`/`alt`/`placeholder` com valor só de letras fosse regressão da 1.1.30 em
  todos os campos** e não é: `a01` (title, 16 letras) já vazava na 1.1.29 pelos 4 entregáveis (o
  `description` do fallback não passava pela regra de cauda naquela versão). A regressão é específica das 4
  formas com cauda sem dígito **e** sem o símbolo antigo, nos campos `name`/`announcementPreview`.

---

## 11. O que eu NÃO medi

- **PDF como superfície da classe além da varredura de sentinelas**: 27 páginas, 0/63 nas duas gerações
  (§3.1); não afirmo que o PDF esteja limpo em todos os percursos.
- **Divergência painel × relatório** pela dupla sanitização (M3): medi o sanitizador e li o caminho no
  código, mas a minha página não levou o snippet do `<main>` ao painel.
- **Batch e auditoria por lista de URLs** com sentinelas próprias: os arquivos passaram na fase serial
  (batch-audit 8 s, url-audit 22 s, url-pixel-consent 33 s), mas não os instrumentei com segredos meus.
- **Superfícies de área de transferência, impressão do navegador e "salvar como"** fora do `downloads` do
  Chrome.
- **O caminho `sanitizeJsonData` com chave de URL numa superfície entregue** (M1) — só o nível unitário.
- **Frames/iframes** como páginas de sentinela (todas as minhas formas viveram no documento principal).
- **Leitores de tela e outros navegadores**: usei a árvore AX do CFT 152 via o produto.
- **A suíte não-e2e sob carga concorrente** e o `axe-mv3-csp` em lote (flake de perfil, verde isolado).
- **`/Users/andrebadini/Downloads/eval_mymonitor.csv`** não foi lido nem citado.

---

## 12. Caminho de conserto (não aplicado)

1. **`src/core/privacy.js:76` (`VALUE_LABEL_SOURCE`)** — aceitar letra acentuada nos tokens do sufixo, ex.
   `(?:[\s]+[\p{L}\p{N}]{1,24}){0,2}` com a flag `u` (ou `[A-Za-zÀ-ÖØ-öø-ÿ0-9]`). É o item que fecha a
   maior parte do C1 (f01–f05, f15–f17, a05): `Cartão de crédito:`, `senha do usuário:`,
   `Chave de segurança:`, `Senha provisória:`, `Palavra-passe do usuário:`, `Número do cartão de crédito:`.
2. **`src/core/privacy.js:57` (`VALUE_LIKE_TAIL_SOURCE`)** — restaurar as alternativas que a 1.1.29 tinha
   e que não são a causa do falso positivo em prosa:
   `\S*(?:\d|[^\p{L}\s]|\S{12,})\S*` — ou, mantendo a lista de símbolos fortes, acrescentar
   `\S{12,}` e os sinais de pontuação (`!?.,;:()`) que ficaram de fora. Fecha as 4 regressões (I1) sem
   voltar a tarjar `Senha da conta`/`Chave da API` (conferir com os controles de prosa).
3. **`src/core/privacy.js:226-227` (`sanitizeEvidenceUrl`)** — usar `credentialKey(key)` (que já existe,
   com `decodeURIComponent` protegido) e testar o `hash` também contra `URL_CREDENTIAL_KEY`; fecha a M1.
4. **`src/core/privacy.js:74` (`URL_CREDENTIAL_SEGMENT`)** — decodificar cada segmento antes de testar
   (fecha `#/authorize/co%64e=`) e aceitar a chave com o separador percent-encoded (`code%3D`).
5. **`src/core/evidence/snippet.js:242`** — aplicar `redactCredentialLabelTail` (ou o próprio
   `hasCredentialValueSignal`) também no ramo não taintado, para a cauda sem separador; fecha a (e).
6. **Decisão de produto sobre o preço (I3)** — o taint monotônico é o que fecha a classe, mas o gatilho
   precisa exigir que o **valor** depois do separador tenha cara de valor (ou que o separador esteja no
   fim do nó, seguido de nó de valor), senão `A senha deve ter 8 caracteres`, `Sua sessão expira em 30
   minutos` e `Senha da conta: alterada em 12/03` seguem apagando o resto do trecho. Se a decisão for
   manter, declarar o falso positivo nos números do incremento (o autor declara o taint, não estes
   gatilhos) — e não trocar asserção de preservação por asserção de perda sem registrar isso no README.
7. **Métrica de aceitação** — dar comando e artefato à "métrica de 125 combinações" (ou citar o
   instrumento que a produz), como já foi pedido na M4 da 1.1.29.

---

## 13. Confirmação do checkout congelado

```
$ git -C /private/tmp/audita-review-130 rev-parse HEAD
3c571f41f6325da2a6a4feab961714692dc95293
$ git -C /private/tmp/audita-review-130 status --porcelain
(vazio)
$ git -C /private/tmp/audita-review-130 diff --stat
(vazio)
```

Nada foi editado no checkout congelado nem na árvore de desenvolvimento
(`/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`): todas as extrações, cópias, mutações e
instrumentos viveram em `/private/tmp/adv130/`. O `git clone` para os gates foi feito **do** checkout
congelado para `/private/tmp/adv130/clone` (leitura apenas na origem).
