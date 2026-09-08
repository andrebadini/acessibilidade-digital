import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import {
  assertBindingMatchesModel,
  createHighlightBindingV1,
  recordHighlightBindingV1,
  validateHighlightBindingV1,
} from '../../src/background/highlight-binding.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';

const EPOCH = 1_788_000_000_000;
const TTL_MS = 30 * 60_000;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const OPTIONS = Object.freeze({
  now: () => '2026-08-29T12:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

async function snapshotFixture({
  auditId = 'audit-highlight-binding', ambiguous = false, extraEvidence = 0,
} = {}) {
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.finalUrl = 'https://servico.exemplo.test/consulta/inicio?view=public';
  draft.pages[0].finalUrl = draft.finalUrl;
  const evidence = draft.evidence.find(value => value.evidenceId === 'ev-control');
  evidence.selector.css = 'button#continue';
  if (ambiguous) {
    const copy = { ...structuredClone(evidence), evidenceId: 'ev-control-copy' };
    draft.evidence.push(copy);
    draft.occurrences[0].evidenceIds.push(copy.evidenceId);
    draft.occurrences[0].evidenceRefs.push(copy.evidenceId);
  }
  for (let index = 0; index < extraEvidence; index += 1) {
    const copy = structuredClone(evidence);
    copy.evidenceId = `ev-linear-budget-${index}`;
    draft.evidence.push(copy);
  }
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await verifyAuditIntegritySnapshot(await enrichAuditForReport(draft, OPTIONS));
  return Object.freeze({
    model,
    modelRevision: 4,
    modelHash: model.integrity.canonicalModelHash,
  });
}

function target(overrides = {}) {
  return {
    documentId: 'document-main',
    frameId: 0,
    backendNodeId: 41,
    evidenceId: 'ev-control',
    selector: {
      syntax: 'CSSSelectorV1',
      value: 'button#continue',
      byteLength: 15,
      complexity: 2,
    },
    structuralSignature: {
      version: 'StructuralSignatureV1',
      sha256: 'b'.repeat(64),
    },
    rectBucket: { x: -16, y: 32, width: 96, height: 32 },
    ...overrides,
  };
}

function bindingInput(snapshot, overrides = {}) {
  const targets = Object.create(null);
  targets['occ-focus-failed'] = target();
  return {
    version: 1,
    auditId: snapshot.model.auditId,
    pageId: 'page-1',
    modelRevision: snapshot.modelRevision,
    modelHash: snapshot.modelHash,
    tabId: 17,
    windowId: 9,
    topDocumentId: 'document-main',
    topUrlEvidence: snapshot.model.pages[0].finalUrl,
    topUrlSessionDigest: DIGEST,
    createdAt: EPOCH,
    expiresAt: EPOCH + TTL_MS,
    locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
    targets,
    ...overrides,
  };
}

function replaceTarget(input, occurrenceId, replacement) {
  const targets = Object.create(null);
  for (const [key, value] of Object.entries(input.targets)) targets[key] = structuredClone(value);
  targets[occurrenceId] = replacement;
  return { ...input, targets };
}

test('reconstructs and recursively freezes the exact closed binding schema', async () => {
  const snapshot = await snapshotFixture();
  const input = bindingInput(snapshot);
  const binding = createHighlightBindingV1(input);

  assert.notEqual(binding, input);
  assert.notEqual(binding.targets, input.targets);
  assert.equal(Object.getPrototypeOf(binding.targets), null);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.targets), true);
  assert.equal(Object.isFrozen(binding.targets['occ-focus-failed']), true);
  assert.equal(Object.isFrozen(binding.targets['occ-focus-failed'].selector), true);
  assert.equal(Object.isFrozen(binding.targets['occ-focus-failed'].structuralSignature), true);
  assert.equal(Object.isFrozen(binding.targets['occ-focus-failed'].rectBucket), true);
  assert.deepEqual(validateHighlightBindingV1(binding), binding);
  assert.notEqual(validateHighlightBindingV1(binding), binding);
});

test('rejects SHA-256 in place of URL HMAC and every unknown nested field', async () => {
  const snapshot = await snapshotFixture();
  const input = bindingInput(snapshot);
  const cases = [
    { ...input, topUrlSessionDigest: `sha256:${'a'.repeat(64)}` },
    { ...input, debugUrl: 'https://private.test/?token=x' },
    replaceTarget(input, 'occ-focus-failed', { ...target(), rawUrl: 'https://private.test/' }),
    replaceTarget(input, 'occ-focus-failed', {
      ...target(), selector: { ...target().selector, segments: [] },
    }),
    replaceTarget(input, 'occ-focus-failed', {
      ...target(), structuralSignature: { ...target().structuralSignature, nodeText: 'private' },
    }),
    replaceTarget(input, 'occ-focus-failed', {
      ...target(), rectBucket: { ...target().rectBucket, right: 80 },
    }),
  ];
  for (const candidate of cases) {
    assert.throws(
      () => createHighlightBindingV1(candidate),
      error => error instanceof TypeError && error.message === 'HighlightBindingV1 inválido.',
    );
  }
});

