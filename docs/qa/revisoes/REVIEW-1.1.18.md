# Independent adversarial review — Audita Acessibilidade 1.1.18

Frozen checkout: `/private/tmp/audita-review-118` @ `75e2717` (detached, `git status` clean except the
pre-existing `?? node_modules`). Scratch: `/private/tmp/adv118`. Chrome for Testing
`Chrome/152.0.7977.64` from `/private/tmp/audita-cft152-fixed/...` (verified by the harness).
ABNT NBR 17225:2025 PDF read directly: SHA-256 `1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc`,
physical 32 (printed 23) — `5.9.7 Campos obrigatórios – Requisito: Todos os campos obrigatórios estão
devidamente identificados, de forma que todos possam perceber. C. S. 3.3.2, Nível de conformidade A`.
No file outside `/private/tmp` was written; the checkout's `release/` hashes are unchanged after the
full suite.

---

## 1. Verdict

**0 Critical, 1 Important, 3 Minor.** (One further observation labelled Minor-design; one previous
Minor verified as genuinely closed.)

**Can 1.1.18 replace the approved candidate 1.1.15? No.** The three Important findings of the 1.1.17
review are genuinely closed for the mainstream flows — I reproduced the pre-fix failures in a real
delivered export and measured them gone — but the corrective revision left one Important instance of
the *same* silent-discard class reachable in production: `forms.js` still throws away every per-field
5.9.7 suspicion, including fields with no observed marking, whenever one field carries a native
`required` attribute together with an invalid/empty `aria-required` token (§2.1). On that page the
unmarked field appears nowhere in the panel groups, the HTML, or the PDF, and 5.9.7 drops into the
generic checklist — the exact user-visible loss the delta claims to have eliminated ("nenhum campo é
descartado"). It is inherited from `c64221d`, not introduced by this delta, but it falsifies the
claim of closure, and the export-chain regression test that would have caught it is still missing
(Minor 3). 1.1.18 is a strict improvement over 1.1.17; the blocker is narrow and cheap to fix.

---

## 2. Findings

### 2.1 Important — the `incomplete` early return silently discards every per-field 5.9.7 suspicion (residual of the review's B; NOT introduced by this delta)

`src/core/rules/forms.js:351-404` — when any declared field has no observed `required` property, the
single `if (incomplete) return result('cantTell', 'Faltam dados …', [], […])` at **:383** runs before
the `problems` list is returned at **:400-404**, so all collected targets (including
`missing-required-identification`) are dropped. The trigger is reachable because `requiredDeclaration`
(**forms.js:336-343**) reads the native `required` attribute *first* — so the malformed ARIA token is
invisible to the rule — while `page-collector.js:417-424` deliberately leaves `required` unobserved
when the ARIA token is malformed.

Measured with the real collector and the real rule (no strings anywhere) — harness
`/private/tmp/adv118/harness/incomplete-root.test.mjs`, fixture
`<input id="unmarked" required>` + `<input id="malformed" required aria-required="maybe">`:

```
ℹ malformed: required=undefined hasRequiredKey=false hasIndicatorKey=false indicator=undefined aria-required="maybe"
ℹ rule outcome=cantTell targets=[] summary="Faltam dados do estado ou da identificação de campo obrigatório."
```

Boundary across declaration shapes (harness `incomplete-boundary.test.mjs`, sub-snapshots of one real
collection, control = unmarked required field; `controlSuspicion` = the control keeps its per-field
suspicion):

```
ℹ plain-malformed:                  shape.required=undefined outcome=cantTell targets=2 controlSuspicion=true
ℹ native-plus-malformed:            shape.required=undefined outcome=cantTell targets=0 controlSuspicion=false
ℹ native-plus-empty:                shape.required=undefined outcome=cantTell targets=0 controlSuspicion=false
ℹ native-plus-word ("required"):    shape.required=undefined outcome=cantTell targets=0 controlSuspicion=false
ℹ native-plus-uppercase ("TRUE"):   shape.required=true      outcome=cantTell targets=1 controlSuspicion=true
ℹ native-plus-false:                shape.required=false     outcome=cantTell targets=2 controlSuspicion=true
ℹ aria-true:                        shape.required=true      outcome=cantTell targets=1 controlSuspicion=true
ℹ select/textarea + native+malformed: shape.required=undefined outcome=cantTell targets=0 controlSuspicion=false
```

End-to-end consequence, measured in the delivered bytes (harness `incomplete.test.mjs`, panel + four
exported artifacts from the real extension):

```
ℹ panel: abnt597=null
ℹ panel: checklist597=["[\"page-1\",\"audita-core\",\"required-field-identification\"]"]
rule outcome: cantTell | targets: [] | summary: Requisito “Campos obrigatórios”: conclusão dependente de revisão humana.
HTML: input#unmarked present: False | input#malformed: True
HTML checklist keys: ['[&quot;page-1&quot;,…&quot;required-field-identification&quot;]']
PDF: unmarked: 0 | malformed: 1 | legal: 0
```

The checklist card the user gets reads "Por que está aqui: este teste não forneceu conclusão
suficiente… O que verificar: … Não foi fornecida uma descrição do que foi observado." — generic
guidance plus opaque ids, no selector, exactly the rendering the 1.1.17 review measured as finding A.
Same page against the pre-fix tree (`prefix-tree`, `src/` = `c64221d`): `abnt597=null`,
`checklist597=[…required-field-identification]` — identical, so the delta did not introduce it and did
not close it. The axe rule `aria-valid-attr-value` still reports the malformed token itself (item
5.13.13, WCAG 4.1.2, human-review card present), so what is lost is specifically the *other* field's
missing-marking suspicion.

Fix direction (not applied): do not let `incomplete` be an early return that erases observations —
return the collected `problems` and carry the incompleteness as a limitation/flag, or make
`requiredDeclaration` treat a malformed token beside a native `required` as the mismatch/invalid state
it already reports when the native attribute is absent.

### 2.2 Minor — M2 is still open, and I could not find a product flow that reaches it (pre-existing, not introduced)

`src/core/report/html.js:505-515`: the generated-model renderer grants the legal sentence for
`occurrence.outcome === 'cantTell' && decision?.answer === 'não conforme'` with **no note/evaluator
requirement**, while `src/core/legal/consumer-basis.js:64-84` (report view) and
`src/panel/panel-detail.js:184-191` require a canonical decision with a non-empty note.

Measured (`/private/tmp/adv118/m2b.mjs`, `SAMPLE_AUDIT` + the canonical decision API):

```
no-note   | stored decision note: undefined
   generated-path renderHtmlReport(model): ["Inconformidade ao item 5.1.1 …","Inconformidade ao item 5.1.4 …"]
   report-view gate (qualifiedConsumerReference): refuses
with-note | stored decision note: "Comprovei a barreira na revisão."
   generated-path renderHtmlReport(model): ["Inconformidade ao item 5.1.1 …","Inconformidade ao item 5.1.4 …"]
   report-view gate (qualifiedConsumerReference): grants
```

Reachability, re-measured rather than assumed: the only product caller of `runReportExport` is
`src/export/index.js:109`, and it always builds `buildReportView(...)` and passes it together with
`auditSnapshotCapability`, so `report-export.js:80-82` always selects `runImmutableRevisionExport`
→ `renderHtmlReport(model, { reportView })` → the strict renderer. `export-controller.js:189-198`
routes review-ready revisions to `validateImmutableRevisionCorrelation`, which never calls
`renderHtmlReport(model)`. No UI flow I could enumerate reaches the lax branch. Consequence today:
none user-visible; the divergence is a latent trap, not a delivered defect. (The author's own account
that M2 is unfixed is correct.)

### 2.3 Minor — the exported HTML/PDF do not attribute a reason to each field; only the JSON and the panel detail do (aggregation inherited from the report view)

Measured on the delivered 1.1.18 HTML for the four-field page
(`/private/tmp/adv118/out/axis1/*.html`):

```
'Nenhuma marcação de obrigatoriedade foi observada junto a este campo': html=0
'Use um valor válido para o estado obrigatório': html=0
'Mantenha o estado obrigatório programático consistente': html=0
'Ofereça uma marcação de obrigatoriedade': html=1
'input#bare': 2   'input#maybe': 2   'input#contradiction': 2   'Inconformidade ao item 5.9.7': 0
```

`src/review/report-view.js:327` picks `occurrences.find(o => o.remediation !== null)?.remediation` —
the **first** occurrence only — for the card-level "Orientação original registrada". All three field
selectors and snippets are in the card's evidence list (and in the PDF's annexed evidence table), so
the user can see *which* fields are involved, but the per-field reason code
(`ruleResults[].targets[].data.reason`) and the guidance for the second and third reasons exist only
in the JSON (`/audit/ruleResults[29]/targets[0..2]/data/reason`) and in the side-panel detail. With
three heterogeneous reasons merged into one card, the visible guidance can describe a different field
than the one the reader is looking at. Every multi-occurrence rule behaves this way (the card is
keyed by `[pageId, engine, ruleId]`), so this is a design boundary, not a 5.9.7 regression — but the
delta's A fix did not deliver per-field attribution to the export, only per-field existence.

