# Revisão adversarial independente — Audita Acessibilidade 1.1.22

Delta `2e2fdfb..a278859` (um commit), checkout congelado `/private/tmp/audita-review-122`,
artefato `release/audita-acessibilidade-1.1.22.zip`. Scratch: `/private/tmp/adv122`.
Ambiente: Chrome for Testing 152.0.7977.64 (`/private/tmp/audita-cft152-fixed/...`), um workload de
Chrome por vez, perfil temporário isolado, `--password-store=basic --use-mock-keychain`,
`downloadMode: 'profile'`. Nada no checkout congelado foi modificado (`git status --porcelain`
devolve só `?? node_modules`, o symlink não ignorado — ver N7).

---

## 1. Veredito

**A 1.1.22 pode substituir a 1.1.21 como candidata. 0 Critical, 0 Important, 4 Minor.**

Os três Minors que o incremento se propôs a fechar estão fechados, medidos nos bytes empacotados e
não na árvore:

| Afirmação | Resultado |
|---|---|
| Cláusula em linguagem simples no HTML **e** no PDF entregue, derivada do código | **REPRODUZIDO** (PDF entregue: `Limitações registradas (6) · Modo sem imagens: nenhuma captura raster. · Observação passiva: …`, 6 `<li>`) |
| Cabeçalho do anexo sem quebra de palavra (3 → 0) | **REPRODUZIDO** (1.1.21: 3 × `Evidênc`/`ia`; 1.1.22: **0** no documento inteiro) |
| Guarda de impressão não vacuosa | **REPRODUZIDO**, e mais forte do que a alegação: pega também regra presente-mas-ineficaz |
| Proveniência na seção 6 dos dois renderizadores | **REPRODUZIDO** (método, viewport, ledger com arquivo+SHA-256, 5 notas) |

Nenhum defeito de produto novo foi encontrado no artefato entregue. Os quatro Minors são: um de
consistência interna (N1, cláusula vs lista por fontes diferentes, não alcançável no produto), dois
de alcance de guarda/cobertura (N2 impressão da própria aba; N3 oráculo de largura não derivado de
`@page`) e um de documentação (N4, cinco frases). N5, N6 e N7 são observações. **Nada é bloqueante**:
todos os Minors ou são frases que a medição não sustenta como escritas, ou são superfícies que o
incremento não alegou cobrir, ou são buracos de guarda para mudanças futuras.

Números por severidade: **Critical 0, Important 0, Minor 4** (N1 cláusula vs lista por fontes
diferentes; N2 impressão da própria aba continua partindo palavra; N3 oráculo de largura do E2E não
deriva de `@page`; N4 frases remanescentes em `LEIA-ME.md`, `estado-dos-criterios:25`,
`triage:19`, `registro:74`, `README:28`; N5/N6 observações; N7 higiene do checkout).

---

## 2. Artefato

| Verificação | Comando | Resultado |
|---|---|---|
| Digest | `shasum -a 256 release/audita-acessibilidade-1.1.22.zip` | `c2d6c44d02dec5c1f0e3081c50633cc61232dbd38bca0dbc9ba06579be5951b5` — **confere** |
| Entradas | `unzip -Z1 … \| wc -l` · `\| head -1` | **199** arquivos; primeira entrada `manifest.json` |
| Manifesto interno | `cat manifest.json` do zip extraído | `manifest_version 3`, `version 1.1.22`, `version_name 1.1.22`, `minimum_chrome_version 116` |
| Composição | `find` na extração | `src/` 191, `vendor/` 3, `assets/icons/` 4, `manifest.json` — exatamente a lista fixa de `scripts/build-release.mjs` |
| Pacote → árvore | `cmp` arquivo a arquivo contra `git archive a278859` | 199/199 idênticos; nenhum arquivo do pacote ausente da árvore |
| Árvore → pacote | `TMPDIR=/tmp node scripts/build-release.mjs --temporary-release-directory /tmp/audita-release-test-adv122` | reconstrução **reproduz o mesmo digest** `c2d6c44d…5951b5` |
| `release-package` | `node --test test/release-package.test.js test/extension-shell.test.js` (clone com `.git`) | **12/12 passam**, 0 falham, 0 pulados |

