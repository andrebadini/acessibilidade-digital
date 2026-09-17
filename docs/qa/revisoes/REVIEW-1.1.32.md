# Revisão adversarial independente — Audita Acessibilidade 1.1.32

- **Alvo**: `release/audita-acessibilidade-1.1.32.zip`, SHA-256 `0f0d5f386604ba39f6c16e807740d278706f16d1309a0e180e92e09be0889375` (confere).
- **Checkout congelado**: `/private/tmp/audita-review-132`, HEAD `d17dd8a5ee8841d2698380c030fc32b4860f9f19`, **intocado** (§6).
- **Bytes medidos**: pacote extraído (não a árvore), em `/private/tmp/adv132/pkg`; comparação contra os bytes empacotados da 1.1.31 (`fa91745`) em `/private/tmp/adv132/pkg131`.
- **Chrome real**: CFT `152.0.7977.64` (`/private/tmp/audita-cft152-fixed/...`), um Chrome por vez, `--test-concurrency=1`.
- **pypdf**: `/Users/andrebadini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3` (6.10.0).

---

## 1. Veredito

**A 1.1.32 NÃO substitui a 1.1.31/1.1.30 como candidata aprovada.** A classe continua aberta por
credenciais inequívocas que chegam inteiras a quatro superfícies entregues, e o incremento **reabriu**
uma forma que a 1.1.31 fechava (regressão medida nos dois sentidos). Três mecanismos novos declarados
funcionam e estão de fato cobertos por teste (ablação em §4, O4), o que é avanço real — mas não é o
suficiente para aprovar.

| Severidade | Qtd | Itens |
| --- | --- | --- |
| Critical | 1 | C1 vocabulário de credencial de cartão/boleto (`PIN`, `CVV`, `CVC`, `PUK`, `seed`, `Linha digitável`) |
| Important | 3 | I1 regressão de string com marcação; I2 nova família de falso positivo destrutivo; I3 `npm test` aborta |
| Minor | 4 | M1 janela de rótulo > 6 palavras; M2 `computeAccessibleText` multi-palavra; M3 separador fora de `[-–—:]`; M4 números declarados e proveniência da medição |
| Observações | 6 | O1–O6 (inclui o que confere: gates, artefato, ablação, idempotência) |

**Conserto bloqueante** (caminho exato, não aplicado): §2.C1 (vocabulário), §2.I1 (guarda `[<>]`),
§2.I3 (uma linha em `scripts/run-tests.mjs`).

---

## 2. Achados

### C1 — Credenciais de cartão e de boleto fora do vocabulário chegam inteiras a 4 superfícies

**Severidade: Critical. Pré-existente** (idêntico na 1.1.31; não é regressão). É a classe do incremento.

Medição direta nos bytes empacotados (`redactSensitiveText` + `sanitizeJsonData`, caminho JSON):

```
"PIN: 4821"                        -> "PIN: 4821"          (livre)
"CVV: 937"                         -> "CVV: 937"           (livre)
"CVC: 937"                         -> "CVC: 937"           (livre)
"Número de segurança: 937"         -> "Número de segurança: 937"
"PUK: 12345678"                    -> "PUK: 12345678"
"seed: JBSWY3DPEHPK3PXP"           -> "seed: JBSWY3DPEHPK3PXP"
"Linha digitável: 00190.00009 03309.933319 00000.000008 8 71030000012345" -> livre
"Código de barras: 1234...1234"    -> livre
"PIN do cartão: 4821"              -> tarjado   (o "cartão" do sufixo é que salva)
"TOTP: 123456"                     -> tarjado   (o "otp" dentro de TOTP casa)
```

Ponta a ponta, no pacote extraído com Chrome real (teste próprio `adv-credential-shapes`,
uma forma por página, 6 superfícies varridas: painel, relatório, modelo/revisão guardados,
artefato html, json, csv):

