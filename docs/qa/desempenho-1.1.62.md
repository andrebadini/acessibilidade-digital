# Desempenho geral — 1.1.62

Versão alvo: 1.1.62 (branch `wip162/desempenho`). O `manifest.json` ainda declara 1.1.61, porque a
subida de versão acontece no processo de release.
Data da validação: 2026-10-16. Chrome for Testing 152.0.7977.64, Node 26.5.0, macOS (Apple Silicon).

Pedido do dono do produto (literal): *"Melhorar o desempenho geral, na medida do possível e sem
prejudicar as funcionalidades."*

Regra desta rodada: **medir primeiro**. Nenhuma otimização entrou sem número medido antes e depois, e
cada uma tem teste que prova que a função continua idêntica. Nada de cobertura, qualidade de
evidência, integridade, privacidade ou limite de segurança foi reduzido para ganhar tempo.

---

## 1. Como foi medido

### 1.1 Instrumentação (desligada por padrão)

`src/background/perf-log.js` (novo) concentra a medição: `perfBegin()`, `perfEnd()`, `perfCount()`,
`perfWrapCdp()`, `readPerfLog()`, `clearPerfLog()`. Sem `globalThis.__auditaPerf === true`, cada ponto
de medição custa **uma comparação booleana** e nada é guardado; `perfWrapCdp` devolve o próprio cliente
CDP recebido, sem `Proxy`. **Nenhum número de medição entra no modelo, no relatório ou no IndexedDB** —
é instrumentação de bancada, lida de fora com o Chrome aberto.

Pontos instrumentados (só marcas, sem mudança de comportamento):

- `src/background/run-audit.js`: `abrir-e-navegar`, `axe`, `ambiente`, `aquecimento-pagina`,
  `coleta-estrutural`, `captura-integral`, `sondas-dinamicas`, `sonda-hover`, `regras-proprias`,
  `evidencias`, `mapa-anuncios`, `mapa-teclado`, `apresentacao`, `modelo-handoff`, `modelo-final`,
  `total`, `rascunho-hashes` / `rascunho-clone` / `rascunho-congelar`, `enriquecer-modelo`,
  `gravacao-indexeddb`; e `perfWrapCdp(cdp, auditId)` para o perfil por método CDP.
- `src/background/authorized-audit-starter.js`: `persist-verificar-integridade`,
  `persist-bundle-painel`, `persist-gravar-terminal`.

### 1.2 Campanha

`scripts/perf-audit.mjs` (novo) roda a auditoria de verdade no Chrome real, por
`test/e2e/support/real-chrome.mjs`, com `--url`, `--runs N`, `--no-fixture`, `--no-journey`,
`--no-export`. Ele liga a chave de medição no worker **e** no painel, lê os dois registros, mede o
tamanho do modelo gravado (`MODEL_SIZE(auditId)`, leitura no IndexedDB: MB total, MB de imagem,
número de evidências, nós e ocorrências) e mede a jornada de quem usa: abrir o painel com resultado →
"Abrir relatório completo" → verificação guiada → exportação dos quatro formatos. Todas as tabelas
deste relatório são **mediana de 2 execuções**.

Cenários: a página de teste local com marcação conhecida (fixture) e um portal público real
(~2.276 nós, ~350 ocorrências, 110 evidências, modelo de ~42 MB).

### 1.3 Micro-benchmark das conversões base64 (carga de 3 MB, mediana de 7)

| operação | 1.1.61 | intermédio | 1.1.62 (nativo) | ganho total |
| --- | ---: | ---: | ---: | ---: |
| decodificar 3 MB (`fromBase64`) | 116,4 ms | 4,1 ms (laço indexado) | 0,5 ms | **235×** |
| codificar 3 MB (`toBase64`) | 50,9 ms | 9,0 ms (`apply` por partes) | 0,3 ms | **162×** |

