# REVISÃO ADVERSARIAL INDEPENDENTE — Audita Acessibilidade 1.1.25

- **Objeto:** checkout congelado `/private/tmp/audita-review-125`, HEAD `72c391926afebd2a7834ff52b6c5ecbfcc3f028c`, delta `bb7ace1..72c3919`.
- **Artefato:** `release/audita-acessibilidade-1.1.25.zip`.
- **Revisor:** agente independente, sem confiança em afirmação do autor. Todo número abaixo foi medido nesta sessão; os comandos estão na seção 3/7.
- **Ambiente:** Chrome for Testing 152.0.7977.64 (`/private/tmp/audita-cft152-fixed/...`), um workload de Chrome por vez, `downloadMode: 'profile'`; pypdf 6.10.0; nenhuma escrita no checkout congelado (`git status --porcelain` = 0 linhas ao fim).

---

## 1. Veredito

**A 1.1.25 pode substituir a 1.1.24 como candidata. 0 Critical, 0 Important, 4 Minor + 4 observações. Nada bloqueante.**

O delta faz o que declara: o digest fixado se reproduz de forma independente (**4 reconstruções honestas** — uma no checkout e três numa cópia minha, inclusive depois de restaurar os mutantes), os 199 arquivos do pacote são byte a byte idênticos à árvore e a lista é idêntica à da 1.1.24, os portões declarados fecham verdes nas medições que fiz (paralela 4.189/4.188/0/1, `release-package`+`extension-shell`+`release-assets` 19/19, 19/19 de E2E de Chrome nos bytes empacotados, auditoria real do Google refeita por mim com os mesmos números, artefato entregue conferido item a item), e a asserção nova do item 8 é **não vacuosa** (mutante derruba o E2E).

O único achado que eu mandaria corrigir antes de publicar é o **N1**: a correção do A2 fechou 13 grafias e **abriu 8 que a 1.1.24 (e a 1.1.22) tarjavam** — inclusive `palavra-passe` e `passw0rd`. É a mesma classe do A2, medida, e por isso **Minor** por consistência com a calibração das revisões anteriores; não é bloqueante porque exige que a página nomeie o campo com uma dessas grafias e porque o tarjador de valores nunca cobriu nenhuma delas.

---

## 2. Artefato

| Medição | Comando | Resultado |
|---|---|---|
| Digest entregue | `shasum -a 256 release/audita-acessibilidade-1.1.25.zip` | `499e1de38af007dac8696b071564ce8c8ddf9a486bd688d0897468f1c3dd6a23` = **esperado** |
| Entradas | `unzip -Z1 … \| wc -l` / `find . -type f \| wc -l` | **199 / 199** |
| Lista vs 1.1.24 | `diff <(unzip -Z1 1.1.24.zip\|sort) <(unzip -Z1 1.1.25.zip\|sort)` | **vazio — lista idêntica** |
| Manifesto interno | `unzip -p … manifest.json` | `version`/`version_name` = **1.1.25**, `minimum_chrome_version` 116, CSP de páginas de extensão intacta |
| Pacote → árvore | sha256 por arquivo dos 199 | **199/199 idênticos** |
| Árvore → pacote | `comm` das listas | só `assets/icons/icon-1024.png` e `icon-source.svg` fora do pacote (por desenho; o manifesto não os referencia) |
| Reconstrução | `node scripts/build-release.mjs --temporary-release-directory "$TMPROOT/audita-release-test-rb125a"` | `499e1de3…d6a23` — **reproduz o digest** |
| Reconstrução numa cópia minha | `build-mutants` (manifest+src+vendor+assets+scripts) | idem `499e1de3…d6a23`, antes e depois dos mutantes |
| `release-package`+`extension-shell`+`release-assets` | `node --test test/release-package.test.js test/extension-shell.test.js test/release-assets.test.js` | **19/19, 0 falhas, 6,09 s**, com o digest fixado no teste = digest do arquivo em disco |

---

## 3. Os nove itens

### 3.1 Item 1 (A2, radical de senha) — **PARCIAL**