O pacote é, byte a byte, o subconjunto empacotado da árvore revisada, e a árvore reconstrói o
artefato entregue — a corrente entre árvore e zip está fechada nos dois sentidos.

---

## 3. Alegações 1–7

### 3.1 Cláusula em linguagem simples no entregue — **REPRODUZIDO**

Driver próprio `drivers/adv-live-122.mjs` sobre `/private/tmp/adv122/pkg` (zip extraído **com
`test/` e `fixtures/` copiados**, como instruído), auditoria real de `https://www.google.com/` em
modo sem imagens, quatro downloads completos (HTML 339.244 B, PDF 1.002.952 B, CSV 86.142 B,
JSON 374.212 B).

Aba interativa (DOM ao vivo):

```
Limitações registradas (6) · Modo sem imagens: nenhuma captura raster. · Observação passiva: sem testes interativos de teclado, redimensionamento e movimento.
itemCount 6 · distinctItems 6 · headlineCount 6
```

Bytes entregues (HTML e PDF do mesmo run):

| Medida (texto com espaços normalizados) | HTML entregue | PDF entregue (18 pág., A4 594,96×841,92 pt) |
|---|---|---|
| `Limitações registradas (6) · Modo sem imagens… · Observação passiva…` | 1 | 1 |
| `Modo sem imagens: nenhuma captura raster.` | 1 | 1 |
| `Observação passiva: sem testes interativos de teclado, redimensionamento e movimento.` | 1 | 1 |
| `<li>` dentro de `[data-report-limitations]` / itens da lista no texto do PDF | **6** | **6** (as 6 entradas presentes, incluindo as duas codificadas) |
| frase simples (a do diagnóstico) fora da entrada codificada | 0 | 0 |

O número entre parênteses continua sendo o número de itens da lista: `(6)` = 6 `<li>` no HTML e 6
itens no PDF, e a cláusula **não** entra na contagem.

**Caso negativo (quando o diagnóstico não existe):** com a fixture servida (`SAMPLE_AUDIT`, cujo
único diagnóstico é `DYNAMIC_PROBES_INCOMPLETE`, que não gera cláusula),
`projectLimitationClauses` devolve `[]`; a folha de impressão entregue tem **0** ocorrências das
duas cláusulas e o cabeçalho é `Limitações registradas (4)`; os PDFs gerados dessa folha
(`out/ab-V122.pdf`, `out/pagina-estreita.pdf`) também têm **0** ocorrências das duas cláusulas.

A derivação por **código** também foi exercitada diretamente: `PIXEL_CAPTURE_OMITTED` →
`['Modo sem imagens: nenhuma captura raster.']`; `DYNAMIC_PROBES_OMITTED_PASSIVE` → cláusula
passiva; `DYNAMIC_PROBES_INCOMPLETE` → `[]`; código só em `pages[].diagnostics` → cláusula
presente (ver N1).

### 3.2 Cabeçalho do anexo inteiro — **REPRODUZIDO**

Detector próprio `detect_breaks2.py` (pypdf; vocabulário do HTML entregue **mais** a fonte
empacotada, para cobrir literais que só existem na impressão; dois sinais independentes: fragmento
final de linha + continuação que formam palavra do vocabulário, e contagem literal sem vocabulário).
Par medido: mesmo fluxo ao vivo, PDF entregue da 1.1.21 (`/private/tmp/adv121/artifacts-121-own`) e
da 1.1.22 (meu run).

| PDF entregue | páginas | páginas de anexo | quebras no meio de palavra (documento inteiro) | `Evidênc` sem `ia` | `Evidência` íntegra |
|---|---|---|---|---|---|
| 1.1.21 | 17 | 3 | **3** — todas `Evidênc`/`ia` | 3 | 0 |
| 1.1.22 | 18 | 2 | **0** | 0 | 2 |

