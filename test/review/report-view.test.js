import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { projectOccurrenceEvidencePreviews } from '../../src/core/report/evidence-treatment.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { canonicalCoreRuleSummary } from '../../src/core/report/text-policy.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import { buildCompleteReportSummary, buildPanelSummary } from '../../src/panel/panel-summary.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildReportView, projectExecutive, renderReportView, updateReportHighlightAction } from '../../src/review/report-view.js';
import { readerMapPresentation } from '../../src/core/report/reader-map-presentation.js';
import { EXPORT_FORMATS_V1 } from '../../src/export/report-export.js';
import { createAnnotationMapFixture, createPristineMapSource, TEST_PNG } from '../report/annotation-map-fixture.js';

const FULL_PAGE_CAPTURE_OMITTED_MESSAGE = 'A captura integral e o mapa anotado foram omitidos pela política; miniaturas de elementos permaneceram permitidas.';
const FULL_PAGE_CAPTURE_OMITTED_LIMITATION = `FULL_PAGE_CAPTURE_OMITTED: ${FULL_PAGE_CAPTURE_OMITTED_MESSAGE}`;
const ATTACHED_COPY_RELOADED_MESSAGE = 'A auditoria foi executada em uma cópia temporária recarregada da URL da aba escolhida; alterações não salvas e estado mantido apenas em memória na aba original não foram observados.';
const ATTACHED_COPY_EVIDENCE_ONLY_MESSAGE = 'A página foi avaliada em uma cópia temporária já removida. O destaque ao vivo não está disponível; consulte as capturas e os seletores registrados no momento da auditoria.';
const ATTACHED_COPY_RETURN_MESSAGE = 'Retorno e destaque na aba original indisponíveis: a auditoria usou uma cópia temporária e não alterou a aba original.';

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = document; this.children = [];
    this.attributes = new Map(); this.dataset = {}; this.listeners = new Map(); this.hidden = false;
    this._text = ''; this.parentNode = null;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { const values = this.listeners.get(type) ?? []; values.push(listener); this.listeners.set(type, values); }
  click() { for (const listener of this.listeners.get('click') ?? []) listener({ currentTarget: this }); }
  querySelectorAll(selector) {
    const output = [];
    const visit = node => { for (const child of node.children) { if (matches(child, selector)) output.push(child); visit(child); } };
    visit(this); return output;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class Document {
  createElement(tag) { return new Element(tag, this); }
  createElementNS(_namespace, tag) { return new Element(tag, this); }
}

function matches(node, selector) {
  const tag = selector.match(/^[a-z][a-z0-9-]*/iu)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const match of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/gu)) {
    const value = node.getAttribute(match[1]);
    if (value === null || (match[2] !== undefined && value !== match[2])) return false;
  }
  return true;
}

async function fixture({ mutateDraft } = {}) {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  const prepared = mutateDraft?.(draft) ?? draft;
  prepared.integrity.canonicalModelHash = 'pending';
  prepared.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(prepared, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.0.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/151.0.0.0',
  });
  const checkpoint = {
    version: 1, auditId: model.auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [
        { ruleId: 'focus-fully-visible', outcome: 'passed' },
        { ruleId: 'keyboard-focus-trap', outcome: 'untested' },
      ],
    })),
  };
  const summary = await buildPanelSummary({ model, executionCheckpoint: checkpoint, inventory });
  return { model, summary, checkpoint, inventory };
}

function expandManualReviewOccurrences(draft, count) {
  for (const ruleId of ['focus-visible', 'focus-order']) {
    const rule = draft.ruleResults.find(value => value.ruleId === ruleId);
    rule.outcome = 'inapplicable';
    rule.targets = [];
    rule.summary = canonicalCoreRuleSummary(ruleId, 'inapplicable');
    rule.limitations = [];
    for (const itemId of rule.nbrItems) {
      draft.itemResults.find(value => value.id === itemId).outcome = 'inapplicable';
    }
  }
  const source = SAMPLE_AUDIT.occurrences.find(value => value.source.engine === 'audita-manual-review');
  const review = SAMPLE_AUDIT.manualReview.find(value => value.occurrenceId === source.occurrenceId);
  draft.occurrences = Array.from({ length: count }, (_value, index) => ({
    ...structuredClone(source), occurrenceId: `occ-report-complete-${String(index).padStart(3, '0')}`,
  }));
  draft.manualReview = draft.occurrences.map(occurrence => ({
    ...structuredClone(review), occurrenceId: occurrence.occurrenceId,
  }));
  draft.reviewDecisions = [];
}

async function readerMapFixture(status = 'complete', preview = 'Salvar & continuar <agora>, botão') {
  const map = await createAnnotationMapFixture({ status, preview });
  return fixture({ mutateDraft(draft) {
    draft.evidence[0] = createPristineMapSource();
    draft.evidence.push(map);
    if (status === 'partial') {
      const diagnostic = {
        code: 'ANNOTATION_MAP_PARTIAL', message: 'O mapa visual foi gerado com cobertura parcial e limitações explícitas.',
        at: draft.pages[0].timestamps.endedAt, recoverable: true,
      };
      draft.pages[0].diagnostics.push(diagnostic);
      draft.session.diagnostics.push({ ...diagnostic });
    }
    return draft;
  } });
}

test('evidence cards display page provenance and distinguish media URL and uncaptured individual time', async () => {
  const { model, summary } = await fixture({ mutateDraft(draft) {
    draft.evidence.find(item => item.evidenceId === 'ev-control').mediaUrl = 'https://media.test/a&b';
  } });
  const before = JSON.stringify(model);
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const page = model.pages.find(page => page.pageId === 'page-1');
  for (const selector of ['[data-report-evidence="ev-control"]', '[data-report-occurrence-evidence="ev-control"]']) {
    const card = root.querySelector(selector);
    assert.ok(card.textContent.includes(`URL da página observada: ${page.finalUrl}`));
    assert.ok(card.textContent.includes(`Período observado da página: ${page.timestamps.startedAt} – ${page.timestamps.endedAt}`));
    assert.ok(card.textContent.includes('Instante individual da captura: não registrado'));
    assert.ok(card.textContent.includes('URL da mídia: https://media.test/a&b'));
  }
  const html = renderHtmlReport(model, { reportView: view });
  for (const marker of ['data-report-evidence="ev-control"', 'data-report-occurrence-evidence="ev-control"']) {
    const section = html.slice(html.indexOf(marker)).split(/<\/(?:article|section)>/u)[0];
    assert.ok(section.includes(`URL da página observada:</strong> ${page.finalUrl}`));
    assert.ok(section.includes(`Período observado da página:</strong> ${page.timestamps.startedAt} – ${page.timestamps.endedAt}`));
    assert.ok(section.includes('Instante individual da captura:</strong> não registrado'));
    assert.ok(section.includes('URL da mídia:</strong> https://media.test/a&amp;b'));
    assert.equal(section.includes('https://media.test/a&b'), false);
  }
  assert.equal(JSON.stringify(model), before);
});

