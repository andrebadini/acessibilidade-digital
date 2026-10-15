import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelPageMarkersSession } from '../../src/panel/page-markers-session.js';

const bundle = (auditId = 'audit-1', modelRevision = 1) => ({ auditId, modelRevision,
  details: ['one', 'two', 'three'].map(occurrenceId => ({ occurrenceId })) });
const active = (selectedOrdinal = null) => ({ ok: true, markers: {
  state: 'active', modelRevision: 1, groups: [{ number: 4, ordinals: [0, 1] }],
  counts: { markers: 1, located: 2, general: 1, unlocated: 0, omitted: 2 }, selectedOrdinal, reasons: [],
} });
const cleared = () => ({ ok: true, markers: { state: 'clear', modelRevision: 1, groups: [],
  counts: { markers: 0, located: 0, general: 0, unlocated: 0, omitted: 0 }, selectedOrdinal: null, reasons: [] } });
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
    r => { r.markers.groups[0].ordinals = [0, 500]; },
    r => { r.markers.reasons = [{ reason: 'not-rendered', count: 0 }]; },
    r => { r.markers.reasons = [{ reason: 'Not Rendered', count: 1 }]; },
    r => { r.markers.reasons = [{ reason: 'unsupported-context', count: 1, installationId: 'PRIVATE_TEXT' }]; },
    r => { r.markers.installationId = 'PRIVATE_TEXT'; },
  ]) {
    const f = fixture(), pending = f.session.show(); await tick();
    const response = active(); change(response); f.requests[0].resolve(response); await pending;
    assert.equal(f.session.read().status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(f.session.read()), /PRIVATE_TEXT/u);
  }
});

test('reasons reach the panel as bounded categories ready for plain language', async () => {
  const f = fixture(), pending = f.session.show(); await tick();
  const response = active();
  response.markers.reasons = [{ reason: 'unsupported-context', count: 3 }, { reason: 'not-rendered', count: 1 }];
  f.requests[0].resolve(response); await pending;
  const state = f.session.read();
  assert.deepEqual(state.reasons, [{ reason: 'unsupported-context', count: 3 }, { reason: 'not-rendered', count: 1 }]);
  assert.ok(Object.isFrozen(state.reasons));
  assert.deepEqual(f.changes.at(-1).reasons, state.reasons);
});