*Reproduzido no que foi declarado; a classe não está fechada, e a troca abriu 8 grafias.*

Comandos: `node /private/tmp/adv125/tally.mjs`, `node /private/tmp/adv125/probe-corpus.mjs`, `node /private/tmp/adv125/probe-privacy.mjs`.

- **Os 5 do achado foram fechados:** `bypasscode`, `bypass_code`, `bypasswd`, `bypass_key`, `bypassword` → `REDACT` (em 1.1.24: `keep`).
- **13 grafias ganhas** vs 1.1.24 (em 107 testadas): `pwd`, `pwdField`, `userPwd`, `PWD`, `bypasscode`, `bypass_code`, `bypasswd`, `bypass_key`, `bypassword`, `bypasskey`, `bypassphrase`, `bypass-code`, `bypass_word`.
- **9/9 preservados** como declarado: `passed`, `passes`, `bypass`, `passive`, `passing`, `passo`, `passage`, `passport`, `bypasses` (destes, `passage` e `passport` eram tarjados na 1.1.24 e agora são preservados — melhora de preservação).
- **Falso positivo novo em chave real: NENHUM.** Corpo de 5.988 strings reais extraídas de `git ls-files` (params de URL, chaves de objeto, `name`, `id`, `aria-label`): **6 chaves novas tarjadas, todas de credencial** (`bypasscode`, `bypass_code`, `bypasswd`, `bypass_key`, `bypassword`, `pwdField`) e **7 chaves legítimas que deixaram de ser destruídas** (`passiva`, `passaram`, `passar`, `passagem`, `passNeedsReview`, `passForModal`, `passLength`). Nas 59 palavras legítimas do meu vocabulário: **0 falsos positivos novos**.
- **8 grafias REGREDIRAM** (1.1.24 tarjava, 1.1.25 deixa escapar):

  `motdepasse`, `passwrd`, `passw0rd`, `palavra-passe`, `palavrapasse`, `frase-passe`, `frasepasse`, `passwort`

  Causa medida: a fronteira `(?![-_a-z])` bloqueia `pass` seguido de **qualquer** letra, e nenhuma dessas caudas (`wrd`, `w0rd`, `e`, `wort`) está na lista de caudas de credencial. `passwrd` e `palavra-passe` já eram tarjados antes da 1.1.23. Consequência no produto: `?palavra-passe=…` **não é removido** por `sanitizeEvidenceUrl` e uma chave `palavra-passe` **mantém o valor** em `sanitizeJsonData` (ambos eram tarjados na 1.1.24). O teste novo do autor não cobre nenhuma das 8.
- 24 grafias continuam escapando nas duas versões (pré-existente, fora do delta): `pasword`, `paswd`, `pssword`, `senhã`, `credenciais`, `contraseña`, `contrasena`, `clave`, `kennwort`, `pin`, `nip`, `codigo`, `código`, `code`, `key`, `accessKey`, `privateKey`, `bearer`, `jwt`, `sid`, `nonce`, `signature`, `salt`, `hash`.

### 3.2 Item 2 (A1, valores com rótulo em português) — **REPRODUZIDO, com resíduo**

- **10/10 rótulos portugueses tarjados** (`senha`, `segredo`, `credencial`, `sessão`, `autenticação`, `autorização`, `chave`, `cpf`, `cnpj`, `cartão`), em `[:=]`, medido por `sanitizeJsonData({texto})`.
- **Prosa legítima preservada:** 5 dos meus 7 casos saem intactos, inclusive o controle do autor ("A sessão de perguntas discutiu o cartão…") e "A senha do Wi-Fi está afixada na parede". Os 2 que mudam (`Chave: valor…`, `CPF: campo obrigatório…`) mudam **por desenho** — são pares rótulo/valor.
- **Resíduo (→ O2):** o tarjador de **valores** não é coextensivo ao `SENSITIVE_KEY`. Medido: `pwd: hunter2`, `passcode: 987654`, `passphrase: correct horse`, `pass: hunter2` e `auth: Basic zzz` **passam intactos**, enquanto as mesmas chaves são tarjadas por `sanitizeJsonData`. `auth` é pré-existente; `pwd`, `passcode`, `passphrase` ficaram inconsistentes porque o radical de chave ganhou `pwd`/caudas de credencial e o tarjador de valores não.
- **Resíduo (→ N2):** só o **primeiro token** depois do rótulo é tarjado. Medido: `cartão: 4111 1111 1111 1111` → `cartão: [redacted] 1111 1111 1111`; `cpf: 123 456 789 00` → vaza `456 789 00`. A asserção nova do autor para esse caso (`!includes('4111 1111 1111 1111')`) passa **trivialmente** — o teste declara coberto um caso que não mede.

