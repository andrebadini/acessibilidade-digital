# Revisão adversarial independente — Audita Acessibilidade 1.1.21

- Delta sob revisão: `a73a9e3..2e2fdfb` (um commit, `2e2fdfb`), checkout congelado `/private/tmp/audita-review-121` (limpo ao final: `git status --porcelain` vazio).
- Artefato: `release/audita-acessibilidade-1.1.21.zip`, SHA-256 `4e9174f8d10e0f3d631c3445a09f3d5569f2d165f044177cf5863122d10e13c5` (confere).
- Baselines re-medidos: `1.1.19.zip` (`0e429e22…`) e `1.1.20.zip` (`140e30bb…`).
- Navegador: Chrome for Testing 152.0.7977.64 em `/private/tmp/audita-cft152-fixed/...`, perfil temporário isolado, **um workload de Chrome por vez**. O outro caminho registrado não foi usado.
- Método: **medições de produto sobre os bytes empacotados**. Os ZIPs foram extraídos em `/private/tmp/adv121/pkg119|pkg120|pkg121`, e `test/` e `fixtures/` do repositório foram copiados para dentro de cada raiz extraída; os drivers rodaram dessa raiz. Scratch em `/private/tmp/adv121`. O checkout congelado não foi modificado.
- Detector de quebras: **próprio** (`/private/tmp/adv121/detect_breaks.py`), descrito na seção 3.1.

---

## 1. Veredito

**Sim — a 1.1.21 pode substituir a 1.1.20 como candidata. 0 Critical, 0 Important, 5 Minor.**

O achado Important da revisão da 1.1.20 está **fechado**: na matriz do PDF entregue, 0 rótulos de item quebrados e **0 fragmentos no meio de palavra**, medido em bytes empacotados, em A/B controlado sobre o mesmo modelo e conferido visualmente (a 1.1.20 parte `Recomendaçã`/`o ABNT`; a 1.1.21 mantém `Recomendação`/`ABNT`). O artefato confere nos dois sentidos, o hash de CSP está correto e é o do pacote, `release-package` passa 7/7 reconstruindo o mesmo digest, os quatro E2E exigidos passam e a fase paralela fecha em 4.180 testes (4.179 passam, 1 pulado, 0 falham).

Duas frases do autor **não se sustentam como escritas**, sem dano funcional: (a) **"mesma paginação"** — em A/B controlado sobre os mesmos bytes de modelo, a CSS nova encurta a tabela da matriz (7.226,97 → 6.172,56 px) e o documento passa de **15 para 14 páginas**; nas minhas execuções ao vivo a matriz passa de 9 para 8 páginas e o total de 18 para 17 (aí também há diferença de conteúdo entre capturas); (b) **"0 fragmentos de palavra"** vale para a matriz, não para o documento: restam **3** quebras no cabeçalho da tabela de anexos (`Evidênc`/`ia`), presentes desde a 1.1.19 e alheias a esta mudança. Além disso, a correção do Minor 5 **não chega ao PDF entregue**: o renderizador de impressão nunca teve cláusulas em linguagem simples no título, então o leitor do PDF continua encontrando o código em maiúsculas — a cláusula nova existe só na aba interativa.

Os quatro Minor restantes da revisão da 1.1.20 (2, 3, 4 e 6) continuam abertos e inalterados; o delta não alegou corrigi-los.

---

## 2. Artefato

| Verificação | Comando | Resultado |
|---|---|---|
| Digest | `shasum -a 256 release/audita-acessibilidade-1.1.21.zip` | `4e9174f8…0e13c5` — **confere** |
| Entradas | `unzip -Z1 … \| wc -l` / `\| head -1` | **199** arquivos, primeira entrada `manifest.json` |
| `manifest.json` interno | leitura do JSON extraído | `manifest_version 3`, `version 1.1.21`, `version_name 1.1.21` |
| Pacote → árvore | `bash /private/tmp/adv121/check-artifact.sh` (SHA-256 por arquivo) | 199 arquivos, **0 ausentes, 0 divergentes** |
| Árvore → pacote | mesmo script | 0 arquivos de `src/`+`vendor/` fora do pacote; 0 caminhos `test/docs/store-assets/fixtures/node_modules` |
| Ícones fora do pacote | comparação `find src vendor assets` | `assets/icons/icon-1024.png` e `assets/icons/icon-source.svg` não são empacotados — coerente com a lista fixa de ícones de `scripts/build-release.mjs` (16/32/48/128); a lista de 199 entradas é **idêntica** em 1.1.19, 1.1.20 e 1.1.21 |
| Suíte do pacote | `cd /private/tmp/adv121/tree && node --test test/release-package.test.js` | **7/7 passam** (inclui digest do arquivo entregue e reconstrução isolada: o pacote reconstruído da árvore tem o mesmo digest do entregue) |

