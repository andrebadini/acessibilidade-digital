# Independent adversarial review — Audita Acessibilidade 1.1.17

Reviewer: adversarial verification pass (independent of the author).
Frozen checkout: `/private/tmp/audita-review-117` @ `c64221d` (detached). Pre-fix comparison tree: `/private/tmp/audita-review-116` @ `3cacadd` and a scratch `src/`-reverted copy at `/private/tmp/adv117/revert-src`.
Real Chrome: `/private/tmp/audita-cft152-fixed/.../Google Chrome for Testing` → `Chrome/152.0.7977.64` (verified by `Browser.getVersion` in every run below).
Delivered artifact: `release/audita-acessibilidade-1.1.17.zip`.
No file outside `/private/tmp` was modified; no `git` state-changing command was run in either review checkout (only `git show`/`git diff`/`git log`, read-only).

---

## 1. Verdict

**Counts: Critical 0 · Important 3 · Minor 5.**

The claimed corrections **C1, I1, I2 and M1 are genuinely closed**, and I closed them by measurement rather than by reading:

| Claim | Status | Decisive measurement |
|---|---|---|
| C1 — no legal sentence for legitimate requiredness markers | **closed** | Same fixture through the real chain: pre-fix `failed` + 21 targets + legal sentence; post-fix `cantTell` + 0 sentences |
| I1 — an invisible marker can never be presented as compliance | **closed** | 120/120 synthetic field states: `passed` 0 times post-fix (15 times pre-fix); 0 static `result('passed'` in the producer |
| I2 — the delivered ZIP is pinned, not just the build | **closed** | Garbage in `release/…1.1.17.zip` → suite **6 pass / 1 FAIL** at `test/release-package.test.js:131`; the same experiment on `3cacadd` stays **7/7 green** |
| M1 — the offscreen target no longer asserts "outside the page" | **closed** | Target text and predicate comment rewritten; the only remaining "fora da página" strings are the ones that say the text does *not* claim it (`src/core/rules/forms.js:87,89`) |
| M3 — three refuted documentation claims | **mostly closed** | The three are corrected in the docs; but the rewritten e2e introduces a *new* overstatement (§2.5) |

**But the correction is incomplete in the dimension that matters for this product: the new suspicion is not delivered to the report.** Three Important findings, all in the 5.9.7 path:

1. the per-field suspicion `missing-required-identification` is classified as *checklist* and its message/selector never reaches the exported HTML/PDF, although the rule's own comment calls it "suspeita concreta";
2. when any field has an invalid programmatic required state, all unmarked fields are **silently discarded** — confirmed in a real exported report;
3. the surviving `failed` branch prints the legal sentence `Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025` for a field that Chrome's own accessibility tree exposes as **required**.

**What I did NOT verify** (so it must not be read as confirmed):
- I did not run the whole suite (author claims 4184 tests / 8 pre-existing failures) nor `verify-project`; I ran only the five commanded commands plus `service-worker`, `personas-mv3-csp` and my own probes.
- I did not launch the **packaged** extension (the harness fixture is excluded from the ZIP by design); "executed bytes == packaged bytes" rests on digest pins plus my own byte comparison, not on running the ZIP.
- I did not drive the product UI through the *generated-model* export path used by M2's production reachability (§2.7): I proved the renderer behaviour and read the call chain, not a UI journey.
- I did not re-measure the M1 `overflow-x:auto` case; I only verified the wording change and that the outcome stays `cantTell`.
- I did not test `content: "*" / "alt"` in Chrome (code-derived only).
- I did not verify the other declared limitations (annotation-map flake, sidepanel-flow, `captureScreenshot`, `SENSITIVE_KEY`, 5.9.8, custom `role=textbox`), and I did not verify the 1.1.15 **PDF** pin.
- I did not confirm the service-worker failures leave the *exact* persona-cleanup scenario intact in real Chrome (see §3, known limitation 1).

---

## 2. Findings

### 2.1 Important — the new concrete suspicion is presented as generic "not yet evaluated" and its per-field content is dropped
*Introduced by this delta. Confidence: high (measured).*

`src/core/report/finding-kind.js:2,11-13` classifies an `audita-core` `cantTell` occurrence as `'suspected'` only when its `target.data.reason` is in
`CONCRETE_REASONS = {generic-link-purpose, new-window-warning-observation-incomplete, ambiguous-idref}`.
`missing-required-identification` was **not added**, so every 5.9.7 suspicion falls through to `'checklist'`.

