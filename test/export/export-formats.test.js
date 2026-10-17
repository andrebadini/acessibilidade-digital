import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalExportFormatsV1,
  EXPORT_FORMATS_V1,
  exportFormatsEnvelopeV1,
  isCanonicalExportFormatsV1,
} from '../../src/export/export-formats.js';

test('canonical subsets accept every ordered, duplicate-free selection from the four formats', () => {
  const selections = [
    ['html'], ['pdf'], ['csv'], ['json'],
    ['html', 'pdf'], ['html', 'json'], ['pdf', 'csv'], ['csv', 'json'],
    ['html', 'pdf', 'csv'], ['pdf', 'csv', 'json'], ['html', 'csv', 'json'],
    [...EXPORT_FORMATS_V1],
  ];
  for (const formats of selections) {
    const comma = formats.join(',');
    assert.equal(isCanonicalExportFormatsV1(formats), true, `array ${comma}`);
    assert.equal(isCanonicalExportFormatsV1(comma), true, `string ${comma}`);
    assert.deepEqual(canonicalExportFormatsV1(formats), formats);
    assert.deepEqual(canonicalExportFormatsV1(comma), formats);
    assert.equal(exportFormatsEnvelopeV1(formats), comma);
    assert.equal(Object.isFrozen(canonicalExportFormatsV1(formats)), true);
  }
});

test('a canonical subset is never empty, reordered, duplicated or extended', () => {
  const invalid = [
    '', [], 'html,', ',html', 'html,,pdf', 'html,html', 'pdf,html', 'json,csv,pdf,html',
    'html,pdf,csv,json,json', 'HTML', 'pdf ', ' pdf', 'html;pdf', 'pdf\n', 'ação',
    ['pdf', 'html'], ['html', 'html'], ['html', 'pdf', 'csv', 'json', 'extra'],
    ['html', null], ['html', 1], new Set(['html']), { 0: 'html', length: 1 },
  ];
  for (const value of invalid) {
    assert.equal(isCanonicalExportFormatsV1(value), false, String(value));
    assert.throws(() => canonicalExportFormatsV1(value), /Formatos de exportação inválidos/u);
  }
});

test('hostile arrays with accessors, holes or inherited entries are rejected without running getters', () => {
  let getterCalls = 0;
  const accessor = ['html'];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { getterCalls += 1; return 'html'; } });
  assert.equal(isCanonicalExportFormatsV1(accessor), false);
  assert.equal(getterCalls, 0);

  const sparsed = ['html', 'pdf'];
  delete sparsed[1];
  assert.equal(isCanonicalExportFormatsV1(sparsed), false);

  class Formats extends Array {}
  const inherited = Formats.from(['html', 'pdf']);
  assert.equal(isCanonicalExportFormatsV1(inherited), false);
});

test('copying ignores extra array properties and freezes the requested subset', () => {
  const source = ['html', 'json'];
  source.note = 'não deve viajar';
  const canonical = canonicalExportFormatsV1(source);
  assert.deepEqual(canonical, ['html', 'json']);
  assert.equal(Object.hasOwn(canonical, 'note'), false);
  assert.equal(Object.isFrozen(canonical), true);
  assert.throws(() => canonical.push('pdf'), TypeError);
});
