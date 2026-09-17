# Revisão adversarial independente — Audita Acessibilidade 1.1.33

- **Alvo**: `release/audita-acessibilidade-1.1.33.zip`, SHA-256 `6b1f27339c2b3871240c4a3d4f2712933bb0ef818c0a5ef80d3b09ddc107ee20` (conferido por mim com `shasum -a 256`).
- **Checkout congelado**: `/private/tmp/audita-review-133`, HEAD `06e70fc`, `manifest.json` = `1.1.33`. O congelado não foi usado para escrever nada além deste relatório; todas as medições rodaram em cópias em `/private/tmp/audita-review-133-scratch` (§7).
- **Bytes medidos**: pacote extraído em `.../scratch/pkg` (199 arquivos, `unzip`), espelho `.../scratch/mirror` (árvore congelada com `src/`, `vendor/`, `assets/` e `manifest.json` **do zip**, conferido por `diff -r`), mutações `mut132` (só o `privacy.js` da 1.1.32) e `mutdb` (só o `privacy.js` de `06e70fc^`).
- **Ambiente**: macOS 26.6.2 (25G83), Chrome for Testing `152.0.7977.64` (`/private/tmp/audita-cft152-fixed/...`), Node v26.5.0, pypdf 6.10.0. **Um Chrome por vez**: toda a fase de Chrome rodou em cadeias serializadas (`--test-concurrency=1`); a fase paralela rodou sozinha depois.
- **Declaração de independência**: escrevi as minhas próprias sondas (`leak-probe.mjs`, `fp-probe.mjs`, `prose-corpus.mjs`, `adv133-surfaces.test.mjs`, `adv133-attr.test.mjs`, `adv133-fp2.test.mjs`) e as minhas próprias contagens (`artcheck-mine.py`). Não usei a métrica do autor nem os documentos dele como prova de nada: os números dele aparecem na tabela de conferência como *alegações*, cada uma com o meu procedimento ao lado. Onde reusei instrumento alheio (`print-integrity.py`, `/private/tmp/adv133/google-pkg133.mjs`), conferi as contagens por conta própria e digo o que conferi.

---

## 1. Veredito

**A 1.1.33 NÃO está aprovada como candidata.** O incremento fecha de fato o Critical de vocabulário nas formas medidas: os controles `PIN:` e `CVV:` saem limpos nas 6 superfícies, o E2E de forma isolada do autor passa **8/8** nos bytes entregues (inclui `card-cvv` e `boleto-linha`) e os 8 rótulos declarados são tarjados nos caminhos de texto e JSON (com a ressalva unitária de O3 para separadores fora de `[-–—:]`). Conserta também a regressão de marcação (I1) e o plano de testes (I3). Mas **a mesma classe continua aberta em formas novas**: a fronteira do radical `pin` que fechou o falso positivo de "shipping" **estreitou a detecção** e devolveu à página composta (`userPin`, `cardPin`, `PINpad`, `data-userpin`) o caminho para quatro superfícies entregues — e esse é exatamente o padrão das seis revisões anteriores. O resíduo de falso positivo que o autor declara como "pré-existente, registrado como observação" **destrói evidência nas quatro superfícies** quando a palavra-radical aparece com valor: medido por comparação com a mesma fixture sem a palavra, e o controle da mesma página cai junto porque a marcação por conteúdo é monotônica. E a prova de não vacuidade do incremento **não tem dentes ponta a ponta para a fronteira do radical**: a mesma suíte de formas isoladas passa 8/8 dos dois lados.

| Severidade | Qtd | Itens |
| --- | --- | --- |
| Critical | 1 | C1 `pin` composto (`userPin`, `cardPin`, `PINpad`, `data-userpin`) chega a 4 superfícies entregues |
| Important | 3 | I1 resíduo de falso positivo destrói evidência nas 4 superfícies (impacto maior que o declarado); I2 números da fase serial não reproduzíveis do commit congelado (teste da árvore de dev); I3 não vacuidade do incremento sem dentes ponta a ponta para a fronteira do radical |
| Minor | 4 | M1 janela de rótulo > 6 palavras ainda vaza ponta a ponta; M2 doc de critérios cita 54/213 contra 57/222 do teste; M3 "CSV 118 linhas" (medido 117/116); M4 "os 146 itens estão nos quatro artefatos" (CSV sem 34 ids e 36 títulos) |
| Observações | 8 | O1–O8 (inclui o que confere: integridade, gate, forma isolada, privacidade, artefatos entregues) |

**Distribuição depende de autorização explícita do usuário** — este relatório não a concede.

---

## 2. Achados

### C1 — `pin` como componente de palavra volta a chegar a quatro superfícies entregues

**Severidade: Critical. Não é regressão contra a 1.1.32; é estreitamento introduzido por este incremento** (o pacote intermediário `6f26a822`, do próprio autor, pegava estas formas — medido na sonda reduzida, abaixo).

Sonda própria, uma forma por página, sentinela com cara de credencial, 6 superfícies varridas (painel, relatório, modelo e revisão guardados, artefato html, artefato json, artefato csv), nos **bytes empacotados**:

```
$ node --test --test-concurrency=1 test/e2e/adv133-surfaces.test.mjs   # no espelho
✔ CONTROLE CVV com dois-pontos        vazou=nenhuma
✔ CONTROLE PIN com dois-pontos        vazou=nenhuma
✖ pin camelCase prefixado userPin     vazou=relatório|modelo e revisão guardados|artefato html|artefato json
     relatório: ...<code>&lt;main&gt;&lt;h1&gt;Forma isolada&lt;/h1&gt;&lt;p&gt;userPin: ADV133PINUSER7X&lt;/p&gt;...
     modelo   : ...,"visibleText":"Forma isolada userPin: ADV133PINUSER7X"}...
✖ pin em CamelCase PINpad             vazou=relatório|modelo e revisão guardados|artefato html|artefato json
✖ pin camelCase cardPin               vazou=relatório|modelo e revisão guardados|artefato html|artefato json
✔ PIN com barra vertical              vazou=nenhuma
✔ CVV com barra vertical              vazou=nenhuma
✔ PIN com tabulação                   vazou=nenhuma
✖ janela de 5 palavras                vazou=relatório|modelo e revisão guardados|artefato html|artefato json
✖ janela de 7 palavras                vazou=relatório|modelo e revisão guardados|artefato html|artefato json
✔ rótulo em entidade numérica         vazou=nenhuma
✔ th PIN e td valor                   vazou=nenhuma
✖ dígito verificador                  vazou=relatório|modelo e revisão guardados|artefato html|artefato json
ℹ tests 13  pass 7  fail 6
```

E na sonda de atributos (`adv133-attr.test.mjs`, 6 formas), a única que vaza é a forma composta:

```
✖ atributo data-* com PIN prefixado   vazou=relatório|modelo e revisão guardados|artefato html|artefato json
     relatório: ...&lt;div data-userpin="ADV133ATTRDATA7X"&gt;x&lt;/div&gt;...
     modelo   : ..."snippet":"<main><h1>Forma isolada</h1><div data-userpin=\"ADV133ATTRDATA7X\">x</div>...
✔ CONTROLE atributo title "senha:"        vazou=nenhuma
✔ data-note com barra vertical             vazou=nenhuma
✔ alt com barra vertical                   vazou=nenhuma
✔ title multi-palavra                      vazou=nenhuma
✔ placeholder multi-palavra                vazou=nenhuma
```

**Causa medida** (`src/core/privacy.js:91`, a única linha de produto que este incremento mudou):

```
(?<![\p{L}\p{N}])pin(?:s)?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pin[-_ ]?(?:c[óo]digo|code)
```

O lookbehind exige que `pin` **não** seja precedido de letra ou número. Toda forma em que `pin` é o *segundo* componente de uma palavra colada (`userPin`, `cardPin`, `appPin`, `PINpad`, `data-userpin`) deixa de casar — e nenhuma outra alternativa do vocabulário a cobre:

```
$ node dbg-mutdb.mjs          # SENSITIVE_KEY.test em três gerações, mesmos bytes de entrada
1.1.32               userPin=livre  cardPin=livre  PINpad=livre  pinCode=livre  pin=livre
06e70fc^ (db7ad29)   userPin=casa   cardPin=casa   PINpad=casa   pinCode=casa   pin=casa
1.1.33 (entregue)    userPin=livre  cardPin=livre  PINpad=livre  pinCode=casa   pin=casa
```

O próprio autor enumerou as compostas que queria manter (`pin-code`, `pin_code`, `pinCode`, `pincode`, `PIN CODE` — e todas continuam fechadas, medido acima), mas a lista não cobre prefixo camelCase nem `PINpad`/`data-*`. E o custo é o inverso do que a métrica controla: o corpus `NAO_ROTULO` prova que `shipping`/`pintura` não viram rótulo, não que `userPin` vire.

**Não vacuidade ponta a ponta da mutação** (sonda reduzida, mesmos 4 casos, com o `privacy.js` de `06e70fc^` dentro do espelho da 1.1.33):

```
$ cd mutdb && node --test --test-concurrency=1 test/e2e/adv133-pinonly.test.mjs
✔ CONTROLE PIN com dois-pontos   ✔ userPin   ✔ PINpad   ✔ cardPin      ℹ tests 4  pass 4  fail 0
```

Ou seja: o pacote **intermediário** do autor fechava estas três formas e o pacote **entregue** as devolve. Contra a 1.1.32 (geração revisada anterior) não há regressão — lá *todas* as formas de `pin` vazavam (é o Critical C1 daquela revisão) —, mas o fechamento anunciado do Critical é **incompleto** e o preço não foi declarado em lugar nenhum: o README declara o preço do lado do falso positivo (frase-senha só de letras) e **não** declara o do lado do falso negativo.

**Impacto no produto**: um relatório de auditoria entregue a terceiros (HTML/JSON/CSV) carrega o valor do PIN do cartão quando a página o rotula como `userPin`, `cardPin`, `PINpad` ou o expõe em `data-userpin`. É a promessa central do produto ("credencial da página não chega ao entregável") quebrada na família que o incremento dizia fechar.

**O que o autor deveria fazer**: (a) cobrir as compostas por prefixo e por `data-*`, por exemplo mantendo a fronteira para o caminho de prosa e acrescentando ao caminho de chave/nome de atributo uma alternativa de sufixo (`[\p{L}]{0,12}pin(?:s)?(?![\p{L}\p{N}])`) mais compostas explícitas (`pinpad`, `pin[-_ ]?block`, `pin[-_ ]?number`) — o custo de falso positivo é menor no caminho de chave do que na prosa, e o preço precisa ser declarado; (b) acrescentar as quatro formas à métrica da classe e ao E2E de forma isolada, que hoje passam 8/8 nos dois lados da mutação (I3); (c) declarar no README qual lado foi escolhido e com que medição.

---

### I1 — O resíduo de falso positivo do vocabulário destrói evidência nas quatro superfícies entregues

**Severidade: Important. Pré-existente** (a 1.1.32 se comporta igual no mesmo caminho), **mas o impacto declarado está subdimensionado**: o autor registra "resíduo pré-existente… `chaveiro`, `chaveamento`, `tokenizador` continuam sendo tarjadas quando seguidas de separador e valor", sem medir o que isso faz com a evidência entregue.

Sonda de falso positivo com **controle negativo na mesma página** (`adv133-fp2.test.mjs`), 5 formas:

```
$ node --test --test-concurrency=1 test/e2e/adv133-fp2.test.mjs      # no espelho
✖ valor com rótulo que contém radical
   CONTROLE "Fatura: R$ 30,00"               em: NENHUMA
   ALVO     "Chaveiro: R$ 30,00"             em: NENHUMA
✖ palavra da secretaria
   CONTROLE "Portal da Saúde: 12 unidades"   em: NENHUMA
   ALVO     "Secretaria de Saúde: 12 unidades" em: NENHUMA
✖ prosa com palavra e data longa
   CONTROLE "A matrícula foi alterada em 12/03/2026 pelo administrador." em: NENHUMA
   ALVO     "A senha foi alterada em 12/03/2026 pelo administrador."     em: NENHUMA
✔ prosa com palavra e data curta              (CONTROLE e ALVO presentes nas 4 superfícies)
✔ atributos de rótulo legítimos
   CONTROLE placeholde="Fatura" em: relatório        ALVO placeholder="Chaveiro" em: NENHUMA
```

A forma "prosa com data curta" é o **controle positivo da medição**: mesma fixture, mesma estrutura, mesma superfície, e ali controle e alvo aparecem nas quatro superfícies. A diferença entre preservar e destruir é só a palavra-radical (e, num caso, o ano de quatro dígitos). No caso dos atributos, o controle (`placeholder="Fatura"`) aparece no relatório e o alvo (`placeholder="Chaveiro"`) não aparece em superfície nenhuma; a unidade mostra o mecanismo exato — o atributo legítimo é **descartado inteiro** (`snippet.js:171`, `SENSITIVE.test(value)` + `SENSITIVE_LABEL_ONLY` ancorado, que não aceita a palavra com sufixo):

```
<input placeholder="Chaveiro">    SENSITIVE_KEY=true   trecho="<input>"                          (atributo descartado)
<input placeholder="Fatura">      SENSITIVE_KEY=false  trecho="<input placeholder=\"Fatura\">"   (atributo preservado)
<input aria-label="Secretaria">   SENSITIVE_KEY=true   trecho="<input>"                          (nome acessível perdido)
<input alt="Chaveiro">            SENSITIVE_KEY=true   trecho="<input>"                          (texto alternativo perdido)
```

Ou seja: um campo legítimo chega à evidência sem o seu nome acessível — exatamente o falso negativo que o comentário do próprio código diz querer evitar. (No caminho JSON puro o valor do atributo sobrevive, porque sozinho ele não tem rótulo+valor; a perda é do **trecho de evidência**, que é o que o relatório e os artefatos mostram.)

**Mecanismo medido** (`fp-mech.mjs`, unidade, no pacote):

```
ALVO "Chaveiro: R$ 30,00"
  trecho  contém alvo? false  contém controle? false
          -> "<main>...<p>Chaveiro: [redacted]</p></section><section><h2>[redacted]</h2><p>[redacted]</p></se"
  json    -> "<main>...<p>Chaveiro: [redacted]"          (a string TERMINA ali)
ALVO "A senha foi alterada em 12/03/2026 pelo administrador."
  trecho  contém alvo? false  contém controle? false     (idem: o irmão seguinte cai junto)
ALVO "A senha expira em 12/03."
  trecho  contém alvo? true   contém controle? true      (sobrevive no trecho; cai no json)
```

Duas coisas se somam: (1) o tarjador de cauda decide por token e o **token final carrega a marcação** (`12/03.</p>` → o extrator de pontuação final `[.!?,;:…"')}\]]+$` não remove `<` nem `/`, então o "valor" tem símbolo e comprimento de sobra); (2) uma vez aceso o sinal, a marcação por conteúdo é monotônica e **o resto do trecho cai** — inclusive o parágrafo-controle irmão, que não tem palavra nenhuma. Corpus de prosa realista no caminho JSON (`prose-corpus.mjs`): **14 de 16 frases destruídas na 1.1.33 e 14 de 16 na 1.1.32** (`A senha deve ser forte`, `A senha deve ter pelo menos oito caracteres`, `Sua senha é pessoal e intransferível`, `Informe o token no cabeçalho Authorization`, `O segredo de justiça requer credenciamento no sistema`, `Digite sua senha atual`…). E a precondição existe no artefato entregue: **9 de 9 snippets** do JSON da auditoria ao vivo carregam marcação crua (`<div jscontroller=…`), e o caminho JSON é onde o defeito vive.

Palavras reais de português que passam a ser rótulo (medido palavra a palavra): `chaveiro`, `chaveta`, `chaveamento`, `secretaria`, `secretário`, `secretariado`, `secreto`, `obsessão`, `obsessões`, `possessão`, `possessões`, `passível`, `passíveis`, `passé` — além das que o autor já declarou. `SENSITIVE_KEY.test()` casa por substring e o sufixo `[\p{L}\p{N}]{0,24}` transforma a palavra inteira em rótulo.

**Impacto no produto**: perda de evidência (não de credencial) no relatório e nos artefatos, com dois agravantes — o trecho inteiro do contêiner cai (não só o valor) e o campo pode chegar sem `placeholder`/`aria-label`, o que enfraquece qualquer regra que julgue nome acessível. É o mesmo custo que a revisão da 1.1.32 mediu no I2 dela, sobrevivendo por outro caminho.

**O que o autor deveria fazer**: (a) declarar o impacto com medição, não só a existência do resíduo; (b) fazer o extrator de pontuação de `credentialLikeToken`/`strongValueToken` também descartar marcação (`<`, `>`, `/`) antes de decidir "cara de valor"; (c) para atributos de rótulo, preservar o valor quando ele for uma palavra única que apenas *contém* o radical, exigindo a mesma fronteira que a 1.1.33 passou a exigir para `pin`; (d) decidir e declarar o preço nos dois sentidos.

