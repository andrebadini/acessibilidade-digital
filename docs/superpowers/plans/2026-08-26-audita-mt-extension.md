# Audita Acessibilidade Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar o núcleo a uma extensão Chromium que navega para uma URL, coleta estado e evidências e executa uma auditoria local.

**Architecture:** Um painel acessível envia comandos ao service worker MV3. O worker cria uma aba de auditoria, anexa `chrome.debugger`, coleta CDP e content-script data, executa o núcleo e mantém uma máquina de estados recuperável.

**Tech Stack:** Manifest V3, Chrome Extensions APIs, Chrome DevTools Protocol, JavaScript ESM, HTML e CSS nativos.

**Spec:** `docs/superpowers/specs/2026-08-26-auditoria-acessibilidade-design.md`

## Global Constraints

- A extensão funciona carregada como “sem compactação”, sem `npm install` e sem build.
- Nenhum dado da página auditada é enviado pela rede da extensão.
- `chrome.debugger` é anexado somente durante auditoria iniciada pelo fiscal e é sempre desconectado.
- Somente URLs HTTP/HTTPS são aceitas; esquemas restritos produzem erro explicado.
- Senhas, cookies, tokens e cabeçalhos de autenticação não entram no modelo de evidência.

---

### Task 1: Manifest, painel mínimo e validação de URL

**Files:**
- Create: `manifest.json`
- Create: `src/panel/index.html`
- Create: `src/panel/panel.css`
- Create: `src/panel/panel.js`
- Create: `src/core/url.js`
- Create: `test/core/url.test.js`

**Interfaces:**
- Produces: `normalizeAuditUrl(value)` and runtime message `{ type: 'START_AUDIT', url }`.

- [ ] **Step 1: Write URL tests**

```js
test('adds https to a host and rejects restricted schemes', () => {
  assert.equal(normalizeAuditUrl('exemplo.test'), 'https://exemplo.test/');
  assert.throws(() => normalizeAuditUrl('chrome://settings'), /HTTP ou HTTPS/);
});
```

- [ ] **Step 2: Run and observe failure**

Run: `node --test test/core/url.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement URL normalization and the MV3 shell**

Manifest permissions: `activeTab`, `debugger`, `downloads`, `scripting`, `storage`, `tabs`; host permissions: `http://*/*`, `https://*/*`; service worker type: `module`; action opens `src/panel/index.html` in a tab.

Panel markup must have one `<h1>`, an explicit `<label for="audit-url">Endereço do site</label>`, URL input, “Auditar” submit button, live status region and link to the latest report.

- [ ] **Step 4: Run URL tests and static manifest validation**