### 2.4 Minor — the revised e2e is blind to this delta (the "no test renders the export chain for 5.9.7" Minor remains open)

`test/e2e/required-field-observation.test.mjs` contains no assertion that can distinguish 1.1.18 from
1.1.17. Measured by reverting **only** `src/` to `c64221d` in a scratch tree
(`/private/tmp/adv118/prefix-tree`, built with `git archive c64221d src`; manifest untouched):

```
$ cd /private/tmp/adv118/prefix-tree && AUDITA_E2E_CHROME=... node --test test/e2e/required-field-observation.test.mjs
✔ observed required state reaches the ABNT 5.9.7 consumer without inventing visual identification (528ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

Every assertion (lines 47-96: observation of `required`, the five `requiredIndicator` sources, and
`result.outcome/targets/summary`) passes against the pre-fix code. The test is not worthless — running
it against the 1.1.16 tree (`/private/tmp/adv118/tree116`, `src/` = `3cacadd`) fails at
`AssertionError: a marker rendered by a stylesheet is declared by the page and must be observed` — so
it guards the 1.1.17 fix, not this one. By contrast the changed unit tests do bite: against the
pre-fix tree, `test/report/finding-kind.test.js` → `tests 6, pass 5, fail 1` (the new
`…are suspicions, not a generic checklist` test) and `test/rules/forms.test.js` → `tests 21, pass 20,
fail 1` (the modified `required field rule checks…` test). Nothing renders the export chain for 5.9.7,
which is why §2.1 survived the delta's own gate.

### 2.5 Minor (design observation, pre-existing) — a legitimately marked field is invisible on a mixed page

Measured: a page whose only required field is properly marked puts 5.9.7 in the panel checklist
(`5.9.7 disclosure: undefined`, `checklist questions: 94 … 5.9.7 in checklist: true`); on a mixed page
the rule returns per-field targets, 5.9.7 moves to the human-review group (`ABNT 5.9.7 · 1 verificação
· 3 ocorrências`, `humanReview`, checklist has no `required-field-identification`), and the marked
field produces no occurrence and no checklist entry at all. So the item's residual question ("is the
observed marking perceivable?") is only represented when *every* declared field is marked. The
item-level summary stays `cantTell`, and the behaviour is identical before/after the delta; recorded
because it is the one promise ("not-yet-evaluated checklist") that the marked field does not land in
on mixed pages.

### 2.6 Verified closed from the previous review's Minors (no action)

* The revised e2e comment's list of seven unobserved marking mechanisms is **accurate**. Real
  collector, per-field `requiredIndicator` on one page (`harness/markers.test.mjs`):
  `s1` sibling span `""`, `s2 title ""`, `s3 <legend> ""`, `s4 image inside label ""`,
  `s5 parent element ""`, `s6 accessible name only ""`, `s7 child's pseudo-element ""`,
  control `ok "*"`.
