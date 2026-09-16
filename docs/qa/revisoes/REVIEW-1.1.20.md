# Revisão adversarial independente — Audita Acessibilidade 1.1.20

- Delta sob revisão: `1da3d68..f0a9192` (produto+testes) e `a73a9e3` (ZIP no controle de versão), checkout congelado `/private/tmp/audita-review-120` em `a73a9e3`.
- Artefato: `release/audita-acessibilidade-1.1.20.zip`.
- Baseline comparado: `release/audita-acessibilidade-1.1.19.zip` (revisão anterior, não revisada de novo aqui).
- Navegador: Chrome for Testing 152.0.7977.64, em `/private/tmp/audita-cft152-fixed/...`. Perfil temporário isolado, um workload de Chrome por vez.
- Todo o trabalho de scratch em `/private/tmp/adv120`. O checkout congelado não foi modificado (`git status --porcelain` vazio ao final).
- As medições de produto foram feitas sobre os **bytes empacotados**: o ZIP foi extraído em `/private/tmp/adv120/pkgrun`, e `test/` e `fixtures/` foram copiados para dentro dele. Referências `../../src/...` dos testes e do harness resolvem para o `src/` do pacote, não para a árvore.

---

## 1. Veredito

**Sim — a 1.1.20 pode substituir a 1.1.19 como candidata. 0 Critical, 1 Important, 5 Minor.**

As três alegações se reproduzem, na medição própria sobre os bytes empacotados, incluindo um par antes/depois empacotado (1.1.19 → 1.1.20) rodado pelo mesmo driver, mesma máquina e mesmo Chrome. O artefato confere (digest, 199 entradas, manifesto, byte a byte nos dois sentidos) e o portão de testes passa. Nenhuma alegação foi refutada.

O achado Important é uma **regressão de apresentação introduzida pela própria correção 2**: a regra `white-space:nowrap` no rótulo do item alarga a primeira coluna e estreita a coluna "Classificação", que passa a quebrar a palavra **"Recomendação" no meio** (`Recomendaçã` / `o ABNT`) em 50 das 146 linhas do PDF entregue. Medido no par empacotado e confirmado por A/B controlado sobre os mesmos bytes (regra ligada: 0 quebras de número de item e 50 quebras de palavra; regra desligada: 56 e 0). A alegação, lida literalmente ("rótulos de item"), continua verdadeira; a frase do README "a regra de impressão impede a quebra" é que fica incompleta — o total de quebras no meio de token na matriz impressa foi de **56 → 50, não 56 → 0**.

---

## 2. Verificação do artefato

| Verificação | Comando | Resultado |
|---|---|---|
| Digest exigido | `shasum -a 256 release/audita-acessibilidade-1.1.20.zip` | `140e30bb8884d27799e4df9252ea79186fd553471d9e46a54a3c6c0a56c6e1b1` — **confere** |
| Digest anterior | `shasum -a 256 release/audita-acessibilidade-1.1.19.zip` | `0e429e226e07e5de365e1fed6542398f1d2acb8e80eada4babb78e0e0af14ec9` — confere |
| Entradas | `unzip -Z1 ... \| wc -l` / `\| head -1` | **199** arquivos, primeira entrada `manifest.json` |
| `manifest.json` interno | leitura do JSON extraído | `version 1.1.20`, `version_name 1.1.20`, `manifest_version 3` |
| Byte a byte, pacote → árvore | script SHA-256 próprio, 199 arquivos | **0 divergências**, 0 ausentes na árvore |
| Byte a byte, árvore → pacote | `src/` (191), `vendor/` (3), `manifest.json`, 4 ícones | **0 ausentes**, 0 arquivos extras, 0 caminhos `test/ docs/ store-assets/ fixtures/ node_modules` |
| Suíte do pacote | `cd /private/tmp/adv120/tree && node --test test/release-package.test.js` | **7/7 passam** (inclui digest do arquivo entregue e reconstrução isolada) |

Comparação com a árvore feita por script próprio, não pelo teste do autor; o teste do autor foi rodado em cópia da árvore em `/private/tmp/adv120/tree` (o checkout congelado não foi tocado, e permaneceu limpo).

---

## 3. Alegação 1 — limitação repetida no sumário executivo

**Situação: REPRODUZIDA**, nos dois renderizadores, no PDF entregue, no HTML entregue, na aba interativa e no HTML de impressão; e com testes de mutação provando que cada renderizador é coberto.