test('the interactive reader map displays the derived PNG, numbered full announcement and source provenance', async () => {
  const { model, summary } = await readerMapFixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const before = JSON.stringify(model);
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const card = root.querySelector('[data-announcement-map-page="page-1"]');
  assert.ok(card, 'the reader map must render as a page-level visual, not just an artifact ID');
  assert.equal(card.getAttribute('data-map-status'), 'complete');
  const image = card.querySelector('img[data-map-segment-image]');
  assert.equal(image?.getAttribute('src'), TEST_PNG);
  assert.match(image?.getAttribute('alt') ?? '', /Segmento 1 de 1.*marcador 1/u);
  const entry = card.querySelector('li[data-map-marker="1"]');
  assert.equal(entry?.getAttribute('value'), '1');
  assert.ok(entry.textContent.includes('Salvar & continuar <agora>, botão'));
  assert.match(entry.textContent, /segmento 1/u);
  const provenance = card.querySelector('details[data-map-provenance]');
  assert.ok(provenance.textContent.includes(view.readerMaps[0].hash));
  assert.ok(provenance.textContent.includes(view.readerMaps[0].derivation.sourceHash));
  assert.match(card.textContent, /1 de 1 elementos elegíveis/u);
  assert.equal(card.querySelectorAll('script').length, 0);
  assert.equal(JSON.stringify(model), before, 'presenting the map must not change original evidence or normative identity');
});

test('the exported ReportView includes map pixels and escaped untruncated legend for HTML and PDF', async () => {
  const preview = `Salvar & continuar <agora>, botão ${'descrição completa '.repeat(100)}`.trim();
  const { model, summary } = await readerMapFixture('partial', preview);
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const html = renderHtmlReport(model, { reportView: view });
  assert.match(html, /data-announcement-map-page="page-1"/u);
  assert.match(html, /data-map-status="partial"/u);
  assert.match(html, /data-map-segment-image/u);
  assert.match(html, /data-map-marker="1"/u);
  assert.ok(html.includes(TEST_PNG));
  assert.ok(html.includes(preview.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  assert.ok(html.includes(view.readerMaps[0].hash));
  assert.ok(html.includes(view.readerMaps[0].derivation.sourceHash));
  assert.match(html, /cobertura parcial/u);
  assert.match(html, /1 contextos de frame/u);
  assert.doesNotMatch(html, /<agora>/u);
});

test('the interactive and exported map legends expose bidi controls without changing the source evidence', async () => {
  const preview = 'Salvar \u202Etexto\u202C, botão';
  const { model, summary } = await readerMapFixture('complete', preview);
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const before = JSON.stringify(model);
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const legend = root.querySelector('li[data-map-marker="1"]');
  assert.ok(legend.textContent.includes('Salvar ⟦U+202E⟧texto⟦U+202C⟧, botão'));
  assert.doesNotMatch(legend.textContent, /[\u202E\u202C]/u);
  const html = renderHtmlReport(model, { reportView: view });
  assert.ok(html.includes('Salvar ⟦U+202E⟧texto⟦U+202C⟧, botão'));
  assert.equal(view.readerMaps[0].legend[0].announcementPreview, preview);
  assert.equal(JSON.stringify(model), before);
});

test('reader map absence and empty selection are explicit without inventing an image or conformity', async () => {
  for (const [setup, status] of [[fixture, 'absent'], [() => readerMapFixture('empty'), 'empty']]) {
    const { model, summary } = await setup();
    const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
    const root = renderReportView({ view, document: new Document(), onExport() {} });
    const card = root.querySelector('[data-announcement-map-page="page-1"]');
    assert.equal(card?.getAttribute('data-map-status'), status);
    assert.equal(card.querySelectorAll('img').length, 0);
    assert.match(card.textContent, status === 'absent' ? /Mapa não coletado/u : /não significa conformidade/u);
    const html = renderHtmlReport(model, { reportView: view });
    assert.ok(html.includes(`data-map-status="${status}"`));
  }
});

test('executive projection preserves canonical page order for two-digit map page ordinals', async () => {
  const { model, summary } = await fixture();
  const orderedPages = Array.from({ length: 12 }, (_, index) => ({
    ...model.pages[0], pageId: `page-${index + 1}`,
    finalUrl: `https://example.test/page-${index + 1}`,
  }));
  const projected = projectExecutive({ ...model, pages: orderedPages }, summary);
  assert.deepEqual(projected.pages.map(page => page.pageId), [
    'page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6',
    'page-7', 'page-8', 'page-9', 'page-10', 'page-11', 'page-12',
  ]);
  const cards = readerMapPresentation(projected.pages, []);
  assert.equal(cards[1].title, 'Página 2 — page-2');
  assert.equal(cards[9].title, 'Página 10 — page-10');
  assert.equal(orderedPages[1].pageId, 'page-2');
});

function retainElementEvidenceWithoutFullPage(draft) {
  const diagnostic = {
    code: 'FULL_PAGE_CAPTURE_OMITTED', message: FULL_PAGE_CAPTURE_OMITTED_MESSAGE,
    at: '2026-08-26T14:00:30.000Z', recoverable: true,
  };
  draft.evidence = draft.evidence.filter(artifact => artifact.kind === 'element').map(artifact => {
    const retained = { ...artifact };
    delete retained.fullPageEvidenceId;
    return retained;
  });
  const retainedEvidenceIds = new Set(draft.evidence.map(artifact => artifact.evidenceId));
  for (const occurrence of draft.occurrences) {
    occurrence.evidenceRefs = occurrence.evidenceRefs.filter(id => retainedEvidenceIds.has(id));
    occurrence.evidenceIds = occurrence.evidenceIds.filter(id => retainedEvidenceIds.has(id));
  }
  draft.evidenceStateCount = 0;
  draft.reproducibility.capturedStateCount = 0;
  draft.pages[0].status = 'complete';
  draft.pages[0].diagnostics = [structuredClone(diagnostic)];
  draft.session = { status: 'complete', partial: false, diagnostics: [diagnostic] };
  draft.limitations = [
    'O relatório cobre somente uma página e o estado observado; não constitui declaração de conformidade do site inteiro.',
    FULL_PAGE_CAPTURE_OMITTED_MESSAGE,
  ];
}

function addEditorialOccurrenceWithoutAbnt(draft) {
  draft.methodology.supplementalRuleCount += 1;
  draft.methodology.ruleCount += 1;
  draft.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-editorial', selectorHint: '', message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  draft.occurrences.push({
    occurrenceId: 'occ-editorial', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-editorial', selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
    mode: 'automated', nodeId: 'n-editorial', evidenceIds: [],
    justification: 'Há conteúdo provisório inequívoco na página.',
  });
}