As duas colunas da 1.1.61 usavam a API da forma mais custosa possível: `Uint8Array.from(binary, c =>
c.charCodeAt(0))` chama uma função por byte, e `String.fromCharCode(...subarray)` espalha 32 KiB como
argumentos. As três implementações produzem bytes e strings **idênticos** (teste de equivalência
abaixo).

---

## 2. Tabela antes/depois — página de teste local

Fixture de marcação conhecida, mediana de 2 execuções. O modelo é o mesmo nos dois lados — 70
evidências, 579 nós e 322 ocorrências, com 5,79 MB (5,07 MB de imagem) antes e 5,78 MB (5,06 MB) depois
—, ou seja: **a comparação é do mesmo trabalho**.

| fase | antes (1.1.61) | depois (1.1.62) | ganho |
| --- | ---: | ---: | ---: |
| abrir-e-navegar | 1 ms | 1 ms | — |
| axe | 100 ms | 91 ms | — |
| ambiente | 1 ms | 1 ms | — |
| aquecimento-pagina | 1.263 ms | 1.267 ms | — (deliberado, ver §5) |
| coleta-estrutural | 335 ms | 316 ms | — |
| captura-integral | 145 ms | 134 ms | — |
| sondas-dinamicas | 5 ms | 4 ms | — |
| sonda-hover | 10 ms | 8 ms | — |
| regras-proprias | 104 ms | 79 ms | — |
| **evidencias** | **2.597 ms** | **2.127 ms** | 1,2× |
| mapa-teclado | 401 ms | 133 ms | 3,0× |
| apresentacao | 2 ms | 1 ms | — |
| modelo-handoff | 20 ms | 15 ms | — |
| modelo-final | 15 ms | 14 ms | — |
| **enriquecer-modelo** | **1.922 ms** | **581 ms** | **3,3×** |
| **gravacao-indexeddb** | **5.646 ms** | **787 ms** | **7,2×** |
| · persist-verificar-integridade | 361 ms | 75 ms | 4,8× |
| · persist-bundle-painel | 3.614 ms | 114 ms | **31,7×** |
| · persist-gravar-terminal | 1.671 ms | 599 ms | 2,8× |
| rascunho-hashes / clone / congelar | 19 / 13 / 4 ms | 15 / 11 / 3 ms | — |
| **total (fases do worker)** | **5.096 ms** | **4.218 ms** | 1,2× |

Detalhe do enriquecimento (medido dentro da fase):

| etapa interna | antes | depois |
| --- | ---: | ---: |
| enr-hashes-1 (hash das evidências) | 349 ms | 53 ms |
| enr-hashes-2 (rehash na verificação) | 342 ms | 52 ms |
| enr-modelo-1 (`createAuditModel`) | 290 ms | 141 ms |
| enr-modelo-2..5 (4 passadas) | 129 ms cada | 53-54 ms cada |
| enr-verificacao-final | 376 ms | 74 ms |

Relógio de parede e jornada de quem usa:

| etapa | antes | depois | ganho |
| --- | ---: | ---: | ---: |
| auditoria até o resultado aparecer | 13.186 ms | 6.053 ms | **2,2×** |
| painel com os cartões | 1 ms | 1 ms | — |
| "Abrir relatório completo" | 1.019 ms | 382 ms | 2,7× |
| verificação guiada | 1.021 ms | 384 ms | 2,7× |
| exportação dos quatro formatos | 4.876 ms | 3.408 ms | 1,4× |

## 3. Tabela antes/depois — portal público real

Mediana de 2 execuções (64,3 s → 27,1 s até o resultado). O conteúdo do portal muda entre execuções
(110-111 evidências, 350-352 ocorrências, modelo de 42-45 MB), então **as fases de captura têm ruído
de alguns pontos percentuais**; as fases abaixo mudam muito além disso.

