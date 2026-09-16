# Revisão adversarial independente — Audita Acessibilidade 1.1.28

- **Checkout congelado:** `/private/tmp/audita-review-128`, `HEAD e3fbe03a9c8204ee68c6e6bc266e51c46fd1494b` (não editado; ver §7)
- **Artefato medido:** `release/audita-acessibilidade-1.1.28.zip`
  SHA-256 `32647285c4c01aaee3bfc9332718921d131a1754554cb7cfa6a42b69533070e2` (**= o esperado**)
- **Produto medido a partir dos bytes empacotados:** extraído em `/private/tmp/adv128/work/ext`, com
  `test/`, `fixtures/` e `scripts/` copiados para dentro, conforme o brief. Nada foi editado no checkout
  congelado nem na árvore de desenvolvimento.
- **Chrome:** Chrome for Testing 152.0.7977.64 em `/private/tmp/audita-cft152-fixed` (perfil temporário
  isolado, um Chrome por vez). Gerações anteriores extraídas por `git show` para `/private/tmp/adv128/gen`.
- **Instrumentos próprios:** `probes/p1-forms.mjs`, `p3-mono.mjs`, `p4-url.mjs`, `p5-split.mjs`,
  `p6-ident.mjs`, `p7-over.mjs`, `p8-exception.mjs`, `artcheck128.py`, `google-mine128.mjs`, e quatro E2E de sentinela
  (`test/e2e/adv128-sentinel{,2,3,4}-mv3.test.mjs`) escritos por mim dentro da cópia extraída.

---

## 1. Veredito

**A 1.1.28 é estritamente melhor que a 1.1.27 — mas NÃO a substitui como candidata aprovada.**

| | Contagem |
|---|---|
| **Critical** | **1** — a classe do C1 continua aberta, medida ponta a ponta nos bytes empacotados: oito formas de HTML comum que o incremento declara fechadas entregam a credencial inteira (sete provadas ponta a ponta) ao relatório, ao modelo/revisão guardados e aos artefatos HTML e JSON |
| **Important** | **2** — (I1) credencial em `placeholder`/`alt`/`title` chega ao entregável pelo nome acessível, onde a regra de menção não age; (I2) chave de credencial em URL (`?code=`, `#code=`, `#assertion=`, rota `#/authorize/code/…`) continua entregue |
| **Minor** | **4** (+ 6 observações) |

O que a 1.1.28 de fato fechou, medido por mim (tudo com o código do pacote, nunca com o mutante):

- as **sete formas** que a revisão da 1.1.27 listou como vazantes: em `sanitizeJsonData` **0 sobreviventes
  nas sete** (`senha: <S>`, `token: <300 A>`, `{"senha": "S"}`, `senha: ""S`, `senha: "S" tail-S`,
  `senha: p4<S`, `senha -> S`); em `sanitizeHtmlSnippetSource` **0 nas seis primeiras**, e em
  `senha: p4<S` sobra a cauda depois do `<` (`senha: [redacted]&lt;S3CR3TX9`), porque o `<` abre um token
  que o sanitizador devolve como texto — é a forma `d6`/`n40` da tabela (§3.1);
- o **valor no elemento seguinte** e a **subárvore profunda** nas formas simples (`<p>senha: <code>X</code></p>`,
  `<th>chave:</th><td>X</td>`, `<dl><dt>senha:</dt><dd>X</dd>`, `<div title=…>` fundo): 0 sobreviventes —
  eram vazamento nas três gerações anteriores;
- a **exceção ancorada do atributo de rótulo**, nos dois lados, no sanitizador de trecho:
  `aria-label="Senha S"`, `title="senha abc"`, `alt="token abc"`, `placeholder="senha do usuário"`
  são descartados; `aria-label="Senha"`, `aria-label="Password"`, `title="Endereço"` sobrevivem;
- o **fragmento de URL com `code`** no caminho do trecho: `#/authorize?code=S`, `#access_token=S`,
  `#token=S`, `#/callback?id_token=S` perdem o fragmento; `?lang=pt#secao` preserva (a regressão M3 da
  1.1.27 está fechada **neste caminho**; ver M5 para o outro);
- os **plurais em português**: 12 formas com e sem acento, em rótulo, chave e URL, todas tarjadas —
  **zero perdas** de forma de credencial no meu universo (§3.4);
- os **números do produto**: 14.747 identificadores distintos em `src/**/*.js`, radical da 1.1.26 casando
  **325** e o da 1.1.28 casando **247**, família `auth` de **107** para **25** — reproduzidos exatamente;
- o **artefato**: digest, 199 entradas, pacote↔árvore idênticos nos dois sentidos, reconstrução
  reproduzindo o digest, e o zip **rastreado** no git (§2).

O que impede a substituição é que o Critical que a 1.1.28 se propôs a fechar **não está fechado**: o
maquinário novo (`pendingValueRedaction`) exige que **rótulo e separador estejam no mesmo fragmento de
texto** e deixa um **elemento vazio** consumir a espera. Medido ponta a ponta: `<p>senha:<br>X</p>`,
`<pre><span>senha</span>: <span>X</span></pre>` (código com realce de sintaxe),
`<th>chave<span>:</span></th><td>X</td>`, `<p>senha:</p><hr><p>X</p>`,
`<p>senha: p4<span>X</span></p>`, `<pre>{\"senha\": \"X\"}</pre>` e
`<pre>{&quot;senha&quot;: &quot;X&quot;}</pre>` chegam **inteiros** ao relatório, ao modelo/revisão
guardados, ao HTML e ao JSON entregues. É a mesma classe, as mesmas superfícies e a mesma severidade do
C1 da 1.1.27 — o incremento mudou a forma do fixture, não a classe do defeito.

