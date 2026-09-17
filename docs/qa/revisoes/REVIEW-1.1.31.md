# Revisão adversarial independente — Audita Acessibilidade 1.1.31

- **Checkout congelado:** `/private/tmp/audita-review-131`, `HEAD fa917456ae2284c5b9d6b10fdcfc59e968c972a9`,
  `git status --porcelain` **vazio** no início e no fim (o brief esperava `?? release/…zip`; o zip está
  **rastreado no próprio commit** — §6). **Não editei nada** no checkout congelado nem em
  `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`.
- **Artefato medido:** `release/audita-acessibilidade-1.1.31.zip`, SHA-256
  `28a53946559e000285b972a88be1c2e54023bcfbe570d83e0994cb2023d732ba` (**= o esperado**), 199 entradas,
  4.282.589 bytes descompactados.
- **Produto medido a partir dos bytes empacotados:** extraído em `/private/tmp/adv131/pkg` (pristino) e
  `/private/tmp/adv131/pkg/test|fixtures|scripts` (cópia do harness). Gerações de comparação:
  `pkg129` (zip 1.1.29), `pkg130` (zip 1.1.30), `pkg-r130` (pacote 1.1.31 com `privacy.js`,
  `evidence/snippet.js` e `accessibility/accessible-name.js` de `3c571f4`, byte a byte idênticos aos do zip
  da 1.1.30), `mut-accent` e `mut130` (mutações), `tree` (cópia da árvore congelada para a suíte).
- **Chrome:** Chrome for Testing 152.0.7977.64 em `/private/tmp/audita-cft152-fixed` (perfil temporário
  isolado, **um Chrome por vez**). Nenhuma navegação externa foi feita — ver §5.
- **Instrumentos próprios (nenhum caso do autor):** `pkg/probe/universe{,2,3}.mjs` (universo próprio,
  900 + 34 + 45 formas), `compare.mjs` (1.1.30 × 1.1.31), `prose-compare.mjs` (3 gerações × 30 frases),
  `metric-coverage.mjs` (cobertura real da métrica), `pkg-vs-tree.mjs`, `patch-{residual,formsweep}.mjs`
  (percursos E2E de sentinela única, forma isolada antes dos controles), `sweep24.txt`.
  Logs crus em `/private/tmp/adv131/`.

---

## 1. Veredito

**A 1.1.31 NÃO substitui a 1.1.30/1.1.29 como candidata aprovada — mas é estritamente melhor que a 1.1.30
e deve substituí-la como linha de base de trabalho.** O conserto de idioma é real e eu o reproduzi ponta a
ponta: com a fixture isolada, os **bytes da 1.1.30 entregam `Cartão de crédito:`, `Número do cartão de
crédito:` e `senha do usuário:` em 4 superfícies** (relatório, modelo/revisão, artefato HTML, artefato
JSON) e **os bytes da 1.1.31 não entregam nenhuma**. Também fecharam as 4 regressões de cauda
(`senha ZQXJKVBWPMTLRNHS` por `placeholder`/`aria-label`/`alt`) e o octal `\150` e o separador `%3a`.

O que impede a substituição é que **a classe continua aberta nos bytes empacotados**, com credencial em
**4 superfícies**: das **24 formas que a revisão da 1.1.30 mediu**, **10 continuam abertas** na 1.1.31, e
medi **outras 4 famílias** que a 1.1.31 não conhece — inclusive **um número de cartão de crédito inteiro
em 4 superfícies** por um rótulo de 4 palavras e **uma senha de 16 letras em 4 superfícies** dentro de um
atributo `title`, esta última por um **quinto vocabulário privado, só em inglês, no gerador de seletor**
(`src/core/evidence/selector.js:5`).

| | Contagem |
|---|---|
| **Critical** | **2** — (C1) a classe segue aberta no caminho de texto/rótulo: 10 das 24 formas da 1.1.30 + 4 famílias minhas, número de cartão inteiro em 4 superfícies; (C2) o **seletor CSS** copia `title`/`alt`/`aria-label`/`data-testid` verbatim para o entregável, porque tem vocabulário próprio só em inglês |
| **Important** | **4** — (I1) a não vacuidade do E2E do produto para **este** incremento é falsa e a métrica da classe não cobre o Critical em nenhum dos quatro caminhos; (I2) lacunas de vocabulário pt-BR (código de verificação, frase/palavra de recuperação) em 4 superfícies; (I3) a declaração "corrigido" do registro de achados é falsificada (`Chave da API: consulte o manual.` etc.); (I4) **regressão**: a abertura do token para `\p{L}` criou 7 tarjas novas em prosa realista, entre elas `Segredo de justiça:` e uma frase que o próprio autor declara intacta |
| **Minor** | **5** |
| **Observações** | **5** |

Números declarados: **reproduzem** o total da suíte (4.163 testes; na passagem limpa, **4.162 passam,
1 pulado, 0 falham** — o "4.161 passam" declarado está um a menos, §2 M1), o gate **20/20** com o digest
fixado, a fase serial **34/35** com o vermelho exatamente em `test/e2e/sidepanel-flow-mv3.test.mjs`, o
digest, as 199 entradas, o pacote↔árvore e a reconstrução byte a byte — com as ressalvas de §2 (M1) e o que
**não** medi em §5 (números do Google, 146/146, notas 5/5 e custo zero na página real).

---

## 2. Achados

### C1 (Critical) — a classe continua aberta: 10 das 24 formas da 1.1.30 e 4 famílias novas, com número de cartão inteiro em 4 superfícies

**Pré-existente (não é regressão da 1.1.31) — mas o incremento afirma ter fechado as 24 formas da 1.1.30
e não fechou.** Medi cada uma das 24 formas da tabela da revisão da 1.1.30 no E2E do produto sobre os
**bytes empacotados da 1.1.31**, com sentinela própria por forma, **a forma sob teste colocada antes dos
controles** (para que um crédito reconhecido depois dela não a mascare) e varredura das superfícies
entregues (painel, relatório, URLs de abas, armazenamento durável, modelo e revisão guardados, CSV, HTML,
JSON — a página auditada é a fonte e é excluída, como no teste do autor).