Run: `node --test test/core/url.test.js`  
Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"`  
Expected: PASS and `manifest ok`.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/panel src/core/url.js test/core/url.test.js
git commit -m "feat: add accessible extension shell"
```

### Task 2: Máquina de estados e cliente CDP

**Files:**
- Create: `src/background/service-worker.js`
- Create: `src/background/session.js`
- Create: `src/browser/cdp-client.js`
- Create: `test/background/session.test.js`
- Create: `test/browser/cdp-client.test.js`

**Interfaces:**
- `createAuditSession({ id, requestedUrl, startedAt })`.
- `transitionSession(session, event)`.
- `createCdpClient({ attach, detach, send })` with `connect(tabId)`, `command(method, params)`, `disconnect()`.

- [ ] **Step 1: Write state and cleanup tests**

Test legal sequence `idle → navigating → collecting → testing → capturing → reporting → complete`, illegal transitions, partial state after recoverable capture failure and exactly-once detach in success/error/cancel flows.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/background/session.test.js test/browser/cdp-client.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement pure state transitions and injected CDP transport**

The real adapter wraps `chrome.debugger.attach({tabId}, '1.3')`, `sendCommand` and `detach`. `disconnect()` must be idempotent. Do not put Chrome globals in the pure session module.

- [ ] **Step 4: Run tests**

Run: `node --test test/background/session.test.js test/browser/cdp-client.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background src/browser/cdp-client.js test/background test/browser
git commit -m "feat: orchestrate auditable CDP sessions"
```

### Task 3: Coleta DOM/AX/CSS e normalização

**Files:**
- Create: `src/collector/page-collector.js`
- Create: `src/browser/collect-page.js`
- Create: `src/core/normalize-snapshot.js`
- Create: `test/core/normalize-snapshot.test.js`
- Create: `fixtures/pages/kitchen-sink.html`

**Interfaces:**
- `collectPage(cdp, tabId)` returns `{ domSnapshot, axTree, layoutMetrics, pageData, warnings }`.
- `normalizeSnapshot(raw)` returns serializable indexes by node ID, backend node ID and frame.

- [ ] **Step 1: Write normalization tests with iframe, shadow host and AX nodes**

Assert deterministic document order, backend-to-AX mapping, attribute maps, computed style subset, text extraction, element rectangles, media metadata and redaction of password values.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/core/normalize-snapshot.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement CDP collection and a serializable page collector**

Enable `Page`, `DOM`, `Accessibility` and `Network`; call `DOMSnapshot.captureSnapshot`, `Accessibility.getFullAXTree`, `Page.getLayoutMetrics`; inject `page-collector.js` into all permitted frames for runtime properties unavailable in DOMSnapshot. Collect only the computed CSS properties used by rules.

- [ ] **Step 4: Implement normalization and sensitive-value redaction**

Never serialize cookies, request headers, local/session storage, password values or hidden token-like input values. Record URLs of resources but not authorization material.

- [ ] **Step 5: Run tests**

Run: `node --test test/core/normalize-snapshot.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/collector src/browser/collect-page.js src/core/normalize-snapshot.js test/core/normalize-snapshot.test.js fixtures/pages/kitchen-sink.html
git commit -m "feat: collect and normalize page accessibility state"
```

### Task 4: Probes dinâmicos de teclado, foco e apresentação

**Files:**
- Create: `src/collector/dynamic-probes.js`
- Create: `src/core/normalize-probes.js`
- Create: `test/core/normalize-probes.test.js`
- Create: `fixtures/pages/dynamic-probes.html`

**Interfaces:**
- `runDynamicProbes(options)` executes in the disposable audit tab and returns events without submitting forms or following links.
- `normalizeProbes(raw)` returns `{ focusOrder, keyboardTraps, focusAppearance, obscuredTargets, reflow, textResize, targetSizes, motion }`.

- [ ] **Step 1: Write probe-normalization tests**

Assert ordered focus targets, repeated-focus trap detection, before/after focus CSS, viewport intersection, 320 CSS px reflow overflow, 200% text resize loss, 24/44 CSS px target geometry and `prefers-reduced-motion` observations.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/core/normalize-probes.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement non-destructive probes**

Use synthetic `Tab` progression only on the disposable tab, cap a cycle after every discovered focusable element plus two steps, prevent link navigation and form submission, restore focus/scroll/viewport after each probe, and record actions. Resize only through CDP emulation and restore original metrics in `finally`.

- [ ] **Step 4: Connect probe results to objective rules**

Feed focus visibility/obscuring/order/trap, keyboard reachability, reflow, resize, target size and motion observations into the normalized snapshot context. A timeout or blocked interaction produces `cantTell`/`untested`, not `passed`.

- [ ] **Step 5: Run tests**

Run: `node --test test/core/normalize-probes.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/collector/dynamic-probes.js src/core/normalize-probes.js test/core/normalize-probes.test.js fixtures/pages/dynamic-probes.html
git commit -m "feat: probe keyboard focus and responsive behavior"
```

### Task 5: Seletores e evidências visuais

**Files:**
- Create: `src/core/evidence/selector.js`
- Create: `src/core/evidence/snippet.js`
- Create: `src/browser/capture-evidence.js`
- Create: `test/evidence/selector.test.js`
- Create: `test/evidence/snippet.test.js`

**Interfaces:**
- `buildStableSelector(node, index)` returns `{ css, framePath, confidence }`.
- `sanitizeHtmlSnippet(html)`.
- `captureFullPage(cdp, metrics)` and `captureElement(cdp, rect)` return PNG data URLs and metadata.

- [ ] **Step 1: Write selector and sanitization tests**

Prefer unique stable IDs, then semantic attributes, then `nth-of-type`; escape CSS; include frame path. Remove password values, tokens, scripts and inline event-handler values from snippets while preserving relevant ARIA and source attributes.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/evidence`  
Expected: FAIL.