Como **linha de base de trabalho**, a 1.1.28 deve substituir a 1.1.27: em todas as medições que fiz ela é
igual ou melhor (zero regressões em 1.1.28 × 1.1.27, 1.1.26 e 1.1.24; no mesmo fixture de sentinelas,
48 vazamentos com os sanitizadores da 1.1.27 contra 34 com os da 1.1.28, e os 14 restantes são
exatamente as formas que ela não declara cobrir). Ela **não** substitui a 1.1.25/1.1.27 como candidata
aprovada enquanto C1 estiver aberto, pela regra do próprio projeto ("nenhuma versão desta sessão foi
declarada candidata com Critical/Important aberto").

---

## 2. Artefato e integridade (item 7) — tudo reproduzido, inclusive a observação anterior

```
$ shasum -a 256 release/audita-acessibilidade-1.1.28.zip
32647285c4c01aaee3bfc9332718921d131a1754554cb7cfa6a42b69533070e2   (= esperado)
$ unzip -l release/audita-acessibilidade-1.1.28.zip | tail -3
  4268668                     199 files

$ python3 (comparação byte a byte, dois sentidos)
zip: 199  tree(runtime declarado: manifest.json + src/ + vendor/ + icon-16/32/48/128): 199  iguais: True
only in zip: []   only in tree: []   content differs: []

$ git -C /private/tmp/audita-review-128 ls-files --error-unmatch release/audita-acessibilidade-1.1.28.zip
release/audita-acessibilidade-1.1.28.zip          # RASTREADO (a observação O5 da 1.1.27 está resolvida)
$ git status --porcelain
(vazio)

$ cd clone && node scripts/build-release.mjs
SHA-256 32647285c4c01aaee3bfc9332718921d131a1754554cb7cfa6a42b69533070e2   (= o entregue)
```

A árvore contém dois arquivos de ícone que **não** entram no pacote (`icon-1024.png`, `icon-source.svg`):
é a única diferença entre "todos os arquivos da árvore" (201) e o conjunto de runtime (199), e está
correta — não são referenciados pelo `manifest.json`.

Gate declarado (`release-package` + `extension-shell` + `release-assets`), no clone com histórico:

```
$ node --test --test-concurrency=1 test/release-package.test.js test/extension-shell.test.js test/release-assets.test.js
ℹ pacote conferido byte a byte: 199 arquivos idênticos à árvore revisada
ℹ tests 20   ℹ pass 20   ℹ fail 0
```

**Ressalva de escopo:** eu conferi o pacote contra a **árvore do HEAD** (`e3fbe03`), que é o que o
portão compara; o digest fixado no teste é o do zip entregue, e a reconstrução bate — ou seja, um fonte
que andasse sem rebuild reprova pelos dois lados, como o teste afirma.

---

## 3. Cada item declarado

### 3.1 Item 1 — C1: **fechado nas sete formas da tabela da 1.1.27; a classe continua aberta** → ver C1

Comando: `node probes/p1-forms.mjs` (sanitizadores das quatro gerações importados por `git show`).
Métrica: ocorrências do **segredo inteiro** na saída (0 = limpo).

| Entrada (no pacote) | 1.1.24 s/j | 1.1.26 s/j | 1.1.27 s/j | **1.1.28 s/j** |
|---|---|---|---|---|
| `senha: <S3CR3TX9>` | 0/1 | 0/1 | 0/1 | **0/0** |
| `token: <` +300`A>` | 0/1 | 0/1 | 0/1 | **0/0** |
| `{"senha": "S3CR3TX9"}` | 1/1 | 1/1 | 1/1 | **0/0** |
| `senha: ""S3CR3TX9` | 1/1 | 1/1 | 1/1 | **0/0** |
| `senha: "S3CR3TX9" tail-S3CR3TX9` | 2/2 | 2/1 | 1/1 | **0/0** |
| `senha: p4<S3CR3TX9` | 1/1 | 1/1 | 1/1 | **1/0** ← sobra a cauda depois do `<` |
| `senha -> S3CR3TX9` | 1/1 | 1/1 | 1/1 | **0/0** |

(s = `sanitizeHtmlSnippetSource`, j = `sanitizeJsonData`; tabela comparativa completa em
`probes/p1-forms.mjs`, com as 58 formas.)

**Formas minhas que ainda sobrevivem na 1.1.28** (saída crua, pacote extraído):

```
--- n26 rotulo, <br>, valor inteiro
    snippet: "<p>senha:<br>S3CR3TX9</p>"
--- n10 th/td com <br> no meio
    snippet: "<table><tr><th>chave:</th><br><td>S3CR3TX9</td></tr></table>"
--- n18 entidade &quot; JSON
    snippet: "<pre>{&quot;senha&quot;: &quot;S3CR3TX9&quot;}</pre>"
    json   : "<pre>{&quot;senha&quot;: &quot;S3CR3TX9&quot;}</pre>"
--- n29 JSON com aspas escapadas \"
    snippet: "<pre>{\"senha\": \"S3CR3TX9\"}</pre>"
    json   : "<pre>{\"senha\": \"S3CR3TX9\"}</pre>"
--- d6/n40 mesmo no: senha: p4<S
    snippet: "<p>senha: [redacted]&lt;S3CR3TX9</p>"      (a cauda depois do `<` sobrevive)
```

**Confirmado ponta a ponta com o E2E de sentinelas** (`test/e2e/adv128-sentinel-mv3.test.mjs`, fixture
própria com um sentinela distinto por forma, rodado nos bytes empacotados). Cada linha abaixo é uma
forma **presente na página** (a prova de fonte não acusou nenhuma ausente) e **ausente de todas as
superfícies** que a varredura cobre:

```
forma                                                     relatório  modelo/revisão  artefato html  artefato json
br-void (rotulo: <br> valor inteiro)  BRSENT01A              1            1               1              1
separador em outro no  SEPSENT02B                            1            1               1              1
th span: / td  THSENT03C                                     1            1               1              1
JSON com aspas escapadas \"  ESCSENT04D                      1            1               1              1
entidade &quot; literal  ENTSENT05E                       1            1               1              1
rotulo </p> <hr> <p> valor  HRSENT06F                        1            1               1              1
valor comeca no no e continua no span  TAILSENT07G          1            1               1              1
```

Exemplo do que ficou gravado no artefato JSON entregue (campo `snippet`):

```
"<main><h1>Página avaliada</h1> <p id=\"credential-text\">senha: [redacted]</p>
 <p id=\"adv-br\">senha:<br>BRSENT01A</p> <pre id=\"adv-sep\"><span class=\"k\">senha</span>:
 <span class=\"s\">SEPSENT02B</span></pre> …
```

**Causa raiz (medida no código do pacote, `src/core/evidence/snippet.js:197-218` e `280-292`):**
`pendingValueRedaction` só é armado quando **o mesmo fragmento de texto termina** em rótulo + separador
(`endsWithCredentialLabel`), e é **consumido por qualquer elemento**, inclusive vazio/auto-fechado:

- `<p>senha:<br>VALOR</p>` → o `<br>` (void) zera a espera (`pendingValueRedaction = false` na linha 282)
  e o valor seguinte é emitido por `sanitizeText` sem rótulo → íntegro;
- `<span>senha</span>: <span>VALOR</span>` → três fragmentos (`senha`, `: `, `VALOR`); nenhum termina em
  rótulo **com** separador → nada é tarjado (é a forma clássica de realce de sintaxe / Prism / Highlight.js);
- `<th>chave<span>:</span></th><td>VALOR</td>` → o rótulo fica num fragmento, o separador noutro;
- `senha: p4<span>VALOR</span>` → o primeiro fragmento não termina no rótulo+separador (termina no
  `p4` que já foi consumido), e a cauda no `<span>` não tem rótulo;
- `{\"senha\": …}` e `{&quot;senha&quot;: …}` → o separador do `redactSensitiveText` é
  `(\s*['"]?\s*(?:[:=]|->|=>|→)\s*)` (`src/core/privacy.js:56`) e não aceita `\` nem `&quot;` entre o
  rótulo e os dois pontos, então **nem o caminho de texto** (`sanitizeJsonData`) casa — o segredo
  sobrevive nos dois caminhos.

### 3.2 Item 2 — regra de atributo de rótulo: **os dois lados fecham no trecho; a credencial ainda chega ao entregável por outro caminho** → ver I1

Sanitizador de trecho, 1.1.28 (pacote):

```
<input aria-label="Senha S3CR3TX9">           -> "<input>"
<div title="senha abc123">x</div>             -> "<div>x</div>"
<img alt="token abc123">                      -> "<img>"
<input placeholder="senha do usuário">        -> "<input>"
<input aria-label="Senha" type="password">    -> "<input aria-label=\"Senha\" type=\"password\">"
<input aria-label="Password" type="password"> -> "<input aria-label=\"Password\" type=\"password\">"
<div title="Endereço">x</div>                 -> "<div title=\"Endereço\">x</div>"
```

Tentei quebrar a exceção ancorada (`SENSITIVE_LABEL_ONLY = ^(?:SENSITIVE_KEY)$`, `snippet.js:25`) com
`node probes/p8-exception.mjs` — 37 valores: **9 passam a exceção e todos os 9 são o rótulo puro**
(`Senha`, `Password`, `pass`, `pwd`, `token`, `api key`, `one-time`, `cpf`, `chave`); **nenhum** valor que
carregue o sentinela passou (`Senha S`, `senha: S`, `senha S`, `senha\u00a0S`, `senha\nS`, `senha\tS`,
`senhaXS`, `xsenha S`, `tokens S`, `token=S`, `{senha:S}`, `"senha":"S"`, `senha&#58; S`, `senha&#x3a; S`,
`senha: &quot;S&quot;`, `senha" S`, `senha' S`, `senha->S`, `senha → S`, `S`, `Bearer S`, `chave secreta S`,
`credenciais S`, `senhas S` — todos descartados ou tarjados; `Bearer S` vira `title="Bearer [redacted]"`).
**A exceção ancorada, em si, está correta.** Duas notas de escopo: a regra é **por menção**, então
`title="S3CR3TX9"` (sem palavra do vocabulário) sobrevive por desenho (observação O6), e o que não está
coberto é a **outra camada**: o **nome acessível** calculado a partir desses atributos vira
`accessibleName`/`announcementPreview` e vai para o entregável sem passar pela regra de menção — ver I1.