`src/core/report/checklist-presentation.js` renders a checklist card from generic guidance keyed by `itemId` plus `Registros originais: <occurrence ids>`; it never renders the occurrence `justification`, the target node or a selector.

Measured (real Chrome, real collector, real rules, then `buildPanelSummary` → `buildReportView` → `renderHtmlReport`), fixture with a CSS `::after` marker, a sibling `<span>*</span>`, a `title`, a `<fieldset><legend>` marker, an image marker, a parent-element marker, an `aria-label`-only marker and a stylesheet marker on a child of the label:

```
=== marked ===
rule=cantTell item=cantTell/automated targets=[f-sibling, f-title, f-legend, f-image, f-parent,
  f-accname, f-childstyle, f-none, f-normal, f-dangling-ref]  (10 targets, reason missing-required-identification)
bucket=null                       # not in failed/alerts/humanReview/passed
checklistCard={"checkKey":"[\"page-1\",\"audita-core\",\"required-field-identification\"]",
  "title":"Campos obrigatórios","occurrenceIds":["occurrence-marked-1",...]}
checklistHtmlHasTargetMessage=false
```

and in the produced `report-marked.html`: `Nenhuma marcação de obrigatoriedade foi observada junto a este campo` → **0 occurrences**, `missing-required-identification` → 0, `f-sibling` → 0, `f-title` → 0, `f-childstyle` → 0. The rendered card reads: *"Por que está aqui: este teste não forneceu conclusão suficiente. … O que verificar: O resultado disponível não confirma atendimento nem falha; é necessária revisão humana. Não foi fornecida uma descrição do que foi observado."*, followed by opaque occurrence ids. In `forPrint` mode the checklist collapses to *"N verificações ainda sem conclusão"* — the PDF carries no field information at all.

Why this is a defect and not a boundary: the rule's own comment (`src/core/rules/forms.js:371-380`) says *"Uma marcação ausente nas fontes observadas é suspeita concreta"*, and the product docs promise three distinct groups (`docs/COMO-USAR.md:37`, `docs/COMO-TESTAR-BETA-1.1.11.md:30`: *"Falhas confirmadas, recomendações, suspeitas e resultados positivos são grupos distintos"*). The delta created a new cantTell-with-target population and did not wire it into the suspicion channel that already exists (`humanReview`). User-visible consequence: a page whose required fields carry no observable marking is reported as *"1 verificação ainda sem conclusão"* with no indication of which fields; the fiscalization user cannot act on it.

### 2.2 Important — the suspicion is silently discarded whenever one field fails programmatically
*Introduced by this delta. Confidence: high (measured, including the real product export).*

`src/core/rules/forms.js:382-383` returns `failed` on `failures` and never reports `unmarked` in that branch. Pre-fix, the unmarked fields were part of `failures` (as wrongly confirmed violations); post-fix they are reported **only when `failures.length === 0`**.

Measured on the real product (`test/e2e`-style journey: real panel → `START_ATTACHED` (no-pixels) → result → report → export; four real downloads), page containing `#marked` (CSS `::after`), `#bare` (required, no marker), `#bad` (`aria-required="maybe"`), `#sibling` (sibling `*`):

```
downloads: html 266272 B sha256 d4f454d4…, pdf 888674 B, csv 66225 B, json 316642 B
sentenceItems: ["5.9.7"]   sentenceCount: 1
itemReferenceParagraph: "Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025"
failed597Block: "…Item 5.9.7 … · 1 verificação · 1 ocorrência… data-result="failed"… Nome acessível: Email…"
checklist597Block: null          # 5.9.7 is not in the checklist at all
'Identifique de modo perceptível' occurrences: 0
'nenhuma marcação de obrigatoriedade foi observada' occurrences: 0
'Bairro' (sibling-marked field) occurrences: 0
'Código' (CSS ::after-marked field) occurrences: 0
```
(`Nome completo` appears 3×, but all three are generic didactic examples under items 5.9.4/5.9.1/5.9.2 — not this field.)

So in the delivered HTML: `#bare` (the very case the new suspicion was written for, with no marker anywhere) is **absent from the entire report**, `#sibling` is absent, and the only 5.9.7 record is the `aria-required="maybe"` field, presented as a confirmed nonconformity. `#marked` correctly produces nothing. Pre-fix, this same page listed 21 targets including `#bare`; the delta traded a false positive for silence on the field.