### 3.3 Item 3 (A3, `.gitignore`) — **REPRODUZIDO**

```
git -C /private/tmp/audita-review-125 check-ignore -v node_modules
  → .gitignore:8:node_modules	node_modules          (exit 0)
git ls-tree HEAD node_modules → vazio
git status --porcelain | wc -l → 0
```
`node_modules` sem barra ignora o symlink. Nada legítimo foi atingido: **635 arquivos rastreados**, **0** caminhos rastreados contendo `node_modules`, e o único caminho com esse nome no disco é o próprio symlink (o padrão sem barra casa em qualquer profundidade, que é o comportamento pretendido). `release/` e `docs/` intactos.

### 3.4 Item 4 (A4/A5, frases) — **REPRODUZIDO, com uma frase nova**

- A4: a frase antiga sumiu — `grep -rn "Chrome estiver livre\|ficam para quando\|E2E de Chrome e a revisão" README.md docs/*.md store-assets/*.md` → **vazio**. A nova frase é sustentada pelo registro da rodada 46 e pelos meus próprios números (0 falhas / 9 positivos / 109 no checklist / 18 páginas).
- A5: nenhum número de teste sem seleção no texto mudado; o registro declara a seleção ("454 testes verdes nos 16 consumidores; importadores de `privacy.js` = 241").
- **Frase nova que a medição não sustenta (→ N4):** `README.md:30` continua dizendo **"Agora `(?<!by)pass(?:word|wd)?(?!es|ed|ive|o|ing)` preserva as quatro…"**, citando como corrente o radical da 1.1.23 — `src/core/privacy.js:13` tem outro regex. Mesma família do A4 (documentação contradiz o código), só que agora dentro do bloco 1.1.23.
- Observação: "seis E2E do escopo 6/6" não nomeia os seis em nenhum documento da 1.1.25 (→ O3).

### 3.5 Item 5 (V6, dois códigos com a mesma frase) — **REPRODUZIDO**

- **Fonte:** `diagnostic-policy.js` tem **exatamente 12** códigos com o mesmo `message` e `fact: 'annotation-failed'` (listados por sonda) — e é o **único** grupo de códigos que compartilha mensagem em toda a política.
- **Sonda:** `listedLimitations([...12 codificados, frase simples])` → **1** entrada (1.1.24 devolvia **12**), e é a forma codificada que sobrevive.
- **Nenhum código sumiu do modelo:** o JSON entregue carrega `audit.session.diagnostics` com `code`+`message` (medido no meu JSON do Google: 3 diagnósticos com código), o HTML entregue imprime `CODE: message` **dentro da própria lista deduplicada** (medido: `PIXEL_CAPTURE_OMITTED:`, `DYNAMIC_PROBES_OMITTED_PASSIVE:` e `BROWSER_VERSION_UNAVAILABLE:` aparecem 1× cada, todos dentro do `<details data-report-limitations>`, nenhum fora), e a sonda de `materialLimitationEntries` (html.js:684, renderer sem `reportView`) preserva **12/12**. `listedLimitations` só é usada em `html.js:282` e `report-view.js:1010` — a deduplicação é de apresentação.
- Observação (→ O1): no renderer que **entrega** o HTML/PDF só existe **uma** lista (a deduplicada), então o segundo código de uma frase repetida fica visível apenas no JSON — é o trade-off que o autor declarou, medido.

