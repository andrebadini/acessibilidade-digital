import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAuditUrl } from '../../src/core/url.js';

test('adds HTTPS to a trimmed hostname deterministically', () => {
  assert.equal(
    normalizeAuditUrl('  procon.mt.gov.br  '),
    'https://procon.mt.gov.br/',
  );
});

test('preserves HTTP(S) ports, paths, queries, and fragments', () => {
  assert.equal(
    normalizeAuditUrl('HTTP://Example.COM:8080/a/b?q=um%20dois#topo'),
    'http://example.com:8080/a/b?q=um%20dois#topo',
  );
});

test('accepts localhost and converts internationalized domains consistently', () => {
  assert.equal(normalizeAuditUrl('localhost:3000/a'), 'https://localhost:3000/a');
  assert.equal(normalizeAuditUrl('https://münich.example/'), 'https://xn--mnich-kva.example/');
});

test('rejects missing, non-string, malformed, credentialed, and restricted URLs', () => {
  for (const value of [
    undefined, null, 42, {}, [], '', '   ', 'http://', 'https://?x=1',
    'http:example.com', 'https:example.com', 'ftp://example.com', '/caminho', '?consulta=1',
    'https://exam\u0000ple.test/', 'https://exam\u001fple.test/', 'https://exam\u007fple.test/',
    'https://exam\\ple.test/', 'https://exa\u202Emple.test/', 'https://exa\u2066mple.test/',
  ]) {
    assert.throws(() => normalizeAuditUrl(value), /URL|endereço/i);
  }

  for (const value of [
    'chrome://settings',
    'file:///tmp/relatorio.html',
    'data:text/html,oi',
    'javascript:alert(1)',
    'about:blank',
    'chrome-extension://abcdef/panel.html',
    'https://usuario:senha@example.com/',
  ]) {
    assert.throws(() => normalizeAuditUrl(value), /HTTP ou HTTPS|credenciais/i);
  }
});