### 3.3 Item 3 — fragmento de URL: **fechado no sanitizador de trecho; não fechado no caminho `sanitizeEvidenceUrl`; e a lista nova de chaves é incompleta** → ver I2 e M5

`node probes/p4-url.mjs` (sentinela neutro `Zq7Xk2`, sobreviventes na saída):

```
href-no-trecho (snippet.js)          1.1.24 1.1.26 1.1.27 1.1.28
#/authorize?code=S                      0      0      1      0     <- M3 da 1.1.27 FECHADO aqui
#access_token=S                         0      0      0      0
#token=S                                0      0      0      0
#/callback?id_token=S                   0      0      0      0
?lang=pt#secao (preservar)              0      0      0      0
#code=S (sem ?)                         1      1      1      1     <- FRAGMENT_CREDENTIAL_KEY exige ?&; ou início
#assertion=S (sem ?)                    1      1      1      1
#/authorize/code/S (rota)               0      0      1      1
?code=S (consulta)                      1      1      1      1
?assertion=S (consulta)                 1      1      1      1

sanitizeEvidenceUrl (privacy.js)
#/authorize?code=S                      0      0      1      1     <- NÃO fechado neste caminho
#author= / #compass=                    0      0      1      1     (preservações declaradas)
#code= / #assertion= / ?code= / ?assertion=   1 em todas as gerações
```

Ponta a ponta (E2E de sentinelas, 1.1.28), com o sentinela **presente na página**:

```
[QCODE29E]   href ?code=S (consulta)              -> relatório, modelo/revisão, html, json (+ PDF)
[IFRAMECD26B] iframe src #code=S                  -> relatório, modelo/revisão, html, json (+ PDF)
[IFRAMEAS27C] iframe src #assertion=S             -> relatório, modelo/revisão, html, json (+ PDF)
[IFRAMEQ31G]  iframe src ?code=S                  -> relatório, modelo/revisão, html, json (+ PDF)
[ROUTE28D]   href #/authorize/code/S (rota)       -> relatório, modelo/revisão, html, json
[QASSERT30F] href #assertion=S                    -> relatório, modelo/revisão, html, json
                                       (limpos: #/authorize?code=, #access_token=, #token=, #secao)
```

O PDF entregue também carrega três dessas formas no apêndice de trechos (`extract_text` do PDF do meu
E2E: `HREFCODE14N`, `IFRAMECD26B`, `IFRAMEAS27C`, `IFRAMEQ31G`), ou seja I2 alcança **cinco** superfícies.

### 3.4 Item 4 — monotonicidade do vocabulário: **REPRODUZIDA, zero perdas, 32 ganhos**

`node probes/p3-mono.mjs` — 118 formas de credencial × 3 caminhos (rótulo de valor = `redactSensitiveText`,
chave = `sanitizeJsonData`, URL = `sanitizeEvidenceUrl`) × 4 gerações:

```
===== PERDAS da 1.1.28 (limpo numa geração anterior -> vaza agora) =====
(nenhuma)
===== ganhos da 1.1.28 =====  32 (todos os plurais em português, com e sem acento)
```

Plurais, na 1.1.28 (0 = tarjado), nas três superfícies `rótulo|chave|url`:
`senhas 0|0|0`, `segredos 0|0|0`, `credenciais 0|0|0`, `sessões 0|0|0`, `sessoes 0|0|0`,
`autenticações 0|0|0`, `autenticacoes 0|0|0`, `autorizações 0|0|0`, `autorizacoes 0|0|0`,
`chaves 0|0|0`, `cartões 0|0|0`, `cartoes 0|0|0` — todas vazavam nas três gerações anteriores.
Controle de inocentes (30 palavras declaradas preservadas): as mesmas 5 tarjadas por engano nas quatro
gerações (`surpass`, `trespass`, `overpass`, `obsessão`, `obsessao`), nenhuma nova.

