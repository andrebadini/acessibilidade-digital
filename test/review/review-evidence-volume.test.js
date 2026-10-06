import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isSafeEvidenceImageUrl } from '../../src/review/review-state.js';
import * as layReview from '../../src/core/report/lay-review.js';

// Executa o renderizador real dos cartões da revisão guiada, sem iniciar a sessão do Chrome.
const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const uiStart = source.indexOf('const layState = {');
const uiEnd = source.indexOf('\nasync function start()');
const renderSource = source.slice(uiStart, uiEnd);

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.classList = { toggle() {}, contains: () => false, add() {} }; }
  append(...children) { this.children.push(...children); }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1l8AAAAASUVORK5CYII=';

function model({ pageLevelCount = 0, dataUrl = png } = {}) {
  const occurrences = [{ occurrenceId: 'occ-img', itemId: '5.2.1', pageId: 'page-1', outcome: 'cantTell', mode: 'assisted',
    target: { nodeId: 'n-1' }, evidenceRefs: ['ev-full', 'ev-img'], source: { engine: 'audita-core', ruleId: 'content-image-alternative' }, ruleId: 'content-image-alternative' }];
  const manualReview = [{ occurrenceId: 'occ-img', itemId: '5.2.1', ruleId: 'content-image-alternative', mode: 'assisted', status: 'unanswered' }];
  for (let index = 0; index < pageLevelCount; index += 1) {
    const id = `occ-page-${index}`;
    occurrences.push({ occurrenceId: id, itemId: '5.13.1', pageId: `page-${index + 2}`, outcome: 'cantTell', mode: 'assisted',
      target: { nodeId: null }, evidenceRefs: ['ev-full'], source: { engine: 'audita-core', ruleId: 'page-title' }, ruleId: 'page-title' });
    manualReview.push({ occurrenceId: id, itemId: '5.13.1', ruleId: 'page-title', mode: 'assisted', status: 'unanswered' });
  }
  return {
    auditId: 'audit-1', timezone: 'America/Cuiaba', occurrences, manualReview, reviewDecisions: [],
    itemResults: [
      { id: '5.2.1', title: 'Texto alternativo para imagens de conteúdo', classification: 'requirement', printedId: '5.2.1', outcome: 'cantTell' },
      { id: '5.13.1', title: 'Título da página', classification: 'requirement', printedId: '5.13.1', outcome: 'cantTell' },
    ],
    evidence: [
      { evidenceId: 'ev-full', kind: 'full-page', dataUrl: png },
      { evidenceId: 'ev-img', kind: 'element', nodeId: 'n-1', dataUrl, snippet: '<img width="20">', accessibility: { role: 'image', name: '' } },
    ],
    ruleResults: [{ ruleId: 'content-image-alternative', targets: [{ nodeId: 'n-1', data: { reason: 'unknown-image-purpose' } }] }],
  };
}

function fixture(options) {
  const auditModel = model(options);
  const before = structuredClone(auditModel);
  let validations = 0;
  const context = {
    ...layReview, auditModel, document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    REVIEW_CARD_LIMIT: 40, reportSessionState: 'result', evaluator: { value: '' }, status: {}, list: new Element('div'),
    reportOccurrence: () => true,
    isSafeEvidenceImageUrl(value, base) { validations += 1; return isSafeEvidenceImageUrl(value, base); },
    chrome: { runtime: { getURL: () => 'chrome-extension://extension/' } },
  };
  const api = runInNewContext(`${renderSource}\n({ renderCardNode, plan: () => buildLayReviewPlan(auditModel) });`, context);
  return { api, auditModel, before, get validations() { return validations; } };
}

function descendants(root) { return (root.children ?? []).flatMap(child => [child, ...descendants(child)]); }

test('guided review cards start collapsed, ask in plain words and offer the four lay answers', () => {
  const run = fixture({ pageLevelCount: 1 });
  const plan = run.api.plan();
  const pageCard = plan.find(card => !card.elementLevel);
  const node = run.api.renderCardNode(pageCard);
  assert.equal(node.tagName, 'details');
  assert.notEqual(node.open, true);
  const text = descendants(node).map(child => child.textContent).join(' ');
  assert.match(text, /aba do navegador/u);
  assert.match(text, /Como verificar/u);
  const answers = descendants(node).filter(child => child.tagName === 'button').map(child => child.textContent);
  for (const label of ['Sim', 'Não', 'Não consegui verificar', 'Não existe nesta página', 'Pular revisão por enquanto']) {
    assert.ok(answers.includes(label), label);
  }
  assert.deepEqual(run.auditModel, run.before);
});

test('many page-level cards never copy or decode the full-page capture', () => {
  const run = fixture({ pageLevelCount: 3000 });
  const plan = run.api.plan();
  assert.equal(plan.filter(card => !card.elementLevel).length, 3000);
  const nodes = plan.filter(card => !card.elementLevel).flatMap(card => descendants(run.api.renderCardNode(card)));
  assert.equal(nodes.filter(node => node.tagName === 'img').length, 0);
  assert.equal(run.validations, 0);
  assert.deepEqual(run.auditModel, run.before);
});

test('element thumbnails remain local and validated, and image cards offer the purpose question', () => {
  const run = fixture();
  const card = run.api.plan().find(value => value.elementLevel);
  assert.equal(card.imageCard, true);
  const nodes = descendants(run.api.renderCardNode(card));
  const images = nodes.filter(node => node.tagName === 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0].src, png);
  assert.match(images[0].alt, /imagem sem nome/u);
  assert.equal(run.validations, 1);
  assert.ok(nodes.some(node => node.textContent === 'Para que serve esta imagem?'));
  assert.ok(nodes.some(node => /não consegue saber sozinha/u.test(node.textContent)), 'a pista do motor aparece em linguagem simples');
  assert.equal(nodes.some(node => node.tagName === 'code'), false, 'o cartão leigo não mostra código');
  const unsafe = fixture({ dataUrl: 'https://example.test/image.png' });
  const unsafeCard = unsafe.api.plan().find(value => value.elementLevel);
  assert.equal(descendants(unsafe.api.renderCardNode(unsafeCard)).some(node => node.tagName === 'img'), false);
});

test('review bootstrap correlates annex anchors with the same sorted ReportView evidence', () => {
  assert.match(source, /evidenceAnchorById\s*=\s*new Map\(view\.technicalEvidence\.map\(/u);
  assert.match(source, /`report-evidence-\$\{index \+ 1\}`/u);
});