* Shadow-root `aria-labelledby` target still unobserved: `sh-input: found=true required=true
  requiredIndicator=""` — direction safe (suspicion, never a violation), documentation correct.
* Service-worker failure account: all 8 failures in the full suite carry
  `code: 'PERSONA_CLEANUP_UNCONFIRMED'` (8 occurrences in the log); the `sourceSnapshots` assertion is
  exactly `mode === 'marker-cleanup-denied' ? sourceSnapshots === 0 : sourceSnapshots > 0`, so **7 of
  8** assert the unsatisfiable `> 0` — as documented; `prepareAttachedCopyPlan` is only destructured
  (`authorized-audit-starter.js:681`), never invoked — dead as documented; the scenario calls
  `auditStarter.beginAuthorizedAudit` — as documented.

---

## 3. The six axes

### Axis 1 — Is A actually closed? (Yes for the measured chain, with the caveats in §2.1/§2.3)

Harness: real extension in real Chrome, real collector → rules → model → `buildPanelSummary` →
`buildReportView` → four exported artifacts (`/private/tmp/adv118/harness/axis1.test.mjs`). Fixture:
`#marked` (marked required), `#bare` (required, no observed marking), `#maybe`
(`aria-required="maybe"`), `#contradiction` (`required aria-required="false"`), plus
`<img id="no-alt">` as a control for the legal-sentence machinery. No strings are passed to any
product function; every stage receives the object the previous stage produced.

