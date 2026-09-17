# REVISÃO INDEPENDENTE — Audita Acessibilidade 1.1.37

## Cabeçalho

| Campo | Valor |
|---|---|
| Artefato | `release/audita-acessibilidade-1.1.37.zip` (extensão Chrome MV3, auditoria local, ABNT NBR 17225:2025) |
| SHA-256 medido | `b6a1a8c05a30ee5f894986a35760518243cce794e683f39ad51a08d64cc044de` — **confere** com o declarado |
| Commit | `d03d4bd23ca92e970ed7eae3a6f586eb4407038d` (clone congelado `/private/tmp/audita-review-137`, `git status` limpo) |
| Data/hora da medição | 2026-09-17, 04:05–09:10 (America/Cuiaba) |
| Ambiente | macOS arm64; Node v26.5.0; Chrome for Testing 152.0.7977.64 (`--test-concurrency=1`, um Chrome por vez); pypdf 6.x (`/Users/andrebadini/.cache/codex-runtimes/.../python3`) |
| Independência | Nenhum documento do autor foi aceito como prova. Toda afirmação numérica abaixo tem comando e saída bruta próprios. O clone não foi modificado (relatório e scratch fora dele); `/Volumes/SSD1/acessibilidade-digital` e `.worktrees/audita-mt` não foram tocados. |
| Raízes de medição | bytes empacotados: `/private/tmp/audita-review-137-scratch/pkg` (zip 1.1.37 extraído + `git archive HEAD test scripts package.json fixtures`); gerações anteriores materializadas por `git archive <rev> src package.json` |

### Equivalência bytes empacotados ↔ fonte (pré-requisito de método)

```
$ cd /private/tmp/audita-review-137 && git archive HEAD src manifest.json assets vendor | tar -x -C .../gitref
$ diff -r -x icon-1024.png -x icon-source.svg .../gitref .../pkg    # 0 diferenças
$ (cd pkg && find src -type f | sort | xargs shasum -a 256 | shasum -a 256)
a32c8088f3a3a1df563dcd821834abb37c43f578eb1050aff49b7421e2cd5d12
$ (cd gitref && find src -type f | sort | xargs shasum -a 256 | shasum -a 256)
a32c8088f3a3a1df563dcd821834abb37c43f578eb1050aff49b7421e2cd5d12
```
O zip traz 199 arquivos; a árvore do commit traz 201 (só `assets/icons/icon-1024.png` e `icon-source.svg`, ativos de loja, ficam de fora). **O `src/` do pacote é byte a byte o `src/` do commit** — por isso medição em Node do `src/` vale como medição do entregável, e a sonda final foi feita no Chrome sobre a raiz extraída.

---

## Correção de premissa do briefing (medida, e é armadilha para a próxima revisão)

O briefing manda restaurar `src/` de **`d03d4bd^` como "1.1.36"**. Não é:

```
$ git show d03d4bd^:manifest.json | grep version      → "version": "1.1.37"
$ git log -1 --oneline d03d4bd^                        → 548025f fix: 1.1.37 — identificador com lista fechada…
$ diff -q gen/136d03/src/core/privacy.js gen/137/src/core/privacy.js   → (idênticos)
```
`d03d4bd^` = `548025f`, o **segundo lote de correções da 1.1.37**, e o `privacy.js` dele é **idêntico ao do HEAD**. Mutar contra `d03d4bd^` compara a geração consigo mesma. A 1.1.36 verdadeira é **`1ffef6c`** (`= 9635afb^`). Medido nas duas leituras (`logs/mutations.log`):

| mutação | 1.1.36 verdadeira (`1ffef6c`) | `d03d4bd^` (`548025f`) |
|---|---|---|
| E2E de formas de credencial | 19/23 passam, **4 falham** | **23/23 passam** |
| métrica da classe | 4/6 passam, **2 falham** | **6/6 passam** |

Confirmados como declarados: `55db44b` = 1.1.35 e `06e70fc` = 1.1.33.

---

## Tabela de conferência (alegação | comando | resultado | veredito)