### 3.6 Item 6 (V7, deduplicação por posição) — **PARCIAL**

Sonda: `node /private/tmp/adv125/probe-limitations.mjs` (compara a implementação da 1.1.24 extraída de `bb7ace1` com a de HEAD, verbatim).

- **As 6 linhas da tabela de lacunas: 6/6 corrigidas.** `OTP: frase curta.`, `otp: frase minúscula.`, `REPORT-PDF:…`, `XYZ:  frase…` (espaço duplo), `ABC: frase…\n` (quebra no fim), `A: B: frase encadeada.` → todas davam **2** entradas na 1.1.24 e dão **1** agora. Acrescentei `A:B: …`, `A: B: C: …`, ` ABC: …` e código com dois-pontos interno: também 1.
- **Ainda escapam (4 formas de separador + 2 de código), iguais às da 1.1.24 — não são regressões:** `ABC:\tfrase…`, `ABC:\nfrase…`, `ABC:frase…`, `ABC:\u00A0frase…`, `REPORT PDF: …` (espaço no código) e ` ABC: …` (espaço à esquerda) continuam produzindo 2 entradas. Ou seja: **a extração continua dependendo da forma do separador** (`": "` literal), e o texto do commit diz mais do que o código faz. Não é alcançável pelo gerador do produto, que sempre escreve `` `${code}: ${message}` ``.
- **Nenhuma entrada legítima engolida no vocabulário real:** 46/46 mensagens do sistema corretamente reconhecidas como par codificado/simples, 0 mal classificadas; os formatos reais (`Página não iniciada: …`, `Verificação não testada: … — …`, os textos de painel) têm prefixo com espaço, logo não são tratados como código. O caso adversário que construí ("`Atenção: X.`" + "`Nota: X.`" → 1 entrada) é **inalcançável**: nenhuma string do produto tem prefixo de uma palavra antes de `": "`, e `model.limitations` é validado para ser igual a `deriveSystemLimitations(model)`.

### 3.7 Item 7 (V9, build recusa hash divergente) — **REPRODUZIDO**

Cópia minha (`/private/tmp/adv125/build-mutants`, `manifest.json`+`src`+`vendor`+`assets`+`scripts`), cada cenário num diretório temporário válido:

| Cenário | Exit | Entradas em `release/` | Mensagem |
|---|---|---|---|
| honesto (controle) | 0 | 1 zip — `499e1de3…d6a23` | — |
| hash declarado trocado, CSS intacto | **1** | **0** | `REPORT_CSS_CSP_HASH divergente do CSS empacotado: declarado sha256-AAAA…, calculado sha256-/08lFCZuvLDTCWc9EohNL3ysHAvD/2TEmNj21sRMFis=` |
| CSS derivado (regra `.x-drift` dentro de `REPORT_CSS`) | **1** | **0** | `REPORT_CSS_CSP_HASH divergente` |
| **dependência do CSS derivada** (`RESULTS_OVERVIEW_CSS`, composta dentro de `REPORT_CSS`) | **1** | **0** | `REPORT_CSS_CSP_HASH divergente` |
| `report.css.js` ausente | **1** | **0** | `ERR_MODULE_NOT_FOUND` cru (→ O4) |
| honesto de novo após restaurar | 0 | 1 zip — `499e1de3…d6a23` | — |

- **O portão vale para os bytes empacotados**, não para a árvore: ele importa o módulo de `staging` e roda **antes** de montar o zip.
- **Amarração verificada:** a meta de CSP que o navegador aplica é construída de `REPORT_CSS_CSP_HASH` (`html.js:96`, `:165`). O portão checa exatamente o par que é imposto — não é um hash decorativo. O caso da dependência composta (3ª linha) é o mais forte: o hash cobre o CSS final, não o arquivo local.
- Também reproduzi a reconstrução honesta 3× (checkout + 2 cópias), sempre `499e1de3…d6a23`.

### 3.8 Item 8 (lacuna não medida da 1.1.22) — **REPRODUZIDO, com não vacuidade provada**

