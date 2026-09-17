# Revisão adversarial independente — Audita Acessibilidade 1.1.34

- **Alvo**: `release/audita-acessibilidade-1.1.34.zip`, SHA-256 `5ed1b333a20cb96565e06e535e8b328f024297c01208014ad7ccd51f5ea92812` (conferido por mim com `shasum -a 256`, duas vezes: no clone e depois de reconstruir o pacote).
- **Checkout congelado**: `/private/tmp/audita-review-134`, HEAD `e84496aae8de32841c070aafcba7b87e75fae1c9`, `manifest.json` = `1.1.34`. O congelado não recebeu escrita de produto; todas as sondas, mutações, espelhos e logs ficaram em `/private/tmp/audita-review-134-scratch`.
- **Bytes medidos**: pacote extraído em `.../scratch/pkg` (**199 arquivos**, `unzip`) com a árvore de teste **do próprio commit** (`git archive HEAD test scripts package.json fixtures`), mais `release/` e `store-assets/` do commit para as fases canônicas; espelho completo `.../scratch/pkgfull-git` (clone do congelado, para as fases que exigem `.git`, `README.md`, `docs/` e `package-lock.json`); mutações `mut522` (`src` de `522ebee^`), `mut133` (1.1.33, `06e70fc`) e `mut132` (1.1.32, `06e70fc^`); gerações anteriores medidas por `git show`.
- **Ambiente**: macOS 26.6.2 (25G83), Chrome for Testing `152.0.7977.64`, Node v26.5.0, pypdf 6.10.0. **Um Chrome por vez**: a fase serial, a sonda própria de E2E, a cadeia de mutação/E2E do autor e as duas auditorias ao vivo rodaram em cadeia serializada (`--test-concurrency=1`); as fases sem Chrome rodaram nos intervalos.
- **Declaração de independência**: escrevi as minhas próprias sondas (`adv134-leak.mjs`, `adv134-fp.mjs`, `dict134.mjs`, `adv134-perf.mjs`, `adv134-surfaces.test.mjs`, `adv134b-surfaces.test.mjs`, `adv134-google.mjs`, `artcheck134.py`) e as minhas próprias formas. Não usei a métrica do autor nem os documentos dele como prova: os números dele aparecem na tabela de conferência como *alegações*, cada uma com o meu procedimento ao lado. As duas auditorias ao vivo no Google são execuções minhas, do pacote, não artefatos herdados.

---

## 1. Veredito

**A 1.1.34 NÃO está aprovada como candidata.** O desenho novo de vocabulário resolve de fato o Critical e o Important da 1.1.33 naquilo que eles mediram — e a resolução é grande e verificável: as quatro compostas de `pin`, a caixa misturada, o caractere invisível, os rótulos sem acento e as três grafias de `saml_response` saem limpos; o corpus de 16 frases realistas que a 1.1.33 destruía em 14 passa a **0 de 16**; `Chaveiro`, `Secretaria`, `tokenizador`, `chaveamento`, `obsessão` e `passível` voltam a ser evidência preservada, inclusive em `placeholder`/`aria-label`/`alt`. A prova de não vacuidade do incremento finalmente tem dentes: contra os bytes da 1.1.33, **9 dos 17** testes E2E reprovam (conferido), e a métrica reprova **4 de 6** contra cada geração anterior (conferido) e 1 de 6 contra o pré-filtro pré-conserto (conferido, nomeando exatamente as formas que o autor declara ter achado).

Mas **a fronteira de palavra abriu uma classe nova no lado do falso negativo**, e ela chega às quatro superfícies entregues: rótulos e chaves em que o radical está no **início** de uma palavra colada em minúsculas — `senhaforte`, `tokenacesso`, `sessionid`, `cookieconsent`, `secretkey`, `data-senhaforte`, `data-sessionid`, `href="…?sessionid=…"` — eram tarjados pela 1.1.33 e **não são mais**. Medi ponta a ponta, nos bytes empacotados, com sonda própria de uma forma por página: sete formas chegam ao **relatório, ao modelo e à revisão guardados, ao artefato HTML e ao artefato JSON**; as cinco que reexecutei contra os bytes da 1.1.33 (três rótulos e dois `href`) **fecham lá**. É a mesma assinatura do Critical da 1.1.33 (estreitamento que devolve formas à página), agora do outro lado do radical. Some-se a isso um Important de falso positivo **novo** (o vocabulário de `certificado digital`/`assinatura eletrônica`/`conta corrente` destrói prosa legítima que fala do certificado, e o contêiner inteiro cai junto) e um Important pré-existente que continua aberto e ponta a ponta (rótulo partido por marcação dentro da palavra: `<b>sen</b>ha:`).

| Severidade | Qtd | Itens |
| --- | --- | --- |
| Critical | 1 | C1 rótulo/chave com radical no **início** de palavra colada (`senhaforte`, `tokenacesso`, `sessionid`, `data-senhaforte`, `data-sessionid`, `href ?sessionid=`) chega a 4 superfícies — era fechado na 1.1.33 |
| Important | 2 | I1 vocabulário novo destrói prosa legítima (`certificado digital A1/A3`, `assinatura eletrônica ICP-Brasil`, `conta corrente 12345-6`) e leva o controle irmão no caminho monotônico; I2 rótulo partido por marcação dentro da palavra (`<b>sen</b>ha:`) chega a 4 superfícies (pré-existente, não declarado) |
| Minor | 5 | M1 porta do pré-filtro recusa o que o decodificador aceita (escape octal) e aceita o que nenhum decodificador cobre (`%68`); M2 rota `#/auth/senha/X` consome o segmento errado e o valor sobrevive; M3 preço declarado incompleto nos dois sentidos; M4 fase paralela com número inconsistente e não reproduzível da raiz prescrita; M5 fase serial 80/72/8 contra 80/70/10 declarados (as 2 falhas de `url-pixel-consent` não ocorreram; as demais não são do incremento) |
| Observações | 10 | O1–O10 (inclui o que confere: forma isolada, falso positivo, artefatos entregues, privacidade, custo) |

**Distribuição depende de autorização explícita do usuário** — este relatório não a concede.

---

## 2. Achados

### C1 — A fronteira de palavra devolve à página os rótulos com o radical no INÍCIO da palavra colada

