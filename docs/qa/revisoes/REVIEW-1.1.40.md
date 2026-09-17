# REVISÃO INDEPENDENTE — Audita Acessibilidade 1.1.40

**Revisor:** agente independente (delegado). Nenhum documento, comentário ou teste do autor foi aceito
como prova: toda afirmação numérica abaixo tem comando próprio e saída bruta preservada em
`/private/tmp/audita-review-140/evidence/`. Nenhum arquivo foi criado dentro do repositório do autor e
nenhum comando `git` de escrita foi executado sobre ele.

| Campo | Valor medido |
|---|---|
| Artefato | `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt/release/audita-acessibilidade-1.1.40.zip` — **199 arquivos**, 4.346.948 bytes descomprimidos (`unzip -l`) |
| SHA-256 medido | `8deba1559dc7f53e650fbbd89d5ac994c87503183d53fe8a6dd4bec703d59a52` — **idêntico ao declarado** |
| Commit do artefato | `c9d7dd4` (`chore: pacote 1.1.40 (zip + digest) e versão nos documentos`), `manifest.json` version **1.1.40** |
| Pacote × commit | para **todos** os 199 arquivos do zip, `cmp` byte a byte contra a árvore de `c9d7dd4` (exportada por `git archive`): **0 diferenças, 0 arquivos fora do commit**; `assets/` tem 2 arquivos a mais na árvore (não empacotados); `manifest.json`, `src/`, `vendor/` idênticos |
| Data/hora da revisão | 2026-09-17, 08:21Z–13:05Z (UTC) |
| Ambiente | macOS arm64; Node v26.5.0; Chrome for Testing **152.0.7977.64** (`/private/tmp/audita-cft152-fixed/…`), perfil temporário do harness, **um Chrome por vez**, `--test-concurrency=1`; pypdf 6.10.0 (Python 3.12.14) |
| Raiz de medição | `/private/tmp/audita-review-140/root` — repositório **independente** (`git clone --no-hardlinks --local` do worktree, passo 1) com o zip sobreposto por `unzip -o`; o `.git` copiado é o **diretório** do meu clone, nunca o arquivo-ponteiro do worktree |
| Gerações de mutação | `746a696` (1.1.39), `733cd01` (1.1.38), `682031e` (1.1.37), `1ffef6c` (1.1.36), `55db44b` (1.1.35), `06e70fc` (1.1.33), geradas por `git archive` **do meu clone** para `/private/tmp/audita-review-140/gen/<rev>` e conferidas por `manifest.json` |
| Frase de independência | **Todas as medições foram feitas por mim, na minha raiz, com código meu. Quando o número do autor não reproduziu, o valor medido está no lugar do declarado. Nenhuma sonda do autor foi usada como prova; o harness de Chrome é o suporte de E2E do próprio produto, usado como mecanismo, com fixture e asserções minhas.** |

---

## 1. Veredito por alegação

