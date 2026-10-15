import assert from 'node:assert/strict';
import test from 'node:test';

import { runAuditaPageMarkersCommand } from '../../src/browser/page-markers-overlay.js';
import {
  FixtureElement, clear, createPageMarkersFixture, filter, idMatch, install, select, semanticMatch, structuralMatch,
} from './page-markers-fixture.js';

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);

function ringOf(group) { return group.children[0]; }
function labelOf(group) { return group.children[1]; }

function buttonForNumber(fixture, number) {
  return fixture.environment.markerButtons().find(button =>
    Number(/^([0-9]+)/u.exec(button.textContent)?.[1]) === number);
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

function singleTarget(match, overrides = {}) {
  return install({ targets: [{ markerId: 'm1', number: 1, match,
    signals: [{ selectionId: 's1', classification: 'failed' }] }], ...overrides });
}

function idlessFirst(fixture, className = 'primary') {
  fixture.first.removeAttribute('id');
  if (className !== null) fixture.first.setAttribute('class', className);
  return fixture;
}

test('a structural match locates an element with no usable class and leaves the page untouched', () => {
  const fixture = idlessFirst(createPageMarkersFixture(), null);
  const before = structuredClone(fixture.first.attributes);
  const command = singleTarget(structuralMatch('button', 'main > button'));
  assert.deepEqual(runAuditaPageMarkersCommand(command, fixture.environment), {
    ok: true, locatedMarkerIds: ['m1'], unlocated: [],
  });
  assert.equal(fixture.environment.markerButtons().length, 1);
  assert.deepEqual(fixture.first.attributes, before);
  assert.equal(fixture.first.scrollCalls.length, 0);
  assert.equal(fixture.first.focusCalls, 0);
  assert.equal(fixture.document.activeElement, fixture.priorFocus);
  assert.equal(ringOf(fixture.environment.markerGroups()[0]).style.display, 'block');
});

test('classes corroborate the structural match without ever being a global uniqueness requirement', () => {
  const fixture = idlessFirst(createPageMarkersFixture());
  fixture.body.appendChild(new FixtureElement('button', { class: 'primary unrelated' }, fixture.document));
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget(structuralMatch('button', 'main > button', { classes: ['primary'] })), fixture.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });

  const missing = idlessFirst(createPageMarkersFixture());
  missing.body.appendChild(new FixtureElement('button', { class: 'primary' }, missing.document));
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget(structuralMatch('button', 'main > button', { classes: ['absent'] })), missing.environment),
  { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'not-found' }] });
});

test('a semantic selector locates by recorded attribute and requires exactly one corroborating match', () => {
  const fixture = createPageMarkersFixture();
  fixture.first.removeAttribute('id');
  fixture.first.setAttribute('aria-label', 'Continuar para a próxima etapa');
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget(semanticMatch('button', 'aria-label', 'Continuar para a próxima etapa')), fixture.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });

  const duplicate = createPageMarkersFixture();
  duplicate.first.removeAttribute('id');
  duplicate.first.setAttribute('data-testid', 'cta');
  duplicate.main.appendChild(new FixtureElement('button', { 'data-testid': 'cta' }, duplicate.document));
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget(semanticMatch('button', 'data-testid', 'cta')), duplicate.environment),
  { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'ambiguous' }] });

  const drifted = createPageMarkersFixture();
  drifted.first.removeAttribute('id');
  drifted.first.setAttribute('title', 'outro');
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget(semanticMatch('button', 'title', 'esperado')), drifted.environment),
  { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'not-found' }] });
});

test('semantic attribute values are escaped, bounded, and restricted to whitelisted names', () => {
  const fixture = createPageMarkersFixture();
  const image = new FixtureElement('img', { alt: 'a"b\\c' }, fixture.document);
  fixture.main.appendChild(image);
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget(semanticMatch('img', 'alt', 'a"b\\c')), fixture.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });

  for (const match of [
    { tag: 'img', attribute: { name: 'onload', value: 'x' } },
    { tag: 'img', attribute: { name: 'href', value: 'x' } },
    { tag: 'img', attribute: { name: 'alt', value: '' } },
    { tag: 'img', attribute: { name: 'alt', value: 'x'.repeat(257) } },
    { tag: 'img', attribute: { name: 'alt', value: 'linha\nquebrada' } },
    { tag: 'img', attribute: { name: 'alt' } },
  ]) {
    const isolated = createPageMarkersFixture();
    assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(match), isolated.environment),
      { ok: false, reason: 'invalid-command' });
    assert.equal(isolated.document.queryCounts.size, 0);
  }
});

