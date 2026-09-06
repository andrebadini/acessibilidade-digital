import assert from 'node:assert/strict';
import test from 'node:test';

import { runAuditaPageMarkersCommand } from '../../src/browser/page-markers-overlay.js';
import { FixtureElement, clear, createPageMarkersFixture, filter, install, select } from './page-markers-fixture.js';

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);

function buttonForNumber(fixture, number) {
  return fixture.environment.markerButtons().find(button => button.textContent.includes(String(number)));
}

function assertClean(fixture) {
  assert.equal(fixture.environment.hosts().length, 0);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaPageMarkersOverlayV1'), false);
  assert.equal(fixture.environment.activeObserverCount(), 0);
  assert.deepEqual(fixture.environment.timerDelays(), []);
  assert.deepEqual(fixture.environment.listenerCounts(), {
    scroll: 0, resize: 0, keydown: 0, pagehide: 0, popstate: 0, hashchange: 0,
  });
}

test('installs multiple isolated markers, groups duplicate DOM targets, and leaves page state untouched', () => {
  const fixture = createPageMarkersFixture();
  let pageClicks = 0;
  fixture.first.addEventListener('click', () => { pageClicks += 1; });
  const beforeSelection = fixture.document.getSelection();
  const beforeAttributes = structuredClone(fixture.first.attributes);
  const command = install({ targets: [
    ...install().targets,
    { markerId: 'm3', number: 9, match: { tag: 'button', id: 'continue' }, signals: [
      { selectionId: 's4', classification: 'alert' },
    ] },
  ] });

  assert.deepEqual(runAuditaPageMarkersCommand(command, fixture.environment), {
    ok: true, locatedMarkerIds: ['m1', 'm2', 'm3'], unlocated: [],
  });
  assert.equal(fixture.environment.hosts().length, 1);
  assert.equal(fixture.environment.markerButtons().length, 2);
  assert.match(buttonForNumber(fixture, 1).getAttribute('aria-label'), /Sinal 1: falha registrada na auditoria, 3 ocorrências\. Abrir no painel\./u);
  assert.equal(buttonForNumber(fixture, 1).textContent, '1×3');
  assert.equal(buttonForNumber(fixture, 2).textContent, '2✓1');
  assert.equal(fixture.document.activeElement, fixture.priorFocus);
  assert.strictEqual(fixture.document.getSelection(), beforeSelection);
  assert.deepEqual(fixture.first.attributes, beforeAttributes);
  assert.equal(fixture.first.scrollCalls.length, 0);
  assert.equal(fixture.first.focusCalls, 0);
  assert.equal(pageClicks, 0);
  const host = fixture.environment.hosts()[0];
  const exposed = [host.textContent, ...Object.values(host.attributes),
    ...host.shadowRoot.children.flatMap(group => [group.textContent, ...Object.values(group.attributes),
      ...group.children.flatMap(child => [child.textContent, ...Object.values(child.attributes)])])].join('|');
  for (const forbidden of [A, 'm1', 's1', 'continue', 'help', 'https:', 'sha256']) {
    assert.equal(exposed.includes(forbidden), false, forbidden);
  }

  const descriptor = Reflect.getOwnPropertyDescriptor(fixture.environment, '__auditaPageMarkersOverlayV1');
  assert.deepEqual({ enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable },
    { enumerable: false, configurable: true, writable: false });
  assert.equal(descriptor.value.version, 1);
  assert.equal(descriptor.value.installationId, A);
  assert.equal(typeof descriptor.value.dispose, 'function');
});

test('real buttons emit only the first visible signal and keyboard activation follows button semantics', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  const marker = buttonForNumber(fixture, 1);
  assert.equal(marker.tagName, 'BUTTON');
  assert.equal(marker.getAttribute('type'), 'button');

  marker.click();
  marker.activateByKeyboard('Enter');
  assert.deepEqual(fixture.environment.messages, [
    { type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: A, selectionId: 's1' },
    { type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: A, selectionId: 's1' },
  ]);
  assert.equal(fixture.first.clickCalls, 0);
});