---

## 3. Alegação 1 — a regressão Important está corrigida

**Situação: REPRODUZIDA.** A matriz do PDF entregue da 1.1.21 não tem rótulo de item quebrado nem palavra partida; a 1.1.20 tem 50 palavras partidas.

### 3.1 O detector (próprio, não o do autor)

`/private/tmp/adv121/detect_breaks.py` conta dois sinais independentes, por página e por região:

- **ITEM-LABEL SPLIT**: linha termina em `<dígitos>.` e a linha seguinte começa com dígito (o defeito de 1.1.19: `5.10.` / `1`).
- **MID-WORD SPLIT**: linha termina num fragmento alfabético `frag` e a linha seguinte começa num fragmento alfabético `cont` tais que `frag+cont` é palavra íntegra **do mesmo relatório** (vocabulário extraído do **HTML entregue da mesma auditoria**, que renderiza as mesmas cadeias sem quebra) e `frag` sozinho **não** é palavra desse vocabulário.

Uso: `$PY detect_breaks.py <pdf> <arquivo.html> <rótulo>`. Regiões: páginas cuja linha começa com `Item Título Classificação Resultado` são matriz; páginas com `Seletor / hash` são anexo; o resto é "outro". Contagem de linhas da matriz por `^5\.\d` (ids ABNT), o que devolve exatamente 146 em todos os PDFs medidos.

O vocabulário vem **só do HTML**: a primeira versão do detector também aceitava tokens do próprio PDF e, com isso, `Evidênc` se auto-autorizava como palavra — o detector devolvia 0 inclusive para quebras conhecidas. Corrigido antes de qualquer medição usada aqui (ver Retratações).

### 3.2 Medição pareada nos PDFs entregues (execuções próprias, bytes empacotados)

Driver próprio `drivers/adv-live.mjs` (página real `https://www.google.com/`, modo sem imagens, `downloadMode: 'profile'`), um pacote por execução:

```
AUDITA_RUN_ROOT=/private/tmp/adv121/pkg1NN AUDITA_KEEP_DIR=/private/tmp/adv121/artifacts-1NN-own \
AUDITA_LABEL=pkg1NN AUDITA_E2E_CHROME=".../Google Chrome for Testing" \
  node --test --test-concurrency=1 drivers/adv-live.mjs
$PY /private/tmp/adv121/detect_breaks.py <pdf> <html> pkg1NN-own
```

| PDF entregue (meu run) | páginas | linhas da matriz | rótulos de item quebrados | palavras partidas |
|---|---|---|---|---|
| 1.1.19 | 18 | 146 | **56** (todas na matriz) | 3 (anexo: `Evidênc`/`ia`) |
| 1.1.20 | 18 | 146 | **0** | **52** — **50 × `Recomendaçã`/`o`** na matriz + 2 no anexo |
| 1.1.21 | **17** | 146 | **0** | 3 (anexo: `Evidênc`/`ia`) |