### 2.3 Important — the surviving `failed` branch prints the legal sentence for a field the accessibility tree reports as required
*Mechanism pre-existing; newly re-scoped and justified by this delta, so in scope. Confidence: high on the measurements; the severity rests on a normative judgement stated below.*

`src/core/report/consumer-basis.js:49-52` grants the fixed legal basis to any `failed` occurrence on an official ABNT item; `src/core/report/html.js` (reportView renderer) and `src/panel/panel-detail.js:188-195` then emit `Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025`. Measured, both `failed` reasons reach it (`sentenceHtml=1`, `legalReference` non-null for both occurrences).

Chrome 152.0.7977.64 ground truth (CDP `Accessibility.getPartialAXTree` + DOM):

```
a-invalid  (<input aria-required="maybe">):        ax.required = true   matches(':required') = false  valueMissing = false
a-mismatch (<input required aria-required="false">): ax.required = true  matches(':required') = true   valueMissing = true
a-plain    (<input required>):                      ax.required = true
a-ariatrue (<input aria-required="true">):          ax.required = true
```

The rule's own texts admit the defect is not about identification: `'Use um valor válido para o estado obrigatório.'` / `'Mantenha o estado obrigatório programático consistente.'`; the item maps only to `C.S. 3.3.2` (labels/instructions), while invalid ARIA token values belong to 4.1.2 (not claimed by 5.9.7 — `src/core/rules/forms.js:529`).

Normative text (PDF physical 32 = printed p. 23):
> **5.9.7 Campos obrigatórios – Requisito** — Todos os campos obrigatórios estão devidamente identificados, de forma que todos possam perceber. *C. S. 3.3.2, Nível de conformidade A*

My view: confirming a **nonconformity with legal wording** for a field that Chrome exposes to assistive technology as required, and whose only defect is a malformed/contradictory ARIA token, over-claims the item. Note also the internal inconsistency the delta introduced: a required field with a *present but invisible* marker is now merely a suspicion ("percepção não é medida"), while a required field with a *malformed token* and no marker at all is a confirmed nonconformity — the visual evidence is identical and the difference is token validity, which 5.9.7 does not measure. Counter-argument, stated fairly: a reviewer may hold that any defect in the requiredness declaration of a required field is "not properly identified", and the malformed-token case is at least demonstrable. I would still not attach the legal sentence to it; at minimum the rule should not route through the 5.9.7 legal basis, or the item mapping should include 4.1.2 explicitly. User-visible consequence, measured in the delivered HTML: a single malformed ARIA token turns the whole report into a printed legal nonconformity of a Level A requirement.

### 2.4 Minor — the rewritten e2e never asserts the report chain, and its two legal-wording assertions cannot fail
*Introduced/unchanged by this delta (the test was rewritten here). Confidence: high (measured against the pre-fix tree).*

Per-assertion vacuity matrix (mirroring the fixture of `test/e2e/required-field-observation.test.mjs`, real Chrome, run against both trees):

```
/private/tmp/audita-review-117     : 19/19 assertions pass; failing: []
/private/tmp/adv117/revert-src     : 14/19 assertions pass;
   failing: ["CSS ::after marker observed","aria-labelledby marker observed",
             "placeholder marker observed","rule outcome is cantTell",
             "rule targets only #aria-required"]
```

So the test is **not vacuous**: the five correction-specific assertions fail hard against pre-fix `src/`. But the assertions that claim to guard the C1 *symptom* pass against the pre-fix code:

- `assert.doesNotMatch(result.summary, /infração|inconformidade ao item/iu)` → PASS pre-fix
- `assert.doesNotMatch(JSON.stringify(result), /inconformidade ao item/iu)` → PASS pre-fix

because the legal sentence is never in the rule result — it is produced downstream. `grep -rn "Inconformidade ao item" test/` shows assertions only for items 5.1.1/5.1.4/5.1.2 (`test/panel/panel-detail.test.js:64,185`, `test/report/html.test.js:71,346,504,510`, `test/review/report-view.test.js:392,395`); **no test asserts the exported report chain for 5.9.7**. A regression that re-printed the sentence for a `cantTell` 5.9.7 occurrence (or that added the reason to a legal path) would leave the suite green. The test comment asserts the opposite confidence ("the independent review measured the `failed` reaching the exported report as a legal infraction") — that measurement was mine/the prior reviewer's, not something this test performs.