| fase | antes (1.1.61) | depois (1.1.62) | ganho |
| --- | ---: | ---: | ---: |
| aquecimento-pagina | 1.121 ms | 1.126 ms | — (deliberado) |
| coleta-estrutural | 727 ms | 701 ms | — |
| sonda-hover | 8.057 ms | 8.102 ms | — (deliberado, ver §5) |
| **evidencias** | **9.729 ms** | **8.398 ms** | 1,2× |
| mapa-teclado | 1.335 ms | 353 ms | 3,8× |
| **enriquecer-modelo** | **13.159 ms** | **2.969 ms** | **4,4×** |
| **gravacao-indexeddb** | **25.220 ms** | **3.297 ms** | **7,6×** |
| · persist-verificar-integridade | 2.737 ms | 439 ms | 6,2× |
| · persist-bundle-painel | 10.717 ms | 298 ms | **36,0×** |
| · persist-gravar-terminal | 11.766 ms | 2.561 ms | 4,6× |
| **total (fases do worker)** | **23.907 ms** | **19.987 ms** | 1,2× |

| etapa | antes | depois | ganho |
| --- | ---: | ---: | ---: |
| auditoria até o resultado aparecer | 64.348 ms | 27.104 ms | **2,4×** |

Perfil CDP (o que sobra de custo externo à extensão):

| método CDP | antes | depois | chamadas |
| --- | ---: | ---: | ---: |
| `Page.captureScreenshot` | 7.410 ms | 7.313 ms | 110 → 109 |
| `Page.getLayoutMetrics` | 33 ms | 35 ms | 121 → 120 |
| `DOM.getOuterHTML` | 37 ms | 33 ms | 108 → 107 |
| `DOM.getContentQuads` | 16 ms | 18 ms | 108 → 107 |
| `Accessibility.getFullAXTree` | 17 ms | 17 ms | 2 |
| `Page.captureScreenshot` (fixture) | 2.104 ms | 1.952 ms | 69 |

Detalhe do enriquecimento no portal (cinco passadas de `createAuditModel` e dois hashes por artefato,
como na página de teste):

| etapa interna | antes | depois |
| --- | ---: | ---: |
| enr-hashes-1 | 2.597 ms | 328 ms |
| enr-hashes-2 | 2.653 ms | 319 ms |
| enr-modelo-1 | 1.701 ms | 591 ms |
| enr-modelo-2..5 (4 passadas) | 804-806 ms cada | 274-276 ms cada |
| enr-verificacao-final | 2.771 ms | 440 ms |

**Leitura:** o custo do Chrome (compositor) é o piso que sobra. Das 8,4 s da fase `evidencias` no
portal, **7,3 s são `Page.captureScreenshot`** — 87% da fase é uma chamada que esta rodada não podia
tocar (§6, recomendação 1).

---

## 4. O que foi otimizado

### OPT-1 — conversão base64 ↔ bytes em `src/core/evidence/png.js` (o maior ganho)

**Problema medido.** Toda evidência passa por `decodePngDataUrl` (validar a captura) e por
`bytesToBase64` (provar que o base64 é canônico). Nas contas do dono do produto, `hashEvidenceArtifact`
roda duas vezes por artefato no enriquecimento e outra vez na verificação de integridade antes de
gravar; o empacotamento do painel revalida o mesmo conteúdo outra vez. Cada passada decodificava e
recodificava os mesmos megabytes com um laço por byte.

**Causa raiz.** `Uint8Array.from(binary, character => character.charCodeAt(0))` (uma chamada de função
por byte) e `String.fromCharCode(...bytes.subarray(...))` (32 KiB espalhados como argumentos).
Medidos: 116,4 ms e 50,9 ms por 3 MB.

**Solução.** Usar as APIs nativas quando existem (`Uint8Array.fromBase64`, `toBase64` — 0,5 ms e
0,3 ms), com o laço indexado e o `apply` por partes como caminho de compatibilidade para o Chrome
mínimo. O limite de bytes continua sendo checado **antes de qualquer alocação** (agora em O(1), pelo
comprimento da string, sem varredura caractere a caractere) e a prova de canonicidade passou a ser a
re-codificação comparada com a entrada — que rejeita exatamente o mesmo conjunto de entradas inválidas
(símbolo fora do alfabeto, `=` fora do fim, bits residuais não nulos) e ainda aceita o que antes era
aceito. `canonicalBase64DecodedLength` continua exportada e inalterada para os artefatos de mapa.

