# Revisão adversarial independente — Audita Acessibilidade 1.1.24

Delta sob revisão: **`a278859..bb7ace1`** (1.1.23 nunca revisada isoladamente + 1.1.24 = N1–N7 do
veredito da 1.1.22). Checkout congelado `/private/tmp/audita-review-124`, HEAD `bb7ace1`.
Artefato: `release/audita-acessibilidade-1.1.24.zip`. Scratch do revisor: `/private/tmp/adv124`.
Ambiente: Chrome for Testing 152.0.7977.64 em
`/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
um workload de Chrome por vez, perfil temporário isolado, `--password-store=basic --use-mock-keychain`,
`downloadMode: 'profile'`.

**Bytes medidos, não a árvore:** todas as medições de produto abaixo importam/servem o pacote
extraído em `/private/tmp/adv124/pkg124` (zip da entrega + cópia de `test/` e `fixtures/` para dentro
da raiz extraída). O checkout congelado não foi modificado: `git status --porcelain` continua
`?? node_modules` (ver achado **A3**) e o `release/` continua com os mesmos 17 zips.

---

## 1. Veredito

**A 1.1.24 pode substituir a 1.1.22 como candidata. 0 Critical, 0 Important, 4 Minor + 2 observações.
Nada é bloqueante.**

Os dois incrementos do delta fazem o que alegam, com uma exceção real e uma formal:

| Bloco | Resultado |
|---|---|
| 1.1.23 — vocabulário sensível em português (URL, chaves JSON, `frameId`, ids/rótulos) | **REPRODUZIDO** (URL do exemplo: `senha`, `cpf` e `chaveAcesso` saem; `id`, `contato`, `pixelRatio`, `cargo` ficam; nenhuma chave das 196 do JSON real entregue passou a ser tarjada) |
| 1.1.23 — fim do `passed`/`passes`/`bypass`/`passive` tarjados | **REPRODUZIDO** (as quatro preservadas; `password`, `passwd`, `pass`, `userPassword`, `passcode`, `passphrase` seguem tarjados) — mas **abriu um buraco estreito**: `bypasscode`, `bypass_code`, `bypasswd`, `bypass_key`, `bypassword` agora escapam (**A2**) |
| 1.1.23 — `listedLimitations` não falha mais aberto | **REPRODUZIDO** (`TypeError` para `undefined`/`null`/`'texto'`/`{}`/`7`; dedup correta; inalcançável nos dois consumidores de produto, logo sem regressão) |
| 1.1.24 — N1 cláusula e lista da mesma fonte | **REPRODUZIDO** (sonda in-process: `[]`; auditoria real: `PAGE_ONLY=[]`, cláusulas idênticas às da lógica antiga, nenhuma cláusula perdida) |
| 1.1.24 — N2 Ctrl+P da aba não parte palavra | **REPRODUZIDO**, com não vacuidade provada por mutação: removida a regra, o E2E **falha** e a matriz da aba mede **198** palavras partidas e **2** no cabeçalho — os números exatos da alegação |
| 1.1.24 — N3 oráculo de largura derivado do `@page` | **PARCIAL**: o oráculo deriva do `@page` (código, diagnóstico `@page=680px` e mutantes honestos) e o oráculo antigo era cego, mas uma margem de 15 → 40 mm **não** falha — só falha quando a caixa derivada cai abaixo do mínimo da matriz (~399 px) |
| 1.1.24 — N4 cinco frases de documentação | **REPRODUZIDO** (5/5 corrigidas e conferidas; `cdaf425` não é ancestral de `a278859`, então a revisão da 1.1.22 tinha razão ao ler 4.180 no commit congelado) — mas sobra **outra** frase que a medição não sustenta (**A4**) e um número irreproduzível (**A5**) |
| 1.1.24 — N5/N6/N7 | **PARCIAL**: N5 e N6 **REPRODUZIDOS** (o `word-break:normal` saiu das duas regras; hash do CSP bate com o `<style>` entregue; nenhum import morto); **N7 não está corrigido na prática** (**A3**) |
| Portões declarados (item 9) | **REPRODUZIDO**, incluindo a auditoria real do Google **refeita por mim** nos bytes empacotados (0 falhas, 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações completas) |

Severidade dos novos: **A1** (privacidade, valor do dado em português não é tarjado — pré-existente,
fora do delta), **A2** (privacidade, buraco aberto pelo novo lookbehind), **A3** (`.gitignore` só
formal), **A4** (README contradiz o próprio delta), **A5** (número `236/236` não reproduzível),
**A6** (flakiness sob carga pré-existente + cobertura/PARCIAL do N3). Nenhum é bloqueante.

---

## 2. Artefato

| Verificação | Comando | Resultado |
|---|---|---|
| Digest | `shasum -a 256 release/audita-acessibilidade-1.1.24.zip` | `978fa19e21de87111ef42f8047d877783776cf1e3aa3ba147216469056665c01` — **confere** |
| Entradas | `unzip -Z1 … \| wc -l` | **199** arquivos (mesmo número da 1.1.22) |
| Lista de arquivos | `diff <(unzip -Z1 1.1.22.zip) <(unzip -Z1 1.1.24.zip)` e idem contra a 1.1.23 | **listas idênticas** nas três versões (nenhum arquivo entrou ou saiu) |
| Pacote → árvore | `cmp` entrada a entrada das 199 | **199/199 idênticas, 0 divergências** |
| Árvore → pacote | conjunto de runtime (`manifest.json` + `src/**` + `vendor/**` + os 4 ícones) vs entradas do zip | **conjuntos iguais**; só ficam de fora, como esperado, `assets/icons/icon-1024.png` e `icon-source.svg` |
| Manifesto interno | `cat pkg124/manifest.json` + `cmp` com a árvore | MV3, `version`/`version_name` **1.1.24**, CSP `script-src 'self'`, sem código remoto; **byte a byte igual à árvore** |
| Reconstrução | `node scripts/build-release.mjs --temporary-release-directory $TMPDIR/audita-release-test-rb124a` | SHA-256 `978fa19e…665c01` e `cmp` → **byte a byte idêntico ao entregue** (build determinístico, nada escrito no checkout) |
| `release-package` + `extension-shell` | `node --test test/release-package.test.js test/extension-shell.test.js` | **12/12 passam**, com o digest `978fa19e…` fixado no teste |

O `release-package` reconstrói em diretório temporário isolado e compara com o arquivo entregue;
o `extension-shell` fixa `1.1.24` no manifesto. O E2E de proveniência lê, no relatório de uma
auditoria real, `Versão da extensão que realizou a auditoria: 1.1.24.`

---

## 3. Item por item

### 3.1 Item 1 — vocabulário sensível em português, fronteira deliberada: **REPRODUZIDO**

Comando (bytes empacotados): `node /private/tmp/adv124/probe-privacy.mjs <JSON real entregue>` e
`node /private/tmp/adv124/probe-four-usages.mjs`.

- Exemplo do enunciado, medido: `sanitizeEvidenceUrl('https://exemplo.test/p?senha=s3gredo&cpf=12345678900&chaveAcesso=k&id=7&contato=ok')`
  → `https://exemplo.test/p?id=7&contato=ok`. `sanitizeJsonData({senha,cpf,chaveAcesso,id,contato,pixelRatio,cargo})`
  → `{"senha":"[redacted]","cpf":"[redacted]","chaveAcesso":"[redacted]","id":1,"contato":"ok","pixelRatio":2,"cargo":"x"}`.
- **Os quatro usos** (URL, chave de JSON, `frameId`, `safeIdRefs`/`role`/`aria-label`), com raiz
  `contenteditable` para exercitar `contentEditableRootAttributes`: `senha`, `cpf`, `cnpj`,
  `chaveAcesso`, `cartao`, `segredo`, `credencial`, `sessao`, `autenticacao`, `autorizacao` são
  removidos/tarjados/nulados nos quatro (`frameId` vira `null`, `id`/`aria-labelledby`/`role`/
  `aria-label` somem). `contato`, `pixelRatio`, `cargo`, `id`, `main` **passam intactos nos quatro**.
  (`role` rejeita `pixelRatio` por forma — camelCase não é token de role —, não por sensibilidade.)
- **Nenhum dado legítimo do produto passou a ser tarjado:** varredura das **196 chaves distintas** do
  JSON real entregue da auditoria empacotada do Google — `newlyRedacted: []`; `newlyKept: ["passes"]`
  (a correção do item 2). A única chave que casa o vocabulário é `session`, que já casava o antigo.
- **Fronteira confirmada por baixo:** o corpus também mostra que `passage`, `passenger`, `passagens` e
  `compass` continuam tarjados (o lookahead só exclui `es|ed|ive|o|ing`) — sobre-redação residual,
  inofensiva, mas convém saber que existe.

**Ressalva medida (novo achado A1):** a expansão cobre **chaves**; o tarjador de **valores**
(`redactSensitiveText`) continua só em inglês. Medido: `sanitizeJsonData({texto:'senha: S3GR3D0'})`
devolve `senha: S3GR3D0`; `{texto:'password: S3GR3D0'}` devolve `password: [redacted]`; `cpf=12345678900`
e `chave de acesso: ABC-123` também passam.

### 3.2 Item 2 — o radical de senha não engole mais o produto: **REPRODUZIDO** (com buraco novo)

- As quatro preservadas, medidas nas duas pontas: `sanitizeJsonData({passed,passes,bypass,passive})`
  mantém as quatro; `password`, `passwd`, `pass`, `userPassword`, `passcode`, `passphrase` seguem
  `[redacted]`; `userPassword` continua tarjado porque o `password` interno casa em posição própria.
- No JSON real entregue, a chave `audit.axe.technicalSummary.passes` existe e vale
  `{"groups":16,"nodes":126}` — não é mais tarjada (`newlyKept`).
- **Buraco aberto (A2, novo):** o lookbehind é avaliado na posição do `pass`; quando a **única**
  ocorrência de `pass` está precedida de `by`, a chave escapa inteira. Medido (regex + `sanitizeJsonData`
  + `sanitizeEvidenceUrl`): `bypasscode`, `bypass_code`, `bypasswd`, `bypass_wd`, `bypassphrase`,
  `bypasskey`, `bypass_key`, `bypassword` → **não tarjados e não removidos da URL**. `bypasscode`
  **era tarjado antes do delta** (o regex antigo casava o `pass` interno de `bypass`). Ainda cobertos:
  `bypassToken`, `bypass_password`, `by-password`.

### 3.3 Item 3 — `listedLimitations` não falha mais aberto: **REPRODUZIDO**

- `node --test test/report/diagnostic-policy.test.js` → **3/3**, incluindo
  `listedLimitations([codificado, frase, 'Frase simples.']) === [codificado, 'Frase simples.']`,
  `listedLimitations([frase]) === [frase]` e `TypeError` para `undefined, null, 'texto', {}, 7`.
- Os dois consumidores de produto (`src/core/report/html.js:282` e `src/review/report-view.js:1010`)
  recebem `view.executive.limitations`, que `projectExecutive` monta sempre como lista → o `throw` é
  inalcançável no produto: falha alto sem regressão. Semântica de dedup preservada (a forma codificada
  fica, a frase simples repetida sai).

### 3.4 Item 4 (N1) — cláusula e lista da mesma fonte: **REPRODUZIDO**

Comando: `node /private/tmp/adv124/probe-n1b.mjs <JSON real entregue>`, mais leitura dos três caminhos.

- Sonda sintética do achado: `projectLimitationClauses({session:{diagnostics:[]},pages:[{diagnostics:[{code:'PIXEL_CAPTURE_OMITTED'}]}]})`
  → `[]` (antes: `['Modo sem imagens: nenhuma captura raster.']`). A inconsistência desapareceu: sem
  código na sessão, não há cláusula **nem** entrada na lista.
- **Nenhuma cláusula perdida em caminho de produto.** Estrutural: `audit-model.js:428` grava
  `pages[0].diagnostics = session.diagnostics` (mesma referência, fluxo de página única);
  `aggregate-audits.js:141` achata `session.diagnostics = [...diagnostics, ...pageDiagnostics]` (lote);
  `remap-audit.js:117` copia `page.diagnostics ?? session.diagnostics` (remap). Logo `pages[].diagnostics ⊆ session.diagnostics`
  em todos os caminhos, e a união e a sessão são o mesmo conjunto.
- Empírico na auditoria real (1.1.24, modo sem imagens): `SESSION_CODES = PAGE_DIAG_CODES =
  [PIXEL_CAPTURE_OMITTED, BROWSER_VERSION_UNAVAILABLE, DYNAMIC_PROBES_OMITTED_PASSIVE]`,
  `PAGE_ONLY = []`; cláusulas pela lógica nova = cláusulas pela lógica antiga = as duas esperadas;
  `projectExecutive` produz 8 limitações com 3 entradas codificadas, exatamente os 3 códigos.
  `deriveSystemLimitations` também só lê `session.diagnostics`, então a lista e a cláusula têm a
  mesma origem de fato.

### 3.5 Item 5 (N2) — Ctrl+P da aba não parte palavra: **REPRODUZIDO**, com não vacuidade provada

- A regra está **dentro** do bloco `@media print` da `review.css` (linha 120 abre, 126 recebe a
  regra), ao lado das regras de impressão já existentes — não afeta o ecrã.
- E2E nos bytes empacotados: `6/6` verdes; diagnóstico do `report-print-breaks`:
  `matriz=0 quebras, cabeçalhos=0, anexo=3 (tokens longos quebram de propósito), documento=9;
  tabela=678px em 680px (@page=680px); forçado com regra=0; forçado sem regra=50; cabeçalho
  comprimido=1; aba=0/0`.
- **Mutação (não vacuidade):** removida a linha ` .matrix-scroll td, .matrix-scroll th, thead th { overflow-wrap: normal; }`
  da `review.css` do pacote, o E2E **falha** com `AssertionError: a aba impressa não pode partir
  palavra na matriz`. Um variante do teste com as asserções trocadas por medição imprime
  **`aba=198/2`** — exatamente as 198 palavras da matriz e 2 do cabeçalho que a alegação cita
  (amostra: `Item`, `Classificação`, `5.1.1`, `5.1.10`, `Recomendação`, `5.1.11`).
- **Caminhos de impressão da aba que sobravam — medidos por mim** (harness próprio, não faz parte do
  pacote): a 680 px, a 717 px (caixa do Ctrl+P por omissão do Chrome ≈ A4 − 2×0,4 in, já que a
  `review.css` **não declara `@page`**) e no layout de impressão **resumo**
  (`data-print-layout="summary"`, com `details` abertos como o `before()` do produto faz):
  matriz **0/0**, cabeçalho **0/0** nos quatro casos. O que resta não é palavra partida e sim token
  longo (URL, SHA-256, `2026-08-26T14:02:00.000Z`) quebrando por desenho em `overflow-wrap:anywhere`:
  `documento=11` na aba a 680 px, `8` a 717 px, `2` no resumo; no entregue, `9`. A asserção de
  largura (`tabela ≤ área imprimível`) só existe para `/entregue` — a aba não a tem (medido num
  mutante de 60 mm: tabela da aba 488 px numa caixa de 340 px e nada falha; não é defeito de produto,
  porque na caixa real de ~717 px a tabela da aba mede 606 px e cabe).

### 3.6 Item 6 (N3) — oráculo de largura derivado do `@page`: **PARCIAL**

- **Deriva, sim.** `printContentWidthPx(REPORT_CSS)` lê `@page`, exige `A4 portrait` e margem lateral
  em mm e devolve `Math.round((210 − 2·lado)/25.4·96)`; o diagnóstico imprime `(@page=680px)`. A
  varredura de mutantes honestos (margem alterada **e** `REPORT_CSS_CSP_HASH` recalculado, com
  `declared === sha256(REPORT_CSS)` conferido) muda a largura emulada como esperado.
- **O oráculo antigo era cego, confirmado:** com margem lateral de 60 mm (caixa derivada 340 px), o
  portão novo **falha** (`a matriz precisa caber na área imprimível: tabela 399px em 340px`) e o
  oráculo antigo (680 px fixos) **passa** — o mesmo resultado em 80 mm e 90 mm.
- **Mas a alegação é mais forte do que o medido:** 15 → **20 mm**, **25 mm** e **40 mm** com hash
  consistente **passam** no portão (tabela 609/571/457 px nas caixas 643/605/491 px, 0 quebras). A
  folha entregue é responsiva: ela reflui para dentro da caixa, então "jogar o conteúdo para fora do
  papel" só acontece quando a caixa cai abaixo do mínimo da matriz (**≈399 px**, ou seja margem
  lateral ≳ 56 mm). O portão ficou sensível a `@page`, não a "qualquer margem errada".
- Nota de mecanismo (medição, não inferência): o `@page` **não** pagina no harness; o teste o usa para
  **derivar a largura emulada** (`Emulation.setDeviceMetricsOverride`). O mutante falha porque a
  emulação encolhe — que é o comportamento certo —, não porque o teste pagine a folha.

### 3.7 Item 7 (N4) — as cinco frases: **REPRODUZIDO** (5/5), com duas frases novas

Conferidas uma a uma contra a medição:

| Frase | Estado |
|---|---|
| `LEIA-ME.md` artefato corrente + linhas 1.1.21/1.1.22 | **corrigida**: a linha corrente agora fala de 1.1.23/1.1.24 sem relatório e a última revisão é a 1.1.22; os digests citados conferem (`4e9174f8…` e `c2d6c44d…` batem com os zips em `release/`) |
| bloco da 1.1.20 em `2026-09-16-estado-dos-criterios-1.1.19.md` | **corrigida**: passou a dizer que a paginação **mudou** (15→14 e 16→15) em vez de "mesma paginação" |
| linha V1 do registro de achados | **corrigida**: dá os dois pares absolutos e mantém `−1 página` |
| `README.md` (50 quebras sob compressão, asserção `> 0`) | **corrigida e fiel ao código**: o teste usa `assert.ok(squeezedWithoutRule.matrixBroken.length > 0)` e `assert.ok(headControl.headBroken.length > 0)` (linhas 217 e 222), e a compressão é injetada (`table-layout:fixed;width:678px` + 3ª coluna de 70 px), como o texto declara |
| `triage:19` | já corrigida em `cdaf425`; **`cdaf425` não é ancestral de `a278859`**, então a revisão da 1.1.22 leu corretamente o commit congelado |

**Outras frases que a medição não sustenta (novos):**

- **A4** — o bloco da 1.1.23 no `README.md` termina com "**E2E de Chrome e a revisão independente da
  1.1.23 ficam para quando o Chrome estiver livre — a revisão da 1.1.22 está em curso.**" O commit
  `e751c5e`, dentro deste mesmo delta, registra os seis E2E da 1.1.23 como medidos 6/6 nos bytes
  empacotados e a auditoria real completa; `e751c5e` não toca no `README.md` e `bb7ace1` reescreveu só
  o parágrafo do topo. Fica uma contradição interna na página de entrada do produto.
- **A5** — "Verificação: **236/236** nos consumidores do sanitizador e da política de texto" não é
  reproduzível como escrito: os **16** arquivos que importam `core/privacy.js` ou `report/text-policy.js`
  somam **454** testes (todos passam) e o conjunto de importadores de `privacy.js` no próprio clone do
  autor (`/private/tmp/adv123-verify`) soma **241** (todos passam). Nenhum conjunto nomeável no
  repositório dá 236. A substância (nenhum consumidor regrediu) vale; o número não é conferível sem a
  lista de arquivos que o autor usou.

### 3.8 Item 8 (N5/N6/N7): **PARCIAL**

- **N5 REPRODUZIDO.** `word-break` saiu das duas regras (`thead th{overflow-wrap:normal}` e
  `.matrix-scroll td,.matrix-scroll th{overflow-wrap:normal}`); a folha ainda tem **1** ocorrência de
  `word-break` no documento inteiro, `word-break:break-all` em `.map-meta code,…,.legend-selector code`
  — outro seletor, não as duas regras. Hash do CSP: `REPORT_CSS_CSP_HASH = sha256-/08lFCZuvLDTCWc9EohNL3ysHAvD/2TEmNj21sRMFis=`
  é igual a `sha256(REPORT_CSS)` **e** igual ao `style-src` do HTML entregue **e** a `sha256(<style>)`
  desse HTML — os três coincidem, medido no pacote e no artefato real.
- **Geometria inalterada pela remoção (medido):** o diagnóstico do E2E na 1.1.24 é idêntico ao da
  1.1.22 no que a remoção poderia mexer — `tabela=678px em 680px`, `forçado sem regra=50`,
  `cabeçalho comprimido=1` (a revisão da 1.1.22 registrou exatamente `tabela=678px em 680px; forçado
  com regra=0; forçado sem regra=50; cabeçalho comprimido=1`). `word-break:normal` era no-op de
  verdade.
- **N6 REPRODUZIDO.** `DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE` não é mais importado em
  `report-view.js` (só resta a string do código de diagnóstico); varredura de imports não usados no
  arquivo: **0**.
- **N7 NÃO CORRIGIDO na prática (A3).** `.gitignore` ganhou `node_modules/` **com barra final**, e
  `node_modules` neste checkout é um **symlink**; o Git não ignora symlink com padrão de diretório.
  Medido: `git check-ignore -v node_modules` → exit **1** (não ignorado) e `git status --porcelain`
  → **`?? node_modules`**, exatamente o estado que o N7 dizia ter fechado. A/B em repositório de
  teste: com `node_modules/` o symlink continua `??`; com `node_modules` (sem barra) ele é ignorado.
  Ou seja, a premissa do próprio pedido de revisão ("`git status` limpo") **não se cumpre**, e a
  correção é uma linha: tirar a barra.

### 3.9 Item 9 — portões declarados: **REPRODUZIDO**

| Portão | Comando | Medido |
|---|---|---|
| Fase paralela | `node run-parallel.mjs` (usa `createTestPlan` do próprio `scripts/run-tests.mjs`) | **4.184 testes, 4.183 passam, 1 pulado, 0 falham** em duas execuções ociosas. Os dois arquivos *process-safe* (`real-chrome.test.mjs`, `axe-mv3-csp-decision.test.mjs`) somam **44/44**; **4.184 − 44 = 4.140** e **4.183 − 44 = 4.139** — o número declarado é o da fase paralela **sem** esses dois arquivos, que o próprio runner classifica como paralelos. Com a convenção que as revisões da 1.1.21/1.1.22 já usavam ("4.137 + 44"), o declarado e o medido coincidem |
| `release-package` + `extension-shell` | `node --test test/release-package.test.js test/extension-shell.test.js` | **12/12**, digest fixado |
| Seis E2E de Chrome real **nos bytes empacotados** | `AUDITA_E2E_CHROME=… node --test --test-concurrency=1 mandatory-journey current-page-export report-executive-print report-print-layout report-print-breaks report-version-provenance` dentro de `pkg124` | **6/6**, 11,5 s no total; proveniência confirma **1.1.24**; exportação da página atual devolve os quatro formatos; varredura de segredos 3 × 9 superfícies |
| Auditoria real do Google (modo sem imagens) | driver **meu**, `node google-own.mjs`, extensão = **minha extração do pacote** | **0 verificações com falha confirmada (0 ocorrências) · 9 Resultados positivos · Checklist separado: 109 verificações ainda sem conclusão · Cobertura 28,5% · motor próprio 9,0/10 · 146 linhas na matriz · 4 downloads `complete`** (html 339.209 B, pdf 1.002.584 B, csv 86.142 B, json 374.160 B, com sha256) |
| Artefato entregue conferido | pypdf + detector independente de quebras + contagem no HTML | **18 páginas**; **notas editoriais 5/5** no PDF (5.9.1, 5.9.2, 5.9.4, 5.9.17, 5.12.1) **e** no HTML (5 `<li>`); `Limitações registradas (6) · Modo sem imagens… · Observação passiva…`; viewport (`1030 × 752 CSS px; escala 1`), `Ledger normativo` e `Método:` presentes nos dois; **146/146 linhas da matriz com id e título, 146 ids distintos, conjunto igual ao do JSON**; **0 palavras partidas** no PDF (detector de vocabulário, 11.958 palavras), 0 `Evidênc`/`Recomendaçã`/`Classificaçã`/`Resultad` partidos; desfechos por item **109 cantTell · 27 inapplicable · 1 failed · 9 passed** iguais no JSON, no EARL (146 asserções) e na matriz; 118 ocorrências (117 + 1) iguais no JSON e no CSV (119 linhas com cabeçalho) |

Observação de reprodutibilidade: o CSV (86.142 B) e o JSON (374.160 B) da minha execução são
**byte a byte do mesmo tamanho** dos do autor, e o HTML também (339.209 B) — a captura do Google é
estável e os números da alegação são propriedade verificável daquele estado de página, não só de uma
execução.

---

## 4. Achados novos

Severidade e evidência; **medição** separada de **inferência**.

### A1 — Minor (privacidade, pré-existente, fora do delta): o tarjador de **valores** continua só em inglês

- **Medição:** `sanitizeJsonData({texto:'senha: S3GR3D0'}).texto === 'senha: S3GR3D0'`;
  `{texto:'cpf=12345678900'}` e `{texto:'chave de acesso: ABC-123'}` idem;
  `{texto:'password: S3GR3D0'}` → `'password: [redacted]'`. `redactSensitiveText` (linha 154 de
  `privacy.js`) não recebeu nenhum termo em português; a expansão do delta ficou em `SENSITIVE_KEY`.
- **Inferência:** texto de página que traga "senha: …"/"CPF: …" chega ao instantâneo e ao relatório
  sem tarja quando a política de privacidade permite texto. Não é regressão do delta (o
  `redactSensitiveText` não foi tocado) e não contradiz a frase revisada ("vocabulário sensível"
  estava no contexto de chaves/URL), mas é a metade simétrica da promessa de privacidade.

### A2 — Minor (privacidade, **introduzido pela 1.1.23**): o lookbehind `(?<!by)` deixa escapar credencial que começa por `bypass`

- **Medição:** `bypasscode`, `bypass_code`, `bypasswd`, `bypass_wd`, `bypassphrase`, `bypasskey`,
  `bypass_key`, `bypassword` → `SENSITIVE_KEY.test(...) === false`; `sanitizeJsonData` mantém o valor,
  `sanitizeEvidenceUrl` mantém o parâmetro, `frameId`/`id` seguem aceitos. **Antes do delta,
  `bypasscode` era tarjado.** `bypassToken`, `bypass_password` e `by-password` continuam cobertos.
- **Inferência:** a superfície é estreita (exige que a única ocorrência de `pass` esteja precedida de
  `by`), mas é uma perda de cobertura paga para preservar `bypass`/`passed`/`passes`/`passive`. Se
  quiser fechar sem reabrir o falso positivo: excluir só quando o token inteiro for
  `bypass|bypassed|bypasses|bypassing|bypassive` (ou aplicar `\b` no início e a lista de sufixos no
  fim), em vez de um lookbehind de dois caracteres.

### A3 — Minor (higiene): `node_modules/` no `.gitignore` não ignora o symlink deste checkout

- **Medição:** `git check-ignore -v node_modules` → exit 1; `git status --porcelain` → `?? node_modules`
  (antes e depois de todos os meus testes); A/B em repositório de teste: `node_modules/` deixa o
  symlink `??`, `node_modules` sem barra o ignora. É a mesma linha que o N7 diz ter corrigido.
- **Inferência:** o efeito prático é nenhum sobre o produto; o efeito sobre o processo é que a
  premissa "checkout limpo" do pedido de revisão continua falsa, e o próximo revisor vai repetir a
  mesma nota.

### A4 — Minor (documentação): o README contradiz o próprio delta sobre os E2E da 1.1.23

- **Medição:** `README.md`, bloco da 1.1.23: "E2E de Chrome e a revisão independente da 1.1.23 ficam
  para quando o Chrome estiver livre". `git show --stat e751c5e` (dentro do delta) altera
  `docs/qa/2026-09-13-continuity-and-e2e-triage.md` e
  `docs/qa/2026-09-16-estado-dos-criterios-1.1.19.md` com os seis E2E 6/6, a auditoria empacotada e o
  artefato conferido; `git show e751c5e -- README.md` é vazio.
- **Inferência:** quem lê só o README conclui que falta rodar o que já foi rodado. Correção de uma
  linha, no espírito do N4.

### A5 — Observação (documentação): `236/236` não é reproduzível como escrito

- **Medição:** 16 arquivos importam `core/privacy.js` ou `report/text-policy.js`: **454** testes, 454
  passam. Importadores diretos de `privacy.js` no clone do autor (`/private/tmp/adv123-verify`, HEAD
  `5e5b8ba` + os dois patches): 168+13+2+1+3+54 = **241**, todos passam. Nenhuma combinação nomeável
  que eu tenha reconstruído dá 236.
- **Inferência:** provavelmente é o total da lista de arquivos que o autor usou, não publicada; a
  frase não é conferível por terceiro. A substância (nenhum consumidor regrediu) está confirmada.

### A6 — Observação (processo): a fase paralela tem 1 teste sensível a carga, herdado do delta anterior

- **Medição:** com um `build-release` meu rodando em paralelo, a fase paralela deu **4.184 testes,
  4.182 passam, 1 falha, 1 pulado** — `test/browser/annotation-map.test.js:632`
  ("times out a stalled bitmap allocation…"): `AssertionError: 0 !== 1` na linha 656. O mesmo arquivo
  isolado: **26/26**. Em duas execuções ociosas: **4.184/4.183/0/1**. O teste usa `timeoutMs: 5`, ou
  seja, é corrida de temporizador.
- **Inferência:** é flakiness pré-existente (o arquivo não está no delta), não regressão; o portão
  "0 falham" é reproduzível em máquina ociosa. Fica registrado porque é exatamente a classe "sob
  carga" que as revisões anteriores listaram como risco não medido.

---

## 5. Minhas retratações

1. **Dois mutantes iniciais do N3 não valiam nada e eu os descartei.** O primeiro trocava `@page` sem
   recalcular `REPORT_CSS_CSP_HASH`; o segundo calculava o hash em Python sobre o texto cru do módulo
   — que começa com a interpolação `${RESULTS_OVERVIEW_CSS}` e portanto não é a folha entregue. Nos
   dois, o que falhava era o CSP (fonte da matriz em `16px`), não a largura. Só os mutantes com
   `declared === sha256(REPORT_CSS)` (recalculado em Node) entram no veredito — e nesses, 15→20/25/40 mm
   **passam**.
2. **Minha primeira medição da fase paralela (1 falha) foi contaminada por mim mesmo** — eu tinha um
   `build-release` concorrente. Retiro-a como evidência de portão vermelho e a reclassifico como o
   achado A6 (sensibilidade a carga).
3. **Duas leituras minhas iniciais estavam erradas por construção do meu próprio probe:** usei raiz
   não-`contenteditable` para os atributos de campo editável (o caminho nem executava) e li
   "`frameId` removido" por ausência de propriedade, quando o contrato é `frameId: null`. Refiz e
   reporto os números corretos (item 1).
4. **Não tratei o rótulo "4.140" como erro do autor**: sob a convenção "paralela + 44 process-safe"
   que as revisões da 1.1.21 e da 1.1.22 usaram, 4.140 + 44 = 4.184 e 4.139 + 44 = 4.183, que é o
   medido. A frase, porém, devia dizer que exclui os dois arquivos process-safe — como as revisões
   anteriores faziam.

---

## 6. O que eu **não** medi, e risco residual

- **A fase serial completa (35 arquivos de Chrome real)** continua não medida por mim, como já era
  declarado. Rodei os seis E2E do escopo (6/6) mais um harness de impressão meu; as 9 falhas de
  `sidepanel-flow-mv3.test.mjs` foram aceitas como conhecidas e não reexecutadas.
- **Nada de UI manual**: painel lateral, diálogos e leitor de tela não foram abertos por mim; a
  verificação de produto é E2E + auditoria real de uma página. O critério 8 segue Parcial e eu não o
  toquei.
- **O detector de palavras partidas do PDF não é meu**: reusei o detector por vocabulário da revisão
  da 1.1.22 (11.958 palavras, extraídas do HTML/JSON entregues e da árvore do pacote). Uma palavra
  partida que não exista nesse vocabulário escaparia; o detector também não distingue quebra de token
  longo intencional (URL, SHA-256) de quebra de palavra — por isso reportei as duas contagens.
- **`717 px` é proxy**: a caixa real do Ctrl+P foi estimada como A4 menos as margens por omissão do
  Chrome (0,4 in por lado); não abri a caixa de diálogo de impressão. E a `review.css` **não declara
  `@page`**: o tamanho de papel da aba depende do navegador, o que o portão novo não cobre (a folha
  entregue cobre).
- **Sem `deviceScaleFactor ≠ 1`**, sem impressão real (só emulação `print` + `printToPDF` do E2E
  executivo), sem teste de flakiness prolongado (só 3 execuções do `report-print-breaks`, 3 da fase
  paralela).
- **Privacidade medida em processo, não em página hostil**: os probes de vocabulário chamam o
  sanitizador diretamente; não montei uma página com campos `senha`/`cpf` reais e coletei com a
  extensão.
- **V6, V7 e V9 herdados** (12 códigos `ANNOTATION_MAP_*`, heurística de forma do
  `listedLimitations`, hash de CSP sem verificação em tempo de execução) não foram reauditados —
  seguem abertos como declarado. O V7 em particular continua: a correção do item 3 mudou o
  **fail-open** para **fail-loud**, não a heurística de forma.
- **A5 pode ser injusto**: se o autor publicar a lista de arquivos do "236/236", a frase passa a ser
  conferível; sem ela, não é.

---

## 7. Reprodução (comandos)

```bash
# artefato
shasum -a 256 /private/tmp/audita-review-124/release/audita-acessibilidade-1.1.24.zip
unzip -Z1 …/audita-acessibilidade-1.1.24.zip | wc -l
TMPROOT=$(node -e "console.log(require('fs').realpathSync(require('os').tmpdir()))")
mkdir -p "$TMPROOT/audita-release-test-rb124a"
cd /private/tmp/audita-review-124 && node scripts/build-release.mjs --temporary-release-directory "$TMPROOT/audita-release-test-rb124a"

# pacote medido
mkdir -p /private/tmp/adv124/pkg124 && (cd /private/tmp/adv124/pkg124 && unzip -qq /private/tmp/audita-review-124/release/audita-acessibilidade-1.1.24.zip)
cp -R /private/tmp/audita-review-124/test /private/tmp/audita-review-124/fixtures /private/tmp/adv124/pkg124/

# fase paralela (exclui os 35 arquivos de Chrome real, inclui os 2 process-safe)
node /private/tmp/adv124/run-parallel.mjs
node --test test/e2e/support/real-chrome.test.mjs test/e2e/axe-mv3-csp-decision.test.mjs
node --test test/release-package.test.js test/extension-shell.test.js

# E2E nos bytes empacotados
cd /private/tmp/adv124/pkg124 && AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  node --test --test-concurrency=1 test/e2e/mandatory-journey-mv3.test.mjs test/e2e/current-page-export-mv3.test.mjs \
  test/e2e/report-executive-print.test.mjs test/e2e/report-print-layout.test.mjs \
  test/e2e/report-print-breaks.test.mjs test/e2e/report-version-provenance.test.mjs

# sondas do revisor
node /private/tmp/adv124/probe-privacy.mjs <json-real-entregue>
node /private/tmp/adv124/probe-four-usages.mjs
node /private/tmp/adv124/probe-n1b.mjs <json-real-entregue>
bash /private/tmp/adv124/mutation-panel.sh      # N2: aba 198/2 e falha do portão
bash /private/tmp/adv124/mutation-panel3.sh     # N3: margens honestas 15/20/25/40 e 60/80/90 mm
cd /private/tmp/adv124 && AUDITA_E2E_CHROME="…" node --test --test-concurrency=1 google-own.mjs
/Users/andrebadini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  /private/tmp/adv122/detect_breaks2.py <pdf-do-google> <html-do-google> rotulo /private/tmp/adv124/pkg124
```

Artefatos das minhas medições: `/private/tmp/adv124/` (`parallel-phase.log`, `e2e-pkg.log`,
`mutation*/`, `google-own.log`, `g124-own/`, `pkg124/`).
