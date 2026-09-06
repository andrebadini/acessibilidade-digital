import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';

import { projectPageMarkers } from '../../src/background/page-marker-projection.js';
const OPTIONS = { now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
  manifestVersion: '1.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/152.0.0.0' };
async function snapshot(change = () => {}, decisions = []) {
  const draft = structuredClone(SAMPLE_AUDIT);
  change(draft);
  const reviewed = decisions.length ? applyReviewDecisions(draft, decisions) : draft;
  const model = await enrichAuditForReport(reviewed, OPTIONS);
  return { model, modelRevision: 7, modelHash: model.integrity.canonicalModelHash };
}
function project(input) {
  return projectPageMarkers(input);
}
function addReviewTarget(draft, suffix = 'second') {
  const source = draft.occurrences.find(row => row.occurrenceId === 'occ-focus-review');
  const nodeId = `node-${suffix}`;
  const occurrenceId = `occ-review-${suffix}`;
  const evidenceId = `evidence-${suffix}`;
  draft.ruleResults.find(row => row.ruleId === 'focus-order').targets.push(nodeId);
  draft.occurrences.push({ ...structuredClone(source), occurrenceId, nodeId,
    target: { nodeId, selector: null, framePath: [] }, evidenceIds: [evidenceId], evidenceRefs: [evidenceId] });
  draft.manualReview.push({ ...structuredClone(draft.manualReview[0]), occurrenceId });
  draft.evidence.push({ ...structuredClone(draft.evidence[1]), evidenceId, nodeId, backendNodeId: 42,
    selector: { css: `button#${suffix}`, framePath: [] }, snippet: `<button id="${suffix}">Enviar</button>` });
}

test('idless evidence uses corroborated safe classes, never bare ordinal or private content', async () => {
  const input = await snapshot(draft => {
    draft.evidence[1].selector.css = 'main > button:nth-of-type(2)';
    draft.evidence[1].snippet = '<button class="primary\t\n\f\r action">Texto reservado</button>';
  });
  const result = project({ snapshot: input, pageId: 'page-1' });
  assert.equal(result.public.counts.locatedOccurrences, 2);
  assert.deepEqual(result.private.candidates[0].match,
    { tag: 'button', id: null, classes: ['action', 'primary'], path: 'main > button:nth-of-type(2)' });
  assert.doesNotMatch(JSON.stringify(result.public), /primary|action|reservado|nth-of-type/u);
});

test('idless class fallback rejects contradictory, unsafe and duplicated evidence attributes', async () => {
  for (const [css, snippet] of [
    ['button.other', '<button class="primary">Enviar</button>'],
    ['button.primary.other', '<button class="primary">Enviar</button>'],
    ['main.scope > button', '<button class="primary">Enviar</button>'],
    ['main#scope > button', '<button class="primary">Enviar</button>'],
    ['button#primary', '<button class="primary">Enviar</button>'],
    ['button', '<a class="primary">Enviar</a>'],
    ['button', '<button><span class="primary">Enviar</span></button>'],
    ['button[type="submit"]', '<button class="primary" type="reset">Enviar</button>'],
    ['button', '<button class="token-private">Enviar</button>'],
    ['button', '<button class="primary" class="other">Enviar</button>'],
    ['button', '<button id="" class="primary">Enviar</button>'],
  ]) {
    const input = await snapshot(draft => Object.assign(draft.evidence[1], { selector: { css, framePath: [] }, snippet }));
    assert.equal(project({ snapshot: input, pageId: 'page-1' }).private.candidates.length, 0, snippet);
  }
});

test('same node shares a marker while distinct checks and ABNT items remain independent', async () => {
  const input = await snapshot();
  const result = project({ snapshot: input, pageId: 'page-1' });
  assert.equal(result.private.kind, 'PageMarkerPrivateProjectionV1');
  assert.equal(result.private.candidates.length, 1);
  const candidate = result.private.candidates[0];
  assert.equal(candidate.pageId, 'page-1');
  assert.equal(candidate.nodeId, 'n-1');
  assert.deepEqual(candidate.match, { tag: 'button', id: 'continuar' });
  assert.equal(candidate.selector.value, 'button#continuar');
  const signals = result.private.signals.filter(row => candidate.selectionIds.includes(row.selectionId));
  assert.deepEqual(signals.map(row => [row.occurrenceId, row.abntItem, row.classification]), [
    ['occ-focus-failed', '5.1.1', 'failed'], ['occ-focus-review', '5.1.4', 'manual-review'],
  ]);
  assert.notEqual(signals[0].checkKey, signals[1].checkKey);
  assert.equal(result.public.markers[0].count, 2);
  assert.equal(result.public.markers[0].classification, 'failed');
  assert.equal(result.public.general.length, 1);
  assert.equal(result.public.unlocated.length, 0);
});