test('ReportViewV1 owns exact frozen copies and the canonical four-format order', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({
    model, summary, modelRevision: 3, modelHash: model.integrity.canonicalModelHash,
  });
  assert.deepEqual(Object.keys(view), [
    'version', 'auditId', 'modelRevision', 'modelHash', 'filters', 'executive', 'issues',
    'technicalEvidence', 'readerMaps', 'methodology', 'exports', 'matrix',
  ]);
  assert.deepEqual(Object.keys(view.filters), ['impact', 'wcag', 'result', 'classification', 'page', 'engine', 'abnt']);
  assert.deepEqual(Object.keys(view.issues), ['failed', 'alerts', 'humanReview', 'passed']);
  assert.equal(view.matrix.length, 146);
  assert.deepEqual(view.exports.formats, EXPORT_FORMATS_V1);
  assert.notStrictEqual(view.executive.counts, summary.counts);
  assert.notStrictEqual(view.matrix[0], model.itemResults[0]);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.matrix), true);
  assert.equal(Object.isFrozen(view.matrix[0]), true);
  assert.ok(view.executive.limitations.includes(
    'DYNAMIC_PROBES_INCOMPLETE: As verificações dinâmicas atingiram o tempo limite.',
  ));
  const failed = view.issues.failed[0];
  assert.deepEqual(failed.plainLanguage, {
    impact: 'Esta barreira pode dificultar ou impedir a tarefa para pessoas que dependem deste requisito de acessibilidade.',
    observed: failed.occurrences.map(occurrence => occurrence.justification),
    correction: 'Revise o elemento e aplique a orientação técnica antes de executar uma nova auditoria.',
  });
  assert.equal(Object.isFrozen(failed.plainLanguage), true);
  assert.equal(Object.isFrozen(failed.plainLanguage.observed), true);
  const humanReview = view.issues.humanReview[0];
  const passed = view.issues.passed[0];
  assert.match(humanReview.plainLanguage.impact, /ainda não há conclusão/iu);
  assert.equal(humanReview.plainLanguage.correction,
    'Realize a verificação humana indicada, registre as condições observadas e conclua se o requisito foi atendido, não atendido ou permaneceu inconclusivo.');
  assert.equal(passed.plainLanguage.correction,
    'Nenhuma correção é indicada para este resultado positivo no escopo observado.');
  assert.doesNotMatch(passed.plainLanguage.correction, /corrija|revise|aplique/iu);
  const observed = Object.values(view.issues).flatMap(cards => cards.map(card => card.plainLanguage.observed));
  assert.doesNotMatch(JSON.stringify(observed), /top-document|mixed|page-or-process/u);
});

test('complete report summary preserves every occurrence beyond the bounded interactive panel projection', async () => {
  const { model, summary: panelSummary, checkpoint, inventory } = await fixture({
    mutateDraft(draft) { expandManualReviewOccurrences(draft, 256); },
  });
  const completeSummary = await buildCompleteReportSummary({
    model, executionCheckpoint: checkpoint, inventory,
  });
  const view = buildReportView({
    model, summary: completeSummary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  });
  const panelOccurrences = Object.values(panelSummary.groups).flatMap(cards =>
    cards.flatMap(card => card.occurrenceIds));
  const reportOccurrences = Object.values(view.issues).flatMap(cards =>
    cards.flatMap(card => card.occurrences));

  assert.equal(panelOccurrences.length <= 64, true);
  assert.equal(reportOccurrences.length, 256);
  assert.equal(new Set(reportOccurrences.map(occurrence => occurrence.occurrenceId)).size, 256);
  assert.equal(completeSummary.limitations.codes.some(value => /painel.+relat.rio completo/iu.test(value)), false);
});

test('ReportViewV1 offers the three WCAG conformance levels instead of numeric criteria', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  });

  assert.deepEqual(view.filters.wcag, [
    { id: 'A', count: 1 },
    { id: 'AA', count: 3 },
    { id: 'AAA', count: 2 },
  ]);
  assert.equal(view.filters.wcag.every(option => !/^\d+(?:\.\d+)+$/u.test(option.id)), true);
});

test('ReportViewV1 keeps qualified remediation and uses a prudent alert fallback', async () => {
  const canonicalRemediation = 'Forneça um indicador de foco visível.';
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      const coreRule = draft.ruleResults.find(rule => rule.ruleId === 'focus-visible');
      coreRule.targets = [{
        nodeId: 'n-1', message: canonicalRemediation,
        data: { reason: 'focus-indicator-not-visible' },
      }];
      addEditorialOccurrenceWithoutAbnt(draft);
    },
  });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  assert.equal(view.issues.failed[0].remediation, canonicalRemediation);
  assert.equal(view.issues.failed[0].plainLanguage.correction, canonicalRemediation);
  assert.equal(view.issues.alerts[0].plainLanguage.correction,
    'Revise o alerta no contexto da página e, se a barreira for confirmada, aplique a orientação técnica antes de repetir a auditoria.');
});

test('ReportViewV1 rejects foreign summary, revision/hash drift and hostile inputs without side effects', async () => {
  const { model, summary } = await fixture();
  const base = { model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash };
  assert.throws(() => buildReportView({ ...base, summary: { ...summary, auditId: 'foreign' } }), /REPORT_VIEW_DENIED/u);
  assert.throws(() => buildReportView({ ...base, modelRevision: 0 }), /REPORT_VIEW_DENIED/u);
  assert.throws(() => buildReportView({ ...base, modelHash: '0'.repeat(64) }), /REPORT_VIEW_DENIED/u);
  let reads = 0;
  const hostile = new Proxy({}, { ownKeys() { reads += 1; throw new Error('private'); } });
  assert.throws(() => buildReportView({ ...base, summary: hostile }), /REPORT_VIEW_DENIED/u);
  assert.equal(reads <= 1, true);
});