| # | Alegação do autor | Comando (resumo) | Resultado medido | Veredito |
|---|---|---|---|---|
| 1 | SHA-256 do pacote 1.1.37 = `b6a1a8c0…44de` | `shasum -a 256 release/…1.1.37.zip` | idêntico | **CONFIRMADO** |
| 2 | 146 itens ABNT (96 requisitos + 50 recomendações) | `import NBR17225_ITEMS` (146 itens, 146 números únicos) | 146 = 96+50 | **CONFIRMADO** |
| 3 | Fase paralela 1.1.37: 4.210 testes, **4.207 passam**, 1 pulado, **2 falham** | `node run-parallel-phase.mjs` (plano do próprio autor, 180 arquivos) | **4.210 / 4.209 / 0 / 1, EXIT=0** | **REFUTADO** (2 falhas a menos) |
| 4 | Fase serial: **86 testes, 77 passam, 9 falham** (7 em `sidepanel-flow`, 1 axe, 1 forma de credencial) | `node --test --test-concurrency=1` sobre os 37 arquivos de `REAL_CHROME_E2E` | **86 / 78 / 7** (6 `sidepanel-flow`, 1 axe, 0 credencial) | **PARCIAL** (total e estrutura certos; 2 casos de folga) |
| 5 | Dentes do E2E: as 6 formas novas reprovam **4 de 6** contra a 1.1.36 e **2 de 6** contra a 1.1.35 | `mut-136true` / `mut-135`: `credential-shapes-mv3` | 1.1.36: falham `letters-only`, `passphrase`, `middle-stem`, `three-parts` = **4 de 6**; 1.1.35: falham `underscore`, `dot` = **2 de 6** | **CONFIRMADO** |
| 6 | Métrica da classe: 92 formas, 395 combinações, 0 vazamentos | `node --test test/core/credential-class-metric.test.js` | `formas=92 combinações=395`, 6/6 verde, 0 vazamentos | **CONFIRMADO como declarado / REFUTADO como prova** (ver I2) |
| 7 | Preço do dicionário: **566 / 101 / 566** | `^[a-z]{3,}$`+lower+único = 234.289 palavras; `isSensitiveKeyName` / `isSensitiveValue` / `SENSITIVE_KEY` por geração | **1.1.36 = 566 / 101 / 566** (exato); **1.1.37 = 33 / 101 / 576** | **CONFIRMADO para a 1.1.36 / NÃO RE-MEDIDO para a 1.1.37** |
| 8 | Envelope declarado: `pintura.png`, `/img/pintura.png`, `pincel`, `pincel.png`, `secretaria-saude`, `hairpin`, `Chaveiro: A1B2C3`, `shipping`, `autocomplete="shipping street-address"`, `tokenizador` | varredura própria nas 5 gerações | todos preservados na 1.1.37; `pintura.png` e `secretaria-saude` eram destruídos na 1.1.36 | **CONFIRMADO** |
| 9 | `sessionid`, `senha_forte`, `data-senhaforte`, `novasenha`, `userpin` seguem tarjados como chave | idem | todos tarjados de 1.1.35 em diante | **CONFIRMADO** |
| 10 | Auditoria ao vivo (Google, sem pixels): 0 falhas confirmadas, 1 alerta/recomendação, 2 suspeitas, 9 positivos, 109 checklist, cobertura 28,5% (denominador 130), índice 9,0/10, PDF 17 páginas | 2 execuções próprias nos bytes empacotados (`review137-live`, `review137-live2`) | 146 `itemResults`, desfechos 109/27/1/9; **1 falha é recomendação** ("Cabeçalho principal") → "0 falhas confirmadas" coerente; 9 positivos; cobertura **37/130 = 28,46% → 28,5%** com fórmula no artefato; índice **9,0 / 10**; PDF **18 páginas** | **CONFIRMADO** (só o nº de páginas e o de suspeitas diferem por conteúdo) |
| 11 | 146/146 ids e títulos no HTML **e no PDF** | HTML: 146 `<th scope="row">`, 146 números únicos, 0 vazios, 4 colunas/linha; PDF: 0 dos 146 números ausentes | 146/146 nos dois | **CONFIRMADO** |
| 12 | Notas editoriais 5/5 no HTML e no PDF | seção "Notas de integridade normativa" → 5 `<li>`; texto extraído do PDF contém as 5 | 5/5 nos dois | **CONFIRMADO** |
| 13 | 0 palavras partidas | contagem intacta vs. texto sem quebras: `Recomendação` 53/53, `Requisito` 98/98, `humana` 120/120, `aplicável` 34/34 | sem quebra nos alvos medidos | **CONFIRMADO** (para os alvos do defeito histórico) |
| 14 | 0 `[redacted]` no HTML e no JSON | `grep -c '\[redacted\]'` nos artefatos | Google: **0**; página de formulário: **3**, todos `data:[redacted]` de URL de mídia (por desenho, `privacy.js:547`) | **PARCIAL** (o 0 é dependente da página, não propriedade do produto) |
| 15 | 0 "Inconformidade ao item" e 111 "Verificar o item" | HTML: 0 e **112**; página com 4 falhas injetadas: 4 e 114; o PDF não imprime o checklist (declarado no próprio PDF) | coerente | **CONFIRMADO** |
| 16 | Limitação declarada: o CSV **não** traz a versão da extensão | `grep -c '1.1.37' live.csv` → 0; `csv_schema_version` e `source_version` (motor axe) presentes; versão em HTML e JSON | 0 no CSV, 1 no HTML, 1 no JSON | **CONFIRMADO** |
| 17 | Gate de release GREEN | `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` | exit 0, mensagem GREEN | **CONFIRMADO** |
| 18 | Relatório da 1.1.36 arquivado em `docs/qa/revisoes/REVIEW-1.1.36.md` | `git cat-file -e HEAD:docs/qa/revisoes/REVIEW-1.1.36.md` | `fatal: path … does not exist`; nenhum commit o adicionou | **REFUTADO** |
| 19 | Custo do tarjador | benchmark intercalado, 7 rodadas, mediana, 19.178 linhas de prosa real | 1.1.37 = **1,71× a 1.1.35** e **1,97× a 1.1.36** | **NÃO DECLARADO** (achado I5) |

