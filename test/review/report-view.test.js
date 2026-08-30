import assert from 'node:assert/strict';
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
      inventoryHash: inventory.sha256, outcomes: [],
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
  const before = structuredClone(view);
  const filter = root.querySelector('button[data-report-filter="result"][data-filter-value="failed"]');
  assert.ok(filter);
  filter.click();
  assert.deepEqual(view, before);
  assert.equal(filter.getAttribute('aria-pressed'), 'true');
  const renderedIssues = root.querySelectorAll('[data-report-issue]');
  assert.equal(renderedIssues.some(issue => issue.hidden), true);
  assert.equal(renderedIssues.some(issue => !issue.hidden), true);
  filter.click();
  assert.equal(filter.getAttribute('aria-pressed'), 'false');
  assert.equal(renderedIssues.every(issue => !issue.hidden), true);
  assert.equal(root.textContent.includes('estimativa'), true);
  assert.doesNotMatch(JSON.stringify(root.dataset), /capability|attempt|revision|lease|tab|window|document/iu);
});
