import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = name => readFile(new URL(`../../fixtures/pages/${name}`, import.meta.url), 'utf8');

test('kitchen-sink fixture is local and structurally exercises frames, shadow DOM, media and sensitive controls', async () => {
  const html = await fixture('kitchen-sink.html');
  for (const structure of [/<iframe\b/iu, /attachShadow\s*\(/u, /<video\b/iu, /<img\b/iu, /type="password"/iu, /type="hidden"/iu]) {
    assert.match(html, structure);
  }
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/iu);
  assert.doesNotMatch(html, /(?:bearer\s+|authorization\s*=|api[-_]?key\s*=)/iu);
});

test('dynamic probe fixture contains exact boundaries and non-destructive local navigation cases', async () => {
  const html = await fixture('dynamic-probes.html');
  for (const expected of ['23.99px', '24px', '43.99px', '44px', 'prefers-reduced-motion: reduce', 'width: 360px']) {
    assert.match(html, new RegExp(expected.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(html, /<form>/iu);
  assert.match(html, /href="#local"/iu);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/iu);
});