test('live report puts the decision summary before compact navigation and exposes one export action', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  let exportCalls = 0;
  const root = renderReportView({ view, document: new Document(), onExport() { exportCalls += 1; } });
  assert.equal(root.querySelectorAll('h2').length, 7);
  assert.deepEqual(root.querySelectorAll('h2').map(node => node.textContent), [
    'Sumário executivo e limitações críticas',
    'Cobertura e quatro grupos de resultado',
    'Não conformidades priorizadas',
    'Revisões humanas pendentes',
    'Mapas de anúncios',
    'Matriz completa dos 146 itens',
    'Metodologia, fontes, integridade, evidências técnicas e anexos',
  ]);
  assert.equal(root.querySelectorAll('[role="status"][aria-live="polite"]').length, 1);
  const liveStatus = root.querySelector('[role="status"]');
  assert.equal(liveStatus.parentNode.getAttribute('class'), 'report-filters');
  assert.match(liveStatus.textContent, /verificações visíveis/iu);
  const positiveMetric = root.querySelector('[data-report-metric="passed"]');
  assert.ok(positiveMetric);
  assert.match(positiveMetric.textContent, /1 verificação.*0 ocorrências/iu);
  const navigation = root.querySelector('[data-report-navigation]');
  assert.ok(navigation);
  const firstSection = root.querySelector('[data-report-section="1"]');
  const secondSection = root.querySelector('[data-report-section="2"]');
  assert.ok(firstSection);
  assert.ok(secondSection);
  assert.equal(root.children.indexOf(firstSection) < root.children.indexOf(navigation), true);
  assert.equal(root.children.indexOf(navigation) < root.children.indexOf(secondSection), true);
  assert.deepEqual(navigation.querySelectorAll('a').map(link => link.getAttribute('href')), [
    '#report-section-1', '#report-section-2', '#report-section-3', '#report-section-4',
    '#report-section-5', '#report-section-6', '#report-section-7',
  ]);
  assert.deepEqual(navigation.querySelectorAll('a').map(link => link.textContent), [
    'Sumário', 'Resultados', 'Não conformidades', 'Revisões humanas', 'Anúncios',
    'Matriz ABNT', 'Metodologia e evidências',
  ]);
  assert.ok(firstSection.querySelector('[data-report-outcome]'));
  assert.match(firstSection.querySelector('[data-report-outcome]').textContent, /Estado|conclu/iu);
  const coverage = firstSection.querySelector('[data-report-coverage]');
  assert.ok(coverage);
  assert.match(coverage.textContent, /Cobertura automática/iu);
  assert.match(coverage.textContent, /não é nota.*certificação/iu);
  const metricGrid = firstSection.querySelector('[data-report-metrics]');
  assert.ok(metricGrid);
  assert.deepEqual(metricGrid.querySelectorAll('[data-report-metric]').map(metric => [
    metric.getAttribute('data-report-metric'), metric.querySelector('[class="metric-value"]')?.textContent,
  ]), [
    ['failed', String(view.executive.counts.errors.checkKeys)],
    ['alerts', String(view.executive.counts.alerts.checkKeys)],
    ['humanReview', String(view.executive.counts.humanReview.checkKeys)],
    ['passed', String(view.executive.counts.positive.checkKeys)],
  ]);
  const limitations = firstSection.querySelector('[data-report-limitations]');
  assert.ok(limitations);
  assert.equal(limitations.getAttribute('open'), null);
  assert.deepEqual(firstSection.children.map(child => {
    if (child.getAttribute('data-report-outcome') !== null) return 'outcome';
    if (child.getAttribute('data-report-coverage') !== null) return 'coverage';
    if (child.getAttribute('data-report-metrics') !== null) return 'metrics';
    if (child.getAttribute('data-report-executive-actions') !== null) return 'actions';
    if (child.getAttribute('data-report-limitations') !== null) return 'limitations';
    return child.tagName.toLowerCase();
  }), ['h2', 'outcome', 'coverage', 'metrics', 'actions', 'limitations']);
  assert.equal(root.querySelectorAll('button[data-report-export]').length, 1);
  assert.equal(firstSection.querySelector('[data-report-executive-actions]').querySelectorAll('button[data-report-export]').length, 1);
  root.querySelector('button[data-report-export]').click();
  assert.equal(exportCalls, 1);
});

test('surfaces no-pixels collection in the visible limitations summary', async () => {
  const { model, summary } = await fixture();
  const view = structuredClone(buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  }));
  view.executive.limitations.push('PIXEL_CAPTURE_OMITTED: Nenhuma captura raster foi coletada no modo sem imagens.');
  const root = renderReportView({ view, document: new Document(), onExport() {} });

  assert.match(root.querySelector('[data-report-limitations]').querySelector('summary').textContent,
    /modo sem imagens.*nenhuma captura raster/iu);
});

test('element-only report discloses the omitted full-page capture in plain language and preserves its technical code in details', async () => {
  const { model, summary } = await fixture({ mutateDraft: retainElementEvidenceWithoutFullPage });
  assert.equal(model.evidence.filter(artifact => artifact.kind === 'full-page').length, 0);
  assert.equal(model.evidence.filter(artifact => artifact.kind === 'element').length > 0, true);
  assert.equal(model.session.diagnostics.some(diagnostic => diagnostic.code === 'FULL_PAGE_CAPTURE_OMITTED'), true);

  const view = buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const limitations = root.querySelector('[data-report-limitations]');

  assert.match(limitations.querySelector('summary').textContent,
    /captura integral omitida.*miniaturas de elementos disponíveis/iu);
  assert.doesNotMatch(limitations.querySelector('summary').textContent, /FULL_PAGE_CAPTURE_OMITTED/u);
  assert.match(limitations.querySelector('ul').textContent, /FULL_PAGE_CAPTURE_OMITTED/u);
});

test('element-only report distinguishes structural element evidence from unavailable PNG thumbnails', async () => {
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      retainElementEvidenceWithoutFullPage(draft);
      for (const artifact of draft.evidence) {
        delete artifact.dataUrl;
        delete artifact.metadata;
      }
    },
  });
  assert.equal(model.evidence.filter(artifact => artifact.kind === 'full-page').length, 0);
  assert.equal(model.evidence.filter(artifact => artifact.kind === 'element').length > 0, true);
  assert.equal(model.evidence.some(artifact => artifact.kind === 'element' && Object.hasOwn(artifact, 'dataUrl')), false);

  const view = buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const limitations = root.querySelector('[data-report-limitations]');

  assert.match(limitations.querySelector('summary').textContent,
    /captura integral omitida.*evidências estruturais de elementos.*sem miniaturas PNG/iu);
  assert.doesNotMatch(limitations.querySelector('summary').textContent, /miniaturas de elementos disponíveis/iu);
  assert.match(limitations.querySelector('ul').textContent, /FULL_PAGE_CAPTURE_OMITTED/u);
});

test('capture summary requires the complete canonical limitation instead of trusting its prefix', async () => {
  const { model, summary } = await fixture();
  const view = structuredClone(buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  }));
  view.technicalEvidence = view.technicalEvidence.filter(artifact => artifact.kind === 'element');
  view.executive.limitations.push(`${FULL_PAGE_CAPTURE_OMITTED_LIMITATION} texto não canônico`);

  const root = renderReportView({ view, document: new Document(), onExport() {} });
  assert.doesNotMatch(root.querySelector('[data-report-limitations]').querySelector('summary').textContent,
    /captura integral omitida/iu);
});

test('renderer keeps filters live-only without mutating the immutable report view', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const before = structuredClone(view);
  const filter = root.querySelector('button[data-report-filter="result"][data-filter-value="failed"]');
  assert.ok(filter);
  filter.click();
  assert.deepEqual(view, before);
  assert.equal(filter.getAttribute('aria-pressed'), 'true');
  const renderedIssues = root.querySelectorAll('[data-report-issue]');
  assert.equal(renderedIssues.some(issue => issue.hidden), true);
  assert.equal(renderedIssues.some(issue => !issue.hidden), true);
  assert.equal(renderedIssues.filter(issue => !issue.hidden).every(issue => issue.getAttribute('data-result') === 'failed'), true);
  assert.match(root.querySelector('[role="status"]').textContent, /filtros não alteram os arquivos exportados/iu);
  filter.click();
  assert.equal(filter.getAttribute('aria-pressed'), 'false');
  assert.equal(renderedIssues.every(issue => !issue.hidden), true);
  assert.equal(root.textContent.includes('estimativa'), true);
  assert.doesNotMatch(root.textContent, /\["page-1","audita-core","keyboard-focus-trap"\]/u);
  assert.match(root.textContent, /Verificação não testada: Armadilha de foco — Página 1\./u);
  assert.doesNotMatch(JSON.stringify(root.dataset), /capability|attempt|revision|lease|tab|window|document/iu);
});