**Severidade: Critical. É regressão introduzida por este incremento** (a 1.1.33 tarjava todas estas formas; medido nas duas gerações, nos mesmos bytes de entrada e ponta a ponta).

Sonda própria, uma forma por página, 6 superfícies varridas (painel, relatório, modelo e revisão guardados, artefato HTML, artefato JSON, artefato CSV), nos **bytes empacotados**:

```
$ cd pkg && node --test --test-concurrency=1 test/e2e/adv134-surfaces.test.mjs
✖ adv134 CONCAT senhaforte   vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
✖ adv134 CONCAT tokenacesso  vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
✖ adv134 CONCAT sessionid    vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
✖ adv134 ATTR data-senhaforte vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
✖ adv134 ATTR data-sessionid  vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
ℹ tests 19  pass 11  fail 8

$ cd pkg && node --test --test-concurrency=1 test/e2e/adv134b-surfaces.test.mjs
✖ adv134b ATTR href sessionid  vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]   (<a href="/p?sessionid=ZQ7K2M9P4X">)
✖ adv134b ATTR href senhaforte vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
✔ adv134b ATTR href senha      vazou=[]          (controle: o radical exato continua fechado)
```

**Não vacuidade ponta a ponta** (mesma sonda, com o `src` da 1.1.33 dentro do espelho):

```
$ cd mut133 && node --test --test-concurrency=1 --test-name-pattern="CONCAT|href|SPLIT|PERCENT" \
    test/e2e/adv134-surfaces.test.mjs test/e2e/adv134b-surfaces.test.mjs
✔ CONCAT senhaforte   vazou=[]      ✔ CONCAT tokenacesso  vazou=[]      ✔ CONCAT sessionid  vazou=[]
✔ href sessionid      vazou=[]      ✔ href senhaforte     vazou=[]      ✔ href senha        vazou=[]
✖ SPLIT b no meio     vazou=[...4 superfícies...]   ✖ PERCENT sen%68a vazou=[...4 superfícies...]
ℹ tests 8  pass 6  fail 2
```

Ou seja: as cinco formas que a 1.1.34 devolve **eram fechadas na 1.1.33**, e as duas que continuam abertas (`SPLIT`, `PERCENT`) já estavam abertas lá — a distinção importa para atribuir o defeito ao incremento.

**Causa medida** (`src/core/privacy.js`): o radical só casa a palavra inteira ou o **fim** de uma palavra com prefixo de 2 a 12 letras:

```
WORD_HEAD  = (?:[A-Za-z]{2,12}|(?<![\p{L}\p{N}]))
WORD_TAIL  = (?!\p{L})
```

`userpin` (radical no fim, prefixo `user`) casa; `senhaforte` (radical no início, cauda `forte`) não tem alternativa que o cubra. A 1.1.33 casava por substring e por isso fechava as duas. A assimetria é exatamente o preço não declarado do desenho.

Sonda unitária própria (480 combinações forma × caminho, `adv134-leak.mjs`), regressões 1.1.33 → 1.1.34 agrupadas por forma:

```
✖ CONCAT senhaforte      6 caminhos    ✖ CONCAT senhatemporaria 6    ✖ CONCAT tokenacesso    6
✖ CONCAT chavedapi       6 caminhos    ✖ CONCAT senhadousuario  6    ✖ CONCAT chavesecreta   6
✖ FECHO SeNhA (seletor)  1 caminho     ✖ ENC octal JS (json/modelo) 2
```

e, na mesma sonda, os identificadores realistas que a 1.1.33 tarjava e a 1.1.34 não (`dbg4.mjs`/`dbg5.mjs`), em três superfícies de produto:

| Entrada | 1.1.34 | 1.1.33 |
| --- | --- | --- |
| trecho `<p>sessionid: VALOR</p>` | **VAZOU** | tarjado |
| trecho `<p>cookieconsent: VALOR</p>` | **VAZOU** | tarjado |
| trecho `<p>secretkey: VALOR</p>` / `passwordkey` | **VAZOU** | tarjado |
| trecho `<p>senhaforte:</p>` / `senhapadrao` / `chaveacesso` | **VAZOU** | tarjado |
| chave JSON `{"sessionid": "VALOR"}` | **VAZOU** | `[redacted]` |
| `sanitizeJsonData({href:"…?sessionid=VALOR"})` | **VAZOU** | removido |
| `?sessionid=VALOR` e `?cookieconsent=VALOR` em texto | **VAZOU** | tarjado |
| rota `#/jsessionid/VALOR` | **VAZOU** | removida |
| `sessiontoken`, `csrftoken`, `authtoken`, `senha_forte`, `senhaForte`, `sessionId`, `cookieConsent`, `senhaAtual` | tarjado | tarjado |

**Impacto no produto**: um relatório entregue a terceiros carrega o identificador de sessão quando a página o expõe em `data-sessionid`, em `href="…?sessionid=…"` (o sanitizador de URL do modelo usa o mesmo predicado) ou em texto de depuração `sessionid:`; e carrega o valor de um campo `senhaforte`/`data-senhaforte`. É a promessa central ("credencial da página não chega ao entregável") quebrada numa forma que a geração anterior cobria. `?sessionid=`/`;jsessionid=` em URL é infraestrutura comum de sessão — e o vocabulário tem `session`/`sessions` exatamente para isso.

**O que o autor deveria fazer**: (a) no caminho de **chave/nome de atributo/URL** (não na prosa, onde o preço de falso positivo é caro), aceitar continuações fechadas depois do radical — `sessionid`, `cookieconsent`, `secretkey`, `passwordkey`, `senhaforte`, `senhapadrao`, `tokenacesso`, `chaveacesso` — ou uma cauda `(?:id|key|keys|value|token|acesso|forte|padrao|consent|secret)` quando o radical estiver no início; (b) acrescentar as formas à métrica e ao E2E de forma isolada, que hoje passam 17/17 nos dois lados para esta classe; (c) declarar o preço do lado do falso negativo, que não está declarado em lugar nenhum.

---

### I1 — O vocabulário novo destrói evidência em prosa legítima (e leva o controle irmão)

**Severidade: Important. Regressão introduzida por este incremento** (as frases abaixo saem intactas na 1.1.33 e na 1.1.32).

Sonda própria, caminho JSON/HTML com marcação (o caminho que a revisão da 1.1.33 mediu) e o mesmo texto sem a marcação:

```
  134 DESTRUIDA  133 intacta   O certificado digital A1 tem validade de um ano
       134 saída: <p>O certificado digital [redacted] tem validade de um ano.</p>
  134 DESTRUIDA  133 intacta   O certificado digital A3 é exigido no pregão
  134 DESTRUIDA  133 intacta   A assinatura eletrônica ICP-Brasil foi aceita
       134 saída: <p>A assinatura eletrônica [redacted] foi aceita.</p>
  134 DESTRUIDA  133 intacta   A conta corrente 12345-6 foi encerrada
  134 DESTRUIDA  133 intacta   The hairpin: 12 units were sold   →  <p>The hairpin: [redacted]
  134 DESTRUIDA  133 DESTRUIDA O pushpin 3 caiu no chão            →  <p>O [redacted]   (contêiner inteiro)
```

Mecanismo: os quatro radicais de várias palavras que entram nesta versão (`dígito verificador`, `conta corrente`, `certificado digital`, `assinatura eletrônica`) casam a **cauda adjacente** com o predicado largo (`valueLikeToken`): qualquer token seguinte com **um dígito** já é "valor". `A1`, `A3`, `ICP-Brasil` e `12345-6` caem nisso; `do CPF é 0` não cai (o predicado forte do rótulo multi-palavra exige 6+ caracteres ou 4 dígitos) — o que mostra que o predicado largo é o que decide o caso.

Ponta a ponta, nos bytes empacotados, com **controle negativo na mesma página**:

```
$ cd pkg && node --test --test-concurrency=1 test/e2e/adv134-surfaces.test.mjs
✖ adv134 FP prosa conta corrente 12345-6    (a frase e o controle sumiram)
ℹ forma=fp-certificado ... vazou=[] controle=[modelo e revisão guardados|artefato json]
ℹ   frase do FP "O certificado digital A1 tem validade de um ano" presente em: []
```

Leitura da medição: em `fp-certificado` a frase **não aparece em nenhuma superfície entregue**; o controle que vem **depois** dela sobrevive no modelo e no JSON, mas **desaparece do relatório e do HTML** — é a marcação monotônica por conteúdo levando o irmão. Na variante com o controle **antes** do alvo (`adv134b`), o controle sobrevive nas quatro superfícies: a destruição é do parágrafo do alvo e do que vem depois dele, não da página inteira.

**Contexto medido (o lado bom, que confirma o fechamento do I1 da 1.1.33)**: no corpus de 16 frases realistas da revisão anterior, a destruição no caminho JSON cai de **14/16** (1.1.32 e 1.1.33) para **0/16** (1.1.34); no meu corpus ampliado de 40 frases, de **31/40** (1.1.32) e **26/40** (1.1.33) para **3/40** (1.1.34) — e duas das três restantes são justamente as novas (`certificado digital A1`, `conta corrente 12345-6`); a terceira (`Chave Pix: 12`) é pré-existente.

**Impacto no produto**: o relatório perde a frase que descreve o certificado digital da página (e o parágrafo seguinte, quando há um) — perda de evidência no entregável, agora causada por um vocabulário que o incremento **acrescentou**.

**O que o autor deveria fazer**: decidir e declarar o preço das quatro frases novas; se `certificado digital`/`assinatura eletrônica` ficam, exigir para elas o predicado **forte** (`strongValueToken`) também na cauda adjacente, ou exigir separador (`:`) para as frases novas em prosa sem marcação.

---

### I2 — Rótulo partido por marcação DENTRO da palavra não é reconhecido e chega às quatro superfícies

**Severidade: Important. Pré-existente** (a 1.1.33 vaza igual; medido nas duas gerações), **não declarado** em documento nenhum do incremento.

```
$ cd pkg && node --test --test-concurrency=1 test/e2e/adv134-surfaces.test.mjs
✖ adv134 SPLIT rotulo com b no meio  vazou=[relatório|modelo e revisão guardados|artefato html|artefato json]
     entrada: <p><b>sen</b>ha: ZQ7K2M9P4X</p>
$ cd mut133 && … mesma forma → ✖ também vaza (1.1.33)
```

Sonda unitária (`adv134-leak.mjs`, 480 combinações): `SPLIT b no meio`, `SPLIT span no meio`, `SPLIT comentario no meio`, `SPLIT chave no meio` vazam nos 6 caminhos, nas três gerações. `SPLIT frase no meio` (`conta cor<b>rente</b>`) é a exceção: o radical de várias palavras aceita separador, então sobrevive.

Mecanismo `src/core/evidence/snippet.js`: cada fragmento de texto é acumulado com um espaço (`textStream = ${textStream} ${decoded}`), então uma palavra partida em dois nós nunca é reconstruída; e o trecho entregue preserva a marcação crua. O caminho do modelo guarda o mesmo trecho.

**Impacto no produto**: o valor da credencial chega ao entregável quando a página estiliza parte do rótulo (`<b>Sen</b>ha:`) — situação plausível em títulos, realce de sintaxe e animação por caractere, e o produto já trata marcação **entre** rótulo e valor, mas não **dentro** do rótulo.

**O que o autor deveria fazer**: testar o sinal sobre a concatenação dos fragmentos **sem inserir separador** (o separador existe para não colar palavras de nós diferentes; uma segunda leitura sem o espaço, restrita ao teste de rótulo, resolve o caso sem reabrir `Senha da conta`).

---

### M1 — A porta do pré-filtro recusa o que o decodificador aceita (escape octal) e aceita o que nenhum decodificador cobre (`%68`)

**Severidade: Minor.** O octal é **regressão no caminho JSON/modelo com marcação**; no texto puro e o `%68` são pré-existentes (vazam nas três gerações), e o `%68` contradiz o comentário do código.

```
$ node dbg8.mjs
texto puro   "sen\150a: ZQ7K2M9P4X"     134 json = "sen\150a: ZQ7K2M9P4X"      133 json = "sen\150a: ZQ7K2M9P4X"   (vaza nas duas)
com marcação "<p>sen\150a: ZQ7K2M9P4X</p>"  134 json = "<p>sen\150a: ZQ7K2M9P4X</p>"   133 json = "[redacted]"   ← regressão
             trecho (134) = "<p>senha: [redacted]</p>"                                     (o trecho tarja nas duas)
$ node dbg1.mjs
json  percent  134="sen%68a: ZQ7K2M9P4X"   133="sen%68a: ZQ7K2M9P4X"
      decodeForMatching(134) = "sen%68a: ZQ7K2M9P4X"     ← nenhum decodificador cobre percent
      decodeForMatching(134) de "sen\150a: …" = "senha: …" ← o decodificador ENTENDE octal
```