**Testes.** `test/evidence/png.test.js`: contrato de canonicidade (inclusive `payload.slice(0,-1)+'A'`,
que continua sendo base64 canônico e só falha na estrutura PNG, como na 1.1.61), equivalência
nativo × alternativa (`delete Uint8Array.fromBase64; delete Uint8Array.prototype.toBase64` +
reimportação com `?sem-nativo`, comparando bytes e mensagens de erro), e o teste de payload gigante
passou a contar as **duas** rotas (`atob` e `fromBase64`) — nenhuma alocação acontece antes da
recusa. 13/13 passam.

### OPT-2 — fim da decodificação por ocorrência no painel (`src/panel/panel-detail.js`)

**Problema medido.** `persist-bundle-painel`: 3.614 ms na página de teste e 10.717 ms no portal —
maior que a própria auditoria em alguns casos.

**Causa raiz.** As ocorrências do modelo apontam para o mesmo artefato (`evidenceIds`). Ao montar a
prévia, o painel revalidava o `dataUrl` de cada artefato **uma vez por referência**: o mesmo PNG de
4,3 MB era decodificado centenas de vezes (322 ocorrências na página de teste, 350 no portal), a
~170-210 ms por passada na 1.1.61 (medido na carga real de 4,3 MB).

**Solução.** Memoização em `WeakMap` com o artefato como chave e a string de origem como conferência:
a validação roda uma vez por artefato; se o `dataUrl` do mesmo artefato for outro (não acontece hoje,
mas o contrato não proíbe), a validação roda de novo. Nenhum conteúdo deixa de ser validado.

**Resultado.** `persist-bundle-painel`: 3.614 → 114 ms (página de teste) e 10.717 → 298 ms (portal).

### OPT-3 — contagem de pontos de código sem materializar a string (`src/panel/panel-result-bundle.js`)

**Problema.** O teto de `MAX_STRING_CODE_POINTS` era conferido com `[...value].length`, que **constrói
um array com um elemento por caractere** — para uma captura integral em base64 (milhões de
caracteres) isso é dezenas de MB alocados só para comparar com um limite, repetido em toda string
grande do modelo.

**Solução.** Quando `value.length` já passa do teto (o caso comum), contar pares substitutos com um
laço sobre `charCodeAt`, sem alocar nada. O comportamento é o mesmo para pares substitutos válidos,
para substitutos soltos e na fronteira exata (o teto conta pontos de código, não unidades de 16 bits).

**Teste.** `test/panel/panel-result-bundle.test.js`: "the string ceiling counts code points exactly:
surrogate pairs, lone surrogates and the boundary" — `'𝄞'.repeat(1_048_576)` é aceito e `+1` é
recusado; `'\ud800'.repeat(1_048_576)` é aceito e `+1` é recusado. 25/25 passam nos arquivos do
painel.

### OPT-4 — ganhos incidentais (sem tocar no código)

Dois módulos de outras frentes ficaram mais rápidos **sem nenhuma linha alterada**, só por usarem a
conversão comum agora rápida: `mapa-teclado` (401 → 133 ms na página de teste; 1.335 → 353 ms no
portal) e as duas passadas de hash (`enr-hashes-1/2`: 349/342 → 53/52 ms na página de teste;
2.597/2.653 → 328/319 ms no portal). Registro aqui porque explicam boa parte do ganho do
`enriquecer-modelo` e porque o ganho **não** veio de mudança na geometria dos mapas.

---

## 5. O que NÃO foi otimizado, e por quê

1. **Laço de evidências/miniaturas** (`src/background/run-audit.js`, ~1.125-1.250) — fora do escopo
   desta rodada por decisão do dono do produto (a tarefa paralela vai trocar as miniaturas por
   recortes da captura integral). Medido e documentado em §6 com números, para essa tarefa usar.
