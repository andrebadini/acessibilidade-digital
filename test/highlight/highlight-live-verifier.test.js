import assert from 'node:assert/strict';
import test from 'node:test';

import { createHighlightBindingV1 } from '../../src/background/highlight-binding.js';
import { createHighlightLiveVerifier } from '../../src/background/highlight-live-verifier.js';

const NOW = 1_788_000_000_000;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;

function bindingFixture(overrides = {}) {
  const targets = Object.create(null);
  targets['occ-1'] = {
    documentId: 'document-child',
    frameId: 4,
    backendNodeId: 91,
    evidenceId: 'evidence-1',
    selector: {
      syntax: 'CSSSelectorV1',
      value: 'button#go',
      byteLength: 9,
      complexity: 2,
    },
    structuralSignature: {
      version: 'StructuralSignatureV1',
      sha256: 'b'.repeat(64),
    },
    rectBucket: { x: 0, y: 16, width: 96, height: 32 },
  };
  return createHighlightBindingV1({
    version: 1,
    auditId: 'audit-1',
    pageId: 'page-1',
    modelRevision: 2,
    modelHash: 'c'.repeat(64),
    tabId: 7,
    windowId: 3,
    topDocumentId: 'document-main',
    topUrlEvidence: 'https://example.test/path',
    topUrlSessionDigest: DIGEST,
    createdAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
    targets,
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const trace = [];
  const clock = { value: NOW };
  const tab = {
    id: 7,
    windowId: 3,
    discarded: false,
    url: 'https://example.test/path',
    ...overrides.tab,
  };
  const chromeApi = {
    tabs: {
      async get(tabId) {
        trace.push(['tabs.get', tabId]);
        if (overrides.tabsGetError) throw new Error('PRIVATE_TAB_ERROR');
        return structuredClone(tab);
      },
    },
  };
  const digestManager = {
    async digest(url) {
      trace.push(['digest', url]);
      if (overrides.digestError) throw new Error('PRIVATE_DIGEST_ERROR');
      return overrides.digest ?? (url === 'https://example.test/path'
        ? DIGEST
        : `hmac-sha256:${'B'.repeat(43)}`);
    },
  };
  const chromeAdapter = {
    async verifyHighlightTarget(input) {
      trace.push(['verify', structuredClone(input)]);
      if (overrides.onVerify) await overrides.onVerify(clock, tab);
      if (overrides.verifyError) throw new Error('PRIVATE_VERIFY_ERROR');
      return structuredClone(overrides.proof ?? {
        ok: true,
        topDocumentId: 'document-main',
        documentId: 'document-child',
        frameId: 4,
      });
    },
  };
  const verifier = createHighlightLiveVerifier({
    chromeApi,
    digestManager,
    chromeAdapter,
    now: () => clock.value,
  });
  return { verifier, trace, clock };
}

test('revalidates tab, complete URL digest and exact live target without returning raw evidence', async () => {
  const binding = bindingFixture();
  const { verifier, trace } = fixture();

  const result = await verifier.verify({ binding, target: binding.targets['occ-1'] });

  assert.deepEqual(result, {
    ok: true,
    tabId: 7,
    windowId: 3,
    documentId: 'document-child',
    frameId: 4,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(trace.map(entry => entry[0]), ['tabs.get', 'digest', 'verify', 'tabs.get', 'digest']);
  assert.deepEqual(trace[2][1], {
    tabId: 7,
    windowId: 3,
    topDocumentId: 'document-main',
    target: binding.targets['occ-1'],
  });
  assert.doesNotMatch(JSON.stringify(result), /https:|selector|backendNode|sha256/u);
});

test('fails closed before browser access for expired, malformed or unrelated targets', async () => {
  const binding = bindingFixture();
  const prototypeMismatch = Object.assign(
    Object.create(Array.prototype),
    structuredClone(binding.targets['occ-1']),
  );
  const cases = [
    { binding: bindingFixture({ expiresAt: NOW }), target: binding.targets['occ-1'], reason: 'expired' },
    {
      binding: bindingFixture({ createdAt: NOW + 1, expiresAt: NOW + 60_001 }),
      target: binding.targets['occ-1'],
      reason: 'live-proof-failed',
    },
    { binding, target: { ...binding.targets['occ-1'], frameId: 5 }, reason: 'invalid-input' },
    { binding, target: prototypeMismatch, reason: 'invalid-input' },
    { binding: { ...binding, extra: true }, target: binding.targets['occ-1'], reason: 'invalid-input' },
  ];
  for (const candidate of cases) {
    const { verifier, trace } = fixture();
    assert.deepEqual(await verifier.verify({ binding: candidate.binding, target: candidate.target }), {
      ok: false,
      reason: candidate.reason,
    });
    assert.deepEqual(trace, []);
  }
});

test('accepts a canonical physical target shared by more than one occurrence', async () => {
  const original = bindingFixture();
  const targets = Object.create(null);
  targets['occ-1'] = structuredClone(original.targets['occ-1']);
  targets['occ-2'] = structuredClone(original.targets['occ-1']);
  const binding = bindingFixture({ targets });
  const { verifier } = fixture();
  assert.equal((await verifier.verify({ binding, target: binding.targets['occ-2'] })).ok, true);
});

test('rejects missing, moved, discarded and non-web tabs before URL digest or live proof', async () => {
  const binding = bindingFixture();
  for (const [options, reason] of [
    [{ tabsGetError: true }, 'page-or-process'],
    [{ tab: { id: 8 } }, 'page-or-process'],
    [{ tab: { windowId: 4 } }, 'window-changed'],
    [{ tab: { discarded: true } }, 'page-or-process'],
    [{ tab: { url: 'chrome://settings/' } }, 'page-or-process'],
    [{ tab: { url: 'https://example.test/path', discarded: 'false' } }, 'page-or-process'],
  ]) {
    const { verifier, trace } = fixture(options);
    assert.deepEqual(await verifier.verify({ binding, target: binding.targets['occ-1'] }), { ok: false, reason });
    assert.equal(trace.filter(entry => entry[0] === 'verify').length, 0);
    assert.equal(trace.filter(entry => entry[0] === 'digest').length, 0);
  }
});

test('compares the HMAC and normalizes digest failures without exposing the URL', async () => {
  const binding = bindingFixture();
  for (const options of [{ digest: `hmac-sha256:${'B'.repeat(43)}` }, { digest: 'raw-url' }, { digestError: true }]) {
    const { verifier, trace } = fixture(options);
    const result = await verifier.verify({ binding, target: binding.targets['occ-1'] });
    assert.deepEqual(result, { ok: false, reason: 'url-changed' });
    assert.equal(trace.filter(entry => entry[0] === 'verify').length, 0);
    assert.doesNotMatch(JSON.stringify(result), /example\.test|PRIVATE_/u);
  }
});

test('accepts only an exact correlated adapter proof', async () => {
  const binding = bindingFixture();
  const cases = [
    [{ verifyError: true }, 'live-proof-failed'],
    [{ proof: { ok: false, reason: 'ambiguous' } }, 'ambiguous'],
    [{ proof: { ok: false, reason: 'private-secret' } }, 'live-proof-failed'],
    [{ proof: { ok: true, topDocumentId: 'reloaded', documentId: 'document-child', frameId: 4 } }, 'document-changed'],
    [{ proof: { ok: true, topDocumentId: 'document-main', documentId: 'other', frameId: 4 } }, 'live-proof-failed'],
    [{ proof: { ok: true, topDocumentId: 'document-main', documentId: 'document-child', frameId: 9 } }, 'live-proof-failed'],
    [{ proof: { ok: true, topDocumentId: 'document-main', documentId: 'document-child', frameId: 4, raw: true } }, 'live-proof-failed'],
  ];
  for (const [options, reason] of cases) {
    const { verifier } = fixture(options);
    assert.deepEqual(await verifier.verify({ binding, target: binding.targets['occ-1'] }), { ok: false, reason });
  }
});

test('rechecks expiry after asynchronous live proof', async () => {
  const binding = bindingFixture();
  const { verifier } = fixture({ onVerify(clock) { clock.value = binding.expiresAt; } });
  assert.deepEqual(await verifier.verify({ binding, target: binding.targets['occ-1'] }), {
    ok: false,
    reason: 'expired',
  });
});

test('rechecks tab window discard and complete URL HMAC after the asynchronous proof', async () => {
  const binding = bindingFixture();
  const moved = fixture({ onVerify(_clock, tab) { tab.windowId = 4; } });
  assert.deepEqual(await moved.verifier.verify({ binding, target: binding.targets['occ-1'] }), {
    ok: false,
    reason: 'window-changed',
  });
  assert.equal(moved.trace.filter(entry => entry[0] === 'tabs.get').length, 2);

  const navigated = fixture({ onVerify(_clock, tab) { tab.url = 'https://example.test/other'; } });
  assert.deepEqual(await navigated.verifier.verify({ binding, target: binding.targets['occ-1'] }), {
    ok: false,
    reason: 'url-changed',
  });
  assert.equal(navigated.trace.filter(entry => entry[0] === 'digest').length, 2);

  const discarded = fixture({ onVerify(_clock, tab) { tab.discarded = true; } });
  assert.deepEqual(await discarded.verifier.verify({ binding, target: binding.targets['occ-1'] }), {
    ok: false,
    reason: 'page-or-process',
  });
});

test('fails closed on invalid or regressing clocks without misclassifying trusted input', async () => {
  const binding = bindingFixture();
  const invalid = fixture();
  invalid.clock.value = Number.NaN;
  assert.deepEqual(await invalid.verifier.verify({ binding, target: binding.targets['occ-1'] }), {
    ok: false,
    reason: 'live-proof-failed',
  });

  const regressing = fixture();
  assert.equal((await regressing.verifier.verify({ binding, target: binding.targets['occ-1'] })).ok, true);
  regressing.clock.value = NOW - 1;
  assert.deepEqual(await regressing.verifier.verify({ binding, target: binding.targets['occ-1'] }), {
    ok: false,
    reason: 'live-proof-failed',
  });
});

test('requires an exact verifier dependency contract', () => {
  const valid = fixture().verifier;
  assert.equal(typeof valid.verify, 'function');
  for (const invalid of [
    null,
    {},
    { chromeApi: { tabs: { get() {} } }, digestManager: { digest() {} }, chromeAdapter: {}, now() { return NOW; } },
    { chromeApi: { tabs: { get() {} } }, digestManager: { digest() {} }, chromeAdapter: { verifyHighlightTarget() {} }, now: NOW },
  ]) assert.throws(() => createHighlightLiveVerifier(invalid), /HIGHLIGHT_LIVE_VERIFIER_INVALID/u);
});
