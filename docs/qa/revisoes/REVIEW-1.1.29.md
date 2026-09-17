# Revisão adversarial independente — Audita Acessibilidade 1.1.29

- **Checkout congelado:** `/private/tmp/audita-review-129`, `HEAD ab615d5c2bc3b95a223d9a4a87a134fc6fc97c7d`
  (não editado; §5). `git status --porcelain` **vazio** (o `?? release/…zip` do brief não aparece porque o
  zip está **rastreado** — ver §2).
- **Artefato medido:** `release/audita-acessibilidade-1.1.29.zip`,
  SHA-256 `6926fe1757ad57db2baf81bf9daa8146b58b7aef998dc3329ff6e96072ec74bf` (**= o esperado**), 199 entradas.
- **Produto medido a partir dos bytes empacotados:** extraído em `/private/tmp/adv129/pkg` (pristino) e
  `/private/tmp/adv129/work` (com `test/`, `fixtures/` e `scripts/` copiados para dentro). Gerações
  anteriores: `pkg128` (zip da 1.1.28), `work-mutant` (1.1.29 com os três arquivos de `e3fbe03`).
- **Chrome:** Chrome for Testing 152.0.7977.64 em `/private/tmp/audita-cft152-fixed` (perfil temporário
  isolado, **um Chrome por vez**). Nada foi publicado; a única navegação externa foi a auditoria de
  `https://www.google.com/` que o próprio número declarado exige (leitura, perfil descartável).
- **Instrumentos próprios:** `harness/matrix.mjs` (117 formas × 4 caminhos), `harness/generations.mjs`
  (1.1.28 × 1.1.29), `test/e2e/adv129-sentinel-mv3.test.mjs` (26 formas com sentinela própria),
  `test/e2e/adv129-sentinel2-mv3.test.mjs` (`title` e chaves de URL do escopo), `harness/google-129.mjs`,
  `serial129.sh`; artefatos e logs em `/private/tmp/adv129/{artifacts,google-artifacts,logs}`.

---

## 1. Veredito

**A 1.1.29 NÃO substitui a 1.1.28 como candidata aprovada — e deve substituí-la como linha de base de
trabalho.** A classe do C1 continua aberta, medida ponta a ponta nos bytes empacotados: **15 formas** que
o incremento declara fechadas entregam a credencial inteira, cada uma a **4 superfícies** (relatório,
modelo/revisão guardados, artefato HTML e artefato JSON).

| | Contagem |
|---|---|
| **Critical** | **1** — a classe do C1 continua aberta: 15 formas, 4 superfícies cada (60 pares forma×superfície) |
| **Important** | **7** — mecanismos distintos da mesma classe (5 no sanitizador de trecho, 1 no nome acessível, 1 nas chaves de URL), todos falsificando uma afirmação explícita da 1.1.29 |
| **Minor** | **5** |
| **Observações** | **5** |

O que a 1.1.29 de fato fez, medido por mim (nunca com o mutante do autor):

- **os dois Important da 1.1.28 estão fechados no caminho de produto.** Na **mesma página** de sentinelas,
  a 1.1.28 entrega `placeholder` (4 superfícies), `alt` (2) e `?code=`/`#code=`/`#assertion=`/rota
  (`#/authorize/code/X`, 4 cada) — **22 pares forma×superfície**; a 1.1.29 entrega **0** em todos (§4.2);
- **os controles legítimos sobrevivem**: `Senha da conta`, `Chave da API`, `Digite sua senha` e a prosa
  `A sessão discutiu o cartão de crédito do usuário` continuam no modelo da 1.1.29 (§6.3);
- **zero regressões** contra a 1.1.28 no meu universo de 47 entradas comparadas nas duas gerações: nenhuma
  forma limpa na 1.1.28 vaza na 1.1.29, e **14 formas** que vazavam fecharam (§6.2);
- **custo zero na página declarada**: artefatos do Google com **11 snippets, 5.228 caracteres e zero
  `[redacted]`** em JSON, HTML e CSV, idêntico à 1.1.28 (§6.4);
- **todos os números do Google** conferem (0 falhas, 1 alerta/1 ocorrência, 3 suspeitas/4 ocorrências,
  9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações `complete`, versão 1.1.29) e o
  artefato entregue tem 146/146 ids e títulos, 0 palavras partidas e notas 5/5 nos dois formatos (§7).

O que impede a substituição é que a **afirmação central** — "fecha a classe de forma **estrutural**" — não
se sustenta: a decisão sobre o texto acumulado é tomada **depois** de o fragmento com o valor já ter sido
emitido, e a espera de valor continua sendo **consumida por estrutura** (comentário, elemento vazio,
elemento vazio com atributos), não por conteúdo. As 12 formas que sobrevivem são a mesma classe, as mesmas
superfícies e a mesma severidade do C1 da 1.1.27 e da 1.1.28.

---

## 2. Integridade do artefato (item 6) — tudo reproduzido

```
$ shasum -a 256 release/audita-acessibilidade-1.1.29.zip
6926fe1757ad57db2baf81bf9daa8146b58b7aef998dc3329ff6e96072ec74bf   (= esperado)

$ unzip -l release/audita-acessibilidade-1.1.29.zip | tail -2
  4275836                     199 files

$ python3 (sha256 por entrada, dois sentidos, contra o conjunto de runtime da árvore)
zip entries: 199
only in zip: []
only in tree: ['.git', '.gitignore', 'README.md', 'assets/icons/icon-1024.png',
               'assets/icons/icon-source.svg', 'design-qa.md', 'package-lock.json', 'package.json']
content differs: []

$ git -C /private/tmp/audita-review-129 ls-files --error-unmatch release/audita-acessibilidade-1.1.29.zip
release/audita-acessibilidade-1.1.29.zip          # RASTREADO
$ git -C /private/tmp/audita-review-129 status --porcelain
(vazio)

$ cd clone2 && node scripts/build-release.mjs --temporary-release-directory $TMPDIR/audita-release-test-Ad129x
audita-acessibilidade-1.1.29.zip
SHA-256 6926fe1757ad57db2baf81bf9daa8146b58b7aef998dc3329ff6e96072ec74bf   (= o entregue)
```

