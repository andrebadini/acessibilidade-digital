import assert from 'node:assert/strict';
import test from 'node:test';

import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';

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