### 3.1 Onde a duplicação nasce (leitura de código, pacote)

- `deriveSystemLimitations` (`src/core/report/text-policy.js`) empurra a frase simples do conjunto fechado de diagnósticos de política para `model.limitations` (linhas 181–187).
- `projectExecutive` (`src/review/report-view.js:290-303`) monta `view.executive.limitations` como união de `model.limitations` **mais** `${code}: ${message}` de **todos** os diagnósticos.
- `listedLimitations` (novo, `text-policy.js:199-207`) remove da lista qualquer entrada que seja exatamente o corpo de uma entrada no formato `^[A-Z][A-Z0-9_]{3,}: ([\s\S]+)$`.
- Os dois renderizadores usam a mesma função: `src/review/report-view.js:988` (aba interativa) e `src/core/report/html.js:282` (HTML entregue **e** HTML de impressão, que é o mesmo caminho com `forPrint`). Confirmado por leitura e por mutação.

### 3.2 Medição pareada no artefato (meus próprios runs empacotados, página real do Google)

Driver próprio `/private/tmp/adv120/drivers/live-google.mjs`, pacote extraído, `downloadMode: 'profile'`, mesmo Chrome, runs separados por ~1 minuto, ambos com cobertura 28,5% e índice 9,0/10:

```
AUDITA_RUN_ROOT=/private/tmp/adv120/pkgrun119 AUDITA_KEEP_DIR=/private/tmp/adv120/artifacts-119-own AUDITA_LABEL=pkg119 \
  AUDITA_E2E_CHROME=".../Google Chrome for Testing" node --test --test-concurrency=1 live-google.mjs
AUDITA_RUN_ROOT=/private/tmp/adv120/pkgrun     AUDITA_KEEP_DIR=/private/tmp/adv120/artifacts-120-own AUDITA_LABEL=pkg120 \
  AUDITA_E2E_CHROME=".../Google Chrome for Testing" node --test --test-concurrency=1 live-google.mjs
```

| Medida | 1.1.19 empacotada (meu run) | 1.1.20 empacotada (meu run) |
|---|---|---|
| versão no relatório | 1.1.19 | 1.1.20 |
| aba interativa: título | `Limitações registradas (8) · Modo sem imagens: nenhuma captura raster.` | `Limitações registradas (6) · Modo sem imagens: nenhuma captura raster.` |
| aba interativa: `<li>` | 8 | 6 |
| HTML entregue: `<summary>` / `<li>` | `(8)` / 8 | `(6)` / 6 |
| HTML entregue: frases distintas | 6 (2 repetidas) | 6 (0 repetidas) |
| PDF entregue: entradas antes do "Índice técnico" | 8 | 6 |
| PDF entregue: título | `(8)` | `(6)` |
| downloads completos | 4/4 | 4/4 |

O mesmo padrão aparece nos artefatos de referência do autor, que eu **re-medi** (`/private/tmp/g119/artifacts` e `/private/tmp/g119/artifacts-tree`): HTML `(8)`/8 itens/6 distintas → `(6)`/6 itens/6 distintas; PDF 8 → 6 entradas.

### 3.3 HTML de impressão (não só o entregue)

Renderização in-process a partir do pacote (`renderHtmlReport(model, {reportView, forPrint:true})`), bloco extraído por regex:

- `forPrint=false` → `Limitações registradas (3)`, 3 `<li>`, 3 frases distintas, 0 repetições.
- `forPrint=true` → `Limitações registradas (3)`, 3 `<li>`, 3 frases distintas, 0 repetições.

O título conta o que a lista mostra nos dois casos (contrato "contagem = itens renderizados" verificado também no caso real de 6 itens).

### 3.4 O teste novo cobre os dois renderizadores (teste de mutação)

Em cópias do pacote (`/private/tmp/adv120/mut2`, `mut3`):

- Revertendo **só** `src/core/report/html.js` para `view.executive.limitations`: `test/review/report-view.test.js` → **53 testes, 52 passam, 1 falha** — exatamente `a limitation that is also a policy diagnostic is not stated twice in the details list`.
- Revertendo **só** `src/review/report-view.js`: **mesma falha**.