test('human decision applies only to that occurrence, not every target of the same check', async () => {
  const decision = createReviewDecision({ auditId: SAMPLE_AUDIT.auditId,
    itemId: '5.1.4', occurrenceId: 'occ-focus-review', answer: 'conforme', evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T15:00:00.000Z', mode: 'assisted', note: 'Ordem de foco verificada.' });
  const input = await snapshot(draft => addReviewTarget(draft), [decision]);
  const result = project({ snapshot: input, pageId: 'page-1' });
  const first = result.private.signals.find(row => row.occurrenceId === 'occ-focus-review');
  const second = result.private.signals.find(row => row.occurrenceId === 'occ-review-second');
  assert.equal(first.checkKey, second.checkKey);
  assert.equal(first.originalOutcome, 'cantTell');
  assert.equal(first.displayOutcome, 'passed');
  assert.equal(first.classification, 'passed');
  assert.equal(second.displayOutcome, 'cantTell');
  assert.equal(second.classification, 'manual-review');
  assert.equal(input.model.occurrences.find(row => row.occurrenceId === first.occurrenceId).outcome, 'cantTell');
});

test('public projection exposes opaque selectors of results, never source data or locators', async () => {
  const input = await snapshot();
  const result = project({ snapshot: input, pageId: 'page-1' });
  const serialized = JSON.stringify(result.public);
  for (const forbidden of [input.model.auditId, 'page-1', 'n-1', 'occ-focus', 'ev-control',
    'continuar', 'https:', 'sha256', input.modelHash, '<button', 'Continuar', '5.1.1']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(result.public.markers[0].markerId, /^m\d+$/u);
  assert.ok(result.public.markers[0].selectionIds.every(id => /^s\d+$/u.test(id)));
  assert.equal(Object.isFrozen(result.private.candidates[0].match), true);
  assert.equal(Object.isFrozen(result.public.markers), true);
  assert.equal(JSON.stringify(result).includes('<button'), false);
  assert.equal(JSON.stringify(result).includes('https:'), false);
  assert.deepEqual(result, project({ snapshot: input, pageId: 'page-1' }));
});

test('conflicting element evidence does not choose an arbitrary selector', async () => {
  const input = await snapshot(draft => {
    const second = { ...structuredClone(draft.evidence[1]), evidenceId: 'ev-conflict',
      selector: { css: 'a#different', framePath: [] }, snippet: '<a id="different">Outro</a>' };
    draft.evidence.push(second);
    draft.occurrences[0].evidenceRefs.push(second.evidenceId);
    draft.occurrences[0].evidenceIds.push(second.evidenceId);
  });
  const result = project({ snapshot: input, pageId: 'page-1' });
  assert.equal(result.public.markers.length, 0);
  assert.equal(result.public.unlocated.length, 2);
  assert.ok(result.public.unlocated.every(row => row.reason === 'conflicting-evidence'));
});

test('conflicting frame contexts isolate one occurrence while preserving general and other target', async () => {
  const input = await snapshot(draft => {
    addReviewTarget(draft);
    draft.evidence[1].selector.framePath = ['frame-one'];
    draft.evidence.push({ ...structuredClone(draft.evidence[1]), evidenceId: 'ev-other',
      selector: { css: 'button#continuar', framePath: ['frame-two'] } });
    draft.occurrences[0].evidenceRefs.push('ev-other');
    draft.occurrences[0].evidenceIds.push('ev-other');
  });
  const result = project({ snapshot: input, pageId: 'page-1' });
  const byOccurrence = new Map(result.private.signals.map(row => [row.occurrenceId, row.selectionId]));
  assert.deepEqual(result.public.unlocated.find(row => row.selectionId === byOccurrence.get('occ-focus-failed')),
    { selectionId: byOccurrence.get('occ-focus-failed'), classification: 'failed', reason: 'conflicting-evidence' });
  assert.equal(result.public.general.length, 1);
  assert.equal(result.public.general[0].selectionId, byOccurrence.get('occ-cross-page'));
  assert.equal(result.public.markers.length, 1);
  assert.deepEqual(result.public.markers[0].selectionIds, [byOccurrence.get('occ-review-second')]);
  assert.equal(result.private.candidates[0].match.id, 'second');
  assert.deepEqual(result.public.counts, {
    totalOccurrences: 4, locatedOccurrences: 1, generalOccurrences: 1, unlocatedOccurrences: 2,
  });
});

test('global checks stay general while missing element evidence is unlocated', async () => {
  const input = await snapshot(draft => {
    draft.evidence = draft.evidence.filter(row => row.kind !== 'element');
    for (const row of draft.occurrences) {
      row.evidenceRefs = ['ev-full']; row.evidenceIds = ['ev-full'];
    }
  });
  const result = project({ snapshot: input, pageId: 'page-1' });
  assert.equal(result.public.markers.length, 0);
  assert.equal(result.public.general.length, 1);
  assert.equal(result.public.unlocated.length, 2);
  assert.ok(result.public.unlocated.every(row => row.reason === 'missing-evidence'));
});

test('positional, unsafe, frame, and mismatched snippets remain explicitly unlocated', async () => {
  for (const [css, framePath, snippet, expected] of [
    ['button:nth-of-type(2)', [], '<button>Enviar</button>', 'insufficient-correspondence'],
    ['button#token', [], '<button id="token">Enviar</button>', 'unsupported-selector'],
    ['button#continuar', ['frame-one'], '<button id="continuar">Enviar</button>', 'unsupported-context'],
    ['button#continuar', [], '<a id="continuar">Enviar</a>', 'insufficient-correspondence'],
    ['button#continuar', [], '<button id="other">Enviar</button>', 'insufficient-correspondence'],
    ['#continuar', [], '', 'insufficient-correspondence'],
    ['button#continuar', [], '<button id="continuar" id="other">Enviar</button>', 'insufficient-correspondence'],
  ]) {
    const input = await snapshot(draft => { Object.assign(draft.evidence[1], { selector: { css, framePath }, snippet }); });
    const result = project({ snapshot: input, pageId: 'page-1' });
    assert.equal(result.public.markers.length, 0, css);
    assert.equal(result.public.unlocated[0].reason, expected, css);
  }
});

test('requires verified model, matching hash/revision, closed envelopes and an existing page', async () => {
  const input = await snapshot();
  let getters = 0;
  const accessor = { pageId: 'page-1' };
  Object.defineProperty(accessor, 'snapshot', { enumerable: true, get() { getters += 1; throw new Error('private'); } });
  for (const args of [accessor, { snapshot: input, pageId: 'foreign' },
    { snapshot: input, pageId: 'page-1', rawUrl: 'private' },
    { snapshot: { ...input, model: structuredClone(input.model) }, pageId: 'page-1' },
    { snapshot: { ...input, modelRevision: 0 }, pageId: 'page-1' },
    { snapshot: { ...input, modelHash: 'f'.repeat(64) }, pageId: 'page-1' }]) {
    assert.throws(() => project(args), { name: 'TypeError', message: 'PAGE_MARKER_PROJECTION_INVALID' });
  }
  assert.equal(getters, 0);
});

test('same node id on another page remains scoped to its own verified page', async () => {
  const first = await snapshot();
  const second = await snapshot(draft => {
    draft.pages[0].pageId = 'page-2';
    for (const row of [...draft.occurrences, ...draft.evidence]) row.pageId = 'page-2';
  });
  for (const [input, pageId] of [[first, 'page-1'], [second, 'page-2']]) {
    const result = project({ snapshot: input, pageId });
    assert.equal(result.private.candidates.length, 1);
    assert.ok(result.private.candidates.every(row => row.pageId === pageId));
    assert.ok(result.private.signals.every(row => row.pageId === pageId));
    assert.equal(result.public.counts.totalOccurrences, 3);
  }
});

test('supplemental failure remains an alert without inventing an ABNT item', async () => {
  const input = await snapshot(draft => {
    draft.methodology.supplementalRuleCount += 1;
    draft.methodology.ruleCount += 1;
    draft.ruleResults.push({ ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
      classification: 'editorial', impact: 'minor', confidence: 'high',
      source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
      nbrItems: [], wcag: [], targets: [{ nodeId: 'n-1', selectorHint: '',
        message: 'Substitua o conteúdo provisório antes da publicação.', data: { reason: 'placeholder-text' } }],
      summary: 'Há conteúdo provisório inequívoco na página.', limitations: [] });
    draft.occurrences.push({ occurrenceId: 'occ-editorial', pageId: 'page-1', outcome: 'failed',
      classification: 'editorial', impact: 'minor', confidence: 'high',
      source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
      nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
      target: { nodeId: 'n-1', selector: null, framePath: [] }, accessiblePreview: null,
      evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
      mode: 'automated', nodeId: 'n-1', evidenceIds: [],
      justification: 'Há conteúdo provisório inequívoco na página.' });
  });
  const result = project({ snapshot: input, pageId: 'page-1' });
  const signal = result.private.signals.find(row => row.occurrenceId === 'occ-editorial');
  assert.equal(signal.classification, 'alert');
  assert.equal(signal.abntItem, null);
  assert.equal(result.public.markers[0].count, 3);
  assert.equal(result.public.markers[0].classification, 'failed');
});

test('declared evidence budget rejects oversized verified models instead of silently truncating', async () => {
  const input = await snapshot(draft => {
    for (let index = 0; index < 4999; index += 1) {
      draft.evidence.push({ ...structuredClone(draft.evidence[1]), evidenceId: `extra-${index}` });
    }
  });
  assert.equal(input.model.evidence.length, 5001);
  assert.throws(() => project({ snapshot: input, pageId: 'page-1' }), {
    name: 'TypeError', message: 'PAGE_MARKER_PROJECTION_INVALID',
  });
});