test('recomputes selector metadata and enforces time, target, rect and dangerous-key limits', async () => {
  const snapshot = await snapshotFixture();
  const input = bindingInput(snapshot);
  const invalidTargets = [
    target({ selector: { ...target().selector, byteLength: 14 } }),
    target({ selector: { ...target().selector, complexity: 3 } }),
    target({ selector: { ...target().selector, value: 'button#session-token' } }),
    target({ rectBucket: { x: 1, y: 32, width: 96, height: 32 } }),
    target({ rectBucket: { x: 0, y: 0, width: -16, height: 16 } }),
    target({ rectBucket: { x: 0, y: 0, width: 1_000_016, height: 16 } }),
    target({ frameId: -1 }),
    target({ backendNodeId: 0 }),
  ];
  for (const invalid of invalidTargets) {
    assert.throws(() => createHighlightBindingV1(
      replaceTarget(input, 'occ-focus-failed', invalid),
    ), /HighlightBindingV1 inválido\./u);
  }

  for (const [createdAt, expiresAt] of [
    [EPOCH, EPOCH - 1],
    [EPOCH, EPOCH + TTL_MS + 1],
    [-1, EPOCH],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ]) {
    assert.throws(
      () => createHighlightBindingV1({ ...input, createdAt, expiresAt }),
      /HighlightBindingV1 inválido\./u,
    );
  }

  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const targets = Object.create(null);
    Object.defineProperty(targets, key, { enumerable: true, value: target() });
    assert.throws(
      () => createHighlightBindingV1({ ...input, targets }),
      /HighlightBindingV1 inválido\./u,
    );
  }

  const tooMany = Object.create(null);
  for (let index = 0; index < 5_001; index += 1) tooMany[`occ-${index}`] = target();
  assert.throws(
    () => createHighlightBindingV1({ ...input, targets: tooMany }),
    /HighlightBindingV1 inválido\./u,
  );
});

test('does not invoke binding accessors or trust proxy property reads', async () => {
  const snapshot = await snapshotFixture();
  const input = bindingInput(snapshot);
  let getterCalls = 0;
  const accessor = { ...input };
  Object.defineProperty(accessor, 'targets', {
    enumerable: true,
    get() { getterCalls += 1; return input.targets; },
  });
  assert.throws(() => createHighlightBindingV1(accessor), /HighlightBindingV1 inválido\./u);
  assert.equal(getterCalls, 0);

  const hostileTargets = new Proxy(Object.create(null), {
    ownKeys() { throw new Error('private trap detail'); },
  });
  assert.throws(
    () => createHighlightBindingV1({ ...input, targets: hostileTargets }),
    error => error instanceof TypeError && error.message === 'HighlightBindingV1 inválido.',
  );

  let coercions = 0;
  const hostileText = { [Symbol.toPrimitive]() { coercions += 1; return DIGEST; } };
  assert.throws(
    () => createHighlightBindingV1({ ...input, topUrlSessionDigest: hostileText }),
    /HighlightBindingV1 inválido\./u,
  );
  assert.throws(
    () => createHighlightBindingV1(replaceTarget(input, 'occ-focus-failed', target({
      structuralSignature: { version: 'StructuralSignatureV1', sha256: hostileText },
    }))),
    /HighlightBindingV1 inválido\./u,
  );
  assert.equal(coercions, 0);
});