Números do produto (`probes/p6-ident.mjs`, 14.747 identificadores distintos em `src/**/*.js`):

```
1.1.24: casam=348   familia auth casam=107
1.1.26: casam=325   familia auth casam=107
1.1.27: casam=246   familia auth casam=25
1.1.28: casam=247   familia auth casam=25      <- declarado: 325 -> 247, auth 107 -> 25  ✓
```

### 3.5 Item 5 — números declarados: **todos conferem, exceto um (off-by-one da classe que o incremento diz fechar)**

| Alegação | Meu comando | Medido | Veredito |
|---|---|---|---|
| Suíte sem `test/e2e/`: **4.157** testes, **4.155** passam, 1 pulado, 0 falham | `node --test --test-concurrency=4 $(find test -name '*.test.js' -o -name '*.test.mjs' \| grep -v '^test/e2e/' \| sort)` (177 arquivos) no clone com histórico | **tests 4157, pass 4156, fail 0, skipped 1, todo 0** (51,9 s) | total, pulado e falhas **exatos**; **passam = 4.156**, não 4.155 → **M3** |
| Gate `release-package`+`extension-shell`+`release-assets` **20/20** com o digest fixado | `node --test --test-concurrency=1` dos três | **20/20**, com "pacote conferido byte a byte: 199 arquivos idênticos" | **REPRODUZIDO** (e o entregue + a reconstrução batem no digest fixado) |
| Fase serial de 35 arquivos: **34 verdes**, único vermelho `sidepanel-flow-mv3` | `/private/tmp/serial-run.sh` sobre a lista `scripts/run-tests.mjs` → `REAL_CHROME_E2E` (35), no clone | ver §3.6 | ver §3.6 |
| Google real do pacote: 0 falhas, 1 alerta, 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações `complete`, versão 1.1.28 | `google-mine128.mjs` contra `work/ext` | `version 1.1.28`; cartões: `Recomendações e alertas 1 verificação · 1 ocorrência`, `Suspeitas a confirmar 3 verificações · 4 ocorrências`, `Resultados positivos 9 verificações`; `0 verificações com falha confirmada (0 ocorrências)`; `Checklist separado: 109`; `Cobertura automática: 28,5%`; `motor próprio 9,0 / 10`; PDF **18 páginas**; 4 downloads `complete` (2,1 s); 0 frases legais | **REPRODUZIDO** (o tempo é dependente de ambiente) |
| Artefato entregue: **146/146 ids e títulos**, 0 palavras partidas, notas **5/5** nos dois formatos, proveniência nos dois | `artcheck128.py` sobre os meus artefatos do Google | 146 itens, 146 ids únicos, 146 títulos; **0 ids e 0 títulos ausentes no HTML e no PDF**; 0 títulos não contíguos no PDF; notas **5/5 no HTML e 5/5 no PDF**; `canonicalModelHash`, `exportDeliveryIdentity.modelHash`, `auditId` e versão presentes nos dois | **REPRODUZIDO** (o CSV é um recorte de achados: 34 ids/36 títulos ausentes, como nas versões anteriores) |
| "custo zero": snippets de **5.228** caracteres com **zero** `[redacted]` nos artefatos da 1.1.27 e da 1.1.28 | `artcheck128.py` nos meus artefatos (1.1.28) e nos do revisor anterior da 1.1.27 | 1.1.28: 11 snippets, **5.228** caracteres, `[redacted]` = **0** em JSON, HTML e CSV; 1.1.27 (mesma página, sessão distinta): 11 snippets, **5.228**, `[redacted]` = 0 | **REPRODUZIDO nos dois** |
| Plurais / vocabulário do produto (14.747; 325→247; auth 107→25) | `probes/p6-ident.mjs` | 14.747; 325→247; 107→25 | **REPRODUZIDO exatamente** |
| "Os **16 testes de escopo** verdes na raiz extraída do zip" | — | não há comando nem lista declarada; 35 arquivos têm 51 `test()` e o runner classifica 35 como serial + 2 como process-safe | **NÃO REPRODUZÍVEL como número** (observação O2); o que medi: o E2E de exportação passa na raiz extraída |

### 3.6 Fase serial (35 arquivos, um Chrome por vez) — **REPRODUZIDA**

Runner: `/private/tmp/adv128/run-serial.sh` sobre a lista de 35 arquivos que o próprio
`scripts/run-tests.mjs` classifica como `REAL_CHROME_E2E` (idêntica a `/private/tmp/serial-files.txt`),
no clone com histórico, nos bytes empacotados, um arquivo por vez:

```
resumo: 34 arquivos verdes, 1 com falha
test/e2e/sidepanel-flow-mv3.test.mjs
```

O vermelho é o arquivo de outro incremento (modificado na árvore de desenvolvimento, `+87/−8` contra
`e6c2619`), e no clone ele falha por **timeout de harness**, não por asserção de produto: `ℹ tests 9,
pass 2, fail 7`, com `WAIT_TIMEOUT` (4), `CDP_COMMAND_TIMEOUT` (2) e
`FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED` (1), em blocos de ~30 s (`real-chrome.mjs:330` → `waitForValue`
estourando em `sidepanel-flow-mv3.test.mjs:1043`). Ver §6 para o que não triei desse arquivo.

### 3.7 Item 6 — mutação do E2E e não vacuidade: **REPRODUZIDAS com código meu, não com o mutante do autor**

Mutação feita por mim, em cópia (`/private/tmp/adv128/work/mutant`), restaurando **os dois** arquivos
de `d9a67e7` (1.1.27) e deixando todo o resto da 1.1.28 intacto:

