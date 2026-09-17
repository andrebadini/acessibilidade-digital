# Revisão adversarial independente — Audita Acessibilidade 1.1.36

- **Alvo**: `release/audita-acessibilidade-1.1.36.zip`, SHA-256 `8fffa961597f28fd8683bb04221580382c4f3ee961bc5659d87226d980a956f5` — conferido por mim com `shasum -a 256` no clone congelado **antes** de qualquer medição.
- **Checkout congelado**: `/private/tmp/audita-review-136`, HEAD `f33bcde92f424aeff822a72667dbde9c92873dd0`, `manifest.json` = `1.1.36`. O congelado não recebeu escrita de produto: a única escrita é este relatório. Todas as sondas, corpora, mutações e raízes de medição ficaram em `/private/tmp/audita-review-136-scratch` (`harness/`, `gen-*`, `pkg/`, `packroot/`, `packroot-mut135/`, `clone-full/`, `live1/`, `live2/`). `/Volumes/SSD1/acessibilidade-digital` e o worktree `audita-mt` **não** foram tocados.
- **Data e hora da medição**: 2026-09-17, 02:56–04:0x (America/New_York, UTC-4).
- **Ambiente**: macOS 26.6.2 (25G83), Chrome for Testing `152.0.7977.64` (`/private/tmp/audita-cft152-fixed/…`), Node v26.5.0, `/usr/share/dict/words` com 235.976 linhas únicas, pypdf pelo runtime Python do Codex (sem poppler; `sips` disponível e não usado). **Um Chrome por vez**: a fase serial canônica, os dois E2E de credencial do autor, o E2E próprio, a mutação e as duas auditorias ao vivo rodaram em cadeia serializada (`--test-concurrency=1`). As medições unitárias/diferenciais rodaram nos intervalos, sem Chrome.
- **Declaração de independência**: escrevi minhas próprias sondas (`harness/probe2.mjs`, `c1c2.mjs`, `sweep.mjs`, `multipart.mjs`, `border.mjs`, `border2.mjs`, `valgate.mjs`, `fp.mjs`, `claimed.mjs`, `price.mjs`, `perf.mjs`, `e2e-vacuity.mjs`, `test/e2e/adv136-surfaces.test.mjs`, `live136.mjs`) e meus próprios corpora, sentinelas e listas de formas — inclusive um **controle positivo na mesma página** de cada forma do E2E próprio. Não usei a métrica do autor como prova: os números dele aparecem na tabela de conferência como *alegações*, cada uma com o meu procedimento ao lado. Os dois E2E de credencial dele **foram executados por mim** nos bytes empacotados e o resultado é reportado como medição minha. Três frentes paralelas (falso positivo, proveniência dos números, auditoria ao vivo) foram executadas por verificadores separados sob minha coordenação, com scripts próprios em `scratch/subA`, `scratch/subB` e `scratch/subC`; **todo número que entra como achado neste relatório foi reconferido por mim** na medição citada (`pintura.png`, `id="secretaria-saude"`, o fragmento realista com cascata, o denominador 234.289, a falha determinística de `normalize-snapshot.test.js`, a versão ausente no CSV e a cobertura/índice das execuções ao vivo).
- **Limite declarado**: não há teste com pessoa leiga nesta revisão, por decisão explícita do usuário (2026-09-16); ele **não** é portão de produção e fica registrado como observação (O5). Publicação em loja depende de autorização explícita do usuário — este relatório não a concede.

---

## 1. Veredito

**A 1.1.36 NÃO está aprovada como candidata.**

O incremento tem partes reais e medidas: a correção do C2 da 1.1.35 (sublinhado/ponto/barra) funciona e é ampla — **60/60** formas multi-parte tarjam o lugar certo, contra **45/60 tarjando o lugar errado** em todas as quatro gerações anteriores; as quatro frases que o autor declara preservadas estão preservadas; o preço declarado reproduz (566/101/566, com uma normalização de dicionário que o documento não escreve — M3); os **totais** da fase paralela batem (4.210/4.208/1/1, com a causa da falha declarada errada — I4); a rota com query (M1 da 1.1.35) fechou; e as duas auditorias ao vivo que rodei confirmam 21 das 23 linhas de números da rodada 78.

Mas **o desenho de borda não fecha os dois lados — ele reabre a classe do C1 da 1.1.35 por um eixo novo e cria um lado cego que independe do valor**:

- **C1 (Critical, regressão)**: o portão de valor `credentialLikeToken` exige ≥6 caracteres **e** dígito ou símbolo. Com um valor **só de letras** (ou ≤5 dígitos, ou data), **8 das 10 formas do C1 da 1.1.35 voltam a vazar** — incluindo `novasenha` e `redefinirsenha`, com o mesmo tipo de sentinela (`Zqwkvbrtnmx…`) que a revisão anterior usou. Medido ponta a ponta nos bytes empacotados, uma forma por página, com controle positivo na mesma página: **relatório + modelo e revisão guardados + artefato HTML + artefato JSON**. `novaSenha: <senha só de letras>` e `userPin: <idem>` vazam na 1.1.36 e eram **tarjados na 1.1.33, na 1.1.34 e na 1.1.35** — regressão pura.
- **C2 (Critical, regressão, independe do valor)**: quando o radical está no **meio** do token com letras dos dois lados, a regra de borda não reconhece nada. `minhasenhaforte: ADV136MINHAFORTE7X` e `novasenhaadmin: ADV136NOVAADMIN7X` — valor **com dígito**, o próprio formato de sentinela do autor — chegam às **mesmas quatro superfícies**. No unitário, as **14** formas de valor testadas vazam. A 1.1.35 tarjava todas essas formas; a 1.1.33 também.

| Severidade | Qtd | Itens |
| --- | --- | --- |
| Critical | 2 | C1 portão de valor reabre a classe do C1 da 1.1.35 (valor só de letras / ≤5 dígitos / data) com regressão contra 1.1.33 e 1.1.34; C2 lado cego da borda com o radical no MEIO do token (`minhasenhaforte`, `novasenhaadmin`, `meupinadmin`, `xsenhaforte`) vaza **qualquer** valor, com regressão contra 1.1.35 e 1.1.33 |
| Important | 4 | I1 falso positivo **regressivo** (nome de arquivo, caminho, `id` hyphenado, cascata no parágrafo irmão): 55 de 213 itens destruídos contra 19 da 1.1.35; I2 `conta corrente 12345-6`, declarada prosa pelo próprio incremento, é destruída inteira no caminho MODELO; I3 o E2E de credencial do autor **passa 17/17 com o `src/` da 1.1.35 restaurado** — não tem dentes para este incremento; I4 a suíte paralela tem falha **determinística** do próprio incremento (`normalize-snapshot.test.js:590`) declarada como flake de carga |
| Minor | 5 | M1 `bearer token: VALOR` ainda tarja o lugar errado no caminho de prosa; M2 separador duplo (`senha__forte`, `session__id`) ainda tarja o lugar errado, pré-existente nas quatro gerações; M3 o denominador/método do preço não reproduz como escrito (234.289 só com normalização não declarada) e a série refutada 203/284/87 segue em três documentos; M4 a fase serial declarada (80/71/9) não reproduz (medido 80/73/7); M5 "41 concatenações" e "com comando" do preço não têm fixture nem script versionado |
| Observações | 8 | O1–O8 (o que confere e tem dentes, o padrão das quatro revisões, o PDF não carrega o texto visível, `data-alpine` recuperado, `placeholder="Digite sua senha"` ainda perdido, critério 8, o espanhol vaza nas quatro gerações, o que os 566 realmente medem) |

**Distribuição depende de autorização explícita do usuário** — este relatório não a concede.

---

## 2. Achados

### C1 — O portão de valor reabre a classe do C1 da 1.1.35 para valor que não tem cara de credencial

**Severidade: Critical. Regressão contra a 1.1.33 e a 1.1.34; a alegação "corrigido na 1.1.36" é refutada.**