```
✖ PIN: 4821            VAZOU em relatório, modelo e revisão guardados, artefato html, artefato json
   contexto: ...&lt;main&gt;&lt;h1&gt;Forma isolada pin&lt;/h1&gt;&lt;p&gt;PIN: 4821&lt;/p&gt; &lt;p&gt;CONTROLEPINMARCADOR...
✖ CVV: 937             VAZOU nas mesmas 4 superfícies
✖ Linha digitável: ... VAZOU nas mesmas 4 superfícies
   contexto: "visibleText":"Forma isolada linhadigitavel Linha digitável: 00190.00009 ...
```

`PIN`, `CVV`/`CVC`, `PUK` e `seed` de 2FA são credenciais; `Linha digitável`/`Código de barras` de
boleto são o instrumento de pagamento. Todos passam porque `SENSITIVE_WORD_SOURCE`
(`src/core/privacy.js:81`) não os conhece e nenhum outro ramo do tarjador exige "cara de valor" sem
rótulo sensível.

**Conserto exato**: acrescentar as alternativas a `SENSITIVE_WORD_SOURCE` em `src/core/privacy.js`
(o vocabulário é compartilhado por snippet, seletor e nome acessível, então uma edição fecha os cinco
caminhos). Mutante medido `FIX-C` (`|pin|cvv|cvc|puk|seed|linha[\s\-–—]+digit[áa]vel|...`):
`PIN: 4821` deixa de vazar e a métrica da 1.1.32 continua verde (4/4).

### I1 — Regressão: string com marcação perdeu a tarja de cauda e entrega a credencial

**Severidade: Important. REGRESSÃO introduzida na 1.1.32.**

```
1.1.31  sanitizeJsonData({t:'<div title="senha ZQ7K2M9P4X">x</div>'}).t
        -> '<div title="senha [redacted]'
1.1.32  -> '<div title="senha ZQ7K2M9P4X">x</div>'          <-- credencial inteira
1.1.31  sanitizeJsonData({t:'<input placeholder="senha ZQ7K2M9P4X">'}).t -> '<input placeholder="senha [redacted]'
1.1.32  -> '<input placeholder="senha ZQ7K2M9P4X">'
1.1.31  sanitizeHtmlSnippetSource('<pre>&lt;div title="senha ZQ7K2M9P4X"&gt;x&lt;/div&gt;</pre>')
        -> '<pre><div title="senha [redacted]</pre>'
1.1.32  -> '<pre><div title="senha ZQ7K2M9P4X">x</div></pre>'
```

Comparação automática do meu universo (801 formas, mesmos caminhos): **a 1.1.31 vaza 244, a 1.1.32
vaza 282**; 173 entradas vazam agora e não vazavam antes, 75 fecharam. A família dominante das 173 é
exatamente `<tag atributo="rótulo valor">` no caminho JSON (title/alt/aria-label/aria-description/
placeholder/data-* em 8 tags diferentes).

Causa (diff `fa91745..d17dd8a`, três edições que se somam):
1. `src/core/privacy.js` — `redactCredentialLabelTail` ganhou `&& !/[<>]/u.test(token)` nas duas
   substituições; com `\S+` guloso o token de `<div title="senha ZQ…">x</div>` é
   `ZQ…">x</div>`, que contém `<`, e o tarjador desiste;
2. `src/core/privacy.js` — `redactStringValue` perdeu o passo `const withTailRule =
   redactCredentialLabelTail(redacted)` que a 1.1.31 aplicava a strings com marcação;
3. `src/core/evidence/snippet.js` — o ramo contaminado trocou
   `sanitizeText(redactCredentialLabelTail(decoded))` por `sanitizeText(decoded)`.

A projeção sem tags não salva: ela **apaga o atributo junto com a tag**, então o rótulo desaparece da
projeção e `hasCredentialValueSignal` devolve falso — a string volta intacta.

Ponta a ponta (Chrome real, pacote extraído) — a página exibe marcação como texto
(`<pre>&lt;div title="senha SECRET"&gt;x&lt;/div&gt;</pre>`):

```
✖ ADV-MARKUP: vazou em relatório+modelo e revisão guardados+artefato html+artefato json
   relatório: ...&lt;pre&gt;&lt;div title="senha ADVMARKUPXQ7"&gt;x&lt;/div&gt;&lt;/pre&gt;...
   modelo   : "visibleText":"... <div title=\"senha ADVMARKUPXQ7\">x</div> ..."
```