2. **Aquecimento e geometria dos mapas** (`capturePristineFullPage`, `map-source-geometry.js`,
   `keyboard-map.js`, `annotation-map.js`) — são a correção de alinhamento entregue na 1.1.60:
   `aquecimento-pagina` (1,1 s, com teto de 3 s, intervalo de 150 ms e estabilidade de 1 s) existe
   para que o mapa não desenhe caixas deslocadas. Tirar tempo dali reintroduz o defeito. Os 1,26 s
   medidos na página de teste e 1,13 s no portal são o preço declarado dessa garantia.
3. **`src/reader/*`** e **`objectBlock`/`showOnPage`** da verificação guiada — fora do escopo por
   decisão do dono do produto (tarefa paralela dos cartões + hashes).
4. **Sondagem de hover** (`sonda-hover`: 8.057 → 8.102 ms no portal; 10 → 8 ms na página de teste).
   É o segundo maior custo do portal, mas **cada espera é a transição declarada pelo próprio bloco**
   (teto de 600 ms por grupo, 60 grupos, prazo de 20 s, 5 confirmações com ponteiro). Ler antes do
   fim da animação produz **falso negativo** exatamente no defeito que a regra 5.1.13 existe para
   encontrar — o código já documenta isso. Encurtar aqui é trocar resultado por tempo, e o dono do
   produto proibiu essa troca. Fica registrado como o maior custo restante do portal.
5. **Cinco a sete passadas de `createAuditModel` no enriquecimento e hash duplicado dos artefatos** —
   é o núcleo de integridade (cadeia de hashes, manifesto, reprodutibilidade). A rodada já derrubou o
   custo por passada (OPT-1); mexer no número de passadas exige revisar o contrato de integridade, o
   que não cabe numa rodada de desempenho. Números de cada passada em §2 e §3, para uma rodada
   dedicada.
6. **Gravação terminal no IndexedDB** (`persist-gravar-terminal`: 1.671 → 599 ms na página de teste;
   11.766 → 2.561 ms no portal) — já caiu com a conversão rápida, mas o que sobra é escrever ~42 MB
   no banco. Reduzir exigiria mudar o formato de armazenamento (contrato fechado, com auditorias
   antigas que precisam continuar abrindo).
7. **Exportação** (4.876 → 3.408 ms na página de teste; ~14,6 s no portal na execução que completou a
   jornada). O HTML é renderizado **duas vezes** (`renderHtmlReport` e de novo com
   `{forPrint:true}`) e a integridade é reverificada antes de exportar — ganho real disponível, mas o
   caminho encosta nos hashes/verificação guiada, que são da tarefa paralela. Recomendação para
   depois: medir o custo das duas renderizações e, se confirmado, reaproveitar a primeira quando
   `forPrint` só muda o enquadramento.
8. **Paralelizar capturas de miniaturas** — a 1.1.61 já captura em série. Duas capturas simultâneas
   quase não sobrepõem trabalho (o compositor do Chrome serializa), e a troca de ordem mudaria qual
   elemento cruza os orçamentos de `ELEMENT_CAPTURE_BUDGET`. Não vale o risco fora do laço que outra
   tarefa vai reescrever.

---

## 6. Recomendações numeradas para o laço de evidências (tarefa paralela)

Números do laço de hoje, medidos com o perfil CDP (página de teste / portal):

| operação | página de teste | portal |
| --- | ---: | ---: |
| `Page.captureScreenshot` (1 chamada por nó único, 69 / 109 nós) | 1.952 ms | 7.313 ms |
| `DOM.getOuterHTML` (trecho de código por nó) | 15 ms (67) | 33 ms (107) |
| `DOM.getContentQuads` (remedição do alvo) | 8 ms (67) | 18 ms (107) |
| `Page.getLayoutMetrics` (junto da medição) | 22 ms (81) | 35 ms (120) |
| fase `evidencias` inteira | 2.127 ms | 8.398 ms |

