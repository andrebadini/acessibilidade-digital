import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';

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