test('live filters expose visible Portuguese labels and apply WCAG levels', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const groups = root.querySelectorAll('.report-filters [role="group"]');

  assert.deepEqual(groups.map(group => group.getAttribute('aria-label')), [
    'Filtrar por impacto',
    'Filtrar por nível WCAG 2.2',
    'Filtrar por tipo de resultado',
    'Filtrar por classificação',
    'Filtrar por página avaliada',
    'Filtrar por origem da verificação',
    'Filtrar por item da ABNT NBR 17225',
  ]);
  assert.deepEqual(groups.map(group => group.querySelector('[data-report-filter-label]').textContent), [
    'Impacto',
    'Nível WCAG 2.2',
    'Tipo de resultado',
    'Classificação',
    'Página avaliada',
    'Origem da verificação',
    'Item ABNT NBR 17225',
  ]);
  const wcagGroup = groups[1];
  assert.deepEqual(wcagGroup.querySelectorAll('button').map(button => button.getAttribute('data-filter-value')), ['A', 'AA', 'AAA']);
  assert.deepEqual(wcagGroup.querySelectorAll('button').map(button => button.textContent), [
    'Nível A (1)', 'Nível AA (3)', 'Nível AAA (2)',
  ]);
  assert.doesNotMatch(wcagGroup.textContent, /\b\d+\.\d+(?:\.\d+)?\b/u);

  wcagGroup.querySelector('button[data-filter-value="AA"]').click();
  const visible = root.querySelectorAll('[data-report-issue]').filter(issue => !issue.hidden);
  assert.equal(visible.length, 3);
  assert.equal(visible.every(issue => issue.getAttribute('data-wcag').split(' ').includes('AA')), true);
});

test('missing ABNT association is explicit in the live report and HTML/PDF source', async () => {
  const { model, summary } = await fixture({ mutateDraft: addEditorialOccurrenceWithoutAbnt });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const alert = root.querySelector('[data-report-issue][data-result="alerts"]');

  assert.ok(alert);
  assert.equal(alert.getAttribute('data-abnt'), '__none__');
  assert.match(alert.querySelector('[data-report-plain-block="normative"]').textContent, /Sem item ABNT associado/u);
  assert.match(alert.querySelector('[data-report-technical]').textContent, /Item ABNT: Sem item ABNT associado\./u);
  assert.doesNotMatch(alert.textContent, /Item ABNT:\s*null|ABNT NBR 17225:\s*(?:\.|sem item\.)/iu);
  const emptyAbntFilter = root.querySelector('button[data-report-filter="abnt"][data-filter-value="__none__"]');
  assert.equal(emptyAbntFilter.textContent, 'Sem item ABNT associado (1)');
  emptyAbntFilter.click();
  assert.deepEqual(root.querySelectorAll('[data-report-issue]').filter(issue => !issue.hidden), [alert]);

  const html = renderHtmlReport(model, { reportView: view });
  assert.match(html, /data-abnt="__none__"/u);
  assert.match(html, /ABNT NBR 17225:<\/strong> Sem item ABNT associado\./u);
  assert.match(html, /Item ABNT:<\/strong> Sem item ABNT associado\./u);
  assert.doesNotMatch(html, /data-abnt=""|Item ABNT:<\/strong> null|ABNT NBR 17225:<\/strong> (?:sem item\.|\.)/iu);

  const standaloneHtml = renderHtmlReport(model);
  assert.match(standaloneHtml, /<option value="__none__">Sem item ABNT associado<\/option>/u);
  assert.match(standaloneHtml, /ABNT NBR 17225:<\/strong> Sem item ABNT associado\./u);
  assert.doesNotMatch(standaloneHtml, /data-abnt-item=""|ABNT NBR 17225:<\/strong> (?:null|\.)/iu);
});

test('live report renders decision-first cards, evidence previews and honest evidence-only navigation', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const firstIssue = root.querySelector('[data-report-issue][data-result="failed"]');
  assert.ok(firstIssue);
  const orderedBlocks = firstIssue.children.map(child => {
    if (child.getAttribute('data-report-issue-heading') !== null) return 'heading';
    if (child.getAttribute('data-report-plain-block') !== null) return child.getAttribute('data-report-plain-block');
    if (child.getAttribute('data-report-evidence-preview') !== null) return 'preview';
    if (child.getAttribute('data-report-live-action') !== null) return 'live-action';
    if (child.getAttribute('data-report-consult-evidence') !== null) return 'consult-evidence';
    if (child.getAttribute('data-report-technical') !== null) return 'technical';
    return 'unexpected';
  });
  assert.deepEqual(orderedBlocks, [
    'heading', 'impact', 'observed', 'correction', 'announcement', 'normative', 'legal',
    'preview', 'live-action', 'consult-evidence', 'technical',
  ]);
  assert.match(firstIssue.querySelector('[data-report-issue-heading]').textContent, /Não atendido neste teste|Não conformidade identificada|Moderado/iu);
  assert.match(firstIssue.querySelector('[data-report-plain-block="impact"]').textContent, /dificultar ou impedir/iu);
  assert.doesNotMatch(firstIssue.querySelector('[data-report-plain-block="observed"]').textContent, /top-document|mixed|page-or-process/u);
  assert.match(firstIssue.querySelector('[data-report-plain-block="correction"]').textContent, /Correção/iu);
  assert.match(firstIssue.querySelector('[data-report-plain-block="announcement"]').textContent, /Nome acessível|anúncio estimado|não é transcrição literal/iu);
  assert.match(firstIssue.querySelector('[data-report-plain-block="normative"]').textContent, /WCAG|ABNT/iu);
  assert.match(firstIssue.querySelector('[data-report-plain-block="legal"]').textContent, /Referência técnica e jurídica qualificada/iu);
  const preview = firstIssue.querySelector('[data-report-evidence-preview]');
  assert.equal(preview.querySelectorAll('img').length, 1);
  assert.equal(preview.querySelectorAll('svg[data-evidence-treatment="failed"]').length, 1);
  assert.equal(preview.querySelectorAll('[data-evidence-kind="element"]').length, 1);
  assert.equal(preview.querySelectorAll('[data-evidence-kind="full-page"]').length, 1);
  assert.equal(firstIssue.querySelectorAll('details').length, 1);
  const technical = firstIssue.querySelector('[data-report-technical]');
  assert.equal(technical.getAttribute('open'), null);
  assert.equal(technical.querySelectorAll('img').length, 0);
  assert.match(technical.textContent, /Resultado original|Resultado consolidado|Contexto técnico|Página|Motor|Regra|Versão|URL|Horário|Seletor|Snippet|Hash|ID|Proveniência/iu);
  assert.match(technical.textContent, /ev-control|ev-full/iu);
  assert.equal(firstIssue.querySelectorAll('img').length, 1);
  assert.equal(firstIssue.querySelector('[data-report-live-action="evidence-only"]').textContent,
    'O destaque ao vivo não está disponível neste relatório. Consulte as capturas registradas no momento da auditoria.');
  assert.equal(firstIssue.querySelector('[data-report-consult-evidence]').getAttribute('href'), '#report-evidence-1');
  assert.equal(root.querySelectorAll('button[data-report-highlight]').length, 0);
  assert.doesNotMatch(root.textContent, /Destacar (?:ao vivo|na página)/iu);
  const positiveIssue = root.querySelector('[data-report-issue][data-result="passed"]');
  assert.match(positiveIssue.querySelector('[data-report-plain-block="correction"]').textContent, /Nenhuma correção é indicada/iu);
  assert.doesNotMatch(positiveIssue.querySelector('[data-report-plain-block="correction"]').textContent, /após a correção/iu);
  assert.equal(root.querySelectorAll('[data-report-evidence]').length, view.technicalEvidence.length);
  assert.deepEqual(root.querySelectorAll('[data-report-evidence]').map(node => node.getAttribute('id')),
    view.technicalEvidence.map((_evidence, index) => `report-evidence-${index + 1}`));
  assert.equal(root.querySelector('[data-report-evidence="ev-full"]').getAttribute('data-evidence-kind'), 'full-page');
  assert.equal(root.querySelectorAll('[id]').some(node => /capability|lease|tab|window|document|chrome/iu.test(node.getAttribute('id'))), false);
  const sources = root.querySelectorAll('[data-official-source]');
  assert.equal(sources.length, 2);
  assert.equal(sources.every(source => source.getAttribute('href') === null && source.getAttribute('src') === null), true);
  assert.equal(root.querySelectorAll('[role="status"][aria-live="polite"]').length, 1);
  const headings = root.querySelectorAll('h3').map(node => node.textContent);
  for (const label of ['Não conformidades', 'Alertas', 'Revisões humanas pendentes', 'Resultados positivos']) {
    assert.equal(headings.includes(label) || headings.some(value => value.startsWith(`${label}:`)), true);
  }
});

