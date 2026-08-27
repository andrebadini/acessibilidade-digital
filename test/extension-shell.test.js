import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('declares a minimal MV3 extension shell without remote executable code', async () => {
  const manifest = JSON.parse(await readWorkspaceFile('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, [
    'activeTab', 'debugger', 'downloads', 'scripting', 'storage', 'tabs',
  ]);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.background, {
    service_worker: 'src/background/service-worker.js',
    type: 'module',
  });
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; img-src 'self' data: blob:; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
});

test('panel is an accessible local document with no inline code', async () => {
  const html = await readWorkspaceFile('src/panel/index.html');
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  assert.match(html, /<label[^>]*for="audit-url"[^>]*>\s*Endereço do site\s*<\/label>/i);
  assert.match(html, /<input[^>]*id="audit-url"[^>]*type="url"/i);
  assert.match(html, /<button[^>]*type="submit"[^>]*>\s*Auditar\s*<\/button>/i);
  assert.match(html, /aria-live="polite"/i);
  assert.match(html, /hidden[^>]*id="latest-report"|id="latest-report"[^>]*hidden/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:\/\//i);
});

test('panel module sends normalized START_AUDIT requests and renders only text', async () => {
  const source = await readWorkspaceFile('src/panel/panel.js');
  assert.match(source, /normalizeAuditUrl/);
  assert.match(source, /type:\s*'START_AUDIT'/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
});