test('requires the exact audit, page, occurrence and unique node evidence relation', async () => {
  const snapshot = await snapshotFixture();
  const binding = createHighlightBindingV1(bindingInput(snapshot));
  const matched = assertBindingMatchesModel({ binding, snapshot });
  assert.deepEqual(matched, binding);
  assert.notEqual(matched, binding);

  const invalid = [
    { ...bindingInput(snapshot), auditId: 'audit-other' },
    { ...bindingInput(snapshot), pageId: 'page-other' },
    { ...bindingInput(snapshot), modelRevision: 5 },
    { ...bindingInput(snapshot), modelHash: 'c'.repeat(64) },
    { ...bindingInput(snapshot), topUrlEvidence: 'https://other.example.test/' },
    replaceTarget(bindingInput(snapshot), 'occ-focus-failed', target({ evidenceId: 'ev-full' })),
    replaceTarget(bindingInput(snapshot), 'occ-focus-failed', target({ backendNodeId: 42 })),
    replaceTarget(bindingInput(snapshot), 'occ-focus-failed', target({
      selector: { ...target().selector, value: 'button#different', byteLength: 16 },
    })),
  ];
  for (const input of invalid) {
    const candidate = createHighlightBindingV1(input);
    assert.throws(
      () => assertBindingMatchesModel({ binding: candidate, snapshot }),
      error => error instanceof TypeError && error.message === 'Relação modelo-evidência inválida.',
    );
  }

  const ambiguousSnapshot = await snapshotFixture({ auditId: snapshot.model.auditId, ambiguous: true });
  const ambiguousBinding = createHighlightBindingV1(bindingInput(ambiguousSnapshot));
  assert.throws(
    () => assertBindingMatchesModel({ binding: ambiguousBinding, snapshot: ambiguousSnapshot }),
    /Relação modelo-evidência inválida\./u,
  );
});

test('keeps evidence binding across later record revisions only for identical verified content', async () => {
  const snapshot = await snapshotFixture();
  const binding = createHighlightBindingV1(bindingInput(snapshot));
  const later = { ...snapshot, modelRevision: snapshot.modelRevision + 1 };
  assert.deepEqual(assertBindingMatchesModel({ binding, snapshot: later }), binding);
  assert.equal(binding.modelRevision, snapshot.modelRevision, 'do not rewrite the provenance of the recorded proof');
  assert.throws(() => assertBindingMatchesModel({ binding,
    snapshot: { ...later, modelHash: 'd'.repeat(64) } }), /Relação modelo-evidência inválida/u);
  assert.throws(() => assertBindingMatchesModel({ binding,
    snapshot: { ...snapshot, modelRevision: snapshot.modelRevision - 1 } }), /Relação modelo-evidência inválida/u);
});

test('records only adapter proofs correlated to the verified model and discards raw URL', async () => {
  const snapshot = await snapshotFixture({ auditId: 'audit-highlight-recorder' });
  const rawCurrentUrl = 'https://servico.exemplo.test/consulta/inicio?token=PRIVATE&view=public';
  let nowCalls = 0;
  let candidatesSeen;
  const chromeAdapter = {
    async getFinalUrl(tabId) {
      assert.equal(tabId, 17);
      return rawCurrentUrl;
    },
    async proveHighlightTargets(input) {
      candidatesSeen = input.candidates;
      const wanted = input.candidates.find(value => value.occurrenceId === 'occ-focus-failed');
      const rejected = input.candidates.find(value => value.occurrenceId === 'occ-focus-review');
      return [
        { ...proofFor(wanted), occurrenceId: 'occ-unknown' },
        { ...proofFor(rejected), backendNodeId: 999 },
        proofFor(wanted),
      ];
    },
  };
  const digestManager = {
    async digest(value) {
      assert.equal(value, rawCurrentUrl);
      return DIGEST;
    },
  };
  const observedTarget = {
    version: 1,
    kind: 'attached',
    tabId: 17,
    windowId: 9,
    documentId: 'document-main',
    urlSessionDigest: DIGEST,
    urlEvidence: snapshot.model.pages[0].finalUrl,
  };

  const binding = await recordHighlightBindingV1({
    snapshot,
    observedTarget,
    chromeAdapter,
    digestManager,
    now: () => { nowCalls += 1; return EPOCH; },
  });

  assert.equal(nowCalls, 1);
  assert.equal(Array.isArray(candidatesSeen), true);
  assert.deepEqual(Object.keys(binding.targets), ['occ-focus-failed']);
  assert.equal(binding.targets['occ-focus-failed'].documentId, 'document-main');
  assert.equal(binding.targets['occ-focus-failed'].backendNodeId, 41);
  assert.equal(binding.createdAt, EPOCH);
  assert.equal(binding.expiresAt, EPOCH + TTL_MS);
  assert.equal(JSON.stringify(binding).includes('PRIVATE'), false);
  assert.deepEqual(assertBindingMatchesModel({ binding, snapshot }), binding);
});