A árvore tem 8 arquivos que não entram no pacote (documentação, `package.json`, dois ícones não
referenciados pelo manifesto, `.gitignore`, `.git`), e **nenhuma** diferença de conteúdo nos 199 de runtime.
O gate `release-package` confirma o mesmo por dentro: `pacote conferido byte a byte: 199 arquivos idênticos
à árvore revisada`.

**Nota de escopo (O4):** o brief esperava `?? release/audita-acessibilidade-1.1.29.zip` em
`git status --porcelain`. A árvore de trabalho está **limpa** porque o zip está versionado — o que é o
estado desejável, não um desvio.

---

## 3. C1 (Critical) — a classe continua aberta: 15 formas × 4 superfícies

### 3.1 Medição ponta a ponta (bytes empacotados)

E2E de sentinela próprio, uma forma por elemento, sentinela distinta por forma, varredura sobre as
superfícies entregues reais (`test/e2e/adv129-sentinel-mv3.test.mjs`, rodado na raiz extraída):

```
$ AUDITA_E2E_CHROME="…/Google Chrome for Testing" node --test --test-concurrency=1 test/e2e/adv129-sentinel-mv3.test.mjs
forma                                               painel  relatorio  modelo/revisao  csv  html  json
A1 rotulo em no + ": valor" no mesmo texto           0        1          1           0    1     1
A2 comentario HTML entre rotulo e separador          0        1          1           0    1     1
A3 img com atributos entre separador e valor         0        1          1           0    1     1
A4 span vazio entre separador e valor                0        1          1           0    1     1
A5 nbsp entre rotulo e separador                     0        1          1           0    1     1
A6 rotulo com sufixo por espaco (Senha atual)        0        1          1           0    1     1
A7 entidade aninhada &amp;quot;                       0        1          1           0    1     1
A8 dois pontos como entidade &#58;                    0        0          0           0    0     0
A9 rotulo em no + espaco + valor (sem separador)     0        1          1           0    1     1
A10 th/td vazio/td valor                             0        1          1           0    1     1
A11 JSON {"code": ...} no pre                        0        1          1           0    1     1
A12 JSON {"assertion": ...} no pre                   0        1          1           0    1     1
A13 svg vazio entre separador e valor                0        1          1           0    1     1
B1 placeholder="senha S"                             0        0          0           0    0     0
B2 alt="token S"                                     0        0          0           0    0     0
B3 title="chave S"                                   0        0          0           0    0     0
B4 aria-label="chave S"                              0        0          0           0    0     0
B5 aria-description="senha S"                        0        0          0           0    0     0
B6 aria-label em input="senha S"                     0        0          0           0    0     0
C1 href ?code=S                                      0        0          0           0    0     0
C2 href #code=S                                      0        0          0           0    0     0
C3 href #assertion=S                                 0        0          0           0    0     0
C4 href rota #/authorize/code/S                      0        0          0           0    0     0
C5 fragmento da URL do escopo #code=S                0        0          0           0    0     0
C6 href ?access_token=S                              0        0          0           0    0     0
superficies por forma: A1..A7,A9..A13 = 4 cada; A8,B*,C* = 0      (48 pares forma×superfície)
CREDENTIAL da fixture presente na pagina: true
```

Saída crua do que ficou gravado no **artefato JSON entregue** (campo `snippet`, um único snippet do
`<main>`; idêntico no relatório, no modelo/revisão e no HTML entregue):

```json
"<main><h1>Página avaliada</h1> <p id=\"credential-text\">senha: [redacted]</p>
 <pre id=\"credential-json\">{\"senha\": [redacted]</pre>
 <p id=\"adv-a1\"><b>senha</b>: ADVSEN01LBLX</p> <p id=\"adv-a2\">senha: ADVSEN02CMTX</p>
 <p id=\"adv-a3\">senha:<img>ADVSEN03IMGT</p> <p id=\"adv-a4\">senha:<span></span>ADVSEN04SPNX</p>
 <p id=\"adv-a5\">senha&nbsp;: ADVSEN05NBSP</p> <p id=\"adv-a6\">Senha atual: ADVSEN06ACNT</p>
 <pre id=\"adv-a7\">{&amp;quot;senha&amp;quot;: &amp;quot;ADVSEN07ENTX&amp;quot;}</pre>
 <p id=\"adv-a8\">senha: [redacted]</p> <p id=\"adv-a9\"><b>senha</b> ADVSEN09TAIL</p> …"
```

O **PDF** entregue não carrega nenhum dos 26 sentinelas (varredura por `pypdf` sobre as 24 páginas do PDF
do próprio E2E): o relatório de impressão não inclui o snippet do `<main>` — só snippets por elemento
(no PDF aparece `<input id="adv-b1" type="text">`, já sanitizado). Ver O3.

### 3.1.1 Segundo sentinel (`adv129-sentinel2-mv3`, foco `title` e chaves de URL)

```
$ ADV_KEEP=sentinel2-129 node --test --test-concurrency=1 test/e2e/adv129-sentinel2-mv3.test.mjs   (1.1.29)
forma                                       painel  relatorio  modelo  csv  html  json
T1 input title (nome acessível = title)       0        1        1      0    1     1    <== VAZA
T2 button title (descrição = title)           0        0        0      0    0     0
T3 iframe title (nome acessível = title)      0        0        0      0    0     0
T4 img alt (controle)                         0        0        0      0    0     0
T5 input placeholder (controle)               0        0        0      0    0     0
T6 input aria-label (controle)                0        0        0      0    0     0
T7 div title com texto                        0        0        0      0    0     0   (vacuidade, ver R4)
T8 span title                                 0        0        0      0    0     0
T9 escopo ?code=S                             0        0        0      0    0     0
T10 escopo #/authorize/code/S                 0        0        0      0    0     0
P1 href ?co%64e=S (chave percent-encoded)     0        1        1      0    1     1    <== VAZA
P2 href ?%43ODE=S (chave percent-encoded)     0        1        1      0    1     1    <== VAZA
ausentes da pagina-fonte: (nenhuma)          vazamentos: 12
mesma página nos bytes da 1.1.28:            vazamentos: 16  (T1, P1, P2 iguais + T4, T5)
```