---

## Achados

### CRITICAL

#### C1 — Regressão de 1.1.37: rótulo com caixa misturada dentro do radical devolve a credencial ao entregável

`SeNhA: <valor>`, `SeNhAfOrTe: <valor>` e `SeNhA do usuário: <valor>` são **tarjados nas 1.1.33, 1.1.35 e 1.1.36** e **vazam na 1.1.37**. É regressão da geração, não resíduo herdado.

Medição ponta a ponta nos **bytes empacotados**, uma forma por página, com **controle positivo na mesma página** (`review137-confirm`, 18 formas; `logs/confirm-137.log`):

```
$ node --test --test-concurrency=1 test/e2e/review137-confirm.test.mjs     # pkg = zip 1.1.37 extraído
RESULTADO forma="mixed-case-abc123" superficies=6
  vazou=[relatório|modelo|artefato html|artefato json]  nc=[]  pc_intacto=[]
JANELA modelo: … "visibleText":"Sonda adversarial SeNhA: abc123 senha: [redacted]" …
JANELA artefato html: … &lt;div id=&quot;alvo&quot;&gt;&lt;p&gt;SeNhA: abc123&lt;/p&gt;&lt;/div&gt;
                       &lt;div id=&quot;pc&quot;&gt;&lt;p&gt;senha: [redacted]&lt;/p&gt;&lt;/div&gt; …
```

A prova de não vacuidade está **dentro da mesma string entregue**: o controle positivo `senha: PC137CTRL9Z7` virou `senha: [redacted]` no mesmo `visibleText` em que `SeNhA: abc123` sobreviveu. Não é página não medida, não é tarja em bloco, não é mascaramento por trecho.

Atribuição por geração (`attack/crossgen.mjs`, `redactedText`/`sanitizeJsonData` de cada geração materializada por `git archive`):

| forma | 1.1.33 | 1.1.35 | 1.1.36 | 1.1.37 |
|---|---|---|---|---|
| `SeNhA: abc123` | ok | ok | ok | **VAZA** |
| `SeNhAfOrTe: abc123` | ok | ok | ok | **VAZA** |
| `SeNhA do usuário: abc123` | ok | ok | ok | **VAZA** |
| `SeNhA: passarinho` | ok | ok | VAZA | **VAZA** |

Mecanismo medido: `isWholeCredentialLabel('SeNhA')` é `false` (a marca de camelCase parte `Se\u0001Nh\u0001A` e o predicado ancorado não reconhece o radical com caixa trocada), então a decisão cai em `shapesValue` → `identifierValue(valor)`, que exige 12+ caracteres, 4+ dígitos ou 8+ com dígito/símbolo. `abc123` (6 caracteres, 3 dígitos) não passa. Na 1.1.36 o portão largo (6+ com dígito/símbolo) cobria esse caso; **estreitar o portão para fechar o C1 da 1.1.36 abriu este**. Impacto: senha de uma página de troca de senha chega ao relatório, ao modelo guardado e aos artefatos HTML/JSON entregues.

