import test from 'node:test';
import assert from 'node:assert/strict';

import { TEST_MODES } from '../../src/core/result.js';
import { WCAG22_LEVELS } from '../../src/core/normative/wcag22.js';
import {
  NBR17225_EDITORIAL_NOTES,
  NBR17225_ITEMS
} from '../../src/core/normative/nbr17225.js';
import { validateNormativeData } from '../../src/core/normative/validate-normative-data.js';

const EXPECTED_KEYS = [
  'id',
  'printedId',
  'title',
  'classification',
  'wcag',
  'evaluation',
  'ruleIds',
  'humanReason'
];

const GROUP_LENGTHS = Object.freeze([16, 6, 5, 5, 2, 6, 16, 15, 18, 5, 6, 13, 13, 10, 4, 6]);

function normativeIds() {
  return GROUP_LENGTHS.flatMap((length, groupIndex) =>
    Array.from({ length }, (_, itemIndex) => `5.${groupIndex + 1}.${itemIndex + 1}`)
  );
}

function cloneItem(item, changes = {}) {
  return {
    ...item,
    wcag: item.wcag.map(reference => ({ ...reference })),
    ruleIds: [...item.ruleIds],
    ...changes
  };
}

test('NBR 17225 database is complete and internally consistent', () => {
  assert.equal(NBR17225_ITEMS.length, 146);
  assert.equal(new Set(NBR17225_ITEMS.map(item => item.id)).size, 146);
  assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'requirement').length, 96);
  assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'recommendation').length, 50);
  assert.deepEqual(NBR17225_ITEMS.map(item => item.id), normativeIds());
  assert.deepEqual(validateNormativeData(), []);
});

test('every normative record has the exact deeply immutable contract', () => {
  assert.ok(Object.isFrozen(NBR17225_ITEMS));

  for (const item of NBR17225_ITEMS) {
    assert.deepEqual(Object.keys(item), EXPECTED_KEYS, item.id);
    assert.ok(Object.isFrozen(item), item.id);
    assert.ok(Object.isFrozen(item.wcag), `${item.id} wcag`);
    assert.ok(Object.isFrozen(item.ruleIds), `${item.id} ruleIds`);
    assert.ok(item.wcag.every(Object.isFrozen), `${item.id} WCAG references`);
    assert.ok(['requirement', 'recommendation'].includes(item.classification), item.id);
    assert.ok(TEST_MODES.includes(item.evaluation), item.id);
    assert.equal(typeof item.humanReason, 'string', item.id);
  }
});

test('every cited WCAG criterion uses its official WCAG 2.2 level', () => {
  for (const item of NBR17225_ITEMS) {
    for (const reference of item.wcag) {
      assert.equal(reference.level, WCAG22_LEVELS[reference.id], `${item.id} / ${reference.id}`);
    }
  }
});

test('known editorial divergences are explicit and normalized from Section 5', () => {
  const byId = new Map(NBR17225_ITEMS.map(item => [item.id, item]));

  assert.equal(byId.get('5.12.1').printedId, '5.1.12');
  assert.deepEqual(byId.get('5.9.1').wcag.map(reference => reference.id), ['3.3.2', '4.1.2']);
  assert.deepEqual(byId.get('5.9.2').wcag.map(reference => reference.id), ['1.3.2', '3.3.2']);
  assert.deepEqual(byId.get('5.9.4').wcag, [
    Object.freeze({ id: '2.4.6', level: 'AA', printedLevel: 'A' })
  ]);
  assert.deepEqual(
    NBR17225_EDITORIAL_NOTES.map(note => note.itemId),
    ['5.9.1', '5.9.2', '5.9.4', '5.9.17', '5.12.1']
  );
  assert.ok(NBR17225_EDITORIAL_NOTES.find(note => note.itemId === '5.9.17').normalized.includes('5.9.18'));
});

test('the first record uses the corrected automated evaluation vocabulary', () => {
  assert.deepEqual(NBR17225_ITEMS[0], {
    id: '5.1.1',
    printedId: '5.1.1',
    title: 'Indicador de foco visível',
    classification: 'requirement',
    wcag: [{ id: '2.4.7', level: 'AA', printedLevel: 'AA' }],
    evaluation: 'automated',
    ruleIds: ['focus-visible'],
    humanReason: ''
  });
});

test('validation deterministically reports duplicate IDs and invalid fields', () => {
  const base = NBR17225_ITEMS[0];
  const malformed = cloneItem(base, {
    id: 'test.invalid',
    printedId: 'test.invalid',
    classification: 'obligation',
    evaluation: 'automatic',
    wcag: [
      { id: '9.9.9', level: 'A', printedLevel: 'A' },
      { id: '2.4.7', level: 'A', printedLevel: 'A' }
    ],
    ruleIds: []
  });
  const assistedWithoutReason = cloneItem(base, {
    id: 'test.assisted',
    printedId: 'test.assisted',
    evaluation: 'assisted',
    humanReason: ''
  });
  const items = [malformed, cloneItem(malformed), assistedWithoutReason];
  const expected = [
    'ID ABNT duplicado: test.invalid',
    'Classificação inválida em test.invalid: obligation',
    'Modo de avaliação inválido em test.invalid: automatic',
    'Critério WCAG inexistente em test.invalid: 9.9.9',
    'Nível WCAG divergente em test.invalid para 2.4.7: esperado AA, recebido A',
    'Classificação inválida em test.invalid: obligation',
    'Modo de avaliação inválido em test.invalid: automatic',
    'Critério WCAG inexistente em test.invalid: 9.9.9',
    'Nível WCAG divergente em test.invalid para 2.4.7: esperado AA, recebido A',
    'Razão humana ausente em test.assisted'
  ];

  assert.deepEqual(validateNormativeData({ items }), expected);
  assert.deepEqual(validateNormativeData({ items }), expected);
});

test('validation rejects automated records without planned rule IDs', () => {
  const item = cloneItem(NBR17225_ITEMS[0], { ruleIds: [] });

  assert.deepEqual(validateNormativeData({ items: [item] }), [
    'Item automatizado sem ruleIds: 5.1.1'
  ]);
});

test('validation requires a human reason for manual records', () => {
  const item = cloneItem(NBR17225_ITEMS[0], {
    evaluation: 'manual',
    ruleIds: [],
    humanReason: ''
  });

  assert.deepEqual(validateNormativeData({ items: [item] }), [
    'Razão humana ausente em 5.1.1'
  ]);
});