---

### I2 — Os números da fase serial não se reproduzem a partir do commit congelado

**Severidade: Important. Reincidência exata do defeito de proveniência que a revisão da 1.1.32 registrou** (lá em M4, "a raiz de teste do autor traz a versão da árvore de desenvolvimento").

A raiz de teste usada nas medições declaradas (`/private/tmp/g133/run`) **não** tem o `test/` do commit congelado:

```
$ shasum -a 256 /private/tmp/g133/run/test/e2e/sidepanel-flow-mv3.test.mjs
f3999ed038db886a…                       # = árvore de dev .worktrees/audita-mt (conferido)
$ git show HEAD:test/e2e/sidepanel-flow-mv3.test.mjs | shasum -a 256
558372547509d3cc…                       # = o arquivo do commit 06e70fc
$ diff -rq /private/tmp/g133/run/test  .../scratch/mirror/test
Files .../sidepanel-flow-mv3.test.mjs differ
Only in /private/tmp/g133/run/test: popup
Only in /private/tmp/g133/run/test/e2e/fixtures: download-fault-extension
```

A versão da árvore de dev tem **4** `test(` de topo contra **3** do arquivo congelado (e um nome de teste diferente: "characterize native screenshot viewport preservation" × "passive current-page observes memory-only elements…"). Rodando a fase serial **do commit congelado**, o resultado não é o declarado:

| | Declarado (README, rodada 71, critério 12) | Medido por mim (espelho, bytes do zip) |
| --- | --- | --- |
| testes | 74 | **71** |
| passam | 65 | **63** |
| falham | 9 | **8** |
| onde falham | "todas em `sidepanel-flow-mv3.test.mjs`" | 7 em `sidepanel-flow-mv3.test.mjs` + **1 em `page-markers-signals-mv3.test.mjs`** |

```
$ node serial-run.mjs <mirror>           # 36 arquivos, --test-concurrency=1, Chrome real
discovered=216 parallel=180 serial=36
ℹ tests 71  ℹ pass 63  ℹ fail 8  ℹ duration_ms 358452
```

Atribuição de cada falha (§5): as 7 de `sidepanel-flow` **reproduzem isoladas** (9 testes, 2 passam, 7 falham: 4× `WAIT_TIMEOUT`, 2× `CDP_COMMAND_TIMEOUT`, 1× `FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED`) — é o arquivo do outro incremento, como o autor diz; a de `page-markers-signals` **passa isolada** (1/1, 1,9 s) e é carga/instância da fase, não defeito do incremento.

**Impacto**: o número de gate não tem comando reproduzível a partir do artefato, e a frase "as 9 estão todas no arquivo do outro incremento" depende de um arquivo de teste que não é o do commit — a mesma classe de achado ("número sem comando, medição de outra geração apresentada como atual") que já rendeu em todas as revisões. O produto não é afetado: `src/` do pacote é idêntico ao da árvore (§4, integridade).

**O que o autor deveria fazer**: montar a raiz de medição copiando `test/` **do commit congelado** (não da árvore de dev) e redeclarar os números; se quiser medir a versão em edição, dizer qual é.

---

### I3 — A prova de não vacuidade do incremento não tem dentes ponta a ponta para a fronteira do radical

**Severidade: Important** (é a lacuna de método que deixou o C1 passar).

A alegação é que "a métrica da classe e o E2E de forma isolada reprovam contra a geração anterior". Medido nas duas mutações:

| Prova | Contra `1.1.32` | Contra `06e70fc^` (db7ad29, o pacote substituído) |
| --- | --- | --- |
| Métrica da classe (`test/core/credential-class-metric.test.js`) | **reprova em 3 dos 5 testes** (24 vazamentos nomeados + `"CVV: 123" precisa acender o sinal` + o corpus de fronteira) | **reprova em 1 dos 5** — só `palavra da língua com radical curto…` (`"shipping" contém radical curto e não é rótulo`); o grupo `CARTAO` inteiro **passa** |
| E2E de forma isolada (`test/e2e/credential-shapes-mv3.test.mjs`) | **6 passam, 2 falham** — exatamente `card-cvv` e `boleto-linha` ✅ confere a alegação | **8 passam, 0 falham** — **nenhum dente** para a fronteira do radical |

```
$ cd mut132 && node --test test/core/credential-class-metric.test.js   → tests 5  pass 2  fail 3
$ cd mutdb  && node --test test/core/credential-class-metric.test.js   → tests 5  pass 4  fail 1
$ cd mut132 && node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs → tests 8 pass 6 fail 2
$ cd mutdb  && node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs → tests 8 pass 8 fail 0
```

Ou seja: o E2E de forma isolada prova o vocabulário de cartão contra a 1.1.32, e **passa nos dois lados** quando o alvo é a mudança de fronteira deste commit — é uma prova sem dentes para o incremento, exatamente o critério que o brief manda aplicar ("uma forma que passa nos dois lados não tem dentes para este incremento"). A fronteira só é coberta por uma asserção unitária (`NAO_ROTULO`) e por um E2E de **outro** item (`input-purpose-observation`, 5.9.8) — que não cobre o lado do falso negativo (formas compostas de PIN), como o C1 mostra.

**O que o autor deveria fazer**: acrescentar as formas compostas (`userPin`, `cardPin`, `PINpad`, `data-userpin`) ao E2E de forma isolada e à métrica, para que a decisão de fronteira passe a ter portão nos dois sentidos.

---

### M1 — A janela de rótulo para na 7ª palavra e vaza ponta a ponta

**Severidade: Minor. Pré-existente** (a 1.1.32 também vazava; a revisão dela registrou como M1 e o incremento não o fechou).