- `ENCODED_HINT = /&#|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|%[0-9a-f]{2}/iu` não cobre `\150`, que `decodeForMatching` converte explicitamente ("Octal no estilo antigo de JavaScript"). Como `redactStringValue` sai em `if (!mayCarryCredential(value)) return …`, a string **com marcação** não é varrida no caminho JSON/modelo — e a 1.1.33 a tarjava (`[redacted]`).
- `sen%68a:` faz o pré-filtro dizer **sim** (`%68` casa), mas o texto não é decodificado em nenhum caminho: vaza nas quatro superfícies entregues (E2E, `PERCENT sen%68a`), nas três gerações. O comentário do código apresenta `sen%68a` como forma de esconder o rótulo que o pré-filtro precisa deixar passar — a metade que faltava (decodificar) não existe.

**Impacto**: baixo a moderado (as formas não são comuns em HTML de página, mas `sen\150a`/`sen%68a` aparecem em amostras de código e em texto copiado). A classe — porta e decodificador com listas divergentes — é a mesma que o autor já fechou duas vezes; é a terceira ocorrência.

### M2 — Rota com palavra sensível antes da chave: o motor consome o segmento errado e o valor sobrevive

**Severidade: Minor. Pré-existente** (1.1.33 igual), **não fechado**.

```
$ node dbg6.mjs
#/auth/senha/VALOR      134 VAZOU  133 VAZOU   saída: …th/[redacted]/VALOR
#/auth/pin/VALOR        134 VAZOU  133 VAZOU   saída: …th/[redacted]/VALOR
#/session/code/VALOR    134 VAZOU  133 VAZOU   saída: …ssion/[redacted]/VALOR
#/api/token/VALOR       134 ok     133 ok      saída: …i/token/[redacted]
```

`URL_CREDENTIAL_SEGMENT` casa `([#/])((?:URL_CREDENTIAL_KEY|SENSITIVE_WORD)/)([^/?#\s]*)` e a primeira ocorrência vence: em `#/auth/senha/X` o segmento `auth/` é a chave e `senha` vira o "valor" tarjado, deixando `X` intacto. O comentário do código afirma que a chave entrou no próprio padrão para o motor não consumir um segmento inocente — mas `auth`/`session` **são** palavras sensíveis, então o consumo errado continua.

### M3 — O preço declarado está incompleto nos dois sentidos

**Severidade: Minor.**

- **Lado falso positivo (declarado, mas subdimensionado)**: o README declara "palavra terminada em radical curto com 2+ letras de prefixo vira rótulo (`hairpin`, `pushpin`), e `spin` fica preservado". Conferi os três: `hairpin=true`, `pushpin=true`, `spin=false` (preservado), `backspin=true`. Mas a varredura de dicionário (`/usr/share/dict/words`, 234.289 entradas únicas, `dict134.mjs`) mostra que **87 palavras que a 1.1.33 não casava passam a casar** — `alypin, antihydropin, archipin, backspin, bespin, bowpin, breastpin, calepin, candlepin, catharpin, chapin, chappin, chinquapin, chopin, clothespin, coppin, crankpin, crappin, crispin, driftpin, duckpin, fingerspin, fivepins, galactolipin, galipoipin, glucolipin, glycolipin, gonadotropin, gulpin, hairpin, hatpin, inchpin, jalapin, kingpin, kittlepins, limpin, linchpin, linpin, lipin, lockpin, lycopin, mainpin, micropin, ninepin, ninepins, outspin, overspin, peppin, phospholipin, pippin, poppin, prelinpinpin, protopin, pushpin, repin, respin, sapin, scarfpin, sculpin, skelpin, stickpin, sulpholipin, tailpin, tampin, tarapin, tenpin, terpin, terrapin, tholepin, thoroughpin, tiepin, turlupin, turnpin, underpin, underspin, unpin, unspin, upspin, wankapin, wheelspin, yancopin, yoncopin, yuapin`. Nenhuma é credencial; `unpin`, `underpin` e `wheelspin` são as mais plausíveis em software. A declaração está qualitativamente certa e quantitativamente estreita (203 palavras casam no total, contra 284 da 1.1.33).
- **Lado falso negativo (não declarado)**: o C1 — radical no início de palavra colada — não aparece em nenhum documento como preço; o README descreve o mecanismo ("um radical casa a palavra inteira ou o **fim** de uma palavra") mas não mede o que isso deixa passar, e o que deixa passar eram formas fechadas na geração anterior.

### M4 — O número da fase paralela é internamente inconsistente e não sai da raiz de medição prescrita

**Severidade: Minor. Proveniência.**

Com a raiz que o brief prescreve (zip + `git archive HEAD test scripts package.json fixtures`):

```
$ cd pkg && node --test $(cat parallel-files.txt)      # 180 arquivos
ℹ tests 4210   ℹ pass 4203   ℹ fail 6   ℹ skipped 1
✖ plain-language usage docs …            ENOENT …/pkg/README.md
✖ the current package passes the neutral identity gate … (idem)
✖ normative ESM exports remain byte-identical to the 78ba813 baseline   (git show 78ba813:… em árvore sem .git)
✖ pins and vendors only the verified axe-core 4.13.0 runtime …          ENOENT package-lock.json
✖ publishes a complete privacy policy in Markdown and standalone HTML   ENOENT docs/…
✖ o guia do usuário só manda clicar em rótulo que existe no produto     (idem)
```

Somando `release/` e `store-assets/` do commit, 4 dessas 6 caem e as 6 restantes são exatamente as que dependem de `README.md`, `docs/`, `package-lock.json` e `.git`. No clone completo do commit (`pkgfull-git`): **`tests 4210 / pass 4209 / fail 0 / skipped 1`** (41,5 s). O autor declara **4.210 testes, 4.208 passam, 1 pulado, 0 falham** — 4.208 + 1 pulado = 4.209 ≠ 4.210: falta um teste na conta declarada. O total de testes confere; o de aprovados está errado por um.

### M5 — Fase serial: 80 testes / 72 passam / 8 falham (declarado: 80 / 70 / 10)

