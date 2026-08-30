# Task 6 implementation report

## Outcome

Implemented the immutable four-state side panel (`initial | running | result | unavailable`) over the existing Task 5 `audita-panel-v1` transport. The runtime consumes the copied/frozen Task 5 panel bundle, renders working impact/WCAG/ABNT filters and the exact ten detail blocks, preserves stable selection/focus/scroll state, and removes all legacy persona, speech, URL-prefill and bearer behavior from the side-panel runtime. Task 5 review/persona compatibility exports remain available.

The renderer uses `createElement` and `textContent` only. It does not use `innerHTML`, construct selectors from audited values, expose bearer/capability data, render raw audited URLs outside the already projected identity, put selector/snippet data in attributes, or expose Chrome target IDs. URL and batch choices remain local Marco 3 explanations. Cancel and report actions continue through the closure-owned session intent API.

## TDD evidence

### Initial RED

Command:

```text
node --test test/panel/panel-state.test.js test/panel/panel-view.test.js test/panel/panel-ui.test.js
```

Result: **0 passed, 9 failed**, as expected. Failures proved the legacy mutable state/view/runtime lacked the Task 6 reducer API, complete renderer, filter model, ten-block detail view, and four-state shell.

### Visual-fidelity refinement RED

After the first GREEN, deterministic comparison showed the selected detail after all groups instead of directly beneath its card, and an asynchronous result could steal focus. Two focused tests were added before changing implementation.

Command:

```text
node --test test/panel/panel-state.test.js test/panel/panel-view.test.js
```

Result: **14 passed, 2 failed**, with the two expected failures: result focus changed from `cancel-audit` and selected detail was not the card's immediate sibling.

### Focused GREEN

Command:

```text
node --test test/panel/panel-state.test.js test/panel/panel-view.test.js test/panel/panel-ui.test.js test/panel/panel-voice-privacy.test.js test/extension-shell.test.js
```

Result before independent review: **29 passed, 0 failed**.

Coverage includes the exact four screens and event/intent unions, recursive freezing, filter OR/AND semantics, selection/focus/scroll preservation, ten ordered detail blocks, closed datasets, one polite live region, 44 px primary targets, responsive CSS at 320/380/480–520/600 px and 200%, forced-colors/reduced-motion rules, no `innerHTML`, and the negative privacy/runtime boundary.

### Independent-review correction RED

Command:

```text
node --test test/panel/panel-state.test.js test/panel/panel-view.test.js test/panel/panel-ui.test.js test/panel/panel-voice-privacy.test.js test/extension-shell.test.js
```

Result: **26 passed, 8 failed**, as expected. The failures proved the missing semantic result focus destination, detached recursively frozen unknown-event output, native progress, multi-occurrence selection, stable per-chip focus identity, explicit filter reset, disclosure events, and real post-replacement focus behavior.

A subsequent visual-density assertion was added before widening the panel content. Its focused RED was **6 passed, 1 failed**, on the former `37.5rem` maximum width.

### Correction GREEN

The exact five focused files above passed **34/34**. Behavioral coverage now proves:

- `running → result` focuses the real result summary after `replaceChildren`;
- every occurrence on a multi-occurrence card is independently selectable without visible opaque IDs;
- manual evidence/technical disclosure emits `EVIDENCE_TOGGLED` and survives rerender;
- the effective `#panel-root` scrolling container preserves its real `scrollTop`;
- every filter option and `Todos` reset has a stable unique closed focus ID and exact focus restoration;
- valid mutable reducer input is detached and recursively frozen even for invalid/unknown events, while structurally invalid state remains fail-closed.

## Compatibility evidence

Command:

```text
node --test test/panel/panel-session-port.test.js test/personas/persona-controller.test.js test/review/*.test.js
```

Correction result: **92 passed, 0 failed**. The existing port client contract and Task 5 review/persona compatibility surfaces remain intact; there is no persona path in the Task 6 panel runtime.

## Full nonlegacy gate

Command, run alone with file concurrency fixed to one:

```text
find test -type f -name '*.test.js' -print0 | sort -z | xargs -0 node --test --test-concurrency=1
```

The first gate produced **1440 passed, 1 failed**. The failure was a proven build-critical stale assertion in `test/report/identity.test.js` that still required the removed legacy form and identity prose. Its panel assertion was updated only to the new neutral four-state mount. The focused identity test then passed **3/3**.

Original implementation full gate: **1441 passed, 0 failed** in 74.2 seconds.

Correction full gate, run once after the final focused and compatibility checks: **1446 passed, 0 failed** in 74.36 seconds.

## Visual and accessibility evidence

The approved option-2 source and the previously rejected joint comparison at `.superpowers/task6-qa/reference-vs-implementation.png` were inspected. That comparison exposed excessive whitespace, text-only coverage, tall filters, detached detail presentation, and weak density relative to the source. The correction adds native determinate progress, increases useful width to `44rem`, compacts metrics/filters/cards, adds a clear `Todos` control, visually integrates detail with its card, and uses a responsive two-column grid for the ten blocks from 480 CSS pixels. Below that breakpoint—including effective narrow layouts at 200% zoom—the detail remains one column. Interactive controls retain the 44 CSS pixel minimum; forced-colors and reduced-motion rules remain explicit.

Focused behavioral tests cover semantic focus, root scroll, exact chip restoration, native progress, disclosure persistence, multi-occurrence selection, and the ten-block structure rather than relying only on CSS regular expressions.

The in-app browser was unavailable during the correction and its browser inventory was empty, so a revised deterministic screenshot and normalized joint comparison could not be produced. The earlier rejected image is not claimed as post-fix evidence. `design-qa.md` therefore records `final result: blocked`; real Chrome side-panel comparison at 320/380/480–520/600, 200% zoom, forced colors, and reduced motion remains pending controller QA. Existing legacy E2E selectors still cannot evidence Task 6 unchanged.

## Scope and hygiene

`node_modules/` remained untracked and is not staged. No Task 5 transport or bundle boundary was changed. No highlight, URL audit, batch audit, raw capability, or legacy persona functionality was added.
