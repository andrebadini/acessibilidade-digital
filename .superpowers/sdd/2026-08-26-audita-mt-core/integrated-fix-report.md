# Integrated Core fix report

## Outcome

The five Important findings were corrected as one dependency-free core integration:

- `SnapshotV1` is the public serializable wire contract. Runtime `byNodeId` and `byDomId` indexes are built separately and are never attached to or serialized with the snapshot.
- accessible-name fallback resolves `children` and collected `labels` through node IDs, ARIA IDREFs and native `for` through unique DOM IDs, and conservatively ignores duplicate DOM IDs;
- `runRules` creates one independent deeply readonly snapshot/context graph per execution and shares that identity across all 130 rules. `Date`, `Map`, `Set`, typed arrays and sync/async helper results cannot mutate shared input;
- announcement values are omitted by default. Only `valueDisclosure: 'safe'` opts a non-sensitive value in, while password, password autocomplete, OTP and explicit sensitivity always suppress it;
- custom interactive semantics accepts only explicit concrete ARIA roles, rejects abstract/unknown/presentational/incompatible roles, and returns `cantTell` when compatibility evidence is absent;
- `src/core/index.js` is the authoritative public entrypoint. It validates exact composition before running, executes 130 rules, aggregates 146 NBR items, and returns a frozen JSON-safe audit model.

## TDD evidence

### RED

Tests were written before production changes and run together. The observed failures were specific to each requested behavior:

1. `snapshot-schema.test.js` and `audit.test.js` failed with `ERR_MODULE_NOT_FOUND` for the new public modules.
2. Announcement preview exposed `token=mt-secret-123` without opt-in.
3. `custom-component-semantics` returned `passed` for `role="made-up"` and for a widget role with no compatibility evidence.
4. The 130-rule identity probe observed a different cloned snapshot/context for each rule.
5. Internal-slot mutation attempts caused the mutating rule to become `untested`, demonstrating that `Object.freeze` alone did not implement the requested shared readonly contract.

The RED tests name observable breaks rather than implementation details: namespace confusion, secret disclosure, false ARIA passes, per-rule clone amplification and cross-rule mutation risk.

### GREEN

Focused integration verification after implementation:

```sh
node --test test/core/snapshot-schema.test.js test/core/audit.test.js \
  test/accessibility/accessible-name.test.js test/accessibility/announcement.test.js \
  test/rules/interactive.test.js test/rules/engine.test.js
```

Result: 75 passed, 0 failed in the final focused run before full-suite verification.

The full-suite, normative/composition, serialization and whitespace commands are recorded in the final verification section below.

## SnapshotV1 API

Public exports from `src/core/index.js`:

- `SNAPSHOT_SCHEMA_VERSION` (`1`)
- `validateSnapshotV1(snapshot)` → deterministic string errors
- `assertSnapshotV1(snapshot)` → returns the valid snapshot or throws `TypeError`
- `buildSnapshotIndexes(snapshot)` → `{ byNodeId: Map, byDomId: Map<string, Node[]> }`
- `computeAccessibleText(node, indexes, axNode?)`
- `CORE_RULES`, `validateCoreRuleComposition(rules?)`, `runCoreAudit(snapshot, context?, rules?)`
- normative, result, rule registry/runner/aggregation and announcement APIs needed by collection, extension and reporting layers.

Wire shape:

```js
{
  schemaVersion: 1,
  document: { /* JSON-safe document observations */ },
  nodes: [{
    nodeId: 'stable-node-id',
    attributes: { id: 'dom-id' },
    children: ['child-node-id'],
    parentId: null
  }]
}
```

`nodeId` and `attributes.id` are deliberately different namespaces. Duplicate DOM IDs remain represented by multiple entries in `byDomId`; consumers that need a unique IDREF resolve them conservatively. Task 5 legacy fixtures with `byId` remain accepted by predicates, but `runCoreAudit` accepts only valid `SnapshotV1` input.

## Performance and isolation

The automated performance gate uses two independent signals:

- diagnostic count: exactly one readonly-view creation for a 10,000-node snapshot and 130 rules;
- broad non-flaky ceiling: the execution must complete within 10 seconds.

Local comparison on this machine, Node.js 25.9.0, same synthetic 10,000-node snapshot and 130 trivial rules:

| Revision | Readonly construction | Time |
| --- | ---: | ---: |
| Base `26d542f` | 260 deep views (snapshot + context for each rule) | 1741.53 ms |
| Integrated fix | 1 combined deep view per execution | 16.47 ms |

This local run was about 105.7× faster. The ratio is documentation, not a CI assertion; the stable clone-count invariant is the primary regression gate.

The readonly layer preserves usable `instanceof` and read semantics for `Date`, `Map`, `Set`, `ArrayBuffer`, `DataView` and typed arrays. Mutator methods, property writes, callback escape paths (`forEach`) and typed-array view escape paths are blocked or detached. Helper results are cloned into independent readonly views for both synchronous and asynchronous helpers.

## Privacy

`buildAnnouncementPreview()` returns only `{ text, kind, locale }`; it never returns the source value as metadata. Values are absent unless the caller explicitly supplies `valueDisclosure: 'safe'`. Even with that opt-in, the value is suppressed for:

- `sensitive: true`;
- `inputType: 'password'` or `type: 'password'`;
- `autocomplete` tokens `current-password`, `new-password` or `one-time-code`, including sectioned token lists.

Regression probes cover the literal token `token=mt-secret-123`, password fields and OTP data.

## Composition and audit guarantees

`CORE_RULES` has stable Task 5 + Task 6 family order. `validateCoreRuleComposition()` compares it with the authoritative NBR catalogue and requires exactly 130 expected IDs with exact `mode`, `nbrItems` and `wcag`, rejecting missing, unexpected and duplicate rules. `runCoreAudit()` aborts before rule execution when either composition or `SnapshotV1` is invalid.

On valid input, the returned model has:

```js
{
  schemaVersion: 1,
  ruleResults: [/* exactly 130 */],
  itemResults: [/* exactly 146 */],
  composition: { ruleCount: 130, itemCount: 146, valid: true }
}
```

The complete object is frozen, JSON-safe and contains no runtime `Map` indexes.

## Final verification

Commands run immediately before staging the integrated commit:

```sh
npm test
node --input-type=module # normative, composition, audit and JSON assertions
git diff --check
```

- Full core suite: 143 passed, 0 failed, 0 skipped.
- 10,000-node gate during the full suite: 35.05 ms, below the deliberately broad 10 s ceiling, with one readonly-view creation.
- Normative validation: 0 errors.
- Composition: 130 rules, 130 unique IDs, 0 errors.
- Aggregation: 146 items.
- Canonical smoke result: frozen and successfully serialized to 119,479 JSON bytes, with no `byNodeId` or `byDomId` leakage.
- Whitespace check: exit 0, no output.

## Revisions

- Base SHA: `26d542fe5cb9bc34be8f6aee002d4ac141e4cc11`.
- Delivery SHA: the single commit containing this report, with subject `feat: integrate and secure core audit pipeline`. Because a commit cannot embed its own hash without changing that hash, resolve it with `git rev-parse HEAD` after the commit is created.