### 2.5 Minor — the new test comment overstates the observation coverage (M3 class)
*Introduced by this delta. Confidence: high (measured).*

`test/e2e/required-field-observation.test.mjs:54` — *"What the page declares is observed from every source the page itself binds to the field"* — is refuted by measurement. Page-bound marker mechanisms still **not** observed (`requiredIndicator: ""`, and the field is then suspected):

```
sibling-text   (f-sibling)      ""    <label>Nome</label><span>*</span>
title-attribute(f-title)        ""    title="campo obrigatorio"
fieldset-legend(f-legend)       ""    <fieldset><legend>Dados obrigatorios *</legend>
image-alt      (f-image)        ""    marker as <img alt="*"> inside the label
parent-element (f-parent)       ""    <div><span>*</span><label …></label></div>
accessible-name(f-accname)      ""    marker only in the accessible name
child-pseudo   (f-childstyle)   ""    #label .star::after { content:"*" }
```

The *rule's* limitation text and the collector comment are accurate (they enumerate the four observed sources and say a marker outside them is invisible to this measurement); only the test comment overstates.

### 2.6 Minor — the widened sources do not see an `aria-labelledby` target inside a shadow root
*Introduced by this delta (new source). Confidence: high (measured), narrow impact, safe direction.*

`markerSources` resolves references with `document.getElementById` (`src/collector/page-collector.js:92`), which does not cross shadow boundaries. Measured on a page where `#in-shadow` lives in an open shadow root and the input carries `aria-labelledby="in-shadow"`: `shadowRefRequired: true`, `shadowRefIndicator: ""` → the field becomes a suspicion, never a violation. 814-record form-heavy page: also `fieldCount 401`, no exception, `vocabulary ["","*"]`. Code-derived (not measured in Chrome): `content: "*" / "alt"` would yield computed `"*" / "alt"`, the quote-stripping regex removes only the outer quotes, and the marker regex then fails on the trailing quote → also a suspicion, not a violation.

### 2.7 Minor — M2 was not fixed, and the "production export path does not reach it" claim is wrong for the generated-model path
*Pre-existing code; not addressed by this delta at all (`git diff 3cacadd..c64221d --stat -- src/core/report/ src/core/legal/ src/panel/` is empty), and the 1.1.17 docs never mention M2. Confidence: high on the renderer measurement; medium on production reachability.*

Two renderers exist (`src/core/report/html.js:85`): with a `reportView` the document comes from `renderReportViewDocument`; without one it comes from the model-mode renderer whose `legalAnalysis` (`src/core/report/html.js:505-515`) is laxer than `src/panel/panel-detail.js:186-190` and `src/core/legal/consumer-basis.js:64-72`: it accepts a reviewed failure without requiring a note.

Measured with a model built through `createAuditModel`/`enrichAuditForReport`/`buildPanelSummary`/`buildReportView` (a `cantTell` 5.9.7 occurrence + a `não conforme` decision **without a note**):

```
createReviewDecision accepted a note-less nonconforming decision: {"answer":"não conforme","hasNote":false}
MODEL-MODE renderer (no reportView, the html runReportExport prints to PDF):
  {"sentences":1,"occurrenceCards":2,"legalAnalysisSections":1}
REPORT-VIEW renderer (immutable export): legalSentencesInExportedHtml = 0
panel-detail legalReference: null
```

`src/export/report-export.js:127` renders `html = renderHtmlReport(model)` (model mode), prints the PDF from it (`printFinalHtml(html, …)`), and returns that same `html` as the delivered artifact; the with-`reportView` re-render at `:291` lives in `runImmutableRevisionExport`, a different function. The generated path is taken when `snapshotCapability === null` or when no `reportView` is supplied (`report-export.js:88-97`). The review UI labels the note **"Nota opcional"** (`src/review/review.js:518`) and `createReviewDecision` accepts an absent note (`src/core/review/decisions.js:114-118`). So an export through the generated path of a report whose reviewer answered a suspicion "não conforme" without a note prints the legal sentence in HTML/PDF while the panel refuses it. The normal current-page export I exercised takes the immutable path and is **not** affected (measured 0). The author's 1.1.17 documentation does not state this boundary; the round-44 narrative states the opposite rule ("a nota é exigida apenas para emitir a referência curta de inconformidade") in a document that then omits `html.js` from the sites that enforce it.

### 2.8 Minor — the author's account of the 8 pre-existing service-worker failures is imprecise
*Known limitation; the documentation of it (not the limitation) is what I question. Confidence: high on the code/measurement, medium on intent.*