test('filter recomputes visible priority, count, label and click destination without reordering signals', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 4, match: { tag: 'button', id: 'continue' }, signals: [
      { selectionId: 's1', classification: 'failed' },
      { selectionId: 's2', classification: 'manual-review' },
      { selectionId: 's3', classification: 'alert' },
      { selectionId: 's4', classification: 'passed' },
    ] },
  ] }), fixture.environment);

  assert.deepEqual(runAuditaPageMarkersCommand(filter(['s3', 's2']), fixture.environment), { ok: true });
  const marker = buttonForNumber(fixture, 4);
  assert.equal(marker.textContent, '4!2');
  assert.equal(marker.style.background, '#8a5a00');
  assert.match(marker.getAttribute('aria-label'), /alerta registrado na auditoria, 2 ocorrências/u);
  marker.click();
  assert.deepEqual(fixture.environment.messages.at(-1), {
    type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: A, selectionId: 's2',
  });

  assert.deepEqual(runAuditaPageMarkersCommand(select('s2'), fixture.environment), { ok: true });
  assert.equal(fixture.environment.markerGroups()[0].children[0].style.display, 'block');
  assert.deepEqual(runAuditaPageMarkersCommand(filter([], A), fixture.environment), { ok: true });
  assert.equal(marker.style.display, 'none');
  assert.deepEqual(runAuditaPageMarkersCommand(select('s2'), fixture.environment), {
    ok: false, reason: 'selection-unavailable',
  });
  assert.equal(fixture.environment.markerGroups()[0].children[0].style.display, 'none');
});

test('selection rings a visible target, and only explicit scroll moves it without focus or feedback messages', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);

  assert.deepEqual(runAuditaPageMarkersCommand(select('s2', false), fixture.environment), { ok: true });
  const group = fixture.environment.markerGroups()[0];
  assert.equal(group.children[0].style.display, 'block');
  assert.equal(fixture.first.scrollCalls.length, 0);
  assert.equal(fixture.document.activeElement, fixture.priorFocus);
  assert.deepEqual(fixture.environment.messages, []);

  assert.deepEqual(runAuditaPageMarkersCommand(select('s3', true), fixture.environment), { ok: true });
  assert.deepEqual(fixture.second.scrollCalls, [{ behavior: 'smooth', block: 'center', inline: 'nearest' }]);
  assert.equal(fixture.document.activeElement, fixture.priorFocus);
  assert.deepEqual(fixture.environment.messages, []);
});

test('isolates missing, ambiguous, non-rendered and unsupported targets while keeping offscreen targets', () => {
  const fixture = createPageMarkersFixture();
  const duplicate = new FixtureElement('button', { id: 'duplicate' }, fixture.document);
  const duplicate2 = new FixtureElement('button', { id: 'duplicate' }, fixture.document);
  const hidden = new FixtureElement('div', { id: 'hidden' }, fixture.document);
  const detached = new FixtureElement('p', { id: 'detached' }, fixture.document);
  const shadowHost = new FixtureElement('div', { id: 'shadow-host' }, fixture.document);
  const foreign = new FixtureElement('p', { id: 'foreign' }, fixture.document);
  const offscreen = new FixtureElement('section', { id: 'offscreen' }, fixture.document);
  hidden.style.visibility = 'hidden';
  offscreen.setRect({ left: -10_000, top: 80, width: 20, height: 20 });
  fixture.main.append(duplicate, duplicate2, hidden, shadowHost, offscreen);
  shadowHost.attachShadow({ mode: 'open' }).appendChild(foreign);
  fixture.document.queryOverrides.set('p#detached', [detached]);
  fixture.document.queryOverrides.set('p#foreign', [foreign]);

  const result = runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: { tag: 'aside', id: 'missing' }, signals: [{ selectionId: 's1', classification: 'failed' }] },
    { markerId: 'm2', number: 2, match: { tag: 'button', id: 'duplicate' }, signals: [{ selectionId: 's2', classification: 'alert' }] },
    { markerId: 'm3', number: 3, match: { tag: 'div', id: 'hidden' }, signals: [{ selectionId: 's3', classification: 'manual-review' }] },
    { markerId: 'm4', number: 4, match: { tag: 'p', id: 'detached' }, signals: [{ selectionId: 's4', classification: 'passed' }] },
    { markerId: 'm5', number: 5, match: { tag: 'p', id: 'foreign' }, signals: [{ selectionId: 's5', classification: 'passed' }] },
    { markerId: 'm6', number: 6, match: { tag: 'section', id: 'offscreen' }, signals: [{ selectionId: 's6', classification: 'passed' }] },
  ] }), fixture.environment);

  assert.deepEqual(result, { ok: true, locatedMarkerIds: ['m6'], unlocated: [
    { markerId: 'm1', reason: 'not-found' },
    { markerId: 'm2', reason: 'ambiguous' },
    { markerId: 'm3', reason: 'not-rendered' },
    { markerId: 'm4', reason: 'not-rendered' },
    { markerId: 'm5', reason: 'unsupported-context' },
  ] });
  assert.equal(fixture.environment.markerButtons().length, 1);
});