1. **Substituir a captura por elemento por recorte da captura integral** (já planejado). É o maior
   ganho isolado que sobrou no projeto: **1,95 s de 2,13 s** da fase na página de teste (92%) e
   **7,31 s de 8,40 s** no portal (87%) são `Page.captureScreenshot`, a ~28 ms por elemento na página
   de teste e ~67 ms no portal. Recortar de um raster já decodificado troca N capturas por N recortes
   em memória. Dois cuidados obrigatórios: (a) a captura integral é feita em escala reduzida — um
   recorte pode não ter resolução suficiente para a miniatura, e isso precisa ser declarado como
   limitação no modelo quando ocorrer; (b) a box do recorte tem de respeitar a remedição feita agora
   (`measureElementTarget` → `DOM.getContentQuads` + `Page.getLayoutMetrics` no instante da captura,
   com `measuredRects` para caixa multilinha); usar o `rect` do snapshot volta a errar a caixa em
   páginas que rolam ou trocam de layout entre a coleta e a captura.
2. **Manter os orçamentos como estão até a recomendação 1 entrar.** `ELEMENT_CAPTURE_BUDGET` (150
   miniaturas / 45 s de captura / 75 s de evidência) já é o teto que fez o portal parar em 109
   capturas em vez de tentar todas as 350 ocorrências; baixar o número sem o recorte só reduz
   cobertura.
3. **`DOM.getOuterHTML` e `DOM.getContentQuads` não são o problema** (15 + 8 ms na página de teste;
   33 + 18 ms no portal, cerca de 1% da fase). Só vale agrupá-los num único `Runtime.evaluate` se,
   depois do recorte, a fase continuar quente — e a troca não pode perder `sanitizeHtmlSnippetSource`
   nem `hasPrivateTextAncestor`, que dependem do nó real.
4. **Sobrepor o hash à captura seguinte, não a captura à captura.** `hashEvidenceArtifact` roda dentro
   do laço (para o portal, ~3 ms por artefato, somando ~330 ms): barato demais para justificar
   concorrência às cegas, mas é CPU do worker que pode rodar enquanto o compositor prepara a próxima
   captura. Duas capturas simultâneas não se ajudam — o Chrome serializa a rasterização.
5. **`occurrence.evidenceIds.push(state.fullPage.evidenceId)` para cada ocorrência é intencional** (a
   captura integral é a prova de contexto de toda ocorrência) e já é barato no laço. O que **não**
   pode voltar é o consumidor decodificar/validar por ocorrência: era exatamente o OPT-2 desta rodada
   (31× de ganho no empacotamento do painel). Qualquer novo consumidor de `evidenceIds` deve usar
   memo/`WeakMap` como o painel passou a usar.

---

## 7. Testes

### 7.1 Suíte unitária

`node scripts/run-tests.mjs`, parte unitária: **4.661 testes, 4.659 passam, 1 falha esperada, 1
ignorado**. A única falha é `test/release-package.test.js` (hash do ZIP), **esperada** enquanto o
código-fonte muda: o pacote de release é reconstruído no processo de release. Nenhuma outra falha.

A segunda etapa do mesmo script (a de E2E) foi executada sem a variável `AUDITA_E2E_CHROME` definida
nesse shell e por isso registra 121 falhas de guarda do tipo "AUDITA_E2E_CHROME ou CHROME_BIN é
obrigatório" — nenhuma delas é falha de teste. Os E2E de verdade foram rodados um arquivo por vez,
como combinado, em §7.3.

### 7.2 Testes novos/alterados

- `test/evidence/png.test.js` — 13/13. Contrato de canonicidade, equivalência nativo × alternativa,
  contagem das duas rotas no teste de payload acima do limite.
- `test/panel/panel-result-bundle.test.js` — 25/25 nos arquivos do painel. Teto de pontos de código
  com pares substitutos, substitutos soltos e fronteira exata.
