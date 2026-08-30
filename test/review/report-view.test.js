import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildReportView, renderReportView } from '../../src/review/report-view.js';
import { EXPORT_FORMATS_V1 } from '../../src/export/report-export.js';

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
  addEventListener(type, listener) { const values = this.listeners.get(type) ?? []; values.push(listener); this.listeners.set(type, values); }
  click() { for (const listener of this.listeners.get('click') ?? []) listener({ currentTarget: this }); }
  querySelectorAll(selector) {
    const output = [];
    const visit = node => { for (const child of node.children) { if (matches(child, selector)) output.push(child); visit(child); } };
    visit(this); return output;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class Document { createElement(tag) { return new Element(tag, this); } }

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
  mutateDraft?.(draft);
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
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
  return { model, summary };
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

test('ReportViewV1 keeps qualified remediation and uses a prudent alert fallback', async () => {
  const canonicalRemediation = 'Forneça um indicador de foco visível.';
  const { model, summary } = await fixture({
    mutateDraft(draft) {
      const coreRule = draft.ruleResults.find(rule => rule.ruleId === 'focus-visible');
      coreRule.targets = [{
        nodeId: 'n-1', message: canonicalRemediation,
        data: { reason: 'focus-indicator-not-visible' },
      }];
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
  assert.equal(preview.querySelectorAll('img').length, 2);
  assert.equal(preview.querySelectorAll('[data-evidence-kind="element"]').length, 1);
  assert.equal(preview.querySelectorAll('[data-evidence-kind="full-page"]').length, 1);
  assert.equal(firstIssue.querySelectorAll('details').length, 1);
  const technical = firstIssue.querySelector('[data-report-technical]');
  assert.equal(technical.getAttribute('open'), null);
  assert.equal(technical.querySelectorAll('img').length, 0);
  assert.match(technical.textContent, /Resultado original|Resultado consolidado|Contexto técnico|Página|Motor|Regra|Versão|URL|Horário|Seletor|Snippet|Hash|ID|Proveniência/iu);
  assert.match(technical.textContent, /ev-control|ev-full/iu);
  assert.equal(firstIssue.querySelectorAll('img').length, 2);
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

test('review CSS keeps the summary and evidence usable from 320px through desktop and assistive modes', async () => {
  const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
  const [html, css] = await Promise.all([read('src/review/index.html'), read('src/review/review.css')]);
  assert.equal((html.match(/aria-live="polite"/giu) ?? []).length, 0);
  assert.match(css, /\[data-report-group\][^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
  assert.match(css, /\.matrix-scroll[^{]*\{[^}]*overflow-x:\s*auto/isu);
  assert.match(css, /\.matrix-scroll[^{]*\{[^}]*min-width:\s*0/isu);
  assert.match(css, /\.report-view[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
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
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
  assert.match(css, /@media\s+print[^]*?\[data-report-evidence-preview\] figure\[data-evidence-kind="full-page"\][^{]*\{[^}]*break-inside:\s*auto/isu);
  assert.match(css, /@media\s+print[^]*?\[data-evidence-kind="full-page"\]\s*>\s*\.evidence-media[^{]*\{[^}]*max-height:\s*210mm[^}]*object-fit:\s*contain/isu);
  assert.match(css, /@media\s+print[^]*?\[data-report-issue\][^}]*\[data-report-technical\][^}]*\[data-report-evidence\][^{]*\{[^}]*break-inside:\s*auto/isu);
});