```
✖ janela de 5 palavras  vazou=relatório|modelo e revisão guardados|artefato html|artefato json
   <p>chave de acesso ao sistema principal da conta ADV133WINFIVE7X</p>
✖ janela de 7 palavras  vazou=relatório|modelo e revisão guardados|artefato html|artefato json
```

O laço do scanner é `end - index <= 6` e o `{0,6}?` do rótulo com separador sofre do mesmo teto. A métrica do autor cobre 4 palavras ("senha do usuário do sistema") e por isso passa.

### M2 — Documento de critérios cita "54 formas, 213 combinações"; o teste corrente afirma 57/222

**Severidade: Minor** (contradição dentro do mesmo commit).

```
$ cd mirror && node --test test/core/credential-class-metric.test.js | grep formas=
ℹ formas=57 combinações=222                          # README e rodada 71 dizem 57/222 ✅
$ grep -n "54 formas, 213" docs/qa/2026-09-16-estado-dos-criterios-1.1.19.md   # critério 11
| 11 | … (**54 formas, 213 combinações**, com o número impresso como diagnóstico) …
```

O número que o critério 11 apresenta como corrente é o da rodada 69; a rodada 70 acrescentou três formas e o critério não foi atualizado.

### M3 — "O CSV é a exportação de ocorrências, 118 linhas": medido 117 linhas / 116 registros

**Severidade: Minor.** `wc -l` = 117; o arquivo termina com `\r\n`; 117 linhas = 1 cabeçalho + **116 ocorrências**, consistente com as 116 ocorrências do JSON. O "118" só sai se a contagem incluir uma linha vazia final.

### M4 — "Os 146 itens estão nos quatro artefatos": no CSV faltam 34 ids e 36 títulos

**Severidade: Minor** (a oração principal é qualificada pelo parêntese logo depois, mas o texto afirma mais do que o artefato mostra).

```
ids ausentes -> html=0  pdf=0  csv=34
títulos ausentes -> html=0  pdf=0  csv=36
```

O CSV é a exportação de ocorrências (116 linhas de dados) — está correto por desenho; o que não se sustenta é a formulação "os 146 itens estão nos quatro artefatos".

### Observações (O1–O8)

- **O1** A varredura de dicionário declarada (234.289 palavras, 284 casando) **não é exatamente reproduzível**: com o dicionário desta máquina (`/usr/share/dict/words` → `web2`, 235.976 entradas) o meu resultado é **286**. O fenômeno e os exemplos citados conferem um a um (`footpath`, `footpad`, `footprint`, `antipass`, `depass`, `birdseed`, `flaxseed`, `hapuku`, `dispossession`, `intersession` todos casam; `shipping`, `passeio`, `passageiro` não casam), e `pin` passou a casar **só a palavra `pin`** — a fronteira funciona. Falta declarar a lista usada.
- **O2** O documento diz que, contra a 1.1.32, a métrica "reprova nomeando 24 vazamentos e reprova a metade positiva do teste de sinal" — medido, **três** testes reprovam: além desses dois, `palavra da língua com radical curto embutido não vira rótulo de credencial`. O número 24 confere exatamente (8 rótulos × trecho/json/json2).
- **O3** **Retrato a leitura da revisão da 1.1.32 sobre o M3 (separador fora de `[-–—:]`) chegar ao entregável.** Medi as duas portas que ela citava e **nenhuma vaza ponta a ponta** nos bytes da 1.1.33: `<p>PIN | X</p>` e `<p>CVV | X</p>` saem limpos nas 6 superfícies, e `<div data-note="senha | X">`, `<img alt="CVV | X">`, `<input title="senha do usuário: X">`, `<input placeholder="chave de api: X">` também (5 de 6 formas de atributo limpas). O defeito unitário existe (a tarja parcial `senha [redacted] X` sobrevive no caminho `sanitizeJsonData` puro), mas a marcação monotônica do trecho o contém — o que a revisão anterior atribuiu ao M3 era, na medição de hoje, o efeito do contêiner.
- **O4** Formas de credencial **fora do vocabulário** continuam chegando às 4 superfícies (`dígito verificador: X`, `agência: X`, `conta corrente: X`, `certificado digital: X`, `assinatura eletrônica: X`, `matrícula: X`, `protocolo: X` — 8 formas medidas). É decisão de escopo de um vocabulário que é blocklist por desenho, não defeito deste incremento; registro com a medição crua para o autor decidir (as três primeiras são dados bancários; `protocolo`/`matrícula` não são credencial).
- **O5** A fase serial tem **flakiness de carga** própria: `page-markers-signals-mv3` falhou na fase de 36 arquivos e passa isolado (1/1); e a falha de bitmap que o autor declara na fase paralela não reproduziu comigo (0 falhas em 4.209). Não é do incremento, mas o número de gate varia de execução para execução (74/65/9 do autor × 71/63/8 meu, reproduzido em duas passagens — §5).
- **O6** O gate de plano de testes está de fato fechado: ao deixar minhas próprias sondas em `test/e2e/`, `createTestPlan` abortou com `TEST_PLAN_UNCLASSIFIED_E2E` — a correção do I3 da 1.1.32 funciona e tem dentes (o `credential-shapes-mv3` está em `REAL_CHROME_E2E`; 216 arquivos descobertos = 180 + 36).
- **O7** **Não há teste com pessoa leiga**: por decisão explícita do usuário (2026-09-16) ele não é portão de produção e será feito depois do lançamento — registrado como observação, não como bloqueio. Também não medi leitor de tela real.
- **O8** Publicação em loja/distribuição externa **não está autorizada**; mesmo um artefato aprovado depende de autorização explícita do usuário.

---

## 3. Tabela de conferência (uma linha por alegação)