#### C2 — O portão de valor deixa vazar senhas curtas e senhas só de letras de 8 a 11 caracteres por rótulos concatenados

O preço declarado é **apenas** `novasenha: abc123`. O conjunto medido é bem maior, e inclui rótulos que são exatamente os de um formulário de troca de senha.

```
RESULTADO forma="novasenha-letters8"  vazou=[relatório|modelo|artefato html|artefato json]
JANELA modelo: "visibleText":"Sonda adversarial novasenha: flamingo senha: [redacted] Fatura: R$ 30,00"
RESULTADO forma="novasenha-letters10" vazou=[relatório|modelo|artefato html|artefato json]
JANELA modelo: "visibleText":"Sonda adversarial novasenha: passarinho senha: [redacted] Fatura: R$ 30,00"
RESULTADO forma="mid-stem-abc123"     vazou=[relatório|modelo|artefato html|artefato json]
RESULTADO forma="three-parts-abc123"  vazou=[relatório|modelo|artefato html|artefato json]
RESULTADO forma="short-prefix-abc123" vazou=[relatório|modelo|artefato html|artefato json]
RESULTADO forma="markup-letters8"     vazou=[relatório|modelo|artefato html|artefato json]
```

Formas que chegam ao entregável na 1.1.37 (sentinela real, medida nos bytes empacotados):

| forma | sentinela | vazou para | gerações anteriores |
|---|---|---|---|
| `novasenha: abc123` | senha curta com 3 dígitos | relatório, modelo, HTML, JSON | 1.1.36 tarjava (**declarado como preço**) |
| `novasenha: flamingo` | 8 letras | idem | 1.1.35 e 1.1.36 vazavam; **1.1.33 tarjava** |
| `novasenha: passarinho` | 10 letras | idem | idem |
| `novasenha: borboletass` | 11 letras | idem | idem |
| `minhasenhaforte: abc123` / `: passarinho` | radical no meio | idem | 1.1.33 e 1.1.35 tarjavam |
| `novasenhaadmin: abc123` | três partes | idem | 1.1.33 e 1.1.35 tarjavam |
| `xsenhaforte: abc123` | prefixo desconhecido | idem | 1.1.33 e 1.1.35 tarjavam |
| `xsenha: abc123` | prefixo curto | idem | 1.1.36 tarjava |
| `redefinirsenha: flamingo` / `trocarsenha: flamingo` | concatenado realista | idem | 1.1.33 tarjava |
| `<b>sen</b>ha: flamingo` | marcação no meio do radical + 8 letras | idem (caminho do trecho) | 1.1.35 e 1.1.36 tarjavam |
| `contraseña: abc123`, `parola d'ordine: abc123` | outro idioma | idem | **vaza nas 4 gerações** (pré-existente) |

A leitura correta é: o autor trocou um portão largo (que gerava falso positivo) por um portão estreito, e **o preço real da troca não é o que está declarado** — é "toda senha de 5 a 11 letras sem dígito, e todo valor de até 7 caracteres com até 3 dígitos, quando o rótulo é uma concatenação". `abc123` e `passarinho` são as duas senhas fracas mais comuns de um formulário real. O `README.md` declara só o caso `novasenha: abc123`; `minhasenhaforte`, `novasenhaadmin`, `xsenhaforte`, `xsenha`, `redefinirsenha`, `trocarsenha` e a caixa misturada do C1 **não estão declarados em lugar nenhum**.

### IMPORTANT

#### I1 — Falsos positivos regressivos destroem prosa portuguesa legítima

Corpus independente de 259 itens (`false-positives/FINDINGS.md`), verificado por mim (`attack/fp-verify.mjs`):

| frase | 1.1.33 | 1.1.35 | 1.1.36 | 1.1.37 |
|---|---|---|---|---|
| `A loja vende chaveiros personalizados.` | TARJA | ok | ok | **`A loja vende [redacted]`** |
| `O pincel profissional sai por R$ 45,90.` | ok | ok | ok | **`O [redacted]`** |
| `O secretariado reuniu-se com o prefeito.` | TARJA | ok | TARJA | **`O [redacted]`** |
| `O CEP da secretaria é 70040-010.` | TARJA | ok | TARJA | **`O CEP da [redacted]`** |

