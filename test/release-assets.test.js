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
  const manifest = JSON.parse((await read('manifest.json')).toString('utf8'));
  assert.ok(listing.includes(manifest.version_name), 'listing must identify the version declared by the package');
  assert.match(listing, /Evidência completa[\s\S]*Somente elementos[\s\S]*Sem imagens/iu);
  assert.match(listing, /HTML, PDF, CSV e JSON-LD\/EARL/iu);
  assert.match(listing, /outra URL[\s\S]*três modos/iu);
  // The listing must describe the shipped mechanism, not the retired one: since `1c9b296` the
  // current-page audit reads the open page itself. The old assertion demanded "cópia temporária
  // e inativa" here, which is how a false claim survived five documents and three reviews.
  assert.match(listing, /página original[\s\S]*coleta lê a própria página[\s\S]*sem criar aba/iu);
  assert.doesNotMatch(listing, /cópia temporária e inativa/iu);
  assert.match(listing, /2 a 20 URLs[\s\S]*relatório consolidado/iu);
  assert.match(listing, /URLs em lote nos três modos/iu);
  assert.match(listing, /confirmação individual por página/iu);
  assert.match(listing, /mapa numerado[^.]*legenda/iu);
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
    assert.match(policy, /versão (?:da política )?1\.5/iu, path);
    assert.match(policy, /sidePanel[\s\S]*alarms[\s\S]*contextMenus/iu, path);
    assert.match(policy, /30 dias[\s\S]*primeiro registro[\s\S]*Chrome[\s\S]*executar/iu, path);
    assert.match(policy, /antes (?:de|das) cada captura[\s\S]*intervalo técnico[\s\S]*não elimina/iu, path);
    assert.match(policy, /opcional[\s\S]*quatro downloads[\s\S]*parcial/iu, path);
    assert.doesNotMatch(policy, /não executa exclusão automática|no máximo,? 30 dias/iu, path);
    assert.doesNotMatch(policy, /Chrome Web Store/iu,
      `${path}: a política não pode prometer publicação ou contato por uma loja específica`);
  }
});

test('o guia do usuário só manda clicar em rótulo que existe no produto', async () => {
  // Mesma classe do achado que o roteiro da loja teve ("Várias páginas" quando o botão é "Lote de
  // páginas"): o guia do usuário não tinha guarda nenhuma de correspondência, então um rótulo podia
  // envelhecer sem que nada falhasse. Aqui os rótulos clicáveis precisam existir em src/.
  const guide = (await read('docs/COMO-USAR.md')).toString('utf8');
  const productUi = [
    await read('src/panel/panel-view.js'),
    await read('src/review/report-view.js'),
    await read('src/review/index.html'),
  ].map(buffer => buffer.toString('utf8')).join('\n');
  for (const label of [
    'Auditar a página atual', 'Outra URL', 'Lote de páginas', 'Evidência completa',
    'Somente elementos', 'Sem imagens', 'Destacar elemento', 'Mostrar sinais na página',
    'Abrir relatório completo', 'Refazer auditoria', 'Imprimir resumo / salvar PDF',
  ]) {
    assert.match(guide, new RegExp(label, 'iu'), `o guia precisa citar ${label}`);
    assert.ok(productUi.includes(label), `o rótulo ${label} citado no guia não existe no produto`);
  }
});

test('ships beta test instructions for the complete current-page journey and declares deferred controls', async () => {
  const instructions = (await read('store-assets/TEST-INSTRUCTIONS.md')).toString('utf8');
  for (const phrase of [
    'Carregar sem compactação', 'painel lateral', 'WCAG 2.2', 'ABNT NBR 17225',
    'HTML', 'PDF', 'CSV', 'JSON-LD/EARL', 'mapa numerado',
  ]) assert.match(instructions, new RegExp(phrase, 'iu'));
  assert.doesNotMatch(instructions, /campo “Endereço do site”|aba descartável|1\.0\.1/iu);
  // Rótulos que o roteiro manda CLICAR precisam existir no produto: a versão anterior deste teste só
  // exigia que a palavra estivesse no documento, e por isso "Várias páginas" (o botão real é "Lote de
  // páginas") passou por várias versões sem que ninguém notasse — um teste que se lê a si mesmo.
  const productUi = [
    await read('src/panel/panel-view.js'),
    await read('src/review/report-view.js'),
    await read('src/review/index.html'),
  ].map(buffer => buffer.toString('utf8')).join('\n');
  for (const label of [
    'Evidência completa', 'Somente elementos', 'Sem imagens', 'Continuar e capturar',
    'Auditar a página atual', 'Outra URL', 'Lote de páginas', 'Abrir relatório completo',
    'Destacar elemento', 'Mostrar sinais na página', 'Ver e destacar na página',
    'Refazer auditoria', 'Gerar relatório atualizado', 'Imprimir resumo / salvar PDF',
  ]) {
    assert.match(instructions, new RegExp(label, 'iu'), `o roteiro precisa citar ${label}`);
    assert.ok(productUi.includes(label), `o rótulo ${label} citado no roteiro não existe no produto`);
  }
});