| # | Alegação conferida | Comando / procedimento | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | zip `6b1f2733…ee20`, versão 1.1.33, HEAD `06e70fc` | `shasum -a 256`, `unzip -l`, `git rev-parse HEAD`, `python -c json.load(manifest)` | idênticos | **CONFIRMADO** |
| 2 | pacote ↔ árvore byte a byte; 199 arquivos; nada fora do pacote | `diff -r pkg/{src,vendor,assets} árvore`, `unzip -Z1`, conjunto do `build-release.mjs` | 199 = 199, `src`/`vendor`/`manifest` idênticos, só ícones de repositório fora (por desenho) | **CONFIRMADO** |
| 3 | build reprodutível | `node scripts/build-release.mjs --temporary-release-directory …` no espelho | refez o zip com **o mesmo SHA-256** | **CONFIRMADO** |
| 4 | manifesto e CSP conferem | leitura do `manifest.json` + gate | MV3, `extension_pages` com `script-src 'self'`, `object-src 'none'` | **CONFIRMADO** |
| 5 | gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` GREEN | `env AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` no espelho | `… 130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN`, exit 0 | **CONFIRMADO** |
| 6 | fase paralela: 4.209 testes, 4.207 passam, 1 falha, 1 pulado | `node --test` sobre os 180 arquivos do plano, em espelho completo (`.git` e `release/` presentes, `src/` do zip) | **4.209 testes, 4.208 passam, 0 falham, 1 pulado** (45,9 s) — a falha declarada (bitmap) não reproduziu; os totais 4.209 e 1 pulado batem | **CONFIRMADO** |
| 7 | fase serial: 74 testes, 65 passam, 9 falham, todas em `sidepanel-flow-mv3` | `node --test --test-concurrency=1` nos 36 arquivos, no espelho; **duas passagens** (espelho simples e espelho completo com `.git`+`release/`) | **71 / 63 / 8** nas duas (355,6 s e 358,5 s): 7 em `sidepanel-flow-mv3` + 1 flake em `page-markers-signals` (que passa isolado) | **NÃO REPRODUZÍVEL** |
| 8 | métrica: 57 formas, 222 combinações, 0 vazamentos | `node --test test/core/credential-class-metric.test.js` | `formas=57 combinações=222`, 5/5 passam | **CONFIRMADO** |
| 9 | métrica reprova contra os bytes da 1.1.32 nomeando 24 vazamentos | mutação `mut132` (só `privacy.js` da 1.1.32) | 24 nomeados (PIN, CVV, CVC, PUK, seed, nº de segurança, linha digitável, código de barras × trecho/json/json2); 3 testes vermelhos | **CONFIRMADO** |
| 10 | E2E de forma isolada: 6 passam e 2 falham contra a 1.1.32 | mutação `mut132` | 6/8, falham `card-cvv` e `boleto-linha` | **CONFIRMADO** |
| 11 | "a métrica e o E2E reprovam contra `06e70fc^`" | mutação `mutdb` | métrica reprova **1** teste (fronteira, `shipping`); E2E **passa 8/8** — sem dentes para o incremento | **PARCIAL** |
| 12 | "A 1.1.33 fecha os quatro bloqueios da 1.1.32" | minhas sondas + mutações | I1 fechado (3 formas); I3 fechado (gate roda); C1 fechado nas 8 formas declaradas, **aberto em formas compostas de `pin`**; I2 fechado no texto, **aberto no caminho JSON/modelo com marcação** | **PARCIAL** |
| 13 | as 8 famílias de cartão/boleto declaradas não chegam ao entregável | (a) E2E próprio com controles `CVV:`/`PIN:`; (b) `credential-shapes-mv3` no espelho (8 formas, inclui as 2 de cartão/boleto); (c) unitário nos 4 caminhos | (a) controles limpos nas 6 superfícies; (b) **8/8**; (c) os 8 rótulos tarjados em trecho/json — ressalva: `CVV \|` e `Linha digitável \|` ainda produzem tarja **parcial** no `sanitizeJsonData` puro, sem alcançar o entregável (O3) | **CONFIRMADO** (com ressalva) |
| 14 | Regressão I1 da 1.1.32 fechada (`<div title="senha X">`, `<input placeholder="senha X">`, trecho escapado) | `sanitizeJsonData`/`sanitizeHtmlSnippetSource` nos bytes | `senha [redacted]` nos três | **CONFIRMADO** |
| 15 | Regressão I2 da 1.1.32 fechada (prosa tarjada) | corpus de 8 frases (texto) + 16 frases (JSON) + sonda E2E | texto: 7/8 intactas ✅; **JSON/modelo: 14/16 destruídas**, igual à 1.1.32 ❌ | **PARCIAL** |
| 16 | auditoria ao vivo: 0 falhas, 1 alerta, 2 suspeitas (2 ocorrências), 9 positivos | `artcheck-mine.py` + pypdf nos artefatos entregues | `failed`=1 (recomendação 5.3.3), "Falhas: 0", "Recomendações e alertas: 1", "Suspeitas a confirmar: 2", "Resultados positivos: 9" | **CONFIRMADO** |
| 17 | 109 verificações no checklist | contagem de `data-checklist-question="` no HTML + texto do PDF | **109** = 109 (as outras 3 menções são CSS) | **CONFIRMADO** |
| 18 | cobertura 28,5% com fórmula e denominador | `(passed+failed+inapplicable)/coreRuleCount` e texto do artefato | 37/130 = 28,46% → 28,5%; "Regras próprias: 130" está na metodologia do HTML e do PDF; a expressão "percentual de acessibilidade" **não** aparece | **CONFIRMADO** |
| 19 | índice 9,0/10 | `10×passed/(passed+failed)` no artefato | 9/10 = 9,0 com "9 verificações atendidas entre 10" | **CONFIRMADO** |
| 20 | PDF 17 páginas; 146/146 ids e títulos no HTML e no PDF; notas 5/5; 0 palavras partidas; 0 `[redacted]`; 0 "Inconformidade ao item"; 111 "Verificar o item" | pypdf + contagens próprias + `print-integrity.py` (instrumento calibrado) | 17 / 146-146 e 146-146 / 5-5 / 0 / 0 / 0 / 111 | **CONFIRMADO** |
| 21 | 146 itens = 96 requisitos + 50 recomendações; 133 resultados de regra (9/1/95/28); 116 ocorrências; 115 registros de revisão humana; 9 evidências / 4.888 caracteres | `json` do artefato entregue | todos idênticos | **CONFIRMADO** |
| 22 | "o CSV é a exportação de ocorrências, 118 linhas" | `wc -l` + `csv.reader` | 117 linhas, 116 registros | **REFUTADO** (117) |
| 23 | "os 146 itens estão nos quatro artefatos" | presença de ids/títulos por artefato | html 0/0, pdf 0/0, **csv 34 ids e 36 títulos ausentes** | **PARCIAL** |
| 24 | critério 11: "54 formas, 213 combinações" | diagnóstico do teste corrente | 57/222 (o próprio README e a rodada 71 dizem 57/222) | **REFUTADO** |
| 25 | dicionário: 234.289 palavras, 284 casam | `/usr/share/dict/words` (235.976) + `SENSITIVE_KEY` | 286 casam; exemplos citados conferem; `pin` casa só `pin` | **PARCIAL** |
| 26 | "as 9 falhas todas em `sidepanel-flow-mv3`" | log do autor (`pkg-serial-1133.log`) + meu run | verdadeiro no log dele (todos os `test at` são desse arquivo); **não reproduzível** do commit congelado | **NÃO REPRODUZÍVEL** |
| 27 | invariantes de privacidade (nonce, consentimento one-shot, captura B, abas próprias, identidade antes do raster) | minha própria execução serial (testes de Chrome real) | passam: `resource-url-privacy`, `url-pixel-consent` (one-shot + owned tabs), `current-page-export` (varredura de nonce em 8 superfícies), `navigation drift`, `retention/deletion`, `personas sob CSP`, `mandatory journey`; diagnósticos `pre-consent-report-raster=0`, `rasterEvidence=0`, `publicLeaks=0`, `one-shot=confirmed`, `document-drift=denied` | **CONFIRMADO** |
| 28 | fixture do E2E de exportação traz o segredo 34 vezes | contagem de `${CREDENTIAL}` + `startUrl` | 33 no documento + 1 na URL = **34** | **CONFIRMADO** |
| 29 | "nenhuma versão declarada candidata com Critical/Important aberto" (critério 10) | meus achados C1/I1/I2/I3 | há Critical medido e não declarado | **REFUTADO** |
| 30 | 6 arquivos de escopo + 8 formas isoladas de credencial passam nos bytes entregues | minha fase serial + `credential-shapes-mv3` no espelho | 6/6 arquivos verdes; formas isoladas **8/8** | **CONFIRMADO** |