Ou seja, o teste falha se qualquer um dos dois renderizadores voltar ao comportamento antigo. A tentativa anterior do autor (corrigir só o DOM) seria pega por este teste hoje.

### 3.5 Entradas adversariais em `listedLimitations` (pacote, `/private/tmp/adv120/probe/limitations-probe.mjs`)

| Entrada | Saída | Leitura |
|---|---|---|
| `undefined` / string / objeto | `[]` | não lança; ver Minor 4 |
| `['MSG','CODE: MSG']` | `['CODE: MSG']` | dedup correto |
| `['MSG','CODE_A: MSG','CODE_B: MSG']` | `['CODE_A: MSG','CODE_B: MSG']` | frase única ainda aparece duas vezes (ver Minor 2) |
| `['CODE_A: MSG']` (sem par simples) | mantido | correto |
| `['CODE: ']` (corpo vazio) | mantido | correto (não casa) |
| `['', 'CODE: ']` | ambos mantidos | correto |
| `ABCD: MSG` (4 chars) | dedup funciona | correto |
| `ABC: MSG` / `AB: MSG` (3 e 2 chars) | **não** dedup | lacuna do heurístico; hoje inalcançável |
| `code: MSG`, `CODE-A: MSG`, `CODE.A: MSG`, `1CODE: MSG` | não dedup | lacuna do heurístico |
| `CODE:  MSG` (dois espaços) | corpo = ` MSG`; não dedup de `MSG` | lacuna do heurístico |
| `['MSG','CODE: MSG\n']` | ambos mantidos | `$` sem flag `m` não casa antes do `\n` final |
| multilinha `['l1\nl2','CODE: l1\nl2']` | dedup correto | `[\s\S]` funciona |
| `['CODE_A: MSG','CODE_B: CODE_A: MSG']` | só `CODE_B: ...` | perda de uma entrada codificada (contrived) |
| `[null, 42, 'CODE: MSG','MSG']` | `[null,42,'CODE: MSG']` | não lança |

**Alcançabilidade das lacunas hoje: nenhuma.** O conjunto fechado de diagnósticos de política tem 55 códigos distintos; o menor tem 15 caracteres; **todos** casam `^[A-Z][A-Z0-9_]{3,}$`. Das 46 mensagens de política, **0** se parecem com forma codificada. O caminho de dados (`${code}: ${message}`) sempre usa um espaço. Ou seja: nenhuma limitação que o usuário precisava ver é perdida nos dados reais — verifiquei no PDF entregue: as frases simples removidas continuam presentes **dentro** da entrada codificada (`Nenhuma captura raster...` ocorre 1× no PDF de 1.1.20, dentro de `PIXEL_CAPTURE_OMITTED: ...`, contra 2× em 1.1.19).

---

## 4. Alegação 2 — rótulo de item inteiro na matriz impressa

**Situação: REPRODUZIDA como enunciada, com efeito colateral não declarado (o achado Important).**

### 4.1 Medição pareada no PDF entregue (meus runs empacotados)

Contagem de quebras no meio do token: linha terminando em `\d+\.` seguida de linha começando por dígito.

| | 1.1.19 (meu) | 1.1.20 (meu) | autor 1.1.19 | autor 1.1.20 (árvore) |
|---|---|---|---|---|
| páginas do PDF | **18** | **18** | 18 | 18 |
| linhas da matriz | 146 (147 células "ABNT" = 146 + título) | 146 | 146 | 146 |
| rótulos de item quebrados | **56** | **0** | **56** | **0** |

Reproduz exatamente os números do autor, e nos meus próprios bytes empacotados. Amostras de 1.1.19: `5.10.|1`, `5.10.|2`, `5.11.|2`, `5.1.1|4`.

### 4.2 A regra é a causa (A/B controlado sobre bytes idênticos)

Driver `/private/tmp/adv120/drivers/print-ab.mjs`, HTML de impressão renderizado do pacote, três variantes do **mesmo** HTML:

- **A** = CSS empacotado (com `.matrix-scroll th[scope="row"]{white-space:nowrap}`)
- **B** = mesma CSS sem essa única regra, hash de CSP **recalculado** (variante honesta)
- **C** = mesma CSS sem a regra, hash de CSP **obsoleto** (para medir o que um hash velho faz)

