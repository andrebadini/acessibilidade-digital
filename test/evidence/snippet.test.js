import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHtmlSnippet, sanitizeHtmlSnippetSource } from '../../src/core/evidence/snippet.js';

test('exposes sanitized readable source while preserving the encoded compatibility API', () => {
  const html = '<iframe title="Mapa" src="javascript:bad()" onload="bad()"></iframe><button aria-label="Abrir">Abrir</button>';
  const source = sanitizeHtmlSnippetSource(html);

  assert.equal(source, '<iframe title="Mapa"></iframe><button aria-label="Abrir">Abrir</button>');
  assert.equal(
    sanitizeHtmlSnippet(html),
    '&lt;iframe title=&quot;Mapa&quot;&gt;&lt;/iframe&gt;&lt;button aria-label=&quot;Abrir&quot;&gt;Abrir&lt;/button&gt;',
  );
});

test('keeps adversarial source inert and free of executable surfaces and secrets', () => {
  const source = sanitizeHtmlSnippetSource(
    '<button onclick="steal()" formaction="javascript:TOPSECRET">Abrir</button></code><script>TOPSECRET</script><style>TOPSECRET</style>',
  );

  assert.equal(source, '<button>Abrir</button></code>');
  assert.doesNotMatch(source, /script|style|onclick|formaction|javascript:|TOPSECRET/iu);
});

test('omits current editable values while preserving static select option labels', () => {
  const secret = 'TOPSECRET-editable';
  const source = sanitizeHtmlSnippetSource([
    `<input type=text name=api_key value="${secret}" aria-valuenow="${secret}" aria-valuetext="${secret}">`,
    `<textarea>${secret}</textarea>`,
    `<select value="${secret}"><option value="${secret}" selected>Rótulo público</option><option value=other>Outro</option></select>`,
    `<div contenteditable=true>${secret}<div title="${secret}"><span>${secret}</span></div></div>`,
  ].join(''));

  assert.equal(source, '<input type="text" name="api_key"><textarea></textarea><select><option>Rótulo público</option><option>Outro</option></select><div contenteditable="true"></div>');
  assert.doesNotMatch(source, /TOPSECRET|\bvalue=|\bselected\b|aria-value|\btitle=/iu);
});

test('suppresses a same-tag editable subtree until the structurally matching close tag', () => {
  const secret = 'TOPSECRET-nested-editor';
  const source = sanitizeHtmlSnippetSource(
    `<div contenteditable=true><div title="${secret}"><div>${secret}</div></div></div><button>Depois</button>`,
  );

  assert.equal(source, '<div contenteditable="true"></div><button>Depois</button>');
  assert.doesNotMatch(source, /TOPSECRET|title=|<div><div>/iu);
});

test('keeps only structural attributes on a contenteditable root but retains ordinary textarea labeling', () => {
  const secret = 'TOPSECRET-editor-attributes';
  const editor = sanitizeHtmlSnippetSource(
    `<div id="${secret}" name="${secret}" contenteditable="true" role="textbox" tabindex="0" aria-labelledby="safe-label" aria-describedby="safe-description" aria-label="${secret}" aria-description="${secret}" title="${secret}" data-private="${secret}" href="https://example.test/?view=${secret}"><span title="${secret}">${secret}</span></div>`,
  );
  const textarea = sanitizeHtmlSnippetSource(
    `<textarea id="message" name="message" aria-labelledby="message-label" placeholder="Comentário">${secret}</textarea>`,
  );

  assert.equal(editor, '<div contenteditable="true" role="textbox" tabindex="0" aria-labelledby="safe-label" aria-describedby="safe-description"></div>');
  assert.equal(textarea, '<textarea id="message" name="message" aria-labelledby="message-label" placeholder="Comentário"></textarea>');
  assert.doesNotMatch(`${editor}${textarea}`, /TOPSECRET|title=|data-private=|href=|aria-label=/iu);
});

test('removes executable elements and inline execution attributes while preserving structure and ARIA', () => {
  const html = '<DIV aria-label="Abrir" OnClick="steal()" style="background:url(data:text/plain,STYLE_MARKER)"><script>bad()</script><style>body{display:none}</style><template><img onerror=bad()></template><span role="img">Ícone</span></DIV>';
  const snippet = sanitizeHtmlSnippet(html);
  assert.equal(snippet, '&lt;div aria-label=&quot;Abrir&quot;&gt;&lt;span role=&quot;img&quot;&gt;Ícone&lt;/span&gt;&lt;/div&gt;');
  assert.doesNotMatch(snippet, /script|style|template|onclick|onerror|bad\(\)|STYLE_MARKER/i);
});