```
$ shasum -a 256 work/mutant/src/core/privacy.js work/mutant/src/core/evidence/snippet.js
dac185c4c694e611eb0d4df1df93ef8ba41a446a0011a670ce75e41659b2de4c
db3de24876570df9fd28939b88d1db89389b5c5fe44578ba4607a772a9aaa023
$ node -e "import('./src/core/evidence/snippet.js')..."   -> ok (mutante autoconsistente)

# com o código do PACOTE (work/ext)
✔ current-page audit exports four verified artifacts (4306.4155ms)
ℹ segredos varridos=3; superfícies=9        ℹ tests 1  ℹ pass 1  ℹ fail 0

# com os sanitizadores da 1.1.27 (work/mutant)
✖ current-page audit exports four verified artifacts (3511.200833ms)
  AssertionError: credencial da página chegou ao entregável em:
  relatório, modelo e revisão guardados, artefato html, artefato json
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

**Não vacuidade da espera acrescentada.** O diff de `test/e2e/current-page-export-mv3.test.mjs` **só
adiciona** a espera (linhas 65-67) antes da leitura dos cartões; `assert.ok(candidates.length > 0, …)`
continua na linha 70 e `waitForValue` **rejeita** no timeout (`WAIT_TIMEOUT`), com teste próprio em
`test/e2e/support/real-chrome.test.mjs:489` (`assert.rejects(...)`). Não há caminho silencioso: espera que
não chega lança, e a asserção de ao menos um achado confirmado permanece.

**Não vacuidade da varredura.** Além da mutação acima, medi cada forma com sentinela próprio
(§3.1–§3.3): todas estavam presentes na página-fonte e as que vazam apareceram nas quatro superfícies.
A prova de fonte do produto, porém, é **por valor** e não por forma — observação O1.

---

## 4. Achados

### C1 — **Critical** (pré-existente; a 1.1.28 declara a classe fechada e ela não está)

**Descrição.** A classe do C1 da 1.1.27 — rótulo e valor separados por marcação — continua entregando a
credencial ao relatório, ao modelo/revisão guardados e aos artefatos HTML e JSON. O maquinário novo
exige rótulo **e** separador no mesmo fragmento de texto e deixa um elemento vazio consumir a espera,
então oito formas comuns de HTML passam inteiras.

**Medição 1 — sanitizador empacotado** (`probes/p1-forms.mjs`, `p5-split.mjs`): saídas cruas na §3.1.
Nove formas com parte do segredo presente na saída, **oito delas com o segredo inteiro** (`n26` `<br>`,
`n10` `<br>` entre rótulo e `<td>`, `n18` `&quot;`, `n29` `\"`, `HRSENT06F` `<hr>`, `SEPSENT02B`,
`THSENT03C`, `TAILSENT07G`) e uma com a cauda (`senha: p4<S…`).

**Medição 2 — ponta a ponta nos bytes empacotados.** Escrevi quatro E2E de sentinela dentro da cópia
extraída (mesmo percurso do E2E do produto, fixture minha com um sentinela distinto por forma, prova de
fonte por sentinela). Sete formas de texto chegam a quatro superfícies (§3.1). O teste do produto com o
código atual passa (`✔ 1/1`), e com os sanitizadores da 1.1.27 reprova nomeando as superfícies (§3.7) —
ou seja, a varredura do produto pega a classe; o que ela não cobre é **estas formas** no fixture.

**Por que é Critical e não Important.** É literalmente o critério da severidade original: "a credencial
chega ao modelo guardado, ao relatório e aos artefatos HTML/JSON entregues". `<p>senha:<br>X</p>` e
`<pre><span>senha</span>: <span>X</span></pre>` (realce de sintaxe) estão entre os layouts mais comuns de
credencial em HTML, e a segunda é a forma como Prism/Highlight.js serializam **qualquer** JSON ou
`key: value` — inclusive `"senha": "…"`.

**Caminho exato do conserto (não aplicado).**
1. `src/core/evidence/snippet.js:197-218` — trocar o booleano por uma máquina de dois estados:
   `pendingValueLabel` (armado quando o fragmento **termina** em rótulo de credencial, com ou sem
   separador) e `pendingValueRedaction` (armado quando o fragmento termina no rótulo **ou** é só o
   separador `[:=]|->|=>|→`), consumindo o valor no próximo fragmento **não vazio**. `endsWithCredentialLabel`
   (`src/core/privacy.js:210`) já resolve o caso "rótulo+separador"; falta o caso "só o rótulo" e o
   "só o separador" — que podem ser derivados exportando um `isCredentialLabelFragment`/`isValueSeparatorFragment`.
2. `src/core/evidence/snippet.js:281-285` — **não** consumir `pendingValueRedaction` em elemento vazio
   ou auto-fechado: manter a espera (apenas remover os atributos desse elemento, como já faz
   `stripValueAttributes`) para que o valor no **texto depois dele** também seja tarjado. Hoje
   `<p>senha:<br>X</p>` e `<p>senha: <img src=x>X</p>` vazam por causa disso.
3. `src/core/privacy.js:56` — aceitar a aspa escapada e a entidade no separador:
   `(?:\s*(?:\\?['"]|&quot;|&#0?39;|&apos;)?\s*(?:[:=]|->|=>|→)\s*)`, mantendo o `$1$2[redacted]`.
4. Prova: acrescentar ao fixture do E2E as formas `<p>senha:<br>X</p>`,
   `<pre><span>senha</span>: <span>X</span></pre>`, `<th>chave<span>:</span></th><td>X</td>` e
   `<pre>{\"senha\": \"X\"}</pre>` — sem isso o portão continua sem cobrir a classe.

### I1 — **Important**: credencial em `placeholder`/`alt`/`title` chega ao entregável pelo nome acessível (pré-existente)

**Descrição.** A regra de menção do trecho (item 2) descarta o **atributo**, mas o **nome acessível**
calculado a partir dele (`placeholder`, `alt`, `title` como fonte de nome) é publicado em
`accessibleName`/`announcementPreview`/`accessiblePreview` e vai para o relatório, o modelo e os
artefatos. `redactSensitiveText` não socorre: `senha do usuário` não tem separador.

**Medição (E2E de sentinelas, código do pacote):**

```
[PLASENT11K]  input placeholder="senha do PLASENT11K"  -> relatório, modelo/revisão, html, json
[PLASENT2X23Y] input placeholder="senha PLASENT2X23Y"  -> relatório, modelo/revisão, html, json
[ALTSENT10J]  img alt="token ALTSENT10J"               -> modelo/revisão, json
[TITLEIMG22W] img title="senha TITLEIMG22W" (sem alt)  -> modelo/revisão, json
[ARISENT08H]  div aria-label="Senha ARISENT08H"        -> limpo em todas
[TITSENT09I]  div title="senha TITSENT09I"             -> limpo em todas
```

Bytes do artefato JSON entregue:

```
"announcementPreview":"senha do PLASENT11K, campo de texto"
"accessiblePreview":"senha do PLASENT11K, campo de texto"
"announcementPreview":"token ALTSENT10J, imagem"
"announcementPreview":"senha TITLEIMG22W, imagem"
```

E no HTML entregue: `<p><strong>Nome acessível:</strong> senha do PLASENT11K.</p>`.

**Regressão?** Não — a 1.1.27 faz igual (no mesmo fixture, 48 vazamentos contra 34; `aria-label` e
`title` de `<div>` vazavam lá e estão limpos aqui). É **pré-existente**, mas **falsifica a declaração do
item 2** no nível do entregável: `placeholder="senha do usuário"` **não** é descartado do produto, só do
trecho.