| | A (regra ligada) | B (regra desligada) |
|---|---|---|
| páginas do PDF | **15** | **15** |
| quebras de número de item | **0** | **56** |
| `white-space` computado no `th[scope=row]` | `nowrap` | `normal` |
| largura da 1ª coluna | 59,7 px | 52,89 px |
| altura da tabela da matriz | 5.897,5 px | 6.371,2 px |
| **tabela de anexos** (altura / célula `th scope=row`) | 245,69 px / 83,47×94,16 px | **idênticos** |
| font-size do parágrafo (CSS aplicada) | 14 px | 14 px |
| nós com overflow cortado | 0 | 0 |

A regra é, portanto, a causa direta das 56 quebras de 1.1.19 e da ausência delas. A tabela de anexos de evidências **não é afetada**: a regra é descendente de `.matrix-scroll`, e no HTML de impressão existe **um único** `class="matrix-scroll"` (a matriz), cujo `</div>` fecha antes da tabela de anexos; a geometria dos anexos é idêntica em A e B. No HTML de impressão do fixture, o corpo tem 148 células `th scope=row`: 146 dentro da matriz e 2 na tabela de anexos, fora do escopo da regra (a mesma estrutura vale no relatório real, com mais linhas de anexo).

Comparação visual (página 7 rasterizada, `sips`): variante A mostra `5.1.10`, `5.1.12`, `5.1.13`, `5.1.14` inteiros; variante B mostra `5.1.1` / `0`, `5.1.1` / `2`, `5.1.1` / `3`.

### 4.3 Achado Important — a correção troca 56 quebras de número por 50 quebras de palavra

Detector rigoroso (fragmento no fim da linha que **não** é palavra do vocabulário, mas cuja concatenação com o começo da linha seguinte é palavra presente no HTML íntegro do mesmo relatório):

| PDF entregue | quebras de número de item | quebras no meio de palavra |
|---|---|---|
| 1.1.19 (meu run empacotado) | 56 | **0** |
| 1.1.20 (meu run empacotado) | 0 | **50 × `Recomendaçã` + `o` → `Recomendação`** |
| 1.1.19 (referência do autor) | 56 | 0 |
| 1.1.20 (referência do autor, árvore) | 0 | **50 × idem** |
| variante A (regra ligada, mesmos bytes) | 0 | **50** |
| variante B (regra desligada, mesmos bytes) | 56 | **0** |

Causa: `.matrix-scroll th[scope="row"]{white-space:nowrap}` alarga a 1ª coluna (52,89 → 59,7 px) e estreita a coluna "Classificação", que contém `Recomendação ABNT`. Com a CSS de impressão da matriz (que usa quebra por caractere: `overflow-wrap:anywhere` ×16 e `word-break:break-all` no arquivo), "Recomendação" deixa de caber e parte-se em `Recomendaçã` / `o ABNT`. Em 1.1.19 a palavra ficava inteira e só "ABNT" ia para a segunda linha.

Impacto: cosmético, sem perda de dado ou de sentido (o texto continua legível e ambos os fragmentos aparecem). Mas é **introduzido pela mudança**, é visível em ~1/3 das linhas da matriz do PDF entregue, e contradiz a leitura natural da frase do README — "56 dos 146 números de item quebravam no meio ... a regra de impressão impede a quebra, e a medição do mesmo PDF caiu para zero". A medição de *rótulos de item* caiu para zero; a de *quebras no meio de token na matriz* foi de 56 para 50. Não é regressão de dado nem de paginação, e não invalida a alegação como escrita — mas deveria ser corrigido (por exemplo, `white-space:nowrap` também na célula de classificação, ou `overflow-wrap:normal` nas células da matriz) ou declarado no README.

### 4.4 Paginação e outras tabelas

- Par empacotado real: 18 → 18 páginas.
- A/B controlado: 15 → 15 páginas; tabela de anexos idêntica; nenhum nó com overflow cortado; a única outra tabela do HTML de impressão é a de anexos.
- A regra está **dentro** do bloco `@media print` (verificação por varredura de chaves: bloco delimitador `@page{...}\n@media print{`) e **não** aparece na seção de tela — a matriz da aba interativa não muda.

---

## 5. Alegação 3 — medições declaradas (18/18, 56/0, 8/6, 2/0, (8)/(6))

**Situação: REPRODUZIDA integralmente**, com medição própria sobre bytes empacotados:

