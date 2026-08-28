import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { SECTION508_REVISED_CROSSWALK } from '../../src/core/normative/section508.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import {
  V1_MIGRATION_DEFAULTS,
  createAuditModel,
  migrateAuditV1ToV2,
} from '../../src/core/report/audit-model.js';
import { reportInput } from './helpers.js';

function reviewDecision(occurrenceId, itemId, answer, mode) {
  return createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId,
    itemId,
    occurrenceId,
    answer,
    evaluator: 'Fiscal de teste',
    decidedAt: '2026-08-26T15:00:00.000Z',
    mode,
  });
}

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
    engine: 'audita-core', ruleId: 'focus-order', version: '1.0.0',
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

test('sanitizes every URL-bearing evidence field at the V1 and technical JSON boundary', () => {
  const input = reportInput();
  const safeDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  input.evidence.artifacts[0] = {
    ...input.evidence.artifacts[0],
    mediaUrl: 'https://cdn.example.test/video.mp4?token=TOPSECRET&view=public',
    resourceUrl: 'https://cdn.example.test/resource?api_key=TOPSECRET&lang=pt-BR',
    dataUrl: safeDataUrl,
    media: {
      currentSrc: 'https://images.example.test/poster.png?session=TOPSECRET&size=large',
    },
  };

  const model = migrateAuditV1ToV2(input);
  const artifact = model.evidence[0];
  assert.equal(artifact.mediaUrl, 'https://cdn.example.test/video.mp4?view=public');
  assert.equal(artifact.resourceUrl, 'https://cdn.example.test/resource?lang=pt-BR');
  assert.equal(artifact.media.currentSrc, 'https://images.example.test/poster.png?size=large');
  assert.equal(artifact.dataUrl, safeDataUrl);
  assert.doesNotMatch(renderTechnicalJson(model), /TOPSECRET|token=|api_key=|session=/u);
});

test('rejects an unregistered V1 supplemental rule instead of inventing trustworthy provenance', () => {
  const input = reportInput();
  input.itemResults.find(item => item.id === '5.1.2').outcome = 'passed';
  input.ruleResults.push({
    ruleId: 'supplemental.legacy-pass', outcome: 'passed', mode: 'automated',
    nbrItems: ['5.1.2'], targets: [], summary: 'Aprovação V1 suplementar.', limitations: [],
  });
  input.occurrences.push({
    occurrenceId: 'occ-legacy-supplemental-pass', itemId: '5.1.2',
    ruleId: 'supplemental.legacy-pass', outcome: 'passed', mode: 'automated',
    nodeId: null, evidenceIds: [], justification: 'Aprovação V1 suplementar.',
  });

  assert.throws(
    () => migrateAuditV1ToV2(input),
    /proveniência|fonte|registro|suplementar|aprova/iu,
  );
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
  assert.throws(() => createAuditModel({ ...batch, session: { ...batch.session, status: 'complete' } }), /status|páginas|sessão/iu);
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

test('rejects non-string occurrence justification and evidence hashes without coercing hostile values', () => {
  const unsafeValues = [null, 42, true, [], { nested: 'PRIVATE_SENTINEL' }];
  for (const value of unsafeValues) {
    const occurrenceInput = structuredClone(SAMPLE_AUDIT);
    occurrenceInput.occurrences[0].justification = value;
    assert.throws(() => createAuditModel(occurrenceInput), /justification|justificativa|texto|schema|inválid/iu);

    const evidenceInput = structuredClone(SAMPLE_AUDIT);
    evidenceInput.evidence[0].hash = value;
    assert.throws(() => createAuditModel(evidenceInput), /evidência|evidence|hash|texto|schema|inválid/iu);
  }

  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'toString', {
    enumerable: true,
    get() { accessed = true; throw new Error('PRIVATE_SENTINEL'); },
  });
  const hostileOccurrence = structuredClone(SAMPLE_AUDIT);
  hostileOccurrence.occurrences[0].justification = hostile;
  assert.throws(() => createAuditModel(hostileOccurrence), /propriedade|segura|justification|valor|schema/iu);
  assert.equal(accessed, false);

  const hostileEvidence = structuredClone(SAMPLE_AUDIT);
  Object.defineProperty(hostileEvidence.evidence[0], 'hash', {
    enumerable: true,
    get() { accessed = true; throw new Error('PRIVATE_SENTINEL'); },
  });
  assert.throws(() => createAuditModel(hostileEvidence), /propriedade|segura|hash|valor|schema/iu);
  assert.equal(accessed, false);
});

test('conclusive failed requirements and recommendations use the same catalog reference without changing classification', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const requirement = NBR17225_ITEMS.find(item => item.id === '5.1.1');
  const recommendation = NBR17225_ITEMS.find(item => item.id === '5.1.2');
  const makeRule = (item, ruleId) => ({
    ruleId, outcome: 'failed', mode: item.evaluation, nbrItems: [item.id],
    targets: [], summary: 'Falha conclusiva.', limitations: [],
    source: { engine: 'audita-core', ruleId, version: '1.0.0' },
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
  model.ruleResults = model.ruleResults.filter(rule => rule.ruleId !== 'focus-visible');
  model.itemResults.find(item => item.id === requirement.id).outcome = 'failed';
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
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-1', selectorHint: '',
      message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-editorial', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-1', selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: null, ruleId: 'editorial.placeholder-text', mode: 'automated', nodeId: 'n-1',
    evidenceIds: [], justification: 'Há conteúdo provisório inequívoco na página.',
  });

  const canonical = createAuditModel(model);
  assert.equal(canonical.itemResults.length, 146);
  assert.equal(canonical.methodology.coreRuleCount, 130);
  assert.equal(canonical.ruleResults.at(-1).nbrItems.length, 0);
  assert.equal(canonical.occurrences.at(-1).legalAnalysis, null);

  model.methodology.coreRuleCount = 129;
  assert.throws(() => createAuditModel(model), /130|core|regra/i);
});