Palavra e célula: `Evidência`, na célula de cabeçalho (`thead th`, 1ª coluna — "Evidência") da
tabela de anexos de evidências, uma vez por página de anexo. Nenhuma outra palavra foi partida; o
scan adversarial de fragmentos finais de linha com 4+ letras fora do vocabulário devolveu **0**.

Sem corte nem transbordo: com a geometria calculada com a CTM aplicada, em todas as 18 páginas o
texto fica em x ∈ [42,75; 543,41] pt, dentro da caixa de conteúdo [42,52; 552,44] pt; a matriz mede
678 px e a tabela de anexo 680 px (== largura de conteúdo) na folha de impressão, com **0** células
transbordando e **0** células com conteúdo cortado (`scrollWidth > clientWidth`).

Efeito colateral medido da regra nova (não declarado, benéfico): `thead th{overflow-wrap:normal}`
também governa a **matriz**, porque impede a coluna "Classificação" de encolher abaixo da própria
palavra do cabeçalho. No A/B sobre o mesmo modelo e o mesmo HTML: com a regra de cabeçalho, remover
a regra da matriz não muda nada (tabela 6.172,56 px, 0 quebras); sem a regra de cabeçalho, a mesma
remoção leva a tabela a 7.226,97 px e devolve as **50** quebras de `Recomendação`. Ver N5.

### 3.3 A guarda nova não é vacuosa — **PARCIAL** (o miolo se sustenta; duas frases não)

**(a) E2E como está:** os seis E2E de Chrome real no pacote passam (6/6, exit 0). O diagnóstico do
próprio teste:

```
print-breaks: matriz=0 quebras, cabeçalhos=0, anexo=3 (tokens longos quebram de propósito), documento=9;
tabela=678px em 680px; forçado com regra=0; forçado sem regra=50; cabeçalho comprimido=1
```

**(b) Produto mutado (regra da matriz removida, hash consistente):** falha. Mutantes construídos com
`drivers/mutate-css.mjs`, que recalcula `REPORT_CSS_CSP_HASH` a partir do **valor do módulo** (não do
texto do arquivo) e verifica `declared === sha256(REPORT_CSS)` — `hashConsistent: true` em todos.

| Mutante | O que muda | E2E |
|---|---|---|
| `drop-matrix-rule` | regra ausente (comportamento de 1.1.20), hash honesto | **falha** — `as duas regras de impressão precisam existir na folha entregue` |
| `override-matrix-rule` | regra presente **literalmente**, com `.matrix-scroll tbody td{overflow-wrap:anywhere}` depois (mais específica) | **falha** — `sob compressão, a regra da matriz precisa continuar mantendo a palavra inteira` |
| `override-head-rule` | regra de cabeçalho presente, com `.report-view-document thead th{overflow-wrap:anywhere}` depois | **falha** — `nenhuma palavra pode ser partida no meio em cabeçalho de tabela` |
| `neuter-head-rule` | regra de cabeçalho trocada por `overflow-wrap:anywhere` | **falha** — asserção de presença da regra |

Ou seja: a guarda pega não só a regra ausente mas também a regra **presente e ineficaz**, que é a
classe de mutação mais difícil. Isso é mais do que a alegação exige.

**(c) Poderia passar medindo tela?** Não pelo oráculo de fonte. Medido com o mesmo `MEASURE` do E2E:
em mídia de tela a célula da matriz fica `16px` e `overflow-wrap:anywhere`; em mídia de impressão
`11.3333px` e `overflow-wrap:normal`. A asserção `|fonte − 11,3333| < 0,1` passa na impressão e
**falha na tela**, então ela discrimina. Não consegui furá-la.
**Mas o oráculo de largura não deriva de `@page`:** `contentWidth` é
`document.documentElement.clientWidth`, isto é, a largura da emulação, não a caixa de impressão.
Com a folha entregue servida com `@page{size:A4 portrait;margin:18mm 30mm 20mm}` (conteúdo 150 mm =
566,9 px), o E2E mede `docWidth = 680` e `tabela = 678 ≤ 681` — **passa** — enquanto o
`Page.printToPDF` real da mesma folha coloca texto até x = 558,57 pt contra a margem direita em
509,92 pt, isto é **48,65 pt (17 mm) dentro da margem**. Hoje isso é inócuo: o `@page` do produto é
A4 com 15 mm laterais (conteúdo 179,89 mm = 679,9 px, medido no PDF entregue), então a constante de
680 px do teste coincide com a realidade. É buraco de guarda para uma mudança futura de `@page`
(N3), não defeito do artefato.