**Severidade: Minor. Mesma atribuição do autor, total diferente.**

```
$ cd pkg && AUDITA_E2E_CHROME=… node --test --test-concurrency=1 $(cat serial-files.txt)   # 37 arquivos
ℹ tests 80   ℹ pass 72   ℹ fail 8   ℹ duration_ms 385427
✖ 7 em test/e2e/sidepanel-flow-mv3.test.mjs
✖ 1 em test/e2e/axe-mv3-csp.test.mjs   ("cleanup axe limitado falhou: [{stage:profile, code:failed}]")
```

- **As 2 falhas declaradas em `url-pixel-consent-mv3` não ocorreram** (o arquivo passou, incluindo `URL pixel modes pause, survive worker restart, remain one-shot and clean owned tabs`, 33,4 s).
- **As 7 de `sidepanel-flow-mv3` não são do incremento**: rodei as cinco mais caras com o `src` da **1.1.33** dentro do espelho (`mut133`) e elas falham igual, com as mesmas durações (121,9 s / 30,9 s / 30,0 s / 30,0 s / 30,0 s): `current-page audits run in one inactive copy…`, `full-evidence can be cancelled at the privacy pause…`, `no-pixels shows progress…`, `element-only confirms once…`, `full-evidence rehydrates…` — 5 testes, 0 passam. As duas de "original-page ABNT markers" não foram reexecutadas por mim nesta revisão (a revisão da 1.1.33 as mediu falhando isoladas com os bytes da 1.1.33). É o arquivo do outro incremento, como o autor declara.
- **A de `axe-mv3-csp` passa 1/1 isolada** (1,05 s) — flakiness de carga, como o autor declara.

Conclusão da atribuição: **nenhuma falha serial é atribuível ao incremento da 1.1.34**, mas o total declarado (10) não é o medido (8), e a diferença está na flakiness que o próprio autor registra.

---

### Observações (O1–O10)

- **O1** O fechamento central do incremento confere, medido por mim, nas duas direções: as 5 compostas de PIN e o `data-userpin` saem limpos nas 6 superfícies no E2E próprio e no do autor (17/17); `SeNhA:`, `sen<ZWSP>ha:`, `car<SHY>tão:`, `numero de seguranca:`, `codigo de barras:`, `Dígito verificador:`, `conta corrente:`, `certificado digital:`, `assinatura eletrônica:` e `?saml_response=`/`?samlresponse=`/`?saml-response=`/`#saml_response=` saem limpos.
- **O2** O pré-filtro consertado tem dentes: com o `src` de `522ebee^` (antes do conserto), a métrica do autor reprova 1 de 6 **nomeando exatamente** `numero de seguranca`, `codigo de barras`, `digito verificador`, `codigo de verificacao` e as três grafias de `?saml_response` em `url-texto`/`url-json`; a minha sonda própria reproduz a mesma lista (52 formas vazando contra 41 da 1.1.34).
- **O3** Falso positivo do lado da evidência: `Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12 unidades`, `A senha foi alterada em 12/03/2026…`, `tokenizador`, `chaveamento`, `obsessão`, `passível`, `Pintura:`/`Pincel:`/`Espinha de peixe:` sobrevivem nas quatro superfícies; `placeholder="Chaveiro"`, `aria-label="Secretaria"`, `alt="Chaveiro"` e `title="Secretaria"` são preservados no trecho (na 1.1.33 eram descartados). `placeholder="Digite sua senha"` e `aria-label="Senha do usuário"` ainda perdem o **atributo** no trecho, mas o nome acessível sobrevive no modelo (medido: presente no modelo/JSON; não no relatório/HTML) — perda menor, não medida como achado.
- **O4** Auditoria ao vivo, duas execuções minhas, do pacote, `https://www.google.com/`, sem pixels, Chrome 152.0.7977.64:
  - **#1** (`b2d985b0…`, 05:40Z): 0 falhas confirmadas (0 ocorrências), 1 recomendação/alerta (1 ocorrência), **2 suspeitas (2 ocorrências)**, 9 positivos, **108 no checklist**, **cobertura 29,2%**, **índice 9,0/10**, **PDF de 17 páginas**, 4 exportações `complete`; 133 resultados de regra (9 `passed` / 1 `failed` / 94 `cantTell` / 29 `inapplicable`), 114 ocorrências, 8 evidências / 4.853 caracteres, 113 registros de revisão humana, 110 "Verificar o item".
  - **#2** (`f34d5c23…`, 05:40Z): 0 falhas, 1 alerta, **3 suspeitas (4 ocorrências)**, 9 positivos, **109 no checklist**, **cobertura 28,5%**, 9,0/10, **PDF de 18 páginas**; 134 resultados de regra (9/1/96/28), **118 ocorrências**, **11 evidências / 5.228 caracteres**, **117 registros de revisão humana**, **112 "Verificar o item"**.
  - Os números de #2 são **idênticos** aos que a rodada 73 declara para os bytes finais; os de #1 reproduzem a outra instância (108/29,2%/17 páginas) que o README atribui à variação de sessão. **A declaração do autor sobre a página do Google varia entre sessões está CONFIRMADA** — a diferença é de instância, não de versão.
