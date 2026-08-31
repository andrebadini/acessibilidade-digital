import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeUrlList } from '../../src/core/batch/normalize-url-list.js';

test('normalizes separators, ignores blank lines and preserves unique URL order', () => {
  const result = normalizeUrlList(' example.test/a\r\n\rHTTPS://MÜNICH.example:443/b#fim\nhttp://127.0.0.1:8080/private ');

  assert.deepEqual(result, {
    entries: [
      { line: 1, navigationUrl: 'https://example.test/a', evidenceUrl: {
        version: 'EvidenceUrlV1', href: 'https://example.test/a', queryIncluded: false, redactedSegments: 0,
      } },
      { line: 3, navigationUrl: 'https://xn--mnich-kva.example/b#fim', evidenceUrl: {
        version: 'EvidenceUrlV1', href: 'https://xn--mnich-kva.example/b', queryIncluded: false, redactedSegments: 0,
      } },
      { line: 4, navigationUrl: 'http://127.0.0.1:8080/private', evidenceUrl: {
        version: 'EvidenceUrlV1', href: 'http://127.0.0.1:8080/private', queryIncluded: false, redactedSegments: 0,
      } },
    ],
    errors: [],
    warnings: [],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.entries), true);
  assert.equal(Object.isFrozen(result.entries[0]), true);
});

test('deduplicates only canonical navigation URLs and retains origin-colliding pages', () => {
  const secret = 'PRIVATE_BATCH_TOKEN';
  const result = normalizeUrlList([
    'https://example.test:443/a',
    'HTTPS://EXAMPLE.TEST/a',
    `https://example.test/account?token=${secret}&view=summary`,
    'https://example.test/account?token=OTHER_PRIVATE_TOKEN&view=summary',
  ].join('\n'));

  assert.deepEqual(result.entries, [
    { line: 1, navigationUrl: 'https://example.test/a', evidenceUrl: {
      version: 'EvidenceUrlV1', href: 'https://example.test/a', queryIncluded: false, redactedSegments: 0,
    } },
    {
      line: 3,
      navigationUrl: `https://example.test/account?token=${secret}&view=summary`,
      evidenceUrl: {
        version: 'EvidenceUrlV1', href: 'https://example.test/account', queryIncluded: false, redactedSegments: 0,
      },
    },
    {
      line: 4,
      navigationUrl: 'https://example.test/account?token=OTHER_PRIVATE_TOKEN&view=summary',
      evidenceUrl: {
        version: 'EvidenceUrlV1', href: 'https://example.test/account', queryIncluded: false, redactedSegments: 0,
      },
    },
  ]);
  assert.deepEqual(result.warnings, [
    { line: 2, code: 'DUPLICATE_URL', firstLine: 1, message: 'A URL repete uma entrada anterior e não será auditada novamente.' },
  ]);
  assert.equal(result.errors.length, 0);
  assert.doesNotMatch(JSON.stringify(result.warnings), /PRIVATE_BATCH_TOKEN|OTHER_PRIVATE_TOKEN/u);
});

test('reports every invalid line with fixed messages and accepts user-authorized private endpoints', () => {
  const result = normalizeUrlList([
    'ftp://example.test/file',
    'https://user:password@example.test/',
    'https://exa\u202Emple.test/',
    'http://localhost:3000/',
    'http://10.0.0.8/internal',
    'http://[fe80::1]/status',
  ].join('\n'));

  assert.deepEqual(result.entries.map(entry => entry.evidenceUrl.href), [
    'http://localhost:3000/',
    'http://10.0.0.8/internal',
    'http://[fe80::1]/status',
  ]);
  assert.deepEqual(result.errors.map(({ line, code }) => ({ line, code })), [
    { line: 1, code: 'INVALID_URL' },
    { line: 2, code: 'EMBEDDED_CREDENTIALS' },
    { line: 3, code: 'INVALID_URL' },
  ]);
  assert.ok(result.errors.every(error => !/ftp|password|example/u.test(error.message)));
});

test('keeps redacted collisions as distinct pages and deduplicates only exact canonical URLs', () => {
  const value = normalizeUrlList([
    'https://example.test/client/1234567',
    'https://example.test/client/7654321',
    'https://EXAMPLE.test/client/1234567',
  ].join('\n'));

  assert.equal(value.entries.length, 2);
  assert.deepEqual(value.entries.map(entry => entry.line), [1, 2]);
  assert.deepEqual(value.entries.map(entry => entry.evidenceUrl.href), [
    'https://example.test/client/:redacted-2',
    'https://example.test/client/:redacted-2',
  ]);
  assert.deepEqual(value.warnings, [{
    line: 3,
    code: 'DUPLICATE_URL',
    firstLine: 1,
    message: 'A URL repete uma entrada anterior e não será auditada novamente.',
  }]);
});

test('keeps exactly twenty unique identities and reports the twenty-first without truncating silently', () => {
  const input = Array.from({ length: 21 }, (_, index) => `https://page-${index + 1}.example.test/`).join('\n');
  const result = normalizeUrlList(input);

  assert.equal(result.entries.length, 20);
  assert.equal(result.entries.at(-1).line, 20);
  assert.deepEqual(result.errors, [{
    line: 21,
    code: 'BATCH_LIMIT_EXCEEDED',
    message: 'O lote aceita no máximo 20 URLs únicas.',
  }]);
});

test('enforces total, non-empty-line and UTF-16 line budgets with bounded fixed errors', () => {
  const tooMany = Array.from({ length: 201 }, () => 'https://example.test/').join('\n');
  const lineLimit = normalizeUrlList(tooMany);
  assert.deepEqual(lineLimit.errors, [{
    line: 201,
    code: 'BATCH_LINE_COUNT_EXCEEDED',
    message: 'O lote aceita no máximo 200 linhas não vazias para validação.',
  }]);

  const longLine = normalizeUrlList(`https://example.test/${'a'.repeat(8_193)}`);
  assert.deepEqual(longLine.errors, [{
    line: 1,
    code: 'BATCH_LINE_TOO_LONG',
    message: 'A linha excede o limite seguro de 8192 caracteres.',
  }]);

  const oversized = normalizeUrlList(' '.repeat(65_537));
  assert.deepEqual(oversized, {
    entries: [], warnings: [], errors: [{
      line: 0,
      code: 'BATCH_INPUT_TOO_LARGE',
      message: 'A lista excede o limite seguro de 64 KiB.',
    }],
  });
});

test('rejects non-string and empty input without reflecting caller-controlled values', () => {
  assert.throws(() => normalizeUrlList({ secret: 'PRIVATE_OBJECT_VALUE' }), /texto/iu);
  assert.deepEqual(normalizeUrlList(' \r\n\t '), {
    entries: [], warnings: [], errors: [{
      line: 0,
      code: 'BATCH_EMPTY',
      message: 'Informe ao menos uma URL para auditoria em lote.',
    }],
  });
});