- `test/background/perf-log.test.js` (novo) — 5/5. Fixa o contrato da instrumentação: com a chave
  desligada nada é guardado e `perfWrapCdp` devolve o próprio cliente recebido, sem `Proxy`; com a
  chave ligada a fase, a contagem e o perfil por método CDP aparecem (inclusive a contagem de
  chamadas, que era o defeito do `Map.set`); o despejo é idempotente.

Nenhuma expectativa existente foi afrouxada; as alterações de teste **acrescentam** casos.

### 7.3 E2E no Chrome real (um arquivo por vez)

| arquivo | resultado |
| --- | --- |
| current-page-export-mv3 | ✔ 1/1 (3,48 s) |
| report-print-layout | ✔ 1/1 (0,49 s) |
| report-version-provenance | ✔ 1/1 (1,53 s) |
| retention-indexeddb-mv3 | ✔ 11/11 (26,4 s) |
| mandatory-journey-mv3 | ✔ 1/1 (3,04 s) — jornada completa, 4 formatos |
| sidepanel-flow-mv3 | ✖ 4 passam / 5 falham, **falha pré-existente do ambiente** (abaixo) |

`sidepanel-flow-mv3` é o único arquivo que não passa, e ele **já não passava antes desta rodada**.
Todas as cinco falhas têm uma de duas assinaturas, e nenhuma tem relação com o que foi alterado:

1. `a geometria final tem de ser idêntica à inicial` — a página de teste troca de largura de
   conteúdo durante a verificação (`clientWidth` 879 → 894, ou seja, a barra de rolagem aparece ou
   desaparece, com `innerWidth` constante em 894). **A mesma falha, com os mesmos números, está
   registrada numa execução da árvore em estado de linha de base** (sem nenhuma das otimizações desta
   rodada; registro de 14:48:54, com a árvore revertida entre 14:41:01 e 15:05:46). É o mesmo efeito
   que o próprio produto declara em linguagem simples no mapa da página de teste: *"A página mudou de
   tamanho enquanto era verificada. Para não apontar o lugar errado, nenhum anúncio foi marcado nesta
   página."*
2. `WAIT_TIMEOUT` na espera de `document.visibilityState === 'visible'` do painel (10 s) — espera que
   depende do gerenciador de janelas; a máquina estava com 52 processos "Google Chrome for Testing" de
   sessões concorrentes (carga média ≈ 6).

Os quatro subtestes que passam incluem navegação preservando a página A, página atual sem interação e
captura reativa. `current-page-export-mv3`, `mandatory-journey-mv3` e `retention-indexeddb-mv3`
exercitam as prévias do painel e a exportação nos quatro formatos — exatamente os caminhos alterados
em OPT-2 e OPT-3 — e passam.

### 7.4 Validação visual (`scripts/visual-qa.mjs`)

Campanha na página de teste e no portal público, com as capturas abertas e conferidas uma a uma
(`qa-out/visual-1.1.62/`, 44 imagens — 22 de cada página; diretório fora do controle de versão):

| página | achados com elemento | contornos precisos | etiquetas sobrepostas / sobre texto | miniaturas no relatório | mapa |
| --- | --- | --- | --- | ---: | --- |
| página de teste local | 133 (133 localizados, 0 não localizados) | 7 de 7 colados ao elemento (folga de 3 px + borda) | 0 / 0 | 143 | parcial (tamanho da página mudou) |
| portal público | 90 (74 localizados, 16 não localizados, 6 gerais) | 10 de 10 colados ao elemento | 0 / 0 | 103 | parcial (declarado) |