test('rejects closed-command violations and unavailable runtime before effects without invoking getters', () => {
  const fixture = createPageMarkersFixture();
  let getterReads = 0;
  const accessor = { version: 1, op: 'clear', installationId: A };
  Object.defineProperty(accessor, 'extra', { enumerable: true, get() { getterReads += 1; return true; } });
  const nestedAccessor = { version: 1, op: 'install', installationId: A, ttlMs: 1 };
  Object.defineProperty(nestedAccessor, 'targets', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('must not execute'); },
  });
  const sparseTargets = install();
  sparseTargets.targets = new Array(1);
  const duplicateSignals = install();
  duplicateSignals.targets[1].signals[0].selectionId = 's1';
  const invalids = [accessor, nestedAccessor, { ...clear(), extra: true }, sparseTargets, duplicateSignals,
    install({ ttlMs: 0 }), install({ installationId: 'short' }), filter(['s1', 's1']),
    select('s1', 'yes'), null];
  for (const command of invalids) {
    assert.deepEqual(runAuditaPageMarkersCommand(command, fixture.environment), {
      ok: false, reason: 'invalid-command',
    });
  }
  assert.equal(getterReads, 0);
  assert.equal(fixture.document.queryCounts.size, 0);
  assertClean(fixture);

  const unavailable = createPageMarkersFixture();
  delete unavailable.environment.chrome;
  assert.deepEqual(runAuditaPageMarkersCommand(install(), unavailable.environment), {
    ok: false, reason: 'runtime-unavailable',
  });
  assertClean(unavailable);
});

test('foreign, stale and divergent commands cannot replace or erase an active installation', () => {
  const fixture = createPageMarkersFixture();
  const original = install();
  const first = runAuditaPageMarkersCommand(original, fixture.environment);
  const host = fixture.environment.hosts()[0];

  for (const command of [select('s1', false, B), filter(['s1'], B), clear(B),
    install({ installationId: B }), install({ ttlMs: 60_001 })]) {
    assert.deepEqual(runAuditaPageMarkersCommand(command, fixture.environment), {
      ok: false, reason: 'installation-mismatch',
    });
    assert.strictEqual(fixture.environment.hosts()[0], host);
  }
  assert.deepEqual(runAuditaPageMarkersCommand(original, fixture.environment), first);
  assert.deepEqual(fixture.environment.timerDelays(), [60_000]);
  assert.equal(fixture.environment.timerRegistrationCount(), 1);

  const foreignFixture = createPageMarkersFixture();
  const foreign = Object.freeze({ version: 99, installationId: B, dispose() { throw new Error('must not call'); } });
  Object.defineProperty(foreignFixture.environment, '__auditaPageMarkersOverlayV1', {
    value: foreign, enumerable: false, configurable: true, writable: false,
  });
  assert.deepEqual(runAuditaPageMarkersCommand(install(), foreignFixture.environment), {
    ok: false, reason: 'installation-mismatch',
  });
  assert.strictEqual(foreignFixture.environment.__auditaPageMarkersOverlayV1, foreign);
  assert.equal(foreignFixture.environment.hosts().length, 0);
});

test('clear and owned dispose preserve foreign roots/listeners and a replacement slot', () => {
  const fixture = createPageMarkersFixture();
  const foreignListener = () => {};
  fixture.environment.addEventListener('scroll', foreignListener, true);
  const foreignRoot = new FixtureElement('div', {}, fixture.document);
  const foreignShadow = foreignRoot.attachShadow({ mode: 'open' });
  fixture.html.append(foreignRoot);
  runAuditaPageMarkersCommand(install(), fixture.environment);
  const ownedState = fixture.environment.__auditaPageMarkersOverlayV1;
  const replacement = Object.freeze({ foreign: true });
  Reflect.deleteProperty(fixture.environment, '__auditaPageMarkersOverlayV1');
  Object.defineProperty(fixture.environment, '__auditaPageMarkersOverlayV1', {
    value: replacement, enumerable: false, configurable: true, writable: false,
  });

  assert.doesNotThrow(() => ownedState.dispose(true));
  assert.doesNotThrow(() => ownedState.dispose(true));
  assert.strictEqual(fixture.environment.__auditaPageMarkersOverlayV1, replacement);
  assert.ok(fixture.html.children.includes(foreignRoot));
  assert.strictEqual(foreignRoot.shadowRoot, foreignShadow);
  assert.equal(fixture.environment.listenerCount('scroll'), 1);
  assert.deepEqual(fixture.environment.messages, [{
    type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: A,
  }]);
});