**Conserto exato**: estreitar a guarda nova de "contém `<`/`>`" para "**começa** com `<`/`>`" nas duas
substituições de `redactCredentialLabelTail` (`src/core/privacy.js`, linhas com
`&& !/[<>]/u.test(token)`) → `&& !/^[<>]/u.test(token)`. Medido no mutante `FIX-A`: a métrica da
1.1.32 continua **verde (4/4)**, as 1.1.31 formas `<div title="senha [redacted]` voltam, e o meu
universo cai de 282 para **101** vazamentos. A ablação `m6` mostra por que a guarda existe: removê-la
por inteiro quebra a forma `A9` (`<p><b>senha</b> X</p>` no caminho JSON) — por isso o conserto é
estreitar, não remover.

### I2 — Regressão: o scanner de cauda destrói prosa legítima com palavra de credencial

**Severidade: Important. REGRESSÃO introduzida na 1.1.32** (o `spacedLabelTailIndex` é novo).

O scanner de rótulo multi-palavra decide pelo **token seguinte** com `strongValueToken`, que aceita
qualquer token de 12+ caracteres, ou com 4+ dígitos, ou de 6+ com símbolo. Numa frase, esse "token
seguinte" é uma palavra comum — e a linha inteira é substituída por `[redacted]`.

Corpus próprio de 29 frases realistas de página brasileira, mesmos dois caminhos:

```
frases: 29   tarjadas na 1.1.31: 1   na 1.1.32: 16   REGRESSÕES: 15

"A senha expira em 12/03."                       -> "<p>A [redacted]</p>"     (1.1.31: intacta)
"A senha deve ter complexidade suficiente."      -> "<p>A [redacted]</p>"
"Sua senha é pessoal e intransferível."          -> "<p>Sua [redacted]</p>"
"A chave do problema está na falta de fiscalização." -> "<p>A [redacted]</p>"
"O cookie de sessão é essencial para autenticação."  -> "<p>O [redacted]</p>"
"Informe o token no cabeçalho Authorization."    -> "<p>Informe o [redacted]</p>"
"A senha foi alterada em 12/03/2026 pelo administrador." -> "<p>A [redacted]</p>"
"O segredo de justiça requer credenciamento no sistema." -> "<p>O [redacted]</p>"
```

No corpus maior de 62 frases (login, tribunal, documentação, e-commerce, notícia) a 1.1.32 tarja 4 e a
1.1.31 tarja 3 — mas as frases são **outras**: as três do autor (`Segredo de justiça: …`,
`Senha do usuário: mínimo de 8 caracteres.`, `Chave da API: consulte o manual.`) e
`Digite sua senha atual.` saem **intactas** (confere a declaração), ao custo de quatro novas.

Ponta a ponta com controle negativo na mesma página (mesma forma, sem palavra de credencial):

```
✖ ADV-FP  controle em: relatório+modelo+artefato html+artefato json
          gêmea (sem credencial) "A fatura expira em 12/03 e pode ser paga no portal." -> entregue nas 4
          alvo  (com credencial) "A senha expira em 12/03 e pode ser trocada no portal." -> AUSENTE das 4
          modelo: "visibleText":"... A fatura expira em 12/03 e pode ser paga no portal. A [redacted]"
```

Ou seja: a diferença entre evidência preservada e evidência destruída é a palavra `senha`. O custo não
é só o valor: a marcação por conteúdo é monotônica, então **o resto do trecho também cai** (é por isso
que o parágrafo de controle da minha fixture desapareceu nas formas que acertam o sinal).

**Conserto exato** (mutante medido `FIX-F`, métrica 4/4 verde): o ramo de cauda usa `strongValueToken`,
cujo primeiro critério é "12+ caracteres" — pensado para o ramo COM separador, onde `senha
ZQXJKVBWPMTLRNHS` precisa cair. Em `spacedLabelTailIndex` (`src/core/privacy.js`), trocar a chamada por
um predicado próprio da cauda que **não** aceite comprimento puro de letras:

```js
function strongTailToken(token) {
  const core = String(token ?? '').replace(/[.!?,;:\u2026"')\]}]+$/u, '');
  if ((core.match(/\d/gu) ?? []).length >= 4) return true;
  return [...core].length >= 6 && /\d|[^\p{L}\p{N}\s]/u.test(core);
}
```

Efeito medido: corpus de 29 frases realistas cai de **16 tarjadas para 5** (as 5 restantes têm
token de 4+ dígitos, ex. `12/03/2026`), corpus de 62 frases cai de 4 para **0**, a métrica da 1.1.32
continua **verde (4/4)** e o meu universo não muda (282 — o conserto não reabre forma nenhuma).
O critério de "4+ dígitos" ainda morde data (`12/03`), então vale restringi-lo a tokens sem separador
interno ou exigir comprimento de segredo junto — decisão do autor, com a medição na mão.

### I3 — `npm test` aborta: o E2E novo não está registrado no plano de testes

**Severidade: Important. REGRESSÃO de ferramenta introduzida na 1.1.32.**

```
$ cd <árvore congelada> && npm test
> node scripts/run-tests.mjs
TEST_PLAN_UNCLASSIFIED_E2E
EXIT=1
```

`scripts/run-tests.mjs` classifica os E2E em `REAL_CHROME_E2E` (35) e `PROCESS_SAFE_E2E` (2). O arquivo
novo do incremento, `test/e2e/credential-shapes-mv3.test.mjs`, **não está em nenhum dos dois** — e
`createTestPlan` lança antes de rodar qualquer teste. Medido: 38 arquivos `test/e2e/**/*.test.mjs`
descobertos, 37 classificados, 1 não classificado (`grep -n credential-shapes scripts/run-tests.mjs`
não retorna nada).

Consequência: os números declarados de suíte e de fase serial **não podem** ter saído do comando
canônico (eu os reproduzi invocando `node --test` diretamente sobre a lista de arquivos — §M4 —, então
o artefato é verificável; o que está quebrado é o comando de gate). O próprio instrumento do autor tem
o mesmo buraco: `/private/tmp/declared.txt` e `/private/tmp/ran.txt` (36 linhas, idênticos) não contêm
`credential-shapes-mv3.test.mjs` — a comparação declarado×rodado passou porque os dois lados foram
montados sem o arquivo novo.

**Conserto exato**: acrescentar `'test/e2e/credential-shapes-mv3.test.mjs',` ao conjunto
`REAL_CHROME_E2E` em `scripts/run-tests.mjs` (o arquivo usa Chrome real e abre uma extensão). Uma linha.

### M1 — Janela de rótulo para na 7ª palavra: rótulo longo em cauda chega a 4 superfícies

**Severidade: Minor. Pré-existente** — a 1.1.31 também vazava aqui, e a 1.1.32 fechou a janela até 6
palavras extras (`senha do usuário administrador do sistema X` fecha); a 7ª palavra extra volta a
vazar.

```
1.1.32  sanitizeHtmlSnippetSource('<p>chave de acesso ao sistema principal da conta ZQ7K2M9P4X</p>')
        -> '<p>chave de acesso ao sistema principal da conta ZQ7K2M9P4X</p>'   (intacto)
        sanitizeJsonData(...) idem
```

Ponta a ponta: `✖ cauda com 5 palavras de rótulo — VAZOU em relatório, modelo e revisão, artefato html,
artefato json`. O laço do scanner é `end - index <= 6`, então o valor depois da 7ª palavra nunca é
testado; o `VALUE_LABEL_SOURCE` do ramo com separador tem `{0,6}?` e sofre do mesmo limite. Formas de
4 palavras (as da métrica e do E2E do autor) fecham; 5+ palavras de rótulo, não.

### M2 — `computeAccessibleText` não tarja rótulo multi-palavra com separador

**Severidade: Minor. Pré-existente.** O nome acessível aplica só `redactCredentialLabelTail`, e a
janela preguiçosa se compromete com a segmentação mais curta (`senha` + ` ` + `do`), cujo token não tem
cara de valor — e o motor não retrocede para tentar a janela maior, porque a rejeição está no callback
da substituição, não no padrão.