test('a duplicated id travels as corroboration on the structural path, never as the locator', () => {
  for (const [recorded, expected] of [['card', ['m1']], ['other', []]]) {
    const fixture = idlessFirst(createPageMarkersFixture(), null);
    fixture.first.setAttribute('id', 'card');
    fixture.body.appendChild(new FixtureElement('button', { id: 'card' }, fixture.document));
    const result = runAuditaPageMarkersCommand(
      singleTarget(structuralMatch('button', 'main > button', { id: recorded })), fixture.environment);
    assert.deepEqual(result.locatedMarkerIds, expected);
    if (expected.length === 0) assert.deepEqual(result.unlocated, [{ markerId: 'm1', reason: 'not-found' }]);
  }
});

test('page-side tokens with four digits or eight hex characters are accepted while credentials stay refused', () => {
  for (const [attribute, value] of [['id', 'secao-2024'], ['class', 'grid-2024'], ['id', 'a1b2c3d4'],
    ['class', 'bloco-9f3e1a2b']]) {
    const fixture = createPageMarkersFixture();
    fixture.first.removeAttribute('id');
    fixture.first.setAttribute(attribute, value);
    const match = attribute === 'id'
      ? idMatch('button', value)
      : structuralMatch('button', 'main > button', { classes: [value] });
    assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(match), fixture.environment), {
      ok: true, locatedMarkerIds: ['m1'], unlocated: [],
    }, `${attribute}=${value}`);
  }
  for (const [attribute, value] of [['id', 'api-key-principal'], ['class', 'session-token'],
    ['id', 'user-password'], ['id', 'csrf-state']]) {
    const fixture = createPageMarkersFixture();
    fixture.first.removeAttribute('id');
    fixture.first.setAttribute(attribute, value);
    const match = attribute === 'id'
      ? idMatch('button', value)
      : structuralMatch('button', 'main > button', { classes: [value] });
    assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(match), fixture.environment),
      { ok: false, reason: 'invalid-command' }, `${attribute}=${value}`);
  }
});

test('long structural paths are accepted up to 64 segments and refused beyond it', () => {
  for (const [segments, valid] of [[64, true], [65, false]]) {
    const fixture = createPageMarkersFixture();
    const path = `${Array(segments - 1).fill('div').join(' > ')} > button`;
    const result = runAuditaPageMarkersCommand(singleTarget(structuralMatch('button', path)), fixture.environment);
    assert.deepEqual(result, valid
      ? { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'not-found' }] }
      : { ok: false, reason: 'invalid-command' }, `${segments} segments`);
  }
});

test('the ceiling of 500 accepts a full payload and refuses one item more', () => {
  const targets = count => Array.from({ length: count }, (_, index) => ({
    markerId: `m${index + 1}`, number: index + 1, match: idMatch('button', 'continue'),
    signals: [{ selectionId: `s${index + 1}`, classification: 'failed' }],
  }));
  const full = createPageMarkersFixture();
  const result = runAuditaPageMarkersCommand(install({ targets: targets(500) }), full.environment);
  assert.equal(result.ok, true);
  assert.equal(result.locatedMarkerIds.length, 500);
  assert.equal(buttonForNumber(full, 1).textContent, '1 × (500)');
  assert.deepEqual(runAuditaPageMarkersCommand(filter(Array.from({ length: 500 }, (_, index) => `s${index + 1}`)),
    full.environment), { ok: true });
  assert.deepEqual(runAuditaPageMarkersCommand(filter(Array.from({ length: 501 }, (_, index) => `s${index + 1}`)),
    full.environment), { ok: false, reason: 'invalid-command' });

  const over = createPageMarkersFixture();
  assert.deepEqual(runAuditaPageMarkersCommand(install({ targets: targets(501) }), over.environment),
    { ok: false, reason: 'invalid-command' });
  assert.equal(over.document.queryCounts.size, 0);
  const crowded = createPageMarkersFixture();
  assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue'), {
    targets: [{ markerId: 'm1', number: 1, match: idMatch('button', 'continue'),
      signals: targets(501).map(row => row.signals[0]) }],
  }), crowded.environment), { ok: false, reason: 'invalid-command' });
});

test('a disappeared element hides only its own signal and gets its marker back when it returns', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  const [first, second] = fixture.environment.markerGroups();
  assert.equal(ringOf(first).style.display, 'block');
  assert.equal(ringOf(second).style.display, 'block');

  fixture.second.remove();
  fixture.environment.triggerMutations([{ type: 'childList', target: fixture.main, removedNodes: [fixture.second] }]);
  fixture.environment.settle();

  assert.equal(fixture.environment.hosts().length, 1);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaPageMarkersOverlayV1'), true);
  assert.equal(ringOf(first).style.display, 'block');
  assert.equal(ringOf(second).style.display, 'none');
  assert.deepEqual(fixture.environment.messages, []);

  fixture.main.appendChild(fixture.second);
  fixture.environment.triggerMutations([{ type: 'childList', target: fixture.main, addedNodes: [fixture.second] }]);
  fixture.environment.settle();
  assert.equal(ringOf(second).style.display, 'block');
});

