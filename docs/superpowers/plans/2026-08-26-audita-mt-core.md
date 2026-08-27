# Audita Acessibilidade Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a base normativa, o modelo de resultados, o cálculo acessível e o motor de regras testável sem navegador.

**Architecture:** Módulos JavaScript ESM puros transformam um snapshot normalizado em resultados por regra e por item ABNT. O núcleo não importa APIs `chrome.*`, não manipula UI e pode ser executado com `node --test` sem instalar pacotes.

**Tech Stack:** JavaScript ES2022, módulos ESM, Node.js test runner nativo, Web Crypto quando disponível.

**Spec:** `docs/superpowers/specs/2026-08-26-auditoria-acessibilidade-design.md`

## Global Constraints

- Somente HTML, CSS e JavaScript empacotados; zero dependências de runtime e zero build obrigatório.
- Base normativa com exatamente 146 itens: 96 requisitos e 50 recomendações.
- A Seção 5 da NBR 17225 é a referência primária; divergências do Anexo C são preservadas em metadados.
- Resultados permitidos: `passed`, `failed`, `cantTell`, `inapplicable`, `untested`.
- Uma regra só retorna `passed` quando aplicabilidade e expectativas foram integralmente avaliadas.
- Código e mensagens em UTF-8; IDs e nomes de propriedades estáveis em inglês; texto de interface em português brasileiro.

---

### Task 1: Harness sem dependências e contratos do núcleo

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/core/result.js`
- Create: `test/core/result.test.js`

**Interfaces:**
- Produces: `OUTCOMES`, `TEST_MODES`, `createRuleResult(input)`.
- `createRuleResult` retorna `{ ruleId, outcome, mode, targets, summary, limitations }` e congela o objeto externo.

- [ ] **Step 1: Write the failing contract test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleResult } from '../../src/core/result.js';

test('createRuleResult rejects an unknown outcome', () => {
  assert.throws(() => createRuleResult({
    ruleId: 'html-title', outcome: 'ok', mode: 'automatic', targets: []
  }), /outcome/i);
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `node --test test/core/result.test.js`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add ESM package metadata and the minimal validated result factory**

```json
{
  "name": "audita-mt",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
```

```js
export const OUTCOMES = Object.freeze(['passed', 'failed', 'cantTell', 'inapplicable', 'untested']);
export const TEST_MODES = Object.freeze(['automatic', 'semiAuto', 'manual']);

export function createRuleResult(input) {
  if (!OUTCOMES.includes(input.outcome)) throw new TypeError('Invalid outcome');
  if (!TEST_MODES.includes(input.mode)) throw new TypeError('Invalid test mode');
  return Object.freeze({
    ruleId: input.ruleId,
    outcome: input.outcome,
    mode: input.mode,
    targets: Object.freeze([...(input.targets ?? [])]),
    summary: input.summary ?? '',
    limitations: Object.freeze([...(input.limitations ?? [])])
  });
}
```

- [ ] **Step 4: Run the contract test**

Run: `node --test test/core/result.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore src/core/result.js test/core/result.test.js
git commit -m "test: establish dependency-free core contracts"
```

### Task 2: Base normativa completa e níveis WCAG

**Files:**
- Create: `src/core/normative/wcag22.js`
- Create: `src/core/normative/nbr17225.js`
- Create: `src/core/normative/validate-normative-data.js`
- Create: `test/normative/nbr17225.test.js`

**Interfaces:**
- Produces: `WCAG22_LEVELS`, `NBR17225_ITEMS`, `NBR17225_EDITORIAL_NOTES`, `validateNormativeData()`.
- Cada item: `{ id, printedId, title, classification, wcag, evaluation, ruleIds, humanReason }`.

- [ ] **Step 1: Write failing completeness tests**

```js
test('NBR 17225 database is complete and internally consistent', () => {
  assert.equal(NBR17225_ITEMS.length, 146);
  assert.equal(new Set(NBR17225_ITEMS.map(item => item.id)).size, 146);
  assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'requirement').length, 96);
  assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'recommendation').length, 50);
  assert.deepEqual(validateNormativeData(), []);
});

