import assert from 'node:assert/strict';
import test from 'node:test';

import { BRAZILIAN_LEGAL_BASIS } from '../../src/core/legal/consumer-basis.js';
import {
  FOREIGN_BENCHMARKS,
  SECTION508_REVISED_CROSSWALK,
  section508ReferencesForWcag
} from '../../src/core/normative/section508.js';
import { validateNormativeData } from '../../src/core/normative/validate-normative-data.js';

function criteriaWith(change) {
  const criteria = SECTION508_REVISED_CROSSWALK.criteria.map(criterion => ({ ...criterion }));
  return change(criteria);
}

function validationErrorsFor(criteria) {
  return validateNormativeData({
    foreignBenchmarks: {
      revised508: { ...SECTION508_REVISED_CROSSWALK, criteria }
    }
  });
}

test('keeps revised Section 508 as a separately frozen foreign benchmark for WCAG 2.0 A and AA', () => {
  assert.notEqual(FOREIGN_BENCHMARKS, BRAZILIAN_LEGAL_BASIS);
  assert.equal(FOREIGN_BENCHMARKS.revised508, SECTION508_REVISED_CROSSWALK);
  assert.equal(SECTION508_REVISED_CROSSWALK.id, 'us.revised-508.wcag20-aa.v1');
  assert.equal(SECTION508_REVISED_CROSSWALK.version, 'Revised Section 508 (2017)');
  assert.equal(SECTION508_REVISED_CROSSWALK.wcagVersion, 'WCAG 2.0');
  assert.ok(Object.isFrozen(FOREIGN_BENCHMARKS));
  assert.ok(Object.isFrozen(SECTION508_REVISED_CROSSWALK));
  assert.ok(Object.isFrozen(SECTION508_REVISED_CROSSWALK.sources));
  assert.ok(Object.isFrozen(SECTION508_REVISED_CROSSWALK.criteria));
  assert.ok(SECTION508_REVISED_CROSSWALK.criteria.every(Object.isFrozen));
  assert.ok(SECTION508_REVISED_CROSSWALK.criteria.every(({ level }) => ['A', 'AA'].includes(level)));
  assert.equal(SECTION508_REVISED_CROSSWALK.criteria.length, 38);
});

test('preserves WCAG 2.0 criterion 4.1.1 for revised Section 508 and returns only mapped criteria', () => {
  assert.deepEqual(section508ReferencesForWcag([{ id: '4.1.1', level: 'A' }]), [
    { benchmarkId: 'us.revised-508.wcag20-aa.v1', criterionId: '4.1.1', level: 'A' }
  ]);
  assert.deepEqual(section508ReferencesForWcag([{ id: '2.5.8', level: 'AA' }]), []);
  assert.deepEqual(section508ReferencesForWcag([{ id: '1.4.3' }, { id: '2.5.8' }]), [
    { benchmarkId: 'us.revised-508.wcag20-aa.v1', criterionId: '1.4.3', level: 'AA' }
  ]);
});

test('does not expose axe legacy tags and validates the separate foreign catalog', () => {
  const serialized = JSON.stringify(FOREIGN_BENCHMARKS);
  assert.equal(serialized.includes('section' + '508'), false);
  assert.deepEqual(validateNormativeData(), []);
});

test('requires the exact authoritative WCAG 2.0 A/AA crosswalk rather than criterion-shaped entries', () => {
  const laterCriterion = validationErrorsFor(criteriaWith(criteria => [
    ...criteria, { id: '2.5.8', level: 'AA' }
  ]));
  assert.ok(laterCriterion.some(error => error.includes('2.5.8')));
  assert.ok(laterCriterion.some(error => error.includes('38')));

  const inventedCriterion = validationErrorsFor(criteriaWith(criteria => [
    ...criteria, { id: '9.9.9', level: 'A' }
  ]));
  assert.ok(inventedCriterion.some(error => error.includes('9.9.9')));

  const missingCriterion = validationErrorsFor(criteriaWith(criteria =>
    criteria.filter(criterion => criterion.id !== '1.4.3')
  ));
  assert.ok(missingCriterion.some(error => error.includes('1.4.3')));

  const wrongLevel = validationErrorsFor(criteriaWith(criteria => criteria.map(criterion =>
    criterion.id === '1.4.3' ? { ...criterion, level: 'A' } : criterion
  )));
  assert.ok(wrongLevel.some(error => error.includes('1.4.3')));
  assert.ok(wrongLevel.some(error => error.includes('esperado AA')));
});

test('rejects duplicate members even when the catalog still has 38 criterion-shaped entries', () => {
  const duplicate = validationErrorsFor(criteriaWith(criteria => [
    criteria[0], criteria[0], ...criteria.slice(2)
  ]));
  assert.ok(duplicate.some(error => error.includes('duplicado') && error.includes('1.1.1')));
  assert.ok(duplicate.some(error => error.includes('1.2.1')));
});