`title` **não** está fechado, e o vazamento não é pelo `accessibleName` — é pela **descrição** calculada
pelo *fallback* de DOM:

```
# modelo/revisão guardados, artefato do elemento:
"announcementPreview":"chave [redacted], campo de texto, chave TITSEN01INPX",
"description":"chave TITSEN01INPX","descriptionSource":"title",
"name":"chave [redacted]","nameSource":"accessibility-tree","role":"textbox"
# HTML entregue:
<p><strong>Anúncio estimado:</strong> chave [redacted], campo de texto, chave TITSEN01INPX.</p>
```

As chaves de URL **percent-encoded** (`?co%64e=`, `?%43ODE=`) atravessam as duas gerações: o
`sanitizeEvidenceUrl` resolve o parâmetro para `code` mas o testa contra `SENSITIVE_KEY` (que não conhece
`code`), e o tarjador de texto casa a **string literal** `code=`, não a chave decodificada.

```
# artefato JSON entregue, snippet do <main>:
<a id=\"adv-p1\" href=\"/current?co%64e=ENCSEN11PCTX\">code codificado</a>
<a id=\"adv-p2\" href=\"/current?%43ODE=ENCSEN12PCTU\">CODE codificado</a>
```

### 3.2 As 15 formas, por mecanismo, com a causa no código do pacote

Todas as linhas apontam para `src/core/evidence/snippet.js` do pacote extraído.

| # | Entrada (sentinela `X`) | Saída crua | Causa |
|---|---|---|---|
| A1 | `<p><b>senha</b>: X</p>` | `<p><b>senha</b>: X</p>` | `emitText` decide a espera **depois** de emitir o fragmento (l.229-244): o fragmento `: X` é emitido por `sanitizeText`, que exige rótulo **e** separador na mesma string; `pendingValueRedaction` só é armado no fim da função |
| A2 | `<p>senha<!-- c -->: X</p>` | `<p>senha: X</p>` | o comentário é pulado sem alimentar `textStream` (l.253-257) e o fragmento seguinte (`: X`) é emitido antes da decisão acumulada |
| A3 | `<p>senha:<img alt="i">X</p>` | `<p>senha:<img>X</p>` | elemento vazio **com** atributos encerra a espera (l.309-316: `if (parsed.attributes.length > 0) pendingValueRedaction = false;`) |
| A4 | `<p>senha:<span></span>X</p>` | idem intacto | elemento vazio **sem** atributos converte a espera em `pendingPrivateRoot` (l.317-320); o `</span>` fecha a raiz privada (l.283-297) e o texto seguinte fica livre |
| A5 | `<p>senha&nbsp;: X</p>` | idem intacto | o separador é a entidade `&nbsp;`, decodificada **só** para `textStream` (l.238), nunca para o fragmento emitido; `VALUE_SEPARATOR_SOURCE` não aceita `&nbsp;` |
| A6 | `<p>Senha atual: X</p>` | idem intacto | `VALUE_LABEL_SOURCE` (`privacy.js:64`) aceita sufixo `[A-Za-z0-9]{0,24}` **sem espaço** — `senhaAtual:` passa, `Senha atual:` não |
| A7 | `<pre>{&amp;quot;senha&amp;quot;: &amp;quot;X&amp;quot;}</pre>` | idem intacto | dupla codificação: `decodeEntities` faz **uma** passagem (`&amp;quot;` → `&quot;`), e o separador não aceita `&amp;quot;` |
| A9 | `<p><b>senha</b> X</p>` | idem intacto | a regra de cauda (`redactCredentialLabelTail`, o conserto do I1) **não** é aplicada no caminho do trecho: `sanitizeText` = `redactSensitiveText`, que exige separador |
| A10 | `<th>senha:</th><td></td><td>X</td>` | idem intacto | o `<td></td>` vazio consome a espera como A4 |
| A11 | `<pre>{"code": "X"}</pre>` | idem intacto | `code` está no vocabulário de **URL** (`privacy.js:36-44`), não no de rótulo/chave — decisão declarada |
| A12 | `<pre>{"assertion": "X"}</pre>` | idem intacto | idem A11 |
| A13 | `<p>senha:<svg></svg>X</p>` | idem intacto | como A4 (`<svg>`/`</svg>`) |
| T1 | `<input type="text" title="chave X">` | `description: "chave X"` nos 4 entregáveis | `computeAccessibleText` (`src/core/accessibility/accessible-name.js:222-238`) calcula a descrição pelo **atributo DOM** `title` (`fallbackDescription`, l.200-214) e devolve `description` sem passar por `projectAccessibleText`; o `name` (que veio da árvore AX) está tarjado |
| P1 | `<a href="/p?co%64e=X">` | atributo intacto no snippet | `URL_CREDENTIAL_PARAM` (`privacy.js:42`) casa a chave **literal**; `sanitizeEvidenceUrl` decodifica a chave mas a testa contra `SENSITIVE_KEY`, que não conhece `code` |
| P2 | `<a href="/p?%43ODE=X">` | atributo intacto no snippet | como P1, com hex maiúsculo |

Medição unitária correspondente (`node harness/matrix.mjs`, 117 formas × 4 caminhos): **37 vazamentos**,
dos quais 12 são as formas acima no caminho do trecho; as demais estão em §4.3 e §6.

### 3.3 Prova de que não é vácuo

