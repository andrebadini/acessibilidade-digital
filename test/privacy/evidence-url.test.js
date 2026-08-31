import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalNavigationUrl,
  isEvidenceUrlV1,
  sanitizeEvidenceUrlV1,
} from '../../src/core/privacy/evidence-url.js';

test('canonicalNavigationUrl reuses the audit URL contract for absolute and relative inputs', () => {
  assert.equal(canonicalNavigationUrl('Example.test/a#fim'), 'https://example.test/a#fim');
  assert.equal(canonicalNavigationUrl('../alvo?view=public#fim', {
    base: 'https://Example.test/app/etapa/',
  }), 'https://example.test/app/alvo?view=public#fim');
  assert.throws(() => canonicalNavigationUrl('..\\segredo', {
    base: 'https://example.test/app/',
  }), error => error instanceof TypeError && error.message === 'URL de evidência HTTP(S) inválida.');
  assert.throws(() => canonicalNavigationUrl('../seg\u202Eredo', {
    base: 'https://example.test/app/',
  }), error => error instanceof TypeError && error.message === 'URL de evidência HTTP(S) inválida.');

  for (const value of [
    'https://user:pass@example.test/private',
    'https://exa\\mple.test/',
    'https://exa\u202Emple.test/',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => canonicalNavigationUrl(value), error =>
      error instanceof TypeError &&
      error.message === 'URL de evidência HTTP(S) inválida.' &&
      !error.message.includes(value));
  }
});

test('EvidenceUrlV1 resolves base, decodes once and redacts objective secrets', () => {
  assert.deepEqual(sanitizeEvidenceUrlV1('../123/caf%C3%A9/1234567/%E0%A4%A', {
    base: 'https://Example.TEST/app/', includeQuery: false,
  }), {
    version: 'EvidenceUrlV1',
    href: 'https://example.test/123/:redacted-2/:redacted-3/:redacted-4',
    queryIncluded: false,
    redactedSegments: 3,
  });
});

test('EvidenceUrlV1 removes fragments, gates query and preserves URL serialization', () => {
  const raw = 'https://xn--mnich-kva.example/public?case=7#secret';
  assert.equal(sanitizeEvidenceUrlV1(raw).href, 'https://xn--mnich-kva.example/public');
  assert.deepEqual(sanitizeEvidenceUrlV1(raw, { includeQuery: true }), {
    version: 'EvidenceUrlV1',
    href: 'https://xn--mnich-kva.example/public?case=7',
    queryIncluded: true,
    redactedSegments: 0,
  });
});

test('EvidenceUrlV1 decodes exactly once and redacts encoded separators and malformed encodings', () => {
  const value = sanitizeEvidenceUrlV1('https://example.test/a/%2F/%252F/%E0%A4%A/ok');
  assert.deepEqual(value, {
    version: 'EvidenceUrlV1',
    href: 'https://example.test/a/:redacted-2/:redacted-3/:redacted-4/ok',
    queryIncluded: false,
    redactedSegments: 3,
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(isEvidenceUrlV1(value), true);
  assert.equal(isEvidenceUrlV1({ ...value, extra: true }), false);
});

test('EvidenceUrlV1 rejects non-http schemes and hostile values without echo or coercion', () => {
  const marker = 'PRIVATE_EVIDENCE_URL_MARKER';
  let coercions = 0;
  const hostile = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };
  for (const value of [
    'data:text/plain,segredo',
    'blob:https://example.test/id',
    'javascript:alert(1)',
    hostile,
  ]) {
    assert.throws(() => sanitizeEvidenceUrlV1(value), error =>
      error instanceof TypeError &&
      error.message === 'URL de evidência HTTP(S) inválida.' &&
      !error.message.includes(marker));
  }
  assert.equal(coercions, 0);
});

test('EvidenceUrlV1 rejects hostile option records without invoking accessors', () => {
  const marker = 'PRIVATE_EVIDENCE_OPTIONS_MARKER';
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'includeQuery', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error(marker);
    },
  });

  assert.throws(() => sanitizeEvidenceUrlV1('https://example.test/', options), error =>
    error instanceof TypeError && error.message === 'Opções de URL de evidência inválidas.');
  assert.equal(reads, 0);
});

test('EvidenceUrlV1 is idempotent for its href projection', () => {
  const first = sanitizeEvidenceUrlV1('https://example.test/client/1234567?case=7#private');
  const second = sanitizeEvidenceUrlV1(first.href);
  assert.equal(second.href, first.href);
  assert.equal(second.redactedSegments, first.redactedSegments);
});

test('EvidenceUrlV1 removes a bare empty query marker and remains valid and idempotent', () => {
  for (const raw of [
    'https://example.test/public?',
    'https://example.test/public?#private-fragment',
  ]) {
    const first = sanitizeEvidenceUrlV1(raw, { includeQuery: true });
    assert.deepEqual(first, {
      version: 'EvidenceUrlV1',
      href: 'https://example.test/public',
      queryIncluded: false,
      redactedSegments: 0,
    });
    assert.equal(isEvidenceUrlV1(first), true);
    assert.deepEqual(
      sanitizeEvidenceUrlV1(first.href, { includeQuery: first.queryIncluded }),
      first,
    );
  }
});

test('EvidenceUrlV1 preserves only redaction markers whose ordinal matches the path segment', () => {
  const value = sanitizeEvidenceUrlV1(
    'https://example.test/:redacted-7/ok/:redacted-2/:redacted-4',
  );

  assert.deepEqual(value, {
    version: 'EvidenceUrlV1',
    href: 'https://example.test/:redacted-1/ok/:redacted-3/:redacted-4',
    queryIncluded: false,
    redactedSegments: 3,
  });
  assert.equal(isEvidenceUrlV1(value), true);
  assert.deepEqual(sanitizeEvidenceUrlV1(value.href), value);
  assert.equal(isEvidenceUrlV1({
    ...value,
    href: 'https://example.test/:redacted-7/ok/:redacted-2/:redacted-4',
  }), false);
});
