import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';

function model(overrides = {}) {
  const fullPage = Object.freeze({ evidenceId: 'ev-full', kind: 'full-page', hash: 'sha-full' });
  const element = Object.freeze({ evidenceId: 'ev-node', kind: 'element', hash: 'sha-node' });
  return Object.freeze({
    schemaVersion: 1,
    auditId: 'audit-1',
    evidence: Object.freeze({ artifacts: Object.freeze([fullPage, element]) }),
    reproducibility: Object.freeze({ evidenceHash: 'manifest-hash' }),
    ruleResults: Object.freeze([
      Object.freeze({ ruleId: 'auto-rule', outcome: 'failed', mode: 'automated', nbrItems: Object.freeze(['5.1.1']) }),
      Object.freeze({ ruleId: 'assist-rule', outcome: 'cantTell', mode: 'assisted', nbrItems: Object.freeze(['5.1.2']) }),
    ]),
    itemResults: Object.freeze([
      Object.freeze({ id: '5.1.1', outcome: 'failed', evaluation: 'automated' }),
      Object.freeze({ id: '5.1.2', outcome: 'cantTell', evaluation: 'assisted' }),
    ]),
    occurrences: Object.freeze([
      Object.freeze({ occurrenceId: 'occ-auto', itemId: '5.1.1', ruleId: 'auto-rule', mode: 'automated', outcome: 'failed', evidenceIds: Object.freeze(['ev-node']) }),
      Object.freeze({ occurrenceId: 'occ-a', itemId: '5.1.2', ruleId: 'assist-rule', mode: 'assisted', outcome: 'cantTell', evidenceIds: Object.freeze(['ev-full']) }),
      Object.freeze({ occurrenceId: 'occ-b', itemId: '5.1.2', ruleId: 'assist-rule', mode: 'assisted', outcome: 'cantTell', evidenceIds: Object.freeze(['ev-node']) }),
    ]),
    manualReview: Object.freeze([
      Object.freeze({ auditId: 'audit-1', occurrenceId: 'occ-a', itemId: '5.1.2', ruleId: 'assist-rule', mode: 'assisted', status: 'unanswered' }),
      Object.freeze({ auditId: 'audit-1', occurrenceId: 'occ-b', itemId: '5.1.2', ruleId: 'assist-rule', mode: 'assisted', status: 'unanswered' }),
    ]),
    reviewDecisions: Object.freeze([]),
    ...overrides,
  });
}

const decision = (occurrenceId, answer = 'conforme', extra = {}) => createReviewDecision({
  auditId: 'audit-1', itemId: occurrenceId === 'occ-auto' ? '5.1.1' : '5.1.2', occurrenceId,
  answer, evaluator: 'Fiscal Ana', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'assisted', ...extra,
});

test('creates a canonical frozen JSON-safe review decision', () => {
  const value = decision('occ-a', 'não conforme', { note: '  Falha confirmada.  ' });
  assert.equal(value.answer, 'não conforme');
  assert.equal(value.evaluator, 'Fiscal Ana');
  assert.equal(value.note, 'Falha confirmada.');
  assert.equal(value.decidedAt, '2026-08-26T14:00:00.000Z');
  assert.equal(value.mode, 'assisted');
  assert.equal(value.decisionId, 'occ-a');
  assert.equal(Object.isFrozen(value), true);
  assert.doesNotThrow(() => JSON.stringify(value));
});

test('rejects an existing decision whose identifier is not its exact canonical occurrence identity', () => {
  const canonical = decision('occ-a');
  assert.throws(
    () => createReviewDecision({ ...canonical, decisionId: 'decision-forged' }),
    /decisão|identificador|canônic|íntegro/i,
  );
});

test('uses the complete occurrence identity without hashing or truncation', () => {
  const occurrenceId = `occ-${'a'.repeat(196)}`;
  const value = createReviewDecision({
    auditId: 'audit-1', itemId: '5.1.2', occurrenceId, answer: 'conforme',
    evaluator: 'Fiscal Ana', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'assisted',
  });

  assert.equal(value.decisionId, occurrenceId);
  assert.throws(
    () => createReviewDecision({
      auditId: 'audit-1', itemId: '5.1.2', occurrenceId: `${occurrenceId}a`, answer: 'conforme',
      evaluator: 'Fiscal Ana', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'assisted',
    }),
    /identificador|ocorrência|inválid/iu,
  );
});