A fixture contém credencial de verdade (`rawPage.includes(CREDENTIAL) === true`, idem
`4111 1111 1111 1111`) e a mesma página, rodada nos **bytes empacotados da 1.1.28**, entrega **70** pares
forma×superfície — contra **48** da 1.1.29 (§6.1). As 12 formas de trecho do C1 vazam **identicamente** nas
duas gerações, e T1/P1/P2 também: não são regressão, são a parte da classe que nenhuma das duas fechou.

---

## 4. Important — mecanismos e afirmações falsificadas

Os seis itens abaixo são **mecanismos do mesmo C1** (não somam vazamentos ao total de §3); cada um
falsifica uma frase explícita do incremento ou fecha um caminho irmão que o conserto deixou aberto.

### 4.1 I1 — "o sanitizador decide sobre o texto acumulado … rótulo e separador podem estar em nós diferentes"

**Falso na forma exata que a frase descreve.** O acumulado é consultado **depois** de o fragmento corrente
já ter sido emitido (`snippet.js:229-244`). Funciona quando o **separador** fecha o fragmento do rótulo
(`<span>senha</span>: <span>X</span>` → tarjado, medido) e falha quando o separador está no fragmento
**do valor**:

```
$ node -e "import('/private/tmp/adv129/pkg/src/core/evidence/snippet.js').then(({sanitizeHtmlSnippetSource:s})=>…)"
<p><span>senha</span>: S3GR3D0XYZQ</p>   ->  <p><span>senha</span>: S3GR3D0XYZQ</p>     (A1, 4 superfícies)
<p>senha<!-- c -->: S3GR3D0XYZQ</p>      ->  <p>senha: S3GR3D0XYZQ</p>                (A2, 4 superfícies)
```

O comentário HTML é o caso extremo: ele **não** entra em `textStream` (l.253-257), então o rótulo e o
separador nunca chegam a se encontrar no acumulado.

### 4.2 I2 — "a espera atravessa … elementos vazios sem atributo; elemento vazio com atributos consome a espera"

A segunda metade da frase é justamente o defeito: consumir a espera transfere o vazamento para o **texto
seguinte** ao elemento vazio.

```
<p>senha:<img alt="icone" src="/i.png">S3GR3D0XYZQ</p>  ->  <p>senha:<img>S3GR3D0XYZQ</p>   (A3)
<p>senha:<span class="i"></span>S3GR3D0XYZQ</p>         ->  <p>senha:<span></span>S3GR3D0XYZQ</p>  (A4)
<p>senha:<svg></svg>S3GR3D0XYZQ</p>                     ->  intacto                            (A13)
<th>senha:</th><td></td><td>S3GR3D0XYZQ</td>            ->  intacto                            (A10)
```

O elemento vazio **sem** atributo preserva a espera (correto), mas o **com** atributo a encerra, e o
elemento vazio **não-void** (`<span></span>`, `<svg></svg>`) a transforma em raiz privada que se fecha
sozinha. Nenhum dos três casos foi coberto pelos testes do próprio incremento (que só exercitam `<br>`,
`<hr>` e `<img alt="…">` como candidato a valor).

### 4.3 I3 — M1 "rótulos com sufixo curto" cobre só sufixo **colado**

`VALUE_LABEL_SOURCE` aceita `[A-Za-z0-9]{0,24}` sem espaço. Medido:

```
<p>senhaAtual: S3GR3D0XYZQ</p>       ->  <p>senhaAtual: [redacted]</p>       (declarado, ok)
<p>Senha atual: S3GR3D0XYZQ</p>      ->  intacto   (A6, 4 superfícies)
<p>Chave da API: S3GR3D0XYZQ</p>     ->  intacto
<p>Senha do usuário: S3GR3D0XYZQ</p> ->  intacto
<p>Token de acesso: S3GR3D0XYZQ</p>  ->  intacto
```

Rótulos de várias palavras são a forma **natural** em português ("Senha atual", "Chave da API",
"Senha do usuário"); a 1.1.29 fecha a variante camelCase e deixa a variante com espaço aberta.

### 4.4 I4 — o decodificador de entidades só vale para o acumulado, e para uma passagem

`DECODED_ENTITIES` (`snippet.js:209-214`) é aplicado a `textStream`, nunca ao fragmento que está sendo
emitido, e a lista não inclui o separador (`&#58;`, `&#x3a;`) nem resolve dupla codificação:

```
<p>senha&nbsp;: S3GR3D0XYZQ</p>                                  ->  intacto   (A5, 4 superfícies)
<pre>{&amp;quot;senha&amp;quot;: &amp;quot;X&amp;quot;}</pre>      ->  intacto   (A7, 4 superfícies)
<p>senha&#58; S3GR3D0XYZQ</p>                                     ->  intacto   (só unitário; ver R1)
```

O caso `&#58;` **não** chega às superfícies porque o `DOM.getOuterHTML` do CDP re-serializa o nó de texto
com `:` literal — medido (A8 = 0 superfícies). É um buraco latente do sanitizador exportado, não um
vazamento ponta a ponta.

### 4.5 I5 — `title` **não** está tarjado: o vazamento muda de campo em vez de sumir

A afirmação do incremento é literal: "a credencial que chegava pelo **nome acessível** de
`placeholder`/`alt`/`title` (agora tarjada por cauda)". Medição ponta a ponta com
`<input type="text" title="chave TITSEN01INPX">`:

```
name                  = "chave [redacted]"     nameSource = accessibility-tree     <- tarjado (projectAccessibleText)
description           = "chave TITSEN01INPX"   descriptionSource = title           <- NÃO tarjado
announcementPreview   = "chave [redacted], campo de texto, chave TITSEN01INPX"
superfícies: relatório, modelo/revisão guardados, artefato HTML, artefato JSON (4)
```