A 1.1.35 foi reprovada porque a lista fechada de caudas devolvia à página `novasenha`, `redefinirsenha`, `trocarsenha`, `alterarsenha`, `segundasenha`, `primeirasenha`, `novachave` (fechadas na 1.1.33 **e** na 1.1.34) e `senhasegura`, `senhafacil`, `tokenpessoal` (fechadas na 1.1.33). A 1.1.36 troca a lista por regra de borda **e** passa a exigir, quando o rótulo não é palavra do vocabulário, que o valor tenha "cara de credencial" (`credentialLikeToken`: núcleo ≥6 caracteres **e** dígito ou símbolo, e não parecer data). O efeito medido é que **a classe do C1 só fecha para o valor que o autor usa como sentinela**.

Sonda diferencial própria, mesma entrada nas quatro gerações, quatro caminhos por forma, **dois sentinelas** — o de **letras** (`Zqwkvbrtnmx…`, o mesmo tipo que a revisão da 1.1.35 usou) e o **com dígito** (`ADV135…`):

```
$ node /private/tmp/audita-review-136-scratch/harness/c1c2.mjs
forma            sentinela        1.1.33   1.1.34   1.1.35   1.1.36
novasenha        letras           tarja    tarja    VAZA     VAZA
novasenha        dígito           tarja    tarja    VAZA     tarja
redefinirsenha   letras           tarja    tarja    VAZA     VAZA
redefinirsenha   dígito           tarja    tarja    VAZA     tarja
trocarsenha      letras           tarja    tarja    VAZA     VAZA
alterarsenha     letras           tarja    tarja    VAZA     VAZA
segundasenha     letras           tarja    tarja    VAZA     VAZA
primeirasenha    letras           tarja    tarja    VAZA     VAZA
novachave        letras           tarja    tarja    VAZA     VAZA
tokenpessoal     letras           tarja    tarja    VAZA     VAZA
senhasegura      letras           tarja    VAZA     VAZA     tarja
senhafacil       letras           tarja    VAZA     VAZA     tarja
```

**8 das 10 formas** do C1 da 1.1.35 continuam abertas para o valor só de letras; **2** (`senhasegura`, `senhafacil`) fecharam porque a cauda está em `CREDENTIAL_TAILS` e o rótulo é "palavra do vocabulário". As duas colunas que importam: 1.1.33 e 1.1.34 **tarjavam todas as dez** — o defeito é atribuível ao incremento que diz tê-lo corrigido.

**Matriz de valor × rótulo** (`redactSensitiveText('<rótulo>: <valor>')`, quatro gerações, 14 formas de valor):

```
$ node /private/tmp/audita-review-136-scratch/harness/valgate.mjs
### rótulo "novaSenha"                ### rótulo "novasenha"
valor                    1.1.33 …  1.1.36      valor                    1.1.33/1.1.34  1.1.36
letras 25 (passphrase)   tarja …   VAZA        letras 25               tarja/tarja    VAZA
letras 15 maiúsculas     tarja …   VAZA        letras 15               tarja/tarja    VAZA
letras 12 minúsculas     tarja …   VAZA        letras 12               tarja/tarja    VAZA
letras 8                 tarja …   VAZA        letras 8                tarja/tarja    VAZA
letras 5                 tarja …   VAZA        letras 5                tarja/tarja    VAZA
letras 3                 tarja …   VAZA        letras 3                tarja/tarja    VAZA
dígitos 8                tarja …   tarja       dígitos 8               tarja/tarja    tarja
dígitos 5                tarja …   VAZA        dígitos 5               tarja/tarja    VAZA
dígitos 4 (PIN)          tarja …   VAZA        dígitos 4               tarja/tarja    VAZA
dígitos 6                tarja …   tarja       dígitos 6               tarja/tarja    tarja
alfanum 6                tarja …   tarja       alfanum 6               tarja/tarja    tarja
símbolo                  tarja …   tarja       símbolo                 tarja/tarja    tarja
data                     tarja …   VAZA        data                    tarja/tarja    VAZA
url-like                 tarja …   tarja       url-like                tarja/tarja    tarja
```

`novaSenha` é a forma de campo de senha mais comum que existe em página brasileira; a 1.1.33, a 1.1.34 **e** a 1.1.35 tarjavam **as 14** formas de valor. A 1.1.36 vaza **8 de 14**, e o critério que decide é a *cara do valor*, não o rótulo. Uma passphrase forte e plausível (`correcthorsebatterystaple`, 25 letras) cai fora porque **não tem dígito nem símbolo** — o próprio extrator de cauda do produto aceitaria esse token pela regra `valueLikeToken` (≥12 caracteres), e é o portão novo, mais estreito, que o rejeita.

**Concordâncias de três partes, plurais e caudas estrangeiras** (mesma sonda, `D` = vaza com valor com dígito, `L` = vaza com valor só de letras):

```
forma                     1.1.33   1.1.34   1.1.35   1.1.36
senhaforteusuario         -/-      D/L      D/L      -/L      ← 3 partes: fecha no dígito, vaza em letras
senhafortes               -/-      D/L      D/L      -/-      ← plural: fechado
senhasfortes              -/-      D/L      D/L      -/-      ← plural: fechado
senhasseguras             -/-      D/L      D/L      -/-      ← plural: fechado
novassenhas               -/-      -/-      D/L      -/L
tokenacessosistema        -/-      D/L      D/L      -/L
chaveapisecret            -/-      -/-      -/-      -/L
passwortneu               -/-      D/L      D/L      -/L      ← cauda alemã
neuespasswort             -/-      D/L      D/L      -/L      ← cauda alemã
motdepassenouveau         -/-      D/L      D/L      -/L      ← cauda francesa
nuevaclave                D/L      D/L      D/L      D/L      ← espanhol: vaza nas QUATRO (ver O7)
clavenueva                D/L      D/L      D/L      D/L
contrasenyanueva          D/L      D/L      D/L      D/L
```

**Ponta a ponta, nos bytes empacotados, uma forma por página, controle positivo na mesma página** (sonda minha `test/e2e/adv136-surfaces.test.mjs`, 6 superfícies: painel, relatório, modelo e revisão guardados, artefato HTML, artefato JSON, artefato CSV):

```
$ cd /private/tmp/audita-review-136-scratch/packroot && AUDITA_E2E_CHROME=… node --test --test-concurrency=1 test/e2e/adv136-surfaces.test.mjs
ℹ ADV136|ctrl-senha-letras            |vazou=NENHUMA|controle=ausente|superficies=6   ← CONTROLE
ℹ ADV136|ctrl-novasenha-digito        |vazou=NENHUMA|controle=ausente|superficies=6   ← CONTROLE
ℹ ADV136|novasenha-letras             |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|controle=ausente|superficies=6
ℹ ADV136|redefinirsenha-letras        |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|controle=ausente|superficies=6
ℹ ADV136|novaSenha-letras             |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|controle=ausente|superficies=6
ℹ ADV136|userpin-letras               |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|controle=ausente|superficies=6
ℹ ADV136|minhasenhaforte-digito       |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|controle=ausente|superficies=6
ℹ ADV136|novasenhaadmin-digito        |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|controle=ausente|superficies=6
ℹ ADV136|bearer-token-espaco          |vazou=NENHUMA|controle=ausente|superficies=6
ℹ tests 9   ℹ pass 3   ℹ fail 6
```

O controle (`senha: <letras>`, que precisa sumir) **sumiu em todas as nove páginas** — a varredura estava viva quando mediu cada vazamento. Contexto exato, provando que o texto chega inteiro e não é artefato da minha busca:

```
CTX|novasenha-letras|relatório|…&lt;main&gt;&lt;h1&gt;Forma isolada&lt;/h1&gt;&lt;p id="alvo"&gt;novasenha: Zqwkvbrtnmxnovas&lt;/p&gt;&lt;p id="…
```

**Causa medida.** `credentialLikeToken` (`src/core/privacy.js:252`):

```
function credentialLikeToken(token) {
  const core = valueCore(token);
  if ([...core].length < 6 || DATE_LIKE.test(core)) return false;
  return /\d|[^\p{L}\p{N}\s]/u.test(core);
}
```