**(d) Depende de conteúdo que não existe no produto real?** Para a perna "folha entregue", sim, no
sentido que o próprio teste declara. A fixture tem **126 de 146** itens "Não aplicável", 50
"Recomendação" e 96 "requisito"; sem compressão injetada, remover a regra da matriz da folha
empacotada deixa a matriz com **0** quebras (medido: `so-cabecalho` → matriz 0, tabela 6.172,56 px),
enquanto o PDF entregue real da 1.1.20 tinha 50. Quem dá dentes ao controle é o `SQUEEZE_MATRIX`
injetado pelo teste (`table-layout:fixed;width:678px` + 3ª coluna de 70 px), que é CSS sintético e
não conteúdo do produto. Além disso, a asserção é `matrixBroken.length > 0`, **não** "50 quebras": o
50 é o valor medido (duas vezes — no E2E e no meu próprio probe), não um requisito. É por isso que
esta alegação fica **PARCIAL**, e não REFUTADA: o mecanismo de guarda funciona (provado em (b)), mas
"exige 50 quebras" e "mede a folha entregue na largura real" não são literalmente o que o código faz.

### 3.4 Proveniência no entregue — **REPRODUZIDO**

Medido no HTML e no PDF da auditoria empacotada (mesmo run ao vivo):

| Item | HTML entregue | PDF entregue |
|---|---|---|
| Fatos de método (`Método:`, `Regras próprias: 130.`, `Regras suplementares: 4.`, `Itens normativos: 146.`) | 1 cada | 1 cada |
| `Viewport observado: 995 × 751 CSS px; escala 1.` | 1 | 1 |
| `Ledger normativo` + 4 itens (ABNT, WCAG 2.2, 2× Section 508) | 1 + 4 `<li>` | 1 + 4 |
| Ledger da ABNT com nome de arquivo **e** SHA-256 (`ABNT-NBR-17225-Acessibilidade-Digital.pdf`, `1c3ee66b…32afc`) | 1 + 1 | 1 + 1 (o nome quebra em hífen na extração: `ABNT-NBR- 17225-…`) |
| `Notas de integridade normativa` + 5 notas | 1 + 5 `<li>` | 1 + 5 (`5.9.1`, `5.9.2`, `5.9.4`, `5.9.17`, `5.12.1`) |
| `Fontes oficiais` (CDC, Decreto) | 2 `<li>` | 2 |

**Não é vazamento novo e não duplica a seção de fontes oficiais.** As duas listas são disjuntas
(ledger = ABNT/WCAG/508; fontes oficiais = Lei 8.078 e Decreto 2.181), o nome do método aparece 1×
em cada artefato, e o ledger não repete a lista oficial. Varredura nos dois artefatos: **0** e-mails,
**0** `/Users/`, **0** `nonce`, **0** `sessionCapabilityId`, **0** `Bearer`. O que entra é o
identificador da auditoria (que já estava no rodapé), o nome local do PDF normativo e o SHA-256 dele
— o esquema fechado do modelo limita `localCopy` a `{fileName, sha256}` (`closed-schema.js:496`),
então nenhum caminho de arquivo pode vazar por ali.

### 3.5 Honestidade das frases — **PARCIAL: as três correções estão certas, cinco frases remanescentes não**

As três frases que a revisão da 1.1.21 refutou **estão corrigidas e a correção se sustenta**:

- (a) "a paginação mudou": reproduzido em A/B controlado sobre o mesmo modelo e o **mesmo HTML**
  (`drivers/ab2.mjs`), com as três CSS reconstruídas por subtração exata das regras do pacote e hash
  recalculado: CSS 1.1.20 → **16 páginas**, matriz **7.226,97 px**, 50 × `Recomendaçã`/`o`; CSS
  1.1.21 → **15 páginas**, matriz **6.172,56 px**, 0 quebras; CSS 1.1.22 → 15 páginas, 6.172,56 px.
  O delta é **−1 página**, como o texto diz. Os absolutos 15/14 do README são do HTML da 1.1.21; no
  HTML da 1.1.22 (que acrescenta a proveniência) o mesmo A/B dá 16/15. Direção e magnitude: certas.
- (b) "0 fragmentos de palavra era escopo de matriz": corrigido, e hoje o documento inteiro mede 0.
- (c) "Minor 5 estava corrigido pela metade": corrigido — a cláusula chega ao HTML e ao PDF.

**Frases remanescentes que a medição não sustenta como escritas** (todas Minor, nenhuma bloqueante):

| Onde | Frase | Medição |
|---|---|---|
| `docs/qa/revisoes/LEIA-ME.md:15` (arquivo não tocado pelo delta) | "o artefato corrente é `release/audita-acessibilidade-1.1.20.zip` … (agora zero, **com a mesma paginação de 18 páginas**)"; "A revisão independente **deste** artefato está em curso" | Falso e obsoleto: o artefato corrente é a 1.1.22, a 1.1.21 já foi revisada (`REVIEW-1.1.21.md` está no mesmo diretório e não tem linha na tabela do LEIA-ME), e "mesma paginação" é exatamente a frase que a 1.1.21 refutou |
| `docs/qa/2026-09-16-estado-dos-criterios-1.1.19.md:25` | bloco da 1.1.20 ainda diz "**56 → 0** … com a **mesma paginação de 18 páginas**" | A frase continua no arquivo; há um aviso de correção na linha 17, mas o texto original não foi reescrito |
| `docs/qa/2026-09-13-continuity-and-e2e-triage.md:19` | "fase paralela da suíte verde na 1.1.22 (**4.180 testes, 4.179 passam**, 1 pulado, 0 falham)" | Medido: **4.181 testes, 4.180 passam, 1 pulado, 0 falham** (4.137 + 44). O total do arquivo é o da 1.1.21: falta contar o teste unitário novo |
| `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md:74` | "a regra nova imprime uma página a menos (**15 → 14**; matriz 7.226,97 → 6.172,56 px)" | As alturas reproduzem exatamente; com o HTML da 1.1.22 o mesmo A/B dá **16 → 15**. Os números 15/14 valem para o HTML da 1.1.21 |
| `README.md:28` | "controles positivos que **falham na CSS da 1.1.20 (50 quebras)** e passam na atual" | Os 50 se reproduzem, mas só sob o `SQUEEZE_MATRIX` injetado; a asserção é `> 0`. Sem compressão, a mesma remoção dá 0 quebras na fixture. O `registro:77` descreve isso corretamente ("sob compressão"); o README não |

Nada mais no `README.md`, em `docs/`, em `store-assets/` ou na mensagem de commit afirma paginação
inalterada, "0 quebras no documento" ou cobertura que a medição derrube. A mensagem do commit está
**correta** nos números que cita (4.137 + 44 = 4.181; 18 páginas; 0 palavras partidas; 50/0 no
controle).

### 3.6 Portões declarados — **REPRODUZIDO no que rodei; a fase serial completa não foi rodada**