```
computeAccessibleText({attributes:{title:'senha do usuário: ZQ802KM9P4X'}})
  -> name: 'senha do usuário: ZQ802KM9P4X'   (1.1.31 também; as superfícies entregues são salvas depois
                                              por redactNormalizedNode/sanitizeJsonData)
E2E: as 6 superfícies saem limpas (o valor não aparece em nenhuma) — o defeito não chega ao entregável
porque `redactNormalizedNode`/`sanitizeJsonData` retarjam depois.
```

O caminho JSON tarja corretamente a mesma forma; o defeito é de fronteira de módulo. **Conserto**:
em `src/core/accessibility/accessible-name.js:234-236`, aplicar `redactSensitiveText` (que tem o
separador obrigatório e por isso expande a janela) em vez de só `redactCredentialLabelTail`, ou repetir
a decisão por scanner de tokens do `spacedLabelTailIndex`.

### M3 — Separador fora de `[-–—:]` faz o tarjador consumir o símbolo como valor

**Severidade: Minor. Pré-existente** na raiz, **e alcançável ponta a ponta** pelo carreador de marcação.

```
1.1.32  redactSensitiveText('<p>senha | ZQ7K2M9P4X</p>')  -> '<p>senha [redacted] ZQ7K2M9P4X</p>'
        redactSensitiveText('<p>senha · ZQ7K2M9P4X</p>')  -> '<p>senha [redacted] ZQ7K2M9P4X</p>'
        idem para '»', '∶', '：' e para o escape '\\u003a'
```

`TAIL_CANDIDATE` (`src/core/privacy.js:295`) só aceita `[-–—:]` como ruído de separador e o `\S+`
interno de `redactCredentialLabelTail` captura o próprio símbolo (`|`) como valor; o resto da linha
sobrevive. No caminho de texto puro o scanner de cauda salva; na string com marcação, não — e o
`redactStringValue` retorna cedo ao ver `[redacted]`, sem conferir a projeção.

Ponta a ponta (mesma fixture do I1, os dois carreadores na mesma página):

```
✖ ADV-MARKUP: vazou em relatório+modelo e revisão guardados+artefato html+artefato json
   modelo: "... <p>senha [redacted] ADVMARKUPXQ7</p> <div title=\"senha ADVMARKUPXQ7\">x</div> ..."
```

**Conserto exato** (mutante medido `FIX-ABD`, métrica verde, universo 282 → **87**, prosa inalterada):
(a) a guarda `^[<>]` do I1; (b) incluir `|·»` na classe de ruído de `TAIL_CANDIDATE`
(`[-–—:|·»]*`); (c) em `redactCredentialLabelTail`, tratar um token que seja só ruído de separador
como separador e olhar o token seguinte.

### M4 — Números declarados e proveniência das medições

