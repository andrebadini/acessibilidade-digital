import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));

test('pins and vendors only the verified axe-core 4.13.0 runtime and license files', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(packageJson.devDependencies['axe-core'], '4.13.0');
  assert.equal(lock.packages[''].devDependencies['axe-core'], '4.13.0');
  assert.equal(lock.packages['node_modules/axe-core'].version, '4.13.0');
  assert.deepEqual((await readdir(new URL('../vendor/axe/', import.meta.url))).sort(), [
    'LICENSE', 'LICENSE-3RD-PARTY.txt', 'axe.min.js',
  ]);
  for (const [path, expected] of Object.entries({
    'vendor/axe/axe.min.js': 'c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1',
    'vendor/axe/LICENSE': 'af175b9d96ee93c21a036152e1b905b0b95304d4ae8c2c921c7609100ba8df7e',
    'vendor/axe/LICENSE-3RD-PARTY.txt': '4f8563870d0fca38bbc3e00b6f670cb7fa9f380ba9f26a7f7d1184a6b18b1653',
  })) {
    assert.equal(createHash('sha256').update(await read(path)).digest('hex'), expected, path);
  }
});

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
  assert.match(listing, /1\.0\.6 beta 5/iu);
  assert.match(listing, /Evidência completa[\s\S]*Somente elementos[\s\S]*Sem imagens/iu);
  assert.match(listing, /HTML, PDF, CSV e JSON-LD\/EARL/iu);
  assert.match(listing, /outra URL[\s\S]*três modos/iu);
  assert.match(listing, /página original[\s\S]*cópia temporária e inativa/iu);
  assert.match(listing, /2 a 20 URLs[\s\S]*relatório consolidado/iu);
  assert.match(listing, /lotes com capturas[\s\S]*mapa numerado[\s\S]*não estão disponíveis/iu);
  assert.doesNotMatch(listing, /1\.0\.1|aba descartável/iu);
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
    assert.match(policy, /versão (?:da política )?1\.4/iu, path);
    assert.match(policy, /sidePanel[\s\S]*alarms[\s\S]*contextMenus/iu, path);
    assert.match(policy, /permanece no armazenamento local[\s\S]*exclua[\s\S]*não executa exclusão automática por prazo/iu, path);
    assert.match(policy, /antes (?:de|das) cada captura[\s\S]*intervalo técnico[\s\S]*não elimina/iu, path);
    assert.doesNotMatch(policy, /no máximo,? 30 dias|auditorias vencidas/iu, path);
    assert.doesNotMatch(policy, /escolher[^.]*exclusão local[^.]*exportação|excluir todas pelo painel/iu, path);
    assert.doesNotMatch(policy, /Chrome Web Store/iu,
      `${path}: a política não pode prometer publicação ou contato por uma loja específica`);
  }
});

test('ships beta test instructions for the complete current-page journey and declares deferred controls', async () => {
  const instructions = (await read('store-assets/TEST-INSTRUCTIONS.md')).toString('utf8');
  for (const phrase of [
    'Carregar sem compactação', 'painel lateral', 'Evidência completa', 'Somente elementos', 'Sem imagens',
    'Continuar e capturar', 'WCAG 2.2', 'ABNT NBR 17225', 'Abrir relatório completo',
    'HTML', 'PDF', 'CSV', 'JSON-LD/EARL', 'Outra URL', 'Várias páginas', 'mapa numerado',
  ]) assert.match(instructions, new RegExp(phrase, 'iu'));
  assert.doesNotMatch(instructions, /campo “Endereço do site”|aba descartável|1\.0\.1/iu);
});
