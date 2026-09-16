import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelPageMarkersSession } from '../../src/panel/page-markers-session.js';

const bundle = (auditId = 'audit-1', modelRevision = 1) => ({ auditId, modelRevision,
  details: ['one', 'two', 'three'].map(occurrenceId => ({ occurrenceId })) });
const active = (selectedOrdinal = null) => ({ ok: true, markers: {
  state: 'active', modelRevision: 1, groups: [{ number: 4, ordinals: [0, 1] }],
  counts: { markers: 1, located: 2, general: 1, unlocated: 0, omitted: 2 }, selectedOrdinal,
} });
const cleared = () => ({ ok: true, markers: { state: 'clear', modelRevision: 1, groups: [],
  counts: { markers: 0, located: 0, general: 0, unlocated: 0, omitted: 0 }, selectedOrdinal: null } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const requests = [], changes = [], selections = [];
  const session = createPanelPageMarkersSession({
    requestIntent: intent => new Promise(resolve => requests.push({ intent, resolve })),
    onChange: value => changes.push(value), onSelection: value => selections.push(value),
  });
  session.setResult(bundle());
  return { session, requests, changes, selections };
}
async function shown(f) {
  const pending = f.session.show();
  await tick(); f.requests.at(-1).resolve(active()); await pending;
}

test('one explicit highlight prepares signals then scrolls to the correlated occurrence', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0, 'opening a result never touches the page');
  const pending = f.session.highlight('two');
  await tick(); f.requests[0].resolve(active()); await tick();
  assert.deepEqual(f.requests[1].intent, { type: 'PANEL_SELECT_PAGE_MARKER', modelRevision: 1, ordinal: 1, scroll: true });
  f.requests[1].resolve(active(1));
  assert.equal(await pending, true);
  assert.equal(f.session.read().selectedOccurrenceId, 'two');
});

test('direct highlight never selects after reset, failed show, or an unlocated/general target', async () => {
  for (const mode of ['reset', 'failed', 'general']) {
    const f = fixture();
    const pending = f.session.highlight(mode === 'general' ? 'three' : 'one');
    await tick();
    if (mode === 'reset') f.session.reset();
    f.requests[0].resolve(mode === 'failed' ? { ok: false } : active());
    assert.equal(await pending, false);
    assert.equal(f.requests.length, 1);
    if (mode === 'general') assert.match(f.session.read().message, /não foi localizado/u);
  }
});

test('show validates counts and projects numbered groups without transport authority', async () => {
  const f = fixture();
  await shown(f);
  assert.deepEqual(f.requests[0].intent, { type: 'PANEL_SHOW_PAGE_MARKERS', modelRevision: 1 });
  const state = f.session.read();
  assert.equal(state.status, 'active');
  assert.deepEqual(state.groups, [{ number: 4, occurrenceIds: ['one', 'two'] }]);
  assert.deepEqual(state.counts, active().markers.counts);
  assert.ok(Object.isFrozen(state.groups[0].occurrenceIds));
  assert.doesNotMatch(JSON.stringify(state), /auditId|modelRevision|ordinal|session|documentId/u);
});

test('malformed groups, partition, extras and arbitrary errors cannot become visible results', async () => {
  for (const change of [
    r => { r.markers.groups[0].ordinals = [0, 0]; },
    r => { r.markers.counts.located = 3; },
    r => { r.markers.modelRevision = 2; },
    r => { r.markers.groups[0].ordinals = [0, 63]; },
    r => { r.markers.installationId = 'PRIVATE_TEXT'; },
  ]) {
    const f = fixture(), pending = f.session.show(); await tick();
    const response = active(); change(response); f.requests[0].resolve(response); await pending;
    assert.equal(f.session.read().status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(f.session.read()), /PRIVATE_TEXT/u);
  }
});

test('clear packet wins a pending SHOW and no late active state is published', async () => {
  const f = fixture(), pending = f.session.show(); await tick();
  f.session.receive({ modelRevision: 1, state: 'clear', selectedOrdinal: null });
  const checkpoint = f.changes.length;
  f.requests[0].resolve(active()); await pending;
  assert.equal(f.session.read().status, 'idle');
  assert.ok(f.changes.slice(checkpoint).every(s => s.status !== 'active'));
});

test('a page click during SHOW survives an older null selection without a feedback loop', async () => {
  const f = fixture(), pending = f.session.show(); await tick();
  f.session.receive({ modelRevision: 1, state: 'active', selectedOrdinal: 1 });
  f.requests[0].resolve(active()); await pending;
  assert.equal(f.session.read().selectedOccurrenceId, 'two');
  assert.deepEqual(f.selections, ['two']);
  assert.equal(f.requests.length, 1);
});