Conferência visual do que importa para esta rodada: as miniaturas de evidência continuam saindo
recortadas com o **contorno vermelho colado ao elemento** e o resto da tela escurecido como contexto
(zoom nas imagens `07-evidencia-*.png` das duas páginas); o mapa do portal continua anotando os 76
elementos elegíveis nos 9 segmentos; o painel abre com resumo, "Abrir relatório completo" e "Mostrar
sinais na página" no lugar; os sinais continuam persistindo após 6 s. Os 16 achados não localizados do
portal são os casos em que o elemento sai do DOM ou fica fora do fragmento capturado; o painel declara
o motivo ("Esta ocorrência não tem sinal localizado na página atual…") e mantém as evidências
disponíveis — nenhum deles perdeu conteúdo por causa das otimizações.

O relatório abre com **0 miniaturas visíveis antes de abrir as seções e 6 carregadas depois** (143
declaradas na página de teste, 103 no portal): a renderização sob demanda que já existia segue
funcionando, e é ela que impede as centenas de imagens de entrarem no DOM de uma vez.

---

## 8. Limitações

1. **As duas lojas on-line não puderam ser auditadas neste ambiente**, antes **e** depois: uma devolve
   `unavailable` no painel em ~203 ms (nas duas medições), na outra o clique é recusado
   (`CLICK_DENIED`) ou a tela nunca sai de `initial` (180 s até o limite). O comportamento é
   **idêntico** nas duas versões, então não há regressão desta rodada — mas também não há medição de
   desempenho nessas páginas. Fica registrado como limitação do ambiente, não da extensão.
2. **Ruído de conteúdo nas páginas reais**: o portal muda entre execuções (110-111 evidências, 350-352
   ocorrências, modelo de 42-45 MB). As comparações de fase com ganho grande (7× na gravação, 4× no
   enriquecimento, 31-36× no empacotamento do painel) estão muito acima desse ruído; as fases de
   captura (±5%) não devem ser lidas como ganho.
3. **Carga concorrente**: as medições foram feitas com outras sessões usando Chrome na mesma máquina.
   Isso afeta igualmente os dois lados (mesma máquina, mesma carga), mas deixa os números absolutos
   conservadores — em máquina ociosa os tempos tendem a ser menores, e a diferença relativa entre
   antes e depois deve se manter ou aumentar.
4. **Mediana de 2 execuções** por cenário, como combinado. Para as fases de captura, uma mediana de 5
   daria mais confiança; o custo de cada execução no portal (~1 min) e a fila de Chrome limitaram a
   campanha.
5. **Independência das métricas**: a instrumentação é de bancada e não entra no modelo, no relatório
   nem no IndexedDB. Com a chave desligada (o padrão de produção) não há medição, nem `Proxy` no
   cliente CDP, nem escrita em `globalThis` — `test/background/perf-log.test.js` confirma que o objeto
   devolvido por `perfWrapCdp` é o próprio cliente recebido e que o registro fica vazio.

---

## 9. Arquivos alterados

| arquivo | mudança |
| --- | --- |
| `src/core/evidence/png.js` | OPT-1: conversão base64 nativa com alternativa compatível; limite em O(1); canonicidade por re-encode |
| `src/panel/panel-detail.js` | OPT-2: memoização da validação de `dataUrl` por artefato |
| `src/panel/panel-result-bundle.js` | OPT-3: teto de pontos de código sem alocar array |
| `src/background/perf-log.js` | novo: instrumentação atrás de chave desligada por padrão |
| `src/background/run-audit.js` | só marcas de medição (nenhuma mudança de comportamento) |
| `src/background/authorized-audit-starter.js` | só marcas de medição |
| `scripts/perf-audit.mjs` | novo: campanha de medição (medição, não produto) |
| `test/evidence/png.test.js` | testes de canonicidade e de equivalência nativo × alternativa |
| `test/panel/panel-result-bundle.test.js` | teste do teto de pontos de código |
| `test/background/perf-log.test.js` | novo: contrato da instrumentação (desligada por padrão) |

Nenhum esquema, catálogo, versão de algoritmo ou formato de artefato foi alterado: as auditorias
antigas continuam abrindo (`fixtures/audits/legacy-1.1.56-full-evidence.json`,
`test/report/legacy-1.1.56-compat.test.js` passa).