- [ ] **Step 3: Implement pure evidence helpers and CDP screenshot commands**

Use `Page.captureScreenshot` with `captureBeyondViewport: true` for the pristine page and `clip` for elements. Store one full-page capture per audited state and reference it by evidence ID. For video/canvas, element capture is the required thumbnail fallback.

- [ ] **Step 4: Run evidence tests**

Run: `node --test test/evidence`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/evidence src/browser/capture-evidence.js test/evidence
git commit -m "feat: capture reproducible accessibility evidence"
```

### Task 6: Pipeline completo e progresso para o fiscal

**Files:**
- Create: `src/background/run-audit.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/panel/panel.js`
- Create: `test/background/run-audit.test.js`

**Interfaces:**
- `runAudit({ url, chromeAdapter, now, idFactory })` returns `AuditModel`.
- Emits `{ type: 'AUDIT_PROGRESS', sessionId, phase, message, percent }`.

- [ ] **Step 1: Write an orchestration test with fake Chrome/CDP adapters**

Assert tab creation, navigation, stable wait, pristine screenshot before rule actions, snapshot, rules, occurrence evidence, 146 item aggregation, report handoff, detach and optional tab close.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/background/run-audit.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement the pipeline with `try/finally` cleanup**

Map phases to plain messages: “Abrindo o site”, “Lendo a estrutura”, “Verificando acessibilidade”, “Preparando evidências”, “Gerando relatório”. A capture failure makes the session `partial`; a structural collection failure makes it `failed` with a diagnostic record.

- [ ] **Step 4: Run all tests**

Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background src/panel/panel.js test/background/run-audit.test.js
git commit -m "feat: run end-to-end local audit pipeline"
```

### Task 7: Fila de revisão humana assistida

**Files:**
- Create: `src/review/index.html`
- Create: `src/review/review.css`
- Create: `src/review/review.js`
- Create: `src/core/review/decisions.js`
- Create: `test/review/decisions.test.js`
- Modify: `src/background/run-audit.js`

**Interfaces:**
- `createReviewDecision({ auditId, itemId, occurrenceId, answer, evaluator, note, decidedAt })`.
- `applyReviewDecisions(auditModel, decisions)` returns a new model and never overwrites automatic failures.

- [ ] **Step 1: Write decision integrity tests**

Test allowed answers `conforme`, `não conforme`, `não foi possível determinar`; require evaluator and ISO timestamp; preserve original evidence; reject decisions for unknown audit/item/occurrence IDs; automatic `failed` remains failed after a human “conforme”.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/review/decisions.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement immutable decisions and simple review cards**

Each card shows one objective question, ABNT/WCAG references, collected code and imagery, the three answer buttons, evaluator name and optional note. Keyboard focus moves to the next unanswered card after a decision. “Pular revisão” keeps `cantTell` and records no fabricated answer.

- [ ] **Step 4: Integrate optional review before final export**

The pipeline generates a valid report without human answers. If the fiscal opens the review queue, regenerated artifacts include decision author, timestamp, note and mode `manual`/`semiAuto`.

- [ ] **Step 5: Run review and full tests**

Run: `node --test test/review/decisions.test.js`  
Run: `npm test`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review src/core/review test/review src/background/run-audit.js
git commit -m "feat: add evidence-backed human review queue"
```