- **O5** Cobertura e índice com fórmula e denominador explícitos, conferidos por aritmética nos dois artefatos: `coreRuleCount = 130` está na metodologia do JSON; `#1 (9+1+28)/130 = 29,23% → 29,2%`; `#2 (9+1+27)/130 = 28,46% → 28,5%`; índice `10×9/(9+1) = 9,0`; a fórmula impressa no HTML é a mesma do código (`COVERED_OUTCOMES = passed, failed, inapplicable`, `denominator = páginas tentadas × 130`).
- **O6** Artefatos entregues, nos dois pares: **146 itens = 96 requisitos + 50 recomendações** (conferido também estaticamente em `NBR17225_ITEMS`), **146/146 ids e títulos no HTML e no PDF**, **notas editoriais 5/5** nos dois, **0 palavras partidas**, **0 `[redacted]`** no HTML/JSON/PDF, **0 frases de "Inconformidade ao item"** com 0 falhas confirmadas (coerência), CSV = exportação de ocorrências (114 e 118 registros; 35/37 ids e títulos ausentes por desenho, agora descrito como tal), versão `1.1.34` declarada nos artefatos. **Nenhum** valor com forma de nonce (`"nonce":"…"`) e nenhum `data:image` nos artefatos dos dois modos sem pixels.
- **O7** Privacidade e autorização: na minha fase serial passam os testes de Chrome real que fixam os invariantes — `URL pixel modes pause, survive worker restart, remain one-shot and clean owned tabs` (33,4 s, diagnóstico `pre-consent-raster=0; one-shot=confirmed; cancel-cleanup=owned-only; document-drift=denied`), `audits one tokenized URL in no-pixels mode and keeps reports and exports public-safe` (15,7 s, `publicLeaks=0; rasterEvidence=0`), `highlights a live URL occurrence, clears it and exports its public-safe report` (5,3 s), `navigation drift accepts only a proven document B or a removed owner`. Li a asserção de `current-page-export-mv3` e ela **não é vacuosa**: exige um nonce real de destaque antes de varrer 8 superfícies. Não escrevi sonda própria nova para esta classe neste incremento.
- **O8** Custo: no corpus denso de radicais a 1.1.34 é **2,8× a 4,1×** mais lenta que a 1.1.33 (meu corpus de 4.000 nós: 379,7 ms contra 135,8 ms; corpus pesado: 391,2 ms contra 95,8 ms), e **7,5 ms para 20.000 strings sem radical** contra 107 ms da 1.1.33. A declaração do autor (2,1× e 9 ms) confere na direção e no número do caso limpo (7,5 ms ≈ 9 ms); o 2,1× exato é propriedade do corpus dele, e no meu o multiplicador é maior. Não encontrei caminho de produto proibitivo: o pior caso medido é ~0,4 s para um modelo de 4.000 nós densos de radical.
- **O9** Gate de release e reprodutibilidade: `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` no clone completo dá a linha declarada e exit 0 — `manifest/CSP e axe 4.13.0 aprovados no Chrome for Testing 152.0.7977.64; mapa numerado aprovado; 130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN`; e `node scripts/build-release.mjs --temporary-release-directory <mkdtemp>` no commit congelado **reproduz o mesmo SHA-256 `5ed1b333…2812`**.
- **O10** Não há teste com pessoa leiga — por decisão explícita do usuário (2026-09-16) ele **não** é portão de produção; também não medi leitor de tela real. Publicação em loja/distribuição externa **não está autorizada**; depende de autorização explícita do usuário.

---

## 3. Tabela de conferência (uma linha por alegação)

