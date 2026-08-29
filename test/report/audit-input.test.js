import assert from 'node:assert/strict';
import test from 'node:test';

import { captureAuditInput } from '../../src/core/report/audit-input.js';

test('materializes only the captured descriptor snapshot after a nested proxy mutates an earlier sibling', () => {
  const marker = 'PRIVATE_LATE_AUDIT_INPUT_VALUE';
  let getterReads = 0;
  let reflectiveTrapCalls = 0;
  const earlierSibling = { safe: 'captured-before-proxy' };
  const proxyTarget = {};
  const mutatingProxy = new Proxy(proxyTarget, {
    getPrototypeOf() {
      reflectiveTrapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      reflectiveTrapCalls += 1;
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
      reflectiveTrapCalls += 1;
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
  earlierSibling.safe = 'changed-after-capture';
  proxyTarget.lateValue = marker;
  assert.equal(getterReads, 0);
  assert.ok(reflectiveTrapCalls > 0, 'a captura local pode acionar traps reflexivos de Proxy');
  assert.ifError(captureError);
  assert.deepEqual(captured, {
    earlierSibling: { safe: 'captured-before-proxy' },
    mutatingProxy: {},
  });
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(marker));
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.earlierSibling), true);
});

test('a transparent local Proxy may define its one captured snapshot but cannot mutate it afterwards', () => {
  const laterSibling = { state: 'before-reflection' };
  const proxy = new Proxy({}, {
    getPrototypeOf: () => Object.prototype,
    ownKeys() {
      laterSibling.state = 'during-reflection';
      return [];
    },
    getOwnPropertyDescriptor: () => undefined,
  });

  const captured = captureAuditInput({ proxy, laterSibling });
  assert.deepEqual(captured, {
    proxy: {},
    laterSibling: { state: 'during-reflection' },
  });

  laterSibling.state = 'after-capture';
  assert.equal(captured.laterSibling.state, 'during-reflection');
  assert.equal(Object.isFrozen(captured.laterSibling), true);
});

test('the production structured-clone transport rejects a nested Proxy before running its reflection traps', () => {
  const marker = 'PRIVATE_PROXY_TRANSPORT_MARKER';
  const transportPayload = { limitations: [], pages: [] };
  let reflectiveTrapCalls = 0;
  transportPayload.pages = new Proxy(transportPayload.pages, {
    getPrototypeOf(target) {
      reflectiveTrapCalls += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      reflectiveTrapCalls += 1;
      transportPayload.limitations.push(marker);
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      reflectiveTrapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  assert.throws(
    () => structuredClone(transportPayload),
    error => error?.name === 'DataCloneError',
  );
  assert.equal(reflectiveTrapCalls, 0);
  assert.deepEqual(transportPayload.limitations, []);
});
