# Production Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this verification plan locally, without restarting approved implementation.

**Goal:** Deliver a production candidate whose actual runtime, reports, tests and distribution package agree; beta delivery is not completion.

**Architecture:** Preserve the existing extension and its security boundaries. Start from the actual 1.1.12 Google evidence, isolate demonstrated failures, and validate the final version itself rather than substituting another version's results.

**Tech Stack:** JavaScript ES modules, MV3, bundled axe-core, node:test, Chrome for Testing 152.0.7977.64.

**Spec:** User correction on 08/09/2026; factual baseline and reproduction in `docs/qa/2026-09-08-google-1112-production-correction.md`.

## User-requested pause checkpoint

On 08/09 the user explicitly requested **beta 1.1.13, then pause**. Finish only the in-flight producer-version fix, validation and that beta delivery before pausing. This is an intermediate package requested by the user, not production approval or completion of this plan. Resume production work only when requested.

**Resumed 12/09:** user explicitly requested continuation. Existing HEAD `396b0ec` and delivered packages are preserved. Production acceptance remains open. Focused follow-up: expose the recorded producer in live/HTML/print reports (the data was already preserved in 1.1.13), then reconcile acceptance and test the frozen production candidate itself.

## Global Constraints

- Production, not beta, is the goal. Do not merely remove the word beta.
- No revision of saved evidence or retrospective replacement of its version.
- No production claims while known Critical/Important findings remain.
- Focused tests during fixes; full logical/native gate on frozen delivery candidate with Chrome path confirmed first.
- Do not re-open approved boundaries without a new reproducible Important/Critical impact.
- Preserve 1.1.12 package and Google exports as historical evidence.
- No publication, login or modification of the user's Chrome installation implied by local testing.

## Task 1 — Current-version factual acceptance

**Files:** `docs/qa/2026-09-08-google-1112-production-correction.md`; existing runtime unchanged.

- [x] Assert ZIP hash and compare all 198 packaged runtime files with the loaded runtime.
- [x] Run `/private/tmp/audita-google-beta1112.mjs` with the confirmed Chrome binary on `https://www.google.com/`.
- [x] Open the generated report, confirm four completed downloads, count PDF pages and visually inspect rendered summary/contrast evidence.
- [x] Save the new four exports under `entregas/teste-google-com-1.1.12/`, recording hashes and comparison limitations.
- [x] Test the independent assertion `audit.versions.extension === manifest.version` against the new JSON. Observed RED: `0.1.0 !== 1.1.12`.

## Task 2 — Isolate the demonstrated production blockers

**Read-only scope initially:** `src/core/report/enrich-audit.js`, `src/background/run-audit.js`, `src/background/service-worker.js`, `src/background/run-batch.js`, related tests and `test/e2e/support/real-chrome.mjs`.

- [x] Trace all five enrichment sites and their installed-version source, including success, cancelled terminal models and resumed attempts. Version is captured as data from the trusted installed Chrome manifest and adapter, without changing public protocol envelopes.
- [x] Add focused regression tests at the actual caller/model boundary: installed producer version survives to the report; historical V2 producer remains unchanged. RED: eight assertions; GREEN: 357/357 focused. Commit `796f802`.
- [ ] For the first-attempt `CDP_COMMAND_FAILED`, instrument only the temporary test controller with substep, fixed error category and fresh panel state; never log raw page content or private capability values. Reproduce or explicitly retain the uncertainty; a subsequent pass alone is not a diagnosis.
- [x] Freeze the corrected increment after focused GREEN and `git diff --check`; two independent reviews of `796f802`: C=0/I=0/M=0. Reviewers independently verified eight and nine focused cases. Not production approval.

## Task 3 — Production candidate, not a relabelled beta

**Release scope after blockers close:** `manifest.json`, `store-assets/STORE-LISTING.md`, current installation/use guide, `README.md`, release tests and QA record. Runtime changes only for demonstrated unresolved requirements.

- [ ] Reconcile the current implementation with all user requirements, including original-page highlighting, readable reports, grouping, personas, accessible names/estimated announcements, URL/batch, privacy and retention; classify genuine missing functionality separately from transparent technical limits and visual refinements.
- [ ] Set a new unambiguous production candidate version without overwriting any distributed version. Run focused release metadata tests.
- [ ] Confirm the Chrome binary version, then run `npm test` on the frozen candidate. Execute `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify`. Investigate actual failures; retry only affected failures with documented preparation/corrections.
- [ ] Review the same frozen candidate independently with zero Critical/Important findings; minor findings remain visible and do not silently reduce requested functionality.
- [ ] Generate the release ZIP once with `npm run build:release`, verify entries/hash, and compare the runtime to the tested candidate.
- [ ] Run the Google public journey on this exact final version, assert the exported extension version, open HTML/PDF and save its own four exports. Validate literal A→B/new audit and preserved A without requiring an unchanged internal panel context.
- [ ] Deliver the production package, current-version reports, installation/update guide, limits and test record. Mark the goal complete only after these acceptance conditions are met.