| # | Alegação conferida | Comando / procedimento | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | zip `5ed1b333…2812`, versão 1.1.34, HEAD `e84496a` | `shasum -a 256`, `git rev-parse HEAD`, `json.load(manifest.json)` | idênticos | **CONFIRMADO** |
| 2 | pacote ↔ árvore do commit, byte a byte | `diff -rq pkg/src pkgfull-git/src`, idem `vendor`/`assets`/`manifest.json`; `unzip` = 199 arquivos | `src`, `vendor`, `manifest` idênticos; só ícones de repositório fora do pacote (por desenho) | **CONFIRMADO** |
| 3 | build reprodutível | `node scripts/build-release.mjs --temporary-release-directory $(mkdtemp)` no clone do commit | mesmo SHA-256 `5ed1b333…2812` | **CONFIRMADO** |
| 4 | gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` GREEN | idem no clone completo | linha declarada, exit 0 | **CONFIRMADO** |
| 5 | fase paralela: 4.210 testes, 4.208 passam, 1 pulado, 0 falham | `node --test` nos 180 arquivos, clone completo com `.git` | **4.210 / 4.209 / 0 / 1** — o total e o pulado batem; "4.208 passam" é inconsistente (4.208+1 ≠ 4.210) | **PARCIAL** |
| 6 | a fase paralela sai da raiz prescrita (zip + árvore de teste do commit) | `node --test` nos 180 arquivos em `pkg` (e em `pkg`+`release`+`store-assets`) | 4.210 / 4.203 / **6** / 1 — as 6 falhas são arquivos do repositório ausentes (`README.md`, `docs/`, `package-lock.json`, `.git`), não produto | **NÃO REPRODUZÍVEL** (como declarado, só no clone completo) |
| 7 | fase serial: 80 testes, 70 passam, 10 falham (7 do outro incremento + 3 de flakiness) | `AUDITA_E2E_CHROME=… node --test --test-concurrency=1` nos 37 arquivos, em `pkg` | **80 / 72 / 8**: 7 em `sidepanel-flow-mv3` (falham igual com o `src` da 1.1.33) + 1 em `axe-mv3-csp` (passa 1/1 isolado); as 2 de `url-pixel-consent` **não ocorreram** | **PARCIAL** |
| 8 | métrica da classe: 75 formas, 286 combinações, 0 vazamentos | `node --test test/core/credential-class-metric.test.js` em `pkg` | `formas=75 combinações=286`, 6/6 passam | **CONFIRMADO** |
| 9 | métrica reprova 4 de 6 contra **cada** geração anterior | mutações `mut132` (`06e70fc^`) e `mut133` (`06e70fc`), só `src` | 4 de 6 em cada | **CONFIRMADO** |
| 10 | o pré-filtro consertado tem dentes | mutação `mut522` (`522ebee^`) | 1 de 6 reprova nomeando as 4 formas sem acento + as 3 grafias de `saml_response` (uni e url) | **CONFIRMADO** |
| 11 | E2E de forma isolada + falso positivo: 17/17 nos bytes entregues | `credential-shapes-mv3` (13) + `credential-false-positives-mv3` (4) em `pkg`, na fase serial | **17/17 verdes** | **CONFIRMADO** |
| 12 | contra os bytes da 1.1.33, **9 dos 17** reprovam | mesmos 17 testes em `mut133` | **8 passam, 9 falham** (5 formas de PIN + 3 falsos positivos + 1 atributo) | **CONFIRMADO** |
| 13 | o Critical da 1.1.33 está fechado (`userPin`, `cardPin`, `userpin`, `PINpad`, `data-userpin`) | sonda própria E2E (6 superfícies, uma forma por página) | as 5 formas limpas; na 1.1.33 vazavam | **CONFIRMADO** |
| 14 | caixa misturada e caractere invisível fechados | sondas próprias unit + E2E (`SeNhA:`) | `SeNhA:` limpo em todas as superfícies; `sen<ZWSP>ha`/`car<SHY>tão` tarjados pela segunda leitura sem marcas | **CONFIRMADO** |
| 15 | rótulos sem acento e as três grafias de `saml_response` fechados | sondas próprias unit + E2E de URL | `numero de seguranca`, `codigo de barras`, `?saml_response=`, `?samlresponse=`, `?saml-response=` limpos | **CONFIRMADO** |
| 16 | o resíduo de falso positivo da 1.1.33 está fechado (prosa, atributos) | corpus próprio de 16 e 40 frases + sonda E2E com controle | 16 frases: 14/16 destruídas na 1.1.33 → **0/16** na 1.1.34; `placeholder="Chaveiro"`/`aria-label="Secretaria"`/`alt="Chaveiro"` preservados | **CONFIRMADO** |
| 17 | o preço declarado do falso positivo (`hairpin`/`pushpin`, `spin` preservado) | `dict134.mjs` (`/usr/share/dict/words`, 234.289 únicas) | `hairpin=true`, `pushpin=true`, `backspin=true`, `spin=false`; **203** palavras casam contra **284** da 1.1.33; **87** são novas | **PARCIAL** (exemplos certos; classe maior que a declarada) |
| 18 | preço do lado do falso negativo declarado | leitura do README + sondas | **não declarado**: `senhaforte`, `tokenacesso`, `sessionid`, `data-senhaforte`, `?sessionid=` eram fechados na 1.1.33 e voltaram | **REFUTADO** |
| 19 | o desenho novo não abre nada novo | sonda própria E2E + unit nas duas gerações | **abre**: 6 formas de concatenação com radical no início (C1) e 2 formas novas de FP que destroem prosa (I1) | **REFUTADO** |
| 20 | auditoria ao vivo #1: 0 falhas, 1 alerta, 2 suspeitas (2), 9 positivos, 108 no checklist, 29,2%, 9,0/10, 17 páginas | execução minha do pacote em `google.com`, sem pixels + `artcheck134.py` | 0/1(1)/2(2)/9, 108, 29,2%, 9,0/10, 17 páginas, 4 exportações `complete` | **CONFIRMADO** |
| 21 | auditoria ao vivo #2 (bytes finais): 3 suspeitas (4 ocorrências), 109 no checklist, 28,5%, 18 páginas, 134 resultados, 118 ocorrências, 11 evidências/5.228 caracteres, 117 revisões, 112 "Verificar o item" | idem, segunda execução | **todos idênticos** | **CONFIRMADO** |
| 22 | a página do Google varia entre sessões (instância, não versão) | minhas duas execuções + README | #1 108/29,2%/17 páginas × #2 109/28,5%/18 páginas, mesma versão e mesmos bytes | **CONFIRMADO** |
| 23 | cobertura 28,5% com fórmula e denominador explícitos (130) | aritmética nos JSON entregues + texto do HTML | `(9+1+28)/130 = 29,2%` (#1) e `(9+1+27)/130 = 28,5%` (#2); `coreRuleCount=130` na metodologia | **CONFIRMADO** |
| 24 | índice 9,0/10 | `10×passed/(passed+failed)` no artefato | 9,0 nos dois; fórmula impressa confere | **CONFIRMADO** |
| 25 | 146 itens (96 requisitos + 50 recomendações) | artefatos + `NBR17225_ITEMS` estático | 146 = 96 + 50 nos dois | **CONFIRMADO** |
| 26 | 146/146 ids e títulos no HTML e no PDF; notas 5/5; 0 palavras partidas; 0 `[redacted]`; 0 "Inconformidade ao item" com 0 falhas | `artcheck134.py` (pypdf) nos dois pares | 146/146 e 146/146, 5/5 e 5/5, 0, 0, 0 — nos dois | **CONFIRMADO** |
| 27 | CSV é a exportação de ocorrências, sem número fixo | contagem própria | 114 e 118 registros; 35/37 ids e títulos ausentes (por desenho) | **CONFIRMADO** |
| 28 | invariantes de privacidade (nonce, one-shot, captura B, abas próprias, identidade antes do raster) | fase serial de Chrome real + leitura das asserções + varredura dos artefatos | testes verdes com diagnósticos `pre-consent-raster=0`, `one-shot=confirmed`, `cancel-cleanup=owned-only`, `document-drift=denied`, `publicLeaks=0`; 0 valores com forma de nonce nos artefatos | **CONFIRMADO** (sem sonda nova própria) |
| 29 | custo 2,1× no corpus denso e 9 ms para 20.000 strings sem radical | `adv134-perf.mjs`/`perf2.mjs` nos três `src` | **2,8×–4,1×** nos meus corpus densos; **7,5 ms** para 20.000 strings limpas (1.1.33: 107 ms) | **PARCIAL** (ordem de grandeza e caso limpo conferem; o 2,1× exato é do corpus do autor) |
| 30 | "todos os bloqueios da 1.1.33 fechados" | meus achados C1/I1/I2/M1–M5 | C1, I1, I2 abertos (1 Critical + 2 Important) | **REFUTADO** |

---

## 4. O que confere (medição própria)

- **Integridade e reprodutibilidade**: digest conferido duas vezes, pacote ↔ árvore byte a byte, reconstrução determinística do zip.
- **O desenho novo funciona no que ele se propôs**: fronteira de palavra, marca de camelCase com segunda leitura, pré-filtro e os quatro vocabulários novos entram e fecham, cada um com prova nos dois sentidos (tabela 8–16).
- **Não vacuidade**: as mutações de `src` reprovam os instrumentos do autor (4/6 da métrica contra cada geração; 9/17 do E2E contra a 1.1.33; 1/6 contra o pré-filtro pré-conserto) e reprovam também a minha sonda (C1 confirmado nas duas gerações).
- **Artefatos entregues e auditoria ao vivo**: todos os números que o autor declara para os bytes finais (`5ed1b333…`) se reproduzem na minha execução #2, e a variação entre as minhas duas execuções confirma a explicação de instância — sem nenhum `[redacted]`, nenhuma frase legal indevida e nenhum id/título ausente.
- **Falso positivo do lado da evidência**: o corpus da revisão anterior cai de 14/16 para 0/16 destruídas, e os atributos de nome acessível legítimos voltam ao trecho.
- **Gate e privacidade**: gate GREEN com a linha declarada; os E2E de pixel/URL/destaque que fixam os invariantes passam na minha execução, com os diagnósticos esperados.

---

## 5. Fase serial — atribuição de cada falha

`cd pkg && AUDITA_E2E_CHROME=… node --test --test-concurrency=1` sobre os 37 arquivos de `REAL_CHROME_E2E`, na raiz com os bytes do zip e a árvore de teste do commit: **80 testes, 72 passam, 8 falham** (385,4 s).

| # | Falha | Arquivo | Dono | Reproduz com o `src` da 1.1.33? | Reproduz isolada? |
| --- | --- | --- | --- | --- | --- |
| 1 | original-page ABNT markers remain usable across idle… | `sidepanel-flow-mv3` | outro incremento | não reexecutei nesta revisão (a revisão da 1.1.33 mediu as duas falhando isoladas com os bytes da 1.1.33) | — |
| 2 | original-page ABNT markers visual review and verified exports | `sidepanel-flow-mv3` | outro incremento | idem | — |
| 3 | current-page audits run in one inactive copy… | `sidepanel-flow-mv3` | outro incremento | **falha igual** (`mut133`, 121,9 s × 121,9 s) | — |
| 4 | full-evidence can be cancelled at the privacy pause… | `sidepanel-flow-mv3` | outro incremento | **falha igual** (30,9 s × 30,9 s) | — |
| 5 | no-pixels shows progress, completes in the copy… | `sidepanel-flow-mv3` | outro incremento | **falha igual** (30,0 s × 30,0 s) | — |
| 6 | element-only confirms once… | `sidepanel-flow-mv3` | outro incremento | **falha igual** (mesma passagem `--test-name-pattern` em `mut133`) | — |
| 7 | full-evidence rehydrates after worker restart… | `sidepanel-flow-mv3` | outro incremento | **falha igual** (mesma passagem) | — |
| 8 | runs pinned local axe in every isolated frame… | `axe-mv3-csp` | flakiness de carga | — | **passa 1/1** (1,05 s) |

Nenhuma falha morre em asserção sobre resultado de auditoria do produto; a única fora do arquivo do outro incremento passa isolada. **Nenhuma falha serial é atribuível ao incremento da 1.1.34** — mas o total medido (8) difere do declarado (10).

---

## 6. O que eu NÃO consegui verificar

- **A superfície PDF para as minhas sentinelas de credencial**: as minhas sondas varrem painel, relatório, modelo/revisão, HTML, JSON e CSV. O PDF foi conferido por extração de texto (146/146 ids e títulos, 0 palavras partidas, notas 5/5, 0 `[redacted]`), mas não varri o PDF por substring das minhas sentinelas — mesma limitação que as revisões anteriores declaram.
- **Repetição estatística**: duas auditorias ao vivo e uma passagem de cada fase; não fiz três repetições para separar flakiness de defeito. As falhas seriais foram atribuídas por reexecução com a geração anterior e por execução isolada, não por repetição da fase.
- **O octal e o `%68` ponta a ponta**: medi o vazamento no caminho JSON/modelo e no trecho; não executei um E2E com uma página que contenha `sen\150a:`/`sen%68a:` (o `%68` foi medido ponta a ponta pela minha sonda E2E; o octal, só unitariamente).
- **Confusáveis Unicode** (`senhа` com `а` cirílico): medi que vaza em todas as superfícies e em todas as gerações; **não** o classifiquei como achado por ser evasão de terceiro fora do vocabulário (blocklist), e não medi se o produto entrega esse texto com a grafia trocada de forma enganosa.
- **Outros idiomas** (`contraseña`, `clave`, `kennwort`, `wachtwoord`, `parola d'ordine`): vazam nas três gerações, fora do vocabulário por desenho; registrado como medição crua, não como achado.
- **CDATA, `<template>`, `<noscript>`, variantes NFD/NFC de rótulo acentuado, CDN/proxy que reescreva o HTML**: não medidos.
- **Runtime clássico de persona** (`accessible-preview-runtime.classic.js`): continua sem tarja e eu não tracei superfície entregue.
- **Leitor de tela real e pessoa leiga**: não testados (o segundo por decisão do usuário).
- **Chrome fora do CFT 152.0.7977.64** e **`verify-project.mjs` por dentro** (rodei só o gate).
- Não despejei nem li dados de sessão/e-mail; o conteúdo citado dos artefatos é de página pública (`google.com`) e só em contextos de contagem/verificação.

