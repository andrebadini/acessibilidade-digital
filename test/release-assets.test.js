import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));

test('ships every manifest icon as a valid PNG with the declared square size', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  for (const [declaredSize, path] of Object.entries(manifest.icons)) {
    const bytes = await read(path);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], path);
    assert.equal(bytes.readUInt32BE(16), Number(declaredSize), path);
    assert.equal(bytes.readUInt32BE(20), Number(declaredSize), path);
    assert.equal(manifest.action.default_icon[declaredSize], path);
  }
});

test('ships three Chrome Web Store screenshots at 1280 by 800 without an alpha channel', async () => {
  for (const path of [
    'store-assets/screenshot-panel.png',
    'store-assets/screenshot-evidence-failed.png',
    'store-assets/screenshot-evidence-review.png',
  ]) {
    const bytes = await read(path);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], path);
    assert.equal(bytes.readUInt32BE(16), 1280, path);
    assert.equal(bytes.readUInt32BE(20), 800, path);
    assert.equal(bytes[25], 2, `${path}: PNG precisa ser RGB sem alfa`);
  }
});

test('keeps the public listing concise, accurate and bounded by the Chrome summary limit', async () => {
  const listing = (await read('store-assets/STORE-LISTING.md')).toString('utf8');
  const summary = listing.match(/## Resumo\s+([^#]+?)\s+## Descrição detalhada/u)?.[1].trim();
  assert.ok(summary);
  assert.ok([...summary].length <= 132, `resumo com ${[...summary].length} caracteres`);
  assert.match(listing, /processamento local/iu);
  assert.match(listing, /não constitui certificação/iu);
  assert.match(listing, /debugger[\s\S]*DOMSnapshot[\s\S]*árvore de acessibilidade/iu);
});

test('publishes a complete privacy policy in Markdown and standalone HTML', async () => {
  for (const path of ['docs/POLITICA-DE-PRIVACIDADE.md', 'store-assets/privacy.html']) {
    const policy = (await read(path)).toString('utf8');
    for (const expectation of [
      /dados tratados/iu,
      /processamento local/iu,
      /armazenamento e retenção/iu,
      /não (?:vende|possui servidor próprio)/iu,
      /controle do usuário/iu,
      /contato/iu,
    ]) assert.match(policy, expectation, `${path}: ${expectation}`);
  }
});