Measured: `node --test test/background/service-worker.test.js` → **105 tests, 97 pass, 8 fail**, all `PERSONA_CLEANUP_UNCONFIRMED` (one parent test plus its 7 subtests `stored, cache-reject, cache-throw, factory-throw, source-failure, vault-failure, vault-invalid`). Accurate so far.

- Mechanism: confirmed in substance. The scenario's mock (`test/background/service-worker.test.js:2166-2172`) answers `target.frameIds[0] === 0` with `[{…, result: rawUrl}]` and **everything else with `[]`**, while the persona runtime uses `documentIds` (`src/background/persona-runtime.js:283,320,333`) — an empty result array, not a "URL string". The "URL string" wording matches the *other* mock at `:1993` in a different test. The empty array is what leaves cleanup unconfirmed.
- Stale writer: accurate. `sourceSnapshots` exists only in the test; the counter increments when `scripting.executeScript` runs while `audita:start-journal:v1` is set, and the only caller chain that writes that journal during this scenario (`prepareAttachedCopyPlan` → `reserveAttachedCopyStartJournalV1`) is dead: `1c9b296` removed the `plan = urlPlan(await prepareAttachedCopyPlan({` call, and `prepareAttachedCopyPlan` now appears in `src/background/authorized-audit-starter.js` only in the factory-keys list (`:32`) and a destructuring (`:681`) — never called.
- Count: the claim "3 of the 8 also assert an unsatisfiable `sourceSnapshots > 0`" undercounts. The assertion sites are `:2256` (unconditional, reached by the 4 successful-path modes `stored/cache-reject/cache-throw/factory-throw`) and `:2235` (conditional, reached by the 3 failure-path modes `source-failure/vault-failure/vault-invalid`) → **7 of the 8**, not 3. Whoever fixes the mock to unblock cleanup will meet six more stale assertions than the account implies.
- Product unaffected in real Chrome: `test/e2e/personas-mv3-csp.test.mjs` → **1 test, 1 pass** (I ran it). This supports the claim for the persona runtime under strict CSP, but that test does not exercise the marker-origin/cleanup scenario the unit test mocks, so "unaffected" is not proven for the exact scenario; it remains plausible (the failing calls are test doubles).

---

## 3. The six axes: what I measured

### Axis 1 — Is C1 actually closed? (real Chrome, real collector, real report chain)
Closed, and closed by construction, but the detection gap is real and is now handled as suspicion. I built my own fixture with **32 fields / 12 marker mechanisms** (+ classes the review had not listed: `::before`, quoted content, CSS escapes `\002A`, `attr(data-mark)`, `content:none`, `content:normal`, `:required`-only, offscreen+long, dangling `aria-labelledby`, `aria-labelledby` → styled element, sensitive-looking label value, prose containing the word "obrigatório") and drove it through `collectPage` → `normalizeSnapshot` → `runRules` → model → `buildPanelSummary` → `buildReportView` → `renderHtmlReport`, plus one full real product export.

Required-indicator observation (post-fix, real Chrome):

| class | `requiredIndicator` | rule outcome |
|---|---|---|
| `::after` on the label | `*` | not a target |
| `::before` on the label | `*` | not a target |
| sibling `<span>*</span>` | `""` | suspicion |
| `aria-labelledby` | `*` | not a target |
| `placeholder="Ramal *"` | `*` | not a target |
| 148-char label, marker at end | `*` | not a target |
| `title` attribute | `""` | suspicion |
| `<fieldset><legend>… *` | `""` | suspicion |
| `<img alt="*">` inside label | `""` | suspicion |
| marker from a parent element | `""` | suspicion |
| marker only in accessible name | `""` | suspicion |
| stylesheet on a child of the label | `""` | suspicion |
| `content:"\"*\""` (quotes) | `*` | not a target |
| `content:"\002A"` (escape) | `*` | not a target |
| `content:attr(data-mark)` | `*` (Chrome resolves `attr()`) | not a target |
| `content:none` / `content:normal` | `""` | suspicion (correctly) |
| offscreen label (`left:-9999px`) | `*` | not a target, never `passed` |
| `clip-path:inset(50%)` label | `*` | not a target |
| offscreen + 148-char label | `*` | not a target |
| `(obrigatorio)` / `OBRIGATORIO` / prose | `(obrigatorio)` / `OBRIGATORIO` / `obrigatorio` | not a target |
| `CPF 123.456.789-00 *` in label | `*` (no CPF leaked) | not a target |
| optional field with `*` placeholder or `*` label | property absent | not a target |
| `aria-required="maybe"` | absent | **failed** |
| `required aria-required="false"` | absent | **failed** |

