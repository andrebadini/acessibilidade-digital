# Audita MT Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar relatórios HTML/PDF/JSON auditáveis, aplicar a identidade neutra do Audita MT e concluir a integração e a verificação do produto.

**Supersessão de identidade (26 de agosto de 2026):** qualquer decisão anterior de associar o produto a uma identidade externa foi substituída por apresentação tipográfica própria, sem imagem de marca, com aviso explícito de independência e ausência de certificação oficial.

**Architecture:** Um modelo canônico é serializado e assinado com SHA-256. Renderizadores puros produzem HTML autocontido e JSON técnico; o service worker imprime o HTML via CDP e baixa os três artefatos.

**Tech Stack:** JavaScript ESM, HTML/CSS de impressão, Web Crypto SHA-256, Chrome Downloads API e Page.printToPDF.

**Spec:** `docs/superpowers/specs/2026-08-26-auditoria-acessibilidade-design.md`

## Global Constraints

- HTML legível sem JavaScript e navegável por teclado.
- PDF e HTML derivam do mesmo modelo, sem divergência de achados.
- Identidade tipográfica: “Audita MT” e “Auditoria independente de acessibilidade”, sem imagem de marca externa.
- Painel e relatório declaram que a ferramenta é independente, sem vínculo institucional e sem equivaler a certificação ou laudo oficial.
- O relatório sempre declara escopo, limitações e que o relógio local não é carimbo certificado.

---

### Task 1: Modelo canônico, serialização e hashes

**Files:**
- Create: `src/core/report/audit-model.js`
- Create: `src/core/report/canonical-json.js`
- Create: `src/core/report/hash.js`
- Create: `src/core/report/earl-json.js`
- Create: `test/report/canonical-json.test.js`
- Create: `test/report/earl-json.test.js`

**Interfaces:**
- `createAuditModel(input)`.
- `canonicalStringify(value)` sorts object keys and rejects cycles/non-finite numbers.
- `sha256Hex(value)` accepts string or bytes.
- `renderTechnicalJson(model)`.

- [ ] **Step 1: Write deterministic serialization and EARL mapping tests**