test('a re-rendered element is re-located by its match and the marker follows the new node', () => {
  const fixture = idlessFirst(createPageMarkersFixture());
  const command = singleTarget(structuralMatch('button', 'main > button', { classes: ['primary'] }));
  assert.equal(runAuditaPageMarkersCommand(command, fixture.environment).locatedMarkerIds.length, 1);
  const replacement = new FixtureElement('button', { class: 'primary' }, fixture.document);
  replacement.setRect({ left: 300, top: 200, width: 80, height: 30 });
  fixture.first.remove();
  fixture.main.appendChild(replacement);
  fixture.environment.triggerMutations([{ type: 'childList', target: fixture.main }]);
  fixture.environment.settle();

  assert.equal(fixture.environment.hosts().length, 1);
  const group = fixture.environment.markerGroups()[0];
  assert.equal(ringOf(group).style.display, 'block');
  assert.equal(ringOf(group).style.left, '295px');
  assert.equal(ringOf(group).style.top, '195px');
  assert.equal(ringOf(group).style.width, '90px');
});

test('a hidden element hides its own contour and comes back when it is shown again', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const group = fixture.environment.markerGroups()[0];
  assert.equal(ringOf(group).style.display, 'block');

  fixture.first.style.visibility = 'hidden';
  fixture.environment.triggerMutations([{ type: 'attributes', target: fixture.first }]);
  fixture.environment.settle();
  assert.equal(ringOf(group).style.display, 'none');
  assert.equal(labelOf(group).style.display, 'none');
  assert.equal(fixture.environment.hosts().length, 1);

  fixture.first.style.visibility = 'visible';
  fixture.environment.triggerMutations([{ type: 'attributes', target: fixture.first }]);
  fixture.environment.settle();
  assert.equal(ringOf(group).style.display, 'block');
});

test('mutations only schedule a throttled check, repositioning on the following frame', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const group = fixture.environment.markerGroups()[0];
  fixture.first.setRect({ left: 100, top: 120, width: 220, height: 44 });
  fixture.environment.triggerMutations([{ type: 'characterData', target: fixture.first }]);
  fixture.environment.flushFrames();
  assert.equal(ringOf(group).style.left, '25px', 'a mutation does not run an unbounded check');
  assert.deepEqual(fixture.environment.timerDelays().includes(100), true);
  fixture.environment.settle();
  assert.equal(ringOf(group).style.left, '95px');
  assert.equal(ringOf(group).style.width, '230px');
});

test('mutations inside the overlay host are ignored', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const before = fixture.environment.timerDelays().length;
  const host = fixture.environment.hosts()[0];
  fixture.environment.triggerMutations([{ type: 'childList', target: host }]);
  fixture.environment.triggerMutations([{ type: 'attributes', target: host.shadowRoot.children[0] }]);
  assert.equal(fixture.environment.timerDelays().length, before);
});

test('hashchange keeps the session, popstate only discards on a real navigation', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  fixture.environment.location.hash = '#secao';
  fixture.environment.dispatch('hashchange');
  fixture.environment.flushFrames();
  assert.equal(fixture.environment.hosts().length, 1);
  assert.equal(fixture.environment.markerButtons().length, 1);

  fixture.environment.dispatch('popstate');
  fixture.environment.flushFrames();
  assert.equal(fixture.environment.hosts().length, 1);

  fixture.environment.location.pathname = '/outra-pagina';
  fixture.environment.dispatch('popstate');
  fixture.environment.flushFrames();
  assertClean(fixture);
  assert.deepEqual(fixture.environment.messages, [{ type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: A }]);
});

test('every located element keeps its own contour outside the element with a white halo and an attached tab', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const group = fixture.environment.markerGroups()[0];
  const ring = ringOf(group);
  const label = labelOf(group);

  assert.equal(ring.style.display, 'block');
  assert.equal(ring.style.left, '25px');
  assert.equal(ring.style.top, '45px');
  assert.equal(ring.style.width, '170px');
  assert.equal(ring.style.height, '50px');
  assert.equal(ring.style.borderWidth, '2px');
  assert.equal(ring.style.borderRadius, '3px');
  assert.match(ring.style.boxShadow, /inset 0 0 0 1px #ffffff/u);
  assert.match(ring.style.boxShadow, /(?:^|, )0 0 0 1px #ffffff/u);

  assert.equal(label.style.display, 'flex');
  assert.equal(label.style.left, '25px');
  assert.equal(label.style.top, '25px');
  assert.equal(label.style.height, '20px');
  assert.equal(label.style.borderRadius, '4px 4px 0 0');
  assert.equal(label.style.color, '#ffffff');
  assert.equal(label.style.borderColor, '#ffffff');
  assert.match(label.style.font, /700 12px/u);
  assert.equal(label.textContent, '1 ×');
});

test('the occurrence count only appears above one and the classification drives colour and symbol', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  assert.equal(buttonForNumber(fixture, 1).textContent, '1 × (2)');
  assert.equal(buttonForNumber(fixture, 2).textContent, '2 ✓');
  assert.equal(buttonForNumber(fixture, 1).style.background, '#8b1e1e');
  assert.equal(buttonForNumber(fixture, 2).style.background, '#1f6f43');
  assert.match(buttonForNumber(fixture, 1).getAttribute('aria-label'),
    /Sinal 1: falha registrada na auditoria, 2 ocorrências\. Abrir no painel\./u);
});