- **Como está, nos bytes empacotados:** `url-pixel-consent-mv3` → **10/10**, incluindo `element-only omits the full page and explains the factual limitation`.
- **Mutante (minha cópia `/private/tmp/adv125/mut-clause`):** removi a cláusula **só da manchete** do renderer interativo (`report-view.js:1011`, a lista fica intacta). Resultado: **falha** em `url-pixel-consent-mv3.test.mjs:283` com `actual: 'Limitações registradas (5)'`, `expected: /Captura integral omitida/u`. A asserção **antiga** (`assert.match(state.text, expected.limitation)`, linha 278) **passou** — a prova de que era ela que a entrada codificada satisfazia. Não vacuidade: **demonstrada**.
- **Bônus medido:** o HTML **entregue** também traz a cláusula na manchete — headline do meu artefato do Google: `Limitações registradas (6) · Modo sem imagens: nenhuma captura raster. · Observação passiva: sem testes interativos de teclado, redimensionamento e movimento.`

### 3.9 Item 9 (portões declarados) — **REPRODUZIDO**

| Portão declarado | Medição | Resultado |
|---|---|---|
| Paralela 4.145/4.144/0 com 1 pulado | `node run-parallel.mjs` → **4.189 testes, 4.188 passam, 1 pulado, 0 falham**; `node --test test/e2e/support/real-chrome.test.mjs test/e2e/axe-mv3-csp-decision.test.mjs` → **44/44** | **4.189 − 44 = 4.145** e **4.188 − 44 = 4.144** ✓ (mesma convenção que a revisão da 1.1.24 ratificou). O delta acrescentou **exatamente 5 testes** (`+test(` no diff: 2 privacy, 2 diagnostic-policy, 1 release-package) — 4.140 + 5 = 4.145 ✓ |
| `release-package` + `extension-shell` + `release-assets` 19/19 com o digest fixado | 19/19, 0 falhas | ✓ |
| **Seis E2E do escopo 6/6 nos bytes empacotados** | rodei os **dois** conjuntos candidatos (o da rodada 46: `mandatory-journey`, `current-page-export`, `highlight-marking`, `page-markers-signals`, `report-version-provenance`, `resource-url-privacy`; e o da revisão da 1.1.24: + `report-executive-print`, `report-print-layout`, `report-print-breaks`) = 9 arquivos numa invocação serial | **9/9 arquivos verdes** (9 testes) — superconjunto de qualquer "seis" |
| E2E de consentimento de pixels 10/10 | mesmo run | **10/10** |
| Auditoria real do Google: 0 falhas, 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações | driver próprio (`google125.mjs`) nos bytes empacotados, `https://www.google.com/`, modo `no-pixels` | **version 1.1.25; 9 positivos; 109 no checklist; 28,5%; 9,0/10; 0 falhas confirmadas; 146 linhas de matriz; HTML 339.209 B, PDF 1.006.764 B, CSV 86.142 B, JSON 374.160 B, os quatro `complete` com sha256; PDF com 18 páginas** |
| Artefato: notas 5/5 no PDF e no HTML, proveniência nos dois, 146/146 ids e títulos, 0 palavras partidas | `verify-artifacts.mjs` + `verify-pdf.py` | **notas editoriais 5/5** (5.9.1, 5.9.2, 5.9.4, 5.9.17, 5.12.1 no PDF e 5 `<li>` no HTML); **proveniência** `ExportDeliveryIdentityV1` no HTML, no JSON (`exportDeliveryIdentity`) e no texto do PDF; **146/146 linhas com id e título, 146 ids distintos, conjunto idêntico ao do JSON**; **0 palavras partidas** (detector meu por vocabulário, 3.885 palavras do PDF); desfechos **109 cantTell · 27 inapplicable · 1 failed · 9 passed** iguais em JSON, EARL (146 asserções) e matriz; 118 ocorrências = 119 linhas de CSV |

