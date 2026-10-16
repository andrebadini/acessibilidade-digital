import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isSafeEvidenceImageUrl } from '../../src/review/review-state.js';
import * as layReview from '../../src/core/report/lay-review.js';
import * as evidenceCrop from '../../src/core/report/evidence-crop.js';
import { EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND } from '../../src/core/report/evidence-highlight.js';
import { GUIDED_REVIEW_TREATMENT_V1 } from '../../src/core/report/evidence-treatment.js';
import { TEST_PNG, TEST_PNG_HASH } from '../report/annotation-map-fixture.js';

// O cartão da revisão guiada mostra o elemento por inteiro: a miniatura guardada quando existe e, sem
// ela, o recorte da captura da página inteira na região do elemento — nunca uma caixa adivinhada.
const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('const layState = {'), source.indexOf('\nasync function start()'));

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.classList = { toggle() {}, contains: () => false, add() {} }; }
  get firstChild() { return this.children[0]; }
  append(...children) { this.children.push(...children); }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const CLIP = Object.freeze({ x: 0, y: 0, width: 400, height: 300 });
const SEGMENT = Object.freeze({
  segmentId: 'ev-map-segment-1', index: 1, count: 1, role: 'image', sourceCssClip: CLIP,
  width: 800, height: 600, dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
});
const ANNOTATION = Object.freeze({
  number: 1, nodeId: 'n-1', sourceRect: { x: 100, y: 60, width: 80, height: 20 },
  marker: { x: 0.5, y: 0.5, size: 28, leaderX: 0.5, leaderY: 0.5 },
});

function mapEvidence({ annotations = [ANNOTATION] } = {}) {
  return {
    evidenceId: 'ev-map', pageId: 'page-1', kind: 'announcement-map', state: 'derived', fullPageEvidenceId: 'ev-full',
    derivation: {
      type: 'annotated-announcement-map',
      geometry: {
        coordinateSpace: 'document-css-px', sourceCssSize: { width: 400, height: 300 }, sourcePixelSize: { width: 800, height: 600 },
        scaleX: 2, scaleY: 2, deviceScaleFactor: 2, annotations,
      },
    },
    segments: [SEGMENT], legend: [], hash: 'a'.repeat(64),
  };
}

function instanceModel({ evidence = [mapEvidence()] } = {}) {
  return {
    auditId: 'audit-1', timezone: 'America/Cuiaba', reviewDecisions: [],
    occurrences: [{
      occurrenceId: 'occ-img', itemId: '5.2.1', pageId: 'page-1', outcome: 'cantTell', mode: 'assisted',
      target: { nodeId: 'n-1' }, evidenceRefs: ['ev-full'], source: { engine: 'audita-core', ruleId: 'content-image-alternative' },
      ruleId: 'content-image-alternative',
    }],
    manualReview: [{ occurrenceId: 'occ-img', itemId: '5.2.1', ruleId: 'content-image-alternative', mode: 'assisted', status: 'unanswered' }],
    itemResults: [{ id: '5.2.1', title: 'Texto alternativo para imagens de conteúdo', classification: 'requirement', printedId: '5.2.1', outcome: 'cantTell' }],
    evidence: [{ evidenceId: 'ev-full', kind: 'full-page', state: 'pristine', dataUrl: TEST_PNG, metadata: { width: 400, height: 300 }, hash: TEST_PNG_HASH }, ...evidence],
    ruleResults: [{ ruleId: 'content-image-alternative', targets: [{ nodeId: 'n-1', data: { reason: 'unknown-image-purpose' } }] }],
  };
}

