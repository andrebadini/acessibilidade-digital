import assert from 'node:assert/strict';
import test from 'node:test';

const modelModule = await import('../../src/reader/report-model.js').catch(() => ({}));
const controllerModule = await import('../../src/reader/controller.js').catch(() => ({}));
const row = (fields = {}) => ({ id: 'element-1', selector: 'button:nth-of-type(1)', tag: 'button', role: 'button', name: 'Enviar', description: '', states: [], preview: 'Enviar, botão', tabIndex: 0, tabOrder: 1, category: 'tab', reasons: [], bounds: { x: 10, y: 20, width: 80, height: 24 }, ...fields });
const inventory = (entries = [row()]) => ({ version: 1, sessionId: 'test-session', entries, limitations: [], counts: { total: entries.length, tab: 1, outsideTab: 0, reading: 0, hidden: 0, scanned: 3, truncated: false } });

test('report preserves every category and Tab order, redacts secrets and excludes arbitrary fields', () => {
  assert.equal(typeof modelModule.createReadingReport, 'function');
  const report = modelModule.createReadingReport(inventory([
    row({ name: 'Token: segredo123', preview: 'Token: segredo123' }),
    row({ id: 'element-2', category: 'outside-tab', tabOrder: null, tabIndex: -1, reasons: ['tabindex negativo'] }),
    row({ id: 'element-3', category: 'reading', tabOrder: null, tabIndex: null, role: 'heading' }),
  ]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  assert.equal(report.entries.length, 3);
  assert.equal(report.counts.outsideTab, 1);
  assert.equal(report.counts.reading, 1);
  assert.doesNotMatch(JSON.stringify(report), /segredo123/u);
  assert.throws(() => modelModule.createReadingReport(inventory([row({ value: 'secret' })])));
  assert.throws(() => modelModule.createReadingReport(inventory([row(), row()])));
  assert.throws(() => modelModule.createReadingReport(inventory([row({ tabOrder: 2 })])));
});

test('HTML export escapes site markup, includes all records and works without executable content', () => {
  assert.equal(typeof modelModule.renderReadingHtml, 'function');
  const report = modelModule.createReadingReport(inventory([row({ name: '<img src=x onerror=alert(1)>', preview: '<script>alert(1)</script>' })]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  const html = modelModule.renderReadingHtml(report);
  assert.match(html, /&lt;script&gt;/u);
  assert.doesNotMatch(html, /<script/iu);
  assert.doesNotMatch(html, /<img[^>]+onerror/iu);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /img-src data:/u);
  assert.match(html, /Imagem do elemento/u);
  assert.match(html, /estimativa/iu);
  assert.match(html, /Conteúdo estrutural/u);
  assert.match(html, /Fora da sequência de Tab/u);
});

test('CSV uses quoted cells and neutralizes spreadsheet formula injection', () => {
  assert.equal(typeof modelModule.renderReadingCsv, 'function');
  const report = modelModule.createReadingReport(inventory([row({ name: '=HYPERLINK("bad")', preview: '+cmd', selector: '@selector' })]));
  const csv = modelModule.renderReadingCsv(report);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/u);
  assert.match(csv, /"'\+cmd"/u);
  assert.match(csv, /"'@selector"/u);
});

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Captura de 1200×600 CSS que virou um PNG de 2400×1200: escala 2, como numa tela de alta densidade.
const MAP_GEOMETRY = { pixelWidth: 2400, pixelHeight: 1200, cssWidth: 1200, cssHeight: 600 };

function reportWithMap() {
  const base = modelModule.createReadingReport(inventory([
    row({ id: 'first', tabOrder: 1, preview: 'Ir para o conteúdo' }),
    row({ id: 'heading', tabOrder: null, tabIndex: null, category: 'reading', role: 'heading', preview: 'Título principal', bounds: { x: 0, y: 40, width: 200, height: 30 } }),
  ]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  return modelModule.attachReadingVisuals(base, {
    elementImages: { first: TINY_PNG },
    fullPage: TINY_PNG,
    pageMapGeometry: MAP_GEOMETRY,
    limitations: ['visual-capture-unavailable'],
  });
}

test('attaches element screenshots before the code column and a reading map at the end', () => {
  const report = reportWithMap();
  assert.equal(report.entries[0].image, TINY_PNG);
  assert.equal(report.entries[1].image, null);
  assert.equal(report.pageMap, TINY_PNG);
  assert.deepEqual(report.pageMapGeometry, MAP_GEOMETRY);
  assert.ok(report.limitations.includes('A captura de tela não ficou disponível nesta inspeção.') || report.limitations.some(value => /captura/iu.test(value)));
  const html = modelModule.renderReadingHtml(report);
  assert.match(html, /Imagem do elemento/u);
  assert.match(html, /map-base/u);
  assert.match(html, /Ir para o conteúdo/u);
  assert.match(html, /T[uí]tulo principal/u);
  assert.ok(html.indexOf('Imagem do elemento') < html.indexOf('Ordem / elemento'));
  assert.ok(html.indexOf('Mapa de leitura') > html.indexOf('Conferir'));
});

test('o mapa usa a medida da captura: viewBox no tamanho do PNG e caixa convertida pela escala', () => {
  const html = modelModule.renderReadingHtml(reportWithMap());
  // O viewBox é o tamanho em pixel do próprio PNG: é o que faz a caixa cair sobre o elemento.
  assert.match(html, /viewBox="0 0 2400 1200"/u);
  // A caixa medida no documento (10,20,80×24 CSS) vira (20,40,160×48) na escala 2.
  assert.match(html, /class="map-box tone-[a-z]+" x="20" y="40" width="160" height="48"/u);
  // O segundo elemento fica na posição dele, também convertida: (0,40,200×30) → (0,80,400×60).
  assert.match(html, /class="map-box tone-[a-z]+" x="0" y="80" width="400" height="60"/u);
  // A coluna da direita é o texto que seria ouvido, com o código e o Tab de quem recebe foco.
  assert.match(html, /<span class="reader-map-code">L1<\/span> <bdi>Ir para o conteúdo<\/bdi> <span class="reader-map-tab">\(Tab 1\)<\/span>/u);
  assert.match(html, /<span class="reader-map-code">L2<\/span> <bdi>Título principal<\/bdi><\/li>/u);
});

test('o mapa numera os códigos uma única vez, na ordem de leitura, e desenha só o código na imagem', () => {
  const html = modelModule.renderReadingHtml(reportWithMap());
  const codes = [...html.matchAll(/<text class="map-badge-text"[^>]*>(L\d+)<\/text>/gu)].map(match => match[1]);
  assert.deepEqual(codes, ['L1', 'L2'], 'cada código aparece uma vez, em ordem');
  const badges = [...html.matchAll(/<rect class="map-badge(?: map-badge-overlapped)?" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/gu)];
  assert.equal(badges.length, 2, 'uma etiqueta por elemento marcado');
  // A etiqueta é uma caixa pequena com o código: o texto do anúncio não é desenhado dentro da imagem.
  for (const badge of badges) assert.ok(Number(badge[3]) < 200, 'a etiqueta tem a largura de um código, não de um anúncio');
  assert.equal((html.match(/Ir para o conteúdo<\/bdi>/gu) ?? []).length, 1, 'o anúncio aparece só na coluna de texto');
});

test('sem a medida da captura o mapa não desenha código nenhum em vez de apontar o lugar errado', () => {
  const base = modelModule.createReadingReport(inventory([row()]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  const report = modelModule.attachReadingVisuals(base, { elementImages: {}, fullPage: TINY_PNG, limitations: [] });
  assert.equal(report.pageMapGeometry, null);
  const html = modelModule.renderReadingHtml(report);
  assert.match(html, /<img class="map-base"/u);
  assert.doesNotMatch(html, /<text class="map-badge-text"/u);
  assert.doesNotMatch(html, /<svg class="map-overlay"/u);
  assert.match(html, /A medida da captura não foi registrada/u);
});

test('rejects non-PNG visual payloads and keeps a text-only report when capture is absent', () => {
  const base = modelModule.createReadingReport(inventory([row()]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  assert.throws(() => modelModule.attachReadingVisuals(base, { elementImages: { 'element-1': 'data:text/html,oi' }, fullPage: null }));
  // Medida incoerente é recusada inteira: o mapa não pode ser desenhado com uma escala inventada.
  assert.throws(() => modelModule.attachReadingVisuals(base, { elementImages: {}, fullPage: TINY_PNG, pageMapGeometry: { pixelWidth: 0, pixelHeight: 0, cssWidth: 0, cssHeight: 0 } }));
  const plain = modelModule.attachReadingVisuals(base, { elementImages: {}, fullPage: null });
  const html = modelModule.renderReadingHtml(plain);
  assert.match(html, /Captura não disponível/u);
  assert.doesNotMatch(html, /class="map-base"/u);
  assert.match(html, /Mapa de leitura da página/u);
  assert.match(html, /Captura da página inteira não disponível/u);
});

test('interleaved structural content cannot disturb Tab order or disclose session tokens in exports', () => {
  const report = modelModule.createReadingReport(inventory([
    row({ id: 'second', tabOrder: 2 }),
    row({ id: 'heading', category: 'reading', tabOrder: null, tabIndex: null }),
    row({ id: 'first', tabOrder: 1 }),
  ]));
  assert.deepEqual(report.entries.filter(entry => entry.category === 'tab').map(entry => entry.id), ['first', 'second']);
  assert.doesNotMatch(JSON.stringify(report), /test-session|sessionId/u);
});

function fakeChrome() {
  const records = {};
  const calls = [];
  let tab = { id: 7, windowId: 2, url: 'https://example.com/private?secret=hidden', status: 'complete' };
  return { calls, records, setTab(value) { tab = value; },
    runtime: { getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}` },
    tabs: { query: async () => [tab], get: async () => tab, create: async value => { calls.push(['create', value]); return { id: 9 }; }, update: async (id, value) => { calls.push(['update', id, value]); } },
    windows: { update: async () => {} },
    storage: { session: { set: async value => Object.assign(records, value), get: async key => key === null ? { ...records } : Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, records[item]])), remove: async key => { delete records[key]; } } },
    scripting: { executeScript: async value => { calls.push(['script', value]); return [{ frameId: 0, documentId: 'document-one', result: value.files ? undefined : inventory() }]; } },
  };
}

// O Chrome oferece Web Locks à extensão; o Node 22 do CI não tem navigator.locks. Os testes que não tratam
// do lock injetam um gerenciador exclusivo trivial para não depender do runtime que os executa.
const exclusiveLock = Object.freeze({ lockManager: { request: async (_name, _options, callback) => callback({}) } });

test('launch is a one-time short-lived local capability and never retains a page URL', async () => {
  assert.equal(typeof controllerModule.openReadingReport, 'function');
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'a'.repeat(43), now: 1000 });
  assert.doesNotMatch(JSON.stringify(api.records), /private|secret|example/u);
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  const source = await controllerModule.consumeReadingLaunch(api, href, 1500, exclusiveLock);
  assert.equal(source.tabId, 7);
  assert.equal(source.documentId, 'document-one', 'freeze the selected document at the launch gesture');
  await assert.rejects(controllerModule.consumeReadingLaunch(api, href, 1600, exclusiveLock));
  api.setTab({ id: 7, url: 'chrome://extensions' });
  await assert.rejects(controllerModule.openReadingReport(api));
});

test('concurrent launch consumers cannot both claim the same one-time capability', async () => {
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'c'.repeat(43), now: 1000 });
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  let tail = Promise.resolve(); const names = [];
  const lockManager = {
    request(name, options, callback) {
      names.push(name); assert.deepEqual(options, { mode: 'exclusive' });
      const pending = tail.then(() => callback({ name }));
      tail = pending.catch(() => {});
      return pending;
    },
  };
  const results = await Promise.allSettled([
    controllerModule.consumeReadingLaunch(api, href, 1500, { lockManager }),
    controllerModule.consumeReadingLaunch(api, href, 1500, { lockManager }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(names.length, 2); assert.equal(names[0], names[1]);
  assert.equal(Object.keys(api.records).length, 0);
});

test('launch consumption fails closed without a Web Lock and leaves its capability unclaimed', async () => {
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'd'.repeat(43), now: 1000 });
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  for (const lockManager of [null, {}, { request: async (_name, _options, callback) => callback(null) }]) {
    await assert.rejects(controllerModule.consumeReadingLaunch(api, href, 1500, { lockManager }));
    assert.equal(Object.keys(api.records).length, 1);
  }
});

test('the first collection cannot bind a different document after the launch click', async () => {
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'a'.repeat(43), now: 1000 });
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  const source = await controllerModule.consumeReadingLaunch(api, href, 1500, exclusiveLock);
  api.setTab({ id: 7, url: 'https://different.example', status: 'complete' });
  const calls = [];
  api.scripting.executeScript = async options => {
    calls.push(options);
    if (options.target.documentIds?.[0] === 'document-one') throw new Error('No document with that id');
    return [{ frameId: 0, documentId: 'document-two', result: inventory() }];
  };
  const controller = controllerModule.createReadingController(api, source, { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  await assert.rejects(controller.collect());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target.documentIds, ['document-one']);
});

test('a busy target lock or paused audit prevents all reading injection', async () => {
  for (const kind of ['lock', 'paused']) {
    const api = fakeChrome();
    if (kind === 'paused') api.records['audita:active-audit-job:v1'] = { state: 'privacy-paused' };
    const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' },
      { lockManager: { request: async (_name, _options, callback) => callback(kind === 'lock' ? null : {}) } });
    await assert.rejects(controller.collect());
    assert.equal(api.calls.length, 0);
  }
});

test('audit revocation prevents the old report from recreating its overlay', async () => {
  const api = fakeChrome();
  const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' },
    { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  await controller.collect();
  delete api.records['audita.reading-active.7'];
  const previous = api.calls.length;
  await assert.rejects(controller.observe());
  assert.equal(api.calls.length, previous);
});

test('collection binds scripts to the document and refuses navigation before a live action', async () => {
  assert.equal(typeof controllerModule.createReadingController, 'function');
  const api = fakeChrome();
  const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' }, { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  const report = await controller.collect();
  assert.equal(report.origin, 'https://example.com');
  assert.doesNotMatch(JSON.stringify(report), /secret=|private\?/u);
  const collection = api.calls.filter(([type]) => type === 'script').at(-1)[1];
  assert.deepEqual(collection.target.documentIds, ['document-one']);
  api.setTab({ id: 7, url: 'https://different.example', status: 'complete' });
  await assert.rejects(controller.highlight('element-1'));
  assert.equal(api.calls.filter(([type]) => type === 'update').length, 0);
});

test('highlight forwards the walk Escape baseline and maps a walk Escape to WALK_ESCAPED', async () => {
  const api = fakeChrome();
  const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' }, { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  await controller.collect();
  const commands = [];
  api.scripting.executeScript = async options => {
    commands.push(options.args[0]);
    const escaped = options.args[0].walkEscapes === 0;
    return [{ frameId: 0, documentId: 'document-one', result: escaped
      ? { version: 1, sessionId: 'test-session', ok: false, reason: 'walk-escaped', escapes: 1 }
      : { version: 1, sessionId: 'test-session', ok: true, reason: 'highlighted', escapes: 0 } }];
  };
  const first = await controller.highlight('element-1');
  assert.equal(first.escapes, 0);
  assert.equal(Object.hasOwn(commands[0], 'walkEscapes'), false, 'a plain highlight sends no walk field');
  await assert.rejects(controller.highlight('element-1', { walkEscapes: 0 }), error => error.code === 'WALK_ESCAPED');
  assert.equal(commands[1].walkEscapes, 0);
  await controller.highlight('element-1', { walkEscapes: -1 });
  assert.equal(Object.hasOwn(commands[2], 'walkEscapes'), false, 'invalid baselines are dropped');
});

test('plain-language layer: HTML export opens with the verdict and the top fixes, escaped', () => {
  const report = modelModule.createReadingReport(inventory([
    row({ id: 'ok-button', tabOrder: 1, name: 'Enviar', preview: 'Enviar, botão' }),
    row({ id: 'nameless', tabOrder: 2, name: '', preview: 'botão', reasons: ['accessible-name-unavailable'] }),
    row({ id: 'img', tabOrder: null, tabIndex: null, category: 'reading', tag: 'img', role: 'img', name: '', preview: 'imagem' }),
    row({ id: 'hidden', tabOrder: null, tabIndex: null, category: 'hidden', name: '<b>x</b>', reasons: ['not-rendered'] }),
  ]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  const html = modelModule.renderReadingHtml(report);
  assert.match(html, /<section class="verdict tone-problem" id="veredito"><h2>Em uma frase<\/h2>/u);
  assert.match(html, /2 problema\(s\), 0 ponto\(s\) a revisar e 1 sem ponto crítico\. 1 elemento\(s\) oculto\(s\)/u);
  assert.match(html, /<h2>O que corrigir primeiro<\/h2>/u);
  assert.ok(html.indexOf('id="veredito"') < html.indexOf('<h2>Limites da inspeção</h2>'), 'verdict comes first');
  assert.ok(html.indexOf('Tab 2 · Problema') < html.indexOf('Conteúdo estrutural · Problema'), 'Tab order first');
  assert.match(html, /tone-chip tone-info/u);
  assert.doesNotMatch(html, /<b>x<\/b>/u);
  assert.doesNotMatch(html, /<script/iu);
  const csv = modelModule.renderReadingCsv(report);
  assert.match(csv.split('\r\n')[0], /"Semáforo","Em linguagem simples"$/u);
  assert.match(csv, /"Problema","Quem usa leitor de tela ouviria só “botão”/u);
});