| Portão declarado | Comando | Resultado |
|---|---|---|
| Fase paralela 4.137 (4.136 passam, 1 pulado) + 44 process-safe | `node --test $(<plan.parallel>)` no clone com `.git`, plano gerado pelo próprio `createTestPlan` de `scripts/run-tests.mjs` (179 arquivos) | **4.181 testes, 4.180 passam, 0 falham, 1 pulado** (43,3 s) |
| — decomposição | `test/e2e/*` excluído (`4137/4136/0/1`); par process-safe (`44/44`) | 4.137 + 44 = **4.181** — bate exatamente com a alegação |
| `release-package` + `extension-shell` 12/12 com digest fixado | `node --test test/release-package.test.js test/extension-shell.test.js` | **12/12**, 0 falham; a reconstrução isolada produz `c2d6c44d…5951b5` |
| Seis E2E de Chrome real | `node --test --test-concurrency=1` em `pkg` (zip + `test/` + `fixtures/`) para `mandatory-journey-mv3`, `current-page-export-mv3`, `report-executive-print`, `report-print-layout`, `report-print-breaks`, `report-version-provenance` | **6/6 passam**, exit 0 |
| Auditoria empacotada da página real do Google | `drivers/adv-live-122.mjs` em `pkg` | 0 falhas, 1 alerta, 3 suspeitas, **9 positivos**, 109 no checklist, cobertura **28,5%**, **18 páginas**, quatro downloads `complete` |

Não reproduzi: a **fase serial completa** (35 arquivos de Chrome real). Rodei os 6 exigidos, mais 4
execuções de mutante do `report-print-breaks` e 4 drivers próprios. `test/e2e/sidepanel-flow-mv3.test.mjs`
segue fora, como instruído. Também não reproduzi o "índice 9,0/10" do registro: ele não aparece no
artefato entregue (é métrica de comparação da trilha de QA, não do relatório).

### 3.7 Minors herdados — **não pioraram; nenhum foi tocado**

| Minor herdado | Estado medido | O delta piorou? |
|---|---|---|
| 12 códigos `ANNOTATION_MAP_*` com a mesma mensagem | `diagnostic-policy.js`: 12 códigos em `annotationFailureCodes` + 1 mensagem compartilhada (13ª ocorrência é `ANNOTATION_MAP_PARTIAL`, outra mensagem) | Não — arquivo não tocado |
| `listedLimitations` por heurística de forma | Reproduzido: entrada não-array → `[]` (`undefined`, `'x'`, `{a:1}`); a filtragem por forma continua removendo a frase simples duplicada pela codificada e mantendo a codificada | Não — função não tocada |
| Entrada não-array devolvendo `[]` | Idem acima, inalterado | Não |
| Hash de CSP obsoleto desestiliza em silêncio | Não há verificação em tempo de execução (o hash só é usado para montar a CSP em `html.js:96,165`). Com o hash declarado revertido para o valor da 1.1.21 e o CSS da 1.1.22: `test/report/html.test.js` + `test/review/report-view.test.js` → **86 testes, 85 passam, 1 falha**, exatamente `uses exact CSP hashes for static CSS and script with no executable audited content`, que **recalcula** o SHA-256 do `<style>` renderizado (linha 761) em vez de comparar com literal | Não — e o delta atualizou o hash corretamente (`sha256-f1gqNE1PS2/DyQys5DQcGk+VCp52hNQcPpmUwzNa9/Q=`, verificado: `declared === sha256(REPORT_CSS)`) |

---

## 4. Achados novos

### N1 — Minor — a cláusula e a lista vêm de fontes diferentes (medição in-process; não alcançável no produto)

`projectLimitationClauses` lê `model.session?.diagnostics` **e** `model.pages[].diagnostics`;
`projectExecutive.limitations` (que produz a contagem `(N)` e a entrada codificada) lê só
`model.session.diagnostics` mais `model.limitations`/resumos. Sonda in-process:

```
modelo com PIXEL_CAPTURE_OMITTED apenas em pages[0].diagnostics
  cláusulas: ["Modo sem imagens: nenhuma captura raster."]
  lista: 2 itens, entrada codificada presente? false
```

Ou seja: a manchete pode afirmar uma limitação que a lista não contém e que a contagem não conta.
**Não é alcançável pelos caminhos do produto**: a projeção single copia `session.diagnostics` para
`pages[0].diagnostics` (o mesmo array) e `src/core/batch/aggregate-audits.js:141` achata os
diagnósticos de página em `session.diagnostics`. Fica como aperto de consistência, não como defeito
demonstrado ponta a ponta. **Inferência + medição in-process, não execução real.**

