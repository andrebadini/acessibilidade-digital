# Independent adversarial review — Audita Acessibilidade 1.1.16 (HEAD `3cacadd`)

Reviewer: independent subagent. No file in `/private/tmp/audita-review-116` was modified. All scratch work in `/private/tmp/adv116`.
Baseline confirmed before anything else:

```
$ shasum -a 256 release/audita-acessibilidade-1.1.16.zip
c175a224b4bf5685b512f786596bc839163c70bc2d43e920f689e21bd2663716   (matches the pin)
$ shasum -a 256 /Volumes/SSD1/.../ABNT-NBR-17225-Acessibilidade-Digital.pdf
1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc   (matches the pin)
```

---

## 1. Verdict

**1 Critical, 2 Important, 3 Minor.**

The two behaviour changes are not innocent. The 5.9.7 change (`8d8509b`) converts a "cannot determine" state into **confirmed failures** — and therefore into the legal sentence "Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025" — for ordinary, legitimate requiredness markings, and into a **`passed`** verdict when the only marker sits inside a label the product's own 5.9.1 producer declares invisible. The 5.9.1 addition (`3cacadd`) is correct in its stated technique but has one unintended false-positive mechanism (scrolled inner container) that its rationale does not cover. The `inset()` work is, this time, correct.

**Not verified (stated explicitly):**
- The full suite (`node scripts/run-tests.mjs`) was **not** run; the author's "4184 tests / 4176 pass" claim is unverified.
- The nonce invariant was not re-derived end to end across every sink (DOM, reducer state, report, exports, URL, logs). I verified only that the delta contains no privacy/URL/nonce code change and that `test/privacy/*.test.js` is 34/34 green.
- The packaged extension was never launched; only its bytes were compared to the tree (content equality, not execution).
- ABNT text read only for 5.9.1 and 5.9.7 (plus 5.9.2–5.9.8 for context). No full-standard audit.
- Pre-existing known limitations (service-worker's 8 failures, sidepanel-flow, `SENSITIVE_KEY` anglocentrism, `captureBeyondViewport`, packaged-harness gap, 5.9.1 aggregate `cantTell` by design, 5.9.8 `inputPurpose`, `contenteditable` name removal) were not re-litigated.
- The 11 non-behavioural files of the delta (README, docs, manifest, store-assets, test version pins) were read as diffs only.

---

## 2. Findings

### C1 — Critical — ABNT 5.9.7 now emits a *confirmed violation* (and the legal nonconformity reference) for legitimate perceptible requiredness markings

**Introduced by this delta** (`8d8509b`; rule gate pre-existed, the producer that triggers it is new).
Files: `src/collector/page-collector.js:44-66` (`requiredMarker`, `requiredMarkerNear`), `:391`, `:409`; `src/core/rules/forms.js:361-366`.

The normative text (ABNT NBR 17225:2025, 5.9.7, printed p. 23 = physical index 32):

> **5.9.7 Campos obrigatórios – Requisito** — Todos os campos obrigatórios estão devidamente identificados, **de forma que todos possam perceber**. C. S. 3.3.2, Nível de conformidade A

The implementation reads the **literal text of the associated `<label>` element (`innerText`)** and, if it contains none of `*`, `(obrigatório)`, `obrigatório`, `required` within the first 120 characters, the field becomes a **failure**:

```js
// src/core/rules/forms.js:361-366
} else if (!hasOwn(field, 'requiredIndicator')) {
  incomplete = true;
} else if (!normalizeText(field.requiredIndicator)) {
  failures.push(target(field, 'Identifique de modo perceptível que este campo é obrigatório.', {
    reason: 'missing-required-identification'
  }));
}
```

Measured in real Chrome 152.0.7977.64 through the real collector (fixture + harness copied from `test/e2e/required-field-observation.test.mjs`):

```
$ AUDITA_E2E_CHROME=... node /private/tmp/adv116/required-probe.mjs
chrome: Chrome/152.0.7977.64
=== raw requiredness observation per field ===
f-text       required=true      requiredIndicator="*"   <- control, marker inside the label
f-css        required=true      requiredIndicator=""    <- label::after { content: " *" }
f-sibling    required=true      requiredIndicator=""    <- <label>Nome</label><span aria-hidden="true">*</span>
f-aria-lab   required=true      requiredIndicator=""    <- <span id=l>Nome *</span> + aria-labelledby
f-ph         required=true      requiredIndicator=""    <- placeholder="Nome *"
f-bare       required=true      requiredIndicator=""    <- no label at all (true positive)
CSS-marker label: {"innerText":"Nome","textContent":"Nome","rendered":"\" *\""}
=== ABNT 5.9.7 rule outcome ===
outcome: failed
targets:
   #f-css    | missing-required-identification
   #f-sibling| missing-required-identification
   #f-aria-lab|missing-required-identification
   #f-ph     | missing-required-identification
   #f-bare   | missing-required-identification
```

Chrome itself reports the `::after` content as `" *"` — the asterisk **is rendered and perceptible** — but `innerText` cannot see CSS-generated content, so the rule declares a confirmed violation. The same happens when the marker is a sibling element, when the label is referenced by `aria-labelledby`, and when it is in the placeholder. A fifth case, the 120-character window:

```
$ AUDITA_E2E_CHROME=... node /private/tmp/adv116/privacy-probe.mjs
f-long     requiredIndicator=""   <- 148-char label, " *" at the end, past the window
five-field page -> outcome: failed | targets: [["#f-long","missing-required-identification"]]
```

**Consequence, measured end to end.** Item 5.9.7 is a `REQUIREMENT` (`src/core/normative/nbr17225.js:134`); a `failed` occurrence on a requirement gets `legalAnalysis.basisRef` (`audit-model.js:324` via `consumerBasisForOccurrence`, `src/core/legal/consumer-basis.js:49-52`), which makes `qualifiedConsumerReference` return the qualified legal text and makes the report print the short reference:

```
$ node /private/tmp/adv116/legal-chain.mjs
occurrence 5.9.7: occ-required-failed | outcome = failed | classification = requirement
  | legalAnalysis = {"basisRef":"br.consumer.accessibility.fixed.v2"}
consumerBasisForOccurrence -> br.consumer.accessibility.fixed.v2
report-view legalReference -> "... e no item 5.9.7 da ABNT NBR 17225:2025."
PRODUCTION HTML (reportView)    : ["Inconformidade ao item 5.1.1 ...","Inconformidade ao item 5.9.7 ..."]
PRODUCTION PDF source (forPrint): ["Inconformidade ao item 5.1.1 ...","Inconformidade ao item 5.9.7 ..."]
```

A page using `label.required::after { content: " *" }` — a textbook accessible pattern — is reported as **"Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025"**. That is exactly the failure mode the product's boundary forbids: a heuristic that cannot prove absence of perception is presented as a confirmed unmet requirement, with legal wording. The delta's own QA note (`docs/qa/2026-09-12-form-family-review.md`, section 5.9.7) justifies `failed` with "nada declarado é exatamente o caso em que ninguém pode perceber nada" — measurement refutes the premise that an empty indicator means nothing was declared.

Confidence: **high** (real Chrome + full renderer chain).

### I1 — Important — the same producer makes 5.9.7 return `passed` when the only marker cannot be seen

**Introduced by this delta.** Files: `src/collector/page-collector.js:44-46` (comment), `src/core/rules/forms.js:342-373`.

The collector's comment states: *"a hidden label is skipped because a marker nobody sees is not a marker."* That is false for the two classic visually-hidden techniques: `innerText` only returns `''` for `display:none`, not for off-screen or `clip: rect(0,0,0,0)` labels.

```
$ AUDITA_E2E_CHROME=... node /private/tmp/adv116/offscreen-probe.mjs
### intentional .sr-only label (left:-9999px), nothing else on the page
  label documentRect = {"x":-9999,"y":8,"width":1,"height":1} | visibleText = "Código *"
  5.9.1 -> cantTell [["#f-so","offscreen-label"]]
  5.9.7 -> passed | Os campos obrigatórios possuem estado e identificação observáveis.
```

The same field is simultaneously *"cannot be seen"* (5.9.1) and *"has state and observable identification"* (5.9.7 → `passed` → report label "Atendido no escopo observado"). Unit-level confirmation of both producers on one node:

```
$ node /private/tmp/adv116/passed-probe.mjs
ABNT 5.9.7 -> passed | Os campos obrigatórios possuem estado e identificação observáveis. | targets: 0
ABNT 5.9.1 -> cantTell | targets: [["#field","clipped-label"]]
```

Before the delta this state was `cantTell` (missing data). The delta turns it into an approval. 5.9.7 asks that requiredness be identifiable "de forma que todos possam perceber"; `passed` is not defensible from an invisible marker, and the rule has no `cantTell` path left for it.

Confidence: **high**.

### I2 — Important — the delivered ZIP in `release/` is never checked against the pinned hash

**Pre-existing pattern; the delta's new check only half-closes it.** File: `test/release-package.test.js:12-23, 116-127, 142-192`.

Line 126 digests `output` — the ZIP **freshly built into a temporary directory** — and compares it to `c175a224…`. Nothing ever digests `release/audita-acessibilidade-1.1.16.zip`. `snapshotRelease()` (line 78) exists only to prove the test did not touch `release/`, comparing the directory against itself before/after.

Demonstrated in a scratch copy of the tree (`/private/tmp/adv116/revert`, src byte-identical to HEAD) with the delivered file replaced by garbage:

```
$ shasum -a 256 release/audita-acessibilidade-1.1.16.zip
7d2aaffb212d1a57d12483dadc60c8316afcfe19f9a1dbae9046dbb6d9d5af30   (garbage)
$ node --test test/release-package.test.js
✔ builds the public ZIP reproducibly in an isolated temporary directory
✔ every packaged byte is the byte in the reviewed working tree   (199 files)
✔ rejects temporary release targets ... ✔ default build ... ✔ ... 
ℹ tests 7  ℹ pass 7  ℹ fail 0
```

The stale-comment on lines 13-15 claims "a stale `release/…zip` and a drifted source cannot both stay green" — measurement says they can. Today the file happens to be correct (`c175a224…` verified directly, and I confirmed all 199 packaged entries are byte-identical to the tree). The new `reviewedPackage` pin protects only `1.1.15` — the very file whose silent overwrite motivated commit `1c384aa`. The 1.1.16 counterpart has no such pin.

Confidence: **high**.

### M1 — Minor — `offscreenAway` cannot distinguish deliberate hiding from an inner scroll position, and its rationale is wrong for that case

**Introduced by this delta.** Files: `src/core/rules/forms.js:79-93` (`OFFSCREEN_MARGIN`, `offscreenAway`), `:133-134`.

The comment argues the check is viewport-independent because "the rectangle arrives raw". That holds for the page origin but not for elements inside a scrolled inner container: `getBoundingClientRect()` is viewport-relative there, so `rect.x + rect.width <= 0` also matches an ordinary label merely scrolled out of its own scrollport.

```
$ AUDITA_E2E_CHROME=... node /private/tmp/adv116/offscreen-probe.mjs
### ordinary label inside an overflow-x:auto container, scrolled
  label documentRect = {"x":-504,"y":80.875,"width":200,"height":18} | visibleText = "Nome do campo"
  5.9.1 -> cantTell [["#f-scroll","offscreen-label"]]
```

User-visible consequence: a suspicion target whose message asserts "O rótulo associado a este campo está posicionado fora da área visível da página. Ofereça um rótulo visível…" for a label that is visible as soon as the user scrolls the container. The outcome stays `cantTell`, so the three-tier boundary is respected — this is noise in the suspicion tier, not an over-claim. (The intentional `.sr-only` case is *not* a defect: the label genuinely is invisible, and reporting it as a suspicion is a design boundary I accept, as the brief instructs.)

Confidence: **high** for the mechanism; **medium** for how often such layouts occur in audits.

### M2 — Minor — the legacy standalone HTML renderer omits the note requirement that the panel and the production report enforce

**Pre-existing; not reachable in the shipped export path.** Files: `src/core/report/html.js:505-515`; contrast `src/panel/panel-detail.js:187-191` and `src/core/legal/consumer-basis.js:64-72`.

`legalAnalysis` requires only `displayOutcome === 'failed' && item.classification === 'requirement' && (automaticBasis || (occurrence.outcome === 'cantTell' && decision?.answer === 'não conforme'))`. It never looks at `decision.note`, while the panel requires note + evaluator + decidedAt, and `qualifiedConsumerReference` requires a canonical decision with a non-empty note. `createReviewDecision` treats the note as optional (`src/core/review/decisions.js:114-118`) and the review UI labels it "Nota opcional" (`src/review/review.js:518`), so a note-less "não conforme" is a reachable, valid state.

```
$ node /private/tmp/adv116/gate.mjs
A) no-note reviewed cantTell on REQUIREMENT 5.1.4 -> PHRASE EMITTED
A) qualifiedConsumerReference -> null
```

Not a production breach: `src/export/index.js:91,109-114` always supplies both `auditSnapshotCapability` and `reportView`, so the executed branch is `runImmutableRevisionExport` (`src/export/report-export.js:89-91, 291-292`), whose document has `class="legal-analysis"` **zero** times and carries the phrase only on the item-group line gated by the note-requiring `occurrence.legalReference` (`html.js:265-267`):

```
production: class="legal-analysis" = 0 | data-report-item-reference = 3
standalone: class="legal-analysis" = 2 | data-report-item-reference = 1
```

The standalone renderer is used when `dependencies.reportView` is undefined (also the `export-controller.js:507` correlation check). Latent, but it is a second, weaker implementation of the same legal sentence.

Confidence: **high** (measured both directions).

### M3 — Minor — three documentation claims are contradicted by measurement

1. `element.labels` does **not** include `aria-labelledby`. Commit `8d8509b` and `docs/qa/2026-09-12-form-family-review.md` (added section) both claim the association covers "`for`, rótulo envolvente e `aria-labelledby`". Measured: `#f-aria-lab { requiredIndicator: "" }` → confirmed failure. `labels` is defined by `for` + ancestor labels only.
2. `src/collector/page-collector.js:44-46` — "a hidden label is skipped because a marker nobody sees is not a marker" — false for off-screen and `clip:rect(0,0,0,0)` labels (see I1).
3. `test/e2e/required-field-observation.test.mjs:43-45` still says "the rule stays in review rather than converting a declaration into proof" while line 60 asserts `result.outcome === 'failed'`. Stale comment on a test that now asserts the opposite.

---

## 3. Axis-by-axis

### Axis 1 — normative fidelity

**5.9.7** (text quoted in C1). The implementation does *not* distinguish the HTML `required` attribute from a perceptible indication in the way the standard requires: it reads a **text token inside the associated label**, which is neither necessary nor sufficient.
- *Over-claims*: CSS `::after` marker, sibling marker, `aria-labelledby` label, placeholder marker, marker beyond 120 chars → `failed` → "Inconformidade ao item 5.9.7" (C1).
- *Under-claims*: marker inside a visually-hidden label → `passed` (I1); the English word "required" as part of a field's name counts as the marker (`f-word`: label "Required reading list" → `requiredIndicator: "Required"`, no finding).
- *Mis-words*: the message "Identifique de modo perceptível que este campo é obrigatório" is emitted as a confirmed finding from a text heuristic; the summary wording is careful ("possuem estado e identificação observáveis") but the item outcome is `passed`/`failed`, not `cantTell`.

**5.9.1** (text: "Todos os campos de formulário possuem um rótulo que os identifica; ou o campo de formulário possui propósito visualmente evidente e um nome acessível que o identifica"). "Label left of the page origin / >2000 px below the content floor" is legitimate *evidence for a suspicion* and the rule keeps `cantTell`, so the tier is right. The code **cannot** distinguish an intentional screen-reader-only label (`position:absolute;left:-9999px`) from an accidental one — verified: the intentional `.sr-only` fixture produces `offscreen-label` — and it also flags a label that is merely scrolled inside an `overflow-x:auto` container (M1). Both are documented design boundaries rather than confirmed violations.

**`clippedAway` / `collapsedInsets` / `insetSides` (independent value matrix, 37 cases, executed through the rule).** Result: **0 false positives, 3 conservative misses** (px/em/calc lengths not parsed). Verified correct: 1/2/3/4-value margin expansion, `round` in both positions, case-insensitivity, whitespace, `inset(50% 0%)`, `inset(0% 50%)`, `inset(50% 0% 50%)`, `inset(0% 50% 0%)`, `inset(49%)` detected / `inset(48%)` not, malformed input rejected, non-`inset()` shapes ignored, and legacy `clip: rect(0,0,0,0)`, `rect(0 0 0 0)`, `rect(0px 0px 0px 0px)`. The author's expansion bug is genuinely fixed; this axis is clean.
(`node /private/tmp/adv116/inset-matrix.mjs`)

### Axis 2 — boundary integrity

Gate verified correct and **complete in the shipped path** for HTML and PDF: `displayOutcome !== 'failed'` blocks every pending review; `item.classification !== 'requirement'` blocks every recommendation. Measured:
- pending `cantTell`, no decision → no phrase; recommendation + human "não conforme" without a note → no phrase; a failed requirement → phrase (correct).
- CSV carries only the `basisRef` token (`src/core/report/csv.js:104`); JSON/closed schema carries only `legalAnalysis.basisRef`; neither contains the sentence. The phrase exists in exactly two source locations (`html.js:515`, `panel-detail.js:195`).
- I could **not** construct a production input that emits the phrase for a recommendation or for a pending review. The one divergence I did construct is a note-less reviewed failure in the *standalone* renderer (M2), which production does not use.
- `evidence-treatment.js` is untouched by the delta; its tone follows the decision answer without requiring a note, matching `panel-summary.js:82`; the note requirement lives where the product says it does (short reference: `panel-detail.js:187-191`, `consumer-basis.js:64-72`).

### Axis 3 — privacy / nonce

The brief says the delta touched URL cleaning in `page-collector.js`. **It does not.** `git diff 2d205c1..3cacadd --numstat` gives `src/collector/page-collector.js  30 0` and both hunks are the `requiredMarker`/`requiredIndicator` block; `src/core/normalize-snapshot.js` is a one-line key-list change; nothing in `src/core/privacy.js`, the URL sanitizer, or the nonce/capability code is touched.

`requiredIndicator` cannot carry page text into the report: the producer returns only values built from its own capture groups — `*`, `(obrigatório)`, `(required)`, or the matched word — never the label text. Measured with a secret planted in the label:
```
f-pw  requiredIndicator="*"   (label: "Senha SEGREDO-DO-USUARIO-1234 *")
f-word requiredIndicator="Required"   (label: "Required reading list")
```
The 120-character bound applies to the *search window*, not to the stored value. Sensitive values are also unaffected: with `value="VALOR-SECRETO-9F3A"` on password and text inputs, the value is absent from the normalized snapshot (`secret in normalized snapshot? false`), and `visibleText` stays empty for the sensitive control. `test/privacy/*.test.js`: 34 tests, 34 pass.

### Axis 4 — tests actually run

```
node --test test/rules/forms.test.js                 ℹ tests 21  pass 21  fail 0
node --test test/core/normalize-snapshot.test.js     ℹ tests 22  pass 22  fail 0
node --test test/privacy/*.test.js                   ℹ tests 34  pass 34  fail 0
AUDITA_E2E_CHROME=… node --test test/e2e/field-label-review.test.mjs            ✔ 1/1 (581 ms)
AUDITA_E2E_CHROME=… node --test test/e2e/required-field-observation.test.mjs    ✔ 1/1 (520 ms)
node --test test/release-package.test.js             ℹ tests 7   pass 7   fail 0
```

**No test passes vacuously.** Proven by reverting `src/` to `2d205c1` in a scratch copy and re-running the *new* test files:

```
test/rules/forms.test.js                         20 pass / 1 fail  (✖ a clipped label becomes a per-field target…)
test/e2e/required-field-observation.test.mjs     0 pass / 1 fail  (actual: undefined, expected: '*')
test/e2e/field-label-review.test.mjs             0 pass / 1 fail  (actual: 1, expected: 2 targets)
```

The real gap is **coverage**, not vacuity: the 5.9.7 test covers only "marker inside the label" and "no label", so every false-positive class in C1 is untested, and the fixture that would expose I1 (marker inside a visually-hidden label) is absent.

### Axis 5 — artifact integrity

- `release/audita-acessibilidade-1.1.16.zip` = `c175a224…` ✓; `release/audita-acessibilidade-1.1.15.zip` = `5619e27d…` ✓ (both as pinned).
- `test/release-package.test.js:142-192` genuinely compares **every** packaged file byte-for-byte in both directions (package→tree by sha256 over all 199 entries; tree→package over all of `src/` and `vendor/`), and says explicitly that it does not replace running the artifact.
- I additionally unzipped the **delivered** ZIP and compared it to the tree myself: `entries: 199`, `files differing from tree: 0`, `missing in tree: 0`, packaged `manifest.json` version `1.1.16`. So the executed tree bytes are the packaged bytes.
- Gap: the delivered file itself is not hash-pinned (I2).

---

## 4. Things I initially believed and had to retract after measuring

1. **"The boundary gate is broken in the delivered report."** From reading `html.js:511-515` I expected note-less "não conforme" decisions to produce the legal sentence in the shipped HTML/PDF. Measured: production always renders `renderReportViewDocument`, whose `issueCard` contains no legal-analysis section at all (`class="legal-analysis"` count = 0); the phrase comes from the note-gated item-group line. Retracted from Critical to Minor (M2).
2. **"The standalone renderer at `report-export.js:127` is the delivered HTML."** It is the fallback branch; production (`src/export/index.js:91,109-114`) always passes a snapshot capability and a `reportView`, taking `runImmutableRevisionExport`. The standalone bytes only appear in tests and the `export-controller.js:507` correlation check.
3. **"The delta weakened URL cleaning."** It does not touch it at all — both page-collector hunks are the requiredness marker.
4. **"`requiredIndicator` may leak page text up to 120 characters."** It only ever holds a token from a small closed vocabulary; the 120-character value bounds the search, not the payload.
5. **"The intentional `.sr-only` label is the false positive to report."** It is flagged, but as a `cantTell` suspicion with true evidence, which is the tier the product defines for it — a design boundary, not a defect. The unintended false positive is the scrolled inner container (M1).
6. **"5.9.7 will over-claim by treating the attribute as proof of perception."** It over-claims in the opposite direction from the one I expected: mostly false *violations* (C1), and false *approval* only when the marker is invisible (I1).
7. **"`collapsedInsets` is probably still wrong somewhere."** The independent 37-case matrix found zero false positives; I had to drop this line of attack.
8. **"The release test pins the delivered artifact."** It pins a freshly built artifact; tampering with `release/1.1.16.zip` leaves the suite 7/7 green (I2).

---

## 5. Residual risk I cannot remove with the access I had

- I reviewed a worktree at `3cacadd` with `node_modules` symlinked to the author's checkout and ran the **unpacked** tree in real Chrome 152; the ZIP was verified by content equality only, never by execution (the harness fixture is correctly excluded from the distribution).
- No full-suite run, so cross-module regressions outside the focused files would not have surfaced here.
- The C1/I1 severity rests on how common the affected patterns are in the wild. The mechanisms are proven; the *population* of affected pages is an estimate. A single scan of a handful of real Brazilian sites using CSS-generated asterisks would settle it, and I did not have a target list.
- The `passed`/`failed` polarity of the whole 5.9.7 producer rests on a text heuristic with no `cantTell` fallback. Any future change to the marker vocabulary silently changes verdicts on the "attendance" side, where the product has no review tier — the more dangerous direction, as I1 shows. That structural property is not fixable by the tests as they stand.
- Whether `documentRect.x` is viewport-relative for other containing-block configurations (transformed ancestors, nested frames) was tested only for the plain `overflow-x:auto` case; M1's blast radius may be wider than measured.
