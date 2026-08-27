import assert from 'node:assert/strict';
import test from 'node:test';

import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { SECTION508_REVISED_CROSSWALK } from '../../src/core/normative/section508.js';
import {
  V1_MIGRATION_DEFAULTS,
  createAuditModel,
  migrateAuditV1ToV2,
} from '../../src/core/report/audit-model.js';
import { reportInput } from './helpers.js';

test('explicitly migrates V1 into the canonical single-page V2 contract without inventing source facts', () => {
  const input = reportInput();
  const original = structuredClone(input);
  const model = migrateAuditV1ToV2(input);
  const occurrence = model.occurrences[0];

  assert.deepEqual(input, original);
  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(model.requestedScope, {
    mode: 'single', urls: ['https://example.test/path?view=public'],
  });
  assert.deepEqual(model.pages, [{
    pageId: 'page-1',
    requestedUrl: 'https://example.test/path?view=public',
    finalUrl: 'https://example.test/final?view=public',
    status: 'partial',
    timestamps: model.timestamps,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  }]);
  assert.equal(Array.isArray(model.evidence), true);
  assert.equal(model.evidence[0].pageId, 'page-1');
  assert.equal(occurrence.pageId, 'page-1');
  assert.equal(occurrence.classification, 'requirement');
  assert.equal(occurrence.impact, V1_MIGRATION_DEFAULTS.impact);
  assert.equal(occurrence.confidence, V1_MIGRATION_DEFAULTS.confidence);
  assert.deepEqual(occurrence.source, {
    engine: 'audita-core', ruleId: 'rule-assisted', version: '1.0.0',
  });
  assert.equal(occurrence.nbrItemRef, '5.1.4');
  assert.deepEqual(occurrence.wcagRefs, ['2.4.3']);
  assert.ok(occurrence.foreignBenchmarkRefs.every(reference =>
    reference.benchmarkId === SECTION508_REVISED_CROSSWALK.id));
  assert.deepEqual(occurrence.target, { nodeId: 'n-1', selector: '#conteudo', framePath: [] });
  assert.equal(occurrence.accessiblePreview, null);
  assert.deepEqual(occurrence.evidenceRefs, ['ev-1']);
  assert.equal(occurrence.legalAnalysis, null);
  assert.deepEqual(model.integrity, {
    algorithm: 'unavailable', status: 'not-recorded-v1',
  });
  assert.equal(Object.isFrozen(model), true);
});