| Declarado | Medido | Situação |
| --- | --- | --- |
| suíte sem `test/e2e/` = 4.164 testes, 4.163 passam, 1 pulado, 0 falham | **4.164 testes, 4.163 passam, 1 pulado, 0 falham** no espelho completo do congelado (`.git` presente). No pacote extraído dá 4.147/16 porque faltam `docs/`, `store-assets/`, `package.json` e `.git` (os 16 são `ENOENT`); os 5 arquivos afetados passam **58/58** no espelho | ✅ idêntico |
| gate `release-package`+`extension-shell`+`release-assets` 20/20 com o digest fixado | **20/20**, e o digest do zip segue `0f0d5f38…9375` depois do gate (o teste reconstrói em diretório temporário e compara com `deliveredPackageSha256`) | ✅ idêntico |
| 22 testes de Chrome real na raiz extraída (16 + 6) | **22 testes, 22 passam, 0 falham** na raiz extraída, conjunto de 8 arquivos do autor (6 `credential-shapes` + 16 de escopo/relatório). A minha primeira rodada deu 27 porque incluí `axe-mv3-csp-decision.test.mjs`, que o autor não incluiu | ✅ idêntico |
| fase serial 32/35 com três vermelhos que passam isolados | meu serial: 54/63 testes, **6 arquivos vermelhos**; isolando um a um: `axe-mv3-csp`, `batch-audit`, `url-audit`, `page-markers-signals`, `url-pixel-consent` **passam** (eram carga), `sidepanel-flow-mv3` **falha também isolado** — duas execuções isoladas, 7/9 e 3/9 vermelhos, sempre `WAIT_TIMEOUT` na tela de pausa por privacidade (`assertPausedAttempt`, `sidepanel-flow-mv3.test.mjs:1043`) | ⚠️ não reproduzi "passa isolado" para `sidepanel-flow-mv3` |
| — | a raiz de teste do autor (`/private/tmp/pkg132/test`) traz a versão da **árvore de desenvolvimento** de `sidepanel-flow-mv3.test.mjs` (`f3999ed0…`), não a do commit congelado (`5583725…`); a árvore de dev está em `f32ca4b`, com esse arquivo modificado. Rodando a versão da árvore de dev **contra a `src` congelada**, ela também falha (9/12) — ou seja, não é só o arquivo velho: há indício de ambiente **ou** de estado real, e eu não consegui separar os dois | ⚠️ proveniência + resultado não reprodutível |
| métrica reprova com 23 vazamentos contra os bytes da 1.1.31 | **24** vazamentos + teste do seletor vermelho + teste de prosa vermelho (`node --test test/core/credential-class-metric.test.js` no pacote 1.1.31) | ⚠️ 24, não 23 |
| Google real = 0 falhas, 9 positivos, 109 no checklist, versão 1.1.32 | conferido **no artefato entregue**, não re-executado (o brief proíbe enviar dado a serviço externo): `itemResults` 146 = 109 `cantTell` + 27 `inapplicable` + 9 `passed` + 1 `failed` (o alerta/recomendação); `versions.extension = 1.1.32`; `axe.occurrences = 4` (3 requirement + 1 recommendation) | ✅ consistente |
| artefato entregue = 146/146 ids e títulos, 0 palavras partidas, notas 5/5 nos dois formatos | medido com pypdf no artefato de `/private/tmp/g132/artifacts-pkg` (cuja `src` é byte a byte a do zip entregue): 146 ids únicos, 146 títulos, **0 ausentes no HTML, no PDF e no JSON**, `editorialNotes` 5/5 no HTML e no PDF, **0 títulos não contíguos no PDF** (palavra partida), `[redacted]` = 0, 11 snippets / 5.228 caracteres | ✅ |
| digest, entradas, pacote↔árvore, reconstrução, zip rastreado | §4 | ✅ |

---

## 3. Retratações

1. **Retrato a suspeita inicial de que a guarda `[<>]` sozinha era o defeito e que removê-la era o
   conserto.** A ablação `m6` (guarda removida) faz a métrica da 1.1.32 **reprovar** na forma `A9`
   (`<p><b>senha</b> ADVSEN09X</p>` no caminho JSON): sem a guarda, o tarjador consome `</b>` como
   valor, produz um `[redacted]` parcial e o `redactStringValue` retorna cedo sem conferir a projeção.
   A guarda é carga; o conserto é **estreitá-la** para `^[<>]`.
2. **Retrato, para esta rodada, a crítica de vacuidade da revisão da 1.1.31.** O E2E de forma isolada
   do autor é não vacuoso: com os sanitizadores da 1.1.31 ele **reprova 4 de 6**, nomeando superfícies
   (`relatório`, `modelo e revisão guardados`, `artefato html`, `artefato json`), e com o código atual
   passa 6/6. A métrica também: contra os bytes da 1.1.31 ela reprova 3 dos 4 testes.
3. **Retrato a leitura de que o defeito de `\s` em template literal continuaria silencioso.** O
   mutante `m5` (trocar `String.raw` por template literal comum no tarjador de cauda) **é detectado**:
   2 testes reprovam (`o nome acessível do fallback…` e `o sinal não acende em prosa…`). A proteção
   contra aquele defeito existe agora.
4. **Corrijo um erro do meu próprio harness**: a primeira versão da minha comparação rotulava as
   formas como "pré-existentes" usando um critério por *qualquer* caminho; a classificação correta é
   por caminho (§2.I1), e é ela que sustenta a palavra "regressão".
5. **Corrijo a contagem de 27 testes de Chrome** na minha primeira rodada do conjunto declarado: o
   autor não inclui `axe-mv3-csp-decision.test.mjs` no conjunto de 22; sem ele, 22 é o número correto.

