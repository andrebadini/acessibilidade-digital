import assert from 'node:assert/strict';
import test from 'node:test';

import { runAuditaPageMarkersCommand } from '../../src/browser/page-markers-overlay.js';
import {
  FixtureElement, createPageMarkersFixture, idMatch, install, filter, textLine,
} from './page-markers-fixture.js';

// The label is a tab glued to the contour, and it used to be placed with no idea that the page has
// words: on a card with a long title and a short link right under it, the label of the link landed
// on the last line of the title and covered it. Visible page text is now an obstacle with a high
// cost, so the label gives up the glued spot and moves — to the free side of the link, or to a free
// row with a short leader line. Text that belongs to the marked element itself is exempt: it is
// already inside the contour, and covering it hides nothing the reader is not already looking at.

const A = 'A'.repeat(22);
const CARDS = 'Título da notícia que ocupa duas linhas inteiras';

function labelOf(fixture) { return fixture.environment.markerGroups()[0].children[1]; }
function leaderOf(fixture) { return fixture.environment.markerGroups()[0].children[2]; }
function ringOf(fixture) { return fixture.environment.markerGroups()[0].children[0]; }

function boxOf(element) {
  const left = Number.parseFloat(element.style.left);
  const top = Number.parseFloat(element.style.top);
  return { left, top, right: left + Number.parseFloat(element.style.width), bottom: top + 20 };
}

function overlaps(left, right) {
  return Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0 &&
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0;
}

// A news card: a long title, and the link right under it with no room between them.
function newsCard() {
  const fixture = createPageMarkersFixture();
  fixture.second.setRect({ left: 40, top: 220, width: 90, height: 22 });
  return fixture;
}

test('a label gives up the glued spot when a line of the page text is under it', () => {
  const fixture = newsCard();
  const title = { left: 40, top: 196, width: 300, height: 22 };
  textLine(fixture.main, CARDS, title);
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: idMatch('a', 'help'), signals: [{ selectionId: 's1', classification: 'failed' }] },
  ] }), fixture.environment);

  const label = labelOf(fixture);
  // Above the link is the last line of the title: the label goes under the link instead.
  assert.equal(label.style.top, '247px');
  assert.equal(label.style.left, '35px');
  assert.equal(label.style.borderRadius, '0 0 4px 4px');
  assert.equal(overlaps(boxOf(label), { left: 40, top: 196, right: 340, bottom: 218 }), false);
  assert.equal(leaderOf(fixture).style.display, 'none', 'a glued label needs no leader line');
});

test('the text of the marked element itself is not an obstacle', () => {
  const fixture = newsCard();
  // The same geometry, but the line belongs to the marked link, so the glued tab stays on it.
  textLine(fixture.second, 'Título da notícia que ocupa duas linhas inteiras', { left: 40, top: 196, width: 300, height: 22 });
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: idMatch('a', 'help'), signals: [{ selectionId: 's1', classification: 'failed' }] },
  ] }), fixture.environment);

  const label = labelOf(fixture);
  assert.equal(label.style.top, '195px');
  assert.equal(label.style.borderRadius, '4px 4px 0 0');
});

test('with text above and below, the label moves to a free row and draws a short leader line', () => {
  const fixture = newsCard();
  textLine(fixture.main, CARDS, { left: 20, top: 190, width: 320, height: 30 });
  textLine(fixture.main, 'Leia também esta outra notícia do dia', { left: 20, top: 245, width: 320, height: 30 });
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: idMatch('a', 'help'), signals: [{ selectionId: 's1', classification: 'failed' }] },
  ] }), fixture.environment);

  const label = labelOf(fixture);
  assert.equal(label.style.top, '147px', 'the label clears both lines of text');
  assert.equal(overlaps(boxOf(label), { left: 20, top: 190, right: 340, bottom: 220 }), false);
  assert.equal(overlaps(boxOf(label), { left: 20, top: 245, right: 340, bottom: 275 }), false);
  const leader = leaderOf(fixture);
  assert.equal(leader.style.display, 'block', 'a detached label is joined to its contour');
  assert.ok(Number.parseFloat(leader.style.width) <= 80, leader.style.width);
  // The contour itself stays exactly where the element is.
  assert.equal(ringOf(fixture).style.top, '215px');
  assert.equal(ringOf(fixture).style.left, '35px');
});