test('limits evaluator and note by Unicode codepoints without exposing rejected text', () => {
  const evaluatorAtLimit = '🧑'.repeat(160);
  const noteAtLimit = '📝'.repeat(4_000);
  assert.doesNotThrow(() => decision('occ-a', 'conforme', {
    evaluator: evaluatorAtLimit, note: noteAtLimit,
  }));

  for (const change of [
    { evaluator: `${evaluatorAtLimit}🧑` },
    { note: `${noteAtLimit}📝` },
  ]) {
    const marker = Object.values(change)[0];
    assert.throws(() => decision('occ-a', 'conforme', change), error => {
      assert.equal(error instanceof TypeError, true);
      assert.doesNotMatch(error.message, new RegExp(marker.slice(0, 20), 'u'));
      return true;
    });
  }

  for (const change of [
    { evaluator: `${' '.repeat(10_000)}Fiscal` },
    { note: `${' '.repeat(20_000)}Nota` },
  ]) {
    assert.throws(() => decision('occ-a', 'conforme', change), /avaliador|nota|inválid/iu);
  }
});

test('keeps the derived evaluator summary bounded after seven maximum-size human names', () => {
  const occurrenceIds = Array.from({ length: 7 }, (_, index) => `occ-review-${index + 1}`);
  const base = model({
    occurrences: Object.freeze([
      Object.freeze({ occurrenceId: 'occ-auto', itemId: '5.1.1', ruleId: 'auto-rule', mode: 'automated', outcome: 'failed', evidenceIds: Object.freeze(['ev-node']) }),
      ...occurrenceIds.map(occurrenceId => Object.freeze({
        occurrenceId, itemId: '5.1.2', ruleId: 'assist-rule', mode: 'assisted',
        outcome: 'cantTell', evidenceIds: Object.freeze(['ev-node']),
      })),
    ]),
    manualReview: Object.freeze(occurrenceIds.map(occurrenceId => Object.freeze({
      auditId: 'audit-1', occurrenceId, itemId: '5.1.2', ruleId: 'assist-rule',
      mode: 'assisted', status: 'unanswered',
    }))),
  });
  const decisions = occurrenceIds.map((occurrenceId, index) => decision(occurrenceId, 'conforme', {
    evaluator: `${index + 1}${'x'.repeat(159)}`,
  }));
  const reviewed = applyReviewDecisions(base, decisions);
  const evaluator = reviewed.itemResults.find(item => item.id === '5.1.2').review.evaluator;
  assert.ok([...evaluator].length <= 640, 'o resumo agregado precisa permanecer dentro do limite explícito');
  assert.equal(reviewed.reviewDecisions.length, 7, 'os nomes completos continuam no histórico bounded de decisões');
});

test('rejects invalid IDs, answers, evaluator, timestamps and modes', () => {
  for (const change of [
    { auditId: '' }, { itemId: ' ' }, { occurrenceId: '' }, { answer: 'sim' },
    { evaluator: '' }, { decidedAt: 'amanhã' }, { decidedAt: '2026-08-26T14:00:00Z' },
    { decidedAt: 'August 26, 2026 14:00:00 UTC' }, { mode: 'semiAuto' },
  ]) {
    assert.throws(() => createReviewDecision({
      auditId: 'audit-1', itemId: '5.1.2', occurrenceId: 'occ-a', answer: 'conforme',
      evaluator: 'Fiscal', decidedAt: '2026-08-26T10:00:00Z', mode: 'manual', ...change,
    }), /decis|resposta|avaliador|data|modo|identificador/i);
  }
});