---

## 7. Estado do checkout congelado

```
$ cd /private/tmp/audita-review-134 && git rev-parse HEAD
e84496aae8de32841c070aafcba7b87e75fae1c9
$ git status --porcelain
?? docs/qa/revisoes/REVIEW-1.1.34.md      # só o arquivo deste relatório
```

O congelado **não recebeu nenhuma alteração de produto**: toda sonda, mutação, espelho, reconstrução de pacote e log ficou em `/private/tmp/audita-review-134-scratch`. Nada foi escrito em `/Volumes/SSD1/acessibilidade-digital` nem em `.worktrees/audita-mt`.

### Artefatos da revisão (em `/private/tmp/audita-review-134-scratch/`)

- `pkg/` (zip extraído + árvore de teste do commit + `release/` + `store-assets/`), `pkgfull-git/` (clone completo do commit, com `.git`), `gen133/`, `gen132/` (`src` por `git show`), `mut522/`, `mut133/`, `mut132/`, `orig/` (zip original preservado).
- Sondas unitárias: `adv134-leak.mjs` (100 formas × 480 combinações, três gerações), `adv134-fp.mjs` (40 frases + 11 atributos, três gerações), `dict134.mjs` (dicionário), `adv134-perf.mjs`, `perf2.mjs`, `dbg1.mjs`–`dbg7.mjs`.
- Sondas E2E (Chrome real, 6 superfícies, uma forma por página): `pkg/test/e2e/adv134-surfaces.test.mjs` (19 formas), `pkg/test/e2e/adv134b-surfaces.test.mjs` (5 formas).
- Auditoria ao vivo: `adv134-google.mjs`, artefatos em `artifacts-a/` e `artifacts-b/`, instrumento próprio `artcheck134.py`.
- Logs: `logs/serial1.log`, `logs/parallel2.log`, `logs/parallel-git.log`, `logs/adv134-surfaces.log`, `logs/adv134b.log`, `logs/mut133-e2e.log`, `logs/google-a2.log`, `logs/google-b2.log`.