test('view-only temporary-copy report explains the removed copy while preserving occurrence evidence', async () => {
  const { model, summary } = await fixture();
  const view = structuredClone(buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  }));
  view.executive.limitations.push(ATTACHED_COPY_RELOADED_MESSAGE);

  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const issue = root.querySelector('[data-report-issue][data-result="failed"]');

  assert.equal(issue.querySelector('[data-report-live-action="evidence-only"]').textContent,
    ATTACHED_COPY_EVIDENCE_ONLY_MESSAGE);
  assert.equal(issue.querySelectorAll('[data-report-highlight-control]').length, 0);
  assert.match(issue.querySelector('[data-report-plain-block="announcement"]').textContent,
    /Nome acessível|Anúncio estimado/iu);
  assert.match(issue.querySelector('[data-report-plain-block="normative"]').textContent, /WCAG 2\.2|ABNT NBR 17225/iu);
  assert.match(issue.querySelector('[data-report-technical]').textContent, /Seletor|Snippet|Hash/iu);
  assert.equal(issue.querySelector('[data-report-evidence-preview]').querySelectorAll('img').length > 0, true);
});

test('report source controls use session state as authority and limitation text only as the view-only reason', async () => {
  const module = await import('../../src/review/report-view.js');
  assert.equal(typeof module.applyReportSourceControls, 'function');
  if (typeof module.applyReportSourceControls !== 'function') return;

  const returnControl = { disabled: false, hidden: false };
  const explanation = { hidden: true, textContent: ATTACHED_COPY_RETURN_MESSAGE };
  module.applyReportSourceControls({
    reportSessionState: 'view-only', limitations: [ATTACHED_COPY_RELOADED_MESSAGE],
    returnControl, explanation,
  });
  assert.deepEqual(returnControl, { disabled: true, hidden: true });
  assert.equal(explanation.hidden, false);
  assert.equal(explanation.textContent, ATTACHED_COPY_RETURN_MESSAGE);

  module.applyReportSourceControls({
    reportSessionState: 'result', limitations: [ATTACHED_COPY_RELOADED_MESSAGE],
    returnControl, explanation,
  });
  assert.deepEqual(returnControl, { disabled: false, hidden: false });
  assert.equal(explanation.hidden, true, 'the model limitation cannot revoke a live session capability');

  module.applyReportSourceControls({
    reportSessionState: 'view-only', limitations: [], returnControl, explanation,
  });
  assert.deepEqual(returnControl, { disabled: true, hidden: false });
  assert.equal(explanation.hidden, true, 'generic view-only reports do not claim that a temporary copy was used');
});

test('live report derives occurrence-specific boxes while preserving the pristine captured evidence', async () => {
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      const elementEvidence = draft.evidence.find(evidence => evidence.kind === 'element');
      elementEvidence.metadata = {
        width: 128,
        height: 88,
        highlightBox: { x: 24, y: 12, width: 80, height: 40, coordinateSpace: 'capture-css-px' },
      };
    },
  });
  const original = model.evidence.find(evidence => evidence.kind === 'element');
  const originalSnapshot = structuredClone(original);
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });

  const failed = root.querySelector('[data-report-issue][data-result="failed"]');
  const failedFigure = failed.querySelector('[data-evidence-kind="element"]');
  const failedVisual = failedFigure.querySelector('svg[data-evidence-treatment="failed"]');
  assert.ok(failedVisual);
  assert.equal(failedVisual.getAttribute('aria-label'), 'Elemento local da evidência ev-control com falha confirmada destacada por moldura vermelha sólida.');
  assert.equal(failedVisual.querySelector('image').getAttribute('href'), original.dataUrl);
  const failedBox = failedVisual.querySelector('rect[data-evidence-highlight="failed"]');
  assert.deepEqual(['x', 'y', 'width', 'height'].map(name => failedBox.getAttribute(name)), ['24', '12', '80', '40']);
  assert.match(failedFigure.querySelector('figcaption').textContent, /✕ Falha confirmada.*moldura vermelha sólida/iu);

  const review = root.querySelector('[data-report-issue][data-result="humanReview"]');
  const reviewFigure = review.querySelector('[data-evidence-kind="element"]');
  const reviewVisual = reviewFigure.querySelector('svg[data-evidence-treatment="review"]');
  assert.ok(reviewVisual);
  assert.equal(reviewVisual.querySelector('image').getAttribute('href'), original.dataUrl);
  const reviewBox = reviewVisual.querySelector('rect[data-evidence-highlight="review"]');
  assert.deepEqual(['x', 'y', 'width', 'height'].map(name => reviewBox.getAttribute(name)), ['24', '12', '80', '40']);
  assert.match(reviewFigure.querySelector('figcaption').textContent, /\? Revisão humana necessária.*moldura âmbar tracejada/iu);

  assert.equal(failed.querySelector('[data-evidence-kind="full-page"]').querySelector('svg'), null);
  assert.equal(root.querySelector('[data-report-evidence="ev-control"]').querySelector('img').getAttribute('src'), original.dataUrl);
  assert.deepEqual(model.evidence.find(evidence => evidence.kind === 'element'), originalSnapshot);

  const html = renderHtmlReport(model, { reportView: view });
  assert.match(html, /<svg class="evidence-media evidence-media--marked"[^>]*data-evidence-treatment="failed"[^>]*aria-label="Elemento local da evidência ev-control com falha confirmada destacada por moldura vermelha sólida\."/u);
  assert.match(html, /<rect class="evidence-highlight evidence-highlight--failed" data-evidence-highlight="failed" x="24" y="12" width="80" height="40" aria-hidden="true"><\/rect>/u);
  assert.match(html, /<svg class="evidence-media evidence-media--marked"[^>]*data-evidence-treatment="review"[^>]*aria-label="Elemento local da evidência ev-control com revisão humana necessária destacada por moldura âmbar tracejada\."/u);
  assert.match(html, /<rect class="evidence-highlight evidence-highlight--review" data-evidence-highlight="review" x="24" y="12" width="80" height="40" aria-hidden="true"><\/rect>/u);
  assert.match(html, /data-report-evidence="ev-control"[^]*?<img class="evidence-media" src="data:image\/png;base64,/u);
  assert.deepEqual(model.evidence.find(evidence => evidence.kind === 'element'), originalSnapshot);
});