---

## 4. O que confere (medição própria)

- **Integridade**: digest, 199 entradas, pacote↔árvore e reconstrução determinística (tabela 1–3). O zip está rastreado em `git ls-files release/` e `git status --porcelain` no congelado é vazio.
- **Gate de release**: exatamente a linha declarada, exit 0 (tabela 5).
- **Fase paralela**: 4.209 testes / 4.208 passam / 0 falham / 1 pulado em espelho completo — a suíte está verde; a única falha declarada (bitmap sob 180 arquivos em paralelo) **não reproduziu** na minha execução, o que é compatível com a flakiness declarada. Numa primeira passagem em espelho **incompleto** (sem `.git` e sem `release/`) eu tinha obtido 4.201/7 — os 7 vermelhos eram `test/release-package.test.js` (6) e `preview-runtime-parity` (1), artefatos de ferramenta que dependem do repositório, não do produto; refiz no espelho completo, como manda o método.
- **Métrica da classe**: 5/5 verde com `formas=57 combinações=222`; reprova contra a 1.1.32 nos três testes esperados (tabela 8–9).
- **Formas isoladas de credencial do autor**: 8/8 nos bytes entregues; 6/8 contra a 1.1.32, nomeando as duas formas de cartão/boleto (tabela 10, 30).
- **Auditoria ao vivo**: todos os números do resumo, a fórmula da cobertura com o denominador 130 declarado na metodologia, a coerência da frase normativa (zero ocorrências com zero falhas confirmadas), 111 "Verificar o item", e a integridade de impressão pelo instrumento calibrado (tabela 16–21).
- **Privacidade e autorização**: os testes de Chrome real que fixam nonce, consentimento one-shot, não atribuição de captura B, limpeza de abas próprias e prova de identidade de documento passaram na minha execução (tabela 27).
- **Falso positivo do lado "seguro" declarado**: `shipping`, `pintura`, `pincel`, `pintor`, `pinguim`, `pino`, `spin`, `passeio`, `passageiro`, `pintinho`, `opinião`, `espinha`, `pingente`, `pinky`, `pinta`, `papiro` **não** casam mais; as frases de prosa com data curta saem intactas nas 4 superfícies (medido, com controle).

---

## 5. Fase serial — atribuição de cada falha (prioridade 7 do brief)

Comando: `node --test --test-concurrency=1` sobre os 36 arquivos de `REAL_CHROME_E2E`, na raiz com os bytes do zip. Resultado em duas passagens independentes: **71 testes, 63 passam, 8 falham** (as duas com o mesmo conjunto). Fase paralela no mesmo espelho: 4.209/4.208/0/1.