test('the signal ceiling is 500 for groups, filters and the offered result', async () => {
  const details = Array.from({ length: 501 }, (_, index) => ({ occurrenceId: `occ-${index}` }));
  const full = Array.from({ length: 500 }, (_, index) => index);
  const inflated = ordinals => {
    const response = active();
    response.markers.groups = [{ number: 1, ordinals }];
    response.markers.counts = { markers: 1, located: ordinals.length, general: 0, unlocated: 0,
      omitted: 501 - ordinals.length };
    return response;
  };
  // 500 signals is the documented ceiling, and the panel keeps every one of them.
  const f = fixture();
  f.session.setResult({ auditId: 'audit-1', modelRevision: 1, details });
  const shown = f.session.show(); await tick();
  f.requests[0].resolve(inflated(full)); assert.equal(await shown, true);
  assert.equal(f.session.read().groups[0].occurrenceIds.length, 500);
  const filtered = f.session.filter(details.slice(0, 500).map(detail => detail.occurrenceId)); await tick();
  assert.equal(f.requests[1].intent.visibleOrdinals.split(',').length, 500);
  f.requests[1].resolve(inflated(full)); assert.equal(await filtered, true);
  // Beyond the ceiling the whole answer is refused, never partially trusted.
  const over = fixture();
  over.session.setResult({ auditId: 'audit-1', modelRevision: 1, details });
  const pending = over.session.show(); await tick();
  over.requests[0].resolve(inflated([...full, 500])); await pending;
  assert.equal(over.session.read().status, 'unavailable');
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

test('picking an occurrence without a signal on the page explains it instead of reporting a failure', async () => {
  const f = fixture();
  await shown(f);
  const pending = f.session.select('three'); await tick();
  f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_SELECTION_UNAVAILABLE' });
  assert.equal(await pending, false);
  const state = f.session.read();
  assert.equal(state.status, 'active');
  assert.equal(state.selectedOccurrenceId, null);
  assert.match(state.message, /não tem sinal na página neste momento/u);
  assert.doesNotMatch(state.message, /Não foi possível/u);

  const failing = f.session.select('two'); await tick();
  f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.equal(await failing, false);
  assert.match(f.session.read().message, /Não foi possível atualizar este sinal/u);
});

// --- Página recarregada (1.1.60): o convite, o aceite e o endereço que mudou ------------------

test('a reloaded page offers the signals instead of the unavailable message', async () => {
  const f = fixture();
  const pending = f.session.show();
  await tick();
  assert.deepEqual(f.requests[0].intent, { type: 'PANEL_SHOW_PAGE_MARKERS', modelRevision: 1 });
  f.requests[0].resolve({ ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.equal(await pending, false);
  const state = f.session.read();
  assert.equal(state.status, 'reload-offer');
  assert.match(state.message, /foi recarregada depois da auditoria/u);
  assert.match(state.message, /Mostrar os sinais na versão atual\?/u);
  assert.deepEqual(state.groups, []);
  assert.equal(state.relocated, false);
  assert.equal(await f.session.hide(), true, 'nada foi desenhado, então não há o que remover');
});

test('accepting the invitation asks for the reloaded variant and marks the relocated signals', async () => {
  const f = fixture();
  const refused = f.session.show();
  await tick(); f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' }); await refused;
  const pending = f.session.showReloaded();
  await tick();
  assert.deepEqual(f.requests.at(-1).intent, { type: 'PANEL_SHOW_PAGE_MARKERS_RELOADED', modelRevision: 1 });
  f.requests.at(-1).resolve(active(1)); await pending;
  const state = f.session.read();
  assert.equal(state.status, 'active');
  assert.equal(state.relocated, true);
  assert.deepEqual(state.groups, [{ number: 4, occurrenceIds: ['one', 'two'] }]);
  assert.equal(state.selectedOccurrenceId, 'two');
});

test('the relocation flag survives filters and selection but never a collapse', async () => {
  const f = fixture();
  const offered = f.session.show();
  await tick(); f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' }); await offered;
  const pending = f.session.showReloaded();
  await tick(); f.requests.at(-1).resolve(active()); await pending;
  assert.equal(f.session.read().relocated, true);
  const selecting = f.session.select('two', false);
  await tick(); f.requests.at(-1).resolve(active(1)); await selecting;
  assert.equal(f.session.read().relocated, true);
  f.session.receive({ modelRevision: 1, state: 'clear', selectedOrdinal: null });
  assert.deepEqual(f.session.read(), {
    status: 'idle', groups: [], counts: null, selectedOccurrenceId: null, reasons: [], message: null, relocated: false,
  });
});

test('another address asks for a new audit instead of relocating anything', async () => {
  for (const code of ['PAGE_MARKERS_DOCUMENT_CHANGED', 'PAGE_MARKERS_UNAVAILABLE']) {
    const f = fixture();
    const pending = f.session.showReloaded();
    await tick(); f.requests[0].resolve({ ok: false, code }); assert.equal(await pending, false);
    const state = f.session.read();
    if (code === 'PAGE_MARKERS_DOCUMENT_CHANGED') {
      assert.equal(state.status, 'changed-address');
      assert.match(state.message, /endereço da página mudou/u);
      assert.match(state.message, /refaça a auditoria/u);
    } else {
      assert.equal(state.status, 'unavailable');
    }
    assert.equal(f.requests[0].intent.type, 'PANEL_SHOW_PAGE_MARKERS_RELOADED');
  }
});

test('the offer is never accepted without the explicit request and never outlives a reset', async () => {
  const f = fixture();
  const first = f.session.show();
  await tick(); f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' }); await first;
  // O botão da página (destacar elemento) aceita o convite que já está na tela.
  const direct = f.session.highlight('one');
  await tick();
  assert.equal(f.requests.at(-1).intent.type, 'PANEL_SHOW_PAGE_MARKERS_RELOADED');
  f.requests.at(-1).resolve(active()); await tick();
  assert.equal(f.requests.at(-1).intent.type, 'PANEL_SELECT_PAGE_MARKER');
  f.requests.at(-1).resolve(active(1));
  assert.equal(await direct, true);
  assert.equal(f.session.read().relocated, true);

  const other = fixture();
  const refused = other.session.show();
  await tick(); other.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' }); await refused;
  other.session.reset();
  const again = other.session.show();
  await tick();
  assert.equal(other.requests.at(-1).intent.type, 'PANEL_SHOW_PAGE_MARKERS',
    'o convite não sobrevive ao reset: a próxima tentativa volta ao pedido de sempre');
  other.requests.at(-1).resolve(active()); await again;
});

test('a second reload while accepting only offers again, never draws the older version', async () => {
  const f = fixture();
  const pending = f.session.showReloaded();
  await tick(); f.requests.at(-1).resolve({ ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.equal(await pending, false);
  assert.equal(f.session.read().status, 'reload-offer');
  const accepted = f.session.showReloaded();
  await tick(); f.requests.at(-1).resolve(active()); await accepted;
  assert.equal(f.session.read().relocated, true);
  // O sinal desenhado é um só: o inventário antigo nunca é reaproveitado como se fosse o novo.
  assert.equal(f.session.read().groups.length, 1);
});