test('one consolidated issue marks every correlated element and keeps one full-page context', async () => {
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      const originalEvidence = draft.evidence.find(evidence => evidence.evidenceId === 'ev-control');
      draft.evidence.push({
        ...structuredClone(originalEvidence),
        evidenceId: 'ev-control-2', nodeId: 'n-2', backendNodeId: 42,
        selector: { css: '#cancelar', framePath: [] },
        snippet: '<button id="cancelar" aria-label="Cancelar">Voltar</button>',
        hash: 'sha256-element-sample-2',
        metadata: {
          width: 128, height: 88,
          highlightBox: { x: 12, y: 16, width: 64, height: 36, coordinateSpace: 'capture-css-px' },
        },
        accessibility: {
          ...structuredClone(originalEvidence.accessibility), name: 'Cancelar', visibleText: 'Voltar',
          announcementPreview: 'Cancelar, botão, Volta para a etapa anterior',
        },
      });
      draft.ruleResults.find(rule => rule.ruleId === 'focus-visible').targets.push('n-2');
      const originalOccurrence = draft.occurrences.find(occurrence => occurrence.occurrenceId === 'occ-focus-failed');
      draft.occurrences.push({
        ...structuredClone(originalOccurrence),
        occurrenceId: 'occ-focus-failed-2', nodeId: 'n-2',
        target: { ...structuredClone(originalOccurrence.target), nodeId: 'n-2' },
        accessiblePreview: 'Cancelar, botão, Volta para a etapa anterior',
        evidenceRefs: ['ev-full', 'ev-control-2'], evidenceIds: ['ev-full', 'ev-control-2'],
      });
    },
  });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const issue = view.issues.failed.find(value => value.ruleId === 'focus-visible');
  assert.equal(issue.occurrences.length, 2);

  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const card = root.querySelector('[data-report-issue][data-result="failed"]');
  const preview = card.querySelector('[data-report-evidence-preview]');
  assert.equal(preview.querySelectorAll('[data-evidence-kind="element"]').length, 2);
  assert.equal(preview.querySelectorAll('svg[data-evidence-treatment="failed"]').length, 2);
  assert.equal(preview.querySelectorAll('[data-evidence-kind="full-page"]').length, 1);

  const html = renderHtmlReport(model, { reportView: view });
  const exportedCard = html.match(/<article class="occurrence-card"[^>]*data-result="failed"[^]*?<\/article>/u)?.[0] ?? '';
  assert.equal((exportedCard.match(/data-evidence-kind="element"/gu) ?? []).length, 2);
  assert.equal((exportedCard.match(/data-evidence-treatment="failed"/gu) ?? []).length, 2);
  assert.equal((exportedCard.match(/data-evidence-kind="full-page"/gu) ?? []).length, 1);
});

test('shared evidence keeps one explicit derivation for each occurrence-specific treatment', () => {
  const evidence = [{ evidenceId: 'ev-shared', kind: 'element' }];
  const occurrences = [
    {
      occurrenceId: 'occ-failed', classification: 'requirement', outcome: 'cantTell',
      decision: { answer: 'não conforme' }, evidenceRefs: ['ev-shared'],
    },
    {
      occurrenceId: 'occ-review', classification: 'requirement', outcome: 'cantTell',
      decision: null, evidenceRefs: ['ev-shared'],
    },
  ];
  assert.deepEqual(projectOccurrenceEvidencePreviews({ evidence, occurrences }).map(entry => ({
    evidenceId: entry.artifact.evidenceId, tone: entry.tone,
  })), [
    { evidenceId: 'ev-shared', tone: 'failed' },
    { evidenceId: 'ev-shared', tone: 'review' },
  ]);
});

test('mixed decisions derive red and amber treatments per occurrence inside one consolidated issue', async () => {
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      const originalEvidence = draft.evidence.find(evidence => evidence.evidenceId === 'ev-control');
      draft.evidence.push({
        ...structuredClone(originalEvidence),
        evidenceId: 'ev-control-2', nodeId: 'n-2', backendNodeId: 42,
        selector: { css: '#cancelar', framePath: [] },
        snippet: '<button id="cancelar" aria-label="Cancelar">Voltar</button>',
        hash: 'sha256-element-sample-2',
        metadata: {
          width: 128, height: 88,
          highlightBox: { x: 12, y: 16, width: 64, height: 36, coordinateSpace: 'capture-css-px' },
        },
      });
      draft.ruleResults.find(rule => rule.ruleId === 'focus-order').targets.push('n-2');
      const occurrence = draft.occurrences.find(value => value.occurrenceId === 'occ-focus-review');
      draft.occurrences.push({
        ...structuredClone(occurrence), occurrenceId: 'occ-focus-review-2', nodeId: 'n-2',
        target: { ...structuredClone(occurrence.target), nodeId: 'n-2' },
        evidenceRefs: ['ev-full', 'ev-control-2'], evidenceIds: ['ev-full', 'ev-control-2'],
      });
      const review = draft.manualReview.find(value => value.occurrenceId === 'occ-focus-review');
      draft.manualReview.push({ ...structuredClone(review), occurrenceId: 'occ-focus-review-2' });
      const decision = createReviewDecision({
        auditId: draft.auditId, itemId: occurrence.itemId, occurrenceId: occurrence.occurrenceId,
        answer: 'não conforme', evaluator: 'Avaliadora de teste',
        decidedAt: '2026-08-29T12:00:00.000Z', mode: occurrence.mode,
        note: 'Falha confirmada somente na primeira ocorrência.',
      });
      return structuredClone(applyReviewDecisions(draft, [decision]));
    },
  });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const issue = view.issues.failed.find(value => value.ruleId === 'focus-order');
  assert.equal(issue.occurrences.length, 2);
  assert.deepEqual(issue.occurrences.map(value => value.decision?.answer ?? null), ['não conforme', null]);

  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const card = root.querySelectorAll('[data-report-issue][data-result="failed"]')
    .find(value => value.querySelector('[data-report-issue-heading]').textContent.includes('Ordem de foco'));
  const preview = card.querySelector('[data-report-evidence-preview]');
  assert.equal(preview.querySelectorAll('svg[data-evidence-treatment="failed"]').length, 1);
  assert.equal(preview.querySelectorAll('svg[data-evidence-treatment="review"]').length, 1);
  assert.equal(preview.querySelectorAll('[data-evidence-kind="element"]').length, 2);

  const html = renderHtmlReport(model, { reportView: view });
  const exportedCard = [...html.matchAll(/<article class="occurrence-card"[^>]*data-result="failed"[^]*?<\/article>/gu)]
    .map(match => match[0]).find(value => value.includes('Ordem de foco')) ?? '';
  assert.equal((exportedCard.match(/data-evidence-treatment="failed"/gu) ?? []).length, 1);
  assert.equal((exportedCard.match(/data-evidence-treatment="review"/gu) ?? []).length, 1);
  assert.equal((exportedCard.match(/data-evidence-kind="element"/gu) ?? []).length, 2);
});

