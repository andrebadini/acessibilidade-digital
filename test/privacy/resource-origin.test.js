import assert from 'node:assert/strict';
import test from 'node:test';

import * as privacy from '../../src/core/privacy.js';

test('projects only canonical absolute HTTP(S) resource origins without reading hostile values', () => {
  assert.equal(typeof privacy.projectAuditResourceOrigin, 'function');
  assert.equal(
    privacy.projectAuditResourceOrigin('https://user:pass@example.test/pessoa/CPF-123456789?case=7#fragmento'),
    'https://example.test/',
  );
  assert.equal(privacy.projectAuditResourceOrigin('http://127.0.0.1:8080/private?q=1'), 'http://127.0.0.1:8080/');
  assert.equal(privacy.projectAuditResourceOrigin('HTTPS://EXAMPLE.TEST/path'), '');
  assert.equal(privacy.projectAuditResourceOrigin('relative/path'), '');

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'toString', { get() { getterCalls += 1; throw new Error('GETTER_INVOKED'); } });
  assert.equal(privacy.projectAuditResourceOrigin(hostile), '');
  assert.equal(getterCalls, 0);
});