test('strictly validates editorial and informational inventory schemas without accepting private extension fields', () => {
  const base = structuredClone(createAuditModel(reportInput()));
  assert.deepEqual(base.accessibilityWidgets, {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'unavailable',
    widgets: [
      { id: 'vlibras', status: 'unknown', signals: [] },
      { id: 'hand-talk', status: 'unknown', signals: [] },
    ],
  });

  for (const mutate of [
    value => { value.accessibilityWidgets.privateText = 'PRIVATE-INVENTORY'; },
    value => { value.accessibilityWidgets.widgets[0].selector = '#PRIVATE-WIDGET'; },
    value => { value.accessibilityWidgets.widgets.reverse(); },
    value => { value.accessibilityWidgets.widgets[0].status = 'absent'; },
    value => { value.accessibilityWidgets.widgets[0].signals = ['script-src']; },
  ]) {
    const forged = structuredClone(base);
    mutate(forged);
    assert.throws(() => createAuditModel(forged), /widget|invent|schema|sinal|status|ordem|campo|inválid/i);
  }

  const editorialBase = structuredClone(base);
  editorialBase.methodology.supplementalRuleCount += 1;
  editorialBase.methodology.ruleCount += 1;
  editorialBase.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-1', selectorHint: '', message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  editorialBase.occurrences.push({
    occurrenceId: 'occ-editorial-strict', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-1', selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
    mode: 'automated', nodeId: 'n-1', evidenceIds: [],
    justification: 'Há conteúdo provisório inequívoco na página.',
  });
  editorialBase.ruleResults.at(-1).limitations = [{
    code: 'EDITORIAL_NODE_SCAN_TRUNCATED', retainedNodeCount: 5_000,
  }];
  assert.doesNotThrow(() => createAuditModel(editorialBase));
  for (const mutate of [
    value => { value.ruleResults.at(-1).privateText = 'PRIVATE-RESULT'; },
    value => { value.ruleResults.at(-1).source.version = '9.9.9'; },
    value => { value.ruleResults.at(-1).nbrItems = ['5.1.1']; },
    value => { value.occurrences.at(-1).privateText = 'PRIVATE-OCCURRENCE'; },
    value => { value.occurrences.at(-1).target.selector = '#PRIVATE-AUTHOR-ID'; },
    value => { value.occurrences.at(-1).evidenceRefs = ['ev-1']; value.occurrences.at(-1).evidenceIds = ['ev-1']; },
    value => { value.occurrences.at(-1).accessiblePreview = 'PRIVATE-PREVIEW'; },
    value => { value.ruleResults.at(-1).limitations[0].retainedNodeCount = 4_999; },
    value => { value.ruleResults.at(-1).limitations[0].privateText = 'PRIVATE-LIMIT'; },
  ]) {
    const forged = structuredClone(editorialBase);
    mutate(forged);
    assert.throws(() => createAuditModel(forged), /editorial|privad|schema|fonte|versão|evidência|seletor|item|preview|campo|inválid/i);
  }
});

