# Independent adversarial review — Audita Acessibilidade 1.1.19 (`dad1cda`)

Reviewer: delegated adversarial agent. Frozen checkout `/private/tmp/audita-review-119` @ `dad1cda`
(delta under review: `75e2717..dad1cda`). Scratch: `/private/tmp/adv119`. No file outside `/private/tmp`
was modified; the frozen checkout was used read-only (tests only).

Chrome used for every run below:
`/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
→ `Chrome/152.0.7977.64` (verified with `--version` and re-verified inside every E2E through
`validateChromeProduct`). One Chrome workload at a time, except where explicitly disclosed.

Executable built from the **delivered package bytes**, not the tree, for every product measurement of
Job A: `/private/tmp/adv119/site19` = `unzip release/audita-acessibilidade-1.1.19.zip` + the repository
`test/` + `fixtures/` copied in (the product never references either); `/private/tmp/adv119/site18` =
the same for `audita-acessibilidade-1.1.18.zip`. Site19's `manifest.json` was verified as `1.1.19`,
site18's as `1.1.18`.

---

## Job A — verdict on the corrective delta

### A.0 Shipped bytes (A5) — PASS

| claim | measurement |
|---|---|
| `release/audita-acessibilidade-1.1.19.zip` sha256 = `0e429e22…af14ec9` | `shasum -a 256` → `0e429e226e07e5de365e1fed6542398f1d2acb8e80eada4babb78e0e0af14ec9` ✔ |
| 1.1.15 `5619e27d…` approved, 1.1.16 `c175a224…` rejected, 1.1.17 `c0cc4118…`, 1.1.18 `c76d49ce…` | all four present and hashing exactly to the recorded prefixes ✔ |
| 199 entries, `manifest.json` first, no `test/ docs/ store-assets/ fixtures/ node_modules/` | `find` → 199 files; only `assets/ src/ vendor/ manifest.json` ✔ |
| every packaged entry identical to the tree, both directions | 199/199 identical (sha256 per file); no `src/` or `vendor/` file missing from the package; only `assets/icons/icon-1024.png` and `assets/icons/icon-source.svg` are intentionally outside the package ✔ |
| the package is reproducible from this tree | `node --test test/release-package.test.js` → 7/7 pass, including the isolated rebuild that must equal the delivered hash ✔ |

Note (not a violation): `release/` holds **12** ZIPs — the seven `1.0.x` artifacts are still there in
addition to the five `1.1.x` ones named in the brief. The brief's "five artifacts must remain" holds for
the `1.1.x` line; the `1.0.x` files are untouched.

### A.1 The discard trigger — FIXED, reproduced and re-measured in real Chrome

Method: one scratch E2E (`/private/tmp/adv119/scratch-test/required-field-report-adv119.test.mjs`) run
twice — once from the packaged 1.1.19 bytes, once from the packaged 1.1.18 bytes. It uses the real
collector (`collectPage` + `normalizeSnapshot`) and the real rule (`FORM_RULES` →
`required-field-identification`), then drives the full product flow (side panel → no-pixels audit →
report → four downloads). Fixture: `#m-input-maybe` (`required aria-required="maybe"`),
`#m-input-empty` (`required aria-required=""`), `#m-input-token` (`required aria-required="required"`),
`#m-select-maybe`, `#m-textarea-token` (same trigger on select/textarea), `#a-maybe`
(`aria-required="maybe"`, no native attribute), `#unmarked` (`required`, no marker anywhere),
`#marked` (`required` + `"Nome *"`).

Collector, measured identically in both revisions (so the delta did **not** need to touch it):

| id | tag | `required` own key | `requiredIndicator` |
|---|---|---|---|
| m-input-maybe / m-input-empty / m-input-token | input | absent | absent |
| m-select-maybe | select | absent | absent |
| m-textarea-token | textarea | absent | absent |
| a-maybe | input | absent | absent |
| unmarked | input | `true` | `""` |
| marked | input | `true` | `"*"` |

Rule outcome:

| revision | outcome | targets |
|---|---|---|
| **1.1.18** (pre-fix) | `cantTell` — "Faltam dados do estado ou da identificação de campo obrigatório." | **`[]`** — the unmarked field and the invalid-ARIA field both vanish; limitations `["Colete o estado calculado e o indicador associado de cada campo obrigatório."]` |
| **1.1.19** (post-fix) | `cantTell` | `[#a-maybe (invalid-required-state), #unmarked (missing-required-identification)]`; limitations include `"Há campo(s) obrigatório(s) sem estado calculado ou sem indicador observado; a conclusão sobre esses campos depende de nova coleta."` |

Delivered artifacts for the same page (files kept after Chrome teardown, read from disk):

| measurement | 1.1.18 | 1.1.19 |
|---|---|---|
| model occurrences of 5.9.7 | **1**, `nodeId: null` (the generic page-level manual fallback of `run-audit.js:558-571`) | **2**, `nodeId: n-6` and `n-7` |
| `manualReview` entries for 5.9.7 | 1 | 2 (both `status: unanswered`) |
| delivered HTML contains `ABNT 5.9.7 — Campos obrigatórios` as a **checklist question** | **true** (93 checklist questions) | **false** (92) |
| delivered HTML mentions of `5.9.7` | 3 | 8 |
| delivered PDF mentions of `Campos obrigatórios` / `5.9.7` | 1 / 1 | 5 / 2 |
| `Inconformidade ao item 5.9.7…` in HTML / JSON / CSV / PDF text | none | none |
| any `Inconformidade ao item …` sentence anywhere in the four artifacts | none | none |

So the reported user-visible regression is reproduced on the pre-fix bytes and is gone on the post-fix
bytes: the genuinely unmarked required field is no longer discarded, and the item left the generic
checklist for the human-review group (2 concrete per-field suspicions). The legal sentence cannot appear
for this item at all (the rule never returns `failed`), and none was found in any format.

The "page has ONLY such fields" case: a second real page with only the five malformed-native fields was
collected and evaluated in the same Chrome run. Result is **byte-identical across the two revisions**:
`cantTell`, `targets: []`, summary "Faltam dados do estado ou da identificação de campo obrigatório.",
limitation "Colete o estado calculado e o indicador associado de cada campo obrigatório.". The fix does
not over-reach: with nothing observed there is nothing to declare beyond the missing data.

### A.2 Does the new limitation mask anything? — no masking, but it does not reach the report

* It does not suppress observations: the mixed page keeps both targets and the item leaves the generic
  checklist (measured above).
* The item still lands in the **human-review** group, not the checklist: `finding-kind.js` maps
  `missing-required-identification` / `invalid-required-state` to `suspected`, and
  `panel-summary.js:groupForOccurrences` puts `cantTell` suspicions in `humanReview`. Measured from the
  delivered model (2 occurrences with node ids and 2 unanswered review entries) and from the checklist
  count dropping 93 → 92.
* **Important (confirmed): the new limitation text does not reach any delivered artifact.** `"sem estado
  calculado ou sem indicador observado"` count = 0 in the exported HTML, JSON, CSV and in the PDF text of
  1.1.19. The model's rule entry is canonicalised by `canonicalCoreRuleLimitations()` at
  `src/core/report/audit-model.js:240` to the fixed string *"A conclusão depende de revisão humana
  conforme o modo da regra e a justificativa normativa do item."* (that canonical string is present in the
  JSON and absent from the HTML/CSV/PDF, which print no rule-level limitation at all). Every core-rule
  summary, limitation and per-field message is replaced before delivery — `audit-model.js:326` even
  *validates* that an occurrence justification equals the canonical summary, so the per-field text
  ("Nenhuma marcação de obrigatoriedade foi observada junto a este campo…") is absent from the delivered
  HTML/JSON/PDF as well (measured: 0 occurrences of that sentence).
  *Consequence:* the author's sentence "missing data is now a declared limitation" is true **only at the
  rule-result layer** (and in the two new tests that read it there). In the panel, the HTML, the JSON,
  the CSV and the PDF, a page whose required fields merely lack observed data is indistinguishable from
  one whose requiredness was observed and looked fine — in both cases 5.9.7 produces no occurrence at all
  when there are no other problems, and the mixed case is distinguishable only by *the presence of
  occurrences*, never by the missing-data declaration.
  *Severity:* Important as a claim/architecture mismatch, **not a regression** — the pre-fix code had the
  same property (its early return also produced no occurrence). Confidence: high (measured in all four
  formats + model + report DOM).