```
$ node --test --test-concurrency=1 test/e2e/adv131-formsweep.test.mjs   # uma forma por execução
f01 Cartão de crédito: 4111 2222 3333 4444            FECHADO
f02 senha do usuário: ADV131F02PWX                    FECHADO
f03 Chave de segurança: ADV131F03CHV                  FECHADO
f04 Senha provisória: ADV131F04PRV                    FECHADO
f05 Palavra-passe do usuário: ADV131F05PPP            FECHADO
f06 cartão de crédito ADV131F06TAIL                   ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
f10 senha - ADV131F10DASH                             ABERTO -> modelo e revisão guardados, artefato json
f11 <a href="/current#/authorize/co%64e=ADV131F11ROUTE">  ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
f12 <a href="/current?code%3DADV131F12SEP">           FECHADO
f13 <a href="/current?%2563ode=ADV131F13DBL">         ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
f14 senha%3a ADV131F14PCT                             FECHADO
f15 Número do cartão de crédito: 4111 8888 9999 0000  FECHADO
f16 <th>Cartão de crédito:</th><td>4111 5555 6666 7777</td>  FECHADO
a01 <input title="senha ZQXJKVBWPMTLRNHS">            ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
a05 <input title="senha do usuário: ADV131A05ACNT">   FECHADO
a13 <input title="senha Segredo!Alfa">                ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
a14 <input title="chave Segredo.Beta">                ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
a15 <input title="senha correcthorsebattery">         ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
a18 <input title="senha Segredo?Epsilon">             ABERTO -> relatório, modelo e revisão guardados, artefato html, artefato json
a06 <input placeholder="senha ZQXJKVBWPMTLRNHSPH">    FECHADO
a07 <input aria-label="senha ZQXJKVBWPMTLRNHSAL">     FECHADO
a12 <img alt="token ZQXJKVBWPMTLRNHSALT">             FECHADO
a16 <input placeholder="senha Segredo!Gama">          FECHADO
>> 14 fechadas, 10 abertas
```

Isso **falsifica a afirmação do commit** ("fecha as 24 formas da 1.1.30"): as 5 formas de idioma e as 4
regressões de cauda fecharam, mas 10 formas que a revisão anterior mediu continuam entregando.

**Famílias novas que eu inventei e que também vazam (bytes da 1.1.31, forma isolada, E2E do produto):**

| forma (minha, sentinela real) | superfícies medidas |
|---|---|
| `<p>Número do cartão de crédito do titular: 4111 1111 1111 1111</p>` | **relatório, modelo e revisão guardados, artefato html, artefato json** |
| `<p>senha do usuário do sistema: S3GR3D0XYZQ</p>` | **relatório, modelo e revisão guardados, artefato html, artefato json** |
| `<p>Código de verificação: S3GR3D0XYZQ</p>` | relatório, modelo e revisão guardados, artefato html, artefato json |
| `<p>frase de recuperação: S3GR3D0XYZQ</p>` | relatório, modelo e revisão guardados, artefato html, artefato json |
| `<p>Senha (provisória): S3GR3D0XYZQ</p>` | modelo e revisão guardados, artefato json |
| `<p>Chave (API): S3GR3D0XYZQ</p>` | modelo e revisão guardados, artefato json |
| controle `<p>Cartão de crédito: S3GR3D0XYZQ</p>` | nenhuma (controle negativo, aprovado) |

Saída crua do vazamento do cartão (campo `visibleText` do nó `<main>` no modelo/revisão):

```
"visibleText":"Página avaliada Número do cartão de crédito do titular: 4111 1111 1111 1111 senha: [redacted]"
AssertionError [ERR_ASSERTION]: credencial da página chegou ao entregável em:
  relatório, modelo e revisão guardados, artefato html, artefato json
```

**Mecanismos (cada um com conserto distinto):**

1. **Janela de rótulo com teto de 2 palavras.** `src/core/privacy.js:90`
   (`VALUE_LABEL_SOURCE = VALUE_LABEL_ADJACENT_SOURCE(?:[\s]+[\p{L}\p{N}]{1,24}){0,2}`) aceita no máximo
   duas palavras depois do radical. Com **três**, o rótulo não casa em lugar nenhum e o valor segue
   intacto — é a mesma classe e o mesmo tipo de payload do Critical da 1.1.30 (número de cartão em 4
   superfícies), uma palavra à direita do conserto. Medido: `Número do cartão de crédito do titular:` e
   `senha do usuário do sistema:` vazam em 1.1.29, 1.1.30 **e** 1.1.31 (`compare.mjs`).
2. **Cauda com rótulo espaçado.** `redactCredentialLabelTail` (`privacy.js:284`) usa
   `VALUE_LABEL_ADJACENT_SOURCE`, não `VALUE_LABEL_SOURCE`: em `cartão de crédito ADV131F06TAIL` o
   "token depois do rótulo" é `de`, não o valor. Medido:
   `redactCredentialLabelTail('cartão de crédito ADV131F06TAIL')` → inalterado (f06, f17).
3. **Cauda consome só um token.** `senha - ADV131F10DASH` → `redactSensitiveText` não casa (o separador
   `-` isolado não está em `VALUE_SEPARATOR_SOURCE`) e a cauda redige o `-`, deixando o valor:
   `redactCredentialLabelTail('senha - ADV131F10DASH')` → `'senha [redacted] ADV131F10DASH'`.