test('requires a plain decision with own contractual properties', () => {
  const inherited = Object.create({
    auditId: 'audit-1', itemId: '5.1.2', occurrenceId: 'occ-a', answer: 'conforme',
    evaluator: 'Fiscal', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'manual',
  });
  assert.throws(() => createReviewDecision(inherited), /própr|decisão|campo/i);
  assert.throws(() => createReviewDecision([]), /decisão/i);
  let accessed = false;
  const hostile = {
    auditId: 'audit-1', itemId: '5.1.2', occurrenceId: 'occ-a', answer: 'conforme',
    evaluator: 'Fiscal', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'manual',
    get payload() { accessed = true; return 'não executar'; },
  };
  assert.throws(() => createReviewDecision(hostile), /dados|propriedade|decisão/i);
  assert.equal(accessed, false);
});

test('requires known audit, item and occurrence links and rejects ambiguous duplicates', () => {
  assert.throws(() => applyReviewDecisions(model(), [decision('occ-a', 'conforme', { auditId: 'other' })]), /auditoria/i);
  assert.throws(() => applyReviewDecisions(model(), [decision('occ-a', 'conforme', { itemId: 'unknown' })]), /item/i);
  assert.throws(() => applyReviewDecisions(model(), [decision('unknown')]), /ocorrência/i);
  assert.throws(() => applyReviewDecisions(model(), [decision('occ-a'), decision('occ-a', 'não conforme')]), /duplic|ambígua/i);
});

test('snapshots a bounded dense decision list without invoking accessor slots or exposing their errors', () => {
  const marker = 'PRIVATE_REVIEW_DECISION_SLOT';
  let getterReads = 0;
  const hostile = new Array(1);
  Object.defineProperty(hostile, '0', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });

  let caught;
  try {
    applyReviewDecisions(model(), hostile);
  } catch (error) {
    caught = error;
  }

  assert.equal(getterReads, 0);
  assert.ok(caught instanceof TypeError);
  assert.doesNotMatch(String(caught?.message), new RegExp(marker));

  const sparse = new Array(1);
  assert.throws(() => applyReviewDecisions(model(), sparse), /decis|lista|densa|inválid/i);
  assert.throws(
    () => applyReviewDecisions(model(), new Array(10_001).fill(decision('occ-a'))),
    /decis|lista|limit|inválid/i,
  );
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.throws(() => applyReviewDecisions(model(), revoked.proxy), error => {
    assert.equal(error instanceof TypeError, true);
    assert.doesNotMatch(String(error?.message), /proxy|revoked|private/iu);
    return true;
  });
});

test('requires the review queue to match the audit, rule and mode exactly', () => {
  for (const change of [
    { auditId: 'audit-other' },
    { ruleId: 'rule-other' },
    { mode: 'manual' },
  ]) {
    const corrupted = structuredClone(model());
    Object.assign(corrupted.manualReview[0], change);
    assert.throws(
      () => applyReviewDecisions(corrupted, [decision('occ-a')]),
      /auditoria|fila|regra|modo|correspond/i,
    );
  }
});

test('rejects a queue and occurrence forged together onto a rule outside the original rule inventory', () => {
  const corrupted = structuredClone(model());
  corrupted.occurrences.find(entry => entry.occurrenceId === 'occ-a').ruleId = 'rule-forged';
  corrupted.manualReview.find(entry => entry.occurrenceId === 'occ-a').ruleId = 'rule-forged';

  assert.throws(
    () => applyReviewDecisions(corrupted, [decision('occ-a')]),
    /regra|inventário|ocorrência|fila/i,
  );
});

test('rejects an answered queue that has no exact prior decision', () => {
  const corrupted = structuredClone(model());
  corrupted.manualReview[0].status = 'answered';
  corrupted.manualReview[0].decisionId = 'decision-forged';

  assert.throws(
    () => applyReviewDecisions(corrupted, [decision('occ-a')]),
    /respond|histórico|decisão|fila/i,
  );
});

test('rejects a decision whose mode differs from its exact review queue', () => {
  assert.throws(
    () => applyReviewDecisions(model(), [decision('occ-a', 'conforme', { mode: 'manual' })]),
    /fila|modo|correspond/i,
  );
});

