import assert from 'node:assert/strict';
import test from 'node:test';

import * as capturePolicy from '../../src/core/privacy/capture-policy.js';

const { createCapturePolicyV1, isCapturePolicyV1 } = capturePolicy;

test('derives the exact frozen pixel capabilities for every privacy mode', () => {
  const cases = [
    ['full-evidence', true, true, true],
    ['element-only', false, true, false],
    ['no-pixels', false, false, false],
  ];
  for (const [mode, captureFullPage, captureElements, composeAnnouncementMap] of cases) {
    const policy = createCapturePolicyV1({ mode, includeQuery: false });
    assert.deepEqual(policy, {
      version: 'CapturePolicyV1', mode, includeQuery: false,
      captureFullPage, captureElements, composeAnnouncementMap,
    });
    assert.equal(Object.isFrozen(policy), true);
  }
});

test('rejects unknown modes and non-boolean query authority', () => {
  for (const input of [
    { mode: 'pixels-sometimes', includeQuery: false },
    { mode: 'no-pixels', includeQuery: 'false' },
    { mode: 'no-pixels', includeQuery: false, extra: true },
  ]) {
    assert.throws(() => createCapturePolicyV1(input), /CAPTURE_POLICY_INVALID/u);
  }
});

test('rejects hostile accessors and symbols without invoking them', () => {
  let getterCalls = 0;
  const input = { includeQuery: false };
  Object.defineProperty(input, 'mode', {
    enumerable: true,
    get() { getterCalls += 1; return 'no-pixels'; },
  });
  assert.throws(() => createCapturePolicyV1(input), /CAPTURE_POLICY_INVALID/u);
  const symbolInput = { mode: 'no-pixels', includeQuery: false };
  Object.defineProperty(symbolInput, Symbol('hidden'), { enumerable: true, value: true });
  assert.throws(() => createCapturePolicyV1(symbolInput), /CAPTURE_POLICY_INVALID/u);
  assert.equal(getterCalls, 0);
});

test('keeps createCapturePolicyV1 as the only capture-policy factory', () => {
  assert.equal(Object.hasOwn(capturePolicy, 'normalizeCapturePolicyV1'), false);
});

test('rejects inherited mode names in both policy creation and recognition', () => {
  for (const mode of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => createCapturePolicyV1({ mode, includeQuery: false }), /CAPTURE_POLICY_INVALID/u);
    assert.equal(isCapturePolicyV1({
      version: 'CapturePolicyV1', mode, includeQuery: false,
      captureFullPage: undefined, captureElements: undefined, composeAnnouncementMap: undefined,
    }), false);
  }
});