e o uso em `sensitivePasses` (`:743-751`): rótulo que **não** é palavra do vocabulário só tarja se `credentialLikeToken(primeiroToken)` for verdadeiro; rótulo que **é** palavra do vocabulário mantém a semântica de atribuição. `isWholeCredentialLabel('novasenha') === false` (o `nova` da frente não está em `CREDENTIAL_PREFIXES`) e `isWholeCredentialLabel('novaSenha') === false` — logo as duas formas dependem do valor.

**Impacto no produto**: um relatório entregue a terceiros carrega o valor de um campo `novasenha`/`redefinirsenha`/`novaSenha` — o caminho mais comum em que uma página de troca de senha expõe a credencial em texto. A promessa central continua quebrada, e agora só para o valor que não tem dígito ou símbolo, o que faz a falha depender da escolha de senha do usuário da página.

---

### C2 — O lado cego da regra de borda: radical no MEIO do token vaza qualquer valor

**Severidade: Critical. Regressão contra a 1.1.35 e a 1.1.33; independe da forma do valor.**

A regra declarada é "o radical conta quando toca uma borda do token". Medido: quando o radical está **cercado de letras dos dois lados** e a cauda que segue **não é** consumida, nenhum ramo do vocabulário de prosa casa — e o rótulo não é reconhecido **de jeito nenhum**, então não existe decisão de valor para salvar o caso.

Varredura própria de 8.447 formas `<prefixo><radical><sufixo>` (11 radicais × 32 prefixos × 24 sufixos):

```
$ node /private/tmp/audita-review-136-scratch/harness/border2.mjs
formas realistas (prefixo e sufixo de página): 3740
cego-à-borda na 1.1.36: 2940 | na 1.1.35: 1260
REGRESSÃO (1.1.36 cego, 1.1.35 tarjava): 2000
   novasenhaforte, novasenhaadmin, minhasenhaforte, meusenhaadmin, usersenhaforte, adminsenhaforte, …
vaza-com-letras na 1.1.36: 3580 | na 1.1.35: 1260
REGRESSÃO letras (1.1.35 tarjava): 2320
1.1.36 FECHA (1.1.35 era cego): 320 -> novasenha, confirmarsenha, redefinirsenha, confirmacaosenha, …
```

"**Cego à borda**" = vaza **mesmo com valor que tem dígito** — é a medida que separa este defeito do C1: aqui não há dependência do valor. Formas nomeadas:

```
$ node /private/tmp/audita-review-136-scratch/harness/valgate.mjs   # rótulo "minhasenhaforte"
valor                          1.1.33   1.1.34   1.1.35   1.1.36
letras 25 (passphrase)         tarja    VAZA     tarja    VAZA
dígitos 8                      tarja    VAZA     tarja    VAZA
dígitos 6                      tarja    VAZA     tarja    VAZA
símbolo                        tarja    VAZA     tarja    VAZA
data                           tarja    VAZA     tarja    VAZA
url-like                       tarja    VAZA     tarja    VAZA
   (idem para as 14 formas: 14/14 VAZA na 1.1.36)
```

E ponta a ponta, nos bytes empacotados, com valor **com dígito** (`ADV136MINHAFORTE7X`, `ADV136NOVAADMIN7X`), as mesmas quatro superfícies entregues — linhas do log acima.

**Causa medida.** O vocabulário de PROSA (`SENSITIVE_WORD_SOURCE = KEY_NAME_CORE`, `privacy.js:189`) tem dois ramos e **nenhum** cobre o radical interior:

```
KEY_NAME_CORE = HEAD_EDGE STEM [alnum]{0,24} LABEL_CONTINUATION      # radical no INÍCIO do token
              | [alnum]{1,12} STEM LABEL_CONTINUATION TAIL_EDGE      # radical no FIM do token (≤12 antes)
              | (?<!by)(?<!com)pass(?![\p{L}\p{N}])
```

Já o vocabulário de **CHAVE** (`SENSITIVE_KEY`) inclui `WORD_RADICAL_SOURCE`, cujo ramo 2 é `STEM (d|de|da|do)? (CAUDA|STEM) TAIL_EDGE` — **sem borda de entrada**. Confirmado por instrumentação:

```
$ node /private/tmp/audita-review-136-scratch/harness/diag.mjs
SENSITIVE_KEY "minhasenhaforte" -> "senhaforte"@5
SENSITIVE_KEY "novasenhaadmin"  -> "senhaadmin"@4
SENSITIVE_KEY "xsenhaforte"     -> "senhaforte"@1
```

Mas o predicado que decide **chave JSON** é `isSensitiveKeyName` (`SENSITIVE_KEY_NAME = KEY_NAME_SOURCE`), que usa a **mesma borda** da prosa — e aí a proteção também não existe. Medido:

```
$ node -e "…isSensitiveKeyName / sanitizeJsonData / sanitizeHtmlSnippetSource…"
isSensitiveKeyName('minhasenhaforte') = false    (idem novasenhaadmin, xsenhaforte, meupinadmin)
sanitizeJsonData({ minhasenhaforte: 'ADV136MINHA7X', total: 5 })
   → {"minhasenhaforte":"ADV136MINHA7X","total":5}          ← chave E valor intactos
sanitizeHtmlSnippetSource('<div id="minhasenhaforte">ADV136MINHA7X</div>') → <div>ADV136MINHA7X</div>
```

Ou seja: o lado cego alcança **o texto de prosa e a chave JSON**; o que ainda cai é o **nome** de atributo `data-*`/`id`/`name` (o `snippet.js` usa o `SENSITIVE_KEY` permissivo em `PRIVATE_ATTRIBUTE`), o que por si só já é perda de evidência do seletor. A leitura correta é: **o mesmo token é reconhecido como chave por um caminho e não pelo outro**, e o caminho que decide o texto entregue é o que não reconhece.

A divergência entre os dois vocabulários é a causa — a mesma classe de causa que a revisão da 1.1.35 nomeou ("o caminho de prosa deve usar o mesmo vocabulário que o de chave já usa"), agora na direção oposta: o caminho de prosa ganhou uma borda que o de chave não tem, e a assimetria produz o lado cego.

**Impacto no produto**: `minhasenhaforte`, `novasenhaadmin`, `meupinadmin` são nomes de campo plausíveis em `name`, `id` e chave JSON **exibidos como texto** em blocos `<pre>`, depuração e páginas de configuração — justamente as páginas em que uma auditoria de acessibilidade costuma encontrar texto denso. O valor chega inteiro, com dígito, e o rótulo é reconhecido como chave pelo resto do produto.

---

### I1 — Falso positivo regressivo: a decisão de valor julga o token inteiro e a haste ao mesmo tempo, e destrói nome de arquivo, caminho, `id` hyphenado e o parágrafo irmão

**Severidade: Important. Regressão contra a 1.1.34 e a 1.1.35; é a mesma classe dos Important I1 das revisões da 1.1.33 e da 1.1.34.**

O preço declarado do desenho é "quando o token não é palavra do vocabulário, o valor precisa ter cara de credencial". O que o incremento **mede e declara** é a contagem de palavras do dicionário (566) e quatro frases preservadas (`Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12 unidades`, `The hairpin: 12 units`, `tokenizador: interno` — **as quatro conferem**, medi e subB mediu). O que ele **não** declara é a perda que a mesma regra produz quando a palavra da língua é seguida de um valor com dígito **ou quando o token inteiro tem símbolo** (ponto de extensão, hífen de identificador, barra de caminho).

Medição própria, quatro superfícies, quatro gerações:

```
$ node -e "…sanitizeHtmlSnippetSource / sanitizeJsonData…"
1.1.34/1.1.35  <div id="secretaria-saude" class="card">x</div>            → preservado
1.1.36         <div id="secretaria-saude" class="card">x</div>            → <div id="[redacted]" class="card">x</div>

1.1.36  "pintura.png"                → "[redacted]"                       (1.1.33/34/35: preservado)
1.1.36  <img src="/img/pintura.png" alt="Chaveiro de latão">  → <img src="/img/[redacted]" alt="…">   (1.1.35: intacto)
1.1.36  <p>Chaveiro: A1B2C3</p>      → <p>Chaveiro: [redacted]</p>        (1.1.34/1.1.35: preservado)
```