test('preserves every original failed item when a cantTell occurrence is reviewed as conforming', () => {
  const original = structuredClone(model());
  const item = original.itemResults.find(entry => entry.id === '5.1.2');
  item.outcome = 'failed';
  item.originalOutcome = 'failed';

  const reviewed = applyReviewDecisions(original, [decision('occ-a'), decision('occ-b')]);

  assert.equal(reviewed.itemResults.find(entry => entry.id === '5.1.2').outcome, 'failed');
  assert.equal(reviewed.itemResults.find(entry => entry.id === '5.1.2').originalOutcome, 'failed');
});

test('validates the integrity of previously stored decisions before applying new ones', () => {
  const corrupt = model({ reviewDecisions: Object.freeze([Object.freeze({
    auditId: 'audit-1', itemId: 'unknown', occurrenceId: 'unknown', answer: 'conforme',
    evaluator: 'Fiscal', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'manual',
  })]) });
  assert.throws(() => applyReviewDecisions(corrupt, []), /item|ocorrência|histórico|canônic/i);

  const once = applyReviewDecisions(model(), [decision('occ-a')]);
  for (const mutate of [
    value => { value.reviewDecisions[0].evaluator = ` ${value.reviewDecisions[0].evaluator} `; },
    value => { value.reviewDecisions[0].note = ''; },
  ]) {
    const noncanonical = structuredClone(once);
    mutate(noncanonical);
    assert.throws(
      () => applyReviewDecisions(noncanonical, []),
      /histórico|decisão|canônic|íntegro|inválid/iu,
    );
  }
});

test('rejects every duplicate already present in immutable decision history', () => {
  const once = applyReviewDecisions(model(), [decision('occ-a')]);
  const duplicated = structuredClone(once);
  duplicated.reviewDecisions.push(structuredClone(duplicated.reviewDecisions[0]));

  assert.throws(
    () => applyReviewDecisions(duplicated, []),
    /histórico|duplic|decisão|inválid/iu,
  );
});

test('never replaces an immutable occurrence decision when answer or note changes', () => {
  const once = applyReviewDecisions(model(), [decision('occ-a', 'conforme', { note: 'Primeira decisão.' })]);
  for (const changed of [
    decision('occ-a', 'não conforme', { note: 'Primeira decisão.' }),
    decision('occ-a', 'conforme', { note: 'Nota alterada.' }),
  ]) {
    assert.throws(() => applyReviewDecisions(once, [changed]), error => {
      assert.equal(error instanceof TypeError, true);
      assert.doesNotMatch(error.message, /Primeira decisão|Nota alterada/iu);
      return true;
    });
  }
});

test('rejects human decisions for conclusive failed, passed, inapplicable or untested occurrences', () => {
  const original = model();
  assert.throws(() => applyReviewDecisions(original, [decision('occ-auto')]), /cantTell|inconclus|revis|resultado/i);

  for (const outcome of ['passed', 'inapplicable', 'untested']) {
    const conclusive = structuredClone(original);
    conclusive.occurrences[0].outcome = outcome;
    assert.throws(
      () => applyReviewDecisions(conclusive, [decision('occ-auto')]),
      /cantTell|inconclus|revis|resultado/i,
    );
  }
});

test('aggregates review answers conservatively across all reviewable occurrences', () => {
  const incomplete = applyReviewDecisions(model(), [decision('occ-a')]);
  assert.equal(incomplete.itemResults.find(item => item.id === '5.1.2').outcome, 'cantTell');

  const unknown = applyReviewDecisions(model(), [
    decision('occ-a'), decision('occ-b', 'não foi possível determinar'),
  ]);
  assert.equal(unknown.itemResults.find(item => item.id === '5.1.2').outcome, 'cantTell');

  const failed = applyReviewDecisions(model(), [decision('occ-a'), decision('occ-b', 'não conforme')]);
  assert.equal(failed.itemResults.find(item => item.id === '5.1.2').outcome, 'failed');

  const passed = applyReviewDecisions(model(), [decision('occ-a'), decision('occ-b')]);
  const item = passed.itemResults.find(value => value.id === '5.1.2');
  assert.equal(item.outcome, 'passed');
  assert.equal(item.originalOutcome, 'cantTell');
  assert.equal(item.reviewedOutcome, 'passed');
  assert.equal(item.review.mode, 'assisted');
  assert.equal(item.review.evaluator, 'Fiscal Ana');
});