4. **`sanitizeUrl` do trecho não foi atualizado.** `src/core/evidence/snippet.js:86-101` testa
   `SENSITIVE.test(url.hash)` e `FRAGMENT_CREDENTIAL_KEY` sobre a forma **crua**: `#/authorize/co%64e=V`
   não casa em nenhum (a chave vem depois de `/`, não de `[?&;]`, e `co%64e` não está na lista literal), e
   `?%2563ode=V` idem. O conserto de "rota percent-encoded" da 1.1.31 foi para `redactSensitiveText` e
   `sanitizeEvidenceUrl`, não para o sanitizador de atributo de URL do trecho. Saída crua entregue:
   `&lt;a href="/current#/authorize/co%64e=ADV131F11ROUTE"&gt;x&lt;/a&gt;` no relatório, modelo, HTML e JSON.
5. **Lacuna de vocabulário pt-BR** (I2, contado separado).

**Conserto mínimo (não aplicado):** `src/core/privacy.js:89-90` — trocar o teto `{0,2}` por uma janela
maior (ex. `{0,6}`) **ou** decidir o rótulo como "a última palavra sensível antes do separador";
`privacy.js:284` — usar `VALUE_LABEL_SOURCE` (com o sufixo espaçado) em `redactCredentialLabelTail` e
redigir **todos** os tokens até o fim da linha, não só o primeiro; `src/core/evidence/snippet.js:86-101` —
delegar o href ao mesmo predicado decodificado de `privacy.js` (`credentialKey` + varredura de segmento
percent-encoded).

### C2 (Critical) — o seletor CSS é um quinto vocabulário, só em inglês: `title="senha …"` chega a 4 superfícies

**Pré-existente, nunca apontado como mecanismo.** `src/core/evidence/selector.js` tem a **quinta lista** de
palavras sensíveis do produto (a `snippet.js` já se queixava de haver a terceira e a quarta):

```js
const SENSITIVE = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
const SEMANTIC_ATTRIBUTES = ['data-testid', 'data-test', 'aria-label', 'name', 'role', 'title', 'alt'];
```

Ela **não conhece nenhuma palavra portuguesa** (`senha`, `chave`, `segredo`, `cartão`, `credencial`,
`sessão`…). Quando o valor do atributo não é pego por ela, o seletor é emitido com o valor **inteiro**, e o
seletor é entregue no relatório ("Seletor:"), no modelo (`selector.css`), no HTML e no JSON.

Medição unitária (pacote, `buildStableSelector`):

```
VAZA {"title":"senha ZQXJKVBWPMTLRNHS"}          -> {"css":"input[title=\"senha ZQXJKVBWPMTLRNHS\"]","confidence":"medium"}
ok   {"title":"password ZQXJKVBWPMTLRNHS"}       -> {"css":"input","confidence":"low"}          <- só o inglês é barrado
VAZA {"title":"senha do usuário: ZQXJKVBWPMTLRNHS"} -> input[title="senha do usuário: ZQXJKVBWPMTLRNHS"]
VAZA {"alt":"senha ZQXJKVBWPMTLRNHS"}            -> input[alt="senha ZQXJKVBWPMTLRNHS"]
VAZA {"aria-label":"chave ZQXJKVBWPMTLRNHS"}     -> input[aria-label="chave ZQXJKVBWPMTLRNHS"]
VAZA {"data-testid":"senha ZQXJKVBWPMTLRNHS"}    -> input[data-testid="senha ZQXJKVBWPMTLRNHS"]
ok   {"name":"senha"}                            -> input[name="senha"]        (evidência legítima preservada)
ok   {"title":"senha ZQXJKVBWPMTLRNHS","class":"campo"} -> input                (com classe, o seletor semântico é pulado)
```

Medição ponta a ponta (bytes da 1.1.31, `<input title="senha ZQXJKVBWPMTLRNHS">` sem rótulo, que vira
evidência por "campo sem rótulo associado"):

```
relatório:  <p><strong>Seletor:</strong> input[title="senha ZQXJKVBWPMTLRNHS"]</p><p><strong>Snippet:</strong> &lt;input&gt;</p>
modelo:     "selector":{"css":"input[title=\"senha ZQXJKVBWPMTLRNHS\"]"}  "snippet":"<input>"
artefato html / artefato json: idem
AssertionError: FORMA VAZOU -> relatório, modelo e revisão guardados, artefato html, artefato json
```

Note que o **snippet e o nome acessível saem limpos** (`<input>`) — o vazamento é exclusivamente o
seletor. É por isso que o caso `a05` (`title="senha do usuário: …"`) aparece fechado: o valor do atributo é
antes redigido por `redactSensitiveText` (que exige separador) e o seletor passa a copiar
`senha do usuário: [redacted]`. A forma de **cauda** (`senha VALOR`, sem separador) não é redigida por
`redactSensitiveText` e atravessa os dois filtros — exatamente a família que a 1.1.31 diz ter corrigido
(I1 do registro de achados: "`senha ZQXJKVBWPMTLRNHS` … volta a tarjar").

**Conserto mínimo (não aplicado):** `src/core/evidence/selector.js:5` — apagar a regex privada e importar
`SENSITIVE_KEY`/`URL_CREDENTIAL_KEY` de `../privacy.js` (e, de preferência, aplicar
`redactCredentialLabelTail` ao valor do atributo antes de decidir); e em `src/core/privacy.js`
`redactNormalizedNode` (~linha 495) aplicar a regra de cauda aos valores de atributo, não só
`redactSensitiveText`, para que o modelo nunca carregue `attributes.title` cru.

### I1 (Important) — a não vacuidade do E2E do produto, para **este** incremento, é falsa; e a métrica não cobre o Critical em nenhum dos quatro caminhos

O item 4 do brief pedia: restaurar `privacy.js`, `snippet.js` e `accessible-name.js` de `3c571f4` (1.1.30)
e ver o E2E **reprovar**. **Medido: ele passa.**