| # | Alegação | Comando (resumo) | Resultado medido | Veredito |
|---|---|---|---|---|
| 1a | **Critical da 1.1.39 fechado** — `senhaassinatura:`/`chavepix:`/`Chavepix:`/`CHAVEPIX:`/`senhawhatsapp:`/`tokenchat:` com valor fraco ou forte não chegam ao modelo nem aos artefatos | E2E próprio, 1 página por forma, Chrome real, bytes empacotados: `probes/e2e-casos-140.test.mjs` (16 casos) + `probes/surfaces-140.mjs` (30 rótulos × 4 valores em 10 superfícies) | No caminho de PROSA/MODELO/TRECHO/NOME ACESSÍVEL: **0 vazamentos nas 96 combinações de rótulos de credencial** (24 rótulos × 4 valores) — nenhum rótulo de credencial aparece nessas superfícies; 72 dessas 96 ainda vazam nas superfícies de CHAVE; as 24 combinações das 6 palavras legítimas preservam o valor por desenho; E2E c02/c03/c07–c13 = `VAZA_EM=(nenhuma)` com `[redacted]` em modelo/html/json; controle de captura c01 aparece em modelo+html+json (medida **não vacuosa**). **FECHADO de fato, ponta a ponta** | **CONFIRMADO** |
| 1b | Mesmo eixo em **nome de atributo** (id/classe) e nas **chaves JSON/URL** | E2E `probes/key-axis-140.test.mjs` (1.1.40 e 1.1.39), `probes/key-path-e2e.test.mjs`, `node probes/key-path-140.mjs` | `<div id="senhaassinatura">borboleta</div>`, `<div id="chavepix" title="girassol">`, `<div class="senhaassinatura">borboleta</div>` → valor **em modelo, HTML e JSON** (`VAZA_EM=modelo,html,json`), seletor emitido `div#senhaassinatura`; idêntico na 1.1.39 (resíduo pré-existente, **não** regressão). No nível de predicado/função, `sanitizeJsonData({senhaassinatura:'borboleta'})`, `sanitizeEvidenceUrl('…?senhaassinatura=borboleta')` e `normalizeSnapshot` de `data-senhaassinatura`/`data-chavepix` **preservam o valor na 1.1.40 e tarjavam na 1.1.39** | **REFUTADO** (na literalidade "em nenhuma variante … nome de atributo") |
| 2a | Dicionário: `trim`+`toLowerCase`+`Set`, minúsculas 3+ = **234.289** | `node probes/dict-140.mjs`, `evidence/dict-variants.txt` | `len>=3` dá 234.291; **`/^[a-z]{3,}$/` dá exatamente 234.289** (as duas entradas a mais são `jean-christophe` e `jean-pierre`) | **CONFIRMADO** |
| 2b | `prefixo curto + radical longo + cauda` custa **35 palavras inglesas e zero portuguesas** | Reconstrução **minha** da regex (prefixo 1–3 + radicais ≥5 + cauda 2–24) sobre o dicionário | **35 palavras, exatamente a lista declarada** (`asecretory … unsecretness`). A metade "zero portuguesas" **não pôde ser medida**: não há léxico português nesta máquina (`/usr/share/dict` só tem `web2`, inglês; `/System/Library/Spelling` ausente) | **PARCIAL** |
| 2c | Lista de exceções cobre as palavras da língua ("MENOS 22") | `node probes/fp-140.mjs`, `node probes/dict-140.mjs`, E2E `probes/e2e-casos-140.test.mjs` (c15) | `isPermissiveCredentialLabel` aceita **563** palavras minúsculas 3+ do dicionário; **todas as 563** tarjam valor fraco em posição de atribuição. A lista de exceções tem 57 entradas (22+35). FPs **novos e destrutivos** medidos: `O pallbearer carregava o caixão` → `O [redacted]`; **20 de 39** frases de morfologia portuguesa destruídas (`Chaveiros`, `Pinturas`, `Pincéis`, `Pingentes`, `Pinguins`, `Secretarias`, `Secretários`, `Tokenizadores`, `Tokenização`, `Obsessões`, `Possessão`…). **Confirmado ponta a ponta em Chrome real** (c15): `A loja vende chaveiros personalizados.` vira `A loja vende [redacted]` no **modelo, no HTML e no JSON entregues** | **PARCIAL / ACHADO NOVO (Important)** |
| 3 | **I1 fechado** — 1/34 nas três superfícies (chave JSON, consulta de URL, nome de atributo), contra 22/34 na 1.1.39 e 1 na 1.1.38 | `node probes/i1-chaves-140.txt` (corpus de 34 palavras do revisor da 1.1.39, medido por mim) | **1/34** nas três (a única é `sessao`); 1.1.39 = **22/34**; 1.1.38 = **1/34** → o número declarado reproduz. Porém, no lado CREDENCIAL os mesmos predicados **perderam** cobertura vs 1.1.39 (ver Achado I-2), e a superfície de **trecho entregue** continua descartando **22/34** atributos legítimos `data-<palavra>` em todas as gerações (1.1.38 inclusive) | **CONFIRMADO** (com ressalvas medidas) |
| 4 | **I2 fechado** — `COBERTURA_PERDIDA=0 / GANHA=0` em **516.235** formas | `node probes/coverage-declared.mjs` (universo reconstruído do zero: radicais × conectores De/Da/Do × caudas + prefixos × radicais × caudas, vocabulário 1.1.39∪1.1.38) | `UNIVERSO=516235` **exato**; vs 1.1.39: **PERDIDA=0**, **GANHA=5.661**; vs 1.1.38: **PERDIDA=0**, **GANHA=30.550**. Todas as ganhas são a família `prefixo+Oauth+cauda` (`userOauthId`…) — recuperação, não regressão | **PARCIAL** (PERDIDA=0 e o universo confirmados; **GANHA=0 REFUTADO**) |
| 5a | **I3** — caudas realistas no caminho MODELO **383 → 86**, e **0** das 86 coberta na 1.1.36 | `node probes/i3-140.mjs` (corpus **meu**: 16 radicais × 55 caudas realistas = **880 formas**, valor `borboleta`) | 1.1.40 = **0** vazamentos; 1.1.39 = **576**; 1.1.38/1.1.37/1.1.36 = **768**. No corpus meu o resíduo é **zero** (melhor que o declarado). `codigo*`/`conta*` medidos à parte (`evidence/codigo-conta-140.txt`): **119/120 vazam na 1.1.40 e também na 1.1.39/1.1.38/1.1.36**, e **0** eram cobertos na 1.1.36 — a declaração ("radicais fora do vocabulário de propósito, 0 cobertos na 1.1.36") **bate** | **CONFIRMADO** (números do autor são de outro corpus; o sentido se reproduz) |
| 5b | **I3** — caçador adversarial **211 → 124** de 1.080 | `node probes/i3-140.mjs` (corpus **meu**: 96 rótulos × 3 valores × 6 superfícies = **1.728 casos**) | 1.1.40 = **336**; 1.1.39 = **384**; 1.1.38 = 768; 1.1.36 = 416; 1.1.33 = 96. Por superfície (1.1.40 vs 1.1.39): prosa **0 vs 168**, modelo **0 vs 168**, trecho 0/0, **chave JSON 168 vs 24**, **URL 168 vs 24**, aria 0/0 → o resíduo **mudou de lado**, para as chaves | **PARCIAL** (o total melhora; a composição regride nas chaves) |
| 5c | Resíduos declarados (`api.key`, `private_key`/`privatekey`, `chave·de·api`, separadores `·`/`\|`/`+`, rótulos codificados na prosa, rótulo+valor em nós irmãos) | `node probes/residuos-140.mjs` | **Todos abertos** na 1.1.40 exatamente como declarado: `api.key`/`private_key`/`privatekey` abertos em prosa+modelo+trecho+json+url; `chave·de·api`, `chave\|de\|api`, `chave+de+api` abertos em prosa/modelo/trecho; `<p>senha</p><p>borboleta</p>` e `<th>chave</th><td>borboleta</td>` intactos; entidade/percent no caminho de prosa abertos (`sen&#104;aassinatura`) | **CONFIRMADO** (declarados e medidos) |
| 6 | Métrica: `formas=92 fracos=72 combinações=559`, 0 vazamentos, com dentes | `node --test test/core/credential-class-metric.test.js` na raiz 1.1.40 e em `mut-746a696`/`mut-733cd01` (o **mesmo** arquivo de teste sobre o `src` antigo) | 1.1.40: **8/8**, `formas=92 fracos=72 combinações=559`, `combinações=72 vazamentos=0`. vs **1.1.39**: **7/8** — reprova "nenhuma forma de credencial sobrevive em nenhum dos quatro caminhos" (o eixo do Critical). vs **1.1.38**: **6/8** — reprova o mesmo + "palavra da língua com radical curto embutido". **Não é vacuosa** | **CONFIRMADO** |
| 7a | Fase paralela **4.221 / 4.220 passam / 0 falham / 1 pulado**, EXIT=0 | `node probes/run-parallel.mjs` (plano do próprio runner, 181 arquivos; raiz com `.git` para o teste de baseline) | `tests 4221 / pass 4219 / fail 1 / skipped 1`, **EXIT=1**. A única falha é `test/export/report-export.test.js` ("adopts a valid reservation committed after the primary timeout…", `'rejected'` vs `'fulfilled'`) e **passa isolada** (`--test-name-pattern`, 1/1) → flake de tempo sob carga, não defeito do produto | **PARCIAL** (números batem a menos do flake) |
| 7b | Escopo serial de 11 arquivos: **52/52** | `probes/serial-scope.sh` (Chrome real, `--test-concurrency=1`), **duas execuções** | As duas rodadas: `tests 52 / pass 51 / fail 1` — a falha é sempre o **hook de limpeza** de `axe-mv3-csp` (`cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]`), nunca uma asserção de produto; em isolamento o arquivo **passa 1/1** numa execução e falha 1/2 (mesmo hook) | **PARCIAL** (flake de ambiente; nenhuma falha funcional) |
| 7c | Gate GREEN `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` | mesmo comando na raiz | exit **0**: "manifest/CSP e axe 4.13.0 aprovados…; mapa numerado aprovado; **130/146 (96/50)**, identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN" | **CONFIRMADO** |
| 7d | Auditoria ao vivo no Google (0 falhas, 1 alerta, 3 suspeitas, 9 positivos, 109 no checklist, 28,5%, 9,0/10, PDF 18 páginas, 146/146 ids e títulos, notas 5/5, 0 palavras partidas, 0 `[redacted]`) | `probes/live-google-140.test.mjs` + `probes/live-artifacts-140.mjs` + `probes/pdf-check.py` sobre os bytes empacotados | Modelo: **146** `itemResults`, **134** `ruleResults` (96 `cantTell`, 28 `inapplicable`, **1** `failed`, **9** `passed`), 11 evidências. HTML: contadores **"Falhas: 0" / "Recomendações e alertas: 1" / "Suspeitas a confirmar: 3" / "Resultados positivos: 9"**, **109** perguntas de checklist, **147** linhas de matriz (146+header), **146/146** ids e títulos, índice **9,0**, cobertura **28,5%**, **0** `[redacted]`. PDF: **18 páginas**, **146/146** ids e títulos (após normalizar espaços), **5/5** notas editoriais, **0** `[redacted]`, **0** palavra partida (23 quebras em hífen são todas legítimas: URLs, `aria-controls`, `nth-of-type`, ids). Notas: **5/5** também no HTML | **CONFIRMADO** |
| 7e | E2E do revisor anterior (`fixture-lower-e2e`) com S1/S2 = false nas cinco superfícies | meu E2E por caso (`probes/e2e-casos-140.test.mjs`, c02 = `senhaassinatura: borboleta`) | `[redacted]` presente em modelo/html/json; sentinela ausente em painel, modelo, relatório, HTML, JSON e CSV; 4 downloads `complete`; PDF sem o trecho da página (superfície vacuamente limpa) | **CONFIRMADO** |
| 8 | Critérios da entrega: 146 itens (96+50), identidade neutra, sem Web Store/`update_url`, separação falhas/suspeitas/checklist, texto que nega certificação, axe do produto sem violação | `node probes/delivery-140.mjs`; `verify-project`; saída do serial | **146** itens = **96 `requirement` + 50 `recommendation`**, 146 ids únicos, 0 títulos vazios, **5** notas; `manifest.json` sem `update_url`/`key`/Web Store, nome "Audita Acessibilidade"; identidade do relatório `{name:"Audita Acessibilidade", independent:true, disclaimer:"…não equivale a certificação nem a laudo oficial"}`; 0 identidade pessoal em `src`+`vendor`+manifest (só a URL do axe no vendor); HTML entregue nega certificação ("não é nota, certificação ou declaração de conformidade", "O índice não é certificação", "aprovação neste teste não certifica a página inteira"); axe do produto: `PAINEL-INICIAL` 0 violações/0 incompletos, `PAINEL-RESULTADO` 0/0, `RELATORIO-ABA` 0 violações/**1** incompleto (`color-contrast`) | **CONFIRMADO** (a 4ª superfície, o HTML exportado, não foi medida sob axe) |

---

## 2. Achados por severidade

### CRITICAL

**Nenhum achado novo Critical.** O Critical da 1.1.39 (rótulo minúsculo com cauda fora da lista no
caminho de prosa/modelo) está **fechado de fato**, medido ponta a ponta por mim em Chrome real, com
controle de não vacuidade (`evidence/e2e-casos-140.txt`): c01 (texto de controle) aparece em
modelo+html+json; c02/c07/c08/c09/c10/c11/c12/c13 não aparecem em superfície nenhuma e o `[redacted]`
aparece no modelo/HTML/JSON. As 30 formas do meu corpus adversarial (cauda nova, dígito na cauda,
radical no meio, prefixo curto, separadores, caixa mista, entidade, invisível) também fecham no
caminho de prosa (96 combinações de rótulos de credencial, 0 vazamentos nessas superfícies).

### IMPORTANT

#### I-1 — O eixo de IDENTIFICADOR (id/classe) entrega o valor fraco ao modelo, ao HTML e ao JSON
**Reprodução mínima (Chrome real, bytes empacotados, `probes/key-axis-140.test.mjs`):**
```
AUDITA_E2E_CHROME="…/Google Chrome for Testing" AUDITA_EXT_PATH=/private/tmp/audita-review-140/root \
  AUDITA_EXT_TAG=1.1.40 node --test --test-concurrency=1 probes/key-axis-140.test.mjs
```
| caso | fixture | resultado |
|---|---|---|
| a03 | `<div id="senhaassinatura">borboleta</div>` | **VAZA_EM=modelo,html,json**; `[redacted]`=0 |
| a04 | `<div id="chavepix" title="girassol">Texto innocuo.</div>` | **VAZA_EM=modelo,html,json**; snippet entregue `<div id="chavepix" title="girassol">` |
| a05 | `<div class="senhaassinatura">borboleta</div>` | **VAZA_EM=modelo,html,json** |
O seletor é emitido como `div#senhaassinatura`/`div#chavepix` (`node probes/key-path-140.mjs`), enquanto
`chaveDeApi` (lista fechada) vira `div`. A 1.1.39 medida do mesmo jeito dá **exatamente o mesmo
resultado** → é resíduo **pré-existente**, que a 1.1.40 **não** fechou. O predicado que decide os
identificadores (`isSensitiveKeyName`) devolve `false` para `senhaassinatura`, `chavepix`,
`senhaassinatura2`, `xchavepix` e todas as variantes de caixa, enquanto
`isSensitiveKey`/`isPermissiveCredentialLabel` devolvem `true` (`evidence/surfaces-140.txt`).

**Impacto.** Uma página que escreve o rótulo da credencial no `id`/`class` do elemento (ou no `name` de
um campo) e o valor no texto/atributo irmão entrega o valor ao modelo guardado e aos artefatos
HTML/JSON — a mesma classe do C1, em outra posição sintática. O `data-*` correspondente é descartado
(`PRIVATE_ATTRIBUTE` usa o vocabulário permissivo), mas `id`/`class`/`name` são preservados de propósito
e o valor vizinho não é tarjado.

**Lado privilegiado.** O vocabulário de identificador ficou deliberadamente fechado para não destruir
`pintura.png`/`secretaria-saude`; o preço é a cauda fora da lista continuar invisível nessa posição.

#### I-2 — Regressão de cobertura nas CHAVES introduzida pela própria 1.1.40 (latente nos artefatos)
A troca de `isSensitiveAssignedKey` por `isSensitiveKeyName` (commit `6a3856b`) fechou o FP de 22/34,
mas **retirou** a cobertura permissiva das três superfícies de chave. Medido com o caminho real do
produto (`node probes/key-path-140.mjs`):
```
senhaassinatura  1.1.40 normalize={"senhaassinatura":"borboleta"}   1.1.39 {"senhaassinatura":"[redacted]"}
chavepix         1.1.40 normalize={"chavepix":"borboleta"}          1.1.39 {"chavepix":"[redacted]"}
data-chavepix    1.1.40 normalize={"data-chavepix":"borboleta"}     1.1.39 {"data-chavepix":"[redacted]"}
```
e no nível de superfície: `sanitizeJsonData({senhaassinatura:'borboleta'})` mantém **chave e valor**
(1.1.39 tarjava), `sanitizeEvidenceUrl('…?senhaassinatura=borboleta')` mantém o parâmetro (1.1.39
removia), e no caçador a contagem por superfície foi `chave JSON 24 → 168` e `URL 24 → 168`
(`evidence/i3-140.txt`).

**Impacto.** É uma perda de cobertura real em código de produto, na mesma família do C1. **Não consegui
demonstrá-la nos artefatos entregues**: o mapa de atributos dos nós de evidência não chega ao modelo
guardado (`b01`/`b02` = `VAZA_EM=(nenhuma)`, nenhum `"attributes"` no snapshot), a URL auditada é
normalizada sem consulta (`finalUrl` sem `?senhaassinatura=`) e URLs de recurso perdem a consulta por
construção. Fica como regressão **latente** (Important), não como vazamento entregue.

**Reprodução:** `node probes/key-path-140.mjs` e `node probes/i3-140.mjs`.

#### I-3 — Falsos positivos destrutivos FORA da lista de 22 palavras declarada
A 1.1.40 declara "as 22 palavras da língua medidas". A medição do dicionário inteiro
(`node probes/dict-140.mjs`) mostra que o vocabulário permissivo aceita **563** palavras minúsculas 3+,
e **todas as 563** tarjam um valor fraco em posição de atribuição. Exemplos claramente inocentes que
destroem prosa (`node probes/fp-140.mjs`):
```
O pallbearer carregava o caixão                  -> O [redacted]            (modelo, trecho e prosa)
A loja vende chaveiros personalizados.           -> A loja vende [redacted] (modelo, trecho e prosa)
As pinturas ficaram prontas.                     -> As [redacted]
Os pincéis são finos.                            -> Os [redacted]
A secretaria respondeu.                          -> A [redacted]
```
**20 de 39** frases de morfologia portuguesa (plurais e derivados das próprias palavras excepcionadas:
`Chaveiros`, `Chaveirinho`, `Chaveirões`, `Pinturas`, `Pintores`, `Pincéis`, `Pincelzinho`,
`Pingentes`, `Pinguins`, `Secretarias`, `Secretários`, `Tokenizadores`, `Tokenização`, `Obsessões`,
`Possessão`) são destruídas. No lado inglês, `cupbearer`, `pallbearer` e `chipping` são destruídos
inclusive nas chaves JSON/URL (3/55 no meu corpus, contra 1/34 no corpus do autor).

**Impacto.** Perda de evidência no relatório (o texto do autor vira tarja) na mesma classe que a 1.1.40
diz ter resolvido com a lista de exceções; a lista cobre o que os revisores mediram, não a classe.
**Provado ponta a ponta** em Chrome real nos bytes empacotados (c15 de
`evidence/e2e-casos-140.txt`): a fixture `<p>A loja vende chaveiros personalizados.</p>` chega ao
entregue como `<p>A loja vende [redacted]</p>` (snippet no modelo, no HTML e no JSON, com
`redacted={modelo:2, html:1, json:2}`), enquanto os controles `Chaveiro: R$ 30,00` (c14) e
`Pintura: látex acrílico` (c16) são preservados.
**Lado privilegiado.** Recall sobre precisão: qualquer palavra que contenha um radical em posição
permissiva é tratada como rótulo de atribuição.

### MINOR

- **M-1 — `GANHA=0` não reproduz.** Universo de 516.235: `PERDIDA=0` (confirmado) e `GANHA=5.661`
  contra a 1.1.39 (`evidence/coverage-declared-universe.txt`). A direção é favorável (recuperação da
  família `prefixo+Oauth+cauda`), mas o número declarado está errado.
- **M-2 — Superfície de TRECHO ainda descarta 22/34 atributos legítimos.** `sanitizeHtmlSnippetSource`
  remove `data-chaveiro`, `data-pintura`, `data-tokenizacao`… em **todas** as gerações medidas
  (1.1.38 inclusive). O "1/34 no nome de atributo" do autor vale para o mapa de atributos do nó
  normalizado, não para o trecho entregue (`evidence/i1-chaves-140.txt`).
- **M-3 — Fase paralela com 1 falha de timing** em `test/export/report-export.test.js`, que passa
  isolada (1/1). O autor declara 0 falhas; eu meço 1, atribuível a carga, com a reprodução isolada.
- **M-4 — `axe-mv3-csp` falha de forma intermitente no hook de limpeza** (`stage:"profile"`,
  `code:"failed"`), não em asserção de produto: **2 de 2** execuções do escopo serial (51/52 nas duas)
  e **1 de 2** execuções isoladas (a outra passa 1/1). O autor declara 52/52.
- **M-5 — PDF não carrega o trecho da página** no meu E2E de fixture (12–13 páginas, 0 sentinelas
  inclusive o controle de captura): a superfície PDF é **vacuamente limpa** para esse teste; a limpeza
  do PDF só é informativa na auditoria ao vivo (onde reproduzi 18 páginas, 146/146 ids/títulos, 0
  `[redacted]`, 0 palavra partida).

### OBSERVAÇÕES

- **O-1 — "Zero portuguesas" não é verificável nesta máquina**: não há léxico português
  (`/usr/share/dict` só tem `web2`; `/System/Library/Spelling` ausente). Medi as 35 palavras do
  dicionário inglês e confirmei a lista exata; a metade portuguesa ficou **NÃO MEDIDA**.
- **O-2 — `isPermissiveCredentialLabel` é uma allowlist de 57 palavras** (22+35) sobre uma classe de
  563 no dicionário inglês; a asserção da métrica percorre a lista, mas a lista não percorre o
  dicionário — ampliar o radical sem ampliar a lista reabre o FP destrutivo.
- **O-3 — `id`/`class`/`name` são explicitamente preservados** no trecho
  (`['id','name','autocomplete']`) mesmo quando o **valor** do atributo é um rótulo de credencial
  (`id="senhaassinatura"`), e o `value` de campo editável segue privado (b06 = sem vazamento).
- **O-4 — Nenhuma forma de credencial foi encontrada no HTML/PDF/JSON ao vivo do Google** (0
  `[redacted]` e nenhuma sentinela), o que é consistente com uma página que não expõe credencial; a
  varredura de credencial do artefato ao vivo é, portanto, pouco informativa — os E2E de fixture é que
  têm dentes.

---

## 3. O que eu tentei para reabrir cada item declarado como fechado

| Item declarado | Tentativa de reabertura | Resultado |
|---|---|---|
| C1 (cauda fora da lista, prosa) | 30 rótulos × 4 valores em 10 superfícies de módulo; E2E com 16 fixtures de 1 forma cada; cauda com dígito (`senhaassinatura2`), cauda longa (`chavepixcobranca`), radical no meio (`minhasenhaassinatura`), prefixo curto (`xchavepix`), separadores `-`, `.`, `_`, caixa mista, entidade `&#104;`, invisível `\u200b`, rótulo partido em `<b>` e em nós irmãos | **Fechado no caminho de prosa/modelo/trecho/nome acessível.** Reaberto **só** pela via do identificador (I-1) |
| I1 (preço nas chaves) | Corpus de 34 palavras do revisor anterior + 55 palavras minhas (dicionário) + corpus PT de morfologia | 1/34 confirmado nas três superfícies; **FP residual medido**: 22/34 no trecho entregue (M-2), 3/55 no meu corpus (I-3) |
| I2 (cobertura 516.235) | Universo reconstruído do zero e comparado com 1.1.39 e 1.1.38 | `PERDIDA=0` ✓, `GANHA=0` ✗ (5.661) |
| I3 (caudas realistas / caçador) | Corpus próprio de 880 formas realistas e 1.728 casos adversariais; `codigo*`/`conta*` medidos à parte em 4 gerações | Sentido confirmado; **composição regrediu nas chaves** (168 vs 24) |
| Métrica com dentes | Mesmo arquivo de teste sobre o `src` de 1.1.39 e 1.1.38 | 7/8 e 6/8 — **não vacuosa** |
| Fase paralela / serial | Plano real do runner com `.git` presente; escopo serial em Chrome real, mais reexecuções isoladas | 4.219/1/1 e 51/52 — as duas únicas vermelhas passam isoladas (flakes) |
| Entrega (146 itens, identidade, `update_url`, certificação, axe) | Medição direta do módulo, do manifest, do HTML entregue e do axe do produto | Tudo confirmado; a 4ª superfície (HTML exportado sob axe) não medida |
| Auditoria ao vivo | Execução própria em `https://www.google.com/`, análise própria de HTML/JSON/CSV/PDF | Todos os números reproduzidos |

---

## 4. O que NÃO foi medido (declarado como limite desta revisão)

1. **"Zero palavras portuguesas" no preço do prefixo** — sem léxico PT na máquina (O-1).
2. **A 4ª superfície do axe** (o HTML exportado do relatório sob axe-core) — medi painel inicial,
   painel de resultado e relatório em aba (0/0, 0/0, 0 violações + 1 incompleto de contraste).
3. **Alcance em artefato da regressão I-2** — medi no predicado e no `normalizeSnapshot`, não em
   entrega; os caminhos que testei (atributos de nó de evidência, URL de recurso, URL auditada) não
   transportam o valor.
4. **Flakiness sob carga** (as duas falhas intermitentes não foram caracterizadas além da reprodução
   isolada).
5. **PDF como superfície de dentes no E2E de fixture** — o PDF não carrega o trecho do `<main>`
   (M-5); só a auditoria ao vivo o exercita.
6. **Outras superfícies do produto** (pixels, lote, personas, exportação por URL, IndexedDB) fora do
   escopo do incremento — a fase paralela e os 11 arquivos seriais as tocam, mas não medi cada uma.

---

## 5. Veredito final

# REPROVADO — para o escopo desta revisão

O incremento **fecha de fato o Critical da 1.1.39 no caminho de prosa/modelo** (medido ponta a ponta,
com controle de não vacuidade) e é **estritamente melhor que a 1.1.39** nesse eixo e no preço das
chaves legítimas (1/34 nas três superfícies). Mas as alegações como escritas **não resistem** a três
medições independentes:

1. **A mesma família de rótulo continua entregando valor fraco ao modelo e aos artefatos quando o
   rótulo está num IDENTIFICADOR (`id`/`class`) e o valor no texto/atributo vizinho** — medido em
   Chrome real, `VAZA_EM=modelo,html,json`, idêntico na 1.1.39 (pré-existente, Important, I-1).
2. **`COBERTURA_GANHA=0` é falso**: no mesmo universo de 516.235 formas a 1.1.40 ganha 5.661 formas
   contra a 1.1.39 (e 30.550 contra a 1.1.38) — direção favorável, número errado (M-1).
3. **A 1.1.40 introduz uma perda de cobertura nas chaves** (JSON/URL/atributo normalizado) para a
   própria família do C1, ao trocar o predicado; não consegui demonstrá-la em artefato entregue, mas a
   regressão existe no código de produto e no caçador (24 → 168 por superfície) (I-2).

Some-se a isso que a lista de exceções declarada ("22 palavras") não cobre a classe medida (563
palavras do dicionário; 20/39 frases de morfologia PT destruídas) — Important I-3.

**Isto é uma revisão de escopo: a 1.1.40 não é aprovação de todo o produto.** Fase paralela, escopo
serial, gate de release, auditoria ao vivo, 146 itens e identidade neutra se reproduzem (com dois
flakes de ambiente); o caminho de prosa do Critical está fechado. O que reprova é a literalidade das
alegações 1 (eixo de identificador), 4 (GANHA=0) e o preço declarado do lado permissivo.

**Evidências:** `/private/tmp/audita-review-140/evidence/` (bruto) e
`/private/tmp/audita-review-140/artifacts/` (HTML/JSON/CSV/PDF e snapshots do E2E e do Google).