E o efeito em cascata, no fragmento realista (trecho entregue e caminho JSON/MODELO):

```
fragmento: <div class="card"><h3>Chaveiro: A1B2C3</h3><p>Texto importante do parágrafo seguinte</p>
            <img src="/img/pintura.png" alt="Chaveiro de latão">
            <input placeholder="Pincel de cerda sintética" autocomplete="shipping street-address"></div>

1.1.34 e 1.1.35: fragmento inteiro preservado, 205/205 caracteres, zero [redacted]
1.1.36 trecho   : <div class="card"><h3>Chaveiro: [redacted]</h3><p>[redacted]</p><img><input></div>
1.1.36 modelo   : <div class="card"><h3>Chaveiro: [redacted]        ← o resto é apagado
```

Perdidos na 1.1.36: `A1B2C3`, o parágrafo irmão inteiro, `alt`, `placeholder` e `autocomplete` — ou seja, **o nome acessível que uma ocorrência de "imagem sem alt" ou "campo sem rótulo" precisa para identificar o alvo**. A cascata é a marcação monotônica do trecho (`snippet.js:227`): uma vez aceso o sinal, nada depois volta a ser texto.

**Tamanho da classe**, em corpus independente de 213 itens (163 de prosa + 50 de HTML) montado por subB e reproduzido por mim nos casos nomeados acima — itens destruídos em pelo menos uma superfície: **1.1.33: 98 · 1.1.34: 32 · 1.1.35: 19 · 1.1.36: 55**. O corpus super-amostra candidatos de propósito, então a taxa não é a de página real; o que importa é a razão: **a 1.1.36 destrói 2,9× o que a 1.1.35 destruía**, e volta ao patamar intermediário entre a 1.1.33 (reprovada por isso) e a 1.1.34.

**Causa-raiz medida** (`privacy.js:779-789`, ramo `TAIL_CANDIDATE`): a decisão "é palavra do vocabulário?" é tomada sobre a **haste** que `tokenAround()` devolve (`pintura`), e a decisão "o valor parece credencial?" é tomada sobre o **token inteiro** (`pintura.png`, 10 caracteres e com símbolo ⇒ `credentialLikeToken` verdadeiro). São duas strings diferentes do mesmo token, e o prefixo a substituir é vazio — a saída é `[redacted]` no lugar do token inteiro. Vale para `pintura.png`, `secretaria-saude`, `id="secretaria-saude"`, `/img/pintura.png` e `/produtos/chaveiro?cor=latao`. Não há declaração desse preço em nenhum documento.

**Impacto**: o valor de uma etiqueta legítima, o nome de um arquivo, o caminho de uma imagem e o `id` de um elemento saem do relatório, do modelo e dos dois artefatos — e um leitor humano não distingue "tarjado por privacidade" de "campo vazio". É exatamente o defeito pelo qual as revisões da 1.1.33 e da 1.1.34 reprovaram o vocabulário anterior.

---

### I2 — `conta corrente 12345-6` é declarada prosa e é destruída inteira no caminho MODELO

**Severidade: Important. Contradiz declaração do próprio incremento; pré-existente desde a 1.1.35.**

O commit `efe698b` e o README afirmam: "as frases que só valem com separador saem do vocabulário de cauda (`conta corrente 12345-6` é prosa, `Conta corrente: 12345-6` é rótulo)". Medição própria:

```
$ node … redactSensitiveText / sanitizeJsonData / sanitizeHtmlSnippetSource
"conta corrente 12345-6"
   prosa : "conta corrente 12345-6"          ← preservada
   trecho: "<p>conta corrente 12345-6</p>"   ← preservada
   json  : "[redacted]"                      ← DESTRUÍDA INTEIRA (caminho modelo)
"A conta corrente 12345-6 foi encerrada"
   prosa : "A conta corrente 12345-6 foi encerrada"   ← preservada
   json  : "[redacted]"                                ← DESTRUÍDA INTEIRA
"assinatura eletrônica ICP-Brasil"
   json  : "[redacted]"
```

O caminho que carrega marcação decide por projeção sem tags: `hasCredentialValueSignal(' p conta corrente 12345-6 p ')` acende porque a regra de cauda casa `conta corrente` + `12345-6`, e `redactStringValue` devolve `[redacted]` para **a string inteira** (`privacy.js:870`). Medido nas quatro gerações: 1.1.33 preservava; 1.1.34 destruía nas quatro superfícies; 1.1.35 e 1.1.36 destroem no caminho modelo. O E2E de falso positivo do autor não tem essa frase, e a métrica também não — a declaração está sem controle no caminho onde ela falha.

---

### I3 — O E2E de credencial do autor passa com o `src/` da 1.1.35: o portão não tem dentes para este incremento

**Severidade: Important. É o portão que o autor cita como prova do incremento.**

Mutação por restauração: raiz de medição nova com a árvore de teste do commit e o **`src/` da 1.1.35** (`gen-55db44b`), `manifest.json` do commit, e os dois E2E de credencial executados por mim:

```
$ cd /private/tmp/audita-review-136-scratch/packroot-mut135 && AUDITA_E2E_CHROME=… \
    node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs test/e2e/credential-false-positives-mv3.test.mjs
ℹ tests 17   ℹ pass 17   ℹ fail 0        ← com o src da 1.1.35, que a revisão anterior REPROVOU
```

O mesmo comando nos bytes da 1.1.36 também dá 17/17 (medição minha, `author-e2e.log`). **O E2E não distingue as duas gerações**: nenhuma das 11 formas de rótulo usa separador entre radical e cauda (`_`, `.`, `/`, `-`), então a correção do C2 da 1.1.35 não tem nenhuma prova E2E; e o sentinela é sempre `ADVSHAPE…7X`, com dígito, então o portão de valor do C1 também não é exercitado:

```
$ node /private/tmp/audita-review-136-scratch/harness/e2e-vacuity.mjs
rótulos do E2E de formas: ["Cartão de crédito","Número do cartão de crédito do titular","Senha (provisória)",
 "Código de verificação","cartão de crédito","CVV","Linha digitável","userPin","cardPin","userpin","PINpad"]
rótulos com separador _ . / - : 0 []
```

A métrica da classe também não serve como prova de comportamento: restaurado o `src/` de qualquer das três gerações anteriores, o arquivo **não carrega** (`SyntaxError: The requested module … does not provide an export named 'isSensitiveValue'`) — falha de importação, não asserção. Ou seja, a alegação de não vacuidade do incremento ("E2E de credencial 17/17") mede a suíte do autor consigo mesma, não o delta.

---

### I4 — A suíte paralela tem uma falha determinística do próprio incremento, e a documentação de release a declara como flake de carga

**Severidade: Important. Regressão de código do incremento, com a causa declarada errada no documento de release.**

A rodada 78 (linha 2531) declara: "a falha é o teste de contenteditable **sob carga**, que passa **168/168 isolado** (`node --test test/background/run-audit.test.js`)". Medição minha:

```
$ cd /private/tmp/audita-review-136 && node --test test/core/normalize-snapshot.test.js
✖ strictly redacts contenteditable root and descendant attributes while preserving external references and control labels (1,8 ms)
ℹ tests 22   ℹ pass 21   ℹ fail 1          ← DETERMINÍSTICA e falha ISOLADA (1,8 ms, não timeout)

$ cd /private/tmp/audita-review-136-scratch/mut-metric-55db44b && node --test test/core/normalize-snapshot.test.js
ℹ tests 22   ℹ pass 22   ℹ fail 0          ← passa com o src da 1.1.35
```

A asserção que falha (`test/core/normalize-snapshot.test.js:597`):

```
AssertionError: Expected values to be strictly deep-equal:
  + actual - expected
    { 'aria-describedby': 'editor-description',
  +   'aria-label': '[redacted]',
      'aria-labelledby': 'editor-label', contenteditable: 'true', role: 'textbox', tabindex: '0' }
```