**Caminho exato do conserto (não aplicado).** Exportar de `src/core/privacy.js` o predicado ancorado
(hoje `SENSITIVE_LABEL_ONLY`, `src/core/evidence/snippet.js:25`) e aplicá-lo em `redactNormalizedNode`
(`src/core/privacy.js:325-403`) aos campos derivados de atributo de rótulo: quando
`nameSource ∈ {placeholder, alt, title, aria-label}` e o valor menciona credencial sem ser **só** o
rótulo, zerar `accessibleName`, `announcementPreview`, `accessiblePreview`, `axValue` e
`accessibleDescription` (ou tarjar o valor). A alternativa no produtor é `src/core/accessibility/accessible-name.js:178-208`
+ `src/core/accessibility/element-accessibility.js:110`, mas a barreira final (`redactNormalizedNode`) é
o lugar onde a regra não pode ser esquecida. Prova: acrescentar ao fixture do E2E
`<input placeholder="senha X">` e `<img alt="token X">` — a varredura atual é cega a essa classe (o
fixture usa `data-note`, que não é atributo de rótulo).

### I2 — **Important**: chave de credencial em URL continua entregue (`?code=`, `#code=`, `#assertion=`, rota) (pré-existente; a lista nova é que está incompleta)

**Descrição.** A 1.1.28 criou `FRAGMENT_CREDENTIAL_KEY` (`src/core/evidence/snippet.js:30`) e o aplicou
**só** ao fragmento e **só** quando a chave é precedida de `?`, `&`, `;` ou está no início. A consulta
continua filtrando por `SENSITIVE_KEY`, que não conhece `code`, `assertion` nem `saml_response`. O
resultado é que o próprio `code` que o incremento classifica como credencial sobrevive na consulta
(`?code=`) e no fragmento sem `?` (`#code=`), e a rota `#/authorize/code/…` (sem `=`) sobrevive.

**Medição ponta a ponta** (§3.3): `?code=`, `#code=`, `#assertion=`, `#/authorize/code/…` → relatório,
modelo/revisão, HTML e JSON; três delas também no PDF entregue. Unidade: `?code=`, `#code=`,
`#assertion=` sobrevivem em **todas as quatro gerações** (pré-existente); `#/authorize?code=` é uma
regressão da 1.1.27 que a 1.1.28 fechou no trecho e **não** fechou no `sanitizeEvidenceUrl` (M5).

**Caminho exato do conserto (não aplicado).** Um predicado único e compartilhado em `src/core/privacy.js`:
`isCredentialKey(name) = SENSITIVE_KEY.test(name) || /^(?:code|assertion|saml[-_]?response|access[-_]?token|refresh[-_]?token|id[-_]?token)$/iu.test(name)`,
usado nos **quatro** pontos: `sanitizeEvidenceUrl` (query, `privacy.js:187`), `sanitizeEvidenceUrl`
(fragmento, `privacy.js:188`), `sanitizeUrl` do trecho (query e fragmento, `snippet.js:94-95`), e
`FRAGMENT_CREDENTIAL_KEY` estendido para `(?:^|[#?&;])` e para a forma de rota
(`/(?:^|[#?&;])(?:code|token|assertion|…)(?:=|/)`). Prova: as URLs da §3.3 no fixture do E2E.

### M1 — **Minor**: a mesma classe do plural — rótulo com letras depois da palavra não é tarjado (pré-existente)

`probes/p3-mono.mjs`, caminho de **rótulo de valor**, 1.1.28 (= idêntico nas três anteriores):
`tokens: S` , `secrets: S`, `sessions: S`, `cookies: S`, `apiKeys: S`, `api_keys: S`, `authTokens: S`,
`oauth2: S`, `sessionId: S`, `authentication: S`, `assertion: S`, `bearer: S`, `saml_response: S`,
`senhaAtual: S`, `senhaDoUsuario: S`, `chaveDeApi: S`, `credencialDeAcesso: S`, `credenciaisDeAcesso: S`,
`cartaoDeCredito: S` → **0 redação** (o valor sobrevive). Todas são tarjadas no caminho de **chave**
(substring) e na regra de **menção**; só o tarjador de valor falha, porque o separador precisa vir
imediatamente depois do radical casado.

**Medição ponta a ponta** (`test/e2e/adv128-sentinel4-mv3.test.mjs`, código do pacote, sentinela próprio
por forma, nenhuma ausente da página-fonte): **10 formas × 4 superfícies = 40 vazamentos**, todas no
relatório, no modelo/revisão guardados, no HTML e no JSON entregues:

```
tokens: TOKSENT01A   secrets: SECSENT02B   sessions: SESSENT03C   cookies: COOKSENT04D
senhaAtual: SENHASENT05E   credenciaisDeAcesso: CREDSENT06F   chaveDeApi: CHAVESENT07G
bearer: BEARSENT08H   authentication: AUTHSENT09I   apiKeys: APIKSENT10J
```

Não é perda (as quatro gerações são iguais), mas é a **mesma classe** do Minor de plurais que o
incremento declara fechado — e o plural inglês (`tokens`, `secrets`, `sessions`, `cookies`) ficou de fora
da correção. **Gradação:** mantenho **Minor** por coerência com a revisão da 1.1.27, que graduou a lacuna
de vocabulário (plurais) como Minor; se o critério for o do C1 ("a credencial chega ao entregável"), as
10 formas medidas são da mesma classe de exposição — a medição está acima para quem quiser regradar.
Conserto: acrescentar as flexões (`tokens?|secrets?|sessions?|cookies?|assertion|bearer|saml[-_]?response|api[-_]?keys?|authTokens?` e os
compostos já cobertos por substring na chave) ao `VALUE_LABEL_SOURCE` e **medir o custo de falso positivo**
antes (é a lista que decide o tarjamento de texto visível).

### M2 — **Minor**: valor dividido por `<br>`/quebra de linha deixa a cauda (pré-existente)

`probes/p5-split.mjs` — maior pedaço contíguo do valor que sobrevive:

```
entrada                                 1.1.24     1.1.26     1.1.27     1.1.28
<p>senha: S3CR<br>3TX9</p>              S3CR(4/8)  S3CR(4/8)  3TX9(4/8)  3TX9(4/8)
<p>senha: S3<br>CR3TX9</p>              CR3TX9(6)  CR3TX9(6)  CR3TX9(6)  CR3TX9(6)
<pre>senha: S3CR\n3TX9</pre> (texto)     S3CR(4)    3TX9(4)    3TX9(4)    3TX9(4)
<p>senha: S3CR<span>3TX9</span></p>     S3CR(4)    3TX9(4)    3TX9(4)    3TX9(4)
```

A cauda (até 6 dos 8 caracteres) sobrevive porque o valor é, por desenho, "até a quebra de linha do
fragmento" — e o `<br>`/a nova linha cortam o valor em dois fragmentos. Pré-existente nas quatro
gerações; o conserto é o mesmo do C1 (a espera tem de atravessar o corte), mas registro em separado
porque **não** é o caso do segredo inteiro.