test('known editorial divergences are explicit', () => {
  assert.equal(NBR17225_ITEMS.find(item => item.id === '5.12.1').printedId, '5.1.12');
  assert.equal(WCAG22_LEVELS['2.4.6'], 'AA');
  assert.ok(NBR17225_EDITORIAL_NOTES.some(note => note.itemId === '5.9.4'));
});
```

- [ ] **Step 2: Run and confirm missing exports**

Run: `node --test test/normative/nbr17225.test.js`  
Expected: FAIL with missing-module or missing-export error.

- [ ] **Step 3: Implement the WCAG level registry and all 146 ABNT records**

Use the item titles, classifications and mappings from the Seção 5 of `ABNT-NBR-17225-Acessibilidade-Digital.pdf`. Do not copy the complete normative propositions. Store every cited criterion as `{ id: '2.4.6', level: 'AA', printedLevel: 'A' }` when the printed level diverges.

Use this exact record shape for every entry; the first record is:

```js
Object.freeze({
  id: '5.1.1', printedId: '5.1.1', title: 'Indicador de foco visível',
  classification: 'requirement',
  wcag: Object.freeze([{ id: '2.4.7', level: 'AA', printedLevel: 'AA' }]),
  evaluation: 'automatic', ruleIds: Object.freeze(['focus-visible']), humanReason: ''
})
```

Transcribe the complete ordered sequence from 5.1.1 through 5.16.6. Use the Seção 5 mapping when it differs from Anexo C, and attach the five divergences enumerated in spec section 4 to `NBR17225_EDITORIAL_NOTES`.

The implementation step is complete only when the array has the 146 distinct records and each `wcag[].level` equals `WCAG22_LEVELS[id]`.

- [ ] **Step 4: Implement deterministic validation**

`validateNormativeData()` returns string errors for duplicate IDs, invalid classification/evaluation, nonexistent WCAG criteria, mismatched official levels, missing rule IDs for automatic items and missing `humanReason` for manual items.

- [ ] **Step 5: Run normative tests**

Run: `node --test test/normative/nbr17225.test.js`  
Expected: PASS with 146 unique records, 96 requirements, 50 recommendations.

- [ ] **Step 6: Commit**

```bash
git add src/core/normative test/normative
git commit -m "feat: add complete NBR 17225 normative registry"
```

### Task 3: Nome acessível fallback e prévia de anúncio

**Files:**
- Create: `src/core/accessibility/accessible-name.js`
- Create: `src/core/accessibility/announcement.js`
- Create: `test/accessibility/accessible-name.test.js`
- Create: `test/accessibility/announcement.test.js`

**Interfaces:**
- Consumes: snapshot node `{ tagName, attributes, text, children, hidden, labels }` and optional AX node.
- Produces: `computeAccessibleText(node, index, axNode)` and `buildAnnouncementPreview(properties)`.

- [ ] **Step 1: Write precedence and announcement tests**

```js
test('AX name wins and its source is recorded', () => {
  const value = computeAccessibleText(buttonNode, index, { name: 'Salvar', description: 'Grava o formulário' });
  assert.deepEqual(value, { name: 'Salvar', nameSource: 'accessibility-tree', description: 'Grava o formulário', descriptionSource: 'accessibility-tree' });
});

test('fallback follows labelledby before aria-label and contents', () => {
  const value = computeAccessibleText(nodeWithBothLabels, index, null);
  assert.equal(value.name, 'Nome referenciado');
  assert.equal(value.nameSource, 'aria-labelledby');
});

