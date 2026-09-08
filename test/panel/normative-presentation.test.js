import test from 'node:test';
import assert from 'node:assert/strict';
import { reportInput } from '../report/helpers.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { buildPanelDetail } from '../../src/panel/panel-detail.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { buildReportView } from '../../src/review/report-view.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { projectOccurrenceEvidencePreviews } from '../../src/core/report/evidence-treatment.js';

test('saved enhanced contrast displays AAA as an advisory without claiming AA or rewriting the audit', async () => {
  const input = reportInput();
  const rule = input.ruleResults.find(row => row.ruleId === 'text-contrast-enhanced');
  rule.outcome = 'failed'; rule.targets = ['n-1'];
  rule.source = { engine: 'audita-core', ruleId: rule.ruleId, version: '1.0.0' };
  input.itemResults.find(row => row.id === '5.11.2').outcome = 'failed';
  input.occurrences.push({ occurrenceId: 'occ-enhanced', itemId: '5.11.2', ruleId: rule.ruleId,
    outcome: 'failed', mode: 'automated', nodeId: 'n-1', evidenceIds: ['ev-1'], justification: 'Contraste aprimorado insuficiente.',
    source: { ...rule.source }, itemWcagRefs: ['1.4.3', '1.4.6'], sourceWcagRefs: ['1.4.3', '1.4.6'],
    testedWcagRefs: ['1.4.3', '1.4.6'], wcagRefs: ['1.4.3', '1.4.6'],
  });
  const inventory = await createInstalledCoreRuleInventory();
  const artifact = input.evidence.artifacts.find(row => row.evidenceId === 'ev-1');
  artifact.dataUrl = input.evidence.artifacts[0].dataUrl;
  artifact.metadata = { width: 1, height: 1 };
  const model = await enrichAuditForReport(createAuditModel(input), {
    now: () => '2026-09-08T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.9', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/152.0.0.0',
  });
  const before = JSON.stringify(model);
  const executionCheckpoint = { version: 1, auditId: model.auditId, pages: model.pages.map(page => ({
    pageId: page.pageId, attempted: true, startedAt: page.timestamps.startedAt,
    rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion, inventoryHash: inventory.sha256, outcomes: [],
  })) };
  const summary = await buildPanelSummary({ model, executionCheckpoint, inventory });
  assert.equal(summary.counts.errors.checkKeys, 0);
  const card = summary.groups.alerts.find(row => row.ruleId === rule.ruleId);
  assert.deepEqual(card.wcag, ['1.4.6']);
  const detail = buildPanelDetail({ model, summary, occurrenceId: 'occ-enhanced' });
  assert.deepEqual(detail.normative, { wcag: ['1.4.6'], level: ['AAA'], abntItem: '5.11.2', classification: 'recommendation' });
  assert.equal(detail.legalReference, null);
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const issue = view.issues.alerts[0];
  assert.deepEqual(projectOccurrenceEvidencePreviews({ evidence: model.evidence.filter(row => row.kind === 'element'),
    occurrences: issue.occurrences }).map(row => row.tone), ['advisory']);
  for (const forPrint of [false, true]) {
    const html = renderHtmlReport(model, { reportView: view, forPrint });
    const cardHtml = html.match(/<article class="occurrence-card"[^]*?<\/article>/u)?.[0] ?? '';
    assert.match(cardHtml, /data-result="alerts"/u);
    assert.doesNotMatch(cardHtml, /data-result="failed"|data-classification="failed"|Falha confirmada/u);
    assert.match(cardHtml, /Recomendação não atendida/u);
    assert.match(cardHtml, /data-evidence-treatment="advisory"/u);
  }
  assert.equal(JSON.stringify(model), before);
});
