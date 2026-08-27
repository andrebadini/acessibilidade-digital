import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const forbiddenIdentity = new RegExp([
  ['go' + 'verno', 'de mato grosso'].join(' '),
  ['go' + 'verno', 'mt'].join(' '),
  ['pro', 'con'].join(''),
  ['se', 'com'].join(''),
  ['gov', '-mt-logo'].join(''),
  ['brand', '-source'].join(''),
].join('|'), 'iu');

test('renders a neutral independent identity in the real HTML and technical JSON', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  const json = renderTechnicalJson(SAMPLE_AUDIT);
  const technical = JSON.parse(json);
  assert.match(html, /<header[^>]*>[\s\S]*Audita MT[\s\S]*Auditoria independente de acessibilidade[\s\S]*<\/header>/iu);
  assert.match(html, /ferramenta independente[^.]*sem vínculo institucional[^.]*não (?:é|equivale a) (?:uma? )?(?:certificação|laudo oficial)/iu);
  assert.doesNotMatch(`${html}\n${json}`, forbiddenIdentity);
  const reportHeader = html.match(/<header[^>]*>[\s\S]*?<\/header>/iu)?.[0] ?? '';
  assert.doesNotMatch(reportHeader, /brand-logo|<img\b/iu);
  assert.deepEqual(technical.identity, {
    name: 'Audita MT',
    description: 'Auditoria independente de acessibilidade',
    independent: true,
    disclaimer: 'Ferramenta independente, sem vínculo institucional; não equivale a certificação nem a laudo oficial.',
  });
  assert.equal(technical.assertions.length, 146);
});

test('keeps strict PNG validation for audit evidence without a brand image', () => {
  const fixtureData = SAMPLE_AUDIT.evidence.artifacts.find(artifact => artifact.dataUrl)?.dataUrl;
  const valid = Buffer.from(fixtureData.slice('data:image/png;base64,'.length), 'base64');
  const corrupted = Buffer.from(valid);
  corrupted[corrupted.indexOf('IDAT') + 4] ^= 1;
  for (const bytes of [
    valid.subarray(0, 8),
    valid.subarray(0, valid.length - 1),
    corrupted,
    Buffer.concat([valid, Buffer.from([0])]),
  ]) {
    const input = structuredClone(SAMPLE_AUDIT);
    input.evidence.artifacts[0].dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const html = renderHtmlReport(input);
    assert.equal((html.match(/<svg\b[^>]*class="evidence-media"/gu) || []).length, 3);
    assert.equal((html.match(/<image\b[^>]*href="data:image\/png;base64,/gu) || []).length, 1);
    assert.doesNotMatch(html, new RegExp(Buffer.from(bytes).toString('base64').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('keeps the panel action-first with neutral identity and the existing AA palette', async () => {
  const html = await read('src/panel/index.html');
  const css = await read('src/panel/panel.css');
  assert.equal((html.match(/<h1\b/giu) || []).length, 1);
  assert.match(html, /Audita MT/iu);
  assert.match(html, /Auditoria independente de acessibilidade/iu);
  assert.match(html, /ferramenta independente[^.]*sem vínculo institucional/iu);
  assert.doesNotMatch(html, /<img\b|\.\.\/\.\.\/assets\//iu);
  assert.doesNotMatch(html, forbiddenIdentity);
  assert.ok(html.indexOf('<form') < html.indexOf('id="audit-status"'));
  assert.match(html, /<button[^>]*type="submit"[^>]*>\s*Auditar\s*<\/button>/iu);
  assert.match(html, /role="status"[^>]+aria-live="polite"/iu);
  const palette = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/giu)].map(match => [match[1], match[2]]));
  assert.ok(contrast(palette.ink, palette.surface) >= 4.5);
  assert.ok(contrast('#ffffff', palette.action) >= 4.5);
  assert.ok(contrast(palette.focus, palette.surface) >= 3);
});

function contrast(first, second) {
  const luminance = color => {
    const channels = color.slice(1).match(/../gu).map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