### M3 — **Minor**: o número de testes que passam está errado por um, na classe que o incremento diz fechar

Declarado em `docs/qa/2026-09-13-continuity-and-e2e-triage.md:2317` e `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md:124`:
"**4.157** testes, **4.155 passam**, 1 pulado, 0 falham". Medido (comando e seleção declarados no próprio
documento): `tests 4157, pass 4156, skipped 1, fail 0`. A decomposição declarada não fecha
(4.155 + 1 pulado = 4.156 ≠ 4.157); o correto é **4.156 passam**. É a mesma classe do M4 da 1.1.27
("4.154 passam" × 4.155) que a 1.1.28 lista como corrigida — a correção pegou o total e deixou a
parcela. Conserto: uma linha em dois documentos.

### M4 — **Minor**: o custo do fail-closed continua o mesmo (declarado, alcance não exercitado)

`probes/p7-over.mjs`: `<p>Senha: use pelo menos 8 caracteres. Veja nossas dicas de segurança.</p>` →
`<p>Senha: [redacted]</p>` (60 caracteres de texto de ajuda perdidos); `<label>Sessão: expira em 30 minutos</label>`
→ `<label>Sessão: [redacted]</label>`; `<p>Autorização: o usuário precisa confirmar o e-mail…</p>` →
`<p>Autorização: [redacted]</p>`. Prosa sem rótulo+separador não é tocada. É regressão da 1.1.27 mantida
igual, declarada em teste, e **não exercitada** nos artefatos do Google (0 `[redacted]` nos dois). Fica
como Minor pelo mesmo motivo da revisão anterior: perda de evidência em texto de interface comum, sem
medição de alcance.

### M5 — **Minor**: o fragmento de `sanitizeEvidenceUrl` (regressão M3 da 1.1.27) continua aberto no outro caminho

`probes/p4-url.mjs`: `sanitizeEvidenceUrl('https://h/cb#/authorize?code=Zq7Xk2')` → **1 sobrevivente**
(1.1.24 = 0, 1.1.26 = 0, 1.1.27 = 1, 1.1.28 = 1); idem `#/authorize/code/…`. O conserto da 1.1.28
(`FRAGMENT_CREDENTIAL_KEY`) foi aplicado só ao `sanitizeUrl` do trecho (`snippet.js:95`), e o
`sanitizeEvidenceUrl` (`privacy.js:188`) segue testando apenas `SENSITIVE_KEY`. **Não sustentei alcance
ponta a ponta** para essa função nos meus E2E (as URLs entregues que medi saíram limpas por outros
caminhos — ver §5.2), então fica como Minor: divergência entre dois caminhos que deveriam ser o mesmo, e
regressão declarada que o incremento diz ter fechado. Conserto: o predicado único do I2, nos dois pontos.

### Observações (não pontuadas)

- **O1.** A prova de não vacuidade do E2E do produto é **por valor**, não por forma:
  `assert.ok(rawPage.includes(CREDENTIAL) && rawPage.includes('4111 1111 1111 1111'))`
  (`test/e2e/current-page-export-mv3.test.mjs:199`). Se uma das seis formas sair do fixture e as outras
  ficarem, o teste continua verde — a varredura é forte, a prova de fonte é grosseira. A espera
  acrescentada antes dos cartões **não** substituiu asserção (o diff só a adiciona; o
  `assert.ok(candidates.length > 0)` continua na linha 70; e `waitForValue` **rejeita** no timeout, com
  teste próprio em `test/e2e/support/real-chrome.test.mjs:489`). Medi cada forma com um sentinela
  próprio (§3.1, sete formas): todas estavam presentes na página-fonte, e a varredura as veria se vazassem.
- **O2.** "Os **16 testes de escopo** verdes na raiz extraída do zip" não tem comando nem lista
  declarada em lugar nenhum do repositório; não é reproduzível como número (o runner classifica
  35 arquivos como serial e 2 como process-safe; os arquivos de `test/e2e/` somam 51 `test()`).
- **O3.** Comentário que descreve código que não existe, no arquivo reescrito pelo incremento:
  `src/core/privacy.js:206-208` afirma "até 120 caracteres, parando em quebra de linha, `<` ou `;`" e
  "O limite evita engolir uma linha inteira de prosa legítima" — o `VALUE_SOURCE` atual é `\S[^\n]*`,
  sem teto, sem `<` e sem `;`, e **engole** a linha inteira de propósito. É a mesma classe do O1 da
  revisão da 1.1.27, agora com o comentário contradizendo o comentário novo 20 linhas acima.
- **O4.** `FRAGMENT_CREDENTIAL_KEY` (`snippet.js:30`) é a **quarta cópia** de vocabulário do produto (as
  outras três convergiram para `privacy.js` na 1.1.27). Foi essa cópia que produziu I2 e M5.
- **O5.** A exceção ancorada do rótulo, em si, resistiu às minhas 37 tentativas de quebra: nenhum valor
  que **carregue** credencial passa por `SENSITIVE_LABEL_ONLY` (9 passam, todos rótulo puro). O buraco do
  item 2 está na outra camada (I1), não na exceção.
- **O6.** A regra de menção continua **por menção**: um atributo de rótulo cujo valor é um segredo puro,
  sem nenhuma palavra do vocabulário, sobrevive no trecho — `title="S3CR3TX9"` → `title="S3CR3TX9"`, e
  `title="Basic dXNlcjpwYXNz"` (Basic auth em base64, sem a palavra `authorization`/`Bearer`) também.
  É pré-existente nas quatro gerações e decorre do desenho declarado (a regra olha a menção, e o
  tarjador de valor exige rótulo); registro porque é o outro lado da mesma escolha, e **não** medi
  alcance de `Basic …` nos entregáveis.

---

## 5. Retratações do que a medição não sustentou

1. **"O zip entregue não está rastreado."** Não se aplica à 1.1.28: `git ls-files` mostra o zip
   rastreado e `git status --porcelain` está **vazio** (a observação O5 da 1.1.27 foi resolvida). Minha
   expectativa inicial, vinda do brief ("deve mostrar `?? release/…zip`"), estava errada para esta versão.
2. **"O buraco do fragmento em `sanitizeEvidenceUrl` é alcançável ponta a ponta."** Não sustentado: nos
   meus quatro E2E de sentinela, as URLs entregues que passam por esse caminho saíram **limpas**
   (`#/authorize?code=` num `href`, num `action` e num `src`; fragmento na URL do escopo; fragmento na
   URL do frame raiz). O achado que sobra é a divergência entre caminhos (M5), não um vazamento provado.
