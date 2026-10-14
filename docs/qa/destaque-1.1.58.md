# Destaque individual ("Ver e destacar na página") — diagnóstico e correção

Versão analisada: 1.1.57 (branch `wip/destaque`, worktree isolado).
Relato: no detalhe da ocorrência, o botão **"Ver e destacar na página"** quase nunca é oferecido em sites reais — no lugar dele aparece **"Consultar evidências"**. Na fixture local funciona. Os **sinais** na página (corrigidos na 1.1.57) localizam os elementos normalmente, ou seja: o mesmo elemento ganha sinal e não ganha destaque individual.

Escopo deste documento: leitura de código **com** execução de navegador real (Chrome for Testing 152) nas duas páginas de referência — um portal público (muitas seções, carrossel e cookie banner no topo) e uma loja (muito JavaScript de terceiros). Nomes e domínios institucionais foram omitidos de propósito; as páginas aparecem como "portal público" e "loja".

> **Ferramenta de QA**: `scripts/visual-qa.mjs --no-fixture`. Ela audita a URL, desenha os sinais, pergunta ao painel a ação oferecida por cada sinal distinto (`selectionProbe[].action`) e captura `01`..`08`. O número que interessa aqui é o `destaque ao vivo oferecido em X de N sinal(is)` impresso no fim de cada página.

---

## 1. Como o destaque individual é decidido

O caminho é diferente do caminho dos sinais, e é por isso que os dois divergiram:

1. `src/background/highlight-binding.js` monta candidatos a partir das ocorrências com evidência de nó e chama `proveHighlightTargets` (`eligibleCandidates`, `recordHighlightBindingV1`).
2. `src/background/chrome-adapter.js` prova cada candidato **duas vezes de forma independente**:
   - dentro da página, com `collectHighlightStructuralProofs` injetado via `chrome.scripting.executeScript` (seletor + `StructuralSignatureInputV1`);
   - pelo CDP, com `DOM.resolveNode` + `Runtime.callFunctionOn` no `backendNodeId`.
3. As duas provas precisam ser idênticas (`canonicalStringify(frame.structuralInput) !== canonicalStringify(resolved.structuralInput)` → `live-proof-failed`, `src/background/chrome-adapter.js`). Só então o alvo entra no vínculo.
4. O vínculo é gravado em `chrome.storage.session` sob `audita:highlight-bindings:v1`.
5. `src/background/highlight-controller.js` lê o vínculo e devolve `available` ou um motivo (`no-binding`, `live-proof-failed`, `ambiguous`, …).
6. `src/panel/highlight-action.js` projeta isso em um botão: `available` → **"Ver e destacar na página"**; qualquer outra coisa → **"Consultar evidências"**.

Ou seja: **um único motivo de descarte em qualquer etapa apaga o botão para todas as ocorrências daquela página**, porque o vínculo é por auditoria/página, não por ocorrência.

---

## 2. Diagnóstico

### 2.1 O que foi medido

Com instrumentação temporária no worker (removida ao fim) e o roteiro pedido, no portal público:

| Medida | Antes |
| --- | --- |
| Candidatos enviados ao coletor | 311 |
| Elementos casados por seletor no documento de topo | 1 para **todos** os candidatos |
| Resultado da injeção no quadro | `{ frameId: 0, reason: "inaccessible", entries: 0 }` |
| Provas devolvidas | **0** |
| `audita:highlight-bindings:v1` em `chrome.storage.session` | **ausente** |
| `selectionProbe[].action` (8 sinais) | `consult-evidence` em 8 de 8 |

O painel mostrava `no-binding` → "Consultar evidências". Não era o seletor: **cada seletor casava exatamente 1 elemento** no documento. A prova morria depois disso.

### 2.2 A causa: teto de profundidade 16 na prova injetada

Em `src/background/chrome-adapter.js`, a função injetada `collectHighlightStructuralProofs` percorria a ancestralidade do elemento e abortava no 16º nível:

```js
if (!current || seen.has(current) || ancestry.length >= 16) throw new TypeError();
```

O `throw` caía no `catch` externo da função, que devolve `failure('inaccessible')` **para o quadro inteiro**. Como o resultado é `{ version: 1, entries: [], reason: 'inaccessible' }`, o worker não recebia prova de **nenhum** candidato daquele documento — nem dos rasos. Dali em diante:

- `frameProofs.byOccurrence` ficava vazio → `frames.length !== 1` → `ambiguous` por candidato (ou `inaccessible`, quando o CDP falhava antes);
- `proofByOccurrence.size === 0` → `recordHighlightBindingV1` devolvia `null` → **nada era gravado**;
- `highlight-controller` devolvia `no-binding` → o painel oferecia "Consultar evidências".

O portal público aninha os controles bem abaixo de 16 níveis: os seletores reais do vínculo têm 18 a 20 segmentos (por exemplo `html > body > main > section > div > div:nth-of-type(1) > div > section > … > h6`). **Um único candidato profundo derrubava a página inteira.**

### 2.3 Por que os sinais não sofriam disso

O caminho dos sinais já usava o teto maior, e o anel do destaque também — o 16 era o valor fora de linha:

| Caminho | Constante | Valor |
| --- | --- | --- |
| Sinais (projeção/overlay na página) | limite de segmentos do caminho estrutural | 64 |
| Anel do destaque (`src/browser/highlight-overlay.js`) | `MAX_HIGHLIGHT_ANCESTRY` | 64 |
| Assinatura estrutural do modelo (`src/background/highlight-locator.js`) | `MAX_SIGNATURE_ANCESTRY` | 64 |
| **Prova injetada do destaque** | literal no laço | **16** ← divergente |
| Leitura da prova no worker (`structuralInputRecord`) | `denseHighlightArray(record.ancestry, 16)` | **16** ← divergente |

### 2.4 Causa secundária: vocabulário do atributo semântico

A 1.1.57 já tinha ampliado o vocabulário do **sinal** em `src/background/highlight-locator.js`: `parseSignalSelectorV1` aceita `tag[atributo-semântico="valor"]` com `name`, `alt`, `title`, `aria-label`, `data-testid` e `role`. Isso existe porque `buildStableSelector` (`src/core/evidence/selector.js`) emite exatamente essa forma quando o elemento **não tem `id` único nem `class`** — e é o único traço estável de campos de formulário, imagens e ícones.

O destaque individual, porém, validava o mesmo `selector.css` com a gramática **estrita** (`SEGMENT_PATTERN`), que só admitia `[role="…"]` e `[type="…"]` com valores de duas listas fechadas. Resultado: `input[name="q"]`, `img[alt="Mapa do site"]`, `a[title="Ver mais"]` e `input[aria-label="Buscar"]` faziam `parseHighlightSelectorV1` lançar → o candidato era descartado mesmo com ancestralidade curta. Mesmo alvo, dois vocabulários: **o sinal achava, o destaque não.**

---

## 3. Correção

### 3.1 Profundidade da prova igual à dos sinais

`src/background/chrome-adapter.js`:

- `structuralInput` (função injetada): teto de 16 → **64**, com comentário ligando a constante ao `MAX_HIGHLIGHT_ANCESTRY` do anel e ao `MAX_SIGNATURE_ANCESTRY` do localizador.
- `structuralInputRecord` (leitura no worker): `denseHighlightArray(record.ancestry, 16)` → `64`.

Os três lugares que calculam a ancestralidade — prova injetada, anel do destaque e assinatura do localizador — agora usam o mesmo teto, que era a condição para as duas provas concordarem.

### 3.2 Isolamento por candidato

Ainda em `collectHighlightStructuralProofs`, a chamada de `structuralInput` passou a ser protegida individualmente:

```js
let structuralInputValue;
try {
  structuralInputValue = await structuralInput(selected);
} catch {
  if (expectedElement !== null) return failure('inaccessible');
  continue;
}
entries.push({ occurrenceId: candidate.occurrenceId, structuralInput: structuralInputValue });
```

