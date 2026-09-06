import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isSafeEvidenceImageUrl } from '../../src/review/review-state.js';
import { accessibilityGuidance } from '../../src/core/report/plain-language-guidance.js';

// Execute the actual form renderer without starting its Chrome session bootstrap.
const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function renderCard(entry)'), source.indexOf('\nasync function start()'));
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  addEventListener() {}
}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1l8AAAAASUVORK5CYII=';
function fixture({ kind = 'full-page', anchor = 'report-evidence-3', dataUrl = png } = {}) {
  const document = { createElement: tag => new Element(tag) };
  const evidence = { evidenceId: 'ev-1', kind, dataUrl, selector: { css: '#observed' }, snippet: '<button>Observado</button>' };
  const auditModel = {
    occurrences: [{ occurrenceId: 'occ-1', itemId: '5.2.1', evidenceRefs: ['ev-1'] }],
    itemResults: [{ id: '5.2.1', title: 'Alternativa textual', classification: 'requirement', wcag: [{ id: '1.1.1', level: 'A' }] }],
    evidence: [evidence],
  };
  const before = structuredClone(auditModel);
  const list = new Element('div');
  let validations = 0;
  const render = runInNewContext(`${renderSource}\nrenderCard;`, {
    document, auditModel, list, accessibilityGuidance,
    evidenceAnchorById: new Map(anchor === null ? [] : [['ev-1', anchor]]),
    evidenceFor: occurrence => auditModel.evidence.filter(item => occurrence.evidenceRefs.includes(item.evidenceId)),
    appendText(parent, tag, text) { const node = document.createElement(tag); node.textContent = text; parent.append(node); return node; },
    isSafeEvidenceImageUrl(value, base) { validations += 1; return isSafeEvidenceImageUrl(value, base); },
    chrome: { runtime: { getURL: () => 'chrome-extension://extension/' } },
    ANSWERS: ['conforme', 'não conforme', 'não foi possível determinar'],
    saveDecision() {}, nextUnanswered() {}, status: {},
  });
  return {
    auditModel, before, list, get validations() { return validations; },
    render: () => render({ occurrenceId: 'occ-1', itemId: '5.2.1', question: 'Revisar o elemento?' }),
  };
}
function descendants(root) { return root.children.flatMap(child => [child, ...descendants(child)]); }

test('human review forms start collapsed and explain the decision with a guide and a hypothetical example', () => {
  const run = fixture(); run.render();
  const card = run.list.children[0];
  assert.equal(card.tagName, 'details');
  assert.notEqual(card.open, true);
  assert.equal(card.children[0].tagName, 'summary');
  const text = descendants(card).map(node => node.textContent).join(' ');
  assert.match(text, /Como revisar/iu);
  assert.match(text, /exemplo/iu);
  assert.match(text, /não foi possível determinar/iu);
  assert.equal(descendants(card).filter(node => node.tagName === 'button').length, 4);
  assert.deepEqual(run.auditModel, run.before);
});

test('many review forms reference the original full-page annex without copying or decoding its pixels', () => {
  const run = fixture();
  for (let index = 0; index < 3000; index += 1) run.render();
  const nodes = descendants(run.list);
  assert.equal(nodes.filter(node => node.tagName === 'img').length, 0);
  assert.equal(run.validations, 0);
  const links = nodes.filter(node => node.tagName === 'a');
  assert.equal(links.length, 3000);
  assert.equal(links.every(link => link.href === '#report-evidence-3'), true);
  assert.equal(links.every(link => link.textContent === 'Ver captura completa da página nas evidências'), true);
  assert.deepEqual(run.auditModel, run.before);
});

test('element thumbnails remain local and validated, with inert selector and snippet text', () => {
  const run = fixture({ kind: 'element' }); run.render();
  const nodes = descendants(run.list);
  const images = nodes.filter(node => node.tagName === 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0].src, png);
  assert.equal(run.validations, 1);
  assert.equal(nodes.some(node => node.tagName === 'code' && node.textContent === 'Seletor: #observed'), true);
  assert.equal(nodes.some(node => node.tagName === 'code' && node.textContent === '<button>Observado</button>'), true);
  assert.deepEqual(run.auditModel, run.before);
  const unsafe = fixture({ kind: 'element', dataUrl: 'https://example.test/image.png' }); unsafe.render();
  assert.equal(descendants(unsafe.list).some(node => node.tagName === 'img'), false);
});

test('an unavailable full-page anchor never produces a broken or external link', () => {
  const run = fixture({ anchor: null }); run.render();
  const nodes = descendants(run.list);
  assert.equal(nodes.some(node => node.tagName === 'a' || node.tagName === 'img'), false);
  assert.equal(nodes.some(node => /Captura completa indisponível/u.test(node.textContent)), true);
});

test('review bootstrap correlates annex anchors with the same sorted ReportView evidence', () => {
  assert.match(source, /evidenceAnchorById\s*=\s*new Map\(view\.technicalEvidence\.map\(/u);
  assert.match(source, /`report-evidence-\$\{index \+ 1\}`/u);
});
