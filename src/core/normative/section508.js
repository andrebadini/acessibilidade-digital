function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const WCAG20_AA_CRITERIA = [
  ['1.1.1', 'A'],
  ['1.2.1', 'A'], ['1.2.2', 'A'], ['1.2.3', 'A'], ['1.2.4', 'AA'], ['1.2.5', 'AA'],
  ['1.3.1', 'A'], ['1.3.2', 'A'], ['1.3.3', 'A'],
  ['1.4.1', 'A'], ['1.4.2', 'A'], ['1.4.3', 'AA'], ['1.4.4', 'AA'], ['1.4.5', 'AA'],
  ['2.1.1', 'A'], ['2.1.2', 'A'],
  ['2.2.1', 'A'], ['2.2.2', 'A'],
  ['2.3.1', 'A'],
  ['2.4.1', 'A'], ['2.4.2', 'A'], ['2.4.3', 'A'], ['2.4.4', 'A'], ['2.4.5', 'AA'], ['2.4.6', 'AA'], ['2.4.7', 'AA'],
  ['3.1.1', 'A'], ['3.1.2', 'AA'],
  ['3.2.1', 'A'], ['3.2.2', 'A'], ['3.2.3', 'AA'], ['3.2.4', 'AA'],
  ['3.3.1', 'A'], ['3.3.2', 'A'], ['3.3.3', 'AA'], ['3.3.4', 'AA'],
  ['4.1.1', 'A'], ['4.1.2', 'A']
];

export const SECTION508_REVISED_CROSSWALK = deepFreeze({
  id: 'us.revised-508.wcag20-aa.v1',
  version: 'Revised Section 508 (2017)',
  label: 'Correspondência técnica com Section 508',
  wcagVersion: 'WCAG 2.0',
  qualification: 'Correspondência técnica potencial; não determina conformidade integral com a Section 508.',
  sources: [
    { id: 'us.access-board.ict', publisher: 'U.S. Access Board', title: 'Revised 508 Standards and Section 255 Guidelines' },
    { id: 'us.revised508.applicability', publisher: 'Section 508.gov', title: 'Applicability and Conformance' }
  ],
  criteria: WCAG20_AA_CRITERIA.map(([id, level]) => ({ id, level }))
});

/** Foreign technical benchmarks are kept independent of Brazilian legal bases. */
export const FOREIGN_BENCHMARKS = deepFreeze({
  revised508: SECTION508_REVISED_CROSSWALK
});

const CRITERION_LEVELS = new Map(SECTION508_REVISED_CROSSWALK.criteria.map(criterion => [criterion.id, criterion.level]));

/** Returns potential revised-508 references for WCAG 2.0 A/AA criteria only. */
export function section508ReferencesForWcag(references) {
  if (!Array.isArray(references)) return Object.freeze([]);
  const seen = new Set();
  const matches = [];
  for (const reference of references) {
    const id = typeof reference === 'string' ? reference : reference?.id;
    const level = CRITERION_LEVELS.get(id);
    if (!level || seen.has(id)) continue;
    seen.add(id);
    matches.push(Object.freeze({
      benchmarkId: SECTION508_REVISED_CROSSWALK.id,
      criterionId: id,
      level
    }));
  }
  return Object.freeze(matches);
}