Causa: `projectElementAccessibility` (`src/core/accessibility/element-accessibility.js:81-110`) chama
`computeAccessibleText(node, indexes, { name, description })`, e essa função
(`src/core/accessibility/accessible-name.js:222-238`) usa a árvore AX só quando ela traz valor; sem
descrição na AX, cai em `fallbackDescription`, que lê o **atributo DOM `title` cru** (l.200-214) — o
atributo não passa por `redactCredentialLabelTail` nem por `redactSensitiveText` (que exige separador).
A mesma função tem `fallbackName` (l.166-198) lendo `aria-label`, `alt`, `title` e conteúdo cru: quando a
árvore AX não estiver disponível (`AX_FRAME_UNAVAILABLE`, caminho já previsto no produto), o **nome**
também cai no fallback e volta a vazar. Os dois `placeholder`/`alt` medidos ficaram limpos porque a AX os
entregou — não porque o fallback esteja coberto.

**Não é regressão** (a 1.1.28 vaza igual, 4 superfícies), mas é a afirmação do I1 que não se sustenta
para `title`.

### 4.6 I6 — chave de URL **percent-encoded** atravessa o I2

```
?co%64e=ENCSEN11PCTX    (A1, 4 superfícies)   ?%43ODE=ENCSEN12PCTU   (A2, 4 superfícies)
# nos dois casos, no mesmo caminho do `?code=` que a 1.1.28 entregava e a 1.1.29 fechou
```

`URL_CREDENTIAL_PARAM` (`privacy.js:42`) casa a chave **literal** no texto; `sanitizeEvidenceUrl`
(`privacy.js:201-216`) até decodifica a chave via `URL.searchParams`, mas a testa contra `SENSITIVE_KEY`,
que **não** contém `code`/`assertion` (decisão declarada). Resultado: a forma percent-encoded passa nos
dois caminhos. Também **não é regressão** (igual nas duas gerações), é a mesma classe do I2 por outra
codificação.

### 4.7 I7 — o vazamento sem separador que o I1 já sabia tarjar não é aplicado no trecho

O conserto do I1 (`redactCredentialLabelTail`) vive em `privacy.js:239-242` e é usado no nome acessível
(`normalize-snapshot.js:257`) e em strings com marcação (`privacy.js:263-266`) — **não** no caminho do
trecho, que chama `redactSensitiveText` (exige separador). Resultado medido ponta a ponta:

```
<p><b>senha</b> S3GR3D0XYZQ</p>   ->  intacto   (A9, 4 superfícies)
```

---

## 5. Não vacuidade e mutação (item 2) — reproduzidas

Mutação feita por mim, em cópia, restaurando os **três** arquivos de `e3fbe03` (1.1.28) e deixando o resto
da 1.1.29 intacto:

```
$ shasum -a 256 work-mutant/src/core/{privacy.js,evidence/snippet.js,normalize-snapshot.js}
17685bc617148c7c5426547a2ff4495180ad4e7c6fe09c144dac1fcf6d71e154  privacy.js
848f824a2b2d8d5f87bc8e733748690a2551f9fd23e78eee371bc4c430a3ce68  evidence/snippet.js
6c41a55e7f98ff9180fe45bed04ed4872d6b8b213eae81e4d0844c3d98743ba5  normalize-snapshot.js
(1.1.29: privacy.js = 7ba382dc1c0696d272eecad6c8df8f18cc7c93895c7d817db278479ecc3f9ea7)

# bytes empacotados (work), código atual
✔ current-page audit exports four verified artifacts (5497.880292ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0

# bytes empacotados com os sanitizadores da 1.1.28 (work-mutant)
✖ current-page audit exports four verified artifacts (5464.198375ms)
  AssertionError [ERR_ASSERTION]: credencial da página chegou ao entregável em:
  relatório, modelo e revisão guardados, artefato html, artefato json
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

- o diff de `test/e2e/current-page-export-mv3.test.mjs` entre as gerações **só acrescenta formas à
  fixture** (+13 linhas: `credential-br`, `-newline`, `-suffix`, `-split`, `-entity`, `-query`, `-hash`,
  `-placeholder`); **nenhuma asserção foi removida ou afrouxada** — as três provas de não vacuidade
  (`collected.secrets.length > 0`, `highlightNonces > 0`, `candidates.length > 0`,
  `deliveredHtml.length > 0 && deliveredJson.length > 0`) continuam lá e são satisfeitas na execução;
- a fixture contém credencial de verdade em **13 formas na página + a URL do escopo** (contagem no
  `DOCUMENT`: 12 ocorrências de `${CREDENTIAL}` em 12 elementos, mais o `cartão: 4111 1111 1111 1111`,
  mais `?senha=`/`cpf=` na `startUrl`): `credential-text`, `-nested`, `th/td`, `-json`, `-multi`, `-br`,
  `-newline`, `-suffix`, `-split`, `-entity`, `-attribute`, `-query`, `-hash`, `-placeholder`;
- a minha própria página de sentinelas, rodada na 1.1.28, mede **70** vazamentos e na 1.1.29 **48** — o
  instrumento separa as gerações, não passa por vacuidade.

---

## 6. Custo do alargamento (item 4) — pequeno, não nulo, e declarado só em parte

### 6.1 Mesma página, duas gerações (sentinela)

```
forma                                          1.1.28  1.1.29
A1..A7, A9..A13 (mecanismos do C1)             4 cada  4 cada
A8 &#58;                                          0       0
B1 placeholder                                  4       0   <== FECHOU
B2 alt                                          2       0   <== FECHOU
C1 ?code=                                       4       0   <== FECHOU
C2 #code=                                       4       0   <== FECHOU
C3 #assertion=                                  4       0   <== FECHOU
C4 rota #/authorize/code/S                      4       0   <== FECHOU
total                                          70      48
```

### 6.2 1.1.28 × 1.1.29 sobre o universo completo (`node harness/regression-full.mjs`)

121 formas × 4 caminhos (trecho, URL, nome acessível, JSON), nas duas gerações:

```
formas medidas: 121
vazamentos 1.1.28: 67   1.1.29: 33
REGRESSÕES (limpo na 1.1.28, vaza na 1.1.29): 0
FECHADOS   (vazava na 1.1.28, limpo na 1.1.29): 34
AINDA VAZAM (nas duas): 33
```

Os 34 fechamentos incluem `<br>`/`<hr>`/`<wbr>` antes do valor, `<span>senha</span>:<span>X</span>`,
`{"senha": "X"}` com `&quot;`/`&#34;`/`&#x22;`/`&QUOT;`, `\&#34;` escapado, `?code=`, `#code=`,
`#assertion=`, a rota `/code/X`, `?saml_response=` e **sete formas do nome acessível** (`senha X`,
`token X`, `chave X`, `SENHA X`, `senhaAtual: X`, `tokens: X`, `palavra-passe X`). **Nenhuma regressão.**

