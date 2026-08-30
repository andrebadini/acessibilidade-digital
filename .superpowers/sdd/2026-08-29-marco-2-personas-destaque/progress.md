# SDD ledger — Marco 2: personas e destaque

- Status: ACTIVE. Marco 1 is complete, independently reviewed and gated in real Chrome 152.
- Plan: `docs/superpowers/plans/2026-08-29-marco-2-personas-destaque.md`.
- Spec authority: `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`.
- Preflight: `.superpowers/sdd/2026-08-29-marco-2-personas-destaque/preflight.md`.

## Controller rulings

1. The exact Marco 1 `ObservedAuditResultV1` union (`completed|paused|failed`) remains authoritative through Marco 2. Marco 3 owns the one deliberate migration to the roadmap runner target/privacy/result contract; no dual-union adapter is permitted.
2. Marco 2 extends the sole target authority with atomic `claimPreparedTarget({capabilityId,intent:'start-persona',senderContext})`. It re-proves sender/window/document/HMAC/expiry inside the serialized claim, writes `state:'claimed'`, emits no audit session and returns only the closed worker-internal target. `inspectPrepared` is preflight only.
3. Marco 2 Task 1 owns protocol/parser/popup UI contracts only. Operational persona branches remain fixed `FEATURE_NOT_READY` with zero claim/effect until Task 3 wires the coordinator; no simulated success.
4. Task 3 performs one idempotent fail-closed legacy-persona migration before new persona/audit operations: clean only a still-provable legacy document/runtime/CSS, delete the legacy key only after absence confirmation, and block that tab on unconfirmed live cleanup. Never convert a legacy binding into a new lease; remove legacy panel owner/content ports/listeners.
5. Locator/signature proof uses one exported, self-contained, closure-free `runHighlightProbeCommand` whose helpers/native-role map are nested in the function. `chrome.scripting.executeScript` invokes it once against exact `documentIds`; it returns one closed JSON-safe result. Unit and real-Chrome tests compare its structural role/signature output byte-for-byte with the module validator.
6. Under the target lock the result order is: runner returns → canonical model/checkpoint persist atomically → snapshot/revision/hash reload and integrity verification → binding record attempt → valid binding or explicit evidence-only absence persists → session transitions `result` → summary/events publish → lock releases. Binding absence never alters normative model/classification.
7. All overlay install/replace/clear operations acquire a per-tab exclusion lock before the `(tabId,topDocumentId)` operation lock. A single lock order is mandatory; reload/SPA races must leave at most one root/owner per tab.
8. The only allowed post-migration persona compatibility surface is a thin adapter over coordinator operations `setMode`, `stop`, `rehydrate` and `cleanupBeforeAudit`; remove `openPanel`, legacy binding leases, panel/content ports and direct listener ownership when their consumers disappear.
9. Remove automatic messaging installation from `src/personas/content.js`. The injected command registers zero `runtime.onMessage` listeners and zero content ports; the factory/runtime may remain local.
10. `HighlightBindingV1` keeps the 5,000 logical-target hard ceiling but additionally enforces canonical serialized budgets of 1 MiB per binding and 4 MiB for the whole persisted registry. Targets are considered in sorted occurrence-ID order; overflow is omitted deterministically and becomes evidence-only availability with a fixed limitation, never partial binding data.
11. The service worker owns the only permanent `tabs.onUpdated`/`tabs.onRemoved` lifecycle listeners. Operation-scoped runner wait listeners are allowed only with tests proving removal on success, failure, timeout and abort; persona/highlight modules register no Chrome lifecycle listener.
12. The binding Side Panel amendment removes every historical popup surface: the toolbar icon opens `src/panel/index.html`, and every UI intent in this milestone is a `PANEL_*`/native `SIDE_PANEL` flow. No `src/popup/*`, `default_popup`, `POPUP` context or fallback launcher may return.
13. A failed persona-expiry schedule may never leave an active runtime/lease without a durable retry or externally usable authority. Recovery must fail closed on future-dated leases, continue across independent candidates, clear orphan runtimes before declaring absence, and repair an invalid registry only after cleanup of every recognizable target is confirmed.
14. The native Side Panel sender in Chrome 152 exposes no `documentId`, tab or window, while `runtime.getContexts()` reports unique Side Panel documents with `tabId:-1` and `windowId:-1`; therefore the historical `side-panel-window:<windowId>` alias is forbidden. The toolbar action now synchronously mints a one-use launch token bound by the worker to its `tabId` and `windowId`, configures the exact tokenized panel URL with `sidePanel.setOptions()` and opens it in that API's callback so the user gesture survives. Admission requires one exact live context and one exact Port URL; privileged panel intents remain bound to that admitted Port/generation and disconnect revokes them. This supersedes ruling 12 only as to `openPanelOnActionClick:true`; the public result remains one-click native Side Panel with zero popup.

## Risk ruling

- Parser/authority/claim, persona lease/recovery/cleanup, binding/model/store/proof and report-session changes are Critical: TDD, attack/race tests, real Chrome and two independent reviews with zero Critical/Important.
- Pure popup/panel/report action presentation and isolated overlay visuals are Medium when not crossing authority: focused tests, visual/a11y QA and one independent UI review.

## Execution ledger

- Marco 1 gate: complete at `d39c05f`; Chrome 152 proved exactly one `SIDE_PANEL`, zero `POPUP`, stable audit/detail/evidence/report journey and four verified exports.
- Task 2 (serialized persona lease store and target queue): complete at `51d9361`; focused tests and independent review passed.
- Task 3 (persona runtime/coordinator/cleanup): complete. The core FSM and cleanup transaction were committed at `5e29a27`; worker, capability, tokenized native Side Panel, report-decision authority and real-browser integration now pass the gate. Two independent final reviews report 0 Critical / 0 Important / 0 Minor. Chrome 152 proved one stable `SIDE_PANEL`, zero `POPUP`, a completed audit/report journey and four hashed exports. The exact integration commit is recorded after the commit is created.
- Task 4 (live target locator): complete at `204a4b9`; focused tests and review passed.
- Task 5 (model-bound highlight binding/store): complete at `39233c0`; 132 focused tests and independent review passed with 0 Critical / 0 Important.
- Task 6 onward: pending after Task 3 gate closes.