test('target mutation, navigation events, expiry and documentElement replacement invalidate once', () => {
  for (const [label, trigger] of [
    ['target-content', fixture => fixture.environment.triggerMutations([{ type: 'characterData', target: fixture.first }])],
    ['escape', fixture => fixture.environment.dispatch('keydown', { key: 'Escape' })],
    ['pagehide', fixture => fixture.environment.dispatch('pagehide')],
    ['popstate', fixture => fixture.environment.dispatch('popstate')],
    ['hashchange', fixture => fixture.environment.dispatch('hashchange')],
    ['expiry', fixture => fixture.environment.fireTimers()],
  ]) {
    const fixture = createPageMarkersFixture();
    runAuditaPageMarkersCommand(install(), fixture.environment);
    trigger(fixture);
    fixture.environment.flushFrames();
    trigger(fixture);
    fixture.environment.flushFrames();
    assertClean(fixture);
    assert.deepEqual(fixture.environment.messages, [{
      type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: A,
    }], label);
    assert.deepEqual(runAuditaPageMarkersCommand(select('s1'), fixture.environment), {
      ok: false, reason: 'installation-mismatch',
    }, label);
  }
});

test('document child-list replacement invalidates without relying on a later window event', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  const ownedHost = fixture.environment.hosts()[0];
  const replacement = new FixtureElement('html', {}, fixture.document);

  fixture.environment.replaceDocumentElement(replacement);
  fixture.environment.flushFrames();

  assertClean(fixture);
  assert.equal(fixture.html.children.includes(ownedHost), false);
  assert.equal(replacement.children.length, 0);
  assert.deepEqual(fixture.environment.messages, [{
    type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: A,
  }]);
});

test('mutation revalidates uniqueness and identity while scroll and resize refresh fixed geometry', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  const firstGroup = fixture.environment.markerGroups()[0];
  fixture.first.setRect({ left: 100, top: 120, width: 220, height: 44 });
  fixture.environment.dispatch('scroll');
  fixture.environment.dispatch('resize');
  assert.equal(firstGroup.children[1].style.left, '30px');
  fixture.environment.flushFrames();
  assert.equal(firstGroup.children[1].style.left, '100px');
  assert.equal(firstGroup.children[0].style.width, '220px');

  const duplicate = new FixtureElement('button', { id: 'continue' }, fixture.document);
  fixture.main.append(duplicate);
  fixture.environment.triggerMutations([{ type: 'childList', target: fixture.main }]);
  fixture.environment.flushFrames();
  assertClean(fixture);
  assert.deepEqual(fixture.environment.messages, [{
    type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: A,
  }]);
});

test('empty and fully unlocated installs retain a session without icons', () => {
  for (const targets of [[], [
    { markerId: 'm1', number: 1, match: { tag: 'aside', id: 'absent' }, signals: [{ selectionId: 's1', classification: 'failed' }] },
  ]]) {
    const fixture = createPageMarkersFixture();
    const result = runAuditaPageMarkersCommand(install({ targets }), fixture.environment);
    assert.equal(result.ok, true);
    assert.equal(fixture.environment.markerButtons().length, 0);
    assert.equal(fixture.environment.hosts().length, 1);
    assert.equal(fixture.environment.__auditaPageMarkersOverlayV1.installationId, A);
  }
});

test('explicit clear is exact, silent, and has no tombstone for stale commands', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  assert.deepEqual(runAuditaPageMarkersCommand(clear(), fixture.environment), { ok: true });
  assertClean(fixture);
  assert.deepEqual(fixture.environment.messages, []);
  assert.deepEqual(runAuditaPageMarkersCommand(clear(), fixture.environment), {
    ok: false, reason: 'installation-mismatch',
  });
});

test('remains synchronous and executable after Chrome-style function serialization', () => {
  const fixture = createPageMarkersFixture();
  const invoke = command => Function(`"use strict"; return (${runAuditaPageMarkersCommand.toString()});`)()
    (command, fixture.environment);
  const result = invoke(install());
  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, { ok: true, locatedMarkerIds: ['m1', 'm2'], unlocated: [] });
  assert.equal(fixture.environment.markerButtons().length, 2);
  assert.deepEqual(invoke(filter(['s2'])), { ok: true });
  assert.deepEqual(invoke(select('s2', false)), { ok: true });
  assert.deepEqual(invoke(clear()), { ok: true });
  assertClean(fixture);
});