Custo medido nas entradas limpas nas duas gerações:

```
in: <p>senha: S3GR<br>3D0XYZQ</p>              28: senha: [redacted]<br>3D0XYZQ      29: senha: [redacted]<br>[redacted]
in: <p>senha: S3GR\n3D0XYZQ</p>                28: senha: [redacted] 3D0XYZQ          29: senha: [redacted]
in: <p>senha: S3GR<span>3D0XYZQ</span></p>     28: senha: [redacted]<span>3D0XYZQ</span>  29: senha: [redacted]<span>[redacted]</span>
in: <p>senha: S3GR\nProssiga com a verificação em duas etapas</p>
                                               28: senha: [redacted] Prossiga com a verificação em duas etapas
                                               29: senha: [redacted]                     <== prosa legítima perdida
in: <p>senha: S3GR<span>mais instruções importantes</span></p>
                                               28: senha: [redacted]<span>mais instruções importantes</span>
                                               29: senha: [redacted]<span>[redacted]</span>   <== prosa legítima perdida
in: <a href="/promo?code=BR">promoção</a>       28: ?code=BR preservado   29: ?code=[redacted]   <== valor inocente tarjado
in: <a href="/code/1234">rota</a>               28: /code/1234 preservado  29: /code/[redacted]   <== rota inocente tarjada
in: https://loja.test/produto?code=BR10&utm_source=x   29: ?code=[redacted]&utm_source=x
```

Os três primeiros itens são o preço **declarado** do fail-closed (a cauda depois do marcador); os dois
últimos (`?code`, `/code/`) são custo **novo** do I2 e não estavam declarados: qualquer `?code=` de
promoção, cupom ou rota inocente passa a ser tarjado. O rótulo em si sobrevive (`senha`, `chave`), então a
perda é do valor — mas é perda de conteúdo legítimo.

**Buraco latente (não ponta a ponta):** `sanitizeJsonData({ href: 'https://h.test/p?code=X' })` mantém o
valor nas duas gerações, porque o ramo `URL_ATTRIBUTE_KEYS` chama `sanitizeEvidenceUrl`, que não conhece
`code`/`assertion` — e `sanitizeEvidenceUrl('…?code=X')` preserva (medido: tabela do `harness/matrix.mjs`).
Não medi superfície entregue que receba um objeto com chave `href`/`src`: no modelo entregue não existe
nenhuma chave `"href"` (as URLs dos elementos chegam pelo `snippet` e por campos próprios, já tarjados).
Fica registrado como caminho a fechar junto com o item 5 do conserto (§10).

### 6.3 Controles preservados (medidos no modelo da 1.1.29)

```
$ grep -c "Senha da conta" surface-modelo…        -> 1
$ grep -c "Chave da API" surface-modelo…          -> 1
$ grep -c "Digite sua senha" surface-modelo…      -> 1
$ grep -c "A sessão discutiu o cartão" surface…   -> 1
```

### 6.4 "Custo zero" na página declarada (Google) — REPRODUZIDO

```
1.1.28: snippets=11 chars=5228 redacted-in-snips=0 redacted-json=0 version=1.1.28
1.1.29: snippets=11 chars=5228 redacted-in-snips=0 redacted-json=0 version=1.1.29
[redacted] em json: 0   em html: 0   em csv: 0   (1.1.29)
```

Os snippets não são byte a byte iguais entre as sessões (tokens de sessão do Google: `data-ved`,
`aria-controls="_ESO…"` vs `"_Jiq…"`), mas têm o mesmo número, o mesmo comprimento total e zero
tarjamento — a afirmação "5.228 caracteres com zero `[redacted]`" confere nas duas.

---

## 7. Números declarados (item 5)