---

## 4. O que confere (medição própria)

- **Integridade do artefato**: digest `0f0d5f38…9375` ✅; `unzip -l` = **199 arquivos** ✅;
  pacote→árvore idêntico em `src/`, `vendor/`, `assets/`, `manifest.json` (só faltam no zip os itens de
  repositório: `assets/icons/icon-1024.png`, `icon-source.svg`); árvore→pacote: nenhum arquivo extra no
  zip (lista de 199 entradas == conjunto de runtime do `scripts/build-release.mjs`) ✅; reconstrução
  determinística com `--temporary-release-directory` (o gate `release-package` reconstrói e compara o
  digest entregue) ✅; **o zip está rastreado** em `git ls-files release/` ✅ — e, ao contrário do que o
  brief supunha, `git status --porcelain` no congelado é **vazio** (não há `?? release/…zip`).
- **Suíte**: 4.164 testes / 4.163 passam / 1 pulado / 0 falham no espelho do congelado (§M4).
- **Gate de release**: 20/20, digest inalterado depois do gate (§M4).
- **22 testes de Chrome** no conjunto declarado: 22/22 (§M4).
- **Artefato entregue** (146/146, notas 5/5, 0 palavras partidas, `[redacted]` = 0, 5.228 caracteres de
  snippet) (§M4).
- **Idempotência**: nenhuma das 801 formas do meu universo produziu vazamento por não-idempotência;
  sondas dirigidas (`<div title="senha X">`, `senha | X`, `senha [redacted] X`, `A senha expira em
  12/03.`) são idempotentes nos três sanitizadores.
- **Ablação dos mecanismos novos** (`node --test test/core/credential-class-metric.test.js` em cópia
  mutada): remover o vocabulário qualificado PT → reprova (`código de verificação`, `frase de
  recuperação` vazam); voltar a janela para `{0,2}` sem parênteses → reprova (parênteses vazam);
  desligar o scanner de tokens → reprova (cauda multi-palavra vaza); devolver o seletor ao vocabulário
  privado em inglês → reprova (`o seletor não pode carregar title`); `strongValueToken` sempre falso →
  reprova; desligar a decisão por valor → reprova a prosa. **Todos os mecanismos declarados estão de
  fato cobertos** — o que falta é cobertura para o que eles não cobrem (§2.I1, §2.I2, O2).
- **Corpus de prosa do autor**: as 4 frases declaradas intactas saem intactas nos 4 caminhos.

### Observações (O1–O6)

- **O1** `Número do protocolo: X` chega às 4 superfícies (E2E). Não é credencial; se for para tarjar,
  é decisão de escopo, não conserto — registro para o autor decidir, com a medição crua.
- **O2** A lista `ATRIBUTOS` da própria métrica (`test/core/credential-class-metric.test.js:124-127`)
  só é conferida no caminho **trecho** — e é exatamente no caminho **json** que a regressão do I1 vive.
  As cinco formas da lista vazam no json hoje:
  ```
  <input placeholder="senha ADVSEN50X">  -> "<input placeholder=\"senha ADVSEN50X\">"
  <img alt="token ADVSEN51X">            -> "<img alt=\"token ADVSEN51X\">"
  <div title="chave ADVSEN52X">x</div>   -> "<div title=\"chave ADVSEN52X\">x</div>"
  <div aria-label="senha ADVSEN53X">…    -> vaza
  <div aria-description="senha ADVSEN54X">… -> vaza
  ```
  Fechar essa lacuna é o teste mínimo que pega o I1.
- **O3** No mesmo teste, `json2` (idempotência) é derivado de `json`: quando `json` já saiu tarjado, a
  asserção de `json2` é vacuosa por construção (não é o caso das formas medidas, mas não protege nada).
- **O4** O autor declara ter corrigido um defeito próprio de `String.raw` que era silencioso — hoje
  **não é silencioso** (retratação 3) e os quatro mecanismos novos são detectados por mutação (acima).