test('result report reveals live highlight only after worker approval and emits occurrence correlation only', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const intents = [];
  const root = renderReportView({
    view, document: new Document(), onExport() {},
    onHighlightIntent(value) { intents.push(value); },
  });
  const occurrenceId = view.issues.failed[0].occurrences[0].occurrenceId;
  const control = root.querySelector(`[data-report-highlight-control="${occurrenceId}"]`);
  const button = control.querySelector('button');
  assert.equal(button.getAttribute('data-report-highlight'), null);
  button.click();
  assert.deepEqual(intents, [{ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId }]);

  assert.equal(updateReportHighlightAction({
    root, occurrenceId, bindingStatus: { state: 'checking' }, activeOccurrenceId: null,
  }), true);
  assert.equal(button.disabled, false, 'checking must keep the focused report action in the tab order');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  button.click();
  assert.equal(intents.length, 1, 'aria-disabled checking cannot issue a duplicate request');

  assert.equal(updateReportHighlightAction({
    root, occurrenceId, bindingStatus: { state: 'available' }, activeOccurrenceId: null,
  }), true);
  assert.equal(button.getAttribute('aria-disabled'), null);
  assert.equal(button.getAttribute('data-report-highlight'), 'highlight');
  button.click();
  assert.deepEqual(intents.at(-1), { type: 'HIGHLIGHT_OCCURRENCE', occurrenceId });

  assert.equal(updateReportHighlightAction({
    root, occurrenceId, bindingStatus: { state: 'available' }, activeOccurrenceId: occurrenceId,
  }), true);
  assert.equal(button.getAttribute('data-report-highlight'), 'clear');
  button.click();
  assert.deepEqual(intents.at(-1), { type: 'CLEAR_HIGHLIGHT' });
  assert.equal(updateReportHighlightAction({
    root, occurrenceId,
    bindingStatus: { state: 'unavailable', reason: 'live-proof-failed' },
    activeOccurrenceId: occurrenceId,
  }), true);
  assert.equal(button.disabled, false, 'an interrupted availability channel cannot hide the active overlay clear action');
  assert.equal(button.getAttribute('data-report-highlight'), 'clear');
  assert.equal(JSON.stringify(intents).includes('selector'), false);
  assert.equal(JSON.stringify(intents).includes('windowId'), false);
});

test('multiple live occurrences have unique contextual accessible names without exposing live target internals', async () => {
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      const original = draft.occurrences.find(value => value.occurrenceId === 'occ-focus-failed');
      const duplicate = structuredClone(original);
      duplicate.occurrenceId = 'occ-focus-failed-2';
      duplicate.nodeId = 'n-2';
      duplicate.target.nodeId = 'n-2';
      duplicate.evidenceIds = ['ev-full'];
      duplicate.evidenceRefs = ['ev-full'];
      draft.occurrences.push(duplicate);
      draft.ruleResults.find(value => value.ruleId === 'focus-visible').targets.push('n-2');
    },
  });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {}, onHighlightIntent() {} });
  const issue = root.querySelectorAll('[data-report-issue][data-result="failed"]')
    .find(node => node.querySelectorAll('[data-report-highlight-control]').length === 2);
  assert.ok(issue, 'the two correlated occurrences remain in one issue card');
  const controls = issue.querySelectorAll('[data-report-highlight-control]');
  assert.equal(controls.length, 2);
  const names = controls.map(control => control.querySelector('button').getAttribute('aria-label'));
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /Imagem|foco|ocorrência|Página/iu);
    assert.doesNotMatch(name, /selector|windowId|tabId|documentId/iu);
  }
});

test('review CSS keeps the summary and evidence usable from 320px through desktop and assistive modes', async () => {
  const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
  const [html, css] = await Promise.all([read('src/review/index.html'), read('src/review/review.css')]);
  assert.equal((html.match(/aria-live="polite"/giu) ?? []).length, 0);
  assert.match(css, /\[data-report-group\][^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
  assert.match(css, /\.matrix-scroll[^{]*\{[^}]*overflow-x:\s*auto/isu);
  assert.match(css, /\.matrix-scroll[^{]*\{[^}]*min-width:\s*0/isu);
  assert.match(css, /\.report-view[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
  assert.match(css, /\.report-view\s+:is\(p,\s*li,\s*dd,\s*dt,\s*th,\s*td,\s*code\)[^{]*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/isu);
  assert.match(css, /\.report-metrics[^{]*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/isu);
  assert.match(css, /@media\s*\(min-width:\s*48rem\)[^]*?\.report-metrics[^{]*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/isu);
  assert.match(css, /\[data-report-evidence-preview\][^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
  assert.match(css, /@media\s*\(min-width:\s*48rem\)[^]*?\[data-report-evidence-preview\][^{]*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/isu);
  assert.match(css, /\[data-report-issue\][^{]*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/isu);
  assert.match(css, /\[data-report-executive-actions\] button[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /summary[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /\.section-nav ul[^{]*\{[^}]*list-style:\s*none/isu);
  assert.match(css, /\[data-report-metric\][^{]*\{[^}]*border-inline-start/isu);
  assert.match(css, /\[data-report-metric\] \.metric-value[^{]*\{[^}]*font-size:\s*clamp/isu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)[^]*?\[data-report-executive-actions\] button\s*\{[^}]*background:\s*Canvas[^}]*color:\s*CanvasText[^}]*border-color:\s*ButtonText/isu);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
  assert.match(css, /@media\s+print[^]*?\[data-report-evidence-preview\] figure\[data-evidence-kind="full-page"\][^{]*\{[^}]*break-inside:\s*auto/isu);
  assert.match(css, /@media\s+print[^]*?\[data-evidence-kind="full-page"\]\s*>\s*\.evidence-media[^{]*\{[^}]*max-height:\s*210mm[^}]*object-fit:\s*contain/isu);
  assert.match(css, /@media\s+print[^]*?\[data-report-issue\][^}]*\[data-report-technical\][^}]*\[data-report-evidence\][^{]*\{[^}]*break-inside:\s*auto/isu);
});