test('text outside the viewport is not an obstacle and never pushes the label off the screen', () => {
  const fixture = newsCard();
  textLine(fixture.main, 'linha muito acima da tela', { left: 40, top: -600, width: 300, height: 22 });
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: idMatch('a', 'help'), signals: [{ selectionId: 's1', classification: 'failed' }] },
  ] }), fixture.environment);
  assert.equal(labelOf(fixture).style.top, '195px');

  // Text on every side of the label: the least covered spot still wins, and the label stays on
  // screen with a real box rather than disappearing or being clamped outside the viewport.
  const crowded = newsCard();
  crowded.second.setRect({ left: 40, top: 30, width: 90, height: 22 });
  for (let index = 0; index < 12; index += 1) {
    textLine(crowded.main, `linha de texto ${index}`, { left: 0, top: index * 20, width: 1024, height: 20 });
  }
  runAuditaPageMarkersCommand(install({ targets: [
    { markerId: 'm1', number: 1, match: idMatch('a', 'help'), signals: [{ selectionId: 's1', classification: 'failed' }] },
  ] }), crowded.environment);
  const label = labelOf(crowded);
  assert.equal(label.style.display, 'flex');
  const box = boxOf(label);
  assert.ok(box.left >= 0 && box.right <= 1024 && box.top >= 0 && box.bottom <= 768,
    `the label stays inside the viewport: ${JSON.stringify(box)}`);
});

test('a dense page of 300 signals keeps the pass short', { timeout: 120_000 }, t => {
  const fixture = createPageMarkersFixture();
  const targets = [];
  for (let index = 0; index < 300; index += 1) {
    const column = index % 20;
    const row = Math.floor(index / 20);
    const button = new FixtureElement('button', { id: `ponto-${index + 1}` }, fixture.document);
    button.setRect({ left: 20 + (column * 48), top: 20 + (row * 48), width: 32, height: 16 });
    fixture.main.appendChild(button);
    // A line of text of another element right under every button: the hardest ground to place on.
    textLine(fixture.main, `texto ${index + 1}`, {
      left: 20 + (column * 48), top: 38 + (row * 48), width: 44, height: 14,
    });
    targets.push({ markerId: `m${index + 1}`, number: index + 1, match: idMatch('button', `ponto-${index + 1}`),
      signals: [{ selectionId: `s${index + 1}`, classification: 'failed' }] });
  }

  const installStarted = performance.now();
  const result = runAuditaPageMarkersCommand(install({ targets }), fixture.environment);
  const installMs = performance.now() - installStarted;
  const passed = performance.now();
  assert.deepEqual(runAuditaPageMarkersCommand(filter(targets.map(target => target.signals[0].selectionId)),
    fixture.environment), { ok: true });
  const passMs = performance.now() - passed;

  assert.equal(result.locatedMarkerIds.length, 300);
  const groups = fixture.environment.markerGroups();
  assert.equal(groups.length, 300);
  assert.equal(groups.filter(group => group.children[0].style.display === 'block').length, 300);
  // Every label is drawn, inside the viewport, and clear of the other labels.
  const boxes = groups.map(group => boxOf(group.children[1]));
  for (const box of boxes) {
    assert.ok(box.left >= 0 && box.right <= 1024 && box.top >= 0 && box.bottom <= 768, JSON.stringify(box));
  }
  // A page that freezes is a page measured in seconds; the budget here is wide and still catches it.
  t.diagnostic(`300 sinais: instalação ${installMs.toFixed(0)} ms, passada de reposicionamento ${passMs.toFixed(0)} ms`);
  assert.ok(installMs < 5_000, `a instalação com 300 sinais levou ${installMs.toFixed(0)} ms`);
  assert.ok(passMs < 3_000, `uma passada com 300 sinais levou ${passMs.toFixed(0)} ms`);
});

test('the label of every signal in a card keeps the number readable and the title intact', () => {
  const fixture = createPageMarkersFixture();
  const links = [];
  for (let index = 0; index < 4; index += 1) {
    const article = new FixtureElement('article', { class: 'noticia' }, fixture.document);
    const link = new FixtureElement('a', { id: `leia-${index + 1}` }, fixture.document);
    article.setRect({ left: 20 + (index * 240), top: 100, width: 220, height: 120 });
    link.setRect({ left: 30 + (index * 240), top: 200, width: 80, height: 22 });
    fixture.main.append(article);
    article.append(link);
    textLine(article, CARDS, { left: 30 + (index * 240), top: 176, width: 200, height: 22 });
    links.push(link);
  }
  const result = runAuditaPageMarkersCommand(install({ targets: links.map((link, index) => ({
    markerId: `m${index + 1}`, number: index + 1, match: idMatch('a', link.getAttribute('id')),
    signals: [{ selectionId: `s${index + 1}`, classification: 'failed' }],
  })) }), fixture.environment);
  assert.equal(result.locatedMarkerIds.length, 4);

  const boxes = fixture.environment.markerGroups().map(group => boxOf(group.children[1]));
  for (const [index, box] of boxes.entries()) {
    const left = 30 + (index * 240);
    assert.equal(overlaps(box, { left, top: 176, right: left + 200, bottom: 198 }), false,
      `a etiqueta ${index + 1} cobre o título do cartão`);
    assert.equal(overlaps(box, { left, top: 200, right: left + 80, bottom: 222 }), false,
      `a etiqueta ${index + 1} cobre o próprio alvo`);
  }
  assert.equal(A.length, 22);
});