test('createAuditModel is the explicit V1 migration boundary and accepts native multipage V2', () => {
  const migrated = createAuditModel(reportInput());
  assert.equal(migrated.schemaVersion, 2);

  const batch = structuredClone(migrated);
  batch.requestedScope = {
    mode: 'batch',
    urls: [...batch.requestedScope.urls, 'https://second.example.test/'],
  };
  batch.pages.push({
    pageId: 'page-2',
    requestedUrl: 'https://second.example.test/',
    finalUrl: 'https://second.example.test/final',
    status: 'failed',
    timestamps: {
      startedAt: '2026-08-26T14:02:00.000Z',
      endedAt: '2026-08-26T14:02:01.000Z',
      generatedAt: '2026-08-26T14:02:02.000Z',
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
  });

  const model = createAuditModel(batch);
  assert.equal(model.requestedScope.mode, 'batch');
  assert.deepEqual(model.pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.throws(() => createAuditModel({
    ...batch,
    pages: batch.pages.map(page => ({ ...page, pageId: 'page-1' })),
  }), /pageId|página|duplicad/i);
  assert.throws(() => createAuditModel({
    ...batch,
    pages: batch.pages.map((page, index) => index === 1
      ? { ...page, requestedUrl: 'https://unrequested.example.test/' }
      : page),
  }), /requestedScope|escopo|solicitad|URL/i);
});

test('conclusive failed requirements and recommendations use the same catalog reference without changing classification', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const requirement = NBR17225_ITEMS.find(item => item.id === '5.1.1');
  const recommendation = NBR17225_ITEMS.find(item => item.id === '5.1.2');
  const makeRule = (item, ruleId) => ({
    ruleId, outcome: 'failed', mode: item.evaluation, nbrItems: [item.id],
    targets: [], summary: 'Falha conclusiva.', limitations: [],
  });
  const makeOccurrence = (item, ruleId, occurrenceId, outcome = 'failed') => ({
    occurrenceId, pageId: 'page-1', outcome, classification: item.classification,
    impact: 'moderate', confidence: 'high',
    source: { engine: 'audita-core', ruleId, version: '1.0.0' },
    nbrItemRef: item.id, wcagRefs: item.wcag.map(reference => reference.id),
    foreignBenchmarkRefs: [], target: { nodeId: null, selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [],
    legalAnalysis: outcome === 'failed'
      ? { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id }
      : null,
    itemId: item.id, ruleId, mode: item.evaluation, nodeId: null,
    evidenceIds: [], justification: 'Falha conclusiva.',
  });
  model.ruleResults.push(makeRule(requirement, 'focus-visible'));
  model.ruleResults.push(makeRule(recommendation, 'focus-fully-visible'));
  model.occurrences.push(makeOccurrence(requirement, 'focus-visible', 'occ-requirement'));
  model.occurrences.push(makeOccurrence(recommendation, 'focus-fully-visible', 'occ-recommendation'));
  model.occurrences.push(makeOccurrence(recommendation, 'focus-fully-visible', 'occ-inconclusive', 'cantTell'));

  const canonical = createAuditModel(model);
  const [requirementFailure, recommendationFailure, inconclusive] =
    ['occ-requirement', 'occ-recommendation', 'occ-inconclusive']
      .map(id => canonical.occurrences.find(occurrence => occurrence.occurrenceId === id));
  assert.equal(requirementFailure.legalAnalysis.basisRef, CONSUMER_ACCESSIBILITY_FIXED_BASIS.id);
  assert.equal(recommendationFailure.legalAnalysis.basisRef, CONSUMER_ACCESSIBILITY_FIXED_BASIS.id);
  assert.equal(requirementFailure.classification, 'requirement');
  assert.equal(recommendationFailure.classification, 'recommendation');
  assert.equal(inconclusive.legalAnalysis, null);
  assert.doesNotMatch(JSON.stringify(canonical.occurrences), /violatedLaw|illegal|liability|sanction/iu);
});

test('allows supplemental and editorial rules without weakening the exact 130-core and 146-item contracts', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  model.methodology = {
    ...model.methodology,
    coreRuleCount: 130,
    supplementalRuleCount: 1,
    ruleCount: 131,
  };
  model.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    nbrItems: [], targets: [], summary: 'Conteúdo provisório.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-editorial', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: null, selector: 'main p', framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: null, ruleId: 'editorial.placeholder-text', mode: 'automated', nodeId: null,
    evidenceIds: [], justification: 'Conteúdo provisório.',
  });

  const canonical = createAuditModel(model);
  assert.equal(canonical.itemResults.length, 146);
  assert.equal(canonical.methodology.coreRuleCount, 130);
  assert.equal(canonical.ruleResults.at(-1).nbrItems.length, 0);
  assert.equal(canonical.occurrences.at(-1).legalAnalysis, null);

  model.methodology.coreRuleCount = 129;
  assert.throws(() => createAuditModel(model), /130|core|regra/i);
});

test('projects legacy aliases only from native V2 facts and requires an explicit integrity record', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const occurrence = model.occurrences[0];
  for (const key of ['itemId', 'ruleId', 'mode', 'nodeId', 'evidenceIds']) delete occurrence[key];

  const canonical = createAuditModel(model);
  assert.equal(canonical.occurrences[0].itemId, canonical.occurrences[0].nbrItemRef);
  assert.equal(canonical.occurrences[0].ruleId, canonical.occurrences[0].source.ruleId);
  assert.equal(canonical.occurrences[0].mode, 'assisted');
  assert.equal(canonical.occurrences[0].nodeId, canonical.occurrences[0].target.nodeId);
  assert.deepEqual(canonical.occurrences[0].evidenceIds, canonical.occurrences[0].evidenceRefs);

  delete model.integrity;
  assert.throws(() => createAuditModel(model), /integrity|integridade/i);
});
