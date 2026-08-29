import assert from 'node:assert/strict';
import test from 'node:test';

import { captureAuditInput } from '../../src/core/report/audit-input.js';

test('materializes only the captured descriptor snapshot after a nested proxy mutates an earlier sibling', () => {
  const marker = 'PRIVATE_LATE_AUDIT_INPUT_VALUE';
  let getterReads = 0;
  const earlierSibling = { safe: 'captured-before-proxy' };
  const mutatingProxy = new Proxy({}, {
    getPrototypeOf() {
      return Object.prototype;
    },
    ownKeys() {
      Object.defineProperty(earlierSibling, 'lateValue', {
        configurable: true,
        enumerable: true,
        get() {
          getterReads += 1;
          return marker;
        },
      });
      return [];
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
  });

  let captured;
  let captureError;
  try {
    captured = captureAuditInput({ earlierSibling, mutatingProxy });
  } catch (error) {
    captureError = error;
  }
  assert.equal(getterReads, 0);
  assert.ifError(captureError);
  assert.deepEqual(captured, {
    earlierSibling: { safe: 'captured-before-proxy' },
    mutatingProxy: {},
  });
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(marker));
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.earlierSibling), true);
});