### A.3 M2 alignment — CLOSED, measured in all three sites

Measured by running the same six decision shapes through the real modules on both packaged trees
(`/private/tmp/adv119/m2-measure.mjs`); site A = the model-mode renderer `renderHtmlReport` scoped to the
occurrence card, site B = `qualifiedConsumerReference` (`consumer-basis.js`, reached in the product by
`src/review/report-view.js:311`), site C = the `legalReferenceFor` gate in `panel-detail.js`.

| decision shape | 1.1.18 site A | 1.1.19 site A | site B (both) |
|---|---|---|---|
| complete (evaluator + decidedAt + note) | section + sentence | section + sentence | qualified reference |
| **note-less** (evaluator + decidedAt) | **section + "Inconformidade ao item 5.1.4…"** | **no section, no sentence** | `null` |
| **note = `"   "`** | **section + sentence** | **no section, no sentence** | `null` |
| note-only | unreachable (`createReviewDecision` rejects) | unreachable | `null` |
| evaluator-missing | unreachable | unreachable | `null` |
| decidedAt-missing | unreachable | unreachable | `null` |

`createReviewDecision` (`src/core/review/decisions.js`) makes `evaluator` and canonical `decidedAt`
mandatory and trims the note, and `applyReviewDecisions`/`createAuditModel` re-validate every stored
decision — so the three unreachable shapes cannot exist in a stored model at all. The literal gate text in
`html.js` and `panel-detail.js` is now **identical** (string-compared: `sameGate: true`); `consumer-basis`
enforces the same requirement through canonicalisation (note required and non-blank after trim). The
whitespace-only note, the one residual divergence pre-fix, now agrees too.