test('reproves the raw URL and its HMAC after the adapter proof before creating a binding', async () => {
  const snapshot = await snapshotFixture({ auditId: 'audit-highlight-recorder-url-toctou' });
  const initialUrl = 'https://servico.exemplo.test/consulta/inicio?token=INITIAL&view=public';
  const navigatedUrl = 'https://servico.exemplo.test/consulta/inicio?token=NAVIGATED&view=public';
  const navigatedDigest = `hmac-sha256:${'B'.repeat(43)}`;
  let urlReads = 0;
  let digestCalls = 0;
  let nowCalls = 0;
  const observedTarget = {
    version: 1, kind: 'attached', tabId: 17, windowId: 9,
    documentId: 'document-main', urlSessionDigest: DIGEST,
    urlEvidence: snapshot.model.pages[0].finalUrl,
  };

  const binding = await recordHighlightBindingV1({
    snapshot,
    observedTarget,
    chromeAdapter: {
      async getFinalUrl() {
        urlReads += 1;
        return urlReads === 1 ? initialUrl : navigatedUrl;
      },
      async proveHighlightTargets({ candidates }) {
        return [proofFor(candidates.find(value => value.occurrenceId === 'occ-focus-failed'))];
      },
    },
    digestManager: {
      async digest(url) {
        digestCalls += 1;
        return url === initialUrl ? DIGEST : navigatedDigest;
      },
    },
    now: () => { nowCalls += 1; return EPOCH; },
  });

  assert.equal(binding, null);
  assert.equal(urlReads, 2);
  assert.equal(digestCalls, 2);
  assert.equal(nowCalls, 0);

  urlReads = 0;
  digestCalls = 0;
  const collisionBinding = await recordHighlightBindingV1({
    snapshot,
    observedTarget,
    chromeAdapter: {
      async getFinalUrl() {
        urlReads += 1;
        return urlReads === 1 ? initialUrl : navigatedUrl;
      },
      async proveHighlightTargets({ candidates }) {
        return [proofFor(candidates.find(value => value.occurrenceId === 'occ-focus-failed'))];
      },
    },
    digestManager: {
      async digest() { digestCalls += 1; return DIGEST; },
    },
    now: () => { nowCalls += 1; return EPOCH; },
  });
  assert.equal(collisionBinding, null);
  assert.equal(urlReads, 2);
  assert.equal(digestCalls, 2);
  assert.equal(nowCalls, 0);
});

test('takes one canonical snapshot of each hostile proof before ambiguity and correlation checks', async () => {
  const snapshot = await snapshotFixture({ auditId: 'audit-highlight-recorder-proof-toctou' });
  const observedTarget = {
    version: 1, kind: 'attached', tabId: 17, windowId: 9,
    documentId: 'document-main', urlSessionDigest: DIGEST,
    urlEvidence: snapshot.model.pages[0].finalUrl,
  };
  let proofOwnKeyPasses = 0;

  const binding = await recordHighlightBindingV1({
    snapshot,
    observedTarget,
    chromeAdapter: {
      async getFinalUrl() { return 'https://servico.exemplo.test/consulta/inicio?view=public'; },
      async proveHighlightTargets({ candidates }) {
        const wanted = candidates.find(value => value.occurrenceId === 'occ-focus-failed');
        const proof = proofFor(wanted);
        return [new Proxy(proof, {
          ownKeys(targetValue) {
            proofOwnKeyPasses += 1;
            return Reflect.ownKeys(targetValue);
          },
          getOwnPropertyDescriptor(targetValue, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(targetValue, key);
            if (key !== 'occurrenceId' || !descriptor) return descriptor;
            return { ...descriptor, value: proofOwnKeyPasses === 1 ? 'occ-unknown' : wanted.occurrenceId };
          },
        })];
      },
    },
    digestManager: { async digest() { return DIGEST; } },
    now: () => EPOCH,
  });

  assert.equal(binding, null);
  assert.equal(proofOwnKeyPasses, 1);
});

test('indexes verified evidence at most once per recording operation', async () => {
  const snapshot = await snapshotFixture({ auditId: 'audit-highlight-recorder-linear-index' });
  const observedTarget = {
    version: 1, kind: 'attached', tabId: 17, windowId: 9,
    documentId: 'document-main', urlSessionDigest: DIGEST,
    urlEvidence: snapshot.model.pages[0].finalUrl,
  };
  const originalMap = Array.prototype.map;
  let evidenceMapPasses = 0;
  Array.prototype.map = function instrumentedMap(callback, thisArg) {
    if (this === snapshot.model.evidence) evidenceMapPasses += 1;
    return Reflect.apply(originalMap, this, [callback, thisArg]);
  };
  let binding;
  try {
    binding = await recordHighlightBindingV1({
      snapshot,
      observedTarget,
      chromeAdapter: {
        async getFinalUrl() { return 'https://servico.exemplo.test/consulta/inicio?view=public'; },
        async proveHighlightTargets({ candidates }) {
          return [proofFor(candidates.find(value => value.occurrenceId === 'occ-focus-failed'))];
        },
      },
      digestManager: { async digest() { return DIGEST; } },
      now: () => EPOCH,
    });
  } finally {
    Array.prototype.map = originalMap;
  }

  assert.ok(binding);
  assert.ok(evidenceMapPasses <= 1, `evidence foi reindexada ${evidenceMapPasses} vezes`);
});