* **Panel groups** (`axis1panel.test.mjs`): `ABNT 5.9.7 · 1 verificação · 3 ocorrências exibidas`,
  group `humanReview`, classification `manual-review`, occurrences 9/10/11; `5.9.7 in checklist:
  false` (93 checklist questions). Opening each occurrence shows the right field and the right
  reason-specific guidance: `#bare` → "Ofereça uma marcação de obrigatoriedade…",
  `#maybe` → "Use um valor válido para o estado obrigatório.", `#contradiction` → "Mantenha o estado
  obrigatório programático consistente.", each with `Seletor sanitizado input#bare|input#maybe|input#contradiction`
  and `Alvo N de 3`.
* **Delivered HTML**: the three occurrences are one `data-report-issue` with
  `data-result="humanReview"`, `data-classification="manual-review"`, `data-abnt="5.9.7"`; the three
  selectors + snippets appear in its evidence sections; `Inconformidade ao item …` count = **0**.
* **Delivered PDF** (16 pp, real Chrome print): `Item 5.9.7 … 1 verificação · 3 ocorrências`, the
  three selectors exactly once each in the annexed evidence table, `Inconformidade` = **0**. (The PDF
  states it delegates per-element correlation to HTML/JSON.)
* **Delivered JSON/CSV**: 3 occurrences, 3 targets with
  `data.reason = missing-required-identification | invalid-required-state | required-state-mismatch`,
  all three field selectors in evidence; CSV has 3 rows for 5.9.7.
* **Positive control** that the legal-sentence machinery works and the zero is meaningful: the
  custom-component page produced confirmed failures, and its delivered HTML contains exactly
  `Inconformidade ao item 5.13.10 …` and `Inconformidade ao item 5.9.3 …` — and none for 5.9.7
  (`/private/tmp/adv118/out/axis3custom/*.html`).