test('the label hangs below the contour when there is no room above and never leaves the viewport', () => {
  const fixture = createPageMarkersFixture();
  fixture.first.setRect({ left: 30, top: 10, width: 160, height: 40 });
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const label = labelOf(fixture.environment.markerGroups()[0]);
  assert.equal(label.style.top, '55px');
  assert.equal(label.style.borderRadius, '0 0 4px 4px');

  const edge = createPageMarkersFixture();
  edge.first.setRect({ left: 1000, top: 10, width: 100, height: 40 });
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), edge.environment);
  const clamped = labelOf(edge.environment.markerGroups()[0]);
  const left = Number.parseInt(clamped.style.left, 10);
  assert.ok(left + Number.parseInt(clamped.style.width, 10) <= 1024, clamped.style.left);
});

test('an element taller than the viewport keeps its label inside the visible band', () => {
  const fixture = createPageMarkersFixture();
  fixture.first.setRect({ left: 30, top: -40, width: 160, height: 900 });
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const group = fixture.environment.markerGroups()[0];
  assert.equal(labelOf(group).style.top, '0px');
  // Both cut sides stay at the viewport edge and are dashed: the element continues past them.
  assert.equal(ringOf(group).style.top, '0px');
  assert.equal(ringOf(group).style.height, '768px');
  assert.equal(ringOf(group).style.borderTopStyle, 'dashed');
  assert.equal(ringOf(group).style.borderBottomStyle, 'dashed');
  assert.equal(ringOf(group).style.borderLeftStyle, 'solid');
});

test('labels never fully cover each other and slide along the contour before overlapping', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: idMatch('button', 'continue'), signals: [{ selectionId: 's1', classification: 'failed' }] },
    { markerId: 'm2', number: 2, match: idMatch('a', 'help'), signals: [{ selectionId: 's2', classification: 'alert' }] },
    { markerId: 'm3', number: 3, match: idMatch('input', 'prior'), signals: [{ selectionId: 's3', classification: 'passed' }] },
  ] }), fixture.environment);
  const labels = fixture.environment.markerGroups().map(group => labelOf(group));
  assert.equal(labels.length, 3);
  const boxes = labels.map(label => ({
    left: Number.parseInt(label.style.left, 10), top: Number.parseInt(label.style.top, 10),
    right: Number.parseInt(label.style.left, 10) + Number.parseInt(label.style.width, 10),
    bottom: Number.parseInt(label.style.top, 10) + 20,
  }));
  for (const left of boxes) {
    for (const right of boxes) {
      if (left === right) continue;
      const covers = left.left <= right.left && left.top <= right.top &&
        left.right >= right.right && left.bottom >= right.bottom;
      assert.equal(covers, false, `${JSON.stringify(left)} covers ${JSON.stringify(right)}`);
    }
  }
});

test('a selection enlarges the contour and its label while the other contours step back', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  assert.deepEqual(runAuditaPageMarkersCommand(select('s1', false), fixture.environment), { ok: true });
  const [group, other] = fixture.environment.markerGroups();
  assert.equal(ringOf(group).style.borderWidth, '3px');
  assert.match(ringOf(group).style.boxShadow, /0 0 0 4px rgba\(139, 30, 30, 0\.35\)/u);
  assert.equal(labelOf(group).style.height, '24px');
  assert.match(labelOf(group).style.font, /700 14px/u);
  // Only the contour steps back; the label keeps its solid colour so its text keeps its contrast.
  assert.equal(ringOf(other).style.opacity, '0.6');
  assert.equal(labelOf(other).style.opacity, '1');
  assert.equal(ringOf(group).style.opacity, '1');
});