test('announcement is explicitly a preview', () => {
  assert.deepEqual(buildAnnouncementPreview({ name: 'Enviar', role: 'button', disabled: true }), {
    text: 'Enviar, botão, indisponível', kind: 'preview', locale: 'pt-BR'
  });
});
```

- [ ] **Step 2: Run and verify missing modules**

Run: `node --test test/accessibility`  
Expected: FAIL.

- [ ] **Step 3: Implement AX-first behavior and the documented DOM fallback**

Support `aria-labelledby`, `aria-label`, native `label`, `alt`, element contents and `title`, with cycle protection and hidden-node rules. Return the source alongside every computed value. Do not label the result as speech from a named screen reader.

- [ ] **Step 4: Implement Portuguese role/state formatting**

Map at least `button`, `link`, `checkbox`, `radio`, `textbox`, `combobox`, `heading`, `img`, `region`, `table`, `list`, `listitem`, plus checked, selected, expanded, disabled, required, invalid, level and value.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/accessibility`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/accessibility test/accessibility
git commit -m "feat: compute accessible text and announcement previews"
```

### Task 4: Motor de regras e agregação por ABNT

**Files:**
- Create: `src/core/rules/registry.js`
- Create: `src/core/rules/run-rules.js`
- Create: `src/core/rules/aggregate-items.js`
- Create: `test/rules/engine.test.js`

**Interfaces:**
- `registerRule({ id, mode, nbrItems, evaluate })`.
- `runRules(snapshot, context, rules)` returns `RuleResult[]`.
- `aggregateItems(ruleResults, NBR17225_ITEMS)` returns 146 `ItemResult` objects.

- [ ] **Step 1: Write outcome precedence tests**

```js
test('failure dominates review and pass for the same ABNT item', async () => {
  const items = aggregateItems([
    result('r1', 'passed', ['5.13.10']),
    result('r2', 'cantTell', ['5.13.10']),
    result('r3', 'failed', ['5.13.10'])
  ], registry);
  assert.equal(items.find(item => item.id === '5.13.10').outcome, 'failed');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/rules/engine.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement registry, exception isolation and aggregation**

Order outcomes as `failed > cantTell > untested > passed > inapplicable`. Convert an exception inside one rule to `untested` for that rule and continue. Every ABNT item with no linked result becomes `cantTell` with its stored human reason, never `passed`.

- [ ] **Step 4: Run engine tests**

Run: `node --test test/rules/engine.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rules test/rules/engine.test.js
git commit -m "feat: add resilient rule engine and ABNT aggregation"
```

### Task 5: Regras estruturais, semânticas e de formulário

**Files:**
- Create: `src/core/rules/structure.js`
- Create: `src/core/rules/interactive.js`
- Create: `src/core/rules/forms.js`
- Create: `test/rules/structure.test.js`
- Create: `test/rules/interactive.test.js`
- Create: `test/rules/forms.test.js`

**Interfaces:**
- Consumes normalized snapshot indexes.
- Produces registered rules with target evidence `{ nodeId, selectorHint, message, data }`.

- [ ] **Step 1: Add failed/passed/inapplicable fixtures for each objective predicate**

Cover page title, page/part language, frame title, heading semantics/order, landmarks, lists, tables and headers, link/button semantics and names, duplicate IDs used by IDREF, invalid ARIA references, visible label in name, form labels, grouping, required state, autocomplete/input purpose and status roles.

- [ ] **Step 2: Run focused tests and observe missing rules**

Run: `node --test test/rules/structure.test.js test/rules/interactive.test.js test/rules/forms.test.js`  
Expected: FAIL with missing rule IDs.

- [ ] **Step 3: Implement rules as pure predicates**

Each rule declares ABNT item IDs and WCAG IDs. Empty applicability returns `inapplicable`; mixed passing/failing targets returns `failed` with every failed target; no arbitrary occurrence cap is permitted.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/rules/structure.test.js test/rules/interactive.test.js test/rules/forms.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rules test/rules
git commit -m "feat: detect structural semantic and form failures"
```

### Task 6: Regras visuais, mídia e revisão humana

**Files:**
- Create: `src/core/rules/visual.js`
- Create: `src/core/rules/media.js`
- Create: `src/core/rules/manual-review.js`
- Create: `src/core/color.js`
- Create: `test/rules/visual.test.js`
- Create: `test/rules/media.test.js`
- Create: `test/rules/manual-review.test.js`

**Interfaces:**
- Produces `contrastRatio(foreground, background)` and remaining rule registrations.

- [ ] **Step 1: Write boundary tests**

Test contrast ratios 4.49/4.50 and 2.99/3.00, target sizes 23.99/24 CSS px, zoom blocking, autoplay audio over 3 s, missing captions tracks, CSS animation duration, focus indicator absence, text spacing risk and explicit manual reasons.

- [ ] **Step 2: Run and confirm failures**

Run: `node --test test/rules/visual.test.js test/rules/media.test.js test/rules/manual-review.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement objective visual/media rules and conservative uncertainty**

Flatten alpha colors before contrast. Return `cantTell` for gradients, background images, canvas/WebGL pixels and cases where essentiality changes the criterion. Generate review targets for alternative-text quality, captions equivalence, audio description, language simplicity, sensory instructions, complete processes and cross-page consistency.

- [ ] **Step 4: Run the complete core suite**

Run: `npm test`  
Expected: PASS with no skipped normative-contract tests.

- [ ] **Step 5: Commit**

```bash
git add src/core test
git commit -m "feat: add visual media and assisted-review rules"
```