- **O5** Custo do falso positivo, medido: a tarja não remove só o valor — como a marcação por conteúdo
  é monotônica, **o resto do trecho cai** (§2.I2, controle da fixture de E2E engolido). Isso agrava I2:
  uma frase legítima com `senha` custa o parágrafo inteiro da evidência.
- **O6** A superfície **PDF** não foi varrida para as minhas sentinelas (o E2E do autor varre
  html/csv/json e pula o PDF); usei pypdf no artefato do Google apenas para as checagens de 146/notas.

---

## 5. O que eu NÃO medi

- **A auditoria real do Google re-executada**: o brief proíbe enviar dado a serviço externo. Conferi os
  números **no artefato entregue** pelo autor (`/private/tmp/g132/artifacts-pkg`), depois de provar que
  `/private/tmp/pkg132/src` é byte a byte a `src` do zip entregue e que o artefato declara 1.1.32.
- **A superfície PDF para as minhas formas**: não gerei PDF com as minhas sentinelas; o E2E que usei
  varre painel, relatório, modelo/revisão, HTML, JSON e CSV.
- **`scripts/verify-project.mjs`** e os "16 testes de escopo" como tais: reproduzi o conjunto de 22
  testes de Chrome do autor, não o verificador.
- **Runtime clássico de persona** (`src/core/accessibility/accessible-preview-runtime.classic.js:249`,
  chamado por `src/personas/content.js:484`): continua sem tarja e eu **não tracei** superfície
  entregue — é a mesma lacuna que a revisão da 1.1.31 deixou.
- **CDATA, `<template>`, `<noscript>` como contêiner entre rótulo e valor**; variantes NFD/NFC de
  rótulos acentuados; CDN/proxy que reescreva o HTML.
- **Uma segunda execução completa da fase serial** para separar carga de defeito: isolei os 6 arquivos
  vermelhos (5 passam, `sidepanel-flow-mv3` falha em duas execuções isoladas), mas não repeti a fase
  inteira; e não consegui determinar se o vermelho de `sidepanel-flow-mv3` é ambiente (o autor declara
  que passa) ou estado real do incremento.
- **Chrome fora do CFT 152.0.7977.64.**
- Não despejei nem li `/Users/andrebadini/Downloads/eval_mymonitor.csv`; nenhum dado de sessão/e-mail
  foi tocado. O conteúdo citado dos artefatos é de página pública (`google.com`) e só em contextos de
  contagem/verificação.

---

## 6. Estado do checkout congelado

```
$ cd /private/tmp/audita-review-132 && git rev-parse HEAD
d17dd8a5ee8841d2698380c030fc32b4860f9f19
$ git status --porcelain
(vazio)
```

O congelado **terminou intocado**: HEAD `d17dd8a`, árvore limpa, e nenhum comando de escrita foi
executado nele (as medições rodaram em cópias: `/private/tmp/adv132/pkg`, `pkg131`, `mirror`, `mut/*`,
`fix/*`). O trabalho de árvore de desenvolvimento foi somente leitura (`diff`, `git rev-parse`).

### Artefatos da revisão (em `/private/tmp/adv132/`)

`attack1.mjs` / `attack1.out` (universo de 801 formas), `attack1.131.mjs` / `.out` (mesmo universo nos
bytes da 1.1.31), `compare.mjs` / `compare.out` (lado a lado por forma e caminho),
`falsopos.mjs` / `falsopos.out` (corpus de 62 frases), `fix/fp29.mjs` (corpus de 29 frases),
`ablation.sh` / `ablation.out` (8 mutantes),
`fixprobe.sh` / `fixprobe.out` e `fix/{A,B2,AD,ABD,E,F}` (consertos candidatos medidos),
`artcheck132.py` (pypdf no artefato entregue), `pkg/test/e2e/adv-credential-shapes.test.mjs` e
`pkg/test/e2e/adv-fp-markup.test.mjs` (E2E próprio, com controle de não vacuidade),
`e2e-current.log`, `e2e-mutant131.log`, `e2e-adv.log`, `e2e-fpmarkup.log`, `e2e-22b.log`,
`serial.log`, `iso-sidepanel.log`, `unit.log`, `unit-mirror.log`, `full-suite.log`
(`TEST_PLAN_UNCLASSIFIED_E2E`).