```
$ shasum -a 256 pkg-r130/src/core/{privacy.js,evidence/snippet.js,accessibility/accessible-name.js}
5cd4c4a68611f9d8df99ff3a9e20352221fab90068ef4c1ff300e887c3467d62  privacy.js          (= zip 1.1.30)
65b5f0166a79107504451430fe7354726aacd4006cb948a89e3b0acf0b032316  evidence/snippet.js (= zip 1.1.30)
339fcc4ecbe407518033c3eb2b26a14e40b9e7254f34f9bf9acc91972851af03  accessible-name.js  (= zip 1.1.30, idêntico nas duas gerações)

$ AUDITA_E2E_CHROME=… node --test --test-concurrency=1 test/e2e/current-page-export-mv3.test.mjs   # pkg-r130
✔ current-page audit exports four verified artifacts (5205ms)   ℹ tests 1  ℹ pass 1  ℹ fail 0
```

E provei **de dentro do navegador** que a extensão executou os bytes da 1.1.30:

```
ADV131_RUNTIME {"privacyHasValueLikeToken":false,"privacyHasValueLikeTailSource":true,
                "privacyHasLatinSuffix":false,"privacyHasAsciiSuffix":true,"privacyLength":27625}
```

Ou seja: **a fixture do E2E não contém nenhuma forma que só a 1.1.31 trate** (não há rótulo acentuado, nem
`%3a`, nem `\150`), então o E2E do produto **não protege o ganho deste incremento**. Pior: ele **mascara**
formas desconhecidas. Com a fixture do autor mais uma forma acentuada, os bytes da 1.1.30 continuam
passando; numa fixture **isolada** (só as formas acentuadas, sem crédito reconhecido antes delas no mesmo
contêiner), os mesmos bytes **reprovam**:

```
# bytes 1.1.30, fixture do autor + <p>Cartão de crédito: …</p> acrescentado
✔ pass 1
# bytes 1.1.30, fixture ISOLADA (só as 3 formas acentuadas + controles não-credential)
✖ AssertionError: credencial da página chegou ao entregável em:
   relatório, modelo e revisão guardados, artefato html, artefato json
# bytes 1.1.31, MESMA fixture isolada
✔ pass 1
```

A causa do mascaramento é o próprio mecanismo monotônico: o trecho/texto do contêiner (`<main>`) é uma
linha só, o primeiro crédito reconhecido (`senha: …`) consome `\S[^\n]*` até o fim da linha / contamina o
resto do trecho, e tudo o que vem depois — inclusive a forma que a regra não conhece — sai tarjado como
dano colateral. Confirmei com um caso mínimo de dois parágrafos (`senha: X` + `Cartão de crédito: X`):
**passa** nos bytes da 1.1.30.

**A métrica da classe tem o mesmo ponto cego.** `node --test test/core/credential-class-metric.test.js`
roda 3/3 verde na raiz extraída, e a lista é larga (35 `FORMAS` + 13 `ROTULOS` + 4 `CAUDAS` +
5 `ATRIBUTOS` + 8 `URLS` = 65 formas no grupo de vazamento). Mas **nenhum payload do grupo de vazamento
tem um único caractere acentuado** (`metric-coverage.mjs`):

```
FORMAS     entradas= 35  com acento no PAYLOAD=0
ROTULOS    entradas= 13  com acento no PAYLOAD=0
CAUDAS     entradas=  4  com acento no PAYLOAD=0
ATRIBUTOS  entradas=  5  com acento no PAYLOAD=0
URLS       entradas=  8  com acento no PAYLOAD=0
cobertura no grupo de VAZAMENTO:
  AUSENTE  Cartão de crédito:      AUSENTE  Número do cartão de crédito:   AUSENTE  senha do usuário:
  AUSENTE  Chave de segurança:     AUSENTE  Senha provisória:             AUSENTE  Palavra-passe do usuário:
```

As formas acentuadas só existem na **lista de sinais obrigatórios** do teste 3
(`assert.equal(hasCredentialValueSignal(texto), true)`), que mede uma propriedade do sinal, não a entrega.
A mutação que o brief pede confirma:

```
# (a) privacy.js + snippet.js do zip 1.1.30, métrica da 1.1.31
✔ nenhuma forma de credencial sobrevive em nenhum dos quatro caminhos   <- a varredura de VAZAMENTO passa
✔ o nome acessível do fallback de DOM não devolve a credencial
✖ o sinal de credencial não acende em prosa legítima e o texto sai intacto
  AssertionError: "senha ZQXJKVBWPMTLRNHS" precisa acender o sinal      <- falha pelo I1, não pelo Critical
# (b) só o sufixo acentuado revertido para [A-Za-z0-9] (mutação cirúrgica)
✖ AssertionError: "Cartão de crédito: 4111 2222 3333 4444" precisa acender o sinal
✔ (teste 1, varredura de vazamento) passa
```

**Conserto mínimo (não aplicado):** acrescentar ao grupo de vazamento da métrica as formas acentuadas
(`Cartão de crédito:`, `Número do cartão de crédito:`, `senha do usuário:`, `Chave de segurança:`,
`Senha provisória:`, `Palavra-passe do usuário:`, `Código de verificação:`, `Senha (provisória):`,
`Número do cartão de crédito do titular:`) e as 10 formas abertas de §C1; e, no E2E do produto, auditar
cada forma numa **página/contêiner próprio** (ou pelo menos antes de qualquer crédito reconhecido), porque
o contêiner compartilhado mascara por contaminação monotônica.

### I2 (Important) — lacuna de vocabulário pt-BR: `Código de verificação:` e `frase de recuperação:` chegam a 4 superfícies

**Pré-existente** (vaza em 1.1.29, 1.1.30 e 1.1.31 — `compare.mjs`). O vocabulário tem `otp|one[-_ ]?time`
**só em inglês**; o produto é brasileiro. Medido no E2E do produto, bytes da 1.1.31: `Código de
verificação: S3GR3D0XYZQ` e `frase de recuperação: S3GR3D0XYZQ` → **relatório, modelo e revisão guardados,
artefato html, artefato json**. Também vazam `Código de acesso:` e `código de segurança:`
(`probe/universe2.mjs`: `LEAK ... sep-com-falha=[": ",":"," = "," -> "]`). Um código de verificação é
credencial de segundo fator; uma frase de recuperação é credencial de recuperação de conta.