test('rejects a supplemental passed rule and occurrence that try to auto-approve an ABNT item', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const item = NBR17225_ITEMS.find(entry => entry.id === '5.1.2');
  model.methodology = {
    ...model.methodology,
    supplementalRuleCount: model.methodology.supplementalRuleCount + 1,
    ruleCount: model.methodology.ruleCount + 1,
  };
  model.itemResults.find(entry => entry.id === item.id).outcome = 'passed';
  model.ruleResults.push({
    ruleId: 'supplemental.fabricated-pass', outcome: 'passed', mode: 'automated',
    nbrItems: [item.id], targets: [], summary: 'Aprovação suplementar.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-supplemental-pass', pageId: 'page-1', outcome: 'passed',
    classification: item.classification, impact: 'minor', confidence: 'high',
    source: { engine: 'third-party-engine', ruleId: 'supplemental.fabricated-pass', version: '9.9.9' },
    nbrItemRef: item.id, wcagRefs: item.wcag.map(reference => reference.id),
    foreignBenchmarkRefs: [], target: { nodeId: null, selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: item.id, ruleId: 'supplemental.fabricated-pass', mode: 'automated',
    nodeId: null, evidenceIds: [], justification: 'Aprovação suplementar.',
  });

  assert.throws(() => createAuditModel(model), /passad|aprova|autorit|ABNT|suplementar/i);
});

test('rejects a third-party engine that claims an authoritative rule ID to approve ABNT', () => {
  const ruleClaim = structuredClone(createAuditModel(reportInput()));
  const rule = ruleClaim.ruleResults.find(entry => entry.ruleId === 'focus-visible');
  rule.source = { engine: 'third-party-engine', ruleId: rule.ruleId, version: ruleClaim.versions.rules };
  assert.throws(() => createAuditModel(ruleClaim), /audita-core|proveniência|fonte|aprova|autorit/i);

  const occurrenceClaim = structuredClone(createAuditModel(reportInput()));
  const item = NBR17225_ITEMS.find(entry => entry.id === '5.1.1');
  occurrenceClaim.occurrences.push({
    occurrenceId: 'occ-third-party-pass', pageId: 'page-1', outcome: 'passed',
    classification: item.classification, impact: 'minor', confidence: 'high',
    source: { engine: 'third-party-engine', ruleId: 'focus-visible', version: occurrenceClaim.versions.rules },
    nbrItemRef: item.id, wcagRefs: item.wcag.map(reference => reference.id),
    foreignBenchmarkRefs: [], target: { nodeId: null, selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: item.id, ruleId: 'focus-visible', mode: 'automated', nodeId: null,
    evidenceIds: [], justification: 'Aprovação de fonte externa.',
  });
  assert.throws(() => createAuditModel(occurrenceClaim), /audita-core|proveniência|fonte|aprova|autorit/i);
});

test('rejects an authoritative passed rule whose source version differs from the model rules version', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const rule = model.ruleResults.find(entry => entry.ruleId === 'focus-visible');
  rule.source = { engine: 'audita-core', ruleId: rule.ruleId, version: '9.9.9' };

  assert.throws(() => createAuditModel(model), /versão|version|proveniência|fonte|aprova|autorit/i);
});

test('rejects incoherent core provenance for every outcome instead of relabeling it downstream', () => {
  for (const [engine, version] of [
    ['third-party-engine', '1.0.0'],
    ['audita-core', '9.9.9'],
  ]) {
    const model = structuredClone(SAMPLE_AUDIT);
    const rule = model.ruleResults.find(entry => entry.ruleId === 'focus-visible');
    const occurrence = model.occurrences.find(entry => entry.source.ruleId === 'focus-visible');
    rule.source = { engine, ruleId: 'focus-visible', version };
    occurrence.source = { engine, ruleId: 'focus-visible', version };

    assert.throws(
      () => createAuditModel(model),
      /audita-core|proveniência|fonte|engine|versão|version|registro/i,
    );
  }

  const coherent = structuredClone(SAMPLE_AUDIT);
  coherent.ruleResults.find(entry => entry.ruleId === 'focus-visible').source = {
    engine: 'audita-core', ruleId: 'focus-visible', version: coherent.versions.rules,
  };
  assert.deepEqual(createAuditModel(coherent).occurrences[0].source, {
    engine: 'audita-core', ruleId: 'focus-visible', version: '1.0.0',
  });
});