| Alegação | Meu comando | Medido | Veredito |
|---|---|---|---|
| Suíte sem `test/e2e/`: **4.160** testes, **4.158** passam, 1 pulado, 0 falham | `node --test --test-concurrency=4 $(find test \( -name '*.test.js' -o -name '*.test.mjs' \) \| grep -v '^test/e2e/' \| sort)` (177 arquivos) no clone com histórico | `tests 4160, pass 4159, fail 0, skipped 1, todo 0` (58,7 s) | total, pulado e falhas **exatos**; **passam = 4.159**, não 4.158 → **M3 (reincidência do M3 da 1.1.28)** |
| Gate `release-package`+`extension-shell`+`release-assets` **20/20** com o digest fixado | `node --test --test-concurrency=1` dos três, no clone | **20/20**, com `pacote conferido byte a byte: 199 arquivos idênticos à árvore revisada` | **REPRODUZIDO** |
| Fase serial de 35 arquivos: **34 verdes**, único vermelho `sidepanel-flow-mv3` | `serial129.sh` sobre a lista `REAL_CHROME_E2E` do próprio `scripts/run-tests.mjs`, nos bytes empacotados, um Chrome por vez | ver §7.1 | ver §7.1 |
| Google real: 0 falhas, 1 alerta (1 ocorrência), 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações `complete`, versão 1.1.29 | `node harness/google-129.mjs` nos bytes empacotados | `Versão … 1.1.29`; `0 verificações com falha confirmada (0 ocorrências)`; `1 Recomendações e alertas · 1 verificação · 1 ocorrência`; `3 Suspeitas a confirmar · 3 verificações · 4 ocorrências`; `9 Resultados positivos · 9 verificações`; `Checklist separado — 109`; `Cobertura automática: 28,5%`; `motor próprio 9,0 / 10`; PDF **18 páginas**; 4 downloads `complete` (2,3 s); 0 frases legais | **REPRODUZIDO** (o tempo é dependente de ambiente) |
| Artefato entregue: **146/146 ids e títulos**, 0 palavras partidas, notas **5/5** nos dois formatos | `artcheck128.py` sobre os meus artefatos do Google (1.1.29) | 146 itens, 146 ids únicos, 146 títulos; **0** ids e **0** títulos ausentes no HTML e no PDF; **0** títulos não contíguos; notas **5/5 no HTML e 5/5 no PDF**; `canonicalModelHash`, `exportDeliveryIdentity.modelHash`, `auditId` e versão presentes nos dois | **REPRODUZIDO** (o CSV é recorte de achados: 34 ids/36 títulos ausentes, como nas versões anteriores) |
| "custo zero": snippets de **5.228** caracteres com **zero** `[redacted]` | §6.4 | 1.1.28 e 1.1.29: 11 snippets, 5.228 caracteres, 0 `[redacted]` em JSON/HTML/CSV | **REPRODUZIDO nos dois** |
| Métrica da classe com **115 combinações** (quatro caminhos) com zero segredos | `grep -rn "115" test/ scripts/` | **nenhuma ocorrência**; os arrays de casos dos três arquivos de teste somam ~63 entradas; não há teste que percorra quatro caminhos | **NÃO REPRODUZÍVEL como declarado** → **M4** |

### 7.1 Fase serial (35 arquivos, um Chrome por vez)

RESULTADO_SERIAL

---

## 8. Minor e observações

### 8.1 Minor (5)

- **M1 — custo novo do I2 em valores inocentes.** `?code=BR` → `?code=[redacted]` e `/code/1234` →
  `/code/[redacted]`; a 1.1.28 preservava os dois (§6.2). Fail-closed na direção declarada, mas é perda de
  conteúdo legítimo (cupom, promoção, rota de documentação) que não estava declarada no incremento.
- **M2 — custo do fail-closed na cauda e na continuação.** `<p>senha: S3GR\nProssiga com a verificação em
  duas etapas</p>` perde a prosa inteira (a 1.1.28 a mantinha) e `<span>mais instruções importantes</span>`
  depois de um valor tarjado vira `[redacted]`. É o preço declarado em comentário do código, mas não nos
  números do incremento.
- **M3 — "4.158 passam" não confere (é 4.159)** e é reincidência exata do M3 da revisão da 1.1.28, que o
  próprio README diz ter sido corrigido ("o número da suíte que eu citava errado"). Total (4.160), pulado
  (1) e falhas (0) conferem.
- **M4 — a métrica de "115 combinações" não tem comando nem artefato reproduzível.** `grep -rn "115"
  test/ scripts/` não encontra nada; os arrays de casos dos três arquivos de teste somam ~63 entradas e
  **nenhum** teste percorre os quatro caminhos declarados (trecho, JSON, nome acessível, URL). A métrica
  equivalente que construí (121 formas × 4 caminhos) mede **33 sobreviventes na 1.1.29**.
- **M5 — `test/e2e/url-audit-mv3.test.mjs` é instável na fase serial.** Na minha passagem em lote (um
  Chrome por vez, bytes empacotados) ele vermelhou por **timeout do próprio teste** (300.052 ms) com
  `tests 2, pass 1, fail 0` na contabilidade; reexecutado isolado nos mesmos bytes, passou 2/2 em 42 s. A
  fase serial, portanto, deu **33/35** na passagem única e **34/35** depois de descontada a instabilidade,
  com o vermelho reprodutível sendo `sidepanel-flow-mv3` (assinatura idêntica à da revisão da 1.1.28:
  `tests 9, pass 2, fail 7`, blocos de ~32 s e ~121 s).

### 8.2 Observações (5)

- **O1 — `{"code": "X"}` e `{"assertion": "X"}` em JSON de página sobrevivem a 4 superfícies.** É decisão
  declarada (vocabulário de URL, não de chave) e **não** é regressão; se a classe deve cobrir resposta de
  token OAuth colada na página, falta incluí-las no vocabulário de valor.
- **O2 — `sanitizeJsonData({ href: 'https://h/p?code=X' })` preserva o valor**, porque o ramo
  `URL_ATTRIBUTE_KEYS` chama `sanitizeEvidenceUrl`, que não conhece `code`/`assertion`. Não medi superfície
  entregue que receba um objeto com chave `href`/`src` (no modelo entregue não existe nenhuma chave
  `"href"`); fica como caminho latente a fechar junto (§10, item 5).
- **O3 — o PDF entregue é uma superfície mais estreita.** Ele não carrega o snippet do `<main>` (varredura
  de 24 páginas com `pypdf`: 0/26 sentinelas); carrega snippets por elemento já sanitizados. Para o C1, o
  PDF não foi superfície neste percurso — o que **não** quer dizer que esteja limpo em todos.
- **O4 — `git status --porcelain` vazio.** O brief esperava `?? release/audita-acessibilidade-1.1.29.zip`;
  o zip está **rastreado** (é o estado desejável), então não aparece como não rastreado.
- **O5 — `code X` / `assertion X` como nome acessível não são tarjados** (o vocabulário dessas chaves é só
  de URL) e `<div title>`/`<span title>` não geram nome/descrição no CFT 152 — a medição de `title` só é
  não-vacuosa em elementos cujo nome acessível vem do `title` (input, iframe, botão), como no sentinel 2.

---

## 9. Retratações — o que a minha própria medição não sustentou