**Conserto mínimo (não aplicado):** somar a `SENSITIVE_WORD_SOURCE` (`privacy.js:69`)
`c[óo]digo` + `(?:de\s+)?(?:verifica|acesso|seguran|autentica|confirma)` e
`(?:frase|palavra|semente)` + `(?:de\s+)?recupera` (e `seed[-_ ]?phrase`).

### I3 (Important) — afirmação falsificada no registro de achados: as frases que o autor declara intactas não estão intactas

`docs/qa/2026-09-16-registro-de-achados-das-revisoes.md`, linha do achado I3 da 1.1.30, coluna Desfecho
("corrigido na 1.1.31"): *"Com isso `Chave da API: consulte o manual.`, `Senha da conta: alterada em 12/03`
e as duas frases acima ficam intactas"*. Medição nos bytes empacotados da 1.1.31:

```
"Chave da API: consulte o manual."      sinal=false  trecho="<p>Chave da API: [redacted]</p>"      json="<p>Chave da API: [redacted]"
"Senha da conta: alterada em 12/03."    sinal=false  trecho="<p>Senha da conta: [redacted]</p>"    json="<p>Senha da conta: [redacted]"
"Digite sua senha atual."               sinal=false  trecho="<p>Digite sua senha atual.</p>"       json="<p>Digite sua senha [redacted]"   (perda no JSON)
"A senha deve ter 8 caracteres."        sinal=false  trecho="<p>A senha deve ter 8 caracteres.</p>" json=<idem>                              (esta confere)
```