3. **"A espera acrescentada ao E2E pode ter substituído uma asserção real."** Refutado pelo diff e pela
   leitura: a espera foi **adicionada** antes da leitura dos cartões, a asserção de ao menos um achado
   confirmado continua, e `waitForValue` rejeita no timeout (`WAIT_TIMEOUT`) — não há caminho silencioso.
4. **"A exceção ancorada deixa passar credencial."** Não encontrei forma: o valor tem de ser **todo** o
   vocabulário sensível, e nenhuma credencial real cabe nisso. A hipótese cai; o achado do item 2 é o I1.
5. **"A varredura do E2E pode ser vacuosa."** Refutado por mutação própria: com `privacy.js` **e**
   `snippet.js` de `d9a67e7` o E2E reprova nomeando `relatório, modelo e revisão guardados, artefato html,
   artefato json` (§3.7); com o código do pacote passa.
6. **A revisão da 1.1.27 registrou `authTokens`, `oauth`, `one-time`… como "ganhos no rótulo".** A
   medição corrige o registro: essas formas são pegas pela regra de **menção** (atributo) e pelo caminho
   de **chave**, mas **não** pelo tarjador de **valor** — `authTokens: Zq7Xk2` sobrevive em 1.1.28 e nas
   três anteriores (é o M1). Não é acusação nova contra a 1.1.28; é correção de escopo de uma medição
   anterior.
7. **Métrica minha enviesada, corrigida.** A primeira versão da minha contagem procurava o **segredo
   inteiro** na saída e por isso classificava como "limpas" as formas com o valor **dividido**
   (`senha: S3CR<br>3TX9` → 0 ocorrências do segredo, mas `3TX9` intacto). Refiz com "maior pedaço
   contíguo sobrevivente" (`probes/p5-split.mjs`); a tabela do §3.1 é a corrigida e o achado M2 nasceu
   dessa correção.

---

## 6. O que eu **não** medi (risco residual)

1. **Os instrumentos do autor.** Não rodei o instrumento calibrado dos 146 itens, o comparador de 5.943
   sondas nem o `verify-project`; construí os meus (`artcheck128.py`, `google-mine128.mjs`, `p1`–`p8`).
   Onde os meus números divergem, a divergência está reportada com o método.
2. **A varredura de credencial no PDF para todas as formas.** O PDF entregue foi varrido por
   `extract_text` (pypdf) para os sentinelas: as formas de URL aparecem nele; as **sete** formas de texto do
   C1 que provei ponta a ponta **não** apareceram nos meus artefatos (o PDF imprime um subconjunto de trechos). Não afirmo que o
   PDF esteja limpo para elas — o fluxo binário comprimido não é varrido byte a byte pelo teste do
   produto, e eu não fiz um detector de palavra partida sobre o PDF inteiro.
3. **A triagem do vermelho da fase serial.** Confirmei que `sidepanel-flow-mv3` está modificado na
   árvore de desenvolvimento (`+87/−8` contra `e6c2619`) e que ele é o único vermelho da minha corrida,
   mas **não** medi se as falhas vêm da modificação: o arquivo do commit congelado é o que eu rodei.
4. **Reachability de `sanitizeEvidenceUrl` fora do que exercitei** (URLs de frame via CDP
   `Page.getFrameTree`, chaves `URL_ATTRIBUTE_KEYS` fora de `href`/`src`/`action`, `sanitizeResourceUrl`
   em `normalize-snapshot.js`): as formas que medi saíram limpas, mas não esgotei os chamadores.
5. **`sanitizeEvidenceUrlV1` com `includeQuery: true`** (o produto usa `queryIncluded: false` no escopo):
   o V1 zera o fragmento sempre e, com a consulta incluída, mantém `?code=` — não verifiquei se algum
   caminho do produto entrega o V1 com `includeQuery: true`.
6. **Os caminhos de captura MHTML/página inteira e o `page-marker-projection`** (que também chama
   `sanitizeHtmlSnippetSource`): não instrumentei esses fluxos.
7. **A inspeção visual página a página do PDF** e a jornada do protocolo de pessoa leiga (critério 8).

---

## 7. Confirmação do checkout congelado

```
$ git -C /private/tmp/audita-review-128 rev-parse HEAD
e3fbe03a9c8204ee68c6e6bc266e51c46fd1494b        (= HEAD inicial)
$ git -C /private/tmp/audita-review-128 status --porcelain
(vazio)
```

NADA foi editado no checkout congelado nem na árvore de desenvolvimento. Todas as mutações, reconstruções,
cópias de `test/`/`fixtures/`/`scripts/`, E2E de sentinela e arquivos de sonda foram feitos em
`/private/tmp/adv128/` (`work/ext`, `work/mutant`, `clone`, `gen`, `probes`, `artifacts`), e o `git clone`
para rodar a suíte foi feito a partir do checkout congelado para `/private/tmp/adv128/clone`.

---

## 8. Anexo — reprodução dos comandos principais

```bash
export AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

# produto a partir dos bytes empacotados
cd /private/tmp/adv128/work/ext
node --test --test-concurrency=1 test/e2e/current-page-export-mv3.test.mjs      # ✔ 1/1 (baseline)
cd /private/tmp/adv128/work/mutant                                             # privacy.js+snippet.js de d9a67e7
node --test --test-concurrency=1 test/e2e/current-page-export-mv3.test.mjs      # ✖ nomeando as 4 superfícies
cd /private/tmp/adv128/work/ext
for n in "" 2 3 4; do node --test --test-concurrency=1 test/e2e/adv128-sentinel${n}-mv3.test.mjs; done
# sondas de unidade (4 gerações)
cd /private/tmp/adv128/probes
node p1-forms.mjs; node p3-mono.mjs; node p4-url.mjs; node p5-split.mjs
node p6-ident.mjs; node p7-over.mjs; node p8-exception.mjs

# números declarados
cd /private/tmp/adv128/clone
FILES=$(find test -name '*.test.js' -o -name '*.test.mjs' | grep -v '^test/e2e/' | sort)
node --test --test-concurrency=4 $FILES                                        # tests 4157 pass 4156 fail 0 skipped 1
node --test --test-concurrency=1 test/release-package.test.js test/extension-shell.test.js test/release-assets.test.js  # 20/20
bash /private/tmp/adv128/run-serial.sh                                        # 34/35, vermelho = sidepanel-flow-mv3
node /private/tmp/adv128/google-mine128.mjs                                    # Google real: §3.5
/Users/andrebadini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  /private/tmp/adv128/artcheck128.py /private/tmp/adv128/google-artifacts        # 146/146, notas 5/5, 5228, 0 [redacted]
```