| Medida declarada | Declarado | Medido por mim (par empacotado próprio) |
|---|---|---|
| páginas do PDF | 18 → 18 | 18 → 18 |
| rótulos de item quebrados | 56 → 0 | 56 → 0 |
| entradas de limitação | 8 → 6 | 8 → 6 |
| frases repetidas | 2 → 0 | 2 → 0 |
| título | (8) → (6) | (8) → (6) |

Ressalva declarada no próprio README do autor: a tabela dele compara "1.1.19 empacotada" com "1.1.20 **da árvore**". O que eu acrescento é a perna que faltava: **1.1.20 a partir dos bytes empacotados**, medida agora, com os mesmos números.

---

## 6. CSP

- Hash declarado no pacote: `sha256-5WbvaexQZLTkq1hshbOAr04inQqSIE0FA6Kyu5IaVx4=`.
- Hash calculado por mim sobre `REPORT_CSS` do pacote (`sha256` → base64): **idêntico**.
- No HTML entregue do meu run: `style-src 'sha256-5Wbvaex...'` e o hash recalculado do próprio `<style>` embutido confere; o hash antigo (`sha256-xHwS8IcG...`) não aparece em nenhum byte empacotado.
- **Um hash obsoleto seria pego?** Sim, pela suíte: mutando `REPORT_CSS_CSP_HASH` de volta para o valor de 1.1.19 em cópia do pacote (`/private/tmp/adv120/mut`), `node --test test/report/html.test.js` falha em `uses exact CSP hashes for static CSS and script with no executable audited content` (o teste recalcula o hash a partir do `<style>` renderizado, não compara com literal fixo).
- **Existe caminho em que um hash velho desestiliza em silêncio?** Sim, em tempo de execução: a variante C do A/B (CSS sem a regra + hash obsoleto) produziu um PDF de **11 páginas sem estilo** (fonte 16 px em vez de 14 px, tabela 740 px, altura de célula 38 em vez de 49), sem erro e sem aviso — só a violação de CSP, silenciosa. Não há verificação de hash em tempo de execução no produto (`REPORT_CSS_CSP_HASH` só é usado para montar o `<meta>` de CSP em `html.js:96,165`). A rede de segurança é a suíte, e ela funciona.

---

## 7. Outros consumidores de `view.executive.limitations` / da contagem antiga

Busca no pacote (`src/`):

- `report-view.js:989` e `html.js:288` — os dois únicos consumidores da **contagem/lista renderizada**; ambos usam `listedLimitations`. Nenhum outro ponto usa `view.executive.limitations.length`.
- `report-view.js:910,969,971` — `hasAttachedCopyReloadedLimitation`, `noPixelEvidence`, `elementOnlyEvidence` usam `.includes()` na lista **não filtrada**; continuam corretos porque as entradas codificadas permanecem na lista (o caso `FULL_PAGE_CAPTURE_OMITTED` é justamente o contrato fixado em teste).
- `review.js:388` e `applyReportSourceControls` recebem a lista não filtrada — correto.
- `map.limitations` (`html.js:335`, `report-view.js:1088`) é outro campo (mapa de anúncios), não tocado.
- CSV: **não carrega texto de limitação** em nenhuma das duas versões (0 ocorrências).
- JSON entregue: `audit.limitations` = 5 frases simples e `session.diagnostics` = 3 códigos, **idênticos** entre 1.1.19 e 1.1.20 — a correção é só de apresentação, o dado não mudou.

---

## 8. Regressão (E2E a partir dos bytes empacotados)

Um Chrome por vez, `--test-concurrency=1`, `downloadMode: 'profile'` (os testes de download já passam esse modo).