| # | Falha (nome do teste) | Arquivo | Dono | Reproduz isolado? | Erro exato |
| --- | --- | --- | --- | --- | --- |
| 1 | the panel draws numbered signals over the audited page | `test/e2e/page-markers-signals-mv3.test.mjs` | **não é o arquivo do outro incremento** | **passa 1/1** (1,9 s) | falhou só sob a fase (carga/instância) |
| 2 | original-page ABNT markers remain usable across idle and preserve the report | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** (31,8 s) | `WAIT_TIMEOUT` |
| 3 | original-page ABNT markers visual review and verified exports | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** (32,1 s) | `WAIT_TIMEOUT` |
| 4 | current-page audits run in one inactive copy and leave the original page intact | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** | `WAIT_TIMEOUT` |
| 5 | full-evidence can be cancelled at the privacy pause without touching the source | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** (30,8 s) | `WAIT_TIMEOUT` |
| 6 | no-pixels shows progress, completes in the copy and exposes a view-only report | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** (30,1 s) | `WAIT_TIMEOUT` |
| 7 | element-only confirms once and keeps the full-page capture omitted | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** (30,0 s) | `CDP_COMMAND_TIMEOUT` |
| 8 | full-evidence rehydrates after worker restart and exports all four formats | `test/e2e/sidepanel-flow-mv3.test.mjs` | outro incremento | **falha** (30,0 s) | `FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED` → `CDP_COMMAND_TIMEOUT` |

Execução isolada do arquivo do outro incremento (frozen, `--test-concurrency=1`): **9 testes, 2 passam, 7 falham**, com 4× `WAIT_TIMEOUT`, 2× `CDP_COMMAND_TIMEOUT` e 1× `FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED` — ou seja, as falhas dele **não são do incremento nem da fase**: são do próprio arquivo, como o autor declara. Nenhuma falha morre em asserção sobre resultado de auditoria do produto; a única falha fora desse arquivo passa isolada. **Conclusão: nenhuma falha serial é atribuível ao incremento da 1.1.33** — mas o número declarado (74/65/9, todas no arquivo do outro incremento) não é o do commit congelado (I2).

---

## 6. O que eu NÃO consegui verificar

- **A superfície PDF para as minhas sentinelas**: as minhas sondas varrem painel, relatório, modelo/revisão, HTML, JSON e CSV. O PDF é binário comprimido e não foi varrido por substring (mesma limitação declarada pelo autor).
- **Uma única execução de cada fase**: medi a paralela uma vez (verde) e a serial duas vezes (mesmo conjunto). Não fiz três repetições para separar flakiness de defeito; a única falha fora do arquivo do outro incremento passou isolada, e a falha de bitmap declarada pelo autor não reproduziu.
- **A auditoria ao vivo re-executada**: não reenviei dado a serviço externo. Conferi os números **nos artefatos entregues** e provei que `/private/tmp/g133/run/src` é byte a byte a `src` do zip entregue — o mesmo método da revisão anterior.
- **Mutação além do `privacy.js`**: as duas mutações restauram só `src/core/privacy.js` (o método que o autor declara). Não mutei `snippet.js`, `selector.js` nem o normalizador.
- **CDATA, `<template>`, `<noscript>` como contêiner entre rótulo e valor; variantes NFD/NFC de rótulos acentuados; CDN/proxy que reescreva o HTML** — não medidos.
- **Runtime clássico de persona** (`accessible-preview-runtime.classic.js`): continua sem tarja e eu não tracei superfície entregue.
- **Leitor de tela real e pessoa leiga**: não testados (o segundo por decisão do usuário).
- **Chrome fora do CFT 152.0.7977.64**.
- **`verify-project.mjs` além do gate `AUDITA_VERIFY_SKIP_TESTS=1`** (não inspecionei o verificador por dentro).
- Não despejei nem li dados de sessão/e-mail; o conteúdo citado dos artefatos é de página pública (`google.com`) e só em contextos de contagem/verificação.

---

## 7. Estado do checkout congelado

```
$ cd /private/tmp/audita-review-133 && git rev-parse HEAD
06e70fc
$ git status --porcelain
?? docs/qa/revisoes/REVIEW-1.1.33.md      # só o arquivo deste relatório
```

O congelado **não recebeu nenhuma alteração de produto**: toda sonda, mutação, espelho e log ficou em `/private/tmp/audita-review-133-scratch`. As únicas escritas no congelado são este relatório (pedido explícito do brief) e o diretório que o contém.

### Artefatos da revisão (em `/private/tmp/audita-review-133-scratch/`)

- `pkg/` (zip extraído), `pkg132/` (1.1.32), `mirror/` (árvore + bytes do zip), `mut132/`, `mutdb/` (mutações de `privacy.js`).
- Sondas unitárias: `leak-probe.mjs` (87 formas × 6 caminhos = 462 combinações), `fp-probe.mjs` (169 entradas, duas gerações), `prose-corpus.mjs`, `prose-mech.mjs`, `fp-mech.mjs`, `dict-check.mjs`, `dbg-mutdb.mjs`, `i2-check.mjs`, `fixes-check.mjs`.
- Sondas E2E (Chrome real, 6 superfícies), em `probes/` e copiadas para `test/e2e/` do espelho **apenas durante a execução** (removidas antes de rodar as fases canônicas, porque `createTestPlan` recusa E2E não classificado — o que, de passagem, provou que a correção do I3 da 1.1.32 funciona): `adv133-surfaces.test.mjs` (13 formas), `adv133-attr.test.mjs` (6), `adv133-fp2.test.mjs` (5), `adv133-pinonly.test.mjs` (4, para a mutação).
- Logs: `serial-133.log` (fase serial), `parallel-1133.log` (fase paralela), `e2e-*.log`, `verify-1133.log`, `fp-probe.out`, `leak-probe.out`.
- Instrumentos próprios: `artcheck-mine.py` (artefatos entregues), além de `print-integrity.py` (do autor, conferido contra as minhas contagens).