Um elemento que não pode ser provado é **apenas descartado**; os outros candidatos da mesma página continuam. A garantia não muda: sem prova, sem alvo — o candidato descartado simplesmente não entra em `byOccurrence`, e `proofHighlightTargets` já trata ausência de entrada como "sem alvo" (nunca como alvo aproximado). Quando `expectedElement !== null` (revalidação de um alvo já vinculado) o comportamento continua estritamente fail-closed.

### 3.3 Vocabulário do atributo semântico compartilhado

`src/background/highlight-locator.js`:

- novo `SEMANTIC_SEGMENT_PATTERN` (mesma forma do segmento dos sinais, com o campo de atributo livre);
- nova `allowsSemanticAttribute(name, value)`: aceita as enumerações de `role`/`type` do modelo **e** os atributos semânticos dos sinais, com o mesmo teste de valor que a página faz (`isSafeSignalAttributeValue`: não vazio, ≤ 256 caracteres, sem caractere de controle, sem cara de credencial/URL/UUID);
- `parseSelectorV1` ganhou o parâmetro `vocabulary` (`'enum'` | `'semantic'`); `parseCssSelectorV1` continua estrita e `parseHighlightSelectorV1` passa `vocabulary: 'semantic'`;
- o valor do atributo é lido de volta com `unescapeCssString`, porque `escapeCssString` escreve as aspas como `\22 ` — sem isso o valor comparado no worker não seria o valor que a página corrobora.

`src/browser/highlight-overlay.js` — a **mesma** regra, reimplementada de propósito (nada do worker é autoridade dentro da página): `ATTRIBUTE_SEGMENT_PATTERN`, `SIGNAL_ATTRIBUTES`, `MAX_ATTRIBUTE_VALUE`, um `unescapeCss` local e a checagem `enumerated || semantic`. A aritmética de complexidade foi mantida idêntica à do worker (`1 + id + classes + 2·atributo + 3·nth`), porque o overlay compara o valor recalculado com o `selector.complexity` assinado.

### 3.4 Código compartilhado vs. duplicado

O vocabulário **não** foi unificado em um módulo comum, e isso é deliberado: as funções injetadas por `chrome.scripting.executeScript` são serializadas com `.toString()` e não podem importar nada — a duplicação de constantes já é o padrão do projeto no overlay. No worker, onde importar é possível, a regra ficou em um lugar só (`allowsSemanticAttribute`), consumida pelas duas gramáticas.

O que **compartilham** de fato:

- a mesma evidência de origem: `evidence.selector.css` de `buildStableSelector` alimenta tanto `eligibleCandidates` (destaque) quanto `page-marker-projection.locatorFor` (sinais) — é o mesmo dado, com o mesmo gerador;
- o mesmo vocabulário de segmento e o mesmo teto de ancestralidade.

### 3.5 Garantias preservadas

Nada disto foi afrouxado:

- **prova dupla obrigatória** — documento/frame/`backendNodeId` pelo CDP **e** seletor + assinatura estrutural SHA-256 na página, comparadas por `canonicalStringify`;
- **sessão e documento** — `live verification` continua exigindo identidade de aba/janela, digest HMAC da URL estável antes e depois e `documentId` iguais;
- **esquema fechado** — o comando continua com chaves exatas, `nonce` de 22 caracteres, `documentId` no formato fechado e assinatura hex de 64 caracteres;
- **nenhum seletor vindo da página** — o seletor chega do modelo de evidência, é revalidado por gramática fechada e ainda assim precisa casar **exatamente 1** elemento (`matches.length !== 1` → `ambiguous`);
- **o que continua recusado** — `div[data-test="x"]`, `a[href="…"]`, `input[type="date"]`, valores com `token`/`session`/`password`, UUID e caracteres de controle: os testes abaixo cobrem cada um.

---

## 4. Limites que permanecem