Duas são regressões contra **todas** as gerações anteriores (`pincel profissional`), duas contra a 1.1.35. Causa raiz medida por pares mínimos: o gatilho é o **token seguinte**, não a palavra da língua — `chaveiros hoje` passa, `chaveiros personalizados` cai (12 caracteres); `pincel azul` passa, `pincel profissional` cai; `meia entrada` passa, `meia-entrada` cai (hífen). O estreitamento por listas fechadas da 1.1.37 foi aplicado a `SENSITIVE_KEY_NAME` (chave/atributo/seletor) mas **não** ao scanner de prosa, que mantém o vocabulário permissivo e o portão de valor largo; depois do sinal, `redactSpacedLabelTail` (`src/core/privacy.js:683-696`) tarja a linha inteira. Destruição total: 1.1.37 = 7/259 (2,7%), 1.1.36 = 12/259, 1.1.35 = 4/259, 1.1.33 = 8/259 — a 1.1.37 é melhor que a 1.1.36 no total, e **pior que a 1.1.35** em prosa.

#### I2 — A métrica da classe é cega para a própria classe: o "0 vazamentos em 395 combinações" é artefato do formato do sentinela

O sentinela é `const S = (n) => \`ADVSEN${n}X\`` — **sempre com dígitos**. Para `identifierValue`, 9 caracteres com dígito satisfazem o portão: nenhuma das 395 combinações exercita valor fraco. Mutação minha, mudando **só o gerador de sentinela** para 11 letras (mesmas 92 formas, mesmas 395 combinações, mesmos caminhos):

```
$ cp test/core/credential-class-metric.test.js review137-metric-letters.test.mjs
  # S(n) → `Zqwkvbr${aa}${bb}tn` (11 letras, sem dígito) e as 3 regexes de extração
$ node --test test/core/review137-metric-letters.test.mjs
✖ nenhuma forma de credencial sobrevive em nenhum dos quatro caminhos
  AssertionError: a credencial sobreviveu em:
    A9 rótulo em nó + espaço + valor (trecho|json|json2),
    senha com traço (…), caixa misturada no radical (…), caixa misturada com prefixo (…),
    novasenhaadmin (…), chaveacessouser (…), dados do cartão (…), cartão pela cauda (…), CVV (…)
ℹ formas=92 combinações=395    ℹ tests 6  ℹ pass 4  ℹ fail 2
```

A métrica do próprio autor **contém** a forma `['caixa misturada no radical', '<p>SeNhA: ${S('120')}</p>']` (`test/core/credential-class-metric.test.js:104`) — a mesma que medi vazando nos bytes empacotados. Ela passa porque o sentinela tem dígito. O instrumento que o autor apresenta como prova de que a classe está fechada não mede a classe; e o E2E de formas, ampliado nesta geração, usa `ADVSHAPE…7X` e `Zqwkvbrtnmx…` (12+ caracteres), tampouco cobrindo o portão.

#### I3 — O preço do dicionário não foi remedido para a 1.1.37

O `README` declara **566 / 101 / 566** (linhas 52-53), mas isso está no parágrafo da **1.1.36** e reproduz **exatamente** para ela:

```
$ node dict3.mjs     # dicionário normalizado: 234.289 palavras (^[a-z]{3,}$, lower, único)
predicado                            1.1.33  1.1.35  1.1.36  1.1.37
isSensitiveKeyName                        0    1567     566      33
isSensitiveValue                          0       0     101     101
SENSITIVE_KEY.test(camelMarks)            0      17     566     576
```
Para o artefato corrente (1.1.37) os números são **33 / 101 / 576**: o caminho de chave caiu 17× (efeito das listas fechadas, não declarado) e a prosa **subiu 10 palavras** (`antidumping`, `appropinquate`, `appropinquation`, `appropinquity`, `cardsharping`, `chipping`, `myosalpingitis`, `myotalpinae`, `supersecretion`, `superspinous`). A rodada 79 não remediu o preço depois de trocar o vocabulário; quem ler "566" como estado corrente erra por 17× num lado e 10 palavras no outro.

#### I4 — A fase paralela declarada não reproduz

Alegação (rodada 79): "4.210 testes, 4.207 passam, 1 pulado e as duas falhas eram o `release-package`". Medição no clone congelado, plano do próprio autor, 180 arquivos:

```
$ node run-parallel-phase.mjs      # fullclone = cópia do clone (com .git e release/)
parallel files: 180  serial files: 37  total: 217
ℹ tests 4210  ℹ pass 4209  ℹ fail 0  ℹ skipped 1  ℹ cancelled 0
PARALLEL_EXIT=0
```
**Zero falhas.** O `release/audita-acessibilidade-1.1.37.zip` existe na raiz medida, então a justificativa declarada ("exige o pacote reconstruído") não se sustenta; e o número que reproduz (4.210/4.209/0/1) é o que o próprio `README:149` atribui à **1.1.33**. O efeito é conservador para o autor (ele declara 2 falhas a mais), mas é número de documento sem lastro.

#### I5 — Custo do tarjador: 1,7× a 1,71–1,97× as gerações anteriores, não declarado

Benchmark intercalado (7 rodadas, ordem rotacionada, mediana) sobre 19.178 linhas de prosa portuguesa real (os próprios `docs/` + `README`):

```
$ node cost2.mjs
1.1.33  mediana=  183.1 ms   vs 1.1.35=0.35x
1.1.35  mediana=  520.0 ms   vs 1.1.35=1.00x   vs 1.1.36=1.15x
1.1.36  mediana=  451.1 ms   vs 1.1.35=0.87x   vs 1.1.36=1.00x
1.1.37  mediana=  889.9 ms   vs 1.1.35=1.71x   vs 1.1.36=1.97x
```
Em corpus denso de radicais a 1.1.37 fica em paridade com a 1.1.35 (0,99×) e 2,0× a 1.1.36. A revisão anterior mediu a 1.1.36 como 0,71× a 1.1.35 no corpus dela; no **meu** corpus a 1.1.36 é 0,87–1,01×, ou seja o número é sensível ao corpus — mas a direção da 1.1.37 é consistente nos dois corpora e nos dois caminhos (`redactSensitiveText` e `sanitizeJsonData`): **a 1.1.37 custa ~2× a 1.1.36**. Nenhum documento da 1.1.37 declara custo. O lado privilegiado é a precisão (menos falso positivo), e o preço em tempo não está medido nem declarado.

#### I6 — Invariantes de privacidade: dois defeitos com caminho concreto

Auditoria dedicada (`privacy/FINDINGS.md`, 771/771 testes citados verdes, 28 testes de falsificação próprios, todos passando). Quatro invariantes **ENFORCED** (nonce fora de DOM/modelo/relatório/logs; autorização antes do pixel; consentimento uso único; identidade de documento provada antes de cada raster — 3 rasters geraram 4 provas, troca A→B recusada, `persisted=0` com prova de B). Dois ficam **PARCIAL**:

- **D1 `src/background/owned-tabs.js:283`** — a limpeza confia no `tabId` do journal como autoridade final, sem reatestação por `chrome.tabs.get`. Reescrevendo `tabId` num registro consistente, medi `clearAudit` fechando a aba 99 (`RAW removeTab = [99]`), isto é, o invariante "limpeza só de abas próprias" depende de o journal não ser adulterado. Pré-requisito: escrita em `chrome.storage.session` (página/worker da extensão; sem `web_accessible_resources`, CSP `script-src 'self'`) — não é escalada de página web, é escalada dentro da extensão.
- **D2 `src/background/service-worker.js:641,652` + `src/background/authorized-audit-starter.js:2103,2343,2095`** — o commit terminal aceita `attemptHandle` nulo e persiste pixels sem `pixelAttemptCommit`; a trilha inicial cria `attemptHandle`/`consentId` nulos. Capturas ficam guardadas **sem correlação durável**, que é justamente o que o invariante 4 ("captura B nunca atribuída a A") promete por construção.

Residual declarado pelo próprio auditor: janela TOCTOU entre a prova de identidade (`pixel-privacy-gate.js:508`) e `Page.captureScreenshot` (`capture-evidence.js:46`) — o pixel do documento errado existe em memória; o que impede o relatório é a prova final antes de persistir, não a atomicidade.

#### I7 — Proveniência: o relatório citado não existe e as contagens do veredito da 1.1.36 se contradizem

```
$ git cat-file -e HEAD:docs/qa/revisoes/REVIEW-1.1.36.md
fatal: path 'docs/qa/revisoes/REVIEW-1.1.36.md' does not exist in 'HEAD'
```
O `README` cita esse relatório e a revisão da 1.1.36 como fontes dos números 60/60, 45/60, 17/17 e "8 das 10 formas"; o commit `d03d4bd` afirma "Arquiva a revisão da 1.1.36 no registro" com `--stat` de 5 `.md` modificados e **0 arquivos novos**. Além disso as contagens são incompatíveis entre si: `README:7`, `README:28`, `estado:12` e a mensagem do commit dizem **2 Critical, 4 Important, 5 Minor, 8 observações**; `LEIA-ME:26` e o cabeçalho da seção no próprio registro dizem **2 Critical, 3 Important, 4 Minor, 6 observações**, e a tabela do registro enumera exatamente C1, C2, I1, I2, I3, M1-M4, O1-O6 = 2/3/4/6. Os números do veredito da geração que esta revisão conserta são, portanto, de segunda mão em pelo menos um dos conjuntos.