Legal wording: **pre-fix** the same `marked` fixture (no failed-path fields at all) produced `rule=failed`, 21 targets — including every CSS/`aria-labelledby`/placeholder/long-label/hidden-label/attr()/quote/escape case — and `sentenceHtml=1` with `legalReference` = the legal sentence on all 21 occurrences; the neighbouring `passed` verdict existed too (see axis 2/4). **Post-fix**: `rule=cantTell`, 10 targets (only the genuinely unobserved sources), `sentenceHtml=0`, `sentencePrint=0`, `legalReference=null` everywhere, and the item lands in the checklist. **No class I could invent still yields a confirmed failure with legal wording** — every miss is a `cantTell` suspicion, and the only legal wording comes from the two malformed-declaration cases of §2.3.

### Axis 2 — Did the fix introduce errors in the opposite direction?
- **Never returning `passed` is faithful to 5.9.7 and I endorse it.** The item is a *Requisito* (Level A, C.S. 3.3.2) whose text is "…devidamente identificados, **de forma que todos possam perceber**". The tool measures the declaration, not perception (no contrast, size, position or presentation channel), so a `passed` verdict would over-claim; `cantTell` is the honest ceiling. It also matches the product's stated contract ("never claim legal certification", "never present a suspicion as confirmed").
- Under-reporting risk: yes, real, and it is *supposed* to be surfaced as a suspicion. §2.1/§2.2 show it is not surfaced in the artifact, which is the actual defect — not the withdrawal of `passed` itself.
- The `failed` paths: the exhaustive matrix over 120 synthetic field states gives
  `[["cantTell",50],["failed",50],["inapplicable",20]]` split as `cantTell:missing-required-identification 5`, `cantTell:no-target 45`, `failed:invalid-required-state 15`, `failed:required-state-mismatch 35`, `inapplicable 20`, with **0** `passed` (pre-fix: `passed 15`, `failed 135` incl. `failed:missing-required-identification 5`). Statically the fixed producer has 0 `result('passed'`, 1 `result('failed'`, 3 `result('cantTell'`. The 50 `failed` cases are exactly malformed tokens and native/ARIA disagreements — but per §2.3, measured AX ground truth says the field is exposed as required in both, so the confirmed failure is an over-claim, and the invalid-token case is a 4.1.2 defect attributed to 3.3.2. Nothing else regressed to hide a defect that I could find: the production code path is unchanged apart from the two files in the diff.

### Axis 3 — Are the widened marker sources sound?
- **Performance**: 814 records / 401 required fields (133 labels with generated content): fixed median **15.5 ms** vs pre-fix **15.0 ms** (5 rounds each, same page, same session) → ~3% / ~0.5 ms. `getComputedStyle` cost is negligible here. No exception on any of the 814 records.
- **Pseudo-element returns**: `none` and `normal` → `''` (no marker); quoted content has outer quotes stripped; `\002A` decodes to `*`; `attr(data-mark)` is resolved by Chrome 152 to the attribute value; a `getComputedStyle` throw is caught (`try/catch` in `renderedContent`), and every element passed in is an in-document `Element` (labels from `element.labels`, references from `document.getElementById`), so the throw path is not reachable in practice.
- **Closed vocabulary**: measured values are `""`, `"*"`, `"(obrigatorio)"`, `"OBRIGATORIO"`, `"obrigatorio"`; longest observed 12 chars, and the grammar (`src/collector/page-collector.js:58-65`) bounds any value to `*` or `(` + `obrigat[óo]ri[ao]|required` + `)` → ≤ 13 chars. It is lexeme-closed but **case-preserving**; the only consumer is `normalizeText(field.requiredIndicator)` truthiness (`src/core/rules/forms.js:368`), and `grep -rn requiredIndicator src/` shows no equality comparison against a token → the closed-vocabulary claim holds and no page text or sensitive value can be carried (the CPF-label case returned `*`). I report the case variance only as an observation.
- **No leak from optional fields**: `requiredIndicator` is only computed when `required === true` (`src/collector/page-collector.js:431,449`), and measured: optional field with `placeholder="Opcional *"` and optional field with label "Apelido *" both have no property and are never targeted.
- **Boundary**: shadow-root `aria-labelledby` target not observed (§2.6).

