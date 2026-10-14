import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CORE_RULES, validateCoreRuleComposition } from '../../src/core/audit.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { reportInput } from '../report/helpers.js';

const fixture = name => readFile(new URL(`../../fixtures/pages/${name}`, import.meta.url), 'utf8');

test('failure fixture contains local observable cases for the eight required rule families', async () => {
  const html = await fixture('failures.html');
  for (const rule of ['content-image-alternative', 'accessible-component-name', 'heading-order', 'form-field-label', 'text-contrast-minimum', 'target-size-minimum', 'frame-title', 'audio-control']) {
    assert.match(html, new RegExp(`data-expected-rule="${rule}"`, 'u'));
    assert.ok(CORE_RULES.some(candidate => candidate.id === rule), `${rule} must exist in the official composition`);
  }
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/iu);
});

test('manual fixture marks contextual cantTell cases without claiming automatic outcomes', async () => {
  const html = await fixture('manual-review.html');
  assert.ok((html.match(/data-review-outcome="cantTell"/gu) ?? []).length >= 4);
  assert.doesNotMatch(html, /data-review-outcome="(?:passed|failed)"/u);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/iu);
});

test('report artifacts share all 146 outcomes and occurrences without leaking sensitive URL data', async () => {
  const raw = reportInput();
  raw.requestedUrl = 'https://servico.exemplo.test/?token=TOPSECRET&view=public';
  raw.finalUrl = 'https://servico.exemplo.test/final?session=TOPSECRET&view=public';
  const model = await enrichAuditForReport(raw, { now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba', manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0' });
  const html = renderHtmlReport(model);
  const json = renderTechnicalJson(model);
  const technical = JSON.parse(json);
  assert.equal((html.match(/data-report-item=/gu) ?? []).length, NBR17225_ITEMS.length);
  assert.equal(technical.assertions.length, NBR17225_ITEMS.length);
  assert.deepEqual(technical.audit.itemResults.map(item => item.outcome), model.itemResults.map(item => item.outcome));
  assert.deepEqual(technical.audit.occurrences, model.occurrences);
  assert.doesNotMatch(`${html}\n${json}`, /TOPSECRET|token=|session=/iu);
  assert.deepEqual(validateCoreRuleComposition(), []);
  assert.equal(CORE_RULES.length, 131);
  assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'requirement').length, 96);
  assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'recommendation').length, 50);
});