test('micro elements get a minimum contour and clipped elements hug the visible area', () => {
  const tiny = createPageMarkersFixture();
  tiny.first.setRect({ left: 100, top: 100, width: 4, height: 4 });
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), tiny.environment);
  const tinyRing = ringOf(tiny.environment.markerGroups()[0]);
  assert.equal(tinyRing.style.width, '22px');
  assert.equal(tinyRing.style.height, '22px');
  assert.equal(tinyRing.style.left, '91px');
  assert.equal(tinyRing.style.top, '91px');

  const clipped = createPageMarkersFixture();
  clipped.main.setRect({ left: 40, top: 60, width: 60, height: 20 });
  clipped.main.style.overflow = 'hidden';
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), clipped.environment);
  const clippedRing = ringOf(clipped.environment.markerGroups()[0]);
  assert.equal(clippedRing.style.left, '40px');
  assert.equal(clippedRing.style.top, '60px');
  assert.equal(clippedRing.style.width, '60px');
  assert.equal(clippedRing.style.height, '20px');
  for (const side of ['Top', 'Bottom', 'Left', 'Right']) assert.equal(clippedRing.style[`border${side}Style`], 'dashed');

  const offscreen = createPageMarkersFixture();
  offscreen.first.setRect({ left: -10_000, top: 80, width: 20, height: 20 });
  const offResult = runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), offscreen.environment);
  assert.deepEqual(offResult, { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
  assert.equal(ringOf(offscreen.environment.markerGroups()[0]).style.display, 'none');
});

test('installs multiple isolated markers, groups duplicate DOM targets, and leaves page state untouched', () => {
  const fixture = createPageMarkersFixture();
  let pageClicks = 0;
  fixture.first.addEventListener('click', () => { pageClicks += 1; });
  const beforeSelection = fixture.document.getSelection();
  const beforeAttributes = structuredClone(fixture.first.attributes);
  const command = install({ targets: [
    ...install().targets,
    { markerId: 'm3', number: 9, match: idMatch('button', 'continue'), signals: [
      { selectionId: 's4', classification: 'alert' },
    ] },
  ] });

  assert.deepEqual(runAuditaPageMarkersCommand(command, fixture.environment), {
    ok: true, locatedMarkerIds: ['m1', 'm2', 'm3'], unlocated: [],
  });
  assert.equal(fixture.environment.hosts().length, 1);
  assert.equal(fixture.environment.markerButtons().length, 2);
  assert.match(buttonForNumber(fixture, 1).getAttribute('aria-label'), /Sinal 1: falha registrada na auditoria, 3 ocorrências\. Abrir no painel\./u);
  assert.equal(buttonForNumber(fixture, 1).textContent, '1 × (3)');
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
    { markerId: 'm1', number: 4, match: idMatch('button', 'continue'), signals: [
      { selectionId: 's1', classification: 'failed' },
      { selectionId: 's2', classification: 'manual-review' },
      { selectionId: 's3', classification: 'alert' },
      { selectionId: 's4', classification: 'passed' },
    ] },
  ] }), fixture.environment);

  assert.deepEqual(runAuditaPageMarkersCommand(filter(['s3', 's2']), fixture.environment), { ok: true });
  const marker = buttonForNumber(fixture, 4);
  assert.equal(marker.textContent, '4 ! (2)');
  assert.equal(marker.style.background, '#8a5a00');
  assert.match(marker.getAttribute('aria-label'), /alerta registrado na auditoria, 2 ocorrências/u);
  marker.click();
  assert.deepEqual(fixture.environment.messages.at(-1), {
    type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: A, selectionId: 's2',
  });

  assert.deepEqual(runAuditaPageMarkersCommand(select('s2'), fixture.environment), { ok: true });
  assert.equal(ringOf(fixture.environment.markerGroups()[0]).style.display, 'block');
  assert.deepEqual(runAuditaPageMarkersCommand(filter([], A), fixture.environment), { ok: true });
  assert.equal(marker.style.display, 'none');
  assert.deepEqual(runAuditaPageMarkersCommand(select('s2'), fixture.environment), {
    ok: false, reason: 'selection-unavailable',
  });
  assert.equal(ringOf(fixture.environment.markerGroups()[0]).style.display, 'none');
  assert.deepEqual(runAuditaPageMarkersCommand(filter(['s1']), fixture.environment), { ok: true });
  assert.equal(marker.textContent, '4 ×');
  assert.equal(ringOf(fixture.environment.markerGroups()[0]).style.display, 'block');
});

test('selection ring stays on a visible target, and only explicit scroll moves it without focus or feedback messages', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);

  assert.deepEqual(runAuditaPageMarkersCommand(select('s2', false), fixture.environment), { ok: true });
  const group = fixture.environment.markerGroups()[0];
  assert.equal(ringOf(group).style.display, 'block');
  assert.equal(fixture.first.scrollCalls.length, 0);
  assert.equal(fixture.document.activeElement, fixture.priorFocus);
  assert.deepEqual(fixture.environment.messages, []);

  assert.deepEqual(runAuditaPageMarkersCommand(select('s3', true), fixture.environment), { ok: true });
  assert.deepEqual(fixture.second.scrollCalls, [{ behavior: 'instant', block: 'center', inline: 'nearest' }]);
  assert.equal(fixture.document.activeElement, fixture.priorFocus);
  assert.deepEqual(fixture.environment.messages, []);
});