function render(model) {
  const auditModel = model;
  const before = structuredClone(auditModel);
  const context = {
    ...layReview, ...evidenceCrop, EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND, GUIDED_REVIEW_TREATMENT_V1, auditModel,
    document: {
      createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag),
      createTextNode: text => ({ textContent: text }), body: new Element('body'),
    },
    REVIEW_CARD_LIMIT: 40, reportSessionState: 'result', evaluator: { value: '' }, status: {}, list: new Element('div'),
    reportOccurrence: () => true,
    modelLookups: value => ({ evidence: value?.evidence ?? [] }),
    isSafeEvidenceImageUrl,
    chrome: { runtime: { getURL: () => 'chrome-extension://extension/' } },
  };
  const api = runInNewContext(`${renderSource}\n({ renderCardNode, plan: () => buildLayReviewPlan(auditModel) });`, context);
  const card = api.plan().find(value => value.elementLevel);
  return { node: api.renderCardNode(card), card, auditModel, before };
}

function descendants(root) { return (root.children ?? []).flatMap(child => [child, ...descendants(child)]); }
function classNames(root) { return descendants(root).map(node => String(node.className ?? '')); }
function texts(root) { return descendants(root).map(node => node.textContent).filter(Boolean).join(' '); }

test('sem miniatura do elemento, o cartão mostra o recorte da captura com o contorno da pergunta', () => {
  const run = render(instanceModel());
  assert.equal(run.card.evidence, null, 'a auditoria não guardou miniatura deste elemento');
  const svg = descendants(run.node).find(node => node.tagName === 'svg');
  assert.ok(svg, 'o cartão mostra a imagem do elemento');
  assert.equal(svg.attributes.role, 'img');
  assert.match(svg.attributes['aria-label'], /Recorte da captura da página inteira, na região do elemento desta pergunta\./u);
  assert.match(svg.attributes['aria-label'], /Contorno vermelho: o elemento desta pergunta\./u);
  // A janela do recorte é o `viewBox`: 176,96 = 200,120 menos a folga de 24 px de imagem.
  assert.equal(svg.attributes.viewBox, '176 96 208 88');
  const shapes = descendants(svg);
  assert.ok(shapes.some(node => node.attributes.class === 'evidence-highlight evidence-highlight--target'),
    'o contorno vermelho do cartão é desenhado sobre a imagem');
  assert.ok(shapes.some(node => node.attributes.class === 'evidence-spotlight' && node.attributes['fill-rule'] === 'evenodd'));
  assert.ok(shapes.some(node => node.attributes.class === 'evidence-halo'));
  const caption = descendants(run.node).find(node => node.tagName === 'figcaption');
  assert.equal(caption.textContent, `Contorno vermelho: o elemento desta pergunta. O restante da imagem aparece escurecido só como contexto. Recorte tirado da captura da página inteira desta auditoria.`);
  assert.match(texts(run.node), /Clique na imagem para ver o recorte ampliado\./u);
  assert.ok(classNames(run.node).includes('lay-crop-zoom'), 'a imagem amplia ao clique');
  assert.equal(classNames(run.node).includes('lay-locate-note'), false, 'com imagem, o cartão não fala em falta de imagem');
  assert.deepEqual(run.auditModel, run.before, 'a leitura do modelo não altera a auditoria');
});

test('sem imagem guardada para o elemento, o cartão diz isso e aponta o destaque ao vivo', () => {
  const run = render(instanceModel({ evidence: [] }));
  assert.equal(descendants(run.node).some(node => node.tagName === 'svg'), false);
  assert.equal(classNames(run.node).includes('lay-locate-note'), true);
  assert.match(texts(run.node), /Esta auditoria não guardou imagem deste elemento\./u);
  assert.match(texts(run.node), /Use “Mostrar na página” para vê-lo destacado na página auditada\./u);
});

test('o recorte do cartão usa o mapa certo quando o elemento está em outro mapa', () => {
  const run = render(instanceModel({ evidence: [mapEvidence({ annotations: [] })] }));
  assert.equal(descendants(run.node).some(node => node.tagName === 'svg'), false);
  assert.match(texts(run.node), /Esta auditoria não guardou imagem deste elemento\./u);
});
