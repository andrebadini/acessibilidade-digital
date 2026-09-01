import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNativePixelCommitClockV1,
  createScriptedPixelCommitClockV1,
  isPixelCommitClockV1,
  readPixelCommitEpochV1,
} from '../../src/background/pixel-commit-clock.js';

test('scripted pixel commit clock copies a closed integer sequence and enforces cross-read monotonicity', () => {
  const epochs = [10, 10, 11];
  const clock = createScriptedPixelCommitClockV1({ epochs });
  epochs[0] = 999;

  assert.equal(isPixelCommitClockV1(clock), true);
  assert.equal(readPixelCommitEpochV1(clock), 10);
  assert.equal(readPixelCommitEpochV1(clock), 10);
  assert.equal(readPixelCommitEpochV1(clock), 11);
  assert.throws(() => readPixelCommitEpochV1(clock), /PIXEL_COMMIT_CLOCK_DENIED/u);
  assert.equal(Object.isFrozen(clock), true);
});

test('scripted pixel commit clock fails closed on a cross-read rollback', () => {
  const clock = createScriptedPixelCommitClockV1({ epochs: [20, 19] });
  assert.equal(readPixelCommitEpochV1(clock), 20);
  assert.throws(() => readPixelCommitEpochV1(clock), /PIXEL_COMMIT_CLOCK_DENIED/u);
  assert.throws(() => readPixelCommitEpochV1(clock), /PIXEL_COMMIT_CLOCK_DENIED/u);
});

test('clock factories and reads reject accessors, symbols, extras, proxies, copies and lookalikes', () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'epochs', {
    enumerable: true,
    get() { getterCalls += 1; return [1]; },
  });
  for (const input of [
    accessor,
    { epochs: [1], extra: true },
    { epochs: [1], [Symbol('private')]: true },
    { epochs: Object.assign([1], { extra: true }) },
    { epochs: [1, Number.NaN] },
    new Proxy({ epochs: [1] }, { ownKeys() { throw new Error('PRIVATE_CLOCK_PROXY'); } }),
  ]) assert.throws(() => createScriptedPixelCommitClockV1(input), /PIXEL_COMMIT_CLOCK_DENIED/u);
  assert.equal(getterCalls, 0);

  const clock = createScriptedPixelCommitClockV1({ epochs: [1] });
  for (const candidate of [
    {},
    { ...clock },
    new Proxy(clock, {}),
    Object.freeze(Object.create(null)),
  ]) {
    assert.equal(isPixelCommitClockV1(candidate), false);
    assert.throws(() => readPixelCommitEpochV1(candidate), /PIXEL_COMMIT_CLOCK_DENIED/u);
  }
});

test('native pixel commit clock is zero-argument, branded and independent of later Date.now replacement', () => {
  assert.throws(() => createNativePixelCommitClockV1({ extra: true }), /PIXEL_COMMIT_CLOCK_DENIED/u);
  const clock = createNativePixelCommitClockV1();
  const original = Date.now;
  Date.now = () => { throw new Error('PRIVATE_REPLACED_DATE_NOW'); };
  try {
    const epoch = readPixelCommitEpochV1(clock);
    assert.equal(Number.isSafeInteger(epoch) && epoch >= 0, true);
  } finally {
    Date.now = original;
  }
});