### Axis 4 — I1 and I2 closure
- **I1**: 0/120 `passed` (15/120 pre-fix) and 0 static `result('passed'` in the producer; the `cantTell` branches carry either no targets (all marked) or per-field targets (unmarked), and the report's item group only exists for `failed`. The only place a `passed`-like state could appear is the interactive panel's `passed` bucket, which is fed exclusively by execution-checkpoint rows whose outcome is `passed` (`src/panel/panel-summary.js:233-239`) — and the rule never produces `passed`, so no such row exists for 5.9.7. Measured: in the `marked` variant the item is in the checklist, and no `Atendido`/`Conforme`/`positive` wording appears near 5.9.7. Invisible markers are therefore never presented as compliance.
- **I2**: scratch copy, delivered ZIP replaced with `GARBAGE-NOT-A-ZIP-1.1.17` (`sha256 03e56d04…`) → `tests 7, pass 6, fail 1`, failing at `test/release-package.test.js:131` with *"o arquivo entregue em release/ precisa ser o artefato de hash fixado; conferir só a reconstrução deixa o arquivo entregue sem verificação"*. Control on the pre-fix tree (`3cacadd`, its ZIP replaced with garbage): **7/7 pass** — the reviewer's original finding reproduces and the new assertion is what closes it. The pin does cover the delivered path (`join(releaseDirectory, packageName)`), and the rebuild digest is still asserted separately, so a source change without a rebuild still fails.

### Axis 5 — The five commanded commands (exact counts)
```
node --test test/rules/forms.test.js
  ℹ tests 21  ℹ pass 21  ℹ fail 0
node --test test/release-package.test.js
  ℹ tests 7   ℹ pass 7   ℹ fail 0   (199 files identical to the tree)
node --test test/extension-shell.test.js
  ℹ tests 5   ℹ pass 5   ℹ fail 0
AUDITA_E2E_CHROME=… node --test test/e2e/required-field-observation.test.mjs
  ℹ tests 1   ℹ pass 1   ℹ fail 0
AUDITA_E2E_CHROME=… node --test test/e2e/field-label-review.test.mjs
  ℹ tests 1   ℹ pass 1   ℹ fail 0
```
Non-vacuity: `src/` reverted to `3cacadd` in scratch (provenance: `git show 3cacadd:src/collector/page-collector.js | cmp -` and `…:src/core/rules/forms.js` → IDENTICAL; `diff -rq` shows only those two files differ from the frozen tree). Against that tree: the rewritten e2e **fails** at `:62` (`'' !== '*'`, "a marker rendered by a stylesheet is declared by the page and must be observed"), `test/rules/forms.test.js` → 20 pass / 1 fail at `:457` (`['state','indicator']` vs `['state']`), and the per-assertion matrix gives 14/19 with the five correction-specific assertions failing. **Assertions that also pass against pre-fix code**: the 5 required-state observations, the label-text marker, the hidden-label marker, the optional-field ones, the unmarked-field empty indicator, `target reason is missing-required-identification` (pre-fix `#css-marker` carried the same reason), and the two legal-wording `doesNotMatch` assertions (§2.4).

### Axis 6 — Artifact integrity
```
shasum -a 256 release/audita-acessibilidade-1.1.15.zip
  5619e27d4002620fa61d57d24b06279dbc5a7ace1ec50a3e9b9df0b775b6b03b   ✔ pinned
shasum -a 256 release/audita-acessibilidade-1.1.16.zip
  c175a224b4bf5685b512f786596bc839163c70bc2d43e920f689e21bd2663716   ✔ pinned
shasum -a 256 release/audita-acessibilidade-1.1.17.zip
  c0cc411887548b46d0c425b7b8d144ee024f62e0945686ce7f5b7b9a9406dbdc   ✔ pinned
```
I unzipped `release/audita-acessibilidade-1.1.17.zip` myself: **199 entries**, each `cmp`-identical to the tree (0 differing, 0 missing in tree). I also derived the shipped subset from the documented rule (manifest.json + `src/**` + `vendor/**` + the four runtime icons) = **199 files**, and the delivered ZIP matches it exactly (no missing, no extra). The ZIP's `manifest.json` declares `1.1.17` in both `version` and `version_name`. So the executed bytes can be considered the packaged bytes **for those 199 files**, on the strength of (a) my own entry-by-entry comparison and (b) the fact that the rebuild must equal the same pinned digest; with the explicit caveat that the package was never launched (harness fixture excluded), which is a declared limitation.