1. **Os quatro exigidos** (`current-page-export-mv3`, `report-print-layout`, `report-executive-print`, `mandatory-journey-mv3`): **4/4 passam**, 10,1 s. Diagnósticos: `downloaded full=22 pages; summary=9 pages; all146ABNTitems`, `live full=34 pages; summary=10 pages; all146ABNTitems`, `print-layout=A4; pages=2`, jornada com `formats=html,pdf,csv,json`.
2. **Fase serial completa** (33 arquivos; excluído `sidepanel-flow-mv3.test.mjs`, que pertence a outro incremento e que a triagem do próprio autor mapeia como falha de outro dono): **53 testes, 51 passam, 2 falham** — sendo 1 teste-folha (`cancel while paused removes only the owned tab and produces no report`, em `url-pixel-consent-mv3`, 30,59 s, `PRIVACY_PAUSE_TIMEOUT`) e o teste-pai que o agrega. Reexecutado isolado: **10/10 passam**, com o mesmo caso em **1,3 s**. É a classe documentada de teto de 30 s por comando do harness sob carga; o arquivo não toca impressão, matriz nem limitações (`grep` vazio para `matrix|limitations|printToPDF|renderHtmlReport|report.css`).
3. **Fase paralela**: 4.136 testes, 4.135 passam, 0 falham, 1 pulado (nenhum E2E); mais os dois arquivos process-safe de `test/e2e` (`axe-mv3-csp-decision`, `support/real-chrome`) com 44/44. Total **4.180 testes, 4.179 passam, 0 falham**, exatamente o número documentado pelo autor.
4. Nota: nas minhas cópias sintéticas de raiz de pacote (`pkgrun`) aparecem 6 falhas que **não são do produto** — `README.md`, `store-assets/screenshot-panel.png`, `.git` e afins não existem nessa raiz. Rodada na árvore completa: 0 falhas.

---

## 9. Achados não declarados pelo autor

| # | Severidade | Achado |
|---|---|---|
| 1 | **Important** | A regra `nowrap` alarga a 1ª coluna e faz a coluna "Classificação" quebrar "Recomendação" no meio, em **50 das 146 linhas** do PDF entregue (0 antes). Total de quebras no meio de token na matriz: 56 → 50, não 56 → 0. Medido no par empacotado próprio, no par de referência do autor e nas variantes A/B controladas. Sem perda de dado; a frase do README fica incompleta. |
| 2 | Minor | Duplicação residual da mesma classe: **12 códigos `ANNOTATION_MAP_*` compartilham a mesma mensagem** (`O mapa visual derivado não pôde ser gerado localmente; ...`). Se dois deles ocorrerem na mesma auditoria (ex.: páginas diferentes de um lote), a lista mostra a mesma frase duas vezes — uma por código — e o título conta 2 para 1 frase distinta. Mecanismo medido (`['MSG','CODE_A: MSG','CODE_B: MSG']` → 2 entradas); a ocorrência em auditoria real de lote é **inferência**, não medida. |
| 3 | Minor | `listedLimitations` é heurística de forma, não o conjunto fechado que o próprio módulo já tem (`SYSTEM_LIMITATION_SET` / `isCanonicalSystemLimitation`). Lacunas medidas e hoje inalcançáveis: código com menos de 4 caracteres, com hífen/ponto/minúscula, corpo com espaço duplo, entrada codificada terminando em `\n`, e códigos encadeados (`CODE_B: CODE_A: MSG` derruba a entrada `CODE_A: MSG`). No conjunto atual: 55 códigos, menor com 15 caracteres, todos casando. |
| 4 | Minor | Entrada **não-array** devolve `[]` em silêncio. Num relatório cujo valor é a honestidade, uma `view` malformada passaria a afirmar "Nenhuma limitação crítica registrada." em vez de falhar. Hoje inalcançável (`projectExecutive` sempre monta array e a `view` é validada/congelada), mas é um caminho "fail-open" novo. |
| 5 | Minor | A frase simples do diagnóstico `DYNAMIC_PROBES_OMITTED_PASSIVE` agora aparece **só dentro da entrada codificada**; a linha de título só tem contrapartida em linguagem simples para o caso "sem imagens" (`Modo sem imagens: nenhuma captura raster.`). Medido: a frase passa de 2 para 1 ocorrência no PDF; o leitor não técnico precisa ler o código em maiúsculas para entender a limitação. |
| 6 | Minor | Um hash de CSP obsoleto desestiliza o relatório **silenciosamente** (variante C: 11 páginas sem estilo, sem erro); não há verificação em tempo de execução. A suíte pega (mutação confirmada), mas quem empacotar sem rodar a suíte entrega um PDF quebrado sem aviso. |

---

## 10. Retratações

Registro do que eu mesmo afirmei e tive de retirar durante esta revisão (nenhuma dessas afirmações chegou a ser enviada ao agente pai):