test('redacts password, token and authorization values across quote styles and case', () => {
  const html = "<INPUT TYPE=PASSWORD VALUE=fixture-pass autocomplete='current-password' data-token=fixture-token AUTHORIZATION=Bearer-fixture><input type=hidden name=csrf_token value=fixture-hidden><p data-safe='ok'>Texto</p>";
  const snippet = sanitizeHtmlSnippet(html);
  assert.match(snippet, /&lt;input type=&quot;password&quot; autocomplete=&quot;current-password&quot;&gt;/);
  assert.match(snippet, /&lt;input type=&quot;hidden&quot; name=&quot;csrf_token&quot;&gt;/);
  assert.match(snippet, /&lt;p data-safe=&quot;ok&quot;&gt;Texto&lt;\/p&gt;/);
  assert.doesNotMatch(snippet, /fixture-pass|fixture-token|fixture-hidden|Bearer-fixture|authorization|data-token/i);
});

test('sanitizes URL userinfo, sensitive query/hash fields and unsafe protocols', () => {
  const html = '<a href="https://user:pass@example.test/path?token=bad&lang=pt#authorization=bad">Abrir</a><img SRC=https://example.test/a.png?ok=1&api_key=bad onload=bad()><a href=javascript:bad()>Ruim</a>';
  const snippet = sanitizeHtmlSnippet(html);
  assert.match(snippet, /href=&quot;https:\/\/example\.test\/path\?lang=pt&quot;/);
  assert.match(snippet, /src=&quot;https:\/\/example\.test\/a\.png\?ok=1&quot;/);
  assert.match(snippet, /&lt;a&gt;Ruim&lt;\/a&gt;/);
  assert.doesNotMatch(snippet, /user:pass|token=|api_key|authorization=|javascript:|onload/i);
});

test('drops srcdoc and produces deterministic displayable text', () => {
  const html = '<iframe title="Local" SRCDOC="<script>bad()</script><p>inside</p>"></iframe>';
  const first = sanitizeHtmlSnippet(html);
  assert.equal(first, '&lt;iframe title=&quot;Local&quot;&gt;&lt;/iframe&gt;');
  assert.equal(sanitizeHtmlSnippet(html), first);
});

test('redacts credential-like values that appear in snippet text nodes', () => {
  const snippet = sanitizeHtmlSnippet('<p>authorization=fixture-auth token: fixture-token conteúdo público</p>');
  assert.equal(snippet, '&lt;p&gt;authorization=[redacted] token: [redacted] conteúdo público&lt;/p&gt;');
  assert.doesNotMatch(snippet, /fixture-auth|fixture-token/);
});

test('is inert under innerHTML and removes duplicate-password and active URL surfaces', () => {
  const marker = 'SNIPPET_PRIVACY_MARKER';
  const html = [
    `<input value="${marker}" type=text TYPE=PASSWORD value=${marker} aria-label="Senha">`,
    `<meta http-equiv=refresh content="0; url=javascript:${marker}">`,
    `<object data="data:text/html,${marker}"></object><embed src="vbscript:${marker}">`,
    `<a xlink:href="javascript:${marker}" ping="https://example.test/?token=${marker}" href="https://user:pass@example.test/path?token=${marker}&ok=1#authorization=${marker}">Seguro</a>`,
    `<img src="data:image/png;base64,${marker}" srcset="javascript:${marker} 1x, https://example.test/a.png?secret=${marker} 2x">`
  ].join('');
  const snippet = sanitizeHtmlSnippet(html);
  assert.doesNotMatch(snippet, /<|>/);
  assert.doesNotMatch(snippet, new RegExp(marker));
  assert.doesNotMatch(snippet, /javascript:|vbscript:|data:|xlink:href|ping=|srcset=|content=/i);
  assert.match(snippet, /aria-label=&quot;Senha&quot;/);
  assert.match(snippet, /href=&quot;https:\/\/example\.test\/path\?ok=1&quot;/);
  assert.doesNotMatch(snippet, /value=/i);
});