---

## 4. What I initially believed and had to retract after measuring

1. **"The per-field suspicion message never reaches the report."** I first measured this with a harness that passed `ruleResults[].targets` as node-id *strings* instead of production target objects, so the occurrence `justification` fell back to the rule summary and the checklist card showed "Não foi fornecida uma descrição do que foi observado." I retracted that and rebuilt the harness to use real target objects and `canonicalCoreRemediation` messages. The conclusion survived (the message is still absent) but for the correct reason: `finding-kind.js` classifies it as checklist, and `checklist-presentation.js` renders only generic guidance. Without the correction I would have mis-attributed the cause and missed the actual wiring gap.
2. **"`getComputedStyle(label,'::after').content` returns `attr(...)` unresolved."** False in Chrome 152: it resolves to the attribute value (measured `*`), which is why `attr(data-mark)` is now observed.
3. **"The packaging byte-identity test covers the delivered ZIP."** False: it builds its own ZIP in a temp dir. Proven by the garbage-ZIP experiment, where that test stayed green while the new pin assertion failed. My own unzip was therefore necessary, not redundant.
4. **"M2 is unreachable, as the author says."** I first accepted the claim. After finding that `renderHtmlReport` has two renderers (`html.js:85`) I measured the model-mode renderer with a note-less reviewed decision and got the legal sentence while the panel refuses it — so the claim is wrong for the generated-model export path. I then had to retract my *first* retraction: the reportView (immutable) path genuinely does not emit it (0 sentences), which is the path my real export used.
5. **"The surviving `failed` branch is the only remaining confirmation and it is deserved."** Measurement of the AX tree contradicted "deserved": Chrome reports those fields as `required: true`.
6. **"The rewritten e2e is partly vacuous."** It is not: 5 correction-specific assertions fail against pre-fix `src/`. Only its two legal-wording assertions are unfalsifiable, which is narrower than I first assumed.
7. **"The author's root cause for the 8 failures is wrong."** Largely right on mechanism and stale writer; only the "URL string" detail and the "3 of the 8" count are wrong (7 of 8 by mode).

---

## 5. Residual risk and readiness

Risk I cannot remove with the access I had:
- I never executed the packaged extension, so a packaging-only defect (e.g. a file that behaves differently when loaded from the ZIP path) is outside my evidence; the digest + byte-identity argument is strong but indirect.
- The M2 exposure exists in a production export path (`runReportExport` generated model) that I reached only at renderer/code level; whether a user can reach that state in the shipped UI (no persisted snapshot capability) is not something I drove.
- My 5.9.7 observations come from one Chrome build (152.0.7977.64) on macOS; the AX behaviour of malformed `aria-required` could differ in other engines/AT combinations, so §2.3's severity is build-specific (the remedy is not).
- The service-worker failures' product impact is verified only for the persona runtime under CSP, not for the exact cleanup scenario.

**Readiness.** 1.1.17 is a genuine and verified improvement over the rejected 1.1.16: C1's false legal infractions are gone (measured before/after through the report chain), I1 cannot present an invisible marker as compliance, I2 now pins the delivered artifact, M1's wording is honest, and the artifact is exactly the shipped subset of the tree under three verified pins. **I would not, however, call it ready to replace the approved candidate (1.1.15) as it stands**, because the correction lands the 5.9.7 problem in a different contract violation: the new "suspeita concreta" is (a) demoted to the generic not-yet-evaluated checklist with no field information in HTML and only a count in the PDF, and (b) discarded entirely whenever any field has a malformed programmatic state — measured in a real exported report where a genuinely unmarked required field vanished from the artifact. For a fiscalization tool whose promise is to separate detected problems, evidence-backed suspicions and the checklist, a suspicion that never reaches the report is a silent under-report, and it is arguably worse than the false positive it replaced because the user cannot see it. The three Important findings have small, local fixes: add `missing-required-identification` to `CONCRETE_REASONS` (`finding-kind.js:2`), report `unmarked` alongside `failures` (`forms.js:382`), and stop attaching the 5.9.7 legal basis to malformed/contradictory ARIA declarations (or fix the item mapping). I recommend those changes plus one report-chain regression test for 5.9.7 (no test currently renders the export for this item) before it supersedes 1.1.15.