Reachability of the model-mode branch (author's claim "no product flow reaches it today"): confirmed for
**delivery**. `renderHtmlReport(model)` without `reportView` is called only from
`export-controller.js:507` (`validateArtifactCorrelation`, legacy branch) and `report-export.js:127/190`
(the legacy paths taken only when `snapshotCapability === null` or `dependencies.reportView === undefined`).
The product export tab (`src/export/index.js:109-114`) always passes both the snapshot capability and a
frozen `reportView`, and a successfully audited model always carries `report.status: 'review-ready'` +
`artifact.status: 'pending'` (`run-audit.js:1107-1109`, measured in the delivered model), so
`runImmutableRevisionExport` is taken and the delivered HTML/print HTML come from the report renderer.
The model-mode renderer is therefore executed by product code only as a self-comparison string in the
legacy branch — never shown to a user. Confidence: high for the delivery paths; the legacy branch is
guarded by tests, not by a product flow.

### A.4 Are the new tests vacuous or over-fitted? — non-vacuous, two of three fail on pre-fix bytes

Run in `/private/tmp/adv119/site18` (1.1.19 tests + fixtures against pre-fix `src/`) and
`/private/tmp/adv119/site19` (control):

| new guard | pre-fix result | post-fix |
|---|---|---|
| `test/rules/forms.test.js` → "a field with unobserved state does not discard the other requiredness suspicions" | **FAILS**: `actual: []`, `expected: ['unmarked']` | passes |
| `test/report/html.test.js` → "a reviewed nonconformity without a note does not print the legal reference here either" | **FAILS**: the card contains `<section class="legal-analysis">… Inconformidade ao item 5.1.4 …` | passes |
| `test/e2e/required-field-observation.test.mjs` (extended) | see Job B extras below | — |
| version guards in `extension-shell` / `release-package` | fail pre-fix by construction (they pin 1.1.19) | pass |

Both guards are non-vacuous and neither is over-fitted: the unit case asserts the *target list*, not the
new strings; the HTML case asserts the absence of the legal section for a note-less decision, and the
report's own pre-existing tests (700+ assertion lines) still pass unchanged on both trees. One unrelated
failure appeared in both trees when running the copied package (`embeds a shared large PNG once…`), which
is an artefact of running the parallel-phase test file from a copied tree, not of this delta.

---

## Job B — triage of the failing real-Chrome E2E set

### Method and exact commands

Batch (identical to the runner's serial phase: same 34 files, same order, `--test-concurrency=1`):

```
cd /private/tmp/audita-review-119
AUDITA_E2E_CHROME=… node --test --test-concurrency=1 $(cat /private/tmp/adv119/serial-files.txt) > serial-batch-1.log
```

Standalone repeats: one file per process, one Chrome at a time, in the same checkout. Per-file pass over
all 34 files plus targeted repeats ran as one sequential driver (never two Chromes at once).

**Batch result: 62 tests, 53 pass, 9 fail** (`/private/tmp/adv119/serial-batch-1.log`). The author's
numbers were 65 / 54 / 11; the difference is itself evidence of intermittency, and the two names in the
author's list that pass here (`mandatory-journey`, `passive current-page…`) are covered below.

**Disclosure — one contamination, corrected by re-running:** during the first batch I ran two heavy
`node --test` files (the report/forms unit suites) at the same time as the Chrome batch, which breaks the
"one workload at a time" rule. Every timing-sensitive failure was therefore re-measured standalone with
the machine otherwise idle; the standalone results are identical (see below), so the contamination did
not change any classification.

### Classification table

| # | test (file) | classification | decisive measurement | user-visible consequence |
|---|---|---|---|---|
| 1 | `mandatory-journey-mv3` → "the side panel must not resize itself during the journey" | **intermittent — test timing** (product exonerated) | passed in my batch (3.4 s) and 3/3 standalone runs; but the same measurement sequence in my own scratch run returned `innerWidth/innerHeight = 0×0` for the baseline immediately after `Page.bringToFront` + `visibilityState === 'visible'` (later 360×765) — the exact baseline the assertion compares against | none: the panel does not resize; the test can compare a not-yet-laid-out 0×0 baseline with a laid-out panel |
| 2 | `batch-pixel-consent-mv3` → "full-evidence batch resumes after restart … exports their report" | **budget/timeout (intermittent)** | failed with `DOWNLOAD_PROOF_TIMEOUT` after 311 s at the raised 300 s budget in the batch; author reports a 15 s pass at 420 s; see extras below for the scratch-budget proof | none if the budget is raised; the export itself completes in seconds when the machine is idle |
| 3 | `axe-mv3-csp` → "runs pinned local axe in every isolated frame …" | **intermittent — harness cleanup budget** | body assertions pass; the failure is the `after` hook `cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]` — the `removeProfile` stage of `createBoundedBrowserCleanup`, 2 000 ms budget; standalone re-run **passed** (ratio 1 fail / 1 pass) | none for the user; the harness fails to delete its own temporary Chrome profile under load |
| 4 | `sidepanel-flow` → "original-page ABNT markers remain usable across idle and preserve the report" | **harness/stale** | `WAIT_TIMEOUT` in `waitForOwner` (30 s): it waits for exactly one `audita:owned-tab:v2:*` record for the audit in state `retained-for-consent`. Dumped session storage at failure: `ownedTabKeys: []` — the key family is absent, while `audita:active-audit-job:v1` is `privacy-paused` for the wanted auditId. Raising the budget to 150 s does **not** help (fails at 151.9 s) | none: the shipped test encodes a contract the current-page flow never implements |
| 5 | `sidepanel-flow` → "original-page ABNT markers visual review and verified exports" | **harness/stale** | identical failure point and identical dump | none |
| 6 | `sidepanel-flow` → "full-evidence can be cancelled at the privacy pause without touching the source" | **harness/stale** | identical (`assertPausedAttempt` → `waitForOwner`, 30 s) | none |
| 7 | `sidepanel-flow` → "no-pixels shows progress, completes in the copy and exposes a view-only report" | **harness/stale (cascade)** | `WAIT_TIMEOUT` at `beginAttachedAttempt:988` waiting for `[data-screen] === 'initial'`; the previous subtest left the panel on the paused screen because it aborted before its `CANCEL` step | none |
| 8 | `sidepanel-flow` → "element-only confirms once and keeps the full-page capture omitted" | **harness/stale (cascade)** | `CDP_COMMAND_TIMEOUT` (30 s) on the first `panel.command('Page.bringToFront')` of the subtest, with the panel still wedged in the previous subtest's paused state | none |
| 9 | `sidepanel-flow` → "full-evidence rehydrates after worker restart and exports all four formats" | **harness/stale (cascade)** | `FULL_EVIDENCE_BEGIN_ATTEMPT_FAILED` ← `CDP_COMMAND_TIMEOUT`, same cause as #8 | none |
| 10 | `sidepanel-flow` → "current-page audits run in one inactive copy and leave the original page intact" (parent) | **harness/stale** | fails only through its subtests (#6–#9); the parent's own final assertions are never reached | none |
| 11 | `sidepanel-flow` → "passive current-page observes memory-only elements without navigation or interaction" (author's element-only / full-evidence variants) | **not reproduced** | passed in the batch (2.9 s) and standalone (2.8 s); this test uses the no-pixels mode and never touches the owned-tab contract | none observed |

### The one root cause behind rows 4–10, and its falsifier

The failing tests assert the **documented** current-page contract: README.md:63 — *"A inspeção ocorre
em uma cópia temporária e inativa, de modo que a página original permanece visível, ativa e sem rolagens,
mudanças de foco ou destaques durante a auditoria."* — and therefore expect an owned, disposable copy tab
registered in `audita:owned-tab:v2:*`.

Measured product behaviour (scratch E2E `adv119-tab-inventory.test.mjs`, packaged 1.1.19 bytes, real
Chrome, `chrome.tabs.query({})` taken before the panel, after the panel, while paused and after cancel):

* The tab list is **identical** at all four moments (3 tabs: the launch `about:blank`, the E2E harness,
  the audited page). **No copy tab is ever created.**
* The audit binds to **the user's own tab**: session capability
  `audita:audit-session-capability:v1:…` → `mode: 'attached'`, `targetBinding: {kind:'attached',
  tabId: 1855240918}` where `1855240918` is the source tab; target capability `kind: 'attached'`, same
  tabId, `state: 'claimed'`.
* Cancelling at the privacy pause works correctly: session capability → `revoked`, target capability →
  `invalidated`, `audita:active-audit-job:v1` cleared, source tab still open, `ownedTabKeys: []` before
  and after (nothing to leak).

Static corroboration: `startAttached` (`side-panel-intent-router.js:499`) never mints an `ownershipId`;
`observed-tab-runner.js:351` returns `'attached'` for every non-`owned-disposable` target, and
`run-audit.js:1351-1355` stubs `createTab`/`removeTab` to the observed tab for the attached case; the
`'attached'` binding is a first-class branch in `target-capabilities.js:678-681` and validated in
`panel-port.js:156-166`. The same design and the same README sentence are present in 1.1.16, 1.1.17 and
1.1.18, so **this is not a regression of this delta**.

**Falsifier:** if the product created and owned a copy tab here, `chrome.tabs.query({})` while paused
would list a fourth tab and `chrome.tabs.query`/session storage would hold one `audita:owned-tab:v2:*`
record in `retained-for-consent`; both were measured empty. Conversely, if the copy is the intended
contract, the defect is in the product (or in the documentation), not in the test.

**Judgement:** the *test family* is stale/harness-level (it encodes the README promise, not the shipped
behaviour), and the product behaviour it was protecting — the source page is untouched, no orphan tab is
created, cancel cleans up every record — is verified intact. What remains genuinely wrong is the
**documentation claim**: for the current-page flow the inspection does not happen in a copy; it happens on
the user's own tab through a CDP attachment. Severity: **Important (documentation / consumer
expectation), confidence high on the measurement, medium on which side should change.** It is pre-existing
relative to `75e2717..dad1cda` and it is the single largest reason the newly-enabled serial phase is red.

### Per-file vs batch comparison, and the extras

(filled in by the runs below)

---

## Retractions (things I had to withdraw after measuring)

1. I initially attributed the `sidepanel-flow` failures to `waitForPrivacyPause` (a 30 s wait) because the
   elapsed times were ~30–32 s. The stack traces show the pause **does** appear; the timeout is in
   `assertPausedAttempt` → `waitForOwner`. Retracted.
2. I hypothesised the failures were load-induced because I had run heavy unit suites concurrently with the
   first batch. The clean standalone re-run reproduces them exactly. Retracted.
3. I first reported "`class="legal-analysis"` is still rendered for a note-less decision in 1.1.19" from a
   whole-document string search; scoping the search to the reviewed occurrence's card showed the section is
   gone and the match came from other occurrences of the sample audit. Retracted.
4. The author's list includes `passive current-page observes memory-only elements…` as failing "element-only
   and full-evidence variants"; in my runs that test passes and uses the no-pixels mode. I could not
   reproduce those two failures.

## Not verified / residual risk

* The delivered-report limitation claim was measured on the report document (the same `reportView`
  renderer that produces the exported HTML and the print HTML for the PDF) and on the four exported files
  read from disk; the PDF was checked by extracting its text with `pypdf`, not by inspecting its tagged
  structure.
* Whether `only-malformed` and `all-fields-marked` pages are also indistinguishable *in the full product
  flow* (not just at the rule layer) was inferred from the model + the occurrence-driven grouping in
  `panel-summary.js`; I did not run a second full audit for those two pages.
* Site C (`panel-detail.js`) was measured by exact source comparison of its gate plus the product's own
  passing assertion that a confirmed failure still carries the short reference (`mandatory-journey` step
  7), not by driving `buildPanelDetail` with a note-less decision.
* Unverified suspicion, not measured: `persistExportSuccess` chooses `validateArtifactCorrelation`
  (which re-renders model-mode HTML and compares it with the delivered reportView HTML) from the *model's*
  `report.status`, not from the export branch. A model whose `report.status` is still `pending`
  (`run-audit.js:744/1397/1447`, e.g. an audit that failed before the report handoff) would take that
  comparison while the delivered HTML came from the reportView renderer, which would raise
  "HTML ou JSON técnico não corresponde ao modelo final". I did not verify whether the UI can export such
  an audit.
* The per-file pass and the extra repeats were still running when this report was written; their results
  are in the sections below and in `/private/tmp/adv119/*.log`.

## Recommendation

**Next step: fix the documentation/test contract, not the product bytes.** 1.1.19 can replace the approved
candidate (see the verdict above); opening a new product revision for the Job B findings would be wrong,
because the only product-side item in them is a README sentence, and the six deterministic failures are
tests asserting that sentence rather than the shipped behaviour. Concretely: (1) decide whether the
current-page flow is *meant* to use an inactive copy; if yes, that is a product change and a new review,
and `sidepanel-flow` is the specification; if no, correct README.md:63 and rewrite
`assertPausedAttempt`/`assertCopyIsolation` against the `attached` session capability (no owned-tab
record), and stop the cascades by making the first subtest's failure cancel the audit in a `finally`.
(2) Raise the two harness budgets (`createBoundedBrowserCleanup` `removeProfile` stage, and the batch
export) and take the panel-size baseline after the panel has a non-zero layout. (3) Either surface the
missing-data limitation in a delivered artifact or drop the "declared limitation" wording, because today
it exists only inside the rule result.
