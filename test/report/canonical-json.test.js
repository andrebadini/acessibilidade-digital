import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditModel } from '../../src/core/report/audit-model.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { NBR17225_EDITORIAL_NOTES } from '../../src/core/normative/nbr17225.js';
import { reportInput } from './helpers.js';

test('canonical JSON is independent of insertion order at every object depth', () => {
  const left = { z: [{ beta: 2, alpha: 1 }], a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, z: [{ alpha: 1, beta: 2 }] };
  assert.equal(canonicalStringify(left), '{"a":{"c":3,"d":4},"z":[{"alpha":1,"beta":2}]}');
  assert.equal(canonicalStringify(left), canonicalStringify(right));
});

test('canonical JSON rejects cycles, non-finite values, unsafe keys and executable data', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { throw new Error('não executar'); } });
  for (const value of [cyclic, { value: NaN }, { value: Infinity }, { value: undefined }, { value() {} }, accessor, JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: 'forged' }]) {
    assert.throws(() => canonicalStringify(value), /canôn|json|ciclo|finito|propriedade|chave/i);
  }
});

test('SHA-256 hashes strings and byte views consistently in browser-compatible code', async () => {
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await sha256Hex('abc'), expected);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), expected);
  await assert.rejects(sha256Hex({ text: 'abc' }), /string|bytes|binário/i);
});

test('creates a sanitized frozen report model without mutating or freezing input', () => {
  const input = reportInput();
  const originalItem = input.itemResults[0];
  const model = createAuditModel(input);
  assert.equal(model.itemResults.length, 146);
  assert.equal(model.auditId, 'audit-report-1');
  assert.equal(model.requestedUrl, 'https://example.test/path?view=public');
  assert.equal(model.finalUrl, 'https://example.test/final?view=public');
  assert.equal(model.timezone, 'America/Cuiaba');
  assert.deepEqual(model.versions, { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' });
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.itemResults), true);
  assert.notStrictEqual(model.itemResults[0], originalItem);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(originalItem), false);
  assert.doesNotMatch(JSON.stringify(model), /REMOVE|token=|session=/i);
});

test('rejects incomplete models and broken item, occurrence or evidence links', () => {
  const missingItem = reportInput({ itemResults: reportInput().itemResults.slice(1) });
  const unknownItem = reportInput({ occurrences: [{ occurrenceId: 'occ-x', itemId: 'unknown', ruleId: null, outcome: 'cantTell', mode: 'manual', nodeId: null, evidenceIds: [], justification: 'Revisão.' }] });
  const unknownEvidence = reportInput({ occurrences: [{ occurrenceId: 'occ-x', itemId: '5.1.1', ruleId: null, outcome: 'cantTell', mode: 'manual', nodeId: null, evidenceIds: ['missing'], justification: 'Revisão.' }] });
  assert.throws(() => createAuditModel(missingItem), /146|item/i);
  assert.throws(() => createAuditModel(unknownItem), /item|ocorrência/i);
  assert.throws(() => createAuditModel(unknownEvidence), /evidência/i);
});

test('rejects a forged 146-item catalogue and every altered normative field', () => {
  const mutations = [
    input => { input.itemResults[0].id = '9.9.9'; },
    input => { input.itemResults[0].printedId = '5.1.0'; },
    input => { input.itemResults[0].title = 'Indicador de foco adulterado'; },
    input => { input.itemResults[0].title += ' '; },
    input => { input.itemResults[0].classification = 'recommendation'; },
    input => { input.itemResults[0].wcag[0].level = 'AAA'; },
    input => { input.itemResults[0].evaluation = 'assisted'; },
    input => { input.itemResults[0].ruleIds = ['forged-rule']; },
    input => { input.itemResults[0].humanReason = 'Texto normativo inventado.'; },
  ];
  for (const mutate of mutations) {
    const input = reportInput();
    mutate(input);
    assert.throws(() => createAuditModel(input), /catálogo|normativ|item|canôn/i);
  }
});

test('validates coherent methodology and the optional normative editorial record', () => {
  const normative = {
    edition: 'ABNT NBR 17225:2025',
    wcag: 'WCAG 2.2',
    editorialNotes: structuredClone(NBR17225_EDITORIAL_NOTES),
  };
  assert.doesNotThrow(() => createAuditModel(reportInput({ normative })));
  for (const methodology of [
    { name: 'Audita Acessibilidade', version: '1.0.0', ruleCount: 129, itemCount: 146 },
    { name: 'Audita Acessibilidade', version: '9.9.9', ruleCount: 130, itemCount: 146 },
    { name: 'Audita Acessibilidade ', version: '1.0.0', ruleCount: 130, itemCount: 146 },
    { name: 'Audita Acessibilidade', version: '1.0.0', ruleCount: 130, itemCount: 145 },
  ]) assert.throws(() => createAuditModel(reportInput({ methodology })), /metodologia|methodology|regra|item|versão|canôn/i);

  const alteredNote = structuredClone(normative);
  alteredNote.editorialNotes[0].rationale = 'Errata oficial inexistente.';
  assert.throws(() => createAuditModel(reportInput({ normative: alteredNote })), /normativ|editorial/i);
});