### MINOR

- **M1** — Contagem de combinações da métrica: `README:152` e `triage:2508` dizem **347**; `triage:2534` diz **389**; o teste imprime e calcula **395** (`formas=92 combinações=395`) e só afirma `>= 210`.
- **M2** — Contagem de falhas da fase serial: declarado "86/77/9" com "7 em `sidepanel-flow`"; medido **86/78/7** com **6** em `sidepanel-flow` e **0** formas de credencial. A estrutura (37 arquivos → 86 casos, sendo 47 `test()` estáticos + 39 gerados em laço, e o salto 80→86 exatamente pelas 6 formas novas) confere; a diferença de 2 casos é compatível com os flakes de carga que o próprio autor declara, mas os números publicados não são os que a suíte produz hoje.
- **M3** — Caminho do trecho entregue ainda destrói identificadores legítimos: 8/64 no corpus dedicado (`id="sessao-do-usuario"`, `title="Chave Pix"`, `data-pincel`, `data-tokenizador`, `data-secretaria`, `data-pintura`; `src="img/pintura.png"` só por normalização de URL relativa). É uma grande melhora sobre 24/64 na 1.1.36, mas `snippet.js:142` isenta de `isSensitiveKeyName` apenas `id`, `name` e `autocomplete`.
- **M4** — Rótulos de credencial em **espanhol** (`contraseña`) e **italiano** (`parola d'ordine`) vazam nas quatro gerações medidas. Num produto brasileiro o espanhol é fronteira plausível; o vocabulário cobre inglês, alemão, francês, dinamarquês e norueguês.
- **M5** — `Chaveiro` **nu** como chave é `false` em `isSensitiveKeyName` na 1.1.37 (era `true` na 1.1.35/1.1.36). É mudança deliberada e documentada (`privacy.js:182-195,325-329`; `credential-class-metric.test.js:213-216`), mas os documentos que descrevem o envelope como incluindo `Chaveiro` como chave valem até a 1.1.36.
- **M6** — `d03d4bd^` é apresentado como "1.1.36" no material do autor/briefing; ver a seção de correção de premissa. Um revisor que siga essa instrução mede a geração contra si mesma.

### OBSERVAÇÕES

- **O1** — "0 `[redacted]`" não é propriedade do produto, é propriedade da página: numa página de formulário sem nenhuma credencial a minha execução mediu **3** `[redacted]`, todos `data:[redacted]` de URL de mídia, o que é desenho declarado (`privacy.js:547`). Registrar como expectativa condicional, não como invariante.
- **O2** — "PDF de 17 páginas" é dependente de conteúdo e de estado da página viva: medi **18** páginas na minha execução no Google (3 suspeitas contra as 2 declaradas). O número não é verificável como propriedade do artefato.
- **O3** — A limitação do CSV é real e declarada: `OCCURRENCE_CSV_COLUMNS` tem `csv_schema_version` e `source_version` (motor axe) e **nenhuma** coluna de versão da extensão; a versão aparece no HTML, no JSON e no PDF.
- **O4** — Não existe teste com pessoa leiga. Por decisão do usuário (2026-09-16) ele **não** é portão de produção, e esta revisão não o trata como bloqueio.
- **O5** — A publicação em loja depende de autorização explícita do usuário; nada nesta revisão a autoriza.
- **O6** — Lado privilegiado de cada escolha desta geração: a 1.1.37 privilegia **precisão** (falsos positivos 7 vs 12 na 1.1.36 no corpus dedicado; trecho 8/64 vs 24/64) e paga com **recall** no portão de valor e com **~2× de custo**. Os comentários do código declaram o primeiro preço de forma explícita e específica (`privacy.js:597-604` nomeia `novasenha: abc123`); **não** declaram o conjunto real de formas afetadas (C2), nem a regressão de caixa misturada (C1), nem o custo (I5), nem a queda de 17× no preço do dicionário no caminho de chave (I3).

---

## O que eu não consegui verificar