A redação de `Chave da API: consulte o manual.` e de `Senha da conta: alterada em 12/03` é feita por
`redactSensitiveText` (que não é condicionado por "cara de valor") e portanto **não** foi tocada pelo
conserto do sinal. **Atribuição:** em 1.1.29 as duas frases saíam **intactas**; a 1.1.30 introduziu a
tarja; a 1.1.31 manteve → é regressão **da 1.1.30**, não da 1.1.31, mas a declaração "corrigido na 1.1.31"
é falsa. O próprio autor, em outro documento, mede e **declara o preço** dessas tarjas
(`docs/qa/2026-09-13-continuity-and-e2e-triage.md`, "O preço da marcação por conteúdo… Das 15 frases, 4
são tarjadas: `Chave da API: consulte o manual`, …") — os dois documentos se contradizem, e a medição
confirma o documento de continuidade, não o registro de achados.

**Conserto mínimo (não aplicado):** corrigir a linha do registro (declarar o preço em vez de "intactas") ou
tornar `redactSensitiveText` também condicionado a "cara de valor" quando o rótulo tem sufixo espaçado —
decisão de desenho, com o trade-off declarado.

### I4 (Important) — regressão: a abertura do token para `\p{L}` criou 7 tarjas novas em prosa realista, entre elas uma frase que o autor declara intacta

Medi 30 frases realistas de página brasileira nas três gerações (`prose-compare.mjs`). **Sete** passaram a
ser tarjadas na 1.1.31 e não eram na 1.1.30:

| frase | 1.1.29 | 1.1.30 | 1.1.31 |
|---|---|---|---|
| `Senha do usuário: mínimo de 8 caracteres.` | ok | ok | **TARJA** `<p>Senha do usuário: [redacted]</p>` |
| `Segredo de justiça: o processo tramita em sigilo.` | ok | ok | **TARJA** `<p>Segredo de justiça: [redacted]</p>` |
| `Segredo de justiça: processo 1234.` | ok | ok | **TARJA** |
| `Chave de proteção: aciona o disjuntor.` | ok | ok | **TARJA** |
| `Token de verificação: enviado por SMS.` | ok | ok | **TARJA** |
| `Palavra-passe provisória: entregue no balcão.` | TARJA | ok | **TARJA** |
| `Senha do usuário: redefinida ontem.` | ok | ok | **TARJA** |

`Segredo de justiça` é termo jurídico corrente em páginas de tribunais e notícias — não é credencial.
`Senha do usuário: mínimo de 8 caracteres.` é **exatamente uma das frases que o autor declara intactas**
("As outras 11 … `Senha do usuário: mínimo de 8 caracteres` … passam intactas"): ela era intacta na 1.1.30
e **passou a ser tarjada na 1.1.31**, e a rodada da 1.1.31 não remediu o corpus de prosa depois de alargar
o token. Mecanismo: com `[\p{L}\p{N}]`, `Senha do usuário`, `Segredo de justiça`, `Chave de proteção` e
`Palavra-passe provisória` viraram rótulos casáveis e `redactSensitiveText` redige a linha inteira depois
do separador, sem exigir "cara de valor". **É regressão da 1.1.31** (falso positivo / perda de evidência),
do mesmo mecanismo do conserto — a lição que o próprio autor escreveu ("estreitar uma regra para reduzir
falso positivo abre falso negativo") vale na direção oposta também.

**Conserto mínimo (não aplicado):** separar as duas decisões — manter o alargamento de `\p{L}` na
**detecção do rótulo** e condicionar a **tarja da linha** a "cara de valor" (ou a um vocabulário ainda mais
estreito no caminho de texto), para que `Segredo de justiça:` volte a passar.

### M1 (Minor) — os números da suíte não fecham e "0 falham" não é reprodutível sem declarar o teste instável

`node --test $(find test -name '*.test.js' -o -name '*.test.mjs' | grep -v '^test/e2e/' | sort)` na cópia da
árvore congelada (`tree`, com `.git` ligado, senão `test/personas/preview-runtime-parity.test.js` não roda
— ele chama `git show 78ba813:`):

```
run 1 (sem .git):  ℹ tests 4163  ℹ pass 4161  ℹ fail 1  ℹ skipped 1   -> falha: preview-runtime-parity (git)
run 2 (com .git):  ℹ tests 4163  ℹ pass 4161  ℹ fail 1  ℹ skipped 1   -> falha: test/export/blob-lifecycle.test.js:176
                   "late print registration is released without creating a print tab after timeout" (442ms, 2 !== 3)
run 3 (com .git):  ℹ tests 4163  ℹ pass 4162  ℹ fail 0  ℹ skipped 1   EXIT=0
$ node --test test/export/blob-lifecycle.test.js   (3×)
ℹ tests 16  ℹ pass 16  ℹ fail 0    ℹ tests 16  ℹ pass 16  ℹ fail 0    ℹ tests 16  ℹ pass 16  ℹ fail 0
```

Dois pontos: (a) o teste é **instável sob carga** e passa isolado 16/16 (o autor declara instabilidade só
para `url-pixel-consent`/`url-audit`/`retention-indexeddb`); (b) a contagem declarada
"4.163 testes, 4.161 passam, 1 pulado, 0 falham" **não fecha**: na passagem limpa (run 3) o resultado foi
**4.162 passam, 0 falham, 1 pulado** — o número de aprovados declarado está um a menos, e "0 falham" se
sustenta (a falha do run 2 é a instabilidade, não um defeito).

### M2 (Minor) — a regra de cauda sobre string COM marcação mata prosa que o autor declara intacta

`privacy.js:371-381` (`redactStringValue`) aplica `redactCredentialLabelTail` à string **com tags**, então o
token capturado depois do rótulo inclui a marcação e os caracteres `<`, `/`, `>` contam como "símbolo
forte":

```
redactCredentialLabelTail("Digite sua senha atual.")        -> "Digite sua senha atual."       (correto)
redactCredentialLabelTail("<p>Digite sua senha atual.</p>") -> "<p>Digite sua senha [redacted]" (token = "atual.</p>")
sanitizeJsonData({texto:"<p>Digite sua senha atual.</p>"}).texto  -> "<p>Digite sua senha [redacted]"
sanitizeJsonData({texto:"<p>Sessão expirada.</p>"}).texto         -> "<p>Sessão [redacted]"
```

**Pré-existente** (idêntico em 1.1.29/1.1.30/1.1.31), e é a razão pela qual `Digite sua senha atual.` e
`Sessão expirada.` — ambas declaradas intactas — perdem texto no caminho JSON. Conserto: aplicar a regra de
cauda sobre a projeção **sem tags** (ou remover a marcação antes de decidir).

### M3 (Minor) — credencial no VALOR de parâmetro de URL sobrevive a `sanitizeEvidenceUrl`/`sanitizeEvidenceUrlV1`

```
sanitizeEvidenceUrl("https://exemplo.test/p?next=senha%3aS3GR3D0XYZQ1")        -> "...?next=senha%3aS3GR3D0XYZQ1"  (vaza)
sanitizeEvidenceUrlV1("...?next=senha%3aS3GR3D0XYZQ1",{includeQuery:true})      -> idem (vaza)
sanitizeEvidenceUrl("...?senha=S3GR3D0XYZQ1&id=7")                              -> "https://exemplo.test/p"           (chave sensível fecha)
```

**Pré-existente e latente:** o predicado é aplicado à **chave**, não ao valor. **Não é caminho de produto
hoje** — todos os chamadores passam `includeQuery: false` (`run-audit.js:202,386,1283,1809,1922,1926`,
`page-markers-controller.js:397`) e o fragmento é sempre apagado —, por isso entra como Minor e não como
classe aberta. Fica registrado porque o brief pede o caminho de URL medido em todas as formas.

### M4 (Minor) — a regra de "resto depois da quebra de linha" existe no trecho e **não** existe no JSON

```
<sanitizeHtmlSnippetSource>  "<p>token: A\nB S3GR3D0XYZQ1</p>"  ->  "<p>token: [redacted]</p>"       (fechado)
<sanitizeJsonData>           "<p>token: A\nB S3GR3D0XYZQ1</p>"  ->  "<p>token: [redacted]\nB S3GR3D0XYZQ1"  (vaza)
```

`snippet.js:233-235` tem a regra do resto (`const remainder = marker …`), mas `redactSensitiveText`
(`VALUE_SOURCE = \S[^\n]*`) continua parando na quebra. **Pré-existente** (idêntico em 1.1.30). Não
consegui traçar uma superfície entregue em que um fragmento cru multi-linha chegue ao `sanitizeJsonData`
(os textos do snapshot são normalizados), por isso Minor com a ressalva de alcance.

### M5 (Minor) — o controle de prosa da métrica não contém as frases que o autor declara

`PROSA` (6 entradas) tem `Senha da conta`, `Chave da API` e `Digite sua senha` **sem separador nem cauda** —
nenhuma das frases que os documentos declaram intactas (`Chave da API: consulte o manual.`,
`Senha da conta: alterada em 12/03`, `Digite sua senha atual.`, `Senha do usuário: mínimo de 8 caracteres.`).
Com isso a métrica não pode detectar as declarações de §I3 e §I4 ficando falsas. Conserto: acrescentar as
frases declaradas ao controle negativo, **nos dois caminhos** (trecho e JSON).

### Observações

- **O1 — o conserto de idioma é real (medição positiva).** Fixture isolada nos bytes da 1.1.30 → **4
  superfícies**; mesmíssima fixture nos bytes da 1.1.31 → **limpa**. Nas 24 formas da revisão anterior, as
  5 de idioma (f01-f05), as 4 regressões de cauda (a06/a07/a12/a16) e f12/f14/f15/f16 fecharam. As formas
  `\150` (octal) e `%3a` também fecharam (`compare.mjs`, `MUDOU … 1.1.30=LEAK 1.1.31=ok`).
- **O2 — controles negativos corretos.** `A senha deve ter 8 caracteres.`, `Digite sua senha atual.`
  (trecho), `Senha da conta`, `Chave da API`, `Número do protocolo: 2026/0012345.`, `Código: 200`,
  `Informe seu CPF no campo ao lado.`, `O cartão de crédito é aceito em todas as lojas.`,
  `A chave do problema está na introdução.` ficam intactos. O vocabulário não é largo demais fora dos
  casos de §I4.
- **O3 — o caminho de URL é o mais forte.** 17 formas de URL (consulta, fragmento, rota, percent-encoding,
  dupla codificação, userinfo, separador `%3a`) medidas em `redactSensitiveText`, `sanitizeEvidenceUrl` e
  `sanitizeJsonData`: 0 vazamentos fora de M3. As URLs entregues descartam consulta e fragmento em todos os
  chamadores (`includeQuery: false`).
- **O4 — `<input value>`/`<option value>`/`<button value>` dentro de string HTML crua passada a
  `sanitizeJsonData`** mantêm o valor (`LEAK json+json2`), mas verifiquei que **não é caminho de produto**:
  `redactNormalizedNode` apaga `value` para controles editáveis e para `<option>`, e o sanitizador de
  trecho remove o atributo. Concordo com a declaração do autor ("não é caminho de produto").
- **O5 — idempotência medida.** `redactSensitiveText`, `sanitizeHtmlSnippetSource` (5 formas, incluindo
  rótulo e valor em nós diferentes e atributo) e `sanitizeJsonData` são idempotentes nas formas testadas
  (1×=2×=3×). Não testei CDATA (declarado pelo autor como não idempotente e sem vazamento).

---

## 3. Retratações

1. **Retrato a minha primeira leitura do caminho do nome acessível.** Medi, no unitário, que
   `computeAccessibleText` (e `projectAccessibleText` do normalizador) entrega `senha: X`,
   `Cartão de crédito: X`, `token: X` intactos — a função aplica só `redactCredentialLabelTail`, que exige
   espaço depois do rótulo. **Isso não vira vazamento entregue**: `redactNormalizedNode` aplica
   `sanitizeJsonData` (e portanto `redactSensitiveText`) a `accessibleName`/`accessibleDescription`/
   `axValue` antes de qualquer projeção, e o E2E com `title`/`aria-label`/`placeholder` com separador não
   achou vazamento (o `adv-name-placeholder` com `placeholder="Chave de segurança: X"` chega ao modelo como
   `"Chave de segurança: [redacted]"`). Fica como fragilidade latente da função isolada, não como achado.
2. **Retrato a premissa do item 4 do brief** ("restaurar a 1.1.30 → o E2E deve reprovar"). Reproduzi o
   contrário, com prova dos bytes carregados em runtime, e o motivo (mascaramento por contaminação
   monotônica no contêiner) — está em §I1. Registro que a revisão da 1.1.30 fez a **mesma** mutação, mas
   com os arquivos da **1.1.29**, e nesse caso o E2E de fato reprova (a fixture contém as formas ASCII que
   a 1.1.29 não fechava); a diferença de geração explica os dois resultados.
3. **Retrato a premissa do item 3** de que basta reverter `VALUE_LABEL_SOURCE`/`VALUE_LIKE_TAIL_SOURCE`
   para o teste reprovar. Ele reprova — mas **pelo teste 3 (sinal)**, não pela varredura de vazamento, que
   passa verde nos bytes da 1.1.30. A mutação está satisfeita no sentido fraco; o achado é §I1.
4. **Correção à revisão da 1.1.30 (não é retratação minha).** A linha `a01` daquela revisão
   (`<input title="senha ZQXJKVBWPMTLRNHS">`, 4 superfícies, "pré-existente") continua verdadeira na
   1.1.31 — mas a causa não é a regra de cauda: é o **seletor CSS** (§C2), que a revisão anterior não
   isolou e que a 1.1.31 não tocou. A causa importa porque o conserto é em outro arquivo.
5. **Divulgação de método:** uma rodada intermediária minha de formas residuais "passou" por um erro meu —
   o valor passado por variável de ambiente era o literal `${CREDENTIAL}`, sem segredo nenhum na página.
   Detectei pelo próprio diagnóstico (`visibleText` continha `${CREDENTIAL}`), descartei a rodada e
   re-executei com o valor real. As medições de §C1 são da segunda rodada.

---

## 4. Integridade do artefato (item 6) — tudo reproduzido

```
$ shasum -a 256 release/audita-acessibilidade-1.1.31.zip
28a53946559e000285b972a88be1c2e54023bcfbe570d83e0994cb2023d732ba   (= esperado)

$ unzip -l release/audita-acessibilidade-1.1.31.zip | tail -2
  4282589                     199 files

$ node pkg-vs-tree.mjs        (199 arquivos de runtime, dois sentidos, contra a árvore congelada)
arquivos no pacote (runtime): 199
só no pacote: []          com conteúdo diferente: []
só na árvore: ["assets/icons/icon-1024.png","assets/icons/icon-source.svg"]   (não entram no pacote por desenho)
digest agregado pacote: 27a3b152fbf668a7e86cfa30d3eef39dca8fd1c6436616b72b41c944dbb5bcc5
digest agregado árvore: 27a3b152fbf668a7e86cfa30d3eef39dca8fd1c6436616b72b41c944dbb5bcc5

$ node scripts/build-release.mjs --temporary-release-directory $TMPDIR/audita-release-test-R131ab
SHA-256 28a53946559e000285b972a88be1c2e54023bcfbe570d83e0994cb2023d732ba
$ cmp <reconstruído> release/audita-acessibilidade-1.1.31.zip  -> BYTE IDENTICAL

$ git ls-files --error-unmatch release/audita-acessibilidade-1.1.31.zip
release/audita-acessibilidade-1.1.31.zip                       # RASTREADO
$ git hash-object release/audita-acessibilidade-1.1.31.zip -> 9210b8488502f812a2e9d573fa21297cd6064213
$ git rev-parse HEAD:release/audita-acessibilidade-1.1.31.zip -> 9210b8488502f812a2e9d573fa21297cd6064213
```

**Gate de release (20/20, com o digest fixado):**

```
$ node --test test/release-package.test.js test/extension-shell.test.js test/release-assets.test.js
ℹ tests 20  ℹ pass 20  ℹ fail 0  ℹ skipped 0        EXIT=0
```

**Fase serial (35 arquivos, um Chrome por vez, sem carga concorrente):**

```
$ node --test --test-concurrency=1 $(cat serial.txt)     # 35 arquivos de Chrome real
ℹ tests 63  ℹ pass 56  ℹ fail 7  ℹ skipped 0            EXIT=1
As 7 falhas estão TODAS em test/e2e/sidepanel-flow-mv3.test.mjs (arquivo de outro incremento):
  original-page ABNT markers remain usable across idle and preserve the report  (32.031ms)
  original-page ABNT markers visual review and verified exports                  (32.030ms)
  current-page audits run in one inactive copy and leave the original page intact (121.977ms)
  full-evidence can be cancelled at the privacy pause without touching the source (30.912ms)
  no-pixels shows progress, completes in the copy and exposes a view-only report  (30.073ms)
  element-only confirms once and keeps the full-page capture omitted              (30.005ms)
  full-evidence rehydrates after worker restart and exports all four formats      (30.006ms)
>> 34 dos 35 ARQUIVOS verdes, com o vermelho exatamente no arquivo declarado.
   url-pixel-consent-mv3 passou nesta passagem limpa.
```

**Métrica da classe (comando declarado, na raiz extraída):**

```
$ node --test test/core/credential-class-metric.test.js
✔ nenhuma forma de credencial sobrevive em nenhum dos quatro caminhos
✔ o nome acessível do fallback de DOM não devolve a credencial
✔ o sinal de credencial não acende em prosa legítima e o texto sai intacto
ℹ tests 3  ℹ pass 3  ℹ fail 0
```

---

## 5. O que eu NÃO medi

- **A auditoria real do Google a partir do pacote** (0 falhas, 1 alerta, 3 suspeitas/4 ocorrências,
  9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, quatro exportações `complete`, versão 1.1.31,
  zero frases legais). O brief proíbe enviar dado a serviço externo, e essa medição exige navegar para
  `https://www.google.com/`. Não a executei. Em vez dela, medi o produto ponta a ponta em **fixtures
  locais** (`current-page-export-mv3`, `adv131-*`), que é onde a classe se mede.
- **146/146 ids e títulos, 0 palavras partidas, notas editoriais 5/5 no PDF e no HTML, proveniência nos
  dois** e **custo zero na página real (snippets de 5.228 caracteres, zero `[redacted]`)**: dependem dos
  artefatos daquela auditoria e do instrumento pypdf do próprio autor (`harness/artcheck130.py`, que não
  está no repositório). O runtime Python com pypdf existe, mas sem os artefatos do Google não há o que
  conferir. O que conferi do artefato é o de §4 (digest, entradas, pacote↔árvore, reconstrução).
- **A superfície PDF** para as minhas sentinelas: o E2E do autor varre HTML/CSV/JSON byte a byte e
  **pula** o PDF (binário comprimido); eu usei o mesmo teste como harness, então meus vazamentos estão
  medidos em painel, relatório, modelo/revisão, armazenamento durável, CSV, HTML e JSON — **não** no PDF.
  A revisão da 1.1.30 mediu o PDF com pypdf (0/63) e eu não repeti esse passo.
- **`scripts/verify-project.mjs`** (CSP MV3, axe 4.13.0, 130/146, identidade neutra) e os "16 testes de
  escopo": não os executei (não estão na lista de números do brief; o gate que executei foi o de release).
- **Persona / runtime clássico** (`accessible-preview-runtime.classic.js`): a cópia clássica de
  `computeAccessibleText` não aplica tarja nenhuma (só `isPrivate`), e é chamada pelo content script de
  persona (`src/personas/content.js:484`) sobre um snapshot montado no próprio DOM. Não tracei uma
  superfície entregue para medir se isso chega ao relatório/exportação — **não medido**, e é a lacuna que
  eu recomendaria medir em seguida.
- **`&#58;` unitário / CDATA / grafia errada de rótulo (`senhá`)**: declarados pelo autor como buracos
  latentes ou limitações; confirmei apenas `&#58;` (fechado nas minhas formas) e não medi CDATA.
- **`<template>`, `<noscript>`, `<object>`, `<script>`, `<style>`** como contêineres entre rótulo e valor:
  não medi (a revisão da 1.1.30 mediu e fechou).
- **Desempenho/custo de tempo** das novas regras: não medi.

---

## 6. Confirmação do checkout congelado

```
$ cd /private/tmp/audita-review-131 && git rev-parse HEAD
fa917456ae2284c5b9d6b10fdcfc59e968c972a9
$ git status --porcelain
(vazio — nenhuma modificação, nenhum arquivo não rastreado)
$ git ls-files --error-unmatch release/audita-acessibilidade-1.1.31.zip
release/audita-acessibilidade-1.1.31.zip        # rastreado no commit fa91745
$ git hash-object release/audita-acessibilidade-1.1.31.zip   # == git rev-parse HEAD:release/…zip
9210b8488502f812a2e9d573fa21297cd6064213
```

O checkout congelado terminou **intocado** (HEAD `fa91745`, `git status --porcelain` vazio, antes e depois).
Observação sobre o brief: ele esperava `?? release/audita-acessibilidade-1.1.31.zip`; o zip está
**rastreado no próprio commit**, então não aparece como não rastreado — o estado é mais forte do que o
esperado, não mais fraco. Todo o trabalho foi feito em cópias sob `/private/tmp/adv131/`; a árvore de
desenvolvimento `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt` não foi usada como diretório de
trabalho nem modificada por mim (o `git status` dela mostra alterações **pré-existentes** do autor:
` M docs/superpowers/plans/2026-09-12-observed-page-passive.md`,
` M test/e2e/sidepanel-flow-mv3.test.mjs` e zips antigos não rastreados).
