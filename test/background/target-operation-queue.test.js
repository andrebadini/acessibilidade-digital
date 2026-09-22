import assert from 'node:assert/strict';
import test from 'node:test';

import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';
import * as targetQueueModule from '../../src/background/target-operation-queue.js';
import { createFakeLockManager } from '../personas/fake-lock-manager.js';

const target = Object.freeze({
  tabId: 7,
  windowId: 3,
  documentId: 'document-main',
  urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
});
const otherTarget = Object.freeze({ ...target, documentId: 'document-other' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('lock token is exact to one target and one operation lifetime', async () => {
  const targetQueue = createTargetOperationQueue();
  let captured;
  await targetQueue.withTarget(target, lock => {
    captured = lock;
    assert.equal(Object.isFrozen(lock), true);
    assert.doesNotThrow(() => targetQueue.assertHeld(lock, target));
    assert.throws(() => targetQueue.assertHeld(lock, otherTarget), /lock inválido/iu);
  });
  assert.throws(() => targetQueue.assertHeld(captured, target), /lock inválido/iu);
  assert.throws(() => targetQueue.assertHeld(Object.freeze({}), target), /lock inválido/iu);
});

test('serializes operations for the same target and preserves their return values', async () => {
  const targetQueue = createTargetOperationQueue();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const order = [];

  const first = targetQueue.withTarget(target, async lock => {
    targetQueue.assertHeld(lock, target);
    order.push('first-enter');
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push('first-exit');
    return 'first-result';
  });
  await firstEntered.promise;
  const second = targetQueue.withTarget({ tabId: 7, documentId: 'document-main' }, lock => {
    targetQueue.assertHeld(lock, target);
    order.push('second');
    return 'second-result';
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first-enter']);
  releaseFirst.resolve();
  assert.equal(await first, 'first-result');
  assert.equal(await second, 'second-result');
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second']);
});

test('a rejected operation releases the target and does not poison its successor', async () => {
  const targetQueue = createTargetOperationQueue();
  let failedLock;
  const expected = new Error('operation failed');
  const first = targetQueue.withTarget(target, lock => {
    failedLock = lock;
    throw expected;
  });
  const second = targetQueue.withTarget(target, lock => {
    targetQueue.assertHeld(lock, target);
    return 42;
  });

  await assert.rejects(first, error => error === expected);
  assert.equal(await second, 42);
  assert.throws(() => targetQueue.assertHeld(failedLock, target), /lock inválido/iu);
});

test('allows independent targets to execute concurrently', async () => {
  const targetQueue = createTargetOperationQueue();
  const release = deferred();
  const entered = [];
  const left = targetQueue.withTarget(target, async () => {
    entered.push('left');
    await release.promise;
  });
  const right = targetQueue.withTarget(otherTarget, async () => {
    entered.push('right');
    await release.promise;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered.sort(), ['left', 'right']);
  release.resolve();
  await Promise.all([left, right]);
});

test('rejects invalid targets and operations without reading accessors', async () => {
  const targetQueue = createTargetOperationQueue();
  const invalidTargets = [
    null,
    {},
    { tabId: 0, documentId: 'document-main' },
    { tabId: 1.5, documentId: 'document-main' },
    { tabId: 7, documentId: '' },
    { tabId: 7, documentId: 'x'.repeat(513) },
    { tabId: 7, documentId: 'document\u0000forged' },
  ];
  for (const value of invalidTargets) {
    assert.throws(() => targetQueue.withTarget(value, () => {}), /alvo inválido/iu);
  }
  assert.throws(() => targetQueue.withTarget(target, null), /operação inválida/iu);

  let reads = 0;
  const hostile = { documentId: 'document-main' };
  Object.defineProperty(hostile, 'tabId', {
    enumerable: true,
    get() {
      reads += 1;
      return 7;
    },
  });
  assert.throws(() => targetQueue.withTarget(hostile, () => {}), /alvo inválido/iu);
  assert.equal(reads, 0);
});

test('two queue instances share one exclusion boundary until the first operation settles', async () => {
  const manager = createFakeLockManager();
  const left = createTargetOperationQueue({ lockManager: manager });
  const right = createTargetOperationQueue({ lockManager: manager });
  const entered = deferred(); const release = deferred(); const events = [];
  const first = left.withTarget(target, async lock => {
    left.assertHeld(lock, target); events.push('audit-start'); entered.resolve();
    await release.promise; events.push('audit-end');
  });
  await entered.promise;
  const second = right.withTarget(target, () => events.push('reader'));
  const independent = right.withTarget(otherTarget, () => events.push('other-document'));
  await new Promise(resolve => setImmediate(resolve));
  try { assert.deepEqual(events, ['audit-start', 'other-document']); }
  finally { release.resolve(); await Promise.all([first, second, independent]); }
  assert.deepEqual(events, ['audit-start', 'other-document', 'audit-end', 'reader']);
  assert.ok(manager.calls.every(call => call.options.mode === 'exclusive'));
});

test('exported lock names use the same validated target identity and external failures fail closed', async () => {
  assert.equal(typeof targetQueueModule.targetOperationLockName, 'function');
  const name = targetQueueModule.targetOperationLockName(target);
  assert.equal(name, targetQueueModule.targetOperationLockName({ tabId: 7, documentId: 'document-main' }));
  assert.notEqual(name, targetQueueModule.targetOperationLockName(otherTarget));
  assert.throws(() => targetQueueModule.targetOperationLockName({ tabId: 7, documentId: '' }));
  let invoked = false;
  const queue = createTargetOperationQueue({ lockManager: { async request() { throw new Error('locks unavailable'); } } });
  await assert.rejects(queue.withTarget(target, () => { invoked = true; }), /locks unavailable/u);
  assert.equal(invoked, false);
});

test('an external ifAvailable client observes the queue lock for the whole async operation', {
  skip: typeof globalThis.navigator?.locks?.request !== 'function',
}, async () => {
  const manager = navigator.locks;
  const queue = createTargetOperationQueue({ lockManager: manager });
  const entered = deferred(); const release = deferred();
  const operation = queue.withTarget(target, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const name = targetQueueModule.targetOperationLockName(target);
  try {
    assert.equal(await manager.request(name, { mode: 'exclusive', ifAvailable: true }, lock => lock === null), true);
  } finally { release.resolve(); await operation; }
  assert.equal(await manager.request(name, { mode: 'exclusive', ifAvailable: true }, lock => lock !== null), true);
});

test('a queued operation keeps the target identity validated at admission', async () => {
  const manager = createFakeLockManager();
  const queue = createTargetOperationQueue({ lockManager: manager });
  const entered = deferred(); const release = deferred();
  const first = queue.withTarget(target, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const mutable = { tabId: target.tabId, documentId: target.documentId };
  const queued = queue.withTarget(mutable, () => {});
  mutable.documentId = 'another-document';
  release.resolve(); await Promise.all([first, queued]);
  assert.equal(manager.calls[0].name, manager.calls[1].name);
});