1. **Os artefatos da auditoria ao vivo do autor** (o JSON/HTML/CSV/PDF do Google que ele mede) não estão no clone nem em caminho acessível; conferi apenas a aritmética das contagens (146 = 96+50 ✓; 133 = 9+1+95+28 ✓; 116 = 95+1+9+11 ✓) e reproduzi os invariantes estruturais numa execução minha. Os números de suspeitas/positivos/páginas do **execução dele** não são reproduzíveis porque dependem do estado da página viva.
2. **A contagem de falhas da fase serial como o autor a obteve** (7+1+1). Medi 6+1+0 com a mesma lista de arquivos e a mesma ordem serial; a diferença é compatível com flakes de carga, mas não posso provar a atribuição declarada.
3. **Reciclagem de `tabId` pelo Chrome** (o defeito D1 pressupõe que o id possa ser reusado) e o caminho real `debugger` + `Page.captureScreenshot` ponta a ponta — exigem instrumentação de navegador que não é acessível pelo harness.
4. **Recuperação após morte do worker no estado `resuming`** (`pixel-consent-expiry.js:508-530`).
5. **Se `27 inapplicable / 109 cantTell` é o estado correto do Google hoje** — não há oráculo independente para a semântica dos itens ABNT; verifiquei a consistência interna (item ↔ matriz ↔ EARL), não a verdade normativa.

---

## Veredito

# REPROVADO — 2 Critical, 7 Important, 6 Minor, 6 observações

O incremento é real e grande: o sublinhado/ponto/barra tarja o lugar certo; `conta corrente 12345-6` sobrevive; entidades, escapes, percent-encoding, invisíveis e marcação no meio do radical fecham; a prosa destruída cai de 12/259 para 7/259; o trecho entregue cai de 24/64 para 8/64 para identificadores; o preço do dicionário no caminho de chave cai 17×; a fase paralela está verde (4.210/4.209/0); a fase serial tem exatamente os 86 casos declarados; a matriz de 146 itens, as notas 5/5, a cobertura 37/130 = 28,5% com fórmula e denominador, o índice 9,0/10, os ids e títulos no HTML e no PDF e a limitação do CSV todos reproduzem — e o E2E de credencial **finalmente tem dentes** contra as duas gerações anteriores (4 de 6 e 2 de 6, confirmado por mutação).

Mesmo assim o portão não passa, porque **a classe que reprovou as quatro revisões anteriores continua aberta, e desta vez com uma regressão nova e não declarada**:

- `SeNhA: abc123`, `SeNhAfOrTe: abc123` e `SeNhA do usuário: abc123` são tarjados nas 1.1.33, 1.1.35 **e** 1.1.36 e chegam ao relatório, ao modelo guardado e aos artefatos HTML e JSON na 1.1.37 (C1), com o controle positivo tarjado na **mesma string entregue**.
- `novasenha:`/`minhasenhaforte:`/`novasenhaadmin:`/`xsenha:`/`xsenhaforte:`/`redefinirsenha:`/`trocarsenha:` devolvem senhas de 8 a 11 letras e valores como `abc123` ao entregável, muito além do único caso declarado (C2).
- A métrica que o autor apresenta como prova de "0 vazamentos em 395 combinações" é cega por construção do sentinela: trocando só o sentinela por 11 letras, a **própria** métrica do autor reprova com 26 vazamentos, incluindo a forma que ele batizou `caixa misturada no radical` (I2).

Somam-se falsos positivos regressivos que destroem prosa portuguesa real (I1), o preço do dicionário não remedido para o artefato corrente (I3), a fase paralela declarada que não reproduz (I4), ~2× de custo não declarado (I5), dois invariantes de privacidade parciais com caminho concreto (I6) e um relatório de revisão citado que nunca existiu, com contagens de veredito contraditórias (I7).

O caminho de conserto é conhecido e estreito: o portão de valor precisa de um critério que cubra valor fraco **quando o rótulo é reconhecido como rótulo** (concatenado ou com caixa misturada), e não de um limiar de comprimento; e o predicado `isWholeCredentialLabel` precisa incluir o composto que o vocabulário de chave já conhece (`novasenha`), senão a assimetria entre "chave" e "rótulo" recria esta classe a cada geração. Sem isso, o E2E e a métrica continuarão verdes com o código antigo no eixo que importa.

**Contagem final: 2 Critical, 7 Important, 6 Minor, 6 observações. Veredito: REPROVADO.**
