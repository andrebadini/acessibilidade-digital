import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHtmlSnippet } from '../../src/core/evidence/snippet.js';

test('removes executable elements and inline execution attributes while preserving structure and ARIA', () => {
  const html = '<DIV aria-label="Abrir" OnClick="steal()"><script>bad()</script><style>body{display:none}</style><template><img onerror=bad()></template><span role="img">Ícone</span></DIV>';
  const snippet = sanitizeHtmlSnippet(html);
  assert.equal(snippet, '<div aria-label="Abrir"><span role="img">Ícone</span></div>');
  assert.doesNotMatch(snippet, /script|style|template|onclick|onerror|bad\(\)/i);
});

test('redacts password, token and authorization values across quote styles and case', () => {
  const html = "<INPUT TYPE=PASSWORD VALUE=fixture-pass autocomplete='current-password' data-token=fixture-token AUTHORIZATION=Bearer-fixture><input type=hidden name=csrf_token value=fixture-hidden><p data-safe='ok'>Texto</p>";
  const snippet = sanitizeHtmlSnippet(html);
  assert.match(snippet, /<input type="password" autocomplete="current-password">/);
  assert.match(snippet, /<input type="hidden" name="csrf_token">/);
  assert.match(snippet, /<p data-safe="ok">Texto<\/p>/);
  assert.doesNotMatch(snippet, /fixture-pass|fixture-token|fixture-hidden|Bearer-fixture|authorization|data-token/i);
});

test('sanitizes URL userinfo, sensitive query/hash fields and unsafe protocols', () => {
  const html = '<a href="https://user:pass@example.test/path?token=bad&lang=pt#authorization=bad">Abrir</a><img SRC=https://example.test/a.png?ok=1&api_key=bad onload=bad()><a href=javascript:bad()>Ruim</a>';
  const snippet = sanitizeHtmlSnippet(html);
  assert.match(snippet, /href="https:\/\/example\.test\/path\?lang=pt"/);
  assert.match(snippet, /src="https:\/\/example\.test\/a\.png\?ok=1"/);
  assert.match(snippet, /<a>Ruim<\/a>/);
  assert.doesNotMatch(snippet, /user:pass|token=|api_key|authorization=|javascript:|onload/i);
});

test('drops srcdoc and produces deterministic displayable text', () => {
  const html = '<iframe title="Local" SRCDOC="<script>bad()</script><p>inside</p>"></iframe>';
  const first = sanitizeHtmlSnippet(html);
  assert.equal(first, '<iframe title="Local"></iframe>');
  assert.equal(sanitizeHtmlSnippet(html), first);
});

test('redacts credential-like values that appear in snippet text nodes', () => {
  const snippet = sanitizeHtmlSnippet('<p>authorization=fixture-auth token: fixture-token conteúdo público</p>');
  assert.equal(snippet, '<p>authorization=[redacted] token: [redacted] conteúdo público</p>');
  assert.doesNotMatch(snippet, /fixture-auth|fixture-token/);
});