Ou seja: numa raiz `contenteditable` com texto privado, a 1.1.36 entrega `aria-label="[redacted]"` onde a 1.1.34 e a 1.1.35 **descartavam** o atributo. **Não há vazamento** (o segredo sai), mas o contrato do próprio produto está quebrado e a suíte canônica fica vermelha por causa deste incremento. A atribuição declarada é de outro arquivo (`run-audit.test.js`, que de fato passa 168/168) e o total declarado (4.210/4.208/1) reproduz — o que não reproduz é a **causa**: não é carga, é comportamento, e é regressão contra as duas gerações anteriores.

---

### M1 — `bearer token: VALOR` ainda tarja o lugar errado (caminho de prosa)

```
$ node /private/tmp/audita-review-136-scratch/harness/bearer.mjs
1.1.33 … 1.1.36:  "bearer token: Zqwkvbrtnmxbear" -> "bearer [redacted] Zqwkvbrtnmxbear"
```

A regra `\b(Bearer)(\s+)([^\s<]+)` roda **antes** do tarjador de rótulo e consome a palavra seguinte (`token`), deixando o valor literal logo depois. É a assinatura do C2 da 1.1.35 ("tarja no lugar errado é pior que ausência de tarja"), **pré-existente nas quatro gerações**. Varredura de 3.630 rótulos × 3 valores (10.890 combinações): a tarja no lugar errado caiu de **5.496** (1.1.33/1.1.34/1.1.35) para **66** (1.1.36), e **as 66 restantes são todas da família `bearer <palavra>:`** — 22 rótulos × 3 valores. Classifico como Minor e não Critical porque **não reproduzi o vazamento nas superfícies entregues**: no E2E próprio a forma `bearer token: …` saiu `NENHUMA` nas seis superfícies (a string com marcação colapsa para `[redacted]`), de modo que a exposição medida é a do caminho de prosa puro.

### M2 — Separador duplo ainda tarja o lugar errado (pré-existente nas quatro gerações)

```
1.1.33 1.1.34 1.1.35 1.1.36:  senha__forte  senha._forte  senha/-forte  token__acesso  session__id  → ERRADO
                              "senha[redacted] ADV136SUB7X"
```

`LABEL_CONTINUATION` aceita **um** caractere separador por continuação (`(?:\u0001|[-_.\/])[\p{L}\p{N}]{1,24}`), então `senha__forte` cai na regra de cauda e tarja `__forte:` no lugar do valor. Minor: a forma é menos comum que `senha_forte`, e o defeito não é do incremento (as quatro gerações fazem igual) — mas é o mesmo efeito que o autor declara corrigido sem ressalva.

### M3 — O denominador e o método do preço declarado não reproduzem como escritos

Declarado (rodada 78, linha 2535): "`/usr/share/dict/words`, **234.289** palavras únicas: 566 chave / 101 valor estrito / 566 prosa". Medido por mim:

```
$ node /private/tmp/audita-review-136-scratch/harness/price.mjs
   únicas exatas                       N=235976   chave=571   estrito=101
   únicas lowercase                    N=234456   chave=566   estrito=101
   lowercase + /^[a-z]+$/ + len >= 3   N=234289   chave=566   estrito=101   ← é ESTE o conjunto declarado
```

**Os três números de preço reproduzem** (566/101/566) — e só com a normalização `case-insensitive + só letras + descarta palavras de 1–2 letras`, que é exatamente a que dá 234.289. O documento não declara essa normalização: escrito como está ("palavras únicas de `/usr/share/dict/words`", arquivo com 235.976 linhas **todas distintas**), a leitura literal dá **571/101/571**. Minor de proveniência: o número é reproduzível, o **método** não está escrito, e é o mesmo tipo de defeito que a revisão da 1.1.35 mediu no I1 — agora com o número certo e o comando ausente.

A série antiga refutada continua em três documentos sem anotação: `README.md:53` (também critérios:29-30 e rodada 75) mantém "203 no caminho de chave (contra 284 da 1.1.33 e 87 novas)". Medido: 203 é a **prosa** da 1.1.34; a 1.1.33 dá 286 e a 1.1.35 dá 1.576 no caminho de chave; 284−203=81≠87.

### M4 — A fase serial declarada não reproduz

Declarado (rodada 78): 80 testes, **71 passam, 9 falham** (7 em `sidepanel-flow-mv3`, 1 em `axe-mv3-csp`, 1 em `retention-indexeddb-mv3`). Medido por mim, na raiz do pacote, os 37 arquivos do plano, `--test-concurrency=1`:

```
$ node --test --test-concurrency=1 <37 arquivos>   →  ℹ tests 80   ℹ pass 73   ℹ fail 7   ℹ skipped 0
```

As **7** falhas são todas de `test/e2e/sidepanel-flow-mv3.test.mjs` (conferido por busca dos títulos no arquivo) — a **atribuição confere**; o total não: 73/7 contra 71/9, e nem `axe-mv3-csp` nem `retention-indexeddb-mv3` falharam comigo. É o mesmo fenômeno de carga que a revisão da 1.1.35 registrou (ela mediu 80/73/7 contra os 80/72/8 de então). Enquanto o número for citado como exato, cada revisão mede um total diferente.

### M5 — "41 concatenações medidas, 0 vazam" não tem fixture nem comando; e o "com comando" do preço não existe no commit

`README.md:20` e o registro declaram a sonda de 41 concatenações; não há fixture, script ou linha de reprodução para ela em lugar nenhum do commit (a métrica tem 21 `CONCATENACOES` + 13 formas concatenadas = 34; nenhuma delas com separador). Do mesmo modo, o "medido por predicado **com comando**" do preço (README:30, critérios:12-13, registro:122) não corresponde a nenhum script versionado: `grep -rn "usr/share/dict" --include=*.mjs --include=*.js .` não devolve nada, e a rodada 78 descreve o número sem a linha de comando. O **resultado** das duas coisas confere (reconstruí 52 formas concatenadas, 0 vazam com valor com dígito; e 566/101/566 reproduz) — o que falta é o comando, que é exatamente o que o M3 da revisão anterior pediu e o registro declara corrigido.

---

### Observações