test('fails closed before adapter work when the verified relation index exceeds its linear budget', async () => {
  const snapshot = await snapshotFixture({
    auditId: 'audit-highlight-recorder-linear-budget', extraEvidence: 5_001,
  });
  let adapterCalls = 0;
  const binding = await recordHighlightBindingV1({
    snapshot,
    observedTarget: {
      version: 1, kind: 'attached', tabId: 17, windowId: 9,
      documentId: 'document-main', urlSessionDigest: DIGEST,
      urlEvidence: snapshot.model.pages[0].finalUrl,
    },
    chromeAdapter: {
      async getFinalUrl() { adapterCalls += 1; return snapshot.model.pages[0].finalUrl; },
      async proveHighlightTargets() { adapterCalls += 1; return []; },
    },
    digestManager: { async digest() { throw new Error('não deve ser chamado'); } },
    now: () => EPOCH,
  });

  assert.equal(binding, null);
  assert.equal(adapterCalls, 0);
});

test('returns null for no proof, duplicate proof, changed URL digest or hostile proof data', async () => {
  const snapshot = await snapshotFixture({ auditId: 'audit-highlight-recorder-null' });
  const observedTarget = {
    version: 1, kind: 'attached', tabId: 17, windowId: 9,
    documentId: 'document-main', urlSessionDigest: DIGEST,
    urlEvidence: snapshot.model.pages[0].finalUrl,
  };
  const rawUrl = 'https://servico.exemplo.test/consulta/inicio?view=public';
  const base = {
    snapshot, observedTarget, digestManager: { async digest() { return DIGEST; } }, now: () => EPOCH,
  };
  const noProof = await recordHighlightBindingV1({
    ...base,
    chromeAdapter: { async getFinalUrl() { return rawUrl; }, async proveHighlightTargets() { return []; } },
  });
  assert.equal(noProof, null);

  const duplicate = await recordHighlightBindingV1({
    ...base,
    chromeAdapter: {
      async getFinalUrl() { return rawUrl; },
      async proveHighlightTargets({ candidates }) {
        const wanted = candidates.find(value => value.occurrenceId === 'occ-focus-failed');
        return [proofFor(wanted), { ...proofFor(wanted), backendNodeId: 999 }];
      },
    },
  });
  assert.equal(duplicate, null);

  let proveCalls = 0;
  const changed = await recordHighlightBindingV1({
    ...base,
    digestManager: { async digest() { return `hmac-sha256:${'B'.repeat(43)}`; } },
    chromeAdapter: {
      async getFinalUrl() { return rawUrl; },
      async proveHighlightTargets() { proveCalls += 1; return []; },
    },
  });
  assert.equal(changed, null);
  assert.equal(proveCalls, 0);

  let getterCalls = 0;
  const hostileProof = {};
  Object.defineProperty(hostileProof, 'occurrenceId', {
    enumerable: true,
    get() { getterCalls += 1; return 'occ-focus-failed'; },
  });
  const hostile = await recordHighlightBindingV1({
    ...base,
    chromeAdapter: {
      async getFinalUrl() { return rawUrl; },
      async proveHighlightTargets() { return [hostileProof]; },
    },
  });
  assert.equal(hostile, null);
  assert.equal(getterCalls, 0);

  let digestCoercions = 0;
  const hostileDigest = await recordHighlightBindingV1({
    ...base,
    digestManager: {
      async digest() {
        return { [Symbol.toPrimitive]() { digestCoercions += 1; return DIGEST; } };
      },
    },
    chromeAdapter: {
      async getFinalUrl() { return rawUrl; },
      async proveHighlightTargets() { throw new Error('must not be reached'); },
    },
  });
  assert.equal(hostileDigest, null);
  assert.equal(digestCoercions, 0);
});

function proofFor(candidate) {
  return {
    occurrenceId: candidate.occurrenceId,
    evidenceId: candidate.evidenceId,
    documentId: 'document-main',
    frameId: 0,
    backendNodeId: candidate.backendNodeId,
    selector: {
      syntax: candidate.selector.syntax,
      value: candidate.selector.value,
      byteLength: candidate.selector.byteLength,
      complexity: candidate.selector.complexity,
    },
    structuralSignature: { version: 'StructuralSignatureV1', sha256: 'b'.repeat(64) },
    rectBucket: null,
  };
}