Observação sobre o "0 falhas" vs `failed: 1`: o item `failed` é a **5.3.3, classificação `recommendation`**, exibido como alerta ("Não atendido neste teste", grupo `alerts`, "0 verificações com falha confirmada"). Consistente com o desenho requisito/recomendação — não é contradição.

---

## 4. Achados novos

### N1 — Minor (privacidade, **regressão introduzida pela correção do A2**)
8 grafias de credencial que a 1.1.24 **e** a 1.1.22 tarjavam passam a escapar: `motdepasse`, `passwrd`, `passw0rd`, `palavra-passe`, `palavrapasse`, `frase-passe`, `frasepasse`, `passwort`.
**Medição:** `node tally.mjs` (dois regexes, o de `bb7ace1` extraído do git) → `{"RR":62,"Rk":13,"kR":8,"kk":24}` em 107 grafias: **13 ganhas, 8 perdidas**. Efeito: `sanitizeEvidenceUrl('…?palavra-passe=x')` mantém o parâmetro; `sanitizeJsonData({palavra-passe:'x'})` mantém o valor. O teste novo (`privacy.test.js`, bloco A2) não inclui nenhuma das 8.
**Inferência (não medida em página viva):** a exploração exige que a página nomeie o campo com uma dessas grafias. `passw0rd`/`passwrd` são neutras de idioma e plausíveis; `palavra-passe` é pt-PT.

### N2 — Minor (força de teste; o produto é pré-existente)
O caso `['cartão: 4111 1111 1111 1111', '4111 1111 1111 1111']` do teste novo do A1 passa **trivialmente**: a saída é `cartão: [redacted] 1111 1111 1111`, que não contém a string de 4 grupos, mas mantém 12 dos 16 dígitos. `cpf: 123 456 789 00` → `cpf: [redacted] 456 789 00`.
**Medição:** saída literal do `sanitizeJsonData` acima. O comportamento de tarjar só o primeiro token é o mesmo dos rótulos ingleses desde antes do delta; o defeito novo é a **asserção que se lê a si mesma** — exatamente o padrão que a rodada 59 celebrou ter corrigido no `release-assets`.

### N3 — Minor (a alegação do V7 é mais larga que o código)
"a deduplicação não depende mais da forma do código" — depende do separador `": "` literal. 4 formas medidas que ainda produzem 2 entradas (tab, quebra de linha, sem espaço, NBSP) + código com espaço interno + espaço à esquerda. Todas **idênticas na 1.1.24** (não são regressões) e inalcançáveis pelo gerador do produto. Minor porque o texto do commit/registro afirma mais do que o medido; as 6 linhas declaradas estão corrigidas.

### N4 — Minor (documentação)
`README.md:30` cita como corrente o radical da 1.1.23 (`Agora (?<!by)pass(?:word|wd)?(?!es|ed|ive|o|ing) preserva as quatro…`) enquanto `src/core/privacy.js:13` traz outro regex. Mesma família do A4. O registro de achados cita o mesmo regex, mas ali como **estado histórico da 1.1.23** — correto no contexto.

### O1 — Observação (trade-off declarado, medido)
No renderer que **entrega** HTML e PDF (`renderReportViewDocument`) só existe uma lista de limitações — a deduplicada —, sem lista técnica paralela (`"Limitações e diagnósticos"` = 0 ocorrências no HTML entregue). Com 2+ códigos de mesma frase, o segundo código fica visível **apenas no JSON**. O autor declarou esse trade-off; se o leitor do PDF precisar do código específico, ele não está lá. Inferência de alcance: `aggregate-audits.js:141` funde diagnósticos de todas as páginas em `session.diagnostics`, então um lote com duas páginas falhando por códigos diferentes é o caso plausível — **não reproduzi um lote real com duas falhas de anotação**.

### O2 — Observação (vocabulário do tarjador de valores ≠ vocabulário da chave)
`pwd`, `passcode`, `passphrase`, `pass` e `auth` seguidos de `[:=]` **não** tarjam o valor, embora as mesmas chaves sejam tarjadas por `sanitizeJsonData`. Medido acima (item 2). `pwd`/caudas de credencial ficaram de fora quando o radical de chave foi ampliado.

