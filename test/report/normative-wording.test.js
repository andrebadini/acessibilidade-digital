import assert from 'node:assert/strict';
import test from 'node:test';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { canonicalCoreRuleSummary } from '../../src/core/report/text-policy.js';
import { reportInput } from './helpers.js';

function contrastInput() {
  const input = reportInput();
  const rule = input.ruleResults.find(row => row.ruleId === 'text-contrast-enhanced');
  rule.outcome = 'cantTell';
  rule.targets = ['n-1'];
  input.occurrences.push({ ...input.occurrences[0], occurrenceId: 'occ-contrast',
    itemId: '5.11.2', ruleId: rule.ruleId, mode: rule.mode });
  input.manualReview.push({ ...input.manualReview[0], occurrenceId: 'occ-contrast',
    itemId: '5.11.2', ruleId: rule.ruleId, mode: 'assisted' });
  input.itemResults = aggregateItems(input.ruleResults, NBR17225_ITEMS).map(item => ({
    ...item, ruleResults: item.ruleResults.map(row => row.ruleId),
  }));
  return input;
}

// The bug is routing both normative classifications through the requirement label.
test('new summaries distinguish recommendations from requirements for every outcome', () => {
  for (const outcome of ['passed', 'failed', 'cantTell', 'inapplicable', 'untested']) {
    const recommendation = canonicalCoreRuleSummary('text-contrast-enhanced', outcome);
    assert.match(recommendation, /^Recomendação “Contraste para texto \(aprimorado\)”:/);
    assert.doesNotMatch(recommendation, /requisito/i);
    assert.match(canonicalCoreRuleSummary('text-contrast-minimum', outcome), /^Requisito /);
  }
});

test('new report and review question identify enhanced contrast as a recommendation without changing evidence', () => {
  const model = createAuditModel(contrastInput());
  const occurrence = model.occurrences.find(row => row.occurrenceId === 'occ-contrast');
  const review = model.manualReview.find(row => row.occurrenceId === occurrence.occurrenceId);
  assert.match(occurrence.justification, /^Recomendação /);
  assert.match(review.question, /^A recomendação /);
  assert.equal(occurrence.outcome, 'cantTell');
  assert.equal(occurrence.classification, 'recommendation');
  assert.equal(occurrence.legalAnalysis, null);
  assert.equal(model.evidence.find(row => row.evidenceId === 'ev-1').snippet, '<button>Continuar</button>');
  assert.match(renderHtmlReport(model), /Recomendação “Contraste para texto \(aprimorado\)”/);
});

const OLD_RESULTS = {
  passed: 'conformidade técnica observada', failed: 'não conformidade técnica identificada',
  cantTell: 'conclusão dependente de revisão humana',
  inapplicable: 'requisito não aplicável ao estado observado', untested: 'verificação técnica não concluída',
};

function legacyWordingModel() {
  const model = structuredClone(createAuditModel(contrastInput()));
  const items = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  for (const rule of model.ruleResults) {
    const item = items.get(rule.nbrItems[0]);
    rule.summary = `Requisito “${item.title}”: ${OLD_RESULTS[rule.outcome]}.`;
  }
  for (const occurrence of model.occurrences) {
    if (occurrence.source.engine === 'audita-core') {
      occurrence.justification = `Requisito “${items.get(occurrence.itemId).title}”: ${OLD_RESULTS[occurrence.outcome]}.`;
    }
  }
  for (const review of model.manualReview) {
    review.question = `O requisito “${items.get(review.itemId).title}” está conforme no contexto apresentado?`;
    review.reason = model.occurrences.find(row => row.occurrenceId === review.occurrenceId).justification;
  }
  return model;
}

test('saved legacy wording remains byte-equivalent through validation and structured export', async () => {
  const legacy = legacyWordingModel();
  assert.equal(canonicalStringify(createAuditModel(legacy)), canonicalStringify(legacy));
  const sealed = await enrichAuditForReport(legacy, { now: () => '2026-08-26T16:00:00.000Z' });
  const exported = JSON.parse(renderTechnicalJson(sealed)).audit;
  const verified = await verifyAuditIntegritySnapshot(exported);
  assert.equal(canonicalStringify(verified), canonicalStringify(sealed));
  assert.equal(verified.occurrences.find(row => row.occurrenceId === 'occ-contrast').justification,
    'Requisito “Contraste para texto (aprimorado)”: conclusão dependente de revisão humana.');
});

test('legacy compatibility does not accept arbitrary or outcome-mismatched text', () => {
  for (const replace of [
    'Requisito “Contraste para texto (aprimorado)”: conformidade técnica observada.',
    'Recomendação “Contraste para texto (aprimorado)”: PRIVATE_TEXT_INJECTION',
  ]) {
    const model = legacyWordingModel();
    model.ruleResults.find(row => row.ruleId === 'text-contrast-enhanced').summary = replace;
    assert.throws(() => createAuditModel(model), error => {
      assert.doesNotMatch(error.message, /PRIVATE_TEXT_INJECTION/);
      return true;
    });
  }
});

test('changing an accepted historical label still invalidates the saved integrity proof', async () => {
  const sealed = await enrichAuditForReport(legacyWordingModel(), { now: () => '2026-08-26T16:00:00.000Z' });
  const changed = structuredClone(sealed);
  changed.ruleResults.find(row => row.ruleId === 'text-contrast-enhanced').summary =
    'Recomendação “Contraste para texto (aprimorado)”: conclusão dependente de revisão humana.';
  assert.doesNotThrow(() => createAuditModel(changed));
  await assert.rejects(verifyAuditIntegritySnapshot(changed));
});