### N2 — Minor — a impressão da própria aba interativa continua partindo palavra (pré-existente, fora do escopo alegado)

A regra nova está só em `REPORT_CSS` (`report.css.js`). A aba interativa carrega
`src/review/review.css` (`src/review/index.html:7`), que não tem regra de impressão para a matriz —
`grep -n matrix src/review/review.css` devolve só `.matrix-scroll { min-width: 0; overflow-x: auto; }`.
Medido no DOM da aba renderizado pelo código empacotado, em mídia de impressão a 680 px:

```
matrixFont 14.8px · overflow-wrap anywhere · matriz 606×… (cabe em 680)
quebras: matriz 198 · thead 2 (Item, Classificação) · documento 209
```

Consequência: um usuário que imprime a aba (Ctrl+P, sem o resumo) ainda vê a classe de defeito que
este incremento fechou no PDF entregue. É pré-existente e o incremento não alegou cobrir essa
superfície — mas **retrata a inferência da revisão da 1.1.21** ("a regra nova vale também nesse
caminho (mesma folha, mesmo `.matrix-scroll`)"), que era falsa. Não é bloqueante porque o artefato
julgado (HTML/PDF entregue) está correto e o caminho de resumo da aba tem E2E próprio.

### N3 — Minor — o oráculo de largura do E2E não deriva de `@page`

Ver 3.3(c). Hoje inócuo (`@page` do produto = A4/15 mm ⇒ 679,9 px, e o PDF entregue tem todo o texto
dentro da caixa), mas o teste não perceberia uma mudança de margem que fizesse o conteúdo sair do
papel: ele mede 680 px por construção da emulação.

### N4 — Minor (documentação) — cinco frases remanescentes

Tabela em 3.5. A mais séria é `docs/qa/revisoes/LEIA-ME.md:15`, que descreve um artefato de duas
versões atrás como corrente e repete a frase refutada.

### N5 — Observação — a regra de cabeçalho também governa a matriz (e isso é o que realmente fecha as 50 quebras na fixture)

Medido no A/B (mesmo modelo, mesmo HTML, hash consistente): com `thead th{overflow-wrap:normal}`
presente, remover a regra da matriz deixa a tabela em 6.172,56 px e 0 quebras; sem a regra de
cabeçalho, a coluna "Classificação" encolhe de 119,27 para 99,78 px e as 50 quebras de
`Recomendação` voltam (tabela 7.226,97 px). Não é defeito — é cobertura redundante e bem-vinda —
mas explica por que o controle "sem a regra da matriz" do E2E precisa da compressão injetada para
falhar. Nota de higiene: `word-break:normal` nas duas regras é no-op (a folha base nunca define
`word-break`).

### N6 — Observação — import morto

`src/review/report-view.js:10` continua importando `DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE`, que
deixou de ser usado quando a derivação passou a ser por código (só `ATTACHED_COPY_RELOADED_MESSAGE`
é usado, na linha 74).

### N7 — Observação — higiene do checkout

`git status --porcelain` no checkout congelado devolve `?? node_modules` (o symlink não está no
`.gitignore`), não vazio como o enunciado afirmava. Não é defeito do artefato e nada foi modificado
por mim: HEAD continua `a278859`, o digest do zip continua o fixado, e trabalhei em cópias
(`treegit`, `pkg`, `mut`).

---

## 5. Retratações (minhas, durante esta revisão)

1. **"O A/B não reproduz a mudança de paginação; V122 e V120 dão 13 páginas cada."** — errado. Meu
   primeiro driver de A/B não aplicava `Emulation.setDeviceMetricsOverride(680)` e usava um modelo
   sem decisão de revisão, então media outro layout. Refeito com as condições do A/B anterior
   (métricas 680, mesmo modelo): as alturas reproduzem exatamente (6.172,56 / 7.226,97 px) e o delta
   de páginas é 16 → 15 com o HTML da 1.1.22. A conclusão "a paginação mudou" se sustenta.
2. **Três mutantes "falharam" na mesma asserção de string** — inválido: eu não restaurava a CSS entre
   mutantes, então `override-*` e `neuter-*` rodaram sobre a árvore já mutada por `drop-matrix-rule`.
   Refeito com `restore` antes de cada mutante: cada um falha na asserção que lhe corresponde, e os
   dois mutantes de "regra presente mas ineficaz" falham nas asserções **comportamentais**.
3. **"Todas as páginas transbordam a caixa de conteúdo"** — defeito do meu medidor: eu usava `tm[4]`
   sem aplicar a CTM, e o Chrome emite matriz de texto escalada. Recalculado com
   `x = tm[4]*cm[0] + tm[5]*cm[2] + cm[4]`, **nenhuma** página sai da caixa.
4. **"As cláusulas e a proveniência não estão no PDF"** — falso, era extração: os textos atravessam
   quebras de linha na extração do pypdf e a contagem literal dava 0 (`Regras suplementares: 4`, o
   nome do arquivo do ledger). Com espaços normalizados, todas as cadeias aparecem 1×.
5. **"O teste de CSP compara com literal em vez de recalcular"** — retirado: o teste recalcula o
   SHA-256 do `<style>` renderizado (linha 761) e compara a CSP com o valor recalculado.
6. **"`documento=9` no diagnóstico do E2E contradiz o '0 palavras partidas' dos documentos"** —
   retirado: são métricas diferentes. O detector do E2E conta qualquer token que ocupe mais de uma
   caixa de linha (e por isso pega `ev-control` quebrando no hífen e hashes de 64 caracteres, quebras
   legítimas); o detector da revisão conta palavra partida no meio. No PDF entregue, por qualquer das
   duas leituras relevantes, não há palavra de vocabulário partida.

---

## 6. O que não medi / risco residual

- **Fase serial completa** (35 arquivos de Chrome real): rodei 6 E2E + 4 mutantes + 4 drivers
  próprios. `sidepanel-flow-mv3` e os demais não foram reexecutados. Risco: uma regressão restrita a
  outro E2E serial não seria vista por mim.
- **Cláusula `FULL_PAGE_CAPTURE_OMITTED` no artefato**: medida só por teste unitário e sonda
  in-process. Minha auditoria ao vivo foi em modo sem imagens (`PIXEL_CAPTURE_OMITTED`), que domina o
  `else if`; não produzi uma auditoria real com captura integral omitida e miniaturas.
- **`deviceScaleFactor` ausente**: o modelo entregue tinha escala 1; a ramificação "escala não
  registrada" de `viewportSummary` só foi exercitada por leitura/teste unitário.
- **Painel lateral**: não medi a UI do painel. Verifiquei que não há acoplamento (`grep` por
  `report-view|buildReportView` em `src/panel/` → nada) e que os testes de `test/panel/*` passam na
  fase paralela; a mudança de `projectMethodology` só é consumida pelos dois renderizadores do
  relatório. É inferência sustentada por grep + suíte, não por medição de tela do painel.
- **Seção 6 da aba interativa ao vivo**: verificada pelo teste unitário novo (2/2 passam por nome) e
  por leitura do código, não por captura de DOM da aba real (só capturei a manchete das limitações na
  aba ao vivo).
- **Flakiness**: os cinco E2E além do `report-print-breaks` rodaram uma vez cada. O
  `report-print-breaks` rodou **9 vezes**: a do pacote e a do controle intacto (2 verdes), 4 mutantes
  válidos (4 vermelhas, cada uma na asserção esperada) e 3 execuções inválidas descartadas (ver
  Retratações 2). Não medi repetição sob carga.
- **Ambiente**: apenas Chrome for Testing 152.0.7977.64; nenhuma medição em Chrome estável de usuário.
  Os números de paginação são do A4 com 15 mm laterais e do HTML desta versão.
- **Inferência, não medição**: a duplicação residual dos 12 `ANNOTATION_MAP_*` em auditoria de lote
  real; a inalcançabilidade de N1 pelos caminhos do produto; o risco de token longo (que o próprio
  E2E converte em falha de portão para a matriz).