Referências re-medidas com o mesmo detector (não confiadas, só re-medidas): `/private/tmp/g119/artifacts` (1.1.19) 18 páginas/56/2; `/private/tmp/adv120/artifacts-119-own` idem; `/private/tmp/adv120/artifacts-120-own` (1.1.20) 18 páginas/0 item/**52** (50 na matriz). Os números do autor e da revisão anterior para 1.1.19 e 1.1.20 se confirmam.

### 3.3 A/B/C controlado sobre o mesmo modelo (bytes idênticos)

`drivers/print-abc.mjs`: renderiza o HTML de impressão do pacote 1.1.21 para o fixture `SAMPLE_AUDIT` **uma única vez** e serve três variantes da mesma string — V121 = CSS empacotada; V120 = CSS sem `.matrix-scroll td,.matrix-scroll th{overflow-wrap:normal;word-break:normal}` (comportamento exato de 1.1.20) e hash de CSP recalculado; V119 = sem essa regra e sem `white-space:nowrap` (comportamento de 1.1.19). Mesmo Chrome, mesmo modelo, `Page.printToPDF` por variante; cada PDF passou pelo detector com o HTML da própria variante:

| Variante | páginas | altura da tabela da matriz | rótulos quebrados | palavras partidas |
|---|---|---|---|---|
| V121 (1.1.21) | **14** | 6.172,56 px | **0** | **0 na matriz** (1 no anexo) |
| V120 (=1.1.20) | **15** | 7.226,97 px | 0 | **50 na matriz** (1 no anexo) |
| V119 (=1.1.19) | **15** | 7.226,97 px | **56** | 0 na matriz (1 no anexo) |

A regra é a causa direta, e a leitura linha a linha confirma o mecanismo: em V120 as 146 linhas têm altura uniforme de 49,16 px (todas com pelo menos uma célula em duas linhas, por causa de `Recomendaçã`/`o ABNT`); em V121 há linhas de 49,16 px e de 33,88 px, porque o layout distribui a largura de outro modo. Conferência visual (pypdf + `sips`, páginas rasterizadas): a página 9 do PDF real da 1.1.20 mostra `Recomendaçã` / `o ABNT` em 50 linhas; a página 9 da 1.1.21 mostra `Recomendação` / `ABNT` e todos os rótulos inteiros.

### 3.4 Nada foi cortado, e o conteúdo continua completo

`completeness2.py` percorre as páginas da matriz do PDF em ordem e exige, para cada uma das 146 linhas do HTML entregue, o id, a primeira palavra do título, a classificação e o resultado na janela seguinte:

| PDF | linhas | falhas |
|---|---|---|
| 1.1.19 | 146 | 84 (ids partidos: `5.1.1`/`0` etc.) |
| 1.1.20 | 146 | 50 (`Recomendação ABNT` não aparece: `Recomendaçã o ABNT`) |
| 1.1.21 | 146 | **0** |

Também confirmei no HTML entregue do meu run que o hash do `<style>` embutido é o mesmo do `style-src` da meta CSP e o mesmo `REPORT_CSS_CSP_HASH` empacotado (seção 6).

---

## 4. Alegação 2 — cláusula de observação passiva (Minor 5)

**Situação: REPRODUZIDA na aba interativa; REFUTADA no caminho de impressão/PDF, que é o artefato entregue.**

Medição ao vivo (headline da aba interativa, 1.1.21, pacote):

```
Limitações registradas (6) · Modo sem imagens: nenhuma captura raster. · Observação passiva: sem testes interativos de teclado, redimensionamento e movimento.
```

6 `<li>` no detalhe, 6 frases distintas, a entrada `DYNAMIC_PROBES_OMITTED_PASSIVE: …` presente na lista e **nenhuma** duplicação da cláusula dentro da lista. O contrato "(N)" continua sendo `N = número de <li>` (6 = 6).

Enumerando os casos (probe in-process `drivers/headline-probe.mjs`, bytes empacotados, `renderReportView` + `renderHtmlReport`):

| Caso | manchete interativa | cláusula passiva | manchete de impressão / HTML entregue |
|---|---|---|---|
| A fixture sem diagnósticos | `Limitações registradas (4)` | não | `(4)`, sem cláusula |
| B + entrada codificada passiva | `(5) · Observação passiva: …` | **sim** | `(5)`, sem cláusula |
| C + só a frase simples (sem código) | `(5)` | **não** | `(5)`, sem cláusula |
| D passiva sem pixels | `(5) · Observação passiva: …` | sim | `(5)`, sem cláusula |
| E passiva + sem imagens | `(6) · Modo sem imagens: … · Observação passiva: …` | sim | `(6)`, sem cláusula |
| F passiva + captura integral omitida, com miniaturas | `(6) · Captura integral omitida: miniaturas… · Observação passiva: …` | sim | `(6)`, sem cláusula |
| G idem, sem miniaturas | `(6) · Captura integral omitida: evidências estruturais… · Observação passiva: …` | sim | `(6)`, sem cláusula |
| H passiva + duplicata simples | `(5) · Observação passiva: …` (uma vez) | sim | `(5)`, sem cláusula |

Ou seja: a cláusula aparece exatamente quando a **entrada codificada exata** está na lista; os três casos anteriores de linguagem simples (`noPixelEvidence`, `elementOnlyEvidence` com e sem miniatura) continuam idênticos — o refactor de ternário aninhado para `if/else if` não regrediu nenhum deles; o "(N)" nunca muda com a cláusula.

**O que não se sustenta:** no PDF entregue do meu run, `Observação passiva` ocorre **0 vezes** e a frase simples continua ocorrendo **1 vez**, dentro da entrada codificada — exatamente como na 1.1.20 (1.1.19: 2 vezes, por causa da duplicação que a 1.1.20 removeu). O renderizador de impressão (`html.js:288`) monta o título como `Limitações registradas (${limitationsList.length})` e **nunca** teve cláusulas em linguagem simples — nem a nova, nem a antiga `Modo sem imagens: …`. A correção do Minor 5, portanto, vale para a aba interativa; o leitor não técnico do PDF (o artefato principal, e onde o Minor 5 foi originalmente medido) continua encontrando o código em maiúsculas para saber que os testes interativos não rodaram.

Risco adicional do gatilho: se um dia a deduplicação passar a manter a frase simples em vez da forma codificada, a cláusula desaparece em silêncio (caso C) — hoje inalcançável, mas é a mesma fragilidade de acoplamento por forma exata que a revisão da 1.1.20 já apontou no Minor 3.

---

## 5. Alegação 3 — 0/0 e "mesma paginação"

**0 rótulos de item: REPRODUZIDO. 0 palavras partidas: REPRODUZIDO na matriz; REFUTADO no documento. "Mesma paginação": REFUTADO.**

- Rótulos de item: 0 nos três caminhos medidos (PDF real da 1.1.21, V121 controlado, e a checagem por linha com 0 falhas em 146 linhas).
- Palavras partidas na matriz: 0. No documento inteiro, **3** quebras (`Evidênc`/`ia`, cabeçalho repetido da tabela de anexos de evidências) — presentes também na 1.1.19 e na 1.1.20, fora do escopo do seletor `.matrix-scroll`, portanto **pré-existentes e não tocadas** pela mudança. A frase "0 fragmentos de palavra" é verdadeira para a matriz e falsa para o PDF como um todo (o próprio autor reporta 0 para a 1.1.19, sinal de que a métrica dele também era restrita à matriz).
- Paginação: **mudou**. No A/B controlado (mesmos bytes de modelo, única diferença é a regra), 15 → **14** páginas e a tabela da matriz 7.226,97 → 6.172,56 px. Nas execuções ao vivo: 18 / 18 / **17** páginas totais e 9 / 9 / **8** páginas de matriz na ordem 1.1.19 / 1.1.20 / 1.1.21. As três execuções ao vivo **não** são o mesmo conteúdo (11 / 11 / 9 evidências, 118 / 118 / 116 ocorrências, 134 / 134 / 133 resultados de regra), então elas sozinhas não isolam a causa — mas o A/B controlado isola, e a direção é a mesma: a 1.1.21 imprime **uma página a menos**. Não há perda de dado nem corte (seção 3.4); é uma frase incorreta no README e na mensagem do commit, não um defeito do produto. O número "18" não é propriedade do artefato: é o tamanho de uma captura específica da página do Google.

---

## 6. CSP

- Hash calculado por mim sobre `REPORT_CSS` do pacote 1.1.21: `sha256-mvlOZmOfzFvivnzxAJKWn9RmFCNbI6PM1xNo1TEUvtE=` — **idêntico** ao declarado em `report.css.js`.
- No HTML entregue do meu run: o hash recalculado do `<style>` embutido é `sha256-mvlOZmOfz…`, e a meta CSP traz exatamente `style-src 'sha256-mvlOZmOfz…'`. O hash antigo (`sha256-5WbvaexQ…`, de 1.1.20) não aparece em nenhum byte entregue.
- **Um hash obsoleto seria pego?** Sim. Mutação `mut-stale` (hash revertido para o valor de 1.1.20, CSS novo): `test/report/html.test.js` + `test/review/report-view.test.js` → 85 testes, 83 passam, 2 falham, sendo a falha extra exatamente `uses exact CSP hashes for static CSS and script with no executable audited content` — o teste recalcula o hash a partir do `<style>` renderizado e não compara com literal fixo.
- **A regra nova está protegida por teste?** Não. Mutação `mut-revert3` (regra removida **e** hash recalculado de forma consistente com o próprio CSS): **84/85 testes passam** (a única falha é `embeds a shared large PNG once…`, que só existe porque a raiz extraída não tem `store-assets/`, falha de raiz sintética, não do produto) e os três E2E de impressão/exportação passam **3/3**. Ou seja, a classe de regressão que este delta corrige pode voltar sem que o portão perceba; o que existe é o pino do hash, que só garante CSS↔hash, não o comportamento de impressão. Nenhum teste do repositório menciona `matrix-scroll` em impressão, `overflow-wrap` da matriz ou contagem de quebras.
- Continua valendo o Minor 6 da revisão anterior: não há verificação de hash em tempo de execução; um pacote montado sem rodar a suíte entregaria PDF sem estilo em silêncio.

---

## 7. Regressão

| Portão | Comando | Resultado |
|---|---|---|
| Os quatro E2E exigidos (bytes empacotados) | `cd /private/tmp/adv121/pkg121 && AUDITA_E2E_CHROME=... node --test --test-concurrency=1 test/e2e/current-page-export-mv3.test.mjs test/e2e/report-print-layout.test.mjs test/e2e/report-executive-print.test.mjs test/e2e/mandatory-journey-mv3.test.mjs` | **4/4 passam** (current-page 3,7 s; report-print-layout 0,4 s; report-executive-print 1,4 s; mandatory-journey 3,4 s) |
| `release-package` | na cópia da árvore | **7/7 passam** |
| Fase paralela | `cd /private/tmp/adv121/tree && node --test $(find test -name '*.test.js' -o -name '*.test.mjs' \| grep -v '^test/e2e/' \| sort)` | **4.136 testes, 4.134 passam, 1 falha, 1 pulado**; a falha é `normative ESM exports remain byte-identical to the 78ba813 baseline`, causada por a minha cópia não ter `.git` — com o ponteiro `.git` copiado, esse arquivo passa **5/5**. |
| E2E process-safe da fase paralela | `node --test --test-concurrency=1 test/e2e/axe-mv3-csp-decision.test.mjs test/e2e/support/real-chrome.test.mjs` | **44/44 passam** |
| Total paralelo | 4.136 + 44 | **4.180 testes, 4.179 passam, 1 pulado, 0 falham** — igual ao número declarado pelo autor |
| E2E no mutante que reintroduz o defeito | `mut-revert3` (regra removida + hash honesto) | **3/3 passam** — o portão não cobre a regressão corrigida |

Chrome isolado, um workload por vez; `downloadMode: 'profile'` como avisado.

---

## 8. A regra nova (`overflow-wrap:normal;word-break:normal`) cria problema novo?

**Onde ela pega:** verifiquei por varredura de chaves que a regra está **dentro** do bloco `@media print` (bloco que começa no offset 16.881 e termina em 19.306; a regra está no offset 19.097), e não aparece em nenhuma regra de tela — a matriz da aba interativa não muda de aparência na tela. O seletor atinge apenas células dentro de `.matrix-scroll`; no HTML de impressão há **um** `.matrix-scroll` (a matriz da seção 5), e a tabela de anexos de evidências está fora dele. Medido: a geometria da tabela de anexos é **idêntica** nas três variantes (245,69 px de altura; célula `th[scope=row]` 77,11 × 94,16 px).

**Transbordo/corte:** no PDF real e no fixture controlado, **0** palavras ultrapassam a caixa da própria célula e **0** sobreposições com a célula seguinte; a tabela termina em 679 px num conteúdo de 680 px (A4, 180 mm), com folga mínima por coluna de 9,3 px (Item), 12,77 px (Título), 26 px (Classificação), 17,27 px (Resultado) e 9,55 px (WCAG). O maior token inquebrável do conteúdo empacotado é `Características` (15 caracteres); a maior palavra medida na coluna Título foi `Comportamento`, 87,31 px.

**Controle positivo (o que aconteceria com um token longo):** injetei um token único de 170 caracteres numa célula de Título do HTML de impressão. Com a CSS da 1.1.21, a tabela **cresce para 1.164,31 px** e deixa de caber na página (680 px) — o transbordo não é cortado por célula, ele empurra a tabela para fora da área imprimível, e o que sai do papel some do PDF sem aviso. Com a CSS da 1.1.20 (`overflow-wrap:anywhere`), o mesmo token é quebrado e a tabela permanece em 679 px. Isso é a troca que a correção faz: prefere-se a palavra inteira a manter a tabela no papel. **Hoje não é alcançável** (os títulos, classificações e rótulos vêm do inventário normativo empacotado e o maior token tem 15 caracteres, com folga ≥ 9 px), mas é um risco latente se um título novo trouxer um token muito longo. Não é um defeito do artefato; registro como risco residual.

---

## 9. Achados que o autor não declarou

| # | Severidade | Achado |
|---|---|---|
| 1 | Minor | **"Mesma paginação" é falso.** A/B controlado sobre os mesmos bytes: 15 → 14 páginas, tabela da matriz 7.226,97 → 6.172,56 px. Nas execuções ao vivo, 18 → 17 páginas totais e 9 → 8 páginas de matriz (com conteúdo ligeiramente diferente entre capturas). Sem perda de conteúdo; a frase do README/commit deve ser corrigida, e "18 páginas" não é propriedade do artefato. |
| 2 | Minor | **"0 fragmentos de palavra" é escopo de matriz, não do PDF.** Restam 3 quebras no cabeçalho da tabela de anexos (`Evidênc`/`ia`), iguais desde a 1.1.19 — pré-existentes, fora do seletor, mas dentro do PDF entregue. |
| 3 | Minor | **A correção do Minor 5 não chega ao artefato entregue.** O renderizador de impressão nunca teve cláusulas em linguagem simples no título (`html.js:288`); no PDF, `Observação passiva` ocorre 0 vezes e a frase simples só aparece dentro da entrada codificada. Quem lê o PDF continua precisando ler o código em maiúsculas. |
| 4 | Minor | **A correção não tem guarda automatizada.** Remover a regra nova e recalcular o hash de forma consistente passa 84/85 testes unitários e 3/3 E2E de impressão/exportação. Só o pino de hash protege o CSS, não o comportamento. |
| 5 | Minor | **Risco latente de token longo.** Com `overflow-wrap:normal`, um token inquebrável maior que a coluna faz a tabela crescer além da página (controle positivo: 680 → 1.164,31 px) em vez de quebrar; inalcançável com o conteúdo atual, mas sem teste que avise. |
| 6 | Minor (herdado) | Minor 2 da 1.1.20 continua aberto: 12 códigos `ANNOTATION_MAP_*` compartilham a mesma mensagem (medido: duas entradas codificadas + a frase simples → 2 itens de lista para 1 frase distinta). Ocorrência em auditoria real de lote continua sendo inferência. |
| 7 | Minor (herdado) | Minor 3 da 1.1.20 continua aberto: `listedLimitations` é heurística de forma. Reproduzi a mesma tabela de lacunas (código com <4 caracteres, hífen/ponto/minúscula, espaço duplo, `\n` final, códigos encadeados) — nenhuma alcançável no conjunto atual. |
| 8 | Minor (herdado) | Minor 4 da 1.1.20 continua aberto: entrada não-array devolve `[]` em silêncio (`undefined`, string, objeto). |
| 9 | Minor (herdado) | Minor 6 da 1.1.20 continua aberto: hash de CSP obsoleto desestiliza em silêncio em tempo de execução (a suíte pega; o produto não verifica). |
| 10 | Observação | **Higiene dos artefatos de referência:** `/private/tmp/g119/artifacts-tree` e `/private/tmp/print-check-out` dizem "Versão da extensão: 1.1.20" mas carregam a **CSS da 1.1.21** (contêm a regra nova e `style-src 'sha256-mvlOZmOfz…'`), e por isso já não reproduzem as 50 quebras que a revisão da 1.1.20 mediu neles. Não são utilizáveis como evidência "antes"; as minhas execuções empacotadas da 1.1.20 substituem essa perna. |

---

## 10. Retratações

Registro do que eu mesmo afirmei e precisei retirar durante esta revisão (nada disso chegou ao agente pai):

1. **"O detector encontra 0 quebras em todos os PDFs"** — falso; era um defeito do meu detector, que incluía os tokens do próprio PDF no vocabulário e assim aceitava `Evidênc` como palavra íntegra. Corrigido para vocabulário somente do HTML entregue, o detector passou a achar as 3 quebras de anexo e as 50 da 1.1.20.
2. **"Retirar a regra com hash consistente passa despercebido"** (primeira versão) — o primeiro mutante tinha hash inconsistente e falhava no teste de CSP por erro **meu**, não por cobertura do produto. Refeito com o hash recalculado a partir do `REPORT_CSS` exportado pelo próprio módulo, o mutante passa 84/85 + 3/3 E2E; a conclusão (não há guarda de layout) só vale para essa versão corrigida.
3. **"As 18 páginas viraram 17: a CSS mudou a paginação"** (leitura inicial das execuções ao vivo) — as três execuções ao vivo não têm o mesmo conteúdo (9 evidências na 1.1.21 contra 11 nas outras duas), então elas não isolam a causa. A conclusão de que a paginação mudou só se sustenta pelo A/B controlado sobre o mesmo modelo, que é o que uso no veredito.
4. **Atribuição de região da quebra `Evidênc`/`ia`** — em uma das medições a quebra do anexo foi classificada como "matriz" porque a página também continha a linha de cabeçalho da matriz. É artefato da minha heurística de região, não uma quebra na matriz; nesta versão do detector as páginas de anexo são identificadas por `Seletor / hash`.

---

## 11. Não verificado / risco residual

- **Não medi** `test/e2e/sidepanel-flow-mv3.test.mjs` (excluído por instrução, outro incremento).
- **Não rodei a fase serial completa** (33 arquivos de Chrome real): rodei os 4 exigidos no pacote, mais 3 no mutante e os 2 process-safe. `url-pixel-consent-mv3` e os demais não foram reexecutados nesta revisão.
- **Não medi** a impressão da aba interativa por um usuário real (Ctrl+P). A regra nova vale também nesse caminho (mesma folha, mesmo `.matrix-scroll`), mas a medição foi feita no HTML de impressão do pacote e no PDF entregue.
- **Não medi** a degradação silenciosa por hash obsoleto na 1.1.21; o código de verificação em tempo de execução não existe (inalterado), e a medição da 1.1.20 (11 páginas sem estilo) não foi refeita.
- **Inferência, não medição:** a duplicação residual dos 12 códigos `ANNOTATION_MAP_*` foi demonstrada no mecanismo; não construí auditoria de lote que dispare dois códigos distintos dessa família.
- **Inferência, não medição:** o risco de token longo é um controle positivo injetado; nenhum título real do inventário chega perto disso hoje (maior token: 15 caracteres).
- **Cobertura das execuções ao vivo:** as três capturas da página do Google não são idênticas (11/11/9 evidências; 118/118/116 ocorrências). Toda conclusão sobre CSS vem do A/B controlado sobre bytes de modelo idênticos; toda conclusão sobre conteúdo vem da checagem por linha dos PDFs reais.
- **Flakiness:** cada E2E foi rodado uma vez; o mutante foi rodado uma vez. O E2E de layout de impressão usa limites de página (1–2) num fixture sintético, não o PDF entregue.
- **Ambiente:** apenas Chrome for Testing 152.0.7977.64. Nenhuma medição em Chrome estável de usuário.

---

## 12. Recomendação

A 1.1.21 pode substituir a 1.1.20 como candidata: o achado Important está genuinamente fechado — na matriz do PDF entregue não há mais rótulo de item partido nem palavra partida, medido em bytes empacotados, em A/B controlado sobre o mesmo modelo e conferido página a página e visualmente; o artefato é exatamente a árvore revisada (199 entradas idênticas nos dois sentidos, digest fixado, `release-package` 7/7 com reconstrução de mesmo digest), o hash de CSP está correto no CSS empacotado e no HTML entregue, os quatro E2E exigidos passam e a fase paralela fecha em 4.180 testes (4.179 passam, 1 pulado, 0 falham), com os quatro Minors herdados ainda abertos exatamente como estavam. Antes de publicar, corrijo três frases que a medição não sustenta e que são fáceis de acertar: (a) "mesma paginação" — a CSS nova encurta a matriz e o documento em uma página no A/B controlado (15 → 14), então o texto deve dizer que a paginação mudou e que não houve perda de conteúdo; (b) "0 fragmentos de palavra" — vale para a matriz, não para o PDF inteiro, que ainda tem três quebras pré-existentes no cabeçalho do anexo; (c) a contrapartida em linguagem simples do Minor 5 existe só na aba interativa e não chega ao HTML/PDF entregue, de modo que o Minor 5 está corrigido pela metade — levar a cláusula ao renderizador de impressão é a correção completa. Recomendo ainda, no próximo incremento, um teste que fixe o comportamento de impressão da matriz (por exemplo, extrair o texto do PDF e exigir 0 quebras no meio de palavra), porque hoje o portão verde não distingue a 1.1.21 da 1.1.20 naquilo que este delta veio consertar.