* **Pre-fix comparison at product level** (same harness, `src/` = `c64221d`): rule `outcome=failed`
  with 2 targets, panel group `failed` with "Falha confirmada" and the panel legal block
  `Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025`, delivered HTML containing the same legal
  sentence, `input#bare` **absent** from HTML/JSON/CSV. So all three Important findings reproduce
  pre-fix and are gone post-fix.
* **Answer to "genuinely present in the delivered HTML, or only in the JSON?"** Field identity is
  genuinely present in HTML and PDF (selectors + sanitized snippets) and per-field guidance is present
  in the panel; the per-field *reason* and the guidance for the 2nd/3rd reason are only in the JSON
  and panel detail (§2.3). Note for the parent: the literal per-field message string
  ("Nenhuma marcação de obrigatoriedade foi observada junto a este campo…") appears in **no**
  user-facing surface even after the fix, because the model replaces target messages with canonical
  remediation text — the previous reviewer's `checklistHtmlHasTargetMessage`
  check would still read false on that string. It is not a regression; the information is carried by
  the canonical per-reason message and the selector.

### Axis 2 — Did removing `failed` introduce a false negative that matters? (No material one found)

* Malformed token without the native attribute (`<input aria-required="maybe">`): still a per-field
  suspicion (`invalid-required-state`, measured `targets=2`, control suspicion intact) **and**
  independently covered: axe `aria-valid-attr-value` → item 5.13.13, WCAG 4.1.2, appears as its own
  human-review occurrence on the same field (`occurrence-page-1-000104`, evidence `input#maybe`).
  Rules whose tested WCAG includes 4.1.2 in the delivered model: `frame-title`,
  `landmark-unique-names`, `button-purpose`, `accessible-component-name`,
  `custom-component-semantics`, `form-field-label`, `custom-component-state`,
  `axe.aria-valid-attr-value` — nothing a user needs was lost.
* Contradiction (`required aria-required="false"`): still a per-field suspicion
  (`required-state-mismatch`); no other rule covers it. It should not be a confirmed 5.9.7 failure:
  the item asks that everyone *perceive* the requiredness, Chrome exposes the field as
  `required: true` (the 1.1.17 review's AX measurement, and the reason the legal sentence was
  withdrawn), so AT perception is present and the contradiction is a component-state defect, not proof
  that identification is missing.
* Missing marking: suspicion, as the documented limitation requires (seven unobserved mechanisms
  re-measured, §2.6).
* Custom component (`div role=textbox aria-required=true`): `isFormField` (`snapshot.js:232-239`)
  excludes non-native fields, so 5.9.7 never evaluated it — before or after the delta (measured:
  no 5.9.7 occurrence on the custom page). Not a downgrade.