- **Conteúdo de iframe e shadow DOM** continua fora do destaque individual, por desenho (mesma regra dos sinais: `unsupported-context`).
- **Elementos com mais de 64 níveis de ancestralidade** agora são descartados individualmente em vez de derrubar a página. O ganho é a página continuar utilizável; o elemento profundíssimo continua sem destaque.
- **A loja não completou a auditoria no harness.** O `outcome` ficou em `initial` (a tela voltou de `running` para `initial`), idêntico ao observado antes da correção — não é regressão deste trabalho e não foi investigado aqui, porque a proteção contra recarga está sendo tratada em paralelo em `run-audit.js`/`chrome-adapter.js`/`diagnostic-policy.js`. Consequência: **não há medição de destaque ao vivo na loja**, nem antes nem depois.
- **Sinais 2 e 3 do portal** têm `signals.groups[].visible === false` (estão em slides ocultos do carrossel): a leitura do anel do sinal estoura por tempo tanto no antes quanto no depois. O destaque individual, porém, é oferecido e desenhado para eles normalmente.

---

## 5. Antes e depois

Roteiro (idêntico nas duas pontas):

```sh
export AUDITA_E2E_CHROME="$HOME/.cache/audita-cft/chrome/mac_arm-152.0.7977.64/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
node scripts/visual-qa.mjs --no-fixture --out qa-out/destaque-antes  --url <LOJA> --url <PORTAL>
node scripts/visual-qa.mjs --no-fixture --out qa-out/destaque-depois --url <LOJA> --url <PORTAL>
```

### Portal público

| Medida | Antes | Depois |
| --- | --- | --- |
| `outcome` | `result` | `result` |
| Sinais desenhados | 63 grupos | 59 grupos |
| Achados com elemento localizado | 74 | 70 |
| Não localizados | 0 | 0 |
| **`destaque ao vivo oferecido em X de 8`** | **0 de 8** | **8 de 8** |
| `selectionProbe[].action` | `consult-evidence` × 8 | `highlight-occurrence` × 8 |
| `04-selecionado-1.png` | sem destaque | caixa "× Falha confirmada" colada ao elemento |

Comparação de geometria, sinal 1 × destaque individual (mesmo elemento):

- anel do sinal (`signals.groups[0].ringDrawnRect`): `{x: 153, y: 266, width: 277, height: 44}`;
- caixa do destaque (`selections[0].highlightBox`): `[152, 265, 279, 46]` — a diferença de 1 px na origem e 2 px no tamanho é a folga de 3 px + borda que o anel do destaque acrescenta de propósito (`GAP`/`BORDER` em `src/browser/highlight-overlay.js`).

Capturas conferidas em `qa-out/destaque-depois/<portal>/`:

- `04-selecionado-1.png` — caixa com a aba "× Falha confirmada" sobre o cartão "População / Estimativas da População 2026", exatamente a área do Sinal 1.
- `04-selecionado-2.png` — caixa sobre o banner-carrossel da Conferência (o `<a>` que envolve o banner inteiro, por isso a caixa é grande); o Sinal 2 aponta para o mesmo bloco.
- `04-selecionado-3.png` — caixa sobre o banner promocional do portal (o `<a>` que envolve a arte inteira), com a aba "× Falha confirmada" no canto superior esquerdo.

A precisão dos sinais não regrediu: `precisão: 10 de 10 contorno(s) visível(is) colados ao elemento (folga 3 px + borda)`, `etiquetas sobrepostas: 0`, persistência `59 → 59` após 6 s.

### Loja

| Medida | Antes | Depois |
| --- | --- | --- |
| `outcome` | `initial` | `initial` |
| Erro registrado | `auditoria-sem-resultado: tela=initial — TELA_FINAL` | idêntico |
| `selectionProbe` | vazio | vazio |

Sem alteração, e sem medição possível — a página não chega à tela de resultado no harness (ver §4).

---

## 6. Arquivos alterados