test('isolates missing, ambiguous, detached and unsupported targets while keeping hidden and offscreen targets', () => {
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
    { markerId: 'm1', number: 1, match: idMatch('aside', 'missing'), signals: [{ selectionId: 's1', classification: 'failed' }] },
    { markerId: 'm2', number: 2, match: idMatch('button', 'duplicate'), signals: [{ selectionId: 's2', classification: 'alert' }] },
    { markerId: 'm3', number: 3, match: idMatch('div', 'hidden'), signals: [{ selectionId: 's3', classification: 'manual-review' }] },
    { markerId: 'm4', number: 4, match: idMatch('p', 'detached'), signals: [{ selectionId: 's4', classification: 'passed' }] },
    { markerId: 'm5', number: 5, match: idMatch('p', 'foreign'), signals: [{ selectionId: 's5', classification: 'passed' }] },
    { markerId: 'm6', number: 6, match: idMatch('section', 'offscreen'), signals: [{ selectionId: 's6', classification: 'passed' }] },
  ] }), fixture.environment);

  // A hidden element (carousel slide, closed accordion) keeps a signal that waits hidden until the
  // element is rendered; detached and foreign-root elements are still refused.
  assert.deepEqual(result, { ok: true, locatedMarkerIds: ['m3', 'm6'], unlocated: [
    { markerId: 'm1', reason: 'not-found' },
    { markerId: 'm2', reason: 'ambiguous' },
    { markerId: 'm4', reason: 'not-rendered' },
    { markerId: 'm5', reason: 'unsupported-context' },
  ] });
  assert.equal(fixture.environment.markerButtons().length, 2);
  for (const group of fixture.environment.markerGroups()) assert.equal(ringOf(group).style.display, 'none');
  hidden.style.visibility = 'visible';
  hidden.setRect({ left: 40, top: 300, width: 80, height: 30 });
  fixture.environment.triggerMutations([{ target: hidden, type: 'attributes' }]);
  fixture.environment.settle?.();
  fixture.environment.flushFrames?.();
  const revealed = fixture.environment.markerGroups()
    .find(group => labelOf(group).getAttribute('aria-label').startsWith('Sinal 3:'));
  assert.equal(ringOf(revealed).style.display, 'block');
  assert.equal(labelOf(revealed).style.display, 'flex');
});

test('rejects malformed matches, unsafe tokens and mixed shapes before any DOM query', () => {
  let reads = 0;
  let index = 0;
  const accessorClasses = [];
  Object.defineProperty(accessorClasses, '0', { enumerable: true, get() { reads += 1; return 'primary'; } });
  const sparseClasses = new Array(1);
  for (const match of [
    { tag: 'button' },
    { tag: 'button', id: 'continue', classes: ['primary'] },
    { tag: 'button', id: null },
    { tag: 'button', id: null, classes: ['primary'] },
    { tag: 'button', classes: ['primary', 'primary'], path: 'main > button', id: null, role: null, type: null },
    { tag: 'button', classes: ['session-token'], path: 'main > button', id: null, role: null, type: null },
    { tag: 'button', classes: accessorClasses, path: 'main > button', id: null, role: null, type: null },
    { tag: 'button', classes: sparseClasses, path: 'main > button', id: null, role: null, type: null },
    { tag: 'button', classes: Array.from({ length: 25 }, (_, index) => `c${index}`), path: 'main > button', id: null, role: null, type: null },
    { tag: 'button', classes: ['x'.repeat(24)], path: 'main > button', id: null, role: null, type: null },
    { tag: 'button', classes: ['primary'], path: 'main > button', id: 'a b', role: null, type: null },
    { tag: 'button', classes: ['primary'], path: 'main > button', id: null, role: 'role!', type: null },
    { tag: 'button', classes: ['primary'], path: 'main > button', id: null, role: null, type: null, snippet: 'private' },
    { tag: 'Button', id: 'continue' },
    { tag: 'button', id: 'continue', extra: true },
  ]) {
    const fixture = createPageMarkersFixture();
    index += 1;
    assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(match), fixture.environment),
      { ok: false, reason: 'invalid-command' }, `match ${index}`);
    assert.equal(fixture.document.queryCounts.size, 0, `match ${index}`);
  }
  assert.equal(reads, 0);
});

test('a structural match without the optional fields Chrome drops still locates', () => {
  const fixture = idlessFirst(createPageMarkersFixture());
  // Chrome serializes injected arguments as JSON and drops null values, so an element with no
  // recorded id arrives with just tag, classes and path.
  assert.deepEqual(runAuditaPageMarkersCommand(
    singleTarget({ tag: 'button', classes: ['primary'], path: 'main > button' }), fixture.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
  const withId = createPageMarkersFixture();
  assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(
    { tag: 'button', classes: [], path: 'main > button', id: 'continue' }), withId.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
  const driftedId = createPageMarkersFixture();
  assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(
    { tag: 'button', classes: [], path: 'main > button', id: 'other' }), driftedId.environment),
  { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'not-found' }] });
});