### O3 — Observação (seleção não declarada)
"seis E2E do escopo 6/6" aparece no registro/estado sem nomear os seis em nenhum documento da 1.1.25 (só na trilha da 1.1.23). O remédio do A5 ("nenhum número de teste sem a seleção declarada") não foi aplicado a esse número. Eu rodei 9 arquivos (superconjunto dos dois conjuntos candidatos), 9/9 verdes.

### O4 — Observação (modo de falha do portão V9)
Sem `src/core/report/report.css.js` o build falha alto (exit 1, `release/` vazio), mas com `ERR_MODULE_NOT_FOUND` cru em vez da mensagem curada. Não é contornável, é opaco.

---

## 5. Retratações (erros meus, corrigidos por medição)

1. **Mutantes do V9 inválidos na primeira rodada.** Usei diretórios `audita-release-test-mutb`/`mutc`/`mutd`: o build exige exatamente 6 caracteres alfanuméricos, então os três "falharam" por validação de diretório, não pelo hash. Refiz com nomes válidos (`aaa001`, `bbb002`, …) — é a tabela da seção 3.7.
2. **Meu primeiro "CSS derivado" não derivava o CSS.** Inseri um comentário *JavaScript* entre `=` e o template literal: o CSS não mudou e o build **acertadamente** passou. Refiz com deriva real dentro de `REPORT_CSS` e na dependência composta `RESULTS_OVERVIEW_CSS` — ambas recusadas.
3. **Interpretei uma divergência de contagem como defeito de artefato e estava errado.** Vi `executive 1 × material 12` e tratei como inconsistência do HTML entregue; as duas listas **não coexistem** em artefato nenhum (a lista material pertence ao renderer sem `reportView`). Rebaixado a observação (O1), com medição e inferência separadas.
4. **"10 divergências de desfecho na matriz" era erro meu de vocabulário.** A matriz imprime "Atendido no escopo observado" e eu procurei "conformidade técnica observada". A distribuição real é exatamente 109/27/9/1, igual ao JSON e ao EARL.
5. **`scripts/verify-project.mjs` com 40 falhas era erro meu de ambiente.** Todas as 40 são `AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório`/`CHROME_BINARY_INVALID` porque não passei a variável; a parte sem Chrome (a fase paralela de 4.189 testes + 15 verificações estáticas) passou. Não é achado contra o produto.
6. **A evidência "146/146" da revisão da 1.1.24 usava um seletor que não existe no HTML entregue** (`data-report-matrix-row` = 0 ocorrências). O número se sustenta, mas foi medido em outro artefato; eu o remeti pela estrutura real da tabela.

---

## 6. O que eu **não** medi / risco residual

- **Fase serial completa (35 arquivos de Chrome real):** não rodei inteira. Rodei 10 arquivos (19 testes) em série nos bytes empacotados; as 9 falhas conhecidas de `test/e2e/sidepanel-flow-mv3.test.mjs` não foram retriadas e continuam sendo o maior risco declarado.
- **Item 6 da revisão da 1.1.24 (oráculo de largura):** aceito como **PARCIAL por desenho** (documentado no registro, com a sensibilidade real medida); não remedi margens (`@page` > 56 mm) nem a não-paginação do harness.
- **Critério 8 (pessoa leiga):** segue Parcial; não medido.
- **N1 não foi explorado em página viva** — é medição de matcher (`SENSITIVE_KEY`), não de auditoria end-to-end com `?palavra-passe=`.
- **O1 (alcance em lote)** é inferência de fonte (`aggregate-audits.js:141`), não um lote real com duas falhas de anotação.
- **Auditoria real:** uma página (google.com), uma execução, modo `no-pixels`. Sem lote real, sem modo com pixels, sem páginas brasileiras.
- **Métricas históricas (1.1.16–1.1.22)** não foram remedidas; todas as métricas de artefato desta revisão são da 1.1.25.
- **Item 8:** a não vacuidade foi provada para a manchete do renderer **interativo** (é o documento que o E2E lê). Não mutei a manchete do HTML **exportado** — medi que ela contém a cláusula, mas não que um E2E a proteja.
- Os 11 falsos positivos pré-existentes do radical (`surpass`, `compass`, `author`, `authority`, `chocolate`-like não; `passível`, `cookiepolicy`, `sessionless`, `author*`, `tokenizer`, `secretary`, `secretion`, `otpCount`, `csrfTokenLegit`, `chaves`, `chaveiro`…) permanecem **inalterados** em relação à 1.1.24: encolher isso é decisão de produto, não regressão deste delta.