test('filters are ordered offered ordinals, serialized and preserve total counts', async () => {
  const f = fixture(); await shown(f);
  const a = f.session.filter(['two', 'two', 'foreign']); await tick();
  const b = f.session.filter(['one']);
  assert.deepEqual(f.requests.at(-1).intent, { type: 'PANEL_FILTER_PAGE_MARKERS', modelRevision: 1, visibleOrdinals: '1' });
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(active()); await a; await tick();
  assert.equal(f.requests[2].intent.visibleOrdinals, '0');
  f.requests[2].resolve(active()); await b;
  assert.deepEqual(f.session.read().counts, active().markers.counts);
});

test('panel selection never scrolls unless explicitly requested and response is not a page click', async () => {
  const f = fixture(); await shown(f);
  for (const scroll of [false, true]) {
    const pending = f.session.select('two', scroll); await tick();
    assert.deepEqual(f.requests.at(-1).intent, { type: 'PANEL_SELECT_PAGE_MARKER', modelRevision: 1, ordinal: 1, scroll });
    f.requests.at(-1).resolve(active(1)); await pending;
  }
  assert.deepEqual(f.selections, []);
  assert.equal(await f.session.select('foreign', true), false);
  assert.equal(f.requests.length, 3);
});

test('a later click is not erased by an in-flight filter response', async () => {
  const f = fixture(); await shown(f);
  const pending = f.session.filter(['one', 'two']); await tick();
  f.session.receive({ modelRevision: 1, state: 'active', selectedOrdinal: 1 });
  f.requests.at(-1).resolve(active()); await pending;
  assert.equal(f.session.read().selectedOccurrenceId, 'two');
});

test('a publication acknowledging panel selection is not treated as another page click', async () => {
  const f = fixture(); await shown(f);
  const pending = f.session.select('two'); await tick();
  f.session.receive({ modelRevision: 1, state: 'active', selectedOrdinal: 1 });
  assert.deepEqual(f.selections, []);
  f.requests.at(-1).resolve(active(1)); await pending;
  assert.equal(f.session.read().selectedOccurrenceId, 'two');
});

test('queued filters coalesce and an older result cannot delay commands in a new result', async () => {
  const f = fixture(); await shown(f);
  const first = f.session.filter(['one']); await tick();
  const skipped = f.session.filter(['two']);
  const final = f.session.filter([]);
  f.requests.at(-1).resolve(active()); await first; await tick();
  assert.equal(f.requests.at(-1).intent.visibleOrdinals, '');
  f.requests.at(-1).resolve(active()); await final;
  assert.equal(await skipped, false);
  const hanging = f.session.select('one'); await tick();
  f.session.setResult(bundle('audit-new', 2));
  const nextShow = f.session.show(); await tick();
  const next = active(); next.markers.modelRevision = 2;
  f.requests.at(-1).resolve(next); await nextShow;
  const nextSelect = f.session.select('two'); await tick();
  assert.equal(f.requests.at(-1).intent.type, 'PANEL_SELECT_PAGE_MARKER');
  assert.equal(f.requests.at(-1).intent.modelRevision, 2);
  f.requests.at(-1).resolve({ ...next, markers: { ...next.markers, selectedOrdinal: 1 } }); await nextSelect;
  f.requests.find(r => r.intent.type === 'PANEL_SELECT_PAGE_MARKER' && r.intent.modelRevision === 1).resolve(active(0));
  await hanging;
  assert.equal(f.session.read().selectedOccurrenceId, 'two');
});

test('hide, reset and result revision retire older operations and packets', async () => {
  for (const action of ['hide', 'reset', 'revision']) {
    const f = fixture(), pending = f.session.show(); await tick();
    let hide;
    if (action === 'hide') { hide = f.session.hide(); await tick(); }
    else if (action === 'reset') f.session.reset();
    else f.session.setResult(bundle('audit-2', 2));
    f.requests[0].resolve(active()); await pending;
    if (hide) { f.requests[1].resolve(cleared()); await hide; }
    f.session.receive({ modelRevision: 1, state: 'active', selectedOrdinal: 1 });
    assert.equal(f.session.read().status, 'idle');
    assert.equal(f.session.read().selectedOccurrenceId, null);
  }
});

test('same delivered result keeps current marks and failed hide remains retryable', async () => {
  const f = fixture(); await shown(f);
  f.session.setResult(bundle());
  assert.equal(f.session.read().status, 'active');
  const pending = f.session.hide(); await tick();
  f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_CLEANUP_UNCONFIRMED' });
  assert.equal(await pending, false);
  assert.equal(f.session.read().status, 'active');
  assert.match(f.session.read().message, /remover/u);
});

test('the unavailable notice does not promise a recovery that cannot work', async () => {
  const f = fixture(), pending = f.session.show(); await tick();
  f.requests[0].resolve({ ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' }); await pending;
  const state = f.session.read();
  assert.equal(state.status, 'unavailable');
  // The source page has no live extension surface, so repeating the audit cannot create one.
  // A person reading this notice must not be told to redo the audit.
  assert.doesNotMatch(state.message, /refaça a auditoria|tente novamente|repita/iu);
  assert.match(state.message, /relatório/u);
  assert.match(state.message, /sinais/u);
});