- **R1 — `&#58;`/`&#x3a;` não é vazamento ponta a ponta.** No nível unitário
  `sanitizeHtmlSnippetSource('<p>senha&#58; X</p>')` mantém o segredo, mas o produto captura o trecho por
  `DOM.getOuterHTML`, que **re-serializa** o nó de texto com `:` literal; medido: 0 superfícies. Fica como
  buraco latente do sanitizador exportado, não como C1.
- **R2 — a "espera consumida por elemento vazio" não é uniforme.** `<br>`/`<hr>`/`<wbr>`/`<img>` sem
  atributos **preservam** a espera (medido: tarjado); a falha é específica de elemento vazio **com**
  atributos e de elemento vazio **não-void**.
- **R3 — eu esperava regressão em `title`/`alt`/`placeholder` pelo caminho do nome acessível e não
  encontrei**: na mesma página, a 1.1.28 entrega `placeholder` (4 superfícies) e `alt` (2) e a 1.1.29
  entrega 0. O `announcementPreview` herda o nome já tarjado (`computeAccessibleText` recebe
  `node.accessibleName`), então o I1 está fechado nos dois campos.
- **R4 — `div title` é vacuidade, não conserto.** O sentinel 1 mediu `title="chave X"` em `<div>` com 0
  superfícies **nas duas gerações**: o navegador não usa `title` como nome acessível de um `div` com
  conteúdo. A medição de `title` foi refeita com formas em que ele **é** o nome/descrição (§9).
- **R5 — a "custo zero" é verdadeira na página declarada, mas não é propriedade geral.** Medida nos
  artefatos do Google (0 `[redacted]`, 5.228 caracteres), e refutada como afirmação universal pelos
  contraexemplos de §6.2.

---

## 10. O que eu NÃO medi

- **PDF como superfície do C1**: o PDF entregue não carrega o snippet do `<main>` (medido 0/26 sentinelas);
  logo, para as 12 formas do C1 o PDF não é superfície **neste percurso**. Não afirmei que o PDF está
  limpo em todos os percursos — só que, neste, nada chegou a ele.
- **`title` como nome acessível**: o sentinel 1 não conseguiu provar a fonte (`div title` é vácuo). O
  sentinel 2 (`adv129-sentinel2-mv3`) mede `input title`, `button title`, `iframe title`, `span title` e as
  chaves de URL do **escopo** (`?code=`, `#/authorize/code/`) com prova de fonte — resultado em §9.1.
- **Outros caminhos de entrega**: CSV (nenhum sentinela o alcançou — é recorte de achados), painel (0 em
  todos), área de transferência/impressão do navegador, e a exportação por "salvar como" fora do
  `downloads` do Chrome.
- **Batch e auditoria por lista de URLs** (não rodei os E2E de batch com sentinelas próprias; eles
  passaram na fase serial, mas não os instrumentei com segredos meus).
- **Chrome/leitores de tela reais** para o nome acessível calculado: usei a árvore AX do CFT 152 via
  `normalizeSnapshot`, que é o que o produto entrega.
- **`/Users/andrebadini/Downloads/eval_mymonitor.csv`** não foi lido nem citado (dado privado).
- **A fase serial completa**: ver §7.1 para o que foi efetivamente rodado.

Ver §3.1.1 (segundo sentinel).

---

## 11. Caminho de conserto (não aplicado)

Tudo em `src/core/evidence/snippet.js` (o núcleo do problema), com um item em `src/core/privacy.js`:

1. **Decidir antes de emitir.** Em `emitText` (`snippet.js:215-245`), calcular o acumulado
   **decodificado** (`decodeEntities(`${textStream} ${fragment}`)`) **antes** de escolher a saída: se
   `pendingValueRedaction || pendingValueTail || endsWithCredentialLabel(acumulado)`, emitir
   `[redacted]`; caso contrário, emitir `sanitizeText(decodeEntities(fragment))`. Isso fecha A1, A2, A5 e A7
   de uma vez, porque o fragmento que contém o separador deixa de ser emitido às cegas.
2. **Espera não é consumida por estrutura.** No ramo `pendingValueRedaction && !parsed.closing`
   (`snippet.js:309-321`), remover os atributos do elemento candidato mas **manter** a espera até que um
   fragmento de **texto não vazio** seja emitido (ou até um `</…>` que feche o elemento que contém o
   rótulo). Fecha A3, A4, A10 e A13.
3. **Aplicar a regra de cauda também no trecho.** Usar `redactCredentialLabelTail` no lugar de
   `redactSensitiveText` quando o fragmento/acumulado **não** tem separador (`snippet.js:107-109`). Fecha A9.
4. **Sufixo de rótulo com espaço.** Em `VALUE_LABEL_SOURCE` (`privacy.js:64`), permitir
   `(?:[A-Za-z0-9]{0,24}|\s+[A-Za-zÀ-ÿ0-9]{1,16}){0,3}`. Fecha A6 e a família "Chave da API".
5. **Entidades no fragmento e dupla decodificação.** Rodar `decodeEntities` também sobre o fragmento e
   aceitar duas passagens (ou incluir `&#58;`/`&#x3a;`/`&nbsp;`/`&Tab;` no separador). Fecha A5/A7 e R1.
6. **Decisão de produto para A11/A12** (`{"code"}`, `{"assertion"}` em JSON de página): se a classe deve
   cobrir resposta de token OAuth, acrescentar essas chaves ao vocabulário de **valor** em texto/JSON
   (mantendo-as fora do vocabulário de chave do produto, como já está).

---

## 12. Confirmação do checkout congelado

```
$ git -C /private/tmp/audita-review-129 rev-parse HEAD
ab615d5c2bc3b95a223d9a4a87a134fc6fc97c7d
$ git -C /private/tmp/audita-review-129 status --porcelain
(vazio)
$ git -C /private/tmp/audita-review-129 diff --stat
(vazio)
```

Nada foi editado no checkout congelado nem na árvore de desenvolvimento
(`/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`): todas as mutações, cópias, extrações e
instrumentos viveram em `/private/tmp/adv129/`.
