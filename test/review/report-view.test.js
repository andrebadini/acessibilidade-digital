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

async function fixture() {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
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

test('renderer creates neutral identity plus exactly seven h2 sections and filters only live DOM', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
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
  assert.deepEqual(navigation.querySelectorAll('a').map(link => link.getAttribute('href')), [
    '#report-section-1', '#report-section-2', '#report-section-3', '#report-section-4',
    '#report-section-5', '#report-section-6', '#report-section-7',
  ]);
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

test('live report exposes complete progressive cards, inert official sources and one combined polite announcement', async () => {
  const { model, summary } = await fixture();
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const root = renderReportView({ view, document: new Document(), onExport() {} });
  const firstIssue = root.querySelector('[data-report-issue][data-result="failed"]');
  assert.ok(firstIssue);
  assert.match(firstIssue.textContent, /Impacto|Observação|Correção|Confirmar|WCAG|ABNT|Nome acessível|estimada|Referência técnica e jurídica qualificada/iu);
  assert.equal(firstIssue.querySelectorAll('details').length, 1);
  assert.match(firstIssue.querySelector('details').textContent, /URL|Horário|Seletor|Snippet|Imagem segura/iu);
  assert.equal(firstIssue.querySelectorAll('img').length >= 2, true);
  assert.match(firstIssue.querySelector('details').textContent, /ev-control|ev-full/iu);
  assert.match(firstIssue.textContent, /Resultado consolidado: Não atendido neste teste|Impacto: Moderado|Classificação: Não conformidade identificada/iu);
  assert.equal(root.querySelectorAll('[data-report-evidence]').length, view.technicalEvidence.length);
  assert.equal(root.querySelectorAll('[data-report-evidence]').flatMap(node => node.querySelectorAll('img')).length >= 2, true);
  const sources = root.querySelectorAll('[data-official-source]');
  assert.equal(sources.length, 2);
  assert.equal(sources.every(source => source.getAttribute('href') === null && source.getAttribute('src') === null), true);
  assert.equal(root.querySelectorAll('[role="status"][aria-live="polite"]').length, 1);
  const headings = root.querySelectorAll('h3').map(node => node.textContent);
  for (const label of ['Não conformidades', 'Alertas', 'Revisões humanas pendentes', 'Resultados positivos']) {
    assert.equal(headings.includes(label) || headings.some(value => value.startsWith(`${label}:`)), true);
  }
});

test('review document retains exactly one polite live region and its CSS protects the 320px matrix reflow', async () => {
  const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
  const [html, css] = await Promise.all([read('src/review/index.html'), read('src/review/review.css')]);
  assert.equal((html.match(/aria-live="polite"/giu) ?? []).length, 0);
  assert.match(css, /\[data-report-group\][^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
  assert.match(css, /\.matrix-scroll[^{]*\{[^}]*overflow-x:\s*auto/isu);
  assert.match(css, /\.matrix-scroll[^{]*\{[^}]*min-width:\s*0/isu);
  assert.match(css, /\.report-view[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu);
  assert.match(css, /\.report-metrics[^{]*\{[^}]*minmax\(min\(100%,\s*14rem\),\s*1fr\)/isu);
  assert.match(css, /\.section-nav ul[^{]*\{[^}]*list-style:\s*none/isu);
  assert.match(css, /\[data-report-metric\][^{]*\{[^}]*border-inline-start/isu);
  assert.match(css, /\[data-report-metric\] \.metric-value[^{]*\{[^}]*font-size:\s*clamp/isu);
});