- **O1 — o que confere e tem dentes.** A correção do C2 da 1.1.35 é real e ampla: **60/60** formas multi-parte (15 identificadores × 4 separadores) tarjam o lugar certo, contra **45/60 no lugar errado** em 1.1.33/1.1.34/1.1.35; `senha_forte`, `senha.mestra`, `senha/mestra`, `session-id` e as demais formas de separador simples (21 das 24 medidas) saem `rótulo: [redacted]`; a rota com query do M1 da 1.1.35 fechou (`#/auth/senha/X?tab=1` → `#/auth/senha/[redacted]?tab=[redacted]`, valor tarjado); as quatro frases declaradas preservadas **estão** preservadas; `autocomplete="shipping street-address"`, `id`/`name` e `data-alpine="12"` sobrevivem (este último era **descartado** na 1.1.35); o preço 566/101/566 reproduz; a fonte dos 146 itens confere (146 ids únicos, 96 requisitos + 50 recomendações, 146 títulos únicos) e as duas auditorias ao vivo confirmam 21 de 23 números.
- **O2 — o padrão das quatro revisões se repetiu pela quarta vez.** A 1.1.33 estreitou a detecção e devolveu formas; a 1.1.34 trocou a fronteira e devolveu o outro lado; a 1.1.35 trocou a fronteira por lista fechada e devolveu um terceiro conjunto; a 1.1.36 troca a lista por regra de borda **e** por decisão de valor, e devolve ao mesmo tempo a classe antiga (para outro valor) e um lado cego novo. A causa comum é resolver falso positivo e falso negativo **no mesmo eixo**: aqui o eixo novo (cara do valor) foi comprado com recall, e o eixo da borda deixou o meio do token descoberto. O que a medição sustenta é separar os eixos: (i) posição/borda **sem** exigir nada do valor quando o radical toca o token, (ii) portão de valor que aceite segredo longo só de letras (`valueLikeToken` já existe no arquivo), (iii) o caminho de prosa usando o mesmo vocabulário do caminho de chave, que é o que o autor já reconheceu como necessário na rodada anterior.
- **O3 — o PDF não carrega o bloco de texto visível.** Nos PDFs das minhas nove páginas de sonda (13 páginas cada), o texto das ocorrências aparece como seletor (`html > body > main > h1`, `img#missing-alt`) mas **`Nome acessível` ocorre 0 vezes**, `Forma isolada` 0, e nenhum sentinela. Ou seja: nos artefatos que medi, o vazamento alcança HTML, JSON, modelo e relatório, e **não** alcança o PDF nem o CSV. Isso reduz o alcance (não o elimina) e é consistente com o layout de impressão omitir o anexo de propriedades; registro como fato medido, não como mitigação declarada.
- **O4 — `placeholder="Digite sua senha"` ainda perde o atributo no trecho** (`<input>`), como na 1.1.35. É direção segura (rótulo puro sem valor) e já estava declarado como perda menor na revisão anterior; permanece.
- **O5 — critério 8, conforme instrução.** Não há teste com pessoa leiga, por decisão explícita do usuário (2026-09-16), e ele **não** é portão de produção. Registro como observação, não como bloqueio.
- **O6 — invariantes de privacidade e autorização.** Verificados por execução da fase paralela (a única falha dos 4.210 testes é a de `normalize-snapshot`; passam `test/privacy/*`, `test/legal/*`, `test/background/pixel-capture-consent.test.js`, `pixel-privacy-gate.test.js`, `pixel-attempt-correlation.test.js`, `pixel-consent-expiry.test.js`, `authorized-audit-starter.test.js`, `live-aid-cleanup.test.js`, `raw-navigation-vault.test.js`, `test/highlight/*`) e por leitura das guardas: **nonce** — nenhum arquivo de `src/core/report/` menciona `nonce` (0 ocorrências) e o nonce do destaque vive em propriedade **não enumerável** do objeto da página (`highlight-overlay.js:147-158`), não em atributo de DOM; **autorização antes do pixel** — `pixel-privacy-gate.js:125-128` recusa categoria não autorizada e `:281-320` exige estado `authorizing`/`ready` com `consentId`; **consentimento one-shot** — estado próprio em `pixel-capture-consent.js` + `pixel-consent-expiry.js`; **captura B nunca atribuída a A** — `pixel-attempt-correlation.js`; **limpeza só de abas próprias** — `live-aid-cleanup.js`/`owned-tabs.js`; **identidade de documento antes de cada raster** — `documentId` no envelope do portão. Não observei a sequência CDP de uma execução instrumentada minha — ver §4.
- **O7 — o vocabulário é PT+EN e o espanhol vaza nas quatro gerações.** `nuevaclave:`, `clavenueva:` e `contrasenyanueva:` vazam com valor com dígito **na 1.1.33, na 1.1.34, na 1.1.35 e na 1.1.36** — não é regressão deste incremento, e por isso não entra como achado, mas é o mesmo lado da mesma classe numa página em espanhol, e nenhum documento declara a fronteira de idioma.
- **O8 — o que o dicionário de 566 realmente mede.** Os 566 do "caminho de prosa" são o **vocabulário** (`SENSITIVE_KEY`), não a destruição de prosa: medido palavra a palavra, o predicado que de fato tarja (`hasCredentialValueSignal`) dá **0** em 234.456 palavras isoladas nas quatro gerações — palavra isolada nunca acende. O preço real da prosa é o que a §I1 mede, e ele não é uma contagem de palavras.

---

## 3. Tabela de conferência

