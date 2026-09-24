import assert from 'node:assert/strict';
import test from 'node:test';
import { WALK_PAUSE_AFTER_SPEECH_MS, WALK_STEP_MS, createTabWalk, tabWalkEntries } from '../../src/reader/tab-walk.js';

const entry = (id, tabOrder, category = 'tab') => ({ id, tabOrder, category, preview: `Item ${id}`, name: id, tag: 'button', role: 'button' });
const entries = [entry('c', 3), entry('a', 1), entry('r', null, 'reading'), entry('b', 2)];
const immediate = () => {
  const waits = [];
  return { waits, setTimer: (callback, ms) => { waits.push(ms); queueMicrotask(callback); return 1; }, clearTimer: () => {} };
};

test('only Tab stops, in order', () => {
  assert.deepEqual(tabWalkEntries(entries).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(tabWalkEntries(null), []);
});

test('silent walk highlights every stop with the longer pause and never speaks aloud', async () => {
  const timers = immediate();
  const highlighted = []; const steps = []; let outcome = null;
  const walk = createTabWalk({ entries, highlight: async item => { highlighted.push(item.id); }, speak: async () => false,
    onStep: (item, index, total) => steps.push(`${index + 1}/${total}`), onEnd: value => { outcome = value; }, ...timers });
  assert.equal(await walk.start(), 'done');
  assert.deepEqual(highlighted, ['a', 'b', 'c']);
  assert.deepEqual(steps, ['1/3', '2/3', '3/3']);
  assert.deepEqual(timers.waits, [WALK_STEP_MS, WALK_STEP_MS, WALK_STEP_MS]);
  assert.equal(outcome, 'done');
});

test('with audio each stop is spoken and followed by a short pause', async () => {
  const timers = immediate(); const spoken = [];
  const walk = createTabWalk({ entries, highlight: async () => {}, speak: async value => { spoken.push(value); return true; }, ...timers });
  await walk.start();
  assert.deepEqual(spoken, ['Tab 1. Item a', 'Tab 2. Item b', 'Tab 3. Item c']);
  assert.deepEqual(timers.waits, [WALK_PAUSE_AFTER_SPEECH_MS, WALK_PAUSE_AFTER_SPEECH_MS, WALK_PAUSE_AFTER_SPEECH_MS]);
});

test('stop interrupts the pause, cancels speech and prevents further highlights', async () => {
  const highlighted = []; let cancelled = 0; let pending = null;
  const walk = createTabWalk({ entries, highlight: async item => { highlighted.push(item.id); }, speak: async () => false,
    cancelSpeech: () => { cancelled += 1; }, setTimer: callback => { pending = callback; return 1; }, clearTimer: () => { pending = null; } });
  const done = walk.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(walk.running(), true);
  assert.equal(await walk.stop(), 'stopped');
  assert.equal(await done, 'stopped');
  assert.deepEqual(highlighted, ['a']);
  assert.equal(cancelled, 1);
  assert.equal(pending, null);
  assert.equal(walk.running(), false);
});

test('Escape on the page, page changes and failures end the walk with their own outcome', async () => {
  for (const [code, expected] of [['WALK_ESCAPED', 'escape'], ['PAGE_CHANGED', 'page-changed'], ['OTHER', 'error']]) {
    let calls = 0; let ended = null;
    const walk = createTabWalk({ entries, speak: async () => false, ...immediate(), onEnd: value => { ended = value; },
      highlight: async () => { calls += 1; if (calls === 2) throw Object.assign(new Error(code), { code }); } });
    assert.equal(await walk.start(), expected);
    assert.equal(ended, expected);
    assert.equal(calls, 2);
  }
});

test('an inspection without Tab stops ends immediately', async () => {
  const walk = createTabWalk({ entries: [entry('r', null, 'reading')], highlight: async () => assert.fail(), speak: async () => false });
  assert.equal(walk.total, 0);
  assert.equal(await walk.start(), 'empty');
});
