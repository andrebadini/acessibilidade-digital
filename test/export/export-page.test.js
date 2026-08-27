import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('internal export page is local, inactive-capable and exposes one live status', async () => {
  const [html, script] = await Promise.all([read('src/export/index.html'), read('src/export/index.js')]);
  assert.match(html, /lang="pt-BR"/u);
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//u);
  assert.doesNotMatch(script, /data:text|URL\.createObjectURL/u);
  assert.match(script, /runReportExport|createAuditStore/u);
  assert.match(script, /if \(!lock\)[\s\S]*closeOwnTab/u);
  assert.match(html, /HTML[\s\S]*JSON-LD[\s\S]*CSV[\s\S]*PDF/iu);
});