test('structural paths stay a closed grammar and unknown roots never reach the page', () => {
  for (const path of [undefined, 'button.other', 'main#scope > button', 'button[type="submit"]', 'button + button',
    'main button', 'button, a', 'button:nth-of-type(0)', 'button:nth-of-type(9007199254740992)',
    'a', 'a'.repeat(2049), 'script', 'main > Button']) {
    const fixture = idlessFirst(createPageMarkersFixture());
    assert.deepEqual(runAuditaPageMarkersCommand(
      singleTarget(structuralMatch('button', path, { classes: ['primary'] })), fixture.environment),
    { ok: false, reason: 'invalid-command' }, String(path));
    assert.equal(fixture.document.queryCounts.size, 0);
  }
  for (const [path, expected] of [['section > button', 'not-found'], ['button', 'ambiguous'],
    ['button:nth-of-type(2)', 'not-found']]) {
    const fixture = idlessFirst(createPageMarkersFixture());
    fixture.main.appendChild(new FixtureElement('button', { class: 'unrelated' }, fixture.document));
    assert.deepEqual(runAuditaPageMarkersCommand(
      singleTarget(structuralMatch('button', path, { classes: ['primary'] })), fixture.environment),
    { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: expected }] });
    assert.equal(fixture.environment.markerButtons().length, 0);
  }
});