---

## 7. Comandos de reprodução

```bash
# artefato
shasum -a 256 /private/tmp/audita-review-125/release/audita-acessibilidade-1.1.25.zip
unzip -Z1 /private/tmp/audita-review-125/release/audita-acessibilidade-1.1.25.zip | wc -l          # 199
cd /private/tmp/adv125/pkg125cmp && diff <(unzip -Z1 …/1.1.24.zip|sort) <(unzip -Z1 …/1.1.25.zip|sort)   # vazio

# reconstrução
TMPROOT=$(node -e "console.log(require('fs').realpathSync(require('os').tmpdir()))")
mkdir -p "$TMPROOT/audita-release-test-rb125a"
cd /private/tmp/audita-review-125 && node scripts/build-release.mjs --temporary-release-directory "$TMPROOT/audita-release-test-rb125a"

# itens 1 e 2 (radical e tarjador de valores)
node /private/tmp/adv125/tally.mjs            # 107 grafias: 13 ganhas / 8 perdidas
node /private/tmp/adv125/probe-corpus.mjs     # 5.988 strings reais: 0 falso positivo novo
node /private/tmp/adv125/probe-privacy.mjs

# itens 5 e 6
node /private/tmp/adv125/probe-limitations.mjs   # tabela de lacunas, velho × novo
node /private/tmp/adv125/probe-count.mjs

# item 7 (mutantes de build, na minha cópia)
SC=/private/tmp/adv125/build-mutants   # manifest.json src vendor assets scripts
cd $SC && node scripts/build-release.mjs --temporary-release-directory "$TMPROOT/audita-release-test-bbb002"

# itens 8 e 9 (Chrome real, um workload por vez, nos bytes empacotados)
cd /private/tmp/adv125/pkg125 && cp -R /private/tmp/audita-review-125/test /private/tmp/audita-review-125/fixtures .
export AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
node --test --test-concurrency=1 test/e2e/url-pixel-consent-mv3.test.mjs            # 10/10
node --test --test-concurrency=1 test/e2e/mandatory-journey-mv3.test.mjs test/e2e/current-page-export-mv3.test.mjs \
  test/e2e/highlight-marking-mv3.test.mjs test/e2e/page-markers-signals-mv3.test.mjs \
  test/e2e/report-version-provenance.test.mjs test/e2e/resource-url-privacy.test.mjs \
  test/e2e/report-executive-print.test.mjs test/e2e/report-print-layout.test.mjs \
  test/e2e/report-print-breaks.test.mjs                                             # 9/9
cd /private/tmp/adv125/mut-clause && node --test --test-concurrency=1 test/e2e/url-pixel-consent-mv3.test.mjs  # falha na linha 283

# portões sem Chrome
node /private/tmp/adv125/run-parallel.mjs                                           # 4.189/4.188/1/0
cd /private/tmp/audita-review-125 && node --test test/release-package.test.js test/extension-shell.test.js test/release-assets.test.js  # 19/19

# auditoria real + artefato
cd /private/tmp/adv125 && node --test --test-concurrency=1 google125.mjs            # 0 falhas/9/109/28,5%/9,0/18 págs/4 exportações
node verify-artifacts.mjs && /Users/andrebadini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 verify-pdf.py
```

**Estado final do checkout congelado:** `git status --porcelain` → 0 linhas; HEAD `72c3919`; digest do zip entregue inalterado; `release/` com 18 zips (17 herdados + 1.1.25); symlink `node_modules` intacto.
