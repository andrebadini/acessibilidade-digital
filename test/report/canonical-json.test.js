import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditModel } from '../../src/core/report/audit-model.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { sha256Hex } from '../../src/core/report/hash.js';
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