test('rejects a globally coherent forged methodology version outside the local provenance registry', () => {
  const forged = structuredClone(SAMPLE_AUDIT);
  forged.versions.rules = '9.9.9';
  forged.methodology.version = '9.9.9';
  forged.reproducibility.methodologyVersion = '9.9.9';
  for (const rule of forged.ruleResults) {
    if (rule.source.engine !== 'axe-core') rule.source.version = '9.9.9';
  }
  for (const occurrence of forged.occurrences) {
    if (occurrence.source.engine !== 'axe-core') occurrence.source.version = '9.9.9';
  }

  assert.throws(
    () => createAuditModel(forged),
    /proveniência|registro|versão|version|metodologia/iu,
  );
});

test('rejects a forged global rules version even when no source-bearing result remains', () => {
  const forged = structuredClone(SAMPLE_AUDIT);
  forged.versions.rules = '9.9.9';
  forged.methodology.version = '9.9.9';
  forged.reproducibility.methodologyVersion = '9.9.9';
  forged.ruleResults = [];
  forged.occurrences = [];
  forged.manualReview = [];
  forged.reviewDecisions = [];
  forged.itemResults.find(item => item.id === '5.1.2').outcome = 'cantTell';

  assert.throws(
    () => createAuditModel(forged),
    /versão|version|proveniência|registro|metodologia/iu,
  );
});

test('requires each legacy occurrence identity to agree with its registered core or manual source', () => {
  const coreIdentityDrift = structuredClone(SAMPLE_AUDIT);
  coreIdentityDrift.occurrences[0].ruleId = null;
  assert.throws(
    () => createAuditModel(coreIdentityDrift),
    /regra|rule|proveniência|fonte|incoerente/iu,
  );

  const manualVersionDrift = structuredClone(SAMPLE_AUDIT);
  manualVersionDrift.occurrences.find(entry => entry.ruleId === null).source.version = '9.9.9';
  assert.throws(
    () => createAuditModel(manualVersionDrift),
    /manual|proveniência|fonte|versão|version|registro/iu,
  );
});

test('rejects an unknown decision ID used to justify a reviewed ABNT pass', () => {
  const model = structuredClone(applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-cross-page', '5.7.5', 'conforme', 'manual'),
  ]));
  model.itemResults.find(item => item.id === '5.7.5').review.decisionIds = ['decision-unknown'];

  assert.throws(() => createAuditModel(model), /decisão|decision|revisão|aprova|autorit/i);
});

test('rejects reviewed ABNT passes backed by another item or a nonconformity decision', () => {
  const otherItem = structuredClone(applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-focus-review', '5.1.4', 'conforme', 'assisted'),
  ]));
  const borrowedDecisionId = otherItem.reviewDecisions[0].decisionId;
  const borrowedPass = otherItem.itemResults.find(item => item.id === '5.7.5');
  borrowedPass.outcome = 'passed';
  borrowedPass.reviewedOutcome = 'passed';
  borrowedPass.review = { mode: 'manual', evaluator: 'Fiscal de teste', decidedAt: '2026-08-26T15:00:00.000Z', decisionIds: [borrowedDecisionId] };
  assert.throws(() => createAuditModel(otherItem), /decisão|decision|item|revisão|aprova|autorit/i);

  const nonconformity = structuredClone(applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-cross-page', '5.7.5', 'não conforme', 'manual'),
  ]));
  const forgedPass = nonconformity.itemResults.find(item => item.id === '5.7.5');
  forgedPass.outcome = 'passed';
  forgedPass.reviewedOutcome = 'passed';
  assert.throws(() => createAuditModel(nonconformity), /decisão|decision|conforme|revisão|aprova|autorit/i);
});

test('rejects derived evidence whose full-page capture belongs to another page', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  model.requestedScope = {
    mode: 'batch',
    urls: [...model.requestedScope.urls, 'https://second.example.test/'],
  };
  model.pages.push({
    pageId: 'page-2', requestedUrl: 'https://second.example.test/',
    finalUrl: 'https://second.example.test/final', status: 'complete',
    timestamps: {
      startedAt: '2026-08-26T14:02:00.000Z', endedAt: '2026-08-26T14:02:01.000Z',
      generatedAt: '2026-08-26T14:02:02.000Z',
    },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  });
  model.evidence.push({ evidenceId: 'ev-page-1-full', pageId: 'page-1', kind: 'full-page' });
  model.evidence.push({
    evidenceId: 'ev-page-2-element', pageId: 'page-2', kind: 'element',
    fullPageEvidenceId: 'ev-page-1-full',
  });

  assert.throws(() => createAuditModel(model), /captura integral|evidência|outra página/i);
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