1. **"194 arquivos de `src/`/`vendor/` estão fora do pacote"** — falso; era um bug do meu primeiro script (comparava o caminho relativo sem juntar o prefixo `src/`). Corrigido: 0 ausentes nos dois sentidos.
2. **"A quebra de 56 rótulos não se reproduz: a 1.1.19 também dá 0"** — falso; meu primeiro medidor procurava a seção pelo título `Matriz ABNT`, que não existe nesse ponto do texto extraído, e devolvia região vazia. Corrigido (delimitação pelas páginas que contêm `Item Título`): 56 na 1.1.19, 0 na 1.1.20, nos quatro PDFs.
3. **"O JSON entregue da 1.1.20 mudou de forma (`KeyError: 'audit'`)"** — falso; meu glob pegou o `measurement-pkg120.json` do meu próprio driver. Com o padrão `audita-*.json`, a forma e o conteúdo são idênticos entre 1.1.19 e 1.1.20.
4. **"A tabela de anexos fica dentro do `.matrix-scroll`"** — falso; meu primeiro probe achou `data-report-annex` dentro do `<style>` (regra de impressão), não no corpo. Corrigido: a tabela de anexos está fora do scroller, e a geometria dela é idêntica com e sem a regra.

---

## 11. Não verificado / risco residual

- **Não medi** o fluxo completo dos 34 arquivos E2E seriais: `test/e2e/sidepanel-flow-mv3.test.mjs` foi excluído por instrução (pertence a outro incremento, modificado no worktree do autor). O autor documenta 7–9 falhas ali, de outro dono.
- **Não medi** a impressão da aba interativa por um usuário real (diálogo do Chrome). A regra vale também nesse caminho (mesma CSS, `@media print`), e a matriz vem do mesmo `.matrix-scroll`, mas a medição foi feita no HTML de impressão entregue e no PDF do pacote.
- **Não medi** a variante C numa aba interativa; a degradação por hash obsoleto foi medida no caminho de impressão/PDF, que é o que o hash governa no documento entregue.
- **Inferência, não medição**: a duplicação residual dos 12 códigos `ANNOTATION_MAP_*` só foi demonstrada no mecanismo; não construí uma auditoria de lote real que dispare dois códigos distintos dessa família.
- **Cobertura da alegação 3**: os dois runs ao vivo são capturas separadas (segundos diferentes, mesmo `coverage` 28,5% e mesmo índice 9,0/10). A parte de CSS está protegida por A/B sobre bytes idênticos; a parte de limitações é função do dado do modelo, não do layout.
- **Flakiness**: cada E2E foi rodado uma vez (exceto o caso do `url-pixel-consent`, que passou isolado). `mandatory-journey-mv3` tem histórico de intermitência no próprio doc do autor; passou aqui.
- **Não re-verifiquei** os 9 E2E do workstream alheio, nem as afirmações de documentação que não envolvem esta mudança (lista da loja, instruções de teste) além de conferir que a versão citada é 1.1.20 e que o README diz explicitamente que a revisão independente deste artefato ainda não havia sido feita.
- Ambiente: apenas Chrome for Testing 152.0.7977.64 (o outro caminho registrado está quebrado, como avisado). Nenhuma medição em Chrome estável de usuário.

---

## 12. Recomendação

A 1.1.20 pode substituir a 1.1.19 como candidata: as três alegações se reproduzem na medição independente sobre os bytes empacotados, o artefato é exatamente a árvore revisada (199 arquivos idênticos nos dois sentidos, digest fixado), o hash de CSP está correto e protegido por teste, nenhum outro consumidor depende da contagem antiga, e o portão de testes passa — incluindo os quatro E2E exigidos, a fase paralela 4.180/4.179/0 e a fase serial com uma única falha intermitente que passa isolada e não toca o caminho alterado. Antes de entregar, porém, resolver ou declarar o achado Important: a correção 2 eliminou as 56 quebras de número de item mas criou 50 quebras da palavra "Recomendação" na coluna vizinha do PDF entregue, de modo que o total de quebras no meio de token da matriz impressa foi de 56 para 50 — o README deveria dizer isso com precisão, ou a CSS deveria impedir também a quebra na célula de classificação (a tabela tem folga: a largura total não mudou entre as variantes A e B). Os cinco Minor são de robustez e de legibilidade, não bloqueiam a substituição, mas os dois primeiros (duplicação residual por mensagem compartilhada e heurística de forma no lugar do conjunto fechado já existente no módulo) merecem uma linha no próximo incremento para que a mesma classe de defeito não volte por outro caminho.
