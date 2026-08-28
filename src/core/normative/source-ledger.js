function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export const NORMATIVE_SOURCE_LEDGER = deepFreeze([
  {
    id: 'abnt.nbr17225.2025',
    version: '2025',
    title: 'ABNT NBR 17225:2025',
    localCopy: {
      fileName: 'ABNT-NBR-17225-Acessibilidade-Digital.pdf',
      sha256: '1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc',
    },
  },
  {
    id: 'w3c.wcag22',
    version: '2.2',
    title: 'Web Content Accessibility Guidelines (WCAG) 2.2',
    url: 'https://www.w3.org/TR/WCAG22/',
  },
  {
    id: 'us.access-board.revised-508',
    version: '2017',
    title: 'Revised 508 Standards and Section 255 Guidelines',
    url: 'https://www.access-board.gov/ict/',
  },
  {
    id: 'us.section508.applicability-conformance',
    version: 'current',
    title: 'Applicability and Conformance',
    url: 'https://www.section508.gov/develop/applicability-conformance/',
  },
]);