* The only state that would deserve a confirmed 5.9.7 violation — proof that a required field's
  marking is imperceptible — is not producible from what the collector observes (contrast, size,
  position, the marker's own rendering are not measured). 5.9.7 can now never convict;
  given the item text ("de forma que todos possam perceber") and the product's promise to never
  present a suspicion as a violation, that boundary is defensible. I could not construct a state
  where the tool *proves* the failure.

### Axis 3 — Is B actually closed, including the boundary cases? (Mainstream yes; one Important exception, §2.1)

* Mixed case (declaration problem + unmarked in the same page): closed. `forms.test.js` asserts it and
  the real page shows two/three targets in one `cantTell` result; the pre-fix export silently dropped
  `#bare`, the post-fix export keeps it.
* `incomplete` precedence: **not** closed — see §2.1. Measured reachable trigger: native `required` +
  invalid/empty `aria-required` on the same field (input/select/textarea). The `!hasOwn(field,
  'requiredIndicator')` variant I could not reach with collector-produced snapshots (the collector
  emits the key exactly when it emits `required: true`, which is also the only way the declaration can
  match), so it stays defensive-only; the `required` variant is live.
* Duplicate/wrong reason: no duplication — the classification is an if/else-if chain and each declared
  node appears once, measured `targets.map(nodeId) = ['n-3','n-4','n-5']` with three distinct reasons.
  A field that is both malformed-token and unmarked is reported once, as `invalid-required-state`
  (the more specific defect); the generic summary no longer names it, which is acceptable.
* Count consequences (120 unmarked required fields, `axis3many` + `axis3lim`):
  panel = **one** card, `Suspeitas a confirmar 1 verificação / 120 ocorrências`, 64 occurrence
  controls rendered and the cap disclosed verbatim: "O painel resume os primeiros resultados para
  manter a navegação rápida; o relatório completo preserva todas as ocorrências."
  (`MAX_INTERACTIVE_PANEL_OCCURRENCES = 64`); JSON 120 targets, CSV 120 rows, HTML 120 evidence
  entries, 39-page PDF. Total question volume is unchanged from pre-fix (the same 120 targets existed;
  only their classification moved from checklist to human-review, which is the point of the A fix), and
  the panel's explosion guard works and is disclosed. No new explosion.

### Axis 4 — Minors claimed fixed, and the ones not fixed (measured)

* Shadow-root `aria-labelledby`: still unobserved (`sh-input` → `requiredIndicator: ""`), direction
  safe, documented — unchanged, not made worse.
* Revised e2e comment: accurate (seven mechanisms enumerated match measurement, §2.6).
* M2: not fixed; measured reproducible at module level; **not reachable from any product flow I could
  enumerate** (§2.2) — the previous reviewer's "reachable" needs that qualification.
* E2E non-vacuity: the revised e2e passes 1/1 against `c64221d` `src/` (§2.4) — no assertion detects
  this delta; the two unit tests do (1 failure each against pre-fix `src/`).

### Axis 5 — The tests the author claims (exact counts)

All run in `/private/tmp/audita-review-118`, `node v26.5.0`:

| command | result |
| --- | --- |
| `node --test test/rules/forms.test.js` | `tests 21, pass 21, fail 0` |
| `node --test test/report/finding-kind.test.js` | `tests 6, pass 6, fail 0` |
| `node --test test/release-package.test.js` | `tests 7, pass 7, fail 0` (incl. "pacote conferido byte a byte: 199 arquivos idênticos à árvore revisada") |
| `node --test test/extension-shell.test.js` | `tests 5, pass 5, fail 0` |
| `node --test test/panel/*.test.js test/report/*.test.js test/review/*.test.js` | `tests 640, pass 640, fail 0` |
| `AUDITA_E2E_CHROME=… node --test test/e2e/required-field-observation.test.mjs` | `tests 1, pass 1, fail 0` |

Full suite (`npm test` → `node scripts/run-tests.mjs`): **`tests 4185, pass 4177, fail 8, cancelled 0,
skipped 0, todo 0`, exit 1**. The 8 are exactly the known `test/background/service-worker.test.js`
`PERSONA_CLEANUP_UNCONFIRMED` sub-tests (`stored, cache-reject, cache-throw, factory-throw,
source-failure, vault-failure, vault-invalid`, plus the parent "default worker snapshots the current
page…"); `times out a stalled bitmap allocation…` **passed** in my run, so the annotation-map flake did
not reproduce (4177, not 4176). Claim verdict: "4185 tests" confirmed; "4176 pass + the same eight plus
the flake" **refuted as written** for this run (4177 pass / 8 fail, no flake). Additionally, `npm test`
is not the whole suite: `scripts/run-tests.mjs:96-97` returns as soon as the parallel phase fails, so
the **34 real-Chrome serial files never ran** (0 mentions of `test/e2e/` in the log; the plan is 179
parallel + 34 serial = 213 files). The eight pre-existing failures therefore keep the whole Chrome
battery out of every release gate.

Assertions that also pass against pre-fix code: the entire revised e2e file (§2.4). Against
`c64221d`, the new `finding-kind` test and the modified `forms` test both fail, so those two are real
guards for this delta.

### Axis 6 — Artifact integrity (all four hashes verified; packaged bytes executed)

```
5619e27d4002620fa61d57d24b06279dbc5a7ace1ec50a3e9b9df0b775b6b03b  release/audita-acessibilidade-1.1.15.zip
c175a224b4bf5685b512f786596bc839163c70bc2d43e920f689e21bd2663716  release/audita-acessibilidade-1.1.16.zip
c0cc411887548b46d0c425b7b8d144ee024f62e0945686ce7f5b7b9a9406dbdc  release/audita-acessibilidade-1.1.17.zip
c76d49ce5996679ac419f26b2439ecca526bfc9a3dff9edfe9630e715a4f80c6  release/audita-acessibilidade-1.1.18.zip
```

All four match the pinned values, and the 1.1.18/1.1.15 hashes were unchanged after the full suite.

My own extraction of `1.1.18` (`/private/tmp/adv118/zip118`, `unzip`): **199 entries**, and an
independent Python SHA-256 comparison found **0 entries differing from the tree, 0 missing in either
direction, 0 extra**; my reconstruction of the build's include set (manifest + `src/**` + `vendor/**`
+ the four manifest-declared icons, per `scripts/build-release.mjs:22-30`) is exactly the zip's
content. The packaged `finding-kind.js` carries the three 5.9.7 reasons in `CONCRETE_REASONS` and the
packaged `forms.js` carries the single-`problems` implementation with the canonical remediation
message; `manifest.json` is `1.1.18`.

Executed bytes = packaged bytes, empirically: I copied `test/` into the extracted directory (the
product never references it; no content scripts) and ran from there —

* `node --test test/e2e/required-field-observation.test.mjs` → `tests 1, pass 1`;
* my full-product harness pointed at the extracted directory → rule `outcome=cantTell` with
  `[missing-required-identification, invalid-required-state, required-state-mismatch]`,
  5.9.7 issue `data-result="humanReview"`, the three selectors in HTML and PDF,
  `Inconformidade` = 0.

---

## 4. What I initially believed and had to retract

1. **"The model will reject the new target message."** `validateCoreRuleTargetInventory` requires
   `target.message === canonicalCoreRemediation(ruleId, data)` and I measured it returning `false` for
   both the old and the new `missing-required-identification` message ("validate new msg: false /
   validate old msg: false"), which would have thrown `Regra required-field-identification contém alvo
   ou remediação core não autoritativa`. Retracted after reading the model: `audit-model.js:540`
   (`projectRuleTarget`) overwrites every core target message with `canonicalCoreRemediation`, and the
   delivered JSON confirms it (`"message": "Ofereça uma marcação de obrigatoriedade…"`). No throw, no
   defect — but the rule's own per-field message never reaches any consumer.
2. **"The panel classified the 5.9.7 occurrences as checklist."** My first panel dump used
   `document.querySelector('.result-group.group-humanReview')` and showed 1 card, which suggested the
   three core occurrences were elsewhere. Retracted: the panel renders one group section **per ABNT
   item**, so `querySelector` only saw the first item; the corrected query shows
   `details[data-abnt-group="5.9.7"]` → `humanReview` with 3 occurrences.
3. **"The `incomplete` branch is unreachable in production."** My call-site enumeration said the
   collector always emits `required`/`requiredIndicator` for declared fields, so I nearly filed it as
   dead code. Measurement proved a live trigger (native `required` + malformed/empty `aria-required`)
   and produced §2.1. Retracted; the *custom component* and *hidden input* variants of that hypothesis
   did remain unreachable, because non-native fields are excluded by `isFormField`.
4. **"After the A fix, the exported HTML will contain the per-field message."** It does not: the model
   swaps target messages for canonical remediation text, so the literal string the previous reviewer
   grepped for is still absent from every user-facing surface. The *information* is present via the
   selector + canonical per-reason guidance; my expectation about that specific observable was wrong.
5. **"M2 is reachable."** The previous review's phrasing implied a live path. I traced every
   `runReportExport`/`renderHtmlReport` call site: the export tab always supplies `reportView`, so the
   lax `legalAnalysis` is module-reachable only. Partially retracted — the divergence is real and
   measured, its product reachability is not.
6. **"Adding three per-field suspicions will explode the pending count."** Measured instead: one card,
   64 occurrences shown with a disclosed limitation, all 120 preserved in the report/JSON/CSV. The
   total volume is unchanged from pre-fix; only the group changed. Retracted the concern.

---

## 5. Residual risk I cannot remove with the access I had

* One Chrome build/platform only (`152.0.7977.64`, macOS arm64). I did not re-measure
  `Accessibility.getPartialAXTree` for the malformed-token cases myself; my axis-2 conclusion does not
  depend on it (the perception question is unprovable either way), but a different AX exposure would
  change which reasonable action the *user* takes on the suspicion.
* I did not run the whole 34-file real-Chrome battery (the gate cannot run it while the parallel phase
  fails; running it by hand under a green parallel phase is the untested configuration). I ran the file
  under review plus five purpose-built harnesses.
* M2's reachability is negative evidence from static call-site tracing of `src/`; a path I did not
  enumerate (a future caller, an extension message route) could still reach the generated-model
  renderer with a note-less decision.
* The per-rule aggregation behaviour in §2.3 was verified for the 5.9.7 rule and inferred from code
  for the rest; I did not measure every multi-reason rule.
* The count/explosion measurement used one shape of page (120 native required inputs); a page mixing
  many rules could still produce a large report, which I did not characterize.
* My pre-fix comparisons used a scratch copy whose `src/` came from `git archive c64221d src` (manifest
  left at 1.1.18, `release/` absent). The delta touches `src/` only, so the comparison is faithful, but
  it is a reconstruction, not the original artifact.
* I could not exercise the review UI's note field to see whether a note-less "não conforme" can be
  submitted by a human; the M2 measurement used the canonical decision API, which accepts it.

---

## 6. Reproduce

```bash
export AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
cd /private/tmp/audita-review-118

# claimed test set
node --test test/rules/forms.test.js test/report/finding-kind.test.js \
            test/release-package.test.js test/extension-shell.test.js
node --test test/panel/*.test.js test/report/*.test.js test/review/*.test.js
node --test test/e2e/required-field-observation.test.mjs

# axis 1: real product, four field states, panel + four exported artifacts
cd /private/tmp/adv118/harness && node --test axis1.test.mjs axis1panel.test.mjs
#   -> /private/tmp/adv118/out/axis1/*.{html,pdf,json,csv}, axis1-panel.json, panel-structure.json

# find §2.1 (Important): real collector + real rule + real product
cd /private/tmp/adv118/harness && node --test incomplete-root.test.mjs incomplete-boundary.test.mjs incomplete.test.mjs
#   -> targets=[] for native `required` + malformed aria-required; item falls into the checklist

# find §2.2 (M2) and §2.4 (e2e vacuity)
node /private/tmp/adv118/m2b.mjs
cd /private/tmp/adv118/prefix-tree && node --test test/e2e/required-field-observation.test.mjs   # passes on pre-fix src
cd /private/tmp/adv118/tree116     && node --test test/e2e/required-field-observation.test.mjs   # fails on 1.1.16 src

# axis 6: independent extraction and execution of the delivered bytes
unzip -q release/audita-acessibilidade-1.1.18.zip -d /private/tmp/adv118/zip118
cp -R test /private/tmp/adv118/zip118/test
cd /private/tmp/adv118/zip118 && node --test test/e2e/required-field-observation.test.mjs
```

Logs: `/private/tmp/adv118/logs/{targeted,e2e-required,full-suite,e2e-prefix-src,prefix-product}.txt`.