```js
test('canonical JSON ignores insertion order', () => {
  assert.equal(canonicalStringify({ b: 2, a: 1 }), canonicalStringify({ a: 1, b: 2 }));
});

test('cantTell maps to the EARL outcome URI', () => {
  const json = JSON.parse(renderTechnicalJson(modelWithCantTell));
  assert.equal(json.assertions[0].result.outcome, 'http://www.w3.org/ns/earl#cantTell');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/report/canonical-json.test.js test/report/earl-json.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement model validation, canonical JSON, SHA-256 and technical export**

Audit metadata includes requested/final URL, audit ID, timestamps, timezone, versions, viewport, scope, status and limitations. Assertions include assertor, subject, test, mode, outcome, pointer, info and evidence IDs.

- [ ] **Step 4: Run tests**

Run: `node --test test/report/canonical-json.test.js test/report/earl-json.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/report test/report
git commit -m "feat: create canonical hashed audit model"
```

### Task 2: Relatório HTML autocontido e acessível

**Files:**
- Create: `src/core/report/html.js`
- Create: `src/core/report/report.css.js`
- Create: `test/report/html.test.js`
- Create: `fixtures/audits/sample-audit.js`

**Interfaces:**
- `renderHtmlReport(model)` returns a complete HTML string without external identity assets.

- [ ] **Step 1: Write structural report tests**

Assert document language/title, skip link, one H1, ordered heading hierarchy, executive summary, methodology, all 146 items, every occurrence, evidence images with alt, editorial notes, limitations, integrity manifest, embedded CSS/data URLs and absence of remote `<script>`, stylesheet, image or font URLs.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/report/html.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement safe templating and the complete report structure**

Escape all page-derived strings. Use semantic tables only for tabular summaries; findings use articles and definition lists. Use `<details>` for progressive disclosure while leaving summaries visible. Render outcome by icon, text and color. Include “Prévia de anúncio” and its variability disclaimer.

- [ ] **Step 4: Add print CSS**

Define A4 margins, page breaks before major sections, repeated table headers, non-splitting evidence cards where possible, footer fields and high-contrast colors. The HTML source remains useful without JavaScript.

- [ ] **Step 5: Run report tests**

Run: `node --test test/report/html.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/report fixtures/audits test/report/html.test.js
git commit -m "feat: render self-contained accessible reports"
```

### Task 3: Identidade neutra e acabamento do painel

**Files:**
- Modify: `src/panel/index.html`
- Modify: `src/panel/panel.css`
- Modify: `src/core/report/html.js`
- Create: `test/report/identity.test.js`

**Interfaces:**
- Produz cabeçalho tipográfico local, sem imagem: “Audita MT” e “Auditoria independente de acessibilidade”.

- [ ] **Step 1: Definir identidade tipográfica neutra**

Use somente texto e a paleta local existente. Não carregue imagem de identidade, hotlink ou recurso remoto. Inclua aviso inequívoco de independência e de que o resultado não é certificação nem laudo oficial.

- [ ] **Step 2: Write neutral identity tests**

Renderize HTML e JSON reais, execute a exportação por adapters e confirme a identidade neutra, o aviso de independência e a ausência de imagem no cabeçalho. A validação PNG continua aplicada somente às evidências da auditoria.

- [ ] **Step 3: Run and confirm failure before integration**

Run: `node --test test/report/identity.test.js`
Expected: FAIL until the asset loader and renderer integration exist.

- [ ] **Step 4: Integrate accessible neutral identity and minimal visual system**

Use nome e descrição neutros no painel e relatório. Panel copy remains action-first. Colors must meet 4.5:1 for normal text and 3:1 for controls/focus; status never relies on color alone.

- [ ] **Step 5: Run identity and report tests**

Run: `node --test test/report/identity.test.js test/report/html.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add assets src/panel src/core/report/html.js test/report
git commit -m "feat: apply neutral Audita MT report identity"
```

### Task 4: PDF e downloads automáticos

**Files:**
- Create: `src/browser/render-pdf.js`
- Create: `src/browser/download-artifacts.js`
- Modify: `src/background/run-audit.js`
- Create: `test/browser/render-pdf.test.js`
- Create: `test/browser/download-artifacts.test.js`

**Interfaces:**
- `renderPdf(cdp, reportTabId, html)` returns PDF bytes.
- `downloadArtifacts({ baseName, html, pdf, json }, downloadsAdapter)` returns download IDs.

- [ ] **Step 1: Write CDP parameter and artifact-name tests**

Assert `Page.printToPDF` receives `printBackground: true`, `preferCSSPageSize: true`, `generateTaggedPDF: true`, `generateDocumentOutline: true`; validate decoded bytes start `%PDF-`; filenames use sanitized host plus audit timestamp and extensions `.html`, `.pdf`, `.json`.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/browser/render-pdf.test.js test/browser/download-artifacts.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement blob report tab, PDF fallback and downloads**

Open the generated HTML in a temporary report tab, attach CDP and call `Page.printToPDF`. If tagged/outline parameters are unsupported, retry once without only the unsupported experimental parameters and record the limitation. A PDF failure still downloads HTML/JSON and marks the audit partial.

- [ ] **Step 4: Run tests**

Run: `node --test test/browser/render-pdf.test.js test/browser/download-artifacts.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser src/background/run-audit.js test/browser
git commit -m "feat: export automatic HTML PDF and JSON artifacts"
```

### Task 5: Integração, documentação e auditoria de conclusão

**Files:**
- Create: `README.md`
- Create: `docs/USO-FISCAL.md`
- Create: `fixtures/pages/failures.html`
- Create: `fixtures/pages/manual-review.html`
- Create: `test/integration/audit-fixtures.test.js`
- Create: `scripts/verify-project.mjs`

**Interfaces:**
- `scripts/verify-project.mjs` exits 0 only when manifest, assets, normative data, tests and report fixtures are valid.

- [ ] **Step 1: Write integration expectations**

The failures fixture must produce findings for missing alt, unnamed control, invalid heading order, missing form label, low contrast, small target, missing frame title and autoplay media. The manual fixture must produce `cantTell` for alt quality, instructions, captions equivalence and process-level checks. Both reports contain 146 item results and complete metadata.

- [ ] **Step 2: Run integration tests and observe failures**

Run: `node --test test/integration/audit-fixtures.test.js`  
Expected: FAIL until adapters and report handoff are wired.

- [ ] **Step 3: Wire remaining interfaces and add verifier**

Verifier checks: valid manifest; no remote executable code; 146/96/50 counts; zero normative validation errors; neutral identity gate; fixture outcomes; self-contained report; HTML/PDF/JSON signatures; secret-pattern scan; all tests passing.

- [ ] **Step 4: Write operator documentation**

`README.md` covers loading unpacked in Chrome/Edge, permissions, local-only behavior, test command and limitations. `docs/USO-FISCAL.md` uses screenshots or annotated steps after visual QA and explains “reprovado”, “revisar”, “não aplicável” and “não testado”.

- [ ] **Step 5: Run the full verification**

Run: `node scripts/verify-project.mjs`  
Expected: exit 0 and a summary covering every acceptance criterion.

- [ ] **Step 6: Perform browser visual and interaction QA**

Load the unpacked extension, audit the local fixture server and uma URL pública autorizada pelo operador, inspect panel states, element/full-page images, HTML at desktop/mobile widths and every PDF page. Record observed limitations in the report and documentation.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/USO-FISCAL.md fixtures test/integration scripts
git commit -m "test: verify complete Audita MT workflow"
```