test('positional drift keeps the located marker instead of discarding the session', () => {
  const fixture = idlessFirst(createPageMarkersFixture());
  const match = structuralMatch('button', 'button:nth-of-type(1)', { classes: ['primary'] });
  assert.equal(runAuditaPageMarkersCommand(singleTarget(match), fixture.environment).locatedMarkerIds.length, 1);
  fixture.first.remove();
  fixture.main.appendChild(new FixtureElement('button', { class: 'unrelated' }, fixture.document));
  fixture.main.appendChild(fixture.first);
  fixture.environment.triggerMutations([{ type: 'childList', target: fixture.main }]);
  fixture.environment.settle();
  assert.equal(fixture.environment.hosts().length, 1);
  assert.equal(ringOf(fixture.environment.markerGroups()[0]).style.display, 'block');
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
  assert.deepEqual([...fixture.environment.timerDelays()].sort((left, right) => left - right), [400, 60_000]);
  assert.equal(fixture.environment.timerRegistrationCount(), 2);

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

test('escape, pagehide, expiry and documentElement replacement invalidate once', () => {
  for (const [label, trigger] of [
    ['escape', fixture => fixture.environment.dispatch('keydown', { key: 'Escape' })],
    ['pagehide', fixture => fixture.environment.dispatch('pagehide')],
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

  const replaced = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), replaced.environment);
  const ownedHost = replaced.environment.hosts()[0];
  const replacement = new FixtureElement('html', {}, replaced.document);
  replaced.environment.replaceDocumentElement(replacement);
  replaced.environment.flushFrames();
  assertClean(replaced);
  assert.equal(replaced.html.children.includes(ownedHost), false);
  assert.equal(replacement.children.length, 0);
  assert.deepEqual(replaced.environment.messages, [{
    type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: A,
  }]);
});

test('scroll and resize refresh fixed geometry on the next frame', () => {
  const fixture = createPageMarkersFixture();
  runAuditaPageMarkersCommand(install(), fixture.environment);
  const firstGroup = fixture.environment.markerGroups()[0];
  fixture.first.setRect({ left: 100, top: 120, width: 220, height: 44 });
  fixture.environment.dispatch('scroll');
  fixture.environment.dispatch('resize');
  assert.equal(ringOf(firstGroup).style.left, '25px');
  fixture.environment.flushFrames();
  assert.equal(ringOf(firstGroup).style.left, '95px');
  assert.equal(ringOf(firstGroup).style.width, '230px');
  assert.equal(labelOf(firstGroup).style.top, '95px');
});

test('empty and fully unlocated installs retain a session without icons', () => {
  for (const targets of [[], [
    { markerId: 'm1', number: 1, match: idMatch('aside', 'absent'), signals: [{ selectionId: 's1', classification: 'failed' }] },
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

test('fixed page chrome over an element trims its contour and hides a fully covered one', () => {
  const fixture = createPageMarkersFixture();
  const banner = new FixtureElement('div', { id: 'cookie-banner' }, fixture.document);
  banner.style.position = 'fixed';
  banner.setRect({ left: 0, top: 70, width: 1024, height: 120 });
  fixture.main.append(banner);
  let covered = { top: 70, bottom: 190 };
  fixture.document.elementFromPoint = (x, y) => (y >= covered.top && y < covered.bottom ? banner : fixture.first);
  runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment);
  const group = fixture.environment.markerGroups()[0];
  // The element spans 50..90; the banner covers it from 70 down, so the contour stops at the banner.
  assert.equal(ringOf(group).style.top, '45px');
  assert.equal(ringOf(group).style.height, '25px');
  assert.equal(ringOf(group).style.borderBottomStyle, 'dashed');
  assert.equal(ringOf(group).style.borderTopStyle, 'solid');
  assert.equal(labelOf(group).style.display, 'flex');

  covered = { top: 40, bottom: 140 };
  banner.setRect({ left: 0, top: 40, width: 1024, height: 100 });
  fixture.environment.triggerMutations([{ target: banner, type: 'attributes' }]);
  fixture.environment.settle();
  assert.equal(ringOf(group).style.display, 'none', 'an element entirely under the banner is not outlined over it');

  // A full-screen scrim (modal backdrop) is not page chrome: the signals stay usable under it.
  covered = { top: 0, bottom: 768 };
  banner.setRect({ left: 0, top: 0, width: 1024, height: 768 });
  fixture.environment.triggerMutations([{ target: banner, type: 'attributes' }]);
  fixture.environment.settle();
  assert.equal(ringOf(group).style.display, 'block');
});

// --- Corroboração da recarga (1.1.60): o sinal só é desenhado se o elemento reencontrado
// --- continuar trazendo o nome acessível ou o texto registrados na auditoria.

function corroborated(match, corroboration, overrides = {}) {
  return install({
    targets: [{ markerId: 'm1', number: 1, match, corroboration,
      signals: [{ selectionId: 's1', classification: 'failed' }] }],
    ...overrides,
  });
}

test('a reloaded signal is drawn when the re-found element still carries the recorded name or text', () => {
  const named = createPageMarkersFixture();
  named.first.setAttribute('aria-label', 'Continuar');
  assert.deepEqual(runAuditaPageMarkersCommand(
    corroborated(idMatch('button', 'continue'), { name: 'Continuar' }), named.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
  assert.equal(named.environment.markerButtons().length, 1);

  const texted = createPageMarkersFixture();
  texted.first.textContent = 'Toque para avançar agora';
  assert.deepEqual(runAuditaPageMarkersCommand(
    corroborated(idMatch('button', 'continue'), { name: 'Continuar', text: 'Avançar' }), texted.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
  assert.equal(texted.environment.markerButtons().length, 1);
});

test('the recorded text has to be inside the live text: the other direction is a mismatch', () => {
  const shorter = createPageMarkersFixture();
  shorter.first.textContent = 'Avançar';
  assert.deepEqual(runAuditaPageMarkersCommand(
    corroborated(idMatch('button', 'continue'), { text: 'Avançar agora mesmo' }), shorter.environment),
  { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'evidence-mismatch' }] });
  assert.equal(shorter.environment.markerButtons().length, 0);
});

test('a re-found element with another name and other text is reported, never drawn', () => {
  const fixture = createPageMarkersFixture();
  fixture.first.textContent = 'Outra coisa';
  fixture.first.setAttribute('aria-label', 'Outro nome');
  assert.deepEqual(runAuditaPageMarkersCommand(
    corroborated(idMatch('button', 'continue'), { name: 'Continuar', text: 'Avançar' }), fixture.environment),
  { ok: true, locatedMarkerIds: [], unlocated: [{ markerId: 'm1', reason: 'evidence-mismatch' }] });
  assert.equal(fixture.environment.markerButtons().length, 0);
  assert.equal(fixture.environment.markerGroups().length, 0);
  // A sessão vazia continua removível: nada ficou preso na página.
  assert.deepEqual(runAuditaPageMarkersCommand(clear(), fixture.environment), { ok: true });
  assertClean(fixture);
});

test('the comparison ignores case and surrounding spaces without accepting credentials', () => {
  const fixture = createPageMarkersFixture();
  fixture.first.setAttribute('title', '  continuar  ');
  assert.deepEqual(runAuditaPageMarkersCommand(
    corroborated(idMatch('button', 'continue'), { name: 'Continuar' }), fixture.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
});

test('an invalid corroboration rejects the whole command instead of drawing a partial install', () => {
  for (const corroboration of [
    {}, { name: 'Continuar', text: 'Avançar', extra: 'x' }, { name: '' }, { name: 17 },
    { text: 'linha\u0000quebrada' }, { text: 'x'.repeat(201) }, { name: 'Continuar', text: null },
  ]) {
    const fixture = createPageMarkersFixture();
    assert.deepEqual(runAuditaPageMarkersCommand(
      corroborated(idMatch('button', 'continue'), corroboration), fixture.environment),
    { ok: false, reason: 'invalid-command' }, JSON.stringify(corroboration));
    assertClean(fixture);
  }
});

test('without corroboration the install behaves exactly as before', () => {
  const fixture = createPageMarkersFixture();
  assert.deepEqual(runAuditaPageMarkersCommand(singleTarget(idMatch('button', 'continue')), fixture.environment),
  { ok: true, locatedMarkerIds: ['m1'], unlocated: [] });
  assert.equal(fixture.environment.markerButtons().length, 1);
});