test('preserves evidence and reproducibility while invalidating stale report integrity after review', () => {
  const original = model();
  const reviewed = applyReviewDecisions(original, [decision('occ-a'), decision('occ-b')]);
  assert.deepEqual(reviewed.evidence, original.evidence);
  assert.deepEqual(reviewed.reproducibility, original.reproducibility);
  assert.notStrictEqual(reviewed.evidence, original.evidence);
  assert.deepEqual(reviewed.occurrences.map(item => item.evidenceIds), original.occurrences.map(item => item.evidenceIds));
  assert.equal(Object.isFrozen(reviewed), true);
  assert.doesNotThrow(() => JSON.stringify(reviewed));

  const sealed = structuredClone(SAMPLE_AUDIT);
  sealed.integrity.canonicalModelHash = 'a'.repeat(64);
  sealed.integrity.evidenceManifestHash = 'b'.repeat(64);
  sealed.report = {
    status: 'complete', reviewUrl: null,
    artifact: {
      status: 'complete', pdfFallback: false, limitations: [],
      formats: ['html', 'json', 'csv', 'pdf'].map(format => ({ format, status: 'prepared' })),
    },
  };
  const decisionInput = createReviewDecision({
    auditId: sealed.auditId, itemId: '5.1.4', occurrenceId: 'occ-focus-review',
    answer: 'conforme', evaluator: 'Fiscal Ana', decidedAt: '2026-08-26T15:00:00.000Z', mode: 'assisted',
  });
  const invalidated = applyReviewDecisions(sealed, [decisionInput]);
  assert.equal(invalidated.integrity.canonicalModelHash, 'pending');
  assert.equal(invalidated.integrity.evidenceManifestHash, 'b'.repeat(64));
  assert.deepEqual(invalidated.report, {
    status: 'review-ready', reviewUrl: null,
    artifact: { status: 'pending', formats: [] },
  });
  assert.deepEqual(invalidated.evidence, sealed.evidence);
  assert.deepEqual(invalidated.reproducibility, sealed.reproducibility);
});

test('never freezes or mutates any object reachable from the input model', () => {
  const input = structuredClone(model());
  const evidence = input.evidence;
  const artifact = evidence.artifacts[0];
  const reviewed = applyReviewDecisions(input, [decision('occ-a'), decision('occ-b')]);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(evidence), false);
  assert.equal(Object.isFrozen(artifact), false);
  assert.deepEqual(reviewed.evidence, evidence);
  assert.notStrictEqual(reviewed.evidence, evidence);
});

test('captures the audit once before decision proxy traps can mutate the source graph', () => {
  const input = structuredClone(model({ limitations: Object.freeze([]) }));
  const rawDecision = {
    auditId: 'audit-1', itemId: '5.1.2', occurrenceId: 'occ-a', answer: 'conforme',
    evaluator: 'Fiscal Ana', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'assisted',
  };
  let mutated = false;
  const hostileDecision = new Proxy(rawDecision, {
    getPrototypeOf(target) {
      if (!mutated) {
        mutated = true;
        input.limitations.push('MUTAÇÃO TARDIA NÃO PODE CRUZAR A FRONTEIRA');
      }
      return Reflect.getPrototypeOf(target);
    },
  });

  const reviewed = applyReviewDecisions(input, [hostileDecision]);

  assert.equal(mutated, true, 'o trap hostil deve ser exercitado pelo teste');
  assert.equal(input.limitations.length, 1, 'a origem mutável comprova a tentativa tardia');
  assert.deepEqual(reviewed.limitations, []);
  assert.doesNotMatch(JSON.stringify(reviewed), /MUTAÇÃO TARDIA/u);
});

test('rejects audit models whose contractual IDs are inherited or ambiguous', () => {
  const inheritedAudit = Object.create({ auditId: 'audit-1' });
  Object.assign(inheritedAudit, { itemResults: [], occurrences: [], ruleResults: [], manualReview: [], reviewDecisions: [] });
  assert.throws(() => applyReviewDecisions(inheritedAudit, []), /modelo|própr/i);
});