| Arquivo | Mudança |
| --- | --- |
| `src/background/chrome-adapter.js` | teto de ancestralidade da prova 16 → 64; isolamento por candidato na coleta da prova injetada; leitura da prova aceita até 64 níveis |
| `src/background/highlight-locator.js` | `SEMANTIC_SEGMENT_PATTERN`, `allowsSemanticAttribute`, parâmetro `vocabulary`, `unescapeCssString` no valor do atributo; `parseHighlightSelectorV1` passa a usar o vocabulário ampliado |
| `src/browser/highlight-overlay.js` | mesma regra revalidada dentro da página (`ATTRIBUTE_SEGMENT_PATTERN`, `SIGNAL_ATTRIBUTES`, `MAX_ATTRIBUTE_VALUE`, `unescapeCss`) com a aritmética de complexidade idêntica à do worker |
| `test/highlight/highlight-locator.test.js` | novo caso: aceita os seletores semânticos dos sinais (com valor escapado) e recusa atributo/valor forjado |
| `test/highlight/highlight-overlay.test.js` | novo caso: instala com `input[name="q"]` e recusa comando forjado antes de tocar no DOM |
| `test/background/chrome-adapter.test.js` | novo caso: prova ancestralidade profunda até o teto de 64 e descarta só o candidato que estoura |

---

## 7. Testes

### Unitários

```sh
node --test test/highlight/*.test.js test/panel/*.test.js          # 452 passam
node --test test/highlight/highlight-locator.test.js test/highlight/highlight-overlay.test.js test/background/chrome-adapter.test.js
                                                                   # 177 passam
```

Suíte unitária completa (fase paralela de `scripts/run-tests.mjs`, 195 arquivos):

```sh
node --test $(cat ...)   # tests 4418, pass 4416, fail 1, skipped 1
```

- `skipped 1` é um teste marcado como substituído no próprio repositório (`default worker snapshots the current page…`).
- `fail 1` é `test/release-package.test.js` → `builds the public ZIP reproducibly in an isolated temporary directory`. A asserção compara o hash do ZIP reconstruído com o hash registrado do artefato entregue da 1.1.57, e os três arquivos alterados (`src/background/chrome-adapter.js`, `src/background/highlight-locator.js`, `src/browser/highlight-overlay.js`) estão **dentro** do pacote (`unzip -Z1 release/audita-acessibilidade-1.1.57.zip`). Qualquer alteração de fonte empacotada muda o hash: **é esperado e só se resolve no passo de release** (subir a versão para 1.1.58, reconstruir `release/` e atualizar o hash registrado), que não faz parte desta tarefa.

### E2E (Chrome for Testing 152, uma suíte por vez)

```sh
node --test --test-concurrency=1 \
  test/e2e/highlight-marking-mv3.test.mjs \
  test/e2e/offscreen-highlight-scroll-mv3.test.mjs \
  test/e2e/sidepanel-flow-mv3.test.mjs \
  test/e2e/page-markers-signals-mv3.test.mjs
```

Resultado: `tests 12, pass 12, fail 0` (exit 0) — inclui o destaque do painel sobre o elemento auditado, a ocorrência fora da tela que é trazida à vista sem animação, os sinais numerados do portal, e os 4 cenários de `sidepanel-flow` com exportações verificadas.

---

## 8. Como reproduzir o diagnóstico

O que provou a causa, em ordem:

1. rodar o harness e ler `selectionProbe[].action` (todos `consult-evidence`) e a ausência de `audita:highlight-bindings:v1` em `chrome.storage.session`;
2. instrumentar `recordHighlightBindingV1` para registrar **qual** caminho devolvia `null` — o registro acusou `no-proofs` com `candidates > 0` e `proofs: 0`;
3. instrumentar `proveHighlightTargets` para ler os resultados por quadro — `{ frameId: 0, reason: "inaccessible", entries: 0 }` com todos os seletores casando exatamente 1 elemento;
4. ler `structuralInput` e ver o teto 16 isolado contra os 64 do resto do sistema.

Toda a instrumentação temporária foi **removida** ao final; nenhum arquivo de diagnóstico ficou no repositório.
