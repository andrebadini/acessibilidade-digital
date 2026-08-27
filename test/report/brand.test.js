import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createBrandAsset, renderHtmlReport } from '../../src/core/report/html.js';

const SOURCE_URL = 'https://www.secom.mt.gov.br/documents/21013/0/_govmt_manual_de_identidade_oficial_expandido_abril_2026.pdf/7921f56c-66a0-15a1-37d7-3f04c37fadfc';
const ASSET_SHA = '1736ccf3c3783a42e9ebc7649a3fa473774b4c5f413ba1a09616cbd2e76cac7d';
const read = path => readFile(new URL(`../../${path}`, import.meta.url));

test('packages the verified rendered PNG with exact provenance and dimensions', async () => {
  const bytes = await read('assets/gov-mt-logo.png');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.readUInt32BE(16), 1120);
  assert.equal(bytes.readUInt32BE(20), 440);
  const brand = await createBrandAsset(bytes);
  assert.equal(brand.sha256, ASSET_SHA);
  assert.equal(brand.sourceUrl, SOURCE_URL);
  assert.equal(brand.alt, 'Governo de Mato Grosso');
  assert.equal(brand.width, 1120);
  assert.equal(brand.height, 440);
  assert.match(brand.dataUrl, /^data:image\/png;base64,/u);
});

test('rejects truncated, CRC-corrupt, signature-only and trailing PNG data', async () => {
  const logo = await read('assets/gov-mt-logo.png');
  const fixtureData = SAMPLE_AUDIT.evidence.artifacts.find(artifact => artifact.dataUrl)?.dataUrl;
  const valid = Buffer.from(fixtureData.slice('data:image/png;base64,'.length), 'base64');
  const corrupted = Buffer.from(valid);
  corrupted[corrupted.indexOf('IDAT') + 4] ^= 1;
  const invalid = [
    valid.subarray(0, 8),
    valid.subarray(0, valid.length - 1),
    corrupted,
    Buffer.concat([valid, Buffer.from([0])]),
  ];
  for (const bytes of invalid) {
    const input = structuredClone(SAMPLE_AUDIT);
    input.evidence.artifacts[0].dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const html = renderHtmlReport(input, {});
    assert.equal((html.match(/<img\b[^>]*>/gu) || []).length, 1);
  }
  for (const bytes of [logo.subarray(0, 24), Buffer.concat([logo, Buffer.from([0])])]) {
    await assert.rejects(createBrandAsset(bytes), /PNG|integridade|estrutura/i);
  }
});

test('documents the official manual and the rasterization/crop without calling it an original asset', async () => {
  const source = (await read('assets/BRAND-SOURCE.md')).toString('utf8');
  for (const value of [
    SOURCE_URL, '2026-08-26',
    '63df310167b8c30ee24a8fe6a7e9ad220292cf4338c6176d28cf0ed385bb962a',
    '841.89 × 595.276 pt', '49 páginas', 'página 3', '1120 × 440', 'RGB', ASSET_SHA,
    'Pantone 2758C', 'C100 M90 Y0 K20', 'rasterização', 'recorte',
  ]) assert.match(source, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
  assert.match(source, /ativo renderizado|derivado|não é o arquivo original/iu);
  assert.doesNotMatch(source, /arquivo original da marca/iu);
});

test('embeds the exact local brand data with accessible identity and no hotlink', async () => {
  const brand = await createBrandAsset(await read('assets/gov-mt-logo.png'));
  const html = renderHtmlReport(SAMPLE_AUDIT, { brand });
  assert.match(html, /<img[^>]+class="brand-logo"[^>]+src="data:image\/png;base64,[^"]+"[^>]+alt="Governo de Mato Grosso"[^>]+width="1120"[^>]+height="440"/u);
  assert.match(html, /PROCON-MT — Secretaria Adjunta de Proteção e Defesa dos Direitos do Consumidor/u);
  assert.doesNotMatch(html, new RegExp(SOURCE_URL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(html, /\.brand-logo\{[^}]*height:auto/iu);
});

test('keeps the panel action-first, locally branded and AA for primary text/action colors', async () => {
  const html = (await read('src/panel/index.html')).toString('utf8');
  const css = (await read('src/panel/panel.css')).toString('utf8');
  assert.equal((html.match(/<h1\b/giu) || []).length, 1);
  assert.match(html, /<img[^>]+src="\.\.\/\.\.\/assets\/gov-mt-logo\.png"[^>]+alt="Governo de Mato Grosso"[^>]+width="1120"[^>]+height="440"/iu);
  assert.match(html, /PROCON-MT — Secretaria Adjunta de Proteção e Defesa dos Direitos do Consumidor/u);
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