test('validates every rule, occurrence, evidence and review graph link', () => {
  const probes = [
    reportInput({ ruleResults: [{ ruleId: 'rule-x', outcome: 'passed', mode: 'automated', nbrItems: ['unknown'], targets: [], summary: 'x', limitations: [] }] }),
    reportInput({ occurrences: [{ occurrenceId: 'occ-x', itemId: '5.1.4', ruleId: 'unknown', outcome: 'cantTell', mode: 'assisted', nodeId: null, evidenceIds: [], justification: 'Revisão.' }] }),
    reportInput({ occurrences: [{ occurrenceId: 'occ-x', itemId: '5.1.4', ruleId: null, outcome: 'cantTell', mode: 'assisted', nodeId: null, evidenceIds: [], justification: 'Revisão.' }] }),
    reportInput({ evidence: { stateCount: 1, artifacts: [{ evidenceId: 'ev-1', kind: 'element', fullPageEvidenceId: 'missing', hash: 'sha' }] } }),
    reportInput({ manualReview: [{ occurrenceId: 'unknown', itemId: '5.1.4', ruleId: 'rule-assisted', mode: 'assisted', status: 'unanswered', question: 'Pergunta?', reason: 'Razão.' }] }),
    reportInput({ manualReview: [{ occurrenceId: 'occ-1', itemId: '5.1.4', ruleId: 'rule-assisted', mode: 'assisted', status: 'forged', question: 'Pergunta?', reason: 'Razão.' }] }),
    reportInput({ reviewDecisions: [{ decisionId: 'decision-forged', auditId: 'audit-report-1', itemId: '5.1.4', occurrenceId: 'unknown', answer: 'conforme', evaluator: 'Fiscal', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'assisted' }] }),
    reportInput({ reviewDecisions: [{ decisionId: 'decision-forged', auditId: 'audit-report-1', itemId: '5.1.4', occurrenceId: 'occ-1', answer: 'sim', evaluator: 'Fiscal', decidedAt: 'amanhã', mode: 'assisted' }] }),
  ];
  for (const input of probes) assert.throws(() => createAuditModel(input), /regra|item|ocorrência|evidência|revisão|decisão|status|resposta|data/i);
});

test('preserves legitimate failed and cancelled terminal sessions without touching input', () => {
  for (const status of ['failed', 'cancelled']) {
    const input = reportInput({ session: { status, diagnostics: [], partial: false } });
    const model = createAuditModel(input);
    assert.equal(model.session.status, status);
    assert.equal(input.session.status, status);
    assert.equal(Object.isFrozen(input), false);
  }
});

test('rejects whitespace and non-ISO instants across report and diagnostic timestamps', () => {
  for (const key of ['startedAt', 'endedAt', 'generatedAt']) {
    const input = reportInput();
    input.timestamps[key] = ` ${input.timestamps[key]}`;
    assert.throws(() => createAuditModel(input), /timestamp|ISO|data|canôn/i);
  }
  for (const at of [' 2026-08-26T14:00:30.000Z', '26 de agosto de 2026']) {
    const input = reportInput();
    input.session.diagnostics[0].at = at;
    assert.throws(() => createAuditModel(input), /diagnóst|ISO|data|canôn/i);
  }
});

test('validates diagnostic records while preserving serializable details without input mutation', () => {
  const input = reportInput();
  input.session.diagnostics[0].details = { frameId: 'frame-1', attempts: 2 };
  const model = createAuditModel(input);
  assert.deepEqual(model.session.diagnostics[0].details, { frameId: 'frame-1', attempts: 2 });
  assert.notStrictEqual(model.session.diagnostics[0].details, input.session.diagnostics[0].details);
  assert.equal(Object.isFrozen(input.session.diagnostics[0].details), false);

  for (const diagnostic of [
    null,
    { code: '', message: 'Falha.', at: '2026-08-26T14:00:30.000Z', recoverable: true },
    { code: 'FRAME_LIMITED', message: ' ', at: '2026-08-26T14:00:30.000Z', recoverable: true },
    { code: 'FRAME_LIMITED', message: 'Falha.', at: '2026-08-26T14:00:30.000Z', recoverable: 'true' },
  ]) {
    const invalid = reportInput({ session: { status: 'partial', diagnostics: [diagnostic], partial: true } });
    assert.throws(() => createAuditModel(invalid), /diagnóst|diagnostic|code|message|recoverable|texto|boolean/i);
  }
});

test('validates coherent monotonic progress timestamps and audit correlation', () => {
  const progress = [
    { type: 'AUDIT_PROGRESS', sessionId: 'audit-report-1', auditId: 'audit-report-1', phase: 'opening', message: 'Abrindo o site', percent: 0, at: '2026-08-26T14:00:00.000Z' },
    { type: 'AUDIT_PROGRESS', sessionId: 'audit-report-1', auditId: 'audit-report-1', phase: 'structure', message: 'Lendo a estrutura', percent: 40, at: '2026-08-26T14:00:20.000Z' },
  ];
  const input = reportInput({ progress });
  const model = createAuditModel(input);
  assert.deepEqual(model.progress, progress);
  assert.notStrictEqual(model.progress, progress);

  const invalidProgress = [
    null,
    [{ ...progress[0], type: 'OTHER' }],
    [{ ...progress[0], auditId: 'other' }],
    [{ ...progress[0], sessionId: 'other' }],
    [{ ...progress[0], phase: ' ' }],
    [{ ...progress[0], message: '' }],
    [{ ...progress[0], percent: 101 }],
    [{ ...progress[0], at: ` ${progress[0].at}` }],
    [progress[1], { ...progress[0], percent: 20 }],
  ];
  for (const value of invalidProgress) {
    assert.throws(() => createAuditModel(reportInput({ progress: value })), /progress|progresso|auditoria|sessão|percent|ISO|fase|mensagem|tipo/i);
  }
});
