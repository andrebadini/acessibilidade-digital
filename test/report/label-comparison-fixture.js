import { reportInput } from './helpers.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';

export async function labelComparisonFixture({ mutate } = {}) {
  const input = reportInput();
  const rule = input.ruleResults.find(row => row.ruleId === 'visible-label-in-name');
  rule.outcome = 'cantTell';
  rule.targets = ['n-1', 'n-2'];
  input.itemResults = aggregateItems(input.ruleResults, NBR17225_ITEMS).map(item => ({
    ...item, ruleResults: item.ruleResults.map(row => row.ruleId),
  }));
  const first = input.evidence.artifacts.find(row => row.kind === 'element');
  first.nodeId = 'n-1';
  first.accessibility = { visibleText: 'Buscar', name: 'Pesquisar', nameSource: 'aria-label',
    description: null, descriptionSource: null, role: 'button', states: [],
    announcementPreview: 'Pesquisar, botão' };
  const second = { ...structuredClone(first), evidenceId: 'ev-second', nodeId: 'n-2',
    accessibility: { ...first.accessibility, visibleText: 'Salvar <rascunho>', name: 'Enviar & continuar',
      announcementPreview: 'Enviar & continuar, botão' } };
  input.evidence.artifacts.push(second);
  input.occurrences.push(...[first, second].map((artifact, index) => ({
    occurrenceId: `occ-label-${index + 1}`, itemId: '5.13.7', ruleId: rule.ruleId,
    outcome: 'cantTell', mode: 'automated', nodeId: artifact.nodeId,
    evidenceIds: [artifact.evidenceId], justification: 'Comparação registrada pelo motor; preservar este resultado.',
  })));
  mutate?.(input);
  const inventory = await createInstalledCoreRuleInventory();
  const model = await enrichAuditForReport(input, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.5', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/152.0.0.0',
  });
  const checkpoint = { version: 1, auditId: model.auditId, pages: [{
    pageId: model.pages[0].pageId, attempted: true, startedAt: model.pages[0].timestamps.startedAt,
    rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
    inventoryHash: inventory.sha256, outcomes: [{ ruleId: rule.ruleId, outcome: 'cantTell' }],
  }] };
  const summary = await buildPanelSummary({ model, executionCheckpoint: checkpoint, inventory });
  return { model, summary, checkpoint, inventory };
}