| # | Alegação do autor (documento) | Meu comando / procedimento | Resultado medido | Veredito |
|---|---|---|---|---|
| 1 | pacote `8fffa961…56f5`, HEAD `f33bcde`, versão 1.1.36 | `shasum -a 256 release/…1.1.36.zip`; `git rev-parse HEAD`; `manifest.json` | `8fffa961597f28fd8683bb04221580382c4f3ee961bc5659d87226d980a956f5`; `f33bcde92f…`; `1.1.36` | **CONFIRMADO** |
| 2 | o `src/` do pacote é a árvore do commit | `unzip` em `scratch/pkg` + `diff -r pkg/src src` | idênticos (nenhuma diferença) | **CONFIRMADO** |
| 3 | "regra estrutural: 41 concatenações medidas, **0 vazam**" (README; registro: "corrigido na 1.1.36") | `harness/c1c2.mjs` + `valgate.mjs` + E2E próprio nos bytes, dois sentinelas | 8 das 10 formas do C1 vazam com valor só de letras; `novaSenha`/`userPin` vazam e eram tarjados em 1.1.33/1.1.34/1.1.35 | **REFUTADO** (→ C1) |
| 4 | "toca uma borda do token (começa nele ou termina nele)": qualquer concatenação é coberta | `harness/border2.mjs` (8.447 formas; 3.740 realistas) | 2.940 formas realistas cegas na 1.1.36 contra 1.260 na 1.1.35; 2.000 regressões | **REFUTADO** (→ C2) |
| 5 | "C2 corrigido: `senha_forte:`, `senha.mestra:`, `senha/mestra:`, `session-id:` tarjam o lugar certo" (registro) | `harness/c2probe.mjs` (24 formas simples) + `harness/multipart.mjs` (60 formas) | as 4 formas nomeadas e as equivalentes de separador simples: **CERTO**; 24 formas simples → **21 CERTO e 3 no lugar errado** (só separador duplo, → M2); 60 formas multi-parte → **60/60 CERTO** (era 45/60 no lugar errado nas quatro gerações anteriores) | **CONFIRMADO** para o que a alegação nomeia |
| 6 | rota com query (M1 da 1.1.35) corrigida | `redactSensitiveText` em 5 rotas | `#/auth/senha/X?tab=1` → `#/auth/senha/[redacted]?tab=[redacted]` (valor tarjado) | **CONFIRMADO** |
| 7 | preço declarado: 566 chave / 101 valor estrito / 566 prosa, em 234.289 palavras únicas | `harness/price.mjs` sobre `/usr/share/dict/words` | 566/101/566 com dedup sem caixa (N=**234.456**); com dedup exato 571/101/571 (N=235.976) | **PARCIAL** (números sim, denominador não → M3) |
| 8 | `Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12 unidades`, `The hairpin: 12 units`, `tokenizador: interno` preservados | `harness/claimed.mjs` nas quatro superfícies | as quatro preservadas nas quatro superfícies | **CONFIRMADO** |
| 9 | "`conta corrente 12345-6` é prosa" (commit `efe698b`, README) | `harness/fp.mjs` nas quatro superfícies | prosa e trecho preservam; **modelo devolve `[redacted]` para a string inteira** | **REFUTADO no caminho modelo** (→ I2) |
| 10 | `placeholder="Chaveiro de latão"` e `autocomplete="shipping street-address"` preservados pelo predicado estrito | `sanitizeHtmlSnippetSource` em 8 atributos | ambos preservados; `id`/`name` preservados; `data-alpine="12"` **recuperado** (a 1.1.35 descartava) | **CONFIRMADO** |
| 11 | E2E de credencial 17/17 nos bytes empacotados | `node --test --test-concurrency=1` nos dois arquivos, na raiz do pacote | `tests 17 / pass 17 / fail 0` (52,4 s) | **CONFIRMADO** (mas vacuoso → #12) |
| 12 | não vacuidade do E2E: o incremento tem dentes | mesma suíte com `src/` restaurado de `55db44b` (`packroot-mut135`) | **17/17 passam com o src da 1.1.35**; 0 das 11 formas com separador; sentinela sempre com dígito | **REFUTADO** (→ I3) |
| 13 | métrica da classe: 92 formas, 389 combinações, 0 vazamentos | `node --test test/core/credential-class-metric.test.js` | `ℹ formas=92 combinações=389`, 6/6; total calculado pelo teste | **CONFIRMADO** |
| 14 | não vacuidade da métrica contra a geração anterior | mesma suíte com `src/` de 1.1.35/1.1.34/1.1.33 | falha nas três, por **importação** (`does not provide an export named 'isSensitiveValue'`) | **PARCIAL** (→ I3) |
| 15 | fase paralela: 4.210 testes, 4.208 passam, 1 pulado, 1 falha, "a falha é o teste de contenteditable **sob carga**, que passa 168/168 isolado" | `node --test` nos 180 arquivos, na cópia do clone congelado com `.git` e `release/`; e `node --test test/core/normalize-snapshot.test.js` | totais `4210 / 4208 / 1 / 1` **conferem**; mas a falha é `normalize-snapshot.test.js:590`, **determinística**, falha **isolada** (21/22, 1,8 ms) e **passa com o src da 1.1.35** — o `run-audit.test.js` (168/168) é outro arquivo | **REFUTADO** na causa (→ I4) |
| 16 | fase serial: 80 testes, 71 passam, 9 falham (7 em `sidepanel-flow-mv3`) | `node --test --test-concurrency=1` nos 37 arquivos, raiz do pacote | `tests 80 / pass 73 / fail 7`; as 7 em `sidepanel-flow-mv3` | **PARCIAL** (atribuição confere, total não → M4) |
| 17 | 146 itens (96 requisitos + 50 recomendações), 146 ids e títulos | importar `NBR17225_ITEMS` da fonte + artefatos das duas execuções ao vivo | 146 itens, 146 ids únicos, 146 títulos únicos, `{requirement: 96, recommendation: 50}`; HTML 146 linhas/146 ids/146 títulos; JSON 146; PDF 146/146 ids (títulos 136/146 crus, 146/146 com espaço normalizado) | **CONFIRMADO** |
| 18 | custo "2,1× no corpus denso de radicais" | `harness/perf.mjs` (4.000 nós densos, 20.000 strings limpas, 4.000 frases; mediana de 5 rodadas intercaladas) + `subA/cost-bench.mjs` | denso 1.1.36 = 517,9 ms contra 105,8 ms da 1.1.33 (**4,90×**) e 726,7 ms da 1.1.35 (**0,71×**); prosa **6,95×** / **0,83×**; limpo 54,8 ms contra 358,8 ms da 1.1.33. O 2,1× é o par **1.1.35/1.1.34** (reproduzo 2,19×), não a 1.1.36 | **NÃO REPRODUZIDO para a 1.1.36** (o incremento é ~30% **mais barato** que a 1.1.35) |
| 19 | auditoria ao vivo no Google: 0 falhas, 1 alerta, 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5% / 130, índice 9,0/10, PDF 18 páginas, 0 `[redacted]`, notas 5/5, 146/146 ids e títulos no HTML e no PDF, 0 palavras partidas, 112 "Verificar o item" | duas execuções ao vivo minhas nos bytes empacotados + conferência dos artefatos (subC, `subC/VERDICT.md`) | ver §3.1 | **PARCIAL** (21/23 linhas confirmadas; 1 parcial; 1 refutada) |
| 20 | invariantes de privacidade e autorização | execução da fase paralela + leitura das guardas | 0 falhas nos arquivos de privacidade/legal/pixel/highlight; nenhum arquivo de relatório menciona `nonce` | **CONFIRMADO por execução indireta** (ver §4) |
| 21 | "medido por predicado **com comando**" (preço); "41 concatenações medidas" | `grep -rn "usr/share/dict" --include=*.mjs --include=*.js .`; busca de fixture/script das 41 | nenhum script versionado lê o dicionário; não existe fixture nem comando para as 41 | **NÃO REPRODUZÍVEL como escrito** (→ M5) |
| 22 | série antiga "203 no caminho de chave (contra 284 da 1.1.33 e 87 novas)" ainda no README:53 | `subA/dict-sweep.mjs` nas quatro árvores | 203 = prosa da 1.1.34; 1.1.33 = 286; 1.1.35 = 1.576; 284−203=81≠87 | **REFUTADO** (→ M3) |
| 23 | "versão 1.1.36 declarada nos quatro" (artefatos) | `grep`/pypdf nos quatro artefatos das duas execuções | HTML 1×, JSON 1× (`versions.extension`), PDF 1×; **CSV não tem coluna de versão da extensão** (só `csv_schema_version` e `source_version` = versão das regras) | **REFUTADO para 1 de 4** |
| 24 | falso positivo: "`Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12 unidades`, `The hairpin: 12 units`, `tokenizador: interno` preservados" | `harness/claimed.mjs` + `subB` nas quatro superfícies | as quatro preservadas nas quatro superfícies | **CONFIRMADO** |

### 3.1 Auditoria ao vivo — duas execuções próprias nos bytes empacotados

Duas execuções independentes minhas contra `https://www.google.com/` (modo sem pixels), do pacote, com os quatro artefatos guardados (`scratch/live1`, `scratch/live2`; auditorias `8a25faf1-…` e `4b911533-…`). Conferência feita por mim e por um verificador independente com scripts próprios (`subC/VERDICT.md`, `measure_all.py`, `check_html_matrix.py`, `check_pdf.py`, `broken_words.py`, `forensics.py`). **21 de 23 linhas confirmadas nas duas execuções**, com as seguintes ressalvas:

- **CONFIRMADO nas duas**: 146 itens (96 requisitos + 50 recomendações), 146 ids únicos e 146 títulos únicos no HTML **e** no JSON, 0 duplicados, 0 divergências entre HTML e JSON; no PDF, **146/146 ids** e **146/146 títulos** depois de normalizar quebra de linha (10 títulos quebram num espaço, nenhum no meio de palavra); cobertura **28,5%** recomputada da fonte (`coveragePercent(37, 130)`, denominador 130 = 1 página tentada × 130 regras do motor próprio) e índice **9,0/10** (`results-overview.js:33`, 9 de 10 verificações concluídas); grupos **0 falhas / 1 recomendação-alerta / 3 suspeitas (4 ocorrências) / 9 positivos**, iguais no painel, no DOM do relatório, no HTML e no PDF; **109** verificações no checklist; 134 resultados de regra (9 `passed`, 1 `failed`, 96 `cantTell`, 28 `inapplicable`), 118 ocorrências, 117 registros de revisão humana, 11 evidências; **0 `[redacted]`** no HTML, JSON, CSV e PDF; **notas editoriais 5/5** no HTML e no JSON; **0** "Inconformidade ao item"; **0 palavras partidas**; **18 páginas** no PDF; versão 1.1.36 no HTML, no JSON e no PDF.
- **PARCIAL — "112 Verificar o item"**: verdadeiro no **HTML** (112 sentenças, todas citando id do inventário de 146, 0 malformadas; 109 ids distintos porque uma pergunta agrupa quatro itens) e **0 no PDF**, que não carrega as perguntas do checklist.
- **REFUTADO (estreito) — "versão 1.1.36 declarada nos quatro"**: o **CSV não tem coluna de versão da extensão**; ele declara `csv_schema_version="audita-occurrences-v2"` e `source_version` (versão do motor de regras, que se confunde com versão de produto). Os quatro artefatos continuam atribuíveis à mesma execução pelo `canonicalModelHash` compartilhado.
- **Diferença entre as duas execuções**: uma caminhada estrutural do JSON encontrou **zero** mudança de conjunto de chaves ou de tamanho de array; só `nodeCount` 623→622 (um nó de DOM), largura de viewport 1003→1002, ids/hashes de evidência e carimbos de tempo. Todos os totais idênticos. É variação de instância da página viva, **não** defeito — e é a resposta à observação O da revisão anterior.
- **Verificação adversarial de credencial nos artefatos**: 13 padrões (AIza, `sk-`, AKIA, `ghp_`, `xox`, JWT, `Bearer`, `user:pass@`, PRIVATE KEY, atribuições de `password`/`senha`/`secret`/`api_key`/`token`, e-mails, cabeçalhos de cookie) calibrados antes contra um controle positivo sintético e depois aplicados aos quatro artefatos das duas execuções: **0 ocorrências**.
- **O que não fecha**: o comando que o autor nomeia (`node --test /private/tmp/adv136-google.mjs`) existe **fora do commit**, importa o harness de um worktree mutável e **não produz** a maior parte dos números da rodada 78 (os 146, o 96/50, o 134, as 118, as 117, as 11, os 0 `[redacted]`, as 112, as 18 páginas, os 146/146, as 5/5, as 0 palavras partidas). Esses números, portanto, continuam sem comando versionado — a pendência M3 da 1.1.35 **não** foi fechada, só trocou de lugar.


---

## 4. O que eu não consegui verificar

1. **A sequência CDP da autorização antes do pixel, do consentimento one-shot, da correlação "captura B nunca atribuída a A", da limpeza só de abas próprias e da prova de identidade de documento antes de cada raster.** Verifiquei por execução da suíte (0 falhas nos arquivos correspondentes) e por leitura das guardas — não por observação instrumentada minha da ordem das mensagens CDP. A fase serial falhou 7 vezes por timeout de harness (30 s) em `sidepanel-flow-mv3`, e nenhuma dessas falhas é asserção sobre resultado de auditoria; mas, por serem timeouts, também não provam a ordem.
2. **O corpus exato do autor para o "2,1×"**: não está versionado como fixture, então o número dele não é conferível — o que medi foi o **meu** corpus, e nele a proporção é outra (4,90× contra a 1.1.33 e 0,71× contra a 1.1.35).
3. **A auditoria ao vivo contra página que não o Google**: as duas execuções foram em `https://www.google.com/` (como a do autor). Não medi páginas com formulário de senha real, `localStorage` populado ou `<pre>` com dump JSON — que são exatamente as formas que o C2 explora no unitário. Também não re-executei a auditoria do autor: conferi o **conteúdo** dos artefatos dele em `/private/tmp/g136/artifacts-pkg` (existem e batem), mas o documento não amarra os números a um `auditId`/hash/timestamp, então a ligação entre aquela execução e aqueles artefatos é dele, não medida por mim.
4. **O PDF como superfície de vazamento**: medi que o bloco de texto visível **não** aparece no PDF das minhas páginas (0 ocorrências de `Nome acessível`), mas não sei dizer se isso é uma decisão de layout de impressão ou uma limitação da extração de texto do pypdf naquele bloco. A conclusão "o PDF não carrega o vazamento" vale para os PDFs que eu medi; não a estendo a outros layouts de impressão. (Nas auditorias ao vivo, o PDF tem 18 páginas e 146/146 ids — a conferência de integridade fecha; o que não fecha é o mapeamento das 10 quebras de título, que resolvi por normalização de espaço.)
5. **O comportamento sob carga**: os totais da fase serial variam com a carga da máquina (medi 80/73/7 e o autor 80/71/9). Não medi duas vezes em repouso absoluto. A falha determinística de `normalize-snapshot.test.js` **não** é desse tipo: ela falha em 1,8 ms, isolada, e passa com o `src/` anterior.
6. **O 4º `"state":"complete"`**: o log da minha própria sonda trunca a linha de downloads em 700 caracteres, então o quarto registro não aparece por escrito; confirmei os quatro arquivos em disco, todos parseáveis e compartilhando o mesmo `canonicalModelHash`.
7. **A versão no CSV**: não há coluna de versão da extensão para conferir — o artefato não declara a versão do produto, por construção (`csv.js`, `OCCURRENCE_CSV_COLUMNS`). Não é um número que eu possa medir; é uma ausência.

---

## 5. Reprodução

```
# 0) alvo e integridade
cd /private/tmp/audita-review-136
shasum -a 256 release/audita-acessibilidade-1.1.36.zip     # 8fffa961597f28fd…a956f5
git rev-parse HEAD                                          # f33bcde92f424aeff822a72667dbde9c92873dd0

# 1) raiz de medição com os bytes empacotados + árvore de teste DO COMMIT
S=/private/tmp/audita-review-136-scratch
mkdir -p $S/pkg $S/packroot && cd $S/pkg && unzip -q /private/tmp/audita-review-136/release/audita-acessibilidade-1.1.36.zip
cd /private/tmp/audita-review-136 && git archive HEAD test scripts package.json fixtures | tar -x -C $S/packroot
cp -R $S/pkg/. $S/packroot/ && diff -r $S/pkg/src /private/tmp/audita-review-136/src   # idênticos

# 2) mutações (não vacuidade)
for spec in "1.1.33:06e70fc" "1.1.34:e84496a" "1.1.35:55db44b"; do n=${spec%%:*}; r=${spec##*:}
  mkdir -p $S/gen-$r && (cd /private/tmp/audita-review-136 && git archive $r src | tar -x -C $S/gen-$r); done
cp -R $S/packroot $S/packroot-mut135 && rm -rf $S/packroot-mut135/src && cp -R $S/gen-55db44b/src $S/packroot-mut135/src

# 3) diferencial (leak e falso positivo) e preço
cd $S/harness
node c1c2.mjs        # C1/C2 nas quatro gerações, dois sentinelas
node valgate.mjs     # 6 rótulos × 14 valores × 4 gerações
node border2.mjs     # 3.740 formas realistas <prefixo><radical><sufixo>
node multipart.mjs   # 60 formas multi-parte (C2)
node fp.mjs          # falso positivo nas quatro gerações
node claimed.mjs     # as quatro frases declaradas preservadas
node price.mjs       # 566/101/566 e o denominador
node perf.mjs        # custo por geração
node e2e-vacuity.mjs # cobertura do E2E do autor

# 4) E2E nos bytes empacotados, um Chrome por vez
export AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
cd $S/packroot
node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs test/e2e/credential-false-positives-mv3.test.mjs   # 17/17
cp $S/adv136-surfaces.test.mjs test/e2e/adv136-surfaces.test.mjs
node --test --test-concurrency=1 test/e2e/adv136-surfaces.test.mjs   # 9 páginas; 6 falham, controle ausente nas 9
rm test/e2e/adv136-surfaces.test.mjs                                  # fora do plano do autor
cd $S/packroot-mut135
node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs test/e2e/credential-false-positives-mv3.test.mjs   # 17/17 com o src da 1.1.35

# 5) fases canônicas
cd $S/packroot && node --test --test-concurrency=1 $(node -e "console.log(require('$S/serial-files.json').join(' '))")   # 80/73/7
cd $S/clone-full && node --test $(node -e "console.log(require('$S/parallel-files.json').join(' '))")                    # 4210/4208/1/1

# 6) auditoria ao vivo (duas execuções), do pacote
cd $S/packroot && AUDITA_OUT=$S/live1 node --test --test-concurrency=1 $S/live136.mjs
cd $S/packroot && AUDITA_OUT=$S/live2 node --test --test-concurrency=1 $S/live136.mjs
# conferência dos artefatos (verificador independente): $S/subC/VERDICT.md + measure_all.py/check_pdf.py/broken_words.py
PY=/Users/andrebadini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
$PY /private/tmp/integrity/print-integrity.py $S/live1      # 18 págs, 146/146 ids e títulos, 0 palavras partidas

# 7) proveniência do preço e a falha determinística da suíte
node $S/harness/price.mjs                                   # 235.976 → 571/101; 234.456 → 566/101; 234.289 → 566/101
cd /private/tmp/audita-review-136 && node --test test/core/normalize-snapshot.test.js   # 21/22, falha determinística
cd $S/mut-metric-55db44b && node --test test/core/normalize-snapshot.test.js            # 22/22 com o src da 1.1.35
```

---

## 6. Fecho

O incremento não é vazio — a correção do C2 é a mais ampla das quatro gerações e está medida, e as partes que o autor declara conferem em sua maioria (preço, 146 itens, fases, frases preservadas, rota com query). Mas o desenho que ele apresenta como "os dois lados" fecha o lado do falso positivo **cobrando o preço no valor** e deixa o **meio** do token sem vocabulário: com isso, a classe do C1 da 1.1.35 continua aberta para o valor sem dígito, abre-se um lado cego que não depende do valor, e o custo do recall é pago do outro lado com uma perda de evidência 2,9× maior que a da geração anterior. Os três são reprodutíveis nos bytes empacotados, com controle positivo na mesma página, e atribuíveis ao incremento. **Veredito: reprovado — 2 Critical, 4 Important, 5 Minor, 8 observações.**
